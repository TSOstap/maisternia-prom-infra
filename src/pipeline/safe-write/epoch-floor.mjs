/** ENG-23 (узгоджений контракт F04 / F06 / F08, розд. 2.2, E2) — межа епох із незалежних коренів.
 *
 *    floor = max( head W2 (state/cc-serving/head.json).epochHigh,
 *                 епохи fencing у сховищі фідів: feeds/<feed>/manifest.json і FENCED_STATE_KEYS,
 *                 дзеркало реєстру (state/cc-registry/head.json).epochHigh )
 *  Токен оренди W2 сам по собі в межу входить тривіально (нова оренда = запис + 1): committer.acquire(scope, { floor }) видає оренду
 *  лише якщо токен у записі ≥ floor, інакше RECOVERY_PENDING — без мовчазного підняття лічильника (підняття — лише погоджена
 *  власником процедура recover, E8).
 *  Корені в межах одного хоста: сховище W2 і сховище фідів. Повне спільне відновлення обох (і точки) НЕ виявляється — BLOCK до
 *  незалежного координатора (Durable Objects). Помилка читання будь-якого кореня → виняток (fail-closed: оренди немає). */
import { manifestKey } from "../../publish/publisher.mjs";
import { FENCED_STATE_KEYS, REGISTRY_KEY } from "../../publish/feed-fence.mjs";
import { SERVING_HEAD_KEY } from "./store.mjs";

const epochOf = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** → { floor, parts: { head, registry, fences: { key: epoch } } } */
export async function epochFloor({ w2Store, feedStore, feeds }) {
  if (!w2Store?.getJsonVersioned) throw new Error("межа епох: немає сховища W2");
  if (!feedStore?.getJson) throw new Error("межа епох: немає сховища фідів");
  const head = (await w2Store.getJsonVersioned(SERVING_HEAD_KEY)).value;
  const fences = {};
  for (const key of [...(feeds || []).map((f) => manifestKey(f)), ...FENCED_STATE_KEYS]) fences[key] = epochOf((await feedStore.getJson(key))?.fence?.epoch);
  const registry = await feedStore.getJson(REGISTRY_KEY);
  const parts = { head: epochOf(head?.epochHigh), registry: epochOf(registry?.epochHigh), fences };
  return { floor: Math.max(parts.head, parts.registry, ...Object.values(fences), 0), parts };
}
