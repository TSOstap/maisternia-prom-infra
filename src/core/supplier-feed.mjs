/** Фід постачальника: потоковий порт mtParse + mtOperationalUrl + mtValidateFeed (Code.LIVE-CURRENT.gs).
 *  Семантика збережена: дубль/невалідний ID, сутності XML, неповний документ, «зламаний» offer — зупиняють весь запуск.
 *  Відмінність лише технічна: розбір потоковий (не тримає весь XML одним рядком) — потрібно для 10–30 тис. товарів. */
import { mtAttr, mtTag } from "./text.mjs";
import { parseZonedDate } from "./time.mjs";

/** Текст між записами offer (пролог, категорії, хвіст) не може бути більшим — інакше структура хибна. */
const GAP_LIMIT = 8_000_000;
const OFFER_OPEN = /<offer\b/g;

function offerFrom(attrs, body) {
  const p = mtTag(body, "price");
  const a = mtAttr(attrs, "available");
  return {
    id: mtAttr(attrs, "id"),
    sku: mtTag(body, "vendorCode"),
    nameUa: mtTag(body, "name_ua"),
    nameRu: mtTag(body, "name"),
    price: p.trim() ? Number(p) : null,
    available: a === "true" ? true : a === "false" ? false : null,
    currency: mtTag(body, "currencyId"),
    quantity: mtTag(body, "quantity_in_stock"),
    url: mtTag(body, "url"),
    gtin: mtTag(body, "barcode") || mtTag(body, "gtin"),
  };
}

/** Поля offer для «Сторожа новинок» (той самий розбір, що й тут). */
export { offerFrom as offerFields };

/** Позиція `<offer` (не `<offers`) або -1. На самому кінці буфера — «ще невідомо» (-2): чекаємо наступний шматок. */
function findOfferOpen(buffer, final) {
  OFFER_OPEN.lastIndex = 0;
  const m = OFFER_OPEN.exec(buffer);
  if (!m) return -1;
  if (!final && m.index + 6 >= buffer.length) return -2;
  return m.index;
}

/**
 * Потоковий розбір. chunks — async iterable рядків або Buffer (UTF-8).
 * options.maximumChars — захист розміру (у Code.gs: 45 000 000 символів).
 * options.onOffer(offer, rawBody) — необов'язковий колбек (напр., зберегти сирий запис нового товару).
 * Повертає { offers: Map<id, offer>, count, date } — як mtParse, але Map замість об'єкта.
 */
export async function parseSupplierFeed(chunks, options = {}) {
  const maximumChars = options.maximumChars ?? Infinity;
  // Як getContentText('UTF-8') в Apps Script: невалідні байти не зупиняють розбір.
  const decoder = new TextDecoder("utf-8");
  const offers = new Map();
  let buffer = "";
  let headText = null;
  let total = 0;
  let count = 0;

  const drain = (final) => {
    for (;;) {
      const start = findOfferOpen(buffer, final);
      if (start === -2) return;
      if (start === -1) {
        if (buffer.length > GAP_LIMIT) throw new Error(headText === null ? "Неповна структура YML" : "Пошкоджений запис offer");
        return;
      }
      if (headText === null) headText = buffer.slice(0, start);
      const close = buffer.indexOf("</offer>", start);
      if (close < 0) {
        if (final) throw new Error("Пошкоджений запис offer");
        buffer = buffer.slice(start);
        return;
      }
      const block = buffer.slice(start, close);
      const gt = block.indexOf(">");
      if (gt < 0) throw new Error("Пошкоджений запис offer");
      const attrs = block.slice(6, gt);
      const body = block.slice(gt + 1);
      // Еквівалент контролю count у mtParse: вкладений <offer у записі = пошкоджений фід.
      OFFER_OPEN.lastIndex = 0;
      if (OFFER_OPEN.test(body) || attrs.includes("<")) throw new Error("Пошкоджений запис offer");
      const offer = offerFrom(attrs, body);
      // Додаткові поля для зіставлення ідентичності (D1). За замовчуванням вимкнено — форма offer = mtParse.
      if (options.identityFields) { offer.vendor = mtTag(body, "vendor"); offer.model = mtTag(body, "model"); }
      if (!/^\d+$/.test(offer.id) || offers.has(offer.id)) throw new Error("Невалідний або повторений ID у YML");
      offers.set(offer.id, offer);
      count++;
      if (options.onOffer) options.onOffer(offer, body);
      buffer = buffer.slice(close + 8);
    }
  };

  for await (const chunk of chunks) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    total += text.length;
    if (total > maximumChars) throw new Error("Фід перевищує безпечний розмір");
    buffer += text;
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
  if (headText === null) headText = buffer; // жодного offer: увесь документ — «пролог»
  const ending = buffer;

  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE yml_catalog SYSTEM [^>]*>\s*)?<yml_catalog\b/.test(headText) || !/<\/yml_catalog>\s*$/.test(ending)) {
    throw new Error("Неповний YML");
  }
  if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(headText)) throw new Error("Непідтримувані XML-сутності");
  if (!/<shop\b/.test(headText) || !/<offers>/.test(headText) || !/<\/offers>/.test(ending)) throw new Error("Неповна структура YML");
  const date = /<yml_catalog\b([^>]*)>/.exec(headText);
  return { offers, count, date: date ? mtAttr(date[1], "date") : "" };
}

/** Зручна обгортка для рядка (тести, малі фіди). */
export function parseSupplierText(xml, options) {
  return parseSupplierFeed([xml], options);
}

/** Операційна адреса: лише HTTPS market-tools, без описів/фото/характеристик (менший фід для оновлення цін). */
export function operationalUrl(full, supplierConfig) {
  if (!new RegExp(supplierConfig.allowedUrlPattern, "i").test(full)) throw new Error("Потрібна HTTPS-адреса YML Market Tools");
  let url = full;
  const set = (key, value) => {
    const re = new RegExp("([?&])" + key + "=[^&]*");
    url = re.test(url)
      ? url.replace(re, "$1" + key + "=" + encodeURIComponent(value))
      : url + (url.indexOf("?") < 0 ? "?" : "&") + key + "=" + encodeURIComponent(value);
  };
  for (const [k, v] of Object.entries(supplierConfig.operationalParams)) set(k, v);
  return url;
}

/** Повнота/свіжість фіду: мінімум, різке падіння кількості (×0.8 від попереднього), вік дати. */
export function validateFeed(parsed, previousCount, now, supplierConfig) {
  const min = Math.max(supplierConfig.minimumOffers, Number(previousCount || 0) * supplierConfig.dropRatio);
  if (parsed.count < min) throw new Error("Неповний фід: різке зменшення кількості ID");
  const date = parseZonedDate(parsed.date, supplierConfig.timeZone);
  if (!Number.isFinite(date)) throw new Error("Немає дати YML");
  const age = now - date;
  if (age > supplierConfig.maximumAgeHours * 3600000 || age < -supplierConfig.maximumFutureHours * 3600000) {
    throw new Error("Застарілий або майбутній YML");
  }
}
