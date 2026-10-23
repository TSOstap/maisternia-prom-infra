/** Категорія Prom — джерело істини (рішення власника 23.10.2026). Чисті функції.
 *
 *  Категорія, фактично встановлена в Prom (експорт товарів Prom), завжди має пріоритет над категорією з таблиці.
 *   • Товар не повертається до попередньої категорії; старіший експорт не перекриває новішого підтвердження.
 *   • Постачальник категорію Prom не задає (у його XML її немає) — синхронізація її не змінює.
 *   • Невідома категорія (товару немає в експорті / порожня) — не вигадується і не підставляється: лише позначка.
 *   • Offer ID не змінюється. Після зміни категорії характеристики перебудовуються за схемою НОВОЇ категорії
 *     (buildCharacteristics бере категорію рядка), а YML віддає нову portal_category_id — наступний імпорт її не поверне. */
import { mtText } from "./text.mjs";
import { SEAL_COLUMN, rowSeal } from "./seal.mjs";

export const CATEGORY_CONFIRMED = "Категорія Prom: підтверджено";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const confirmedDate = (v) => /PROM\s+(\d{4}-\d{2}-\d{2})/.exec(mtText(v))?.[1] || "";

/**
 * rows — рядки аркуша (об'єкти); promById — Map(Offer ID → { categoryId, url }) з експорту Prom;
 * date — дата експорту (YYYY-MM-DD); sheet — назва аркуша (для «Журналу»); seal — перераховувати печатку (основний каталог).
 * Повертає нові рядки, записи «Журналу», індекси змінених рядків і списки невідомих / застарілих.
 */
export function planPromCategories(rows, promById, { date, stamp, sheet, seal = true }) {
  if (!DATE_RE.test(mtText(date))) throw new Error("потрібна дата експорту Prom (YYYY-MM-DD)");
  const out = { rows: [], entries: [], changed: new Set(), unknown: [], stale: [], confirmed: 0, categoryChanged: 0 };
  rows.forEach((row, i) => {
    const r = { ...row };
    const id = mtText(row["Offer ID"]);
    const p = promById.get(id);
    const cat = mtText(p?.categoryId).trim();
    if (!p || !/^\d+$/.test(cat)) { out.unknown.push(id); out.rows.push(r); return; }
    const prev = confirmedDate(row[CATEGORY_CONFIRMED]);
    if (prev && prev > date) { out.stale.push(id); out.rows.push(r); return; } // старіший експорт не повертає попередню категорію
    const why = `КАТЕГОРІЯ PROM (експорт Prom ${date})`;
    let touched = false;
    const set = (col, next) => { if (mtText(r[col]) !== mtText(next)) { out.entries.push([stamp, sheet, id, col, mtText(r[col]), mtText(next), why]); r[col] = next; touched = true; } };
    if (mtText(r["Категорія Prom ID"]).trim() !== cat) out.categoryChanged++;
    set("Категорія Prom ID", cat);
    const url = mtText(p.url).trim();
    if (/^https?:\/\/[^\s<>"']+$/.test(url)) set("Категорія Prom URL", url);
    const mark = `PROM ${date}`;
    if (mtText(r[CATEGORY_CONFIRMED]) !== mark) { r[CATEGORY_CONFIRMED] = mark; touched = true; }
    out.confirmed++;
    if (touched) {
      if (seal) r[SEAL_COLUMN] = rowSeal(r);
      out.changed.add(i);
    }
    out.rows.push(r);
  });
  return out;
}

/** Експорт товарів Prom (2D-масив аркуша) → Map(Offer ID → { categoryId, url }). */
export function promCategoriesFromExport(values) {
  const h = (values?.[0] || []).map(mtText);
  const iId = h.indexOf("Ідентифікатор_товару"), iCat = h.indexOf("Ідентифікатор_підрозділу"), iUrl = h.indexOf("Посилання_підрозділу");
  if (iId < 0 || iCat < 0) throw new Error("в експорті Prom немає колонок «Ідентифікатор_товару» / «Ідентифікатор_підрозділу»");
  const out = new Map(), dup = new Set();
  for (const r of values.slice(1)) {
    const id = mtText(r[iId]).trim();
    if (!id) continue;
    if (out.has(id)) dup.add(id);
    out.set(id, { categoryId: mtText(r[iCat]).trim(), url: iUrl >= 0 ? mtText(r[iUrl]).trim() : "" });
  }
  for (const id of dup) out.delete(id); // повторений товар в експорті — категорія невідома (не вибираємо)
  return out;
}
