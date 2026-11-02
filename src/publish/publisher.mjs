/** Публікація YML у сховище (R2 або локальне) — логіка mtPublishYml_ без Drive/Apps Script.
 *
 *  Ключі для фіду <name>:
 *    feeds/<name>/versions/<generatedAt>-<sha12>.xml[.gz]  — незмінні версії (ніколи не перезаписуються)
 *    feeds/<name>/manifest.json                            — { active, previous, history[] } — ЄДИНИЙ запис перемикання
 *
 *  Порядок: (повторне використання при незмінному sourceDigest) → PUT кандидата → readback (SHA/розмір/ID)
 *  → повторна перевірка джерела (колбек) → один PUT маніфесту → очищення старих версій понад retain.
 *  Будь-яка помилка до PUT маніфесту не змінює те, що бачить Prom. */
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { verifyYmlStream } from "../core/xml-verify.mjs";

export const manifestKey = (feed) => `feeds/${feed}/manifest.json`;
/** ENG-23 (E10): об'єкт версії фіду — лише під feeds/<фід>/ (як у Worker); службові ключі (state/…) ніколи не обслуговуються. */
export const ownFeedKey = (feed, entry) => typeof entry?.key === "string" && entry.key.startsWith(`feeds/${feed}/`) && !entry.key.includes("..");

/** CC R6 §6 п. 3: контракт готовності — сам модуль publisher (renderProbe тим самим шляхом, що runUpdate; cc-publisher.mjs). */
export const contract = "cc-publisher-v2";
export async function renderProbe(input) {
  const { ccPublisher } = await import("../pipeline/cc-publisher.mjs");
  return ccPublisher().renderProbe(input);
}

function versionKey(feed, built, gzip) {
  return `feeds/${feed}/versions/${built.generatedAt.replace(/[:.]/g, "-")}-${built.sha256.slice(0, 12)}.xml${gzip ? ".gz" : ""}`;
}

function entryFrom(key, built, object) {
  return {
    key, sha256: built.sha256, bytes: built.bytes, count: built.count, idsSha: built.idsSha, contentSha: built.contentSha,
    sourceDigest: built.sourceDigest, sourceSuccess: built.sourceSuccess, generatedAt: built.generatedAt, ccFingerprint: built.ccFingerprint ?? null,
    encoding: object.gzip ? "gzip" : "identity", storedBytes: object.size, storedSha256: object.storedSha256, publishedAt: new Date().toISOString(),
  };
}

/** ENG-27 (Hermes INT N2): відбиток ЗБЕРЕЖЕНИХ байтів версії, з яким звіряються Worker, servedChain, відкат і перевірки публікатора.
 *  Записи до ENG-27 без storedSha256: для identity збережені байти = YML (sha256), для gzip відбитка немає → неперевірна (fail-closed). */
export const expectedStoredSha = (entry) => (typeof entry?.storedSha256 === "string" && entry.storedSha256 ? entry.storedSha256 : entry?.encoding !== "gzip" && entry?.sha256 ? entry.sha256 : null);
/** Збережені байти версії відповідають маніфесту (розмір і SHA-256 самих байтів, не метаданих записувача)? true / false. */
export async function storedBytesOk(store, entry) {
  const want = expectedStoredSha(entry);
  if (!want) return false;
  const buf = await store.getBuffer(entry.key);
  if (!buf || buf.length !== entry.storedBytes) return false;
  return crypto.createHash("sha256").update(buf).digest("hex") === want;
}

/** Потік розпакованого вмісту версії для перевірки. */
async function contentStream(store, entry) {
  const raw = await store.getStream(entry.key);
  if (!raw) return null;
  return entry.encoding === "gzip" ? raw.pipe(zlib.createGunzip()) : raw;
}

/** Повна перевірка збереженої версії: SHA усього вмісту, байти, кількість і набір ID. */
export async function verifyStoredVersion(store, entry) {
  const head = await store.head(entry.key);
  if (!head || head.size !== entry.storedBytes || head.metadata?.sha256 !== entry.sha256) throw new Error("Збережена версія відсутня або метадані не збігаються");
  if (!(await storedBytesOk(store, entry))) throw new Error("Збережені байти версії не відповідають маніфесту (storedSha256)");
  const stream = await contentStream(store, entry);
  if (!stream) throw new Error("Збережена версія відсутня");
  return verifyYmlStream(stream, { count: entry.count, idsSha: entry.idsSha, sha256: entry.sha256, bytes: entry.bytes });
}

/** SHA-256 файлу (потоком). */
const fileSha256 = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash("sha256");
  fs.createReadStream(file).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});

async function gzipFile(src) {
  const dst = src + ".gz";
  await new Promise((resolve, reject) => {
    fs.createReadStream(src).pipe(zlib.createGzip({ level: 9 })).pipe(fs.createWriteStream(dst)).on("finish", resolve).on("error", reject);
  });
  return dst;
}

/**
 * @param store       сховище (LocalObjectStore / R2)
 * @param feed        назва фіду
 * @param file        шлях до сформованого XML
 * @param built       результат buildYml
 * @param options     { retain, readback: 'full'|'head', gzip, assertSourceUnchanged: async () => void,
 *                      checkCandidate: (xml) => void — CC R6 §6.4: перевірка КОЖНОГО кандидата (новий і перевикористаний) на стан CC;
 *                      виняток → нічого не перемикається }
 */
export async function publishFeed(store, feed, file, built, options = {}) {
  const retain = Math.max(2, options.retain ?? 7);
  const manifest = (await store.getJson(manifestKey(feed))) || { active: null, previous: null, history: [] };
  const active = manifest.active;

  let activeValid = false;
  if (active) {
    const h = await store.head(active.key).catch(() => null);
    // ENG-27 (N2): чинна — лише якщо збережені байти відповідають маніфесту (не метадані, які задає записувач).
    activeValid = Boolean(h && h.size === active.storedBytes && h.metadata?.sha256 === active.sha256) && (await storedBytesOk(store, active).catch(() => false));
  }
  // Ті самі товари/ціни/групи → той самий відбиток: новий файл не створюємо (економія операцій класу A).
  // CC R4 §6: REUSE лише за того самого відбитка стану Catalog Controls (він також входить у sourceDigest).
  if (activeValid && active.sourceDigest === built.sourceDigest && (active.ccFingerprint ?? null) === (built.ccFingerprint ?? null)) {
    // REUSE — теж кандидат: чинна версія перевіряється на свіжий стан CC (видалений / знятий не «перевикористовується»).
    if (typeof options.checkCandidate === "function") {
      const cur = await readVerifiedXml(store, active);
      if (cur === null) throw new Error("REUSE: чинна версія не проходить перевірку цілісності");
      options.checkCandidate(cur);
      // ENG-17 (Hermes ENG15-P1): запасна версія — лише перевірена на ПОТОЧНИЙ стан CC; зняття з обслуговування прибирається
      // лише після перевірки чинної версії. Маніфест переписується тільки якщо щось змінилось (економія операцій).
      const pfs = await fallbackSafe(store, manifest.previous, options.checkCandidate);
      if (manifest.withdrawn || (manifest.previousFallbackSafe ?? false) !== pfs) {
        if (options.assertSourceUnchanged) await options.assertSourceUnchanged();
        const { withdrawn: _w, ...rest } = manifest;
        await store.putJson(manifestKey(feed), { ...rest, previousFallbackSafe: pfs, updatedAt: new Date().toISOString() });
      }
    }
    return { feed, reused: true, active };
  }
  if (typeof options.checkCandidate === "function") options.checkCandidate(await fs.promises.readFile(file, "utf8"));

  const gzip = Boolean(options.gzip);
  const upload = gzip ? await gzipFile(file) : file;
  const key = versionKey(feed, built, gzip);
  const storedSha256 = await fileSha256(upload); // ENG-27 (N2): відбиток байтів, які зберігаються й обслуговуються
  const object = await store.put(key, { file: upload }, {
    contentType: gzip ? "application/gzip" : "application/xml; charset=utf-8",
    metadata: { sha256: built.sha256, count: String(built.count), idsSha: built.idsSha },
  });
  if (gzip) await fs.promises.unlink(upload).catch(() => {});
  const next = entryFrom(key, built, { gzip, size: object.size, storedSha256 });

  try {
    if (options.readback === "head") {
      const h = await store.head(key);
      if (!h || h.size !== next.storedBytes || h.metadata?.sha256 !== next.sha256) throw new Error("Readback: метадані кандидата не збігаються");
    } else {
      await verifyStoredVersion(store, next);
    }
    if (options.assertSourceUnchanged) await options.assertSourceUnchanged();
  } catch (error) {
    // Кандидат не став активним — прибираємо, щоб не займав місце.
    await store.delete(key).catch(() => {});
    throw error;
  }

  // Hermes E7 / правило 8: Worker віддає попередню версію при недоступності активної ЛИШЕ якщо її перевірено на поточний стан CC.
  const previousFallbackSafe = activeValid ? await fallbackSafe(store, active, options.checkCandidate) : false;
  const history = [next, ...(manifest.history || []).filter((h) => h.key !== next.key)].slice(0, retain);
  const nextManifest = {
    kind: "FEED_MANIFEST_V1",
    feed,
    active: next,
    previous: activeValid ? stripHistory(active) : manifest.previous,
    previousFallbackSafe: activeValid ? previousFallbackSafe : false,
    history,
    updatedAt: new Date().toISOString(),
  };
  await store.putJson(manifestKey(feed), nextManifest); // ЄДИНЕ перемикання для читачів

  const removed = await prune(store, feed, nextManifest);
  return { feed, reused: false, active: next, previous: nextManifest.previous, removed };
}

function stripHistory(entry) {
  return entry ? { ...entry } : null;
}

/** Видаляє версії, на які не посилаються active/previous/history. Видалення в R2 безплатні. */
async function prune(store, feed, manifest) {
  const keep = new Set([manifest.active?.key, manifest.previous?.key, ...manifest.history.map((h) => h.key)].filter(Boolean));
  const keys = await store.list(`feeds/${feed}/versions/`);
  const removed = [];
  for (const k of keys) if (!keep.has(k)) { await store.delete(k); removed.push(k); }
  return removed;
}

/** Зняти фід з обслуговування (явний контракт, Hermes E7): активна версія суперечить стану CC, а безпечний патч неможливий.
 *  Worker віддає 503 (ніколи не небезпечну версію й не попередню). Наступна успішна публікація прибирає позначку. */
export async function withdrawFeed(store, feed, reason) {
  const manifest = await store.getJson(manifestKey(feed));
  if (!manifest?.active) return { withdrawn: false, reason: "немає активної версії" };
  await store.putJson(manifestKey(feed), { ...manifest, withdrawn: { at: new Date().toISOString(), reason: String(reason).slice(0, 500) }, previousFallbackSafe: false });
  return { withdrawn: true };
}

/** Повний текст збереженої версії (розпакований) — для останніх опублікованих offer і перевірки старих версій. */
export async function readVersionXml(store, entry) {
  const stream = await contentStream(store, entry);
  if (!stream) return null;
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}
/** Перевірена версія: метадані + повний вміст (verifyYmlStream: кількість, idsSha, sha256, байти) → текст або null.
 *  ENG-18 (Hermes ENG17-P3, read-TOCTOU): вміст читається ОДИН раз — перевіряються й повертаються ті самі байти (раніше: перевірка
 *  одного читання, повернення іншого; об'єкт, змінений між читаннями, давав неперевірений текст → absent / DONE). */
export async function readVerifiedXml(store, entry) {
  if (!entry) return null;
  try {
    const head = await store.head(entry.key);
    if (!head || head.size !== entry.storedBytes || head.metadata?.sha256 !== entry.sha256) return null;
    if (!(await storedBytesOk(store, entry))) return null; // ENG-27 (N2): байти, які віддасть Worker, — саме ці
    const stream = await contentStream(store, entry);
    if (!stream) return null;
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const buf = Buffer.concat(chunks);
    await verifyYmlStream([buf], { count: entry.count, idsSha: entry.idsSha, sha256: entry.sha256, bytes: entry.bytes });
    return buf.toString("utf8");
  } catch { return null; }
}
/** Чи може версія бути запасною: перевірений вміст і жодного порушення стану CC (checkCandidate). Без перевірки — ні. */
async function fallbackSafe(store, entry, checkCandidate) {
  if (!entry || typeof checkCandidate !== "function") return false;
  const xml = await readVerifiedXml(store, entry);
  if (xml === null) return false;
  try { checkCandidate(xml); return true; } catch { return false; }
}
const ENCODINGS = Object.freeze({ xml: false, gz: true });
/**
 * ENG-17 (Hermes ENG15-P1 / I15–I16): що ФАКТИЧНО віддає Worker — той самий алгоритм (worker/src/index.js): manifest.withdrawn → нічого;
 * для запиту .xml / .xml.gz — активна версія потрібного кодування, якщо метадані об'єкта збігаються з маніфестом; інакше попередня —
 * лише за previousFallbackSafe === true. Для кожної ланки — також перевірений вміст (xml або null).
 * → { manifest, served: { xml: "active"|"previous"|null, gz: … }, possible: { xml: [...], gz: [...] }, links: { active, previous } }
 *
 * ENG-22 (Hermes ENG-21 F01): помилка HEAD (тимчасова недоступність сховища) — НЕ доказ відсутності об'єкта: Worker може віддати
 * його наступним запитом. Такий об'єкт — metaOk "unknown": вважається, що він МОЖЕ обслуговуватися (без перевіреного вмісту → небезпечний),
 * і далі по ланцюгу теж (Worker перейде до previous, якщо active насправді недоступний). possible — усі версії, які Worker може віддати;
 * served — перша з них (сумісність). Безпечність рахується за possible (servedNames).
 */
export const META_UNKNOWN = "unknown";
export async function servedChain(store, feed) {
  const manifest = await store.getJson(manifestKey(feed));
  if (!manifest?.active) return { manifest: manifest || null, served: { xml: null, gz: null }, possible: { xml: [], gz: [] }, links: {} };
  const metaOk = async (e) => {
    if (!e) return false;
    let h;
    try { h = await store.head(e.key); } catch { return META_UNKNOWN; }
    if (!(h && h.size === e.storedBytes && h.metadata?.sha256 === e.sha256)) return false;
    // ENG-27 (N2): Worker ENG-27 віддає лише версію, чиї ЗБЕРЕЖЕНІ байти збігаються з маніфестом (storedSha256); Worker до ENG-27
    // перевіряв лише метадані. Метадані збігаються, а байти — ні (або їх не прочитано) → «може обслуговуватися» (unknown): без
    // перевіреного вмісту → небезпечна → зняття (UNSAFE), незалежно від того, яку версію Worker розгорнуто.
    try { return (await storedBytesOk(store, e)) ? true : META_UNKNOWN; } catch { return META_UNKNOWN; }
  };
  const link = async (e, eligible) => (e ? { entry: e, eligible, metaOk: await metaOk(e), xml: await readVerifiedXml(store, e) } : null);
  const links = { active: await link(manifest.active, ownFeedKey(feed, manifest.active)), previous: await link(manifest.previous, manifest.previousFallbackSafe === true && ownFeedKey(feed, manifest.previous)) };
  const pickAll = (wantGzip) => {
    if (manifest.withdrawn) return [];
    const out = [];
    for (const name of ["active", "previous"]) {
      const l = links[name];
      if (!l || !l.eligible || (l.entry.encoding === "gzip") !== wantGzip || l.metaOk === false) continue;
      out.push(name);
      if (l.metaOk === true) break; // Worker віддасть цю версію — далі по ланцюгу не піде
    }
    return out;
  };
  const possible = Object.fromEntries(Object.entries(ENCODINGS).map(([k, g]) => [k, pickAll(g)]));
  return { manifest, served: Object.fromEntries(Object.entries(possible).map(([k, v]) => [k, v[0] ?? null])), possible, links };
}
/** Усі версії, які Worker може віддати (обидва кодування, з урахуванням невідомого HEAD). */
export const servedNames = (ch) => [...new Set(Object.values(ch.possible || {}).flat())];
/** Тексти версій, які фактично обслуговуються (обидва кодування); null — якщо обслуговуваної версії немає або її вміст не перевірено
 *  (доказ публікації неможливий: Hermes ENG15-P3 — пошкоджений / нечитабельний / знятий з обслуговування → unknown, не DONE). */
export async function readServedVersions(store, feed) {
  const ch = await servedChain(store, feed);
  const names = servedNames(ch);
  if (!names.length) return null;
  const xmls = names.map((n) => ch.links[n].xml);
  return xmls.every((x) => typeof x === "string") ? xmls : null;
}
/** Попередня версія більше не є запасною (стан CC змінився / вміст не перевірено). */
export async function invalidateFallback(store, feed, reason) {
  const manifest = await store.getJson(manifestKey(feed));
  if (!manifest?.active || manifest.previousFallbackSafe !== true) return { changed: false };
  await store.putJson(manifestKey(feed), { ...manifest, previousFallbackSafe: false, fallbackInvalidated: { at: new Date().toISOString(), reason: String(reason).slice(0, 300) } });
  return { changed: true };
}

/** Активна версія фіду: { entry, xml } або null. */
export async function readActiveXml(store, feed) {
  const manifest = await store.getJson(manifestKey(feed));
  if (!manifest?.active) return null;
  const xml = await readVersionXml(store, manifest.active).catch(() => null);
  return xml == null ? null : { entry: manifest.active, xml };
}

/** Ручний відкат: попередня (або вказана з history) версія стає активною після повної перевірки.
 *  violations (S7 / CC R6 правило 8) — ОБОВ'ЯЗКОВА: xml → порушення стану CC (yml.mjs: controlsViolations — видалений у фіді / знятий
 *  доступний); без неї або з будь-яким порушенням → відкат заборонено (стара версія не повертає видалений чи знятий товар).
 *  verify — async (): перевірка свіжого стану CC безпосередньо перед перемиканням (виняток → не перемикати). */
export async function rollbackFeed(store, feed, { toKey, violations = null, verify = null } = {}) {
  if (typeof violations !== "function") throw new Error("Відкат заборонено: без перевірки стану Catalog Controls (правило 8 — стара версія може повернути видалений товар)");
  const manifest = await store.getJson(manifestKey(feed));
  if (!manifest?.active) throw new Error("Немає опублікованого фіду " + feed);
  const target = toKey ? manifest.history.find((h) => h.key === toKey) : manifest.previous;
  if (!target) throw new Error("Немає попередньої версії для відкату");
  if (!ownFeedKey(feed, target)) throw new Error("Відкат заборонено: версія поза feeds/" + feed + "/ (службовий ключ не може стати фідом)");
  await verifyStoredVersion(store, target);
  const bad = violations(await readVersionXml(store, target));
  if (!Array.isArray(bad)) throw new Error("Відкат заборонено: перевірка стану Catalog Controls не дала результату");
  if (bad.length) throw new Error(`Відкат заборонено: версія суперечить стану Catalog Controls (${bad.length}: ${bad.slice(0, 5).map((x) => x.id + " — " + x.why).join(", ")})`);
  if (typeof verify === "function") await verify();
  // Поточна активна стає попередньою: як запасна — лише якщо теж без порушень стану CC.
  let previousFallbackSafe = false;
  try { const x = await readVerifiedXml(store, manifest.active); const b = x === null ? null : violations(x); previousFallbackSafe = Array.isArray(b) && b.length === 0; } catch { previousFallbackSafe = false; }
  const { withdrawn: _w, ...rest } = manifest;
  const next = { ...rest, active: target, previous: manifest.active, previousFallbackSafe, updatedAt: new Date().toISOString(), rolledBackAt: new Date().toISOString() };
  await store.putJson(manifestKey(feed), next);
  return next;
}
