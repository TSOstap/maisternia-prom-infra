/** ENG-24 (узгоджений контракт F04 / F06 / F08, розд. 3 `cc-recovery-v1`; E8) — процедура відновлення Engineering.
 *
 *  Стан відновлення — у дзеркалі реєстру рішень (сховище фідів, state/cc-registry/head.json, поле recovery): саме воно переживає
 *  відкат сховища W2 (W2_ONLY), коли оренду W2 видати неможливо. Записи цієї процедури в дзеркало — УМОВНІ (If-Match на поточний ETag,
 *  атомарно в сховищі, ENG-22 F02); паралельний записувач під fencing отримає STALE_FENCE і нічого не зафіксує (fail-closed).
 *
 *   1. declareRecovery(type)     — система (виявлення 2.6, детектор журналу) або оператор (FULL) → RECOVERY_PENDING з id.
 *   2. authorizeRecover(id, …)   — ЛИШЕ окремий дозвіл власника (Q1): той самий id, ім'я, підтвердження «ВІДНОВИТИ <id>»
 *                                  → RECOVERY_AUTHORIZED; floorProven — лише для типів із незалежним коренем (CP_ONLY, W2_ONLY).
 *   3. establishFloor()          — межа епох із незалежних коренів; лічильник оренди W2 = межа (наступна оренда = межа + 1),
 *                                  покоління + 1. FULL / UNKNOWN / JOURNAL без незалежного координатора — не доведено → BLOCK.
 *   4. CC runControls({ mode: "recover" }) під орендою нового покоління → beforeCommit(phase "recover") → запечатаний запис →
 *      afterCommit → NORMAL у head W2 і дзеркалі (cc-serving.mjs).
 *  Поки стан не NORMAL: CC не пише точки й не видає кодів, публікації й відкати заборонено (E7, update.mjs), обслуговування —
 *  перевірене безпечним щодо найсуворішого стану або 503 (cc-serving.mjs). Сирого відновлення сховищ ця процедура не робить. */
import crypto from "node:crypto";
import { REGISTRY_KEY } from "../publish/feed-fence.mjs";
import { epochFloor } from "./safe-write/epoch-floor.mjs";
import { SERVING_HEAD_KEY, SEALED_CHECKPOINT_KEY } from "./safe-write/store.mjs";
import { leaseKeyOf } from "./safe-write/committer.mjs";
import { jcsHash } from "./safe-write/jcs.mjs";

export const RECOVERY_STATE = Object.freeze({ NORMAL: "NORMAL", PENDING: "RECOVERY_PENDING", AUTHORIZED: "RECOVERY_AUTHORIZED" });
/** Типи з доведеною межею епох на одному хості: один із коренів (W2 / сховище фідів) не відкочено. */
export const PROVABLE_TYPES = Object.freeze(["CP_ONLY", "W2_ONLY"]);
export const RECOVERY_TYPES = Object.freeze(["CP_ONLY", "W2_ONLY", "F_ONLY", "FULL", "JOURNAL", "UNKNOWN"]);
const NORMAL_RECORD = Object.freeze({ state: RECOVERY_STATE.NORMAL, type: null, id: null, since: null, reason: "" });
const rawOf = (store) => store?.fenceBase || store; // дзеркало — напряму, умовним записом (без проксі fencing)
const iso = (now) => new Date(now()).toISOString();
export const confirmationFor = (id) => `ВІДНОВИТИ ${id}`;

/** Поточний стан відновлення з дзеркала → { recovery, mirror, etag }. Немає дзеркала → NORMAL. */
export async function readRecovery(feedStore) {
  const { value, etag } = await rawOf(feedStore).getJsonEtag(REGISTRY_KEY);
  const rec = value?.recovery && typeof value.recovery === "object" ? value.recovery : NORMAL_RECORD;
  return { recovery: { ...NORMAL_RECORD, ...rec }, mirror: value, etag };
}
export const recoveryActive = (rec) => Boolean(rec && rec.state && rec.state !== RECOVERY_STATE.NORMAL);

async function writeRecovery(feedStore, mutate) {
  const raw = rawOf(feedStore);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { value, etag } = await raw.getJsonEtag(REGISTRY_KEY);
    const cur = value || { v: 1, generation: 0, epochHigh: 0, leaseId: null, committed: null, prepared: null, recovery: { ...NORMAL_RECORD } };
    const rec = mutate({ ...NORMAL_RECORD, ...(cur.recovery || {}) }, cur);
    if (!rec) return { ...NORMAL_RECORD, ...(cur.recovery || {}) };
    try { await raw.putJson(REGISTRY_KEY, { ...cur, recovery: rec }, { ifMatch: etag }); return rec; }
    catch (e) { if (e?.code !== "PRECONDITION_FAILED" || attempt === 2) throw e; }
  }
  return null;
}

/** Хто виявив відновлення: лише система (таблиця 2.6, межа епох) оголошує тип із доведеною межею (ENG-25, e2). */
export const SYSTEM_DECLARER = "system";
const provableRecord = (rec) => PROVABLE_TYPES.includes(rec?.type) && rec?.declaredBy === SYSTEM_DECLARER;

/** Крок 1: RECOVERY_PENDING. Якщо відновлення вже активне — лишається чинний запис і id, крім ескалації (ENG-25, e3): тип без
 *  доведеної межі (JOURNAL / FULL / UNKNOWN / F_ONLY) під час відновлення з доведеною межею робить запис суворішим — новий тип і id,
 *  RECOVERY_PENDING, попередній дозвіл і межа недійсні (старе «ВІДНОВИТИ <id>» не діє). Зворотного зниження немає.
 *  Тип із доведеною межею (CP_ONLY / W2_ONLY) — лише declaredBy "system" (ENG-25, e2): оператор / API — RECOVERY_TYPE_FORBIDDEN. */
export async function declareRecovery({ feedStore, type, reason = "", declaredBy = "api", now = Date.now }) {
  if (!RECOVERY_TYPES.includes(type)) throw new Error("declareRecovery: невідомий тип " + type);
  if (PROVABLE_TYPES.includes(type) && declaredBy !== SYSTEM_DECLARER) throw Object.assign(new Error(`declareRecovery: тип ${type} (з доведеною межею епох) оголошує лише система (виявлення таблиці 2.6 / межа епох); оператор — лише FULL або UNKNOWN`), { code: "RECOVERY_TYPE_FORBIDDEN" });
  return writeRecovery(feedStore, (rec) => {
    const fresh = { state: RECOVERY_STATE.PENDING, type, id: crypto.randomBytes(6).toString("hex"), since: iso(now), reason: String(reason).slice(0, 400), declaredBy: String(declaredBy).slice(0, 60) };
    if (!recoveryActive(rec)) return fresh;
    if (!PROVABLE_TYPES.includes(type) && PROVABLE_TYPES.includes(rec.type)) return { ...fresh, escalatedFrom: rec.id, previous: { id: rec.id, type: rec.type, state: rec.state } };
    return null;
  });
}

const rankOf = (x) => [Number.isInteger(x?.generation) ? x.generation : 0, Number.isInteger(x?.epochHigh) ? x.epochHigh : 0];
const newer = (a, b) => { const [x, y] = [rankOf(a), rankOf(b)]; return (x[0] - y[0] || x[1] - y[1]) > 0; };
/** Ознаки доведеного типу в сховищах (не в записі оголошення). */
async function provableEvidence({ type, w2Store, mirror, head, leaseRec, floor }) {
  if (type === "W2_ONLY") {
    if ((leaseRec?.token ?? 0) < floor) return { ok: true };
    if (mirror?.committed && newer(mirror, head)) return { ok: true };
    return { ok: false, why: "лічильник оренди W2 не нижчий за межу, дзеркало не новіше за head" };
  }
  if (type === "CP_ONLY") {
    const C = (await w2Store.getJsonVersioned(SEALED_CHECKPOINT_KEY)).value;
    const hC = C == null ? null : jcsHash(C), Hc = head?.cp?.hash ?? null;
    if (Hc !== null && Hc === (mirror?.committed?.cpHash ?? null) && hC !== Hc) return { ok: true };
    return { ok: false, why: "head і дзеркало не узгоджені між собою або чинна точка вже збігається з ними" };
  }
  return { ok: false, why: "тип без доведеної межі" };
}

/** Крок 2: окремий дозвіл власника. Без точного id, імені й підтвердження «ВІДНОВИТИ <id>» — відмова, стан не змінюється. */
export async function authorizeRecover({ feedStore, id, authorizedBy, confirm, now = Date.now }) {
  const { recovery } = await readRecovery(feedStore);
  const why = [];
  if (recovery.state !== RECOVERY_STATE.PENDING) why.push(`стан ${recovery.state} — дозвіл можливий лише в RECOVERY_PENDING`);
  if (!id || id !== recovery.id) why.push("id відновлення не збігається з оголошеним");
  if (typeof authorizedBy !== "string" || !authorizedBy.trim()) why.push("потрібне ім'я власника, який дає дозвіл");
  if (confirm !== confirmationFor(recovery.id)) why.push(`потрібне точне підтвердження «${confirmationFor(recovery.id || "<id>")}»`);
  if (why.length) throw Object.assign(new Error("authorizeRecover: " + why.join("; ")), { code: "RECOVERY_NOT_AUTHORIZED" });
  const changed = () => Object.assign(new Error("authorizeRecover: стан змінився під час дозволу"), { code: "RECOVERY_NOT_AUTHORIZED" });
  // ENG-25 (e1): тип без незалежно доведеної межі (або не виявлений системою) — дозвіл блокування НЕ знімає: фіксується лише
  // ownerAck { by, at }, стан лишається RECOVERY_PENDING, відповідь — FLOOR_NOT_PROVEN.
  if (!provableRecord(recovery)) {
    await writeRecovery(feedStore, (rec) => {
      if (rec.state !== RECOVERY_STATE.PENDING || rec.id !== id) throw changed();
      return { ...rec, ownerAck: { by: authorizedBy.trim().slice(0, 80), at: iso(now) } };
    });
    throw Object.assign(new Error(`authorizeRecover: межу епох для типу ${recovery.type} (оголосив ${recovery.declaredBy || "—"}) не доведено незалежним джерелом — дозвіл зафіксовано (ownerAck), стан лишається RECOVERY_PENDING (повне відновлення без незалежного координатора — BLOCK)`), { code: "FLOOR_NOT_PROVEN" });
  }
  return writeRecovery(feedStore, (rec) => {
    if (rec.state !== RECOVERY_STATE.PENDING || rec.id !== id || !provableRecord(rec)) throw changed();
    return { ...rec, state: RECOVERY_STATE.AUTHORIZED, authorizedBy: authorizedBy.trim().slice(0, 80), authorizedAt: iso(now), floorProven: true };
  });
}

/**
 * Крок 3: межа епох з незалежних коренів → лічильник оренди W2 (через committer.raiseFloor, CAS запису оренди), покоління + 1.
 * Лише в RECOVERY_AUTHORIZED і для типу з доведеною межею. → { floor, generation }. Повтор — та сама межа, доки запис оренди їй
 * відповідає (те саме покоління, токен ≥ межі); якщо W2 відкочено вже після цього кроку — межу й покоління піднято знову (лише вгору).
 */
export async function establishFloor({ feedStore, w2Store, committer, feeds, now = Date.now }) {
  const { recovery, mirror } = await readRecovery(feedStore);
  // ENG-25 (e1): тип без доведеної межі — FLOOR_NOT_PROVEN за будь-якого стану (дозволу для нього не буває).
  if (recoveryActive(recovery) && !provableRecord(recovery)) throw Object.assign(new Error(`establishFloor: межу епох для типу ${recovery.type} не доведено незалежним джерелом (повне відновлення без незалежного координатора — BLOCK)`), { code: "FLOOR_NOT_PROVEN" });
  if (recovery.state !== RECOVERY_STATE.AUTHORIZED) throw Object.assign(new Error("establishFloor: потрібен окремий дозвіл власника (RECOVERY_AUTHORIZED)"), { code: "RECOVERY_NOT_AUTHORIZED" });
  if (!recovery.floorProven || !provableRecord(recovery)) throw Object.assign(new Error(`establishFloor: межу епох для типу ${recovery.type} не доведено незалежним джерелом (повне відновлення без незалежного координатора — BLOCK)`), { code: "FLOOR_NOT_PROVEN" });
  const fe0 = recovery.floorEstablished;
  const leaseRec = (await w2Store.getJsonVersioned(leaseKeyOf(committer.resourceFor("catalog-controls")))).value;
  if (fe0 && leaseRec && leaseRec.generation === fe0.generation && Number.isInteger(leaseRec.token) && leaseRec.token >= fe0.floor) return fe0;
  const { floor } = await epochFloor({ w2Store, feedStore: rawOf(feedStore), feeds });
  const head = (await w2Store.getJsonVersioned(SERVING_HEAD_KEY)).value;
  // ENG-25 (e2, захист у глибину): перед підняттям межі — ознаки доведеного типу ще мають бути в сховищах (оголошення само по собі
  // нічого не доводить). W2_ONLY: лічильник оренди W2 нижчий за межу з незалежних коренів або дзеркало новіше за head. CP_ONLY: head і
  // дзеркало узгоджені між собою, а чинна точка — інша. Ознак немає (напр. відкочено все разом) → FLOOR_NOT_PROVEN.
  const evidence = await provableEvidence({ type: recovery.type, w2Store, mirror, head, leaseRec, floor });
  if (!evidence.ok) throw Object.assign(new Error(`establishFloor: ознак типу ${recovery.type} у сховищах немає (${evidence.why}) — межу не доведено (BLOCK)`), { code: "FLOOR_NOT_PROVEN" });
  const raised = await committer.raiseFloor("catalog-controls", { floor: Math.max(floor, fe0?.floor ?? 0), minGeneration: Math.max(head?.generation ?? 0, mirror?.generation ?? 0, fe0?.generation ?? 0) + 1, reason: `recover ${recovery.id} (${recovery.type})` });
  const floorEstablished = { floor: raised.token, generation: raised.generation, at: iso(now) };
  await writeRecovery(feedStore, (rec) => {
    if (rec.state !== RECOVERY_STATE.AUTHORIZED || rec.id !== recovery.id) throw Object.assign(new Error("establishFloor: стан змінився"), { code: "RECOVERY_NOT_AUTHORIZED" });
    return { ...rec, floorEstablished };
  });
  return floorEstablished;
}
