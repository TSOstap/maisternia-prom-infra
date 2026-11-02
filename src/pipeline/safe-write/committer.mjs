/** E3 (ENG-01 K2) — оренда запису з fencing-токеном. Контракт `cc-committer-v1` (CC-R3-READINESS-CONTRACT §3):
 *    acquire(scope) → { token, assertCurrent(), release() }  — або виняток, якщо ресурс зайнятий.
 *
 *  Одна черга для всіх записувачів ТАБЛИЦІ: область (scope: "sync", "catalog-controls", "content-html", …) — лише мітка; оренда
 *  береться на РЕСУРС (`resourceFor(scope)`, за замовчуванням «sheets-main»). Окремий ресурс — лише для службових перевірок
 *  (`…:readiness-probe`), щоб перевірка готовності не блокувала робочий запис.
 *
 *  Гарантії (на рівні сховища з CAS — `store.putJsonIfVersion`):
 *   1. token — ціле ≥ 1, строго зростає з кожною видачею (навіть після збою власника).
 *   2. Виключність: поки оренда чинна (не звільнена й не сплила) — друга видача → BUSY. Дві одночасні видачі → одна виграє CAS.
 *   3. Застаріла оренда: assertCurrent() / release() після звільнення, спливу чи перехоплення → STALE. Стара оренда не може
 *      звільнити чужу (release перевіряє token) і не проходить перевірку перед записом.
 *   4. Перехоплення після збою власника — лише після спливу оренди + settleMs. settleMs ≥ максимального часу обробки запиту
 *      Google (офіційно: «When Sheets processes a request for more than 180 seconds, the request returns a timeout error») +
 *      клієнтського тайм-ауту — щоб запит, відправлений старою орендою, вже не міг застосуватися. За замовчуванням 200 000 мс.
 *      ЗАЛИШКОВИЙ РИЗИК: документація Google не підтверджує, що запит не застосується після тайм-ауту (ENG-06 §Блокери).
 *   5. Fencing ключів сховища (H04, Р7): оренда НЕ змінює жодних чужих ключів. Ключі, які можна писати лише під чинною орендою
 *      (контрольна точка Catalog Controls), пишуться store.putJsonIfVersionFenced(key, …, { leaseKey, token }) — сховище
 *      атомарно перевіряє token оренди й версію ключа; запізнілий запис старої оренди → CONFLICT (fencing).
 *
 *  Годинник: оренда порівнює час одного процесу-власника з часом наступного. Для кількох машин потрібен узгоджений час
 *  (розбіжність годинників додається до settleMs).
 *
 *  ENG-23 (узгоджений контракт F04 / F06 / F08, розд. 2.1, E1):
 *   • leaseId — 32 hex (16 байт crypto.randomBytes), новий на КОЖНУ видачу; зберігається в записі оренди. assertCurrent / renew /
 *     release перевіряють і token, і leaseId: ідентичність оренди не залежить від годинника й не повторюється (F04);
 *   • generation — покоління відновлення з запису оренди (≥ 0); змінює його лише погоджена процедура recover (E8);
 *   • межа епох (E2): acquire(scope, { floor }) — нова оренда лише якщо токен у записі ≥ floor; інакше RECOVERY_PENDING (відкат
 *     сховища W2), оренди немає, лічильник НЕ піднімається мовчки (підняття — лише в процедурі recover). */
import crypto from "node:crypto";

/** Помилка оренди виникає ДО відправлення запиту до Sheets — результат запису NOT_APPLIED. */
export class LeaseError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = "LeaseError"; this.code = code; this.outcome = "NOT_APPLIED"; }
}

export const DEFAULT_RESOURCE = "sheets-main";
export const defaultResourceFor = (scope) => (/:readiness-probe$/.test(String(scope)) ? String(scope) : DEFAULT_RESOURCE);
export const leaseKeyOf = (resource) => `state/write-lease/${resource}.json`;
const leaseKey = leaseKeyOf;

/**
 * @param {object} o
 * @param {{ getJsonVersioned: Function, putJsonIfVersion: Function }} o.store
 * @param {(scope: string) => string} [o.resourceFor]
 * @param {() => number} [o.now]
 * @param {number} [o.ttlMs]      тривалість оренди
 * @param {number} [o.settleMs]   вікно після спливу, коли запити старого власника ще можуть застосуватися
 * @param {string} [o.owner]      ідентифікатор процесу (для аудиту)
 */
export function createCommitter({ store, resourceFor = defaultResourceFor, now = Date.now, ttlMs = 15 * 60_000, settleMs = 200_000, owner = "process", ...rest }) {
  if (!store?.getJsonVersioned || !store?.putJsonIfVersion) throw new Error("committer: потрібне сховище cc-store-v1");
  if (!(ttlMs > 0) || !(settleMs >= 0)) throw new Error("committer: невалідні ttlMs / settleMs");
  // Р7: оновлення чужих ключів при видачі оренди заборонено рішенням власника — опцію прибрано, повернення — лише явною зміною коду.
  if ("touchKeys" in rest) throw new Error("committer: touchKeys заборонено (Р7) — для fencing використовуйте store.putJsonIfVersionFenced");

  async function acquire(scope, { label = "", floor = null } = {}) {
    const resource = resourceFor(String(scope)), key = leaseKey(resource);
    const { value: cur, version } = await store.getJsonVersioned(key);
    const t = now();
    // E2: токен у записі нижчий за межу з незалежних коренів (head W2, епохи fencing і дзеркало у сховищі фідів) — сховище W2 відкочено.
    if (floor !== null && (!Number.isInteger(floor) || floor < 0)) throw new LeaseError("RECOVERY_PENDING", "межа епох невалідна — оренду не видано");
    if (Number.isInteger(floor) && (cur?.token || 0) < floor) throw new LeaseError("RECOVERY_PENDING", `токен у записі оренди (${cur?.token || 0}) нижчий за межу епох (${floor}) — сховище W2 відкочено; потрібна погоджена власником процедура відновлення`);
    if (cur && !cur.released) {
      if (t < cur.expiresAt) throw new LeaseError("BUSY", `ресурс «${resource}» зайнятий записувачем «${cur.scope}» (token ${cur.token}) до ${new Date(cur.expiresAt).toISOString()}`);
      if (t < cur.expiresAt + settleMs) throw new LeaseError("SETTLING", `оренда token ${cur.token} сплила без звільнення; запити старого власника ще можуть застосуватися — перехоплення після ${new Date(cur.expiresAt + settleMs).toISOString()}`);
    }
    const token = (cur?.token || 0) + 1;
    const leaseId = crypto.randomBytes(16).toString("hex"), generation = Number.isInteger(cur?.generation) ? cur.generation : 0;
    const lease = { token, leaseId, generation, resource, scope: String(scope), owner, label, acquiredAt: t, expiresAt: t + ttlMs, released: false,
      previous: cur ? { token: cur.token, scope: cur.scope, released: Boolean(cur.released), crashed: !cur.released } : null };
    try { await store.putJsonIfVersion(key, lease, version); } catch (e) {
      if (e?.code === "CONFLICT") throw new LeaseError("BUSY", `ресурс «${resource}» щойно взяв інший записувач`);
      throw e;
    }
    let gone = false;
    const assertCurrent = async () => {
      if (gone) throw new LeaseError("STALE", `оренду token ${token} уже звільнено цим власником`);
      const { value } = await store.getJsonVersioned(key);
      if (!value || value.token !== token) throw new LeaseError("STALE", `оренду token ${token} перехоплено (чинний token ${value?.token ?? "—"})`);
      if (value.leaseId !== leaseId) throw new LeaseError("STALE", `оренду token ${token} підмінено: інший leaseId (відкат або чужа видача)`);
      if (value.released) throw new LeaseError("STALE", `оренду token ${token} звільнено`);
      if (now() >= value.expiresAt) throw new LeaseError("STALE", `оренда token ${token} сплила`);
    };
    const renew = async () => {
      const { value, version: v } = await store.getJsonVersioned(key);
      if (!value || value.token !== token || value.leaseId !== leaseId || value.released || now() >= value.expiresAt) throw new LeaseError("STALE", `оренду token ${token} не можна подовжити`);
      const expiresAt = now() + ttlMs;
      await store.putJsonIfVersion(key, { ...value, expiresAt }, v);
      handle.expiresAt = expiresAt;
    };
    const release = async () => {
      const { value, version: v } = await store.getJsonVersioned(key);
      if (!value || value.token !== token || value.leaseId !== leaseId) throw new LeaseError("STALE", `стара оренда token ${token} не може звільнити чинну (token ${value?.token ?? "—"})`);
      if (value.released) throw new LeaseError("STALE", `оренду token ${token} уже звільнено`);
      await store.putJsonIfVersion(key, { ...value, released: true, releasedAt: now() }, v);
      gone = true;
    };
    const handle = { token, leaseId, generation, expiresAt: lease.expiresAt, resource, leaseKey: key, scope: String(scope), tookOverCrashed: Boolean(cur && !cur.released), previous: lease.previous, assertCurrent, renew, release };
    return handle;
  }

  /** ENG-24 (E8, cc-recovery-v1 крок 4): підняти лічильник оренди до межі епох і покоління — ЛИШЕ в погодженій власником процедурі
   *  відновлення (recovery.establishFloor). Ресурс має бути вільним (немає чинної оренди й вікна settle). Лічильник лише зростає:
   *  токен у записі = max(поточний, floor) (наступна оренда = межа + 1); покоління = max(поточне + 1, minGeneration). CAS. */
  async function raiseFloor(scope, { floor, minGeneration = 0, reason = "" } = {}) {
    if (!Number.isInteger(floor) || floor < 0) throw new LeaseError("RECOVERY_PENDING", "raiseFloor: невалідна межа");
    const resource = resourceFor(String(scope)), key = leaseKey(resource);
    const { value: cur, version } = await store.getJsonVersioned(key);
    const t = now();
    if (cur && !cur.released && t < cur.expiresAt + settleMs) throw new LeaseError("BUSY", `raiseFloor: ресурс «${resource}» має чинну оренду token ${cur.token}`);
    const token = Math.max(cur?.token || 0, floor), generation = Math.max((Number.isInteger(cur?.generation) ? cur.generation : 0) + 1, minGeneration);
    const next = { ...(cur || { resource, scope: String(scope), owner, acquiredAt: t, expiresAt: t }), token, generation, released: true, releasedAt: t, raisedFloor: { floor, from: cur?.token || 0, at: t, reason: String(reason).slice(0, 200) } };
    try { await store.putJsonIfVersion(key, next, version); } catch (e) {
      if (e?.code === "CONFLICT") throw new LeaseError("BUSY", `raiseFloor: ресурс «${resource}» щойно взяв інший записувач`);
      throw e;
    }
    return { token, generation };
  }

  // ENG-24: cc-committer-v2 (leaseId 32 hex на кожну видачу, generation, expiresAt) — вимога CC R7.3 (C4).
  return { contract: "cc-committer-v2", acquire, resourceFor, raiseFloor };
}
