/** ENG-25 × CC R7.3 — наскрізні сценарії після ревю Hermes ENG-24 (N1) і висновків Catalog (розд. 11, b–e):
 *   N1 — псевдонім запечатаних ключів через публічний API не пише точку / head; підроблена файлами точка (поза моделлю, Q6) не потрапляє
 *        в дзеркало рішень і не скасовує ухваленого видалення;
 *   b  — захист обслуговування за найсуворішим із (власна проєкція Engineering, переданий CC стан);
 *   c  — стан відновлення H ↔ M: синхронізація лише вгору, суперечність id → UNKNOWN, F_ONLY не скидає;
 *   d  — MIGRATION лише для точки формату до R7.3 після захищеного обслуговування; утрата / недійсність коренів — не міграція;
 *   e  — JOURNAL / FULL: дозвіл не знімає блокування, ескалація типу, фактичний режим обслуговування у звіті.
 *  СПРАВЖНІЙ CC (R7.3), повний productionConfig, FileStore W2, LocalObjectStore, локальний Worker. Відновлення / підробка сховищ —
 *  файлами поза API (поза моделлю загроз, Q6). 503 — лише синтетика (Q3). Без модуля CC R7.3 — пропуск. Модель — один хост. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ccFiles = ["../src/core/controls-plan.mjs", "../src/pipeline/controls-run.mjs", "./helpers/controls.mjs"].every((p) => fs.existsSync(new URL(p, import.meta.url)));
const r73 = ccFiles && /export function recoverCheckpoint/.test(fs.readFileSync(new URL("../src/core/controls-plan.mjs", import.meta.url), "utf8"));
const skip = r73 ? false : "модуль Catalog Controls R7.3 (recoverCheckpoint) відсутній — композиційна проба";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  x.protocolA = async (over = {}) => {
    const mods = await L.prod.loadCatalogControlsModules();
    return x.gateway.ccProtocolA({ feedStore: store, config, loadBook: () => w.readBook(L.prod.CC_BOOK_SHEETS), contract: h.ACTIVE_CONTRACT, mods, activeXmlsOf: L.prod.activeXmlsOf, base: L.engineeringReadiness(x.gateway, { config }), ...over });
  };
  return x;
}
const deletedServed = (s) => Object.values(s).some((v) => v.deleted);


const file = (x, key) => path.join(x.stateDir, encodeURIComponent(key) + ".json");
const readFileRec = (x, key) => JSON.parse(fs.readFileSync(file(x, key), "utf8"));
const writeFileRec = (x, key, rec) => fs.writeFileSync(file(x, key), JSON.stringify(rec));
const headRec = async (x) => (await x.state.getJsonVersioned(HEAD)).value?.recovery ?? null;
/** Перший товар, доступний у постачальника (у синтетиці частина недоступна). */
async function availableProduct(x, exclude = []) {
  const main = new Set(x.h.mainRows(x.w).map((r) => String(r["Offer ID"])));
  return [...(await x.availableIds())].find((id) => main.has(id) && id !== ID && !exclude.includes(id));
}
/** Обгортка сховища фідів для синтетичних відмов (лише лабораторія): versions(n) → відмова n-го запису версії; withdraw → відмова зняття. */
function wrapFeeds(store, rules = {}) {
  let n = 0;
  return new Proxy(store, {
    get(t, p) {
      if (p === "put") return async (key, body, meta) => { if (String(key).includes("/versions/") && rules.versions?.(++n)) throw new Error("синтетична відмова запису версії"); return t.put(key, body, meta); };
      if (p === "putJson") return async (key, value, opts) => { if (rules.withdraw && /\/manifest\.json$/.test(key) && value?.withdrawn) throw new Error("синтетична відмова зняття фіду"); return t.putJson(key, value, opts); };
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
const offerXml = (xml, id) => new RegExp(`<offer id="${id}"[\\s\\S]*?</offer>`).exec(xml)?.[0] ?? null;
async function servedXml(L, x) {
  const r = await L.worker.fetch(new Request("https://local.invalid/feeds/main.xml?key=TEST_E24"), { FEEDS_BUCKET: L.r2(x.store), FEED_ACCESS_KEY: "TEST_E24", FEEDS: "main" });
  return r.status === 200 ? await r.text() : "";
}
const beforeCommitArgs = (lease, C, extra = {}) => ({ phase: "intents", lease: { token: lease.token, leaseId: lease.leaseId, scope: "catalog-controls", generation: lease.generation }, cp: { expectedVersion: C.version, next: { ...C.value, epochHigh: lease.token, leaseId: lease.leaseId, at: new Date(Date.now()).toISOString() } }, registry: null, ...extra });

// ---------------------------------------------------------------- N1
test("N1 (наслідок, повтор проби Hermes через API): псевдоніми точки й head через FileStore / ccReadiness / протокол A не пишуть; видалення лишається, дзеркало не синхронізовано з підробкою, Worker без видаленого", { skip }, async () => {
  const L = await load(), x = await world(L);
  const cp0 = structuredClone((await x.cp()).value);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
  const C = await x.cp(), H = await x.state.getJsonVersioned(HEAD), M0 = await x.mirror();
  const forged = { ...cp0, epochHigh: C.value.epochHigh, leaseId: C.value.leaseId };
  const pa = await x.protocolA();
  for (const s of [x.state, x.gateway.ccReadiness().store, pa.store]) {
    await assert.rejects(s.putJsonIfVersion("STATE/catalog-controls/checkpoint.json", forged, C.version), (e) => e.code === "CC_KEY_SEALED");
    await assert.rejects(s.putJsonIfVersion("STATE/cc-serving/head.json", { ...H.value, cp: { hash: L.jcsHash(forged), version: "x" } }, H.version), (e) => e.code === "CC_KEY_SEALED");
  }
  assert.deepEqual(await x.cp(), C, "точка без змін");
  assert.deepEqual(await x.state.getJsonVersioned(HEAD), H, "head без змін");
  const r = await x.cc();
  assert.ok(["COMMITTED", "PENDING"].includes(r.state), JSON.stringify(r).slice(0, 300));
  assert.ok((await x.controls.state()).removed.has(ID));
  const M1 = await x.mirror(), ops1 = new Set(M1.committed.registry.ops.map((e) => e.op + ":" + e.seal));
  assert.ok(M0.committed.registry.ops.every((e) => ops1.has(e.op + ":" + e.seal)), "ухвалені рішення дзеркала не зникли");
  assert.notEqual(M1.committed.cpHash, L.jcsHash(forged), "дзеркало не синхронізовано з підробкою");
  await x.bump(5);
  assert.ok(["PUBLISHED", "REUSED"].includes((await x.publish()).feeds[0].state));
  assert.equal(deletedServed(await x.served()), false);
});

test("N1 (захист у глибину): точку й head підроблено ФАЙЛАМИ (поза моделлю, Q6) — без ухваленого видалення; дзеркало реєстру НЕ переписано підробкою, стан — RECOVERY_PENDING / UNKNOWN, публікація заблокована, видалений не обслуговується", { skip }, async () => {
  const L = await load(), x = await world(L);
  const cp0 = structuredClone((await x.cp()).value);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
  const M0 = await x.mirror(), cRec = readFileRec(x, CK), hRec = readFileRec(x, HEAD);
  const forged = { ...cp0, epochHigh: cRec.value.epochHigh, leaseId: cRec.value.leaseId };
  writeFileRec(x, CK, { version: String(Number(cRec.version) + 1), value: forged });
  writeFileRec(x, HEAD, { version: String(Number(hRec.version) + 1), value: { ...hRec.value, cp: { hash: L.jcsHash(forged), version: String(Number(cRec.version) + 1) }, prepared: null, generation: (hRec.value.generation || 0) + 1 } });
  x.reopen();
  const r = await x.cc();
  assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
  const M1 = await x.mirror();
  assert.equal(M1.committed.cpHash, M0.committed.cpHash, "авторитетне джерело рішень не отруєне");
  assert.deepEqual(M1.committed.registry.ops.map((e) => e.op), M0.committed.registry.ops.map((e) => e.op));
  assert.equal(M1.recovery.state, "RECOVERY_PENDING"); assert.equal(M1.recovery.type, "UNKNOWN");
  assert.equal((await headRec(x))?.id, M1.recovery.id, "head — той самий запис");
  await x.bump(5);
  assert.equal((await x.publish()).feeds[0].state, "RECOVERY_PENDING");
  assert.equal(deletedServed(await x.served()), false, "обслуговування — щодо найсуворішого стану (реєстр дзеркала з видаленням)");
});

// ---------------------------------------------------------------- b
test("b (E5-4): переданий CC стан ДОДАЄ обмеження до власної проєкції Engineering — знятий лише в переданому стані недоступний, видалений лише в переданому — відсутній у фактичному YML ще до квитка", { skip }, async () => {
  const L = await load(), x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  const HID = await availableProduct(x), DID = await availableProduct(x, [HID]);
  assert.ok(HID && DID, "передумова: є доступні товари");
  for (const [label, passed, check] of [
    ["held", { blocked: false, held: new Set([HID]), tombstoned: new Map(), reasons: [], fingerprint: "passed" }, async () => assert.equal((await x.availableIds()).has(HID), false, "знятий лише в переданому стані — недоступний")],
    ["removed", { blocked: false, held: new Set(), tombstoned: new Map([[DID, { stage: "REMOVED" }]]), reasons: [], fingerprint: "passed" }, async () => assert.equal(L.yml.offersById(await servedXml(L, x)).has(DID), false, "видалений лише в переданому стані — відсутній")],
  ]) {
    const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
    try {
      const C = await x.cp();
      const g = await pa.serving.beforeCommit(beforeCommitArgs(lease, C, { state: passed }));
      assert.equal(g.ok, true, label + ": " + JSON.stringify(g).slice(0, 300));
      await check();
      assert.deepEqual(await x.cp(), C, "точку не записано (лише beforeCommit)");
    } finally { await lease.release(); }
  }
});

test("b: послаблення з дійсним кодом (ПОВЕРНУТИ В ПРОДАЖ) — до запису точки й звичайної публікації байти товару в обслуговуваному YML не змінюються; повтор патча з ВЛАСНИМ слабшим станом — остаточна перевірка щодо об'єднаного стану не проходить, квитка немає", { skip }, async () => {
  const L = await load(), x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  const HID = await availableProduct(x);
  assert.ok(HID);
  assert.equal((await x.command("ЗНЯТИ З ПРОДАЖУ", HID)).r2.state, "COMMITTED");
  assert.ok(["PUBLISHED", "REUSED"].includes((await x.publish()).feeds[0].state));
  const held = offerXml(await servedXml(L, x), HID);
  assert.match(held, /available="false"/);
  assert.equal((await x.command("ПОВЕРНУТИ В ПРОДАЖ", HID)).r2.state, "COMMITTED");
  assert.equal(offerXml(await servedXml(L, x), HID), held, "beforeCommit лише зменшує обслуговування: байти товару без змін до публікації");
  assert.ok(["PUBLISHED", "REUSED"].includes((await x.publish()).feeds[0].state));
  assert.equal((await x.availableIds()).has(HID), true, "повернення — лише звичайною публікацією після запису точки");
  // Повтор патча: перша спроба запису версії падає → повтор зі свіжим ВЛАСНИМ станом (без зняття) → остаточна перевірка щодо
  // найсуворішого (переданий стан знімає HID) не проходить → квитка немає.
  const pa = await x.protocolA({ feedStore: wrapFeeds(x.store, { versions: (n) => n === 1 }) }), lease = await pa.committer.acquire("catalog-controls");
  try {
    const C = await x.cp();
    const g = await pa.serving.beforeCommit(beforeCommitArgs(lease, C, { state: { blocked: false, held: new Set([HID]), tombstoned: new Map(), reasons: [], fingerprint: "passed" } }));
    assert.equal(g.ok, false, JSON.stringify(g).slice(0, 300));
    assert.equal(g.code, "SERVING_NOT_SECURED");
    assert.equal(g.ticket, undefined);
    assert.deepEqual(await x.cp(), C);
  } finally { await lease.release(); }
});

// ---------------------------------------------------------------- c
test("c: стан відновлення лише в M (JOURNAL / W2_ONLY з acquire) → наступна оренда переносить у H той самий id / тип; лише в H (M відкочено) → M отримує той самий id (RECOVERY_PENDING), дозвіл з цим id можливий, доведений тип доходить до NORMAL", { skip }, async () => {
  const L = await load();
  { // JOURNAL — оголошено лише в M, оренда протоколу A переносить у H.
    const x = await world(L);
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    const HID = await availableProduct(x);
    x.snapshot("full", ["w2", "objects"]);
    assert.equal((await x.command("ЗНЯТИ З ПРОДАЖУ", HID)).r2.state, "COMMITTED");
    x.restore("full", ["w2", "objects"]);
    const r = await x.cc();
    assert.equal(r.declared?.type, "JOURNAL");
    const M = await x.mirror(), hr = await headRec(x);
    assert.equal(hr?.id, M.recovery.id); assert.equal(hr?.type, "JOURNAL"); assert.equal(hr?.state, "RECOVERY_PENDING");
  }
  { // W2_ONLY з acquire — після першої виданої оренди (після межі).
    const x = await world(L);
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    x.snapshot("bk");
    assert.equal((await x.command("ЗНЯТИ З ПРОДАЖУ")).r2.state, "COMMITTED");
    x.restore("bk");
    const r0 = await x.cc();
    assert.deepEqual([r0.state, r0.detector], ["RECOVERY_PENDING", "epoch-floor"], JSON.stringify(r0).slice(0, 200)); // CC R7.4, п. a
    const M = await x.mirror();
    assert.equal(M.recovery.type, "W2_ONLY"); assert.equal(await headRec(x), null, "у відкоченому H запису ще немає");
    await x.recover();
    const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
    try { const hr = await headRec(x); assert.equal(hr?.id, M.recovery.id); assert.equal(hr?.type, "W2_ONLY"); } finally { await lease.release(); }
  }
  { // Лише в H: M (сховище фідів) відкочено після виявлення CP_ONLY.
    const x = await world(L);
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    const cpFile = file(x, CK), before = fs.readFileSync(cpFile);
    assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
    x.snapshot("afterDel", ["objects"]);
    fs.writeFileSync(cpFile, before);
    assert.equal((await x.cc()).state, "RECOVERY_PENDING");
    const id = (await x.mirror()).recovery.id;
    x.restore("afterDel", ["objects"]);
    assert.notEqual((await x.mirror()).recovery?.state, "RECOVERY_PENDING", "передумова: M без запису");
    assert.equal((await x.cc()).state, "RECOVERY_PENDING");
    const M = await x.mirror();
    assert.equal(M.recovery.id, id); assert.equal(M.recovery.state, "RECOVERY_PENDING"); assert.equal(M.recovery.type, "CP_ONLY");
    await x.recover();
    const rr = await x.cc("recover");
    assert.equal(rr.state, "RECOVERED", JSON.stringify(rr).slice(0, 300));
    assert.equal((await x.mirror()).recovery.state, "NORMAL"); assert.equal(await headRec(x), null);
    assert.ok((await x.controls.state()).removed.has(ID));
  }
});

test("c: запис лише в M, M потім відкочено, H має копію → F_ONLY_SYNCED не скидає відновлення; H і M активні з різними id → RECOVERY_PENDING / UNKNOWN, recover → RECOVERY_PENDING", { skip }, async () => {
  const L = await load();
  { const x = await world(L);
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    const HID = await availableProduct(x);
    x.snapshot("full", ["w2", "objects"]);
    assert.equal((await x.command("ЗНЯТИ З ПРОДАЖУ", HID)).r2.state, "COMMITTED");
    x.restore("full", ["w2", "objects"]);
    x.snapshot("preJ", ["objects"]);
    assert.equal((await x.cc()).declared?.type, "JOURNAL");
    const id = (await x.mirror()).recovery.id;
    assert.equal((await headRec(x))?.id, id);
    x.restore("preJ", ["objects"]); // M — без запису відновлення (старіше)
    const r = await x.cc();
    assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 200));
    const M = await x.mirror();
    assert.equal(M.recovery.id, id); assert.equal(M.recovery.type, "JOURNAL"); assert.equal(M.recovery.state, "RECOVERY_PENDING");
    assert.equal((await x.availableIds()).has(HID), false);
  }
  { const x = await world(L);
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    const cpFile = file(x, CK), before = fs.readFileSync(cpFile);
    assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
    fs.writeFileSync(cpFile, before);
    assert.equal((await x.cc()).state, "RECOVERY_PENDING");
    const { value, etag } = await x.store.getJsonEtag(REG);
    await x.store.putJson(REG, { ...value, recovery: { ...value.recovery, id: "b".repeat(12), type: "W2_ONLY" } }, { ifMatch: etag });
    assert.equal((await x.cc()).state, "RECOVERY_PENDING");
    const M = await x.mirror(), hr = await headRec(x);
    assert.equal(M.recovery.type, "UNKNOWN"); assert.equal(hr?.type, "UNKNOWN"); assert.equal(hr?.id, M.recovery.id);
    assert.ok(M.recovery.conflict, "суперечність зафіксовано");
    await assert.rejects(L.rec.authorizeRecover({ feedStore: x.store, id: M.recovery.id, authorizedBy: "Власник", confirm: L.rec.confirmationFor(M.recovery.id) }), (e) => e.code === "FLOOR_NOT_PROVEN");
    assert.equal((await x.cc("recover")).state, "RECOVERY_PENDING");
    assert.notEqual((await x.mirror()).recovery.state, "NORMAL");
  }
});

// ---------------------------------------------------------------- d
/** Перевести світ у «до ENG-23»: прибрати head W2 і дзеркало, точку — у формат до R7.3 (без epochHigh / leaseId / recovery). */
function toPreR73(x, { keepR73Format = false } = {}) {
  fs.rmSync(file(x, HEAD), { force: true });
  fs.rmSync(path.join(x.objDir, "state", "cc-registry"), { recursive: true, force: true });
  if (!keepR73Format) {
    const rec = readFileRec(x, CK);
    const { epochHigh: _e, leaseId: _l, recovery: _r, ...old } = rec.value;
    writeFileRec(x, CK, { version: rec.version, value: old });
  }
  x.reopen();
}

test("d: MIGRATION — лише точка формату до R7.3 без head і дзеркала: обслуговування перевірене щодо точки (видалений не віддається) ДО NORMAL, у H і M позначка migration; другий запуск — звичайний; BOOTSTRAP — без точки", { skip }, async () => {
  const L = await load(), x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  x.snapshot("pre", ["objects"]);
  assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
  const feedDir = path.join(x.objDir, "feeds", "main");
  fs.rmSync(feedDir, { recursive: true, force: true }); fs.cpSync(path.join(x.dir, "pre-objects", "feeds", "main"), feedDir, { recursive: true });
  toPreR73(x);
  assert.equal(deletedServed(await x.served()), true, "передумова: обслуговується версія з видаленим");
  const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
  let st;
  try { st = await pa.serving.status({ lease }); } finally { await lease.release(); }
  assert.equal(st.state, "NORMAL"); assert.equal(st.type, "MIGRATION", JSON.stringify(st));
  assert.equal(deletedServed(await x.served()), false, "MIGRATION — лише після захищеного обслуговування");
  const H = (await x.state.getJsonVersioned(HEAD)).value, M = await x.mirror();
  assert.equal(H.migration?.cpHash, L.jcsHash((await x.cp()).value)); assert.equal(M.migration?.cpHash, H.migration.cpHash);
  const r2 = await x.cc();
  assert.ok(["COMMITTED", "PENDING", "MIGRATED"].includes(r2.state), JSON.stringify(r2).slice(0, 300));
  assert.ok((await x.controls.state()).removed.has(ID));
  const r3 = await x.cc();
  assert.ok(["COMMITTED", "PENDING"].includes(r3.state), JSON.stringify(r3).slice(0, 300));
  // BOOTSTRAP: новий світ без точки.
  const st2 = new L.FileStore(path.join(x.dir, "w2-empty")), gw2 = new L.WriteGateway({ sheets: x.w.mem, read: (n) => x.w.mem.read(n), store: st2, now: () => x.clock.now });
  const fs2 = new L.LocalObjectStore(path.join(x.dir, "objects-empty"));
  const pa2 = gw2.ccProtocolA({ feedStore: fs2, config: x.config, loadBook: () => x.w.readBook(L.prod.CC_BOOK_SHEETS), contract: x.h.ACTIVE_CONTRACT, mods: await L.prod.loadCatalogControlsModules(), activeXmlsOf: L.prod.activeXmlsOf, base: L.engineeringReadiness(gw2, { config: x.config }) });
  const l2 = await pa2.committer.acquire("catalog-controls");
  try { assert.equal((await pa2.serving.status({ lease: l2 })).type, "BOOTSTRAP"); } finally { await l2.release(); }
});

test("d: без head і дзеркала, але точка формату R7.3 → RECOVERY_PENDING / UNKNOWN (не міграція), CC — нуль записів; дзеркало недійсне (v ≠ 1 або зламаний JSON) → UNKNOWN; MIGRATION без захищеного обслуговування → UNKNOWN", { skip }, async () => {
  const L = await load();
  { const x = await world(L);
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    toPreR73(x, { keepR73Format: true });
    const C0 = await x.cp();
    const r = await x.cc();
    assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
    assert.equal((await x.mirror()).recovery.type, "UNKNOWN");
    assert.deepEqual(await x.cp(), C0, "точку не змінено");
  }
  { const x = await world(L); // дзеркало v ≠ 1, head немає → UNKNOWN
    fs.rmSync(file(x, HEAD), { force: true });
    await x.store.put(REG, JSON.stringify({ v: 2, committed: null }), { contentType: "application/json" });
    x.reopen();
    const C0 = await x.cp();
    const r = await x.cc();
    assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
    assert.equal((await x.mirror()).recovery.type, "UNKNOWN");
    assert.deepEqual(await x.cp(), C0);
  }
  { const x = await world(L); // дзеркало — зламаний JSON: корінь межі епох не читається → оренди немає (fail-closed), нуль записів, не MIGRATION
    fs.rmSync(file(x, HEAD), { force: true });
    await x.store.put(REG, "{зламаний json", { contentType: "application/json" });
    x.reopen();
    const C0 = await x.cp();
    const r = await x.cc();
    assert.ok(["BUSY", "BLOCKED", "RECOVERY_PENDING"].includes(r.state), JSON.stringify(r).slice(0, 300));
    assert.deepEqual(await x.cp(), C0, "точку не змінено");
    assert.equal((await x.state.getJsonVersioned(HEAD)).value, null, "head не створено (не міграція)");
  }
  { const x = await world(L);
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    x.snapshot("pre", ["objects"]);
    assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
    const feedDir = path.join(x.objDir, "feeds", "main");
    fs.rmSync(feedDir, { recursive: true, force: true }); fs.cpSync(path.join(x.dir, "pre-objects", "feeds", "main"), feedDir, { recursive: true });
    toPreR73(x);
    const pa = await x.protocolA({ feedStore: wrapFeeds(x.store, { versions: () => true, withdraw: true }) }), lease = await pa.committer.acquire("catalog-controls");
    let st;
    try { st = await pa.serving.status({ lease }); } finally { await lease.release(); }
    assert.equal(st.state, "RECOVERY_PENDING", JSON.stringify(st)); assert.equal(st.type, "UNKNOWN");
    assert.equal((await x.state.getJsonVersioned(HEAD)).value?.migration, undefined, "позначки міграції немає");
  }
});

// ---------------------------------------------------------------- e
test("e: ескалація — тип без доведеної межі під час відновлення з доведеною межею: новий id і тип, RECOVERY_PENDING, попередній дозвіл і межа недійсні; head синхронізовано (не суперечність); recover → RECOVERY_PENDING", { skip }, async () => {
  const L = await load(), x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  const cpFile = file(x, CK), before = fs.readFileSync(cpFile);
  assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
  fs.writeFileSync(cpFile, before);
  assert.equal((await x.cc()).state, "RECOVERY_PENDING");
  const old = (await x.mirror()).recovery;
  assert.equal(old.type, "CP_ONLY");
  await x.recover(); // дозвіл і межа для CP_ONLY
  assert.equal((await x.mirror()).recovery.state, "RECOVERY_AUTHORIZED");
  const esc = await L.rec.declareRecovery({ feedStore: x.store, type: "JOURNAL", reason: "детектор журналу (симуляція)", declaredBy: "cc-journal-detector" });
  assert.equal(esc.type, "JOURNAL"); assert.equal(esc.state, "RECOVERY_PENDING"); assert.notEqual(esc.id, old.id); assert.equal(esc.escalatedFrom, old.id);
  const M = (await x.mirror()).recovery;
  assert.equal(M.floorEstablished, undefined); assert.equal(M.floorProven, undefined); assert.equal(M.authorizedBy, undefined);
  await assert.rejects(L.rec.authorizeRecover({ feedStore: x.store, id: old.id, authorizedBy: "Власник", confirm: L.rec.confirmationFor(old.id) }), (e) => e.code === "RECOVERY_NOT_AUTHORIZED", "старе підтвердження не діє");
  assert.equal((await x.cc("recover")).state, "RECOVERY_PENDING");
  const hr = await headRec(x);
  assert.equal(hr?.id, esc.id, "head — ескальований запис (без суперечності)"); assert.equal(hr?.type, "JOURNAL");
  assert.equal((await L.rec.declareRecovery({ feedStore: x.store, type: "FULL", declaredBy: "operator" })).id, esc.id, "зворотного зниження / повторної ескалації між недоведеними типами немає");
});

test("e: JOURNAL / FULL — жодна точка входу (CC apply / recover, runUpdate, guardedRollback, tools/recover status / declare / authorize / establish-floor) не дає NORMAL ні в H, ні в M; звіт детектора журналу — фактичний режим обслуговування (STRICT; NOT_SECURED, коли захист не вдався)", { skip }, async () => {
  const L = await load();
  const tool = (x, args) => spawnSync(process.execPath, [path.join(ROOT, "tools", "recover.mjs"), ...args, "--feed-store=" + x.objDir], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: x.stateDir } });
  const notNormal = async (x, where) => {
    assert.notEqual((await x.mirror())?.recovery?.state ?? "NORMAL", "NORMAL", "M: " + where);
    assert.notEqual((await headRec(x))?.state ?? "NORMAL", "NORMAL", "H: " + where);
  };
  const exercise = async (x) => {
    const id = (await x.mirror()).recovery.id;
    assert.equal((await x.cc()).state, "RECOVERY_PENDING"); await notNormal(x, "apply");
    await x.bump(2); assert.equal((await x.publish()).feeds[0].state, "RECOVERY_PENDING"); await notNormal(x, "runUpdate");
    await assert.rejects(L.update.guardedRollback({ store: x.store, feed: "main", controls: x.controls, coordinator: x.gateway.committer }), (e) => e.code === "RECOVERY_PENDING"); await notNormal(x, "rollback");
    assert.equal(tool(x, ["status"]).status, 0); await notNormal(x, "tool status");
    assert.equal(tool(x, ["declare", "--type=UNKNOWN"]).status, 0); assert.equal(tool(x, ["declare", "--type=W2_ONLY"]).status, 2); await notNormal(x, "tool declare");
    assert.equal(tool(x, ["authorize", "--id=" + id, "--by=Власник", "--confirm=ВІДНОВИТИ " + id]).status, 1); await notNormal(x, "tool authorize");
    assert.equal(tool(x, ["establish-floor"]).status, 1); await notNormal(x, "tool establish-floor");
    assert.equal((await x.cc("recover")).state, "RECOVERY_PENDING"); await notNormal(x, "recover");
    assert.equal((await x.mirror()).recovery.state, "RECOVERY_PENDING");
  };
  { const x = await world(L); // JOURNAL; звіт — STRICT
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    const HID = await availableProduct(x);
    x.snapshot("full", ["w2", "objects"]);
    assert.equal((await x.command("ЗНЯТИ З ПРОДАЖУ", HID)).r2.state, "COMMITTED");
    x.restore("full", ["w2", "objects"]);
    const r = await x.cc();
    assert.equal(r.declared?.type, "JOURNAL"); assert.equal(r.declared?.serving, "STRICT", JSON.stringify(r.declared));
    await exercise(x);
  }
  { const x = await world(L); // JOURNAL, обслуговування не захищено (синтетичні відмови запису версії й зняття) → NOT_SECURED
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    const HID = await availableProduct(x);
    x.snapshot("full", ["w2", "objects"]);
    assert.equal((await x.command("ЗНЯТИ З ПРОДАЖУ", HID)).r2.state, "COMMITTED");
    x.restore("full", ["w2", "objects"]);
    x.clock.now += 60_000;
    const r = await L.prod.runCatalogControls({ sheets: x.w.mem, readBook: x.w.readBook, gateway: x.gateway, config: x.config, stamp: new Date(x.clock.now).toISOString(), mode: "apply", contractFile: x.contractFile, protection: x.h.PROTECTION_OK, feedStore: wrapFeeds(x.store, { versions: () => true, withdraw: true }) });
    assert.equal(r.declared?.type, "JOURNAL"); assert.equal(r.declared?.serving, "NOT_SECURED", JSON.stringify(r.declared));
  }
  { const x = await world(L); // FULL від оператора
    assert.equal(tool(x, ["declare", "--type=FULL"]).status, 0);
    await exercise(x);
  }
});

// Еквівалент проби Hermes «H24 незалежний FULL» після e1: правильний дозвіл не знімає блокування.
test("e (еквівалент H24 FULL): правильний дозвіл власника для FULL → FLOOR_NOT_PROVEN (ownerAck), стан RECOVERY_PENDING; establishFloor → FLOOR_NOT_PROVEN; recover → RECOVERY_PENDING; точка без змін", { skip }, async () => {
  const L = await load(), x = await world(L);
  const c0 = await x.cp();
  const rec = await L.rec.declareRecovery({ feedStore: x.store, type: "FULL", reason: "локальна негативна перевірка", declaredBy: "operator" });
  await assert.rejects(L.rec.authorizeRecover({ feedStore: x.store, id: rec.id, authorizedBy: "Власник (синтетика)", confirm: L.rec.confirmationFor(rec.id) }), (e) => e.code === "FLOOR_NOT_PROVEN");
  const m = (await x.mirror()).recovery;
  assert.equal(m.state, "RECOVERY_PENDING"); assert.equal(m.ownerAck.by, "Власник (синтетика)");
  await assert.rejects(L.rec.establishFloor({ feedStore: x.store, w2Store: x.state, committer: L.createCommitter({ store: x.state, now: () => x.clock.now }), feeds: ["main"] }), (e) => e.code === "FLOOR_NOT_PROVEN");
  assert.equal((await x.cc("recover")).state, "RECOVERY_PENDING");
  assert.deepEqual(await x.cp(), c0);
});

test("e2 (захист у глибину, API): W2_ONLY / CP_ONLY, оголошений через API як «system» без ознак у сховищах (повний відкат — корені узгоджені), — дозвіл можливий, але establishFloor → FLOOR_NOT_PROVEN, лічильник оренди не змінено; recover → RECOVERY_PENDING", { skip }, async () => {
  const L = await load();
  for (const type of ["W2_ONLY", "CP_ONLY"]) {
    const x = await world(L);
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    const HID = await availableProduct(x);
    x.snapshot("full", ["w2", "objects"]);
    assert.equal((await x.command("ЗНЯТИ З ПРОДАЖУ", HID)).r2.state, "COMMITTED");
    x.restore("full", ["w2", "objects"]);
    const d = await L.rec.declareRecovery({ feedStore: x.store, type, reason: "перекласифікація (симуляція атаки e2)", declaredBy: "system" });
    await L.rec.authorizeRecover({ feedStore: x.store, id: d.id, authorizedBy: "Власник", confirm: L.rec.confirmationFor(d.id) });
    const tok = async () => (await x.state.getJsonVersioned(L.leaseKeyOf("sheets-main"))).value.token;
    const t0 = await tok();
    await assert.rejects(L.rec.establishFloor({ feedStore: x.store, w2Store: x.state, committer: L.createCommitter({ store: x.state, now: () => x.clock.now }), feeds: x.feeds }), (e) => e.code === "FLOOR_NOT_PROVEN", type);
    assert.equal(await tok(), t0, "лічильник оренди не змінено");
    assert.equal((await x.cc("recover")).state, "RECOVERY_PENDING");
    assert.notEqual((await x.mirror()).recovery.state, "NORMAL");
  }
});

test("c: копія H → M — завжди RECOVERY_PENDING (дозвіл і межа живуть лише в M): H отримав AUTHORIZED з M, потім M відкочено → M знову PENDING з тим самим id, без полів дозволу; дозвіл — заново", { skip }, async () => {
  const L = await load(), x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  const cpFile = file(x, CK), before = fs.readFileSync(cpFile);
  assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
  x.snapshot("afterDel", ["objects"]);
  fs.writeFileSync(cpFile, before);
  assert.equal((await x.cc()).state, "RECOVERY_PENDING");
  const id = (await x.mirror()).recovery.id;
  await L.rec.authorizeRecover({ feedStore: x.store, id, authorizedBy: "Власник", confirm: L.rec.confirmationFor(id) });
  // H втратив запис (файлом, поза API — Q6; відкат каталогу W2 відкотив би й лічильник оренди), M — AUTHORIZED.
  { const h = readFileRec(x, HEAD); writeFileRec(x, HEAD, { version: String(Number(h.version) + 1), value: { ...h.value, recovery: null } }); x.reopen(); }
  { const pa = await x.protocolA(), l = await pa.committer.acquire("catalog-controls"); await l.release(); }
  const hr = await headRec(x);
  assert.equal(hr?.id, id); assert.equal(hr?.state, "RECOVERY_AUTHORIZED", "M → H — той самий стан (H лише свідок)");
  x.restore("afterDel", ["objects"]); // M — без запису
  { const pa = await x.protocolA(), l = await pa.committer.acquire("catalog-controls"); await l.release(); }
  const m = (await x.mirror()).recovery;
  assert.equal(m.id, id); assert.equal(m.state, "RECOVERY_PENDING"); assert.equal(m.authorizedBy, undefined); assert.equal(m.floorProven, undefined);
  const again = await L.rec.authorizeRecover({ feedStore: x.store, id, authorizedBy: "Власник", confirm: L.rec.confirmationFor(id) });
  assert.equal(again.state, "RECOVERY_AUTHORIZED");
});

test("d: недійсне дзеркало (v ≠ 1) при чинних head і точці — не «старіше дзеркало» (F_ONLY_SYNCED): перевірити, що точка містить ухвалені рішення, неможливо → RECOVERY_PENDING / UNKNOWN, дзеркало не відбудовано з точки", { skip }, async () => {
  const L = await load(), x = await world(L);
  assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
  await x.store.put(REG, JSON.stringify({ v: 2, committed: { cpHash: "0".repeat(64) } }), { contentType: "application/json" });
  const r = await x.cc();
  assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
  const M = await x.mirror();
  assert.equal(M.recovery.type, "UNKNOWN");
  assert.equal(M.committed, null, "дзеркало не відбудовано з точки");
});

test("E-d1 (ENG-26, CC R7.4; контракт 2.4 / 2.6): під однією орендою status повертає результат її видачі — MIGRATION (точка до R7.3) двічі; точка R7.3 без коренів — RECOVERY_PENDING / UNKNOWN двічі, CC — нуль записів і жодного коду (відмова Engineering, не міграція)", { skip }, async () => {
  const L = await load();
  { const x = await world(L);
    toPreR73(x);
    const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
    try {
      const a = await pa.serving.status({ lease }), b = await pa.serving.status({ lease });
      assert.deepEqual([a.state, a.type], ["NORMAL", "MIGRATION"], JSON.stringify(a));
      assert.deepEqual(b, a, "той самий результат під тією самою орендою");
    } finally { await lease.release(); }
    const pa2 = await x.protocolA(), l2 = await pa2.committer.acquire("catalog-controls");
    try { assert.deepEqual([(await pa2.serving.status({ lease: l2 })).type], ["NORMAL"], "нова оренда — новий результат"); } finally { await l2.release(); }
  }
  { const x = await world(L);
    const ID2 = x.h.mainRows(x.w)[3]["Offer ID"];
    x.h.setCells(x.w, ID2, { [L.SALE]: "ЗНЯТИ З ПРОДАЖУ" });
    toPreR73(x, { keepR73Format: true });
    const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
    try {
      const a = await pa.serving.status({ lease }), b = await pa.serving.status({ lease });
      assert.deepEqual([a.state, a.type], ["RECOVERY_PENDING", "UNKNOWN"], JSON.stringify(a));
      assert.deepEqual([b.state, b.type, b.id], [a.state, a.type, a.id]);
    } finally { await lease.release(); }
    const C0 = await x.cp();
    const r = await x.cc();
    assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
    assert.deepEqual(await x.cp(), C0, "точку не змінено");
    assert.throws(() => x.h.codeOf(x.w, ID2, "ЗНЯТИ З ПРОДАЖУ"), /немає коду/, "код не видано");
  }
  { const x = await world(L); // FINISHED (збій процесу між записом точки й afterCommit) — теж стабільний під орендою
    const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
    try {
      const C = await x.cp(), args = beforeCommitArgs(lease, C);
      const g = await pa.serving.beforeCommit(args);
      assert.equal(g.ok, true, JSON.stringify(g).slice(0, 200));
      await pa.store.putJsonIfVersion(CK, args.cp.next, C.version, { lease: { scope: "catalog-controls", token: lease.token, leaseId: lease.leaseId }, ticket: g.ticket });
    } finally { await lease.release(); } // afterCommit не викликано
    const pa2 = await x.protocolA(), l2 = await pa2.committer.acquire("catalog-controls");
    try {
      const a = await pa2.serving.status({ lease: l2 }), b = await pa2.serving.status({ lease: l2 });
      assert.deepEqual([a.state, a.type], ["NORMAL", "FINISHED"], JSON.stringify(a)); assert.deepEqual(b, a);
    } finally { await l2.release(); }
  }
  { const x = await world(L); // виняток: afterCommit(recover) цієї оренди змінює стан за задумом → наступний status — NORMAL
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    const cpFile = file(x, CK), before = fs.readFileSync(cpFile);
    assert.equal((await x.command(`ВИДАЛИТИ ТОВАР ${ID}`)).r2.state, "COMMITTED");
    fs.writeFileSync(cpFile, before);
    assert.equal((await x.cc()).state, "RECOVERY_PENDING");
    await x.recover();
    const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
    try {
      assert.equal((await pa.serving.status({ lease })).state, "RECOVERY_AUTHORIZED");
      const rv = await pa.serving.recovery({ lease });
      assert.equal(rv.floorProven, true);
      const C = await x.cp(), mods = await L.prod.loadCatalogControlsModules();
      const next = mods.plan.recoverCheckpoint({ base: C.value, registry: rv.registry, prepared: rv.prepared, journal: [], at: new Date(x.clock.now).toISOString(), epoch: lease.token, leaseId: lease.leaseId, generation: lease.generation, type: rv.type, fromHash: rv.fromHash });
      const g = await pa.serving.beforeCommit({ phase: "recover", lease: { token: lease.token, leaseId: lease.leaseId, scope: "catalog-controls", generation: lease.generation }, cp: { expectedVersion: C.version, next }, state: null, registry: null });
      assert.equal(g.ok, true, JSON.stringify(g).slice(0, 200));
      const w = await pa.store.putJsonIfVersion(CK, next, C.version, { lease: { scope: "catalog-controls", token: lease.token, leaseId: lease.leaseId }, ticket: g.ticket });
      assert.equal((await pa.serving.afterCommit({ ticket: g.ticket, version: w.version })).ok, true);
      assert.equal((await pa.serving.status({ lease })).state, "NORMAL", "після завершеного відновлення цієї оренди — перераховано");
    } finally { await lease.release(); }
    assert.equal((await x.mirror()).recovery.state, "NORMAL");
  }
});

// ---------------------------------------------------------------- ENG-27 (Hermes INT R-MIG)
test("ENG-27 R-MIG: через протокол A точку формату до R7.3 (без epochHigh / leaseId) чи з чужою епохою записати неможливо — квитка немає; точка, head і дзеркало без змін", { skip }, async () => {
  const L = await load(), x = await world(L);
  const pa = await x.protocolA(), lease = await pa.committer.acquire("catalog-controls");
  try {
    assert.equal((await pa.serving.status({ lease })).state, "NORMAL");
    const C = await x.cp(), head0 = await x.state.getJsonVersioned(HEAD), mirror0 = await x.mirror();
    assert.ok(Number.isInteger(C.value.epochHigh), "передумова: чинна точка — формату R7.3");
    const base = beforeCommitArgs(lease, C);
    const { epochHigh, leaseId, recovery, ...legacy } = base.cp.next;
    const fenceLease = { scope: "catalog-controls", token: lease.token, leaseId: lease.leaseId };
    for (const [label, next] of [
      ["формат до R7.3 (без epochHigh / leaseId / recovery)", legacy],
      ["чужа (менша) епоха", { ...base.cp.next, epochHigh: lease.token - 1 }],
      ["епоха з майбутнього", { ...base.cp.next, epochHigh: lease.token + 1 }],
      ["чужий leaseId", { ...base.cp.next, leaseId: "0".repeat(32) }],
      ["епоха рядком", { ...base.cp.next, epochHigh: String(lease.token) }],
    ]) {
      const g = await pa.serving.beforeCommit({ ...base, cp: { ...base.cp, next } });
      assert.equal(g.ok, false, label + ": " + JSON.stringify(g).slice(0, 200));
      assert.equal(g.code, "SERVING_NOT_SECURED", label);
      assert.equal(g.ticket, undefined, label);
      // Без квитка (і з підробленим) — запис точки неможливий.
      await assert.rejects(pa.store.putJsonIfVersion(CK, next, C.version, { lease: fenceLease }), label + ": без квитка");
      await assert.rejects(pa.store.putJsonIfVersion(CK, next, C.version, { lease: fenceLease, ticket: { v: 1, key: CK, nextHash: "0".repeat(64), expectedVersion: C.version, leaseToken: lease.token, leaseId: lease.leaseId, phase: "intents", nonce: "00", notAfter: Date.now() + 60_000 } }), label + ": підроблений квиток");
    }
    assert.deepEqual(await x.cp(), C, "точку не записано");
    assert.deepEqual(await x.state.getJsonVersioned(HEAD), head0, "head без prepared");
    assert.deepEqual(await x.mirror(), mirror0, "дзеркало без prepared");
    // Позитивний контроль: точка з епохою ЦІЄЇ оренди (як пише CC withEpoch) — квиток видається.
    const ok = await pa.serving.beforeCommit(base);
    assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 300));
  } finally { await lease.release(); }
  // Повний цикл CC після відмов — звичайний запуск, точка R7.3 з новою епохою.
  const rc = await x.cc();
  assert.ok(!/RECOVERY|BLOCK|ABORT|FAIL/.test(rc.state), "звичайний запуск CC після відмов: " + rc.state);
  const C2 = await x.cp();
  assert.ok(Number.isInteger(C2.value.epochHigh) && typeof C2.value.leaseId === "string", "точка лишається формату R7.3");
});
