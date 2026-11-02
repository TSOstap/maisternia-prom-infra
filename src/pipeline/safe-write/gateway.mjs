/** E3 (ENG-01 K2) — спільний шлюз запису (СШЗ): ЄДИНИЙ шлях запису в таблицю для всіх модулів — інженерна синхронізація,
 *  Catalog Controls, майбутній запис HTML-описів, SEO, інші.
 *
 *    const gw = new WriteGateway({ sheets, read, store });
 *    const s = await gw.open({ writer: "sync", scope: "sync" });   // оренда (одна на таблицю), запис ACQUIRE у журнал
 *    if (s.state === "RECONCILE_REQUIRED") await s.reconcile();       // невідомі результати попередніх власників — з'ясувати
 *    await s.updateByKey({ title, changes });                         // E2: запис за Offer ID
 *    await s.appendMissingByKey({ title, rows });                     // дописування без дублів
 *    await s.close();                                                 // звільнення оренди (стара оренда цього не зможе)
 *
 *  Правила:
 *   • поки є операції з невідомим результатом (INTENT / UNKNOWN / PARTIAL) — новий запис заборонено, доки не з'ясовано (reconcile);
 *   • поки є NEEDS_DECISION (запис у чужий рядок, зміна між записом і перевіркою, дубль) — запис заборонено до рішення людини (decide);
 *   • кожен запит запису — після assertCurrent() оренди; транспорт отримує fence (GoogleSheetsWriter / MemorySheets);
 *   • видалення рядків через шлюз неможливе; прямий (сирий) запис — лише через s.sheets з fence і записом у журнал.
 *  Контракти Catalog Controls: gw.ccReadiness() → { committer (cc-committer-v1), store (cc-store-v1) } — пара на ОДИН запуск CC.
 *  Р7 (рішення власника 29.10): шлюз НЕ пише жодного ключа Catalog Controls. Контрольна точка CC пишеться лише самим CC через
 *  store пари, і лише fenced-записом під орендою, виданою committer цієї ж пари: запізнілий запис після втрати оренди → CONFLICT.
 *  ENG-23 (узгоджений контракт F04 / F06 / F08, E4): пара ccReadiness() НЕ здатна записати контрольну точку (лише читання й службовий
 *  ключ проби): точку пише лише протокол A (cc-serving-v2) з квитком beforeCommit; саме сховище W2 запечатує ключ (E3). */
import { mtText } from "../../core/text.mjs";
import { OUTCOME, WriteOutcomeError, outcomeOf } from "../write-outcome.mjs";
import { createCommitter, LeaseError, leaseKeyOf } from "./committer.mjs";
import { StoreFencedError, StoreSealedError, SERVING_HEAD_KEY } from "./store.mjs";
import { keyIdentity, sameKey } from "../../storage/keys.mjs";
import { OpJournal } from "./journal.mjs";
import { loadOwnership } from "./ownership.mjs";
import { withProvisionalQueue } from "./queue-ownership.mjs";
import { keyedUpdate, appendMissingByKey, compensateMisplaced, deleteByKeys, cellMatches, OP, SETTLE_MS } from "./keyed-update.mjs";
import { buildProtocolA } from "../cc-serving.mjs";

/** ENG-23 (E3 / E5): стіл квитків сховища W2 — забирає ПЕРШИЙ шлюз над цим сховищем (store.claimDesk видається один раз); назовні
 *  модуля недоступний. Квиток на запис контрольної точки видає лише протокол A (ccProtocolA → cc-serving-v2.beforeCommit). */
const DESKS = new WeakMap();

export const SESSION = Object.freeze({ READY: "READY", RECONCILE_REQUIRED: "RECONCILE_REQUIRED", BLOCKED: "BLOCKED", CLOSED: "CLOSED" });
/** Ключі Catalog Controls (CC-R4-READINESS-CONTRACT §3). Шлюз їх не пише й не «оновлює». */
export const CC_KEY_PREFIX = "state/catalog-controls/";
export const CC_CHECKPOINT_KEY = CC_KEY_PREFIX + "checkpoint.json";
export const CC_PROBE_KEY = CC_KEY_PREFIX + "readiness-probe.json";
/** Ключ CC → область, оренду якої має пред'явити запис (R4: checkpoint — «catalog-controls», службовий — «…:readiness-probe»). */
export const CC_KEY_SCOPE = Object.freeze({ [CC_CHECKPOINT_KEY]: "catalog-controls", [CC_PROBE_KEY]: "catalog-controls:readiness-probe" });
/** ENG-25 (N1): область ключа CC — за фізичною ідентичністю (псевдонім регістру не знімає вимоги оренди). */
const ccScopeOf = (key) => { const id = keyIdentity(key); return CC_KEY_SCOPE[id] ?? (id.startsWith(CC_KEY_PREFIX) ? "catalog-controls" : null); };

export class WriteGateway {
  /** heartbeatMs — ENG-29: подовження оренди, поки процес живий (довгі операції на сервері перевищують ttl оренди 15 хв: читання «Журналу»
   *  ≈ 50 тис. рядків у межах квоти Google). За замовчуванням — як просить сховище (RemoteStore / Durable Object — 4 хв); локальні — вимкнено. */
  constructor({ sheets, read, store, contract = loadOwnership(), now = Date.now, ttlMs, settleMs = SETTLE_MS, owner = "process", resourceFor, heartbeatMs = store?.leaseHeartbeatMs ?? null }) {
    if (!sheets || typeof read !== "function" || !store) throw new Error("WriteGateway: потрібні sheets, read, store");
    if (typeof store.putJsonIfVersionFenced !== "function") throw new Error("WriteGateway: сховище без putJsonIfVersionFenced — fencing контрольної точки CC неможливий (Р7)");
    this.sheets = sheets; this.read = read; this.store = store; this.contract = contract; this.now = now; this.settleMs = settleMs; this.heartbeatMs = heartbeatMs;
    this.committer = createCommitter({ store, now, ttlMs, settleMs, owner, ...(resourceFor ? { resourceFor } : {}) });
    if (!DESKS.has(store)) {
      let rec;
      try { rec = { desk: typeof store.claimDesk === "function" ? store.claimDesk({ now: () => now() }) : null, error: null }; }
      catch (e) { rec = { desk: null, error: e }; }
      DESKS.set(store, rec);
    }
  }

  /** ENG-23 (E5): протокол A — readiness для apply CC з cc-serving-v2 (межа епох, fencing фідів, виявлення відновлення, квитки
   *  beforeCommit, head W2 і дзеркало реєстру). deps: { feedStore, config, loadBook, contract, mods, activeXmlsOf, base }. */
  ccProtocolA(deps) {
    const rec = DESKS.get(this.store) || { desk: null, error: null };
    return buildProtocolA({ ...deps, desk: rec.desk, deskError: rec.error, gateway: this });
  }

  async open({ writer, scope = writer, label = "", floor = null }) {
    const lease = await this.committer.acquire(scope, { label, floor });
    const journal = new OpJournal({ store: this.store, resource: lease.resource, now: this.now });
    try {
      await journal.append(lease, { opId: "", phase: "ACQUIRE", writer, detail: { tookOverCrashed: lease.tookOverCrashed, previous: lease.previous } });
    } catch (e) { await lease.release().catch(() => {}); throw e; }
    const s = new WriteSession(this, lease, journal, String(writer));
    if (this.heartbeatMs > 0) s.startHeartbeat(this.heartbeatMs);
    await s.refreshState();
    return s;
  }

  /** Готовність для запуску Catalog Controls (readiness.committer + readiness.store), контракт CC R4 §2–3.
   *  committer — cc-committer-v1: оренда в тій самій черзі, що й усі записувачі таблиці (службова область — окремий ресурс).
   *  store — cc-store-v1 R4: putJsonIfVersion(key, value, version, { lease: { scope, token } }) — АТОМАРНО: версія = version І
   *  оренда {scope, token} досі чинна (token = поточний токен ресурсу області, не звільнена, належить саме цій області).
   *  Інакше — виняток: CONFLICT (версія) / STALE_LEASE (оренда). Ключі CC без оренди або з орендою не тієї області → STALE_LEASE.
   *  Інші ключі без оренди — звичайний CAS (з орендою — так само fenced). */
  ccReadiness() {
    const gw = this;
    const issued = new Map(); // token → leaseId оренд, виданих цією парою (сховище звіряє й leaseId)
    const committer = { contract: "cc-committer-v2", acquire: async (scope, opts = {}) => {
      const s = await gw.open({ writer: "catalog-controls", scope, floor: opts?.floor ?? null });
      issued.set(s.token, s.lease.leaseId);
      return { token: s.token, leaseId: s.lease.leaseId, generation: s.lease.generation, expiresAt: s.lease.expiresAt, leaseKey: s.lease.leaseKey, scope: s.scope,
        assertCurrent: () => s.assertCurrent(), renew: () => s.lease.renew(), release: () => s.close() };
    } };
    const store = {
      getJsonVersioned: (key) => gw.store.getJsonVersioned(key),
      putJsonIfVersion: async (key, value, version, opts = {}) => {
        // E4: контрольну точку ця пара не пише за жодних умов (shadow / читання); запис — лише протокол A з квитком.
        // ENG-25 (N1): за фізичною ідентичністю — псевдонім ключа точки або head serving теж запечатаний.
        if (sameKey(key, CC_CHECKPOINT_KEY)) throw new StoreSealedError(key, "ccReadiness() / engineeringReadiness() не пишуть контрольну точку — лише протокол A (cc-serving-v2) з квитком beforeCommit");
        if (sameKey(key, SERVING_HEAD_KEY)) throw new StoreSealedError(key, "head протоколу serving пише лише Engineering (стіл квитків)");
        const lease = opts?.lease, need = ccScopeOf(String(key));
        if (!lease) {
          if (need) throw new StoreFencedError(key, "запис ключа Catalog Controls без оренди відхилено");
          return gw.store.putJsonIfVersion(key, value, version);
        }
        if (typeof lease.scope !== "string" || !Number.isInteger(lease.token)) throw new StoreFencedError(key, "невалідна оренда (потрібні scope і token)");
        if (need && lease.scope !== need) throw new StoreFencedError(key, `ключ вимагає оренди області «${need}», пред'явлено «${lease.scope}»`);
        const leaseId = issued.get(lease.token);
        return gw.store.putJsonIfVersionFenced(key, value, version, { leaseKey: leaseKeyOf(gw.committer.resourceFor(lease.scope)), token: lease.token, scope: lease.scope, ...(leaseId ? { leaseId } : {}) });
      },
    };
    return { committer, store };
  }
  /** Сумісність: спільна пара для викликачів, які беруть committer і store окремо (рекомендовано — ccReadiness() на запуск). */
  get ccCommitter() { return (this.cc ||= this.ccReadiness()).committer; }
  get ccStore() { return (this.cc ||= this.ccReadiness()).store; }
}

class WriteSession {
  constructor(gw, lease, journal, writer) {
    this.gw = gw; this.lease = lease; this.journal = journal; this.writer = writer;
    this.token = lease.token; this.scope = lease.scope; this.state = SESSION.READY; this.unresolved = []; this.blocking = [];
    const prevFence = gw.sheets.fence;
    this.restoreFence = () => { gw.sheets.fence = prevFence; };
    if ("fence" in gw.sheets) gw.sheets.fence = { assertCurrent: () => this.assertCurrent() };
    this.sheets = this.#fencedRaw();
  }
  assertCurrent() { return this.lease.assertCurrent(); }
  /** ENG-29: подовження оренди за інтервалом (CAS за token + leaseId — committer.renew). Відмова (перехоплено / сплила / звільнено) —
   *  серцебиття зупиняється, наступний запис відхиляється як STALE (як без серцебиття). Процес упав — оренда спливає за ttl. */
  startHeartbeat(ms) {
    let busy = null, stopped = false;
    const timer = setInterval(() => {
      if (stopped || busy) return;
      busy = this.lease.renew().catch((e) => { stopped = true; clearInterval(timer); this.heartbeatError = String(e?.message || e).slice(0, 200); }).finally(() => { busy = null; });
    }, ms);
    timer.unref?.();
    this.stopHeartbeat = async () => { stopped = true; clearInterval(timer); if (busy) await busy; };
  }
  async refreshState() {
    this.unresolved = await this.journal.unresolved();
    this.blocking = await this.journal.blocking();
    this.state = this.state === SESSION.CLOSED ? SESSION.CLOSED : this.blocking.length ? SESSION.BLOCKED : this.unresolved.length ? SESSION.RECONCILE_REQUIRED : SESSION.READY;
    return this.state;
  }
  #ready() {
    if (this.state !== SESSION.READY) throw new WriteOutcomeError(`шлюз: сесія ${this.state} — запис заборонено (${this.state === SESSION.BLOCKED ? "потрібне рішення людини" : this.state === SESSION.RECONCILE_REQUIRED ? "спершу reconcile()" : "сесію закрито"})`, { outcome: OUTCOME.NOT_APPLIED, op: "gateway", code: this.state });
  }
  // ENG-22 (F05): для черги «Нові товари» без затвердженого розділу — тимчасовий розділ B6 (queue-ownership.mjs, fail-closed).
  #ctx() { return { sheets: this.gw.sheets, read: this.gw.read, contract: withProvisionalQueue(this.gw.contract), writer: this.writer, assertCurrent: () => this.assertCurrent(), journal: this.journal, lease: this.lease, now: this.gw.now, settleMs: this.gw.settleMs }; }

  async updateByKey({ title, changes, generation = "" }) {
    this.#ready();
    const r = await keyedUpdate({ ...this.#ctx(), title, changes, generation });
    await this.refreshState();
    return r;
  }
  async appendMissingByKey({ title, rows, generation = "" }) {
    this.#ready();
    const r = await appendMissingByKey({ ...this.#ctx(), title, rows, generation });
    await this.refreshState();
    return r;
  }
  /** Видалення рядків за ключем зі знімком (архів «Видалені товари»): єдиний дозволений шлях видалення через шлюз. */
  async deleteByKeys({ title, rows, generation = "" }) {
    this.#ready();
    const r = await deleteByKeys({ ...this.#ctx(), title, rows, generation });
    await this.refreshState();
    return r;
  }
  /** Компенсація MISPLACED за ключем (дозволена й у стані BLOCKED: саме вона знімає наслідок), потім — рішення людини decide(). */
  async compensateMisplaced(title, misplaced) {
    if (this.state === SESSION.CLOSED) throw new WriteOutcomeError("сесію закрито", { outcome: OUTCOME.NOT_APPLIED, op: "gateway", code: "CLOSED" });
    const r = await compensateMisplaced({ ...this.#ctx(), title }, misplaced);
    await this.refreshState();
    return r;
  }

  /** З'ясування невідомих результатів попередніх операцій — читанням за ключем. Нічого не пише в таблицю. */
  async reconcile() {
    const out = [];
    for (const u of await this.journal.unresolved()) {
      const intent = await this.journal.intentOf(u.opId);
      const d = intent?.detail;
      // Запит міг ще не застосуватися: чекати до кінця вікна settle (від позначки UNKNOWN або від наміру, якщо власник упав).
      const until = u.detail?.settleUntil ? Date.parse(u.detail.settleUntil) : u.phase === "INTENT" && intent?.at ? Date.parse(intent.at) + this.gw.settleMs : 0;
      if (until && this.gw.now() < until) { out.push({ opId: u.opId, result: "PENDING_SETTLE", settleUntil: new Date(until).toISOString() }); continue; }
      let result = OP.NEEDS_DECISION, detail = {};
      if (d?.title && intent.kind === "update") {
        const v = (await this.gw.read([d.title]))[d.title], h = v[0].map(mtText), kc = h.indexOf(d.keyColumn);
        const at = new Map(); for (let i = 1; i < v.length; i++) { const k = mtText(v[i]?.[kc]); if (k && !at.has(k)) at.set(k, i); }
        const per = d.items.map((it) => {
          const i = at.get(it.key);
          if (i === undefined) return "VANISHED";
          const cur = it.cols.map((c) => mtText(v[i][h.indexOf(c)]));
          // ENG-29: значення наміру — текст або відбиток SHA-256 (довгі клітинки) — cellMatches.
          return it.cols.every((c, j) => cellMatches(cur[j], it.set[c])) ? "APPLIED" : it.cols.every((c, j) => cellMatches(cur[j], it.expect[c])) ? "NOT_APPLIED" : "CHANGED";
        });
        // Запис у чужий рядок: на позиції рядка тепер інший ключ і в ньому наші значення.
        const misplaced = d.items.filter((it) => { const row = v[it.row - 1]; const k = mtText(row?.[kc]); return k && k !== it.key && it.cols.every((c) => cellMatches(row[h.indexOf(c)], it.set[c])); }).map((it) => ({ row: it.row, intendedKey: it.key, key: mtText(v[it.row - 1][kc]) }));
        result = misplaced.length || per.some((p) => p === "CHANGED" || p === "VANISHED") ? OP.NEEDS_DECISION : per.every((p) => p === "APPLIED") ? OP.VERIFIED : per.every((p) => p === "NOT_APPLIED") ? OP.NOT_APPLIED : OP.PARTIAL;
        // PARTIAL після з'ясування — стан відомий (частина застосована, частина ні): повтор наміру безпечний за ключем.
        detail = { per: d.items.map((it, j) => ({ key: it.key, status: per[j] })), misplaced };
      } else if (d?.title && intent.kind === "append") {
        const v = (await this.gw.read([d.title]))[d.title], kc = v[0].map(mtText).indexOf(d.keyColumn);
        const counts = new Map(); for (let i = 1; i < v.length; i++) { const k = mtText(v[i]?.[kc]); if (d.keys.includes(k)) counts.set(k, (counts.get(k) || 0) + 1); }
        const dup = d.keys.filter((k) => counts.get(k) > 1), got = d.keys.filter((k) => counts.get(k) === 1);
        result = dup.length ? OP.NEEDS_DECISION : got.length === d.keys.length ? OP.VERIFIED : got.length === 0 ? OP.NOT_APPLIED : OP.PARTIAL;
        detail = { appended: got.length, duplicates: dup };
      } else if (d?.title && intent.kind === "delete") {
        // Видалення: цільових ключів немає → застосовано; кожен інший ключ з наміру на місці → без чужих втрат.
        const v = (await this.gw.read([d.title]))[d.title], kc = v[0].map(mtText).indexOf(d.keyColumn);
        const now = new Set(); for (let i = 1; i < v.length; i++) { const k = mtText(v[i]?.[kc]); if (k) now.add(k); }
        const targets = new Set(d.targets.map((x) => x.key));
        const gone = [...targets].filter((k) => !now.has(k)), lost = d.keysBefore.filter((k) => !targets.has(k) && !now.has(k));
        result = lost.length ? OP.NEEDS_DECISION : gone.length === targets.size ? OP.VERIFIED : gone.length === 0 ? OP.NOT_APPLIED : OP.PARTIAL;
        detail = { deleted: gone, lost };
      } else if (intent?.kind === "raw" && d?.supersedable) {
        // Повний перезапис, який кожен наступний запуск робить заново (ціни / наявність усіх рядків): невідомий результат
        // перекривається наступним записом — окремого з'ясування не потрібно, але подія лишається в журналі.
        result = "SUPERSEDED"; detail = { note: "повний перезапис — перекривається наступним запуском", op: d.op, title: d.title, label: d.label };
      } else if (intent?.kind === "raw") {
        result = OP.NEEDS_DECISION; detail = { note: "сирий запис з невідомим результатом — автоматично не з'ясовується", op: d?.op, title: d?.title };
      }
      const phase = result === OP.NEEDS_DECISION ? "NEEDS_DECISION" : "RECONCILED";
      await this.journal.append(this.lease, { opId: u.opId, phase, writer: this.writer, kind: intent?.kind || "", detail: { result, ...detail, previousToken: u.token } });
      out.push({ opId: u.opId, result, ...detail });
    }
    await this.refreshState();
    return out;
  }
  /** Рішення людини щодо операції NEEDS_DECISION (після перевірки таблиці вручну). */
  async decide(opId, note) {
    if (!note) throw new Error("decide: потрібне пояснення рішення");
    await this.journal.append(this.lease, { opId, phase: "DECIDED", writer: this.writer, detail: { note: String(note) } });
    return this.refreshState();
  }
  async close() {
    if (this.state === SESSION.CLOSED) return;
    await this.stopHeartbeat?.(); // ENG-29: спершу дочекатися подовження в процесі — інакше release отримав би CONFLICT за версією оренди
    try { await this.journal.append(this.lease, { opId: "", phase: "RELEASE", writer: this.writer }); } catch { /* стара оренда: журнал відхиляє — release нижче теж відмовить */ }
    try { await this.lease.release(); } finally { this.state = SESSION.CLOSED; this.restoreFence(); }
  }

  /** Сирий транспорт для кроків, які ще не переведено на keyed-операції (наприклад, черга синхронізації): fence + журнал.
   *  deleteRows заборонено. Невідомий результат сирого запису блокує подальший запис до рішення людини. */
  /** Сирий запис повного блоку, який кожен запуск переписує заново (ціни / наявність): невідомий результат → SUPERSEDED. */
  async rawSupersedable(op, args, label) { return this.#rawCall(op, args, { supersedable: true, label: String(label || "") }); }

  #rawCall(op, args, extra = {}) { return this.#wrap(op, extra)(...args); }
  #wrap(op, extra = {}) {
    const s = this, base = this.gw.sheets;
    return async (...args) => {
      s.#ready();
      const title = String(args[0]?.[0]?.title ?? args[0] ?? "");
      const opId = `raw-${s.token}-${op}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await s.journal.append(s.lease, { opId, phase: "INTENT", writer: s.writer, kind: "raw", detail: { op, title, ...extra } });
      try {
        await s.assertCurrent();
        const r = await base[op](...args);
        await s.journal.append(s.lease, { opId, phase: "VERIFIED", writer: s.writer, kind: "raw", detail: { op, title } }).catch(() => {});
        return r;
      } catch (e) {
        const o = outcomeOf(e);
        const notApplied = o === OUTCOME.NOT_APPLIED && !(e?.appliedParts > 0);
        await s.journal.append(s.lease, { opId, phase: notApplied ? "NOT_APPLIED" : "UNKNOWN", writer: s.writer, kind: "raw", detail: { op, title, ...extra, error: String(e?.message || e).slice(0, 200), ...(notApplied ? {} : { settleUntil: new Date(s.gw.now() + s.gw.settleMs).toISOString() }) } }).catch(() => {});
        await s.refreshState().catch(() => {});
        throw e;
      }
    };
  }
  #fencedRaw() {
    const base = this.gw.sheets;
    return {
      fence: undefined,
      meta: (...a) => base.meta(...a),
      updateRanges: this.#wrap("updateRanges"), appendRows: this.#wrap("appendRows"), ensureSheet: this.#wrap("ensureSheet"), ensureColumns: this.#wrap("ensureColumns"), setPercentFormat: this.#wrap("setPercentFormat"),
      deleteRows: async () => { throw new WriteOutcomeError("шлюз: видалення рядків заборонено (позиційна й неідемпотентна операція)", { outcome: OUTCOME.NOT_APPLIED, op: "deleteRows", code: "DELETE_FORBIDDEN" }); },
    };
  }
}
export { LeaseError };
