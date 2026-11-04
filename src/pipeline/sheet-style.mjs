/** Рішення власника 04.11.2026: аркуші попереджень мають читатися з першого погляду — лише ОФОРМЛЕННЯ (дані й порядок колонок
 *  не змінюються: система дописує рядки в порядку WARN_HEADER). Довгий HTML («Було» / «Стало» / «Наше значення») — обрізаний у
 *  клітинці (повний текст — у рядку формул), рядки — під вміст «Що змінилось»; службові «Ключ» і «Джерело» приховано;
 *  «Дія власника» — спадний список (лише дві дії, які розуміє система) і підсвічена колонка. Колонки — за заголовками. */
import { mtText } from "../core/text.mjs";
import { WARN_SHEET, ACTION, SUMMARY_COLUMN } from "./supplier-warnings.mjs";
import { WARN_ARCHIVE_SHEET } from "./warnings-archive.mjs";

const WIDTHS = { "Виявлено": 105, "Offer ID": 95, "Артикул": 95, "Назва": 240, "Поле": 150, "Було (постачальник)": 220, "Стало (постачальник)": 220,
  "Наше значення": 180, "Позначка власника": 130, "Дія власника": 220, "Стан дії": 150, [SUMMARY_COLUMN]: 380, "Архівовано": 140 };
const CLIP = ["Ключ", "Виявлено", "Було (постачальник)", "Стало (постачальник)", "Наше значення", "Джерело", "Стан дії"];
const WRAP = ["Назва", "Поле", SUMMARY_COLUMN, "Дія власника", "Позначка власника"];
const HIDDEN = ["Ключ", "Джерело"];
const HEADER_BG = { red: 0.85, green: 0.89, blue: 0.95 };
const ACTION_BG = { red: 1, green: 0.97, blue: 0.85 };
const SUMMARY_BG = { red: 0.93, green: 0.97, blue: 0.93 };

export function warningsStyle(header, { archive = false } = {}) {
  const h = header.map((x) => mtText(x).trim()), at = (k) => h.indexOf(k);
  const pick = (list) => list.map(at).filter((i) => i >= 0);
  const spec = { frozenRows: 1, header: { bg: HEADER_BG }, autoRows: true, widths: {}, wrap: {}, hidden: pick(HIDDEN), columnBg: {} };
  for (const [k, px] of Object.entries(WIDTHS)) if (at(k) >= 0) spec.widths[at(k)] = px;
  for (const i of pick(CLIP)) spec.wrap[i] = "CLIP";
  for (const i of pick(WRAP)) spec.wrap[i] = "WRAP";
  if (at(SUMMARY_COLUMN) >= 0) spec.columnBg[at(SUMMARY_COLUMN)] = SUMMARY_BG;
  // В архіві рішення вже ухвалені — без списку й підсвітки дії.
  if (!archive && at("Дія власника") >= 0) { spec.columnBg[at("Дія власника")] = ACTION_BG; spec.list = { col: at("Дія власника"), values: [ACTION.KEEP, ACTION.ACCEPT] }; }
  return spec;
}

export async function styleWarningSheets({ sheets, readBook, stamp }) {
  const book = await readBook([WARN_SHEET, WARN_ARCHIVE_SHEET]);
  const done = [];
  for (const [title, archive] of [[WARN_SHEET, false], [WARN_ARCHIVE_SHEET, true]]) {
    if (!book[title]?.[0]?.length) continue;
    await sheets.formatColumns(title, warningsStyle(book[title][0], { archive }));
    done.push(title);
  }
  if (!done.length) return { state: "NOTHING", reason: "немає аркушів попереджень" };
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", "", "СТРУКТУРА", "", "оформлення аркушів: " + done.join(", ") + " (дані не змінено)", "рішення власника 04.11"]]);
  return { state: "STYLED", sheets: done };
}
