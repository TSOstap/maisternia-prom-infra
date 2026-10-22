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
import { resolveIdentity } from "./d1.mjs";

export const SHEET = Object.freeze({ main: "Основний каталог", queue: "Нові товари", deferred: "Відкладені товари", frozen: "Заморожені ID", groups: "Групи", journal: "Журнал", passport: "Паспорт каталогу" });
export const QUEUE_EXTRA = Object.freeze(["Рішення", "Перевірка", "Виявлено"]);
export const QUEUE_HEADERS = Object.freeze([...YML_HEADERS, ...QUEUE_EXTRA]);
export const PASSPORT_HEADER = Object.freeze(["Поле", "Значення"]);
export const DECISION = Object.freeze({ APPROVE: "ЗАТВЕРДЖЕНО", APPROVE_NOT_DUP: "ЗАТВЕРДЖЕНО (НЕ ДУБЛЬ)", REJECT: "ВІДХИЛЕНО" });
export const STATUS_NEW = "НОВИЙ_ВІД_ПОСТАЧАЛЬНИКА";
const DUP_PREFIX = "МОЖЛИВИЙ ДУБЛЬ";
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
  if (dupFlag && decision !== DECISION.APPROVE_NOT_DUP) p.push(`позначено «${DUP_PREFIX}» — перевірте й поставте «${DECISION.APPROVE_NOT_DUP}»`);
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

const dupNoteOf = (row) => (/^МОЖЛИВИЙ ДУБЛЬ[^;]*/.exec(mtText(row["Перевірка"]))?.[0] || "");

/**
 * Фаза 1: план без контенту нових позицій.
 *  book — { назва: values2D } (основний, черга, відкладені, заморожені, групи, паспорт);
 *  parsed — операційний розбір фіду (Map offers); previousOffers — обсяг фіду останнього успішного оновлення.
 */
export function planSheetSync({ book, parsed, stamp, config, now, groupsRows }) {
  const out = { abort: null, warnings: [], stats: {} };
  const main = readSheet(book[SHEET.main], SHEET.main);
  const queueValues = book[SHEET.queue];
  const queueHeader = (queueValues?.[0] || []).map(mtText);
  if (QUEUE_EXTRA.some((k) => !queueHeader.includes(k))) { out.abort = "аркуш «Нові товари» ще не переведено в режим черги (немає колонок «Рішення/Перевірка/Виявлено») — спершу перенесення NEW92"; return out; }
  const queue = readSheet(queueValues, SHEET.queue);
  const deferred = book[SHEET.deferred] ? readSheet(book[SHEET.deferred], SHEET.deferred).rows : [];
  const frozenIds = new Set((book[SHEET.frozen] || []).slice(1).map((r) => mtText(r[0])).filter(Boolean));

  // 0. Паспорт: основний каталог не змінювали поза затвердженням.
  const passport = readPassport(book[SHEET.passport]);
  const current = approvalManifest(main.rows, groupsRows);
  if (!passport) { out.abort = "немає «Паспорта каталогу» — запис заборонено"; return out; }
  if (!samePassport(passport, current)) {
    const badSeals = main.rows.filter((r) => rowSeal(r) !== mtText(r[SEAL_COLUMN])).length;
    out.abort = `основний каталог не відповідає паспорту (рядків ${main.rows.length}/${passport.count}, змінених печаток ${badSeals}) — зміни поза затвердженням; нічого не записано`;
    return out;
  }

  // 1. Ціни й наявність (точний порт mtPlan) — основний каталог і черга.
  const mainPlan = planRows(main.rows, parsed.offers, stamp, config.pricing);
  const queuePlan = planRows(queue.rows, parsed.offers, stamp, config.pricing);
  const missing = mainPlan.filter((p) => p.match === MATCH.MISSING).length;
  const an = config.policy?.anomaly || { maxNewlyMissing: 50, maxNewlyMissingRatio: 0.02 };
  const limit = Math.max(an.maxNewlyMissing, Math.ceil(main.rows.length * an.maxNewlyMissingRatio));
  if (missing > limit) { out.abort = `зникло ${missing} товарів основного каталогу (поріг ${limit}) — схоже на збій постачальника; нічого не записано`; return out; }
  // Стан до запуску й окремі лічильники змін (лише кількості — без ID).
  const ids = main.rows.map((r) => mtText(r["Offer ID"]));
  const diff = (k) => mainPlan.filter((p) => mtText(p.before[LIVE_COLUMNS.indexOf(k)]) !== mtText(p.next[LIVE_COLUMNS.indexOf(k)])).length;
  out.stats.before = { mainRows: main.rows.length, uniqueIds: new Set(ids).size, queueRows: queue.rows.length, passportCount: passport.count };
  out.stats.main = {
    rows: main.rows.length, match: tally(mainPlan.map((p) => p.match)), changedCells: changeEntries(stamp, SHEET.main, mainPlan).filter((e) => e[3] !== "ПОМИЛКА").length,
    supplierPriceChanged: diff("Ціна постачальника"), salePriceChanged: diff("Ціна кінцева"), availabilityChanged: diff("Наявність"),
    becameAvailable: mainPlan.filter((p) => p.before[4] !== "+" && p.next[4] === "+").length, becameUnavailable: mainPlan.filter((p) => p.before[4] === "+" && p.next[4] !== "+").length,
    quantityChanged: diff("Кількість постачальника"), missingInFeed: missing,
  };

  // 2. Нові позиції без дублікатів (D1: перевипуск ID — не новий товар; автоматичних перев'язок у таблиці немає).
  const known = [...main.rows, ...queue.rows, ...deferred];
  const id = resolveIdentity({ syncRows: [...main.rows, ...queue.rows], knownRows: known, offers: parsed.offers, links: null, autoRelink: false, now, frozenIds });
  const dupOf = new Map();
  for (const d of id.manual) {
    if (d.frozen) continue; // заморожений (свідомо виключений) — у чергу не додаємо
    dupOf.set(d.offerId, mtText(d.target || d.candidates?.[0]?.offerId || ""));
  }
  const maxNew = config.queue?.maxNewPerRun ?? 300;
  const newIds = [...new Set([...id.newOfferIds, ...dupOf.keys()])].filter((x) => !frozenIds.has(x));
  if (newIds.length > maxNew) out.warnings.push(`нових позицій ${newIds.length} > ${maxNew} за запуск — додано перші ${maxNew}, решта наступного разу`);
  out.newIds = newIds.slice(0, maxNew);
  out.dupOf = dupOf;
  out.frozenSimilar = id.frozen;

  // 3. Рішення власника в черзі (на рядках з уже оновленими цінами/наявністю).
  const groupsById = new Map(groupsRows.map((g) => [mtText(g["Ідентифікатор_групи"]), { ua: mtText(g["Назва_групи_укр"]), ru: mtText(g["Назва_групи"]) }]));
  const groupIds = new Set(groupsById.keys());
  const mainIds = new Set(main.rows.map((r) => mtText(r["Offer ID"])));
  const approve = [], reject = [], keep = [];
  queue.rows.forEach((r, i) => {
    const updated = { ...r };
    LIVE_COLUMNS.forEach((k, j) => { updated[k] = queuePlan[i].next[j]; });
    const decision = norm(r["Рішення"]);
    const dupNote = dupNoteOf(r);
    if (decision === DECISION.REJECT) { reject.push(updated); return; }
    if (decision === DECISION.APPROVE || decision === DECISION.APPROVE_NOT_DUP) {
      const problems = approvalProblems(updated, { groupIds, mainIds, dupFlag: Boolean(dupNote) });
      if (!problems.length) { approve.push(toMainRow(updated, groupsById)); mainIds.add(mtText(r["Offer ID"])); return; }
      updated["Перевірка"] = [dupNote, "НЕ ПЕРЕНЕСЕНО: " + problems.join("; ")].filter(Boolean).join("; ");
    } else if (decision) {
      updated["Перевірка"] = [dupNote, `невідоме «Рішення»: «${mtText(r["Рішення"])}» (можна: ${DECISION.APPROVE}, ${DECISION.APPROVE_NOT_DUP}, ${DECISION.REJECT})`].filter(Boolean).join("; ");
    } else if (queuePlan[i].match !== MATCH.OK) {
      updated["Перевірка"] = [dupNote, "зараз не зіставлено з постачальником: " + queuePlan[i].match].filter(Boolean).join("; ");
    } else updated["Перевірка"] = dupNote || (/^НЕ ПЕРЕНЕСЕНО|^невідоме|^зараз не зіставлено/.test(mtText(r["Перевірка"])) ? "" : mtText(r["Перевірка"]));
    keep.push(updated);
  });
  out.main = { start: main.start, plan: mainPlan, rows: main.rows };
  out.queue = { header: queueHeader, keep, approve, reject, planRowsByIndex: queuePlan };
  out.journal = [...changeEntries(stamp, SHEET.main, mainPlan), ...changeEntries(stamp, SHEET.queue, queuePlan)];
  out.passportBefore = passport;
  out.stats.queue = { rows: queue.rows.length, approve: approve.length, reject: reject.length, keep: keep.length, newIds: out.newIds.length, possibleDuplicates: [...dupOf.keys()].filter((k) => out.newIds.includes(k)).length };
  return out;
}

/** Фаза 2: підсумкова черга (лишені + нові з оригінальним контентом) і новий паспорт. */
export function finalizeSheetSync(plan, { parsed, fullById, stamp, config, groupsRows, journalSummary }) {
  const newRows = plan.newIds.map((id) => {
    const row = candidateRow(parsed.offers.get(id), fullById.get(id), stamp, config.pricing);
    const target = plan.dupOf.get(id);
    if (plan.dupOf.has(id)) row["Перевірка"] = [`${DUP_PREFIX}: схожий на товар ${target || "у каталозі"} (можливий новий ID того самого товару)`, row["Перевірка"]].filter(Boolean).join("; ");
    return row;
  });
  const queueRows = [...plan.queue.keep, ...newRows];
  const queueValues = queueRows.map((r) => plan.queue.header.map((k) => (r[k] == null ? "" : r[k])));
  const mainRowsAfter = [...plan.main.rows.map((r, i) => { const x = { ...r }; LIVE_COLUMNS.forEach((k, j) => { x[k] = plan.main.plan[i].next[j]; }); return x; }), ...plan.queue.approve];
  const passportAfter = approvalManifest(mainRowsAfter, groupsRows);
  const entries = plan.journal.slice();
  for (const r of plan.queue.approve) entries.push([stamp, SHEET.main, mtText(r["Offer ID"]), "ЗАТВЕРДЖЕНО", SHEET.queue, SHEET.main, "ДОЗВОЛЕНО"]);
  for (const r of plan.queue.reject) entries.push([stamp, SHEET.queue, mtText(r["Offer ID"]), "ВІДХИЛЕНО", "", SHEET.frozen, "ВІДХИЛЕНО"]);
  for (const r of newRows) entries.push([stamp, SHEET.queue, mtText(r["Offer ID"]), "НОВИЙ", "", "", plan.dupOf.has(mtText(r["Offer ID"])) ? DUP_PREFIX : STATUS_NEW]);
  entries.push([stamp, "СИСТЕМА", "", "ЗАВЕРШЕНО", "", parsed.count, JSON.stringify({ mode: "ОНОВЛЕННЯ", system: "НОВА СИСТЕМА (S1, тестова копія)", feedDate: parsed.date, offers: parsed.count, changes: entries.length, ...journalSummary })]);
  return { queueValues, newRows, passportAfter, journal: entries, mainCountAfter: mainRowsAfter.length };
}
