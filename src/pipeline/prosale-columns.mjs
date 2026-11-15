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

/** Рядок аркуша для категорії id з n товарами (порядок колонок — PROSALE_SHEET_HEADER). */
export function prosaleSheetRow(id, n, rates = RATES) {
  const c = rates.categories?.[id];
  if (c && Number.isFinite(c.order)) return [id, c.name, "за замовлення", `${c.order}%`, n, "", `${markupPct(c.order, TARIFFS["звичайний"])}%`, `${markupPct(c.order, TARIFFS["більше продажів"])}%`, `${markupPct(c.order, TARIFFS["турбо"])}%`];
  if (c && Number.isFinite(c.click)) return [id, c.name, `за перехід ${c.click} грн`, "", n, "", "—", "—", "—"];
  return [id, c?.name || "", "ставка невідома", "", n, "", "—", "—", "—"];
}

export function prosaleSheetRows(mainValues, rates = RATES) {
  const h = mainValues[0].map((x) => mtText(x)), ci = h.indexOf("Категорія Prom ID");
  const count = new Map();
  for (const r of mainValues.slice(1)) { const id = mtText(r[ci]).trim(); if (id) count.set(id, (count.get(id) || 0) + 1); }
  return [...count].sort((a, b) => b[1] - a[1]).map(([id, n]) => prosaleSheetRow(id, n, rates));
}

/** Рішення власника 04.11 (пізніше): на аркуші лишаються лише категорії «за замовлення» (оплату за перехід власник не вмикає);
 *  set — { "Категорія Prom ID": "Турбо" | "" } для колонки «Тариф». Решта значень рядків — як були.
 *  Рішення власника 15.11: add — { "Категорія Prom ID": товарів } — категорії каталогу, яких ще немає на аркуші (з'явились після 04.11),
 *  дописуються в кінець рядком довідника ставок (лише «за замовлення»; інші — у missing).
 *  → { values (новий вміст без заголовка), removed (ID), changed ([{id, from, to}]), added (ID), missing (ID із set / add, яких немає серед «за замовлення») }. */
export function prosaleTariffPlan(sheetValues, { set = {}, orderOnly = true, add = {}, rates = RATES } = {}) {
  const h = sheetValues[0].map((x) => mtText(x).trim());
  const ci = h.indexOf("Категорія Prom ID"), ki = h.indexOf("Комісія"), ti = h.indexOf("Тариф");
  if (ci < 0 || ki < 0 || ti < 0) throw new Error("аркуш «" + PROSALE_SHEET + "»: немає колонок «Категорія Prom ID» / «Комісія» / «Тариф»");
  for (const t of Object.values(set)) if (t !== "" && !(TARIFFS[String(t).toLowerCase()] > 0)) throw new Error("невідомий тариф: " + t);
  const values = [], removed = [], changed = [], seen = new Set();
  for (const r of sheetValues.slice(1)) {
    const id = mtText(r[ci]).trim();
    if (!id && r.every((x) => mtText(x).trim() === "")) continue;
    if (orderOnly && mtText(r[ki]).trim() !== "за замовлення") { removed.push(id); continue; }
    const row = h.map((_, i) => r[i] ?? "");
    if (Object.prototype.hasOwnProperty.call(set, id)) {
      seen.add(id);
      const from = mtText(row[ti]).trim(), to = set[id];
      if (from !== to) { row[ti] = to; changed.push({ id, from, to }); }
    }
    values.push(row);
  }
  const onSheet = new Set(values.map((r) => mtText(r[ci]).trim()).concat(removed));
  const added = [], unaddable = [];
  for (const [id, n] of Object.entries(add)) {
    if (onSheet.has(id)) continue;
    const base = prosaleSheetRow(id, Number(n) || 0, rates);
    if (base[2] !== "за замовлення") { unaddable.push(id); continue; }
    const row = h.map((name) => { const i = PROSALE_SHEET_HEADER.indexOf(name); return i < 0 ? "" : base[i]; });
    if (Object.prototype.hasOwnProperty.call(set, id)) { seen.add(id); row[ti] = set[id]; }
    values.push(row); added.push(id); onSheet.add(id);
  }
  return { values, removed, changed, added, missing: Object.keys(set).filter((id) => !seen.has(id)).concat(unaddable) };
}

export async function applyProsaleTariffs({ sheets, readBook, stamp, set = {}, orderOnly = true, add = {} }) {
  const book = await readBook([PROSALE_SHEET]);
  const before = book[PROSALE_SHEET];
  if (!before?.length) return { state: "BLOCKED", reason: "немає аркуша «" + PROSALE_SHEET + "»" };
  const plan = prosaleTariffPlan(before, { set, orderOnly, add });
  if (plan.missing.length) return { state: "BLOCKED", reason: "категорій немає серед «за замовлення»: " + plan.missing.join(", ") };
  if (!plan.removed.length && !plan.changed.length && !plan.added.length) return { state: "NOTHING", reason: "аркуш уже такий" };
  const width = before[0].length, oldRows = before.length - 1;
  // Рядки — на тих самих місцях зверху; хвіст, що звільнився, очищається (рядки аркуша не видаляються).
  const body = plan.values.concat(Array.from({ length: Math.max(0, oldRows - plan.values.length) }, () => Array(width).fill("")));
  await sheets.updateRanges([{ title: PROSALE_SHEET, row: 2, col: 1, values: body }]);
  const after = (await readBook([PROSALE_SHEET]))[PROSALE_SHEET];
  const again = prosaleTariffPlan(after, { set, orderOnly, add });
  const ok = !again.removed.length && !again.changed.length && !again.added.length && !again.missing.length && again.values.length === plan.values.length;
  const byTo = {}; for (const c of plan.changed) byTo[c.to || "Економ"] = (byTo[c.to || "Економ"] || 0) + 1;
  const note = [plan.removed.length ? `прибрано ${plan.removed.length} категорій не «за замовлення»` : "",
    plan.added.length ? `додано ${plan.added.length} нових категорій` : "",
    plan.changed.length > 10 ? Object.entries(byTo).map(([t, n]) => `тариф «${t}» — ${n} категорій`).join(", ") : "",
    ...(plan.changed.length > 10 ? [] : plan.changed.map((c) => `${c.id}: тариф «${c.from || "Економ"}» → «${c.to || "Економ"}»`))].filter(Boolean).join("; ");
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", "", "СТРУКТУРА", "", note.slice(0, 1000), "рішення власника 04.11: ProSale — лише «за замовлення»; 15.11: «Звичайний» для всіх (без топ-продавця)"]]);
  return { state: ok ? "PROSALE_TARIFFS_SET" : "INCOMPLETE", kept: plan.values.length, removed: plan.removed.length, added: plan.added.length, changed: plan.changed };
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
