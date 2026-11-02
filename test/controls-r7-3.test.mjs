/** Catalog Controls R7.3 — C1–C7 узгодженого контракту F04 / F06 / F08 (ENG-21-review/CC-ENG-AGREED-CONTRACT-F04-F06-F08.uk.md):
 *  C1 — запечатаний запис точки: beforeCommit перед КОЖНИМ записом (усі фази), квиток у запис, стан після запису;
 *  C2 — стан протоколу A на початку запуску (лише NORMAL); C3 — epochHigh / leaseId у кожному записі, epoch > epochHigh;
 *  C4 — жодного apply поза протоколом A (cc-serving-v2, cc-committer-v2); C5 — recover; C6 — класи результатів;
 *  Q2 — «Історія керування» як додатковий детектор; F08 — без доведеної межі епох — RECOVERY_PENDING.
 *  Двійники serving / сховища з печаткою — ЛИШЕ тестові (test/helpers/controls.mjs); справжні — Engineering (E3–E8). */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { SEAL_COLUMN, rowSeal } from "../src/core/seal.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { ACTION, CC_SHEET, SALE_DECISION, SEO_DECISION, historyRow } from "../src/core/controls-common.mjs";
import { CHECKPOINT_KEY, LEASE_SCOPE } from "../src/pipeline/controls-run.mjs";
import { prepared, setCells, codeOf, rowOf, later, viewOf, history, mainIds } from "./helpers/controls.mjs";
import { HOLD, ID, ID2, RELEASE, apply, col, confirmR, cpOf, prompt, readinessDouble, stateOf, writes } from "./helpers/controls-r3.mjs";

const SEO = { "SEO заголовок UA": "Перевірка протоколу A", "SEO заголовок RU": "Проверка протокола A", "SEO опис UA": "Незалежний опис для перевірки", "SEO опис RU": "Независимое описание для проверки" };
const DEL = (id) => `ВИДАЛИТИ ТОВАР ${id}`;
function reseal(w, id = ID) {
  const v = w.book[SHEET.main], h = v[0].map(mtText), i = v.findIndex((r, k) => k > 0 && mtText(r[0]) === id);
  v[i][h.indexOf(SEAL_COLUMN)] = rowSeal(Object.fromEntries(h.map((k, j) => [k, v[i][j] ?? ""])));
}
/** Чи показано код для команди (без винятку, на відміну від codeOf). */
const hasCode = (w, id, words) => new RegExp(`${words} [0-9A-F]{6}`).test(mtText(viewOf(w, id)?.["Коди підтвердження"]));
const cpWrites = (R) => { const n = { k: 0 }; R.store.afterPut = async (k) => { if (k === CHECKPOINT_KEY) n.k++; }; return n; };
const others = (w, ...skip) => mainIds(w).filter((x) => ![ID, ID2, ...skip].includes(x));
const lastLease = (R) => {
  const acquire = R.committer.acquire.bind(R.committer), box = { lease: null };
  R.committer.acquire = async (scope) => { const l = await acquire(scope); if (scope === LEASE_SCOPE) box.lease = l; return l; };
  return box;
};

// ---------------------------------------------------------------- C1 — запечатаний запис у всіх фазах
test("R7.3-C1 (F06-6): кожен запис контрольної точки в усіх 7 фазах — після beforeCommit і з квитком саме для цього значення, версії й оренди (сховище-двійник із печаткою відхиляє запис без квитка)", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  const n = cpWrites(R);
  await confirmR(w, R, ID, HOLD); // init, issued, intents, settle
  await confirmR(w, R, ID, RELEASE, 1);
  setCells(w, ID, { "Артикул постачальника": "R73-OTHER-PHYSICAL" }); reseal(w);
  await apply(w, R, { stamp: later(2) }); // debt (AUTOHOLD)
  await prompt(w, R, ID2, HOLD, 3);
  R.store.failCommit = true;
  await apply(w, R, { stamp: later(4) });
  R.store.failCommit = false;
  await apply(w, R, { stamp: later(5) }); // recovery (звірка)
  R.serving.state = "RECOVERY_AUTHORIZED";
  assert.equal((await apply(w, R, { stamp: later(6), mode: "recover" })).state, "RECOVERED"); // recover
  const phases = new Set(R.serving.calls.map((c) => c.phase));
  for (const p of ["init", "issued", "intents", "settle", "debt", "recovery", "recover"]) assert.ok(phases.has(p), "немає фази " + p + ": " + [...phases].join(","));
  assert.equal(n.k, R.serving.afterCalls.length, "кожен запис точки завершено afterCommit");
  assert.ok(n.k > 0 && R.serving.calls.length >= n.k, "жодного запису без beforeCommit");
  for (const c of R.serving.calls) assert.ok(c.next.epochHigh === c.lease.token && c.next.leaseId === c.lease.leaseId, "C3: епоха й leaseId оренди в кожному записі");
});

test("R7.3-C1: стан, переданий у beforeCommit, — той, що діятиме після запису (видалення: намір уже захищає — товар поза YML ще до коміту)", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, DEL(ID), 1);
  R.serving.calls.length = 0;
  await apply(w, R, { stamp: later(2) });
  const intents = R.serving.calls.find((c) => c.phase === "intents"), settle = R.serving.calls.find((c) => c.phase === "settle");
  assert.ok(intents?.tombstoned.includes(ID) && intents.held.includes(ID), "стан для запису намірів уже містить видалення");
  const s = stateOf(w, R);
  assert.deepEqual([settle.tombstoned.sort(), settle.held.sort()], [[...s.tombstoned.keys()].sort(), [...s.held].sort()], "стан коміту = стан після запису");
});

// ---------------------------------------------------------------- C4 — жодного apply поза протоколом A
test("R7.3-C4 (F06-1): readiness без serving «cc-serving-v2» (як engineeringReadiness) або committer без leaseId — NOT_READY; жодного запису ні в сховище, ні в аркуші", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  const { serving, ...noServing } = R;
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  const r = await apply(w, noServing);
  assert.equal(r.state, "NOT_READY", JSON.stringify(r).slice(0, 300));
  assert.match(r.reasons.join(" "), /cc-serving-v2/);
  assert.equal(R.store.writes, 0, "сховище не змінено");
  assert.equal(writes(w).length, 0, "аркуші не змінено");
  const acquire = R.committer.acquire.bind(R.committer);
  let k = 0;
  const badFormat = { ...R, committer: { contract: "cc-committer-v2", acquire: async (s) => { const l = await acquire(s); return { ...l, leaseId: "lease-" + ++k }; } } };
  const rl = await apply(w, badFormat);
  assert.equal(rl.state, "NOT_READY");
  assert.match(rl.reasons.join(" "), /leaseId \(32 hex/);
  const repeated = { ...R, committer: { contract: "cc-committer-v2", acquire: async (s) => { const l = await acquire(s); return { ...l, leaseId: "b".repeat(32) }; } } };
  assert.match((await apply(w, repeated)).reasons.join(" "), /leaseId повторюється/);
  const v1 = { ...R, committer: { ...R.committer, contract: "cc-committer-v1" } };
  assert.equal((await apply(w, v1)).state, "NOT_READY");
  assert.equal(R.store.writes, 0);
  void serving;
});

// ---------------------------------------------------------------- C1 / C6 — відмова протоколу A
test("R7.3-C6: відмова beforeCommit на записі намірів видалення — NOT_APPLIED: точку не записано, видалення не діє, рядка журналу немає", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, DEL(ID), 1);
  const before = R.store.ver.get(CHECKPOINT_KEY);
  R.serving.deny = (req) => (req.phase === "intents" ? "HEAD невідомий — обслуговування не доведено безпечним" : null);
  const r = await apply(w, R, { stamp: later(2) });
  assert.equal(r.state, "NOT_APPLIED", JSON.stringify(r).slice(0, 300));
  assert.match(r.reason, /serving not secured/);
  assert.equal(R.store.ver.get(CHECKPOINT_KEY), before, "версія точки та сама");
  assert.equal(stateOf(w, R).tombstoned.has(ID), false);
  assert.ok(!history(w).some((x) => x[col("Дія")] === ACTION.TOMBSTONE));
});

test("R7.3-C6: відмова beforeCommit на коміті — UNCONFIRMED (не COMMITTED); захисний намір уже діє", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, DEL(ID), 1);
  R.serving.deny = (req) => (req.phase === "settle" ? "обслуговування не захищено" : null);
  const r = await apply(w, R, { stamp: later(2) });
  assert.equal(r.state, "UNCONFIRMED", JSON.stringify(r).slice(0, 300));
  const s = stateOf(w, R);
  assert.ok(s.tombstoned.has(ID) && s.held.has(ID), "намір видалення діє");
});

test("R7.3-C6: відмова beforeCommit на записі лише видач — PENDING, кодів не показано й не видано; виняток у beforeCommit — як відмова", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  await apply(w, R);
  R.serving.deny = (req) => (req.phase === "issued" ? "обслуговування не захищено" : null);
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  assert.equal((await apply(w, R, { stamp: later(1) })).state, "PENDING");
  assert.ok(!hasCode(w, ID, HOLD) && !(cpOf(R).issued || []).length, "код не видано");
  R.serving.deny = null;
  const orig = R.serving.beforeCommit;
  R.serving.beforeCommit = async () => { throw new Error("захист обслуговування впав"); };
  assert.equal((await apply(w, R, { stamp: later(2) })).state, "PENDING");
  assert.ok(!(cpOf(R).issued || []).length);
  R.serving.beforeCommit = orig;
});

test("R7.3-C1: оренду втрачено під час beforeCommit — UNKNOWN, точку не записано", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, DEL(ID), 1);
  const box = lastLease(R), before = R.store.ver.get(CHECKPOINT_KEY), orig = R.serving.beforeCommit;
  R.serving.beforeCommit = async (req) => { const g = await orig(req); await box.lease.release(); return g; };
  const r = await apply(w, R, { stamp: later(2) });
  assert.equal(r.state, "UNKNOWN", JSON.stringify(r).slice(0, 300));
  assert.equal(R.store.ver.get(CHECKPOINT_KEY), before);
});

// ---------------------------------------------------------------- C2 / C3
test("R7.3-C2: стан протоколу A не NORMAL — RECOVERY_PENDING без записів і без beforeCommit; стан не прочитано — BLOCKED", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  await apply(w, R);
  const v = R.store.ver.get(CHECKPOINT_KEY), calls = R.serving.calls.length;
  R.serving.state = "RECOVERY_PENDING";
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  assert.equal((await apply(w, R, { stamp: later(1) })).state, "RECOVERY_PENDING");
  assert.deepEqual([R.store.ver.get(CHECKPOINT_KEY), R.serving.calls.length], [v, calls]);
  R.serving.state = "NORMAL";
  R.serving.status = async () => { throw new Error("стан недоступний"); };
  assert.equal((await apply(w, R, { stamp: later(2) })).state, "BLOCKED");
  assert.equal(R.store.ver.get(CHECKPOINT_KEY), v);
});

test("R7.3-C3 (F04-5): кожен запис точки несе епоху (токен) і leaseId оренди; новий координатор із лічильником від 1 — BLOCKED з попередженням, без записів", async () => {
  const w = await prepared(); const R = readinessDouble();
  await apply(w, R);
  await apply(w, R, { stamp: later(1) }); // запуск без видачі й без змін — точку не переписано
  await confirmR(w, R, ID, HOLD, 2);
  const cp = cpOf(R), lastCall = R.serving.calls.at(-1);
  assert.ok(Number.isInteger(cp.epochHigh) && cp.epochHigh === lastCall.lease.token && cp.leaseId === lastCall.lease.leaseId);
  const v = R.store.ver.get(CHECKPOINT_KEY);
  const R2 = readinessDouble({ store: R.store });
  setCells(w, ID2, { [SALE_DECISION]: HOLD });
  const r = await apply(w, R2, { stamp: later(3) });
  assert.equal(r.state, "BLOCKED", JSON.stringify(r).slice(0, 300));
  assert.match(r.warnings.join(" "), /токен оренди/);
  assert.deepEqual([R.store.ver.get(CHECKPOINT_KEY), R2.serving.calls.length], [v, 0]);
});

// ---------------------------------------------------------------- Q2 — журнал як детектор
test("R7.3-Q2: рядки «Історії керування» без прив'язки до точки — apply RECOVERY_PENDING (детектор), без записів; стан для споживачів — захисний діє, послаблення не діє; після recover — захисний у точці, послаблення визнано недійсним, товар не ізольовано", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  const t = mainIds(w).find((x) => x !== ID && x !== ID2);
  const hold2 = historyRow({ stamp: later(1), opId: "op-r73-unbound-hold-0000001", offerId: ID2, action: ACTION.HOLD, field: "Продаж", before: "У ПРОДАЖУ", after: "ЗНЯТО", reason: "рядок без прив'язки", generation: "sale:1" });
  const rel1 = historyRow({ stamp: later(1), opId: "op-r73-unbound-release-001", offerId: ID, action: ACTION.RELEASE, field: "Продаж", before: "ЗНЯТО", after: "У ПРОДАЖУ", reason: "рядок без прив'язки", generation: "sale:2" });
  w.book[CC_SHEET.history].push(hold2, rel1);
  const v = R.store.ver.get(CHECKPOINT_KEY);
  const r = await apply(w, R, { stamp: later(2) });
  assert.deepEqual([r.state, r.detector], ["RECOVERY_PENDING", "journal"], JSON.stringify(r).slice(0, 300));
  assert.equal(R.store.ver.get(CHECKPOINT_KEY), v, "нічого не записано");
  let s = stateOf(w, R);
  assert.ok(s.held.has(ID2) && s.held.has(ID) && !s.held.has(t), "захисний діє, послаблення — ні, інші не зачеплено");
  R.serving.state = "RECOVERY_AUTHORIZED";
  const rr = await apply(w, R, { stamp: later(3), mode: "recover" });
  assert.equal(rr.state, "RECOVERED", JSON.stringify(rr).slice(0, 300));
  assert.deepEqual(rr.recovery.ack, ["op-r73-unbound-release-001"]);
  R.serving.finishRecovery();
  assert.notEqual((await apply(w, R, { stamp: later(4) })).state, "RECOVERY_PENDING", "детектор більше не спрацьовує");
  s = stateOf(w, R);
  assert.ok(s.held.has(ID2), "захисний рядок тепер у точці");
  assert.ok(s.held.has(ID) && !s.damaged.has(ID), "послаблення з журналу не діє, але товар не ізольовано — власник може вирішити заново");
});

// ---------------------------------------------------------------- C5 — recover
async function afterBackup() {
  const w = await prepared(); const R = readinessDouble({ strict: true });
  const [T, F] = others(w);
  await confirmR(w, R, ID, HOLD);
  const backup = structuredClone(cpOf(R)); // «резервна копія» точки
  await confirmR(w, R, ID, RELEASE, 1); // послаблення ПІСЛЯ копії — ухвалене
  await confirmR(w, R, ID2, HOLD, 2); // захисне після копії
  await confirmR(w, R, T, DEL(T), 3); // видалення після копії
  setCells(w, F, { [SALE_DECISION]: HOLD });
  await apply(w, R, { stamp: later(4) }); // невикористаний код для F
  const codeF = codeOf(w, F, HOLD);
  await prompt(w, R, ID2, RELEASE, 5);
  R.store.failCommit = true;
  await apply(w, R, { stamp: later(6) }); // незавершене послаблення ID2
  R.store.failCommit = false;
  R.store.data.set(CHECKPOINT_KEY, backup); // відновлення точки поза протоколом A
  return { w, R, T, F, codeF };
}
test("R7.3-C5: відновлення точки — виявлено (RECOVERY_PENDING); recover за дозволом власника: ухвалені рішення після копії не скасовано (повернення в продаж, зняття, видалення), незавершене послаблення скасовано, усі невикористані коди недійсні", async () => {
  const { w, R, T, F, codeF } = await afterBackup();
  setCells(w, F, { [SALE_DECISION]: `${HOLD} ${codeF}` });
  assert.equal((await apply(w, R, { stamp: later(7) })).state, "RECOVERY_PENDING");
  assert.equal((await apply(w, R, { stamp: later(7.5), mode: "recover" })).state, "RECOVERY_PENDING", "без дозволу власника — немає відновлення");
  R.serving.state = "RECOVERY_AUTHORIZED";
  const rr = await apply(w, R, { stamp: later(8), mode: "recover" });
  assert.equal(rr.state, "RECOVERED", JSON.stringify(rr).slice(0, 300));
  const cp = cpOf(R);
  assert.ok(!(cp.issued || []).length, "видачі кодів анульовано");
  assert.ok(cp.aborted.some((e) => e.offerId === ID2 && e.action === ACTION.RELEASE), "незавершене послаблення скасовано");
  R.serving.finishRecovery();
  let s = stateOf(w, R);
  assert.ok(!s.held.has(ID), "повернення в продаж після копії — не скасовано");
  assert.ok(s.held.has(ID2), "зняття після копії діє");
  assert.ok(s.tombstoned.get(T)?.confirmed, "видалення після копії діє");
  await apply(w, R, { stamp: later(9) });
  s = stateOf(w, R);
  assert.ok(!s.held.has(F), "код, виданий до відновлення, не діє");
  assert.match(viewOf(w, F)["Попередження"], /видано до відновлення/);
  assert.ok(codeOf(w, F, HOLD) && codeOf(w, F, HOLD) !== codeF, "новий код видано");
});

test("R7.3-C5 / F08: без доведеної межі епох (повне відновлення W2 + фідів + точки) — RECOVERY_PENDING і для apply, і для recover навіть із дозволом; нічого не записано, кодів немає", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  await confirmR(w, R, ID, HOLD);
  const v = R.store.ver.get(CHECKPOINT_KEY), calls = R.serving.calls.length;
  Object.assign(R.serving, { state: "RECOVERY_PENDING", type: "FULL", floorProven: false });
  setCells(w, ID2, { [SALE_DECISION]: HOLD });
  assert.equal((await apply(w, R, { stamp: later(1) })).state, "RECOVERY_PENDING");
  R.serving.state = "RECOVERY_AUTHORIZED";
  const rr = await apply(w, R, { stamp: later(2), mode: "recover" });
  assert.equal(rr.state, "RECOVERY_PENDING", JSON.stringify(rr).slice(0, 300));
  assert.match(rr.reason, /межу епох не доведено/);
  assert.deepEqual([R.store.ver.get(CHECKPOINT_KEY), R.serving.calls.length], [v, calls]);
  assert.ok(!hasCode(w, ID2, HOLD) && !(cpOf(R).issued || []).some((x) => x.offerId === ID2));
});

test("R7.3-C5: recover у стані NORMAL — NOT_RECOVERING; відмова захисту обслуговування на записі відновлення — RECOVERY_PENDING, точку не записано", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  await confirmR(w, R, ID, HOLD);
  assert.equal((await apply(w, R, { stamp: later(1), mode: "recover" })).state, "NOT_RECOVERING");
  const v = R.store.ver.get(CHECKPOINT_KEY);
  R.serving.state = "RECOVERY_AUTHORIZED";
  R.serving.deny = (req) => (req.phase === "recover" ? "обслуговування не захищено" : null);
  assert.equal((await apply(w, R, { stamp: later(2), mode: "recover" })).state, "RECOVERY_PENDING");
  assert.equal(R.store.ver.get(CHECKPOINT_KEY), v);
});

test("R7.3-C5 (чиста функція): та сама операція з різним вмістом — товар ізольовано; скасоване в одній гілці й ухвалене в реєстрі — ухвалене; результат — дійсна точка v4", async () => {
  const plan = await import("../src/core/controls-plan.mjs");
  assert.equal(typeof plan.recoverCheckpoint, "function", "recoverCheckpoint немає");
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  const cp = cpOf(R), op = cp.ops[0];
  const forked = structuredClone(op);
  forked.row[0] = later(9); forked.row[9] = (await import("../src/core/controls-common.mjs")).historySeal(forked.row); forked.seal = forked.row[9];
  const aborted = { op: "op-r73-aborted-then-ok-00001", offerId: ID2, seal: "x", action: ACTION.HOLD, gen: 1, reason: "скасовано в гілці" };
  const okRow = historyRow({ stamp: later(1), opId: aborted.op, offerId: ID2, action: ACTION.HOLD, field: "Продаж", before: "У ПРОДАЖУ", after: "ЗНЯТО", reason: "ухвалено в іншій гілці", generation: "sale:1" });
  const base = { ...structuredClone(cp), aborted: [{ ...aborted, seal: okRow.at(-1) }] };
  const registry = { v: 4, ops: [forked, { op: aborted.op, offerId: ID2, seal: okRow.at(-1), row: okRow }], pending: [], aborted: [] };
  const next = plan.recoverCheckpoint({ base, registry, at: later(10), epoch: 99, leaseId: "a".repeat(32), generation: 1, type: "CP_ONLY" });
  assert.ok(next, "точка відновлення дійсна");
  assert.ok(next.ops.some((e) => e.op === aborted.op) && !next.aborted.some((e) => e.op === aborted.op), "ухвалене в реєстрі — ухвалене");
  assert.deepEqual(next.recovery.conflicts, [ID]);
  // Журнал узгоджено з реєстром (рядок гілки реєстру), тож ізоляцію дає саме конфлікт відновлення, а не розбіжність журналу.
  const book = structuredClone(w.book), hk = book[CC_SHEET.history].findIndex((r, i) => i && r[1] === op.op);
  book[CC_SHEET.history][hk] = forked.row.slice();
  book[CC_SHEET.history].push(okRow.slice());
  const { ACTIVE_CONTRACT } = await import("./helpers/controls.mjs");
  const s = plan.controlsState(book, { contract: ACTIVE_CONTRACT, checkpoint: next });
  assert.ok(s.damaged.has(ID) && s.held.has(ID), "конфлікт вмісту — товар ізольовано");
  assert.ok(!s.damaged.has(ID2), "без конфлікту — не ізольовано");
});

test("R7.3-C5 (захист у глибину): видача з епохою ≤ епохи відновлення — недійсна: вид її не показує, команда з її кодом — відмова «видано до відновлення» й нова видача", async () => {
  const plan = await import("../src/core/controls-plan.mjs");
  const { ACTIVE_CONTRACT, PROTECTION_OK } = await import("./helpers/controls.mjs");
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  await apply(w, R);
  const code = codeOf(w, ID, HOLD), cp = cpOf(R), x = cp.issued.find((e) => e.offerId === ID);
  const rec = { ...structuredClone(cp), recovery: { generation: 1, epoch: x.epoch, type: "CP_ONLY", at: later(1), fromHash: "", ack: [], conflicts: [] } };
  const view = plan.buildView(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: rec, notes: new Map() });
  assert.ok(!mtText(view.find((r) => r[0] === ID)?.[5]).includes(code), "вид не показує коду до відновлення");
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${code}` });
  const p = plan.planControls({ book: structuredClone(w.book), stamp: later(2), contract: ACTIVE_CONTRACT, protection: PROTECTION_OK, checkpoint: rec, epoch: x.epoch + 5 });
  assert.equal(p.intents.length, 0, "команда з кодом до відновлення не виконується");
  assert.match((p.notes.get(ID) || []).join(" "), /видано до відновлення/);
  assert.ok([...p.issued.values()].some((e) => e.offerId === ID && e.epoch === x.epoch + 5), "нова видача");
});

// ---------------------------------------------------------------- контрприклади Hermes C71-01 (порти з двійниками протоколу A)
function sku(w, value) { setCells(w, ID, { "Артикул постачальника": value }); reseal(w); }
const seoIssue = (R) => (cpOf(R)?.issued || []).find((x) => x.offerId === ID && x.action === "SEO_APPROVE");
test("R7.3 (Hermes C71-01, гілка точки): відновлена старіша точка виявлена до видачі коду A; після погодженого відновлення й повтору гілки B незмінна команда для A не авторизує B", async () => {
  const w = await prepared(); const R = readinessDouble({ strict: true });
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); sku(w, "C73-BASE");
  await apply(w, R);
  const base = structuredClone(cpOf(R));
  sku(w, "C73-B"); await apply(w, R, { stamp: later(1 / 60) });
  const branchB = structuredClone(cpOf(R));
  R.store.data.set(CHECKPOINT_KEY, structuredClone(base));
  sku(w, "C73-A");
  assert.equal((await apply(w, R, { stamp: later(2 / 60) })).state, "RECOVERY_PENDING", "відновлення виявлено — коду для A не видано");
  R.serving.state = "RECOVERY_AUTHORIZED";
  assert.equal((await apply(w, R, { stamp: later(3 / 60), mode: "recover" })).state, "RECOVERED");
  R.serving.finishRecovery();
  await apply(w, R, { stamp: later(4 / 60) });
  const command = "ЗАТВЕРДИТИ " + seoIssue(R).code;
  setCells(w, ID, { [SEO_DECISION]: command }); // підтвердження лише для A
  sku(w, "C73-B"); R.store.data.set(CHECKPOINT_KEY, branchB);
  const r = await apply(w, R, { stamp: later(5 / 60) });
  assert.equal(r.state, "RECOVERY_PENDING");
  assert.equal(rowOf(w, ID)[SEO_DECISION], command);
  assert.equal(stateOf(w, R).seo.has(ID), false, "незмінна команда для A затвердила B");
});

test("R7.3 (Hermes C71-01, CAS): відновлення старішої точки через putJsonIfVersion з чинною орендою — відхилено печаткою ключа (CC_KEY_SEALED, контракт сховища — двійник; справжнє — Engineering E3)", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); sku(w, "CAS-BASE");
  await apply(w, R);
  const base = structuredClone(cpOf(R));
  sku(w, "CAS-B"); await apply(w, R, { stamp: later(1 / 60) });
  const before = JSON.stringify(cpOf(R));
  const lease = await R.committer.acquire(LEASE_SCOPE);
  let code = "";
  try {
    const cur = await R.store.getJsonVersioned(CHECKPOINT_KEY);
    await R.store.putJsonIfVersion(CHECKPOINT_KEY, base, cur.version, { lease: { scope: LEASE_SCOPE, token: lease.token, leaseId: lease.leaseId } });
  } catch (e) { code = e.code; } finally { await lease.release(); }
  assert.equal(code, "CC_KEY_SEALED");
  assert.equal(JSON.stringify(cpOf(R)), before, "точку не змінено");
});
