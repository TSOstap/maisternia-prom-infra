/** Разовий крок структури (рішення власника 14.11.2026, ціни за конкурентами): три ПОРОЖНІ колонки правила ціни в КІНЦІ
 *  «Основного каталогу» — «Ціна вручну», «Ціна вручну: при ціні постачальника», «Надбавка» (src/core/pricing.mjs).
 *  Порожні колонки ціни не змінюють; значення пише лише owner-edits. Наявні колонки не змінюються: уже є — не пишеться. */
import { mtText } from "../core/text.mjs";
import { PRICE_RULE_COLUMNS } from "../core/pricing.mjs";

const MAIN = "Основний каталог";

export async function addPriceRuleColumns({ sheets, readBook, stamp }) {
  const book = await readBook([MAIN]);
  const header = (book[MAIN]?.[0] || []).map((x) => mtText(x));
  if (!header.includes("Offer ID")) return { state: "BLOCKED", reason: "немає заголовка «Основного каталогу»" };
  const missing = PRICE_RULE_COLUMNS.filter((c) => !header.includes(c));
  if (!missing.length) return { state: "NOTHING", reason: "колонки вже є" };
  let last = header.length; while (last > 0 && !header[last - 1]) last--;
  await sheets.ensureColumns(MAIN, last + missing.length);
  await sheets.updateRanges([{ title: MAIN, row: 1, col: last + 1, values: [missing.slice()] }]);
  const after = (await readBook([MAIN]))[MAIN][0].map((x) => mtText(x));
  const ok = PRICE_RULE_COLUMNS.every((c) => after.indexOf(c) >= 0 && after.indexOf(c) === after.lastIndexOf(c));
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", "", "СТРУКТУРА", "", "колонки " + missing.map((c) => `«${c}»`).join(", "), "рішення власника 14.11: ціни за конкурентами — ручна ціна (лише поки ціна постачальника та сама) і надбавка −1…+5"]]);
  return { state: ok ? "PRICE_RULE_COLUMNS_ADDED" : "INCOMPLETE", added: missing };
}
