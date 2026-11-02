/** Catalog Controls R3 — тести механізмів R3, яких не покривали регресійні тести дефектів (виявлено мутаційною перевіркою);
 *  R5: знімки «Виключених назавжди» прибрано (архітектура «Видалені товари») — відповідні перевірки замінено перевірками дзеркала
 *  журналу проти самодостатньої контрольної точки v4 (ізоляція товару замість глобальної зупинки). Усе — синтетика в пам'яті. */
import test from "node:test";
import assert from "node:assert/strict";
import { ACTION, CC_SHEET, SALE_DECISION, SEO_DECISION, historyRow, historySeal } from "../src/core/controls-common.mjs";
import { controlsState, verifyControlsSnapshot } from "../src/core/controls-plan.mjs";
import { CHECKPOINT_KEY, LEASE_SCOPE } from "../src/pipeline/controls-run.mjs";
import { ACTIVE_CONTRACT, prepared, setCells, codeOf, history, later } from "./helpers/controls.mjs";
import { HOLD, ID, ID2, RELEASE, apply, col, confirmR, cpOf, readinessDouble, shadow, stateOf, writes } from "./helpers/controls-r3.mjs";

const SEO = { "SEO заголовок UA": "Дриль ALPHA AL-1000 — купити в Майстерні", "SEO заголовок RU": "Дрель ALPHA AL-1000 — купить в Мастерской", "SEO опис UA": "Дриль ALPHA AL-1000: гарантія, доставка по Україні.", "SEO опис RU": "Дрель ALPHA AL-1000: гарантия, доставка по Украине." };
const ctxOf = (R) => ({ contract: ACTIVE_CONTRACT, checkpoint: cpOf(R) });
const actions = (w, action, id) => history(w).filter((x) => x[col("Дія")] === action && (!id || x[col("Offer ID")] === id));

/** Запит → код → підтвердження, але запис контрольної точки на кроці підтвердження не вдається (операція непідтверджена). */
async function unconfirmed(w, R, id, words, hours = 0) {
  setCells(w, id, { [SALE_DECISION]: words });
  await apply(w, R, { stamp: later(hours) });
  setCells(w, id, { [SALE_DECISION]: `${words} ${codeOf(w, id, words)}` });
  R.store.failCommit = true;
  const r = await apply(w, R, { stamp: later(hours + 0.5) });
  R.store.failCommit = false;
  assert.equal(r.state, "UNCONFIRMED", JSON.stringify(r));
  return r;
}

test("Стан для споживачів (S6): після активації точки немає, а журнал має записи — blocked, а не «усе дозволено»", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  const s = controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: null });
  assert.equal(s.blocked, true);
  assert.match(s.reasons.join("; "), /контрольної точки немає, а журнал має записи/);
});

test("Контрольна точка застарілого формату (v1 / v2 / v3 R4) — blocked; apply — BLOCKED без записів (не «усе непідтверджене й довиконається»)", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  const ops = cpOf(R).ops.map((e) => e.op);
  for (const cp of [{ at: later(0), history: [], excluded: [] }, { at: later(0), history: ops, excluded: [] }, { v: 2, at: later(0), history: ops, excluded: [] }, { v: 3, at: later(0), history: [], excluded: [], pending: [], aborted: [] }, { v: 3, at: later(0), ops: cpOf(R).ops, pending: [], aborted: [] }]) {
    const s = controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: cp });
    assert.equal(s.blocked, true, JSON.stringify(cp));
    assert.match(s.reasons.join("; "), /застарілого формату/);
  }
  R.store.data.set(CHECKPOINT_KEY, { at: later(0), history: [], excluded: [] });
  const n = writes(w).length;
  const r = await apply(w, R, { stamp: later(2) });
  assert.equal(r.state, "BLOCKED", JSON.stringify(r));
  assert.equal(writes(w).length, n, "жодного запису");
});

test("R5-D: запис контрольної точки не самоузгоджений (Offer ID запису ≠ рядку; рядок у точці змінено без печатки) — точка недійсна, глобальна зупинка (довіреному джерелу без цілісності довіряти не можна)", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  const cp = cpOf(R);
  const a = structuredClone(cp); a.ops[0].offerId = ID2;
  const b = structuredClone(cp); b.ops[0].row[col("Підстава")] = "змінено в точці";
  for (const [name, c] of [["Offer ID запису", a], ["рядок без печатки", b]]) {
    const s = controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: c });
    assert.equal(s.blocked, true, name);
    assert.match(s.reasons.join(" "), /контрольна точка пошкоджена/, name);
  }
  assert.equal(controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: cp }).blocked, false, "контроль: справжня точка");
});

test("R5-D: рядок ПІДТВЕРДЖЕНОЇ операції змінено в журналі з перерахованою печаткою — товар із точки ізольовано (поза продажем), решта каталогу працює (не blocked)", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await confirmR(w, R, ID2, HOLD, 1);
  await confirmR(w, R, ID2, RELEASE, 2);
  const row = history(w).find((x) => x[col("Дія")] === ACTION.HOLD && x[col("Offer ID")] === ID);
  row[col("Підстава")] = "підміна підстави"; row[col("Печатка")] = historySeal(row);
  const s = stateOf(w, R);
  assert.equal(s.blocked, false, "проблема одного товару не зупиняє каталог");
  assert.ok(s.damaged.has(ID) && s.held.has(ID), "товар із точки ізольовано");
  assert.ok(!s.held.has(ID2), "інший товар у продажу");
  assert.match(s.issues.join(" | "), /не відповідає контрольній точці/);
});

test("R5-D: пошкоджений рядок журналу: з прив'язкою — ізольовано лише товар із точки (Offer ID рядка — попередження); без прив'язки — заявлений товар (поза продажем), глобальної зупинки немає", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  const row = history(w).find((x) => x[col("Дія")] === ACTION.HOLD);
  row[col("Offer ID")] = ID2; // печатку не перераховано
  const s = stateOf(w, R);
  assert.equal(s.blocked, false);
  assert.ok(s.damaged.has(ID) && s.held.has(ID), "товар із довіреної точки");
  assert.ok(!s.held.has(ID2), "Offer ID зі зміненого прив'язаного рядка не довірений — чужий товар не знімається (як R4-гарантія R3-C1)");
  assert.match(s.issues.join(" | "), new RegExp(`у рядку вказано Offer ID ${ID2}`), "розбіжність видно як попередження");
  const forged = historyRow({ stamp: later(3), opId: "op-unbound00000000000000000", offerId: "1500000021", action: ACTION.HOLD, field: "Продаж", before: "У ПРОДАЖУ", after: "ЗНЯТО", reason: "?", generation: "sale:1" });
  forged[col("Печатка")] = "зламана";
  w.book[CC_SHEET.history].push(forged);
  const s2 = stateOf(w, R);
  assert.equal(s2.blocked, false, "без прив'язки — ізоляція товару, а не зупинка магазину");
  assert.ok(s2.held.has("1500000021"));
});

test("R5-D: захисна операція з дублем рядка (інша дата) — підтверджується з довіреного наміру; товар лишається ізольованим, доки дубль не прибрано", async () => {
  const w = await prepared(); const R = readinessDouble();
  await unconfirmed(w, R, ID, HOLD);
  const h = w.book[CC_SHEET.history];
  const dup = h.find((x, i) => i && x[col("Дія")] === ACTION.HOLD).slice();
  dup[col("Дата")] = later(7); dup[col("Печатка")] = historySeal(dup);
  h.push(dup);
  const r = await apply(w, R, { stamp: later(2) });
  assert.notEqual(r.state, "BLOCKED", JSON.stringify(r));
  assert.ok(cpOf(R).ops.some((e) => e.offerId === ID), "довірений рядок наміру підтверджено");
  const s = stateOf(w, R);
  assert.ok(s.damaged.has(ID) && s.held.has(ID));
});

test("C2: ініціалізацію контрольної точки не підтверджено (запис не вдався) — BLOCKED, жодного запису в аркуші", async () => {
  const w = await prepared(); const R = readinessDouble();
  R.store.failAllPuts = true; // R4: ініціалізація — не коміт; збій будь-якого запису точки
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  const r = await apply(w, R);
  assert.equal(r.state, "BLOCKED", JSON.stringify(r));
  assert.match(r.reason, /ініціалізацію контрольної точки не підтверджено/);
  assert.equal(writes(w).length, 0);
  assert.equal(cpOf(R), null);
});

test("C3: SEO, затверджене без підтвердженої точки, не діє (немає в стані для споживачів); після довиконання — діє", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" });
  await apply(w, R);
  setCells(w, ID, { [SEO_DECISION]: `ЗАТВЕРДИТИ ${codeOf(w, ID, "ЗАТВЕРДИТИ")}` });
  R.store.failCommit = true;
  const r = await apply(w, R, { stamp: later(1) });
  R.store.failCommit = false;
  assert.equal(r.state, "UNCONFIRMED", JSON.stringify(r));
  assert.equal(actions(w, ACTION.SEO_APPROVED, ID).length, 1, "подію записано");
  assert.ok(!stateOf(w, R).seo.has(ID), "непідтверджене SEO не діє");
  assert.equal((await apply(w, R, { stamp: later(2) })).state, "COMMITTED");
  assert.ok(stateOf(w, R).seo.has(ID), "після підтвердження — діє");
});

test("C3: непідтверджена операція — shadow відхиляє нову команду товару (WAIT, нічого не планується); apply спершу довиконує точку, потім обробляє команду (R7: недійсний код — новий код; з ним — повернуто)", async () => {
  const w = await prepared(); const R = readinessDouble();
  await unconfirmed(w, R, ID, HOLD);
  setCells(w, ID, { [SALE_DECISION]: `${RELEASE} ABCDEF` }); // будь-яка команда з кодом для товару з непідтвердженою операцією
  const sh = await shadow(w, { store: R.store });
  assert.equal(sh.planned.events, 0, "WAIT: команду не заплановано");
  assert.match(sh.view.find((x) => x[0] === ID)[6], /ще не підтверджена контрольною точкою/);
  const r0 = await apply(w, R, { stamp: later(2) });
  assert.ok(cpOf(R).ops.some((e) => e.offerId === ID), "довиконання точки — ДО нових команд: " + r0.state);
  assert.equal(actions(w, ACTION.RELEASE, ID).length, 0, "невиданий код нічого не повертає");
  setCells(w, ID, { [SALE_DECISION]: `${RELEASE} ${codeOf(w, ID, RELEASE)}` });
  const r = await apply(w, R, { stamp: later(3) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.equal(actions(w, ACTION.RELEASE, ID).length, 1);
  assert.ok(!stateOf(w, R).held.has(ID));
});

test("C3: довиконання точки не вдалося — UNKNOWN до нових команд: подій інших товарів не дописано", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { [SALE_DECISION]: HOLD }); setCells(w, ID2, { [SALE_DECISION]: HOLD });
  await apply(w, R);
  const code2 = codeOf(w, ID2, HOLD);
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
  R.store.failCommit = true;
  assert.equal((await apply(w, R, { stamp: later(1) })).state, "UNCONFIRMED");
  setCells(w, ID2, { [SALE_DECISION]: `${HOLD} ${code2}` });
  const r = await apply(w, R, { stamp: later(2) });
  assert.equal(r.state, "UNKNOWN", JSON.stringify(r));
  assert.equal(actions(w, ACTION.HOLD, ID2).length, 0, "нова команда не виконується, поки попереднє не підтверджено");
  R.store.failCommit = false;
  const s = stateOf(w, R);
  assert.ok(s.held.has(ID) && !s.held.has(ID2));
});

test("C3: сховище зберегло не те, що записано (читання назад не збігається) — не COMMITTED", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  await apply(w, R);
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
  // Сховище «губить» підтвердження під час коміту (R4: перший запис точки в запуску — наміри, коміт — другий).
  R.store.afterPut = (k, v) => { if (k === CHECKPOINT_KEY && v?.ops?.length) { R.store.afterPut = null; R.store.data.get(k).ops = []; } };
  const r = await apply(w, R, { stamp: later(1) });
  assert.equal(r.state, "UNKNOWN", JSON.stringify(r));
  assert.match(r.checkpoint, /після запису інша/);
});

test("C4: відбиток змінюється, коли з'являється непідтверджена операція, навіть якщо held той самий", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  const a = stateOf(w, R);
  await unconfirmed(w, R, ID, RELEASE, 1);
  const b = stateOf(w, R);
  assert.deepEqual([...b.held], [...a.held], "товар досі поза продажем");
  assert.equal(b.unconfirmed.length, 1);
  assert.notEqual(b.fingerprint, a.fingerprint);
});

test("C4: verifyControlsSnapshot відхиляє зміну стану без blocked (інший товар знято між перевіркою й публікацією)", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  const snap = stateOf(w, R);
  await confirmR(w, R, ID2, HOLD, 1);
  const v = verifyControlsSnapshot(structuredClone(w.book), ctxOf(R), snap.fingerprint);
  assert.equal(stateOf(w, R).blocked, false);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join("; "), /змінився після перевірки/);
});

test("W2: оренду перехоплено, поки дописувались події, — контрольну точку не записано (assertCurrent перед записом точки), UNKNOWN; захисна операція діє", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  await apply(w, R);
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
  let lost = false;
  const acquire = R.committer.acquire.bind(R.committer);
  R.committer.acquire = async (scope) => {
    const l = await acquire(scope);
    if (scope !== LEASE_SCOPE) return l;
    return { ...l, async assertCurrent() { if (lost) throw new Error("STALE: оренду перехоплено"); return l.assertCurrent(); } };
  };
  const inner = w.sheets;
  const sheets = { ...inner, appendRows: async (title, rows) => { const res = await inner.appendRows(title, rows); if (title === CC_SHEET.history) lost = true; return res; } };
  const r = await apply(w, R, { stamp: later(1), sheets });
  assert.equal(r.state, "UNKNOWN", JSON.stringify(r));
  assert.equal(actions(w, ACTION.HOLD, ID).length, 1, "подію дописано до втрати оренди");
  assert.ok(!cpOf(R).ops.some((e) => e.offerId === ID), "точку застарілим записувачем не змінено");
  assert.ok(stateOf(w, R).held.has(ID), "захисна операція діє без підтвердження");
});
