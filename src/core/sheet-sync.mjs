/** Етап S1: логіка запису нової системи в таблицю (варіант A, погоджено 22.10.2026). Чисті функції — без мережі й запису.
 *
 *  Аркуші:
 *   «Основний каталог» — готові SEO-товари: система змінює ЛИШЕ 8 операційних колонок (LIVE_COLUMNS) і додає затверджені рядки.
 *   «Нові товари»      — черга СИРИХ позицій постачальника (40 колонок каталогу + «Рішення», «Перевірка», «Виявлено»).
 *   «Паспорт каталогу» — погоджений набір основного каталогу (кількість, idsSha, contentSha, groupsSha): будь-яка зміна
 *                        SEO/ідентичності поза затвердженням → невідповідність паспорту → запуск нічого не пише.
 *   «Заморожені ID»    — свідомо виключені ID; сюди ж потрапляють ВІДХИЛЕНІ власником позиції (щоб не з'являлися знову).
 *   «Журнал»           — формат mtUpdate: [час, аркуш, ID, поле, було, стало, статус] + підсумок «СИСТЕМА / ЗАВЕРШЕНО». */
import { mtDecode, mtKey, mtText, sha256 } from "./text.mjs";
import { LIVE_COLUMNS, MATCH, changeEntries, planRows, readSheet } from "./sync-plan.mjs";
import { YML_HEADERS, SEAL_COLUMN, approvalManifest, rowSeal } from "./seal.mjs";
import { mtPrices } from "./pricing.mjs";
import { cardKeys, resolveUnknownOffers } from "./identity.mjs";
import { buildDupIndex, compareEntries, dupNote, findDuplicates, kitDifferences, rowEntry } from "./dup-check.mjs";
import { INTAKE_RULES, changedParts, rawFromOffer, rawFromQueueRow, sheetFingerprint, verifyReady, watchFingerprint } from "./intake.mjs";
import { buildCharacteristics, cleanDescription } from "./prom-attributes.mjs";
import { CATEGORY_CONFIRMED } from "./prom-categories.mjs";
import { PRESENCE_COLUMNS, holdLimit } from "./supplier-presence.mjs";
import { enabled as ownerPriorityEnabled, OP_MAIN_COLUMNS, prepareRow, finishRow, stateCell, markCell, approvalState } from "./owner-priority.mjs";
import { STATE_COLUMN, WARNING_MARK_COLUMN, PARAMS_FIELD, acceptSupplier, markCustom, parseParams, hv } from "./field-control.mjs";
import { WARN_SHEET, pendingActions, CLASSIFY_SHEET, CLASSIFY, pendingClassifications } from "../pipeline/supplier-warnings.mjs";
import { ARCHIVE_SHEET } from "./archive.mjs";
/** Рядки архіву «Видалені товари» як об'єкти — лише для «відомих» ID (анти-повторне створення). */
/** CC R6 (S5, правило 5): стан Catalog Controls для синхронізації й intake — { removed: Set Offer ID (усі видалені, будь-яка стадія),
 *  gate: { check(offer) }, blocked, reasons }. Приймає вихід адаптера (removed / tombstoned) або null. */
export function syncControls(c) {
  if (!c) return null;
  const ids = (v) => new Set(v instanceof Map ? [...v.keys()].map(String) : [...(v || [])].map(String));
  return Object.freeze({ removed: new Set([...ids(c.removed), ...ids(c.tombstoned)]), gate: c.gate && typeof c.gate.check === "function" ? c.gate : null, blocked: c.blocked === true, reasons: [...(c.reasons || [])] });
}
export const REMOVED_ISOLATION = "ВИДАЛЕНО (рішення Catalog Controls) — синхронізація не оновлює товар до перенесення в «Видалені товари»";
const gateOffer = (row) => ({ id: mtText(row["ID постачальника"]), sku: row["Артикул постачальника"], nameUa: row["Назва постачальника UA"], nameRu: row["Назва постачальника RU"], url: row["URL постачальника"], vendor: row["Виробник"], model: row["Модель"], gtin: row["GTIN"] });
/** S5: фільтр повторного створення CC для позиції (offer постачальника або рядок черги). blocked — не додавати / не затверджувати;
 *  SIMILAR_TO_EXCLUDED — лише позначка (не хибне зіставлення різних моделей), затвердження — як для можливого дубля. */
export function gateFor(cc, { offer = null, row = null } = {}) {
  if (!cc) return null;
  const ids = [mtText(offer?.id), mtText(row?.["ID постачальника"]), mtText(row?.["Offer ID"])].filter(Boolean);
  const hit = ids.find((id) => cc.removed.has(id));
  if (hit) return { blocked: true, kind: "EXCLUDED", reason: `товар видалено (Offer ID ${hit}) — повторне додавання заборонене` };
  if (!cc.gate) return { blocked: true, kind: "NO_GATE", reason: "фільтр новинок Catalog Controls недоступний — нові товари не приймаються" };
  const g = cc.gate.check(offer || gateOffer(row));
  if (g?.blocked) return { blocked: true, kind: g.kind, reason: g.reason || g.kind };
  if (g?.kind === "SIMILAR_TO_EXCLUDED") return { blocked: false, kind: g.kind, reason: g.reason || "схожий на видалений товар" };
  return null;
}
const ccStop = (cc) => `стан Catalog Controls ${cc ? "недостовірний: " + (cc.reasons.join("; ") || "blocked") : "не підключено"} — видалені товари неможливо відрізнити (правила 5 / S5); нічого не записано`;

const archivedRows = (book) => { const v = book[ARCHIVE_SHEET]; if (!v?.length) return []; const h = v[0].map(mtText); return v.slice(1).filter((r) => r.some((x) => mtText(x))).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""]))); };

/** Категорія для вибору схеми характеристик (власник, 25.10.2026): фактична категорія товару в Prom (перевірений експорт;
 *  catalog.promCategories — { date, map: Offer ID → ID категорії }) — джерело істини. Категорія таблиці — лише якщо товару
 *  в експорті немає (не вигадуємо). Схема іншої категорії не підставляється; категорія в YML (portal_category_id) і в Prom
 *  не змінюється. */
export function schemaCategory(row, catalog) {
  const table = mtText(row["Категорія Prom ID"]).trim();
  const prom = mtText(catalog?.promCategories?.map?.get(mtText(row["Offer ID"]).trim()) ?? "").trim();
  return { cat: prom || table, source: prom ? "prom" : "table", table, prom, differs: Boolean(prom && table && prom !== table) };
}

export const SHEET = Object.freeze({ main: "Основний каталог", queue: "Нові товари", deferred: "Відкладені товари", frozen: "Заморожені ID", groups: "Групи", journal: "Журнал", passport: "Паспорт каталогу" });
export const QUEUE_EXTRA = Object.freeze(["Рішення", "Перевірка", "Виявлено"]);
/** ENG-28a: системна позначка в «Перевірці» рядків NEW92 після міграції структури й до перенесення — sync / intake їх не змінюють. */
export const PENDING_TRANSFER_MARK = "ОЧІКУЄ ПЕРЕНЕСЕННЯ В «ОСНОВНИЙ КАТАЛОГ»";
/** Стан даних постачальника в черзі (варіант А, погоджено 22.10.2026). До наявної черги додаються автоматично. */
export const QUEUE_STATE = Object.freeze(["Остання зміна постачальника", "SHA даних постачальника", "Погоджено для SHA", "SHA SEO при додаванні", "Погоджені дані постачальника"]);
/** Контент постачальника й походження характеристик (погоджено 23.10.2026) — в обох аркушах, після наявних колонок.
 *  Не входять у печатку (не YML_HEADERS): сирі дані постачальника оновлюються без зміни паспорта. */
export const RAW_PARAMS = "Характеристики постачальника JSON";
export const RAW_DESC_UA = "Опис постачальника UA";
export const RAW_DESC_RU = "Опис постачальника RU";
export const PARAMS_ORIGIN = "Походження характеристик JSON";
export { CATEGORY_CONFIRMED };
export const CONTENT_COLUMNS = Object.freeze([RAW_PARAMS, RAW_DESC_UA, RAW_DESC_RU, PARAMS_ORIGIN, CATEGORY_CONFIRMED]);

/** FZ (Frozen Attributes; FZ-03 ред. 2, FZ-HERMES-06, FZ-HERMES-REVIEW-1): обов'язкові ключі джерела збереженого товару — offer
 *  операційного розбору (identityFields: true, як у production: vendor і model) і повний XML (extractFullOffers, з read-only id / vendor /
 *  sku / categoryId постачальника). Операційний і повний XML — різні фіди: кожна сторона зв'язана окремо. Відсутній ключ ≠ порожнє значення. */
export const FROZEN_OFFER_KEYS = Object.freeze(["id", "sku", "nameUa", "nameRu", "url", "vendor", "model"]);
export const FROZEN_FULL_TEXT = Object.freeze(["nameUa", "nameRu", "descriptionUa", "descriptionRu", "model", "id", "vendor", "sku", "categoryId"]);
const FROZEN_FULL_LISTS = Object.freeze(["params", "pictures"]);
/** Тип блокування в «Журналі» (рядок «ОНОВЛЕННЯ ЗАБЛОКОВАНО»): FZ або кореневий контракт захисту недійсні. */
export const FZ_BLOCK = "ЗАХИСТ ХАРАКТЕРИСТИК (FZ)";
/** Тип блокування в «Журналі»: обов'язкові рішення власника (OV, R1) недійсні — файл рішень не відповідає переліку в репозиторії. */
export const OV_BLOCK = "РІШЕННЯ ВЛАСНИКА (OV)";
const guardType = (g) => (g?.type === "OV" ? OV_BLOCK : FZ_BLOCK);
const fzBlockText = (b) => `${b.id}: ${b.kind} — ${b.reason}${b.fields?.length ? ` (${b.fields.join(", ")})` : ""}`;
const ownText = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === "string";

/** Перевірки FZ-товару — ДО «вже збережено» і до перерахунку печатки звичайним конвеєром (FZ-HERMES-06):
 *  1) повнота offer / full за ключами; 2) джерело — поточні offer / full = знімку (повні значення, без нормалізації); 3) локальна
 *  ідентичність рядка і фактична категорія вибору схеми (schemaCategory: експорт Prom, інакше таблиця); 4) фактична rowSeal(рядок) =
 *  печатці в рядку; 5) рішення власника; 6) стан рядка: збережений → нічого, очікуваний → застосувати, інакше — ручний drift.
 *  Повертає { block: { id, kind, fields, reason } } або { state: "saved" | "apply" }. */
export function frozenCheck(row, offer, full, item, catalog = null) {
  const id = mtText(row["Offer ID"]);
  const block = (kind, reason, fields = []) => ({ block: { id, kind, fields, reason } });
  const missOffer = FROZEN_OFFER_KEYS.filter((k) => !ownText(offer, k));
  if (missOffer.length) return block("OFFER", offer ? "неповний offer постачальника" : "немає offer постачальника (товар зник із фіду)", missOffer);
  const missFull = [...FROZEN_FULL_TEXT.filter((k) => !ownText(full, k)), ...FROZEN_FULL_LISTS.filter((k) => !(full && typeof full === "object" && Array.isArray(full[k])))];
  if (missFull.length) return block("FULL", full ? "неповний повний XML товару" : "немає повного XML товару", missFull);
  const src = [
    ...FROZEN_OFFER_KEYS.filter((k) => offer[k] !== item.source.offer[k]).map((k) => "offer." + k),
    ...FROZEN_FULL_TEXT.filter((k) => full[k] !== item.source.full[k]).map((k) => "full." + k),
    ...FROZEN_FULL_LISTS.filter((k) => JSON.stringify(full[k]) !== JSON.stringify(item.source.full[k])).map((k) => "full." + k),
  ];
  if (src.length) return block("ДЖЕРЕЛО", "дані постачальника змінилися з моменту знімка — потрібна нова ревізія FZ", src);
  const loc = [["ID постачальника", item.supplierId], ["Категорія Prom ID", item.categoryId], ["Виробник", item.vendor]].filter(([k, v]) => mtText(row[k]) !== v).map(([k]) => k);
  if (schemaCategory(row, catalog).cat !== item.schemaCategoryId) loc.push("Категорія Prom (фактична для схеми: експорт Prom / таблиця)");
  if (loc.length) return block("ІДЕНТИЧНІСТЬ", "ідентичність картки змінилася з моменту знімка", loc);
  if (rowSeal(row) !== mtText(row[SEAL_COLUMN])) return block("ПЕЧАТКА", "печатка в рядку не відповідає вмісту (поле змінено без перерахунку)", [SEAL_COLUMN]);
  if (catalog?.ownerValueIds?.has?.(id) || catalog?.ownerValues?.has?.(id) || catalog?.ownerIndex?.has?.(id)) return block("ВЛАСНИК", "для товару є рішення власника — потрібна нова погоджена ревізія FZ (накладання не автоматичне)");
  if (catalog?.ownerValuesOk === false) return block("ВЛАСНИК", "файл рішень власника недійсний — рішення власника для товару невідомі");
  const cur = { paramsJson: mtText(row["Характеристики JSON"]), provenanceJson: mtText(row[PARAMS_ORIGIN]), seal: mtText(row[SEAL_COLUMN]) };
  const same = (st) => ["paramsJson", "provenanceJson", "seal"].every((k) => cur[k] === item[st][k]);
  if (same("saved")) return { state: "saved" };
  if (same("expected")) return { state: "apply" };
  return block("DRIFT", "поточні характеристики / походження / печатка відрізняються і від очікуваних, і від збережених — ручна зміна", ["paramsJson", "provenanceJson", "seal"].filter((k) => cur[k] !== item.saved[k]));
}
export const MAIN_HEADERS = Object.freeze([...YML_HEADERS, ...CONTENT_COLUMNS]);
export const QUEUE_HEADERS = Object.freeze([...YML_HEADERS, ...QUEUE_EXTRA, ...QUEUE_STATE, ...CONTENT_COLUMNS]);
export const VERIFIED = "ПЕРЕВІРЕНО";
export const RECHECK = "ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ";
/** Наш SEO-контент — система його НЕ перезаписує. Зміна відносно значень при додаванні = «SEO-підготовку почато». */
export const SEO_FIELDS = Object.freeze(["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Запити UA", "Запити RU"]);
const LEGACY_SEO = "УСПАДКОВАНО (SEO змінено до запуску контролю)";
const UNKNOWN_SEO = "НЕВІДОМО (рядок до запуску контролю; потрібне підтвердження)";
export const SEO_SUPPLIER = "SEO ПОСТАЧАЛЬНИКА";
export const seoHash = (row) => "seo1." + sha256(SEO_FIELDS.map((k) => mtText(row[k])).join("\u0000")).slice(0, 16);
export const PASSPORT_HEADER = Object.freeze(["Поле", "Значення"]);
export const DECISION = Object.freeze({ APPROVE: "ЗАТВЕРДЖЕНО", APPROVE_NOT_DUP: "ЗАТВЕРДЖЕНО (НЕ ДУБЛЬ)", REJECT: "ВІДХИЛЕНО" });
export const STATUS_NEW = "НОВИЙ_ВІД_ПОСТАЧАЛЬНИКА";
export const AUDIT_SHEET = "Аудит";
const NON_PRODUCT_NAME = /співпрац|сотрудничеств|дропшип|dropship|послуг|услуг|партнерств/i;
/** Нетоварні записи у фіді постачальника (напр. «Співпраця по дропшипінгу»): за «Аудитом» або за ознаками. Лише позначка. */
export function nonProductReason(row, auditTypes) {
  const t = auditTypes?.get(mtText(row["Offer ID"]));
  if (t && /НЕТОВАРН/.test(t)) return "за «Аудитом»";
  const names = [row["Назва постачальника UA"], row["Назва постачальника RU"], row["Назва UA"], row["Назва RU"]].map(mtText).join(" ");
  if (!mtText(row["Артикул постачальника"]).trim() && NON_PRODUCT_NAME.test(names)) return "без артикулу, назва — послуга/співпраця";
  return "";
}
/** «Аудит» (лише читання): Offer ID → «Тип» + «Причина» (колонки за заголовком; аркуша може не бути). */
function auditMarks(values) {
  if (!values || !values.length) return new Map();
  const h = values[0].map(mtText);
  const id = h.indexOf("Offer ID"), cols = ["Тип", "Причина"].map((k) => h.indexOf(k)).filter((i) => i >= 0);
  if (id < 0) return new Map();
  const out = new Map();
  for (const r of values.slice(1)) {
    const k = mtText(r[id]);
    if (k) out.set(k, [out.get(k), ...cols.map((i) => mtText(r[i]))].filter(Boolean).join(" "));
  }
  return out;
}
const withNonProduct = (note, reason) => (reason ? ["НЕТОВАРНИЙ ЗАПИС (" + reason + ") — не товар; рішення за вами", note].filter(Boolean).join(" ") : note);
const CELL_LIMIT = 49000; // ліміт Google — 50 000 символів у клітинці

const norm = (v) => mtText(v).trim().toUpperCase().replace(/\s+/g, " ");
const tally = (arr) => arr.reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {});

// ---------- паспорт ----------
export function readPassport(values) {
  if (!values || values.length < 2) return null;
  const m = Object.fromEntries(values.slice(1).map((r) => [mtText(r[0]), r[1]]));
  if (!m.idsSha || !m.contentSha || !m.groupsSha) return null;
  return { count: Number(m.count), idsSha: mtText(m.idsSha), contentSha: mtText(m.contentSha), groupsSha: mtText(m.groupsSha), updatedAt: mtText(m.updatedAt), reason: mtText(m.reason) };
}
export function passportValues(manifest, reason, at) {
  return [PASSPORT_HEADER.slice(), ["count", manifest.count], ["idsSha", manifest.idsSha], ["contentSha", manifest.contentSha], ["groupsSha", manifest.groupsSha], ["updatedAt", at], ["reason", reason]];
}
export const samePassport = (a, b) => Boolean(a && b) && a.count === b.count && a.idsSha === b.idsSha && a.contentSha === b.contentSha && a.groupsSha === b.groupsSha;

// ---------- повний XML постачальника: контент лише для потрібних ID ----------
const stripCdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
const tagRaw = (body, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(body); return m ? stripCdata(m[1]).trim() : ""; };
export function extractFullOffers(xml, ids) {
  const want = new Set(ids);
  const out = new Map();
  if (!want.size) return out;
  for (const m of xml.matchAll(/<offer\b([^>]*)>([\s\S]*?)<\/offer>/g)) {
    const id = /\bid\s*=\s*"([^"]*)"/.exec(m[1])?.[1];
    if (!want.has(id)) continue;
    const b = m[2];
    out.set(id, {
      nameRu: mtDecode(tagRaw(b, "name")), nameUa: mtDecode(tagRaw(b, "name_ua")),
      descriptionRu: tagRaw(b, "description"), descriptionUa: tagRaw(b, "description_ua"),
      pictures: [...b.matchAll(/<picture>([\s\S]*?)<\/picture>/g)].map((x) => mtDecode(stripCdata(x[1]).trim())).filter((u) => /^https?:\/\//.test(u)),
      params: [...b.matchAll(/<param\b([^>]*)>([\s\S]*?)<\/param>/g)].map((p) => ({
        name: mtDecode(/\bname\s*=\s*"([^"]*)"/.exec(p[1])?.[1] || "").trim(), value: mtDecode(stripCdata(p[2])).trim(), unit: mtDecode(/\bunit\s*=\s*"([^"]*)"/.exec(p[1])?.[1] || "").trim(),
      })).filter((p) => p.name),
      country: mtDecode(tagRaw(b, "country_of_origin") || tagRaw(b, "country")),
      model: mtDecode(tagRaw(b, "model")),
      // Лише читання для перевірки ідентичності FZ (повний XML — окремий фід): у дані таблиці не потрапляють.
      id, vendor: mtDecode(tagRaw(b, "vendor")), sku: mtDecode(tagRaw(b, "vendorCode")), categoryId: mtDecode(tagRaw(b, "categoryId")),
    });
    if (out.size === want.size) break;
  }
  return out;
}

const clip = (s, notes, what) => { const t = mtText(s); if (t.length <= CELL_LIMIT) return t; notes.push(`${what} скорочено до ${CELL_LIMIT} символів (ліміт клітинки)`); return t.slice(0, CELL_LIMIT); };

/** Рядок черги з ОРИГІНАЛЬНИМИ даними постачальника. Ідентичність і ціна — з операційного розбору (той самий, що для зіставлення). */
export function candidateRow(offer, full, stamp, pricing, catalog = null) {
  const notes = [];
  let p = { base: "", final: "", discount: "", availability: "-" }, status = MATCH.OK;
  if (offer.currency && offer.currency !== "UAH") status = MATCH.UNKNOWN_CURRENCY;
  else if (typeof offer.available !== "boolean") status = MATCH.UNKNOWN_AVAILABILITY;
  else { try { p = mtPrices(offer.price, offer.available, pricing); } catch { status = MATCH.INVALID_PRICE; } }
  if (status !== MATCH.OK) notes.push("у постачальника некоректні дані: " + status);
  const row = Object.fromEntries(QUEUE_HEADERS.map((k) => [k, ""]));
  Object.assign(row, {
    "Offer ID": offer.id, "ID постачальника": offer.id, "Артикул постачальника": offer.sku,
    "Назва UA": offer.nameUa, "Назва RU": offer.nameRu,
    "Ціна постачальника": offer.price ?? "", "Ціна": p.base, "Ціна кінцева": p.final, "Знижка": p.discount, "Наявність": p.availability,
    "Кількість постачальника": offer.quantity === "" ? "" : Number(offer.quantity), "Стан синхронізації": status, "Оновлено": stamp,
    "Валюта": "UAH",
    "Опис UA": clip(full?.descriptionUa, notes, "Опис UA"), "Опис RU": clip(full?.descriptionRu, notes, "Опис RU"),
    "Фото JSON": JSON.stringify((full?.pictures || []).slice(0, 10)),
    "Характеристики JSON": clip(JSON.stringify((full?.params || []).slice(0, 100)), notes, "Характеристики"),
    "Виробник": offer.vendor || "", "Країна": full?.country || "", "Модель": full?.model || offer.model || "",
    "Назва постачальника UA": offer.nameUa, "Назва постачальника RU": offer.nameRu, "URL постачальника": offer.url,
    "Джерело контенту": "ПОСТАЧАЛЬНИК", "Статус імпорту": STATUS_NEW, "Виявлено": stamp,
  });
  // Сирі дані постачальника — окремо; «Характеристики JSON» — підготовлені (без схеми категорії — копія сирих, як раніше).
  row[RAW_PARAMS] = row["Характеристики JSON"];
  row[RAW_DESC_UA] = row["Опис UA"];
  row[RAW_DESC_RU] = row["Опис RU"];
  const cat = schemaCategory(row, catalog).cat;
  const ch = buildCharacteristics({ schema: catalog?.schemas?.get(cat) || null, categoryId: cat, rawParams: full?.params || [], descUa: row[RAW_DESC_UA], descRu: row[RAW_DESC_RU], current: [], provenance: null, mapping: catalog?.mappings?.get(cat), units: catalog?.units, names: catalog?.names, mode: "queue", brand: row["Виробник"], titles: [row["Назва постачальника UA"], row["Назва постачальника RU"]], kitOwner: catalog?.kitConfirmed?.get(String(row["Offer ID"])) || null, multiOwner: catalog?.multiConfirmed?.get(String(row["Offer ID"])) || null, ownerValues: catalog?.ownerValues?.get(String(row["Offer ID"])) || null, ownerIndex: catalog?.ownerIndex?.get(String(row["Offer ID"])) || null, cardTitles: [row["Назва UA"], row["Назва RU"]] });
  if (ch.changed) row["Характеристики JSON"] = clip(JSON.stringify(ch.params), notes, "Характеристики");
  row[PARAMS_ORIGIN] = JSON.stringify(ch.provenance);
  if (!full) notes.push("немає повного опису в XML постачальника — заповнити вручну");
  row["Перевірка"] = notes.join("; ");
  return row;
}

/** Що не дає затвердити рядок черги (порожній масив — можна переносити). */
export function approvalProblems(row, { groupIds, mainIds, dupFlag }) {
  const p = [];
  // «ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ» — інформаційне попередження (рішення власника 23.10.2026): затвердження не блокує.
  const decision = norm(row["Рішення"]);
  if (dupFlag && decision !== DECISION.APPROVE_NOT_DUP) p.push(`позначено «МОЖЛИВИЙ ДУБЛЬ» — перевірте й поставте «${DECISION.APPROVE_NOT_DUP}»`);
  if (mainIds.has(mtText(row["Offer ID"]))) p.push("такий Offer ID уже є в основному каталозі");
  for (const k of ["Назва UA", "Назва RU", "Опис UA", "Опис RU"]) if (!mtText(row[k]).trim()) p.push(`порожнє «${k}»`);
  let photos = null;
  try { photos = JSON.parse(mtText(row["Фото JSON"]) || "null"); } catch { /* */ }
  if (!Array.isArray(photos) || !photos.length || photos.length > 10 || !photos.every((u) => typeof u === "string" && /^https?:\/\//.test(u))) p.push("«Фото JSON»: потрібно 1–10 посилань http(s)");
  let params = null;
  try { params = JSON.parse(mtText(row["Характеристики JSON"]) || "[]"); } catch { /* */ }
  if (!Array.isArray(params) || params.length > 100 || !params.every((x) => x && typeof x.name === "string" && x.name.trim() && typeof x.value === "string" && typeof x.unit === "string")) p.push("«Характеристики JSON»: масив до 100 елементів {name, value, unit} (рядки)");
  if (!groupIds.has(mtText(row["Група ID"]))) p.push("«Група ID» не знайдено в аркуші «Групи»");
  if (!/^\d+$/.test(mtText(row["Категорія Prom ID"]))) p.push("«Категорія Prom ID» — потрібне число");
  if (row["Валюта"] !== "UAH") p.push("«Валюта» має бути UAH");
  for (const k of ["Запити UA", "Запити RU"]) if (mtText(row[k]).length > 1024) p.push(`«${k}» довші за 1024 символи`);
  if (row["Стан синхронізації"] !== MATCH.OK) p.push(`товар зараз не зіставлено з постачальником (${mtText(row["Стан синхронізації"]) || "невідомо"})`);
  return p;
}

// ---------- варіант А + правила SEO (погоджено 23.10.2026) ----------
const RAW_COLUMNS = Object.freeze([["Назва постачальника UA", "nameUa"], ["Назва постачальника RU", "nameRu"], ["Артикул постачальника", "sku"], ["URL постачальника", "url"]]);
const VERIFIED_RE = /^ПЕРЕВІРЕНО(?:\s+(\S+))?$/;
const SEO_SUPPLIER_RE = /^SEO ПОСТАЧАЛЬНИКА$/;
/** Службові команди «Рішення», що стосуються перевірки даних (не затвердження). */
export const isStateCommand = (decision) => VERIFIED_RE.test(decision) || SEO_SUPPLIER_RE.test(decision);
const JOURNAL_VALUE = 1000;
const jv = (v) => { const t = mtText(v); return t.length > JOURNAL_VALUE ? t.slice(0, JOURNAL_VALUE) + "…" : t; };
const shaMatches = (sha, token) => {
  const t = mtText(token).toLowerCase();
  return t === sha || (t.length >= 8 && /^[0-9a-f]+$/.test(t) && sha.replace(/^s1\./, "").replace(/\./g, "").startsWith(t));
};
/** Сирі характеристики постачальника рядка (рядок до 23.10.2026 без окремої колонки — «Характеристики JSON», яку тоді писала система). */
const rawParamsOf = (row) => (mtText(row[RAW_PARAMS]).trim() ? row[RAW_PARAMS] : row["Характеристики JSON"]);
const kitOf = (row) => ({ nameUa: row["Назва постачальника UA"], nameRu: row["Назва постачальника RU"], params: rawParamsOf(row) });
const descKey = (s) => mtKey(mtText(s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " "));
const descPart = (sha) => /^s1\.(?:[0-9a-f]{8}\.){6}([0-9a-f]{8})$/.exec(mtText(sha))?.[1] || "";
const jsonOr = (v, d) => { try { const x = JSON.parse(mtText(v) || "null"); return x ?? d; } catch { return d; } };
const photoId = (u) => (/images\.prom\.ua\/(\d+)_/.exec(mtText(u)) || [])[1] || mtText(u).trim();

/** Знімок СИРИХ даних постачальника (не нашого SEO) — для попередження «було → стало». */
function supplierSnapshot(row, sha, supplierModel = "") {
  return {
    nameUa: mtText(row["Назва постачальника UA"]), nameRu: mtText(row["Назва постачальника RU"]), sku: mtText(row["Артикул постачальника"]), url: mtText(row["URL постачальника"]),
    photos: (jsonOr(row["Фото JSON"], []) || []).filter((u) => typeof u === "string").map(photoId),
    params: (jsonOr(rawParamsOf(row), []) || []).filter((p) => p && typeof p === "object").map((p) => [mtText(p.name), mtText(p.value), mtText(p.unit)]),
    model: mtText(supplierModel || row["Модель"]), desc: descPart(sha),
  };
}
const snapshotText = (s) => { const x = JSON.stringify(s); return x.length <= CELL_LIMIT ? x : JSON.stringify({ ...s, params: [], cut: true }); };
const cutText = (s, n = 90) => { const x = mtText(s).replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };
/** Що саме змінив постачальник: попередні й нові дані ПОСТАЧАЛЬНИКА (не наше SEO). */
export function describeSupplierChanges(a, b) {
  const out = [];
  const q = (s) => "«" + cutText(s) + "»";
  if (mtKey(a.nameUa) !== mtKey(b.nameUa)) out.push("назва UA: було " + q(a.nameUa) + " → стало " + q(b.nameUa));
  if (mtKey(a.nameRu) !== mtKey(b.nameRu)) out.push("назва RU: було " + q(a.nameRu) + " → стало " + q(b.nameRu));
  if (mtText(a.sku).trim() !== mtText(b.sku).trim()) out.push("артикул: було " + q(a.sku) + " → стало " + q(b.sku));
  if (a.model && b.model && mtKey(a.model) !== mtKey(b.model)) out.push("модель: було " + q(a.model) + " → стало " + q(b.model));
  if (mtText(a.url).trim() !== mtText(b.url).trim()) out.push("сторінка постачальника змінилась");
  const pa = new Set(a.photos || []), pb = new Set(b.photos || []);
  const added = [...pb].filter((x) => !pa.has(x)).length, removed = [...pa].filter((x) => !pb.has(x)).length;
  if (added || removed) out.push("фото: " + [added ? "+" + added + " нових" : "", removed ? "−" + removed + " прибрано" : ""].filter(Boolean).join(", "));
  const ma = new Map((a.params || []).map((p) => [mtKey(p[0]), p])), mb = new Map((b.params || []).map((p) => [mtKey(p[0]), p]));
  const changed = [...mb].filter(([k, p]) => ma.has(k) && (mtKey(ma.get(k)[1]) !== mtKey(p[1]) || mtKey(ma.get(k)[2]) !== mtKey(p[2])));
  const pAdded = [...mb.keys()].filter((k) => !ma.has(k)).length, pRemoved = [...ma.keys()].filter((k) => !mb.has(k)).length;
  if (changed.length || pAdded || pRemoved) {
    const items = changed.slice(0, 4).map(([, p]) => { const o = ma.get(mtKey(p[0])); return "«" + cutText(p[0], 40) + "» " + cutText(o[1] + (o[2] ? " " + o[2] : ""), 30) + " → " + cutText(p[1] + (p[2] ? " " + p[2] : ""), 30); });
    out.push("характеристики: " + [...items, changed.length > 4 ? "ще " + (changed.length - 4) + " змін" : "", pAdded ? "+" + pAdded + " нових" : "", pRemoved ? "−" + pRemoved + " прибрано" : ""].filter(Boolean).join("; "));
  }
  if (a.desc && b.desc && a.desc !== b.desc) out.push("опис постачальника змінився");
  return out;
}

/**
 * Рядок черги: сирі дані постачальника — з поточного XML; правила SEO (погоджено 23.10.2026):
 *  • сире SEO (не редаговане нами: SEO-поля = знімку, записаному системою) — оновлюється разом із постачальником, без попереджень;
 *  • власне SEO — ніколи не перезаписується; суттєва зміна даних постачальника → «ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ» з «було → стало»;
 *  • «ПЕРЕВІРЕНО» прив'язується до SHA, записаної в рядку (саме ці дані бачив власник); наступна суттєва зміна — знову перевірка;
 *  • ціна й наявність — окремо (planRows), не входять у SHA і ніколи не блокуються;
 *  • рядок до запуску контролю без знімка: сире — лише якщо назви = назвам постачальника, запитів немає й опис = опису
 *    постачальника; інакше власне або «походження невідоме» (команди «SEO ПОСТАЧАЛЬНИКА» / «ПЕРЕВІРЕНО»).
 * offer — операційний розбір; full — повний offer (фото, характеристики, опис) або undefined (тоді вони не змінюються).
 */
export function refreshQueueRow(row, offer, full, { stamp, catalog = null, cleanDescriptions = false, commands = true }) {
  const r = { ...row };
  const entries = [], notes = [];
  const id = mtText(row["Offer ID"]);
  const prevSha = mtText(row["SHA даних постачальника"]);
  const decision = norm(row["Рішення"]);
  const verifiedCmd = commands ? VERIFIED_RE.exec(decision) : null;
  const supplierCmd = commands && SEO_SUPPLIER_RE.test(decision);
  // 1. Походження SEO
  let initialSeo = mtText(row["SHA SEO при додаванні"]);
  if (!initialSeo) {
    const namesRaw = mtKey(row["Назва UA"]) === mtKey(row["Назва постачальника UA"]) && mtKey(row["Назва RU"]) === mtKey(row["Назва постачальника RU"])
      && !mtText(row["Запити UA"]).trim() && !mtText(row["Запити RU"]).trim();
    if (!namesRaw) initialSeo = LEGACY_SEO;
    else if (full) initialSeo = descKey(row["Опис UA"]) === descKey(full.descriptionUa) && descKey(row["Опис RU"]) === descKey(full.descriptionRu) ? seoHash(row) : UNKNOWN_SEO;
    // без повного XML рішення відкладається; цей прохід — як для власного SEO (нічого не перезаписуємо)
  }
  if (supplierCmd) { // власник підтвердив: SEO — копія постачальника → дозволено автооновлення
    entries.push([stamp, SHEET.queue, id, SEO_SUPPLIER, initialSeo, "сире SEO", "РІШЕННЯ ВЛАСНИКА"]);
    initialSeo = seoHash(row);
    r["Рішення"] = "";
  }
  let seoUnknown = initialSeo === UNKNOWN_SEO;
  const seoOwn = !initialSeo || initialSeo === LEGACY_SEO || seoUnknown || seoHash(row) !== initialSeo || Boolean(decision && !isStateCommand(decision));
  // 2. «ПЕРЕВІРЕНО» — до даних, які бачив власник (SHA у рядку)
  let agreed = mtText(row["Погоджено для SHA"]);
  let snapshot = mtText(row["Погоджені дані постачальника"]);
  const pre = supplierSnapshot(row, prevSha);
  if (verifiedCmd) {
    if (!prevSha && !seoUnknown) notes.push("«" + VERIFIED + "» не прийнято: SHA даних постачальника ще не записано — повторіть після наступного оновлення");
    else if (verifiedCmd[1] && prevSha && !shaMatches(prevSha, verifiedCmd[1])) notes.push("«" + VERIFIED + "» не прийнято: указана SHA не відповідає поточній (" + prevSha.slice(0, 11) + "…) — дані змінилися");
    else {
      entries.push([stamp, SHEET.queue, id, VERIFIED, agreed, prevSha, "РІШЕННЯ ВЛАСНИКА"]);
      if (prevSha) { agreed = prevSha; snapshot = snapshotText(pre); }
      if (seoUnknown) { initialSeo = LEGACY_SEO; seoUnknown = false; } // підтверджено: SEO власне
      r["Рішення"] = "";
    }
  }
  // 3. Сирі дані постачальника
  const supplierModel = mtText(full?.model || offer?.model || "").trim();
  let ch = null;
  if (offer) {
    const set = (col, next) => { if (mtText(r[col]) !== mtText(next)) { entries.push([stamp, SHEET.queue, id, col, jv(r[col]), jv(next), "ДАНІ ПОСТАЧАЛЬНИКА"]); r[col] = next; } };
    for (const [col, f] of RAW_COLUMNS) set(col, offer[f] ?? "");
    // Рядок до 23.10.2026: сирі характеристики — те, що система тоді записала в «Характеристики JSON».
    if (!mtText(r[RAW_PARAMS]).trim()) r[RAW_PARAMS] = mtText(row["Характеристики JSON"]) || "[]";
    if (full) {
      // Фото — повним актуальним списком постачальника (порядок, головне фото); порожній список не стирає наявних.
      if ((full.pictures || []).length) set("Фото JSON", JSON.stringify(full.pictures.slice(0, 10)));
      else if ((jsonOr(r["Фото JSON"], []) || []).length) notes.push("у повному XML немає фото — залишено попередні");
      const params = JSON.stringify((full.params || []).slice(0, 100));
      if (params.length > CELL_LIMIT) notes.push("характеристики постачальника завеликі для клітинки — не оновлено");
      else if ((full.params || []).length || !(jsonOr(r[RAW_PARAMS], []) || []).length) set(RAW_PARAMS, params);
      else notes.push("у повному XML немає характеристик — залишено попередні");
      if (supplierModel) set("Модель", supplierModel); // модель — сирі дані постачальника
      // Оригінальний опис постачальника (для відновлення й перенесення характеристик); зміна вже видна в SHA опису.
      if (mtText(full.descriptionUa).trim()) r[RAW_DESC_UA] = clip(full.descriptionUa, notes, "Опис постачальника UA");
      if (mtText(full.descriptionRu).trim()) r[RAW_DESC_RU] = clip(full.descriptionRu, notes, "Опис постачальника RU");
    }
    // 3б. Підготовлені характеристики для Prom: за схемою категорії, з урахуванням ручних виправлень.
    const cat = schemaCategory(r, catalog).cat;
    ch = buildCharacteristics({ schema: catalog?.schemas?.get(cat) || null, categoryId: cat, rawParams: jsonOr(r[RAW_PARAMS], []), descUa: r[RAW_DESC_UA], descRu: r[RAW_DESC_RU], current: r["Характеристики JSON"], provenance: r[PARAMS_ORIGIN], mapping: catalog?.mappings?.get(cat), units: catalog?.units, names: catalog?.names, mode: "queue", brand: r["Виробник"], titles: [r["Назва постачальника UA"], r["Назва постачальника RU"]], kitOwner: catalog?.kitConfirmed?.get(String(r["Offer ID"])) || null, multiOwner: catalog?.multiConfirmed?.get(String(r["Offer ID"])) || null, ownerValues: catalog?.ownerValues?.get(String(r["Offer ID"])) || null, ownerIndex: catalog?.ownerIndex?.get(String(r["Offer ID"])) || null, cardTitles: [r["Назва UA"], r["Назва RU"]] });
    const prepared = JSON.stringify(ch.params);
    if (ch.changed && prepared.length <= CELL_LIMIT) { entries.push([stamp, SHEET.queue, id, "Характеристики JSON", jv(r["Характеристики JSON"]), jv(prepared), "ХАРАКТЕРИСТИКИ (автоматично)"]); r["Характеристики JSON"] = prepared; }
    r[PARAMS_ORIGIN] = JSON.stringify(ch.provenance);
    if (ch.conflicts.length || ch.notes.length) notes.push("характеристики: " + [...ch.conflicts, ...ch.notes].slice(0, 5).join("; "));
  }
  const raw = { ...rawFromQueueRow(r), descriptionUa: full?.descriptionUa || "", descriptionRu: full?.descriptionRu || "", hasDescription: Boolean(offer && full) };
  const sha = offer ? sheetFingerprint(raw, prevSha) : prevSha || sheetFingerprint(raw);
  if (prevSha && full && offer) {
    const a = descPart(prevSha), b = descPart(sha);
    if (a && b && a !== b) entries.push([stamp, SHEET.queue, id, "Опис постачальника", "SHA " + a, "SHA " + b + " (" + mtText(full.descriptionUa).length + " симв.)", "ДАНІ ПОСТАЧАЛЬНИКА"]);
  }
  // 4. Сире SEO — автооновлення разом із постачальником (без попереджень)
  if (offer && !seoOwn && initialSeo) {
    const seoSet = (col, next) => { if (mtText(r[col]) !== mtText(next)) { entries.push([stamp, SHEET.queue, id, col, jv(r[col]), jv(next), "SEO-КОПІЯ ПОСТАЧАЛЬНИКА"]); r[col] = next; } };
    seoSet("Назва UA", offer.nameUa ?? ""); seoSet("Назва RU", offer.nameRu ?? "");
    if (full) {
      // Очищення лише СИРОЇ копії опису й лише від пар, уже перенесених у поля Prom (вмикається окремо: cleanDescriptions).
      const clean = (lang, text) => (cleanDescriptions && ch?.descRanges[lang].length && mtText(r[lang === "ua" ? RAW_DESC_UA : RAW_DESC_RU]) === text ? cleanDescription(text, ch.descRanges[lang]) : text);
      seoSet("Опис UA", clean("ua", clip(full.descriptionUa, notes, "Опис UA")));
      seoSet("Опис RU", clean("ru", clip(full.descriptionRu, notes, "Опис RU")));
    }
    initialSeo = seoHash(r); // знімок системи рухається разом із копією
  }
  r["SHA SEO при додаванні"] = initialSeo;
  r["SHA даних постачальника"] = sha;
  if (prevSha && sha !== prevSha) r["Остання зміна постачальника"] = stamp;
  else if (!mtText(r["Остання зміна постачальника"])) r["Остання зміна постачальника"] = mtText(row["Виявлено"]) || stamp;
  const cur = supplierSnapshot(r, sha, supplierModel);
  // 5. Погоджені дані: сире SEO — «йдуть за» постачальником; власне — фіксуються (перший раз — на даних, які бачив власник)
  if (!seoOwn) { agreed = sha; snapshot = snapshotText(cur); }
  else if (!agreed) {
    agreed = prevSha || sheetFingerprint({ ...rawFromQueueRow(row), descriptionUa: full?.descriptionUa || "", descriptionRu: full?.descriptionRu || "", hasDescription: Boolean(full) });
    snapshot = snapshotText(pre);
  } else if (!snapshot && agreed === prevSha) snapshot = snapshotText(pre);
  r["Погоджено для SHA"] = agreed;
  r["Погоджені дані постачальника"] = snapshot;
  // 6. Попередження
  let recheck = seoOwn && agreed !== sha ? changedParts(agreed, sha) : [];
  let recheckNote = "";
  if (recheck.length) {
    const was = jsonOr(snapshot, null);
    const details = was ? describeSupplierChanges(was, cur) : [];
    const kit = kitDifferences(kitOf(was ? { "Назва постачальника UA": was.nameUa, "Назва постачальника RU": was.nameRu, "Характеристики JSON": JSON.stringify((was.params || []).map((p) => ({ name: p[0], value: p[1], unit: p[2] }))) } : row), kitOf(r));
    const identity = details.some((d) => /^(назва|артикул|модель)/.test(d)) ? "Постачальник змінив назву / артикул / модель товару. " : "";
    recheckNote = RECHECK + ": " + identity + (details.length ? details.join("; ") : "змінено: " + recheck.join(", ") + " (попередні значення не збережено)")
      + (kit.length ? "; різниця комплектації: " + kit.join(", ") : "")
      + ". Наше SEO не змінено — перевірте відповідність SEO новим даним постачальника і поставте «" + VERIFIED + "» у «Рішення».";
    for (const e of entries) if (e[6] === "ДАНІ ПОСТАЧАЛЬНИКА") e[6] = RECHECK;
  } else if (seoUnknown) {
    recheck = ["походження SEO"];
    recheckNote = RECHECK + ": походження SEO невідоме (рядок доданий до запуску контролю, а опис постачальника відтоді змінився) — SEO не оновлюється автоматично. "
      + "Якщо SEO — копія постачальника, поставте «" + SEO_SUPPLIER + "»; якщо власне — «" + VERIFIED + "».";
  } else if (prevSha && sha !== prevSha) notes.push((seoOwn ? "" : "SEO-копію оновлено разом із даними постачальника; ") + "дані постачальника оновлено (" + changedParts(prevSha, sha).join(", ") + ")");
  return { row: r, entries, notes, recheck, recheckNote, sha, changed: Boolean(prevSha && sha !== prevSha), verified: Boolean(verifiedCmd || supplierCmd), seoOwn };
}

/**
 * Основний каталог (погоджено 23.10.2026): постачальник під тим самим ID змінив модель / артикул / інші дані — приймаємо
 * автоматично: сирі поля, «Модель», фото (повним списком, у його порядку); ціна й наявність — planRows.
 * Характеристики: сирі — у «Характеристики постачальника JSON» (автоматично); підготовлені «Характеристики JSON» — лише
 * за схемою категорії Prom (buildCharacteristics): ручні й невизначені значення зберігаються; без схеми — без змін.
 * Наше SEO (SEO_FIELDS) не перезаписується ніколи — у «Журналі» інформаційне попередження «було → стало» (нічого не блокує).
 * «Код товару Prom» іде за артикулом лише тоді, коли дорівнював попередньому артикулу й новий не зайнятий іншою карткою.
 * Offer ID і категорія Prom не змінюються. Фото й характеристики — лише з повного перевіреного XML (full).
 */
/** ENG-28b (рішення власника 01.11): characteristics — "rebuild" (як раніше: генератор за схемою) або "preserve" (звичайне
 *  «Оновити товари»: «Характеристики JSON» і походження не перебудовуються, опис не розбирається, збережені FZ не застосовуються;
 *  сирі дані постачальника, зокрема «Характеристики постачальника JSON», оновлюються й виявляються як зміни — rawParams). */
export function refreshMainRow(row, offer, full, { stamp, skuInUse = () => "", catalog = null, ownerPriority = false, characteristics = "rebuild" }) {
  const preserve = characteristics === "preserve";
  // FZ: каталог заблоковано (кореневий контракт захисту або обов'язковий FZ недійсний) — жодних змін, структурований блокер; для
  // FZ-товару — перевірки frozenCheck до будь-яких змін (зокрема на відсутній offer / full — не тихий успіх).
  const idle = (frozenBlock) => ({ row, entries: [], changed: false, identity: false, photos: false, params: false, frozenBlock });
  if (catalog?.guard?.blocked) return idle({ id: mtText(row["Offer ID"]), kind: "КАТАЛОГ", fields: [], reason: catalog.guard.reasons.join("; ") });
  const fz = catalog?.frozenFor?.(mtText(row["Offer ID"])) || null;
  let fzState = "";
  if (fz) {
    const chk = frozenCheck(row, offer, full, fz, catalog);
    if (chk.block) return idle(chk.block);
    fzState = chk.state;
  }
  if (!offer) return { row, entries: [], changed: false, identity: false, photos: false, params: false };
  const r = { ...row };
  const id = mtText(row["Offer ID"]);
  const entries = [];
  const status = "ДАНІ ПОСТАЧАЛЬНИКА (автоматично; SEO не змінено)";
  let touched = false;
  const set = (col, next, why = status) => { if (mtText(r[col]) !== mtText(next)) { entries.push([stamp, SHEET.main, id, col, jv(r[col]), jv(next), why]); r[col] = next; touched = true; return true; } return false; };
  // Службові колонки без запису в «Журнал» (перше заповнення, походження).
  const quiet = (col, next) => { if (mtText(r[col]) !== mtText(next)) { r[col] = next; touched = true; } };
  const firstRaw = !mtText(row[RAW_PARAMS]).trim();
  const pre = supplierSnapshot(row, "", mtText(row["Модель"]));
  const oldSku = mtText(row["Артикул постачальника"]).trim();
  for (const [col, f] of RAW_COLUMNS) set(col, f === "sku" ? mtText(offer.sku).trim() : offer[f] ?? "");
  const newSku = mtText(r["Артикул постачальника"]).trim();
  // Пріоритет власника (рішення 29.10): «Код товару Prom» — поле власника (за замовчуванням Offer ID), за артикулом не ходить.
  if (newSku !== oldSku && !ownerPriority) {
    const code = mtText(row["Код товару Prom"]).trim();
    const owner = newSku ? skuInUse(newSku, id) : "";
    if ((!code || code === oldSku) && newSku && !owner) set("Код товару Prom", newSku);
    else if (owner) entries.push([stamp, SHEET.main, id, "Код товару Prom", code, code, "НЕ ЗМІНЕНО: артикул «" + newSku + "» уже має товар " + owner]);
  }
  let photos = false, params = false, rawParams = false;
  if (full) {
    const model = mtText(full.model).trim();
    if (model) set("Модель", model);
    if ((full.pictures || []).length) photos = set("Фото JSON", JSON.stringify(full.pictures.slice(0, 10)));
    const rawJson = JSON.stringify((full.params || []).slice(0, 100));
    if (rawJson.length <= CELL_LIMIT && (full.params || []).length) { if (firstRaw) quiet(RAW_PARAMS, rawJson); else rawParams = set(RAW_PARAMS, rawJson); }
    for (const [col, text] of [[RAW_DESC_UA, full.descriptionUa], [RAW_DESC_RU, full.descriptionRu]]) {
      if (mtText(text).trim() && mtText(text).length <= CELL_LIMIT) quiet(col, text); // зміну опису видно з SHA; повний текст у «Журнал» не пишемо
    }
  }
  // Підготовлені характеристики — за схемою категорії (без схеми: не змінюються).
  const cat = schemaCategory(r, catalog).cat;
  const schema = catalog?.schemas?.get(cat) || null;
  const techRules = catalog?.techRulesFor?.(String(r["Offer ID"])) || [];
  // А2: у повному XML немає жодного <param> — характеристики лише з блоку характеристик опису (той самий генератор), тільки в
  // області дії переліку захищених товарів; без повного XML, без опису або без валідного переліку — як раніше (не перебудовується).
  const descOnly = techRules.includes("A2") && Boolean(full) && !(full.params || []).length && Boolean(mtText(r[RAW_DESC_UA]).trim() || mtText(r[RAW_DESC_RU]).trim());
  // OV (рішення власника, 28.10.2026): товар із підтвердженими рішеннями власника (файл рішень або перелік у репозиторії), але без сирих
  // характеристик постачальника і не А2 — генератор лише застосовує рішення власника й зберігає наявні значення картки: сирих даних
  // і опису не розбирає (порожні rawParams / descUa / descRu), тож нічого нового з опису не з'являється.
  const ownerOnly = !mtText(r[RAW_PARAMS]).trim() && !descOnly && Boolean(catalog?.ownerValues?.has?.(id) || catalog?.ownerIndex?.has?.(id));
  if (fz) {
    // FZ: лише збережені params / provenance прийнятого знімка; генератор для товару не викликається.
    // ENG-28b: у режимі preserve збережені FZ не застосовуються (етап C) — рядок лишається в стані expected, перевірка нижче.
    if (fzState === "apply" && !preserve) {
      params = set("Характеристики JSON", fz.saved.paramsJson, `ЗБЕРЕЖЕНІ ХАРАКТЕРИСТИКИ ЗАХИЩЕНОГО ТОВАРУ (FZ rev ${catalog.frozenInfo?.rev ?? ""})`);
      quiet(PARAMS_ORIGIN, fz.saved.provenanceJson);
    }
  } else if (!preserve && schema && (mtText(r[RAW_PARAMS]).trim() || descOnly || ownerOnly)) {
    const ch = buildCharacteristics({ schema, categoryId: cat, rawParams: jsonOr(r[RAW_PARAMS], []), descUa: ownerOnly ? "" : r[RAW_DESC_UA], descRu: ownerOnly ? "" : r[RAW_DESC_RU], current: r["Характеристики JSON"], provenance: r[PARAMS_ORIGIN], mapping: catalog?.mappings?.get(cat), units: catalog?.units, names: catalog?.names, mode: "main", brand: r["Виробник"], titles: [r["Назва постачальника UA"], r["Назва постачальника RU"]], kitOwner: catalog?.kitConfirmed?.get(String(r["Offer ID"])) || null, multiOwner: catalog?.multiConfirmed?.get(String(r["Offer ID"])) || null, ownerValues: catalog?.ownerValues?.get(String(r["Offer ID"])) || null, ownerIndex: catalog?.ownerIndex?.get(String(r["Offer ID"])) || null, cardTitles: [r["Назва UA"], r["Назва RU"]], techRules, exactPairs: catalog?.a3PairsFor?.(String(r["Offer ID"])) || [] });
    const prepared = JSON.stringify(ch.params);
    const provJson = JSON.stringify(ch.provenance);
    // Пріоритет власника (рішення 29.10): без зайвих записів — якщо характеристики разом зі своїм походженням (items[i] ↔ params[i])
    // збігаються як множина пар без урахування порядку, а службова частина походження (крім діагностичних notes) та сама — нічого
    // не пишемо (ні порядок, ні позначку джерела). Будь-яка змістовна зміна — як і раніше.
    if (!(ownerPriority && sameCharacteristics(r["Характеристики JSON"], r[PARAMS_ORIGIN], prepared, provJson))) {
      if (ch.changed && prepared.length <= CELL_LIMIT) params = set("Характеристики JSON", prepared, "ХАРАКТЕРИСТИКИ ЗА СХЕМОЮ PROM (автоматично; ручні значення збережено)");
      quiet(PARAMS_ORIGIN, provJson);
    }
  }
  const identity = mtKey(pre.nameUa) !== mtKey(r["Назва постачальника UA"]) || mtKey(pre.nameRu) !== mtKey(r["Назва постачальника RU"]) || pre.sku !== newSku;
  if (touched) {
    r[SEAL_COLUMN] = rowSeal(r);
    const post = supplierSnapshot(r, "", mtText(r["Модель"]));
    if (firstRaw) pre.params = post.params; // перше заповнення сирої колонки — не «зміна постачальника»
    const details = describeSupplierChanges(pre, post);
    if (details.length) entries.push([stamp, SHEET.main, id, RECHECK, "", jv(details.join("; ")), "ІНФОРМАЦІЙНО: наше SEO не змінено — перевірте відповідність новим даним постачальника"]);
  }
  // FZ: підсумковий рядок має точно дорівнювати стану, який визнає FZ (печатка охоплює всі незмінні колонки): збереженому, а в
  // режимі preserve без застосування (state "apply") — очікуваному (поточному) стану. Будь-яке інше відхилення — BLOCK, як і раніше.
  const fzSeal = preserve && fzState === "apply" ? fz.expected.seal : fz?.saved.seal;
  if (fz && mtText(r[SEAL_COLUMN]) !== fzSeal) return idle({ id, kind: "ПЕЧАТКА", fields: [SEAL_COLUMN], reason: "після оновлення печатка ≠ збереженій — змінено незв'язане поле; потрібна нова ревізія FZ" });
  return { row: r, entries, changed: touched, identity, photos, params, rawParams, ...(preserve && fzState === "apply" ? { frozenPending: true } : {}) };
}

/** Характеристики та їхнє походження однакові по суті: та сама множина пар «характеристика + запис походження» (без порядку),
 *  та сама службова частина походження (v, cat, x); діагностичні notes не враховуються. Помилка розбору → «різні» (захисно). */
export function sameCharacteristics(curParams, curProv, newParams, newProv) {
  try {
    const cp = JSON.parse(mtText(curParams) || "[]"), np = JSON.parse(mtText(newParams) || "[]");
    const cv = JSON.parse(mtText(curProv) || "null"), nv = JSON.parse(mtText(newProv) || "null");
    if (!Array.isArray(cp) || !Array.isArray(np)) return false;
    const pairs = (ps, pv) => ps.map((p, i) => JSON.stringify([p?.name, p?.value, p?.unit ?? "", pv?.items?.[i] ?? null])).sort();
    const meta = (pv) => JSON.stringify([pv?.v ?? null, pv?.cat ?? null, [...(pv?.x || [])].map(String).sort()]);
    return JSON.stringify(pairs(cp, cv)) === JSON.stringify(pairs(np, nv)) && meta(cv) === meta(nv);
  } catch { return false; }
}

/** Черга з колонками стану й контенту (додаються автоматично в кінець, якщо аркуш створено раніше). */
function readQueue(values) {
  const header = (values?.[0] || []).map(mtText);
  const migrated = [...QUEUE_STATE, ...CONTENT_COLUMNS].filter((k) => !header.includes(k));
  const v = migrated.length ? [[...header, ...migrated], ...values.slice(1)] : values;
  return { ...readSheet(v, SHEET.queue), migrated };
}
/** Основний каталог з колонками контенту (погоджено 23.10.2026; додаються автоматично в кінець аркуша). */
export function readMain(values, { extra = [] } = {}) {
  const header = (values?.[0] || []).map(mtText);
  const migrated = values?.length ? [...CONTENT_COLUMNS, ...extra].filter((k) => !header.includes(k)) : [];
  const v = migrated.length ? [[...header, ...migrated], ...values.slice(1)] : values;
  return { ...readSheet(v, SHEET.main), migrated };
}
const queueEntryNote = (rq, rest) => [rq.recheckNote, ...rq.notes, ...rest].filter(Boolean).join(" ");

/** Заморожені — ОБЕРЕЖНО: лише сильний збіг (артикул + обидві назви) з карткою, чий ID зник із фіду. */
function frozenFlags({ mainRows, parsed, frozenIds, knownSupplierIds }) {
  const flag = new Set();
  const orphanIds = new Set(mainRows.filter((r) => !parsed.offers.has(mtText(r["ID постачальника"]))).map((r) => mtText(r["Offer ID"])));
  if (orphanIds.size) {
    const frozenOffers = [...parsed.offers.values()].filter((o) => frozenIds.has(o.id) && !knownSupplierIds.has(o.id));
    const cards = mainRows.map((r) => cardKeys(r));
    for (const d of resolveUnknownOffers({ offers: frozenOffers, cards, orphanIds })) if (d.candidates.some((c) => c.orphan && c.level === "STRONG")) flag.add(d.offerId);
  }
  return flag;
}

/** Звіт для «Сторожа новинок»: база відомих ID і відбитки сирих даних черги (той самий формат, що рахує Worker). */
export function ackFor({ mainRows, queueRows, deferredRows, frozenIds, frozenFlag, profile = "medium", results = {} }) {
  const known = new Set();
  for (const r of [...mainRows, ...queueRows, ...deferredRows]) for (const k of ["ID постачальника", "Offer ID"]) { const v = mtText(r[k]); if (v) known.add(v); }
  for (const id of frozenIds) if (!frozenFlag.has(id)) known.add(id); // заморожений, схожий на зниклу картку, — під спостереження
  const queue = {};
  for (const r of queueRows) { const id = mtText(r["ID постачальника"]); if (id) queue[id] = watchFingerprint(rawFromQueueRow(r), profile); }
  return { profile, known: [...known], queue, results };
}

/** Рядок черги → рядок основного каталогу: ті самі ID і значення, «ДОЗВОЛЕНО», групи з довідника, нова печатка. */
export function toMainRow(row, groupsById) {
  const g = groupsById.get(mtText(row["Група ID"]));
  const out = Object.fromEntries(MAIN_HEADERS.map((k) => [k, row[k] ?? ""]));
  if (g) { if (!mtText(out["Група UA"])) out["Група UA"] = g.ua; if (!mtText(out["Група RU"])) out["Група RU"] = g.ru; }
  out["Статус імпорту"] = "ДОЗВОЛЕНО";
  out[SEAL_COLUMN] = rowSeal(out);
  return out;
}

export const BINDINGS_SHEET = "Історія прив'язок";
export const BINDINGS_HEADERS = Object.freeze([
  "Дата", "Offer ID", "Старий ID постачальника", "Новий ID постачальника", "Старий артикул", "Новий артикул",
  "Старий Код товару Prom", "Новий Код товару Prom", "Стара назва постачальника UA", "Стара назва постачальника RU", "Старий URL постачальника",
  "Нова назва постачальника UA", "Нова назва постачальника RU", "Новий URL постачальника", "Підстава", "Стан", "Рішення",
]);
const BIND_RE = /^ПРИВ['’ʼ`]?ЯЗАТИ ДО\s+(\d+)(\s*\(ПІДТВЕРДЖУЮ\))?$/;
const UNDO = "СКАСУВАТИ";
const SUPPLIER_FIELDS = [["ID постачальника", "id"], ["Артикул постачальника", "sku"], ["Назва постачальника UA", "nameUa"], ["Назва постачальника RU", "nameRu"], ["URL постачальника", "url"]];

/** Індекс схожості: основний каталог (з ознакою «зник із фіду»), черга, відкладені. */
function dupIndexFor({ mainRows, queueRows, deferredRows, offers }) {
  const entries = [
    ...mainRows.map((r) => rowEntry(r, SHEET.main, { orphan: !offers.has(mtText(r["ID постачальника"])) })),
    ...queueRows.map((r) => rowEntry(r, SHEET.queue)),
    ...deferredRows.map((r) => rowEntry(r, SHEET.deferred)),
  ];
  return buildDupIndex(entries);
}
const queueEntry = (r) => rowEntry(r, SHEET.queue);

/** Сумніви щодо «той самий товар» між карткою й позицією: комплектація, бренд, назви, фото. Порожньо — сумнівів немає. */
function bindingDoubts(cmp) {
  const d = [];
  if (cmp.kit.length) d.push("різна комплектація: " + cmp.kit.join(", "));
  if (cmp.brandConflict) d.push("різний бренд");
  if (!cmp.evidence.includes("назва UA") && !cmp.evidence.includes("назва RU")) d.push("назви постачальника відрізняються");
  if (cmp.photo.card && cmp.photo.offer) {
    if (!cmp.photo.shared) d.push(`фото різні (у картки ${cmp.photo.cardSample}, у нової ${cmp.photo.offerSample})`);
    else if (cmp.photo.shared < Math.max(cmp.photo.card, cmp.photo.offer)) d.push(`фото частково різні (спільних ${cmp.photo.shared}; у картки ${cmp.photo.card}, у нової ${cmp.photo.offer}) — можлива інша комплектація`);
  } else d.push("немає фото для порівняння");
  return d;
}

/** Перевірка й застосування «ПРИВ'ЯЗАТИ ДО» (лише рішення власника; автоматичних прив'язок немає). */
function planBindings({ queueRows, mainRows, deferredRows, offers, stamp, cc = null, historyValues = null }) {
  const mainById = new Map(mainRows.map((r, i) => [mtText(r["Offer ID"]), i]));
  // ENG-27 (N3): рядок черги з «ПРИВ'ЯЗАТИ ДО» після прив'язки лишається (видалення рядків — B6), а команду sync не стирає. Тож
  // команда ідемпотентна за «Історією прив'язок»: та сама пара (картка, новий ID постачальника) уже є — повторно не виконується;
  // скасовану власником прив'язку команда в черзі не відновлює.
  const hh = (historyValues?.[0] || []).map(mtText), hT = hh.indexOf("Offer ID"), hS = hh.indexOf("Новий ID постачальника"), hState = hh.indexOf("Стан");
  const past = new Map();
  if (hT >= 0 && hS >= 0) for (const h of (historyValues || []).slice(1)) { const k = mtText(h?.[hT]) + "\u0000" + mtText(h?.[hS]); if (mtText(h?.[hT])) past.set(k, mtText(h?.[hState])); }
  const wanted = [];
  queueRows.forEach((r, qi) => {
    const m = BIND_RE.exec(norm(r["Рішення"]).replace(/’|ʼ|`/g, "'"));
    if (m) wanted.push({ qi, row: r, target: m[1], confirmed: Boolean(m[2]) });
  });
  const done = [], refused = new Map();
  // Команди, уже записані в історію, не виконуються й не рахуються як «кілька позицій до одного товару».
  const fresh = wanted.filter((w) => {
    const was = past.get(w.target + "\u0000" + mtText(w.row["ID постачальника"]));
    if (was === undefined) return true;
    refused.set(w.qi, /^АКТИВНА/.test(was) ? "ПРИВ'ЯЗАНО РАНІШЕ (див. «Історія прив'язок»): повторно не виконується; рядок лишається в черзі до затвердження B6 (видалення рядків)"
      : "НЕ ПРИВ'ЯЗАНО: цю прив'язку скасовано власником («Історія прив'язок», стан «" + was + "») — команда в черзі її не відновлює");
    return false;
  });
  const perTarget = fresh.reduce((a, w) => ((a[w.target] = (a[w.target] || 0) + 1), a), {});
  for (const w of fresh) {
    const problems = [];
    const ti = mainById.get(w.target);
    const offerId = mtText(w.row["ID постачальника"]);
    const offer = offers.get(offerId);
    if (ti === undefined) problems.push(`товару ${w.target} немає в основному каталозі`);
    if (!offer) problems.push("цієї позиції зараз немає у фіді постачальника");
    if (perTarget[w.target] > 1) problems.push(`до товару ${w.target} прив'язують кілька позицій — залиште одну`);
    if (cc?.removed.has(w.target)) problems.push(`товар ${w.target} видалено (Catalog Controls) — прив'язка заборонена`);
    const g = cc ? gateFor(cc, { offer, row: w.row }) : null;
    if (g?.blocked) problems.push("позиція: " + g.reason);
    // Один ID постачальника — лише в однієї активної картки (основний каталог і відкладені, з урахуванням скасувань і прив'язок цього запуску).
    const owner = [...mainRows, ...deferredRows].find((r) => mtText(r["ID постачальника"]) === offerId && mtText(r["Offer ID"]) !== w.target);
    if (owner) problems.push(`ID постачальника вже використовує товар ${mtText(owner["Offer ID"])}`);
    const newSku = mtText(offer?.sku).trim();
    if (offer && !newSku) problems.push("у нової позиції немає артикулу — «Код товару Prom» не можна оновити");
    const skuOwner = newSku && mainRows.find((r) => mtText(r["Offer ID"]) !== w.target && (mtText(r["Код товару Prom"]).trim() === newSku || mtText(r["Артикул постачальника"]).trim() === newSku));
    if (skuOwner) problems.push(`артикул «${newSku}» уже використовує товар ${mtText(skuOwner["Offer ID"])}`);
    if (ti !== undefined) {
      const card = mainRows[ti];
      const oldId = mtText(card["ID постачальника"]);
      if (offers.has(oldId) && oldId !== offerId) problems.push(`стара позиція постачальника товару ${w.target} досі є у фіді — ймовірно, це різні товари`);
      const cmp = compareEntries(rowEntry(card, SHEET.main), queueEntry(w.row));
      const doubts = bindingDoubts(cmp);
      if (doubts.length && !w.confirmed) problems.push(`потрібна додаткова ручна перевірка (${doubts.join("; ")}) — якщо це точно той самий товар, напишіть «ПРИВ'ЯЗАТИ ДО ${w.target} (ПІДТВЕРДЖУЮ)»`);
      if (!problems.length) {
        done.push({ ...w, ti, offer, evidence: cmp.evidence.join(", ") + (doubts.length ? "; підтверджено власником попри: " + doubts.join("; ") : "") });
        // Одразу резервуємо ID і артикул, щоб наступна прив'язка цього ж запуску їх не взяла.
        const t = mainRows[ti];
        t["ID постачальника"] = offer.id; t["Артикул постачальника"] = newSku; t["Код товару Prom"] = newSku;
      }
    }
    if (problems.length) refused.set(w.qi, "НЕ ПРИВ'ЯЗАНО: " + problems.join("; "));
  }
  return { done, refused };
}

/** Застосування прив'язок до копій рядків + записи історії (старі значення — для відновлення). */
function applyBindings(bind, { mainRows, originals, stamp }) {
  const history = [];
  for (const b of bind.done) {
    const card = mainRows[b.ti];
    const before = originals[b.ti];
    for (const [k, f] of SUPPLIER_FIELDS) card[k] = k === "Артикул постачальника" ? mtText(b.offer.sku).trim() : b.offer[f] ?? "";
    card["Код товару Prom"] = mtText(b.offer.sku).trim(); // рішення власника: Код товару Prom = новий артикул постачальника
    card[SEAL_COLUMN] = rowSeal(card);
    history.push([stamp, b.target, mtText(before["ID постачальника"]), b.offer.id, mtText(before["Артикул постачальника"]), mtText(b.offer.sku).trim(),
      mtText(before["Код товару Prom"]), mtText(card["Код товару Prom"]), mtText(before["Назва постачальника UA"]), mtText(before["Назва постачальника RU"]), mtText(before["URL постачальника"]),
      b.offer.nameUa, b.offer.nameRu, b.offer.url, `рішення власника; збіг: ${b.evidence || "—"}`, "АКТИВНА", ""]);
  }
  return { history, changedMain: new Set(bind.done.map((b) => b.ti)) };
}

/**
 * Скасування прив'язки в будь-який момент: «СКАСУВАТИ» в колонці «Рішення» аркуша «Історія прив'язок».
 * Картка зберігає Offer ID і SEO; повертаються старі ID постачальника, артикул, «Код товару Prom», назви/URL постачальника.
 * Ціни й наявність НЕ відновлюються з історії — їх перераховує поточний XML за старим ID (немає — «немає в наявності»).
 */
function planUndos({ historyValues, mainRows, deferredRows, queueRows, offers, stamp, cc = null }) {
  const out = { undone: [], cells: [], changedMain: new Set(), reclaimedQueueIds: new Set() };
  if (!historyValues || historyValues.length < 2) return out;
  const h = historyValues[0].map(mtText);
  const col = (k) => h.indexOf(k);
  const mainById = new Map(mainRows.map((r, i) => [mtText(r["Offer ID"]), i]));
  historyValues.slice(1).forEach((r, k) => {
    const rowNo = k + 2;
    const state = mtText(r[col("Стан")]);
    // Активна прив'язка, а стара позиція постачальника знову у фіді — у чергу її не додаємо (той самий Offer ID), але попереджаємо тут.
    if (/^АКТИВНА/.test(state) && norm(r[col("Рішення")]) !== UNDO) {
      const warn = offers.has(mtText(r[col("Старий ID постачальника")]));
      const next = warn ? "АКТИВНА — УВАГА: стара позиція постачальника знову у фіді, перевірте прив'язку (за потреби — «СКАСУВАТИ»)" : "АКТИВНА";
      if (next !== state && (warn || /УВАГА/.test(state))) out.cells.push({ row: rowNo, state: next });
      return;
    }
    if (norm(r[col("Рішення")]) !== UNDO || !/^АКТИВНА/.test(state)) return;
    const offerId = mtText(r[col("Offer ID")]);
    const oldId = mtText(r[col("Старий ID постачальника")]);
    const ti = mainById.get(offerId);
    const problems = [];
    if (ti === undefined) problems.push("товару немає в основному каталозі");
    else if (cc?.removed.has(offerId)) problems.push("товар видалено (Catalog Controls) — скасування прив'язки не виконується");
    else if (mtText(mainRows[ti]["ID постачальника"]) !== mtText(r[col("Новий ID постачальника")])) problems.push("товар уже прив'язано до іншої позиції — спершу скасуйте новішу прив'язку");
    const owner = [...mainRows, ...deferredRows].find((x) => mtText(x["ID постачальника"]) === oldId && mtText(x["Offer ID"]) !== offerId);
    if (owner) problems.push(`старий ID постачальника тепер використовує товар ${mtText(owner["Offer ID"])}`);
    const oldSku = mtText(r[col("Старий артикул")]).trim(), oldCode = mtText(r[col("Старий Код товару Prom")]).trim();
    const codeOwner = oldCode && mainRows.find((x) => mtText(x["Offer ID"]) !== offerId && mtText(x["Код товару Prom"]).trim() === oldCode);
    if (codeOwner) problems.push(`старий «Код товару Prom» тепер використовує товар ${mtText(codeOwner["Offer ID"])}`);
    if (problems.length) { out.cells.push({ row: rowNo, state: "АКТИВНА — скасувати неможливо: " + problems.join("; ") }); return; }
    const card = mainRows[ti];
    card["ID постачальника"] = oldId;
    card["Артикул постачальника"] = oldSku;
    card["Код товару Prom"] = oldCode;
    card["Назва постачальника UA"] = mtText(r[col("Стара назва постачальника UA")]);
    card["Назва постачальника RU"] = mtText(r[col("Стара назва постачальника RU")]);
    card["URL постачальника"] = mtText(r[col("Старий URL постачальника")]);
    card[SEAL_COLUMN] = rowSeal(card);
    out.changedMain.add(ti);
    // Стара позиція могла тим часом потрапити в чергу як «нова» — картка її повертає, тож із черги її прибираємо.
    for (const q of queueRows) if (mtText(q["ID постачальника"]) === oldId) out.reclaimedQueueIds.add(mtText(q["Offer ID"]));
    out.undone.push({ offerId, oldId, newId: mtText(r[col("Новий ID постачальника")]) });
    out.cells.push({ row: rowNo, state: `СКАСОВАНА ${stamp}: повернуто ID постачальника ${oldId}; позицію ${mtText(r[col("Новий ID постачальника")])} повернуто в чергу` });
  });
  return out;
}

/**
 * Фаза 1: план без контенту нових позицій.
 *  book — { назва: values2D } (основний, черга, відкладені, заморожені, групи, паспорт, історія прив'язок);
 *  parsed — операційний розбір фіду (Map offers).
 */
/** ENG-28a: стан для товару, відсутнього у фіді з фільтром охоплення (внутрішній; у таблицю не пишеться). */
export const OUT_OF_SCOPE = "ПОЗА_ОХОПЛЕННЯМ_ФІДУ";
/** ENG-28c (рішення власника: три незалежні операції): queueMode "off" — «Оновити товари» не чіпає «Нові товари»: сирі дані черги не
 *  оновлюються, рішення черги (затвердження / відхилення / прив'язки / скасування) не виконуються (лише кількість у звіті), записів
 *  «Журналу» про чергу немає. Типово "full" — як раніше (застарілий комбінований --mode=sync і тести). */
/** ENG-29 (логіка власника 02.11): «Оновити товари» підготовлені характеристики не змінює (characteristics = "preserve"); якщо постачальник
 *  змінив свої характеристики (попередній ↔ новий стан «Характеристики постачальника JSON»), — попередження на товарі: які характеристики,
 *  було → стало, і наше значення тієї самої характеристики. Без ізоляції; товар лишається придатним до експорту. Перше заповнення сирої
 *  колонки — не зміна (М2). Повтор із тим самим сирим значенням — той самий ключ (нового попередження немає). */
export function supplierParamsWarning({ original, rawAfter, at, ctx }) {
  const before = parseParams(original[RAW_PARAMS]), after = parseParams(rawAfter);
  if (!mtText(original[RAW_PARAMS]).trim() || !before.ok || !after.ok) return null;
  const fmt = (p) => `${mtText(p.name).trim()}: ${[mtText(p.value).trim(), mtText(p.unit ?? "").trim()].filter(Boolean).join(" ")}`;
  const ours = parseParams(original[PARAMS_FIELD]);
  const was = [], now = [], mine = [];
  for (const k of new Set([...before.map.keys(), ...after.map.keys()])) {
    const a = before.map.get(k), b = after.map.get(k);
    if (a && b && fmt(a) === fmt(b)) continue;
    was.push(a ? fmt(a) : `${mtText(b.name).trim()}: (не було)`);
    now.push(b ? fmt(b) : `${mtText(a.name).trim()}: (прибрано)`);
    const o = ours.ok ? ours.map.get(k) : null;
    mine.push(o ? fmt(o) : `${mtText((a || b).name).trim()}: (у нас немає)`);
  }
  if (!was.length) return null;
  return { key: `${ctx.offerId}|${PARAMS_FIELD}|${hv(rawAfter)}`, at, offerId: ctx.offerId, sku: ctx.sku ?? "", name: ctx.name ?? "",
    field: `${PARAMS_FIELD} (змінено характеристик постачальника: ${was.length})`, before: was.join("; "), after: now.join("; "), custom: mine.join("; "), source: ctx.source ?? "постачальник" };
}

export function planSheetSync({ book, parsed, stamp, config, now, groupsRows, fullById = new Map(), catalog = null, controls = null, queueCommands = true, presenceColumns = false, feedScope = "full", queueMode = "full", resumeStateMigration = false }) {
  const queueOff = queueMode === "off";
  const cleanDescriptions = config.characteristics?.cleanDescriptions === true; // очищення сирої копії опису — окреме погодження
  const out = { abort: null, block: null, warnings: [], stats: {} };
  // Зупинка: зрозуміла причина + тип, кількість зачеплених товарів і поріг (для «Журналу»).
  const stop = (type, reason, affected = "", limit = "") => { out.abort = reason; out.block = { type, reason, affected, limit }; return out; };
  // FZ: кореневий контракт захисту або обов'язковий FZ недійсний — прохід НЕ ВИКОНАНО до будь-яких записів (FZ-HERMES-06).
  if (catalog?.guard?.blocked) return stop(guardType(catalog.guard), `прохід НЕ ВИКОНАНО: ${catalog.guard.reasons.join("; ")}; нічого не записано`);
  // Пріоритет власника (фінальні вимоги 29.10; Hermes CC4-REQ-MANUAL): паспорт / печатка — аудит, правки власника — field-control,
  // критична проблема одного товару — ізоляція лише його (owner-priority.mjs). Без прапорця — чинна прийнята поведінка.
  const op = ownerPriorityEnabled(config);
  // CC R6: у режимі пріоритету власника стан CC обов'язковий; недостовірний / відсутній — нічого не пишемо (fail-closed).
  const cc = op ? syncControls(controls) : null;
  if (op && (!cc || cc.blocked)) return stop("CATALOG CONTROLS НЕДОСТОВІРНИЙ", ccStop(cc));
  // ENG-28: колонки присутності у фіді постачальника — лише коли запуск їх застосовує («Оновити товари»).
  const main = readMain(book[SHEET.main], op ? { extra: presenceColumns ? [...OP_MAIN_COLUMNS, ...PRESENCE_COLUMNS] : OP_MAIN_COLUMNS } : undefined);
  const queueValues = book[SHEET.queue];
  const queueHeader = (queueValues?.[0] || []).map(mtText);
  if (QUEUE_EXTRA.some((k) => !queueHeader.includes(k))) return stop("ЧЕРГА НЕ ГОТОВА", "аркуш «Нові товари» ще не переведено в режим черги (немає колонок «Рішення/Перевірка/Виявлено») — спершу перенесення NEW92");
  const queue0 = readQueue(queueValues);
  // Варіант А: сирі дані постачальника черги — з поточного XML (SEO не змінюється); далі всі кроки — на оновлених рядках.
  // ENG-27 (N3): queueCommands:false (sync) — службові команди «ПЕРЕВІРЕНО» / «SEO ПОСТАЧАЛЬНИКА» не виконуються: виконати й спожити
  // їх атомарно може лише intake (cmd-consume); sync рішень власника не стирає, тож повторне виконання щозапуску затирало б пізніші правки.
  const refreshed = queueOff ? queue0.rows.map((r) => ({ row: { ...r }, entries: [], notes: [], recheck: [], changed: false, verified: false }))
    : queue0.rows.map((r) => refreshQueueRow(r, parsed.offers.get(mtText(r["ID постачальника"])), fullById.get(mtText(r["ID постачальника"])), { stamp, catalog, cleanDescriptions, commands: queueCommands }));
  const queue = { ...queue0, rows: refreshed.map((x) => x.row) };
  const deferred = book[SHEET.deferred] ? readSheet(book[SHEET.deferred], SHEET.deferred).rows : [];
  const frozenIds = new Set((book[SHEET.frozen] || []).slice(1).map((r) => mtText(r[0])).filter(Boolean));

  // 0. Паспорт: основний каталог не змінювали поза затвердженням/прив'язкою.
  const passport = readPassport(book[SHEET.passport]);
  if (!op && !passport) return stop("НЕМАЄ ПАСПОРТА", "немає «Паспорта каталогу» — запис заборонено");
  if (op) out.audit = { passportPresent: Boolean(passport), passportMatches: Boolean(passport) && samePassport(passport, approvalManifest(main.rows, groupsRows)), sealMismatch: main.rows.filter((r) => rowSeal(r) !== mtText(r[SEAL_COLUMN])).length };
  else if (!samePassport(passport, approvalManifest(main.rows, groupsRows))) {
    const badSeals = main.rows.filter((r) => rowSeal(r) !== mtText(r[SEAL_COLUMN])).length;
    return stop("ЗМІНИ ПОЗА ЗАТВЕРДЖЕННЯМ", `основний каталог не відповідає паспорту (рядків ${main.rows.length}/${passport.count}, змінених печаток ${badSeals}) — зміни поза затвердженням; нічого не записано`, badSeals || Math.abs(main.rows.length - passport.count), 0);
  }
  const ids = main.rows.map((r) => mtText(r["Offer ID"]));
  out.stats.before = { mainRows: main.rows.length, uniqueIds: new Set(ids).size, queueRows: queue.rows.length, passportCount: passport?.count ?? null };
  // Пріоритет власника: стан полів кожного рядка (міграція / виявлення правок) і ізоляція окремих товарів — до будь-яких змін.
  const migratingState = op && main.migrated.includes(STATE_COLUMN);
  // ENG-28d (F-28B-1, Hermes U3): перший прохід обірвано після запису заголовка (колонка стану вже є), до запису стану в рядки, —
  // рядки без стану продовжують ту саму міграцію (консервативно, hold), а не ізолюються як «додані вручну». Ознака — з контрольного
  // плану незавершеного запуску (resumeStateMigration), не з даних таблиці.
  const migrateRow = (r) => migratingState || (op && resumeStateMigration && !mtText(r[STATE_COLUMN]).trim());
  const opPrep = op ? main.rows.map((r) => prepareRow(r, { at: stamp, migrating: migrateRow(r) })) : null;
  const isolated = new Map(); // індекс рядка → причина (жодного запису в цей рядок у цьому запуску)
  opPrep?.forEach((p, i) => { if (p.isolate) isolated.set(i, p.isolate); });
  // Правило 5 (CC R6): видалений товар (tombstone CC, будь-яка стадія), чий рядок ще в «Основному каталозі», — жодного запису.
  if (cc) main.rows.forEach((r, i) => { if (cc.removed.has(mtText(r["Offer ID"]))) isolated.set(i, REMOVED_ISOLATION); });
  // Дії власника з аркуша попереджень: «Прийняти значення постачальника» → поле (або характеристика) знову S. Стан спершу
  // пишеться окремо (фаза 1 у sheet-sync-run), щоб «ворота стану» пропустили запис значення постачальника (фаза 2).
  const accepted = [], actionsSkipped = [];
  if (op) for (const a of [...pendingActions(book[WARN_SHEET]).map((x) => ({ ...x, sheet: WARN_SHEET })), ...pendingClassifications(book[CLASSIFY_SHEET])]) {
    const i = main.rows.findIndex((r) => mtText(r["Offer ID"]) === a.offerId);
    if (i < 0 || isolated.has(i) || !opPrep[i]?.state) { actionsSkipped.push({ ...a, reason: i < 0 ? "товару немає в основному каталозі" : "товар ізольовано або без стану" }); continue; }
    const next = a.decision === CLASSIFY.OURS ? markCustom(opPrep[i].state, a.field, a.param, stamp, "owner-classified") : acceptSupplier(opPrep[i].state, a.field, a.param, stamp);
    opPrep[i].state = { ...next, sid: opPrep[i].state.sid };
    accepted.push({ ...a, i, originalState: mtText(main.rows[i][STATE_COLUMN]) });
  }
  // Кілька рішень для одного товару — один проміжний стан (кумулятивний, після всіх дій товару).
  for (const a of accepted) a.intermediateState = stateCell(opPrep[a.i].state, main.rows[a.i]);

  // 1. Рішення власника, що змінюють картки: скасування прив'язок, потім нові прив'язки (на копіях рядків).
  const mainRows = main.rows.map((r) => ({ ...r }));
  // ENG-28c: queueMode "off" — прив'язки / скасування (рішення власника з черги) у «Оновити товари» не виконуються.
  const undo = queueOff ? { undone: [], cells: [], changedMain: new Set(), reclaimedQueueIds: new Set() }
    : planUndos({ historyValues: book[BINDINGS_SHEET], mainRows, deferredRows: deferred, queueRows: queue.rows, offers: parsed.offers, stamp, cc });
  const originals = mainRows.map((r) => ({ ...r })); // після скасувань, до прив'язок — «старі» значення для історії
  const bind = queueOff ? { done: [], refused: new Map() } : planBindings({ queueRows: queue.rows, mainRows, deferredRows: deferred, offers: parsed.offers, stamp, cc, historyValues: book[BINDINGS_SHEET] });
  Object.assign(bind, queueOff ? { history: [], changedMain: new Set() } : applyBindings(bind, { mainRows, originals, stamp }));
  // Остаточний запобіжник: жоден ID постачальника не належить двом карткам.
  // Пріоритет власника: ізольований рядок (ідентичність змінено поза системою) у перевірці не бере участі — він нічого не отримує.
  const supplierIds = [...mainRows.filter((_, i) => !isolated.has(i)), ...deferred].map((r) => mtText(r["ID постачальника"])).filter(Boolean);
  if (new Set(supplierIds).size !== supplierIds.length) return stop("КОНФЛІКТ ID ПОСТАЧАЛЬНИКА", "після рішень один ID постачальника належав би двом карткам — нічого не записано", supplierIds.length - new Set(supplierIds).size, 0);

  // 1б. Основний каталог: зміни постачальника під тим самим ID — автоматично (не для карток, змінених прив'язкою цього запуску).
  const skuOwners = new Map();
  for (const r of mainRows) for (const k of ["Артикул постачальника", "Код товару Prom"]) { const v = mtText(r[k]).trim(); if (v && !skuOwners.has(v)) skuOwners.set(v, mtText(r["Offer ID"])); }
  const skuInUse = (sku, self) => { const o = skuOwners.get(sku); return o && o !== self ? o : ""; };
  const mainRaw = { entries: [], changed: new Set(), identity: 0, photos: 0, params: 0, paramsHeld: 0 };
  // ENG-28b: звичайне оновлення (productionConfig) — характеристики основного каталогу зберігаються (A / B), перебудова — окремий етап C.
  const charMode = config.characteristics?.main === "preserve" ? "preserve" : "rebuild";
  const refreshAll = (cat) => mainRows.map((r, i) => {
    if (undo.changedMain.has(i) || bind.changedMain.has(i) || isolated.has(i)) return null;
    const sid = mtText(r["ID постачальника"]);
    return refreshMainRow(r, parsed.offers.get(sid), fullById.get(sid), { stamp, skuInUse, catalog: cat, ownerPriority: op, characteristics: charMode });
  });
  // FZ preflight — до звичайного оновлення й перерахунку печаток: будь-який блокер обов'язкового FZ-товару зупиняє весь прохід.
  const fzBlocks = [];
  for (const fid of catalog?.frozenIds || []) {
    const i = mainRows.findIndex((r) => mtText(r["Offer ID"]) === fid);
    if (i < 0) { fzBlocks.push(`${fid}: немає в основному каталозі`); continue; }
    // Прив'язка / скасування цього запуску змінили ідентичність після планування, а refreshAll такі рядки пропускає — лише BLOCK.
    if (undo.changedMain.has(i) || bind.changedMain.has(i)) { fzBlocks.push(`${fid}: змінено прив'язкою або її скасуванням у цьому запуску — потрібна нова ревізія FZ`); continue; }
    const sid = mtText(mainRows[i]["ID постачальника"]);
    const chk = frozenCheck(mainRows[i], parsed.offers.get(sid), fullById.get(sid), catalog.frozenFor(fid), catalog);
    if (chk.block) { if (op) isolated.set(i, "FZ: " + fzBlockText(chk.block)); else fzBlocks.push(fzBlockText(chk.block)); }
  }
  if (fzBlocks.length) return stop(FZ_BLOCK, `НЕ ВИКОНАНО — блокери збережених характеристик (${fzBlocks.length}): ${fzBlocks.join(" | ")}; нічого не записано`, fzBlocks.length, 0);
  let refreshedMain = refreshAll(catalog);
  if (op) refreshedMain = refreshedMain.map((m, i) => { if (m?.frozenBlock) { isolated.set(i, "FZ: " + fzBlockText(m.frozenBlock)); return null; } return m; });
  const lateFz = refreshedMain.filter((m) => m?.frozenBlock).map((m) => fzBlockText(m.frozenBlock));
  if (lateFz.length) return stop(FZ_BLOCK, `НЕ ВИКОНАНО — блокери збережених характеристик (${lateFz.length}): ${lateFz.join(" | ")}; нічого не записано`, lateFz.length, 0);
  // Масова зміна підготовлених характеристик (напр. щойно додано схеми) — не застосовується в цьому запуску;
  // сирі дані, ціни й наявність оновлюються як завжди. Ліміт можна підняти лише окремим погодженим запуском.
  const paramsLim = config.characteristics?.maxChangedRows ?? Math.max(200, Math.ceil(mainRows.length * 0.1));
  // ENG-28b: preserve — підготовлені характеристики не змінюються; запобіжник рахує зміни СИРИХ <param> постачальника (B): масова
  // зміна за активного FZ зупиняє весь прохід (як і раніше), без FZ — попередження; зміни лише фіксуються, не застосовуються.
  const supplierParamRows = refreshedMain.map((m, i) => (m?.rawParams ? i : -1)).filter((i) => i >= 0);
  out.supplierParamChanges = supplierParamRows.map((i) => ({ offerId: mtText(mainRows[i]["Offer ID"]), supplierId: mtText(mainRows[i]["ID постачальника"]), name: mtText(mainRows[i]["Назва UA"]) }));
  out.frozenPending = refreshedMain.map((m, i) => (m?.frozenPending ? mtText(mainRows[i]["Offer ID"]) : null)).filter(Boolean);
  out.characteristicsMode = charMode;
  const paramsMass = supplierParamRows.length > paramsLim;
  if (charMode === "preserve" && supplierParamRows.length > paramsLim) {
    if (catalog?.frozenInfo?.active) return stop(FZ_BLOCK, `НЕ ВИКОНАНО — МАСОВА ЗМІНА ХАРАКТЕРИСТИК ПОСТАЧАЛЬНИКА за активного FZ: ${supplierParamRows.length} товарів (поріг ${paramsLim}); схоже на помилку у фіді; нічого не записано`, supplierParamRows.length, paramsLim);
    out.warnings.push(`МАСОВА ЗМІНА ХАРАКТЕРИСТИК ПОСТАЧАЛЬНИКА: ${supplierParamRows.length} товарів (поріг ${paramsLim}) — зафіксовано, характеристики не змінено`);
  }
  const paramsChanged = refreshedMain.filter((m) => m?.params).length;
  if (paramsChanged > paramsLim) {
    // Активний FZ: обхід refreshAll(null) пройшов би без каталогу й оминув би збережені характеристики — весь прохід НЕ ВИКОНАНО
    // (FZ-HERMES-06). Поріг не змінюється, FZ-зміни рахуються в статистиці.
    if (catalog?.frozenInfo?.active) return stop(FZ_BLOCK, `НЕ ВИКОНАНО — МАСОВА ЗМІНА ХАРАКТЕРИСТИК за активного FZ: ${paramsChanged} товарів (поріг ${paramsLim}); обхід без каталогу характеристик оминув би збережені характеристики; нічого не записано`, paramsChanged, paramsLim);
    mainRaw.paramsHeld = paramsChanged;
    out.warnings.push(`МАСОВА ЗМІНА ХАРАКТЕРИСТИК: підготовлені характеристики змінились би в ${paramsChanged} товарах (поріг ${paramsLim}) — у цьому запуску не застосовано; сирі дані, ціни й наявність оновлено`);
    mainRaw.entries.push([stamp, SHEET.main, "", "ХАРАКТЕРИСТИКИ НЕ ЗАСТОСОВАНО", "", paramsChanged, `МАСОВА ЗМІНА ХАРАКТЕРИСТИК (поріг ${paramsLim}) — потрібне окреме погодження`]);
    refreshedMain = refreshAll(null);
  }
  // Пріоритет власника: керовані поля S → від постачальника, C → наші; попередження «було → стало»; стан і печатка рядка.
  const opOut = { warnings: [], rawChanged: 0, productsWithRawChanges: 0, migratedRows: opPrep ? opPrep.filter((p) => p.migrated).length : 0, uncertainty: [], migrationClasses: {}, editsDetected: 0 };
  if (op) {
    refreshedMain = refreshedMain.map((m, i) => {
      if (isolated.has(i) || undo.changedMain.has(i) || bind.changedMain.has(i)) return m;
      const original = mainRows[i];
      const f = finishRow({ original, refreshed: m?.changed ? m.row : original, state: opPrep[i].state, ctx: { offerId: mtText(original["Offer ID"]), sku: mtText(original["Артикул постачальника"]), name: mtText(original["Назва UA"]), source: "YML постачальника" }, at: stamp, hold: Boolean(opPrep[i].migrated) });
      // ENG-29: зміна характеристик постачальника (preserve) — попередження на товарі; при масовій зміні (понад поріг) — лише загальне.
      const pw = charMode === "preserve" && m?.rawParams && !paramsMass ? supplierParamsWarning({ original, rawAfter: m.row[RAW_PARAMS], at: stamp, ctx: { offerId: mtText(original["Offer ID"]), sku: mtText(original["Артикул постачальника"]), name: mtText(original["Назва UA"]), source: "YML постачальника" } }) : null;
      if (pw) f.warnings.push(pw);
      f.row[WARNING_MARK_COLUMN] = markCell(original[WARNING_MARK_COLUMN], f.warnings);
      f.row[SEAL_COLUMN] = rowSeal(f.row);
      opOut.warnings.push(...f.warnings); opOut.rawChanged += f.rawChanged.length; if (f.rawChanged.length) opOut.productsWithRawChanges++;
      opOut.editsDetected += opPrep[i].changes.length;
      if (opPrep[i].migrated) for (const x of opPrep[i].migrated) { opOut.migrationClasses[x.class] = (opOut.migrationClasses[x.class] || 0) + 1; if (x.class === "НЕВИЗНАЧЕНЕ") opOut.uncertainty.push({ offerId: mtText(original["Offer ID"]), ...x }); }
      const changed = Object.keys(f.row).some((k) => mtText(f.row[k]) !== mtText(original[k]));
      return changed ? { ...(m || { entries: [], identity: false, photos: false, params: false }), row: f.row, changed: true } : m;
    });
    // Прив'язка / її скасування змінили «ID постачальника» системою — оновити ідентичність у стані рядка.
    for (const i of [...undo.changedMain, ...bind.changedMain]) if (opPrep[i]?.state) mainRows[i][STATE_COLUMN] = stateCell({ ...opPrep[i].state, sid: mtText(mainRows[i]["ID постачальника"]) }, mainRows[i]);
  }
  refreshedMain.forEach((m, i) => {
    if (!m) return;
    mainRaw.entries.push(...m.entries);
    if (!m.changed) return;
    mainRows[i] = m.row;
    mainRaw.changed.add(i);
    if (m.identity) mainRaw.identity++;
    if (m.photos) mainRaw.photos++;
    if (m.params) mainRaw.params++;
  });
  {
    const an0 = config.policy?.anomaly || { maxNewlyMissing: 50, maxNewlyMissingRatio: 0.02 };
    const lim = Math.max(an0.maxNewlyMissing, Math.ceil(mainRows.length * an0.maxNewlyMissingRatio));
    const photoLim = Math.max(200, Math.ceil(mainRows.length * 0.1));
    out.stats.mainRaw = { changed: mainRaw.changed.size, identity: mainRaw.identity, photos: mainRaw.photos, params: mainRaw.params, paramsHeld: mainRaw.paramsHeld, migratedColumns: main.migrated.length, characteristics: charMode, supplierParams: out.supplierParamChanges.length, frozenPending: out.frozenPending.length };
    // Захист від помилкового фіду: масова зміна назв / артикулів або фото — нічого не пишемо.
    if (mainRaw.identity > lim) return stop("МАСОВА ЗМІНА ДАНИХ ПОСТАЧАЛЬНИКА", `назви / артикул змінились у ${mainRaw.identity} товарів основного каталогу (поріг ${lim}) — схоже на помилку у фіді; нічого не записано`, mainRaw.identity, lim);
    if (mainRaw.photos > photoLim) return stop("МАСОВА ЗМІНА ФОТО", `фото змінились у ${mainRaw.photos} товарів основного каталогу (поріг ${photoLim}) — схоже на помилку у фіді; нічого не записано`, mainRaw.photos, photoLim);
  }

  // 2. Ціни й наявність (точний порт mtPlan) — на картках уже з урахуванням прив'язок і даних постачальника.
  const mainPlan = planRows(mainRows, parsed.offers, stamp, config.pricing);
  // Ізольований товар: ціни й наявність не змінюються в цьому запуску (жодного запису в рядок).
  for (const i of isolated.keys()) mainPlan[i] = { ...mainPlan[i], next: mainPlan[i].before.slice() };
  const queuePlan = planRows(queue.rows, parsed.offers, stamp, config.pricing);
  // ENG-28a: фід із фільтром охоплення (group_ids тощо) — відсутній у ньому товар може бути поза охопленням: наявність, ціни й стан
  // синхронізації НЕ змінюються (не D1 «немає в наявності»), у масові зникнення не рахується.
  if (feedScope !== "full") for (const p of [mainPlan, queuePlan]) p.forEach((x, i) => { if (x.match === MATCH.MISSING) p[i] = { ...x, next: x.before.slice(), match: OUT_OF_SCOPE }; });
  // ENG-28a: рядки черги, що чекають перенесення NEW92 або вже перенесені (ID в основному каталозі), — без змін цін / наявності.
  const mainIdSet = new Set(ids);
  const queueFrozen = (i) => mtText(queue0.rows[i]["Перевірка"]).startsWith(PENDING_TRANSFER_MARK) || mainIdSet.has(mtText(queue0.rows[i]["Offer ID"]));
  queuePlan.forEach((x, i) => { if (queueOff || queueFrozen(i)) queuePlan[i] = { ...x, next: x.before.slice() }; });
  out.stats.outOfFeedScope = feedScope !== "full" ? mainPlan.filter((p) => p.match === OUT_OF_SCOPE).length : 0;
  const missing = mainPlan.filter((p) => p.match === MATCH.MISSING).length;
  const an = config.policy?.anomaly || { maxNewlyMissing: 50, maxNewlyMissingRatio: 0.02 };
  const limit = Math.max(an.maxNewlyMissing, Math.ceil(mainRows.length * an.maxNewlyMissingRatio));
  // ENG-28b (рішення власника 01.11): аномальне ЗНИКНЕННЯ — менший із «50» і «2 %» каталогу, при досягненні; лише товари в доведено
  // порівнюваному охопленні (фільтрований фід відсутніх не рахує — вони OUT_OF_SCOPE). Пороги масової зміни наявності — як були.
  const missingLimit = holdLimit({ maxGoneAbsolute: an.maxNewlyMissing, maxGoneRatio: an.maxNewlyMissingRatio }, mainRows.length);
  const diff = (k) => mainPlan.filter((p) => mtText(p.before[LIVE_COLUMNS.indexOf(k)]) !== mtText(p.next[LIVE_COLUMNS.indexOf(k)])).length;
  const becameAvailable = mainPlan.filter((p) => p.before[4] !== "+" && p.next[4] === "+").length;
  const becameUnavailable = mainPlan.filter((p) => p.before[4] === "+" && p.next[4] !== "+").length;
  out.stats.main = {
    rows: mainRows.length, match: tally(mainPlan.map((p) => p.match)), changedCells: changeEntries(stamp, SHEET.main, mainPlan).filter((e) => e[3] !== "ПОМИЛКА").length,
    supplierPriceChanged: diff("Ціна постачальника"), salePriceChanged: diff("Ціна кінцева"), availabilityChanged: diff("Наявність"),
    becameAvailable, becameUnavailable, quantityChanged: diff("Кількість постачальника"), missingInFeed: missing,
    // ENG-29: скільки товарів змінено цим запуском (ціни / наявність / кількість або дані постачальника в рядку) — для підсумку власнику.
    // «Оновлено» (час успішного оновлення) змінюється в кожному рядку щоразу — це не зміна товару; не рахується.
    changedProducts: new Set([...mainPlan.map((p, i) => (p.before.some((v, j) => LIVE_COLUMNS[j] !== "Оновлено" && mtText(v) !== mtText(p.next[j])) ? i : -1)).filter((i) => i >= 0), ...mainRaw.changed]).size,
  };
  // Захист від пошкодженого/помилкового фіду: масове зникнення або масова зміна наявності — нічого не пишемо.
  if (missing > 0 && missing >= missingLimit) return stop("МАСОВЕ ЗНИКНЕННЯ", `зникло ${missing} товарів основного каталогу (поріг ${missingLimit}) — схоже на збій постачальника; нічого не записано`, missing, missingLimit);
  if (becameUnavailable > limit) return stop("МАСОВА ЗМІНА НАЯВНОСТІ", `«немає в наявності» стало ${becameUnavailable} товарів (поріг ${limit}) — схоже на помилку у фіді постачальника; нічого не записано`, becameUnavailable, limit);
  if (becameAvailable > limit) return stop("МАСОВА ЗМІНА НАЯВНОСТІ", `«в наявності» стало ${becameAvailable} товарів (поріг ${limit}) — схоже на помилку у фіді постачальника; нічого не записано`, becameAvailable, limit);

  // 3. Нові позиції: ID постачальника, якого немає в жодній картці/черзі/відкладених і не заморожений.
  const archived = archivedRows(book); // видалені товари — відомі: постачальник не поверне їх у «Нові товари»
  const knownSupplierIds = new Set([...mainRows, ...queue.rows, ...deferred, ...archived].map((r) => mtText(r["ID постачальника"])));
  // Також за Offer ID: позиція, чий ID уже є як Offer ID у будь-якому аркуші (напр. після ручної правки «ID постачальника»), не дублюється.
  const knownOfferIds = new Set([...mainRows, ...queue.rows, ...deferred, ...archived].map((r) => mtText(r["Offer ID"])));
  for (const id of cc?.removed || []) { knownSupplierIds.add(id); knownOfferIds.add(id); } // видалені (CC) — не кандидати
  const unknown = [...parsed.offers.values()].filter((o) => !knownSupplierIds.has(o.id) && !knownOfferIds.has(o.id) && !frozenIds.has(o.id));
  const frozenFlag = frozenFlags({ mainRows, parsed, frozenIds, knownSupplierIds });
  // Погоджено 22.10.2026: синхронізація НЕ додає новинок — лише GitHub intake для ID, стабільність яких підтвердив «Сторож новинок».
  // Worker / KV недоступні — новинки лишаються кандидатами; ціни й наявність затверджених товарів оновлюються як завжди.
  out.newIds = [];
  out.candidatesInFeed = unknown.length + frozenFlag.size;
  out.frozenFlag = frozenFlag;
  out.frozenSimilar = { inFeed: [...parsed.offers.keys()].filter((id) => frozenIds.has(id) && !knownSupplierIds.has(id)).length, flagged: frozenFlag.size };

  // 4. Рішення власника в черзі (на рядках з уже оновленими цінами/наявністю); схожість перераховується щоразу.
  const groupsById = new Map(groupsRows.map((g) => [mtText(g["Ідентифікатор_групи"]), { ua: mtText(g["Назва_групи_укр"]), ru: mtText(g["Назва_групи"]) }]));
  const groupIds = new Set(groupsById.keys());
  const mainIds = new Set(ids);
  const index = dupIndexFor({ mainRows, queueRows: queue.rows, deferredRows: deferred, offers: parsed.offers });
  const auditTypes = auditMarks(book[AUDIT_SHEET]);
  out.auditTypes = auditTypes;
  const approve = [], reject = [], keep = [], bound = [], reclaimed = [];
  const mainIdsBefore = new Set(ids), decisionRefused = []; // ENG-28 (N4)
  // ENG-28c: queueMode "off" — черга лишається як є; рішення власника, які виконала б стара синхронізація, лише рахуються у звіті.
  const pendingDecisions = queueOff ? queue0.rows.filter((r) => { const d = norm(r["Рішення"]); return d && !mainIdsBefore.has(mtText(r["Offer ID"])) && !mtText(r["Перевірка"]).startsWith(PENDING_TRANSFER_MARK) && (d === DECISION.APPROVE || d === DECISION.APPROVE_NOT_DUP || d === DECISION.REJECT || BIND_RE.test(d.replace(/’|ʼ|`/g, "'"))); }).length : 0;
  if (queueOff) {
    keep.push(...queue0.rows.map((r) => ({ ...r })));
    // ENG-28 (N4) у «Оновити товари»: «ВІДХИЛЕНО» вже перенесеного товару не виконується (тут не виконується жодне рішення) —
    // відмова з поясненням лише у звіті запуску (черга не змінюється).
    for (const r of queue0.rows) {
      const qid = mtText(r["Offer ID"]);
      if (mtText(r["Перевірка"]).startsWith(PENDING_TRANSFER_MARK) || !mainIdsBefore.has(qid) || norm(r["Рішення"]) !== DECISION.REJECT) continue;
      decisionRefused.push({ offerId: qid, decision: mtText(r["Рішення"]), reason: "НЕ ВІДХИЛЕНО: товар уже в «Основному каталозі» (рішення виконано раніше) — зняти з продажу або видалити лише через Catalog Controls; у «Заморожені ID» не додано" });
    }
  } else queue.rows.forEach((r, i) => {
    const updated = { ...r };
    const rq = refreshed[i];
    LIVE_COLUMNS.forEach((k, j) => { updated[k] = queuePlan[i].next[j]; });
    const decision = norm(r["Рішення"]);
    const cands = findDuplicates(index, queueEntry(r));
    const g = cc ? gateFor(cc, { offer: parsed.offers.get(mtText(r["ID постачальника"])), row: r }) : null;
    const dup = [dupNote(cands, { frozen: frozenIds.has(mtText(r["ID постачальника"])) }), g ? (g.blocked ? "ВИДАЛЕНИЙ ТОВАР: " : "СХОЖИЙ НА ВИДАЛЕНИЙ: ") + g.reason : ""].filter(Boolean).join(" ");
    if (bind.done.some((b) => b.qi === i)) { bound.push(updated); return; }
    if (undo.reclaimedQueueIds.has(mtText(r["Offer ID"]))) { reclaimed.push(updated); return; } // картка повернула собі цей ID постачальника
    // ENG-28 (Hermes ENG-27 N4): рішення вже виконано (рядок лишається в черзі — B6), власник змінив його пізніше.
    //  - товар уже в «Основному каталозі» (затверджено / перенесено раніше): «ВІДХИЛЕНО» не виконується (у «Заморожені» не додається,
    //    картка лишається) — зняти / видалити лише через Catalog Controls; без рішення — рядок «ПЕРЕНЕСЕНО», дані черги не оновлюються;
    //  - ID у «Заморожених ID» (відхилено раніше), а тепер «ЗАТВЕРДЖЕНО» — не переноситься (крім позначених схожими на зниклу картку).
    const qid = mtText(r["Offer ID"]);
    // ENG-28a: рядок NEW92 чекає перенесення (міграція структури) — без змін (рядок і печатка — як у NEW92).
    if (mtText(queue0.rows[i]["Перевірка"]).startsWith(PENDING_TRANSFER_MARK)) { keep.push({ ...queue0.rows[i] }); return; }
    if (mainIdsBefore.has(qid)) {
      const kept = { ...queue0.rows[i] };
      if (decision === DECISION.REJECT) {
        const why = "НЕ ВІДХИЛЕНО: товар уже в «Основному каталозі» (рішення виконано раніше) — зняти з продажу або видалити лише через Catalog Controls; у «Заморожені ID» не додано";
        decisionRefused.push({ offerId: qid, decision: mtText(r["Рішення"]), reason: why });
        kept["Перевірка"] = why;
      } else kept["Перевірка"] = "ПЕРЕНЕСЕНО: товар уже в «Основному каталозі»; рядок черги чекає рішення B6 (видалення рядків)" + (decision && decision !== DECISION.APPROVE && decision !== DECISION.APPROVE_NOT_DUP ? `; «Рішення» «${mtText(r["Рішення"])}» не виконується` : "");
      keep.push(kept); return;
    }
    if ((decision === DECISION.APPROVE || decision === DECISION.APPROVE_NOT_DUP) && frozenIds.has(qid) && !frozenFlag.has(qid)) {
      const why = "НЕ ПЕРЕНЕСЕНО: ID у «Заморожених ID» (відхилено раніше) — рішення змінено після виконання; потрібне окреме рішення власника";
      decisionRefused.push({ offerId: qid, decision: mtText(r["Рішення"]), reason: why });
      updated["Перевірка"] = withNonProduct(queueEntryNote(rq, [[dup, why].filter(Boolean).join(" ")]), nonProductReason(updated, auditTypes));
      keep.push(updated); return;
    }
    if (decision === DECISION.REJECT) { reject.push(updated); return; }
    if (bind.refused.has(i)) updated["Перевірка"] = [dup, bind.refused.get(i)].filter(Boolean).join(" ");
    else if (decision === DECISION.APPROVE || decision === DECISION.APPROVE_NOT_DUP) {
      // «(НЕ ДУБЛЬ)» обов'язкове лише при схожості з товаром основного каталогу або оцінці «ймовірно той самий».
      const blocking = cands.some((c) => c.sheet === SHEET.main || c.level === "ЙМОВІРНО ТОЙ САМИЙ") || Boolean(g && !g.blocked);
      const problems = approvalProblems(updated, { groupIds, mainIds, dupFlag: blocking });
      if (g?.blocked) problems.unshift(g.reason); // S5: видалений товар (той самий ID, новий ID, конфлікт ID) — не затверджується
      if (!problems.length) {
        const mr = toMainRow(updated, groupsById);
        if (op) {
          // «Код товару Prom» нового товару: за замовчуванням Offer ID (порожній або системне значення = артикул постачальника);
          // код, введений власником у черзі, зберігається.
          const code = mtText(mr["Код товару Prom"]).trim();
          if (!code || code === mtText(mr["Артикул постачальника"]).trim()) { mr["Код товару Prom"] = mtText(mr["Offer ID"]); mr[SEAL_COLUMN] = rowSeal(mr); }
          mr[STATE_COLUMN] = stateCell(approvalState(mr, stamp), mr); mr[WARNING_MARK_COLUMN] = "";
        }
        approve.push(mr); mainIds.add(mtText(r["Offer ID"])); return;
      }
      updated["Перевірка"] = [dup, "НЕ ПЕРЕНЕСЕНО: " + problems.join("; ")].filter(Boolean).join(" ");
    } else if (isStateCommand(decision)) {
      updated["Перевірка"] = dup; // службову команду не прийнято — причина в rq.notes
    } else if (decision) {
      updated["Перевірка"] = [dup, `невідоме «Рішення»: «${mtText(r["Рішення"])}» (можна: ${DECISION.APPROVE}, ${DECISION.APPROVE_NOT_DUP}, ${DECISION.REJECT}, ПРИВ'ЯЗАТИ ДО <Offer ID>)`].filter(Boolean).join(" ");
    } else if (queuePlan[i].match !== MATCH.OK) {
      updated["Перевірка"] = [dup, "зараз не зіставлено з постачальником: " + queuePlan[i].match].filter(Boolean).join(" ");
    } else updated["Перевірка"] = dup;
    updated["Перевірка"] = withNonProduct(queueEntryNote(rq, [updated["Перевірка"]]), nonProductReason(updated, auditTypes));
    keep.push(updated);
  });
  out.main = { start: main.start, header: main.header, migrated: main.migrated, plan: mainPlan, rows: mainRows, changedRows: new Set([...undo.changedMain, ...bind.changedMain, ...mainRaw.changed]) };
  out.queue = { header: queue.header, migrated: queueOff ? [] : queue.migrated, keep, approve, reject, bound, reclaimed, planRowsByIndex: queuePlan, decisionRefused, mode: queueOff ? "off" : "full", pendingDecisions };
  out.bindings = { history: bind.history, done: bind.done.length, refused: bind.refused.size, undoCells: undo.cells, undone: undo.undone.length, undoneList: undo.undone };
  out.deferredRows = deferred;
  // ENG-28c: «поза охопленням фіду» — нейтральний стан (не помилка): щозапускового «ПОМИЛКА ПОЗА_ОХОПЛЕННЯМ_ФІДУ» в «Журналі» немає.
  const notScopeError = (e) => !(e[3] === "ПОМИЛКА" && e[6] === OUT_OF_SCOPE);
  out.journal = [...mainRaw.entries, ...changeEntries(stamp, SHEET.main, mainPlan).filter(notScopeError), ...(queueOff ? [] : [...refreshed.flatMap((x) => x.entries), ...changeEntries(stamp, SHEET.queue, queuePlan).filter(notScopeError)])];
  out.stats.queueRaw = { changed: refreshed.filter((x) => x.changed).length, recheck: refreshed.filter((x) => x.recheck.length).length, verified: refreshed.filter((x) => x.verified).length, migratedColumns: queue.migrated.length };
  // «Сторож новинок»: видалені (CC) — відомі ID, Worker їх не пропонує.
  out.ackInput = { mainRows, deferredRows: [...deferred, ...archived, ...[...(cc?.removed || [])].map((id) => ({ "Offer ID": id, "ID постачальника": id }))], frozenIds, frozenFlag };
  out.passportBefore = passport;
  if (op) {
    out.ownerPriority = { isolated: [...isolated].map(([i, reason]) => ({ offerId: mtText(mainRows[i]["Offer ID"]), reason })), isolatedIndexes: new Set(isolated.keys()), ...opOut, accepted, actionsSkipped, removedInMain: [...isolated.values()].filter((x) => x === REMOVED_ISOLATION).length };
    for (const w of opOut.warnings) out.journal.push([stamp, SHEET.main, w.offerId, w.field, jv(w.before), jv(w.after), "ПОПЕРЕДЖЕННЯ ПОСТАЧАЛЬНИКА: наше значення збережено («" + jv(w.custom).slice(0, 200) + "»)"]);
    for (const x of out.ownerPriority.isolated) out.journal.push([stamp, SHEET.main, x.offerId, "ІЗОЛЬОВАНО", "", "", x.reason]);
  }
  out.catalog = catalog;
  out.stats.queue = { rows: queue.rows.length, approve: approve.length, reject: reject.length, keep: keep.length, bound: bound.length, newIds: 0, candidatesInFeed: out.candidatesInFeed };
  return out;
}

/** Фаза 2: підсумкова черга (лишені + нові з оригінальним контентом, з перевіркою схожості) і новий паспорт. */
export function finalizeSheetSync(plan, { parsed, fullById, stamp, config, groupsRows, journalSummary }) {
  const newRows = plan.newIds.map((id) => candidateRow(parsed.offers.get(id), fullById.get(id), stamp, config.pricing, plan.catalog));
  // Схожість нових — проти карток, черги (включно з іншими новими) і відкладених, з фото й характеристиками постачальника.
  const index = dupIndexFor({ mainRows: plan.main.rows, queueRows: [...plan.queue.keep, ...newRows], deferredRows: plan.deferredRows, offers: parsed.offers });
  let possibleDuplicates = 0;
  for (const r of newRows) {
    const note = dupNote(findDuplicates(index, queueEntry(r)), { frozen: plan.frozenFlag.has(mtText(r["Offer ID"])) });
    if (/^МОЖЛИВИЙ ДУБЛЬ/.test(note)) possibleDuplicates++;
    r["Перевірка"] = withNonProduct([note, r["Перевірка"]].filter(Boolean).join(" "), nonProductReason(r, plan.auditTypes));
  }
  const queueRows = [...plan.queue.keep, ...newRows];
  const queueValues = queueRows.map((r) => plan.queue.header.map((k) => (r[k] == null ? "" : r[k])));
  const mainRowsAfter = [...plan.main.rows.map((r, i) => { const x = { ...r }; LIVE_COLUMNS.forEach((k, j) => { x[k] = plan.main.plan[i].next[j]; }); return x; }), ...plan.queue.approve];
  const passportAfter = approvalManifest(mainRowsAfter, groupsRows);
  const entries = plan.journal.slice();
  for (const r of plan.queue.approve) entries.push([stamp, SHEET.main, mtText(r["Offer ID"]), "ЗАТВЕРДЖЕНО", SHEET.queue, SHEET.main, "ДОЗВОЛЕНО"]);
  for (const r of plan.queue.reject) entries.push([stamp, SHEET.queue, mtText(r["Offer ID"]), "ВІДХИЛЕНО", "", SHEET.frozen, "ВІДХИЛЕНО"]);
  for (const h of plan.bindings.history) entries.push([stamp, SHEET.main, h[1], "ПРИВ'ЯЗАНО", h[2], h[3], "РІШЕННЯ ВЛАСНИКА"]);
  for (const u of plan.bindings.undoneList || []) entries.push([stamp, SHEET.main, u.offerId, "ВІДВ'ЯЗАНО", u.newId, u.oldId, "РІШЕННЯ ВЛАСНИКА"]);
  for (const r of plan.queue.reclaimed || []) entries.push([stamp, SHEET.queue, mtText(r["Offer ID"]), "ПОВЕРНУТО КАРТЦІ", "", SHEET.main, "СКАСУВАННЯ ПРИВ'ЯЗКИ"]);
  for (const r of newRows) entries.push([stamp, SHEET.queue, mtText(r["Offer ID"]), "НОВИЙ", "", "", /МОЖЛИВИЙ ДУБЛЬ/.test(r["Перевірка"]) ? "МОЖЛИВИЙ ДУБЛЬ" : STATUS_NEW]);
  entries.push([stamp, "СИСТЕМА", "", "ЗАВЕРШЕНО", "", parsed.count, JSON.stringify({ mode: "ОНОВЛЕННЯ", system: "НОВА СИСТЕМА (S1, тестова копія)", feedDate: parsed.date, offers: parsed.count, changes: entries.length, ...journalSummary })]);
  return { queueValues, newRows, passportAfter, journal: entries, mainCountAfter: mainRowsAfter.length, possibleDuplicates };
}

/**
 * GitHub intake (погоджено 22.10.2026): лише черга «Нові товари». Основний каталог, паспорт, YML — не змінюються.
 *  ready — кандидати, стабільність яких підтвердив «Сторож новинок»: [{ id, fp, firstSeen, lastChange, fullFp? }].
 *  Кожен повторно перевіряється за ПОВНИМ XML (verifyReady): ≥10 хв без змін, той самий відбиток, повні дані.
 *  Рішення власника (затвердження, відхилення, прив'язки) тут не обробляються — лише під час синхронізації.
 */
export function planIntake({ book, parsed, fullById, stamp, config, now, ready = [], profile = "medium", catalog = null, controls = null, feedScope = "full" }) {
  const cleanDescriptions = config.characteristics?.cleanDescriptions === true;
  const rules = { ...INTAKE_RULES, ...(config.intake || {}) };
  const out = { abort: null, block: null, warnings: [], stats: {}, results: {} };
  const stop = (type, reason) => { out.abort = reason; out.block = { type, reason, affected: "", limit: "" }; return out; };
  if (catalog?.guard?.blocked) return stop(guardType(catalog.guard), `прохід НЕ ВИКОНАНО: ${catalog.guard.reasons.join("; ")}; нічого не записано`);
  // CC R6 S5: у режимі пріоритету власника — лише з достовірним станом CC (blocked → новинок не приймати).
  const cc = ownerPriorityEnabled(config) ? syncControls(controls) : null;
  if (ownerPriorityEnabled(config) && (!cc || cc.blocked)) return stop("CATALOG CONTROLS НЕДОСТОВІРНИЙ", ccStop(cc));
  const queueValues = book[SHEET.queue];
  const queueHeader = (queueValues?.[0] || []).map(mtText);
  if (QUEUE_EXTRA.some((k) => !queueHeader.includes(k))) return stop("ЧЕРГА НЕ ГОТОВА", "аркуш «Нові товари» ще не переведено в режим черги");
  const main = readSheet(book[SHEET.main], SHEET.main);
  const queue0 = readQueue(queueValues);
  const deferred = book[SHEET.deferred] ? readSheet(book[SHEET.deferred], SHEET.deferred).rows : [];
  const frozenIds = new Set((book[SHEET.frozen] || []).slice(1).map((r) => mtText(r[0])).filter(Boolean));
  const auditTypes = auditMarks(book[AUDIT_SHEET]);

  // ENG-28a: рядки, що чекають перенесення NEW92 або вже перенесені (ID в основному каталозі), intake не оновлює.
  const mainIdsI = new Set(main.rows.map((r) => mtText(r["Offer ID"])));
  const frozenQ = (r) => mtText(r["Перевірка"]).startsWith(PENDING_TRANSFER_MARK) || mainIdsI.has(mtText(r["Offer ID"]));
  const refreshed = queue0.rows.map((r) => (frozenQ(r) ? { row: { ...r }, entries: [], notes: [], recheck: [], changed: false, verified: false } : refreshQueueRow(r, parsed.offers.get(mtText(r["ID постачальника"])), fullById.get(mtText(r["ID постачальника"])), { stamp, catalog, cleanDescriptions })));
  const qRows = refreshed.map((x) => x.row);
  // ENG-28c: фід із фільтром охоплення — відсутній рядок черги поза охопленням: без змін і без «ПОМИЛКА» (нейтральний стан).
  const queuePlan = planRows(qRows, parsed.offers, stamp, config.pricing).map((p, i) => (frozenQ(queue0.rows[i]) ? { ...p, next: p.before.slice() }
    : feedScope !== "full" && p.match === MATCH.MISSING ? { ...p, next: p.before.slice(), match: OUT_OF_SCOPE } : p));
  const kept = qRows.map((r, i) => { const x = { ...r }; LIVE_COLUMNS.forEach((k, j) => { x[k] = queuePlan[i].next[j]; }); return x; });

  const archivedI = archivedRows(book); // видалені товари — не новинки
  const knownSupplierIds = new Set([...main.rows, ...qRows, ...deferred, ...archivedI].map((r) => mtText(r["ID постачальника"])));
  const knownOfferIds = new Set([...main.rows, ...qRows, ...deferred, ...archivedI].map((r) => mtText(r["Offer ID"])));
  const frozenFlag = frozenFlags({ mainRows: main.rows, parsed, frozenIds, knownSupplierIds });
  const similarNote = new Map();
  const maxNew = config.queue?.maxNewPerRun ?? 300;
  const newRows = [];
  for (const e of ready) {
    const id = mtText(e?.id);
    if (!/^\d+$/.test(id)) continue;
    if (knownSupplierIds.has(id) || knownOfferIds.has(id)) { out.results[id] = { status: "ВЖЕ Є" }; continue; } // повторний запуск — без дубля
    if (frozenIds.has(id) && !frozenFlag.has(id)) { out.results[id] = { status: "ВІДМОВА", reason: "ID у «Заморожених»" }; continue; }
    if (newRows.length >= maxNew) { out.results[id] = { status: "ВІДМОВА", reason: `ліміт ${maxNew} нових за запуск` }; continue; }
    const offer = parsed.offers.get(id), full = fullById.get(id);
    // S5: той самий видалений товар (за ID, під новим ID або конфлікт ID) — не додається; схожий — позначка в «Перевірці».
    const g = cc ? gateFor(cc, { offer: offer || { id } }) : null;
    if (g?.blocked) { out.results[id] = { status: "ВИДАЛЕНИЙ ТОВАР", kind: g.kind, reason: g.reason }; continue; }
    const raw = offer && full ? rawFromOffer(offer, full) : null;
    const v = verifyReady(e, raw, now, { rules, profile });
    if (!v.ok) { out.results[id] = { status: "ВІДМОВА", reason: v.reason, ...(v.fullFp ? { fullFp: v.fullFp } : {}) }; continue; }
    const row = candidateRow(offer, full, stamp, config.pricing, catalog);
    const iso = (t) => (Number.isFinite(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : stamp);
    row["Виявлено"] = iso(e.firstSeen);
    row["Остання зміна постачальника"] = iso(e.lastChange);
    row["SHA даних постачальника"] = row["Погоджено для SHA"] = sheetFingerprint(raw);
    row["SHA SEO при додаванні"] = seoHash(row);
    if (g) similarNote.set(id, "СХОЖИЙ НА ВИДАЛЕНИЙ: " + g.reason);
    newRows.push(row);
    knownSupplierIds.add(id); knownOfferIds.add(id);
    out.results[id] = { status: "ДОДАНО" };
  }

  // Схожість — за АКТУАЛЬНИМИ даними (оновлені рядки черги + нові).
  const index = dupIndexFor({ mainRows: main.rows, queueRows: [...kept, ...newRows], deferredRows: deferred, offers: parsed.offers });
  kept.forEach((r, i) => {
    const rq = refreshed[i];
    // Без змін — «Перевірку» лишаємо (рішення обробить синхронізація). Змінились сирі поля (також у рядку, доданому
    // до запуску контролю, де перший прохід лише ставить базову SHA) — схожість перераховується за новими даними.
    if (!rq.changed && !rq.verified && !rq.recheck.length && !rq.notes.length && !rq.entries.some((e) => e[6] !== "РІШЕННЯ ВЛАСНИКА")) return;
    const dup = dupNote(findDuplicates(index, queueEntry(r)), { frozen: frozenIds.has(mtText(r["ID постачальника"])) });
    r["Перевірка"] = withNonProduct(queueEntryNote(rq, [dup]), nonProductReason(r, auditTypes));
  });
  let possibleDuplicates = 0;
  for (const r of newRows) {
    const note = dupNote(findDuplicates(index, queueEntry(r)), { frozen: frozenFlag.has(mtText(r["Offer ID"])) });
    if (/^МОЖЛИВИЙ ДУБЛЬ/.test(note)) possibleDuplicates++;
    r["Перевірка"] = withNonProduct([note, similarNote.get(mtText(r["ID постачальника"])), r["Перевірка"]].filter(Boolean).join(" "), nonProductReason(r, auditTypes));
  }
  const rows = [...kept, ...newRows];
  out.queue = { header: queue0.header, migrated: queue0.migrated, values: rows.map((r) => queue0.header.map((k) => (r[k] == null ? "" : r[k]))) };
  out.newRows = newRows;
  // ENG-28c: рядки, які intake не веде (чекають перенесення / уже в основному каталозі), і «поза охопленням» — без записів «Журналу»
  // (раніше щозапускова «ПОМИЛКА» перенесених поза охопленням фіду ще й змушувала intake писати).
  const frozenIdsQ = new Set(queue0.rows.filter(frozenQ).map((r) => mtText(r["Offer ID"])));
  const entries = [...refreshed.flatMap((x) => x.entries), ...changeEntries(stamp, SHEET.queue, queuePlan).filter((e) => !frozenIdsQ.has(mtText(e[2])) && !(e[3] === "ПОМИЛКА" && e[6] === OUT_OF_SCOPE))];
  for (const r of newRows) entries.push([stamp, SHEET.queue, mtText(r["Offer ID"]), "НОВИЙ", "", "", /МОЖЛИВИЙ ДУБЛЬ/.test(r["Перевірка"]) ? "МОЖЛИВИЙ ДУБЛЬ" : STATUS_NEW]);
  const tallyResults = tally(Object.values(out.results).map((x) => x.status));
  out.stats = { queueRows: qRows.length, ready: ready.length, results: tallyResults, added: newRows.length, possibleDuplicates, queueRaw: { changed: refreshed.filter((x) => x.changed).length, recheck: refreshed.filter((x) => x.recheck.length).length, verified: refreshed.filter((x) => x.verified).length, migratedColumns: queue0.migrated.length } };
  // ENG-27 (N3): службові команди виконує лише intake — відмову (напр. «ПЕРЕВІРЕНО» із застарілою SHA) власник бачить у «Перевірці»
  // рядка з командою, тож зміна лише її «Перевірки» — теж зміна (раніше її писала синхронізація; рядків із командою sync не оновлює).
  const cmdNoteChanged = kept.some((r, i) => isStateCommand(norm(queue0.rows[i]?.["Рішення"])) && mtText(r["Перевірка"]) !== mtText(queue0.rows[i]?.["Перевірка"]));
  out.changed = entries.length > 0 || queue0.migrated.length > 0 || cmdNoteChanged;
  entries.push([stamp, "СИСТЕМА", "", "ЗАВЕРШЕНО", "", parsed.count, JSON.stringify({ mode: "ІНТЕЙК", system: "НОВА СИСТЕМА (S1, тестова копія)", feedDate: parsed.date, offers: parsed.count, changes: entries.length, ready: ready.length, ...tallyResults })]);
  out.journal = entries;
  out.ack = ackFor({ mainRows: main.rows, queueRows: rows, deferredRows: [...deferred, ...[...(cc?.removed || [])].map((id) => ({ "Offer ID": id, "ID постачальника": id }))], frozenIds, frozenFlag, profile, results: out.results });
  return out;
}
