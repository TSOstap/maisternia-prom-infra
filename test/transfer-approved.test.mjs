/** ENG-29 — «Перенести затверджені» (кнопка): затверджені рядки черги → «Основний каталог», перенесені прибираються з «Нових товарів»
 *  (рішення власника 02.11), неповні — «НЕ ПЕРЕНЕСЕНО: … колонка E …», продовження після збою за планом W2. Синтетика, таблиця в пам'яті,
 *  записи — через шлюз W2 і охоронця цілі з політикою режиму transfer. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, DECISION, extractFullOffers, readPassport, samePassport } from "../src/core/sheet-sync.mjs";
import { columnLetter, withColumn, TRANSFER_APPROVED_KEY } from "../src/core/transfer-approved.mjs";
import * as run from "../src/pipeline/sheet-sync-run.mjs";
import { transferApproved } from "../src/pipeline/transfer-approved.mjs";
import { openPlansGate, JOURNAL_SHEET, journalIds } from "../src/pipeline/run-plan.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { guardedSheets, MODE_POLICIES, TEST_SHEET_ID } from "../src/pipeline/safe-write/write-target.mjs";
import { EMPTY_CATALOG, intakeAll } from "./helpers/intake.mjs";
import legacyConfig from "./helpers/legacy-config.mjs";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();
const config = structuredClone(legacyConfig);

async function world() {
  const s = generateSynthetic({ products: 60, queue: 6, deferred: 2, newOffers: 5, seed: 11, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const raw = new MemorySheets(book);
  const w = { s, raw, readBook: async () => raw.read(), xml: s.supplierXml(), store: new MemoryStore() };
  await run.mergeNew92({ sheets: raw, readBook: w.readBook, stamp: STAMP });
  const parsed = await parseSupplierText(w.xml, { maximumChars: 45_000_000, identityFields: true });
  assert.equal((await run.syncSheet({ sheets: raw, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(w.xml, ids), stamp: STAMP, config, now: NOW, catalog: EMPTY_CATALOG })).state, "SYNCED");
  assert.equal((await intakeAll({ sheets: raw, readBook: w.readBook }, w.xml, { session: "auto", stamp: STAMP, now: NOW, config, catalog: EMPTY_CATALOG })).state, "INTAKE_DONE");
  return w;
}
/** Кнопка: сесія «sync» шлюзу W2 над записувачем з охоронцем політики transfer (як у tools/sheet-sync --mode=transfer). */
async function press(w, { stamp = STAMP, sheets = w.raw } = {}) {
  const guarded = guardedSheets(sheets, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES.transfer, headers: { [SHEET.queue]: w.raw.book[SHEET.queue][0] } });
  const session = await new WriteGateway({ sheets: guarded, read: w.readBook, store: w.store, settleMs: 0 }).open({ writer: "sync" });
  try { return await transferApproved({ readBook: w.readBook, stamp, session, config }); }
  finally { await session.close().catch(() => {}); }
}
const qh = (w) => w.raw.book[SHEET.queue][0].map(mtText);
const qRows = (w) => readSheet(w.raw.book[SHEET.queue], SHEET.queue).rows;
const qRow = (w, id) => qRows(w).find((r) => mtText(r["Offer ID"]) === id);
const mainRows = (w) => readSheet(w.raw.book[SHEET.main], SHEET.main).rows;
const setQ = (w, id, col, v) => w.raw.humanSet(SHEET.queue, w.raw.book[SHEET.queue].findIndex((r, i) => i > 0 && mtText(r[qh(w).indexOf("Offer ID")]) === id) + 1, col, v);
function approve(w, id) {
  const groupId = w.raw.book[SHEET.groups][1][0];
  for (const [k, v] of Object.entries({ "Назва UA": "SEO UA " + id, "Назва RU": "SEO RU " + id, "Опис UA": "<p>Опис</p>", "Опис RU": "<p>Описание</p>", "Група ID": groupId, "Категорія Prom ID": "123" })) setQ(w, id, k, v);
  setQ(w, id, "Рішення", DECISION.APPROVE);
}

test("літера колонки й текст причини для власника", () => {
  assert.deepEqual([0, 4, 25, 26, 51, 52].map(columnLetter), ["A", "E", "Z", "AA", "AZ", "BA"]);
  const h = ["Offer ID", "A", "B", "C", "Назва UA"];
  assert.equal(withColumn("порожнє «Назва UA»", h), "не заповнено: колонка E «Назва UA»");
  assert.equal(withColumn("«Група ID» не знайдено в аркуші «Групи»", ["Група ID"]), "колонка A «Група ID» не знайдено в аркуші «Групи»");
  assert.equal(withColumn("щось інше", h), "щось інше");
});

test("кнопка: затверджені → «Основний каталог», прибрано з «Нових товарів»; неповний — «НЕ ПЕРЕНЕСЕНО: не заповнено: колонка … «Назва UA»»; журнал, паспорт, план DONE; повтор нічого не дублює", async () => {
  const w = await world();
  const ids = qRows(w).map((r) => mtText(r["Offer ID"]));
  assert.ok(ids.length >= 4);
  const [a, b, bad, idle] = ids;
  approve(w, a); approve(w, b); approve(w, bad); setQ(w, bad, "Назва UA", "");
  const mainBefore = mainRows(w).length;
  const r = await press(w);
  assert.equal(r.state, "TRANSFERRED", JSON.stringify(r).slice(0, 400));
  assert.equal(r.moved, 2);
  assert.equal(r.removedFromQueue, 2);
  assert.equal(mainRows(w).length, mainBefore + 2);
  for (const id of [a, b]) {
    const m = mainRows(w).find((x) => mtText(x["Offer ID"]) === id);
    assert.ok(m, "товар у каталозі");
    assert.equal(m["Назва UA"], "SEO UA " + id);
    assert.equal(m["Статус імпорту"], "ДОЗВОЛЕНО");
    assert.equal(qRow(w, id), undefined, "рядок прибрано з черги");
  }
  const letter = columnLetter(qh(w).indexOf("Назва UA"));
  assert.match(qRow(w, bad)["Перевірка"], new RegExp(`^НЕ ПЕРЕНЕСЕНО: не заповнено: колонка ${letter} «Назва UA»`));
  assert.ok(r.notTransferred.some((x) => x.offerId === bad && x.problems.some((p) => p.includes(`колонка ${letter}`))));
  assert.ok(qRow(w, idle), "незатверджений рядок лишився");
  assert.equal(mainRows(w).filter((x) => mtText(x["Offer ID"]) === bad).length, 0);
  const journal = w.raw.book[JOURNAL_SHEET];
  assert.ok(journal.some((e) => e[2] === a && e[3] === "ЗАТВЕРДЖЕНО"));
  assert.ok(journal.some((e) => e[2] === b && e[3] === "ПРИБРАНО З ЧЕРГИ"));
  assert.ok(journal.some((e) => e[2] === bad && e[3] === "НЕ ПЕРЕНЕСЕНО"));
  assert.equal(journalIds(journal).size, journal.length - 1 - journal.slice(1).filter((e) => !mtText(e[7])).length);
  assert.equal((await w.store.getJsonVersioned(TRANSFER_APPROVED_KEY)).value.status, "DONE");
  assert.ok(r.verify.passportOk && r.verify.journalOk && r.verify.movedIdentical);
  // Повтор: нічого нового, неповний — лише у звіті.
  const r2 = await press(w, { stamp: new Date(NOW + 60_000).toISOString() });
  assert.equal(r2.state, "NOTHING");
  assert.ok(r2.notTransferred.some((x) => x.offerId === bad));
  assert.equal(mainRows(w).length, mainBefore + 2);
});

test("перенесені раніше (позначка «ПЕРЕНЕСЕНО…», ID уже в каталозі) — прибираються з черги; без позначки — не чіпаються", async () => {
  const w = await world();
  const main = mainRows(w), h = qh(w);
  const mk = (row, check) => h.map((k) => (k === "Перевірка" ? check : k in row ? row[k] : ""));
  const earlier = mtText(main[0]["Offer ID"]), other = mtText(main[1]["Offer ID"]);
  w.raw.book[SHEET.queue].push(mk(main[0], "ПЕРЕНЕСЕНО В «ОСНОВНИЙ КАТАЛОГ» 2026-11-02 (доручення власника); рядок черги не видаляється до рішення B6"));
  w.raw.book[SHEET.queue].push(mk(main[1], "якийсь текст власника"));
  const r = await press(w);
  assert.equal(r.state, "TRANSFERRED", JSON.stringify(r).slice(0, 300));
  assert.equal(r.moved, 0);
  assert.equal(r.removedFromQueue, 1);
  assert.equal(qRow(w, earlier), undefined);
  assert.ok(qRow(w, other), "рядок без системної позначки лишився");
  assert.equal(mainRows(w).length, main.length);
});

test("збій під час прибирання з черги → INCOMPLETE; інші товарні операції заблоковано; повторне натискання продовжує за планом без дублів; рядок, змінений власником між збоєм і продовженням, не видаляється", async () => {
  const w = await world();
  const ids = qRows(w).map((r) => mtText(r["Offer ID"]));
  const [a, b] = ids;
  approve(w, a); approve(w, b);
  const mainBefore = mainRows(w).length;
  w.raw.armFailure("deleteRows");
  const r1 = await press(w);
  assert.equal(r1.state, "INCOMPLETE", JSON.stringify(r1).slice(0, 300));
  assert.deepEqual(r1.done, ["main", "passport"]);
  assert.equal(mainRows(w).length, mainBefore + 2);
  assert.ok(qRow(w, a) && qRow(w, b), "рядки черги ще на місці");
  const gate = await openPlansGate({ store: w.store, session: null, readBook: w.readBook, stamp: STAMP, recover: false });
  assert.equal(gate.state, "BLOCKED");
  assert.match(gate.reason, /Перенести затверджені/);
  setQ(w, b, "Опис UA", "<p>Власник виправив опис після перенесення</p>");
  const r2 = await press(w, { stamp: new Date(NOW + 120_000).toISOString() });
  assert.equal(r2.state, "TRANSFERRED", JSON.stringify(r2).slice(0, 400));
  assert.equal(r2.resumed, true);
  assert.equal(mainRows(w).length, mainBefore + 2, "без дублів");
  assert.equal(qRow(w, a), undefined);
  assert.ok(qRow(w, b), "змінений рядок не видалено");
  assert.ok(r2.conflicts.some((c) => c.offerId === b));
  assert.equal((await w.store.getJsonVersioned(TRANSFER_APPROVED_KEY)).value.status, "DONE");
  assert.equal(await openPlansGate({ store: w.store, session: null, readBook: w.readBook, stamp: STAMP, recover: false }), null);
});

test("охоронець: transfer не може видаляти рядки каталогу, писати інші колонки черги чи змінювати наявні картки; інші режими не можуть видаляти рядки черги", async () => {
  const w = await world();
  const g = (mode) => guardedSheets(w.raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES[mode], headers: { [SHEET.queue]: w.raw.book[SHEET.queue][0], [SHEET.main]: w.raw.book[SHEET.main][0] } });
  await assert.rejects(g("transfer").deleteRows(SHEET.main, [2]), /видалення рядків заборонено/);
  await assert.rejects(g("transfer").updateRanges([{ title: SHEET.queue, row: 2, col: qh(w).indexOf("Рішення") + 1, values: [["x"]] }]), /не дозволена/);
  await assert.rejects(g("transfer").updateRanges([{ title: SHEET.main, row: 2, col: 1, values: [["x"]] }]), /не дозволена/);
  for (const m of ["update", "find-new", "sync", "merge", "qa"]) await assert.rejects(g(m).deleteRows(SHEET.queue, [2]), /видалення рядків заборонено/, m);
  const len = w.raw.book[SHEET.queue].length;
  await g("transfer").deleteRows(SHEET.queue, [len]);
  assert.equal(w.raw.book[SHEET.queue].length, len - 1);
});

test("паспорт після перенесення = затвердженому набору", async () => {
  const w = await world();
  const [a] = qRows(w).map((r) => mtText(r["Offer ID"]));
  approve(w, a);
  const r = await press(w);
  assert.equal(r.state, "TRANSFERRED");
  const cp = (await w.store.getJsonVersioned(TRANSFER_APPROVED_KEY)).value;
  assert.ok(samePassport(readPassport(w.raw.book[SHEET.passport]), cp.passportAfter));
  assert.equal(cp.passportAfter.count, mainRows(w).length);
});

test("підсумок для власника (вікно «Стан останньої операції»): перенесено, прибрано, причини з літерою колонки", async () => {
  const { ownerSummary } = await import("../src/pipeline/ops-summary.mjs");
  const s = ownerSummary("transfer", { result: { state: "TRANSFERRED", moved: 2, count: 5123, removedFromQueue: 94, notTransferred: [{ offerId: "324325435", problems: ["не заповнено: колонка E «Назва UA»"] }], conflicts: [] } });
  assert.match(s, /^Перенесено \(TRANSFERRED\)/);
  assert.match(s, /Перенесено в «Основний каталог»: 2; у каталозі тепер 5123/);
  assert.match(s, /Прибрано з «Нових товарів»: 94/);
  assert.match(s, /Не перенесено 324325435: не заповнено: колонка E «Назва UA»/);
  assert.match(ownerSummary("transfer", { result: { state: "INCOMPLETE", error: "x", next: "натисніть ще раз" } }), /Далі: натисніть ще раз/);
});

test("«Основний каталог» без службових колонок вмісту (як у TEST): картка пишеться в наявні колонки, структура не змінюється, у звіті — які колонки не перенесено", async () => {
  const w = await world();
  const drop = ["Опис постачальника UA", "Опис постачальника RU", "Характеристики постачальника JSON"];
  const mv = w.raw.book[SHEET.main], keep = mv[0].map((k, i) => (drop.includes(mtText(k)) ? -1 : i)).filter((i) => i >= 0);
  w.raw.book[SHEET.main] = mv.map((r) => keep.map((i) => r[i] ?? ""));
  const width = w.raw.book[SHEET.main][0].length;
  const [a] = qRows(w).map((r) => mtText(r["Offer ID"]));
  approve(w, a);
  const r = await press(w);
  assert.equal(r.state, "TRANSFERRED", JSON.stringify(r).slice(0, 300));
  assert.equal(r.moved, 1);
  assert.equal(w.raw.book[SHEET.main][0].length, width, "колонки не додано");
  for (const k of drop) assert.ok(r.droppedColumns.includes(k), k);
  assert.ok(mainRows(w).some((x) => mtText(x["Offer ID"]) === a));
});

test("Hermes F-28C-2 / F-28C-3 (ENG-29): update не дописує рядки в каталог і не чіпає чергу та «Заморожені ID»; find-new може лише очищувати «Рішення»", async () => {
  const w = await world();
  const headers = Object.fromEntries(Object.entries(w.raw.book).map(([k, v]) => [k, (v[0] || []).slice()]));
  const g = (mode) => guardedSheets(w.raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES[mode], headers });
  const mh = headers[SHEET.main].map(mtText), qhh = headers[SHEET.queue].map(mtText);
  await assert.rejects(g("update").appendRows(SHEET.main, [mh.map(() => "x")]), /appendRows/);
  await assert.rejects(g("update").updateRanges([{ title: SHEET.queue, row: 2, col: 1, values: [["x"]] }]), /не дозволено/);
  await assert.rejects(g("update").appendRows(SHEET.frozen, [["123"]]), /не дозволено/);
  await g("update").updateRanges([{ title: SHEET.main, row: 2, col: mh.indexOf("Характеристики JSON") + 1, values: [["[]"]] }]);
  const dc = qhh.indexOf("Рішення") + 1;
  await assert.rejects(g("find-new").updateRanges([{ title: SHEET.queue, row: 2, col: dc, values: [[DECISION.APPROVE]] }]), /лише очищувати/);
  await g("find-new").updateRanges([{ title: SHEET.queue, row: 2, col: dc, values: [[""]] }]);
  await assert.rejects(g("find-new").appendRows(SHEET.queue, [qhh.map((k) => (k === "Рішення" ? DECISION.APPROVE : "1"))]), /лише очищувати/);
  await assert.rejects(g("find-new").appendRows(SHEET.main, [["1"]]), /не дозволено/);
});
