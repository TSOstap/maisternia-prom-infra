/** Ціноутворення — точний порт mtPrices/mtMoney/mtSameDiscount_ з Code.LIVE-CURRENT.gs.
 *  Final = round2(ціна постачальника + extra); Base = round2(round(Final × (1 + markup) / rounding) × rounding).
 *  Знижка «20%» і наявність «+» — лише для available=true. */
import { mtText } from "./text.mjs";
import { prosaleFinal } from "./prosale.mjs";

export const DEFAULT_PRICING = Object.freeze({ extra: 5, markup: 0.25, discount: 20, rounding: 0.01 });

export function mtMoney(v) {
  return Math.round(v * 100) / 100;
}

/** Рішення власника 16.11.2026 (реєстр № 63; замінює правила 06.11 / 14.11 / 15.11): дві колонки цін власника — ціну в них власник
 *  пише ЯК НОВУ РРЦ (постачальник сказав 2000 — пише 2000), далі все як завжди: +5, націнка ProSale (тариф не «Економ»), × 1,25,
 *  знижка 20 % для наявних. «Ціна постачальника» (РРЦ) лишається з Excel / фіду — для звірки.
 *   • «Ціна власника» — ПОСТІЙНА: діє, навіть коли постачальник змінив РРЦ (тоді — попередження в «Попередження постачальника»).
 *   • «Ціна вручну» — ТИМЧАСОВА: діє, поки РРЦ та сама, що була, коли її вписали («Ціна вручну: при ціні постачальника» — якір; порожній
 *     — «Ціни» записують поточну РРЦ). РРЦ змінилась — «Ціни» очищують обидві клітинки, далі стандартна ціна.
 *   Обидві заповнені — діє «Ціна власника». Ціна нижча за дроп (закупівлю) — не діє (захист від помилки в клітинці). Невалідне — не діє. */
export const OWNER_PRICE_COLUMN = "Ціна власника";
export function ownerCost(row) {
  const t = mtText(row?.[OWNER_PRICE_COLUMN]).replace(/[\s ₴]|грн\.?/gi, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const MANUAL_PRICE_COLUMN = "Ціна вручну";
export const MANUAL_ANCHOR_COLUMN = "Ціна вручну: при ціні постачальника";
// «Надбавку» прибрано (рішення власника 16.11, № 63: «прибрати «Надбавку»»; −1 скасовано ще 14.11).
export const PRICE_RULE_COLUMNS = Object.freeze([MANUAL_PRICE_COLUMN, MANUAL_ANCHOR_COLUMN]);

/** Число з клітинки: порожньо → null; не число → NaN. «1 234,50», «−1», «5 грн» — числа. */
export function cellNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const t = mtText(v).replace(/[\s ₴]|грн\.?/gi, "").replace(/[−–]/g, "-").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Ефективна РРЦ рядка (рішення власника 16.11, № 63) → { cost, kind: "owner" | "manual" | "standard", notes: [], anchor: null | "set" | "stale" }.
 *  rrp — РРЦ постачальника (Excel / фід); drop — дроп (закупівля) з Excel або null. anchor: "set" — «Ціна вручну» діє, якоря ще немає
 *  («Ціни» запишуть якір = rrp); "stale" — РРЦ змінилась відносно якоря («Ціни» очищують «Ціна вручну» і якір). */
export function effectiveCost(row, rrp, drop = null) {
  const notes = [];
  const belowDrop = (v) => Number.isFinite(drop) && drop > 0 && v < drop - 1e-9;
  const own = ownerCost(row);
  if (own != null) {
    if (belowDrop(own)) notes.push(`«Ціна власника» ${own} нижча за дроп ${drop} — не діє`);
    else return { cost: own, kind: "owner", notes, anchor: null };
  }
  const manual = cellNumber(row?.[MANUAL_PRICE_COLUMN]);
  if (manual !== null) {
    const anchor = cellNumber(row?.[MANUAL_ANCHOR_COLUMN]);
    if (Number.isNaN(manual) || !(manual > 0)) notes.push("«Ціна вручну» — не число, не діє");
    else if (anchor !== null && (Number.isNaN(anchor) || Math.abs(anchor - rrp) > 0.005)) return { cost: rrp, kind: "standard", notes: [...notes, `РРЦ змінилась (${anchor} → ${rrp}) — «Ціна вручну» знята`], anchor: "stale" };
    else if (belowDrop(manual)) notes.push(`«Ціна вручну» ${manual} нижча за дроп ${drop} — не діє`);
    else return { cost: manual, kind: "manual", notes, anchor: anchor === null ? "set" : null };
  }
  return { cost: rrp, kind: "standard", notes, anchor: null };
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

/** Ціни рядка з урахуванням «Ціна власника» / «Ціна вручну» (№ 63): ефективна РРЦ + 5, далі ProSale / × 1,25 / знижка. Без цих
 *  клітинок — точно mtPrices(rrp). rrp — РРЦ постачальника; drop — дроп з Excel (захист «нижче дропу») або null. → { …, rule } */
export function rowPrices(row, rrp, available, pricing = DEFAULT_PRICING, prosale = null, drop = null) {
  if (!Number.isFinite(rrp) || rrp <= 0 || typeof available !== "boolean") throw new Error("Невалідні ціна або наявність");
  const rule = effectiveCost(row, rrp, drop);
  return { ...fromFinal0(mtMoney(rule.cost + pricing.extra), available, pricing, prosale), rule };
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
