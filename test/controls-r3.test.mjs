/** Catalog Controls R3 — регресійні тести дефектів другого BLOCK Hermes (independent-20261029T024530):
 *  C1 підміна Offer ID пошкодженого рядка; C2 bootstrap після shadow; C3 збій запису контрольної точки; C4 відбиток без blocked;
 *  C5 публічний шлях запису; бар'єр готовності S6 / W2 (п. 9); shadow не створює враження застосування (п. 10); A7 конкурентна
 *  контрольна точка; зміна стану між перевіркою й застосуванням. Тести викликають runControls напряму, тому виконуються і на R2
 *  (мають бути RED), і на R3 (GREEN). Усе — синтетика в пам'яті. Двійники — test/helpers/controls-r3.mjs. */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { ACTION, CC_SHEET, HISTORY_HEADERS, SALE_DECISION, historySeal } from "../src/core/controls-common.mjs";
import { controlsState } from "../src/core/controls-plan.mjs";
import * as runModule from "../src/pipeline/controls-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { ACTIVE_CONTRACT, prepared, setCells, codeOf, history, later } from "./helpers/controls.mjs";
import { CasStore, HOLD, ID, ID2, PROTECTION, RELEASE, apply, col, confirmR, cpOf, readinessDouble, shadow, stateOf, writes } from "./helpers/controls-r3.mjs";

const { runControls, CHECKPOINT_KEY } = runModule;

test("R3-C1: підміна Offer ID у пошкодженому рядку журналу (без перерахунку печатки) не знімає HOLD з оригінального товару", async () => {
  const w = await prepared(); const R = readinessDouble();
  const r = await confirmR(w, R, ID, HOLD);
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.ok(stateOf(w, R).held.has(ID));
  const k = w.book[CC_SHEET.history].findIndex((x, i) => i && x[col("Offer ID")] === ID && x[col("Дія")] === ACTION.HOLD);
  w.book[CC_SHEET.history][k][col("Offer ID")] = ID2;
  const s = stateOf(w, R);
  assert.ok(s.held.has(ID) || s.blocked, "оригінал лишається поза продажем або стан blocked");
  assert.ok(s.damaged.has(ID), "пошкодження прив'язано до товару з контрольної точки");
});

test("R3-C1: підміна Offer ID із ПЕРЕРАХОВАНОЮ печаткою — контрольна точка (печатка операції) виявляє підміну; оригінал поза продажем", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  const k = w.book[CC_SHEET.history].findIndex((x, i) => i && x[col("Offer ID")] === ID && x[col("Дія")] === ACTION.HOLD);
  const row = w.book[CC_SHEET.history][k];
  row[col("Offer ID")] = ID2; row[col("Печатка")] = historySeal(row);
  const s = stateOf(w, R);
  assert.ok(s.held.has(ID) || s.blocked);
  assert.ok(s.damaged.has(ID));
});

test("R3-C1: пошкоджений непідтверджений рядок — товар із довіреного наміру поза продажем; R5-D: рядок без жодної прив'язки — зачеплений товар ізольовано (поза продажем), без загальної зупинки", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  await apply(w, R);
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
  R.store.failCommit = true;
  await apply(w, R, { stamp: later(1) }); // подія записана, контрольна точка — ні
  R.store.failCommit = false;
  const k = w.book[CC_SHEET.history].findIndex((x, i) => i && x[col("Дія")] === ACTION.HOLD);
  w.book[CC_SHEET.history][k][col("Offer ID")] = ID2;
  const s = stateOf(w, R);
  assert.ok(s.blocked || s.held.has(ID), "fail-closed");
  // R4: рядок має довірений намір у точці (записаний ДО рядка) — пошкоджено товар із наміру, а не з рядка.
  assert.ok(s.damaged.has(ID) && s.held.has(ID) && !s.held.has(ID2), "пошкоджено товар із довіреного наміру");
  const forged = w.book[CC_SHEET.history][k].slice(); forged[col("Operation ID")] = "op-unbound00000000000000000"; w.book[CC_SHEET.history].push(forged);
  const s2 = stateOf(w, R);
  // R4 → R5 (рішення D): замість глобального blocked — ізоляція товару з рядка; продаж не відкривається, решта каталогу працює.
  assert.equal(s2.blocked, false, "без загальної зупинки");
  assert.ok(s2.held.has(ID2) && s2.damaged.has(ID2), "товар із рядка без прив'язки — поза продажем");
  assert.ok(s2.held.has(ID), "оригінал лишається поза продажем");
});

test("R3-C2: shadow на порожньому сховищі — нічого не пише й кодів не видає; перший apply ініціалізує точку (до першої події) і видає код; apply з кодом — COMMITTED з підтвердженою початковою точкою; перезапуск не застрягає", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  const sh = await shadow(w, { store: R.store });
  assert.equal(sh.state, "SHADOW", JSON.stringify(sh));
  assert.equal(cpOf(R), null, "shadow не пише в сховище");
  // R7 (F2): код — лише виданий і збережений у точці; SHADOW нічого не видає.
  assert.equal(new RegExp(`${HOLD} ([0-9A-F]{6})`).exec(sh.view.find((r) => r[0] === ID)[5]), null, "SHADOW не показує коду як дійсного");
  const init = await apply(w, R, { stamp: later(0.5) });
  assert.equal(init.state, "COMMITTED", JSON.stringify(init));
  assert.ok(cpOf(R)?.issued?.length === 1 && history(w).length === 0, "точку ініціалізовано, код видано, подій ще немає");
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
  const first = await apply(w, R, { stamp: later(1) });
  assert.equal(first.state, "COMMITTED", JSON.stringify(first));
  assert.equal(first.blocked, false);
  const cp = cpOf(R);
  assert.ok(cp && cp.ops.some((e) => (e.op || e) === history(w)[0][col("Operation ID")]), "операцію підтверджено в точці");
  const again = await apply(w, R, { stamp: later(2) });
  assert.equal(again.state, "COMMITTED", JSON.stringify(again));
  assert.ok(again.held.has(ID));
});

test("R3-C3: запис контрольної точки не вдався — результат НЕ COMMITTED; наступний запуск довиконує точку; після підтвердження обрізання виявляється (R5-D: товар ізольовано, рядок дописується з точки)", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  await apply(w, R);
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
  R.store.failCommit = true;
  const r = await apply(w, R, { stamp: later(1) });
  assert.notEqual(r.state, "COMMITTED", JSON.stringify(r));
  assert.ok(r.held.has(ID), "захисна операція діє одразу");
  R.store.failCommit = false;
  const r2 = await apply(w, R, { stamp: later(2) });
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2));
  const op = history(w).find((x) => x[col("Дія")] === ACTION.HOLD)[col("Operation ID")];
  assert.ok(cpOf(R).ops.some((e) => (e.op || e) === op), "довиконано");
  w.book[CC_SHEET.history] = w.book[CC_SHEET.history].filter((x, i) => !i || x[col("Operation ID")] !== op);
  // R4 → R5 (рішення D): обрізання виявляється як ізоляція товару (поза продажем), а не глобальний blocked; довірений запис — у точці.
  const s = stateOf(w, R);
  assert.equal(s.blocked, false);
  assert.ok(s.damaged.has(ID) && s.held.has(ID), "після підтвердження обрізання виявлено — товар поза продажем");
  const r3 = await apply(w, R, { stamp: later(3) });
  assert.equal(r3.state, "COMMITTED", JSON.stringify(r3));
  assert.equal(history(w).filter((x) => x[col("Operation ID")] === op).length, 1, "рядок дописано з точки (repair)");
  const s3 = stateOf(w, R);
  assert.ok(!s3.damaged.has(ID) && s3.held.has(ID), "після дописування — ізоляцію знято, HOLD діє");
});

test("R3-C3: послаблювальна операція (ПОВЕРНУТИ В ПРОДАЖ) без підтвердженої контрольної точки не діє — товар лишається поза продажем", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  setCells(w, ID, { [SALE_DECISION]: RELEASE });
  await apply(w, R, { stamp: later(2) });
  setCells(w, ID, { [SALE_DECISION]: `${RELEASE} ${codeOf(w, ID, RELEASE)}` });
  R.store.failCommit = true;
  const r = await apply(w, R, { stamp: later(3) });
  assert.notEqual(r.state, "COMMITTED");
  assert.equal(history(w).filter((x) => x[col("Дія")] === ACTION.RELEASE).length, 1, "подію повернення записано — перевіряється саме непідтверджена точка");
  assert.ok(stateOf(w, R).held.has(ID), "непідтверджене повернення не відкриває продаж");
  R.store.failCommit = false;
  const r2 = await apply(w, R, { stamp: later(4) });
  assert.equal(r2.state, "COMMITTED");
  assert.ok(!stateOf(w, R).held.has(ID), "після підтвердження — повернуто");
});

test("R3-C4: зміна blocked змінює відбиток; verifyControlsSnapshot відхиляє зміну й blocked перед публікацією (R5-D: blocked — недійсна точка; зламаний заголовок журналу — зміна стану)", async () => {
  const w = await prepared(); const R = readinessDouble();
  // Журнал без подій — held / tombstoned порожні до й після; змінюється blocked (точка застарілого формату).
  w.book[CC_SHEET.history] = [HISTORY_HEADERS.slice()];
  const empty = { v: 4, at: later(0), ops: [], pending: [], aborted: [] };
  const before = controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: empty });
  const after0 = controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: { ...empty, v: 3 } });
  assert.equal(before.blocked, false);
  assert.equal(after0.blocked, true);
  assert.deepEqual([[...before.held], [...after0.held]], [[], []]);
  assert.notEqual(after0.fingerprint, before.fingerprint, "blocked входить у відбиток");
  // Перевірка перед публікацією на справжньому стані з подіями
  await confirmR(w, R, ID, HOLD);
  const snap = stateOf(w, R);
  const broken = structuredClone(w.book);
  broken[CC_SHEET.history][0][col("Дія")] = "Дія перейменована";
  const { verifyControlsSnapshot } = await import("../src/core/controls-plan.mjs");
  assert.equal(typeof verifyControlsSnapshot, "function");
  const ctx = { contract: ACTIVE_CONTRACT, checkpoint: cpOf(R) };
  assert.equal(verifyControlsSnapshot(structuredClone(w.book), ctx, snap.fingerprint).ok, true);
  assert.equal(verifyControlsSnapshot(broken, ctx, snap.fingerprint).ok, false, "зламаний журнал — стан змінився");
  const badCtx = { contract: ACTIVE_CONTRACT, checkpoint: { ...cpOf(R), v: 3 } };
  const after = controlsState(structuredClone(w.book), badCtx);
  assert.equal(after.blocked, true);
  assert.equal(verifyControlsSnapshot(structuredClone(w.book), badCtx, after.fingerprint).ok, false, "blocked відхиляється навіть з «правильним» відбитком");
});

test("R3-C5: публічний API не дозволяє запис у «Основний каталог»: write-хелпери не експортуються; guardWriter відхиляє main / deleteRows / чужі аркуші", async () => {
  const exported = Object.keys(runModule).sort();
  for (const name of ["appendMissing", "ensureOwnSheet", "writeView", "once"]) assert.ok(!exported.includes(name), `експорт ${name}`);
  assert.equal(typeof runModule.guardWriter, "function");
  const w = await prepared();
  const g = runModule.guardWriter(new MemorySheets(w.book));
  const n = w.book[SHEET.main].length;
  await assert.rejects(() => g.appendRows(SHEET.main, [["x"]]), /заборонено/);
  await assert.rejects(() => g.updateRanges([{ title: SHEET.main, row: 2, col: 1, values: [["x"]] }]), /заборонено/);
  await assert.rejects(() => g.deleteRows(CC_SHEET.history, [2]), /заборонено/);
  await assert.rejects(() => g.ensureSheet(SHEET.passport, ["x"]), /заборонено/);
  assert.equal(w.book[SHEET.main].length, n, "каталог без змін");
  await g.ensureSheet(CC_SHEET.state, ["Offer ID"]);
  assert.deepEqual(w.book[CC_SHEET.state], [["Offer ID"]], "службовий аркуш — дозволено");
});

test("R3-п.9: apply без підтвердженої готовності S6 / W2 — NOT_READY ДО будь-яких записів (activated=true недостатньо)", async () => {
  const w = await prepared();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  const store = new CasStore();
  const r = await runControls({ sheets: w.sheets, readBook: w.readBook, stamp: later(0), contract: ACTIVE_CONTRACT, protection: PROTECTION, store, mode: "apply" });
  assert.equal(r.state, "NOT_READY", JSON.stringify(r));
  assert.equal(writes(w).length, 0);
  assert.equal(store.writes, 0);
});

test("R3-п.9: невдалі перевірки готовності — publisher не застосовує стан (available=true), не відхиляє blocked; оренда не виключна; не виявляє застарілу оренду; сховище без CAS (або з CAS-методами без перевірки версії); publisher, що знімає все, — NOT_READY, 0 записів", async () => {
  const cases = [
    ["publisher available=true", readinessDouble({ publisherOk: false })],
    ["publisher не відхиляє blocked", readinessDouble({ refusesBlocked: false })],
    ["оренда не виключна", readinessDouble({ exclusive: false })],
    ["застаріла оренда не виявляється", readinessDouble({ staleDetect: false })],
    ["сховище без CAS", (() => { const R = readinessDouble(); R.store = { getJson: R.store.getJson.bind(R.store), putJson: R.store.putJson.bind(R.store) }; return R; })()],
    ["сховище з методами CAS, але без перевірки версії", readinessDouble({ casStrict: false })],
    ["сховище повідомляє конфлікт версії без винятку", readinessDouble({ conflictByReturn: true })],
    ["publisher знімає все (не справжнє формування)", readinessDouble({ publisherAllHeld: true })],
    ["немає publisher", (() => { const R = readinessDouble(); delete R.publisher; return R; })()],
  ];
  for (const [name, R] of cases) {
    const w = await prepared();
    setCells(w, ID, { [SALE_DECISION]: HOLD });
    const r = await apply(w, R);
    assert.equal(r.state, "NOT_READY", name + ": " + JSON.stringify(r));
    assert.equal(writes(w).length, 0, name);
  }
});

test("R3-п.10: shadow не створює враження застосування — явне попередження, «Стан керування» не записано, YML не змінюється", async () => {
  const w = await prepared();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  const sh = await shadow(w);
  assert.match(mtText(sh.notice), /нічого не застосовано/);
  assert.ok(sh.view.slice(1).every((r) => r[2].startsWith("SHADOW")), "кожен рядок вигляду позначено SHADOW");
  assert.equal(w.book[CC_SHEET.state], undefined);
  assert.equal(writes(w).length, 0);
});

test("R3-A7 / W2: другий записувач під час чинної оренди — відмова до записів; контрольна точка монотонна (пізній запис першого не відкочує точку)", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { [SALE_DECISION]: HOLD }); setCells(w, ID2, { [SALE_DECISION]: HOLD });
  await apply(w, R);
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
  setCells(w, ID2, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID2, HOLD)}` });
  let reached, release; const atPut = new Promise((r) => (reached = r)), gate = new Promise((r) => (release = r));
  let paused = false;
  R.store.hookPut = async (k) => { if (k === CHECKPOINT_KEY && !paused) { paused = true; reached(); await gate; } };
  const runA = apply(w, R, { stamp: later(1) });
  // Без зависання: якщо перший записувач завершився, не дійшовши до запису точки (напр. BUSY), — це провал тесту, а не очікування.
  const first = await Promise.race([atPut.then(() => "paused"), runA.then((x) => x)]);
  assert.equal(first, "paused", "перший записувач має дійти до запису контрольної точки: " + JSON.stringify(first));
  R.store.hookPut = null;
  const before = writes(w).length;
  const runB = await apply(w, R, { stamp: later(2) });
  assert.notEqual(runB.state, "COMMITTED", "другий записувач не пише паралельно: " + JSON.stringify(runB));
  assert.equal(writes(w).length, before, "0 записів від другого");
  release();
  const a = await runA;
  assert.equal(a.state, "COMMITTED", JSON.stringify(a));
  const n = cpOf(R).ops.length;
  const c = await apply(w, R, { stamp: later(3) });
  assert.equal(c.state, "COMMITTED");
  assert.ok(cpOf(R).ops.length >= n, "точка не регресує");
});

test("R3: зміна стану між перевіркою й застосуванням — оренду втрачено посеред запуску (assertCurrent) → подальших записів немає, результат UNKNOWN; контрольну точку змінено іншим (CAS) → не COMMITTED", async () => {
  {
    const w = await prepared(); const R = readinessDouble();
    setCells(w, ID, { [SALE_DECISION]: HOLD });
    await apply(w, R);
    setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
    const acquire = R.committer.acquire.bind(R.committer);
    R.committer.acquire = async (scope) => { const l = await acquire(scope); let n = 0; return { ...l, async assertCurrent() { if (++n > 1) throw new Error("STALE: оренду перехоплено"); } }; };
    const before = history(w).length;
    const r = await apply(w, R, { stamp: later(1) });
    assert.equal(r.state, "UNKNOWN", JSON.stringify(r));
    assert.equal(history(w).length, before, "після втрати оренди подію не дописано");
  }
  {
    const w = await prepared(); const R = readinessDouble();
    setCells(w, ID, { [SALE_DECISION]: HOLD });
    await apply(w, R);
    setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
    R.store.hookPut = async (k) => { if (k === CHECKPOINT_KEY) { R.store.hookPut = null; R.store.ver.set(k, (R.store.ver.get(k) || 0) + 7); } };
    const r = await apply(w, R, { stamp: later(1) });
    assert.notEqual(r.state, "COMMITTED", "CAS-конфлікт: " + JSON.stringify(r));
  }
});

test("R3: дубль операції з іншою датою (не байт-ідентичний повтор) — пошкодження товару (fail-closed), а не вибір першого рядка", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  const h = w.book[CC_SHEET.history];
  const dup = h.find((x, i) => i && x[col("Дія")] === ACTION.HOLD).slice();
  dup[col("Дата")] = later(9); dup[col("Печатка")] = historySeal(dup);
  h.push(dup);
  const s = controlsState(structuredClone(w.book), { contract: { ...ACTIVE_CONTRACT, activated: false } });
  assert.ok(s.damaged.has(ID) && s.held.has(ID));
});
