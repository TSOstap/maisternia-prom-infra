/** ENG-20 (рішення власника 30.10, B): умовне перемикання маніфесту фіду з ETag та епохою fencing.
 *
 *  Проблема (Hermes E17-02): оренда W2 живе в іншому сховищі, ніж маніфест; запізнілий PUT записувача, що втратив оренду, сховище
 *  фідів приймало. Простого If-Match недостатньо: старий записувач може тримати незмінений ETag.
 *
 *  Протокол:
 *   1. Одразу після отримання оренди W2 кожен записувач маніфестів (публікатор, відкат, запуск Catalog Controls) ПІДВИЩУЄ епоху:
 *      для кожного маніфесту — умовний запис { …, fence: { epoch: token оренди, scope, at } } з If-Match на щойно прочитаний ETag
 *      (ключа немає → If-None-Match: створюється заглушка без active — Worker нічого не віддає). Епоха в маніфесті не менша за нашу
 *      (ENG-21: рівна теж) → оренду перехоплено або лічильник оренди відкотився → відмова. Так епоха маніфестів — незалежна межа знизу
 *      для токенів оренди: після відкату каталогу W2 (за цілого сховища фідів) токен, що не перевищує вже використану епоху, не проходить.
 *   2. Далі цей записувач пише маніфест ЛИШЕ умовно, з ETag, отриманим після ВЛАСНОГО підвищення (і після кожного свого запису).
 *   3. Будь-яке наступне отримання оренди записувачем маніфестів змінює ETag (крок 1) → запізнілий запис старого записувача
 *      отримує 412 атомарно в сховищі — навіть якщо його запит затримався в мережі.
 *  Записувачі аркушів (sync / intake / archive / maintenance) епоху не підвищують: вони не фіксують обмежень Catalog Controls, тож
 *  запис старого публікатора після їхнього перехоплення не суперечить жодному новому обмеженню (обмеження фіксує лише запуск CC,
 *  а він підвищує епоху — протокол A, production.mjs).
 *
 *  Модель: LocalObjectStore (умова й запис атомарні на одному хості). НЕ доказ поведінки справжнього R2 (onlyIf / If-Match) чи
 *  розгорнутого Worker. Неумовні записи маніфесту поза цим протоколом не захищені (у R2-адаптері їх слід заборонити).
 *
 *  ENG-22 (Hermes ENG-21):
 *   F07 — атомарний умовний запис ОБОВ'ЯЗКОВИЙ: оголошена можливість сховища (capabilities.atomicConditionalPut) + функціональна
 *         проба під орендою (хибний / застарілий If-Match мають бути відхилені 412). Немає → NO_CAS (BLOCK), жодного безумовного запису.
 *   F03 — той самий протокол для операційного стану (state/operational.json, FENCED_STATE_KEYS): кожне отримання оренди записувачем
 *         маніфестів (у т.ч. запуск CC, протокол A) підвищує його епоху, а комміт синхронізації пише його лише умовно — запізнілий запис
 *         старої оренди після COMMITTED-обмеження CC відхиляється атомарно в сховищі.
 *
 *  ENG-23 (узгоджений контракт F04 / F06 / F08, розд. 2.3, E6):
 *   • штамп — { epoch: token, leaseId, scope, at }; at — лише аудит. Прийняття: cur.epoch < epoch; або cur.epoch === epoch і
 *     cur.leaseId === leaseId (повтор ВЛАСНОГО запису); інакше STALE_EPOCH. Рівність штампу за годинником більше нічого не дає (F04);
 *   • дзеркало реєстру рішень CC (state/cc-registry/head.json) — під тим самим fencing, що й маніфести й операційний стан. */
import crypto from "node:crypto";
import { manifestKey } from "./publisher.mjs";
import { keyIdentity } from "../storage/keys.mjs";

export const MANIFEST_RE = /^feeds\/[^/]+\/manifest\.json$/;
export const OPERATIONAL_KEY = "state/operational.json";
/** ENG-23: дзеркало реєстру рішень CC у сховищі фідів (власник — Engineering; Worker його не обслуговує — E10). */
export const REGISTRY_KEY = "state/cc-registry/head.json";
/** Службові ключі стану під тим самим fencing, що й маніфести (F03; ENG-23 — дзеркало реєстру). */
export const FENCED_STATE_KEYS = Object.freeze([OPERATIONAL_KEY, REGISTRY_KEY]);
const LEASE_ID = /^[0-9a-f]{32}$/;
/** ENG-25 (N1): за фізичною ідентичністю — псевдонім маніфесту чи службового ключа (регістр, кінцева крапка, «\») теж під fencing
 *  (через обгортку — NOT_FENCED / NOT_CONDITIONAL; саме сховище такий ключ і не прийме — INVALID_KEY). */
export const isFencedKey = (key) => { const id = keyIdentity(key); return MANIFEST_RE.test(id) || FENCED_STATE_KEYS.includes(id); };
export class FenceError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = "FenceError"; this.code = code; }
}
/** Оголошена можливість атомарного умовного запису (статична перевірка; функціональна — assertCasCapability). */
export const supportsFencing = (store) => typeof store?.getJsonEtag === "function" && typeof store?.putJson === "function" && store?.capabilities?.atomicConditionalPut === true;

/** ENG-22 (F07): функціональна проба CAS на службовому ключі: хибний If-Match → 412; правильний → запис; той самий (вже застарілий)
 *  If-Match → 412; читання повертає саме наш запис. Будь-яке відхилення → NO_CAS. Виконується під орендою (fenceFeeds). */
export const CAS_PROBE_KEY = "state/cas-probe.json";
export async function assertCasCapability(store) {
  if (!supportsFencing(store)) throw new FenceError("NO_CAS", "сховище фідів без оголошеного атомарного умовного запису (capabilities.atomicConditionalPut + getJsonEtag) — fencing неможливий, запис заборонено");
  const refused = async (fn) => { try { await fn(); return false; } catch (e) { return e?.code === "PRECONDITION_FAILED"; } };
  try {
    const nonce = crypto.randomUUID();
    const cur = await store.getJsonEtag(CAS_PROBE_KEY);
    if (!(await refused(() => store.putJson(CAS_PROBE_KEY, { kind: "CAS_PROBE_V1", nonce, step: "wrong" }, { ifMatch: `"cas-probe-${nonce}"` })))) throw new Error("запис із хибним If-Match не відхилено");
    const w = await store.putJson(CAS_PROBE_KEY, { kind: "CAS_PROBE_V1", nonce, step: "ok" }, { ifMatch: cur.etag });
    if (!(await refused(() => store.putJson(CAS_PROBE_KEY, { kind: "CAS_PROBE_V1", nonce, step: "stale" }, { ifMatch: cur.etag })))) throw new Error("запис із застарілим If-Match не відхилено");
    const after = await store.getJsonEtag(CAS_PROBE_KEY);
    if (after.value?.nonce !== nonce || after.value?.step !== "ok" || after.etag !== w?.etag) throw new Error("читання після умовного запису не збігається");
  } catch (e) {
    throw new FenceError("NO_CAS", "функціональна проба атомарного умовного запису не пройдена — запис заборонено: " + (e?.message || e));
  }
}

/** Крок 1: підвищити епоху в маніфестах feeds і службових ключах state (F03) під орендою lease → сховище, що пише їх лише умовно (крок 2). */
export async function fenceFeeds({ store, feeds, lease, scope = "", state = FENCED_STATE_KEYS }) {
  if (!lease || !Number.isInteger(lease.token) || typeof lease.assertCurrent !== "function") throw new FenceError("NO_LEASE", "fencing без чинної оренди W2");
  if (!LEASE_ID.test(String(lease.leaseId))) throw new FenceError("NO_LEASE", "fencing без leaseId оренди (cc-committer-v2) — ідентичність повтору невизначена");
  await assertCasCapability(store);
  const stamp = { epoch: lease.token, leaseId: lease.leaseId, scope: String(scope || lease.scope || ""), at: new Date().toISOString() };
  const expected = new Map();
  const targets = [
    ...feeds.map((feed) => ({ key: manifestKey(feed), label: "маніфест " + feed, stub: { kind: "FEED_MANIFEST_V1", feed, active: null, previous: null, history: [] } })),
    ...state.map((key) => ({ key, label: key, stub: {} })),
  ];
  for (const { key, label, stub } of targets) {
    for (let attempt = 1; ; attempt++) {
      const { value, etag } = await store.getJsonEtag(key);
      const cur = Number(value?.fence?.epoch || 0);
      // ENG-21: рівна епоха теж відмова (крім повтору ВЛАСНОГО запису): токен оренди мав строго зрости. Рівний / менший → оренду
      // перехоплено або лічильник оренди W2 відкотився (відновлення каталогу W2) — епоху не повторюємо (вона ж — епоха видачі кодів CC R7.2).
      // ENG-23 (F04): «власний» — лише за leaseId цієї видачі оренди; збіг epoch / scope / at іншої операції повтором не є.
      if (cur > stamp.epoch || (cur === stamp.epoch && value?.fence?.leaseId !== stamp.leaseId)) throw new FenceError("STALE_EPOCH", `${label}: епоха ${cur} не менша за нашу ${stamp.epoch} — токен оренди W2 не зростає (перехоплення або відкат сховища W2)`);
      await lease.assertCurrent();
      const next = { ...(value ?? stub), fence: stamp };
      try { const r = await store.putJson(key, next, { ifMatch: etag }); expected.set(key, r.etag); break; }
      catch (e) { if (e?.code !== "PRECONDITION_FAILED" || attempt >= 5) throw e; }
    }
  }
  return fencedStore(store, { stamp, lease, expected });
}

/** Крок 2: обгортка сховища — маніфести й службові ключі state (isFencedKey) пишуться лише умовно з ETag після власного fencing;
 *  безумовний put / delete цих ключів через обгортку заборонено (NOT_CONDITIONAL); решта ключів — без змін. */
export function fencedStore(base, f) {
  const putJson = async (key, value, opts) => {
    if (!isFencedKey(key)) return base.putJson(key, value, opts);
    if (!f.expected.has(key)) throw new FenceError("NOT_FENCED", `${key} не захищено fencing цієї оренди — запис заборонено`);
    await f.lease.assertCurrent();
    try {
      const r = await base.putJson(key, { ...value, fence: f.stamp }, { ifMatch: f.expected.get(key) });
      f.expected.set(key, r?.etag);
      return r;
    } catch (e) {
      if (e?.code === "PRECONDITION_FAILED") throw new FenceError("STALE_FENCE", `${MANIFEST_RE.test(String(key)) ? "маніфест " : ""}${key} змінено після fencing епохи ${f.stamp.epoch} — запис відхилено сховищем`);
      throw e;
    }
  };
  const refuse = (op) => async (key, ...rest) => {
    if (isFencedKey(key)) throw new FenceError("NOT_CONDITIONAL", `${op} ${key} повз умовний запис fencing заборонено`);
    return base[op](key, ...rest);
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "putJson") return putJson;
      if (prop === "put" || prop === "delete") return refuse(prop);
      if (prop === "fence") return f;
      if (prop === "fenceBase") return target;
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Компенсація ПІСЛЯ втрати оренди: лише записи, що зменшують обслуговування (зняття / знецінення запасної — secureServed,
 *  withdrawFeed), і лише умовно з ETag нашої останньої дії. Успішні, тільки якщо після нашої епохи маніфест ніхто не змінював;
 *  інакше 412 — безпеку забезпечує новий власник оренди (протокол A). Публікувати через це сховище заборонено (викликач). */
export function compensationStore(fenced) {
  const f = fenced?.fence;
  if (!f) return fenced;
  return fencedStore(fenced.fenceBase, { ...f, lease: { assertCurrent: async () => {} } });
}
