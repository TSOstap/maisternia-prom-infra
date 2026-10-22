/** Етап S1: логіка запису нової системи в таблицю (варіант A, погоджено 22.10.2026). Чисті функції — без мережі й запису.
 *
 *  Аркуші:
 *   «Основний каталог» — готові SEO-товари: система змінює ЛИШЕ 8 операційних колонок (LIVE_COLUMNS) і додає затверджені рядки.
 *   «Нові товари»      — черга СИРИХ позицій постачальника (40 колонок каталогу + «Рішення», «Перевірка», «Виявлено»).
 *   «Паспорт каталогу» — погоджений набір основного каталогу (кількість, idsSha, contentSha, groupsSha): будь-яка зміна
 *                        SEO/ідентичності поза затвердженням → невідповідність паспорту → запуск нічого не пише.
 *   «Заморожені ID»    — свідомо виключені ID; сюди ж потрапляють ВІДХИЛЕНІ власником позиції (щоб не з'являлися знову).
 *   «Журнал»           — формат mtUpdate: [час, аркуш, ID, поле, було, стало, статус] + підсумок «СИСТЕМА / ЗАВЕРШЕНО». */
import { mtDecode, mtText } from "./text.mjs";
import { LIVE_COLUMNS, MATCH, changeEntries, planRows, readSheet } from "./sync-plan.mjs";
import { YML_HEADERS, SEAL_COLUMN, approvalManifest, rowSeal } from "./seal.mjs";
import { mtPrices } from "./pricing.mjs";
import { cardKeys, resolveUnknownOffers } from "./identity.mjs";
import { buildDupIndex, compareEntries, dupNote, findDuplicates, rowEntry } from "./dup-check.mjs";

export const SHEET = Object.freeze({ main: "Основний каталог", queue: "Нові товари", deferred: "Відкладені товари", frozen: "Заморожені ID", groups: "Групи", journal: "Журнал", passport: "Паспорт каталогу" });
export const QUEUE_EXTRA = Object.freeze(["Рішення", "Перевірка", "Виявлено"]);
export const QUEUE_HEADERS = Object.freeze([...YML_HEADERS, ...QUEUE_EXTRA]);
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
export function approvalProblems(row, { groupIds, mainIds, dupFlag }) {
  const p = [];
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
export function planSheetSync({ book, parsed, stamp, config, now, groupsRows }) {
  const out = { abort: null, block: null, warnings: [], stats: {} };
  // Зупинка: зрозуміла причина + тип, кількість зачеплених товарів і поріг (для «Журналу»).
  const stop = (type, reason, affected = "", limit = "") => { out.abort = reason; out.block = { type, reason, affected, limit }; return out; };
  const main = readSheet(book[SHEET.main], SHEET.main);
  const queueValues = book[SHEET.queue];
  const queueHeader = (queueValues?.[0] || []).map(mtText);
  if (QUEUE_EXTRA.some((k) => !queueHeader.includes(k))) return stop("ЧЕРГА НЕ ГОТОВА", "аркуш «Нові товари» ще не переведено в режим черги (немає колонок «Рішення/Перевірка/Виявлено») — спершу перенесення NEW92");
  const queue = readSheet(queueValues, SHEET.queue);
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

  // 2. Ціни й наявність (точний порт mtPlan) — на картках уже з урахуванням прив'язок.
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
  // Заморожені — ОБЕРЕЖНО: лише сильний збіг (артикул + обидві назви) з карткою, чий ID зник із фіду.
  const orphanIds = new Set(mainRows.filter((r) => !parsed.offers.has(mtText(r["ID постачальника"]))).map((r) => mtText(r["Offer ID"])));
  const frozenFlag = new Set();
  if (orphanIds.size) {
    const frozenOffers = [...parsed.offers.values()].filter((o) => frozenIds.has(o.id) && !knownSupplierIds.has(o.id));
    const cards = mainRows.map((r) => cardKeys(r));
    for (const d of resolveUnknownOffers({ offers: frozenOffers, cards, orphanIds })) if (d.candidates.some((c) => c.orphan && c.level === "STRONG")) frozenFlag.add(d.offerId);
  }
  const maxNew = config.queue?.maxNewPerRun ?? 300;
  const newIds = [...unknown.map((o) => o.id), ...frozenFlag];
  if (newIds.length > maxNew) out.warnings.push(`нових позицій ${newIds.length} > ${maxNew} за запуск — додано перші ${maxNew}, решта наступного разу`);
  out.newIds = newIds.slice(0, maxNew);
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
      const problems = approvalProblems(updated, { groupIds, mainIds, dupFlag: blocking });
      if (!problems.length) { approve.push(toMainRow(updated, groupsById)); mainIds.add(mtText(r["Offer ID"])); return; }
      updated["Перевірка"] = [dup, "НЕ ПЕРЕНЕСЕНО: " + problems.join("; ")].filter(Boolean).join(" ");
    } else if (decision) {
      updated["Перевірка"] = [dup, `невідоме «Рішення»: «${mtText(r["Рішення"])}» (можна: ${DECISION.APPROVE}, ${DECISION.APPROVE_NOT_DUP}, ${DECISION.REJECT}, ПРИВ'ЯЗАТИ ДО <Offer ID>)`].filter(Boolean).join(" ");
    } else if (queuePlan[i].match !== MATCH.OK) {
      updated["Перевірка"] = [dup, "зараз не зіставлено з постачальником: " + queuePlan[i].match].filter(Boolean).join(" ");
    } else updated["Перевірка"] = dup;
    updated["Перевірка"] = withNonProduct(updated["Перевірка"], nonProductReason(updated, auditTypes));
    keep.push(updated);
  });
  out.main = { start: main.start, plan: mainPlan, rows: mainRows, changedRows: new Set([...undo.changedMain, ...bind.changedMain]) };
  out.queue = { header: queueHeader, keep, approve, reject, bound, reclaimed, planRowsByIndex: queuePlan };
  out.bindings = { history: bind.history, done: bind.done.length, refused: bind.refused.size, undoCells: undo.cells, undone: undo.undone.length, undoneList: undo.undone };
  out.deferredRows = deferred;
  out.journal = [...changeEntries(stamp, SHEET.main, mainPlan), ...changeEntries(stamp, SHEET.queue, queuePlan)];
  out.passportBefore = passport;
  out.stats.queue = { rows: queue.rows.length, approve: approve.length, reject: reject.length, keep: keep.length, bound: bound.length, newIds: out.newIds.length };
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
