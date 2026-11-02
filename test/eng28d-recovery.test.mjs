/** ENG-28d — fault-injection: відновлення перенесення NEW92 (F-28B-2) і «Журналу» після часткового оновлення (F-28B-1).
 *  Збої: перед першим записом; після 1 / 40 / 91 / 92 перенесених рядків (частковий batch, невідомий результат); між товаром і позначкою
 *  черги; невідомий результат API (BLOCK до reconcile); конкурентна правка власника; зміна порядку рядків; повтор після успіху; збій
 *  журналу після успішних цін; збій посеред журналу; відновлення без дублів; конфлікт, який безпечно не відновити.
 *  Інваріанти: нуль втрачених товарів, нуль дублів Offer ID, ручні дані не перезаписуються, повна звірка журналу або явний BLOCK.
 *  Не транзакція: R-N3W відкритий. Синтетика, таблиця в пам'яті, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import * as SS from "../src/core/sheet-sync.mjs";
import * as run from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { OUTCOME, WriteOutcomeError } from "../src/pipeline/write-outcome.mjs";
import * as WT from "../src/pipeline/safe-write/write-target.mjs";
import * as RP from "../src/pipeline/run-plan.mjs";
import * as T from "../src/core/transfer-new92.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { updateProducts } from "../src/pipeline/update-products.mjs";
import { qaProducts } from "../src/pipeline/qa-products.mjs";
import { findNewProducts } from "../src/pipeline/find-new.mjs";
import * as steps from "../src/pipeline/eng28a-steps.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const { SHEET } = SS;
const NOW = Date.parse("2026-10-22T10:00:00Z");
const at = (min) => new Date(NOW + min * 60_000).toISOString();
const SNAP_DATE = "2026-10-29T18:20:40.743Z";
const URL_F = "https://market-tools.com.ua/feed.xml?key=SECRET&group_ids=1";
const cfg = () => { const c = productionConfig(structuredClone(baseConfig)); c.supplier.minimumOffers = 10; c.policy.anomaly = { ...c.policy.anomaly, maxNewlyMissingRatio: 1 }; return c; };
const okCc = () => Object.freeze({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp-", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
const full = (xml) => xml.replace(/<\/offer>/g, "<description>Опис постачальника</description></offer>");
const dated = (xml, min) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 3 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });
const t = (v) => mtText(v).trim();

/** Транспорт із моделлю збоїв ENG-28d поверх MemorySheets: w.fault = { op, title, mode, rows } —
 *  rows (для appendRows): застосувати перші N рядків і повернути невідомий результат (частковий batch); timeout — не застосовано,
 *  результат невідомий; lost — застосовано, відповідь втрачено; reject — відхилено (NOT_APPLIED). Спрацьовує один раз. */
function world({ products = 40, queue = 92, seed = 41 } = {}) {
  const s = generateSynthetic({ products, queue, deferred: 2, newOffers: 0, seed, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const mem = new MemorySheets(book);
  const w = { s, mem, store: new MemoryStore(), clock: { now: NOW }, fault: null, readBook: async () => mem.read(), xml: full(s.supplierXml()) };
  const fail = (op, mode, applied) => { throw new WriteOutcomeError(`імітовано (${mode}) ${op}`, { outcome: mode === "reject" ? OUTCOME.NOT_APPLIED : OUTCOME.UNKNOWN, op, code: "SIMULATED", ...(applied ? { appliedParts: 1, totalParts: 2 } : {}) }); };
  w.transport = new Proxy(mem, { get(target, prop) {
    const v = Reflect.get(target, prop, target);
    if (typeof v !== "function") return v;
    // Збій на першій же операції запису (будь-якій) — відмова, нічого не застосовано.
    if (w.failFirstWrite && ["appendRows", "updateRanges", "ensureColumns", "ensureSheet"].includes(prop)) return async () => { w.failFirstWrite = false; w.firstWriteOp = prop; return fail(prop, "reject", false); };
    if (prop === "appendRows") return async (title, rows) => {
      const f = w.fault;
      if (!f || f.op !== "appendRows" || f.title !== title) return v.call(target, title, rows);
      w.fault = null;
      if (f.rows != null) { if (f.rows > 0) await v.call(target, title, rows.slice(0, f.rows)); return fail("appendRows", f.mode || "timeout", f.rows > 0); }
      if (f.mode === "lost") { await v.call(target, title, rows); return fail("appendRows", "lost", true); }
      // delay — запит застосується пізніше (target.flushDelayed()), клієнт бачить невідомий результат.
      if (f.mode === "delay") { const copy = rows.map((r) => r.slice()); target.delayed.push(() => { const sh = target.book[title]; let last = sh.length; while (last > 1 && !(sh[last - 1] || []).some((x) => x !== "" && x != null)) last--; sh.splice(last, 0, ...copy.map((r) => r.slice())); }); return fail("appendRows", "timeout", false); }
      return fail("appendRows", f.mode, false);
    };
    if (prop === "updateRanges") return async (list) => {
      const f = w.fault;
      if (!f || f.op !== "updateRanges" || !list.some((b) => b.title === f.title && b.row !== 1)) return v.call(target, list);
      w.fault = null;
      if (f.mode === "lost") { await v.call(target, list); return fail("updateRanges", "lost", true); }
      return fail("updateRanges", f.mode, false);
    };
    return v.bind(target);
  }, set(target, prop, value) { target[prop] = value; return true; } });
  return w;
}
const headersOf = (w) => Object.fromEntries(Object.entries(w.mem.book).map(([k, v]) => [k, (v[0] || []).slice()]));
const gw = (w, mode) => new WriteGateway({ sheets: WT.guardedSheets(w.transport, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES[mode], headers: headersOf(w) }), read: w.readBook, store: w.store, now: () => w.clock.now });
async function withSession(w, mode, writer, fn) { const s = await gw(w, mode).open({ writer }); try { return await fn(s); } finally { await s.close().catch(() => {}); } }
const transfer = (w, min) => withSession(w, "merge", "sync", (s) => run.transferNew92({ sheets: s.sheets, readBook: w.readBook, stamp: at(min), snapshotDate: SNAP_DATE, session: s, expectCount: w.queueIds.length }));
/** reconcile W2 після вікна settle (лише читання таблиці). */
async function reconcile(w) { w.clock.now += 300_000; return withSession(w, "reconcile", "sync", async (s) => { const r = s.state === "RECONCILE_REQUIRED" ? await s.reconcile() : []; return { state: s.state, results: r }; }); }
const main = (w) => readSheet(w.mem.book[SHEET.main], SHEET.main).rows;
const queue = (w) => readSheet(w.mem.book[SHEET.queue], SHEET.queue).rows;
const ids = (rows) => rows.map((r) => t(r["Offer ID"]));
const journalRows = (w) => w.mem.book[SHEET.journal].slice(1);
const journalIdsOf = (w) => { const h = w.mem.book[SHEET.journal][0].map(t), k = h.indexOf(RP.EVENT_ID_COLUMN); return k < 0 ? [] : journalRows(w).map((r) => t(r[k])).filter(Boolean); };
async function prepared(o) {
  const w = world(o);
  assert.equal((await steps.migrateQueueForTransfer({ sheets: WT.guardedSheets(w.transport, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES.structure, headers: headersOf(w) }), readBook: w.readBook, stamp: at(0) })).state, "MIGRATED");
  w.queueIds = ids(queue(w));
  w.mainIds0 = ids(main(w));
  w.queue0 = new Map(queue(w).map((r) => [t(r["Offer ID"]), { ...r }]));
  return w;
}
/** Інваріанти після завершеного перенесення: усі товари, без дублів, 92 = черга (40 колонок), позначки, рядки черги збережено, журнал за ID. */
function assertTransferred(w) {
  const m = main(w), mids = ids(m);
  assert.equal(new Set(mids).size, mids.length, "нуль дублів Offer ID");
  assert.equal(m.length, w.mainIds0.length + w.queueIds.length, "нуль утрачених товарів");
  for (const id of w.mainIds0) assert.ok(mids.includes(id), "наявний товар на місці: " + id);
  for (const id of w.queueIds) {
    const a = w.queue0.get(id), b = m.find((r) => t(r["Offer ID"]) === id);
    assert.ok(b, "перенесено: " + id);
    for (const k of ["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Запити UA", "Запити RU", "Характеристики JSON", "Категорія Prom ID", "Група ID", "Артикул постачальника"]) assert.equal(mtText(b[k]), mtText(a[k]), `${id}: ${k}`);
    const q = queue(w).filter((r) => t(r["Offer ID"]) === id);
    assert.equal(q.length, 1, "рядок черги збережено: " + id);
    assert.ok(t(q[0]["Перевірка"]).startsWith(T.TRANSFER_MARK), "позначка: " + id);
    assert.equal(t(q[0]["Рішення"]), t(a["Рішення"]), "«Рішення» не змінено: " + id);
  }
  const jids = journalIdsOf(w);
  assert.equal(new Set(jids).size, jids.length, "журнал без дублів ID");
}

// ================================================================ F-28B-2: перенесення
test("ENG-28d перенесення: контрольний план до запису; збій перед першим записом → нічого не записано, повтор — контрольоване продовження (усі «не перенесено») → TRANSFERRED; повтор після успіху → NOTHING", async () => {
  const w = await prepared();
  const log0 = w.mem.log.length;
  w.failFirstWrite = true;
  const r1 = await transfer(w, 1);
  assert.equal(r1.state, "INCOMPLETE", JSON.stringify(r1).slice(0, 300));
  assert.ok(w.firstWriteOp, "збій спрацював на першому записі");
  assert.equal(main(w).length, w.mainIds0.length, "нічого не записано");
  assert.equal(w.mem.log.length, log0, "жодної операції запису не застосовано");
  const cp = (await RP.loadPlan(w.store, RP.TRANSFER_PLAN_KEY)).plan;
  assert.equal(cp.ids.length, 92); assert.equal(Object.keys(cp.input).length, 92); assert.equal(Object.keys(cp.target).length, 92); assert.ok(cp.opId.startsWith("transfer-new92:"));
  w.fault = null;
  const r2 = await transfer(w, 2);
  assert.equal(r2.state, "TRANSFERRED", JSON.stringify(r2).slice(0, 400));
  assert.equal(r2.resumed, true); assert.equal(r2.classification[T.MOVE.NOT_MOVED], 92);
  assertTransferred(w);
  const log1 = w.mem.log.length;
  assert.equal((await transfer(w, 3)).state, "NOTHING", "повтор після повного успіху");
  assert.equal(w.mem.log.length, log1, "жодного зайвого запису");
});

test("ENG-28d перенесення: збій після 92 з 92 рядків (усі застосовано, відповідь API втрачено) → читання за ключем підтверджує всі 92 (без сліпого повтору) → перенесення завершується тим самим запуском; повтор → NOTHING", async () => {
  const w = await prepared();
  w.fault = { op: "appendRows", title: SHEET.main, rows: 92, mode: "timeout" };
  const r = await transfer(w, 1);
  assert.equal(r.state, "TRANSFERRED", JSON.stringify(r).slice(0, 300));
  assert.equal(w.fault, null, "збій спрацював");
  assertTransferred(w);
  assert.equal((await RP.loadPlan(w.store, RP.TRANSFER_PLAN_KEY)).plan.status, "DONE");
  assert.equal((await transfer(w, 2)).state, "NOTHING");
});

for (const n of [1, 40, 91]) {
  test(`ENG-28d перенесення: збій після ${n} з 92 рядків (частковий batch, невідомий результат) → повтор без reconcile — BLOCKED; reconcile → продовження лише відсутніх → 5 029-аналог + 92, без дублів`, async () => {
    const w = await prepared();
    w.fault = { op: "appendRows", title: SHEET.main, rows: n, mode: "timeout" };
    const r1 = await transfer(w, 1);
    assert.equal(r1.state, "INCOMPLETE", JSON.stringify(r1).slice(0, 300));
    assert.equal(main(w).length, w.mainIds0.length + n, `застосовано ${n}`);
    const b = await transfer(w, 2);
    assert.equal(b.state, "BLOCKED", "невідомий результат — без reconcile сліпого повтору немає");
    assert.equal(main(w).length, w.mainIds0.length + n);
    const rc = await reconcile(w);
    assert.equal(rc.state, "READY", JSON.stringify(rc).slice(0, 300));
    const r2 = await transfer(w, 10);
    assert.equal(r2.state, "TRANSFERRED", JSON.stringify(r2).slice(0, 400));
    assert.equal(r2.classification[T.MOVE.MOVED_UNMARKED], n); assert.equal(r2.classification[T.MOVE.NOT_MOVED], 92 - n);
    assert.equal(r2.appendedNow, 92 - n, "дописано лише відсутні");
    assertTransferred(w);
    assert.ok(journalRows(w).some((e) => t(e[3]) === "ПРОДОВЖЕННЯ ПЕРЕНЕСЕННЯ"), "подія продовження в «Журналі»");
  });
}

test("ENG-28d перенесення: збій між записом товарів і позначками черги (тайм-аут) → reconcile → продовження: лише позначки, паспорт, журнал", async () => {
  const w = await prepared();
  w.fault = { op: "updateRanges", title: SHEET.queue, mode: "timeout" };
  const r1 = await transfer(w, 1);
  assert.equal(r1.state, "INCOMPLETE");
  assert.equal(main(w).length, w.mainIds0.length + 92);
  assert.ok(queue(w).every((r) => t(r["Перевірка"]).startsWith(SS.PENDING_TRANSFER_MARK)), "позначок ще немає");
  await reconcile(w);
  const r2 = await transfer(w, 10);
  assert.equal(r2.state, "TRANSFERRED", JSON.stringify(r2).slice(0, 300));
  assert.equal(r2.classification[T.MOVE.MOVED_UNMARKED], 92); assert.equal(r2.appendedNow, 0); assert.equal(r2.markedNow, 92);
  assertTransferred(w);
});

test("ENG-28d перенесення: зміна порядку рядків між збоєм і продовженням (сортування людиною) — продовження за ключем, без дублів і втрат", async () => {
  const w = await prepared();
  w.fault = { op: "appendRows", title: SHEET.main, rows: 40, mode: "timeout" };
  await transfer(w, 1);
  w.mem.humanSort(SHEET.main, "Назва UA", true);
  w.mem.humanSort(SHEET.queue, "Назва UA");
  await reconcile(w);
  const r2 = await transfer(w, 10);
  assert.equal(r2.state, "TRANSFERRED", JSON.stringify(r2).slice(0, 300));
  assertTransferred(w);
});

test("ENG-28d перенесення: конкурентна правка власника після часткового перенесення (рядок каталогу; «Рішення» в черзі) → BLOCK зі звітом, нічого не записано, правки збережено", async () => {
  const w = await prepared();
  w.fault = { op: "appendRows", title: SHEET.main, rows: 40, mode: "timeout" };
  await transfer(w, 1);
  await reconcile(w);
  const moved = main(w).find((r) => w.queueIds.includes(t(r["Offer ID"])));
  const mRow = w.mem.book[SHEET.main].findIndex((r, i) => i > 0 && t(r[0]) === t(moved["Offer ID"])) + 1;
  w.mem.humanSet(SHEET.main, mRow, "Назва UA", "Назва власника після збою");
  const notMoved = w.queueIds.find((id) => !ids(main(w)).includes(id));
  const qRow = w.mem.book[SHEET.queue].findIndex((r, i) => i > 0 && t(r[0]) === notMoved) + 1;
  w.mem.humanSet(SHEET.queue, qRow, "Рішення", SS.DECISION.REJECT);
  const snap = JSON.stringify(w.mem.book[SHEET.main]) + JSON.stringify(w.mem.book[SHEET.queue]);
  const r = await transfer(w, 10);
  assert.equal(r.state, "BLOCKED", JSON.stringify(r).slice(0, 300));
  assert.ok(r.conflicts.some((c) => c.offerId === t(moved["Offer ID"]) && /змінено після часткового перенесення/.test(c.why)));
  assert.ok(r.conflicts.some((c) => c.offerId === notMoved && /рядок черги змінено/.test(c.why)));
  assert.equal(JSON.stringify(w.mem.book[SHEET.main]) + JSON.stringify(w.mem.book[SHEET.queue]), snap, "нічого не записано, правки власника збережено");
  assert.equal(RP.isOpen((await RP.loadPlan(w.store, RP.TRANSFER_PLAN_KEY)).plan), true, "план лишається відкритим — рішення власника");
  // «Оновити товари» / пошук новинок не обходять незавершене перенесення.
  const u = await withSession(w, "update", "sync", (s) => updateProducts({ sheets: s.sheets, readBook: w.readBook, xml: dated(w.xml, 20), source: URL_F, fetchedAt: at(20), stamp: at(20), now: NOW + 20 * 60_000, config: cfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, session: s }));
  assert.equal(u.state, "BLOCKED"); assert.match(u.reason, /незавершене перенесення/);
});

test("ENG-28d перенесення: дубль Offer ID у каталозі (рядок вставлено вдруге) → BLOCK; позначка «ПЕРЕНЕСЕНО» без товару → BLOCK", async () => {
  const w = await prepared();
  w.fault = { op: "appendRows", title: SHEET.main, rows: 40, mode: "timeout" };
  await transfer(w, 1);
  await reconcile(w);
  const cp = (await RP.loadPlan(w.store, RP.TRANSFER_PLAN_KEY)).plan;
  const book = await w.readBook();
  const movedRow = book[SHEET.main].find((r, i) => i > 0 && cp.ids.includes(t(r[0])));
  const dupBook = { ...book, [SHEET.main]: [...book[SHEET.main], movedRow.slice()] };
  assert.ok(T.classifyTransfer(cp, dupBook).conflicts.some((c) => /дубль/.test(c.why)));
  const qh = book[SHEET.queue][0].map(t), kC = qh.indexOf("Перевірка");
  const notMoved = cp.ids.find((id) => !book[SHEET.main].some((r) => t(r[0]) === id));
  const markBook = { ...book, [SHEET.queue]: book[SHEET.queue].map((r, i) => (i > 0 && t(r[0]) === notMoved ? r.map((v, j) => (j === kC ? cp.marks[notMoved].set : v)) : r)) };
  assert.ok(T.classifyTransfer(cp, markBook).conflicts.some((c) => /позначку «ПЕРЕНЕСЕНО» записано, а товару/.test(c.why)));
});

// ================================================================ F-28B-1: «Журнал» оновлення
async function updated(o = {}) {
  const w = world({ products: 40, queue: 4, seed: 17 });
  await run.mergeNew92({ sheets: w.mem, readBook: w.readBook, stamp: at(0) });
  w.update = (xml, min) => { w.clock.now = Math.max(w.clock.now, NOW + min * 60_000); return withSession(w, "update", "sync", (s) => updateProducts({ sheets: s.sheets, readBook: w.readBook, xml: dated(xml, min), source: URL_F, fetchedAt: at(min), stamp: at(min), now: w.clock.now, config: cfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, session: s })); };
  assert.equal((await w.update(w.xml, 1)).state, "SYNCED");
  // Наступний фід: ціни 5 товарів змінено.
  const rows = main(w).slice(3, 8);
  w.changed = rows.map((r) => ({ id: t(r["Offer ID"]), sid: t(r["ID постачальника"]), price: Number(mtText(r["Ціна постачальника"]).replace(",", ".")) || 100 }));
  w.xml2 = w.changed.reduce((x, c) => perturb.tag(x, c.sid, "price", String(Math.round(c.price * 1.07 * 100) / 100)), w.xml);
  return w;
}
const planOf = async (w) => (await RP.loadPlan(w.store, RP.RUN_PLAN_KEY)).plan;
const priceEvents = (w, runId) => journalRows(w).filter((e) => t(e[3]) === "Ціна постачальника" && t(e[0]) === runId.split(":").slice(1).join(":"));

test("ENG-28d журнал: збій дописування «Журналу» після успішного оновлення цін → JOURNAL_INCOMPLETE (не SYNCED), ціни не відкочено; наступний запуск дописує відсутні події рівно раз (без повтору товарних записів) і продовжує штатно", async () => {
  const w = await updated();
  w.fault = { op: "appendRows", title: SHEET.journal, mode: "reject" };
  const r = await w.update(w.xml2, 10);
  assert.equal(r.state, "JOURNAL_INCOMPLETE", JSON.stringify(r).slice(0, 300));
  const plan = await planOf(w);
  assert.equal(plan.status, RP.PLAN.PRODUCT_DONE);
  for (const c of w.changed) assert.notEqual(Number(mtText(main(w).find((x) => t(x["Offer ID"]) === c.id)["Ціна постачальника"]).replace(",", ".")), c.price, "ціну оновлено й не відкочено");
  assert.equal(priceEvents(w, plan.runId).length, 0, "подій ще немає");
  const liveSnap = () => JSON.stringify(main(w).map((x) => ["Offer ID", "Ціна постачальника", "Ціна", "Ціна кінцева", "Наявність"].map((k) => mtText(x[k]))));
  const live0 = liveSnap();
  const r2 = await w.update(w.xml2, 20);
  assert.equal(r2.sync.recovery?.state, "JOURNAL_RECOVERED", JSON.stringify(r2.sync).slice(0, 300));
  assert.equal(r2.state, "SYNCED", "після відновлення — штатна синхронізація того самого запуску");
  assert.equal(liveSnap(), live0, "товарні записи цін не повторено");
  assert.equal(priceEvents(w, plan.runId).length, 5, "події цін відновлено");
  assert.equal(journalRows(w).filter((e) => t(e[0]) === at(20) && t(e[3]) === "Ціна постачальника").length, 0, "нових подій цін немає — змін немає");
  const jids = journalIdsOf(w);
  for (const e of plan.events) assert.equal(jids.filter((x) => x === e[7]).length, 1, "кожна подія — рівно раз");
  const p2 = await planOf(w);
  assert.notEqual(p2.runId, plan.runId); assert.equal(p2.status, RP.PLAN.DONE);
  assert.equal(r2.report.recovery.state, "JOURNAL_RECOVERED"); assert.equal(r2.report.journal.ok, true);
  const r3 = await w.update(w.xml2, 30);
  assert.ok(["SYNCED", "NO_CHANGES"].includes(r3.state), JSON.stringify(r3).slice(0, 200));
});

test("ENG-28d журнал: збій посеред дописування «Журналу» (частина рядків застосована, результат невідомий) → наступний запуск BLOCKED до reconcile; після reconcile дописано лише відсутні, без дублів", async () => {
  const w = await updated();
  w.fault = { op: "appendRows", title: SHEET.journal, rows: 3, mode: "timeout" };
  const r = await w.update(w.xml2, 10);
  assert.equal(r.state, "JOURNAL_INCOMPLETE", JSON.stringify(r).slice(0, 300));
  const plan = await planOf(w);
  assert.equal(journalIdsOf(w).filter((x) => x.startsWith(plan.runId)).length, 3, "3 події вже в «Журналі»");
  const b = await w.update(w.xml2, 20);
  assert.equal(b.state, "BLOCKED", "невідомий результат — без reconcile нічого не пишемо");
  await reconcile(w);
  const r2 = await w.update(w.xml2, 40);
  assert.equal(r2.sync.recovery?.state, "JOURNAL_RECOVERED", JSON.stringify(r2.sync).slice(0, 300));
  assert.equal(r2.sync.recovery.appended, plan.events.length - 3, "дописано лише відсутні");
  assert.equal(r2.state, "SYNCED");
  const mine = journalIdsOf(w).filter((x) => x.startsWith(plan.runId));
  assert.equal(mine.length, plan.events.length); assert.equal(new Set(mine).size, mine.length, "без дублів");
});

test("ENG-28d журнал: збій під час запису карток (невідомий результат) → план PLANNED; reconcile → відновлено лише події підтверджено застосованих змін (ціни), подій незастосованих немає; той самий запуск дописує решту змін штатно", async () => {
  const w = await updated();
  // Наступний фід: ціни 5 товарів + нова назва постачальника одного товару (картка — запис за ключем).
  const nameRow = main(w)[12], xml3 = perturb.tag(w.xml2, t(nameRow["ID постачальника"]), "name_ua", "Нова назва постачальника X");
  w.fault = { op: "updateRanges", title: SHEET.main, mode: "timeout", cardsOnly: true };
  // Перший updateRanges основного каталогу — блок цін (застосовується); другий — картки (тайм-аут).
  let seen = 0; const orig = w.fault; w.fault = null;
  const tr = w.transport;
  w.transport = new Proxy(tr, { get(target, prop) { const v = Reflect.get(target, prop); if (prop !== "updateRanges") return typeof v === "function" ? v.bind(target) : v; return async (list) => { if (list.some((b) => b.title === SHEET.main && b.row !== 1) && ++seen === 2) { w.fault = orig; } return v.call(target, list); }; }, set(target, prop, value) { target[prop] = value; return true; } });
  const r = await w.update(xml3, 10);
  w.transport = tr; w.fault = null;
  assert.equal(r.state, "INCOMPLETE", JSON.stringify(r).slice(0, 300));
  const plan = await planOf(w);
  assert.equal(plan.status, RP.PLAN.PLANNED);
  await reconcile(w);
  const r2 = await w.update(xml3, 20);
  assert.equal(r2.sync.recovery?.state, "JOURNAL_RECOVERED", JSON.stringify(r2.sync).slice(0, 300));
  assert.equal(r2.sync.recovery.partial, true, "частина змін не застосована");
  assert.equal(r2.state, "SYNCED");
  const stamp = plan.stamp;
  assert.equal(journalRows(w).filter((e) => t(e[0]) === stamp && t(e[3]) === "Ціна постачальника").length, 5, "події цін (застосовано) — є");
  assert.equal(journalRows(w).filter((e) => t(e[0]) === stamp && t(e[3]) === "Назва постачальника UA").length, 0, "подія назви (не застосовано) — немає");
  assert.equal(journalRows(w).filter((e) => t(e[0]) === stamp && t(e[3]) === "ЗАВЕРШЕНО").length, 0, "«ЗАВЕРШЕНО» неповного запуску — не вигадується");
  assert.equal(t(main(w).find((x) => t(x["Offer ID"]) === t(nameRow["Offer ID"]))["Назва постачальника UA"]), "Нова назва постачальника X", "незастосовану зміну дописано тим самим запуском");
  assert.equal(journalRows(w).filter((e) => t(e[0]) === at(20) && t(e[3]) === "Назва постачальника UA").length, 1, "її подія — від запуску, що її застосував");
  assert.equal(journalRows(w).filter((e) => t(e[0]) === at(20) && t(e[3]) === "Ціна постачальника").length, 0, "ціни вже застосовано — подій не дублюємо");
  const ids2 = journalIdsOf(w); assert.equal(new Set(ids2).size, ids2.length);
});

test("ENG-28d журнал: після збою власник змінив клітинку-доказ (ціна — третє значення) → BLOCK зі звітом, жодної події не дописано, план відкритий", async () => {
  const w = await updated();
  // Збій журналу при плані PRODUCT_DONE відновлюється без доказів; конфлікт доказів перевіряємо на плані PLANNED.
  w.fault = { op: "updateRanges", title: SHEET.main, mode: "timeout" }; // блок цін: невідомий результат
  const r = await w.update(w.xml2, 10);
  assert.equal(r.state, "INCOMPLETE", JSON.stringify(r).slice(0, 300));
  await reconcile(w);
  const c = w.changed[0];
  const row = w.mem.book[SHEET.main].findIndex((x, i) => i > 0 && t(x[0]) === c.id) + 1;
  w.mem.humanSet(SHEET.main, row, "Ціна постачальника", 777.77);
  const j0 = journalRows(w).length;
  const r2 = await w.update(w.xml2, 20);
  assert.equal(r2.state, "BLOCKED", JSON.stringify(r2).slice(0, 300));
  assert.ok(r2.sync.other.some((o) => o.offerId === c.id && o.column === "Ціна постачальника"), "звіт: яка клітинка");
  assert.equal(journalRows(w).length, j0, "жодної події");
  assert.equal(RP.isOpen(await planOf(w)), true);
});

test("ENG-28d журнал: збій ДО товарних записів (відмова службових рядків) → ROLLED_BACK, план закрито без подій; наступний запуск — штатний, вигаданих подій немає", async () => {
  const w = await updated();
  const nameRow = main(w)[12], xml3 = perturb.tag(w.xml2, t(nameRow["ID постачальника"]), "name_ua", "Ще одна назва постачальника");
  w.fault = { op: "appendRows", title: "Попередження постачальника", mode: "reject" };
  const r = await w.update(xml3, 10);
  assert.equal(r.state, "ROLLED_BACK", JSON.stringify(r).slice(0, 300));
  const plan = await planOf(w);
  assert.equal(plan.status, RP.PLAN.ABANDONED);
  assert.equal(journalRows(w).filter((e) => t(e[0]) === plan.stamp && t(e[3]) === "Ціна постачальника").length, 0, "подій незастосованого запуску немає");
  const r2 = await w.update(xml3, 20);
  assert.equal(r2.state, "SYNCED", JSON.stringify(r2).slice(0, 300));
  const p2 = await planOf(w);
  assert.equal(p2.status, RP.PLAN.DONE);
  assert.equal(journalRows(w).filter((e) => t(e[0]) === p2.stamp && t(e[3]) === "Ціна постачальника").length, 5);
});

test("ENG-28d журнал: SYNCED лише з повним «Журналом» — кожна подія запуску рівно раз за «ID події»; повтор тим самим фідом не пише подій", async () => {
  const w = await updated();
  const r = await w.update(w.xml2, 10);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 300));
  const plan = await planOf(w);
  assert.equal(plan.status, RP.PLAN.DONE);
  const jids = journalIdsOf(w);
  for (const e of plan.events) assert.equal(jids.filter((x) => x === e[7]).length, 1);
  assert.equal(r.sync.journal.ok, true);
  const j0 = journalRows(w).length;
  assert.equal((await w.update(w.xml2, 10)).state, "NO_CHANGES");
  assert.equal(journalRows(w).length, j0);
});

// ================================================================ «Журнал» перенесення, QA, брама «Знайти нові товари»
test("ENG-28d перенесення: дані, позначки й паспорт записано, «Журнал» відхилено → INCOMPLETE (план відкритий); продовження — без товарних записів, лише події плану за ID", async () => {
  const w = await prepared();
  w.fault = { op: "appendRows", title: SHEET.journal, mode: "reject" };
  const r1 = await transfer(w, 1);
  assert.equal(r1.state, "INCOMPLETE", JSON.stringify(r1).slice(0, 300));
  assert.equal((await RP.loadPlan(w.store, RP.TRANSFER_PLAN_KEY)).plan.status, "PASSPORT_DONE");
  const mainSnap = JSON.stringify(w.mem.book[SHEET.main]), queueSnap = JSON.stringify(w.mem.book[SHEET.queue]);
  await reconcile(w);
  const r2 = await transfer(w, 10);
  assert.equal(r2.state, "TRANSFERRED", JSON.stringify(r2).slice(0, 300));
  assert.equal(r2.classification[T.MOVE.MOVED_DONE], 92); assert.equal(r2.appendedNow, 0); assert.equal(r2.markedNow, 0);
  assert.equal(JSON.stringify(w.mem.book[SHEET.main]), mainSnap, "товарних записів немає");
  assert.equal(JSON.stringify(w.mem.book[SHEET.queue]), queueSnap, "черга без змін");
  const cp = (await RP.loadPlan(w.store, RP.TRANSFER_PLAN_KEY)).plan, jids = journalIdsOf(w);
  for (const e of cp.events) assert.equal(jids.filter((x) => x === e[7]).length, 1, "подія плану рівно раз");
  assertTransferred(w);
});

/** QA-світ: 4 товари з новою назвою постачальника (ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ), як у ENG-28c. */
async function qaWorld() {
  const w = world({ products: 60, queue: 4, seed: 31 });
  const v = w.mem.book[SHEET.main], h = v[0].map(t), rows = readSheet(v, SHEET.main).rows;
  w.qa = rows.slice(10, 14).map((r) => t(r["Offer ID"]));
  let xml = w.xml;
  for (const id of w.qa) {
    const i = rows.findIndex((r) => t(r["Offer ID"]) === id) + 1, sid = t(rows[i - 1]["ID постачальника"]);
    v[i][h.indexOf("Стан синхронізації")] = "ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ";
    xml = perturb.tag(xml, sid, "name_ua", "Нова назва постачальника " + sid);
  }
  w.xml = xml;
  assert.equal((await steps.migrateQueueForTransfer({ sheets: WT.guardedSheets(w.transport, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES.structure, headers: headersOf(w) }), readBook: w.readBook, stamp: at(0) })).state, "MIGRATED");
  w.qaRun = (min) => { w.clock.now = Math.max(w.clock.now, NOW + min * 60_000); return withSession(w, "qa", "sync", (s) => qaProducts({ sheets: s.sheets, readBook: w.readBook, xml: dated(w.xml, min), source: "https://market-tools.com.ua/feed.xml?key=SECRET&group_ids=101,102", fetchedAt: at(min), stamp: at(min), now: w.clock.now, config: cfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, session: s, ids: w.qa })); };
  return w;
}

test("ENG-28d журнал QA: «Журнал» відхилено після перевірених даних QA → JOURNAL_INCOMPLETE (не QA_DONE); повтор QA → відновлення журналу без повтору даних і продовження QA (NOTHING); ще повтор → NOTHING", async () => {
  const w = await qaWorld();
  w.fault = { op: "appendRows", title: SHEET.journal, mode: "reject" };
  const r = await w.qaRun(3);
  assert.equal(r.state, "JOURNAL_INCOMPLETE", JSON.stringify(r).slice(0, 400));
  const plan = await planOf(w);
  assert.equal(plan.kind, "qa"); assert.equal(plan.status, RP.PLAN.PRODUCT_DONE);
  for (const id of w.qa) assert.equal(t(main(w).find((x) => t(x["Offer ID"]) === id)["Стан синхронізації"]), "ЗІСТАВЛЕНО", "дані QA записано й не відкочено");
  const mainSnap = JSON.stringify(w.mem.book[SHEET.main]);
  const r2 = await w.qaRun(4);
  assert.equal(r2.recovery?.state, "JOURNAL_RECOVERED", JSON.stringify(r2).slice(0, 300));
  assert.equal(r2.state, "NOTHING", "дані QA вже записано");
  assert.equal(JSON.stringify(w.mem.book[SHEET.main]), mainSnap, "дані QA не повторено");
  const jids = journalIdsOf(w);
  for (const e of plan.events) assert.equal(jids.filter((x) => x === e[7]).length, 1);
  assert.equal((await w.qaRun(5)).state, "NOTHING");
});

test("ENG-28d брама: незавершений товарний запуск (журнал неповний) → «Знайти нові товари» BLOCKED без жодного запису; після відновлення — працює", async () => {
  const w = await updated();
  w.fault = { op: "appendRows", title: SHEET.journal, mode: "reject" };
  assert.equal((await w.update(w.xml2, 10)).state, "JOURNAL_INCOMPLETE");
  const find = (min) => { w.clock.now = Math.max(w.clock.now, NOW + min * 60_000); return withSession(w, "find-new", "intake", (s) => findNewProducts({ sheets: s.sheets, readBook: w.readBook, xml: dated(w.xml2, min), source: URL_F, fetchedAt: at(min), stamp: at(min), now: w.clock.now, config: cfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, session: s })); };
  const log0 = w.mem.log.length;
  const f = await find(15);
  assert.equal(f.state, "BLOCKED", JSON.stringify(f).slice(0, 300)); assert.match(f.reason, /незавершений запуск/);
  assert.equal(w.mem.log.length, log0, "жодного запису");
  assert.equal((await w.update(w.xml2, 20)).sync.recovery?.state, "JOURNAL_RECOVERED");
  assert.notEqual((await find(25)).state, "BLOCKED");
});

// ================================================================ Hermes U3: перший прохід обірвано після запису заголовка
test("ENG-28d журнал (Hermes U3): перший прохід обірвано після заголовка, до стану полів у рядках → BLOCKED до reconcile; наступний запуск продовжує міграцію (жодного «ІЗОЛЬОВАНО»), дані й історія товарних змін = еталону без збою", async () => {
  const mk = async () => {
    const w = world({ products: 40, queue: 4, seed: 23 });
    await run.mergeNew92({ sheets: w.mem, readBook: w.readBook, stamp: at(0) });
    w.update = (xml, min) => { w.clock.now = Math.max(w.clock.now, NOW + min * 60_000); return withSession(w, "update", "sync", (s) => updateProducts({ sheets: s.sheets, readBook: w.readBook, xml: dated(xml, min), source: URL_F, fetchedAt: at(min), stamp: at(min), now: w.clock.now, config: cfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, session: s })); };
    const rows = main(w).slice(3, 8);
    w.xml3 = rows.reduce((x, r) => perturb.tag(x, t(r["ID постачальника"]), "price", "777"), w.xml);
    w.xml3 = perturb.tag(w.xml3, t(main(w)[12]["ID постачальника"]), "name_ua", "Нова назва постачальника U3");
    return w;
  };
  const LIVE = ["Ціна постачальника", "Ціна", "Ціна кінцева", "Знижка", "Наявність", "Кількість постачальника", "Назва постачальника UA", "Назва постачальника RU", "Фото JSON"];
  const sig = (w) => JSON.stringify(main(w).map((r) => [t(r["Offer ID"]), ...LIVE.map((k) => mtText(r[k]))]).sort());
  const bag = (w, from) => journalRows(w).slice(from).filter((e) => t(e[1]) !== "СИСТЕМА").map((e) => [t(e[2]), t(e[3]), mtText(e[4]), mtText(e[5]), t(e[6]).slice(0, 60)].join("|")).sort();
  // Еталон: той самий перший прохід без збою.
  const ref = await mk(), jr = journalRows(ref).length;
  assert.equal((await ref.update(ref.xml3, 20)).state, "SYNCED");
  // Збій: заголовок записано, перший позиційний блок «Основного каталогу» — тайм-аут (стан полів у рядки не записано).
  const w = await mk(), j0 = journalRows(w).length;
  w.fault = { op: "updateRanges", title: SHEET.main, mode: "timeout" };
  const r1 = await w.update(w.xml3, 10);
  assert.equal(r1.state, "INCOMPLETE", JSON.stringify(r1).slice(0, 300));
  assert.ok(w.mem.book[SHEET.main][0].map(t).includes("Стан полів JSON") || w.mem.book[SHEET.main][0].length > ref.mem.book[SHEET.main][0].length - 1, "заголовок уже записано");
  assert.equal((await planOf(w)).stateMigration, true, "план зафіксував міграцію стану до першого запису");
  assert.equal((await w.update(w.xml3, 15)).state, "BLOCKED", "без reconcile — нічого");
  await reconcile(w);
  const r2 = await w.update(w.xml3, 20);
  assert.equal(r2.state, "SYNCED", JSON.stringify(r2).slice(0, 300));
  assert.ok(["JOURNAL_RECOVERED", "RUN_PLAN_ABANDONED"].includes(r2.sync.recovery?.state), JSON.stringify(r2.sync.recovery));
  assert.equal(r2.report.conflicts.isolated, 0, "жодного рядка «без стану полів»");
  assert.equal(journalRows(w).filter((e) => t(e[3]) === "ІЗОЛЬОВАНО").length, 0);
  assert.equal(sig(w), sig(ref), "товарні дані = еталону");
  assert.deepEqual(bag(w, j0), bag(ref, jr), "історія товарних змін = еталону (без втрат і зайвих)");
  const ids = journalIdsOf(w); assert.equal(new Set(ids).size, ids.length);
  // Наступний запуск: міграцію завершено — без повторних подій.
  const j2 = journalRows(w).length;
  const r3 = await w.update(w.xml3, 30);
  assert.ok(["SYNCED", "NO_CHANGES"].includes(r3.state));
  assert.equal(bag(w, j2).length, 0, "наступний запуск не повторює подій");
});

// ================================================================ Hermes S5b: запізнілий запит дописування після вікна settle (R-N3W)
test("ENG-28d перенесення (Hermes S5b, R-N3W): запит дописування застосовано ПІЗНІШЕ, ніж reconcile зробив висновок «не застосовано» → після продовження 92 дублі; система їх не пише сама, але виявляє: повтор перенесення — NOTHING, «Оновити товари» — без записів", async () => {
  const w = await prepared();
  w.mem.armFault({ op: "appendRows", nth: 1, mode: "delay" }); // перше дописування — дописування товарів до «Основного каталогу»
  const r1 = await transfer(w, 1);
  assert.equal(r1.state, "INCOMPLETE", JSON.stringify(r1).slice(0, 300));
  assert.equal(main(w).length, w.mainIds0.length, "запит ще не застосовано");
  await reconcile(w);
  const r2 = await transfer(w, 10);
  assert.equal(r2.state, "TRANSFERRED", JSON.stringify(r2).slice(0, 300));
  assertTransferred(w);
  assert.equal(w.mem.flushDelayed(), 1, "запізнілий запит дійшов після продовження");
  const mids = ids(main(w));
  assert.equal(mids.length - new Set(mids).size, w.queueIds.length, "92 дублі — залишковий ризик R-N3W (не атомарно)");
  const log0 = w.mem.log.length;
  assert.equal((await transfer(w, 20)).state, "NOTHING", "перенесення завершено — нічого не пише");
  const mainSnap = JSON.stringify(w.mem.book[SHEET.main]);
  const u = await withSession(w, "update", "sync", (s) => updateProducts({ sheets: s.sheets, readBook: w.readBook, xml: dated(w.xml, 30), source: URL_F, fetchedAt: at(30), stamp: at(30), now: (w.clock.now = NOW + 30 * 60_000), config: cfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, session: s }));
  assert.notEqual(u.state, "SYNCED", JSON.stringify(u).slice(0, 300));
  assert.equal(JSON.stringify(w.mem.book[SHEET.main]), mainSnap, "«Оновити товари» нічого не записала в «Основний каталог»");
  assert.ok(w.mem.log.length >= log0);
});

// ================================================================ Hermes U8b: запізнілий запит «Журналу» після вікна settle (R-N3W)
test("ENG-28d журнал (Hermes U8b, R-N3W): запит «Журналу» застосовано ПІЗНІШЕ, ніж reconcile зробив висновок «не застосовано» → відновлення дописало події; запізнілий запит дає дублі з ТИМИ САМИМИ «ID події» (видно за ключем, товарних записів не повторено)", async () => {
  const w = await updated();
  w.fault = { op: "appendRows", title: SHEET.journal, mode: "delay" };
  const r = await w.update(w.xml2, 10);
  assert.equal(r.state, "JOURNAL_INCOMPLETE", JSON.stringify(r).slice(0, 300));
  const plan = await planOf(w);
  assert.equal((await w.update(w.xml2, 20)).state, "BLOCKED", "невідомий результат — без reconcile нічого");
  await reconcile(w);
  const live = () => JSON.stringify(main(w).map((x) => ["Offer ID", "Ціна постачальника", "Ціна", "Наявність"].map((k) => mtText(x[k]))));
  const live0 = live();
  const r2 = await w.update(w.xml2, 40);
  assert.equal(r2.sync.recovery?.state, "JOURNAL_RECOVERED", JSON.stringify(r2.sync).slice(0, 300));
  assert.equal(r2.state, "SYNCED");
  let mine = journalIdsOf(w).filter((x) => x.startsWith(plan.runId));
  assert.equal(mine.length, plan.events.length, "до запізнілого запиту — кожна подія рівно раз");
  assert.equal(w.mem.flushDelayed(), 1, "запізнілий запит дійшов");
  mine = journalIdsOf(w).filter((x) => x.startsWith(plan.runId));
  assert.equal(mine.length, plan.events.length * 2, "дублі подій — залишковий ризик R-N3W");
  assert.equal(new Set(mine).size, plan.events.length, "ті самі «ID події» — дублі видно й можна прибрати; вигаданих подій немає");
  assert.equal(live(), live0, "товарні дані не змінено ні відновленням, ні запізнілим запитом");
});
