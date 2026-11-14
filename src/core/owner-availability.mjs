/** Рішення власника 14.11.2026: «Наявність власника» (колонка в кінці «Основного каталогу»). Власник знає про наявність раніше за фід
 *  постачальника (постачальник написав / сказав): «−» — товару вже немає, хоча у фіді ще є; «+» — товар уже є, хоча у фіді ще немає.
 *  Значення власника діє, ПОКИ постачальник не змінить свою наявність; далі — знову наявність постачальника.
 *  Наявність двозначна, тож «постачальник змінив наявність» = у фіді стала та сама наявність, що в клітинці власника. Тоді клітинку
 *  треба очистити (clear) — інакше при наступній зміні у постачальника (напр. товар повернувся) стара позначка власника знову сховала б
 *  товар. Очищує лише «Оновити ціни й наявність» (src/core/prices-only.mjs → src/pipeline/prices-run.mjs, за ключем з очікуваним
 *  значенням); інші режими лише рахують ту саму ефективну наявність (planRows). Нерозпізнаний текст у клітинці — не діє і не очищується.
 *  Модуль чистий (без I/O). */
import { mtText } from "./text.mjs";

export const OWNER_AVAILABILITY_COLUMN = "Наявність власника";

const YES = new Set(["+", "так", "є", "в наявності", "у наявності", "є в наявності"]);
const NO = new Set(["-", "−", "–", "—", "ні", "немає", "нема", "немає в наявності", "нема в наявності"]);

/** true / false — значення власника; null — клітинка порожня; undefined — текст не розпізнано (не діє). */
export function ownerAvailabilityValue(row) {
  const t = mtText(row?.[OWNER_AVAILABILITY_COLUMN]).trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  if (YES.has(t)) return true;
  if (NO.has(t)) return false;
  return undefined;
}

/** Ефективна наявність рядка за наявністю постачальника (boolean).
 *  → { available, rule: "none" | "invalid" | "owner" | "caught-up", clear } */
export function effectiveAvailability(row, supplierAvailable) {
  const own = ownerAvailabilityValue(row);
  if (own === null) return { available: supplierAvailable, rule: "none", clear: false };
  if (own === undefined) return { available: supplierAvailable, rule: "invalid", clear: false };
  if (own === supplierAvailable) return { available: supplierAvailable, rule: "caught-up", clear: true };
  return { available: own, rule: "owner", clear: false };
}
