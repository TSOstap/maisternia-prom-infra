/** Рішення власника 11.11.2026: кольори рядків аркуша «Нові товари» (лише умовне форматування; дані не змінюються).
 *   • сірий — «Рішення» = «ВІДХИЛЕНО» (власник позначив дубль / не беремо): рядок одразу видно як опрацьований;
 *   • жовтий — у «Перевірці» щось є (можливий дубль, схожі позиції, «НЕ ПЕРЕНЕСЕНО: …») і рядок не відхилено.
 *  Колонки шукаються за заголовками; формули — з літерами колонок на момент запуску (Google сам зсуває їх при вставці колонок).
 *  Маркери в кінці формул (рядок <> "") потрібні, щоб повторний запуск замінив саме ці правила, а не додав копії. */
import { mtText } from "../core/text.mjs";
import { colLetter, HIGHLIGHT_RGB } from "./row-highlight.mjs";

const QUEUE = "Нові товари";
export const REJECTED_RGB = Object.freeze({ red: 0.85, green: 0.85, blue: 0.85 });
export const GREY_MARKER = "mm-queue-grey";
export const YELLOW_MARKER = "mm-queue-yellow";

/** Формули для рядка 2 (Google застосовує їх відносно до кожного рядка діапазону). */
export function queueFormulas(queueHeader) {
  const h = queueHeader.map((x) => mtText(x).trim());
  const dec = h.indexOf("Рішення"), chk = h.indexOf("Перевірка");
  if (dec < 0 || chk < 0) throw new Error("немає колонок «Рішення» / «Перевірка» в «Нових товарах»");
  const rejected = `UPPER(TRIM($${colLetter(dec)}2))="ВІДХИЛЕНО"`;
  return {
    grey: `=AND(${rejected},"${GREY_MARKER}"<>"")`,
    yellow: `=AND(LEN(TRIM($${colLetter(chk)}2))>0,NOT(${rejected}),"${YELLOW_MARKER}"<>"")`,
  };
}

export async function addQueueHighlight({ sheets, readBook, stamp }) {
  const book = await readBook([QUEUE]);
  if (!book[QUEUE]?.[0]) return { state: "BLOCKED", reason: "немає аркуша «Нові товари»" };
  const f = queueFormulas(book[QUEUE][0]);
  // Правило додається на початок списку: спершу жовте, потім сіре — сіре буде першим (вищий пріоритет).
  const y = await sheets.addRowHighlight(QUEUE, f.yellow, HIGHLIGHT_RGB, { replaceMarker: YELLOW_MARKER });
  const g = await sheets.addRowHighlight(QUEUE, f.grey, REJECTED_RGB, { replaceMarker: GREY_MARKER });
  if (y.already && g.already) return { state: "NOTHING", reason: "правила вже є", formulas: f };
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", "", "СТРУКТУРА", "", "«Нові товари»: сірі рядки «ВІДХИЛЕНО», жовті — з позначкою в «Перевірці» (умовне форматування)", "рішення власника 11.11"]]);
  return { state: "HIGHLIGHT_ADDED", formulas: f, replaced: (y.replaced || 0) + (g.replaced || 0) };
}
