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

/** prosale — { k, rate } тарифу ProSale рядка (src/core/prosale.mjs prosaleFor) або null: тоді формула точно як раніше. */
export function mtPrices(price, available, pricing = DEFAULT_PRICING, prosale = null) {
  if (!Number.isFinite(price) || price <= 0 || typeof available !== "boolean") throw new Error("Невалідні ціна або наявність");
  const final0 = mtMoney(price + pricing.extra);
  const final = prosale ? prosaleFinal(final0, prosale) : final0;
  return {
    final,
    base: mtMoney(Math.round((final * (1 + pricing.markup)) / pricing.rounding) * pricing.rounding),
    discount: available ? pricing.discount + "%" : "",
    availability: available ? "+" : "-",
  };
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
