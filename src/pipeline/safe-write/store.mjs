/** E3 (ENG-01 K2) — версійне сховище стану записувачів. Контракт `cc-store-v1` (Catalog Controls R3, CC-R3-READINESS-CONTRACT §4):
 *    getJsonVersioned(key)               → { value, version }  (value і version — null, якщо ключа немає)
 *    putJsonIfVersion(key, value, version) → { version }        (виняток code="CONFLICT", якщо поточна версія ≠ version;
 *                                                                 version = null — створити лише якщо ключа немає)
 *  Значення копіюються при читанні й записі: викликач не може змінити збережене через посилання.
 *
 *  Fencing (Р7, рішення власника 29.10): putJsonIfVersionFenced(key, value, version, { leaseKey, token }) — АТОМАРНО (в одній
 *  критичній секції) перевіряє, що оренда за leaseKey має саме цей token і не звільнена, і лише тоді виконує CAS ключа.
 *  Запис застарілої оренди відхиляється без зміни будь-яких інших ключів (жодного «оновлення версії» чужих ключів).
 *  Безпеку дає рівність токена: перехоплення оренди й fenced-запис лінеаризовані замком ключа оренди. Сплив оренди без
 *  перехоплення — питання живучості (assertCurrent), не безпеки: такий запис упорядкований ДО перехоплення.
 *  Відмова fencing — виняток code="STALE_LEASE" (контракт CC R4 §3: «CONFLICT — версія; STALE_LEASE — оренда») і fencing=true.
 *  Якщо передано fence.scope — оренда має належати саме цій області (запис чужою орендою того самого ресурсу відхиляється).
 *
 *  MemoryStore — для тестів і однопроцесних прогонів.
 *  FileStore   — локальний прототип, що переживає перезапуск процесу: CAS через ексклюзивний файл-замок (open "wx") і атомарне
 *                перейменування. ОБМЕЖЕННЯ: лише один хост / один диск. Спільне сховище для CI й локальних запусків (вимога W2:
 *                «однакове для всіх запусків») — окреме рішення власника (Durable Object / R2 / інше), див. ENG-04.
 *
 *  ENG-23 (узгоджений контракт F04 / F06 / F08, розд. 2.5, E3) — ЗАПЕЧАТАНІ ключі:
 *   • контрольна точка CC (`state/catalog-controls/checkpoint.json`) пишеться ЛИШЕ putJsonIfVersionFenced(…, { leaseKey, token,
 *     leaseId, ticket }) з дійсним квитком. В ОДНІЙ критичній секції з CAS ключа сховище перевіряє: оренду (token, leaseId, не
 *     звільнена, не сплила), version = expectedVersion квитка, sha256(JCS(value)) = nextHash, квиток відомий ЦЬОМУ екземпляру сховища,
 *     не погашений, не прострочений, належить цій оренді; далі — запис і погашення квитка. Розбіжність → CC_TICKET_REJECTED.
 *     Будь-який інший запис ключа точки (putJsonIfVersion, fenced без квитка) → CC_KEY_SEALED;
 *   • head протоколу serving (`state/cc-serving/head.json`, власник — Engineering) пишеться лише через «стіл квитків» (desk);
 *   • стіл квитків — один на екземпляр сховища й видається ОДИН раз: claimDesk({ now }) — його забирає перший WriteGateway над цим
 *     сховищем (повторний виклик → DESK_CLAIMED); desk.bind(binding) прив'язує стіл до одного фізичного сховища фідів (інша прив'язка →
 *     DESK_BOUND). Реєстр квитків і запис head — лише через стіл (модуль не експортує внутрішнього доступу).
 *  Межа довіри — API сховища в процесі; прямі зміни файлів на диску — поза моделлю загроз (рішення власника Q6).
 *
 *  ENG-25 (Hermes ENG-24 N1): ключі — лише канонічні (src/storage/keys.mjs: нижній регістр, без «\», порожніх сегментів, «.» / «..»,
 *  кінцевих крапок, імен пристроїв), інакше INVALID_KEY — для КОЖНОГО методу й КОЖНОГО ключа (зокрема fence.leaseKey і читання).
 *  Запечатані ключі розпізнаються за фізичною ідентичністю: будь-який інший запис того самого файлу (напр. «STATE/…» на NTFS) —
 *  CC_KEY_SEALED незалежно від оренди й квитка. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { jcs, jcsHash } from "./jcs.mjs";
import { canonicalStateKey, keyIdentity } from "../../storage/keys.mjs";

export const SEALED_CHECKPOINT_KEY = "state/catalog-controls/checkpoint.json";
export const SERVING_HEAD_KEY = "state/cc-serving/head.json";
const TICKET_PHASES = new Set(["init", "intents", "settle", "recovery", "debt", "issued", "recover"]);

export class StoreConflictError extends Error {
  constructor(key, expected, actual) {
    super(`CONFLICT: «${key}» — версія ${actual ?? "відсутня"} ≠ очікуваній ${expected ?? "відсутня"}`);
    this.name = "StoreConflictError";
    this.code = "CONFLICT";
    this.key = key;
  }
}

/** Запис від імені оренди, яка вже не чинна (перехоплена або звільнена). */
export class StoreFencedError extends Error {
  constructor(key, reason) {
    super(`STALE_LEASE: «${key}» — запис застарілої або чужої оренди відхилено (${reason})`);
    this.name = "StoreFencedError";
    this.code = "STALE_LEASE";
    this.fencing = true;
    this.key = key;
  }
}

/** Запис запечатаного ключа без квитка / повз стіл — будь-яким методом, будь-яким викликачем. */
export class StoreSealedError extends Error {
  constructor(key, reason) { super(`CC_KEY_SEALED: «${key}» — ${reason}`); this.name = "StoreSealedError"; this.code = "CC_KEY_SEALED"; this.key = key; }
}
/** Квиток не той / погашений / прострочений / чужий / іншого екземпляра сховища. */
export class TicketRejectedError extends Error {
  constructor(key, reasons) { super(`CC_TICKET_REJECTED: «${key}» — ${reasons.join("; ")}`); this.name = "TicketRejectedError"; this.code = "CC_TICKET_REJECTED"; this.key = key; this.reasons = reasons; }
}

const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const HEX32 = /^[0-9a-f]{32}$/, HEX64 = /^[0-9a-f]{64}$/;
/** Стіл квитків екземпляра сховища (внутрішній стан модуля, назовні — лише фасад із claimDesk). */
const DESKS = new WeakMap();
const HEAD_WRITE = Symbol("serving-head-write");
function deskFacade(store, d) {
  return Object.freeze({
    get binding() { return d.binding; },
    now: () => d.now(),
    /** Прив'язати стіл до фізичного сховища фідів (один раз; інша прив'язка → DESK_BOUND). */
    bind(binding) {
      if (typeof binding !== "string" || !binding) throw Object.assign(new Error("DESK_BINDING: стіл квитків потребує прив'язки до фізичного сховища фідів"), { code: "DESK_BINDING" });
      if (d.binding === null) d.binding = binding;
      else if (d.binding !== binding) throw Object.assign(new Error("DESK_BOUND: стіл квитків цього сховища W2 уже прив'язано до іншого сховища фідів"), { code: "DESK_BOUND" });
      return true;
    },
    /** Зареєструвати квиток (лише cc-serving-v2.beforeCommit). */
    registerTicket(ticket) {
      const t = ticket && typeof ticket === "object" ? ticket : {};
      const bad = [];
      if (t.v !== 1) bad.push("v");
      if (t.key !== SEALED_CHECKPOINT_KEY) bad.push("key");
      if (!HEX64.test(String(t.nextHash))) bad.push("nextHash");
      if (!(t.expectedVersion === null || typeof t.expectedVersion === "string")) bad.push("expectedVersion");
      if (!Number.isInteger(t.leaseToken) || t.leaseToken < 1) bad.push("leaseToken");
      if (!HEX32.test(String(t.leaseId))) bad.push("leaseId");
      if (!TICKET_PHASES.has(t.phase)) bad.push("phase");
      if (!HEX32.test(String(t.nonce))) bad.push("nonce");
      if (!Number.isFinite(t.notAfter)) bad.push("notAfter");
      if (bad.length) throw new TicketRejectedError(SEALED_CHECKPOINT_KEY, ["квиток невалідний: " + bad.join(", ")]);
      if (d.tickets.has(t.nonce) || d.spent.has(t.nonce)) throw new TicketRejectedError(SEALED_CHECKPOINT_KEY, ["повторний nonce квитка"]);
      d.tickets.set(t.nonce, Object.freeze(clone(t)));
      return true;
    },
    /** Відкликати ще не погашений квиток (напр. оренду втрачено до запису). */
    revokeTicket(nonce) { if (d.tickets.delete(String(nonce))) d.spent.add(String(nonce)); },
    /** Запис head протоколу serving: CAS + fencing оренди (token, leaseId). */
    putHead(value, version, fence) { return store[HEAD_WRITE](value, version, fence); },
  });
}
function claimDeskOf(store, { now = Date.now } = {}) {
  if (DESKS.has(store)) throw Object.assign(new Error("DESK_CLAIMED: стіл квитків цього сховища W2 уже видано (лише перший WriteGateway)"), { code: "DESK_CLAIMED" });
  const nd = { binding: null, now, tickets: new Map(), spent: new Set() };
  nd.facade = deskFacade(store, nd);
  DESKS.set(store, nd);
  return nd.facade;
}
/** Перевірка квитка для запису ключа точки (синхронна — у тій самій критичній секції, що й CAS). Повертає nonce для погашення. */
function checkTicket(store, key, value, version, fence, leaseRec) {
  const t = fence?.ticket;
  if (!t || typeof t !== "object") throw new StoreSealedError(key, "запис контрольної точки без квитка beforeCommit заборонено");
  const d = DESKS.get(store);
  const reg = d?.tickets.get(String(t.nonce));
  const why = [];
  if (!reg) why.push("квиток невідомий цьому екземпляру сховища (інший процес / екземпляр, погашений або відкликаний)");
  else {
    const now = d.now();
    if (jcs(reg) !== jcs(t)) why.push("квиток змінено після видачі");
    if (reg.key !== key) why.push("квиток для іншого ключа");
    if (reg.expectedVersion !== (version ?? null)) why.push(`квиток для версії ${reg.expectedVersion ?? "відсутня"}, запис — для ${version ?? "відсутня"}`);
    let hash = null;
    try { hash = jcsHash(value); } catch (e) { why.push("значення не є JSON: " + e.message); }
    if (hash !== null && hash !== reg.nextHash) why.push("значення не те, на яке видано квиток (nextHash)");
    if (now > reg.notAfter) why.push("квиток прострочено");
    if (reg.leaseToken !== fence.token || reg.leaseId !== fence.leaseId) why.push("квиток іншої оренди");
    if (!leaseRec || leaseRec.token !== reg.leaseToken || leaseRec.leaseId !== reg.leaseId) why.push("оренда квитка не чинна (перехоплено / відкат)");
    else if (leaseRec.released) why.push("оренду квитка звільнено");
    else if (now >= leaseRec.expiresAt) why.push("оренда квитка сплила");
  }
  if (why.length) throw new TicketRejectedError(key, why);
  return reg.nonce;
}
function spend(store, nonce) { const d = DESKS.get(store); if (d && d.tickets.delete(nonce)) d.spent.add(nonce); }
const CHECKPOINT_ID = keyIdentity(SEALED_CHECKPOINT_KEY), HEAD_ID = keyIdentity(SERVING_HEAD_KEY);
/** Запечатаний ключ — за фізичною ідентичністю (псевдонім регістру / кінцевої крапки / «\» — той самий файл). */
const sealedWithoutDesk = (key) => { const id = keyIdentity(key); return id === CHECKPOINT_ID || id === HEAD_ID; };
/** Fenced-запис: head — лише стіл квитків; ключ точки — лише точним канонічним записом (псевдонім → CC_KEY_SEALED). */
function sealedFenced(key) {
  const id = keyIdentity(key);
  if (id === HEAD_ID) throw new StoreSealedError(key, "head протоколу serving пише лише Engineering (стіл квитків)");
  if (id === CHECKPOINT_ID && key !== SEALED_CHECKPOINT_KEY) throw new StoreSealedError(key, "псевдонім ключа контрольної точки (інший запис того самого фізичного ключа) заборонено");
}
/** ENG-25 (N1): лише канонічний ключ сховища стану (src/storage/keys.mjs), інакше INVALID_KEY. */
const checkKey = canonicalStateKey;
/** Перевірка fencing: оренда за leaseKey має той самий token і не звільнена. */
function checkFence(key, lease, fence) {
  if (!fence || typeof fence.leaseKey !== "string" || !Number.isInteger(fence.token)) throw new Error("fenced-запис: потрібні leaseKey і token");
  if (fence.leaseKey === key) throw new Error("fenced-запис: ключ оренди не можна писати fenced-записом");
  if (!lease || lease.token !== fence.token) throw new StoreFencedError(key, `чинний token ${lease?.token ?? "—"}, запит від token ${fence.token}`);
  // ENG-23 (E1): ідентичність оренди — і leaseId (якщо пред'явлено; для ключа точки й head — обов'язково).
  if (fence.leaseId !== undefined && lease.leaseId !== fence.leaseId) throw new StoreFencedError(key, `оренда token ${fence.token} з іншим leaseId (відкат сховища W2 або чужа видача)`);
  if (lease.released) throw new StoreFencedError(key, `оренду token ${fence.token} звільнено`);
  if (fence.scope && lease.scope !== fence.scope) throw new StoreFencedError(key, `оренда token ${fence.token} належить області «${lease.scope}», а не «${fence.scope}»`);
}

export class MemoryStore {
  constructor() { this.map = new Map(); this.seq = 0; }
  async getJsonVersioned(key) {
    const e = this.map.get(checkKey(key));
    return e ? { value: clone(e.value), version: e.version } : { value: null, version: null };
  }
  async putJsonIfVersion(key, value, version) {
    if (sealedWithoutDesk(key)) throw new StoreSealedError(key, "запис без оренди й квитка заборонено");
    checkKey(key);
    return this.#cas(key, value, version);
  }
  /** Перевірка оренди (+ квиток для ключа точки) + CAS без жодного await між ними — атомарно в межах процесу. */
  async putJsonIfVersionFenced(key, value, version, fence) {
    sealedFenced(key);
    checkKey(key);
    const leaseRec = this.map.get(checkKey(fence?.leaseKey ?? ""))?.value;
    checkFence(key, leaseRec, fence);
    if (key !== SEALED_CHECKPOINT_KEY) return this.#cas(key, value, version);
    if (fence?.leaseId === undefined) throw new StoreSealedError(key, "запис точки без leaseId оренди заборонено");
    const nonce = checkTicket(this, key, value, version, fence, leaseRec);
    const r = this.#cas(key, value, version);
    spend(this, nonce);
    return r;
  }
  /** ENG-23: стіл квитків цього екземпляра (один, прив'язаний до сховища фідів). */
  claimDesk(opts) { return claimDeskOf(this, opts); }
  [HEAD_WRITE](value, version, fence) {
    checkFence(SERVING_HEAD_KEY, this.map.get(checkKey(fence?.leaseKey ?? ""))?.value, fence);
    if (fence?.leaseId === undefined) throw new StoreSealedError(SERVING_HEAD_KEY, "запис head без leaseId оренди заборонено");
    return this.#cas(SERVING_HEAD_KEY, value, version);
  }
  #cas(key, value, version) {
    const e = this.map.get(checkKey(key));
    const cur = e ? e.version : null;
    if (cur !== (version ?? null)) throw new StoreConflictError(key, version ?? null, cur);
    const v = String(++this.seq);
    this.map.set(key, { value: clone(value), version: v });
    return { version: v };
  }
}

export class FileStore {
  /** probe(event, key) — лише для тестів атомарності: "fence-checked" (між перевіркою оренди й CAS) і "committed". */
  constructor(dir, { lockWaitMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), probe = null } = {}) {
    this.dir = dir; this.lockWaitMs = lockWaitMs; this.sleep = sleep; this.probe = probe;
    fs.mkdirSync(dir, { recursive: true });
  }
  #file(key) { return path.join(this.dir, encodeURIComponent(checkKey(key)) + ".json"); }
  #read(file) {
    try { const d = JSON.parse(fs.readFileSync(file, "utf8")); return { value: d.value ?? null, version: d.version ?? null }; }
    catch (e) { if (e.code === "ENOENT") return { value: null, version: null }; throw e; }
  }
  async getJsonVersioned(key) { const r = this.#read(this.#file(key)); return { value: clone(r.value), version: r.version }; }
  async putJsonIfVersion(key, value, version) {
    if (sealedWithoutDesk(key)) throw new StoreSealedError(key, "запис без оренди й квитка заборонено");
    checkKey(key);
    return this.#withLock(key, () => this.#cas(key, value, version));
  }
  /** Замок ключа оренди → замок ключа (завжди в цьому порядку) — перехоплення оренди не може вклинитися між перевіркою й CAS.
   *  ENG-23: для ключа точки в тій самій критичній секції — перевірка квитка; погашення — одразу після CAS (синхронно). */
  async putJsonIfVersionFenced(key, value, version, fence) {
    sealedFenced(key);
    checkKey(key);
    const leaseKey = checkKey(fence?.leaseKey ?? "");
    if (leaseKey === key) throw new Error("fenced-запис: ключ оренди не можна писати fenced-записом"); // до замків: інакше — подвійний замок
    if (key === SEALED_CHECKPOINT_KEY && fence?.leaseId === undefined) throw new StoreSealedError(key, "запис точки без leaseId оренди заборонено");
    return this.#withLock(leaseKey, () => this.#withLock(key, () => {
      const leaseRec = this.#read(this.#file(leaseKey)).value;
      checkFence(key, leaseRec, fence);
      const nonce = key === SEALED_CHECKPOINT_KEY ? checkTicket(this, key, value, version, fence, leaseRec) : null;
      this.probe?.("fence-checked", key);
      const r = this.#cas(key, value, version);
      if (nonce) spend(this, nonce);
      return r;
    }));
  }
  /** ENG-23: стіл квитків цього екземпляра (один, прив'язаний до сховища фідів). */
  claimDesk(opts) { return claimDeskOf(this, opts); }
  [HEAD_WRITE](value, version, fence) {
    const leaseKey = checkKey(fence?.leaseKey ?? "");
    if (fence?.leaseId === undefined) throw new StoreSealedError(SERVING_HEAD_KEY, "запис head без leaseId оренди заборонено");
    return this.#withLock(leaseKey, () => this.#withLock(SERVING_HEAD_KEY, () => {
      checkFence(SERVING_HEAD_KEY, this.#read(this.#file(leaseKey)).value, fence);
      return this.#cas(SERVING_HEAD_KEY, value, version);
    }));
  }
  async #withLock(key, fn) {
    const lock = this.#file(key) + ".lock";
    const t0 = Date.now();
    let fd;
    for (;;) {
      try { fd = fs.openSync(lock, "wx"); break; } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (Date.now() - t0 > this.lockWaitMs) throw Object.assign(new Error(`сховище: замок «${key}» не звільнено за ${this.lockWaitMs} мс`), { code: "LOCKED" });
        await this.sleep(20);
      }
    }
    try { return await fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  #cas(key, value, version) {
    const file = this.#file(key);
    const cur = this.#read(file).version;
    if (cur !== (version ?? null)) throw new StoreConflictError(key, version ?? null, cur);
    const next = String((Number(cur) || 0) + 1);
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: next, value: clone(value) }));
    fs.renameSync(tmp, file);
    this.probe?.("committed", key);
    return { version: next };
  }
}

/** ENG-29: квиток для запису ключа точки через RemoteStore — ті самі перевірки, що checkTicket, КРІМ запису оренди: його атомарно з
 *  CAS перевіряє сервер (w2-engine: token, leaseId, не звільнена, не сплила на момент desk.now()). */
function checkTicketClient(store, key, value, version, fence) {
  const t = fence?.ticket;
  if (!t || typeof t !== "object") throw new StoreSealedError(key, "запис контрольної точки без квитка beforeCommit заборонено");
  const d = DESKS.get(store);
  const reg = d?.tickets.get(String(t.nonce));
  const why = [];
  if (!reg) why.push("квиток невідомий цьому екземпляру сховища (інший процес / екземпляр, погашений або відкликаний)");
  else {
    if (jcs(reg) !== jcs(t)) why.push("квиток змінено після видачі");
    if (reg.key !== key) why.push("квиток для іншого ключа");
    if (reg.expectedVersion !== (version ?? null)) why.push(`квиток для версії ${reg.expectedVersion ?? "відсутня"}, запис — для ${version ?? "відсутня"}`);
    let hash = null;
    try { hash = jcsHash(value); } catch (e) { why.push("значення не є JSON: " + e.message); }
    if (hash !== null && hash !== reg.nextHash) why.push("значення не те, на яке видано квиток (nextHash)");
    if (d.now() > reg.notAfter) why.push("квиток прострочено");
    if (reg.leaseToken !== fence.token || reg.leaseId !== fence.leaseId) why.push("квиток іншої оренди");
  }
  if (why.length) throw new TicketRejectedError(key, why);
  return reg.nonce;
}
const fenceOf = (f) => ({ leaseKey: f.leaseKey, token: f.token, ...(f.leaseId !== undefined ? { leaseId: f.leaseId } : {}), ...(f.scope ? { scope: f.scope } : {}) });

/** ENG-29 (переїзд на сервер) — сховище W2 у Cloudflare Durable Object (Worker mm-ops, POST /w2; сервер — w2-engine.mjs).
 *  Те саме API, що MemoryStore / FileStore. Ключі, запечатані ключі й квитки перевіряються тут (стіл квитків — лише в процесі),
 *  оренда + CAS — атомарно на сервері. Кожен запит має reqId: повтор після мережевої помилки чи 5xx повертає збережену відповідь
 *  сервера (запис не виконується двічі). Сховище недоступне після повторів → виняток W2_UNAVAILABLE (fail-closed: шлюз не пише). */
export class RemoteStore {
  constructor({ url, key, fetchImpl = globalThis.fetch, retries = 3, timeoutMs = 20_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    if (!/^https:\/\//.test(String(url || "")) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(url || ""))) throw new Error("W2: адреса сховища має бути https://");
    if (!key || String(key).length < 20) throw new Error("W2: немає ключа доступу до сховища");
    this.endpoint = new URL("/w2", url).href; this.key = String(key); this.fetchImpl = fetchImpl; this.retries = retries; this.timeoutMs = timeoutMs; this.sleep = sleep;
    // Шлюз над цим сховищем подовжує оренду кожні 4 хв (операції на сервері довші за ttl оренди 15 хв) — WriteGateway.heartbeatMs.
    this.leaseHeartbeatMs = 4 * 60_000;
    this.stats = { calls: 0, ms: 0 }; // ENG-29: розбивка часу операції (звернення до сховища W2)
  }
  async #call(body) {
    const t0 = Date.now();
    try { return await this.#callOnce(body); } finally { this.stats.calls++; this.stats.ms += Date.now() - t0; }
  }
  async #callOnce(body) {
    const req = JSON.stringify({ ...body, reqId: crypto.randomBytes(16).toString("hex") });
    let last = "";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await this.sleep(1000 * attempt);
      let res, text;
      try {
        res = await this.fetchImpl(this.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs), headers: { authorization: "Bearer " + this.key, "content-type": "application/json" }, body: req });
        text = await res.text();
      } catch (e) { last = "мережа: " + String(e?.name || e?.message || e).slice(0, 80); continue; }
      if (res.status >= 500 || res.status === 429) { last = "HTTP " + res.status; continue; }
      let data = null; try { data = JSON.parse(text); } catch { /* */ }
      if (!res.ok && !data?.error) throw Object.assign(new Error(`W2: сховище відхилило запит (HTTP ${res.status})`), { code: "W2_UNAVAILABLE" });
      if (data?.error) {
        const e = data.error, k = e.key ?? body.key;
        if (e.code === "CONFLICT") throw new StoreConflictError(k, e.expected ?? null, e.actual ?? null);
        if (e.code === "STALE_LEASE") throw new StoreFencedError(k, String(e.message || ""));
        if (e.code === "CC_KEY_SEALED") throw new StoreSealedError(k, String(e.message || "").replace(/^CC_KEY_SEALED: «[^»]*» — /, ""));
        if (e.code === "CC_TICKET_REJECTED") throw new TicketRejectedError(k, Array.isArray(e.reasons) ? e.reasons : [String(e.message || "")]);
        throw Object.assign(new Error(String(e.message || e.code)), { code: e.code || "W2_ERROR" });
      }
      if (!data || typeof data.result !== "object" || data.result === null) throw Object.assign(new Error("W2: відповідь сховища без результату"), { code: "W2_UNAVAILABLE" });
      return data.result;
    }
    throw Object.assign(new Error(`W2: сховище недоступне після ${this.retries + 1} спроб (${last})`), { code: "W2_UNAVAILABLE" });
  }
  async getJsonVersioned(key) {
    const r = await this.#call({ op: "get", key: checkKey(key) });
    return { value: clone(r.value), version: r.version ?? null };
  }
  async putJsonIfVersion(key, value, version) {
    if (sealedWithoutDesk(key)) throw new StoreSealedError(key, "запис без оренди й квитка заборонено");
    checkKey(key);
    return { version: (await this.#call({ op: "cas", key, value: clone(value), version: version ?? null })).version };
  }
  async putJsonIfVersionFenced(key, value, version, fence) {
    sealedFenced(key);
    checkKey(key);
    const leaseKey = checkKey(fence?.leaseKey ?? "");
    if (leaseKey === key) throw new Error("fenced-запис: ключ оренди не можна писати fenced-записом");
    if (!fence || !Number.isInteger(fence.token)) throw new Error("fenced-запис: потрібні leaseKey і token");
    const point = key === SEALED_CHECKPOINT_KEY;
    if (point && fence.leaseId === undefined) throw new StoreSealedError(key, "запис точки без leaseId оренди заборонено");
    const nonce = point ? checkTicketClient(this, key, value, version, fence) : null;
    const r = await this.#call({ op: "fenced", key, value: clone(value), version: version ?? null, fence: fenceOf(fence), ...(point ? { ticket: nonce, leaseNow: DESKS.get(this).now() } : {}) });
    if (nonce) spend(this, nonce);
    return { version: r.version };
  }
  /** ENG-23: стіл квитків цього екземпляра (один, прив'язаний до сховища фідів). */
  claimDesk(opts) { return claimDeskOf(this, opts); }
  async [HEAD_WRITE](value, version, fence) {
    checkKey(fence?.leaseKey ?? "");
    if (fence?.leaseId === undefined) throw new StoreSealedError(SERVING_HEAD_KEY, "запис head без leaseId оренди заборонено");
    if (!Number.isInteger(fence.token)) throw new Error("fenced-запис: потрібні leaseKey і token");
    return { version: (await this.#call({ op: "head", value: clone(value), version: version ?? null, fence: fenceOf(fence) })).version };
  }
}
