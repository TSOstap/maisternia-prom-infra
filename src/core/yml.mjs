/** Генератор YML для Prom — порт mtBuildYml_ (Yml.LIVE-CURRENT.gs) з потоковим виводом.
 *  Ціль паритету: на тих самих рядках/групах/часі результат байт-у-байт збігається з Apps Script
 *  (перевіряє test/parity-apps-script.test.mjs, запускаючи справжній LIVE-код у VM).
 *  Відмінності лише інфраструктурні:
 *   - паспорт набору (count/idsSha/contentSha/groupsSha) передається параметром, а не вшитий у код (MTY);
 *   - ліміт байтів задається для кожного фіду (у LIVE 50 000 000 через транспорт Apps Script);
 *   - XML пишеться потоком у sink, тому 30 тис. товарів не впираються в ліміт довжини рядка V8. */
import crypto from "node:crypto";
import { mtText } from "./text.mjs";
import { DEFAULT_PRICING, mtPrices, rowPrices } from "./pricing.mjs";
import { prosaleFor } from "./prosale.mjs";
import { formatYmlDate } from "./time.mjs";
import { FROZEN_COLUMNS, GROUP_HEADERS, YML_HEADERS, canonicalGroups, contentSha, idsSha, rowSeal, SEAL_COLUMN } from "./seal.mjs";
import { sha256 } from "./text.mjs";
import { MATCH } from "./sync-plan.mjs";

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
/** ownerPriority (фінальні вимоги власника 29.10): набір ID і печатки — аудит, не заборона (лічильник у звіті); групи й свіжість — як раніше. */
function preflight(rows, groups, meta, manifest, config, { ownerPriority = false } = {}) {
  if (meta.syncState !== "OK") throw new Error("Немає успішного завершеного mtUpdate");
  const success = new Date(meta.lastSuccess).getTime();
  const now = new Date(meta.now).getTime();
  if (!Number.isFinite(success) || !Number.isFinite(now) || now - success > config.maximumSyncAgeHours * 3600000 || success > now + 60000) {
    throw new Error("Оновлення цін застаріле або дата невалідна");
  }
  if (!ownerPriority && rows.length !== manifest.count) throw new Error("Потрібні рівно " + manifest.count + " товарів; отримано " + rows.length);
  const ids = rows.map((r) => mtText(r["Offer ID"]));
  const seen = new Set();
  for (const id of ids) {
    if (!/^\d+$/.test(id) || seen.has(id)) throw new Error("Невалідний або повторений Offer ID"); // ключ фіду — глобально
    seen.add(id);
  }
  const audit = { sealMismatch: 0, idsChanged: false, contentChanged: false };
  if (idsSha(ids) !== manifest.idsSha) { if (!ownerPriority) throw new Error("Набір дозволених ID змінився: публікацію зупинено"); audit.idsChanged = true; }
  const sealed = rows.map((r) => {
    const seal = rowSeal(r);
    if (seal !== mtText(r[SEAL_COLUMN])) { if (!ownerPriority) throw new Error("Контент/identity змінено після QA; ID " + r["Offer ID"]); audit.sealMismatch++; }
    return r["Offer ID"] + "\t" + seal;
  });
  if (contentSha(sealed) !== manifest.contentSha) { if (!ownerPriority) throw new Error("Контрольні хеші погодженого контенту не збігаються"); audit.contentChanged = true; }
  const canonical = canonicalGroups(groups);
  if (sha256(JSON.stringify(canonical)) !== manifest.groupsSha) throw new Error("Групи змінилися після QA");
  const { groupMap, categories } = groupsForYml(groups);
  return { success, now, groupMap, categories, audit };
}

/** Групи фіду: перевірка (числові унікальні ID, батьківська група існує, без циклів) → groupMap і теги <category>. */
export function groupsForYml(groups) {
  const canonical = canonicalGroups(groups);
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
  return { groupMap, categories };
}

/** Серіалізація одного товару — порядок і умови тегів як у mtBuildYml_. */
/** Політика D1 (погоджено власником 21.10.2026): товар, що зник із повного коректного фіду, публікується
 *  як «немає в наявності» (або з підтвердженим власним залишком), а не блокує весь фід.
 *  'block' — чинна поведінка LIVE (для паритету). */
export const MISSING_POLICIES = Object.freeze(["block", "unavailable"]);
/** Політика D1b (погоджено власником 21.10.2026): конфлікт однієї картки ізолює лише її. 'block' — LIVE. */
export const CONFLICT_POLICIES = Object.freeze(["block", "isolate"]);
export const STATUS_MISSING = "ВІДСУТНІЙ_У_YML";
export const STATUS_OWN_STOCK = "ВЛАСНИЙ_ЗАЛИШОК";
export const STATUS_MODEL_CONFLICT = "КОНФЛІКТ_МОДЕЛІ";
const CONFLICTS = new Set([...Object.values(MATCH).filter((s) => s !== MATCH.OK && s !== MATCH.MISSING), STATUS_MODEL_CONFLICT]);
export const isConflictStatus = (status) => CONFLICTS.has(status);
/** Ізольована картка: зникла або конфліктна (не ЗІСТАВЛЕНО і не власний залишок). */
export const isIsolatedStatus = (status) => status === STATUS_MISSING || CONFLICTS.has(status);

function statusAllowed(r, missingPolicy, conflictPolicy) {
  const st = r["Стан синхронізації"];
  if (st === "ЗІСТАВЛЕНО") return true;
  const unavailable = r["Наявність"] === "-";
  if (st === STATUS_MISSING) return missingPolicy === "unavailable" && unavailable;
  if (CONFLICTS.has(st)) return conflictPolicy === "isolate" && unavailable;
  if (st === STATUS_OWN_STOCK) return (missingPolicy === "unavailable" || conflictPolicy === "isolate") && r["Наявність"] === "+";
  return false;
}

/** opts.held (S7): знятий / виключений товар — available="false" незалежно від стану синхронізації, власного залишку й
 *  значень «Наявність» / «Знижка» / «Ціна кінцева» рядка; потрібна лише перевірена «Ціна постачальника». */
/** Ціни рядка за формулою: з націнкою ProSale тарифу рядка, а в перехідний період (тариф змінено, «Ціни» ще не перерахували)
 *  — і без неї; повертає той варіант, якому відповідають колонки рядка (інакше — варіант із націнкою, і перевірка дасть помилку). */
function expectedPrices(r, price, available, pricing) {
  const ps = prosaleFor(r, pricing);
  // Рішення власника 16.11 (№ 63): правило рядка («Ціна власника» / «Ціна вручну» — як нова РРЦ) — основний варіант.
  const dr = Number(String(r["Дроп-ціна"] ?? "").replace(",", ".")), drop = dr > 0 ? dr : null; // «Дроп-ціна» — захист «нижче дропу», як у «Цінах»
  const own = rowPrices(r, price, available, pricing, ps, drop);
  const variants = [own];
  // № 87 (ціни без копійок): перехідний стан — «Ціни» ще не перерахували рядок, чинні ціни з копійками теж погоджені (не ізолюємо товар).
  for (const pr of pricing.whole === true ? [pricing, { ...pricing, whole: false }] : [pricing]) {
    if (pr !== pricing) variants.push(rowPrices(r, price, available, pr, ps, drop));
    if (ps) variants.push(rowPrices(r, price, available, pr, null, drop));
    // Перехідний стан: правило вже записано, а «Ціни» ще не перерахували рядок — чинні стандартні ціни теж погоджені (не ізолюємо товар).
    if (own.rule.kind !== "standard") {
      variants.push(mtPrices(price, available, pr, ps));
      if (ps) variants.push(mtPrices(price, available, pr));
    }
  }
  const same = (e) => Number(r["Ціна"]) === e.base && Number(r["Ціна кінцева"]) === e.final;
  return variants.find(same) || own;
}

/** Брендів немає в довіднику Prom (25.11.2026, звіт імпорту «Неизвестный производитель», 19 товарів): Prom їх не приймає, а на сторінці
 *  стоїть чужий виробник (Dacia, GMP, Yanchuan, Energy). Поле виробника для них не відправляється; у таблиці й назві бренд лишається. */
export const VENDORS_UNKNOWN_TO_PROM = new Set(["Zymmer", "YMASU", "Yasui", "Edbird", "VMF EURO", "СИЧ", "LADDER STANDART", "OnDragon", "Bulltech", "Power Value", "NOVGEN", "Ripper", "DroGO", "Energy Drive", "Gabra", "Super Oil", "MAXXT"]);
/** Характеристика для Prom (рішення власника 25.11.2026, № 116). Звіт імпорту Prom: «Характеристика … с единицей измерения должна быть
 *  числом» — користувацьку характеристику з одиницею й нечисловим значенням (габарити 180×120×200, діапазон 8–12, «До 400») він відкидає
 *  або губить одиницю. Тому число лишається числом з одиницею, а решта — текст разом з одиницею, без unit. Дані в таблиці не змінюються. */
const NUMBER_VALUE = /^-?\d+(?:[.,]\d+)?$/;
export function promParam(value, unit) {
  const v = value.trim(), u = unit.trim();
  if (!u || !v || NUMBER_VALUE.test(v)) return { value, unit };
  // Одиниця вже є в тексті окремим словом — не дублювати.
  const has = new RegExp("(^|[^\\p{L}])" + u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^\\p{L}])", "u").test(v);
  if (has) return { value: v, unit: "" };
  const tail = /^(.*\S)\s*(\([^()]*\p{L}{2}[^()]*\))$/u.exec(v); // «1.6–3.2 (5 шт.)» → «1.6–3.2 мм (5 шт.)»
  const gap = u === "°" ? "" : /\p{L}{2}$/u.test(tail ? tail[1] : v) ? ", " : " "; // «10 вгору, 10 вниз» → «…, м»
  return { value: tail ? tail[1] + gap + u + " " + tail[2] : v + gap + u, unit: "" };
}
export function offerXml(r, success, groupMap, pricing = DEFAULT_PRICING, missingPolicy = "block", conflictPolicy = "block", opts = {}) {
  const id = mtText(r["Offer ID"]);
  const held = opts.held === true;
  if (r["Статус імпорту"] !== "ДОЗВОЛЕНО" || (!held && !statusAllowed(r, missingPolicy, conflictPolicy))) throw new Error("Непідтверджений статус; ID " + id);
  if (!held && new Date(r["Оновлено"]).getTime() !== success) throw new Error("Рядок не належить останньому успішному оновленню; ID " + id);
  if (r["Валюта"] !== "UAH" || (!held && ["+", "-"].indexOf(r["Наявність"]) < 0)) throw new Error("Невизначена валюта/наявність; ID " + id);
  const available = held ? false : r["Наявність"] === "+";
  // № 63: РРЦ постачальника; «Ціна власника» / «Ціна вручну» враховує rowPrices (expectedPrices) — як у «Цінах».
  const price = Number(r["Ціна постачальника"]);
  if (held && !(price > 0)) throw new Error("Знятий товар без перевіреної ціни; ID " + id);
  const expected = expectedPrices(r, price, available, pricing);
  const discountOk = mtText(r["Знижка"]) === expected.discount
    || (expected.discount === pricing.discount + "%" && typeof r["Знижка"] === "number" && Math.abs(r["Знижка"] - pricing.discount / 100) < 1e-9);
  if (!held && (mtText(r["Ціна"]).trim() === "" || mtText(r["Ціна кінцева"]).trim() === "" || Number(r["Ціна"]) !== expected.base
    || Number(r["Ціна кінцева"]) !== expected.final || !discountOk)) {
    throw new Error("Ціни/знижка не відповідають погодженій формулі; ID " + id);
  }
  if (expected.base > 9999999999) throw new Error("Ціни/знижка не відповідають погодженій формулі; ID " + id);
  for (const k of ["Назва UA", "Назва RU", "Опис UA", "Опис RU"]) if (!mtText(r[k]).trim()) throw new Error("Порожнє " + k + "; ID " + id);
  if (!groupMap[mtText(r["Група ID"])] || !/^\d+$/.test(mtText(r["Категорія Prom ID"]))) throw new Error("Не визначена група/категорія; ID " + id);
  const photos = jsonArray(r["Фото JSON"], "Фото JSON", id);
  const params = jsonArray(r["Характеристики JSON"], "Характеристики JSON", id);
  if (!photos.length || photos.length > 10 || params.length > 100) throw new Error("Кількість фото/характеристик не підтримується Prom; ID " + id);
  const body = [
    // ENG-29 (рішення власника 02.11): «Готово до відправки» для товарів у наявності — available="true" in_stock="true" (довідка Prom).
    '<offer id="' + id + '" available="' + available + '"' + (available && opts.inStock === true ? ' in_stock="true"' : "") + ' selling_type="r">',
    element("name", r["Назва RU"]),
    element("name_ua", r["Назва UA"]),
    // 04.11.2026 (інцидент): Prom після імпорту «Оновити примусово» прочитав пару <price> (зі знижкою) + <oldprice> як «Ціна = price»
    // і ще раз застосував знижку (oldprice − price) — покупець бачив −25 %. Тепер <price> = базова ціна, знижка — тегом <discount>
    // (довідка Prom: «Знижка задана в відсотках… застосовується на період у 45 днів»). Покупець платить base × (1 − знижка) = «Ціна кінцева».
    element("price", expected.base.toFixed(2)),
  ];
  if (available) body.push(element("discount", expected.discount));
  body.push("<currencyId>UAH</currencyId>", element("categoryId", r["Група ID"]), element("portal_category_id", r["Категорія Prom ID"]));
  if (r["Категорія Prom URL"]) body.push(element("portal_category_url", httpUrl(r["Категорія Prom URL"])));
  for (const url of photos) {
    if (typeof url !== "string") throw new Error("Невалідне фото; ID " + id);
    body.push(element("picture", httpUrl(url)));
  }
  // Збережений «Код товару Prom» — не артикул постачальника й не внутрішній ID Prom.
  for (const [tag, column] of [["vendorCode", "Код товару Prom"], ["vendor", "Виробник"], ["country", "Країна"], ["gtin", "GTIN"], ["keywords", "Запити RU"], ["keywords_ua", "Запити UA"]]) {
    if (tag === "vendor" && VENDORS_UNKNOWN_TO_PROM.has(mtText(r[column]).trim())) continue;
    if (r[column]) body.push(element(tag, r[column]));
  }
  if (mtText(r["Запити UA"]).length > 1024 || mtText(r["Запити RU"]).length > 1024) throw new Error("Запити довші за ліміт Prom; ID " + id);
  // type=vendor.model не задається, щоб Prom не склеював іншу назву.
  if (r["Модель"]) body.push(element("model", r["Модель"]));
  const qty = held ? "" : r["Кількість постачальника"];
  if (qty !== "") {
    if (!/^\d+(?:\.\d+)?$/.test(mtText(qty)) || !Number.isFinite(Number(qty))) throw new Error("Невалідна кількість; ID " + id);
    body.push(element("quantity_in_stock", qty));
  }
  body.push("<description>" + cdata(r["Опис RU"]) + "</description>", "<description_ua>" + cdata(r["Опис UA"]) + "</description_ua>");
  for (const param of params) {
    if (!param || typeof param.name !== "string" || !param.name.trim() || typeof param.value !== "string" || typeof param.unit !== "string") {
      throw new Error("Невалідна характеристика; ID " + id);
    }
    const { value, unit } = promParam(param.value, param.unit);
    body.push('<param name="' + xmlAttr(param.name) + '"' + (unit ? ' unit="' + xmlAttr(unit) + '"' : "") + ">" + xmlEscape(value) + "</param>");
  }
  body.push("</offer>");
  return body.join("");
}

// ---------- S6 / S7: стан Catalog Controls у фіді (ENG-10 розд. 1) ----------
/** Стан CC недостовірний (controlsState.blocked) — нового фіду не формуємо. */
export class ControlsBlockedError extends Error {
  constructor(reasons) { super("Стан Catalog Controls недостовірний (blocked): " + (reasons || []).join("; ")); this.name = "ControlsBlockedError"; this.code = "CC_BLOCKED"; }
}
/** Нормалізований вхід стану CC: held — зняті з продажу; removed — виключені / видалені (tombstone, архів). */
export function controlsInput(c) {
  if (!c) return null;
  const set = (v) => new Set(v instanceof Map ? v.keys() : [...(v || [])].map(String));
  return Object.freeze({ held: set(c.held), removed: set(c.removed), blocked: c.blocked === true, fingerprint: String(c.fingerprint || ""), reasons: [...(c.reasons || [])] });
}
const OFFER_RE = /<offer id="([^"]+)"[^>]*>[\s\S]*?<\/offer>/g;
/** Усі offer фіду: id → XML offer. */
export function offersById(xml) {
  const m = new Map();
  for (const x of String(xml).matchAll(OFFER_RE)) if (!m.has(x[1])) m.set(x[1], x[0]);
  return m;
}
/** Примусово «немає в наявності» (S7): available="false", ціна — базова (як у offerXml для недоступного: без oldprice),
 *  без знижки й quantity_in_stock. Решта offer — без змін. */
export function forceUnavailable(offer) {
  let s = String(offer).replace(/(<offer id="[^"]+"[^>]*?)available="(?:true|false)"/, '$1available="false"');
  const old = /<oldprice>([^<]*)<\/oldprice>/.exec(s);
  if (old) s = s.replace(/<price>[^<]*<\/price>/, "<price>" + old[1] + "</price>").replace(/<oldprice>[^<]*<\/oldprice>/, "");
  s = s.replace(/<discount>[^<]*<\/discount>/, ""); // 04.11: <price> уже базова — прибираємо лише знижку
  return s.replace(/<quantity_in_stock>[^<]*<\/quantity_in_stock>/, "");
}
/** Патч цілого фіду (захист від старих версій, S7): offer з ids → forceUnavailable. Повертає новий XML і змінені ID. */
export function patchFeedUnavailable(xml, ids) {
  const patched = [];
  const out = String(xml).replace(OFFER_RE, (offer, id) => {
    if (!ids.has(id)) return offer;
    const next = forceUnavailable(offer);
    if (next !== offer) patched.push(id);
    return next;
  });
  return { xml: out, patched };
}
/** Патч цілого фіду (рішення власника 29.10: видалений товар — жодного <offer>): offer з ids прибираються повністю. */
export function patchFeedRemove(xml, ids) {
  const removed = [];
  const out = String(xml).replace(new RegExp("\\n?" + OFFER_RE.source, "g"), (offer) => { const id = /<offer id="([^"]+)"/.exec(offer)[1]; if (!ids.has(id)) return offer; removed.push(id); return ""; });
  return { xml: out, removed };
}
/** Чи є у фіді доступний (available="true") offer із заборонених ID — для відкату та перевірки старих версій. */
export function availableForbidden(xml, ids) {
  const bad = [];
  for (const [id, offer] of offersById(xml)) if (ids.has(id) && /available="true"/.test(offer.slice(0, offer.indexOf(">") + 1))) bad.push(id);
  return bad;
}
/** Порушення стану CC у версії фіду: видалений (removed) — будь-який offer; знятий (held) — available="true". */
export function controlsViolations(xml, { held = new Set(), removed = new Set() } = {}) {
  const bad = [];
  for (const [id, offer] of offersById(xml)) {
    if (removed.has(id)) bad.push({ id, why: "видалений товар у фіді" });
    else if (held.has(id) && /available="true"/.test(offer.slice(0, offer.indexOf(">") + 1))) bad.push({ id, why: "знятий товар доступний" });
  }
  return bad;
}

export function headerXml(dateText, config, categories) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="' + dateText + '"><shop><name>' + config.shopName + "</name><company>" + config.company
    + '</company><currencies><currency id="UAH" rate="1"/></currencies><categories>' + categories.join("") + "</categories><offers>";
}
const FOOTER = "</offers></shop></yml_catalog>";
export const YML_FOOTER = FOOTER;

/**
 * Формує YML потоком у sink ({ write(text): void|Promise }).
 * rows/groups — об'єкти (див. objectsFromValues). manifest — паспорт погодженого набору.
 * Повертає метадані, сумісні з маніфестом публікатора LIVE (sha256, bytes, sourceDigest, ...).
 */
/**
 * S6 / S7 (ENG-10): controls — стан Catalog Controls { held, removed, blocked, fingerprint, reasons } (controlsInput):
 *   blocked → ControlsBlockedError до першого байта (нового фіду немає);
 *   removed (видалений: tombstone CC / архів) → ЖОДНОГО offer (рішення власника 29.10; без підтвердження Prom);
 *   held (тимчасово знятий) → offer лише available="false" (пріоритет над будь-яким залишком і рядком).
 * isolateRows: вада одного рядка не зупиняє фід — останній опублікований offer цього товару, ПРИМУСОВО недоступний
 *   (без продажу за застарілими даними), або пропуск, якщо товар не публікувався; rowIssues у результаті.
 * ownerPriority: паспорт / печатки — аудит (preflight).
 */
export async function buildYml({ rows, groups, meta, manifest, config, pricing = DEFAULT_PRICING, maximumBytes, sink, missingPolicy = "block", conflictPolicy = "block",
  controls = null, lastGood = null, isolateRows = false, ownerPriority = false }) {
  if (!MISSING_POLICIES.includes(missingPolicy)) throw new Error("Невідома політика відсутніх товарів: " + missingPolicy);
  if (!CONFLICT_POLICIES.includes(conflictPolicy)) throw new Error("Невідома політика конфліктів: " + conflictPolicy);
  const cc = controlsInput(controls);
  if (cc?.blocked) throw new ControlsBlockedError(cc.reasons);
  const { success, now, groupMap, categories, audit } = preflight(rows, groups, meta, manifest, config, { ownerPriority });
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
  // Відбиток стану CC — частина відбитка джерела: інший стан керування → нова версія (REUSE лише за того самого відбитка).
  await emit(headerXml(formatYmlDate(now, config.timeZone), config, categories), headerXml("", config, categories) + (cc ? "<!--cc:" + cc.fingerprint + "-->" : ""));
  const published = [];
  const excluded = [];
  const rowIssues = [];
  let unavailableMissing = 0;
  let isolatedConflicts = 0;
  let ownStock = 0;
  let held = 0;
  const removedOut = [];
  const forcedIds = cc ? new Set(cc.held) : new Set();
  for (const r of rows) {
    const st = r["Стан синхронізації"];
    const id = mtText(r["Offer ID"]);
    const o = renderOffer(r, { success, groupMap, pricing, missingPolicy, conflictPolicy, removed: cc?.removed, forced: forcedIds.has(id), inStock: config.readyToShip === true, isolateRows, lastGood });
    if (o.kind === "removed") { removedOut.push(id); continue; }
    if (o.issue) rowIssues.push(o.issue);
    if (o.kind === "excluded") { excluded.push(id); continue; }
    const xml = o.xml, forced = o.forced;
    await emit("\n" + xml);
    published.push(id);
    if (forced) held++;
    else if (st === STATUS_MISSING) unavailableMissing++;
    else if (CONFLICTS.has(st)) isolatedConflicts++;
    else if (st === STATUS_OWN_STOCK) ownStock++;
  }
  await emit("\n" + FOOTER);
  return {
    count: published.length,
    bytes,
    sha256: full.digest("hex"),
    sourceDigest: digest.digest("hex"),
    sourceSuccess: meta.lastSuccess,
    generatedAt: new Date(meta.now).toISOString(),
    // Паспорт перевірено на ВСІХ погоджених рядках; опубліковано — без ніколи не оцінених відсутніх.
    idsSha: excluded.length || removedOut.length || ownerPriority ? idsSha(published) : manifest.idsSha,
    contentSha: manifest.contentSha,
    approvedCount: rows.length,
    excludedNeverPriced: excluded,
    unavailableMissing,
    isolatedConflicts,
    ownStock,
    held,
    removedExcluded: removedOut,
    rowIssues,
    audit,
    ccFingerprint: cc ? cc.fingerprint : null,
  };
}

/**
 * Один товар фіду — ТІ САМІ правила, що й цикл buildYml (S6 / S7, D1 / D1b, ізоляція рядка). success — час останнього успішного
 * оновлення (у buildYml — з meta; сервер mm-ops передає «Оновлено» самого рядка: ціни там оновлюються лише в змінених рядках).
 * → { kind: "removed" | "excluded" | "published", xml?, forced, issue? }
 */
export function renderOffer(r, { success, groupMap, pricing = DEFAULT_PRICING, missingPolicy = "block", conflictPolicy = "block", removed = null, forced = false, inStock = false, isolateRows = false, lastGood = null }) {
  const st = r["Стан синхронізації"];
  const id = mtText(r["Offer ID"]);
  if (removed?.has(id)) return { kind: "removed", forced }; // видалений — жодного offer, навіть останнього опублікованого
  // Ізольована / знята картка без жодної перевіреної ціни ніколи не публікувалась — у Prom її нема чого вимикати.
  const isolatedHere = (st === STATUS_MISSING && missingPolicy === "unavailable") || (CONFLICTS.has(st) && conflictPolicy === "isolate");
  if ((isolatedHere || forced) && mtText(r["Ціна постачальника"]).trim() === "") return { kind: "excluded", forced };
  try { return { kind: "published", forced, xml: offerXml(r, success, groupMap, pricing, missingPolicy, conflictPolicy, { held: forced, inStock }) }; }
  catch (e) {
    if (!isolateRows) throw e;
    const lg = lastGood?.get(id);
    const issue = { offerId: id, reason: String(e.message).slice(0, 300), action: lg ? "LAST_GOOD_UNAVAILABLE" : "SKIPPED_NEVER_PUBLISHED" };
    return lg ? { kind: "published", forced, xml: forceUnavailable(lg), issue } : { kind: "excluded", forced, issue };
  }
}

/**
 * Оновлення в ГОТОВОМУ offer лише полів цін і наявності (рядок змінив тільки колонки LIVE): available / in_stock, <price>, <oldprice>,
 * <quantity_in_stock> — ті самі значення й перевірки, що в offerXml (формула ціни, «+» / «-», кількість). Будь-яка невідповідність —
 * виняток (викликач робить повне формування). Знятий / ізольований товар так не оновлюється (викликач).
 */
export function patchOfferLive(offer, r, { pricing = DEFAULT_PRICING, inStock = false } = {}) {
  const id = /^<offer id="([^"]+)"/.exec(offer)?.[1];
  if (!id || id !== mtText(r["Offer ID"])) throw new Error("offer не того товару");
  if (r["Стан синхронізації"] !== "ЗІСТАВЛЕНО" || r["Статус імпорту"] !== "ДОЗВОЛЕНО" || ["+", "-"].indexOf(r["Наявність"]) < 0) throw new Error("Непідтверджений статус; ID " + id);
  const available = r["Наявність"] === "+";
  const expected = expectedPrices(r, Number(r["Ціна постачальника"]), available, pricing);
  const discountOk = mtText(r["Знижка"]) === expected.discount
    || (expected.discount === pricing.discount + "%" && typeof r["Знижка"] === "number" && Math.abs(r["Знижка"] - pricing.discount / 100) < 1e-9);
  if (mtText(r["Ціна"]).trim() === "" || mtText(r["Ціна кінцева"]).trim() === "" || Number(r["Ціна"]) !== expected.base || Number(r["Ціна кінцева"]) !== expected.final || !discountOk || expected.base > 9999999999) {
    throw new Error("Ціни/знижка не відповідають погодженій формулі; ID " + id);
  }
  const qty = r["Кількість постачальника"];
  if (qty !== "" && (!/^\d+(?:\.\d+)?$/.test(mtText(qty)) || !Number.isFinite(Number(qty)))) throw new Error("Невалідна кількість; ID " + id);
  const open = /^<offer id="[^"]+" available="(?:true|false)"(?: in_stock="true")? selling_type="r">/;
  if (!open.test(offer) || (offer.match(/<price>/g) || []).length !== 1 || !offer.includes("<description>")) throw new Error("offer нестандартний; ID " + id);
  let s = offer.replace(open, '<offer id="' + id + '" available="' + available + '"' + (available && inStock ? ' in_stock="true"' : "") + ' selling_type="r">');
  s = s.replace(/<oldprice>[^<]*<\/oldprice>/, "").replace(/<discount>[^<]*<\/discount>/, "").replace(/<quantity_in_stock>[^<]*<\/quantity_in_stock>/, "");
  s = s.replace(/<price>[^<]*<\/price>/, element("price", expected.base.toFixed(2)) + (available ? element("discount", expected.discount) : ""));
  if (qty !== "") s = s.replace("<description>", element("quantity_in_stock", qty) + "<description>");
  return s;
}

/** Sink у пам'ять — для тестів і паритету. */
export function memorySink() {
  const parts = [];
  return { write(text) { parts.push(text); }, text() { return parts.join(""); } };
}

export { YML_HEADERS, GROUP_HEADERS, FROZEN_COLUMNS };
