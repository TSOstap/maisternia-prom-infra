/** ENG-29 (переїзд на сервер, рішення власника 02.11) — серверна частина сховища W2 (контракт cc-store-v1) для Cloudflare Durable Object.
 *
 *  Клієнт — RemoteStore (store.mjs). Тут — лише те, що мусить бути АТОМАРНИМ: перевірка оренди (fencing) і CAS ключа в одній
 *  критичній секції. Durable Object однопотоковий, а весь код нижче — синхронний (жодного await), тож між перевіркою й записом
 *  інший запит не вклиниться. Обгортка DO викликає w2Handle у transactionSync: помилка посередині → відкат без часткового запису.
 *
 *  Правила — ті самі, що в MemoryStore / FileStore:
 *   • ключі — лише канонічні (src/storage/keys.mjs), інакше INVALID_KEY;
 *   • ключ контрольної точки CC і head протоколу serving — запечатані: звичайний CAS → CC_KEY_SEALED; точка — лише fenced-записом
 *     із leaseId і квитком (квиток перевіряє клієнт у своєму процесі — стіл квитків існує лише там, як і в FileStore), head — лише
 *     операцією head (стіл квитків);
 *   • fencing: оренда за leaseKey має той самий token (і leaseId, якщо пред'явлено), не звільнена, тієї самої області (scope);
 *     для точки — ще й не сплила на момент запису (час — годинник клієнта-власника оренди, як у FileStore);
 *   • версія — рядок-лічильник ("1", "2", …), як у FileStore.
 *  Ідемпотентність: кожен запит має reqId; відповідь (і успіх, і відмова) зберігається в тій самій транзакції, повтор того самого
 *  reqId (втрачена відповідь, повтор клієнта) повертає збережену відповідь і нічого не змінює.
 *  Межа довіри — ключ запускача (RUNNER_KEY): хто його має, той є «процесом» у сенсі моделі загроз FileStore (рішення власника Q6). */
import { canonicalStateKey, keyIdentity } from "../../storage/keys.mjs";

export const CHECKPOINT_KEY = "state/catalog-controls/checkpoint.json";
export const HEAD_KEY = "state/cc-serving/head.json";
const CHECKPOINT_ID = keyIdentity(CHECKPOINT_KEY), HEAD_ID = keyIdentity(HEAD_KEY);
const HEX32 = /^[0-9a-f]{32}$/;
export const REQ_KEEP_MS = 7 * 24 * 3600_000;

const fail = (code, message, extra = {}) => ({ error: { code, message, ...extra } });

/** Канонічний ключ або відмова INVALID_KEY (повідомлення — як у keys.mjs). */
function canon(key) {
  try { return { key: canonicalStateKey(key) }; }
  catch (e) { return fail(e?.code || "INVALID_KEY", String(e?.message || e)); }
}

/** Та сама перевірка, що checkFence у store.mjs: null — оренда чинна для цього запису. */
function fenceProblem(key, lease, fence) {
  if (!fence || typeof fence.leaseKey !== "string" || !Number.isInteger(fence.token)) return fail("BAD_FENCE", "fenced-запис: потрібні leaseKey і token");
  if (fence.leaseKey === key) return fail("BAD_FENCE", "fenced-запис: ключ оренди не можна писати fenced-записом");
  const stale = (reason) => fail("STALE_LEASE", reason, { key });
  if (!lease || lease.token !== fence.token) return stale(`чинний token ${lease?.token ?? "—"}, запит від token ${fence.token}`);
  if (fence.leaseId !== undefined && lease.leaseId !== fence.leaseId) return stale(`оренда token ${fence.token} з іншим leaseId (відкат сховища W2 або чужа видача)`);
  if (lease.released) return stale(`оренду token ${fence.token} звільнено`);
  if (fence.scope && lease.scope !== fence.scope) return stale(`оренда token ${fence.token} належить області «${lease.scope}», а не «${fence.scope}»`);
  return null;
}

function cas(kv, key, value, version) {
  const cur = kv.get(key)?.version ?? null;
  if (cur !== (version ?? null)) return fail("CONFLICT", `CONFLICT: «${key}» — версія ${cur ?? "відсутня"} ≠ очікуваній ${version ?? "відсутня"}`, { key, expected: version ?? null, actual: cur });
  const next = String((Number(cur) || 0) + 1);
  kv.set(key, value === undefined ? null : value, next);
  return { result: { version: next } };
}

/** Одна операція сховища (без ідемпотентності). kv: { get(key) → { value, version } | null, set(key, value, version) } — синхронні. */
export function w2Apply(kv, req) {
  const op = req?.op;
  if (op === "get") {
    const c = canon(req.key); if (c.error) return c;
    const r = kv.get(c.key);
    return { result: { value: r ? r.value : null, version: r ? r.version : null } };
  }
  if (op === "cas") {
    const id = keyIdentity(req.key);
    if (id === CHECKPOINT_ID || id === HEAD_ID) return fail("CC_KEY_SEALED", `CC_KEY_SEALED: «${req.key}» — запис без оренди й квитка заборонено`, { key: req.key });
    const c = canon(req.key); if (c.error) return c;
    return cas(kv, c.key, req.value, req.version);
  }
  if (op === "fenced") {
    const id = keyIdentity(req.key);
    if (id === HEAD_ID) return fail("CC_KEY_SEALED", `CC_KEY_SEALED: «${req.key}» — head протоколу serving пише лише Engineering (стіл квитків)`, { key: req.key });
    if (id === CHECKPOINT_ID && req.key !== CHECKPOINT_KEY) return fail("CC_KEY_SEALED", `CC_KEY_SEALED: «${req.key}» — псевдонім ключа контрольної точки (інший запис того самого фізичного ключа) заборонено`, { key: req.key });
    const c = canon(req.key); if (c.error) return c;
    const lk = canon(req.fence?.leaseKey ?? ""); if (lk.error) return lk;
    if (lk.key === c.key) return fail("BAD_FENCE", "fenced-запис: ключ оренди не можна писати fenced-записом");
    const isPoint = c.key === CHECKPOINT_KEY;
    if (isPoint && req.fence?.leaseId === undefined) return fail("CC_KEY_SEALED", `CC_KEY_SEALED: «${c.key}» — запис точки без leaseId оренди заборонено`, { key: c.key });
    if (isPoint && !HEX32.test(String(req.ticket))) return fail("CC_KEY_SEALED", `CC_KEY_SEALED: «${c.key}» — запис контрольної точки без квитка beforeCommit заборонено`, { key: c.key });
    const lease = kv.get(lk.key)?.value ?? null;
    const bad = fenceProblem(c.key, lease, req.fence);
    if (bad) return bad;
    if (isPoint && !(Number.isFinite(req.leaseNow) && req.leaseNow < lease.expiresAt)) return fail("CC_TICKET_REJECTED", `CC_TICKET_REJECTED: «${c.key}» — оренда квитка сплила`, { key: c.key, reasons: ["оренда квитка сплила"] });
    return cas(kv, c.key, req.value, req.version);
  }
  if (op === "head") {
    const lk = canon(req.fence?.leaseKey ?? ""); if (lk.error) return lk;
    if (req.fence?.leaseId === undefined) return fail("CC_KEY_SEALED", `CC_KEY_SEALED: «${HEAD_KEY}» — запис head без leaseId оренди заборонено`, { key: HEAD_KEY });
    const bad = fenceProblem(HEAD_KEY, kv.get(lk.key)?.value ?? null, req.fence);
    if (bad) return bad;
    return cas(kv, HEAD_KEY, req.value, req.version);
  }
  return fail("BAD_REQUEST", "невідома операція сховища W2: " + String(op).slice(0, 40));
}

/** Операція з ідемпотентністю за reqId (32 hex). kv додатково: getReq(id) → відповідь | null, putReq(id, at, відповідь). */
export function w2Handle(kv, req, now = Date.now()) {
  if (!HEX32.test(String(req?.reqId))) return fail("BAD_REQUEST", "немає reqId (32 hex)");
  const seen = kv.getReq(req.reqId);
  if (seen) return { ...seen, replay: true };
  const res = w2Apply(kv, req);
  if (req.op !== "get") kv.putReq(req.reqId, now, res);
  return res;
}

/** Початкове заповнення (перенесення стану з однохостового FileStore): лише в ПОРОЖНЄ сховище, версії — як у джерелі. */
export function w2Seed(kv, entries) {
  if (kv.count() > 0) return fail("NOT_EMPTY", "сховище W2 у Durable Object уже має дані — повторне заповнення заборонено");
  if (!Array.isArray(entries) || !entries.length) return fail("BAD_REQUEST", "немає записів для заповнення");
  const seen = new Set();
  for (const e of entries) {
    const c = canon(e?.key); if (c.error) return c;
    if (c.key !== e.key) return fail("INVALID_KEY", "ключ не канонічний: " + String(e.key).slice(0, 120));
    if (seen.has(c.key)) return fail("BAD_REQUEST", "повторний ключ: " + c.key);
    if (typeof e.version !== "string" || !/^[1-9]\d*$/.test(e.version)) return fail("BAD_REQUEST", "версія має бути рядком-лічильником: " + c.key);
    seen.add(c.key);
  }
  for (const e of entries) kv.set(e.key, e.value ?? null, e.version);
  return { result: { seeded: entries.length } };
}
