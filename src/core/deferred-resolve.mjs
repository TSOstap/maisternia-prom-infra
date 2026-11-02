/** ENG-29 — «Відкладені товари» (рішення власника 03.11): розібрати аркуш, створений разовою дією 16.10 («ОЧІКУЄ_ОПЕРАЦІЙНОЇ_ПЕРЕВІРКИ»).
 *  Чиста функція: лише читання книги й фіду → план. Запис — src/pipeline/deferred-resolve.mjs (шлюз W2).
 *
 *   • товар є у фіді постачальника (за «ID постачальника») і не дубль → «Основний каталог»: наші SEO / описи / характеристики / група /
 *     категорія / код Prom — як були; дані постачальника (артикул, назви постачальника, сторінка, фото, сирі описи й характеристики) — з
 *     актуального фіду (назва постачальника змінилась — тому й був відкладений); ціни й наявність — за погодженими правилами з фіду;
 *     «ДОЗВОЛЕНО», нова печатка, стан полів — як при затвердженні;
 *   • дубль (той самий ID постачальника / код Prom / артикул, що в каталозі чи серед відкладених, або «ймовірно той самий» за назвою й
 *     фото) — НЕ переноситься, у звіт (рішення власника);
 *   • товару немає у фіді ні за ID, ні за артикулом, ні за назвою → «Видалені товари» («Статус видалення» — як у системі: ОЧІКУЄ
 *     ПУБЛІКАЦІЇ YML; у фід не потрапляє, повторно новинкою не створюється); знайдено за артикулом / назвою під іншим ID — у звіт;
 *   • перенесені рядки прибираються з «Відкладених товарів» (за ключем зі знімком рядка). */
import crypto from "node:crypto";
import { mtText } from "./text.mjs";
import { readSheet, planRows, LIVE_COLUMNS, MATCH } from "./sync-plan.mjs";
import { rowSeal, SEAL_COLUMN, approvalManifest, GROUP_HEADERS, YML_HEADERS } from "./seal.mjs";
import { objectsFromValues } from "./yml.mjs";
import { SHEET, approvalProblems, RAW_PARAMS } from "./sheet-sync.mjs";
import { buildDupIndex, findDuplicates, rowEntry } from "./dup-check.mjs";
import { STATE_COLUMN, WARNING_MARK_COLUMN } from "./field-control.mjs";
import { stateCell, approvalState } from "./owner-priority.mjs";
import { ARCHIVE_SHEET, ARCHIVE_EXTRA, REMOVAL, archiveHeader } from "./archive.mjs";

export const DEFERRED_PLAN_KEY = "state/deferred-resolve/plan.json";
const t = (v) => mtText(v).trim();
const key = (v) => t(v).normalize("NFKC").toLowerCase().replace(/[\s\-_.,/()«»"]+/g, "");
const skus = (v) => t(v).split(",").map(key).filter(Boolean);
export const rowHash = (row, header) => crypto.createHash("sha256").update(JSON.stringify(header.map((k) => mtText(row?.[k] ?? "")))).digest("hex").slice(0, 32);

/** book: основний, відкладені, архів (може не бути), групи. parsed — повний фід (parseSupplierText identityFields), fullById — extractFullOffers. */
export function planDeferred({ book, parsed, fullById, stamp, pricing, decisionRef = "рішення власника 03.11.2026" }) {
  const mainHeader = (book[SHEET.main]?.[0] || []).map(t);
  const defValues = book[SHEET.deferred];
  if (!defValues?.length) return { state: "NOTHING", reason: "аркуша «Відкладені товари» немає або він порожній" };
  const defHeader = defValues[0].map(t);
  const def = readSheet(defValues, SHEET.deferred).rows;
  if (!def.length) return { state: "NOTHING", reason: "у «Відкладених товарах» немає рядків" };
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); return ok; };
  check("«Основний каталог» має всі колонки картки (YML)", YML_HEADERS.every((k) => mainHeader.includes(k)));
  check("«Відкладені товари» мають Offer ID і ID постачальника", defHeader.includes("Offer ID") && defHeader.includes("ID постачальника"));
  if (!checks.every((c) => c.ok)) return { state: "PRECONDITION_FAILED", checks };
  const main = readSheet(book[SHEET.main], SHEET.main).rows;
  const mainIds = new Set(main.map((r) => t(r["Offer ID"])));
  const mainSid = new Map(main.map((r) => [t(r["ID постачальника"]), t(r["Offer ID"])]));
  const mainCode = new Map(main.filter((r) => key(r["Код товару Prom"])).map((r) => [key(r["Код товару Prom"]), t(r["Offer ID"])]));
  const mainSku = new Map(); for (const r of main) for (const s of skus(r["Артикул постачальника"])) mainSku.set(s, t(r["Offer ID"]));
  const archValues = book[ARCHIVE_SHEET];
  const archIds = new Set(archValues?.length ? readSheet(archValues, ARCHIVE_SHEET).rows.map((r) => t(r["Offer ID"])) : []);
  const groups = objectsFromValues(book[SHEET.groups], GROUP_HEADERS);
  const groupIds = new Set(groups.map((g) => t(g["Ідентифікатор_групи"])));
  const offers = parsed.offers;
  const bySku = new Map(), byName = new Map();
  for (const o of offers.values()) {
    for (const s of skus(o.sku)) { if (!bySku.has(s)) bySku.set(s, []); bySku.get(s).push(o.id); }
    for (const n of [key(o.nameUa), key(o.nameRu)]) if (n) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(o.id); }
  }
  const inFeed = def.filter((r) => offers.has(t(r["ID постачальника"])));
  const index = buildDupIndex([...main.map((r) => rowEntry(r, SHEET.main)), ...inFeed.map((r) => rowEntry(r, SHEET.deferred))]);
  const archHeaderAfter = archValues?.length ? archValues[0].map(t) : archiveHeader(mainHeader);

  const moveRows = [], archiveRows = [], keep = [], removeFromDeferred = [];
  for (const r of def) {
    const id = t(r["Offer ID"]), sid = t(r["ID постачальника"]);
    if (!id) continue;
    if (mainIds.has(id)) { keep.push({ offerId: id, reason: "Offer ID уже є в «Основному каталозі» — рішення власника" }); continue; }
    if (archIds.has(id)) { keep.push({ offerId: id, reason: "Offer ID уже є у «Видалених товарах» — рішення власника" }); continue; }
    const offer = offers.get(sid);
    if (offer) {
      const why = [];
      if (mainSid.has(sid)) why.push(`той самий «ID постачальника», що в картки ${mainSid.get(sid)}`);
      const c = mainCode.get(key(r["Код товару Prom"])); if (c) why.push(`той самий «Код товару Prom», що в картки ${c}`);
      for (const s of skus(offer.sku)) if (mainSku.has(s)) why.push(`артикул постачальника як у картки ${mainSku.get(s)}`);
      const twin = inFeed.filter((x) => x !== r && skus(x["Артикул постачальника"]).some((s) => skus(r["Артикул постачальника"]).includes(s))).map((x) => t(x["Offer ID"]));
      if (twin.length) why.push(`той самий артикул серед відкладених: ${twin.join(", ")}`);
      const sim = findDuplicates(index, rowEntry(r, SHEET.deferred)).filter((x) => x.level === "ЙМОВІРНО ТОЙ САМИЙ").map((x) => `${x.id} («${x.sheet}»)`);
      if (sim.length) why.push("ймовірно той самий товар: " + sim.join(", "));
      if (why.length) { keep.push({ offerId: id, reason: "можливий дубль — " + [...new Set(why)].join("; ") }); continue; }
      // Рядок каталогу: колонки каталогу з рядка відкладених; дані постачальника — з актуального фіду.
      const row = Object.fromEntries(mainHeader.map((k) => [k, r[k] ?? ""]));
      const full = fullById.get(sid) || {};
      row["Артикул постачальника"] = mtText(offer.sku);
      row["Назва постачальника UA"] = mtText(offer.nameUa);
      row["Назва постачальника RU"] = mtText(offer.nameRu);
      if (offer.url) row["URL постачальника"] = mtText(offer.url);
      if (mtText(full.model).trim() && mainHeader.includes("Модель")) row["Модель"] = mtText(full.model).trim();
      if ((full.pictures || []).length) row["Фото JSON"] = JSON.stringify(full.pictures.slice(0, 10));
      if (mainHeader.includes(RAW_PARAMS) && (full.params || []).length) row[RAW_PARAMS] = JSON.stringify(full.params.slice(0, 100));
      if (mainHeader.includes("Опис постачальника UA") && t(full.descriptionUa)) row["Опис постачальника UA"] = full.descriptionUa;
      if (mainHeader.includes("Опис постачальника RU") && t(full.descriptionRu)) row["Опис постачальника RU"] = full.descriptionRu;
      const [lp] = planRows([row], offers, stamp, pricing);
      if (lp.match !== MATCH.OK) { keep.push({ offerId: id, reason: `не зіставлено з постачальником після оновлення даних: ${lp.match}` }); continue; }
      LIVE_COLUMNS.forEach((k, j) => { row[k] = lp.next[j]; });
      row["Статус імпорту"] = "ДОЗВОЛЕНО";
      const problems = approvalProblems(row, { groupIds, mainIds, dupFlag: false });
      if (problems.length) { keep.push({ offerId: id, reason: "не готовий до каталогу — " + problems.join("; ") }); continue; }
      row[SEAL_COLUMN] = rowSeal(row);
      if (mainHeader.includes(STATE_COLUMN)) { row[STATE_COLUMN] = stateCell(approvalState(row, stamp), row); if (mainHeader.includes(WARNING_MARK_COLUMN)) row[WARNING_MARK_COLUMN] = ""; }
      moveRows.push(row); mainIds.add(id); mainSid.set(sid, id);
      removeFromDeferred.push({ offerId: id, row: r, to: SHEET.main });
      continue;
    }
    // Немає за ID — шукаємо за артикулом і назвою: знайдено під іншим ID — не видаляємо (рішення власника).
    const found = new Set();
    for (const s of skus(r["Артикул постачальника"])) for (const x of bySku.get(s) || []) found.add(`артикул → ID постачальника ${x}`);
    for (const n of [key(r["Назва постачальника UA"]), key(r["Назва постачальника RU"])]) for (const x of (n && byName.get(n)) || []) found.add(`назва → ID постачальника ${x}`);
    if (found.size) { keep.push({ offerId: id, reason: "немає за ID, але знайдено у фіді: " + [...found].join(", ") }); continue; }
    const arow = Object.fromEntries(archHeaderAfter.map((k) => [k, ARCHIVE_EXTRA.includes(k) ? "" : r[k] ?? ""]));
    arow["Видалено"] = stamp;
    arow["Операція видалення"] = `ВІДКЛАДЕНІ → ВИДАЛЕНІ: немає у фіді постачальника ні за ID, ні за артикулом, ні за назвою (${decisionRef})`;
    arow["Статус видалення"] = REMOVAL.PENDING;
    arow["YML без товару"] = "";
    archiveRows.push(arow);
    removeFromDeferred.push({ offerId: id, row: r, to: ARCHIVE_SHEET });
  }
  const passportAfter = approvalManifest([...main, ...moveRows], groups);
  const counts = { deferred: def.length, toMain: moveRows.length, toArchive: archiveRows.length, keep: keep.length, mainBefore: main.length, mainAfter: main.length + moveRows.length };
  const state = moveRows.length || archiveRows.length ? "READY" : "NOTHING";
  return { state, checks, moveRows, archiveRows, keep, removeFromDeferred, mainHeader, defHeader, archHeaderAfter, archiveExists: Boolean(archValues?.length), passportAfter, counts };
}

/** Контрольний план у W2: відбитки, без повних описів. */
export function deferredControlPlan(plan, { stamp, opId, events }) {
  return {
    v: 1, kind: "deferred-resolve", opId, stamp, status: "PLANNED", createdAt: stamp,
    mainHeader: plan.mainHeader, defHeader: plan.defHeader, archHeader: plan.archHeaderAfter, archiveExists: plan.archiveExists,
    moveIds: plan.moveRows.map((r) => t(r["Offer ID"])), moveValues: plan.moveRows.map((r) => plan.mainHeader.map((k) => mtText(r[k] ?? ""))),
    archiveIds: plan.archiveRows.map((r) => t(r["Offer ID"])), archiveValues: plan.archiveRows.map((r) => plan.archHeaderAfter.map((k) => mtText(r[k] ?? ""))),
    remove: plan.removeFromDeferred.map((x) => ({ offerId: x.offerId, to: x.to, hash: rowHash(x.row, plan.defHeader) })),
    keep: plan.keep, passportAfter: plan.passportAfter, counts: plan.counts, events,
  };
}
