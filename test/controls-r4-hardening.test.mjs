/** Catalog Controls R4 — додаткові перевірки протоколу R4 (довірені наміри, звірка, НЕВИЗНАЧЕНО, fencing, межа запису) за
 *  переліком власника: пошкоджений журнал, незавершена операція, частковий збій контрольної точки, запізнілі записи старої оренди,
 *  одночасні запуски, повтори API, помилкове RELEASE, відновлення після переривання. Як RED на R3 не заявляються (частина
 *  використовує API R4). Усе — синтетика в пам'яті й фейковий транспорт. */
import test from "node:test";
import assert from "node:assert/strict";
import { ACTION, CC_SHEET, SALE_DECISION, historySeal } from "../src/core/controls-common.mjs";
import { controlsState } from "../src/core/controls-plan.mjs";
import { CHECKPOINT_KEY, LEASE_SCOPE, checkReadiness } from "../src/pipeline/controls-run.mjs";
import { ACTIVE_CONTRACT, prepared, setCells, codeOf, history, later, viewOf } from "./helpers/controls.mjs";
import { HOLD, ID, ID2, RELEASE, apply, col, confirmR, cpOf, fakeSheetsApi, prompt, readinessDouble, shadow, stateOf, writes } from "./helpers/controls-r3.mjs";

const DEL = (id) => `ВИДАЛИТИ ТОВАР ${id}`, BACK = (id) => `ПОВЕРНУТИ З АРХІВУ ${id}`;
const rowsOf = (w, action, id) => history(w).filter((x) => x[col("Дія")] === action && (!id || x[col("Offer ID")] === id));
const failingAppend = (w, pred) => ({ ...w.sheets, appendRows: async (title, rows) => { if (pred(title, rows)) throw new Error("імітовано: append не виконано"); return w.sheets.appendRows(title, rows); } });

test("R4: межа запису на рівні HTTP — увесь цикл (зняти, повернути, зняти, виключити, повернути в каталог) через справжній GoogleSheetsWriter торкається лише трьох службових аркушів, без deleteDimension", async () => {
  const w = await prepared(); const R = readinessDouble();
  const api = fakeSheetsApi(w.book);
  const step = async (words, h) => {
    setCells(w, ID, { [SALE_DECISION]: words });
    await apply(w, R, { stamp: later(h), sheets: api.writer() });
    setCells(w, ID, { [SALE_DECISION]: `${words} ${codeOf(w, ID, words)}` });
    const r = await apply(w, R, { stamp: later(h + 0.5), sheets: api.writer() });
    assert.equal(r.state, "COMMITTED", words + ": " + JSON.stringify(r));
  };
  await step(HOLD, 0); await step(RELEASE, 1); await step(HOLD, 2); await step(DEL(ID), 3); await step(BACK(ID), 4);
  const own = new Set(Object.values(CC_SHEET));
  assert.deepEqual(api.touched().filter((t) => !own.has(t)), [], "запити лише до службових аркушів");
  assert.ok(!api.requests.some((r) => r.ops.includes("deleteDimension")), "жодного видалення рядків");
  assert.ok(stateOf(w, R).held.has(ID), "після скасування виключення товар лишається знятим");
});

test("R4: відновлення після переривання — намір записано, append події не виконано: захисна дія діє (PENDING), наступний запуск дописує з наміру й підтверджує", async () => {
  const w = await prepared(); const R = readinessDouble();
  await prompt(w, R, ID, HOLD);
  const r = await apply(w, R, { stamp: later(1), sheets: failingAppend(w, (t) => t === CC_SHEET.history) });
  assert.equal(r.state, "PENDING", JSON.stringify(r));
  assert.equal(rowsOf(w, ACTION.HOLD, ID).length, 0, "рядка ще немає");
  assert.ok(stateOf(w, R).held.has(ID), "зняття діє з довіреного наміру");
  assert.match(viewOf(w, ID)["Актуальність"], /ОЧІКУЄ ЗВІРКИ/);
  setCells(w, ID, { [SALE_DECISION]: "" }); // власник очистив клітинку — захисне довиконання від команди не залежить
  const r2 = await apply(w, R, { stamp: later(2) });
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2));
  assert.equal(rowsOf(w, ACTION.HOLD, ID).length, 1, "дописано рівно один раз");
  assert.equal(cpOf(R).pending.length, 0);
  assert.match(viewOf(w, ID)["Актуальність"], /ПІДТВЕРДЖЕНО/);
});

test("R4: помилкове / неавторизоване RELEASE — append не підтверджено: повернення скасовано, товар поза продажем; старий код більше не діє, новий код — повертає", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  const old = codeOf(w, ID, RELEASE);
  const r = await apply(w, R, { stamp: later(2), sheets: failingAppend(w, (t, rows) => t === CC_SHEET.history && rows.some((x) => x[col("Дія")] === ACTION.RELEASE)) });
  assert.equal(r.state, "PENDING", JSON.stringify(r));
  assert.ok(stateOf(w, R).held.has(ID));
  assert.equal(cpOf(R).aborted.length, 1, "послаблення скасовано, а не лишено висіти");
  const v = viewOf(w, ID);
  assert.match(v["Попередження"], /скасовано під час звірки/);
  const again = await apply(w, R, { stamp: later(3) }); // у клітинці лишилась стара команда
  assert.ok(stateOf(w, R).held.has(ID), "старий код не відкриває продаж: " + JSON.stringify(again.state));
  // R7: стара команда з вичерпаним кодом → відмова й нова видача (код ніколи не повторює попередніх).
  const fresh = codeOf(w, ID, RELEASE);
  assert.notEqual(fresh, old, "після скасування — новий код");
  setCells(w, ID, { [SALE_DECISION]: `${RELEASE} ${fresh}` });
  assert.equal((await apply(w, R, { stamp: later(4) })).state, "COMMITTED");
  assert.ok(!stateOf(w, R).held.has(ID), "нове рішення власника — повернуто");
});

test("R4: скасований намір із запізнілим рядком — рядок не діє (ні в згортці, ні в кодах); вигляд пропонує новий код повернення, ним — повернуто", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  const late = [];
  const sheets = { ...w.sheets, appendRows: async (title, rows) => {
    if (title === CC_SHEET.history && rows.some((r) => r[col("Дія")] === ACTION.RELEASE)) { late.push(structuredClone(rows)); throw new Error("імітовано: відповідь втрачено"); }
    return w.sheets.appendRows(title, rows);
  } };
  assert.equal((await apply(w, R, { stamp: later(2), sheets })).state, "PENDING");
  for (const rows of late) await w.mem.appendRows(CC_SHEET.history, rows); // запізнілий рядок скасованого наміру
  setCells(w, ID, { [SALE_DECISION]: "" });
  await apply(w, R, { stamp: later(3) });
  assert.ok(stateOf(w, R).held.has(ID), "скасований намір не відкриває продаж");
  setCells(w, ID, { [SALE_DECISION]: RELEASE }); // R7: новий код — на запит
  await apply(w, R, { stamp: later(3.5) });
  const code = codeOf(w, ID, RELEASE); // товар лишається знятим — видано новий код повернення
  setCells(w, ID, { [SALE_DECISION]: `${RELEASE} ${code}` });
  assert.equal((await apply(w, R, { stamp: later(4) })).state, "COMMITTED");
  assert.ok(!stateOf(w, R).held.has(ID), "нове рішення власника — повернуто");
});

test("R4: оренду втрачено одразу після запису намірів — жодного запису в аркуші після втрати (навіть заголовка журналу); UNKNOWN", async () => {
  const w = await prepared(); const R = readinessDouble();
  await prompt(w, R, ID, HOLD);
  let lost = false;
  const acquire = R.committer.acquire.bind(R.committer);
  R.committer.acquire = async (scope) => { const l = await acquire(scope); if (scope !== LEASE_SCOPE) return l; return { ...l, async assertCurrent() { if (lost) throw new Error("STALE: оренду перехоплено"); return l.assertCurrent(); } }; };
  const get = R.store.getJsonVersioned.bind(R.store);
  R.store.getJsonVersioned = async (k) => { const g = await get(k); if (k === CHECKPOINT_KEY && g.value?.pending?.length) lost = true; return g; };
  assert.equal(w.book[CC_SHEET.history], undefined, "передумова: журналу ще немає");
  const r = await apply(w, R, { stamp: later(1) });
  assert.equal(r.state, "UNKNOWN", JSON.stringify(r));
  assert.equal(w.book[CC_SHEET.history], undefined, "після втрати оренди аркуш журналу не створено");
  assert.ok(stateOf(w, R).held.has(ID), "захисний намір уже в точці — діє");
});

test("R4: до активації (оцінка) незавершене видалення — намір у точці, події в журналі немає — та сама команда планує завершення (R5: знімків «Виключені назавжди» немає; R7.2: з кодом оцінки)", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, DEL(ID), 1);
  assert.equal((await apply(w, R, { stamp: later(2), sheets: failingAppend(w, (t) => t === CC_SHEET.history) })).state, "PENDING");
  assert.equal(history(w).filter((x) => x[col("Дія")] === ACTION.TOMBSTONE).length, 0, "передумова: події видалення в журналі немає");
  assert.ok(cpOf(R).pending.some((it) => it.action === ACTION.TOMBSTONE && it.offerId === ID), "передумова: намір видалення в точці");
  const sh = await shadow(w, { contract: { ...ACTIVE_CONTRACT, activated: false } });
  assert.equal(sh.state, "SHADOW", JSON.stringify(sh));
  // R7.2 (C71-01): код, виданий під орендою (прив'язаний до її епохи), оцінка без контрольної точки й оренди не визнає — нічого
  // не планує; та сама команда з кодом оцінки (показаним у «Стані керування» оцінки) планує завершення.
  assert.equal(sh.planned.events, 0, "код, виданий під орендою, оцінка без точки не визнає");
  const evalCode = new RegExp(`${DEL(ID)} ([0-9A-F]{6})`).exec(sh.view.find((r) => r[0] === ID)?.[5] || "")?.[1];
  assert.ok(evalCode, "оцінка показує власний розрахунковий код");
  setCells(w, ID, { [SALE_DECISION]: `${DEL(ID)} ${evalCode}` });
  const sh2 = await shadow(w, { contract: { ...ACTIVE_CONTRACT, activated: false } });
  assert.ok(sh2.planned.events >= 1, "команда з кодом оцінки завершує незавершене виключення");
});

test("R4: частковий збій контрольної точки — запис намірів не вдався: нічого не дописано, вигляд НЕВИЗНАЧЕНО; наступний запуск звіряє й виконує команду", async () => {
  const w = await prepared(); const R = readinessDouble();
  await prompt(w, R, ID, HOLD);
  R.store.failAllPuts = true;
  const r = await apply(w, R, { stamp: later(1) });
  R.store.failAllPuts = false;
  assert.equal(r.state, "UNKNOWN", JSON.stringify(r));
  assert.equal(history(w).length, 0, "без наміру в точці — жодного рядка в журналі");
  assert.match(viewOf(w, ID)["Продаж"], /НЕВИЗНАЧЕНО/);
  assert.equal((await apply(w, R, { stamp: later(2) })).state, "COMMITTED");
  assert.ok(stateOf(w, R).held.has(ID));
  assert.match(viewOf(w, ID)["Актуальність"], /ПІДТВЕРДЖЕНО/);
});

test("R4: точку підтверджено, а остаточний вигляд записати не вдалося — лишається НЕВИЗНАЧЕНО (не старий стан); наступний запуск показує підтверджене", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  let n = 0;
  const sheets = { ...w.sheets, updateRanges: async (list) => { if (list.some((b) => b.title === CC_SHEET.state) && ++n === 2) throw new Error("імітовано: запис вигляду не вдався"); return w.sheets.updateRanges(list); } };
  const r = await apply(w, R, { stamp: later(2), sheets });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.match(r.view, /^FAILED/);
  assert.match(viewOf(w, ID)["Продаж"], /НЕВИЗНАЧЕНО/, "не «ЗНЯТО З ПРОДАЖУ» як поточне");
  await apply(w, R, { stamp: later(3) });
  assert.match(viewOf(w, ID)["Продаж"], /^У ПРОДАЖУ/);
  assert.match(viewOf(w, ID)["Актуальність"], /ПІДТВЕРДЖЕНО/);
});

test("R4: після UNKNOWN (точку записано, читання назад не вдалося) наступний apply звіряє фактичну точку й показує правдивий стан", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  const n0 = cpOf(R).ops.length;
  let failNext = false;
  const get = R.store.getJsonVersioned.bind(R.store);
  R.store.afterPut = (k, v) => { if (k === CHECKPOINT_KEY && (v?.ops?.length || 0) > n0) { R.store.afterPut = null; failNext = true; } };
  R.store.getJsonVersioned = async (k) => { if (k === CHECKPOINT_KEY && failNext) { failNext = false; throw new Error("імітовано: читання не вдалося"); } return get(k); };
  assert.equal((await apply(w, R, { stamp: later(2) })).state, "UNKNOWN");
  const r = await apply(w, R, { stamp: later(3) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.ok(!stateOf(w, R).held.has(ID));
  assert.match(viewOf(w, ID)["Продаж"], /^У ПРОДАЖУ/);
  assert.match(viewOf(w, ID)["Актуальність"], /ПІДТВЕРДЖЕНО/);
});

test("R4: одночасні запуски — лише один записувач; другий отримує BUSY / NOT_READY без записів; подія одна", async () => {
  const w = await prepared(); const R = readinessDouble();
  await prompt(w, R, ID, HOLD);
  const [a, b] = await Promise.all([apply(w, R, { stamp: later(1) }), apply(w, R, { stamp: later(1) })]);
  const states = [a.state, b.state].sort();
  assert.equal(states.filter((s) => s === "COMMITTED").length, 1, JSON.stringify(states));
  assert.ok(states.every((s) => ["COMMITTED", "BUSY", "NOT_READY"].includes(s)), JSON.stringify(states));
  assert.equal(rowsOf(w, ACTION.HOLD, ID).length, 1);
});

test("R4: запізнілий запис старої оренди — наступник виконав повний apply, старий записувач відновився: fencing відхиляє його точку, стан наступника цілий", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  let first = null;
  const acquire = R.committer.acquire.bind(R.committer);
  R.committer.acquire = async (scope) => { const l = await acquire(scope); if (scope === LEASE_SCOPE && !first) first = l; return l; };
  let arrived, resume; const reached = new Promise((r) => (arrived = r)), gate = new Promise((r) => (resume = r));
  let once = false;
  R.store.hookPut = async (k) => { if (k === CHECKPOINT_KEY && !once) { once = true; arrived(); await gate; } };
  const running = apply(w, R, { stamp: later(2) });
  assert.equal(await Promise.race([reached.then(() => true), running.then(() => false)]), true);
  await first.release(); // стара оренда спливла
  const succ = await apply(w, R, { stamp: later(3) });
  assert.equal(succ.state, "COMMITTED", JSON.stringify(succ));
  const cp = structuredClone(cpOf(R));
  resume();
  const late = await running;
  assert.notEqual(late.state, "COMMITTED", JSON.stringify(late.state));
  assert.deepEqual(cpOf(R), cp, "точку наступника не перезаписано");
  assert.equal(rowsOf(w, ACTION.RELEASE, ID).length, 1, "без дубля події");
});

test("R4: готовність — сховище без fencing → NOT_READY без записів в аркуші й точку; невдалий publisher → у сховище нічого не записано (H10)", async () => {
  {
    const w = await prepared(); const R = readinessDouble({ fencing: false });
    setCells(w, ID, { [SALE_DECISION]: HOLD });
    const r = await apply(w, R);
    assert.equal(r.state, "NOT_READY");
    assert.match(r.reasons.join("; "), /fencing/);
    assert.equal(writes(w).length, 0);
    assert.equal(cpOf(R), null);
  }
  {
    const w = await prepared(); const R = readinessDouble({ publisherOk: false });
    assert.equal((await apply(w, R)).state, "NOT_READY");
    assert.equal(R.store.writes, 0, "службовий ключ перевірки теж не записано");
    assert.equal(writes(w).length, 0);
  }
  assert.equal((await checkReadiness(readinessDouble())).ok, true, "коректний двійник проходить (це не доказ справжнього S6 / W2)");
});

test("R4: shadow за непідтвердженого послаблення — ОЧІКУЄ ЗВІРКИ, команда товару не планується (WAIT), продаж не показано як відкритий", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  R.store.failCommit = true;
  assert.equal((await apply(w, R, { stamp: later(2) })).state, "UNCONFIRMED");
  R.store.failCommit = false;
  const sh = await shadow(w, { store: R.store });
  const row = sh.view.find((x) => x[0] === ID);
  assert.match(row[8], /ОЧІКУЄ ЗВІРКИ/);
  assert.doesNotMatch(row[2], /У ПРОДАЖУ/);
  assert.equal(sh.planned.events, 0);
});

test("R4: відбиток після активації не залежить від порядку рядків журналу, але змінюється від будь-якої зміни вмісту", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await confirmR(w, R, ID2, HOLD, 1);
  const ctx = { contract: ACTIVE_CONTRACT, checkpoint: cpOf(R) };
  const base = controlsState(structuredClone(w.book), ctx).fingerprint;
  const sorted = structuredClone(w.book); sorted[CC_SHEET.history] = [sorted[CC_SHEET.history][0], ...sorted[CC_SHEET.history].slice(1).reverse()];
  assert.equal(controlsState(sorted, ctx).fingerprint, base);
  const edited = structuredClone(w.book); const r = edited[CC_SHEET.history][1]; r[col("Підстава")] = "інакше"; r[col("Печатка")] = historySeal(r);
  assert.notEqual(controlsState(edited, ctx).fingerprint, base);
});
