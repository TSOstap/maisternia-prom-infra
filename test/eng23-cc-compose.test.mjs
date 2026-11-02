/** ENG-23 × CC — узгоджений контракт F04 / F06 / F08 (E1–E6) зі СПРАВЖНІМ Catalog Controls (R7.2 через перехідний міст протоколу A),
 *  повним productionConfig, FileStore W2 + WriteGateway, LocalObjectStore, локальним Worker (GET / HEAD). Рядки матриці розд. 8 з
 *  позначкою «композиція», які реалізовні до ревізії CC: F06-1, Q4, F06-6 (міст), пункт 5 доручення (частковий збій W2 / дзеркала),
 *  F08-4, F08-5, вміст дзеркала. Модель — один хост: НЕ доказ поведінки R2 чи розгорнутого Worker. Без модуля CC — пропуск. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ccPresent = fs.existsSync(new URL("../src/core/controls-plan.mjs", import.meta.url)) && fs.existsSync(new URL("../src/pipeline/controls-run.mjs", import.meta.url)) && fs.existsSync(new URL("./helpers/controls.mjs", import.meta.url));
const skip = ccPresent ? false : "модуль Catalog Controls відсутній (до злиття гілок) — композиційна проба";
const ID = "1500000007";
const CK = "state/catalog-controls/checkpoint.json", REG = "state/cc-registry/head.json", HEAD = "state/cc-serving/head.json";
const load = async () => {
  const [prod, store, gw, h, common, seal, yml, sheetSync, sources, local, update, publisher, worker, r2, jcs, run, ccpub, baseConfig] = await Promise.all([
    import("../src/pipeline/production.mjs"), import("../src/pipeline/safe-write/store.mjs"), import("../src/pipeline/safe-write/gateway.mjs"),
    import("./helpers/controls.mjs"), import("../src/core/controls-common.mjs"), import("../src/core/seal.mjs"), import("../src/core/yml.mjs"),
    import("../src/core/sheet-sync.mjs"), import("../src/pipeline/sources.mjs"), import("../src/storage/local.mjs"), import("../src/pipeline/update.mjs"),
    import("../src/publish/publisher.mjs"), import("../worker/src/index.js"), import("./helpers/r2-fake.mjs"), import("../src/pipeline/safe-write/jcs.mjs"),
    import("../src/pipeline/controls-run.mjs"), import("../src/pipeline/cc-publisher.mjs"), import("../config/default.json", { with: { type: "json" } }),
  ]);
  return { prod, FileStore: store.FileStore, WriteGateway: gw.WriteGateway, h, SALE: common.SALE_DECISION, seal, yml, SHEET: sheetSync.SHEET, sources, LocalObjectStore: local.LocalObjectStore, update, manifestKey: publisher.manifestKey, worker: worker.default, r2: r2.r2BindingFrom, jcsHash: jcs.jcsHash, runControls: run.runControls, engineeringReadiness: ccpub.engineeringReadiness, baseConfig: baseConfig.default };
};
async function world(L) {
  const { h } = L;
  const w = await h.prepared();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-e23c-"));
  const clock = { now: h.NOW };
  const stateDir = path.join(dir, "w2");
  const state = new L.FileStore(stateDir);
  const gateway = new L.WriteGateway({ sheets: w.mem, read: (n) => w.mem.read(n), store: state, now: () => clock.now });
  const store = new L.LocalObjectStore(path.join(dir, "objects"));
  const config = L.prod.productionConfig(structuredClone(L.baseConfig));
  config.supplier.minimumOffers = 10;
  const contractFile = path.join(dir, "contract.json");
  await fsp.writeFile(contractFile, JSON.stringify(h.ACTIVE_CONTRACT));
  const cc = (extra = {}) => L.prod.runCatalogControls({ sheets: w.mem, readBook: w.readBook, gateway, config, stamp: new Date(clock.now).toISOString(), mode: "apply", contractFile, protection: h.PROTECTION_OK, feedStore: store, ...extra });
  assert.ok(["COMMITTED", "PENDING"].includes((await cc()).state));
  const catalog = path.join(dir, "catalog"), supplier = path.join(dir, "supplier.xml");
  await L.sources.writeCatalogSnapshot(catalog, { sheets: w.book, groups: w.book[L.SHEET.groups] });
  await fsp.writeFile(supplier, w.xml);
  await store.putJson("approved/main.json", L.seal.approvalManifest(h.mainRows(w), L.yml.objectsFromValues(w.book[L.SHEET.groups], L.seal.GROUP_HEADERS)));
  const controls = await L.prod.loadCatalogControls({ loadBook: async () => structuredClone(w.book), store: state, config, contractFile, feedStore: store });
  const ctx = { store, config, catalog: new L.sources.NdjsonCatalogSource(catalog), supplier: new L.sources.FileSupplierSource(supplier), now: () => clock.now, tmpDir: dir, controls, coordinator: gateway.committer };
  const DEL = `ВИДАЛИТИ ТОВАР ${ID}`;
  const prepareDelete = async () => { h.setCells(w, ID, { [L.SALE]: DEL }); assert.ok(["COMMITTED", "PENDING"].includes((await cc()).state)); h.setCells(w, ID, { [L.SALE]: `${DEL} ${h.codeOf(w, ID, DEL)}` }); };
  const publish = () => L.update.runUpdate(ctx);
  const served = async () => {
    const out = {};
    for (const method of ["GET", "HEAD"]) {
      const r = await L.worker.fetch(new Request("https://local.invalid/feeds/main.xml?key=TEST_E23", { method }), { FEEDS_BUCKET: L.r2(store), FEED_ACCESS_KEY: "TEST_E23", FEEDS: "main" });
      out[method] = { status: r.status, deleted: r.status === 200 && method === "GET" && L.yml.offersById(await r.text()).has(ID) };
    }
    return out;
  };
  const cp = async () => (await state.getJsonVersioned(CK));
  return { w, h, dir, stateDir, clock, state, gateway, store, config, contractFile, cc, controls, prepareDelete, publish, served, cp };
}
const deletedServed = (s) => Object.values(s).some((x) => x.deleted);
// Контракт 2.4 / R7.3: реєстр = { v, ops, pending, aborted, epochHigh, leaseId, recovery? } (без issued і часу запису).
const registryOf = (c) => ({ v: c.v, ops: c.ops, pending: c.pending, aborted: c.aborted, epochHigh: c.epochHigh, leaseId: c.leaseId, ...(c.recovery ? { recovery: c.recovery } : {}) });

test("F06-1 (еквівалент проби Hermes «A bypass»): справжній CC + engineeringReadiness того самого W2 — точку не записано (CC_KEY_SEALED), не COMMITTED; Q4: apply не через протокол A — BLOCKED", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  const before = await x.cp();
  const r = await L.runControls({ sheets: x.w.mem, readBook: x.w.readBook, stamp: new Date(x.clock.now).toISOString(), config: L.prod.ccConfigOf(x.config), contract: x.h.ACTIVE_CONTRACT, protection: x.h.PROTECTION_OK, mode: "apply", readiness: L.engineeringReadiness(x.gateway, { config: x.config }) });
  assert.notEqual(r.state, "COMMITTED", JSON.stringify(r).slice(0, 300));
  assert.deepEqual(await x.cp(), before, "контрольну точку не змінено");
  const removed = (await x.controls.state()).removed.has(ID), s = await x.served();
  assert.ok(!(removed && deletedServed(s)));
  assert.equal(removed, false);
  const q4 = await x.cc({ config: { ...x.config, w2: { required: false } } });
  assert.equal(q4.state, "BLOCKED", JSON.stringify(q4).slice(0, 200));
  assert.match(q4.reason, /лише через протокол A/);
});

test("F06-6 (CC R7.3 сам отримує квиток; моста ENG-23 немає) + вміст дзеркала: кожен запис точки в повному видаленні — з квитком beforeCommit (жодного без); head W2 і дзеркало = h(точки); дзеркало = реєстр за контрактом 2.4; Worker не віддає видаленого", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  const raw = x.state.putJsonIfVersionFenced.bind(x.state), writes = [];
  x.state.putJsonIfVersionFenced = async (k, v, ver, fence) => { if (k === CK) writes.push({ ticket: Boolean(fence?.ticket), phase: fence?.ticket?.phase }); return raw(k, v, ver, fence); };
  let r;
  try { await x.prepareDelete(); r = await x.cc(); } finally { x.state.putJsonIfVersionFenced = raw; }
  assert.equal(r.state, "COMMITTED", JSON.stringify(r).slice(0, 300));
  assert.ok(writes.length >= 2 && writes.every((w) => w.ticket), JSON.stringify(writes));
  const C = await x.cp(), hC = L.jcsHash(C.value);
  const H = (await x.state.getJsonVersioned(HEAD)).value, M = await x.store.getJson(REG);
  assert.equal(H.cp.hash, hC); assert.equal(H.prepared, null);
  assert.equal(M.committed.cpHash, hC); assert.equal(M.prepared, null);
  assert.equal(L.jcsHash(M.committed.registry), L.jcsHash(registryOf(C.value)), "дзеркало = точка без issued");
  assert.ok(M.fence?.epoch >= 1 && /^[0-9a-f]{32}$/.test(M.fence.leaseId), "дзеркало під fencing");
  assert.equal(M.epochHigh, H.epochHigh);
  assert.equal(deletedServed(await x.served()), false);
});

test("Пункт 5 / частковий збій: запис prepared у дзеркало не вдався → квитка немає, точку не записано, НЕ COMMITTED, Worker безпечний; наступний запуск — завершує коміт", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  const before = await x.cp();
  const raw = x.store.putJson.bind(x.store);
  let failed = 0;
  x.store.putJson = async (k, v, o) => { if (k === REG && v?.prepared && !failed) { failed++; throw new Error("synthetic: збій запису дзеркала"); } return raw(k, v, o); };
  let r;
  try { r = await x.cc(); } finally { x.store.putJson = raw; }
  assert.equal(failed, 1, "передумова: збій на prepared дзеркала");
  assert.notEqual(r.state, "COMMITTED", JSON.stringify(r).slice(0, 300));
  assert.deepEqual(await x.cp(), before, "точку не змінено");
  assert.equal((await x.controls.state()).removed.has(ID), false);
  assert.equal(deletedServed(await x.served()), false);
  const r2 = await x.cc();
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2).slice(0, 300));
  assert.ok((await x.controls.state()).removed.has(ID));
  assert.equal(deletedServed(await x.served()), false);
  const C = await x.cp();
  assert.equal((await x.store.getJson(REG)).committed.cpHash, L.jcsHash(C.value));
});

test("Пункт 5 / head W2 не читається / не пишеться → оренди протоколу A немає, НЕ COMMITTED, точку не змінено", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  await x.prepareDelete();
  const before = await x.cp();
  const headFile = path.join(x.stateDir, encodeURIComponent(HEAD) + ".json"), saved = fs.readFileSync(headFile);
  fs.rmSync(headFile); fs.mkdirSync(headFile); // синтетичний збій файлової системи на ключі head
  let r;
  try { r = await x.cc(); } finally { fs.rmSync(headFile, { recursive: true, force: true }); fs.writeFileSync(headFile, saved); }
  assert.notEqual(r.state, "COMMITTED", JSON.stringify(r).slice(0, 300));
  assert.deepEqual(await x.cp(), before);
  assert.equal((await x.cc()).state, "COMMITTED", "після відновлення файлу — коміт");
});

test("F08-5: збій процесу між записом точки й afterCommit — результат НЕ COMMITTED (невідомо), наступна оренда завершує head / дзеркало за prepared → NORMAL, коміт стоїть", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  const raw = x.state.putJsonIfVersionFenced.bind(x.state);
  let crashed = false;
  x.state.putJsonIfVersionFenced = async (k, v, ver, fence) => { const out = await raw(k, v, ver, fence); if (k === CK && !crashed && v?.ops?.length) { crashed = true; throw new Error("synthetic: процес упав після запису точки"); } return out; };
  let r;
  try { r = await x.cc(); } finally { x.state.putJsonIfVersionFenced = raw; }
  assert.ok(crashed);
  assert.notEqual(r.state, "COMMITTED", JSON.stringify(r).slice(0, 300));
  const C1 = await x.cp(), h1 = L.jcsHash(C1.value);
  assert.equal((await x.state.getJsonVersioned(HEAD)).value.prepared?.hash, h1, "head: prepared = записана точка");
  assert.equal((await x.store.getJson(REG)).prepared?.cpHash, h1);
  assert.equal(deletedServed(await x.served()), false, "обслуговування захищене ще до запису точки");
  const r2 = await x.cc();
  assert.ok(["COMMITTED", "PENDING"].includes(r2.state), JSON.stringify(r2).slice(0, 300));
  const C2 = await x.cp(), h2 = L.jcsHash(C2.value), H = (await x.state.getJsonVersioned(HEAD)).value, M = await x.store.getJson(REG);
  assert.equal(H.cp.hash, h2); assert.equal(M.committed.cpHash, h2);
  assert.equal(H.recovery?.state ?? "NORMAL", "NORMAL");
  assert.equal(deletedServed(await x.served()), false);
});

test("Пункт 5 / afterCommit: дзеркало не завершено після запису точки → COMMITTED (точку записано), наступна оренда завершує дзеркало за prepared", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  await x.prepareDelete();
  const raw = x.store.putJson.bind(x.store);
  let failed = 0; // увесь запуск: кожне завершення дзеркала (afterCommit) не вдається (R7.2 пише точку кілька разів за запуск)
  x.store.putJson = async (k, v, o) => { if (k === REG && v?.prepared === null && v?.committed) { const cur = await x.store.getJson(REG); if (cur?.prepared) { failed++; throw new Error("synthetic: afterCommit дзеркала"); } } return raw(k, v, o); };
  let r;
  try { r = await x.cc(); } finally { x.store.putJson = raw; }
  assert.ok(failed >= 1);
  assert.equal(r.state, "COMMITTED", JSON.stringify(r).slice(0, 300));
  const C = await x.cp(), hC = L.jcsHash(C.value);
  assert.notEqual((await x.store.getJson(REG)).committed?.cpHash, hC, "передумова: дзеркало не завершено");
  await x.cc();
  assert.equal((await x.store.getJson(REG)).committed.cpHash, L.jcsHash((await x.cp()).value));
});

test("F08-4: відновлено сховище фідів (дзеркало й маніфест старіші), W2 ціле → дзеркало синхронізовано з head / точкою, обслуговування перевірено (видалений не віддається), кодів не анульовано, NORMAL", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  const snap = path.join(x.dir, "objects-snap");
  fs.cpSync(path.join(x.dir, "objects"), snap, { recursive: true }); // копія сховища фідів ДО видалення (YML з товаром)
  await x.prepareDelete();
  assert.equal((await x.cc()).state, "COMMITTED");
  const issuedBefore = ((await x.cp()).value.issued || []).length;
  fs.rmSync(path.join(x.dir, "objects"), { recursive: true, force: true });
  fs.cpSync(snap, path.join(x.dir, "objects"), { recursive: true });
  assert.equal(deletedServed(await x.served()), true, "передумова: відновлений YML містить видалений товар");
  const r = await x.cc();
  assert.notEqual(r.state, "BUSY", JSON.stringify(r).slice(0, 300));
  const C = await x.cp();
  const M = await x.store.getJson(REG);
  assert.equal(M.committed.cpHash, L.jcsHash(C.value), "дзеркало синхронізовано");
  assert.equal(M.recovery?.state, "NORMAL");
  assert.equal(deletedServed(await x.served()), false, "обслуговування — перевірено / знято");
  assert.ok((C.value.issued || []).length >= issuedBefore - 1, "коди не анульовано відновленням сховища фідів");
});
