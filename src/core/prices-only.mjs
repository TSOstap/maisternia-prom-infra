/** «Оновити ціни й наявність» (рішення власника 03.11.2026: спершу ручна кнопка, розклад кожні 2 год — після підключення Prom).
 *  Чиста функція плану — без мережі й запису.
 *
 *  Лише 8 операційних колонок «Основного каталогу» (LIVE_COLUMNS) за чинними правилами цін і наявності (planRows — точний порт mtPlan
 *  LIVE) з ОПЕРАЦІЙНОГО фіду постачальника. Усе інше — назви, фото, характеристики, присутність у фіді, попередження постачальника —
 *  лише «Оновити товари». Тому рядок НЕ змінюється, якщо:
 *   • товар видалено (Catalog Controls) або «ВИДАЛЕНИЙ_У_ПОСТАЧАЛЬНИКА» (повернення оформлює «Оновити товари»);
 *   • товару немає у фіді (присутність і пороги зникнення — лише «Оновити товари»);
 *   • дані постачальника не збігаються з карткою (змінились назва / артикул тощо — їх приймає «Оновити товари», потім ціни).
 *  «Оновлено» змінюється лише в рядках, де змінилась ціна, наявність, кількість або стан синхронізації. Масова зміна наявності понад
 *  поріг (як у синхронізації: більший із 50 товарів і 2 % каталогу) — нічого не пишемо. */
import { mtText } from "./text.mjs";
import { LIVE_COLUMNS, MATCH, planRows, readSheet, changeEntries } from "./sync-plan.mjs";
import { PRESENCE, PRESENCE_COLUMN } from "./supplier-presence.mjs";

export const MAIN_TITLE = "Основний каталог";
const STAMP_COL = LIVE_COLUMNS.indexOf("Оновлено");
export const PRICES_SKIP = Object.freeze({ REMOVED: "REMOVED", GONE: "GONE", MISSING: "MISSING", MISMATCH: "MISMATCH" });

/**
 * values — «Основний каталог» (2D, перший рядок — заголовок); offers — Map ID постачальника → offer (parseSupplierText);
 * removed — Set Offer ID, видалених через Catalog Controls. → { abort?, rows, plan, changed: [індекси], journal, stats }.
 */
export function planPrices({ values, offers, stamp, pricing, removed = new Set(), anomaly = { maxNewlyMissing: 50, maxNewlyMissingRatio: 0.02 } }) {
  const main = readSheet(values, MAIN_TITLE);
  const skipped = { removed: 0, gone: 0, missing: 0, mismatch: {} };
  const plan = planRows(main.rows, offers, stamp, pricing).map((p, i) => {
    const keep = (why) => ({ ...p, next: p.before.slice(), skip: why });
    if (removed.has(p.id)) { skipped.removed++; return keep(PRICES_SKIP.REMOVED); }
    if (mtText(main.rows[i][PRESENCE_COLUMN]).trim() === PRESENCE.GONE) { skipped.gone++; return keep(PRICES_SKIP.GONE); }
    if (p.match === MATCH.MISSING) { skipped.missing++; return keep(PRICES_SKIP.MISSING); }
    if (p.match !== MATCH.OK) { skipped.mismatch[p.match] = (skipped.mismatch[p.match] || 0) + 1; return keep(PRICES_SKIP.MISMATCH); }
    // «Оновлено» — лише разом зі справжньою зміною.
    const real = p.before.some((v, j) => j !== STAMP_COL && mtText(v) !== mtText(p.next[j]));
    return real ? p : { ...p, next: p.before.slice() };
  });
  const changed = plan.map((p, i) => (p.before.some((v, j) => mtText(v) !== mtText(p.next[j])) ? i : -1)).filter((i) => i >= 0);
  const diff = (k) => { const j = LIVE_COLUMNS.indexOf(k); return plan.filter((p) => mtText(p.before[j]) !== mtText(p.next[j])).length; };
  const becameAvailable = plan.filter((p) => p.before[4] !== "+" && p.next[4] === "+").length;
  const becameUnavailable = plan.filter((p) => p.before[4] === "+" && p.next[4] !== "+").length;
  const stats = {
    rows: main.rows.length, changedProducts: changed.length,
    supplierPriceChanged: diff("Ціна постачальника"), salePriceChanged: diff("Ціна кінцева"), availabilityChanged: diff("Наявність"),
    becameAvailable, becameUnavailable, quantityChanged: diff("Кількість постачальника"), skipped,
  };
  const limit = Math.max(anomaly.maxNewlyMissing, Math.ceil(main.rows.length * anomaly.maxNewlyMissingRatio));
  const mass = becameUnavailable > limit ? `«немає в наявності» стало б ${becameUnavailable} товарів (поріг ${limit})` : becameAvailable > limit ? `«в наявності» стало б ${becameAvailable} товарів (поріг ${limit})` : "";
  if (mass) return { abort: { type: "МАСОВА ЗМІНА НАЯВНОСТІ", reason: mass + " — схоже на помилку у фіді постачальника; нічого не записано", affected: String(Math.max(becameAvailable, becameUnavailable)), limit: String(limit) }, stats };
  // Події «Журналу» — як у mtUpdate: лише змінені колонки F:K (без «ПОМИЛКА»: незіставлені рядки ця операція не чіпає).
  const journal = changeEntries(stamp, MAIN_TITLE, changed.map((i) => plan[i]));
  return { header: main.header, rows: main.rows, plan, changed, journal, stats };
}
