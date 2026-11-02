/** Catalog Controls R7.4 — пп. a і d ревю ENG-24 (ENG-24-review/CC-ENG24-SECTION11-REVIEW.uk.md; погоджено власником 31.10.2026):
 *  a — відмова видачі оренди: BUSY (звичайна зайнятість) ≠ RECOVERY_PENDING (відкат W2 за межею епох) ≠ BLOCKED (невідоме), записів
 *      немає в жодному разі (контракт F04 / F06 / F08, розд. 5);
 *  d — serving.status NORMAL / type "MIGRATION": окремий стан MIGRATED без записів рішень, видач кодів і без COMMITTED; недостовірна
 *      міграція (поля протоколу A у точці, точки немає, журнал не узгоджений) команд не застосовує;
 *  N1 (Hermes ENG-24, частина CC): CC звертається до сховища лише канонічними ключами — псевдонімів не створює (печатку фізичних
 *      ключів реалізує Engineering).
 *  Розділ «композиція» виконується лише в дереві зі справжнім протоколом A Engineering (ENG-24: cc-serving.mjs, recovery.mjs).
 *  R7.4.1 (лише тести; ENG-26 розд. 4, I-1 / I-2): точку R7.3 без head і дзеркала відхиляє протокол A стійко (E-d2) — тест
 *  вимагає саме цього (сильніше, ніж одноразова відмова CC); стабільність status (E-d1) — двома викликами для обох випадків.
 *  Одноразова відмова CC (MIGRATION_UNVERIFIED) лишається захистом у глибину й перевіряється з двійником протоколу A. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mtText } from "../src/core/text.mjs";
import { ACTION, CC_SHEET, HISTORY_HEADERS, SALE_DECISION, historyRow } from "../src/core/controls-common.mjs";
import { CHECKPOINT_KEY, LEASE_SCOPE } from "../src/pipeline/controls-run.mjs";
import { prepared, setCells, viewOf, later, mainIds } from "./helpers/controls.mjs";
import { HOLD, ID, ID2, apply, confirmR, cpOf, prompt, readinessDouble, stateOf, writes } from "./helpers/controls-r3.mjs";

const PROBE_KEY = "state/catalog-controls/readiness-probe.json";
const DEL = (id) => `ВИДАЛИТИ ТОВАР ${id}`;
const hasCode = (w, id, words) => new RegExp(`${words} [0-9A-F]{6}`).test(mtText(viewOf(w, id)?.["Коди підтвердження"]));
const leaseErr = (code, text = "імітовано") => Object.assign(new Error(`${code}: ${text}`), { code });
/** Відмова видачі ОСНОВНОЇ оренди (перевірка готовності — окрема область — працює як звичайно). */
function refuseLease(R, err) {
  const acquire = R.committer.acquire.bind(R.committer);
  R.committer.acquire = async (scope) => { if (scope === LEASE_SCOPE) throw err; return acquire(scope); };
  return () => { R.committer.acquire = acquire; };
}
/** Знімок усього, що CC міг би змінити: версія точки, видачі кодів, виклики протоколу A, записи аркушів. */
const footprint = (w, R) => ({ cp: R.store.ver.get(CHECKPOINT_KEY) ?? null, issued: (cpOf(R)?.issued || []).length, before: R.serving.calls.length, after: R.serving.afterCalls.length, status: R.serving.statusCalls, sheets: writes(w).length });
/** Точка формату до R7.3 (R7.2 і раніше): без epochHigh / leaseId / recovery; нова версія — як після запису старим кодом. */
function legacyCheckpoint(R, keep = []) {
  const cp = structuredClone(cpOf(R));
  for (const k of ["epochHigh", "leaseId", "recovery"]) if (!keep.includes(k)) delete cp[k];
  R.store.data.set(CHECKPOINT_KEY, cp); R.store.ver.set(CHECKPOINT_KEY, (R.store.ver.get(CHECKPOINT_KEY) || 0) + 1);
  return cp;
}
/** Світ із підтвердженим зняттям ID і запитаною (код видано, не підтверджено) командою для ID2. */
async function world({ sealed = true } = {}) {
  const w = await prepared(); const R = readinessDouble({ sealed });
  assert.equal((await confirmR(w, R, ID, HOLD)).state, "COMMITTED");
  await prompt(w, R, ID2, HOLD, 1);
  assert.ok(stateOf(w, R).held.has(ID) && !stateOf(w, R).held.has(ID2), "передумова: ID знято, команда для ID2 чекає");
  return { w, R };
}

// ================================================================ a — відмова видачі оренди
for (const mode of ["apply", "recover"]) {
  test(`R7.4-a (${mode}): звичайна зайнятість (BUSY / SETTLING / STALE_EPOCH) → BUSY з кодом; жодного запису й жодного виклику протоколу A`, async () => {
    const { w, R } = await world();
    for (const code of ["BUSY", "SETTLING", "STALE_EPOCH"]) {
      const f0 = footprint(w, R), undo = refuseLease(R, leaseErr(code, "ресурс зайнятий"));
      const r = await apply(w, R, { stamp: later(2), mode });
      undo();
      assert.deepEqual([r.state, r.code], ["BUSY", code], JSON.stringify(r).slice(0, 300));
      assert.equal(r.detector, undefined);
      assert.deepEqual(footprint(w, R), f0, code + ": нічого не змінено");
    }
  });

  test(`R7.4-a (${mode}): відкат W2 за межею епох (RECOVERY_PENDING) → RECOVERY_PENDING, detector «epoch-floor» (не «journal»); жодного запису`, async () => {
    const { w, R } = await world();
    const f0 = footprint(w, R);
    const undo = refuseLease(R, leaseErr("RECOVERY_PENDING", "токен у записі оренди (3) нижчий за межу епох (5) — сховище W2 відкочено"));
    const r = await apply(w, R, { stamp: later(2), mode });
    undo();
    assert.deepEqual([r.state, r.code, r.detector], ["RECOVERY_PENDING", "RECOVERY_PENDING", "epoch-floor"], JSON.stringify(r).slice(0, 300));
    assert.match(r.reason, /нижчий за межу епох \(5\)/, "причина Engineering збережена");
    assert.match(r.reason, /окремий дозвіл власника/);
    assert.deepEqual(footprint(w, R), f0, "нічого не змінено");
    assert.equal(stateOf(w, R).held.has(ID2), false, "команда не застосована");
  });

  test(`R7.4-a (${mode}): невідома причина відмови (NO_CAS, SERVING_NOT_SECURED, NO_LEASE, без коду, не Error, нерядковий код) → BLOCKED; жодного запису`, async () => {
    const { w, R } = await world();
    const cases = [[leaseErr("NO_CAS"), "NO_CAS"], [leaseErr("SERVING_NOT_SECURED"), "SERVING_NOT_SECURED"], [leaseErr("NO_LEASE"), "NO_LEASE"],
      [new Error("межа епох: немає сховища фідів"), "LEASE_REFUSED"], ["рядок замість помилки", "LEASE_REFUSED"], [Object.assign(new Error("BUSY: число"), { code: 409 }), "LEASE_REFUSED"]];
    for (const [err, code] of cases) {
      const f0 = footprint(w, R), undo = refuseLease(R, err);
      const r = await apply(w, R, { stamp: later(2), mode });
      undo();
      assert.deepEqual([r.state, r.code], ["BLOCKED", code], JSON.stringify(r).slice(0, 300));
      assert.notEqual(r.state, "BUSY", "невідома причина — не «повторіть пізніше»");
      assert.deepEqual(footprint(w, R), f0, code + ": нічого не змінено");
    }
  });
}

test("R7.4-a: зайнятість і відкат епохи — РІЗНІ результати; зайнятість минає без участі власника, відкат — ні (оренди немає, поки Engineering не підніме межу процедурою)", async () => {
  const { w, R } = await world();
  const busy = refuseLease(R, leaseErr("BUSY"));
  const rb = await apply(w, R, { stamp: later(2) });
  busy();
  const back = refuseLease(R, leaseErr("RECOVERY_PENDING"));
  const rr = await apply(w, R, { stamp: later(2.1) });
  back();
  assert.notEqual(rb.state, rr.state);
  assert.deepEqual([rb.state, rr.state], ["BUSY", "RECOVERY_PENDING"]);
  // Справжня зайнятість двійника (оренду тримає інший записувач) — BUSY; після звільнення команда виконується.
  const held = await R.committer.acquire(LEASE_SCOPE);
  const rh = await apply(w, R, { stamp: later(3) });
  assert.deepEqual([rh.state, rh.code], ["BUSY", "BUSY"], JSON.stringify(rh).slice(0, 300));
  await held.release();
  assert.equal((await apply(w, R, { stamp: later(4) })).state, "COMMITTED");
  assert.ok(stateOf(w, R).held.has(ID2), "після зайнятості команда власника виконана");
});

// ================================================================ d — MIGRATION
test("R7.4-d: підтверджена міграція (точка формату до R7.3, журнал узгоджений) → MIGRATED: не COMMITTED, жодного запису точки, рішень, кодів чи аркушів; наступний звичайний запуск виконує команду", async () => {
  const { w, R } = await world();
  legacyCheckpoint(R);
  setCells(w, mainIds(w).find((x) => x !== ID && x !== ID2), { [SALE_DECISION]: HOLD }); // новий запит коду
  const f0 = footprint(w, R), heldBefore = [...stateOf(w, R).held].sort();
  R.serving.statusType = "MIGRATION"; R.serving.reason = "head і дзеркало створено з чинної точки";
  const r = await apply(w, R, { stamp: later(2) });
  assert.equal(r.state, "MIGRATED", JSON.stringify(r).slice(0, 300));
  assert.notEqual(r.state, "COMMITTED");
  assert.deepEqual([r.checkpoint, r.view, r.migration?.type], ["UNCHANGED", "UNCHANGED", "MIGRATION"]);
  assert.equal(r.migration.reason, "head і дзеркало створено з чинної точки");
  assert.deepEqual({ ...footprint(w, R), status: 0 }, { ...f0, status: 0 }, "жодного beforeCommit / запису точки / видачі / запису аркушів");
  assert.deepEqual([...stateOf(w, R).held].sort(), heldBefore, "рішень не додано й не знято");
  assert.ok(r.held.has(ID) && !r.held.has(ID2), "стан для споживачів — з чинної точки");
  // Наступний запуск — звичайний (Engineering: NORMAL); підтверджена раніше команда ID2 виконується, запечатаний запис — як завжди.
  R.serving.statusType = "NORMAL"; R.serving.reason = "";
  const n = R.serving.afterCalls.length;
  const r2 = await apply(w, R, { stamp: later(3) });
  assert.ok(["COMMITTED", "PENDING"].includes(r2.state), JSON.stringify(r2).slice(0, 300));
  assert.ok(stateOf(w, R).held.has(ID2), "команда власника виконана наступним запуском");
  assert.ok(R.serving.afterCalls.length > n && R.serving.calls.length >= R.serving.afterCalls.length, "кожен запис — через beforeCommit / afterCommit");
  assert.ok(Number.isInteger(cpOf(R).epochHigh) && typeof cpOf(R).leaseId === "string", "точка тепер формату протоколу A");
});

test("R7.4-d: недостовірна міграція — точка з будь-яким полем протоколу A (epochHigh / leaseId / recovery) → RECOVERY_PENDING, detector «migration», MIGRATION_UNVERIFIED; команди не застосовано, нічого не записано", async () => {
  for (const keep of [["epochHigh", "leaseId"], ["epochHigh"], ["leaseId"], ["recovery"]]) {
    const { w, R } = await world();
    const cp = legacyCheckpoint(R, keep);
    if (keep.includes("recovery")) { cp.recovery = { generation: 1, epoch: 2, type: "CP_ONLY", at: later(0), fromHash: "", ack: [], conflicts: [] }; R.store.data.set(CHECKPOINT_KEY, structuredClone(cp)); }
    const f0 = footprint(w, R);
    R.serving.statusType = "MIGRATION";
    const r = await apply(w, R, { stamp: later(2) });
    assert.deepEqual([r.state, r.detector, r.code], ["RECOVERY_PENDING", "migration", "MIGRATION_UNVERIFIED"], keep.join("+") + ": " + JSON.stringify(r).slice(0, 300));
    assert.match(r.reason, new RegExp(keep[0]));
    assert.deepEqual({ ...footprint(w, R), status: 0 }, { ...f0, status: 0 }, keep.join("+") + ": нічого не записано");
    assert.equal(stateOf(w, R).held.has(ID2), false, "команда не застосована");
  }
});

test("R7.4-d: недостовірна міграція — раніше за перевірку епохи (C3): точка з epochHigh ≥ токена оренди → RECOVERY_PENDING / migration; без міграції та сама точка — BLOCKED за епохою", async () => {
  const { w, R } = await world();
  R.store.data.set(CHECKPOINT_KEY, { ...cpOf(R), epochHigh: 10_000 });
  const f0 = footprint(w, R);
  R.serving.statusType = "MIGRATION";
  const r = await apply(w, R, { stamp: later(2) });
  assert.deepEqual([r.state, r.detector, r.code], ["RECOVERY_PENDING", "migration", "MIGRATION_UNVERIFIED"], JSON.stringify(r).slice(0, 300));
  R.serving.statusType = "NORMAL";
  const rn = await apply(w, R, { stamp: later(3) });
  assert.equal(rn.state, "BLOCKED", JSON.stringify(rn).slice(0, 300));
  assert.match(rn.reason, /не більший за епоху останнього запису/);
  assert.deepEqual({ ...footprint(w, R), status: 0 }, { ...f0, status: 0 }, "нічого не записано");
});

test("R7.4-d: міграція без контрольної точки → RECOVERY_PENDING (MIGRATION_UNVERIFIED); ініціалізації немає", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  R.serving.statusType = "MIGRATION";
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  const r = await apply(w, R);
  assert.deepEqual([r.state, r.code], ["RECOVERY_PENDING", "MIGRATION_UNVERIFIED"], JSON.stringify(r).slice(0, 300));
  assert.equal(cpOf(R), null, "точку не ініціалізовано");
  assert.equal(R.serving.calls.length, 0);
  assert.equal(writes(w).length, 0);
});

test("R7.4-d: міграція, а журнал має рядки без прив'язки до точки → RECOVERY_PENDING, detector «journal» (суворіший), жодного запису", async () => {
  const { w, R } = await world();
  legacyCheckpoint(R);
  w.book[CC_SHEET.history].push(historyRow({ stamp: later(1), opId: "op-r74-unbound-tomb-0000001", offerId: ID2, action: ACTION.HOLD, field: "Продаж", before: "У ПРОДАЖУ", after: "ЗНЯТО", reason: "рядок без прив'язки", generation: "sale:1" }));
  const f0 = footprint(w, R);
  R.serving.statusType = "MIGRATION";
  const r = await apply(w, R, { stamp: later(2) });
  assert.deepEqual([r.state, r.detector], ["RECOVERY_PENDING", "journal"], JSON.stringify(r).slice(0, 300));
  assert.deepEqual({ ...footprint(w, R), status: 0 }, { ...f0, status: 0 });
  assert.ok(r.held.has(ID2), "захисний рядок діє для споживачів (fail-closed)");
});

test("R7.4-d: міграція, а журнал не читається або точка пошкоджена → BLOCKED, жодного запису", async () => {
  {
    const { w, R } = await world();
    legacyCheckpoint(R);
    w.book[CC_SHEET.history][0] = HISTORY_HEADERS.map((k) => (k === "Operation ID" ? "Зламано" : k));
    const f0 = footprint(w, R);
    R.serving.statusType = "MIGRATION";
    const r = await apply(w, R, { stamp: later(2) });
    assert.equal(r.state, "BLOCKED", JSON.stringify(r).slice(0, 300));
    assert.match(r.reason, /не читається/);
    assert.deepEqual({ ...footprint(w, R), status: 0 }, { ...f0, status: 0 });
  }
  {
    const { w, R } = await world();
    const cp = legacyCheckpoint(R);
    R.store.data.set(CHECKPOINT_KEY, { ...cp, v: 3 });
    const f0 = footprint(w, R);
    R.serving.statusType = "MIGRATION";
    const r = await apply(w, R, { stamp: later(2) });
    assert.equal(r.state, "BLOCKED", JSON.stringify(r).slice(0, 300));
    assert.deepEqual({ ...footprint(w, R), status: 0 }, { ...f0, status: 0 });
  }
});

test("R7.4-d: видалений товар і зняття власника лишаються чинними через міграцію (стан для споживачів — з точки; підтвердження видалення в запуску міграції не виконується)", async () => {
  const { w, R } = await world();
  await confirmR(w, R, ID, DEL(ID), 2);
  assert.ok(stateOf(w, R).tombstoned.has(ID), "передумова: ID видалено");
  await prompt(w, R, ID2, DEL(ID2), 3);
  legacyCheckpoint(R);
  R.serving.statusType = "MIGRATION";
  const r = await apply(w, R, { stamp: later(4) });
  assert.equal(r.state, "MIGRATED", JSON.stringify(r).slice(0, 300));
  assert.ok(r.tombstoned.has(ID) && r.held.has(ID), "видалення діє");
  assert.equal(r.tombstoned.has(ID2), false, "нове видалення в запуску міграції не зафіксовано");
  R.serving.statusType = "NORMAL";
  await apply(w, R, { stamp: later(5) });
  assert.ok(stateOf(w, R).tombstoned.has(ID2) && stateOf(w, R).tombstoned.has(ID), "наступний запуск фіксує підтверджене видалення; попереднє не скасовано");
});

test("R7.4-d: інші типи NORMAL (NORMAL, BOOTSTRAP, FINISHED, F_ONLY_SYNCED, порожній) — звичайний запуск; у режимі recover міграція — NOT_RECOVERING без записів", async () => {
  for (const type of ["NORMAL", "BOOTSTRAP", "FINISHED", "F_ONLY_SYNCED", ""]) {
    const { w, R } = await world();
    R.serving.statusType = type;
    const r = await apply(w, R, { stamp: later(2) });
    assert.ok(["COMMITTED", "PENDING"].includes(r.state), `${type || "—"}: ${JSON.stringify(r).slice(0, 200)}`);
    assert.ok(stateOf(w, R).held.has(ID2), `${type || "—"}: команда виконана`);
  }
  const { w, R } = await world();
  legacyCheckpoint(R);
  R.serving.statusType = "MIGRATION";
  const f0 = footprint(w, R);
  const r = await apply(w, R, { stamp: later(2), mode: "recover" });
  assert.equal(r.state, "NOT_RECOVERING", JSON.stringify(r).slice(0, 300));
  assert.deepEqual({ ...footprint(w, R), status: 0 }, { ...f0, status: 0 });
});

test("R7.4-d: стан протоколу A не NORMAL має пріоритет над type «MIGRATION» (RECOVERY_PENDING, без записів)", async () => {
  const { w, R } = await world();
  legacyCheckpoint(R);
  R.serving.state = "RECOVERY_PENDING"; R.serving.statusType = "MIGRATION";
  const f0 = footprint(w, R);
  const r = await apply(w, R, { stamp: later(2) });
  assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
  assert.equal(r.detector, undefined);
  assert.deepEqual({ ...footprint(w, R), status: 0 }, { ...f0, status: 0 });
});

// ================================================================ N1 (Hermes ENG-24) — частина CC
test("R7.4-N1: CC звертається до сховища лише канонічними ключами (точка, проба готовності) у всіх режимах і фазах; точку пише лише putJsonIfVersion з квитком", async () => {
  const w = await prepared(); const R = readinessDouble({ sealed: true });
  const log = [];
  for (const m of ["getJson", "getJsonVersioned", "putJson", "putJsonIfVersion"]) {
    const orig = R.store[m].bind(R.store);
    R.store[m] = async (k, ...a) => { log.push({ m, k, ticket: Boolean(a[2]?.ticket) }); return orig(k, ...a); };
  }
  await confirmR(w, R, ID, HOLD);
  await confirmR(w, R, ID, DEL(ID), 1);
  await prompt(w, R, ID2, HOLD, 2);
  await apply(w, R, { stamp: later(3), mode: "shadow" });
  R.serving.statusType = "MIGRATION"; await apply(w, R, { stamp: later(4) }); R.serving.statusType = "NORMAL";
  R.serving.state = "RECOVERY_AUTHORIZED";
  assert.equal((await apply(w, R, { stamp: later(5), mode: "recover" })).state, "RECOVERED");
  const keys = new Set(log.map((x) => x.k));
  assert.deepEqual([...keys].sort(), [CHECKPOINT_KEY, PROBE_KEY].sort(), "лише два канонічні ключі");
  assert.equal(CHECKPOINT_KEY, "state/catalog-controls/checkpoint.json", "ключ точки — той, що запечатує Engineering");
  for (const k of keys) assert.equal(k, k.toLowerCase(), "без регістрових варіантів");
  const cpPuts = log.filter((x) => x.k === CHECKPOINT_KEY && x.m.startsWith("put"));
  assert.ok(cpPuts.length > 0 && cpPuts.every((x) => x.m === "putJsonIfVersion" && x.ticket), "кожен запис точки — putJsonIfVersion з квитком");
});

// ================================================================ композиція зі справжнім протоколом A Engineering (ENG-24)
const engFiles = ["../src/pipeline/cc-serving.mjs", "../src/pipeline/recovery.mjs", "../src/pipeline/production.mjs", "../src/pipeline/safe-write/gateway.mjs"].every((p) => fs.existsSync(new URL(p, import.meta.url)));
const skip = engFiles ? false : "протокол A Engineering (ENG-24) відсутній у дереві — інтеграційні тести лише в композиції";
const CK = CHECKPOINT_KEY, REG = "state/cc-registry/head.json", HEAD = "state/cc-serving/head.json";
async function composed() {
  const [prod, store, gw, local, rec, committer, baseConfig, h] = await Promise.all([
    import("../src/pipeline/production.mjs"), import("../src/pipeline/safe-write/store.mjs"), import("../src/pipeline/safe-write/gateway.mjs"), import("../src/storage/local.mjs"),
    import("../src/pipeline/recovery.mjs"), import("../src/pipeline/safe-write/committer.mjs"), import("../config/default.json", { with: { type: "json" } }), import("./helpers/controls.mjs"),
  ]);
  const w = await h.prepared();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-r74-"));
  const stateDir = path.join(dir, "w2"), clock = { now: h.NOW };
  const x = { w, h, dir, stateDir, clock, rec, leaseKeyOf: committer.leaseKeyOf, feeds: new local.LocalObjectStore(path.join(dir, "objects")) };
  x.open = () => { x.state = new store.FileStore(stateDir); x.gateway = new gw.WriteGateway({ sheets: w.mem, read: (n) => w.mem.read(n), store: x.state, now: () => clock.now }); };
  x.open();
  const config = prod.productionConfig(structuredClone(baseConfig.default));
  config.supplier.minimumOffers = 10;
  const contractFile = path.join(dir, "contract.json");
  await fsp.writeFile(contractFile, JSON.stringify(h.ACTIVE_CONTRACT));
  x.cc = (mode = "apply") => { clock.now += 60_000; return prod.runCatalogControls({ sheets: w.sheets, readBook: w.readBook, gateway: x.gateway, config, stamp: new Date(clock.now).toISOString(), mode, contractFile, protection: h.PROTECTION_OK, feedStore: x.feeds }); };
  x.command = async (cmd, id = ID) => { h.setCells(w, id, { [SALE_DECISION]: cmd }); await x.cc(); h.setCells(w, id, { [SALE_DECISION]: `${cmd} ${h.codeOf(w, id, cmd)}` }); return x.cc(); };
  x.file = (k) => path.join(stateDir, encodeURIComponent(k) + ".json");
  x.cpBytes = () => fs.readFileSync(x.file(CK), "utf8");
  x.mirror = () => x.feeds.getJson(REG);
  x.leaseToken = async () => (await x.state.getJsonVersioned(x.leaseKeyOf("sheets-main"))).value?.token ?? 0;
  x.sheetWrites = () => writes(w).length;
  x.dropRoots = async () => { fs.rmSync(x.file(HEAD), { force: true }); await x.feeds.delete(REG); };
  x.protocolA = async () => {
    const [mods, pub] = await Promise.all([prod.loadCatalogControlsModules(), import("../src/pipeline/cc-publisher.mjs")]);
    return x.gateway.ccProtocolA({ feedStore: x.feeds, config, loadBook: () => w.readBook(prod.CC_BOOK_SHEETS), contract: h.ACTIVE_CONTRACT, mods, activeXmlsOf: prod.activeXmlsOf, base: pub.engineeringReadiness(x.gateway, { config }) });
  };
  assert.ok(["COMMITTED", "PENDING"].includes((await x.cc()).state), "передумова: ініціалізація через протокол A");
  return x;
}
/** Уточнення контракту 2.4 / 2.6 для Engineering (R7.4, вимога E-d1): CC викликає serving.status ОДИН раз на запуск — уже після
 *  status, який протокол A виконує при видачі оренди; відповідь для тієї самої оренди має бути та сама (зокрема type "MIGRATION"). */
const E_D1 = "serving.status під тією самою орендою повертає інший результат, ніж при видачі оренди (міграцію вже виконано) — CC не бачить MIGRATION; потрібна вимога E-d1 (handoff R7.4)";
/** R7.4.1 (вимога E-d2, ревю ENG-24 п. d): точку R7.3 без head і дзеркала протокол A не приймає як міграцію — стійка відмова
 *  RECOVERY_PENDING / UNKNOWN в обох коренях; рішень недостовірної точки не приймає ні head, ні дзеркало. */
const E_D2 = "протокол A не відмовляє стійко для точки R7.3 без head і дзеркала (потрібна вимога E-d2: RECOVERY_PENDING / UNKNOWN в head і дзеркалі, точку не прийнято)";
/** Точка формату до R7.3 у файлі FileStore (без epochHigh / leaseId / recovery; версія та сама). */
const legacyFile = (x) => { const f = JSON.parse(x.cpBytes()); for (const k of ["epochHigh", "leaseId", "recovery"]) delete f.value[k]; fs.writeFileSync(x.file(CK), JSON.stringify(f)); };

test("R7.4-a × ENG-24: відкат каталогу W2 файлами (межа епох) → RECOVERY_PENDING / epoch-floor (не BUSY); W2_ONLY у дзеркалі, JOURNAL не оголошено; лічильник оренди не піднято; повтор — той самий id", { skip }, async () => {
  const x = await composed();
  fs.cpSync(x.stateDir, x.stateDir + "-bk", { recursive: true });
  assert.equal((await x.command(HOLD)).state, "COMMITTED");
  fs.rmSync(x.stateDir, { recursive: true, force: true }); fs.cpSync(x.stateDir + "-bk", x.stateDir, { recursive: true }); x.open();
  const t0 = await x.leaseToken(), cp0 = x.cpBytes(), s0 = x.sheetWrites();
  const r = await x.cc();
  assert.deepEqual([r.state, r.detector, r.code], ["RECOVERY_PENDING", "epoch-floor", "RECOVERY_PENDING"], JSON.stringify(r).slice(0, 300));
  assert.equal(r.declared, undefined, "детектор журналу не спрацював — JOURNAL не оголошено");
  const M = await x.mirror();
  assert.deepEqual([M.recovery.state, M.recovery.type], ["RECOVERY_PENDING", "W2_ONLY"]);
  assert.equal(await x.leaseToken(), t0, "лічильник оренди не піднято мовчки");
  assert.equal(x.cpBytes(), cp0, "точку не змінено");
  assert.equal(x.sheetWrites(), s0, "аркуші не змінено");
  const r2 = await x.cc();
  assert.equal(r2.state, "RECOVERY_PENDING");
  assert.equal((await x.mirror()).recovery.id, M.recovery.id, "той самий запис відновлення");
});

test("R7.4-a × ENG-24: чинна оренда іншого записувача на тому ж ресурсі → BUSY / BUSY; відновлення не оголошено; після звільнення — звичайний запуск", { skip }, async () => {
  const x = await composed();
  const other = await x.gateway.committer.acquire("sync");
  const cp0 = x.cpBytes();
  const r = await x.cc();
  assert.deepEqual([r.state, r.code], ["BUSY", "BUSY"], JSON.stringify(r).slice(0, 300));
  assert.notEqual((await x.mirror())?.recovery?.state, "RECOVERY_PENDING", "зайнятість не є відкатом");
  assert.equal(x.cpBytes(), cp0);
  await other.release();
  assert.ok(["COMMITTED", "PENDING"].includes((await x.cc()).state));
});

test("R7.4-d × ENG-24: head і дзеркала немає, точка формату до R7.3 → MIGRATED (точка байт-у-байт та сама, аркуші й коди без змін); наступний запуск — звичайний", { skip }, async () => {
  const x = await composed();
  await x.command(HOLD);
  x.h.setCells(x.w, ID2, { [SALE_DECISION]: HOLD });
  const f = JSON.parse(x.cpBytes());
  for (const k of ["epochHigh", "leaseId", "recovery"]) delete f.value[k];
  fs.writeFileSync(x.file(CK), JSON.stringify(f));
  await x.dropRoots();
  const cp0 = x.cpBytes(), s0 = x.sheetWrites();
  const r = await x.cc();
  assert.equal(r.state, "MIGRATED", (r.state === "COMMITTED" || r.state === "PENDING" ? E_D1 + ": " : "") + JSON.stringify(r).slice(0, 300));
  assert.equal(x.cpBytes(), cp0, "точку не змінено");
  assert.equal(x.sheetWrites(), s0, "аркуші не змінено");
  assert.equal(hasCode(x.w, ID2, HOLD), false, "код не видано");
  const r2 = await x.cc();
  assert.ok(["COMMITTED", "PENDING"].includes(r2.state), JSON.stringify(r2).slice(0, 300));
  assert.ok(hasCode(x.w, ID2, HOLD), "наступний запуск видає код за запитом");
});

test("R7.4.1-d × протокол A (E-d2): head і дзеркала немає, точка має поля протоколу A — не міграція: протокол A стійко відмовляє (RECOVERY_PENDING / UNKNOWN у head і дзеркалі, точку не прийнято); CC у кожному запуску — RECOVERY_PENDING без жодного запису", { skip }, async () => {
  const x = await composed();
  await x.command(HOLD);
  x.h.setCells(x.w, ID2, { [SALE_DECISION]: HOLD });
  await x.dropRoots();
  const cp0 = x.cpBytes(), s0 = x.sheetWrites();
  let id = null;
  for (let i = 1; i <= 3; i++) {
    const r = await x.cc();
    assert.equal(r.state, "RECOVERY_PENDING", `запуск ${i}: ` + (r.state === "COMMITTED" || r.state === "PENDING" ? E_D1 + "; " + E_D2 + ": " : "") + JSON.stringify(r).slice(0, 300));
    assert.equal(r.detector, undefined, `запуск ${i}: відмова — від протоколу A (C2), а не одноразова відмова CC (${r.detector}): ` + E_D2);
    const M = await x.mirror(), H = (await x.state.getJsonVersioned(HEAD)).value;
    assert.deepEqual([M?.recovery?.state, M?.recovery?.type], ["RECOVERY_PENDING", "UNKNOWN"], `запуск ${i}: дзеркало — ` + E_D2);
    assert.deepEqual([H?.recovery?.state, H?.recovery?.type], ["RECOVERY_PENDING", "UNKNOWN"], `запуск ${i}: head — ` + E_D2);
    assert.equal(M.committed ?? null, null, `запуск ${i}: дзеркало не прийняло рішень недостовірної точки`);
    assert.equal(H.cp ?? null, null, `запуск ${i}: head не прийняв точки`);
    assert.ok(!M.migration && !H.migration, `запуск ${i}: позначки міграції немає`);
    if (id === null) id = M.recovery.id;
    assert.equal(M.recovery.id, id, `запуск ${i}: той самий запис відмови (стійка, без нових оголошень)`);
    assert.equal(x.cpBytes(), cp0, `запуск ${i}: точку не змінено`);
    assert.equal(x.sheetWrites(), s0, `запуск ${i}: аркуші не змінено`);
    assert.equal(hasCode(x.w, ID2, HOLD), false, `запуск ${i}: код не видано`);
  }
});

test("R7.4.1-d × протокол A (контракт 2.4 / 2.6, E-d1): serving.status під тією самою орендою стабільний — точка до R7.3: двічі той самий NORMAL / MIGRATION; точка R7.3 без коренів: двічі той самий RECOVERY_PENDING / UNKNOWN", { skip }, async () => {
  for (const legacy of [true, false]) {
    const x = await composed();
    if (legacy) legacyFile(x);
    await x.dropRoots();
    const pa = await x.protocolA(), lease = await pa.committer.acquire(LEASE_SCOPE);
    try {
      const s1 = await pa.serving.status({ lease }), s2 = await pa.serving.status({ lease });
      assert.deepEqual(s2, s1, E_D1 + ": " + JSON.stringify([s1, s2]).slice(0, 400));
      assert.deepEqual([s1.state, s1.type], legacy ? ["NORMAL", "MIGRATION"] : ["RECOVERY_PENDING", "UNKNOWN"], (legacy ? E_D1 : E_D2) + ": " + JSON.stringify(s1));
    } finally { await lease.release(); }
  }
});
