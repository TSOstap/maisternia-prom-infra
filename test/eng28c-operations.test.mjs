/** ENG-28c (рішення власника 01.11.2026) — три незалежні операції й вузький QA:
 *   - QA погоджених товарів — лише їхні рядки й наявні системні колонки; порушена печатка — лише з поясненням рішенням власника;
 *     службових аркушів і нових колонок немає; перенесення 92 — без повного оновлення;
 *   - «Оновити товари» — черги не торкається (новинки, рішення, сирі дані черги); «поза охопленням фіду» — нейтральний стан один раз;
 *   - «Знайти нові товари» — лише черга, звірка з відхиленими / відкладеними / видаленими, стабільність, без дублів;
 *   - М1 (бюджет запитів до першого запису), М2 (перше заповнення ≠ зміна), М3 (службові рядки до товарних даних; збій — зупинка).
 *  Синтетика, таблиця в пам'яті, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { rowSeal, SEAL_COLUMN } from "../src/core/seal.mjs";
import * as SS from "../src/core/sheet-sync.mjs";
import * as FC from "../src/core/field-control.mjs";
import * as P from "../src/core/supplier-presence.mjs";
import * as run from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets, GoogleSheetsWriter, estimateRequests } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import * as WT from "../src/pipeline/safe-write/write-target.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { updateProducts } from "../src/pipeline/update-products.mjs";
import { qaProducts, explainSeal, QA_COLUMNS } from "../src/pipeline/qa-products.mjs";
import { findNewProducts } from "../src/pipeline/find-new.mjs";
import * as steps from "../src/pipeline/eng28a-steps.mjs";
import { ARCHIVE_SHEET } from "../src/core/archive.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const { SHEET } = SS;
const NOW = Date.parse("2026-10-22T10:00:00Z");
const at = (min) => new Date(NOW + min * 60_000).toISOString();
const SNAP_DATE = "2026-10-29T18:20:40.743Z";
const FIX = "1561514532";
const FILTERED_URL = "https://market-tools.com.ua/feed.xml?key=SECRET&group_ids=101,102";
const FULL_URL = "https://market-tools.com.ua/feed.xml?key=SECRET";
/** Робоча точка (productionConfig: пріоритет власника, preserve). Поріг зникнення — справжній (min(50; ⌈2 %⌉), ≥). */
const cfg = (f) => { const c = productionConfig(structuredClone(baseConfig)); c.supplier.minimumOffers = 10; f?.(c); return c; };
const okCc = (removed = []) => Object.freeze({ held: new Set(), removed: new Set(removed), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp-", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
const full = (xml) => xml.replace(/<\/offer>/g, "<description>Опис постачальника</description></offer>");
const dated = (xml, min) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 3 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });
const FIX_TEXT = { "Опис UA": "<p>Потужність 1700 Вт, енергія удару 6 Дж; живлення 220 В.</p>", "Опис RU": "<p>Мощность 1700 Вт, энергия удара 6 Дж.</p>", "Запити UA": "перфоратор 1700 Вт, перфоратор 6 Дж", "Запити RU": "перфоратор 1700 Вт" };
const offer = (id, extra = "") => `<offer id="${id}" available="true"><url>https://market-tools.com.ua/p${id}-x.html</url><price>500</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>Новий ${id}</name><name_ua>Новий ${id}</name_ua><vendorCode>NEW-${id}</vendorCode><picture>https://images.prom.ua/${id}_n.jpg</picture><param name="Потужність" unit="Вт">10</param><description>Опис</description>${extra}</offer>`;

/** Тестова копія як резервна копія TEST 01.11: NEW92 (40 колонок), без паспорта; 1561514532 — печатку порушила ручна часткова правка
 *  («1700 Вт» → «1500 Вт» в «Опис UA» без перепечатування, як у LIVE); 4 товари — нові назви постачальника (ЗМІНА_ІДЕНТИЧНОСТІ). */
function world({ queue = 8 } = {}) {
  const s = generateSynthetic({ products: 60, queue, deferred: 2, newOffers: 0, seed: 31, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const h = book[SHEET.main][0].map(mtText);
  const v = book[SHEET.main][5];
  v[h.indexOf("Offer ID")] = FIX;
  for (const [k, x] of Object.entries(FIX_TEXT)) v[h.indexOf(k)] = x;
  v[h.indexOf(SEAL_COLUMN)] = rowSeal(Object.fromEntries(h.map((k, j) => [k, v[j] ?? ""])));
  v[h.indexOf("Опис UA")] = FIX_TEXT["Опис UA"].replace("1700 Вт", "1500 Вт"); // ручна часткова правка в LIVE — печатка порушена
  const mainRows = readSheet(book[SHEET.main], SHEET.main).rows;
  const qh = book[SHEET.queue][0].map(mtText);
  const absent = book[SHEET.queue][3];
  absent[qh.indexOf("Стан синхронізації")] = "ВІДСУТНІЙ_У_YML";
  const qRows0 = readSheet(book[SHEET.queue], SHEET.queue).rows;
  const w = { s, sheets: new MemorySheets(book), store: new MemoryStore(), w2: new MemoryStore(), absentId: mtText(absent[0]) };
  w.readBook = async () => w.sheets.read();
  w.qa = [FIX, ...mainRows.slice(10, 14).map((r) => mtText(r["Offer ID"]))];
  const sidOf = (id) => mtText(mainRows.find((r) => mtText(r["Offer ID"]) === id)["ID постачальника"]);
  for (const id of w.qa) { const i = mainRows.findIndex((r) => mtText(r["Offer ID"]) === id) + 1; book[SHEET.main][i][h.indexOf("Стан синхронізації")] = "ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ"; }
  // Стан синхронізації — не запечатаний (LIVE), печатки решти — цілі.
  w.outOfScope = [qRows0[2], qRows0[5], qRows0[6]].map((r) => mtText(r["ID постачальника"]));
  let xml = perturb.drop(full(s.supplierXml()), w.outOfScope);
  for (const id of w.qa) xml = perturb.tag(xml, sidOf(id), "name_ua", "Нова назва постачальника " + sidOf(id));
  w.xml = xml;
  w.queueIds = qRows0.map((r) => mtText(r["Offer ID"]));
  return w;
}
const headersOf = (w) => Object.fromEntries(Object.entries(w.sheets.book).map(([k, v]) => [k, (v[0] || []).slice()]));
const guarded = (w, mode) => WT.guardedSheets(w.sheets, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES[mode], headers: headersOf(w) });
const session = (w, mode, writer) => new WriteGateway({ sheets: guarded(w, mode), read: w.readBook, store: w.w2 }).open({ writer });
const structure = (w) => steps.migrateQueueForTransfer({ sheets: guarded(w, "structure"), readBook: w.readBook, stamp: at(0) });
const correction = (w) => steps.applyOwnerCorrection({ sheets: guarded(w, "correction"), readBook: w.readBook, stamp: at(1), expected: steps.planOwnerCorrection(w.sheets.book[SHEET.main]) });
async function qa(w, min, o = {}) {
  const s = await session(w, "qa", "sync");
  try { return await qaProducts({ sheets: guarded(w, "qa"), readBook: w.readBook, xml: dated(o.xml || w.xml, min), source: FILTERED_URL, fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config: cfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, session: s, ids: o.ids || w.qa, expected: o.expected ?? null }); }
  finally { await s.close(); }
}
const transfer = (w, min = 5) => run.transferNew92({ sheets: guarded(w, "merge"), readBook: w.readBook, stamp: at(min), snapshotDate: SNAP_DATE, expectCount: w.queueIds.length });
async function update(w, min, o = {}) {
  const s = await session(w, "update", "sync");
  try { return await updateProducts({ sheets: guarded(w, "update"), readBook: w.readBook, xml: o.raw ? o.xml : dated(o.xml || w.xml, min), source: o.source || FILTERED_URL, fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config: o.config || cfg(), catalog: EMPTY_CATALOG, controls: o.controls || okCc(), snapshotStore: w.store, session: s, writeBudget: o.writeBudget ?? null }); }
  finally { await s.close(); }
}
async function findNew(w, min, o = {}) {
  const s = await session(w, "find-new", "intake");
  try { return await findNewProducts({ sheets: guarded(w, "find-new"), readBook: w.readBook, xml: o.raw ? o.xml : dated(o.xml || w.xml, min), source: o.source || FILTERED_URL, fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config: cfg(), catalog: EMPTY_CATALOG, controls: o.controls || okCc(), snapshotStore: w.store, session: s }); }
  finally { await s.close(); }
}
const main = (w) => readSheet(w.sheets.book[SHEET.main], SHEET.main).rows;
const queue = (w) => readSheet(w.sheets.book[SHEET.queue], SHEET.queue).rows;
const byId = (rows, id) => rows.find((r) => mtText(r["Offer ID"]) === id);
const sealBad = (rows) => rows.filter((r) => rowSeal(r) !== mtText(r[SEAL_COLUMN])).map((r) => mtText(r["Offer ID"]));
const journal = (w) => w.sheets.book[SHEET.journal].slice(1);
/** Рядки службового аркуша як об'єкти (за заголовком; аркуша немає — порожньо). */
const sheetRows = (v) => (v?.length ? v.slice(1).map((r) => Object.fromEntries(v[0].map((k, j) => [mtText(k), r[j] ?? ""]))) : []);

// ================================================================ послідовність: структура → виправлення → QA → перенесення → оновлення
test("ENG-28c: структура → виправлення → вузький QA (лише QA-рядки, печатку 1561514532 визнано рішенням власника, без службових аркушів) → перенесення без повного оновлення → «Оновити товари» (М2, нейтральний стан, черга без змін)", async () => {
  const w = world();
  assert.deepEqual(sealBad(main(w)), [FIX], "передумова: печатку 1561514532 порушено, як у резервній копії TEST");
  assert.equal((await structure(w)).state, "MIGRATED");
  assert.equal((await correction(w)).state, "CORRECTED");
  assert.equal((await transfer(w)).state, "PRECONDITION_FAILED", "до QA перенесення неможливе (печатка)");
  const header0 = w.sheets.book[SHEET.main][0].map(mtText);
  const before = new Map(main(w).map((r) => [mtText(r["Offer ID"]), JSON.stringify(r)]));
  // План dry-run (інший запуск, інший час) → запис із --expected: «Оновлено» (час запуску) не робить плани різними.
  const plan = await qaProducts({ sheets: guarded(w, "qa"), readBook: w.readBook, xml: dated(w.xml, 2), source: FILTERED_URL, fetchedAt: at(2), stamp: at(2), now: NOW + 2 * 60_000, config: cfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, ids: w.qa, planOnly: true });
  assert.equal(plan.state, "PLANNED", JSON.stringify(plan).slice(0, 300));
  assert.equal(JSON.stringify(main(w)), JSON.stringify([...before.values()].map((x) => JSON.parse(x))), "план — без записів");
  const q = await qa(w, 3, { expected: plan.qaPlan });
  assert.equal(q.state, "QA_DONE", JSON.stringify(q).slice(0, 600));
  assert.equal(q.seals.find((s) => s.offerId === FIX).kind, "EXPLAINED");
  for (const it of q.items) assert.equal(it.stateAfter, "ЗІСТАВЛЕНО", it.offerId);
  assert.deepEqual(q.verify, { rows: true, qaApplied: true, qaSeals: true, othersUnchanged: true });
  for (const [id, row] of before) if (!w.qa.includes(id)) assert.equal(JSON.stringify(byId(main(w), id)), row, id + ": поза QA без змін");
  for (const it of q.items) for (const k of it.columns) assert.ok(QA_COLUMNS.includes(k), `${it.offerId}: ${k}`);
  for (const id of w.qa) for (const k of ["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Запити UA", "Запити RU", "Характеристики JSON"]) assert.equal(mtText(byId(main(w), id)[k]), mtText(JSON.parse(before.get(id))[k]), `${id}: ${k}`);
  assert.deepEqual(w.sheets.book[SHEET.main][0].map(mtText), header0, "нових колонок немає");
  assert.ok(!w.sheets.book["Класифікація полів"] && !w.sheets.book["Попередження постачальника"], "службових аркушів QA не створює");
  assert.ok(journal(w).some((e) => e[2] === FIX && /^ПЕЧАТКУ ВИЗНАНО/.test(mtText(e[6]))));
  assert.deepEqual(sealBad(main(w)), [], "печатки цілі");
  assert.equal((await qa(w, 4)).state, "NOTHING", "повтор QA — без записів");
  const logQ = w.sheets.log.length;
  assert.equal((await qa(w, 5, { expected: plan.qaPlan })).state, "NOTHING", "повтор із погодженим планом — теж NOTHING");
  assert.equal(w.sheets.log.length, logQ, "повтор QA нічого не пише");
  // Перенесення — без повного оновлення.
  const t = await transfer(w);
  assert.equal(t.state, "TRANSFERRED", JSON.stringify(t).slice(0, 400));
  assert.equal(main(w).length, 60 + w.queueIds.length);
  assert.equal((await transfer(w, 6)).state, "NOTHING");
  // Перше «Оновити товари»: черга без змін; «поза охопленням» — нейтральний стан, без «ПОМИЛКА»; М2 — жодного попередження «перше заповнення».
  const q0 = JSON.stringify(w.sheets.book[SHEET.queue]);
  const u = await update(w, 10);
  assert.equal(u.state, "SYNCED", JSON.stringify(u).slice(0, 500));
  assert.equal(JSON.stringify(w.sheets.book[SHEET.queue]), q0, "черга без змін");
  const outIds = w.outOfScope.map((sid) => mtText(byId(queue(w), queue(w).find((r) => mtText(r["ID постачальника"]) === sid)?.["Offer ID"])?.["Offer ID"]));
  for (const id of outIds) assert.equal(mtText(byId(main(w), id)[P.PRESENCE_COLUMN]), id === w.absentId ? P.PRESENCE.ABSENT_IN_SNAPSHOT : P.OUT_OF_SCOPE_PRESENCE, id);
  assert.ok(!journal(w).some((e) => e[3] === "ПОМИЛКА" && e[6] === SS.OUT_OF_SCOPE));
  const warn = sheetRows(w.sheets.book["Попередження постачальника"]);
  assert.equal(warn.filter((r) => !mtText(r["Було (постачальник)"]).trim()).length, 0, "М2: перше заповнення — не попередження");
  assert.ok(w.sheets.book["Класифікація полів"].length > 1, "класифікація полів (правила власності) — є");
  // Повтор із новою датою й тим самим вмістом: жодних нових попереджень, «ПОМИЛКА» поза охопленням, нейтральних позначок.
  const j0 = journal(w).length, w0 = (w.sheets.book["Попередження постачальника"] || []).length;
  const u2 = await update(w, 250);
  assert.equal(u2.state, "SYNCED");
  const added = journal(w).slice(j0);
  assert.equal((w.sheets.book["Попередження постачальника"] || []).length, w0);
  assert.ok(added.every((e) => e[3] === "ЗАВЕРШЕНО" || ["Ціна постачальника", "Ціна", "Ціна кінцева", "Знижка", "Наявність", "Кількість постачальника"].includes(e[3])), JSON.stringify(added.map((e) => e[3])));
  assert.equal(added.filter((e) => e[3] === "ЗАВЕРШЕНО").length, 1);
  assert.equal((await update(w, 250)).state, "NO_CHANGES", "той самий YML — нічого");
});

test("ENG-28c QA: порушена печатка, НЕ пояснена рішенням власника → BLOCKED без жодного запису; план поза QA-колонками → BLOCKED; погоджений план ≠ поточного → BLOCKED", async () => {
  const w = world();
  await structure(w); await correction(w);
  const h = w.sheets.book[SHEET.main][0].map(mtText);
  const i = w.sheets.book[SHEET.main].findIndex((r, k) => k > 0 && mtText(r[0]) === FIX);
  const keep = w.sheets.book[SHEET.main][i][h.indexOf("Модель")];
  w.sheets.book[SHEET.main][i][h.indexOf("Модель")] = "ІНША МОДЕЛЬ"; // ще одна непояснена правка запечатаного поля
  const snap = JSON.stringify(w.sheets.book), log0 = w.sheets.log.length;
  const r = await qa(w, 3);
  assert.equal(r.state, "BLOCKED", JSON.stringify(r).slice(0, 300));
  assert.match(r.reason, /не пояснюється погодженим рішенням власника/);
  assert.equal(JSON.stringify(w.sheets.book), snap); assert.equal(w.sheets.log.length, log0);
  w.sheets.book[SHEET.main][i][h.indexOf("Модель")] = keep;
  assert.equal(explainSeal(byId(main(w), FIX)).kind, "EXPLAINED");
  const wrong = await qa(w, 3, { expected: { changes: [] } });
  assert.equal(wrong.state, "BLOCKED"); assert.match(wrong.reason, /погодженого dry-run/);
  assert.equal(JSON.stringify(w.sheets.book), snap.replace("ІНША МОДЕЛЬ", mtText(keep)));
  // Охоронець режиму qa: SEO-колонку записати неможливо.
  await assert.rejects(guarded(w, "qa").updateRanges([{ title: SHEET.main, row: i + 1, col: h.indexOf("Назва UA") + 1, values: [["x"]] }]), /не дозволена/);
});

// ================================================================ М3: службові рядки до товарних даних
test("ENG-28c М3: збій дописування «Попереджень постачальника» → товарні дані НЕ записано, стан полів не просунуто, подія в «Журналі»; повтор допише попередження рівно один раз; «відповідь втрачено» після застосування — без дублів", async () => {
  const w = world();
  await structure(w); await correction(w); await qa(w, 3); await transfer(w);
  assert.equal((await update(w, 10)).state, "SYNCED");
  const target = main(w)[20], sid = mtText(target["ID постачальника"]);
  const xml2 = perturb.tag(w.xml, sid, "name_ua", "Справжня зміна назви " + sid);
  const warnRows = () => JSON.stringify((w.sheets.book["Попередження постачальника"] || []).slice(1));
  const mainSnap = JSON.stringify(w.sheets.book[SHEET.main]), warnSnap = warnRows();
  const j0 = journal(w).length;
  w.sheets.armFault({ op: "appendRows", nth: 1, mode: "reject" });
  const r = await update(w, 300, { xml: xml2 });
  assert.notEqual(r.state, "SYNCED", JSON.stringify(r).slice(0, 300));
  assert.equal(JSON.stringify(w.sheets.book[SHEET.main]), mainSnap, "товарні дані / стан полів не записано");
  assert.equal(warnRows(), warnSnap, "рядків попереджень не дописано");
  assert.ok(journal(w).slice(j0).some((e) => e[3] === "ПОМИЛКА" && /Попередження постачальника/.test(mtText(e[6]))), "незавершений стан зафіксовано");
  const r2 = await update(w, 340, { xml: xml2 });
  assert.equal(r2.state, "SYNCED", JSON.stringify(r2).slice(0, 300));
  const keys = sheetRows(w.sheets.book["Попередження постачальника"]).filter((x) => mtText(x["Offer ID"]) === mtText(target["Offer ID"]));
  assert.equal(keys.length, 1, "попередження — рівно одне");
  // «Відповідь втрачено» після застосування: дописування застосовано, звірка за ключем → без дублів, SYNCED.
  const xml3 = perturb.tag(w.xml, sid, "name_ua", "Ще одна зміна назви " + sid);
  w.sheets.armFault({ op: "appendRows", nth: 1, mode: "lost" });
  const r3 = await update(w, 400, { xml: xml3 });
  assert.equal(r3.state, "SYNCED", JSON.stringify(r3).slice(0, 300));
  const all = sheetRows(w.sheets.book["Попередження постачальника"]).map((x) => mtText(x["Ключ"]));
  assert.equal(all.length, new Set(all).size, "ключі попереджень унікальні");
});

// ================================================================ М2
test("ENG-28c М2: перше заповнення відсутнього значення постачальника — не зміна (без попередження, стан запам'ятовує значення); наступна справжня зміна — попередження", () => {
  const st = { v: 1, f: { "Опис UA": { s: FC.SRC.CUSTOM, sys: FC.hv("наш"), raw: FC.hv(""), at: "t", by: "migration:НЕВИЗНАЧЕНЕ" } }, p: {} };
  const row = { "Опис UA": "наш", "Опис постачальника UA": "" };
  const fields = FC.MANAGED_FIELDS.filter((f) => f.field === "Опис UA");
  const a = FC.applySupplier({ row, proposed: { ...row, "Опис постачальника UA": "опис постачальника" }, state: st, ctx: { offerId: "1" }, at: "t2", fields });
  assert.equal(a.warnings.length, 0, "перше заповнення — без попередження");
  assert.equal(a.state.f["Опис UA"].raw, FC.hv("опис постачальника"), "стан запам'ятав нове сире значення");
  assert.equal(a.row["Опис UA"], "наш", "наше значення збережено");
  const b = FC.applySupplier({ row: { ...row, "Опис постачальника UA": "опис постачальника" }, proposed: { ...row, "Опис постачальника UA": "новий опис постачальника" }, state: a.state, ctx: { offerId: "1" }, at: "t3", fields });
  assert.equal(b.warnings.length, 1, "справжня зміна — попередження");
  assert.equal(b.warnings[0].before, "опис постачальника");
});

// ================================================================ М1: бюджет запитів
test("ENG-28c М1: оцінка запитів = фактична кількість запитів GoogleSheetsWriter; бюджет менший за оцінку → «Оновити товари» нічого не пише (ABORTED), більший → SYNCED", async () => {
  const st = { calls: [] };
  const fetchImpl = async (url, init) => { st.calls.push(init.method); return new Response(init.method === "GET" ? JSON.stringify({ sheets: [{ properties: { title: "A", sheetId: 1, gridProperties: { rowCount: 10, columnCount: 2 } } }, { properties: { title: "B", sheetId: 2, gridProperties: { rowCount: 10, columnCount: 2 } } }] }) : "{}", { status: 200 }); };
  const wr = new GoogleSheetsWriter({ spreadsheetId: "TESTCOPYxxxxxxxxxxxxxxxxxxx", liveSpreadsheetId: "LIVExxxxxxxxxxxxxxxxxxxxxx", getAccessToken: async () => "t", fetchImpl, sleep: async () => {}, random: () => 0, maxChunkChars: 5000 });
  const big = Array.from({ length: 60 }, (_, i) => ["x".repeat(300), i]);
  const ops = [{ op: "ensureSheet", exists: false }, { op: "appendRows", rows: big }, { op: "ensureColumns", needed: true }, { op: "updateRanges", blocks: [{ title: "A", row: 2, col: 1, values: big }, { title: "B", row: 2, col: 1, values: [["y"]] }] }, { op: "setPercentFormat" }, { op: "appendRows", rows: big.slice(0, 5) }];
  await wr.ensureSheet("C", ["h1", "h2"]); await wr.appendRows("A", big); await wr.ensureColumns("A", 5);
  await wr.updateRanges([{ title: "A", row: 2, col: 1, values: big }, { title: "B", row: 2, col: 1, values: [["y"]] }]); await wr.setPercentFormat("A", 2, 2, 3); await wr.appendRows("A", big.slice(0, 5));
  assert.equal(estimateRequests(ops, { maxChunkChars: 5000 }).requests, st.calls.length, "оцінка = фактична кількість запитів");
  // syncSheet: бюджет 3 запити — перший прохід пріоритету власника більший → нічого не записано, лише подія «Журналу».
  const w = world();
  await structure(w); await correction(w); await qa(w, 3); await transfer(w);
  const snapMain = JSON.stringify(w.sheets.book[SHEET.main]), j0 = journal(w).length;
  const r = await update(w, 10, { writeBudget: { maxRequests: 3, used: 0, maxChunkChars: 2_000_000 } });
  assert.equal(r.state, "ABORTED", JSON.stringify(r).slice(0, 300));
  assert.equal(r.sync.block.type, "БЮДЖЕТ ЗАПИСУ");
  assert.equal(JSON.stringify(w.sheets.book[SHEET.main]), snapMain, "основний каталог без змін");
  assert.ok(!w.sheets.book["Класифікація полів"], "службових рядків немає");
  assert.equal(journal(w).length, j0 + 1);
  assert.equal(r.report.budget.ok, false);
  const ok = await update(w, 11, { writeBudget: { maxRequests: 120, used: 0, maxChunkChars: 2_000_000 } });
  assert.equal(ok.state, "SYNCED", JSON.stringify(ok).slice(0, 300));
  assert.ok(ok.sync.preflight.ok && ok.sync.preflight.estimate > 3);
});

// ================================================================ охоплення фіду: усі режими (sync, intake)
test("ENG-28c --mode=sync з фільтрованим операційним фідом: відсутні — поза охопленням (наявність / ціни не змінюються, без HOLD навіть масово, без «ПОМИЛКА»); той самий фід як повний — HOLD «МАСОВЕ ЗНИКНЕННЯ»; CLI бере охоплення з адреси", async () => {
  const w = world();
  await structure(w);
  const dropped = main(w).slice(20, 40).map((r) => ({ id: mtText(r["Offer ID"]), sid: mtText(r["ID постачальника"]), live: { "Наявність": mtText(r["Наявність"]), "Ціна": mtText(r["Ціна"]) } }));
  const xml = dated(perturb.drop(w.xml, dropped.map((d) => d.sid)), 5);
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  const sync = async (feedScope) => { const s = await session(w, "sync", "sync"); try { return await run.syncSheet({ sheets: guarded(w, "sync"), readBook: w.readBook, parsed, fetchFull: async (ids) => SS.extractFullOffers(xml, ids), stamp: at(5), config: cfg(), now: NOW + 5 * 60_000, catalog: EMPTY_CATALOG, session: s, controls: okCc(), feedScope }); } finally { await s.close(); } };
  const full1 = await sync("full");
  assert.equal(full1.state, "ABORTED"); assert.match(full1.reason, /зникло 20/, "повний фід: HOLD не послаблено");
  const f = await sync("filtered");
  assert.equal(f.state, "SYNCED", JSON.stringify(f).slice(0, 300));
  assert.equal(f.stats.outOfFeedScope, 20);
  for (const d of dropped) { const r = byId(main(w), d.id); assert.equal(mtText(r["Наявність"]), d.live["Наявність"], d.id); assert.equal(mtText(r["Ціна"]), d.live["Ціна"]); }
  assert.ok(!journal(w).some((e) => e[3] === "ПОМИЛКА" && e[6] === SS.OUT_OF_SCOPE));
  const fs = await import("node:fs");
  const tool = fs.readFileSync(new URL("../tools/sheet-sync.mjs", import.meta.url), "utf8");
  assert.equal((tool.match(/feedScopeOf\(operationalUrl\(process\.env\.MM_SUPPLIER_FEED_URL \|\| "", config\.supplier\)\)/g) || []).length, 2, "sync і intake — охоплення з адреси операційного фіду");
});

// ================================================================ «Оновити товари» не чіпає черги
test("ENG-28c «Оновити товари»: рішення власника в черзі (ЗАТВЕРДЖЕНО новинки) не виконується й не стирається — лише кількість у звіті; «Нові товари» побайтово ті самі", async () => {
  const w = world();
  await structure(w); await correction(w); await qa(w, 3); await transfer(w);
  await update(w, 10);
  const xmlN = w.xml.replace("\n</offers>", "\n" + offer("2990000501") + "\n</offers>");
  assert.equal((await findNew(w, 20, { xml: xmlN })).state, "WAITING_STABILITY");
  assert.equal((await findNew(w, 60, { xml: xmlN })).state, "INTAKE_DONE");
  const row = queue(w).findIndex((r) => mtText(r["Offer ID"]) === "2990000501") + 2;
  w.sheets.humanSet(SHEET.queue, row, "Рішення", SS.DECISION.APPROVE);
  const q0 = JSON.stringify(w.sheets.book[SHEET.queue]);
  const u = await update(w, 100, { xml: xmlN });
  assert.equal(u.state, "SYNCED", JSON.stringify(u).slice(0, 300));
  assert.equal(JSON.stringify(w.sheets.book[SHEET.queue]), q0, "черга без змін");
  assert.ok(!main(w).some((r) => mtText(r["Offer ID"]) === "2990000501"), "не перенесено");
  assert.equal(u.report.queue.pendingDecisions, 1);
  assert.equal(u.report.queue.touched, false);
});

// ================================================================ «Знайти нові товари»
test("ENG-28c «Знайти нові товари»: лише дозволені нові ID (не відхилені, не відкладені, не видалені власником, не в архіві); перший запуск — чекає стабільності; другий — додає; повтор — без дублів; основний каталог і ціни без змін; фільтр group_ids — у звіті; охоронець режиму не пускає в основний каталог", async () => {
  const w = world();
  await structure(w); await correction(w); await qa(w, 3); await transfer(w);
  const deferredSid = mtText(readSheet(w.sheets.book[SHEET.deferred], SHEET.deferred).rows[0]["ID постачальника"]);
  w.sheets.book[SHEET.frozen].push(["2990000602"]);
  w.sheets.book[ARCHIVE_SHEET] = [["Offer ID", "ID постачальника"], ["2990000603", "2990000603"]];
  const xml = w.xml.replace("\n</offers>", "\n" + ["2990000601", "2990000602", "2990000603", "2990000604"].map((id) => offer(id)).join("\n") + (w.xml.includes(`id="${deferredSid}"`) ? "" : "\n" + offer(deferredSid)) + "\n</offers>");
  const cc = okCc(["2990000604"]);
  const mainSnap = JSON.stringify(w.sheets.book[SHEET.main]);
  const f1 = await findNew(w, 20, { xml, controls: cc });
  assert.equal(f1.state, "WAITING_STABILITY", JSON.stringify(f1).slice(0, 400));
  assert.deepEqual(f1.newIds.waiting, ["2990000601"]);
  assert.equal(f1.report.excluded.rejected, 1); assert.equal(f1.report.excluded.archived, 1); assert.equal(f1.report.excluded.removedByOwner, 1); assert.ok(f1.report.excluded.deferred >= 1);
  assert.equal(f1.report.scope.scope, "filtered"); assert.match(f1.report.scope.note, /allcats/);
  const f2 = await findNew(w, 60, { xml, controls: cc });
  assert.equal(f2.state, "INTAKE_DONE", JSON.stringify(f2).slice(0, 400));
  assert.equal(f2.report.intake.added, 1);
  const added = queue(w).filter((r) => mtText(r["Offer ID"]) === "2990000601");
  assert.equal(added.length, 1);
  assert.match(mtText(added[0]["Перевірка"]) + mtText(added[0]["Рішення"]), /^(?!.*ПЕРЕВІРЕНО).*$/s, "не позначено перевіреним");
  assert.equal(mtText(added[0]["Рішення"]), "", "не погоджено автоматично");
  assert.equal(JSON.stringify(w.sheets.book[SHEET.main]), mainSnap, "основний каталог без змін");
  for (const id of ["2990000602", "2990000603", "2990000604"]) assert.ok(!queue(w).some((r) => mtText(r["Offer ID"]) === id), id + ": не відновлено");
  const f3 = await findNew(w, 100, { xml, controls: cc });
  assert.equal(f3.state, "NOTHING_NEW");
  assert.equal(queue(w).filter((r) => mtText(r["Offer ID"]) === "2990000601").length, 1, "без дублів");
  // Пошкоджений фід — нічого не записано.
  const qSnap = JSON.stringify(w.sheets.book[SHEET.queue]), jn = journal(w).length;
  const broken = await findNew(w, 140, { xml: dated(xml, 140).slice(0, Math.floor(xml.length / 2)), raw: true, controls: cc });
  assert.equal(broken.state, "ABORTED");
  assert.equal(JSON.stringify(w.sheets.book[SHEET.queue]), qSnap); assert.equal(journal(w).length, jn);
  await assert.rejects(guarded(w, "find-new").updateRanges([{ title: SHEET.main, row: 2, col: 1, values: [["x"]] }]), /не дозволено/);
});
