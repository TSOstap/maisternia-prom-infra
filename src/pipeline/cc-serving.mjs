/** ENG-23 / ENG-24 (узгоджений контракт F04 / F06 / F08, розд. 2.4–2.6, 3–5; E5, E7, E8) — протокол A як `cc-serving-v2`.
 *
 *  Збирається ЛИШЕ через WriteGateway.ccProtocolA(…): стіл квитків сховища W2 забирає перший шлюз (DESKS у store.mjs), назовні його
 *  не видно. ЄДИНИЙ шлях запису контрольної точки — CC R7.3 (C1): serving.beforeCommit → readiness.store.putJsonIfVersion(CHECKPOINT_KEY,
 *  next, expectedVersion, { lease: { scope, token, leaseId }, ticket }) → запечатаний CAS сховища W2 → serving.afterCommit.
 *  ENG-24: перехідний міст ENG-23 (квиток, оформлений Engineering за R7.2) ПРИБРАНО — без квитка CC запис точки неможливий.
 *
 *  beforeCommit видає квиток лише після:
 *    1. перевірки оренди (token + leaseId — саме ця оренда протоколу A) і стану serving: NORMAL (усі фази, крім recover) або
 *       RECOVERY_AUTHORIZED з установленою межею епох і орендою нового покоління (лише фаза recover, E8);
 *    2. безпечного обслуговування фідів щодо стану НОВОЇ точки — найсуворішого з двох: переданого CC (`state`, контракт 2.4) і
 *       обчисленого Engineering незалежно (controlsState модуля CC над свіжими аркушами); невідомий HEAD → зняття (F01);
 *    3. запису prepared у head W2 (state/cc-serving/head.json) І в дзеркало реєстру (state/cc-registry/head.json, fencing).
 *  afterCommit завершує head і дзеркало (ідемпотентно); фаза recover → NORMAL нового покоління в обох.
 *  status — виявлення відновлення за таблицею 2.6 на кожній оренді; стан відновлення — у дзеркалі (recovery.mjs) і head. Поки не
 *  NORMAL — обслуговування перевіряється щодо найсуворішого стану (recoverCheckpoint CC над точкою, реєстром і prepared), інакше
 *  знімається (503, лише синтетика — Q3). recovery() → { state, type, floorProven, registry, prepared, fromHash, reason }.
 *  Хеші — лише тут (jcsHash). Реєстр Engineering зберігає й звіряє за хешем, але не інтерпретує (Р7).
 *  Модель — один хост; повне спільне відновлення W2 + фідів + точки без детектора журналу НЕ виявляється (BLOCK до DO). */
import crypto from "node:crypto";
import os from "node:os";
import { jcsHash } from "./safe-write/jcs.mjs";
import { LeaseError } from "./safe-write/committer.mjs";
import { SEALED_CHECKPOINT_KEY, SERVING_HEAD_KEY } from "./safe-write/store.mjs";
import { sameKey } from "../storage/keys.mjs";
import { epochFloor } from "./safe-write/epoch-floor.mjs";
import { fenceFeeds, REGISTRY_KEY } from "../publish/feed-fence.mjs";
import { withdrawFeed } from "../publish/publisher.mjs";
import { secureServingAgainst, servedSafety } from "./update.mjs";
import { catalogControlsAdapter, controlsFromState } from "./controls-adapter.mjs";
import { RECOVERY_STATE, PROVABLE_TYPES, declareRecovery } from "./recovery.mjs";

export const SERVING_CONTRACT = "cc-serving-v2";
export const SERVING_STATE = RECOVERY_STATE;
const PHASES = new Set(["init", "intents", "settle", "recovery", "debt", "issued", "recover"]);
const CC_SCOPE = "catalog-controls";
const TICKET_TTL_MS = 5 * 60_000;

/** Реєстр рішень (контракт 2.4): { v, ops, pending, aborted, epochHigh, leaseId, recovery? } — без issued і часу запису. Engineering
 *  лише вибирає поля за контрактом і звіряє хеш; змісту не інтерпретує. */
export const registryOf = (cp) => {
  if (!cp || typeof cp !== "object") return null;
  return structuredClone({ v: cp.v, ops: cp.ops, pending: cp.pending, aborted: cp.aborted, epochHigh: cp.epochHigh, leaseId: cp.leaseId, ...(cp.recovery ? { recovery: cp.recovery } : {}) });
};
const rank = (x) => [Number.isInteger(x?.generation) ? x.generation : 0, Number.isInteger(x?.epochHigh) ? x.epochHigh : 0];
const cmpRank = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
const msg = (e) => String(e?.message || e).slice(0, 300);
const setOf = (v) => new Set(v instanceof Map ? v.keys() : [...(v || [])].map(String));
/** Найсуворіший із двох станів CC для захисту обслуговування: знято / видалено — об'єднання; blocked — будь-який. */
const strictest = (a, b) => (!b ? a : { ...a, held: new Set([...setOf(a.held), ...setOf(b.held)]), removed: new Set([...setOf(a.removed), ...setOf(b.removed)]), blocked: a.blocked === true || b.blocked === true, reasons: [...(a.reasons || []), ...(b.reasons || [])] });
/** Фізична ідентичність сховища фідів для прив'язки столу квитків. */
const bindingOf = (store) => (typeof store?.root === "string" && store.root ? "feeds-root:" + store.root : null);
const activeRec = (x) => (x?.recovery?.state && x.recovery.state !== SERVING_STATE.NORMAL ? x.recovery : null);

/**
 * @param o.desk        стіл квитків сховища W2 (лише від WriteGateway)
 * @param o.gateway     WriteGateway (сховище W2, годинник, ccReadiness)
 * @param o.feedStore   сховище фідів (LocalObjectStore; CAS обов'язковий — F07)
 * @param o.config      робочий конфіг (feeds)
 * @param o.loadBook    () → аркуші для стану CC
 * @param o.contract    контракт CC (об'єкт)
 * @param o.mods        модулі CC ({ plan: { controlsState, verifyControlsSnapshot, recoverCheckpoint? } })
 * @param o.activeXmlsOf (store, config) → async () → тексти обслуговуваних версій
 * @param o.base        readiness Engineering (engineeringReadiness): committer / store / publisher
 */
export function buildProtocolA({ desk, deskError = null, gateway, feedStore, config, loadBook, contract, mods, activeXmlsOf, base }) {
  const w2 = gateway.store, now = () => gateway.now();
  const feeds = (config?.feeds || []).filter((f) => f.enabled !== false).map((f) => f.name);
  const run = { lease: null, store: null, status: null, warnings: [] };
  const deskProblem = () => {
    if (!desk) return "стіл квитків сховища W2 недоступний" + (deskError ? ": " + msg(deskError) : "") + " — протокол A не може видати квиток";
    const b = bindingOf(feedStore);
    if (!b) return "сховище фідів без фізичної ідентичності (root) — прив'язка столу квитків неможлива";
    try { desk.bind(b); } catch (e) { return msg(e); }
    return null;
  };

  // ---------- head W2 і дзеркало реєстру ----------
  const leaseFence = (lease) => ({ leaseKey: lease.leaseKey, token: lease.token, leaseId: lease.leaseId, scope: lease.scope });
  const readHead = async () => (await w2.getJsonVersioned(SERVING_HEAD_KEY));
  /** ENG-25 (d): дзеркало — { present, valid, value }: відсутнє, недійсне (не JSON / v ≠ 1) і дійсне розрізняються (MIGRATION —
   *  лише за ВІДСУТНЬОГО; недійсне — суперечність коренів, не «нова система»). */
  const readMirrorState = async () => {
    const s = run.store || feedStore;
    let text = null;
    if (typeof s.getBuffer === "function") { const b = await s.getBuffer(REGISTRY_KEY); text = b == null ? null : b.toString("utf8"); }
    else { const v = await s.getJson(REGISTRY_KEY); text = v == null ? null : JSON.stringify(v); }
    if (text == null) return { present: false, valid: false, value: null };
    let v = null;
    try { v = JSON.parse(text); } catch { return { present: true, valid: false, value: null }; }
    // Заглушка fencing ({ fence } — fenceFeeds створює ключ до першого запису реєстру) рішень не містить: це «дзеркала ще немає».
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => k === "fence")) return { present: false, valid: false, value: null, stub: true };
    return v && v.v === 1 ? { present: true, valid: true, value: v } : { present: true, valid: false, value: null };
  };
  const readMirror = async () => (await readMirrorState()).value;
  async function writeHead(lease, mutate) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { value, version } = await readHead();
      const next = { v: 1, generation: 0, epochHigh: 0, leaseId: null, cp: null, prepared: null, recovery: null, ...(value || {}), ...mutate(value || null), at: new Date(now()).toISOString() };
      try { return await desk.putHead(next, version, leaseFence(lease)); } catch (e) { if (e?.code !== "CONFLICT" || attempt === 2) throw e; }
    }
    return null;
  }
  async function writeMirror(mutate) {
    if (!run.store) throw new Error("дзеркало реєстру: немає сховища фідів з fencing цієї оренди");
    const cur = await readMirror();
    const { fence: _f, ...rest } = cur || {};
    const next = { v: 1, generation: 0, epochHigh: 0, leaseId: null, committed: null, prepared: null, recovery: { state: SERVING_STATE.NORMAL, type: null, id: null, since: null, reason: "" }, ...rest, ...mutate(cur || null), at: new Date(now()).toISOString() };
    return run.store.putJson(REGISTRY_KEY, next); // умовний запис під fencing (ETag після власного fencing)
  }
  const sameLease = (a, b) => Boolean(a && b && a.token === b.token && a.leaseId === b.leaseId);

  // ---------- безпечне обслуговування щодо стану точки (ENG-20 A; F01) ----------
  async function secureFor(cpValue, ccState = null) {
    const overlay = new Proxy(w2, {
      get(t, p) {
        if (p === "getJsonVersioned") return async (k) => (k === SEALED_CHECKPOINT_KEY ? { value: structuredClone(cpValue), version: "pending" } : t.getJsonVersioned(k));
        if (p === "getJson") return async (k) => (k === SEALED_CHECKPOINT_KEY ? structuredClone(cpValue) : t.getJson(k));
        const v = t[p];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const adapter = catalogControlsAdapter({ loadBook, store: overlay, contract, api: { controlsState: mods.plan.controlsState, verifyControlsSnapshot: mods.plan.verifyControlsSnapshot }, activeXmls: activeXmlsOf(run.store, config), requireActive: true });
    let st;
    try { st = await adapter.state(); } catch (e) { st = { blocked: true, reasons: ["стан не прочитано: " + msg(e)] }; }
    // Стан, переданий CC (контракт 2.4), — разом із власним: захищаємо обслуговування щодо найсуворішого з них.
    const passed = ccState ? controlsFromState(ccState) : null;
    if (st && st.blocked === false && passed && passed.blocked !== false) st = { ...st, blocked: true, reasons: ["стан, переданий CC, недостовірний: " + (passed.reasons || []).join("; ")] };
    if (!st || st.blocked !== false) return withdrawAll("протокол A: стан Catalog Controls для нової контрольної точки недостовірний: " + (st?.reasons || []).join("; "));
    const controls = strictest(st, passed);
    const r = await secureServingAgainst({ store: run.store, controls, adapter, config, lease: run.lease, now: now(), tmpDir: os.tmpdir() });
    return { ...r, serving: r.ok ? (r.feeds.some((f) => f.action === "WITHDRAWN") ? "WITHDRAWN" : "SAFE") : "UNKNOWN" };
  }
  /** Зняти всі фіди з обслуговування (з fencing) і перевірити, що Worker нічого не віддає. */
  async function withdrawAll(reason) {
    for (const feed of feeds) await withdrawFeed(run.store, feed, reason).catch(() => {});
    const left = [];
    for (const feed of feeds) { const s = await servedSafety(run.store, feed, { blocked: false, held: new Set(), removed: new Set() }); if (s.served.length) left.push(feed); }
    return { ok: left.length === 0, mode: "WITHDRAWN_UNKNOWN_STATE", serving: left.length ? "UNKNOWN" : "WITHDRAWN", stillServed: left };
  }
  /** E7 (розд. 3, крок 2): під час відновлення — обслуговування безпечне щодо найсуворішого стану (recoverCheckpoint CC: чинна точка ∪
   *  реєстр ∪ prepared; захисні діють, послаблення — ні), інакше 503. Лише зменшення обслуговування. */
  async function secureDuringRecovery(C, M, lease, rec) {
    let strict = null;
    if (typeof mods.plan.recoverCheckpoint === "function") {
      try {
        strict = mods.plan.recoverCheckpoint({ base: C.value, registry: M?.committed?.registry ?? null, prepared: M?.prepared?.registry ?? null, journal: [],
          at: new Date(now()).toISOString(), epoch: lease.token, leaseId: lease.leaseId, generation: lease.generation ?? 0, type: rec?.type || "", fromHash: C.value == null ? "" : jcsHash(C.value) });
      } catch { strict = null; }
    }
    if (strict) { const sec = await secureFor(strict).catch((e) => ({ ok: false, error: msg(e) })); if (sec.ok) return { ok: true, mode: "STRICT", serving: sec.serving }; }
    return withdrawAll("відновлення Catalog Controls: безпечність обслуговування щодо найсуворішого стану не доведено");
  }
  /** ENG-25 (e4): фактичний режим обслуговування під час відновлення для звіту — STRICT / WITHDRAWN / NOT_SECURED. */
  const servingModeOf = (sec) => (!sec?.ok ? "NOT_SECURED" : sec.serving === "WITHDRAWN" ? "WITHDRAWN" : sec.mode === "STRICT" && sec.serving === "SAFE" ? "STRICT" : "NOT_SECURED");
  /** ENG-25: ухвалені рішення дзеркала (ops: op + печатка) містяться в точці? CC ops лише додає (settle / recover), тож законна новіша
   *  точка завжди їх містить; інакше точка підроблена / відкочена — синхронізувати дзеркало з нею не можна. */
  const opsContained = (registry, cp) => {
    const need = Array.isArray(registry?.ops) ? registry.ops : [];
    if (!need.length) return true;
    const have = new Map((Array.isArray(cp?.ops) ? cp.ops : []).map((e) => [e?.op, e?.seal]));
    return need.every((e) => have.has(e?.op) && have.get(e?.op) === e?.seal);
  };

  // ---------- serving.status: виявлення відновлення (2.6) ----------
  async function pending(lease, type, reason) {
    const recovery = { state: SERVING_STATE.PENDING, type, id: crypto.randomBytes(6).toString("hex"), since: new Date(now()).toISOString(), reason: String(reason).slice(0, 400), declaredBy: "system" };
    await writeMirror(() => ({ recovery })).catch((e) => run.warnings.push("дзеркало: RECOVERY_PENDING не записано: " + msg(e)));
    await writeHead(lease, () => ({ recovery })).catch((e) => run.warnings.push("head: RECOVERY_PENDING не записано: " + msg(e)));
    // Одразу — обслуговування щодо найсуворішого стану (E7), не чекаючи наступного запуску.
    const C = await w2.getJsonVersioned(SEALED_CHECKPOINT_KEY), M = await readMirror().catch(() => null);
    const sec = await secureDuringRecovery(C, M, lease, recovery).catch((e) => ({ ok: false, error: msg(e) }));
    if (!sec.ok) run.warnings.push("відновлення: обслуговування не захищено — " + JSON.stringify(sec).slice(0, 200));
    return { state: SERVING_STATE.PENDING, type, id: recovery.id, reason, generation: lease.generation ?? 0, serving: servingModeOf(sec) };
  }
  /** ENG-25 (c): запис відновлення для head (свідок в іншому корені) — без полів процедури дозволу. */
  const headRec = (r) => ({ state: r.state, type: r.type, id: r.id, since: r.since ?? null, reason: r.reason ?? "", declaredBy: r.declaredBy ?? null, ...(r.escalatedFrom ? { escalatedFrom: r.escalatedFrom } : {}) });
  /** ENG-25 (c): синхронізація стану відновлення H ↔ M лише ВГОРУ (активний запис копіюється в корінь, де його немає; знизити так не
   *  можна). Обидва активні з різними id (і не ескалація) → суперечність: UNKNOWN з новим id в обох коренях. → активний запис або null. */
  async function syncRecovery(lease, H, M) {
    const recH = activeRec(H), recM = activeRec(M);
    if (recH && recM && recH.id !== recM.id) {
      if (recM.escalatedFrom === recH.id) { await writeHead(lease, () => ({ recovery: headRec(recM) })); return recM; }
      const conflict = { head: { id: recH.id, type: recH.type }, mirror: { id: recM.id, type: recM.type } };
      const recovery = { state: SERVING_STATE.PENDING, type: "UNKNOWN", id: crypto.randomBytes(6).toString("hex"), since: new Date(now()).toISOString(), reason: `суперечність стану відновлення head (${recH.id}, ${recH.type}) і дзеркала (${recM.id}, ${recM.type})`, declaredBy: "system", conflict };
      await writeMirror(() => ({ recovery })).catch((e) => run.warnings.push("дзеркало: суперечність відновлення не записано: " + msg(e)));
      await writeHead(lease, () => ({ recovery: headRec(recovery) })).catch((e) => run.warnings.push("head: суперечність відновлення не записано: " + msg(e)));
      return recovery;
    }
    if (recM && !recH) await writeHead(lease, () => ({ recovery: headRec(recM) })).catch((e) => run.warnings.push("head: стан відновлення не синхронізовано: " + msg(e)));
    // H → M: дозвіл власника й межа живуть лише в M — копія в M завжди RECOVERY_PENDING (суворіше, не нижче); дозвіл — заново.
    if (recH && !recM) {
      const copy = { ...headRec(recH), state: SERVING_STATE.PENDING };
      await writeMirror(() => ({ recovery: copy })).catch((e) => run.warnings.push("дзеркало: стан відновлення не синхронізовано: " + msg(e)));
      return copy;
    }
    return recM || recH || null;
  }
  /** ENG-25 (d): точка формату ДО R7.3 (v4, ops / pending / aborted — масиви, без epochHigh, leaseId, recovery) — лише вона буває без
   *  head і дзеркала законно (перший запуск після переходу); точка R7.3 без обох коренів означає їх втрату, а не міграцію. */
  const preR73Checkpoint = (c) => Boolean(c && typeof c === "object" && c.v === (mods.plan.CHECKPOINT_VERSION ?? 4)
    && ["ops", "pending", "aborted"].every((k) => Array.isArray(c[k])) && !("epochHigh" in c) && !("leaseId" in c) && !("recovery" in c));
  async function status({ lease } = {}) {
    if (!sameLease(lease, run.lease) || !run.store) return { state: SERVING_STATE.PENDING, type: "NO_LEASE", reason: "status лише під орендою протоколу A з fencing" };
    // ENG-26 (Catalog R7.4, E-d1; контракт 2.4 / 2.6): для тієї самої оренди (token + leaseId) status повертає результат, обчислений
    // при її видачі (state, type, reason) — CC бачить, напр., MIGRATION, виконану в acquire. Перерахунок — лише після afterCommit(recover).
    if (run.status) return run.status;
    const gen = run.lease.generation ?? 0;
    const C = await w2.getJsonVersioned(SEALED_CHECKPOINT_KEY);
    const hC = C.value == null ? null : jcsHash(C.value);
    const Hv = await readHead(), H = Hv.value, Ms = await readMirrorState(), M = Ms.value;
    // Стан відновлення: найсуворіший із H і M (ENG-25 c: синхронізація лише вгору, суперечність id → UNKNOWN); процедура — за M.
    const rec = await syncRecovery(run.lease, H, M);
    if (rec) {
      const sec = await secureDuringRecovery(C, M, run.lease, rec).catch((e) => ({ ok: false, error: msg(e) }));
      if (!sec.ok) run.warnings.push("відновлення: обслуговування не захищено — " + JSON.stringify(sec).slice(0, 200));
      return { state: rec.state, type: rec.type, id: rec.id, reason: rec.reason || "відновлення не завершено", generation: gen, serving: servingModeOf(sec) };
    }
    const Hc = H?.cp?.hash ?? null, Hp = H?.prepared?.hash ?? null, Mc = M?.committed?.cpHash ?? null, Mp = M?.prepared?.cpHash ?? null;
    const epochHigh = (x) => (Number.isInteger(x?.epochHigh) ? x.epochHigh : 0);
    const syncMirrorFromC = (extra = {}) => writeMirror(() => ({ committed: { cpHash: hC, cpVersion: C.version, registry: registryOf(C.value) }, prepared: null, epochHigh: Math.max(epochHigh(M), epochHigh(H)), generation: Math.max(rank(M)[0], rank(H)[0]), leaseId: H?.leaseId ?? null, ...extra }));
    // ENG-25 (d): немає head і дзеркала (саме відсутні). Без точки — BOOTSTRAP. MIGRATION — лише точка формату до R7.3 і лише після
    // доведено безпечного обслуговування щодо неї; інакше (точка R7.3 без коренів = їх утрата) — RECOVERY_PENDING / UNKNOWN.
    const headAbsent = H == null && Hv.version == null;
    if (headAbsent && !Ms.present) {
      if (hC === null) return { state: SERVING_STATE.NORMAL, type: "BOOTSTRAP", reason: "", generation: gen };
      if (!preR73Checkpoint(C.value)) return pending(run.lease, "UNKNOWN", "немає head W2 і дзеркала, а точка має формат R7.3 (epochHigh / leaseId) — корені втрачено або відкочено, це не міграція");
      const sec = await secureFor(C.value).catch((e) => ({ ok: false, reason: msg(e) }));
      if (!sec.ok) return pending(run.lease, "UNKNOWN", "MIGRATION: обслуговування щодо чинної точки не захищено — точку не прийнято");
      const migration = { at: new Date(now()).toISOString(), cpHash: hC, generation: gen };
      await writeHead(run.lease, () => ({ cp: { hash: hC, version: C.version }, prepared: null, epochHigh: run.lease.token, leaseId: run.lease.leaseId, generation: gen, migration }));
      await syncMirrorFromC({ epochHigh: run.lease.token, leaseId: run.lease.leaseId, generation: gen, migration });
      return { state: SERVING_STATE.NORMAL, type: "MIGRATION", reason: "точку формату до R7.3 прийнято: обслуговування перевірене, head і дзеркало створено", generation: gen, cpHash: hC };
    }
    if (Ms.present && !Ms.valid) return pending(run.lease, "UNKNOWN", "дзеркало реєстру недійсне (не JSON або v ≠ 1) — суперечність коренів");
    if (headAbsent && !M?.committed && hC === null) return { state: SERVING_STATE.NORMAL, type: "BOOTSTRAP", reason: "", generation: gen };
    // Збій між записом точки й afterCommit: точка = prepared → завершити head / дзеркало.
    if (hC !== null && hC !== Hc && (hC === Hp || hC === Mp)) {
      if (hC !== Hp && Hc !== Mc) return pending(run.lease, "UNKNOWN", "точка = prepared дзеркала, але head не узгоджений");
      const prepEpoch = Math.max(H?.prepared?.epoch ?? 0, M?.prepared?.epoch ?? 0);
      await writeHead(run.lease, (h) => ({ cp: { hash: hC, version: C.version }, prepared: null, epochHigh: Math.max(epochHigh(h), prepEpoch), leaseId: h?.prepared?.leaseId ?? h?.leaseId ?? null }));
      await writeMirror((m) => ({ committed: { cpHash: hC, cpVersion: C.version, registry: m?.prepared?.cpHash === hC ? m.prepared.registry : registryOf(C.value) }, prepared: null, epochHigh: Math.max(epochHigh(m), prepEpoch) }));
      return { state: SERVING_STATE.NORMAL, type: "FINISHED", reason: "завершено head / дзеркало за prepared", generation: gen };
    }
    if (hC === Hc) {
      if (hC === Mc || (hC !== null && hC === Mp)) {
        if (hC !== Mc) await writeMirror((m) => ({ committed: { cpHash: hC, cpVersion: C.version, registry: m.prepared.registry }, prepared: null, epochHigh: Math.max(epochHigh(m), m.prepared.epoch ?? 0) }));
        // Застарілий prepared (квиток видано, точку не записано): прибрати.
        if (Hp && Hp !== hC) await writeHead(run.lease, () => ({ prepared: null }));
        if (Mp && Mp !== hC && hC === Mc) await writeMirror(() => ({ prepared: null }));
        return { state: SERVING_STATE.NORMAL, type: "NORMAL", reason: "", generation: gen };
      }
      // Точка = head, дзеркало інше.
      if (!M?.committed || cmpRank(rank(M), rank(H)) < 0) {
        // Відновлено сховище фідів (дзеркало старіше): синхронізувати з head / точкою (нічого не надає) і перевірити обслуговування.
        // ENG-25 (N1, захист у глибину): лише якщо точка містить усі ухвалені рішення дзеркала — інакше точку (і head) підроблено або
        // відкочено разом: дзеркало не переписувати (авторитетне джерело рішень), стан — RECOVERY_PENDING / UNKNOWN.
        if (M?.committed && !opsContained(M.committed.registry, C.value)) return pending(run.lease, "UNKNOWN", "контрольна точка не містить ухвалених рішень дзеркала реєстру — синхронізацію дзеркала з точкою відхилено (точку й head підроблено або відкочено)");
        const sec = await secureFor(C.value).catch((e) => ({ ok: false, reason: msg(e) }));
        if (!sec.ok) return pending(run.lease, "F_ONLY", "дзеркало відновлено, а безпечне обслуговування щодо чинної точки не досягнуто");
        await syncMirrorFromC();
        return { state: SERVING_STATE.NORMAL, type: "F_ONLY_SYNCED", reason: "дзеркало синхронізовано з head / точкою", generation: gen };
      }
      return pending(run.lease, "W2_ONLY", "дзеркало новіше за head W2 — сховище W2 відновлено з копії");
    }
    // Точка не збігається ні з head, ні з prepared.
    if (Hc !== null && Hc === Mc) return pending(run.lease, "CP_ONLY", "контрольну точку відновлено окремо (не збігається з head і дзеркалом)");
    if (cmpRank(rank(M), rank(H)) > 0) return pending(run.lease, "W2_ONLY", "дзеркало новіше за head W2 — сховище W2 відновлено з копії");
    return pending(run.lease, "UNKNOWN", "суперечність точки, head і дзеркала");
  }

  /** Відновлення дозволено й межу встановлено для ЦІЄЇ оренди (нове покоління після establishFloor). */
  async function recoveryReady(lease) {
    const M = await readMirror();
    const rec = M?.recovery;
    const fe = rec?.floorEstablished;
    const ok = rec?.state === SERVING_STATE.AUTHORIZED && rec.floorProven === true && PROVABLE_TYPES.includes(rec.type)
      && fe && Number.isInteger(fe.generation) && (lease.generation ?? 0) === fe.generation && lease.token > fe.floor;
    return { ok, rec, M };
  }

  // ---------- serving.beforeCommit / afterCommit / recovery ----------
  async function beforeCommit({ phase, lease, cp, state = null, registry = null } = {}) {
    const fail = (code, reason, serving = "SAFE") => ({ ok: false, code, reason: String(reason).slice(0, 500), serving });
    try {
      const dp = deskProblem();
      if (dp) return fail("SERVING_NOT_SECURED", dp);
      if (!sameLease(lease, run.lease) || !run.store) return fail("SERVING_NOT_SECURED", "квиток — лише для чинної оренди протоколу A (token + leaseId) з fencing фідів");
      if (!PHASES.has(phase)) return fail("SERVING_NOT_SECURED", "невідома фаза: " + phase);
      if (phase === "recover") {
        if (run.status?.state !== SERVING_STATE.AUTHORIZED) return fail("RECOVERY_NOT_AUTHORIZED", "фаза recover — лише в RECOVERY_AUTHORIZED (окремий дозвіл власника, Q1)");
        const rr = await recoveryReady(run.lease);
        if (!rr.ok) return fail("RECOVERY_NOT_AUTHORIZED", "фаза recover: межу епох не встановлено для цієї оренди / тип без доведеної межі");
      } else if (run.status?.state !== SERVING_STATE.NORMAL) return fail("RECOVERY_PENDING", "стан serving не NORMAL: " + (run.status?.state || "невідомо"));
      const next = cp?.next, expectedVersion = cp?.expectedVersion ?? null;
      if (!next || typeof next !== "object") return fail("SERVING_NOT_SECURED", "немає значення нової точки");
      // ENG-27 (Hermes INT R-MIG): нова точка — лише формату R7.3 з епохою ЦІЄЇ оренди (epochHigh = token, leaseId = leaseId; так пише
      // CC withEpoch). Точку формату до R7.3 (без epochHigh / leaseId — status без коренів приймає її як MIGRATION) чи з чужою епохою
      // через протокол A записати неможливо; вона може з'явитися лише відновленням файлів поза моделлю (клас F08-1).
      if (next.epochHigh !== lease.token || next.leaseId !== lease.leaseId) return fail("SERVING_NOT_SECURED", `нова точка без епохи цієї оренди (epochHigh ${next.epochHigh ?? "відсутній"} ≠ ${lease.token} або leaseId не той) — точка формату до R7.3 / чужої епохи через протокол A заборонена`);
      await run.lease.assertCurrent();
      const cur = await w2.getJsonVersioned(SEALED_CHECKPOINT_KEY);
      if ((cur.version ?? null) !== expectedVersion) return fail("CONFLICT", `версія точки ${cur.version ?? "відсутня"} ≠ очікуваній ${expectedVersion ?? "відсутня"}`);
      const nextHash = jcsHash(next), reg = registryOf(next);
      if (registry !== null && jcsHash(registry) !== jcsHash(reg)) return fail("SERVING_NOT_SECURED", "реєстр не відповідає новій точці (контракт 2.4)");
      // 1) безпечне обслуговування щодо НОВОГО стану (найсуворіший із переданого CC і власного) — до будь-якого запису точки
      let sec;
      try { sec = await secureFor(next, state); } catch (e) { sec = { ok: false, serving: "UNKNOWN", error: msg(e) }; }
      if (!sec.ok) return fail("SERVING_NOT_SECURED", "безпечне обслуговування фідів щодо нового стану CC не досягнуто: " + JSON.stringify(sec).slice(0, 300), sec.serving || "UNKNOWN");
      // 2) prepared у head W2 і в дзеркалі (обидва — до квитка)
      const prepared = { epoch: lease.token, leaseId: lease.leaseId, phase, expectedVersion };
      await writeHead(run.lease, () => ({ prepared: { hash: nextHash, ...prepared } }));
      await writeMirror(() => ({ prepared: { cpHash: nextHash, registry: reg, ...prepared } }));
      await run.lease.assertCurrent();
      // 3) квиток
      const ticket = { v: 1, key: SEALED_CHECKPOINT_KEY, nextHash, expectedVersion, leaseToken: lease.token, leaseId: lease.leaseId, phase, nonce: crypto.randomBytes(16).toString("hex"), notAfter: Math.min(Number(run.lease.expiresAt) || now() + TICKET_TTL_MS, now() + TICKET_TTL_MS) };
      desk.registerTicket(ticket);
      return { ok: true, ticket };
    } catch (e) {
      return fail(e?.code === "STALE" || e?.code === "STALE_FENCE" || e?.code === "STALE_LEASE" ? "SERVING_NOT_SECURED" : e?.code || "SERVING_NOT_SECURED", "beforeCommit: " + msg(e), "UNKNOWN");
    }
  }
  async function afterCommit({ ticket, version } = {}) {
    try {
      if (!ticket || !run.lease) return { ok: false, reason: "немає квитка або оренди" };
      const C = await w2.getJsonVersioned(SEALED_CHECKPOINT_KEY);
      const hC = C.value == null ? null : jcsHash(C.value);
      if (hC !== ticket.nextHash) return { ok: false, reason: "чинна точка не та, на яку видано квиток" };
      if (version !== undefined && C.version !== version) return { ok: false, reason: "версія точки змінилась після запису" };
      const gen = run.lease.generation ?? 0, recover = ticket.phase === "recover";
      const M0 = recover ? await readMirror() : null;
      await writeHead(run.lease, (h) => ({ cp: { hash: hC, version: C.version }, prepared: null, epochHigh: Math.max(rank(h)[1], ticket.leaseToken), leaseId: ticket.leaseId, generation: gen, ...(recover ? { recovery: null } : {}) }));
      await writeMirror((m) => ({ committed: { cpHash: hC, cpVersion: C.version, registry: m?.prepared?.cpHash === hC ? m.prepared.registry : registryOf(C.value) }, prepared: null, epochHigh: Math.max(rank(m)[1], ticket.leaseToken), leaseId: ticket.leaseId, generation: gen,
        ...(recover ? { recovery: { state: SERVING_STATE.NORMAL, type: null, id: null, since: null, reason: "", lastRecovery: { ...(M0?.recovery || {}), completedAt: new Date(now()).toISOString(), generation: gen, cpHash: hC } } } : {}) }));
      if (recover) run.status = null; // ENG-26 (E-d1): відновлення завершено цією орендою — наступний status перераховує (NORMAL)
      return { ok: true, reason: "" };
    } catch (e) { return { ok: false, reason: "afterCommit: " + msg(e) }; }
  }
  /** cc-recovery-v1 (R7.3 C5 читає: floorProven, registry, prepared, type, fromHash, reason). */
  async function recovery({ lease } = {}) {
    if (!sameLease(lease, run.lease) || !run.store) return { state: SERVING_STATE.PENDING, type: "NO_LEASE", floorProven: false, registry: null, prepared: null, fromHash: "", reason: "немає чинної оренди протоколу A" };
    const C = await w2.getJsonVersioned(SEALED_CHECKPOINT_KEY);
    const rr = await recoveryReady(run.lease);
    const st = run.status || { state: SERVING_STATE.PENDING };
    return { state: st.state, type: rr.rec?.type ?? st.type ?? null, id: rr.rec?.id ?? null, floorProven: rr.ok, registry: rr.M?.committed?.registry ?? null, prepared: rr.M?.prepared?.registry ?? null,
      fromHash: C.value == null ? "" : jcsHash(C.value), registryGen: rr.M?.generation ?? 0, reason: rr.ok ? "" : (st.reason || "межу епох не встановлено / дозволу власника немає") };
  }
  const serving = Object.freeze({ contract: SERVING_CONTRACT, status, beforeCommit, afterCommit, recovery });

  // ---------- оренда протоколу A: межа епох (E2) → fencing (B, E6) → status (2.6; CC сам відмовляє, якщо не NORMAL — C2) ----------
  const committer = {
    ...base.committer,
    acquire: async (scope, opts = {}) => {
      if (/:readiness-probe$/.test(String(scope))) return base.committer.acquire(scope, opts);
      const dp = deskProblem();
      if (dp) throw new LeaseError("SERVING_NOT_SECURED", dp);
      const { floor } = await epochFloor({ w2Store: w2, feedStore, feeds });
      let lease;
      try { lease = await base.committer.acquire(scope, { ...opts, floor }); }
      catch (e) {
        // Токен у записі оренди нижчий за межу епох — сховище W2 відкочено (W2_ONLY): оголосити відновлення в дзеркалі (переживає
        // відкат W2), щоб процедура cc-recovery-v1 мала id для окремого дозволу власника. Лічильник не піднімається.
        if (e?.code === "RECOVERY_PENDING") await declareRecovery({ feedStore, type: "W2_ONLY", reason: msg(e), declaredBy: "system", now }).catch((x) => run.warnings.push("W2_ONLY не оголошено: " + msg(x)));
        throw e;
      }
      try {
        run.store = await fenceFeeds({ store: feedStore, feeds, lease, scope: CC_SCOPE });
        run.lease = lease;
        run.status = null;
        run.status = await status({ lease });
      } catch (e) { run.lease = null; run.store = null; run.status = null; await lease.release().catch(() => {}); throw e; }
      return { ...lease, release: async () => { run.lease = null; run.store = null; run.status = null; return lease.release(); } };
    },
  };

  // ---------- сховище для CC: точка — ЛИШЕ з квитком beforeCommit (R7.3 C1); інші ключі — як у ccReadiness ----------
  const store = {
    ...base.store,
    putJsonIfVersion: async (key, value, version, opts) => {
      // ENG-25 (N1): ключ точки — за фізичною ідентичністю; будь-який інший запис того самого файлу (псевдонім) — запечатано.
      if (!sameKey(key, SEALED_CHECKPOINT_KEY)) return base.store.putJsonIfVersion(key, value, version, opts);
      if (key !== SEALED_CHECKPOINT_KEY) throw Object.assign(new Error("протокол A: псевдонім ключа контрольної точки (інший запис того самого фізичного ключа) заборонено"), { code: "CC_KEY_SEALED" });
      const lease = run.lease, l = opts?.lease;
      if (!opts?.ticket) throw Object.assign(new Error("протокол A: запис контрольної точки без квитка beforeCommit заборонено"), { code: "CC_KEY_SEALED" });
      if (!lease || !run.store || l?.token !== lease.token || l?.leaseId !== lease.leaseId || (l?.scope && l.scope !== lease.scope)) throw Object.assign(new Error("протокол A: запис точки — лише під чинною орендою протоколу A (token + leaseId)"), { code: "CC_TICKET_REJECTED" });
      return w2.putJsonIfVersionFenced(SEALED_CHECKPOINT_KEY, value, version, { ...leaseFence(lease), ticket: opts.ticket });
    },
  };
  return { ...base, committer, store, serving, warnings: run.warnings };
}
