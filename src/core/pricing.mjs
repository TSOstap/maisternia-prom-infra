/** Ціноутворення — точний порт mtPrices/mtMoney/mtSameDiscount_ з Code.LIVE-CURRENT.gs.
 *  Final = round2(ціна постачальника + extra); Base = round2(round(Final × (1 + markup) / rounding) × rounding).
 *  Знижка «20%» і наявність «+» — лише для available=true. */
import { mtText } from "./text.mjs";
import { prosaleFinal } from "./prosale.mjs";

export const DEFAULT_PRICING = Object.freeze({ extra: 5, markup: 0.25, discount: 20, rounding: 0.01 });

export function mtMoney(v) {
  return Math.round(v * 100) / 100;
}

/** Рішення власника 06.11.2026: «Ціна власника» — ціна ПОСТАЧАЛЬНИКА, яку власник знає раніше за фід (постачальник написав).
 *  Заповнена (додатне число) — замість ціни з фіду: +5, націнка тарифу ProSale, знижка — як завжди; порожня — ціна з фіду.
 *  Невалідна (не число, ≤ 0) — ігнорується (ціна з фіду). «Ціна постачальника» лишається з фіду (для звірки). */
export const OWNER_PRICE_COLUMN = "Ціна власника";
export function ownerCost(row) {
  const t = mtText(row?.[OWNER_PRICE_COLUMN]).replace(/[\s ₴]|грн\.?/gi, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Рішення власника 14.11.2026 (ціни за конкурентами): ручна ціна й надбавка окремого товару. Пише їх лише owner-edits.
 *  • «Ціна вручну» — кінцева ціна товару. Діє, ЛИШЕ поки ціна постачальника (або «Ціна власника», якщо заповнена) дорівнює
 *    «Ціна вручну: при ціні постачальника» — ціні, за якої ручну ціну встановили. Ціна постачальника змінилась — ручна ціна
 *    сама перестає діяти (стандартна формула «+5»); клітинки система не очищає, тож якщо постачальник поверне ту саму ціну,
 *    ручна ціна знову діятиме (застарілі правила знімає owner-edits після перевірки конкурентів). Межі: не нижче за ціну постачальника − 1
 *    і не вище за 1,5 × стандартної ціни — інакше не діє (захист від помилки в клітинці).
 *  • «Надбавка» — замість +5 до ціни постачальника, лише від −1 до +5 («−1» — на 1 грн дешевше за ціну постачальника; рухається
 *    разом із нею). Ручна ціна, коли діє, має перевагу.
 *  Невалідне значення або значення поза межами не діє — стандартна формула, пояснення в rule.note. Націнка ProSale і знижка — як завжди. */
export const MANUAL_PRICE_COLUMN = "Ціна вручну";
export const MANUAL_ANCHOR_COLUMN = "Ціна вручну: при ціні постачальника";
export const EXTRA_COLUMN = "Надбавка";
export const PRICE_RULE_COLUMNS = Object.freeze([MANUAL_PRICE_COLUMN, MANUAL_ANCHOR_COLUMN, EXTRA_COLUMN]);
export const MANUAL_MAX_RATIO = 1.5;
export const MANUAL_MIN_BELOW_COST = 1;
export const EXTRA_MIN = -1;

/** Число з клітинки: порожньо → null; не число → NaN. «1 234,50», «−1», «5 грн» — числа. */
export function cellNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const t = mtText(v).replace(/[\s ₴]|грн\.?/gi, "").replace(/[−–]/g, "-").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Правило ціни рядка → { kind: "standard" | "manual" | "extra", final0 (до ProSale), notes: [] }. cost — ціна постачальника
 *  (з «Ціною власника», якщо заповнена), від якої рахується ціна. */
export function priceRule(row, cost, pricing = DEFAULT_PRICING) {
  const standard = mtMoney(cost + pricing.extra);
  const notes = [];
  const manual = cellNumber(row?.[MANUAL_PRICE_COLUMN]);
  if (manual !== null) {
    const anchor = cellNumber(row?.[MANUAL_ANCHOR_COLUMN]);
    if (Number.isNaN(manual) || !(manual > 0)) notes.push("«Ціна вручну» — не число, не діє");
    else if (anchor === null || Number.isNaN(anchor) || !(anchor > 0)) notes.push("немає «Ціна вручну: при ціні постачальника» — ручна ціна не діє");
    else if (Math.abs(anchor - cost) > 0.005) notes.push(`ціна постачальника змінилась (${anchor} → ${cost}) — ручна ціна не діє`);
    else if (manual < cost - MANUAL_MIN_BELOW_COST - 1e-9) notes.push("ручна ціна нижча за ціну постачальника − 1 — не діє");
    else if (manual > standard * MANUAL_MAX_RATIO + 1e-9) notes.push("ручна ціна вища за 1,5 × стандартної — не діє");
    else return { kind: "manual", final0: mtMoney(manual), notes };
  }
  const extra = cellNumber(row?.[EXTRA_COLUMN]);
  if (extra !== null) {
    if (Number.isNaN(extra) || extra < EXTRA_MIN || extra > pricing.extra) notes.push(`«Надбавка» має бути від ${EXTRA_MIN} до ${pricing.extra} — не діє`);
    else if (cost + extra > 0) return { kind: "extra", final0: mtMoney(cost + extra), notes };
    else notes.push("ціна з «Надбавкою» не додатна — не діє");
  }
  return { kind: "standard", final0: standard, notes };
}

function fromFinal0(final0, available, pricing, prosale) {
  const final = prosale ? prosaleFinal(final0, prosale) : final0;
  return {
    final,
    base: mtMoney(Math.round((final * (1 + pricing.markup)) / pricing.rounding) * pricing.rounding),
    discount: available ? pricing.discount + "%" : "",
    availability: available ? "+" : "-",
  };
}

/** prosale — { k, rate } тарифу ProSale рядка (src/core/prosale.mjs prosaleFor) або null: тоді формула точно як раніше. */
export function mtPrices(price, available, pricing = DEFAULT_PRICING, prosale = null) {
  if (!Number.isFinite(price) || price <= 0 || typeof available !== "boolean") throw new Error("Невалідні ціна або наявність");
  return fromFinal0(mtMoney(price + pricing.extra), available, pricing, prosale);
}

/** Ціни рядка з урахуванням «Ціна вручну» / «Надбавка» (рішення власника 14.11). Без цих клітинок — точно mtPrices. → { …, rule } */
export function rowPrices(row, price, available, pricing = DEFAULT_PRICING, prosale = null) {
  if (!Number.isFinite(price) || price <= 0 || typeof available !== "boolean") throw new Error("Невалідні ціна або наявність");
  const rule = priceRule(row, price, pricing);
  return { ...fromFinal0(rule.final0, available, pricing, prosale), rule };
}

/** «20%» ≡ 0.2 (допуск 1e-9); '' — без знижки. Інші подання не еквівалентні. */
export function mtSameDiscount(a, b) {
  const value = (v) => {
    if (v === "" || v == null) return "";
    if (typeof v === "number") return v;
    const m = /^(\d+(?:\.\d+)?)%$/.exec(mtText(v));
    return m ? Number(m[1]) / 100 : NaN;
  };
  const x = value(a);
  const y = value(b);
  if (x === "" || y === "") return x === y;
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-9;
}
