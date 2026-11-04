/** Рішення власника 04.11.2026: аркуші попереджень — у стилі «Нових товарів» (темно-синій фон, білий жирний Arial 10, по центру;
 *  зелені — колонки рішення), рядки фіксованої висоти 61 px (багаторядковий HTML не розтягує рядок, повний текст — у рядку
 *  формул). Лише ОФОРМЛЕННЯ: дані й порядок колонок не змінюються (система дописує рядки в порядку WARN_HEADER).
 *  Службові «Ключ» і «Джерело» приховано; «Дія власника» — спадний список (лише дві дії, які розуміє система). */
import { mtText } from "../core/text.mjs";
import { WARN_SHEET, ACTION, SUMMARY_COLUMN } from "./supplier-warnings.mjs";
import { WARN_ARCHIVE_SHEET } from "./warnings-archive.mjs";

// Кольори й шрифт — прочитані з «Нових товарів» (TEST, 04.11).
const NAVY = { red: 0.14117648, green: 0.23137255, blue: 0.3254902 };
const GREEN = { red: 0.28627452, green: 0.4, blue: 0.2901961 };
const WHITE = { red: 1, green: 1, blue: 1 };
const DARK = { red: 0.1, green: 0.1, blue: 0.1 };
const ACTION_BG = { red: 1, green: 0.95, blue: 0.75 };
const GRID = { red: 0.75, green: 0.78, blue: 0.82 };

const WIDTHS = { "Ключ": 40, "Виявлено": 105, "Offer ID": 105, "Артикул": 110, "Назва": 260, "Поле": 150, "Було (постачальник)": 200, "Стало (постачальник)": 200,
  "Наше значення": 170, "Позначка власника": 130, "Дія власника": 230, "Стан дії": 160, [SUMMARY_COLUMN]: 380, "Архівовано": 140 };
// «Ключ» (колонка A) НЕ приховується: з прихованою першою колонкою Google дописує рядки (values.append) зі зсувом на колонку
// (перевірено 04.11 на архіві) — лише вузька. Прихована лише «Джерело» (усередині рядка).
const HIDDEN = ["Джерело"];
const SHOWN = ["Ключ"];
// Як у «Нових товарах»: ідентичність / назва — синім по центру; довгий HTML — синім, обрізаний, зліва (менший шрифт); рішення — зеленим.
const LOOK = {
  "Ключ": { bg: NAVY, fg: NAVY, h: "LEFT", wrap: "CLIP", size: 6 },
  "Виявлено": { bg: NAVY, fg: WHITE, bold: true, h: "LEFT", wrap: "CLIP" },
  "Offer ID": { bg: NAVY, fg: WHITE, bold: true, h: "CENTER" },
  "Артикул": { bg: NAVY, fg: WHITE, bold: true, h: "CENTER" },
  "Назва": { bg: NAVY, fg: WHITE, bold: true, h: "CENTER" },
  "Поле": { bg: NAVY, fg: WHITE, bold: true, h: "CENTER" },
  "Було (постачальник)": { bg: NAVY, fg: WHITE, h: "LEFT", wrap: "CLIP", size: 9 },
  "Стало (постачальник)": { bg: NAVY, fg: WHITE, h: "LEFT", wrap: "CLIP", size: 9 },
  "Наше значення": { bg: NAVY, fg: WHITE, h: "LEFT", wrap: "CLIP", size: 9 },
  "Позначка власника": { bg: GREEN, fg: WHITE, bold: true, h: "CENTER" },
  "Дія власника": { bg: ACTION_BG, fg: DARK, bold: true, h: "CENTER" },
  "Стан дії": { bg: GREEN, fg: WHITE, h: "LEFT", wrap: "CLIP", size: 9 },
  [SUMMARY_COLUMN]: { bg: GREEN, fg: WHITE, bold: true, h: "LEFT" },
  "Архівовано": { bg: GREEN, fg: WHITE, h: "CENTER", wrap: "CLIP" },
};
const HEAD_GREEN = new Set(["Позначка власника", "Дія власника", "Стан дії", SUMMARY_COLUMN, "Архівовано"]);

export function warningsStyle(header, { archive = false } = {}) {
  const h = header.map((x) => mtText(x).trim()), at = (k) => h.indexOf(k);
  const named = h.filter(Boolean).length;
  const spec = { frozenRows: 1, rowHeight: 61, borders: GRID, columns: named, widths: {}, hidden: HIDDEN.map(at).filter((i) => i >= 0), shown: SHOWN.map(at).filter((i) => i >= 0), cells: {} };
  for (const [k, px] of Object.entries(WIDTHS)) if (at(k) >= 0) spec.widths[at(k)] = px;
  for (const [k, look] of Object.entries(LOOK)) {
    const i = at(k);
    if (i < 0) continue;
    // В архіві рішення вже ухвалені — «Дія власника» без жовтого (як решта колонок рішення).
    const body = archive && k === "Дія власника" ? { ...look, bg: GREEN, fg: WHITE } : look;
    spec.cells[i] = { header: { bg: HEAD_GREEN.has(k) ? GREEN : NAVY, fg: WHITE, bold: true, h: "CENTER" }, body };
  }
  if (!archive && at("Дія власника") >= 0) spec.list = { col: at("Дія власника"), values: [ACTION.KEEP, ACTION.ACCEPT] };
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
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", "", "СТРУКТУРА", "", "оформлення аркушів у стилі «Нових товарів»: " + done.join(", ") + " (дані не змінено)", "рішення власника 04.11"]]);
  return { state: "STYLED", sheets: done };
}
