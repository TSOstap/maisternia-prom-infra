/** Разовий крок структури (рішення власника 04.11.2026, ProSale):
 *   • колонка «Тариф ProSale» у КІНЦІ «Основного каталогу» — тариф окремого товару (має перевагу над тарифом категорії);
 *   • аркуш «Тарифи ProSale» — категорія Prom, ставка «Економ», товарів у каталозі, «Тариф» (заповнює власник: Звичайний /
 *     Більше продажів / Турбо; порожньо = Економ) і готова націнка для кожного тарифу (для цін до 10 000 грн; понад — трохи менша).
 *  Наявне не змінюється: колонка / аркуш уже є — не пишеться. */
import { mtText } from "../core/text.mjs";
import { PROSALE_TARIFF_COLUMN, PROSALE_SHEET, PROSALE_SHEET_HEADER, TARIFFS } from "../core/prosale.mjs";
import RATES from "../../config/prosale-rates.json" with { type: "json" };

const MAIN = "Основний каталог";
/** Націнка (%) для ціни до 10 000 грн: (1 − r) / (1 − k·r) − 1. */
const markupPct = (rate, k) => Math.round(((1 - rate / 100) / (1 - (k * rate) / 100) - 1) * 10000) / 100;

export function prosaleSheetRows(mainValues, rates = RATES) {
  const h = mainValues[0].map((x) => mtText(x)), ci = h.indexOf("Категорія Prom ID");
  const count = new Map();
  for (const r of mainValues.slice(1)) { const id = mtText(r[ci]).trim(); if (id) count.set(id, (count.get(id) || 0) + 1); }
  return [...count].sort((a, b) => b[1] - a[1]).map(([id, n]) => {
    const c = rates.categories?.[id];
    if (c && Number.isFinite(c.order)) return [id, c.name, "за замовлення", `${c.order}%`, n, "", `${markupPct(c.order, TARIFFS["звичайний"])}%`, `${markupPct(c.order, TARIFFS["більше продажів"])}%`, `${markupPct(c.order, TARIFFS["турбо"])}%`];
    if (c && Number.isFinite(c.click)) return [id, c.name, `за перехід ${c.click} грн`, "", n, "", "—", "—", "—"];
    return [id, c?.name || "", "ставка невідома", "", n, "", "—", "—", "—"];
  });
}

export async function addProsaleColumns({ sheets, readBook, stamp }) {
  const book = await readBook([MAIN, PROSALE_SHEET]);
  const header = (book[MAIN]?.[0] || []).map((x) => mtText(x));
  if (!header.includes("Offer ID")) return { state: "BLOCKED", reason: "немає заголовка «Основного каталогу»" };
  const done = [];
  if (!header.includes(PROSALE_TARIFF_COLUMN)) {
    let last = header.length; while (last > 0 && !header[last - 1]) last--;
    await sheets.ensureColumns(MAIN, last + 1);
    await sheets.updateRanges([{ title: MAIN, row: 1, col: last + 1, values: [[PROSALE_TARIFF_COLUMN]] }]);
    done.push(`колонка «${PROSALE_TARIFF_COLUMN}»`);
  }
  let rows = 0;
  if (!book[PROSALE_SHEET]) {
    const values = prosaleSheetRows(book[MAIN]);
    await sheets.ensureSheet(PROSALE_SHEET, PROSALE_SHEET_HEADER.slice());
    await sheets.appendRows(PROSALE_SHEET, values);
    rows = values.length;
    done.push(`аркуш «${PROSALE_SHEET}» (${rows} категорій)`);
  }
  if (!done.length) return { state: "NOTHING", reason: "колонка й аркуш уже є" };
  const after = await readBook([MAIN, PROSALE_SHEET]);
  const ok = after[MAIN][0].map((x) => mtText(x)).includes(PROSALE_TARIFF_COLUMN) && (after[PROSALE_SHEET]?.length || 0) - 1 >= rows;
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", "", "СТРУКТУРА", "", done.join("; "), "рішення власника 04.11: ProSale — тариф товару і тарифи категорій"]]);
  return { state: ok ? "PROSALE_COLUMNS_ADDED" : "INCOMPLETE", done, rows };
}
