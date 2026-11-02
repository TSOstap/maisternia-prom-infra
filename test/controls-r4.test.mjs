/** Catalog Controls R4 — регресійні тести блокерів третього ревю Hermes (independent-20261029T144034):
 *  F1 довірена прив'язка непідтверджених операцій (H02, H03, H12); F2 відбиток і verifyControlsSnapshot (H08); F3 правдивість
 *  «Стану керування» за UNKNOWN / UNCONFIRMED і без доказу публікації (H05, H06); F4 межа запису guardWriter (H07); W2 — запізнілий
 *  запис контрольної точки застарілою орендою (H04). Тести викликають лише API, наявне в R3, тому однаково запускаються на
 *  замороженому R3 (мають бути RED зі змістовною причиною) і на R4 (GREEN). Усе — синтетика в пам'яті й фейковий транспорт. */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { SHEET, passportValues } from "../src/core/sheet-sync.mjs";
import { GROUP_HEADERS, SEAL_COLUMN, approvalManifest, rowSeal } from "../src/core/seal.mjs";
import { objectsFromValues } from "../src/core/yml.mjs";
import { ACTION, CC_SHEET, SALE_DECISION, historyRow, historySeal } from "../src/core/controls-common.mjs";
import { controlsState, verifyControlsSnapshot } from "../src/core/controls-plan.mjs";
import { CHECKPOINT_KEY, LEASE_SCOPE, guardWriter } from "../src/pipeline/controls-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { ACTIVE_CONTRACT, prepared, setCells, codeOf, history, later, viewOf, mainRows, rowOf } from "./helpers/controls.mjs";
import { HOLD, ID, ID2, RELEASE, apply, col, confirmR, cpOf, fakeSheetsApi, prompt, readinessDouble, stateOf } from "./helpers/controls-r3.mjs";

const DEL = (id) => `ВИДАЛИТИ ТОВАР ${id}`;
const ctxOf = (R) => ({ contract: ACTIVE_CONTRACT, checkpoint: cpOf(R) });
const releaseRows = (w, id) => history(w).filter((x) => x[col("Дія")] === ACTION.RELEASE && (!id || x[col("Offer ID")] === id));
const UNCERTAIN = /НЕВИЗНАЧЕНО/;

/** Код вже стоїть у клітинці; запуск дописує подію, а коміт контрольної точки не вдається (UNCONFIRMED). */
async function commitFails(w, R, hours, extra = {}) {
  R.store.failCommit = true;
  const r = await apply(w, R, { stamp: later(hours), ...extra });
  R.store.failCommit = false;
  assert.equal(r.state, "UNCONFIRMED", "передумова: коміт точки не вдався — " + JSON.stringify(r));
  return r;
}

// ---------------------------------------------------------------- F1 — довірена прив'язка
test("R4-F1 (H02): непідтверджений HOLD, у рядку журналу Offer ID замінено й печатку перераховано — оригінал не втрачає HOLD", async () => {
  const w = await prepared(); const R = readinessDouble();
  await prompt(w, R, ID, HOLD);
  await commitFails(w, R, 1);
  const row = history(w).find((x) => x[col("Дія")] === ACTION.HOLD);
  row[col("Offer ID")] = ID2; row[col("Печатка")] = historySeal(row);
  const s = stateOf(w, R);
  assert.ok(s.blocked || s.held.has(ID), "оригінальний товар має лишатися поза продажем (або стан blocked)");
});

test("R4-F1 (H03): непідтверджений RELEASE товару B переадресовано на A з перерахованою печаткою — довиконання не відкриває A", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await confirmR(w, R, ID2, HOLD, 1);
  await prompt(w, R, ID2, RELEASE, 2);
  await commitFails(w, R, 3);
  const ev = history(w).find((x) => x[col("Дія")] === ACTION.RELEASE);
  ev[col("Offer ID")] = ID; ev[col("Печатка")] = historySeal(ev);
  setCells(w, ID2, { [SALE_DECISION]: "" });
  await apply(w, R, { stamp: later(4) });
  const after = stateOf(w, R);
  assert.ok(after.blocked || after.held.has(ID), "A без рішення власника не можна відкривати в продаж");
  assert.doesNotMatch(viewOf(w, ID)?.["Продаж"] || "", /^У ПРОДАЖУ/, "вигляд A не повинен показувати «У ПРОДАЖУ»");
});

test("R4-F1: сторонній рядок RELEASE із коректною печаткою без жодного наміру Catalog Controls — не легалізується довиконанням", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  w.book[CC_SHEET.history].push(historyRow({ stamp: later(2), opId: "op-forged000000000000000000", offerId: ID, action: ACTION.RELEASE, field: "Продаж", before: "ЗНЯТО", after: "У ПРОДАЖУ", reason: "рішення власника", generation: "sale:2" }));
  await apply(w, R, { stamp: later(3) });
  const s = stateOf(w, R);
  assert.ok(s.blocked || s.held.has(ID), "недовірений рядок не відкриває продаж");
  // R4 → R5 (рішення D): замість глобального blocked — послаблювальний рядок без прив'язки не діє, товар ізольовано.
  assert.equal(s.blocked, false, "без загальної зупинки");
  assert.ok(s.held.has(ID) && s.damaged.has(ID), "товар поза продажем і позначений для перевірки");
});

test("R4-F1: непідтверджений RELEASE (коміт не вдався), до звірки власник зняв команду — повернення не підтверджується, товар поза продажем", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  await commitFails(w, R, 2);
  assert.equal(releaseRows(w, ID).length, 1, "передумова: рядок RELEASE дописано");
  setCells(w, ID, { [SALE_DECISION]: "" });
  await apply(w, R, { stamp: later(3) });
  const s = stateOf(w, R);
  assert.ok(s.blocked || s.held.has(ID), "без чинної команди власника послаблення не підтверджується");
});

test("R4-F1 (H12, без справжнього writer): запізнілий append RELEASE після зміни ідентичності й зняття команди не підтверджується автоматично", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  const inner = w.sheets, late = [];
  const sheets = { ...inner, appendRows: async (title, rows) => {
    if (title === CC_SHEET.history && rows.some((r) => r[col("Дія")] === ACTION.RELEASE)) { late.push(structuredClone(rows)); throw new Error("імітовано: відповідь втрачено, запит застосується пізніше"); }
    return inner.appendRows(title, rows);
  } };
  const first = await apply(w, R, { stamp: later(2), sheets });
  assert.notEqual(first.state, "COMMITTED", JSON.stringify(first));
  assert.ok(late.length > 0, "передумова: append RELEASE відкладено");
  setCells(w, ID, { [SALE_DECISION]: "", "Артикул постачальника": "R4-NEW-PHYSICAL-ITEM", "Назва постачальника UA": "Інший фізичний товар", "Назва постачальника RU": "Другой физический товар" });
  const v = w.book[SHEET.main], i = v.findIndex((x) => x[0] === ID);
  v[i][v[0].indexOf(SEAL_COLUMN)] = rowSeal(rowOf(w, ID));
  for (const rows of late) await w.mem.appendRows(CC_SHEET.history, rows);
  assert.ok(releaseRows(w, ID).length > 0, "передумова: запізнілий рядок RELEASE з'явився в журналі");
  await apply(w, R, { stamp: later(4) });
  const s = stateOf(w, R);
  assert.ok(s.blocked || s.held.has(ID), "стара авторизація RELEASE не діє для зміненої картки без нового коду власника");
});

test("R4-F1 (H12, справжній GoogleSheetsWriter + фейковий транспорт): повтори API й запізнілі append не відкривають продаж зміненої картки", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  const pending = [];
  const api = fakeSheetsApi(w.book, { onAppend: async (title, values, mem) => {
    if (title === CC_SHEET.history && values.some((r) => r[col("Дія")] === ACTION.RELEASE)) { pending.push(structuredClone(values)); return "lost"; }
    await mem.appendRows(title, values); return "ok";
  } });
  const writer = api.writer();
  const first = await apply(w, R, { stamp: later(2), sheets: writer });
  assert.notEqual(first.state, "COMMITTED", JSON.stringify(first));
  // CC4-E1-TEST: передумова не залежить від сліпих повторів writer (E1 їх прибирає) — достатньо одного запізнілого append.
  assert.ok(pending.length >= 1, "передумова: append RELEASE застосується пізніше (відповідь втрачено)");
  setCells(w, ID, { [SALE_DECISION]: "", "Артикул постачальника": "R4-NEW-PHYSICAL-ITEM", "Назва постачальника UA": "Інший фізичний товар", "Назва постачальника RU": "Другой физический товар" });
  const v = w.book[SHEET.main], i = v.findIndex((x) => x[0] === ID);
  v[i][v[0].indexOf(SEAL_COLUMN)] = rowSeal(rowOf(w, ID));
  const groups = objectsFromValues(w.book[SHEET.groups], GROUP_HEADERS);
  w.book[SHEET.passport] = passportValues(approvalManifest(mainRows(w), groups), "тест: власник затвердив нову картку", later(3));
  for (const rows of pending) await api.mem.appendRows(CC_SHEET.history, rows);
  await apply(w, R, { stamp: later(4), sheets: api.writer() });
  const s = stateOf(w, R);
  assert.ok(s.blocked || s.held.has(ID), "запізнілий RELEASE не підтверджено для іншої фізичної картки");
});

// ---------------------------------------------------------------- F2 — відбиток
async function pendingDeletion() {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, DEL(ID), 1);
  await commitFails(w, R, 2);
  const old = rowOf(w, ID);
  const candidate = { id: "2999999991", sku: old["Артикул постачальника"], nameUa: old["Назва постачальника UA"], nameRu: old["Назва постачальника RU"], url: "https://market-tools.com.ua/p2999999991-r4.html" };
  return { w, R, candidate };
}
/** R5: «Виключених назавжди» немає — ідентичність видалення в журналі («Стало» події «ТОВАР ВИДАЛЕНО»); підміна з перерахованою печаткою. */
function resealDeletion(w, change) {
  const row = history(w).find((x) => x[col("Дія")] === ACTION.TOMBSTONE);
  const idn = JSON.parse(row[col("Стало")]);
  change(idn);
  row[col("Стало")] = JSON.stringify(idn); row[col("Печатка")] = historySeal(row);
}

test("R4-F2 (H08): ідентичність непідтвердженого видалення змінено з перерахованою печаткою — відбиток інший, verify відхиляє, фільтр лишається закритим", async () => {
  const { w, R, candidate } = await pendingDeletion();
  const before = stateOf(w, R);
  assert.equal(before.gate.check(candidate).blocked, true, "передумова: фільтр блокує той самий товар під новим ID");
  resealDeletion(w, (o) => Object.assign(o, { supplierId: "2999999992", sku: "R4-DIFFERENT-ITEM", nameUa: "Цілком інший пристрій", nameRu: "Совсем другой прибор" }));
  const after = stateOf(w, R);
  assert.notEqual(after.fingerprint, before.fingerprint, "зміна вхідних даних фільтра має змінювати відбиток");
  assert.equal(verifyControlsSnapshot(structuredClone(w.book), ctxOf(R), before.fingerprint).ok, false);
  assert.equal(after.gate.check(candidate).blocked, true, "недовірений вміст рядка не робить фільтр дозвільним");
});

test("R4-F2: непідтверджений рядок журналу змінено (підстава) з перерахованою печаткою — відбиток змінюється", async () => {
  const w = await prepared(); const R = readinessDouble();
  await prompt(w, R, ID, HOLD);
  await commitFails(w, R, 1);
  const before = stateOf(w, R);
  const row = history(w).find((x) => x[col("Дія")] === ACTION.HOLD);
  row[col("Підстава")] = "інша підстава"; row[col("Печатка")] = historySeal(row);
  assert.notEqual(stateOf(w, R).fingerprint, before.fingerprint);
});

test("R4-F2: confirmed — для всього стану: непідтверджене видалення робить confirmed=false", async () => {
  const { w, R } = await pendingDeletion();
  assert.equal(stateOf(w, R).confirmed, false, "намір видалення поза підтвердженими — стан не підтверджено");
});

// ---------------------------------------------------------------- F3 — правдивість «Стану керування»
test("R4-F3 (H06): точку з RELEASE записано, читання назад не вдалося (UNKNOWN) — вигляд не показує «ЗНЯТО З ПРОДАЖУ», лише НЕВИЗНАЧЕНО без кодів", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  const n0 = cpOf(R).ops.length;
  let failNext = false;
  const get = R.store.getJsonVersioned.bind(R.store);
  R.store.afterPut = (k, v) => { if (k === CHECKPOINT_KEY && (v?.ops?.length || 0) > n0) { R.store.afterPut = null; failNext = true; } };
  R.store.getJsonVersioned = async (k) => { if (k === CHECKPOINT_KEY && failNext) { failNext = false; throw new Error("імітовано: читання точки після запису не вдалося"); } return get(k); };
  const r = await apply(w, R, { stamp: later(2) });
  assert.equal(r.state, "UNKNOWN", JSON.stringify(r));
  assert.ok(!stateOf(w, R).held.has(ID), "передумова: збережена точка вже дозволяє продаж");
  const v = viewOf(w, ID);
  assert.doesNotMatch(v["Продаж"], /ЗНЯТО З ПРОДАЖУ/, "старий напис успіху не можна лишати як поточний");
  assert.match(v["Продаж"], UNCERTAIN);
  assert.equal(v["Коди підтвердження"], "", "за невизначеності коди не пропонуються");
});

test("R4-F3 (H05): вигляд tombstone не стверджує стан фіду YML без доказу публікації", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  assert.equal((await confirmR(w, R, ID, DEL(ID), 1)).state, "COMMITTED");
  assert.doesNotMatch(viewOf(w, ID)["Виключення"], /у YML «немає в наявності»/);
});

test("R4-F3: оренду втрачено після дописування RELEASE — UNKNOWN; товар у вигляді явно НЕВИЗНАЧЕНО", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  let lost = false;
  const acquire = R.committer.acquire.bind(R.committer);
  R.committer.acquire = async (scope) => { const l = await acquire(scope); if (scope !== LEASE_SCOPE) return l; return { ...l, async assertCurrent() { if (lost) throw new Error("STALE: оренду перехоплено"); return l.assertCurrent(); } }; };
  const inner = w.sheets;
  const sheets = { ...inner, appendRows: async (title, rows) => { const res = await inner.appendRows(title, rows); if (title === CC_SHEET.history) lost = true; return res; } };
  const r = await apply(w, R, { stamp: later(2), sheets });
  assert.equal(r.state, "UNKNOWN", JSON.stringify(r));
  assert.match(viewOf(w, ID)["Продаж"], UNCERTAIN, "невизначений результат має бути видно оператору");
});

test("R4-F3: коміт точки з RELEASE не вдався (UNCONFIRMED) — вигляд не подає «ЗНЯТО З ПРОДАЖУ» як підтверджений факт", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  await commitFails(w, R, 2);
  const v = viewOf(w, ID);
  assert.match(v["Продаж"], UNCERTAIN);
  assert.doesNotMatch(v["Продаж"], /ЗНЯТО З ПРОДАЖУ/);
});

// ---------------------------------------------------------------- F4 — межа запису
test("R4-F4 (H07): getter destination — справжній GoogleSheetsWriter + фейковий транспорт не отримує запиту до «Основного каталогу»", async () => {
  const w = await prepared();
  const api = fakeSheetsApi(w.book);
  const cell0 = w.book[SHEET.main][1][0];
  let reads = 0;
  const block = { get title() { return ++reads === 1 ? CC_SHEET.state : SHEET.main; }, row: 2, col: 1, values: [["R4_F4_PROBE"]] };
  try { await guardWriter(api.writer()).updateRanges([block]); } catch { /* відмова — теж безпечно */ }
  assert.equal(w.book[SHEET.main][1][0], cell0, "клітинка «Основного каталогу» не змінена");
  assert.ok(!api.touched().includes(SHEET.main), "жодного HTTP-запиту до «Основного каталогу»: " + JSON.stringify(api.touched()));
});

test("R4-F4: Proxy-блок із мінливим title — запис у «Основний каталог» неможливий", async () => {
  const w = await prepared();
  const api = fakeSheetsApi(w.book);
  const cell0 = w.book[SHEET.main][1][0];
  let n = 0;
  const block = new Proxy({ row: 2, col: 1, values: [["R4_PROXY"]] }, { get(t, k) { if (k === "title") return ++n === 1 ? CC_SHEET.state : SHEET.main; return Reflect.get(t, k); } });
  try { await guardWriter(api.writer()).updateRanges([block]); } catch { /* */ }
  assert.equal(w.book[SHEET.main][1][0], cell0);
  assert.ok(!api.touched().includes(SHEET.main), JSON.stringify(api.touched()));
});

test("R4-F4: Proxy-список, що на другому проході віддає інший блок, — запис у «Основний каталог» неможливий", async () => {
  const w = await prepared();
  const api = fakeSheetsApi(w.book);
  const cell0 = w.book[SHEET.main][1][0];
  const ok = { title: CC_SHEET.state, row: 1, col: 1, values: [["Offer ID"]] }, bad = { title: SHEET.main, row: 2, col: 1, values: [["R4_LIST"]] };
  let n = 0;
  const list = new Proxy([ok], { get(t, k) { if (k === "0") return ++n === 1 ? ok : bad; return Reflect.get(t, k); } });
  try { await guardWriter(api.writer()).updateRanges(list); } catch { /* */ }
  assert.equal(w.book[SHEET.main][1][0], cell0);
  assert.ok(!api.touched().includes(SHEET.main), JSON.stringify(api.touched()));
});

test("R4-F4: назва аркуша — об'єкт із мінливим toString (appendRows) — рядок не потрапляє в «Основний каталог»", async () => {
  const w = await prepared();
  w.book[CC_SHEET.history] = [["Дата"]];
  const n0 = w.book[SHEET.main].length;
  let n = 0;
  const title = { toString() { return ++n === 1 ? CC_SHEET.history : SHEET.main; } };
  try { await guardWriter(new MemorySheets(w.book)).appendRows(title, [["R4_TITLE_OBJECT"]]); } catch { /* */ }
  assert.equal(w.book[SHEET.main].length, n0, "у «Основному каталозі» не з'явилося рядків");
  assert.ok(!w.book[SHEET.main].some((r) => r.includes("R4_TITLE_OBJECT")));
});

// ---------------------------------------------------------------- W2 — запізнілий запис точки (H04)
test("R4-W2 (H04): запис точки призупинено, оренда спливла й видана наступнику — запізнілий запис не дає COMMITTED", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  let actual;
  const acquire = R.committer.acquire.bind(R.committer);
  R.committer.acquire = async (scope) => { const l = await acquire(scope); if (scope === LEASE_SCOPE) actual = l; return l; };
  let arrived, resume; const reached = new Promise((r) => (arrived = r)), gate = new Promise((r) => (resume = r));
  let once = false;
  R.store.hookPut = async (k) => { if (k === CHECKPOINT_KEY && !once) { once = true; arrived(); await gate; } };
  const running = apply(w, R, { stamp: later(2) });
  assert.equal(await Promise.race([reached.then(() => true), running.then(() => false)]), true, "передумова: запис точки призупинено");
  await actual.release();
  const successor = await acquire(LEASE_SCOPE);
  resume();
  const result = await running;
  await successor.release();
  assert.notEqual(result.state, "COMMITTED", "застаріла оренда не може комітити: " + JSON.stringify({ state: result.state, checkpoint: result.checkpoint }));
  assert.ok(stateOf(w, R).held.has(ID), "RELEASE застарілого записувача не діє");
  assert.equal(cpOf(R).pending.length, 0, "запис застарілої оренди відхилено сховищем (fencing): контрольна точка не змінена");
});
