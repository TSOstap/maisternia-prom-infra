/** ProSale: націнка, що перекриває додаткову комісію Prom на дорожчому тарифі (рішення власника 04.11.2026).
 *
 *  Правила Prom (офіційна довідка + звірка з реальним списанням 03.11, замовлення 437761344):
 *   • комісія за замовлення = ставка × ціна до 10 000 грн + знижена ставка × частина ціни понад 10 000 грн;
 *   • кабінет показує ставки тарифу «Економ» (= ½ єдиної ставки категорії), над 10 000 грн — 1 %;
 *   • «Звичайний» = ×2, «Більше продажів» = ×2,5, «Турбо» = ×3 до «Економу» (і для частини понад 10 000 грн: 2 / 2,5 / 3 %).
 *     «Турбо» має ще плату за кліки в рекламних блоках — розмір Prom не публікує, тут не враховано.
 *  Мета: після комісії продавцю лишається стільки ж, скільки на «Економі»: P1 − C_t(P1) = P0 − C_економ(P0).
 *  Категорії з комісією «за перехід» — без націнки (плата не залежить від ціни). Порожній / невідомий тариф — без націнки. */
import RATES from "../../config/prosale-rates.json" with { type: "json" };
import { mtText } from "./text.mjs";

export const PROSALE_TARIFF_COLUMN = "Тариф ProSale";
export const PROSALE_MARKUP_COLUMN = "Націнка ProSale %";
export const TARIFFS = Object.freeze({ "економ": 1, "звичайний": 2, "більше продажів": 2.5, "турбо": 3 });
const THRESHOLD = 10000;
const ABOVE_ECON = 0.01;

/** Комісія Prom за замовлення (грн) при ціні P, ставці «Економ» rate (%) і множнику тарифу k. */
export function prosaleCommission(P, rate, k = 1) {
  return k * ((rate / 100) * Math.min(P, THRESHOLD) + ABOVE_ECON * Math.max(0, P - THRESHOLD));
}

/** Аркуш «Тарифи ProSale» (рішення власника 04.11: тариф — на всю категорію Prom, як кампанія в Prom): Категорія Prom ID → Тариф. */
export const PROSALE_SHEET = "Тарифи ProSale";
export const PROSALE_SHEET_HEADER = Object.freeze(["Категорія Prom ID", "Категорія Prom", "Комісія", "Ставка Економ", "Товарів", "Тариф", "Націнка Звичайний %", "Націнка Більше продажів %", "Націнка Турбо %"]);
/** pricing + тарифи категорій з аркуша (values — 2D значення аркуша або null/undefined → без змін). */
export function withProsale(pricing, values) {
  if (!Array.isArray(values) || values.length < 2) return pricing;
  const h = values[0].map((x) => mtText(x).trim()), ci = h.indexOf("Категорія Prom ID"), ti = h.indexOf("Тариф");
  if (ci < 0 || ti < 0) return pricing;
  const categories = {};
  for (const r of values.slice(1)) { const id = mtText(r[ci]).trim(), t = mtText(r[ti]).trim(); if (id && t && TARIFFS[t.toLowerCase()] > 1) categories[id] = t; }
  return { ...pricing, prosaleCategories: categories };
}

/** Тариф і ставка рядка → { k, rate } або null (без націнки). Тариф товару (колонка каталогу) має перевагу над тарифом категорії. */
export function prosaleFor(row, pricing = null, rates = RATES) {
  const own = mtText(row?.[PROSALE_TARIFF_COLUMN]).trim();
  const t = (own || mtText(pricing?.prosaleCategories?.[mtText(row?.["Категорія Prom ID"]).trim()])).trim().toLowerCase();
  const k = TARIFFS[t];
  if (!k || k === 1) return null;
  const c = rates?.categories?.[mtText(row?.["Категорія Prom ID"]).trim()];
  if (!c || !Number.isFinite(c.order)) return null;
  return { k, rate: c.order };
}

/** Ціна на тарифі з тим самим залишком після комісії, що й ціна final0 на «Економі»; копійки — вгору. */
export function prosaleFinal(final0, { k, rate }) {
  const net = final0 - prosaleCommission(final0, rate, 1);
  const kept = (P) => P - prosaleCommission(P, rate, k);
  let lo = final0, hi = final0 * 2;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (kept(m) < net) lo = m; else hi = m; }
  let p = Math.ceil(hi * 100 - 1e-6) / 100;
  while (kept(p) + 1e-9 < net) p = Math.round(p * 100 + 1) / 100;
  return p;
}

/** Націнка у % до ціни «Економ» (для показу), 2 знаки. */
export const prosaleMarkupPct = (final0, final1) => Math.round((final1 / final0 - 1) * 10000) / 100;
