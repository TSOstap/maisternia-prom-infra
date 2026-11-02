/** Catalog Controls R6 — остаточне рішення власника щодо видалених товарів (29.10.2026):
 *  1) «Видалити товар» — одна дія (внутрішні захисні переходи лишаються); 2) надійний tombstone; 3) перенесення — Engineering;
 *  4) видалений товар повністю відсутній у новому YML (не available="false"); 5) не оновлюється й не повертається через фід;
 *  6) повернення — лише окремим підтвердженим рішенням; 7) видалення не блокує інших; 8) старий YML / fallback не передає видалений;
 *  завершення — рішення + архів + активний опублікований YML без цього Offer ID; підтвердження Prom не потрібне.
 *  Нові API R6 імпортуються динамічно, тому файл запускається й на замороженому R5 (змістовний RED, не помилка імпорту). */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { GROUP_HEADERS, approvalManifest } from "../src/core/seal.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { buildYml, memorySink, objectsFromValues } from "../src/core/yml.mjs";
import { ACTION, ARCHIVE_SHEET, CC_SHEET, SALE_DECISION, loadControlsContract, validateContract } from "../src/core/controls-common.mjs";
import { holdRowsForYml } from "../src/core/controls-sale.mjs";
import { controlsState } from "../src/core/controls-plan.mjs";
import { CHECKPOINT_KEY } from "../src/pipeline/controls-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { ACTIVE_CONTRACT, PROTECTION_OK, prepared, run, confirm, codeOf, viewOf, mainRows, eventsOf, evField, setCells, spy, later } from "./helpers/controls.mjs";
import { readinessDouble } from "./helpers/controls-r3.mjs";

const ID = "1500000007", ID2 = "1500000014", ID3 = "1500000021";
const HOLD = "ЗНЯТИ З ПРОДАЖУ", RELEASE = "ПОВЕРНУТИ В ПРОДАЖ", DEL = (id) => `ВИДАЛИТИ ТОВАР ${id}`, BACK = (id) => `ПОВЕРНУТИ З АРХІВУ ${id}`;
const cpOf = (w) => w.store.data.get(CHECKPOINT_KEY) ?? null;
const stateOf = (w, extra = {}) => controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: cpOf(w), publication: w.publication ?? null, ...extra });
const offerRe = (id) => new RegExp(`<offer id="${id}"[\\s>]`);
/** Еталонна проєкція CC для YML (локально, щоб не залежати від нового API): видалені — без рядка; зняті — «немає в наявності». */
async function ymlOf(w, st) {
  const all = mainRows(w), groups = objectsFromValues(w.book[SHEET.groups], GROUP_HEADERS), sink = memorySink();
  const rows = holdRowsForYml(all.filter((r) => !st.tombstoned.has(mtText(r["Offer ID"]))), st.held).rows;
  const success = mtText(all[0]["Оновлено"]);
  await buildYml({ rows, groups, manifest: approvalManifest(rows, groups), meta: { syncState: "OK", lastSuccess: success, now: Date.parse(success) + 60000 }, config: { maximumSyncAgeHours: 12, shopName: "Тест", company: "Тест", timeZone: "Europe/Kyiv" }, maximumBytes: 50_000_000, sink, missingPolicy: "unavailable", conflictPolicy: "isolate" });
  return sink.text();
}
/** Одна дія власника: «ВИДАЛИТИ ТОВАР <id>» → код → команда з кодом (без попереднього зняття). */
async function deleteOnce(w, id, hours = 1, opts = {}) {
  setCells(w, id, { [SALE_DECISION]: DEL(id) });
  await run(w, { stamp: later(hours), ...opts });
  setCells(w, id, { [SALE_DECISION]: `${DEL(id)} ${codeOf(w, id, DEL(id))}` });
  return run(w, { stamp: later(hours + 0.5), ...opts });
}
/** Видалення зі знятого товару (двокроково — сумісно з R5): передумова для тестів, що перевіряють не одну дію, а інше. */
async function deleteHeld(w, id, hours = 1) {
  await confirm(w, id, SALE_DECISION, HOLD, { stamp: later(hours) });
  const { r2 } = await confirm(w, id, SALE_DECISION, DEL(id), { stamp: later(hours + 0.2) });
  return r2;
}
/** Двійник перенесення Engineering; extra — службові колонки архіву Engineering (archiveHeader: колонки каталогу + додаткові). */
function moveRow(book, id, from, to, { stop = "", extra = null } = {}) {
  const src = book[from], h = src[0].map(mtText);
  if (!book[to]?.length) book[to] = [extra && to === ARCHIVE_SHEET ? [...h, ...Object.keys(extra)] : h.slice()];
  const th = book[to][0].map(mtText);
  const i = src.findIndex((r, k) => k > 0 && mtText(r[0]) === id);
  const obj = Object.fromEntries(h.map((k, j) => [k, src[i][j] ?? ""]));
  if (!book[to].some((r, k) => k > 0 && mtText(r[0]) === id)) book[to].push(th.map((k) => (k in obj ? obj[k] : extra?.[k] ?? "")));
  if (stop !== "afterCopy") src.splice(i, 1);
}
/** Службові колонки архіву Engineering (src/core/archive.mjs ARCHIVE_EXTRA, знімок 29.10.2026 22:20). */
const ENG_EXTRA = { "Видалено": "2026-10-29T12:00:00.000Z", "Операція видалення": "op-eng", "Статус видалення": "ОЧІКУЄ ПУБЛІКАЦІЇ YML", "YML без товару": "" };

test("R6-1: «Видалити товар» — одна дія власника для товару в продажу; запис журналу не вдався → PENDING, але товар уже поза YML (реєстр із довіреного наміру); наступний запуск довиконує без дублів", async () => {
  const w = await prepared();
  setCells(w, ID, { [SALE_DECISION]: DEL(ID) });
  await run(w, { stamp: later(1) });
  setCells(w, ID, { [SALE_DECISION]: `${DEL(ID)} ${codeOf(w, ID, DEL(ID))}` });
  const s0 = spy(new MemorySheets(w.book));
  w.sheets = { ...s0, appendRows: async (t, rows) => { if (t === CC_SHEET.history) throw new Error("імітовано: append журналу не виконано"); return s0.appendRows(t, rows); } };
  const r = await run(w, { stamp: later(2) });
  assert.equal(r.state, "PENDING", JSON.stringify(r));
  assert.equal(eventsOf(w, ID).length, 0, "передумова: рядків ще немає");
  const s = stateOf(w);
  assert.ok(s.tombstoned.has(ID) && s.held.has(ID) && s.gate.knownIds.has(ID), "захисне рішення діє одразу з наміру");
  assert.ok(!offerRe(ID).test(await ymlOf(w, s)), "у новий YML не передається");
  assert.deepEqual(s.moves.toArchive, [], "непідтверджене — не переносити");
  w.sheets = spy(new MemorySheets(w.book));
  const r2 = await run(w, { stamp: later(3) });
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2));
  assert.deepEqual(eventsOf(w, ID).map((e) => evField(e, "Дія")).sort(), [ACTION.HOLD, ACTION.TOMBSTONE].sort(), "внутрішнє зняття + видалення, кожне один раз");
  assert.deepEqual(stateOf(w).moves.toArchive, [ID], "після підтвердження — доручення перенесення");
});

test("R6-2: одна дія не обходить захисту: FZ / OV / захист не перевірено — видалення не виконується й внутрішнього зняття немає", async () => {
  for (const protection of [{ ...PROTECTION_OK, fzIds: new Set([ID]) }, { ...PROTECTION_OK, ovIds: new Set([ID]) }, null]) {
    const w = await prepared();
    setCells(w, ID, { [SALE_DECISION]: DEL(ID) });
    await run(w, { stamp: later(1), protection });
    const cell = viewOf(w, ID)["Коди підтвердження"];
    const code = new RegExp(`${DEL(ID)} ([0-9A-F]{6})`).exec(cell)?.[1];
    assert.ok(code, "код видається (рішення — на етапі виконання)");
    setCells(w, ID, { [SALE_DECISION]: `${DEL(ID)} ${code}` });
    await run(w, { stamp: later(2), protection });
    assert.equal(eventsOf(w, ID).length, 0, JSON.stringify(protection?.fzIds ? "FZ" : protection));
    assert.ok(!stateOf(w).held.has(ID) && !stateOf(w).tombstoned.has(ID), "товар лишається в продажу");
  }
});

test("R6-3: видалений товар відсутній у новому YML на будь-якій стадії, а тимчасово знятий — offer з available=\"false\"; видалення не блокує інших — у тому самому запуску виконуються команди інших товарів", async () => {
  const w = await prepared();
  await confirm(w, ID3, SALE_DECISION, HOLD);
  const cpBefore = structuredClone(cpOf(w));
  for (const [id, words] of [[ID, DEL(ID)], [ID2, HOLD], [ID3, RELEASE]]) setCells(w, id, { [SALE_DECISION]: words });
  await run(w, { stamp: later(1) });
  for (const [id, words] of [[ID, DEL(ID)], [ID2, HOLD], [ID3, RELEASE]]) setCells(w, id, { [SALE_DECISION]: `${words} ${codeOf(w, id, words)}` });
  const r = await run(w, { stamp: later(2) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  const s = stateOf(w);
  assert.ok(s.tombstoned.has(ID) && !s.tombstoned.has(ID2) && s.held.has(ID2) && !s.held.has(ID3), "видалено, знято, повернуто — усе в одному запуску");
  const xml = await ymlOf(w, s);
  assert.ok(!offerRe(ID).test(xml), "REGISTERED (рядок ще в каталозі) — без offer");
  assert.match(new RegExp(`<offer id="${ID2}"[^>]*>`).exec(xml)?.[0] || "", /available="false"/, "тимчасово знятий — available=false");
  assert.ok(offerRe(ID3).test(xml));
  // регрес точки (відновлено бекап до видалення): рядок «ТОВАР ВИДАЛЕНО» без прив'язки — однаково поза YML
  const sc = controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: cpBefore });
  assert.equal(sc.tombstoned.get(ID)?.stage, "UNBOUND");
  assert.ok(!offerRe(ID).test(await ymlOf(w, sc)), "UNBOUND — без offer");
  // рядок в архіві без рішення CC — поза YML (рядка в каталозі немає), повторне додавання заборонене
  const b = structuredClone(w.book);
  moveRow(b, ID3, SHEET.main, ARCHIVE_SHEET);
  const sb = controlsState(b, { contract: ACTIVE_CONTRACT, checkpoint: cpOf(w) });
  assert.ok(sb.tombstoned.get(ID3)?.stage === "UNREGISTERED" && sb.gate.knownIds.has(ID3));
});

test("R6-4: будь-який YML-кандидат перевіряється перед публікацією (feedViolations): старий YML / відкат / резерв із видаленим Offer ID — відмова; поточний — дозволено; blocked — відмова; непідтверджене видалення теж рахується", async () => {
  const mod = await import("../src/core/controls-plan.mjs");
  assert.equal(typeof mod.feedViolations, "function", "R6: перевірка кандидата YML має бути в API Catalog Controls");
  const w = await prepared();
  const oldXml = await ymlOf(w, stateOf(w));
  const idsOf = (xml) => [...xml.matchAll(/<offer id="(\d+)"/g)].map((m) => m[1]);
  assert.ok(idsOf(oldXml).includes(ID), "передумова: старий YML містить товар");
  await deleteOnce(w, ID);
  const st = stateOf(w);
  const old = mod.feedViolations(idsOf(oldXml), st);
  assert.deepEqual([old.ok, old.removedPresent], [false, [ID]], "старий YML повернув би видалений товар — не публікувати");
  assert.equal(mod.feedViolations(idsOf(await ymlOf(w, st)), st).ok, true);
  assert.equal(mod.feedViolations([], { ...st, blocked: true }).ok, false, "blocked — без публікації");
  assert.equal(mod.feedViolations([], null).ok, false, "стан невідомий — без публікації");
  // непідтверджене видалення (намір у точці, рядка немає)
  const w2 = await prepared();
  setCells(w2, ID2, { [SALE_DECISION]: DEL(ID2) });
  await run(w2, { stamp: later(1) });
  setCells(w2, ID2, { [SALE_DECISION]: `${DEL(ID2)} ${codeOf(w2, ID2, DEL(ID2))}` });
  const s0 = spy(new MemorySheets(w2.book));
  w2.sheets = { ...s0, appendRows: async (t, rows) => { if (t === CC_SHEET.history) throw new Error("імітовано"); return s0.appendRows(t, rows); } };
  await run(w2, { stamp: later(2) });
  assert.deepEqual(mod.feedViolations([ID2, ID3], stateOf(w2)).removedPresent, [ID2]);
});

test("R6-5: готовність publisher (cc-publisher-v2): publisher, що лише робить видалений «немає в наявності» (не вилучає offer), — NOT_READY і 0 записів; відповідний контракту — готовий", async () => {
  const bad = await prepared();
  setCells(bad, ID, { [SALE_DECISION]: HOLD });
  const R = readinessDouble({ omitsRemoved: false });
  const r = await run(bad, { readiness: R, store: R.store, stamp: later(1) });
  assert.equal(r.state, "NOT_READY", JSON.stringify(r));
  assert.match((r.reasons || []).join(" "), /видалений товар є у фіді/);
  assert.equal((bad.book[CC_SHEET.history] || []).length, 0, "0 записів");
  const over = await prepared();
  const O = readinessDouble({ overRemoves: true });
  const ro = await run(over, { readiness: O, store: O.store, stamp: later(1) });
  assert.equal(ro.state, "NOT_READY", "publisher, де видалення зачіпає інші товари, — не готовий");
  assert.match((ro.reasons || []).join(" "), /видалення одного товару зачепило інший/);
  const good = await prepared();
  setCells(good, ID, { [SALE_DECISION]: HOLD });
  const G = readinessDouble();
  assert.notEqual((await run(good, { readiness: G, store: G.store, stamp: later(1) })).state, "NOT_READY");
});

test("R6-6: перенесення — одразу після підтвердженого рішення (без доказу публікації); DONE — архів + активний опублікований YML без цього Offer ID; підтвердження Prom не потрібне й не замінює доказу YML", async () => {
  const w = await prepared();
  const r = await deleteHeld(w, ID);
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.deepEqual(stateOf(w).moves.toArchive, [ID], "без доказу «немає в наявності» / Prom");
  w.publication = new Map([[ID, { feed: "absent" }]]);
  assert.equal(stateOf(w).tombstoned.get(ID).stage, "REGISTERED", "без архівування — не завершено");
  moveRow(w.book, ID, SHEET.main, ARCHIVE_SHEET);
  assert.equal(stateOf(w).tombstoned.get(ID).stage, "DONE", "рішення + архів + YML без товару");
  w.publication = new Map([[ID, { feed: "present", promConfirmed: true }]]);
  assert.equal(stateOf(w).tombstoned.get(ID).stage, "ARCHIVED", "Prom не замінює доказу опублікованого YML");
  w.publication = null;
  assert.equal(stateOf(w).tombstoned.get(ID).stage, "ARCHIVED", "без доказу — внутрішній стан «не завершено», без вимог до власника");
});

test("R6-7: архів Engineering зі службовими колонками («Видалено», «Операція видалення», «Статус видалення», «YML без товару»): перервані перенесення в обидва боки — MOVING з тим самим дорученням; різна колонка каталогу — ANOMALY", async () => {
  const w = await prepared();
  await deleteHeld(w, ID);
  moveRow(w.book, ID, SHEET.main, ARCHIVE_SHEET, { stop: "afterCopy", extra: ENG_EXTRA });
  let s = stateOf(w);
  assert.equal(s.tombstoned.get(ID).stage, "MOVING", "у архів: службові колонки не заважають");
  moveRow(w.book, ID, SHEET.main, ARCHIVE_SHEET, { extra: ENG_EXTRA });
  assert.equal(stateOf(w).tombstoned.get(ID).stage, "ARCHIVED");
  // повернення з архіву: команда в «Видалених товарах» з кодом
  setCells(w, ID, { [SALE_DECISION]: BACK(ID) }, ARCHIVE_SHEET);
  await run(w, { stamp: later(3) });
  setCells(w, ID, { [SALE_DECISION]: `${BACK(ID)} ${codeOf(w, ID, BACK(ID))}` }, ARCHIVE_SHEET);
  const r = await run(w, { stamp: later(4) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.deepEqual(stateOf(w).moves.toCatalog, [ID]);
  moveRow(w.book, ID, ARCHIVE_SHEET, SHEET.main, { stop: "afterCopy" });
  s = stateOf(w);
  assert.deepEqual(s.moves.toCatalog, [ID], "з архіву: копія без службових колонок — те саме доручення (MOVING), а не аномалія");
  assert.ok(!s.damaged.has(ID));
  const mi = w.book[SHEET.main].findIndex((x) => x[0] === ID);
  w.book[SHEET.main][mi][w.book[SHEET.main][0].indexOf("Назва UA")] = "змінено між копіями";
  s = stateOf(w);
  assert.ok(s.damaged.has(ID) && !s.moves.toCatalog.includes(ID), "різні копії — ANOMALY, доручення немає");
});

test("R6-8: повернення — лише окремим підтвердженим рішенням: після повернення з архіву товар поза реєстром видалень, у YML — лише «немає в наявності» до окремого «ПОВЕРНУТИ В ПРОДАЖ»; внутрішнє зняття перед повторним видаленням — нова операція", async () => {
  const w = await prepared();
  await deleteHeld(w, ID);
  moveRow(w.book, ID, SHEET.main, ARCHIVE_SHEET);
  setCells(w, ID, { [SALE_DECISION]: BACK(ID) }, ARCHIVE_SHEET);
  await run(w, { stamp: later(3) });
  setCells(w, ID, { [SALE_DECISION]: `${BACK(ID)} ${codeOf(w, ID, BACK(ID))}` }, ARCHIVE_SHEET);
  await run(w, { stamp: later(4) });
  moveRow(w.book, ID, ARCHIVE_SHEET, SHEET.main);
  let s = stateOf(w);
  assert.ok(!s.tombstoned.has(ID) && s.held.has(ID));
  assert.match(new RegExp(`<offer id="${ID}"[^>]*>`).exec(await ymlOf(w, s))?.[0] || "", /available="false"/);
  const { r2 } = await confirm(w, ID, SALE_DECISION, RELEASE, { stamp: later(5) });
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2));
  assert.ok(!stateOf(w).held.has(ID));
  // повторне видалення (одна дія) — внутрішнє зняття з окремим Operation ID
  await deleteOnce(w, ID, 6);
  const holds = eventsOf(w, ID, ACTION.HOLD);
  assert.equal(holds.length, 2, "зняття власника + внутрішнє зняття перед повторним видаленням");
  assert.equal(new Set(holds.map((e) => evField(e, "Operation ID"))).size, 2);
  assert.match(evField(holds.find((e) => /внутрішній/.test(evField(e, "Підстава"))) || holds[0], "Підстава"), /внутрішній захисний перехід/);
  assert.equal(eventsOf(w, ID, ACTION.TOMBSTONE).length, 2);
});

test("R6-9: контракт v3 — requireTemporaryFirst=false, deletion=OMIT_FROM_YML; старий контракт (v2, попереднє зняття, ARCHIVE_AFTER_UNAVAILABLE) відхиляється", () => {
  const { contract, problems } = loadControlsContract();
  assert.deepEqual(problems, [], "контракт репозиторію валідний");
  assert.deepEqual([contract.v, contract.requireTemporaryFirst, contract.deletion, contract.activated], [3, false, "OMIT_FROM_YML", false]);
  const old = { ...contract, v: 2, requireTemporaryFirst: true, deletion: "ARCHIVE_AFTER_UNAVAILABLE" };
  assert.equal(validateContract(old).length, 3);
});
