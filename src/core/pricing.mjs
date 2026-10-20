/** Ціноутворення — точний порт mtPrices/mtMoney/mtSameDiscount_ з Code.LIVE-CURRENT.gs.
 *  Final = round2(ціна постачальника + extra); Base = round2(round(Final × (1 + markup) / rounding) × rounding).
 *  Знижка «20%» і наявність «+» — лише для available=true. */
import { mtText } from "./text.mjs";

export const DEFAULT_PRICING = Object.freeze({ extra: 5, markup: 0.25, discount: 20, rounding: 0.01 });

export function mtMoney(v) {
  return Math.round(v * 100) / 100;
}

export function mtPrices(price, available, pricing = DEFAULT_PRICING) {
  if (!Number.isFinite(price) || price <= 0 || typeof available !== "boolean") throw new Error("Невалідні ціна або наявність");
  const final = mtMoney(price + pricing.extra);
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
