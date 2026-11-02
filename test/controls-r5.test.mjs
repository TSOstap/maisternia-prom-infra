/** Catalog Controls R5 — регресійні тести зауважень Hermes R4 (independent-20261029T183021) і рішень власника:
 *  CC4-N1 — явна фізична ідентичність («ID постачальника» + «Артикул»; без артикула — назви / URL постачальника): перейменування й
 *  дозволені правки власника (GTIN, «Виробник», «Код товару Prom», ENG-10) не перевидають коди й не скасовують повернення; зміна
 *  артикула — скасовує; CC4-N2 — вікно між останнім читанням і CAS (свіже читання перед комітом + автоматичне зняття після);
 *  CC4-Q1 / M96 — відбиток розрізняє два прив'язані наміри з тим самим Operation ID; скасована команда не виконується повторно;
 *  регрес контрольної точки — захисні рядки діють, послаблювальні ні; C — M3 CORRUPT блокує повернення в продаж лише цієї картки.
 *  Тести викликають лише API, наявне в R4 (runControls, controlsState), тому запускаються й на замороженому R4. */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { SEAL_COLUMN, rowSeal } from "../src/core/seal.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { ACTION, CC_SHEET, SALE_DECISION, historySeal } from "../src/core/controls-common.mjs";
import { controlsState, verifyControlsSnapshot } from "../src/core/controls-plan.mjs";
import { CHECKPOINT_KEY, CONTROLS_SHEETS } from "../src/pipeline/controls-run.mjs";
import { ACTIVE_CONTRACT, prepared, setCells, codeOf, history, later, viewOf, rowOf } from "./helpers/controls.mjs";
import { HOLD, ID, ID2, RELEASE, apply, col, confirmR, cpOf, prompt, readinessDouble, stateOf } from "./helpers/controls-r3.mjs";

const releaseRows = (w, id = ID) => history(w).filter((x) => x[col("Дія")] === ACTION.RELEASE && x[col("Offer ID")] === id);
function reseal(w, id) {
  const v = w.book[SHEET.main], i = v.findIndex((x) => x[0] === id);
  v[i][v[0].indexOf(SEAL_COLUMN)] = rowSeal(rowOf(w, id));
}
/** HOLD підтверджено; RELEASE з кодом дійшов до журналу, коміт точки не вдався (UNCONFIRMED); команда лишається в клітинці. */
async function releaseUnconfirmed() {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  R.store.failCommit = true;
  const r = await apply(w, R, { stamp: later(2) });
  R.store.failCommit = false;
  assert.equal(r.state, "UNCONFIRMED", "передумова: " + JSON.stringify(r));
  assert.equal(releaseRows(w).length, 1, "передумова: рядок RELEASE є");
  return { w, R };
}

// ---------------------------------------------------------------- CC4-N1 — фізична ідентичність
test("R5-N1: зміна «Артикулу постачальника» (фізична ідентичність) — старий RELEASE не легалізується, навіть якщо команда з кодом лишилась", async () => {
  const { w, R } = await releaseUnconfirmed();
  setCells(w, ID, { "Артикул постачальника": "R5-OTHER-PHYSICAL" }); reseal(w, ID);
  await apply(w, R, { stamp: later(3) });
  assert.ok(stateOf(w, R).held.has(ID), "інший фізичний товар — повернення не підтверджується");
  assert.equal(cpOf(R).aborted.length, 1, "намір скасовано, а не лишено висіти");
});

test("R5-N1 (ENG-10): дозволені правки власника — GTIN, «Виробник», «Код товару Prom», «Назва UA» — не є фізичною ідентичністю: непідтверджений RELEASE підтверджується, глобальної зупинки немає", async () => {
  const { w, R } = await releaseUnconfirmed();
  setCells(w, ID, { "GTIN": "5901234123457", "Виробник": "Власник змінив", "Код товару Prom": "OWNER-CODE-1", "Назва UA": "Власна назва" });
  const r = await apply(w, R, { stamp: later(3) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  const s = stateOf(w, R);
  assert.equal(s.blocked, false);
  assert.ok(!s.held.has(ID), "рішення власника про повернення чинне");
});

test("R5-N1: перейменування постачальником (назви постачальника UA / RU) за наявності артикула не перевидає коди — команда з виданим кодом виконується", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  assert.ok(mtText(rowOf(w, ID)["Артикул постачальника"]), "передумова: артикул є");
  setCells(w, ID, { "Назва постачальника UA": "Перейменовано постачальником", "Назва постачальника RU": "Переименовано поставщиком" }); reseal(w, ID);
  const r = await apply(w, R, { stamp: later(2) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.equal(releaseRows(w).length, 1, "код не перевидано — повернення виконано");
  assert.ok(!stateOf(w, R).held.has(ID));
});

test("R5-C (M3): службове поле змінено поза sync (вердикт CORRUPT) — повернення в продаж не виконується лише для цієї картки; OWNER_EDIT — виконується", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await confirmR(w, R, ID2, HOLD, 0.2);
  for (const id of [ID, ID2]) setCells(w, id, { [SALE_DECISION]: RELEASE });
  await apply(w, R, { stamp: later(1) });
  for (const id of [ID, ID2]) setCells(w, id, { [SALE_DECISION]: `${RELEASE} ${codeOf(w, id, RELEASE)}` });
  const integrity = { cardVerdict: (row) => (mtText(row["Offer ID"]) === ID ? { verdict: "CORRUPT", reasons: ["«Модель» змінено поза sync"] } : { verdict: "OWNER_EDIT", reasons: [] }) };
  const r = await apply(w, R, { stamp: later(2), integrity });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  const s = stateOf(w, R);
  assert.ok(s.held.has(ID) && !s.held.has(ID2), "відмова лише пошкодженій картці");
  assert.match(viewOf(w, ID)["Попередження"], /картка пошкоджена \(CORRUPT: «Модель» змінено поза sync\)/);
});

// ---------------------------------------------------------------- CC4-N2 — вікно перед CAS
/** hookPut на записі точки, що підтверджує RELEASE (рядок уже в журналі): зміна книги між останнім читанням і CAS. */
function atCommit(w, R, mutate) {
  let fired = false;
  R.store.hookPut = async (k) => { if (k === CHECKPOINT_KEY && !fired && releaseRows(w).length) { fired = true; mutate(); } };
  return () => fired;
}

test("R5-N2: між останнім читанням і CAS змінено артикул і очищено команду — повернення не діє (автоматичне зняття після коміту), стан не blocked", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  const fired = atCommit(w, R, () => { setCells(w, ID, { [SALE_DECISION]: "", "Артикул постачальника": "R5-WINDOW-SKU" }); reseal(w, ID); });
  const r = await apply(w, R, { stamp: later(2) });
  assert.ok(fired(), "передумова: зміну внесено у вікні перед CAS");
  const s = stateOf(w, R);
  assert.ok(s.held.has(ID), "товар поза продажем: " + JSON.stringify(r));
  assert.equal(s.blocked, false);
  assert.ok(history(w).some((x) => x[col("Дія")] === ACTION.HOLD && x[col("Offer ID")] === ID && /автоматично/.test(x[col("Підстава")])), "автоматичне зняття записано в журнал");
});

test("R5-N2 (звірка): непідтверджене повернення попереднього запуску, артикул змінено між свіжим читанням і CAS звірки — автоматичне зняття, товар поза продажем", async () => {
  const { w, R } = await releaseUnconfirmed();
  const fired = atCommit(w, R, () => { setCells(w, ID, { "Артикул постачальника": "R5-RECOVERY-WINDOW" }); reseal(w, ID); });
  await apply(w, R, { stamp: later(3) });
  assert.ok(fired(), "передумова: зміну внесено у вікні перед CAS звірки");
  const s = stateOf(w, R);
  assert.ok(s.held.has(ID) && !s.blocked);
  assert.ok(history(w).some((x) => x[col("Дія")] === ACTION.HOLD && /автоматично/.test(x[col("Підстава")])));
});

test("R5-N2: команду знято одразу після перевірочного читання (до свіжого читання перед CAS) — повернення скасовується, не підтверджується", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  let fired = false;
  // Повне читання після дописування рядка RELEASE — перевірочне: повертає знімок ДО зміни, а жива книга змінюється одразу після.
  const readBook = async (names) => {
    const snap = structuredClone(w.book);
    if (!fired && names?.length === CONTROLS_SHEETS.length && releaseRows(w).length) { fired = true; setCells(w, ID, { [SALE_DECISION]: "" }); }
    return snap;
  };
  await apply(w, R, { stamp: later(2), readBook });
  assert.ok(fired, "передумова: команду знято між перевірочним і свіжим читанням");
  assert.ok(stateOf(w, R).held.has(ID), "відкликання, видиме у свіжому читанні перед CAS, скасовує повернення");
  assert.ok(cpOf(R).aborted.some((e) => e.offerId === ID && e.action === ACTION.RELEASE), "намір повернення скасовано");
});

test("R5-N2: зміна до свіжого читання (на записі намірів) — послаблення скасовується до CAS; новий код для повернення", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  const old = viewOf(w, ID)["Коди підтвердження"];
  let fired = false;
  R.store.hookPut = async (k, v) => { if (k === CHECKPOINT_KEY && !fired && v?.pending?.some?.((it) => it.action === ACTION.RELEASE) && !releaseRows(w).length) { fired = true; setCells(w, ID, { [SALE_DECISION]: "" }); } };
  await apply(w, R, { stamp: later(2) });
  assert.ok(fired, "передумова: команду знято після запису наміру");
  assert.ok(stateOf(w, R).held.has(ID));
  await apply(w, R, { stamp: later(3) });
  assert.notEqual(viewOf(w, ID)["Коди підтвердження"], old, "після скасованого повернення — новий одноразовий код");
});

// ---------------------------------------------------------------- CC4-Q1 / M96
test("R5-Q1 (M96): два валідно прив'язані наміри з тим самим Operation ID, але різною підставою / печаткою — відбиток різний, verifyControlsSnapshot відхиляє", async () => {
  const w = await prepared(); const R = readinessDouble();
  await prompt(w, R, ID, HOLD);
  R.store.failCommit = true;
  await apply(w, R, { stamp: later(1) });
  R.store.failCommit = false;
  const ctx = (cp) => ({ contract: ACTIVE_CONTRACT, checkpoint: cp });
  const cpA = structuredClone(cpOf(R));
  const fpA = controlsState(structuredClone(w.book), ctx(cpA)).fingerprint;
  // Другий стан: той самий op, інша «Підстава» — і в рядку журналу, і в довіреному намірі (печатки перераховано, прив'язка валідна).
  const book = structuredClone(w.book), cpB = structuredClone(cpA);
  const k = book[CC_SHEET.history].findIndex((x, i) => i && x[col("Дія")] === ACTION.HOLD);
  const row = book[CC_SHEET.history][k];
  row[col("Підстава")] = "інша підстава"; row[col("Печатка")] = historySeal(row);
  const it = (cpB.pending || []).find((e) => e.op === row[col("Operation ID")]);
  assert.ok(it, "передумова: намір у точці");
  it.row = row.slice(); it.seal = row[col("Печатка")];
  const sB = controlsState(structuredClone(book), ctx(cpB));
  assert.equal(sB.blocked, false, "передумова: другий стан валідний");
  assert.notEqual(sB.fingerprint, fpA);
  assert.equal(verifyControlsSnapshot(structuredClone(book), ctx(cpB), fpA).ok, false);
});

// ---------------------------------------------------------------- скасована команда, регрес точки
test("R5: скасоване повернення (команду знято до звірки) — повторно вписана стара команда зі старим кодом не виконується; новий код — виконується", async () => {
  const { w, R } = await releaseUnconfirmed();
  const oldCell = rowOf(w, ID)[SALE_DECISION];
  setCells(w, ID, { [SALE_DECISION]: "" });
  await apply(w, R, { stamp: later(3) });
  assert.ok(stateOf(w, R).held.has(ID));
  setCells(w, ID, { [SALE_DECISION]: oldCell });
  await apply(w, R, { stamp: later(4) });
  assert.ok(stateOf(w, R).held.has(ID), "стара скасована команда не діє");
  assert.match(viewOf(w, ID)["Попередження"], /код недійсний або застарів/);
  setCells(w, ID, { [SALE_DECISION]: `${RELEASE} ${codeOf(w, ID, RELEASE)}` });
  const r = await apply(w, R, { stamp: later(5) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.ok(!stateOf(w, R).held.has(ID));
});

test("R5: регрес контрольної точки (відновлено старий бекап) — рядок HOLD без прив'язки діє (fail-closed), рядок RELEASE без прив'язки не діє; глобальної зупинки немає, інші товари не зачеплено", async () => {
  const w = await prepared(); const R = readinessDouble();
  const cp0 = structuredClone(cpOf(R) ?? null);
  await confirmR(w, R, ID, HOLD);
  const cpHold = structuredClone(cpOf(R));
  await confirmR(w, R, ID, RELEASE, 1);
  await confirmR(w, R, ID2, HOLD, 2);
  assert.ok(!stateOf(w, R).held.has(ID) && stateOf(w, R).held.has(ID2), "передумова");
  // бекап до RELEASE: RELEASE ID і HOLD ID2 — рядки без прив'язки
  const s1 = controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: cpHold });
  assert.equal(s1.blocked, false);
  assert.ok(s1.held.has(ID), "послаблювальний рядок без прив'язки не відкриває продаж");
  assert.ok(s1.held.has(ID2), "захисний рядок без прив'язки діє");
  assert.ok(!s1.held.has("1500000021"), "інші товари не зачеплено");
  if (cp0) assert.equal(controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: cp0 }).blocked, false);
});
