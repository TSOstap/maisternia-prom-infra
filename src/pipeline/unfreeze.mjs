/** Рішення власника 15.11.2026: «у нас мають бути всі товари постачальника… тільки без дублів» — розморозити свідомо виключені
 *  товари: прибрати їхні Offer ID з аркуша «Заморожені ID», щоб «Знайти нові» поставила їх у «Нові товари».
 *  Захист: ID, який уже є в «Основному каталозі», не прибирається (це відомий товар, а не виключений); ID зі списку keep
 *  (рішення власника «дубль») — теж. Рядки не видаляються: вміст переписується на тих самих місцях зверху, хвіст очищується. */
import { mtText } from "../core/text.mjs";

export const FROZEN_SHEET = "Заморожені ID";
const MAIN = "Основний каталог";

/** → { values (новий вміст без заголовка), removed: [ID], refused: [{id, reason}], missing: [ID] } */
export function unfreezePlan(frozenValues, { ids = [], keep = [], mainIds = new Set() } = {}) {
  const h = (frozenValues?.[0] || []).map((x) => mtText(x).trim());
  const ci = h.indexOf("Offer ID");
  if (ci < 0) throw new Error("аркуш «" + FROZEN_SHEET + "»: немає колонки «Offer ID»");
  const want = new Set(ids.map((x) => mtText(x).trim()).filter(Boolean)), hold = new Set(keep.map((x) => mtText(x).trim()));
  const refused = [];
  for (const id of want) {
    if (hold.has(id)) refused.push({ id, reason: "рішення власника: дубль — лишається замороженим" });
    else if (mainIds.has(id)) refused.push({ id, reason: "уже в «Основному каталозі» — не виключений товар" });
  }
  const bad = new Set(refused.map((r) => r.id));
  const values = [], removed = [], seen = new Set();
  for (const r of frozenValues.slice(1)) {
    const id = mtText(r[ci]).trim();
    if (!id && r.every((x) => mtText(x).trim() === "")) continue;
    if (want.has(id) && !bad.has(id)) { removed.push(id); seen.add(id); continue; }
    values.push(h.map((_, i) => r[i] ?? ""));
  }
  const missing = [...want].filter((id) => !seen.has(id) && !bad.has(id));
  return { values, removed, refused, missing };
}

export async function unfreezeIds({ sheets, readBook, stamp, ids = [], keep = [], reason = "" }) {
  const book = await readBook([FROZEN_SHEET, MAIN]);
  const before = book[FROZEN_SHEET];
  if (!before?.length) return { state: "BLOCKED", reason: "немає аркуша «" + FROZEN_SHEET + "»" };
  const mh = (book[MAIN]?.[0] || []).map((x) => mtText(x).trim()), mi = mh.indexOf("Offer ID");
  if (mi < 0) return { state: "BLOCKED", reason: "немає заголовка «Основного каталогу»" };
  const mainIds = new Set((book[MAIN] || []).slice(1).map((r) => mtText(r[mi]).trim()).filter(Boolean));
  const plan = unfreezePlan(before, { ids, keep, mainIds });
  if (!plan.removed.length) return { state: "NOTHING", reason: "немає чого розморожувати", refused: plan.refused, missing: plan.missing };
  const width = before[0].length, oldRows = before.length - 1;
  const body = plan.values.concat(Array.from({ length: Math.max(0, oldRows - plan.values.length) }, () => Array(width).fill("")));
  await sheets.updateRanges([{ title: FROZEN_SHEET, row: 2, col: 1, values: body }]);
  const after = (await readBook([FROZEN_SHEET]))[FROZEN_SHEET];
  const left = new Set(after.slice(1).map((r) => mtText(r[0]).trim()));
  const ok = plan.removed.every((id) => !left.has(id)) && after.slice(1).filter((r) => mtText(r[0]).trim()).length === plan.values.length;
  const note = `розморожено ${plan.removed.length} Offer ID${plan.refused.length ? `; не розморожено ${plan.refused.length} (дублі / уже в каталозі)` : ""}`;
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", "", "СТРУКТУРА", "", note.slice(0, 1000), reason || "рішення власника 15.11: усі товари постачальника, без дублів"]]);
  return { state: ok ? "UNFROZEN" : "INCOMPLETE", removed: plan.removed.length, kept: plan.values.length, refused: plan.refused, missing: plan.missing };
}
