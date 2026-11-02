/** Локальне об'єктне сховище з тим самим контрактом, що й майбутній адаптер R2 (S3 API).
 *  Кожен PUT атомарний для читача (тимчасовий файл + rename). Лічильники операцій
 *  ведуться за класами R2 (A: put/list, B: get/head, delete — безплатний), щоб прогнозувати квоти.
 *
 *  ENG-22 (Hermes ENG-21 F02): JSON-ключі (*.json — маніфести, стан) зберігаються ВЕРСІЯМИ: <файл>.cas/v<N> (заголовок + вміст).
 *  Запис = ексклюзивне створення наступної версії (fs.link → EEXIST, якщо її вже хтось створив). Умова (ifMatch) перевіряється щодо
 *  версії N, а запис можливий лише як N+1: будь-який інший запис після перевірки займає N+1 раніше → наш link відмовляє. Тож умова й
 *  запис атомарні в точці фактичного запису, без блокувань і без витіснення «покинутого» замка за віком (причина F02 у ENG-21),
 *  за будь-якої затримки між перевіркою й записом. Невиконана умова → put повертає null (як R2 Workers put з onlyIf),
 *  putJson кидає PRECONDITION_FAILED (412). Модель для одного хоста — НЕ доказ поведінки справжнього R2.
 *  Старі версії прибираються (GC): спершу піднімається «підлога» (floor), потім видаляються версії ≤ floor; запис, що потрапив у
 *  звільнений номер ≤ floor, сам себе відкликає (невидимий для читачів) і повертає відмову. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonicalObjectKey } from "./keys.mjs";

/** ETag об'єкта — SHA-256 збережених байтів (у лапках, як HTTP ETag). */
export const etagOf = (buf) => '"' + crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32) + '"';

/** SHA-256 файлу (потоком). */
const fileSha = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash("sha256");
  fs.createReadStream(file).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});
/** Той самий вміст двох файлів (розмір + SHA-256). */
async function sameContent(a, b) {
  const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  return sa.size === sb.size && (await fileSha(a)) === (await fileSha(b));
}

/** Ключі з атомарним умовним записом (версійне зберігання). Решта (версії YML) — незмінні об'єкти з унікальними іменами. */
export const isCasKey = (key) => String(key).endsWith(".json");
const VERSION_RE = /^v(\d{12})$/;
const vname = (n) => "v" + String(n).padStart(12, "0");
/** Windows: файл, який інший процес саме видаляє / перейменовує, тимчасово дає EPERM / EBUSY / EACCES замість ENOENT. */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const preconditionFailed = (key, expected, actual) =>
  Object.assign(new Error(`412 Precondition Failed: ${key} (очікувано ${expected ?? "відсутній"}, є ${actual ?? "відсутній / змінено"})`), { code: "PRECONDITION_FAILED", status: 412 });

export function newOpCounter() {
  return { classA: 0, classB: 0, deletes: 0, bytesUploaded: 0, bytesDownloaded: 0 };
}

export class LocalObjectStore {
  /** casWindow(key, { observed, etag }) — ЛИШЕ для тестів атомарності: викликається між перевіркою умови й ексклюзивним записом
   *  (вікно TOCTOU). casKeep — скільки останніх версій JSON-ключа зберігати. */
  constructor(root, { counter = newOpCounter(), failOn = null, casWindow = null, casKeep = 16 } = {}) {
    this.root = path.resolve(root);
    this.ops = counter;
    // Для тестів відмов: failOn(op, key) → true кидає помилку перед операцією.
    this.failOn = failOn;
    this.casWindow = casWindow;
    this.casKeep = Math.max(2, Number(casKeep) || 16);
    // ENG-22 (F07): оголошена можливість — атомарний умовний запис JSON-ключів (перевіряється й функціональною пробою, feed-fence.mjs).
    this.capabilities = Object.freeze({ atomicConditionalPut: true, scope: "json", model: "local-versioned-exclusive-create" });
  }

  /** ENG-25 (Hermes ENG-24 N1): лише канонічний ключ (keys.mjs) — на регістронезалежній ФС кожному файлу відповідає один ключ;
   *  службові ключі (state/…, approved/…, маніфести) — лише в нижньому регістрі, інакше INVALID_KEY. */
  #file(key) {
    return path.join(this.root, ...canonicalObjectKey(key).split("/"));
  }

  #check(op, key) {
    if (this.failOn && this.failOn(op, key)) throw new Error(`Імітована відмова сховища: ${op} ${key}`);
  }

  // ---------- версійне зберігання JSON-ключів (ENG-22, F02) ----------
  #casDir(key) { return this.#file(key) + ".cas"; }
  async #readNum(file) {
    for (let i = 0; ; i++) {
      try { return Number((await fsp.readFile(file, "utf8")).trim()) || 0; } catch (e) {
        if (e.code === "ENOENT") return 0;
        if (!TRANSIENT.has(e.code) || i >= 50) throw e;
        await pause(2);
      }
    }
  }
  /** Версія існує? Файл, що саме видаляється (EPERM на Windows), вважається наявним: GC прибирає лише версії ≤ floor. */
  async #exists(file) { try { await fsp.stat(file); return true; } catch (e) { if (e.code === "ENOENT") return false; if (TRANSIENT.has(e.code)) return true; throw e; } }
  async #writeAtomic(file, text) {
    const tmp = file + ".tmp-" + crypto.randomBytes(6).toString("hex");
    await fsp.writeFile(tmp, text);
    try { await fsp.rename(tmp, file); } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
  }
  /** Номер останньої версії (0 — версій немає: старий файл без версій або ключа немає). Версії над floor ідуть без пропусків. */
  async #latest(dir) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const floor = await this.#readNum(path.join(dir, "floor"));
      const base = Math.max(floor, await this.#readNum(path.join(dir, "head")));
      let m = base;
      while (await this.#exists(path.join(dir, vname(m + 1)))) m++;
      if (m === 0) return 0;
      if (m === floor) continue; // над floor нічого — GC саме підняв floor: повторити
      if (m === base && !(await this.#exists(path.join(dir, vname(m))))) continue; // підказку прибрано GC: повторити
      return m;
    }
    throw new Error("сховище: останню версію ключа не визначено (" + dir + ")");
  }
  /** Поточний стан JSON-ключа: { n, body (Buffer | null), header }. */
  async #current(key) {
    const dir = this.#casDir(key);
    for (let attempt = 0; attempt < 100; attempt++) {
      const n = await this.#latest(dir);
      if (n === 0) {
        // Ключ без версій: файл, записаний до ENG-22 (версія 0), або ключа немає.
        let body = null, header = {};
        try { body = await fsp.readFile(this.#file(key)); } catch (e) { if (e.code !== "ENOENT") throw e; }
        if (body) { try { header = JSON.parse(await fsp.readFile(this.#file(key) + ".meta", "utf8")); } catch { header = {}; } }
        return { n: 0, body, header };
      }
      let buf;
      try { buf = await fsp.readFile(path.join(dir, vname(n))); } catch (e) { if (e.code === "ENOENT" || TRANSIENT.has(e.code)) { await pause(1); continue; } throw e; }
      const i = buf.indexOf(10);
      const header = JSON.parse(buf.subarray(0, i).toString("utf8"));
      return { n, body: header.deleted ? null : buf.subarray(i + 1), header };
    }
    throw new Error("сховище: версію ключа не прочитано: " + key);
  }
  /** Атомарний запис наступної версії. ifMatch: undefined — без умови; null — ключа не має бути; рядок — ETag поточного вмісту.
   *  → { ok: true, n } | { ok: false, etag } (умову не виконано). */
  async #commit(key, body, header, ifMatch) {
    const dir = this.#casDir(key);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, ".tmp-" + crypto.randomBytes(8).toString("hex"));
    await fsp.writeFile(tmp, Buffer.concat([Buffer.from(JSON.stringify(header) + "\n", "utf8"), body]));
    try {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const cur = await this.#current(key);
        const etag = cur.body ? etagOf(cur.body) : null;
        if (ifMatch !== undefined && etag !== ifMatch) return { ok: false, etag };
        if (this.casWindow) await this.casWindow(key, { observed: cur.n, etag });
        const n = cur.n + 1, file = path.join(dir, vname(n));
        try { await fsp.link(tmp, file); } catch (e) {
          // EEXIST — номер уже зайнятий; EPERM / EACCES (Windows) — файл із цим номером саме видаляє GC (звільнений номер ≤ floor).
          if (e.code !== "EEXIST" && !TRANSIENT.has(e.code)) throw e;
          if (ifMatch !== undefined) return { ok: false, etag: null }; // після перевірки версію N+1 записав інший — умова вже не чинна
          continue;
        }
        if (n <= await this.#readNum(path.join(dir, "floor"))) {
          // Номер, звільнений GC: така версія невидима — відкликати й вважати запис невиконаним.
          await fsp.unlink(file).catch(() => {});
          if (ifMatch !== undefined) return { ok: false, etag: null };
          continue;
        }
        await this.#writeAtomic(path.join(dir, "head"), String(n)).catch(() => {});
        await this.#gc(dir, n).catch(() => {});
        return { ok: true, n };
      }
      throw new Error("сховище: запис не виконано після 1000 спроб: " + key);
    } finally { await fsp.unlink(tmp).catch(() => {}); }
  }
  /** Прибирання старих версій під ексклюзивним замком GC (без витіснення за віком; власник-процес, що завершився, — витісняється). */
  async #gc(dir, n) {
    const target = n - this.casKeep;
    if (target <= await this.#readNum(path.join(dir, "floor"))) return;
    const lock = path.join(dir, "gc.lock");
    try { await fsp.mkdir(lock); } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const owner = Number(await fsp.readFile(path.join(lock, "owner"), "utf8").catch(() => "0"));
      let alive = true;
      if (owner > 0) { try { process.kill(owner, 0); } catch (k) { alive = k.code !== "ESRCH"; } }
      if (alive || owner <= 0) return; // GC необов'язковий: зайнято — пропустити
      await fsp.rm(lock, { recursive: true, force: true });
      try { await fsp.mkdir(lock); } catch { return; }
    }
    try {
      await fsp.writeFile(path.join(lock, "owner"), String(process.pid));
      const floor = await this.#readNum(path.join(dir, "floor"));
      if (target <= floor) return;
      await this.#writeAtomic(path.join(dir, "floor"), String(target)); // спершу floor, потім видалення (за зростанням)
      for (let i = floor + 1; i <= target; i++) await fsp.unlink(path.join(dir, vname(i))).catch((e) => { if (e.code !== "ENOENT") throw e; });
    } finally { await fsp.rm(lock, { recursive: true, force: true }).catch(() => {}); }
  }
  async #putCas(key, body, meta) {
    const buf = body && typeof body === "object" && "file" in body ? await fsp.readFile(body.file) : Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
    const header = { contentType: meta.contentType || "application/octet-stream", metadata: meta.metadata || {}, size: buf.length };
    const r = await this.#commit(key, buf, header, meta.ifMatch);
    if (!r.ok) return null;
    this.ops.bytesUploaded += buf.length;
    return { key, size: buf.length, etag: etagOf(buf) };
  }

  /** body: Buffer | string | { file: шлях } ; meta: { contentType, metadata, ifMatch? }
   *  ifMatch (лише JSON-ключі): рядок ETag / null (ключа не має бути); умова не виконана → null, нічого не записано. */
  async put(key, body, meta = {}) {
    this.#check("put", key);
    this.ops.classA++;
    if (isCasKey(key)) return this.#putCas(key, body, meta || {});
    if (meta && meta.ifMatch !== undefined) throw Object.assign(new Error("умовний запис підтримано лише для JSON-ключів: " + key), { code: "CAS_UNSUPPORTED" });
    const target = this.#file(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = target + ".tmp-" + crypto.randomBytes(6).toString("hex");
    try {
      if (body && typeof body === "object" && "file" in body) {
        await pipeline(fs.createReadStream(body.file), fs.createWriteStream(tmp));
      } else {
        await fsp.writeFile(tmp, body);
      }
      const size = (await fsp.stat(tmp)).size;
      await fsp.writeFile(tmp + ".meta", JSON.stringify({ contentType: meta.contentType || "application/octet-stream", metadata: meta.metadata || {}, size }));
      // ENG-27 (Hermes INT N2): об'єкти (не JSON — версії фідів) — write-once. Ексклюзивне створення (fs.link → EEXIST): існує з тим
      // самим вмістом — повтор, нічого не записано (метадані теж не змінюються); з іншим — OBJECT_IMMUTABLE. Регістровий псевдонім
      // на NTFS / APFS — той самий файл → та сама відмова. Видалення (prune) лишається; захист від «видалити й записати» — звірка
      // байтів із маніфестом у Worker / servedChain / відкаті.
      try { await fsp.link(tmp, target); } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (!(await sameContent(tmp, target))) throw Object.assign(new Error(`OBJECT_IMMUTABLE: ${key} — об'єкт уже існує з іншим вмістом (версії не перезаписуються)`), { code: "OBJECT_IMMUTABLE", status: 412 });
        // Повтор після збою між створенням і записом метаданих: метаданих немає — дописати (наявні не змінюються).
        try { await fsp.link(tmp + ".meta", target + ".meta"); } catch (m) { if (m.code !== "EEXIST") throw m; }
        return { key, size, existed: true };
      }
      await fsp.rename(tmp + ".meta", target + ".meta");
      this.ops.bytesUploaded += size;
      return { key, size };
    } finally {
      await fsp.unlink(tmp).catch(() => {});
      await fsp.unlink(tmp + ".meta").catch(() => {});
    }
  }

  async head(key) {
    this.#check("head", key);
    this.ops.classB++;
    if (isCasKey(key)) {
      const cur = await this.#current(key);
      return cur.body ? { key, size: cur.body.length, contentType: cur.header.contentType, metadata: cur.header.metadata || {} } : null;
    }
    try {
      const meta = JSON.parse(await fsp.readFile(this.#file(key) + ".meta", "utf8"));
      const size = (await fsp.stat(this.#file(key))).size;
      return { key, size, contentType: meta.contentType, metadata: meta.metadata };
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  /** Повний вміст (малі службові об'єкти) або null. */
  async getBuffer(key) {
    this.#check("get", key);
    this.ops.classB++;
    if (isCasKey(key)) {
      const { body } = await this.#current(key);
      if (body) this.ops.bytesDownloaded += body.length;
      return body;
    }
    try {
      const data = await fsp.readFile(this.#file(key));
      this.ops.bytesDownloaded += data.length;
      return data;
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  async getJson(key) {
    const data = await this.getBuffer(key);
    return data ? JSON.parse(data.toString("utf8")) : null;
  }

  /** opts.ifMatch (ENG-20, B): умовний запис — рядок ETag (поточний вміст має мати саме його) або null (ключа не має бути).
   *  ENG-22 (F02): умова передається в put (meta.ifMatch) і перевіряється атомарно в точці запису (версійне зберігання, див. вище);
   *  невиконана умова → PRECONDITION_FAILED (412), нічого не записано. Модель If-Match / If-None-Match R2 — НЕ доказ поведінки
   *  справжнього R2. → { key, size, etag } */
  async putJson(key, value, opts = {}) {
    const body = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
    const conditional = Boolean(opts) && opts.ifMatch !== undefined;
    const r = await this.put(key, body, { contentType: "application/json", ...(conditional ? { ifMatch: opts.ifMatch } : {}) });
    if (r === null) throw preconditionFailed(key, opts.ifMatch, null);
    return { ...r, etag: etagOf(body) };
  }
  /** ENG-20 (B): JSON разом з ETag (SHA-256 збережених байтів) → { value, etag }; ключа немає → { value: null, etag: null }.
   *  Значення й ETag — з однієї версії (одне читання). */
  async getJsonEtag(key) {
    const data = await this.getBuffer(key);
    return data ? { value: JSON.parse(data.toString("utf8")), etag: etagOf(data) } : { value: null, etag: null };
  }

  /** Потік вмісту (великі YML) або null. */
  async getStream(key) {
    this.#check("get", key);
    this.ops.classB++;
    if (isCasKey(key)) {
      const { body } = await this.#current(key);
      if (!body) return null;
      this.ops.bytesDownloaded += body.length;
      return Readable.from([body]);
    }
    const file = this.#file(key);
    try { await fsp.access(file); } catch { return null; }
    const stream = fs.createReadStream(file);
    stream.on("data", (c) => { this.ops.bytesDownloaded += c.length; });
    return stream;
  }

  async list(prefix) {
    this.#check("list", prefix);
    this.ops.classA++;
    const dir = this.#file(prefix.replace(/\/$/, ""));
    const out = [];
    const walk = async (d, rel) => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return; throw e; }
      for (const e of entries) {
        if (e.name.endsWith(".meta") || e.name.includes(".tmp-") || e.name.endsWith(".cas-lock")) continue;
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory() && e.name.endsWith(".cas")) cas.add(prefix.replace(/\/$/, "") + "/" + r.slice(0, -4));
        else if (e.isDirectory()) await walk(path.join(d, e.name), r);
        else out.push(prefix.replace(/\/$/, "") + "/" + r);
      }
    };
    const cas = new Set();
    await walk(dir, "");
    // JSON-ключі: наявність — за останньою версією (видалений → не в переліку; файл без версій, записаний до ENG-22, — як був).
    for (const k of new Set([...out.filter(isCasKey), ...cas])) {
      const present = Boolean((await this.#current(k)).body);
      const i = out.indexOf(k);
      if (present && i < 0) out.push(k);
      if (!present && i >= 0) out.splice(i, 1);
    }
    return out.sort();
  }

  async delete(key) {
    this.#check("delete", key);
    this.ops.deletes++;
    // Видалення JSON-ключа — нова версія-позначка (deleted), упорядкована з умовними записами так само, як будь-який запис.
    if (isCasKey(key)) await this.#commit(key, Buffer.alloc(0), { deleted: true }, undefined);
    for (const f of [this.#file(key), this.#file(key) + ".meta"]) {
      try { await fsp.unlink(f); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  }
}
