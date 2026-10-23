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

export const SHEET = Object.freeze({ main: "Основний каталог", queue: "Нові товари", deferred: "Відкладені товари", frozen: "Заморожені ID", groups: "Групи", journal: "Журнал", passport: "Паспорт каталогу" });
export const QUEUE_EXTRA = Object.freeze(["Рішення", "Перевірка", "Виявлено"]);
/** Стан даних постачальника в черзі (варіант А, погоджено 22.10.2026). До наявної черги додаються автоматично. */
export const QUEUE_STATE = Object.freeze(["Остання зміна постачальника", "SHA даних постачальника", "Погоджено для SHA", "SHA SEO при додаванні", "Погоджені дані постачальника"]);
export const QUEUE_HEADERS = Object.freeze([...YML_HEADERS, ...QUEUE_EXTRA, ...QUEUE_STATE]);
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
    });
    if (out.size === want.size) break;
  }
  return out;
}

const clip = (s, notes, what) => { const t = mtText(s); if (t.length <= CELL_LIMIT) return t; notes.push(`${what} скорочено до ${CELL_LIMIT} символів (ліміт клітинки)`); return t.slice(0, CELL_LIMIT); };

/** Рядок черги з ОРИГІНАЛЬНИМИ даними постачальника. Ідентичність і ціна — з операційного розбору (той самий, що для зіставлення). */
export function candidateRow(offer, full, stamp, pricing) {
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
  if (!full) notes.push("немає повного опису в XML постачальника — заповнити вручну");
  row["Перевірка"] = notes.join("; ");
  return row;
}

/** Що не дає затвердити рядок черги (порожній масив — можна переносити). */
export function approvalProblems(row, { groupIds, mainIds, dupFlag, recheck = [] }) {
  const p = [];
  if (recheck.length) p.push(`${RECHECK} (змінено: ${recheck.join(", ")}) — перевірте SEO й поставте «${VERIFIED}»`);
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
const kitOf = (row) => ({ nameUa: row["Назва постачальника UA"], nameRu: row["Назва постачальника RU"], params: row["Характеристики JSON"] });
const descKey = (s) => mtKey(mtText(s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " "));
const descPart = (sha) => /^s1\.(?:[0-9a-f]{8}\.){6}([0-9a-f]{8})$/.exec(mtText(sha))?.[1] || "";
const jsonOr = (v, d) => { try { const x = JSON.parse(mtText(v) || "null"); return x ?? d; } catch { return d; } };
const photoId = (u) => (/images\.prom\.ua\/(\d+)_/.exec(mtText(u)) || [])[1] || mtText(u).trim();

/** Знімок СИРИХ даних постачальника (не нашого SEO) — для попередження «було → стало». */
function supplierSnapshot(row, sha, supplierModel = "") {
  return {
    nameUa: mtText(row["Назва постачальника UA"]), nameRu: mtText(row["Назва постачальника RU"]), sku: mtText(row["Артикул постачальника"]), url: mtText(row["URL постачальника"]),
    photos: (jsonOr(row["Фото JSON"], []) || []).filter((u) => typeof u === "string").map(photoId),
    params: (jsonOr(row["Характеристики JSON"], []) || []).filter((p) => p && typeof p === "object").map((p) => [mtText(p.name), mtText(p.value), mtText(p.unit)]),
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
export function refreshQueueRow(row, offer, full, { stamp }) {
  const r = { ...row };
  const entries = [], notes = [];
  const id = mtText(row["Offer ID"]);
  const prevSha = mtText(row["SHA даних постачальника"]);
  const decision = norm(row["Рішення"]);
  const verifiedCmd = VERIFIED_RE.exec(decision);
  const supplierCmd = SEO_SUPPLIER_RE.test(decision);
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
  if (offer) {
    const set = (col, next) => { if (mtText(r[col]) !== mtText(next)) { entries.push([stamp, SHEET.queue, id, col, jv(r[col]), jv(next), "ДАНІ ПОСТАЧАЛЬНИКА"]); r[col] = next; } };
    for (const [col, f] of RAW_COLUMNS) set(col, offer[f] ?? "");
    if (full) {
      // Фото — повним актуальним списком постачальника (порядок, головне фото); порожній список не стирає наявних.
      if ((full.pictures || []).length) set("Фото JSON", JSON.stringify(full.pictures.slice(0, 10)));
      else if ((jsonOr(r["Фото JSON"], []) || []).length) notes.push("у повному XML немає фото — залишено попередні");
      const params = JSON.stringify((full.params || []).slice(0, 100));
      if (params.length > CELL_LIMIT) notes.push("характеристики постачальника завеликі для клітинки — не оновлено");
      else if ((full.params || []).length || !(jsonOr(r["Характеристики JSON"], []) || []).length) set("Характеристики JSON", params);
      else notes.push("у повному XML немає характеристик — залишено попередні");
      if (supplierModel) set("Модель", supplierModel); // модель — сирі дані постачальника
    }
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
    if (full) { seoSet("Опис UA", clip(full.descriptionUa, notes, "Опис UA")); seoSet("Опис RU", clip(full.descriptionRu, notes, "Опис RU")); }
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
 * автоматично: сирі поля, «Модель», фото (повним списком, у його порядку), характеристики; ціна й наявність — planRows.
 * Наше SEO (SEO_FIELDS) не перезаписується ніколи — у «Журналі» інформаційне попередження «було → стало» (нічого не блокує).
 * «Код товару Prom» іде за артикулом лише тоді, коли дорівнював попередньому артикулу й новий не зайнятий іншою карткою.
 * Offer ID не змінюється. Фото й характеристики — лише з повного перевіреного XML (full); інакше не чіпаємо.
 */
export function refreshMainRow(row, offer, full, { stamp, skuInUse = () => "" }) {
  if (!offer) return { row, entries: [], changed: false, identity: false, photos: false };
  const r = { ...row };
  const id = mtText(row["Offer ID"]);
  const entries = [];
  const status = "ДАНІ ПОСТАЧАЛЬНИКА (автоматично; SEO не змінено)";
  const set = (col, next) => { if (mtText(r[col]) !== mtText(next)) { entries.push([stamp, SHEET.main, id, col, jv(r[col]), jv(next), status]); r[col] = next; return true; } return false; };
  const pre = supplierSnapshot(row, "", mtText(row["Модель"]));
  const oldSku = mtText(row["Артикул постачальника"]).trim();
  for (const [col, f] of RAW_COLUMNS) set(col, f === "sku" ? mtText(offer.sku).trim() : offer[f] ?? "");
  const newSku = mtText(r["Артикул постачальника"]).trim();
  if (newSku !== oldSku) {
    const code = mtText(row["Код товару Prom"]).trim();
    const owner = newSku ? skuInUse(newSku, id) : "";
    if ((!code || code === oldSku) && newSku && !owner) set("Код товару Prom", newSku);
    else if (owner) entries.push([stamp, SHEET.main, id, "Код товару Prom", code, code, "НЕ ЗМІНЕНО: артикул «" + newSku + "» уже має товар " + owner]);
  }
  let photos = false;
  if (full) {
    const model = mtText(full.model).trim();
    if (model) set("Модель", model);
    if ((full.pictures || []).length) photos = set("Фото JSON", JSON.stringify(full.pictures.slice(0, 10)));
    const params = JSON.stringify((full.params || []).slice(0, 100));
    if (params.length <= CELL_LIMIT && (full.params || []).length) set("Характеристики JSON", params);
  }
  const changed = entries.some((e) => e[6] === status);
  const identity = mtKey(pre.nameUa) !== mtKey(r["Назва постачальника UA"]) || mtKey(pre.nameRu) !== mtKey(r["Назва постачальника RU"]) || pre.sku !== newSku;
  if (changed) {
    r[SEAL_COLUMN] = rowSeal(r);
    const details = describeSupplierChanges(pre, supplierSnapshot(r, "", mtText(r["Модель"])));
    if (details.length) entries.push([stamp, SHEET.main, id, RECHECK, "", jv(details.join("; ")), "ІНФОРМАЦІЙНО: наше SEO не змінено — перевірте відповідність новим даним постачальника"]);
  }
  return { row: r, entries, changed, identity, photos };
}

/** Черга з колонками стану (додаються автоматично до черги, створеної до 22.10.2026). */
function readQueue(values) {
  const header = (values?.[0] || []).map(mtText);
  const migrated = QUEUE_STATE.filter((k) => !header.includes(k));
  const v = migrated.length ? [[...header, ...migrated], ...values.slice(1)] : values;
  return { ...readSheet(v, SHEET.queue), migrated };
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
  const out = Object.fromEntries(YML_HEADERS.map((k) => [k, row[k] ?? ""]));
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
function planBindings({ queueRows, mainRows, deferredRows, offers, stamp }) {
  const mainById = new Map(mainRows.map((r, i) => [mtText(r["Offer ID"]), i]));
  const wanted = [];
  queueRows.forEach((r, qi) => {
    const m = BIND_RE.exec(norm(r["Рішення"]).replace(/’|ʼ|`/g, "'"));
    if (m) wanted.push({ qi, row: r, target: m[1], confirmed: Boolean(m[2]) });
  });
  const perTarget = wanted.reduce((a, w) => ((a[w.target] = (a[w.target] || 0) + 1), a), {});
  const done = [], refused = new Map();
  for (const w of wanted) {
    const problems = [];
    const ti = mainById.get(w.target);
    const offerId = mtText(w.row["ID постачальника"]);
    const offer = offers.get(offerId);
    if (ti === undefined) problems.push(`товару ${w.target} немає в основному каталозі`);
    if (!offer) problems.push("цієї позиції зараз немає у фіді постачальника");
    if (perTarget[w.target] > 1) problems.push(`до товару ${w.target} прив'язують кілька позицій — залиште одну`);
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
function planUndos({ historyValues, mainRows, deferredRows, queueRows, offers, stamp }) {
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
export function planSheetSync({ book, parsed, stamp, config, now, groupsRows, fullById = new Map() }) {
  const out = { abort: null, block: null, warnings: [], stats: {} };
  // Зупинка: зрозуміла причина + тип, кількість зачеплених товарів і поріг (для «Журналу»).
  const stop = (type, reason, affected = "", limit = "") => { out.abort = reason; out.block = { type, reason, affected, limit }; return out; };
  const main = readSheet(book[SHEET.main], SHEET.main);
  const queueValues = book[SHEET.queue];
  const queueHeader = (queueValues?.[0] || []).map(mtText);
  if (QUEUE_EXTRA.some((k) => !queueHeader.includes(k))) return stop("ЧЕРГА НЕ ГОТОВА", "аркуш «Нові товари» ще не переведено в режим черги (немає колонок «Рішення/Перевірка/Виявлено») — спершу перенесення NEW92");
  const queue0 = readQueue(queueValues);
  // Варіант А: сирі дані постачальника черги — з поточного XML (SEO не змінюється); далі всі кроки — на оновлених рядках.
  const refreshed = queue0.rows.map((r) => refreshQueueRow(r, parsed.offers.get(mtText(r["ID постачальника"])), fullById.get(mtText(r["ID постачальника"])), { stamp }));
  const queue = { ...queue0, rows: refreshed.map((x) => x.row) };
  const deferred = book[SHEET.deferred] ? readSheet(book[SHEET.deferred], SHEET.deferred).rows : [];
  const frozenIds = new Set((book[SHEET.frozen] || []).slice(1).map((r) => mtText(r[0])).filter(Boolean));

  // 0. Паспорт: основний каталог не змінювали поза затвердженням/прив'язкою.
  const passport = readPassport(book[SHEET.passport]);
  if (!passport) return stop("НЕМАЄ ПАСПОРТА", "немає «Паспорта каталогу» — запис заборонено");
  if (!samePassport(passport, approvalManifest(main.rows, groupsRows))) {
    const badSeals = main.rows.filter((r) => rowSeal(r) !== mtText(r[SEAL_COLUMN])).length;
    return stop("ЗМІНИ ПОЗА ЗАТВЕРДЖЕННЯМ", `основний каталог не відповідає паспорту (рядків ${main.rows.length}/${passport.count}, змінених печаток ${badSeals}) — зміни поза затвердженням; нічого не записано`, badSeals || Math.abs(main.rows.length - passport.count), 0);
  }
  const ids = main.rows.map((r) => mtText(r["Offer ID"]));
  out.stats.before = { mainRows: main.rows.length, uniqueIds: new Set(ids).size, queueRows: queue.rows.length, passportCount: passport.count };

  // 1. Рішення власника, що змінюють картки: скасування прив'язок, потім нові прив'язки (на копіях рядків).
  const mainRows = main.rows.map((r) => ({ ...r }));
  const undo = planUndos({ historyValues: book[BINDINGS_SHEET], mainRows, deferredRows: deferred, queueRows: queue.rows, offers: parsed.offers, stamp });
  const originals = mainRows.map((r) => ({ ...r })); // після скасувань, до прив'язок — «старі» значення для історії
  const bind = planBindings({ queueRows: queue.rows, mainRows, deferredRows: deferred, offers: parsed.offers, stamp });
  Object.assign(bind, applyBindings(bind, { mainRows, originals, stamp }));
  // Остаточний запобіжник: жоден ID постачальника не належить двом карткам.
  const supplierIds = [...mainRows, ...deferred].map((r) => mtText(r["ID постачальника"])).filter(Boolean);
  if (new Set(supplierIds).size !== supplierIds.length) return stop("КОНФЛІКТ ID ПОСТАЧАЛЬНИКА", "після рішень один ID постачальника належав би двом карткам — нічого не записано", supplierIds.length - new Set(supplierIds).size, 0);

  // 1б. Основний каталог: зміни постачальника під тим самим ID — автоматично (не для карток, змінених прив'язкою цього запуску).
  const skuOwners = new Map();
  for (const r of mainRows) for (const k of ["Артикул постачальника", "Код товару Prom"]) { const v = mtText(r[k]).trim(); if (v && !skuOwners.has(v)) skuOwners.set(v, mtText(r["Offer ID"])); }
  const skuInUse = (sku, self) => { const o = skuOwners.get(sku); return o && o !== self ? o : ""; };
  const mainRaw = { entries: [], changed: new Set(), identity: 0, photos: 0 };
  mainRows.forEach((r, i) => {
    if (undo.changedMain.has(i) || bind.changedMain.has(i)) return;
    const sid = mtText(r["ID постачальника"]);
    const m = refreshMainRow(r, parsed.offers.get(sid), fullById.get(sid), { stamp, skuInUse });
    if (!m.changed) { mainRaw.entries.push(...m.entries); return; }
    mainRows[i] = m.row;
    mainRaw.changed.add(i);
    mainRaw.entries.push(...m.entries);
    if (m.identity) mainRaw.identity++;
    if (m.photos) mainRaw.photos++;
  });
  {
    const an0 = config.policy?.anomaly || { maxNewlyMissing: 50, maxNewlyMissingRatio: 0.02 };
    const lim = Math.max(an0.maxNewlyMissing, Math.ceil(mainRows.length * an0.maxNewlyMissingRatio));
    const photoLim = Math.max(200, Math.ceil(mainRows.length * 0.1));
    out.stats.mainRaw = { changed: mainRaw.changed.size, identity: mainRaw.identity, photos: mainRaw.photos };
    // Захист від помилкового фіду: масова зміна назв / артикулів або фото — нічого не пишемо.
    if (mainRaw.identity > lim) return stop("МАСОВА ЗМІНА ДАНИХ ПОСТАЧАЛЬНИКА", `назви / артикул змінились у ${mainRaw.identity} товарів основного каталогу (поріг ${lim}) — схоже на помилку у фіді; нічого не записано`, mainRaw.identity, lim);
    if (mainRaw.photos > photoLim) return stop("МАСОВА ЗМІНА ФОТО", `фото змінились у ${mainRaw.photos} товарів основного каталогу (поріг ${photoLim}) — схоже на помилку у фіді; нічого не записано`, mainRaw.photos, photoLim);
  }

  // 2. Ціни й наявність (точний порт mtPlan) — на картках уже з урахуванням прив'язок і даних постачальника.
  const mainPlan = planRows(mainRows, parsed.offers, stamp, config.pricing);
  const queuePlan = planRows(queue.rows, parsed.offers, stamp, config.pricing);
  const missing = mainPlan.filter((p) => p.match === MATCH.MISSING).length;
  const an = config.policy?.anomaly || { maxNewlyMissing: 50, maxNewlyMissingRatio: 0.02 };
  const limit = Math.max(an.maxNewlyMissing, Math.ceil(mainRows.length * an.maxNewlyMissingRatio));
  const diff = (k) => mainPlan.filter((p) => mtText(p.before[LIVE_COLUMNS.indexOf(k)]) !== mtText(p.next[LIVE_COLUMNS.indexOf(k)])).length;
  const becameAvailable = mainPlan.filter((p) => p.before[4] !== "+" && p.next[4] === "+").length;
  const becameUnavailable = mainPlan.filter((p) => p.before[4] === "+" && p.next[4] !== "+").length;
  out.stats.main = {
    rows: mainRows.length, match: tally(mainPlan.map((p) => p.match)), changedCells: changeEntries(stamp, SHEET.main, mainPlan).filter((e) => e[3] !== "ПОМИЛКА").length,
    supplierPriceChanged: diff("Ціна постачальника"), salePriceChanged: diff("Ціна кінцева"), availabilityChanged: diff("Наявність"),
    becameAvailable, becameUnavailable, quantityChanged: diff("Кількість постачальника"), missingInFeed: missing,
  };
  // Захист від пошкодженого/помилкового фіду: масове зникнення або масова зміна наявності — нічого не пишемо.
  if (missing > limit) return stop("МАСОВЕ ЗНИКНЕННЯ", `зникло ${missing} товарів основного каталогу (поріг ${limit}) — схоже на збій постачальника; нічого не записано`, missing, limit);
  if (becameUnavailable > limit) return stop("МАСОВА ЗМІНА НАЯВНОСТІ", `«немає в наявності» стало ${becameUnavailable} товарів (поріг ${limit}) — схоже на помилку у фіді постачальника; нічого не записано`, becameUnavailable, limit);
  if (becameAvailable > limit) return stop("МАСОВА ЗМІНА НАЯВНОСТІ", `«в наявності» стало ${becameAvailable} товарів (поріг ${limit}) — схоже на помилку у фіді постачальника; нічого не записано`, becameAvailable, limit);

  // 3. Нові позиції: ID постачальника, якого немає в жодній картці/черзі/відкладених і не заморожений.
  const knownSupplierIds = new Set([...mainRows, ...queue.rows, ...deferred].map((r) => mtText(r["ID постачальника"])));
  // Також за Offer ID: позиція, чий ID уже є як Offer ID у будь-якому аркуші (напр. після ручної правки «ID постачальника»), не дублюється.
  const knownOfferIds = new Set([...mainRows, ...queue.rows, ...deferred].map((r) => mtText(r["Offer ID"])));
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
  queue.rows.forEach((r, i) => {
    const updated = { ...r };
    const rq = refreshed[i];
    LIVE_COLUMNS.forEach((k, j) => { updated[k] = queuePlan[i].next[j]; });
    const decision = norm(r["Рішення"]);
    const cands = findDuplicates(index, queueEntry(r));
    const dup = dupNote(cands, { frozen: frozenIds.has(mtText(r["ID постачальника"])) });
    if (bind.done.some((b) => b.qi === i)) { bound.push(updated); return; }
    if (undo.reclaimedQueueIds.has(mtText(r["Offer ID"]))) { reclaimed.push(updated); return; } // картка повернула собі цей ID постачальника
    if (decision === DECISION.REJECT) { reject.push(updated); return; }
    if (bind.refused.has(i)) updated["Перевірка"] = [dup, bind.refused.get(i)].filter(Boolean).join(" ");
    else if (decision === DECISION.APPROVE || decision === DECISION.APPROVE_NOT_DUP) {
      // «(НЕ ДУБЛЬ)» обов'язкове лише при схожості з товаром основного каталогу або оцінці «ймовірно той самий».
      const blocking = cands.some((c) => c.sheet === SHEET.main || c.level === "ЙМОВІРНО ТОЙ САМИЙ");
      const problems = approvalProblems(updated, { groupIds, mainIds, dupFlag: blocking, recheck: rq.recheck });
      if (!problems.length) { approve.push(toMainRow(updated, groupsById)); mainIds.add(mtText(r["Offer ID"])); return; }
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
  out.main = { start: main.start, plan: mainPlan, rows: mainRows, changedRows: new Set([...undo.changedMain, ...bind.changedMain, ...mainRaw.changed]) };
  out.queue = { header: queue.header, migrated: queue.migrated, keep, approve, reject, bound, reclaimed, planRowsByIndex: queuePlan };
  out.bindings = { history: bind.history, done: bind.done.length, refused: bind.refused.size, undoCells: undo.cells, undone: undo.undone.length, undoneList: undo.undone };
  out.deferredRows = deferred;
  out.journal = [...mainRaw.entries, ...changeEntries(stamp, SHEET.main, mainPlan), ...refreshed.flatMap((x) => x.entries), ...changeEntries(stamp, SHEET.queue, queuePlan)];
  out.stats.queueRaw = { changed: refreshed.filter((x) => x.changed).length, recheck: refreshed.filter((x) => x.recheck.length).length, verified: refreshed.filter((x) => x.verified).length, migratedColumns: queue.migrated.length };
  out.ackInput = { mainRows, deferredRows: deferred, frozenIds, frozenFlag };
  out.passportBefore = passport;
  out.stats.queue = { rows: queue.rows.length, approve: approve.length, reject: reject.length, keep: keep.length, bound: bound.length, newIds: 0, candidatesInFeed: out.candidatesInFeed };
  return out;
}

/** Фаза 2: підсумкова черга (лишені + нові з оригінальним контентом, з перевіркою схожості) і новий паспорт. */
export function finalizeSheetSync(plan, { parsed, fullById, stamp, config, groupsRows, journalSummary }) {
  const newRows = plan.newIds.map((id) => candidateRow(parsed.offers.get(id), fullById.get(id), stamp, config.pricing));
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
export function planIntake({ book, parsed, fullById, stamp, config, now, ready = [], profile = "medium" }) {
  const rules = { ...INTAKE_RULES, ...(config.intake || {}) };
  const out = { abort: null, block: null, warnings: [], stats: {}, results: {} };
  const stop = (type, reason) => { out.abort = reason; out.block = { type, reason, affected: "", limit: "" }; return out; };
  const queueValues = book[SHEET.queue];
  const queueHeader = (queueValues?.[0] || []).map(mtText);
  if (QUEUE_EXTRA.some((k) => !queueHeader.includes(k))) return stop("ЧЕРГА НЕ ГОТОВА", "аркуш «Нові товари» ще не переведено в режим черги");
  const main = readSheet(book[SHEET.main], SHEET.main);
  const queue0 = readQueue(queueValues);
  const deferred = book[SHEET.deferred] ? readSheet(book[SHEET.deferred], SHEET.deferred).rows : [];
  const frozenIds = new Set((book[SHEET.frozen] || []).slice(1).map((r) => mtText(r[0])).filter(Boolean));
  const auditTypes = auditMarks(book[AUDIT_SHEET]);

  const refreshed = queue0.rows.map((r) => refreshQueueRow(r, parsed.offers.get(mtText(r["ID постачальника"])), fullById.get(mtText(r["ID постачальника"])), { stamp }));
  const qRows = refreshed.map((x) => x.row);
  const queuePlan = planRows(qRows, parsed.offers, stamp, config.pricing);
  const kept = qRows.map((r, i) => { const x = { ...r }; LIVE_COLUMNS.forEach((k, j) => { x[k] = queuePlan[i].next[j]; }); return x; });

  const knownSupplierIds = new Set([...main.rows, ...qRows, ...deferred].map((r) => mtText(r["ID постачальника"])));
  const knownOfferIds = new Set([...main.rows, ...qRows, ...deferred].map((r) => mtText(r["Offer ID"])));
  const frozenFlag = frozenFlags({ mainRows: main.rows, parsed, frozenIds, knownSupplierIds });
  const maxNew = config.queue?.maxNewPerRun ?? 300;
  const newRows = [];
  for (const e of ready) {
    const id = mtText(e?.id);
    if (!/^\d+$/.test(id)) continue;
    if (knownSupplierIds.has(id) || knownOfferIds.has(id)) { out.results[id] = { status: "ВЖЕ Є" }; continue; } // повторний запуск — без дубля
    if (frozenIds.has(id) && !frozenFlag.has(id)) { out.results[id] = { status: "ВІДМОВА", reason: "ID у «Заморожених»" }; continue; }
    if (newRows.length >= maxNew) { out.results[id] = { status: "ВІДМОВА", reason: `ліміт ${maxNew} нових за запуск` }; continue; }
    const offer = parsed.offers.get(id), full = fullById.get(id);
    const raw = offer && full ? rawFromOffer(offer, full) : null;
    const v = verifyReady(e, raw, now, { rules, profile });
    if (!v.ok) { out.results[id] = { status: "ВІДМОВА", reason: v.reason, ...(v.fullFp ? { fullFp: v.fullFp } : {}) }; continue; }
    const row = candidateRow(offer, full, stamp, config.pricing);
    const iso = (t) => (Number.isFinite(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : stamp);
    row["Виявлено"] = iso(e.firstSeen);
    row["Остання зміна постачальника"] = iso(e.lastChange);
    row["SHA даних постачальника"] = row["Погоджено для SHA"] = sheetFingerprint(raw);
    row["SHA SEO при додаванні"] = seoHash(row);
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
    r["Перевірка"] = withNonProduct([note, r["Перевірка"]].filter(Boolean).join(" "), nonProductReason(r, auditTypes));
  }
  const rows = [...kept, ...newRows];
  out.queue = { header: queue0.header, migrated: queue0.migrated, values: rows.map((r) => queue0.header.map((k) => (r[k] == null ? "" : r[k]))) };
  out.newRows = newRows;
  const entries = [...refreshed.flatMap((x) => x.entries), ...changeEntries(stamp, SHEET.queue, queuePlan)];
  for (const r of newRows) entries.push([stamp, SHEET.queue, mtText(r["Offer ID"]), "НОВИЙ", "", "", /МОЖЛИВИЙ ДУБЛЬ/.test(r["Перевірка"]) ? "МОЖЛИВИЙ ДУБЛЬ" : STATUS_NEW]);
  const tallyResults = tally(Object.values(out.results).map((x) => x.status));
  out.stats = { queueRows: qRows.length, ready: ready.length, results: tallyResults, added: newRows.length, possibleDuplicates, queueRaw: { changed: refreshed.filter((x) => x.changed).length, recheck: refreshed.filter((x) => x.recheck.length).length, verified: refreshed.filter((x) => x.verified).length, migratedColumns: queue0.migrated.length } };
  out.changed = entries.length > 0 || queue0.migrated.length > 0;
  entries.push([stamp, "СИСТЕМА", "", "ЗАВЕРШЕНО", "", parsed.count, JSON.stringify({ mode: "ІНТЕЙК", system: "НОВА СИСТЕМА (S1, тестова копія)", feedDate: parsed.date, offers: parsed.count, changes: entries.length, ready: ready.length, ...tallyResults })]);
  out.journal = entries;
  out.ack = ackFor({ mainRows: main.rows, queueRows: rows, deferredRows: deferred, frozenIds, frozenFlag, profile, results: out.results });
  return out;
}
