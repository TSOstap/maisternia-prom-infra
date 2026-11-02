/** ENG-24 × CC R7.3 — наскрізні сценарії узгодженого контракту F04 / F06 / F08 (розд. 2.6, 3, 5, 8): відновлення cc-recovery-v1
 *  (E8), блокування публікації й відкату під час відновлення (E7), детектор журналу → declareRecovery, serving.recovery() з prepared /
 *  fromHash, єдиний шлях запису точки (моста ENG-23 немає). СПРАВЖНІЙ CC (потрібен recoverCheckpoint — R7.3), повний productionConfig,
 *  FileStore W2, LocalObjectStore, локальний Worker (GET / HEAD). Відновлення сховищ — файлами поза API (поза моделлю загроз, Q6).
 *  503 — лише синтетика (Q3). Без модуля CC R7.3 — пропуск. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ccFiles = ["../src/core/controls-plan.mjs", "../src/pipeline/controls-run.mjs", "./helpers/controls.mjs"].every((p) => fs.existsSync(new URL(p, import.meta.url)));
const r73 = ccFiles && /export function recoverCheckpoint/.test(fs.readFileSync(new URL("../src/core/controls-plan.mjs", import.meta.url), "utf8"));
const skip = r73 ? false : "модуль Catalog Controls R7.3 (recoverCheckpoint) відсутній — композиційна проба";
const ID = "1500000007";
const CK = "state/catalog-controls/checkpoint.json", REG = "state/cc-registry/head.json", HEAD = "state/cc-serving/head.json";
const load = async () => {
  const [prod, store, gw, h, common, seal, yml, sheetSync, sources, local, update, publisher, worker, r2, jcs, recovery, committer, ccpub, baseConfig] = await Promise.all([
    import("../src/pipeline/production.mjs"), import("../src/pipeline/safe-write/store.mjs"), import("../src/pipeline/safe-write/gateway.mjs"),
    import("./helpers/controls.mjs"), import("../src/core/controls-common.mjs"), import("../src/core/seal.mjs"), import("../src/core/yml.mjs"),
    import("../src/core/sheet-sync.mjs"), import("../src/pipeline/sources.mjs"), import("../src/storage/local.mjs"), import("../src/pipeline/update.mjs"),
    import("../src/publish/publisher.mjs"), import("../worker/src/index.js"), import("./helpers/r2-fake.mjs"), import("../src/pipeline/safe-write/jcs.mjs"),
    import("../src/pipeline/recovery.mjs"), import("../src/pipeline/safe-write/committer.mjs"), import("../src/pipeline/cc-publisher.mjs"), import("../config/default.json", { with: { type: "json" } }),
  ]);
  return { prod, FileStore: store.FileStore, WriteGateway: gw.WriteGateway, h, SALE: common.SALE_DECISION, seal, yml, SHEET: sheetSync.SHEET, sources, LocalObjectStore: local.LocalObjectStore, update, publisher, worker: worker.default, r2: r2.r2BindingFrom, jcsHash: jcs.jcsHash, rec: recovery, createCommitter: committer.createCommitter, leaseKeyOf: committer.leaseKeyOf, engineeringReadiness: ccpub.engineeringReadiness, baseConfig: baseConfig.default };
};
async function world(L) {
  const { h } = L;
  const w = await h.prepared();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-e24-"));
  const clock = { now: h.NOW };
  const stateDir = path.join(dir, "w2"), objDir = path.join(dir, "objects");
  let state = new L.FileStore(stateDir), gateway = new L.WriteGateway({ sheets: w.mem, read: (n) => w.mem.read(n), store: state, now: () => clock.now });
  const store = new L.LocalObjectStore(objDir);
  const config = L.prod.productionConfig(structuredClone(L.baseConfig));
  config.supplier.minimumOffers = 10;
  const contractFile = path.join(dir, "contract.json");
  await fsp.writeFile(contractFile, JSON.stringify(h.ACTIVE_CONTRACT));
  const x = { w, h, dir, stateDir, objDir, clock, store, config, contractFile };
  // Новий «процес» над тим самим каталогом W2 (після відновлення файлів — нові екземпляри сховища й шлюзу).
  x.reopen = () => { state = new L.FileStore(stateDir); gateway = new L.WriteGateway({ sheets: w.mem, read: (n) => w.mem.read(n), store: state, now: () => clock.now }); x.state = state; x.gateway = gateway; x.ctx.coordinator = gateway.committer; };
  x.state = state; x.gateway = gateway;
  x.cc = (mode = "apply") => { clock.now += 60_000; return L.prod.runCatalogControls({ sheets: w.mem, readBook: w.readBook, gateway: x.gateway, config, stamp: new Date(clock.now).toISOString(), mode, contractFile, protection: h.PROTECTION_OK, feedStore: store }); };
  assert.ok(["COMMITTED", "PENDING"].includes((await x.cc()).state));
  const catalog = path.join(dir, "catalog"), supplier = path.join(dir, "supplier.xml");
  await L.sources.writeCatalogSnapshot(catalog, { sheets: w.book, groups: w.book[L.SHEET.groups] });
  await fsp.writeFile(supplier, w.xml);
  await store.putJson("approved/main.json", L.seal.approvalManifest(h.mainRows(w), L.yml.objectsFromValues(w.book[L.SHEET.groups], L.seal.GROUP_HEADERS)));
  x.controls = await L.prod.loadCatalogControls({ loadBook: async () => structuredClone(w.book), store: { getJsonVersioned: (k) => x.state.getJsonVersioned(k) }, config, contractFile, feedStore: store });
  x.ctx = { store, config, catalog: new L.sources.NdjsonCatalogSource(catalog), supplier: new L.sources.FileSupplierSource(supplier), now: () => clock.now, tmpDir: dir, controls: x.controls, coordinator: gateway.committer };
  x.publish = () => { clock.now += 60_000; return L.update.runUpdate(x.ctx); };
  x.bump = (d = 1) => fsp.writeFile(supplier, w.xml.replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + d) + b));
  x.command = async (cmd, id = ID) => { h.setCells(w, id, { [L.SALE]: cmd }); const r1 = await x.cc(); h.setCells(w, id, { [L.SALE]: `${cmd} ${h.codeOf(w, id, cmd)}` }); return { r1, r2: await x.cc() }; };
  x.served = async () => {
    const out = {};
    for (const method of ["GET", "HEAD"]) {
      const r = await L.worker.fetch(new Request("https://local.invalid/feeds/main.xml?key=TEST_E24", { method }), { FEEDS_BUCKET: L.r2(store), FEED_ACCESS_KEY: "TEST_E24", FEEDS: "main" });
      const xml = r.status === 200 && method === "GET" ? await r.text() : "";
      out[method] = { status: r.status, deleted: Boolean(xml) && L.yml.offersById(xml).has(ID), availableTrue: Boolean(xml) && new RegExp(`<offer id="${ID}"[^>]*available="true"`).test(xml) };
    }
    return out;
  };
  // Ідентифікатори, доступні (available="true") у фактично обслуговуваному YML (Worker GET).
  x.availableIds = async () => {
    const r = await L.worker.fetch(new Request("https://local.invalid/feeds/main.xml?key=TEST_E24"), { FEEDS_BUCKET: L.r2(store), FEED_ACCESS_KEY: "TEST_E24", FEEDS: "main" });
    return r.status === 200 ? new Set([...(await r.text()).matchAll(/<offer id="(\d+)"[^>]*available="true"/g)].map((m) => m[1])) : new Set();
  };
  x.cp = async () => (await x.state.getJsonVersioned(CK));
  x.mirror = () => store.getJson(REG);
  x.manifest = () => store.getJson(L.publisher.manifestKey("main"));
  x.snapshot = (name, dirs = ["w2"]) => { for (const d of dirs) fs.cpSync(path.join(dir, d), path.join(dir, name + "-" + d), { recursive: true }); };
  x.restore = (name, dirs = ["w2"]) => { for (const d of dirs) { fs.rmSync(path.join(dir, d), { recursive: true, force: true }); fs.cpSync(path.join(dir, name + "-" + d), path.join(dir, d), { recursive: true }); } x.reopen(); };
  x.feeds = config.feeds.filter((f) => f.enabled !== false).map((f) => f.name);
  x.recover = async ({ by = "Власник (тест)", confirm } = {}) => {
    const { recovery } = await L.rec.readRecovery(store);
    await L.rec.authorizeRecover({ feedStore: store, id: recovery.id, authorizedBy: by, confirm: confirm ?? L.rec.confirmationFor(recovery.id) });
    return L.rec.establishFloor({ feedStore: store, w2Store: x.state, committer: L.createCommitter({ store: x.state, now: () => clock.now }), feeds: x.feeds });
  };
  x.protocolA = async () => {
    const mods = await L.prod.loadCatalogControlsModules();
    return x.gateway.ccProtocolA({ feedStore: store, config, loadBook: () => w.readBook(L.prod.CC_BOOK_SHEETS), contract: h.ACTIVE_CONTRACT, mods, activeXmlsOf: L.prod.activeXmlsOf, base: L.engineeringReadiness(x.gateway, { config }) });
  };
  return x;
}
const deletedServed = (s) => Object.values(s).some((v) => v.deleted);

test("E8 / CP_ONLY (F08-2): відновлену файлом точку виявлено → RECOVERY_PENDING; публікація й відкат заблоковані; Worker без видаленого; без дозволу — recover не виконується; з дозволом власника й межею — RECOVERED, рішення після копії з дзеркала, NORMAL нового покоління", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  const cpFile = path.join(x.stateDir, encodeURIComponent(CK) + ".json"), before = fs.readFileSync(cpFile);
  const del = await x.command(`ВИДАЛИТИ ТОВАР ${ID}`);
  assert.equal(del.r2.state, "COMMITTED", JSON.stringify(del.r2).slice(0, 300));
  assert.ok((await x.controls.state()).removed.has(ID));
  const manifestBefore = await x.manifest();
  // Відновлення лише точки — файлом (через API неможливо: CC_KEY_SEALED, ENG-23).
  fs.writeFileSync(cpFile, before);
  const r = await x.cc();
  assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
  const M = await x.mirror();
  assert.equal(M.recovery.state, "RECOVERY_PENDING");
  assert.equal(M.recovery.type, "CP_ONLY");
  assert.equal(deletedServed(await x.served()), false, "обслуговування — щодо найсуворішого стану (реєстр із видаленням)");
  // E7: публікація й відкат заблоковані.
  await x.bump(3);
  const m0 = await x.manifest();
  const u = await x.publish();
  assert.equal(u.feeds[0].state, "RECOVERY_PENDING", JSON.stringify(u.feeds[0]).slice(0, 300));
  const m1 = await x.manifest();
  assert.equal(m1.active?.key ?? null, m0.active?.key ?? null, "нової версії не опубліковано");
  assert.equal((m1.history || []).length, (m0.history || []).length);
  void manifestBefore;
  await assert.rejects(L.update.guardedRollback({ store: x.store, feed: "main", controls: x.controls, coordinator: x.gateway.committer }), (e) => e.code === "RECOVERY_PENDING");
  assert.equal(deletedServed(await x.served()), false);
  // Без дозволу власника recover не виконується; дозвіл — лише з точним id і підтвердженням.
  assert.equal((await x.cc("recover")).state, "RECOVERY_PENDING");
  await assert.rejects(x.recover({ confirm: "ВІДНОВИТИ невірно" }), (e) => e.code === "RECOVERY_NOT_AUTHORIZED");
  await assert.rejects(L.rec.establishFloor({ feedStore: x.store, w2Store: x.state, committer: L.createCommitter({ store: x.state }), feeds: x.feeds }), (e) => e.code === "RECOVERY_NOT_AUTHORIZED");
  const fl = await x.recover();
  assert.ok(Number.isInteger(fl.generation) && fl.generation >= 1);
  // serving.recovery(): prepared / fromHash / floorProven — для оренди нового покоління.
  const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
  try {
    const sv = await pa.serving.status({ lease });
    assert.equal(sv.state, "RECOVERY_AUTHORIZED");
    const rv = await pa.serving.recovery({ lease });
    assert.equal(rv.floorProven, true);
    assert.equal(rv.type, "CP_ONLY");
    assert.equal(rv.fromHash, L.jcsHash((await x.cp()).value));
    assert.deepEqual(rv.registry, (await x.mirror()).committed.registry);
    assert.ok("prepared" in rv);
    assert.equal(typeof pa.store.putJsonIfVersionFenced, "undefined", "паралельного шляху запису точки немає");
    await assert.rejects(pa.store.putJsonIfVersion(CK, { v: 1 }, (await x.cp()).version, { lease: { scope: "catalog-controls", token: lease.token, leaseId: lease.leaseId } }), (e) => e.code === "CC_KEY_SEALED", "без квитка — запечатано");
  } finally { await lease.release(); }
  assert.equal((await x.cc()).state, "RECOVERY_PENDING", "apply у RECOVERY_AUTHORIZED нічого не пише (C2)");
  const rr = await x.cc("recover");
  assert.equal(rr.state, "RECOVERED", JSON.stringify(rr).slice(0, 400));
  const M2 = await x.mirror(), H2 = (await x.state.getJsonVersioned(HEAD)).value, C2 = await x.cp();
  assert.equal(M2.recovery.state, "NORMAL");
  assert.equal(M2.recovery.lastRecovery.type, "CP_ONLY");
  assert.equal(M2.generation, fl.generation); assert.equal(H2.generation, fl.generation);
  assert.equal(M2.committed.cpHash, L.jcsHash(C2.value)); assert.equal(H2.cp.hash, L.jcsHash(C2.value)); assert.equal(H2.recovery, null);
  assert.equal(C2.value.recovery.generation, fl.generation);
  assert.ok((await x.controls.state()).removed.has(ID), "видалення після копії не скасовано (дзеркало реєстру)");
  // Після відновлення — звичайна робота: публікація без видаленого.
  const u2 = await x.publish();
  assert.ok(["PUBLISHED", "REUSED"].includes(u2.feeds[0].state), JSON.stringify(u2.feeds[0]).slice(0, 300));
  assert.equal(deletedServed(await x.served()), false);
});

test("E8 / W2_ONLY (F08-3): відкат каталогу W2 файлами → оренди немає (межа епох), відновлення оголошено автоматично; без дозволу — BLOCK; дозвіл + межа (лічильник піднято лише процедурою) → RECOVERED; рішення після копії діють; невикористаний код старої гілки недійсний", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  x.snapshot("bk");
  const hold = await x.command("ЗНЯТИ З ПРОДАЖУ");
  assert.equal(hold.r2.state, "COMMITTED");
  assert.ok((await x.controls.state()).held.has(ID));
  // Нова видача коду (не використано) — у втраченій гілці.
  x.h.setCells(x.w, ID, { [L.SALE]: `ВИДАЛИТИ ТОВАР ${ID}` });
  await x.cc();
  const lostCode = x.h.codeOf(x.w, ID, `ВИДАЛИТИ ТОВАР ${ID}`);
  assert.ok(lostCode);
  x.restore("bk");
  const leaseRec = async () => (await x.state.getJsonVersioned(L.leaseKeyOf("sheets-main"))).value;
  const t0 = (await leaseRec()).token;
  const r = await x.cc();
  // ENG-26 (CC R7.4, п. a): відкат W2 → RECOVERY_PENDING / epoch-floor (не BUSY); причина Engineering збережена.
  assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
  assert.equal(r.detector, "epoch-floor");
  assert.match(r.reason, /RECOVERY_PENDING/);
  assert.equal((await leaseRec()).token, t0, "лічильник не піднято мовчки");
  const M = await x.mirror();
  assert.equal(M.recovery.state, "RECOVERY_PENDING"); assert.equal(M.recovery.type, "W2_ONLY");
  await assert.rejects(L.update.guardedRollback({ store: x.store, feed: "main", controls: x.controls, coordinator: x.gateway.committer }), (e) => e.code === "RECOVERY_PENDING");
  const u = await x.publish();
  assert.notEqual(u.feeds[0].state, "PUBLISHED");
  const rr0 = await x.cc("recover");
  assert.deepEqual([rr0.state, rr0.detector], ["RECOVERY_PENDING", "epoch-floor"], "без дозволу й межі — оренди немає");
  const fl = await x.recover();
  assert.ok((await leaseRec()).token >= fl.floor);
  const rr = await x.cc("recover");
  assert.equal(rr.state, "RECOVERED", JSON.stringify(rr).slice(0, 400));
  assert.ok((await x.controls.state()).held.has(ID), "зняття з продажу після копії не скасовано");
  // Невикористаний код старої гілки — недійсний: команда з ним не виконує видалення.
  x.h.setCells(x.w, ID, { [L.SALE]: `ВИДАЛИТИ ТОВАР ${ID} ${lostCode}` });
  const r2 = await x.cc();
  assert.notEqual((await x.controls.state()).removed.has(ID), true, "старий код не авторизує: " + JSON.stringify(r2).slice(0, 200));
  assert.equal((await x.mirror()).recovery.state, "NORMAL");
});

test("Пункт 4 / Q2: детектор журналу CC (рядок «Історії керування» без прив'язки після повного відкату W2 + фідів) → системний declareRecovery(JOURNAL); CC, публікація й відкат заблоковані; дозвіл власника не відкриває (межу не доведено без незалежного координатора — BLOCK); зняття діє в обслуговуванні", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  // Товар, доступний у постачальника (у синтетиці частина недоступна): саме для нього зняття видно в YML.
  const main = new Set(x.h.mainRows(x.w).map((row) => String(row["Offer ID"])));
  const HID = [...(await x.availableIds())].find((id) => main.has(id) && id !== ID);
  assert.ok(HID, "передумова: є доступний товар");
  x.snapshot("full", ["w2", "objects"]);
  const hold = await x.command("ЗНЯТИ З ПРОДАЖУ", HID);
  assert.equal(hold.r2.state, "COMMITTED");
  assert.equal((await x.availableIds()).has(HID), false);
  x.restore("full", ["w2", "objects"]); // повний відкат W2 + фідів + точки; аркуші (журнал) — новіші
  assert.equal((await x.availableIds()).has(HID), true, "передумова: після відкату фідів знятий знову доступний");
  const r = await x.cc();
  assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
  assert.equal(r.detector, "journal");
  assert.equal(r.declared?.type, "JOURNAL", JSON.stringify(r.declared));
  const M = await x.mirror();
  assert.equal(M.recovery.state, "RECOVERY_PENDING"); assert.equal(M.recovery.type, "JOURNAL"); assert.equal(M.recovery.declaredBy, "cc-journal-detector");
  // Захищені дії заблоковані.
  assert.equal((await x.cc()).state, "RECOVERY_PENDING");
  const u = await x.publish();
  assert.equal(u.feeds[0].state, "RECOVERY_PENDING", JSON.stringify(u.feeds[0]).slice(0, 300));
  await assert.rejects(L.update.guardedRollback({ store: x.store, feed: "main", controls: x.controls, coordinator: x.gateway.committer }), (e) => e.code === "RECOVERY_PENDING");
  assert.equal((await x.availableIds()).has(HID), false, "зняття лише в журналі — діє в обслуговуванні одразу після виявлення");
  // ENG-25 (e1): дозвіл власника фіксується лише як ownerAck, блокування не знімає (FLOOR_NOT_PROVEN, стан RECOVERY_PENDING);
  // establishFloor — FLOOR_NOT_PROVEN, лічильник оренди не змінено; recover — RECOVERY_PENDING.
  const { recovery } = await L.rec.readRecovery(x.store);
  await assert.rejects(L.rec.authorizeRecover({ feedStore: x.store, id: recovery.id, authorizedBy: "Власник (тест)", confirm: L.rec.confirmationFor(recovery.id) }), (e) => e.code === "FLOOR_NOT_PROVEN");
  const ack = (await x.mirror()).recovery;
  assert.equal(ack.state, "RECOVERY_PENDING"); assert.equal(ack.ownerAck.by, "Власник (тест)"); assert.equal(ack.id, recovery.id);
  const leaseTok = async () => (await x.state.getJsonVersioned(L.leaseKeyOf("sheets-main"))).value.token;
  const tok0 = await leaseTok();
  await assert.rejects(L.rec.establishFloor({ feedStore: x.store, w2Store: x.state, committer: L.createCommitter({ store: x.state }), feeds: x.feeds }), (e) => e.code === "FLOOR_NOT_PROVEN");
  assert.equal(await leaseTok(), tok0, "лічильник оренди не змінено");
  // Захист у глибину на боці Engineering: recovery() не підтверджує межу; beforeCommit(phase "recover") квитка не видає.
  const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
  try {
    assert.equal((await pa.serving.status({ lease })).state, "RECOVERY_PENDING");
    assert.equal((await pa.serving.recovery({ lease })).floorProven, false);
    const C = await x.cp();
    const g = await pa.serving.beforeCommit({ phase: "recover", lease: { token: lease.token, leaseId: lease.leaseId, scope: "catalog-controls", generation: lease.generation }, cp: { expectedVersion: C.version, next: { ...C.value, epochHigh: lease.token, leaseId: lease.leaseId } }, state: null, registry: null });
    assert.equal(g.ok, false); assert.equal(g.code, "RECOVERY_NOT_AUTHORIZED");
    const g2 = await pa.serving.beforeCommit({ phase: "intents", lease: { token: lease.token, leaseId: lease.leaseId, scope: "catalog-controls", generation: lease.generation }, cp: { expectedVersion: C.version, next: { ...C.value, epochHigh: lease.token, leaseId: lease.leaseId } }, state: null, registry: null });
    assert.equal(g2.ok, false); assert.equal(g2.code, "RECOVERY_PENDING", "звичайні фази — лише в NORMAL");
  } finally { await lease.release(); }
  const rr = await x.cc("recover");
  assert.equal(rr.state, "RECOVERY_PENDING", JSON.stringify(rr).slice(0, 300));
  assert.equal((await x.mirror()).recovery.state, "RECOVERY_PENDING");
});

test("E7 / розд. 3 крок 2: під час відновлення обслуговування — щодо найсуворішого стану (точка ∪ реєстр ∪ prepared): небезпечну обслуговувану версію (фід відновлено файлами) прибрано одразу при виявленні й знову — на кожній оренді протоколу A; без найсуворішої проєкції (CC без recoverCheckpoint) — зняття всіх фідів (503, синтетика Q3)", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  const cpFile = path.join(x.stateDir, encodeURIComponent(CK) + ".json"), before = fs.readFileSync(cpFile);
  x.snapshot("pre", ["objects"]);
  const del = await x.command(`ВИДАЛИТИ ТОВАР ${ID}`);
  assert.equal(del.r2.state, "COMMITTED", JSON.stringify(del.r2).slice(0, 300));
  assert.equal(deletedServed(await x.served()), false);
  // Відновлення файлами поза API (Q6): точка — на копію до видалення (CP_ONLY); каталог фіду — на версію з offer. Дзеркало й head — ні.
  const feedDir = path.join(x.objDir, "feeds", "main");
  const restoreFeed = () => { fs.rmSync(feedDir, { recursive: true, force: true }); fs.cpSync(path.join(x.dir, "pre-objects", "feeds", "main"), feedDir, { recursive: true }); };
  fs.writeFileSync(cpFile, before);
  restoreFeed();
  assert.equal(deletedServed(await x.served()), true, "передумова: обслуговувана версія небезпечна");
  // Перше виявлення — сама оренда протоколу A (status у acquire), без подальших викликів: захист — уже при виявленні.
  const pa0 = await x.protocolA(), l0 = await pa0.committer.acquire("catalog-controls");
  try { assert.equal(l0 && (await x.mirror()).recovery.type, "CP_ONLY"); } finally { await l0.release(); }
  assert.equal(deletedServed(await x.served()), false, "виявлення → одразу захист щодо найсуворішого стану (реєстр дзеркала з видаленням)");
  const r = await x.cc();
  assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
  // Знову небезпечна версія (ще одне відновлення файлом) → наступна оренда протоколу A (стан відновлення стійкий) знову захищає.
  restoreFeed();
  assert.equal(deletedServed(await x.served()), true);
  assert.equal((await x.cc()).state, "RECOVERY_PENDING");
  assert.equal(deletedServed(await x.served()), false, "кожна оренда під час відновлення перевіряє обслуговування");
  // Без найсуворішої проєкції — не «довіряти» обслуговуваному, а зняти всі фіди.
  restoreFeed();
  const mods = await L.prod.loadCatalogControlsModules();
  const pa = x.gateway.ccProtocolA({ feedStore: x.store, config: x.config, loadBook: () => x.w.readBook(L.prod.CC_BOOK_SHEETS), contract: x.h.ACTIVE_CONTRACT, mods: { ...mods, plan: { ...mods.plan, recoverCheckpoint: undefined } }, activeXmlsOf: L.prod.activeXmlsOf, base: L.engineeringReadiness(x.gateway, { config: x.config }) });
  const lease = await pa.committer.acquire("catalog-controls");
  try { assert.equal((await pa.serving.status({ lease })).state, "RECOVERY_PENDING"); } finally { await lease.release(); }
  const s = await x.served();
  assert.equal(s.GET.status, 503); assert.equal(s.HEAD.status, 503);
});

test("E8 / межа й покоління: W2 відкочено ВЖЕ після establishFloor (запис оренди старого покоління) → recover не виконується (оренда не того покоління, floorProven:false); повторний establishFloor піднімає межу й покоління (лише вгору) → RECOVERED у новішому поколінні; незавершений prepared (збій після beforeCommit) — у recovery(); recover не через протокол A — BLOCKED", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  const cpFile = path.join(x.stateDir, encodeURIComponent(CK) + ".json"), before = fs.readFileSync(cpFile);
  assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
  // Збій процесу після beforeCommit (квиток видано, точку не записано): prepared — у head W2 і дзеркалі.
  { const pa0 = await x.protocolA(), l0 = await pa0.committer.acquire("catalog-controls");
    try {
      const C = await x.cp();
      const g = await pa0.serving.beforeCommit({ phase: "intents", lease: { token: l0.token, leaseId: l0.leaseId, scope: "catalog-controls", generation: l0.generation }, cp: { expectedVersion: C.version, next: { ...C.value, epochHigh: l0.token, leaseId: l0.leaseId, at: new Date(x.clock.now + 1).toISOString() } }, state: null, registry: null });
      assert.equal(g.ok, true, JSON.stringify(g).slice(0, 300));
    } finally { await l0.release(); } }
  const P = (await x.mirror()).prepared;
  assert.ok(P?.registry && P.cpHash);
  fs.writeFileSync(cpFile, before);
  assert.equal((await x.cc()).state, "RECOVERY_PENDING");
  assert.equal((await x.mirror()).recovery.type, "CP_ONLY");
  const { recovery } = await L.rec.readRecovery(x.store);
  await L.rec.authorizeRecover({ feedStore: x.store, id: recovery.id, authorizedBy: "Власник (тест)", confirm: L.rec.confirmationFor(recovery.id) });
  x.snapshot("preFloor");
  const committer = () => L.createCommitter({ store: x.state, now: () => x.clock.now });
  const fl1 = await L.rec.establishFloor({ feedStore: x.store, w2Store: x.state, committer: committer(), feeds: x.feeds });
  // Відкат W2 файлами на копію до кроку 3 (поза API, Q6): запис оренди — старого покоління.
  x.restore("preFloor");
  const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
  try {
    assert.notEqual(lease.generation, fl1.generation);
    assert.equal((await pa.serving.recovery({ lease })).floorProven, false, "межу встановлено для іншого покоління");
  } finally { await lease.release(); }
  const r1 = await x.cc("recover");
  assert.equal(r1.state, "RECOVERY_PENDING", JSON.stringify(r1).slice(0, 300));
  assert.equal((await x.mirror()).recovery.state, "RECOVERY_AUTHORIZED");
  const fl2 = await L.rec.establishFloor({ feedStore: x.store, w2Store: x.state, committer: committer(), feeds: x.feeds });
  assert.ok(fl2.generation > fl1.generation && fl2.floor >= fl1.floor, JSON.stringify({ fl1, fl2 }));
  assert.deepEqual(await L.rec.establishFloor({ feedStore: x.store, w2Store: x.state, committer: committer(), feeds: x.feeds }), fl2, "повтор без відкату — та сама межа");
  const pa2 = await x.protocolA(), l2 = await pa2.committer.acquire("catalog-controls");
  try {
    const rv = await pa2.serving.recovery({ lease: l2 });
    assert.equal(rv.floorProven, true);
    assert.deepEqual(rv.prepared, P.registry, "незавершений prepared дзеркала — у recovery() (для recoverCheckpoint CC)");
  } finally { await l2.release(); }
  x.clock.now += 60_000;
  const noA = await L.prod.runCatalogControls({ sheets: x.w.mem, readBook: x.w.readBook, gateway: x.gateway, config: { ...x.config, w2: { ...x.config.w2, required: false } }, stamp: new Date(x.clock.now).toISOString(), mode: "recover", contractFile: x.contractFile, protection: x.h.PROTECTION_OK, feedStore: x.store });
  assert.equal(noA.state, "BLOCKED", JSON.stringify(noA).slice(0, 300));
  assert.equal((await x.mirror()).recovery.state, "RECOVERY_AUTHORIZED");
  const r2 = await x.cc("recover");
  assert.equal(r2.state, "RECOVERED", JSON.stringify(r2).slice(0, 300));
  const M = await x.mirror();
  assert.equal(M.recovery.state, "NORMAL"); assert.equal(M.generation, fl2.generation); assert.equal(M.prepared, null);
  assert.ok((await x.controls.state()).removed.has(ID), "рішення після копії — з дзеркала");
  assert.equal(deletedServed(await x.served()), false);
  // NORMAL: запис точки — лише з квитком І під заявленою чинною орендою протоколу A (інший leaseId — відмова, точку не записано).
  const pa3 = await x.protocolA(), l3 = await pa3.committer.acquire("catalog-controls");
  try {
    const C = await x.cp(), next = { ...C.value, epochHigh: l3.token, leaseId: l3.leaseId, at: new Date(x.clock.now + 2).toISOString() };
    const g = await pa3.serving.beforeCommit({ phase: "intents", lease: { token: l3.token, leaseId: l3.leaseId, scope: "catalog-controls", generation: l3.generation }, cp: { expectedVersion: C.version, next }, state: null, registry: null });
    assert.equal(g.ok, true, JSON.stringify(g).slice(0, 300));
    await assert.rejects(pa3.store.putJsonIfVersion(CK, next, C.version, { lease: { scope: "catalog-controls", token: l3.token, leaseId: "f".repeat(32) }, ticket: g.ticket }), (e) => e.code === "CC_TICKET_REJECTED");
    assert.equal((await x.cp()).version, C.version, "точку не записано");
  } finally { await l3.release(); }
});
