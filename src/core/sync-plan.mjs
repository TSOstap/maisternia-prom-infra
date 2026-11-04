/** Зіставлення рядка каталогу з offer постачальника і план операційних колонок F:M.
 *  Точні порти mtMatch / mtPlan / mtHeaders з Code.LIVE-CURRENT.gs. */
import { mtKey, mtSku, mtText } from "./text.mjs";
import { DEFAULT_PRICING, mtPrices, mtSameDiscount } from "./pricing.mjs";
import { prosaleFor } from "./prosale.mjs";

/** Операційні колонки F:M — єдине, що оновлення має право змінювати. Порядок фіксований. */
export const LIVE_COLUMNS = Object.freeze([
  "Ціна постачальника", "Ціна", "Ціна кінцева", "Знижка", "Наявність", "Кількість постачальника", "Стан синхронізації", "Оновлено",
]);

export const MATCH = Object.freeze({
  OK: "ЗІСТАВЛЕНО",
  MISSING: "ВІДСУТНІЙ_У_YML",
  ID_CONFLICT: "КОНФЛІКТ_ID",
  SKU_CONFLICT: "КОНФЛІКТ_АРТИКУЛА",
  IDENTITY_CHANGED: "ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ",
  NO_REFERENCE_NAME: "НЕМАЄ_ОПОРНОЇ_НАЗВИ",
  UNKNOWN_CURRENCY: "НЕВІДОМА_ВАЛЮТА",
  INVALID_PRICE: "НЕВАЛІДНА_ЦІНА",
  UNKNOWN_AVAILABILITY: "НЕВІДОМА_НАЯВНІСТЬ",
  INVALID_QUANTITY: "НЕВАЛІДНА_КІЛЬКІСТЬ",
});

export function matchOffer(row, offer) {
  if (!offer) return MATCH.MISSING;
  if (mtText(row["ID постачальника"]) !== offer.id) return MATCH.ID_CONFLICT;
  const expectedSku = mtSku(row["Артикул постачальника"]);
  const actualSku = mtSku(offer.sku);
  if (expectedSku !== actualSku) return MATCH.SKU_CONFLICT;
  if (!expectedSku && (!row["URL постачальника"] || row["URL постачальника"] !== offer.url || !row["Назва постачальника UA"] || !row["Назва постачальника RU"])) {
    return MATCH.SKU_CONFLICT;
  }
  let checked = 0;
  for (const [column, field] of [["Назва постачальника UA", "nameUa"], ["Назва постачальника RU", "nameRu"]]) {
    if (row[column]) {
      checked++;
      if (!offer[field] || mtKey(row[column]) !== mtKey(offer[field])) return MATCH.IDENTITY_CHANGED;
    }
  }
  if (!checked) return MATCH.NO_REFERENCE_NAME;
  if (offer.currency !== "UAH") return MATCH.UNKNOWN_CURRENCY;
  if (!Number.isFinite(offer.price) || offer.price <= 0) return MATCH.INVALID_PRICE;
  if (typeof offer.available !== "boolean") return MATCH.UNKNOWN_AVAILABILITY;
  if (offer.quantity !== "" && (!/^\d+(?:\.\d+)?$/.test(offer.quantity) || !Number.isFinite(Number(offer.quantity)))) return MATCH.INVALID_QUANTITY;
  return MATCH.OK;
}

/**
 * Чистий план. Помилки зіставлення не замінюють перевірені операційні значення порожнечею.
 * offers — Map<id, offer> (потоковий парсер) або об'єкт.
 */
export function planRows(rows, offers, stamp, pricing = DEFAULT_PRICING) {
  const lookup = offers instanceof Map ? (id) => offers.get(id) : (id) => offers[id];
  const seen = new Set();
  return rows.map((row) => {
    const id = mtText(row["Offer ID"]);
    if (!id || seen.has(id)) throw new Error("Повторений або порожній Offer ID у таблиці");
    seen.add(id);
    const before = LIVE_COLUMNS.map((k) => (row[k] == null ? "" : row[k]));
    const offer = lookup(mtText(row["ID постачальника"]));
    const match = matchOffer(row, offer);
    let next = before.slice();
    if (match === MATCH.OK) {
      const p = mtPrices(offer.price, offer.available, pricing, prosaleFor(row, pricing));
      next = [offer.price, p.base, p.final, p.discount, p.availability, offer.quantity === "" ? before[5] : Number(offer.quantity), match, stamp];
      // Та сама знижка в іншому поданні (0.2 у %-клітинці = «20%») — не зміна.
      if (mtSameDiscount(before[3], next[3])) next[3] = before[3];
    } else if (match === MATCH.MISSING) {
      // Повний здоровий фід доводить відсутність: стару ціну зберігаємо, продаж вимикаємо.
      next[3] = ""; next[4] = "-"; next[5] = ""; next[6] = match; next[7] = stamp;
    } else {
      next[6] = match; next[7] = stamp;
    }
    return { id, before, next, match };
  });
}

/**
 * Аркуш як 2D-масив (перший рядок — заголовки) → об'єкти рядків.
 * Як mtHeaders: обов'язкові унікальні колонки, операційні колонки суміжні й у фіксованому порядку.
 * Додатково (для Sheets API, що обрізає порожні хвости рядків) рядки доповнюються до ширини заголовка.
 */
export function readSheet(values, name) {
  if (!values || !values.length) throw new Error("Порожній аркуш: " + name);
  const header = values[0].map(mtText);
  const required = ["Offer ID", "ID постачальника", "Артикул постачальника", "Назва постачальника UA", "Назва постачальника RU", ...LIVE_COLUMNS];
  for (const k of required) {
    if (header.indexOf(k) < 0 || header.indexOf(k) !== header.lastIndexOf(k)) throw new Error("Немає унікальної колонки: " + k);
  }
  const start = header.indexOf(LIVE_COLUMNS[0]);
  LIVE_COLUMNS.forEach((k, i) => {
    if (header[start + i] !== k) throw new Error("Змінено порядок операційних колонок");
  });
  const raw = values.slice(1).map((r) => header.map((_, i) => (r[i] == null ? "" : r[i])));
  const rows = raw.filter((r) => r.some((v) => v !== "")).map((r) => Object.fromEntries(header.map((k, i) => [k, r[i]])));
  if (rows.length !== raw.length) throw new Error("Порожній рядок усередині каталогу: " + name);
  return { header, start, rows };
}

/** Записи журналу змін — як у mtRun (лише F:K, плюс рядок ПОМИЛКА для незіставлених). */
export function changeEntries(stamp, sheetName, plan) {
  const entries = [];
  for (const r of plan) {
    LIVE_COLUMNS.forEach((k, i) => {
      if (i < 6 && mtText(r.before[i]) !== mtText(r.next[i])) entries.push([stamp, sheetName, r.id, k, r.before[i], r.next[i], r.match]);
    });
    if (r.match !== MATCH.OK) entries.push([stamp, sheetName, r.id, "ПОМИЛКА", "", "", r.match]);
  }
  return entries;
}
