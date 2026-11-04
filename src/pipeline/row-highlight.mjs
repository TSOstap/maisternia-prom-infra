/** Рішення власника 04.11.2026: рядок «Основного каталогу» жовтий, поки в нього є ВІДКРИТЕ попередження постачальника — рядок на
 *  аркуші «Попередження постачальника» з цим Offer ID, де ще порожні і «Позначка власника», і «Дія власника» (колонку-позначку
 *  в каталозі не беремо: вона буває порожньою за відкритого попередження). Власник заповнив одну з них — рядок знову звичайний
 *  (умовне форматування; дані не змінюються).
 *  Колонки шукаються за заголовками; формула — з літерами колонок на момент запуску (Google сам зсуває їх при вставці колонок). */
import { mtText } from "../core/text.mjs";
import { WARN_SHEET } from "./supplier-warnings.mjs";

const MAIN = "Основний каталог";
export const HIGHLIGHT_RGB = Object.freeze({ red: 1, green: 0.95, blue: 0.6 });

export const colLetter = (i) => { let s = ""; for (let n = i + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** Формула умовного форматування для рядка 2 (Google застосовує її відносно до кожного рядка діапазону). */
export function warningFormula(mainHeader, warnHeader) {
  const m = mainHeader.map((x) => mtText(x).trim()), w = warnHeader.map((x) => mtText(x).trim());
  const id = m.indexOf("Offer ID");
  const wid = w.indexOf("Offer ID"), note = w.indexOf("Позначка власника"), act = w.indexOf("Дія власника");
  if ([id, wid, note, act].some((i) => i < 0)) throw new Error("немає потрібних колонок для підсвітки попереджень");
  const ref = (i) => `INDIRECT("'${WARN_SHEET}'!$${colLetter(i)}:$${colLetter(i)}")`;
  return `=COUNTIFS(${ref(wid)},$${colLetter(id)}2,${ref(note)},"",${ref(act)},"")>0`;
}

export async function addWarningHighlight({ sheets, readBook, stamp }) {
  const book = await readBook([MAIN, WARN_SHEET]);
  if (!book[MAIN]?.[0] || !book[WARN_SHEET]?.[0]) return { state: "BLOCKED", reason: "немає «Основного каталогу» або аркуша попереджень" };
  const formula = warningFormula(book[MAIN][0], book[WARN_SHEET][0]);
  const r = await sheets.addRowHighlight(MAIN, formula, HIGHLIGHT_RGB, { replaceMarker: "'" + WARN_SHEET + "'!" });
  if (r.already) return { state: "NOTHING", reason: "правило вже є", formula };
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", "", "СТРУКТУРА", "", "жовті рядки з відкритим попередженням постачальника (умовне форматування)", "рішення власника 04.11"]]);
  return { state: "HIGHLIGHT_ADDED", formula, replaced: r.replaced || 0 };
}
