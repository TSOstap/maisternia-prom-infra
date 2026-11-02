/** ENG-22 × CC — виправлення блокерів Hermes ENG-21 зі СПРАВЖНІМ Catalog Controls (R7.2), повним productionConfig, FileStore +
 *  WriteGateway, локальним Worker (GET / HEAD). Еквіваленти точних проб Hermes (F01, F02, F03, F05, F07) у тестовому світі ENG-20.
 *  Модель — LocalObjectStore (один хост): НЕ доказ поведінки R2 чи розгорнутого Worker. Без модуля CC — пропуск. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ccPresent = fs.existsSync(new URL("../src/core/controls-plan.mjs", import.meta.url)) && fs.existsSync(new URL("../src/pipeline/controls-run.mjs", import.meta.url)) && fs.existsSync(new URL("./helpers/controls.mjs", import.meta.url));
const skip = ccPresent ? false : "модуль Catalog Controls відсутній (до злиття гілок) — композиційна проба";
const ID = "1500000007";
const load = async () => {
  const [prod, store, gw, h, common, seal, yml, sheetSync, sources, local, update, publisher, worker, r2, intake, baseConfig] = await Promise.all([
    import("../src/pipeline/production.mjs"), import("../src/pipeline/safe-write/store.mjs"), import("../src/pipeline/safe-write/gateway.mjs"),
    import("./helpers/controls.mjs"), import("../src/core/controls-common.mjs"), import("../src/core/seal.mjs"), import("../src/core/yml.mjs"),
    import("../src/core/sheet-sync.mjs"), import("../src/pipeline/sources.mjs"), import("../src/storage/local.mjs"), import("../src/pipeline/update.mjs"),
    import("../src/publish/publisher.mjs"), import("../worker/src/index.js"), import("./helpers/r2-fake.mjs"), import("./helpers/intake.mjs"), import("../config/default.json", { with: { type: "json" } }),
  ]);
  return { prod, FileStore: store.FileStore, WriteGateway: gw.WriteGateway, h, SALE: common.SALE_DECISION, seal, yml, SHEET: sheetSync.SHEET, sources, LocalObjectStore: local.LocalObjectStore, update, manifestKey: publisher.manifestKey, worker: worker.default, r2: r2.r2BindingFrom, intake, baseConfig: baseConfig.default };
};
/** Світ ENG-20: справжній CC (контракт із файлу), FileStore W2 з віртуальним годинником, сховище фідів LocalObjectStore, публікатор під тим самим координатором. */
async function world(L, { feedStore = null } = {}) {
  const { h } = L;
  const w = await h.prepared();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-e22c-"));
  const clock = { now: h.NOW };
  const state = new L.FileStore(path.join(dir, "w2"));
  const gateway = new L.WriteGateway({ sheets: w.mem, read: (n) => w.mem.read(n), store: state, now: () => clock.now });
  const store = new L.LocalObjectStore(path.join(dir, "objects"));
  const config = L.prod.productionConfig(structuredClone(L.baseConfig));
  config.supplier.minimumOffers = 10;
  const contractFile = path.join(dir, "contract.json");
  await fsp.writeFile(contractFile, JSON.stringify(h.ACTIVE_CONTRACT));
  const cc = (fs_ = feedStore || store) => L.prod.runCatalogControls({ sheets: w.mem, readBook: w.readBook, gateway, config, stamp: new Date(clock.now).toISOString(), mode: "apply", contractFile, protection: h.PROTECTION_OK, feedStore: fs_ });
  assert.ok(["COMMITTED", "PENDING"].includes((await cc(store)).state));
  const catalog = path.join(dir, "catalog"), supplier = path.join(dir, "supplier.xml");
  await L.sources.writeCatalogSnapshot(catalog, { sheets: w.book, groups: w.book[L.SHEET.groups] });
  await fsp.writeFile(supplier, w.xml);
  await store.putJson("approved/main.json", L.seal.approvalManifest(h.mainRows(w), L.yml.objectsFromValues(w.book[L.SHEET.groups], L.seal.GROUP_HEADERS)));
  const controls = await L.prod.loadCatalogControls({ loadBook: async () => structuredClone(w.book), store: state, config, contractFile, feedStore: store });
  const ctx = { store, config, catalog: new L.sources.NdjsonCatalogSource(catalog), supplier: new L.sources.FileSupplierSource(supplier), now: () => clock.now, tmpDir: dir, controls, coordinator: gateway.committer };
  const DEL = `ВИДАЛИТИ ТОВАР ${ID}`;
  const prepareDelete = async () => { h.setCells(w, ID, { [L.SALE]: DEL }); assert.ok(["COMMITTED", "PENDING"].includes((await cc(store)).state)); h.setCells(w, ID, { [L.SALE]: `${DEL} ${h.codeOf(w, ID, DEL)}` }); };
  const publish = () => L.update.runUpdate(ctx);
  const served = async () => {
    const out = {};
    for (const method of ["GET", "HEAD"]) {
      const r = await L.worker.fetch(new Request("https://local.invalid/feeds/main.xml?key=TEST_E22", { method }), { FEEDS_BUCKET: L.r2(store), FEED_ACCESS_KEY: "TEST_E22", FEEDS: "main" });
      out[method] = { status: r.status, version: r.headers.get("x-feed-version"), deleted: r.status === 200 && method === "GET" && L.yml.offersById(await r.text()).has(ID) };
    }
    return out;
  };
  return { w, dir, clock, state, gateway, store, config, cc, controls, ctx, prepareDelete, publish, served, supplier };
}
const deletedServed = (s) => Object.values(s).some((x) => x.deleted);
/** Після коміту обмеження Worker ніколи не віддає видалений товар; HEAD 200 можливий лише разом із GET 200 без видаленого. */
const safeAfterCommit = (s) => !deletedServed(s) && !(s.HEAD.status === 200 && s.GET.status !== 200);

test("F01 × CC: тимчасова недоступність HEAD активного об'єкта під час протоколу A — коміт видалення лише після зняття з обслуговування (або без коміту); Worker не віддає видалений і після відновлення HEAD", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  const m = await x.store.getJson(L.manifestKey("main"));
  const raw = x.store.head.bind(x.store);
  let denied = 0;
  x.store.head = async (k) => { if (k === m.active.key) { denied++; throw new Error("synthetic transient HEAD outage"); } return raw(k); };
  let r;
  try { r = await x.cc(); } finally { x.store.head = raw; }
  assert.ok(denied > 0, "передумова: HEAD активного недоступний під час CC");
  const removed = (await x.controls.state()).removed.has(ID);
  const s = await x.served();
  assert.ok(!removed || safeAfterCommit(s), JSON.stringify({ r: r.state, removed, s }));
  if (r.state === "COMMITTED") assert.ok((await x.store.getJson(L.manifestKey("main"))).withdrawn, "коміт — лише після зняття з обслуговування");
});

test("F02 × CC: затриманий умовний PUT відкату ПІСЛЯ перевірки умови (вікно сховища) + перехоплення оренди CC → 412, ніколи не віддається видалений", { skip }, async () => {
  const L = await load();
  const base = await world(L);
  let window = null;
  const store = new L.LocalObjectStore(base.store.root, { casWindow: async (key) => { if (window && key === L.manifestKey("main")) { const f = window; window = null; await f(); } } });
  const x = { ...base, store, ctx: { ...base.ctx, store } };
  assert.equal((await L.update.runUpdate(x.ctx)).feeds[0].state, "PUBLISHED");
  await fsp.writeFile(x.supplier, x.w.xml.replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 1) + b));
  x.clock.now += 60_000;
  assert.equal((await L.update.runUpdate(x.ctx)).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  let actor = null, during = null;
  const rawPut = store.putJson.bind(store);
  store.putJson = async (k, v, o) => {
    if (k === L.manifestKey("main") && v?.rolledBackAt && !actor) {
      // Умову відкату буде перевірено сховищем; у вікні між перевіркою й записом — сплив оренди, CC перехоплює й комітить видалення.
      window = async () => { x.clock.now += 20 * 60_000; actor = await x.cc(store); during = await x.served(); };
    }
    return rawPut(k, v, o);
  };
  let err = null;
  try { await L.update.guardedRollback({ store, feed: "main", controls: x.controls, coordinator: x.gateway.committer }); } catch (e) { err = e.message; } finally { store.putJson = rawPut; }
  assert.equal(actor?.state, "COMMITTED", JSON.stringify(actor));
  assert.ok((await x.controls.state()).removed.has(ID));
  assert.match(String(err), /STALE_FENCE/);
  assert.ok(safeAfterCommit(during), JSON.stringify(during));
  assert.ok(safeAfterCommit(await x.served()));
});

test("F03 × CC: затриманий операційний PUT після verify — перехоплення оренди CC (протокол A підвищує епоху операційного стану) і COMMITTED delete → запис відхилено, ціна видаленого не змінена", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  const before = (await x.store.getJson("state/operational.json")).rows[ID][0];
  await fsp.writeFile(x.supplier, x.w.xml.replace(new RegExp(`(<offer id="${ID}"[\\s\\S]*?<price>)([^<]+)(</price>)`), (_, a, p, b) => a + String(Number(p) + 17) + b));
  const raw = x.store.putJson.bind(x.store);
  let fired = false, actor = null, opts = null;
  x.store.putJson = async (k, v, o) => {
    if (!fired && k === "state/operational.json" && v.rows?.[ID]?.[0] !== before) { fired = true; opts = o; x.clock.now += 20 * 60_000; actor = await x.cc(); }
    return raw(k, v, o);
  };
  let r;
  try { r = await x.publish(); } finally { x.store.putJson = raw; }
  assert.ok(fired, "передумова: перехоплення між verify і операційним записом");
  assert.equal(typeof opts?.ifMatch, "string", "операційний запис — умовний");
  assert.equal(actor.state, "COMMITTED");
  assert.ok((await x.controls.state()).removed.has(ID));
  assert.equal((await x.store.getJson("state/operational.json")).rows[ID][0], before, "ціна видаленого не оновлена після COMMITTED delete");
  assert.equal(r.sync.state, "ERROR");
  assert.ok(safeAfterCommit(await x.served()));
});

test("F05 × CC: intake через справжній робочий адаптер CC і шлюз W2 — «Рішення» = ВІДХИЛИТИ, поставлене під час запису черги, зберігається", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  const { SHEET } = L;
  const known = new Set([SHEET.main, SHEET.queue, SHEET.deferred].flatMap((n) => { const v = x.w.book[n], c = v[0].indexOf("ID постачальника"); return v.slice(1).map((r) => String(r[c])); }));
  const ready = L.intake.readyFromXml(x.w.xml, L.h.NOW).filter((r) => !known.has(r.id));
  assert.ok(ready.length >= 2);
  const apply = async (list) => { const s = await x.gateway.open({ writer: "intake" }); try { return await L.intake.intakeAll(x.w, x.w.xml, { stamp: new Date(x.clock.now).toISOString(), now: L.h.NOW, config: x.config, ready: list, catalog: L.intake.EMPTY_CATALOG, controls: x.controls, session: s }); } finally { await s.close(); } };
  assert.equal((await apply([ready[0]])).state, "INTAKE_DONE");
  const d = x.w.book[SHEET.queue][0].indexOf("Рішення");
  const rawU = x.w.mem.updateRanges.bind(x.w.mem), rawA = x.w.mem.appendRows.bind(x.w.mem);
  let fired = 0;
  const owner = () => { if (!fired++) x.w.mem.book[SHEET.queue][1][d] = "ВІДХИЛИТИ"; };
  x.w.mem.updateRanges = async (ranges) => { if (ranges.some((r) => r.title === SHEET.queue && r.row >= 2)) owner(); return rawU(ranges); };
  x.w.mem.appendRows = async (title, rows) => { if (title === SHEET.queue) owner(); return rawA(title, rows); };
  let r;
  try { r = await apply([ready[1]]); } finally { x.w.mem.updateRanges = rawU; x.w.mem.appendRows = rawA; }
  assert.ok(fired, "передумова: власник змінив рішення під час запису intake");
  assert.equal(x.w.book[SHEET.queue][1][d], "ВІДХИЛИТИ", JSON.stringify(r).slice(0, 300));
});

test("F07 × CC: протокол A зі сховищем фідів без атомарного CAS — без оголошення → BLOCKED до запуску; з обгорткою, що губить умову, → оренди з fencing немає, видалення не COMMITTED", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  const proxy = (over) => new Proxy(x.store, { get(t, p) { if (p in over) return over[p]; const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  const undeclared = await x.cc(proxy({ capabilities: undefined }));
  assert.equal(undeclared.state, "BLOCKED", JSON.stringify(undeclared).slice(0, 300));
  const dropping = await x.cc(proxy({ putJson: (k, v) => x.store.putJson(k, v) }));
  assert.notEqual(dropping.state, "COMMITTED", JSON.stringify(dropping).slice(0, 300));
  assert.equal((await x.controls.state()).removed.has(ID), false, "обмеження не зафіксовано без безпечного обслуговування");
  assert.equal((await x.cc()).state, "COMMITTED", "зі справжнім CAS — комміт");
  assert.ok(safeAfterCommit(await x.served()));
});
