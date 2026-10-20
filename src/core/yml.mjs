/** Генератор YML для Prom — порт mtBuildYml_ (Yml.LIVE-CURRENT.gs) з потоковим виводом.
 *  Ціль паритету: на тих самих рядках/групах/часі результат байт-у-байт збігається з Apps Script
 *  (перевіряє test/parity-apps-script.test.mjs, запускаючи справжній LIVE-код у VM).
 *  Відмінності лише інфраструктурні:
 *   - паспорт набору (count/idsSha/contentSha/groupsSha) передається параметром, а не вшитий у код (MTY);
 *   - ліміт байтів задається для кожного фіду (у LIVE 50 000 000 через транспорт Apps Script);
 *   - XML пишеться потоком у sink, тому 30 тис. товарів не впираються в ліміт довжини рядка V8. */
import crypto from "node:crypto";
import { mtText } from "./text.mjs";
import { DEFAULT_PRICING, mtPrices } from "./pricing.mjs";
import { formatYmlDate } from "./time.mjs";
import { FROZEN_COLUMNS, GROUP_HEADERS, YML_HEADERS, canonicalGroups, contentSha, idsSha, rowSeal, SEAL_COLUMN } from "./seal.mjs";
import { sha256 } from "./text.mjs";

const SECRET_RE = /hash_tag\s*(?:=|&(?:amp|#38);)|products_feed\.xml|Bearer\s+[A-Za-z0-9_-]{12,}/i;

export function xmlText(v) {
  const s = mtText(v);
  // Заборонені символи XML не видаляються мовчки: контент не переписується.
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (!(cp === 9 || cp === 10 || cp === 13 || (cp >= 32 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff))) {
      throw new Error("Заборонений символ XML у перевіреному полі");
    }
  }
  return s;
}
export function xmlEscape(v) {
  return xmlText(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/\r/g, "&#13;");
}
export function xmlAttr(v) {
  return xmlEscape(v).replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}
export function cdata(v) {
  return "<![CDATA[" + xmlText(v).replace(/\]\]>/g, "]]]]><![CDATA[>").replace(/\r/g, "]]>&#13;<![CDATA[") + "]]>";
}
function element(name, value) {
  return "<" + name + ">" + xmlEscape(value) + "</" + name + ">";
}
function jsonArray(value, field, id) {
  let result;
  try { result = JSON.parse(mtText(value)); } catch { throw new Error("Пошкоджений " + field + "; ID " + id); }
  if (!Array.isArray(result)) throw new Error("Не масив " + field + "; ID " + id);
  return result;
}
export function httpUrl(value) {
  const url = mtText(value);
  if (!/^https?:\/\/[^\s<>"']+$/.test(url) || /products_feed|hash_tag|[?&](?:token|key|api_key|access_token)=/i.test(url)) {
    throw new Error("Небезпечна або невалідна адреса у публічному полі");
  }
  return url;
}

/** Порт mtObjects_: обов'язкові унікальні колонки; будь-який порожній рядок — помилка. */
export function objectsFromValues(values, required) {
  if (!values.length) throw new Error("Порожній аркуш");
  const h = values[0].map(mtText);
  for (const k of required) if (h.indexOf(k) < 0 || h.indexOf(k) !== h.lastIndexOf(k)) throw new Error("Немає унікальної колонки " + k);
  return values.slice(1).map((row) => {
    if (!row.some((v) => v !== "" && v != null)) throw new Error("Порожній рядок усередині аркуша");
    return Object.fromEntries(h.map((k, i) => [k, row[i] == null ? "" : row[i]]));
  });
}

/** Перевірки до запису першого байта: свіжість sync, набір ID, печатки, групи. */
function preflight(rows, groups, meta, manifest, config) {
  if (meta.syncState !== "OK") throw new Error("Немає успішного завершеного mtUpdate");
  const success = new Date(meta.lastSuccess).getTime();
  const now = new Date(meta.now).getTime();
  if (!Number.isFinite(success) || !Number.isFinite(now) || now - success > config.maximumSyncAgeHours * 3600000 || success > now + 60000) {
    throw new Error("Оновлення цін застаріле або дата невалідна");
  }
  if (rows.length !== manifest.count) throw new Error("Потрібні рівно " + manifest.count + " товарів; отримано " + rows.length);
  const ids = rows.map((r) => mtText(r["Offer ID"]));
  const seen = new Set();
  for (const id of ids) {
    if (!/^\d+$/.test(id) || seen.has(id)) throw new Error("Невалідний або повторений Offer ID");
    seen.add(id);
  }
  if (idsSha(ids) !== manifest.idsSha) throw new Error("Набір дозволених ID змінився: публікацію зупинено");
  const sealed = rows.map((r) => {
    const seal = rowSeal(r);
    if (seal !== mtText(r[SEAL_COLUMN])) throw new Error("Контент/identity змінено після QA; ID " + r["Offer ID"]);
    return r["Offer ID"] + "\t" + seal;
  });
  if (contentSha(sealed) !== manifest.contentSha) throw new Error("Контрольні хеші погодженого контенту не збігаються");
  const canonical = canonicalGroups(groups);
  if (sha256(JSON.stringify(canonical)) !== manifest.groupsSha) throw new Error("Групи змінилися після QA");
  const groupMap = Object.create(null);
  const categories = canonical.map((g) => {
    if (!/^\d+$/.test(g[0]) || groupMap[g[0]]) throw new Error("Невалідний або повторений ID групи");
    groupMap[g[0]] = g;
    return '<category id="' + xmlEscape(g[0]) + '"' + (g[3] ? ' parentId="' + xmlEscape(g[3]) + '"' : "") + ' name_ua="' + xmlAttr(g[1]) + '">' + xmlEscape(g[2]) + "</category>";
  });
  for (const g of canonical) {
    if (g[3] && !groupMap[g[3]]) throw new Error("Немає батьківської групи");
    const chain = Object.create(null);
    let id = g[0];
    while (id) {
      if (chain[id]) throw new Error("Цикл груп");
      chain[id] = true;
      id = groupMap[id][3];
    }
  }
  return { success, now, groupMap, categories };
}

/** Серіалізація одного товару — порядок і умови тегів як у mtBuildYml_. */
export function offerXml(r, success, groupMap, pricing = DEFAULT_PRICING) {
  const id = mtText(r["Offer ID"]);
  if (r["Статус імпорту"] !== "ДОЗВОЛЕНО" || r["Стан синхронізації"] !== "ЗІСТАВЛЕНО") throw new Error("Непідтверджений статус; ID " + id);
  if (new Date(r["Оновлено"]).getTime() !== success) throw new Error("Рядок не належить останньому успішному оновленню; ID " + id);
  if (r["Валюта"] !== "UAH" || ["+", "-"].indexOf(r["Наявність"]) < 0) throw new Error("Невизначена валюта/наявність; ID " + id);
  const available = r["Наявність"] === "+";
  const price = Number(r["Ціна постачальника"]);
  const expected = mtPrices(price, available, pricing);
  const discountOk = mtText(r["Знижка"]) === expected.discount
    || (expected.discount === pricing.discount + "%" && typeof r["Знижка"] === "number" && Math.abs(r["Знижка"] - pricing.discount / 100) < 1e-9);
  if (mtText(r["Ціна"]).trim() === "" || mtText(r["Ціна кінцева"]).trim() === "" || Number(r["Ціна"]) !== expected.base
    || Number(r["Ціна кінцева"]) !== expected.final || !discountOk || expected.base > 9999999999) {
    throw new Error("Ціни/знижка не відповідають погодженій формулі; ID " + id);
  }
  for (const k of ["Назва UA", "Назва RU", "Опис UA", "Опис RU"]) if (!mtText(r[k]).trim()) throw new Error("Порожнє " + k + "; ID " + id);
  if (!groupMap[mtText(r["Група ID"])] || !/^\d+$/.test(mtText(r["Категорія Prom ID"]))) throw new Error("Не визначена група/категорія; ID " + id);
  const photos = jsonArray(r["Фото JSON"], "Фото JSON", id);
  const params = jsonArray(r["Характеристики JSON"], "Характеристики JSON", id);
  if (!photos.length || photos.length > 10 || params.length > 100) throw new Error("Кількість фото/характеристик не підтримується Prom; ID " + id);
  const body = [
    '<offer id="' + id + '" available="' + available + '" selling_type="r">',
    element("name", r["Назва RU"]),
    element("name_ua", r["Назва UA"]),
    element("price", (available ? expected.final : expected.base).toFixed(2)),
  ];
  if (available) body.push(element("oldprice", expected.base.toFixed(2)));
  body.push("<currencyId>UAH</currencyId>", element("categoryId", r["Група ID"]), element("portal_category_id", r["Категорія Prom ID"]));
  if (r["Категорія Prom URL"]) body.push(element("portal_category_url", httpUrl(r["Категорія Prom URL"])));
  for (const url of photos) {
    if (typeof url !== "string") throw new Error("Невалідне фото; ID " + id);
    body.push(element("picture", httpUrl(url)));
  }
  // Збережений «Код товару Prom» — не артикул постачальника й не внутрішній ID Prom.
  for (const [tag, column] of [["vendorCode", "Код товару Prom"], ["vendor", "Виробник"], ["country", "Країна"], ["gtin", "GTIN"], ["keywords", "Запити RU"], ["keywords_ua", "Запити UA"]]) {
    if (r[column]) body.push(element(tag, r[column]));
  }
  if (mtText(r["Запити UA"]).length > 1024 || mtText(r["Запити RU"]).length > 1024) throw new Error("Запити довші за ліміт Prom; ID " + id);
  // type=vendor.model не задається, щоб Prom не склеював іншу назву.
  if (r["Модель"]) body.push(element("model", r["Модель"]));
  const qty = r["Кількість постачальника"];
  if (qty !== "") {
    if (!/^\d+(?:\.\d+)?$/.test(mtText(qty)) || !Number.isFinite(Number(qty))) throw new Error("Невалідна кількість; ID " + id);
    body.push(element("quantity_in_stock", qty));
  }
  body.push("<description>" + cdata(r["Опис RU"]) + "</description>", "<description_ua>" + cdata(r["Опис UA"]) + "</description_ua>");
  for (const param of params) {
    if (!param || typeof param.name !== "string" || !param.name.trim() || typeof param.value !== "string" || typeof param.unit !== "string") {
      throw new Error("Невалідна характеристика; ID " + id);
    }
    body.push('<param name="' + xmlAttr(param.name) + '"' + (param.unit ? ' unit="' + xmlAttr(param.unit) + '"' : "") + ">" + xmlEscape(param.value) + "</param>");
  }
  body.push("</offer>");
  return body.join("");
}

function headerXml(dateText, config, categories) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="' + dateText + '"><shop><name>' + config.shopName + "</name><company>" + config.company
    + '</company><currencies><currency id="UAH" rate="1"/></currencies><categories>' + categories.join("") + "</categories><offers>";
}
const FOOTER = "</offers></shop></yml_catalog>";

/**
 * Формує YML потоком у sink ({ write(text): void|Promise }).
 * rows/groups — об'єкти (див. objectsFromValues). manifest — паспорт погодженого набору.
 * Повертає метадані, сумісні з маніфестом публікатора LIVE (sha256, bytes, sourceDigest, ...).
 */
export async function buildYml({ rows, groups, meta, manifest, config, pricing = DEFAULT_PRICING, maximumBytes, sink }) {
  const { success, now, groupMap, categories } = preflight(rows, groups, meta, manifest, config);
  const full = crypto.createHash("sha256");
  const digest = crypto.createHash("sha256");
  let bytes = 0;
  const emit = async (text, digestText = text) => {
    if (SECRET_RE.test(text)) throw new Error("Секрет або службова адреса у вихідному YML");
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maximumBytes) throw new Error("YML перевищує встановлений ліміт байтів фіду; публікацію зупинено");
    full.update(text, "utf8");
    digest.update(digestText, "utf8");
    await sink.write(text);
  };
  await emit(headerXml(formatYmlDate(now, config.timeZone), config, categories), headerXml("", config, categories));
  for (const r of rows) await emit("\n" + offerXml(r, success, groupMap, pricing));
  await emit("\n" + FOOTER);
  return {
    count: rows.length,
    bytes,
    sha256: full.digest("hex"),
    sourceDigest: digest.digest("hex"),
    sourceSuccess: meta.lastSuccess,
    generatedAt: new Date(meta.now).toISOString(),
    idsSha: manifest.idsSha,
    contentSha: manifest.contentSha,
  };
}

/** Sink у пам'ять — для тестів і паритету. */
export function memorySink() {
  const parts = [];
  return { write(text) { parts.push(text); }, text() { return parts.join(""); } };
}

export { YML_HEADERS, GROUP_HEADERS, FROZEN_COLUMNS };
