/** ENG-28a (доручення власника 01.11.2026) — розрив залежності QA ↔ перенесення. Порядок:
 *   1. міграція структури (заголовок черги, «ОЧІКУЄ ПЕРЕНЕСЕННЯ», «Паспорт каталогу»); 2. стан Catalog Controls (тут — двійник);
 *   3. разове виправлення 1561514532 (лише 4 поля, лише погоджені заміни, очікувані старі значення, «Журнал», повторна QA);
 *   4. QA штатною синхронізацією (зміни назв постачальника прийнято, наше SEO не змінено); 5. перенесення NEW92; 6. перевірка.
 *  Також: неправильний порядок зупиняється без записів, конфлікти власника, конкурентні правки Google Sheets, повторні запуски.
 *  Кожен крок — через охоронця цілі запису з політикою свого режиму (MODE_POLICIES). Синтетика, таблиця в пам'яті, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { rowSeal, SEAL_COLUMN, YML_HEADERS } from "../src/core/seal.mjs";
import * as SS from "../src/core/sheet-sync.mjs"; // простір імен: PENDING_TRANSFER_MARK — новий експорт ENG-28a
import { STATE_COLUMN } from "../src/core/field-control.mjs";
import * as run from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { UNDEFINED_B6_COLUMNS } from "../src/pipeline/safe-write/queue-ownership.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import { updateProducts } from "../src/pipeline/update-products.mjs";
import * as P from "../src/core/supplier-presence.mjs";
import baseConfig from "../config/default.json" with { type: "json" };
// Новий модуль ENG-28a — динамічно: у кандидатах без нього (RED на ENG-28) падають окремі тести, а не файл.
const steps = await import("../src/pipeline/eng28a-steps.mjs").catch(() => ({}));
const WT = await import("../src/pipeline/safe-write/write-target.mjs").catch(() => ({}));
const { SHEET, QUEUE_HEADERS, DECISION, PENDING_TRANSFER_MARK, readPassport } = SS;

const NOW = Date.parse("2026-10-22T10:00:00Z");
const at = (min) => new Date(NOW + min * 60_000).toISOString();
const SNAP_DATE = "2026-10-29T18:20:40.743Z";
const FIX = "1561514532";
const FILTERED_URL = "https://market-tools.com.ua/feed.xml?key=SECRET&group_ids=101,102";
const cfg = () => { const c = structuredClone(baseConfig); c.ownerPriority = { enabled: true }; c.supplier.minimumOffers = 10; return c; };
const okCc = () => Object.freeze({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp-", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
const full = (xml) => xml.replace(/<\/offer>/g, "<description>Опис постачальника</description></offer>");
const dated = (xml, min) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 3 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });
const SEO = ["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Запити UA", "Запити RU", "Характеристики JSON", "Категорія Prom ID", "Група ID"];
const FIX_TEXT = {
  "Опис UA": "<p>Потужність 1700 Вт, енергія удару 6 Дж; 5,6 Дж — молодша модель, 16 Дж — старша; живлення 220 В, патрон 26 мм.</p>",
  "Опис RU": "<p>Мощность 1700 Вт, энергия удара 6 Дж.</p>",
  "Запити UA": "перфоратор 1700 Вт, перфоратор 6 Дж",
  "Запити RU": "перфоратор 1700 Вт",
};

/** Тестова копія до кроку 1: «Нові товари» — NEW92 (40 колонок), «Паспорта каталогу» немає (як у резервній копії TEST 01.11). */
function world({ queue = 8 } = {}) {
  const s = generateSynthetic({ products: 60, queue, deferred: 2, newOffers: 0, seed: 31, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const h = book[SHEET.main][0].map(mtText);
  const v = book[SHEET.main][5];
  v[h.indexOf("Offer ID")] = FIX;
  for (const [k, x] of Object.entries(FIX_TEXT)) v[h.indexOf(k)] = x;
  v[h.indexOf(SEAL_COLUMN)] = rowSeal(Object.fromEntries(h.map((k, j) => [k, v[j] ?? ""])));
  // Аналог 3236816949: у знімку LIVE «ВІДСУТНІЙ_У_YML» (поза охопленням фіду group_ids).
  const qh = book[SHEET.queue][0].map(mtText);
  const absent = book[SHEET.queue][3]; // рядок аркуша 4 = qRows0[2]
  absent[qh.indexOf("Стан синхронізації")] = "ВІДСУТНІЙ_У_YML";
  absent[qh.indexOf("Наявність")] = "-";
  const sheets = new MemorySheets(book);
  // Як GoogleSheetsCatalogSource у CLI: книга завжди з «Групами».
  const w = { s, sheets, readBook: async () => sheets.read(), store: new MemoryStore(), absentId: mtText(absent[0]) };
  const mainRows = readSheet(book[SHEET.main], SHEET.main).rows;
  w.renamed = mainRows.slice(10, 14).map((r) => ({ offerId: mtText(r["Offer ID"]), supplierId: mtText(r["ID постачальника"]) }));
  // Фід group_ids: основний каталог охоплено повністю; 3 товари NEW92 (разом з аналогом 3236816949) — поза охопленням.
  const qRows0 = readSheet(book[SHEET.queue], SHEET.queue).rows;
  w.outOfScope = [qRows0[2], qRows0[5], qRows0[6]].map((r) => mtText(r["ID постачальника"]));
  let xml = perturb.drop(full(s.supplierXml()), w.outOfScope);
  for (const r of w.renamed) xml = perturb.tag(xml, r.supplierId, "name_ua", "Нова назва постачальника " + r.supplierId);
  // Ціна товару, що чекає перенесення, змінилась у фіді: QA не змінює рядок черги (перенесення — байт-у-байт з NEW92).
  w.pricedPending = mtText(qRows0[0]["Offer ID"]);
  xml = perturb.tag(xml, mtText(qRows0[0]["ID постачальника"]), "price", "12345");
  w.xml = xml;
  w.queueIds = qRows0.map((r) => mtText(r["Offer ID"]));
  return w;
}
const headersOf = (w) => Object.fromEntries(Object.entries(w.sheets.book).map(([k, v]) => [k, (v[0] || []).slice()]));
/** Записувач кроку — лише через охоронця цілі з політикою режиму CLI (structure / correction / update / merge). */
const guarded = (w, mode) => WT.guardedSheets(w.sheets, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES[mode], headers: headersOf(w) });
const structure = (w, o = {}) => steps.migrateQueueForTransfer({ sheets: guarded(w, "structure"), readBook: o.readBook || w.readBook, stamp: at(0) });
const correction = (w, expected, o = {}) => steps.applyOwnerCorrection({ sheets: guarded(w, "correction"), readBook: o.readBook || w.readBook, stamp: at(1), expected });
const qa = (w, min, o = {}) => updateProducts({ sheets: guarded(w, "update"), readBook: w.readBook, xml: dated(o.xml || w.xml, min), source: FILTERED_URL, fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config: cfg(), catalog: EMPTY_CATALOG, controls: "controls" in o ? o.controls : okCc(), snapshotStore: w.store });
// ENG-28b: як у CLI (--expect-new92) — переносяться лише рядки «ОЧІКУЄ…», рівно стільки, скільки підготувала структура.
const transfer = (w, min = 5, o = {}) => run.transferNew92({ sheets: guarded(w, "merge"), readBook: o.readBook || w.readBook, stamp: at(min), snapshotDate: SNAP_DATE, expectCount: o.expectCount ?? w.queueIds.length });
const main = (w) => readSheet(w.sheets.book[SHEET.main], SHEET.main).rows;
const queue = (w) => readSheet(w.sheets.book[SHEET.queue], SHEET.queue).rows;
const byId = (rows, id) => rows.find((r) => mtText(r["Offer ID"]) === id);
const sealBad = (rows) => rows.filter((r) => rowSeal(r) !== mtText(r[SEAL_COLUMN])).map((r) => mtText(r["Offer ID"]));
const qRowNo = (w, id) => w.sheets.book[SHEET.queue].findIndex((r, i) => i > 0 && mtText(r[0]) === id) + 1;
const mRowNo = (w, id) => w.sheets.book[SHEET.main].findIndex((r, i) => i > 0 && mtText(r[0]) === id) + 1;
const snapshotBook = (w) => JSON.stringify(w.sheets.book);
const B6_QUEUE = UNDEFINED_B6_COLUMNS.filter((k) => QUEUE_HEADERS.includes(k));

// ================================================================ повна послідовність
test("ENG-28a послідовність: структура → CC → виправлення 1561514532 → QA ×2 → перенесення → перевірка; кожен крок — через охоронця цілі", async () => {
  const w = world();
  const main0 = main(w), q0 = queue(w);
  const n0 = main0.length, nq = q0.length;
  const seo0 = new Map(main0.map((r) => [mtText(r["Offer ID"]), Object.fromEntries(SEO.map((k) => [k, mtText(r[k])]))]));

  // 1. Структура.
  const s1 = await structure(w);
  assert.equal(s1.state, "MIGRATED", JSON.stringify(s1));
  assert.equal(s1.marked, nq);
  assert.equal(s1.passport.count, n0);
  assert.deepEqual(w.sheets.book[SHEET.queue][0].map(mtText), QUEUE_HEADERS.slice());
  for (const r of queue(w)) {
    assert.ok(mtText(r["Перевірка"]).startsWith(PENDING_TRANSFER_MARK), mtText(r["Offer ID"]));
    const r0 = byId(q0, mtText(r["Offer ID"]));
    for (const k of YML_HEADERS) assert.equal(mtText(r[k]), mtText(r0[k]), "рядок NEW92 незмінний: " + k);
  }
  assert.equal(readPassport(w.sheets.book[SHEET.passport]).count, n0);
  assert.deepEqual(main(w), main0, "основний каталог не змінено");

  // 2. CC — окремий штатний крок (тут двійник okCc). 3. Виправлення.
  const plan = steps.planOwnerCorrection(w.sheets.book[SHEET.main]);
  assert.equal(plan.ok, true, plan.problems.join());
  assert.equal(plan.replaced, 7, "7 замін у 4 полях");
  assert.deepEqual(plan.changes.map((c) => c.column), ["Опис UA", "Опис RU", "Запити UA", "Запити RU"]);
  const j0 = w.sheets.book[SHEET.journal].length;
  const c3 = await correction(w, structuredClone(plan));
  assert.equal(c3.state, "CORRECTED", JSON.stringify(c3));
  const fixed = byId(main(w), FIX);
  assert.equal(fixed["Опис UA"], "<p>Потужність 1500 Вт, енергія удару 5,5 Дж; 5,6 Дж — молодша модель, 16 Дж — старша; живлення 220 В, патрон 26 мм.</p>");
  assert.equal(fixed["Опис RU"], "<p>Мощность 1500 Вт, энергия удара 5,5 Дж.</p>");
  assert.equal(fixed["Запити UA"], "перфоратор 1500 Вт, перфоратор 5,5 Дж");
  assert.equal(fixed["Запити RU"], "перфоратор 1500 Вт");
  for (const k of Object.keys(fixed).filter((k) => !(k in FIX_TEXT))) assert.equal(mtText(fixed[k]), mtText(byId(main0, FIX)[k]), "інші поля не змінено: " + k);
  for (const r of main(w).filter((x) => mtText(x["Offer ID"]) !== FIX)) assert.deepEqual(r, byId(main0, mtText(r["Offer ID"])), "інші товари не змінено");
  const jFix = w.sheets.book[SHEET.journal].slice(j0);
  assert.equal(jFix.filter((e) => e[2] === FIX).length, 4, "журнал: 4 поля");
  assert.ok(jFix.every((e) => /РІШЕННЯ ВЛАСНИКА 29\.10\.2026/.test(e[6])));
  assert.deepEqual(sealBad(main(w)), [FIX], "печатка розходиться до QA");

  // 5 до 4: перенесення до QA — заборонено (печатка основного каталогу), жодного запису.
  const b5 = snapshotBook(w);
  const early = await transfer(w, 2);
  assert.equal(early.state, "PRECONDITION_FAILED");
  assert.deepEqual(early.checks.find((x) => /печатки основного каталогу/.test(x.name)).detail, [FIX]);
  assert.equal(snapshotBook(w), b5);

  // 4. QA ×2 (фід group_ids: охоплення основного каталогу повне).
  const jQa = w.sheets.book[SHEET.journal].length;
  const q1 = await qa(w, 3);
  assert.equal(q1.state, "SYNCED", JSON.stringify(q1).slice(0, 500));
  assert.equal(q1.sync.ownerPriority.isolated.length, 0);
  assert.equal(q1.presence.gone, 0);
  const q2 = await qa(w, 4);
  assert.ok(["SYNCED", "NO_CHANGES"].includes(q2.state), JSON.stringify(q2).slice(0, 300));
  assert.deepEqual(sealBad(main(w)), [], "QA узгодила печатки (аудит-маркер)");
  const afterQa = main(w);
  assert.equal(byId(afterQa, FIX)["Опис UA"], fixed["Опис UA"], "виправлення не перезаписано синхронізацією");
  for (const r of w.renamed) {
    const row = byId(afterQa, r.offerId);
    assert.equal(mtText(row["Назва постачальника UA"]), "Нова назва постачальника " + r.supplierId, "зміну назви постачальника прийнято");
    for (const k of SEO) assert.equal(mtText(row[k]), seo0.get(r.offerId)[k], `${r.offerId}: наше SEO «${k}» не змінено`);
  }
  for (const r of queue(w)) {
    assert.ok(mtText(r["Перевірка"]).startsWith(PENDING_TRANSFER_MARK), "QA не чіпає рядки, що чекають перенесення");
    const r0 = byId(q0, mtText(r["Offer ID"]));
    // «Знижка»: синтетичний текст «20%» записується числом 0.2 (у резервній копії TEST — уже числа); порівняння за значенням.
    const val = (k, x) => (k === "Знижка" ? String(run.sheetDiscount(x)) : mtText(x));
    for (const k of YML_HEADERS) assert.equal(val(k, r[k]), val(k, r0[k]), `${mtText(r["Offer ID"])}: «${k}» рядка черги не змінено QA`);
  }
  assert.notEqual(mtText(byId(queue(w), w.pricedPending)["Ціна постачальника"]), "12345");
  // «Журнал» не фіксує змін полів рядків, що чекають перенесення (рядок «ПОМИЛКА» зі станом зіставлення — як у mtRun — допустимий).
  assert.deepEqual(w.sheets.book[SHEET.journal].slice(jQa).filter((e) => w.queueIds.includes(mtText(e[2])) && e[3] !== "ПОМИЛКА"), [], "фантомні зміни рядків «ОЧІКУЄ ПЕРЕНЕСЕННЯ»");

  // 5. Перенесення.
  const t5 = await transfer(w, 5);
  assert.equal(t5.state, "TRANSFERRED", JSON.stringify(t5).slice(0, 600));
  assert.equal(t5.moved, nq);
  const m5 = main(w), ids5 = m5.map((r) => mtText(r["Offer ID"]));
  assert.equal(m5.length, n0 + nq);
  assert.equal(new Set(ids5).size, ids5.length, "нуль дублів Offer ID");
  for (const id of w.queueIds) {
    const r = byId(m5, id), r0 = byId(q0, id);
    assert.ok(r, "перенесено " + id);
    // «Знижка» в аркуші — число (0.2), у синтетичній черзі — текст «20%»: порівняння за значенням (sheetDiscount).
    for (const k of YML_HEADERS.filter((k) => k !== "Стан синхронізації" && k !== "Наявність")) assert.equal(k === "Знижка" ? String(run.sheetDiscount(r[k])) : mtText(r[k]), k === "Знижка" ? String(run.sheetDiscount(r0[k])) : mtText(r0[k]), `${id}: ${k}`);
    assert.ok(mtText(r[STATE_COLUMN]), "стан полів для режиму пріоритету власника: " + id);
    assert.match(mtText(byId(queue(w), id)["Перевірка"]), /^ПЕРЕНЕСЕНО В «ОСНОВНИЙ КАТАЛОГ»/);
  }
  assert.equal(queue(w).length, nq, "рядки черги лишились");
  assert.equal(mtText(byId(m5, w.absentId)[P.PRESENCE_COLUMN]), P.PRESENCE.ABSENT_IN_SNAPSHOT, "історична позначка (аналог 3236816949)");
  assert.equal(readPassport(w.sheets.book[SHEET.passport]).count, n0 + nq);
  assert.ok(w.sheets.log.every((x) => x.op !== "deleteRows"), "жодного видалення рядків");

  // 6. Перевірка: наступне «Оновити товари» — без ізоляції перенесених, поза охопленням — без змін і без «видалений».
  const absentBefore = { ...byId(m5, w.absentId) };
  const q6 = await qa(w, 6);
  assert.ok(["SYNCED", "NO_CHANGES"].includes(q6.state), JSON.stringify(q6).slice(0, 400));
  if (q6.sync?.ownerPriority) assert.equal(q6.sync.ownerPriority.isolated.length, 0, JSON.stringify(q6.sync.ownerPriority.isolated));
  assert.equal(q6.presence?.gone ?? 0, 0);
  const m6 = main(w);
  for (const sid of w.outOfScope) {
    const r = m6.find((x) => mtText(x["ID постачальника"]) === sid);
    assert.notEqual(mtText(r[P.PRESENCE_COLUMN]), P.PRESENCE.GONE);
  }
  for (const k of ["Наявність", P.PRESENCE_COLUMN, P.PRESENCE_META_COLUMN]) assert.equal(mtText(byId(m6, w.absentId)[k]), mtText(absentBefore[k]), "поза охопленням: " + k);
  assert.equal(new Set(m6.map((r) => mtText(r["Offer ID"]))).size, n0 + nq);
});

// ================================================================ неправильний порядок
test("ENG-28a порядок: QA до структури, QA без стану CC, виправлення до структури без паспорта — зупинка без жодного запису товарів", async () => {
  const w = world();
  const b0 = snapshotBook(w);
  const a = await qa(w, 1);
  assert.equal(a.state, "ABORTED");
  assert.match(a.reason, /не переведено в режим черги/);
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(w.sheets.book).filter(([k]) => k !== SHEET.journal))), JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(b0)).filter(([k]) => k !== SHEET.journal))));
  assert.equal((await structure(w)).state, "MIGRATED");
  const b1 = snapshotBook(w);
  const b = await qa(w, 2, { controls: null });
  assert.equal(b.state, "ABORTED");
  assert.match(b.reason, /Catalog Controls/);
  const keep = (s) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(s)).filter(([k]) => k !== SHEET.journal)));
  assert.equal(keep(snapshotBook(w)), keep(b1));
  // Синхронізація без паспорта (режим пріоритету власника): чиста зупинка замість TypeError, до запису товарів.
  const w2 = world();
  await steps.migrateQueueForTransfer({ sheets: w2.sheets, readBook: w2.readBook, stamp: at(0) });
  delete w2.sheets.book[SHEET.passport];
  const b2 = snapshotBook(w2);
  const c = await qa(w2, 3);
  assert.equal(c.state, "ABORTED", JSON.stringify(c).slice(0, 300));
  assert.match(c.reason, /немає аркуша «Паспорт каталогу»/);
  assert.equal(keep(snapshotBook(w2)), keep(b2));
});

// ================================================================ повторні запуски
test("ENG-28a повтор: структура → NOTHING; виправлення → BLOCKED («змін немає»); QA тим самим фідом → NO_CHANGES; перенесення → NOTHING; без дублів і без записів", async () => {
  const w = world();
  await structure(w);
  const plan = steps.planOwnerCorrection(w.sheets.book[SHEET.main]);
  assert.equal((await correction(w, plan)).state, "CORRECTED");
  await qa(w, 3);
  assert.equal((await transfer(w, 5)).state, "TRANSFERRED");
  const b = snapshotBook(w), mark = w.sheets.log.length;
  assert.equal((await structure(w)).state, "NOTHING");
  const c2 = await correction(w, plan);
  assert.equal(c2.state, "BLOCKED");
  assert.match(c2.problems.join(), /змін немає/);
  const t2 = await transfer(w, 6);
  assert.equal(t2.state, "NOTHING");
  assert.equal(snapshotBook(w), b, "жодної зміни");
  assert.equal(w.sheets.log.length, mark, "жодного запису");
  const qSame = await updateProducts({ sheets: guarded(w, "update"), readBook: w.readBook, xml: dated(w.xml, 3), source: FILTERED_URL, fetchedAt: at(7), stamp: at(7), now: NOW + 7 * 60_000, config: cfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store });
  assert.equal(qSame.state, "NO_CHANGES");
  assert.equal(new Set(main(w).map((r) => mtText(r["Offer ID"]))).size, main(w).length);
});

// ================================================================ виправлення 1561514532: межі процедури
test("ENG-28a виправлення: лише Offer ID 1561514532, лише 4 поля, лише пари 1700→1500 Вт і 6→5,5 Дж; «5,6 Дж», «16 Дж», «26 мм», «220 В» не чіпаються", () => {
  assert.equal(steps.correctText("1700 Вт; 1700Вт; 21700 Вт; 1700 Вт·год; 1700 Вт⋅год; 6 Дж; 6Дж; 5,6 Дж; 16 Дж; 6,5 Дж; 26 мм; 220 В; 6 кг"), "1500 Вт; 1500Вт; 21700 Вт; 1700 Вт·год; 1700 Вт⋅год; 5,5 Дж; 5,5Дж; 5,6 Дж; 16 Дж; 6,5 Дж; 26 мм; 220 В; 6 кг");
  const w = world();
  const p = steps.planOwnerCorrection(w.sheets.book[SHEET.main]);
  assert.ok(p.changes.every((c) => c.pairs.every(([a, b]) => (a === "1700" && b === "1500") || (a === "6" && b === "5,5"))));
  // Товару немає / дубль Offer ID — BLOCKED.
  const noRow = structuredClone(w.sheets.book[SHEET.main]);
  noRow[6][0] = "999"; noRow.splice(6, 1);
  const h = noRow[0].map(mtText);
  const idx = noRow.findIndex((r) => mtText(r[h.indexOf("Offer ID")]) === FIX);
  noRow[idx][h.indexOf("Offer ID")] = "1561514533";
  assert.match(steps.planOwnerCorrection(noRow).problems.join(), /рядків 0/);
  const dup = structuredClone(w.sheets.book[SHEET.main]);
  dup.push(dup[5].slice());
  assert.match(steps.planOwnerCorrection(dup).problems.join(), /рядків 2/);
  // Немає що виправляти — BLOCKED («уже виправлено?»).
  const done = structuredClone(w.sheets.book[SHEET.main]);
  for (const k of Object.keys(FIX_TEXT)) done[5][h.indexOf(k)] = steps.correctText(done[5][h.indexOf(k)]);
  assert.match(steps.planOwnerCorrection(done).problems.join(), /змін немає/);
});

test("ENG-28a виправлення: поточні значення ≠ погодженого dry-run — BLOCKED без запису; dry-run обов'язковий у CLI", async () => {
  const w = world();
  await steps.migrateQueueForTransfer({ sheets: w.sheets, readBook: w.readBook, stamp: at(0) });
  const plan = steps.planOwnerCorrection(w.sheets.book[SHEET.main]);
  const stale = structuredClone(plan);
  stale.changes[0].expect = stale.changes[0].expect.replace("патрон 26 мм", "патрон 28 мм");
  const b = snapshotBook(w), mark = w.sheets.log.length;
  const r = await correction(w, stale);
  assert.equal(r.state, "BLOCKED");
  assert.match(r.problems.join(), /відрізняються від погодженого dry-run/);
  const r2 = await correction(w, { changes: plan.changes.slice(1) });
  assert.equal(r2.state, "BLOCKED", "неповний погоджений план — теж відмова");
  assert.equal(snapshotBook(w), b);
  assert.equal(w.sheets.log.length, mark);
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../tools/sheet-sync.mjs", import.meta.url), "utf8");
  assert.match(src, /mode === "correction"[\s\S]{0,400}arg\("expected"\)/, "CLI вимагає --expected=<план dry-run>");
});

// ================================================================ конфлікти власника й конкурентні правки
test("ENG-28a конкурентна правка під час виправлення: власник змінив «Опис UA» 1561514532 між читанням і записом — CONFLICT_OWNER_EDIT, жодне з 4 полів не записано, правку збережено, «Журнал» без запису про виправлення", async () => {
  const w = world();
  await steps.migrateQueueForTransfer({ sheets: w.sheets, readBook: w.readBook, stamp: at(0) });
  const plan = steps.planOwnerCorrection(w.sheets.book[SHEET.main]);
  let n = 0;
  const readBook = async () => { if (++n === 2) w.sheets.humanSet(SHEET.main, mRowNo(w, FIX), "Опис UA", "<p>Правка власника: 1700 Вт</p>"); return w.sheets.read(); };
  const j0 = w.sheets.book[SHEET.journal].length;
  const r = await correction(w, plan, { readBook });
  assert.equal(r.state, "CONFLICT_OWNER_EDIT", JSON.stringify(r).slice(0, 300));
  const row = byId(main(w), FIX);
  assert.equal(row["Опис UA"], "<p>Правка власника: 1700 Вт</p>", "правку власника збережено");
  for (const k of ["Опис RU", "Запити UA", "Запити RU"]) assert.equal(row[k], FIX_TEXT[k], "не записано: " + k);
  assert.equal(w.sheets.book[SHEET.journal].length, j0);
  // Повтор із тим самим погодженим планом — BLOCKED (значення вже інші): потрібне нове рішення власника, не «сліпий» повтор.
  assert.equal((await correction(w, plan)).state, "BLOCKED");
});

test("ENG-28a конкурентна правка іншого поля під час виправлення: власник змінив «Назва UA» у вікні запису — 4 поля виправлено, правку збережено, повторна QA-перевірка → INCOMPLETE (рішення людини)", async () => {
  const w = world();
  await steps.migrateQueueForTransfer({ sheets: w.sheets, readBook: w.readBook, stamp: at(0) });
  const plan = steps.planOwnerCorrection(w.sheets.book[SHEET.main]);
  let once = true;
  w.sheets.beforeWrite = (op, args) => { if (once && op === "updateRanges" && args.some((b) => b.title === SHEET.main)) { once = false; w.sheets.humanSet(SHEET.main, mRowNo(w, FIX), "Назва UA", "Назва власника"); } };
  const r = await correction(w, plan);
  w.sheets.beforeWrite = null;
  assert.equal(r.state, "INCOMPLETE", JSON.stringify(r).slice(0, 300));
  assert.equal(r.needsDecision, true);
  assert.deepEqual(r.qa.otherChanged, ["Назва UA"]);
  const row = byId(main(w), FIX);
  assert.equal(row["Назва UA"], "Назва власника");
  for (const c of plan.changes) assert.equal(row[c.column], c.set);
});

test("ENG-28a виправлення: після погоджених замін лишається заборонене значення (напр. «1700 Вт·год» — інша одиниця) — BLOCKED без запису, рішення власника", async () => {
  const w = world();
  w.sheets.humanSet(SHEET.main, mRowNo(w, FIX), "Запити RU", "перфоратор 1700 Вт·год");
  const p = steps.planOwnerCorrection(w.sheets.book[SHEET.main]);
  assert.equal(p.ok, false);
  assert.match(p.problems.join(), /лишаються заборонені значення: .*«Запити RU»/);
  const b = snapshotBook(w);
  const r = await steps.applyOwnerCorrection({ sheets: w.sheets, readBook: w.readBook, stamp: at(1), expected: p });
  assert.equal(r.state, "BLOCKED");
  assert.equal(snapshotBook(w), b);
});

test("ENG-28a intake: рядки, що чекають перенесення, не оновлюються (ціни, назви, печатки); нова позиція — окремим рядком черги", async () => {
  const w = world();
  await structure(w);
  await correction(w, steps.planOwnerCorrection(w.sheets.book[SHEET.main]));
  assert.equal((await qa(w, 3)).state, "SYNCED");
  const q0 = queue(w);
  const pendingSid = mtText(byId(q0, w.queueIds[1])["ID постачальника"]);
  let xml = perturb.tag(dated(w.xml, 4), pendingSid, "name_ua", "Інша назва постачальника");
  const extra = `<offer id="2990000777" available="true"><url>https://market-tools.com.ua/p2990000777-x.html</url><price>500</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>Новий</name><name_ua>Новий</name_ua><vendorCode>NEW-777</vendorCode><picture>https://images.prom.ua/1_n.jpg</picture><param name="Потужність" unit="Вт">10</param><description>Опис</description></offer>`;
  xml = xml.replace("\n</offers>", "\n" + extra + "\n</offers>");
  const { intakeAll } = await import("./helpers/intake.mjs");
  const r = await intakeAll(w, xml, { session: "auto", stamp: at(4), now: NOW + 4 * 60_000, config: cfg(), catalog: EMPTY_CATALOG, controls: okCc() });
  assert.equal(r.state, "INTAKE_DONE", JSON.stringify(r).slice(0, 400));
  const q1 = queue(w);
  for (const id of w.queueIds) {
    const a = byId(q0, id), b = byId(q1, id);
    for (const k of Object.keys(a)) assert.equal(mtText(b[k]), mtText(a[k]), `${id}: «${k}» не змінено intake`);
  }
  assert.ok(q1.some((x) => mtText(x["ID постачальника"]) === "2990000777"), "нова позиція — окремим рядком");
  assert.equal(sealBad(q1.filter((x) => w.queueIds.includes(mtText(x["Offer ID"])))).length, 0, "печатки NEW92 цілі");
  // ENG-28b: нова позиція intake — не рядок NEW92: переносяться лише рядки «ОЧІКУЄ…», нова лишається в черзі без змін.
  const newRow0 = { ...q1.find((x) => mtText(x["ID постачальника"]) === "2990000777") };
  const t = await transfer(w, 5);
  assert.equal(t.state, "TRANSFERRED", JSON.stringify(t).slice(0, 400));
  assert.equal(t.moved, w.queueIds.length);
  assert.ok(!main(w).some((x) => mtText(x["ID постачальника"]) === "2990000777"), "нова позиція не перенесена");
  assert.deepEqual(queue(w).find((x) => mtText(x["ID постачальника"]) === "2990000777"), newRow0, "рядок новинки не змінено");
  // Повтор структури після перенесення, коли в черзі є новинка intake (не «ОЧІКУЄ…» і не «ПЕРЕНЕСЕНО…») — NOTHING, без записів.
  const mark = w.sheets.log.length;
  assert.equal((await structure(w)).state, "NOTHING");
  assert.equal(w.sheets.log.length, mark);
});

test("ENG-28a конкурентна правка під час міграції структури: власник пише в «Перевірку» рядка — INCOMPLETE (рішення людини), повтор — PRECONDITION_FAILED без записів; перенесення заблоковане", async () => {
  const w = world();
  const target = w.queueIds[2];
  let n = 0;
  const readBook = async () => { if (++n === 2) w.sheets.humanSet(SHEET.queue, qRowNo(w, target), "Перевірка", "примітка власника"); return w.sheets.read(); };
  const r = await structure(w, { readBook });
  assert.equal(r.state, "INCOMPLETE", JSON.stringify(r).slice(0, 300));
  assert.equal(r.needsDecision, true);
  assert.equal(byId(queue(w), target)["Перевірка"], "примітка власника", "правку власника не перезаписано");
  assert.equal(w.sheets.book[SHEET.passport], undefined, "після зупинки далі нічого не пишеться (паспорт не створено)");
  assert.ok(!w.sheets.book[SHEET.journal].some((e) => e[3] === "СТРУКТУРА (ENG-28a)"));
  const b = snapshotBook(w), mark = w.sheets.log.length;
  const r2 = await structure(w);
  assert.equal(r2.state, "PRECONDITION_FAILED");
  assert.equal(snapshotBook(w), b);
  assert.equal(w.sheets.log.length, mark);
  const t = await transfer(w, 5);
  assert.equal(t.state, "PRECONDITION_FAILED");
  assert.equal(snapshotBook(w), b);
});

async function readyForTransfer() {
  const w = world();
  await structure(w);
  await correction(w, steps.planOwnerCorrection(w.sheets.book[SHEET.main]));
  await qa(w, 3);
  return w;
}

test("ENG-28a конкурентна правка під час перенесення: власник змінив «Перевірку» рядка черги до запису позначок — INCOMPLETE (рішення людини), правку збережено; нуль дублів; повтор не дублює", async () => {
  const w = await readyForTransfer();
  const n0 = main(w).length;
  const target = w.queueIds[1];
  let once = true;
  // Правка власника після читання плану, до свіжого читання позначок черги (під час дописування рядків в основний каталог).
  w.sheets.beforeWrite = (op, args) => { if (once && op === "appendRows" && args.title === SHEET.main) { once = false; w.sheets.humanSet(SHEET.queue, qRowNo(w, target), "Перевірка", "власник: перевірити ще раз"); } };
  const r = await transfer(w, 5);
  w.sheets.beforeWrite = null;
  assert.equal(r.state, "INCOMPLETE", JSON.stringify(r).slice(0, 400));
  assert.equal(r.needsDecision, true);
  assert.equal(byId(queue(w), target)["Перевірка"], "власник: перевірити ще раз", "правку власника збережено");
  const ids = main(w).map((x) => mtText(x["Offer ID"]));
  assert.equal(new Set(ids).size, ids.length, "нуль дублів");
  assert.equal(ids.length, n0 + w.queueIds.length, "рядки дописано за ключем рівно один раз");
  const b = snapshotBook(w);
  const r2 = await transfer(w, 6);
  assert.equal(r2.state, "PRECONDITION_FAILED", "повтор — не «сліпий»: потрібне рішення власника");
  assert.equal(snapshotBook(w), b, "повтор нічого не записав");
});

test("ENG-28a R-N3W (ВІДКРИТО, не закрито): правка власника в мілісекундному вікні між свіжим читанням і записом позначок перезаписується — Sheets API не має умовного запису (CAS)", async () => {
  const w = await readyForTransfer();
  const target = w.queueIds[1];
  let once = true;
  w.sheets.beforeWrite = (op, args) => { if (once && op === "updateRanges" && args.some((b) => b.title === SHEET.queue)) { once = false; w.sheets.humanSet(SHEET.queue, qRowNo(w, target), "Перевірка", "власник: у вікні запису"); } };
  const r = await transfer(w, 5);
  w.sheets.beforeWrite = null;
  // Залишковий ризик зафіксовано тестом: результат TRANSFERRED, правку у вікні запису не виявлено. Пом'якшення — лише організаційне
  // (передумова власника: під час контрольованого запуску таблицю ніхто не редагує, тригери вимкнено).
  assert.equal(r.state, "TRANSFERRED");
  assert.match(mtText(byId(queue(w), target)["Перевірка"]), /^ПЕРЕНЕСЕНО/);
});

test("ENG-28a рішення власника на рядках, що чекають перенесення: QA їх не виконує й не стирає; після перенесення «Рішення» і 6 колонок B6 незмінні; «ВІДХИЛЕНО» вже перенесеного — відмова (N4)", async () => {
  const w = world();
  await structure(w);
  const [a, b] = w.queueIds;
  w.sheets.humanSet(SHEET.queue, qRowNo(w, a), "Рішення", DECISION.APPROVE);
  w.sheets.humanSet(SHEET.queue, qRowNo(w, b), "Рішення", DECISION.REJECT);
  const b6 = B6_QUEUE.length ? B6_QUEUE[0] : null;
  if (b6) w.sheets.humanSet(SHEET.queue, qRowNo(w, b), b6, "значення власника");
  const snapB6 = new Map(queue(w).map((r) => [mtText(r["Offer ID"]), Object.fromEntries([...B6_QUEUE, "Рішення"].map((k) => [k, mtText(r[k])]))]));
  await correction(w, steps.planOwnerCorrection(w.sheets.book[SHEET.main]));
  const q = await qa(w, 3);
  assert.equal(q.state, "SYNCED", JSON.stringify(q).slice(0, 300));
  assert.equal(q.sync.stats?.approved ?? 0, 0, "ЗАТВЕРДЖЕНО на рядку, що чекає перенесення, — не виконано окремо");
  assert.equal(q.sync.stats?.rejected ?? 0, 0);
  assert.ok(!(w.sheets.book[SHEET.frozen] || []).some((r) => mtText(r[0]) === b), "у «Заморожені ID» не додано");
  for (const r of queue(w)) assert.ok(mtText(r["Перевірка"]).startsWith(PENDING_TRANSFER_MARK));
  assert.equal((await transfer(w, 5)).state, "TRANSFERRED");
  for (const r of queue(w)) for (const [k, v] of Object.entries(snapB6.get(mtText(r["Offer ID"])))) assert.equal(mtText(r[k]), v, `${mtText(r["Offer ID"])}: ${k}`);
  const q2 = await qa(w, 6);
  assert.ok(["SYNCED", "NO_CHANGES"].includes(q2.state));
  assert.ok(main(w).some((r) => mtText(r["Offer ID"]) === b), "перенесений товар лишився в каталозі");
  if (q2.sync?.decisionRefused) assert.ok(q2.sync.decisionRefused.some((x) => x.offerId === b), "N4: відмова з поясненням");
  assert.ok(!(w.sheets.book[SHEET.frozen] || []).some((r) => mtText(r[0]) === b));
});
