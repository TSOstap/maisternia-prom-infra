/** ENG-18 × CC R7.1 — композиція зі СПРАВЖНІМ Catalog Controls на робочому шляху: повний productionConfig (не config:{}), контракт
 *  з файлу (як MM_CONTROLS_CONTRACT_FILE), FileStore + шлюз W2, спільний координатор для CC і публікації. Регресії Hermes ENG16-N1
 *  (G3 / P5) і P4 (гонка з новою публікацією). Без модуля CC (до злиття гілок) — пропуск. */
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
  const [prod, store, gw, helpers, common, run, seal, yml, sheetSync, sources, local, update, publisher, worker, r2, baseConfig] = await Promise.all([
    import("../src/pipeline/production.mjs"), import("../src/pipeline/safe-write/store.mjs"), import("../src/pipeline/safe-write/gateway.mjs"),
    import("./helpers/controls.mjs"), import("../src/core/controls-common.mjs"), import("../src/pipeline/controls-run.mjs"), import("../src/core/seal.mjs"),
    import("../src/core/yml.mjs"), import("../src/core/sheet-sync.mjs"), import("../src/pipeline/sources.mjs"), import("../src/storage/local.mjs"),
    import("../src/pipeline/update.mjs"), import("../src/publish/publisher.mjs"), import("../worker/src/index.js"), import("./helpers/r2-fake.mjs"),
    import("../config/default.json", { with: { type: "json" } }),
  ]);
  return { prod, FileStore: store.FileStore, WriteGateway: gw.WriteGateway, ...helpers, SALE_DECISION: common.SALE_DECISION, CC_SHEET: common.CC_SHEET,
    CHECKPOINT_KEY: run.CHECKPOINT_KEY, seal, yml, SHEET: sheetSync.SHEET, sources, LocalObjectStore: local.LocalObjectStore, runUpdate: update.runUpdate,
    readActiveXml: publisher.readActiveXml, manifestKey: publisher.manifestKey, worker: worker.default, r2BindingFrom: r2.r2BindingFrom, baseConfig: baseConfig.default };
};
/** Робочий світ: контракт — файл (активований контракт тестів), сховище W2 — FileStore, конфіг — productionConfig як у tools/sheet-sync. */
async function world(h, contract = h.ACTIVE_CONTRACT) {
  const w = await h.prepared();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-eng18-"));
  const contractFile = path.join(dir, "fixture-active-contract.json");
  await fsp.writeFile(contractFile, JSON.stringify(contract));
  const store = new h.FileStore(path.join(dir, "w2"));
  const gateway = new h.WriteGateway({ sheets: w.mem, read: (n) => w.mem.read(n), store });
  const config = h.prod.productionConfig(structuredClone(h.baseConfig));
  // ENG-20 (протокол A): запуск CC у робочому режимі — лише зі сховищем фідів з умовним записом (fencing + безпечне обслуговування).
  const feeds = new h.LocalObjectStore(path.join(dir, "objects"));
  const cc = (stamp, extra = {}) => h.prod.runCatalogControls({ sheets: w.mem, readBook: w.readBook, gateway, config, stamp, mode: "apply", contractFile, protection: h.PROTECTION_OK, feedStore: feeds, ...extra });
  const adapter = (extra = {}) => h.prod.loadCatalogControls({ loadBook: async () => structuredClone(w.book), store, config, contractFile, ...extra });
  return { w, dir, contractFile, store, gateway, config, cc, adapter, feeds };
}
/** Публікація під тим самим координатором W2, що й запуск CC (gateway.committer). */
async function feedWorld(h, x) {
  const feeds = x.feeds, supplier = path.join(x.dir, "supplier.xml"), catalog = path.join(x.dir, "catalog");
  const snapshot = () => h.sources.writeCatalogSnapshot(catalog, { sheets: x.w.book, groups: x.w.book[h.SHEET.groups] });
  await snapshot();
  await fsp.writeFile(supplier, x.w.xml);
  await feeds.putJson("approved/main.json", h.seal.approvalManifest(h.mainRows(x.w), h.yml.objectsFromValues(x.w.book[h.SHEET.groups], h.seal.GROUP_HEADERS)));
  x.config.supplier.minimumOffers = 10;
  const controls = await x.adapter({ feedStore: feeds });
  const ctx = (t) => ({ store: feeds, config: x.config, catalog: new h.sources.NdjsonCatalogSource(catalog), supplier: new h.sources.FileSupplierSource(supplier), now: () => t, tmpDir: x.dir, controls, coordinator: x.gateway.committer });
  const served = async () => {
    const res = await h.worker.fetch(new Request("https://local.invalid/feeds/main.xml?key=TEST_ONLY_ENG18"), { FEEDS_BUCKET: h.r2BindingFrom(feeds), FEED_ACCESS_KEY: "TEST_ONLY_ENG18", FEEDS: "main" });
    return { status: res.status, xml: await res.text() };
  };
  return { feeds, supplier, snapshot, controls, ctx, served };
}

test("ENG16-N1 / G3 (справжній productionConfig, контракт із файлу, FileStore): команда «ЗНЯТИ З ПРОДАЖУ» → код → COMMITTED; адаптер — held; повтор ідемпотентний", { skip }, async () => {
  const h = await load();
  const x = await world(h);
  assert.equal(x.config.controls.required, true, "передумова: робочий конфіг із допуском fail-closed Engineering");
  h.setCells(x.w, ID, { [h.SALE_DECISION]: "ЗНЯТИ З ПРОДАЖУ" });
  const r1 = await x.cc(h.later(1));
  assert.ok(["COMMITTED", "PENDING"].includes(r1.state), JSON.stringify(r1).slice(0, 400));
  h.setCells(x.w, ID, { [h.SALE_DECISION]: `ЗНЯТИ З ПРОДАЖУ ${h.codeOf(x.w, ID, "ЗНЯТИ З ПРОДАЖУ")}` });
  assert.equal((await x.cc(h.later(2))).state, "COMMITTED");
  const st = await (await x.adapter()).state();
  assert.equal(st.blocked, false, JSON.stringify(st.reasons));
  assert.ok(st.held.has(ID));
  const v1 = (await x.store.getJsonVersioned(h.CHECKPOINT_KEY)).version;
  await x.cc(h.later(3));
  assert.equal((await x.store.getJsonVersioned(h.CHECKPOINT_KEY)).version, v1, "ідемпотентний повтор");
});

test("ENG16-N1: строгість конфігу CC не послаблена — невідомий ключ у config.controls (окрім required Engineering) → CC ABORTED, 0 записів таблиці", { skip }, async () => {
  const h = await load();
  const x = await world(h);
  x.config.controls.bogusLimit = 1;
  h.setCells(x.w, ID, { [h.SALE_DECISION]: "ЗНЯТИ З ПРОДАЖУ" });
  const before = JSON.stringify(x.w.book);
  const r = await x.cc(h.later(1));
  assert.equal(r.state, "ABORTED", JSON.stringify(r).slice(0, 300));
  assert.match(r.reason, /bogusLimit: невідомий параметр/);
  assert.doesNotMatch(r.reason, /required/);
  assert.equal(JSON.stringify(x.w.book), before);
});

test("ENG16-N1 / P5 (повний productionConfig для CC і runUpdate, спільний координатор): код ФАКТИЧНО видано між двома публікаціями → REUSED", { skip }, async () => {
  const h = await load();
  const x = await world(h);
  assert.ok(["COMMITTED", "PENDING"].includes((await x.cc(h.later(0))).state), "ініціалізація контрольної точки — робочим конфігом");
  const f = await feedWorld(h, x);
  const r1 = await h.runUpdate(f.ctx(h.NOW));
  assert.equal(r1.feeds[0].state, "PUBLISHED", JSON.stringify(r1.feeds[0]).slice(0, 300));
  h.setCells(x.w, ID, { [h.SALE_DECISION]: "ЗНЯТИ З ПРОДАЖУ" });
  const issue = await x.cc(h.later(1));
  assert.ok(["COMMITTED", "PENDING"].includes(issue.state), JSON.stringify(issue).slice(0, 300));
  assert.match(String(h.viewOf(x.w, ID)?.["Коди підтвердження"] || ""), /ЗНЯТИ З ПРОДАЖУ\s+[0-9A-F]{6}/, "код видано (передумова REUSED)");
  const r2 = await h.runUpdate(f.ctx(h.NOW));
  assert.equal(r2.feeds[0].state, "REUSED", JSON.stringify(r2.feeds[0]).slice(0, 300));
});

test("P4 (нова публікація, справжній CC через робочий запуск): видалення, ініційоване в момент PUT маніфесту, — BUSY (спільна оренда W2); далі комітиться, наступна публікація і Worker не віддають offer", { skip }, async () => {
  const h = await load();
  const x = await world(h);
  assert.ok(["COMMITTED", "PENDING"].includes((await x.cc(h.later(0))).state));
  const f = await feedWorld(h, x);
  assert.equal((await h.runUpdate(f.ctx(h.NOW))).feeds[0].state, "PUBLISHED");
  await fsp.writeFile(f.supplier, x.w.xml.replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 1) + b));
  const DEL = `ВИДАЛИТИ ТОВАР ${ID}`;
  h.setCells(x.w, ID, { [h.SALE_DECISION]: DEL });
  await x.cc(h.later(1)); // запит коду
  h.setCells(x.w, ID, { [h.SALE_DECISION]: `${DEL} ${h.codeOf(x.w, ID, DEL)}` });
  const injected = [];
  const raw = f.feeds.putJson.bind(f.feeds);
  // ENG-22: перехоплювач передає умову запису (opts) — обгортку, що її губить, функціональна CAS-проба fencing справедливо відхиляє (NO_CAS).
  f.feeds.putJson = async (k, v, ...o) => {
    if (k === h.manifestKey("main") && !injected.length) injected.push((await x.cc(h.later(2))).state); // підтвердження — у вікні PUT маніфесту
    return raw(k, v, ...o);
  };
  const u = await h.runUpdate(f.ctx(h.NOW + 60_000));
  f.feeds.putJson = raw;
  assert.equal(u.feeds[0].state, "PUBLISHED", JSON.stringify(u.feeds[0]).slice(0, 300));
  assert.deepEqual(injected, ["BUSY"], "запуск CC у вікні публікації не отримав оренди");
  assert.equal((await f.controls.state()).removed.has(ID), false, "видалення не зафіксовано до перемикання маніфесту");
  const s1 = await f.served();
  assert.equal(s1.status, 200);
  assert.ok(h.yml.offersById(s1.xml).has(ID), "товар ще не видалено — він законно в YML");
  // Після публікації: підтвердження комітиться, наступна публікація прибирає offer; Worker віддає версію без нього.
  assert.equal((await x.cc(h.later(3))).state, "COMMITTED");
  assert.ok((await f.controls.state()).removed.has(ID));
  const u2 = await h.runUpdate(f.ctx(h.NOW + 120_000));
  assert.ok(["PUBLISHED", "REUSED"].includes(u2.feeds[0].state), JSON.stringify(u2.feeds[0]).slice(0, 300));
  assert.equal(h.yml.offersById((await h.readActiveXml(f.feeds, "main")).xml).has(ID), false);
  const s2 = await f.served();
  assert.ok(s2.status !== 200 || !h.yml.offersById(s2.xml).has(ID), "Worker не віддає видалений offer");
});

test("P4 (той самий світ): публікація без координатора у робочому конфігу — BLOCKED_W2, маніфест не змінено", { skip }, async () => {
  const h = await load();
  const x = await world(h);
  const f = await feedWorld(h, x);
  const r = await h.runUpdate({ ...f.ctx(h.NOW), coordinator: undefined });
  assert.equal(r.feeds?.[0]?.state ?? r.state, "BLOCKED_W2", JSON.stringify(r).slice(0, 300));
  assert.equal(await f.feeds.getJson(h.manifestKey("main")).catch(() => null), null);
});
