/** ENG-20 × CC — протокол A («спершу обслуговування») + B (умовне перемикання маніфесту з епохою fencing) зі СПРАВЖНІМ Catalog
 *  Controls, повним productionConfig, FileStore + WriteGateway, локальним Worker (GET / HEAD). Інваріант: після коміту обмеження CC
 *  жодна відповідь Worker 200 не містить видаленого товару — зокрема за BUSY, перехоплення оренди й затриманого PUT.
 *  Модель — LocalObjectStore (умовний запис на одному хості): НЕ доказ поведінки R2 чи розгорнутого Worker. Без модуля CC — пропуск. */
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
  const [prod, store, gw, h, common, seal, yml, sheetSync, sources, local, update, publisher, worker, r2, baseConfig] = await Promise.all([
    import("../src/pipeline/production.mjs"), import("../src/pipeline/safe-write/store.mjs"), import("../src/pipeline/safe-write/gateway.mjs"),
    import("./helpers/controls.mjs"), import("../src/core/controls-common.mjs"), import("../src/core/seal.mjs"), import("../src/core/yml.mjs"),
    import("../src/core/sheet-sync.mjs"), import("../src/pipeline/sources.mjs"), import("../src/storage/local.mjs"), import("../src/pipeline/update.mjs"),
    import("../src/publish/publisher.mjs"), import("../worker/src/index.js"), import("./helpers/r2-fake.mjs"), import("../config/default.json", { with: { type: "json" } }),
  ]);
  return { prod, FileStore: store.FileStore, WriteGateway: gw.WriteGateway, h, SALE: common.SALE_DECISION, seal, yml, SHEET: sheetSync.SHEET, sources, LocalObjectStore: local.LocalObjectStore, update, manifestKey: publisher.manifestKey, worker: worker.default, r2: r2.r2BindingFrom, baseConfig: baseConfig.default, publisher_read: (x) => publisher.readActiveXml(x.store, "main") };
};
/** Світ: справжній CC (контракт із файлу), FileStore W2 з віртуальним годинником, сховище фідів LocalObjectStore, публікатор під тим самим координатором. */
async function world(L) {
  const { h } = L;
  const w = await h.prepared();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-e20ab-"));
  const clock = { now: h.NOW };
  const state = new L.FileStore(path.join(dir, "w2"));
  const gateway = new L.WriteGateway({ sheets: w.mem, read: (n) => w.mem.read(n), store: state, now: () => clock.now });
  const store = new L.LocalObjectStore(path.join(dir, "objects"));
  const config = L.prod.productionConfig(structuredClone(L.baseConfig));
  config.supplier.minimumOffers = 10;
  const contractFile = path.join(dir, "contract.json");
  await fsp.writeFile(contractFile, JSON.stringify(h.ACTIVE_CONTRACT));
  const cc = () => L.prod.runCatalogControls({ sheets: w.mem, readBook: w.readBook, gateway, config, stamp: new Date(clock.now).toISOString(), mode: "apply", contractFile, protection: h.PROTECTION_OK, feedStore: store });
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
  const bump = () => fsp.writeFile(supplier, w.xml.replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 1) + b));
  const served = async () => {
    const out = {};
    for (const method of ["GET", "HEAD"]) {
      const r = await L.worker.fetch(new Request("https://local.invalid/feeds/main.xml?key=TEST_E20", { method }), { FEEDS_BUCKET: L.r2(store), FEED_ACCESS_KEY: "TEST_E20", FEEDS: "main" });
      out[method] = { status: r.status, version: r.headers.get("x-feed-version"), deleted: r.status === 200 && method === "GET" && L.yml.offersById(await r.text()).has(ID) };
    }
    return out;
  };
  return { w, dir, clock, state, gateway, store, config, cc, controls, ctx, prepareDelete, publish, bump, served };
}
const deletedServed = (s) => Object.values(s).some((x) => x.deleted);

test("A (E17-01): коміт видалення CC — обслуговування безпечне вже ДО коміту (Worker без видаленого одразу); далі W2 BUSY + збій CC / зникла активна — теж без видаленого", { skip }, async () => {
  const L = await load();
  for (const variant of ["CC_OUTAGE", "ACTIVE_MISSING"]) {
    const x = await world(L);
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    await x.bump(); x.clock.now += 60_000;
    assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
    await x.prepareDelete();
    assert.equal((await x.cc()).state, "COMMITTED");
    assert.ok((await x.controls.state()).removed.has(ID));
    assert.equal(deletedServed(await x.served()), false, variant + ": одразу після коміту, без публікації");
    if (variant === "ACTIVE_MISSING") { const m = await x.store.getJson(L.manifestKey("main")); await x.store.delete(m.active.key); }
    else x.ctx.controls = { ...x.controls, state: async () => { throw new Error("test outage"); } };
    await fsp.writeFile(path.join(x.dir, "supplier.xml"), "<broken>");
    const busy = await x.gateway.committer.acquire("sync");
    let r;
    try { r = await x.publish(); assert.equal(deletedServed(await x.served()), false, variant + ": під час BUSY"); } finally { await busy.release(); }
    assert.equal(r.feeds[0].state, "BLOCKED_W2");
  }
});

test("A: безпечне обслуговування недосяжне (сховище фідів відмовляє записи) — CC НЕ звітує COMMITTED, видалення не зафіксоване", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  const rawPut = x.store.put.bind(x.store), rawJson = x.store.putJson.bind(x.store);
  x.store.put = async (k, ...a) => { if (String(k).startsWith("feeds/main/versions/")) throw new Error("test: відмова сховища"); return rawPut(k, ...a); };
  x.store.putJson = async (k, v, ...o) => { if (k === L.manifestKey("main") && v?.withdrawn) throw new Error("test: відмова маніфесту"); return rawJson(k, v, ...o); };
  const r = await x.cc();
  x.store.put = rawPut; x.store.putJson = rawJson;
  assert.notEqual(r.state, "COMMITTED", JSON.stringify(r).slice(0, 300));
  // ENG-24: відмову формулює CC R7.3 (C1 / C6): beforeCommit протоколу A не видав квитка — «serving not secured».
  assert.match(String(r.reason || ""), /serving not secured/);
  assert.equal((await x.controls.state()).removed.has(ID), false);
});

test("A: збій після безпечного обслуговування, ДО запису контрольної точки — не COMMITTED; Worker без видаленого (надто обережно, безпечно)", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  const raw = x.state.putJsonIfVersionFenced.bind(x.state);
  let failed = 0;
  x.state.putJsonIfVersionFenced = async (k, ...a) => { if (String(k).includes("catalog-controls/checkpoint") && !failed) { failed++; throw Object.assign(new Error("test: процес упав"), { code: "CRASH" }); } return raw(k, ...a); };
  const r = await x.cc();
  x.state.putJsonIfVersionFenced = raw;
  assert.notEqual(r.state, "COMMITTED");
  assert.equal((await x.controls.state()).removed.has(ID), false);
  assert.equal(deletedServed(await x.served()), false);
});

test("B (E17-02): затриманий PUT відкату з умовою запиту — CC перехоплює оренду (TTL + settle) і фіксує видалення під час затримки → 412; Worker ні під час, ні після не віддає видалений", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.bump(); x.clock.now += 60_000;
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  const raw = x.store.putJson.bind(x.store), key = L.manifestKey("main");
  let fired = false, during, actor, err;
  x.store.putJson = async (k, v, ...o) => {
    if (!fired && k === key && v?.rolledBackAt) {
      fired = true; x.clock.now += 20 * 60_000; actor = await x.cc();
      try { return await raw(k, v, ...o); } finally { during = await x.served(); }
    }
    return raw(k, v, ...o);
  };
  try { await L.update.guardedRollback({ store: x.store, feed: "main", controls: x.controls, coordinator: x.gateway.committer }); } catch (e) { err = e.message; }
  x.store.putJson = raw;
  assert.ok(fired);
  assert.equal(actor.state, "COMMITTED");
  assert.match(String(err), /STALE_FENCE/);
  assert.equal(deletedServed(during), false, "усередині затриманого PUT");
  assert.equal(deletedServed(await x.served()), false);
});

test("B: затриманий PUT перемикання НОВОЇ публікації — CC перехоплює й фіксує видалення → 412; Worker без видаленого", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  await x.prepareDelete();
  await x.bump(); x.clock.now += 60_000;
  const raw = x.store.putJson.bind(x.store), key = L.manifestKey("main");
  let fired = false, during, actor;
  x.store.putJson = async (k, v, ...o) => {
    if (!fired && k === key && o[0]?.ifMatch !== undefined && v?.fence?.scope === "publisher" && v.active?.key && (await x.store.getJson(k))?.active?.key !== v.active.key) {
      fired = true; x.clock.now += 20 * 60_000; actor = await x.cc();
      try { return await raw(k, v, ...o); } finally { during = await x.served(); }
    }
    return raw(k, v, ...o);
  };
  const u = await x.publish();
  x.store.putJson = raw;
  assert.ok(fired);
  assert.equal(actor.state, "COMMITTED");
  assert.notEqual(u.feeds[0].state, "PUBLISHED");
  assert.match(String(u.feeds[0].error || ""), /STALE_FENCE/);
  assert.equal(deletedServed(during), false);
  assert.equal(deletedServed(await x.served()), false);
});

test("B: запуск CC САМ підвищує епоху — обслуговувана версія вже безпечна щодо нового зняття (A нічого не пише), а затриманий кандидат публікатора — ні → 412; Worker не віддає знятий як доступний", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  const HOLD = "ЗНЯТИ З ПРОДАЖУ";
  const avail = (xml) => /available="(true|false)"/.exec(L.yml.offersById(xml).get(ID)?.slice(0, 300) || "")?.[1] ?? null;
  const flip = (xml, v) => xml.replace(new RegExp(`(<offer\\b[^>]*\\bid="${ID}"[^>]*\\bavailable=")(true|false)"`), `$1${v}"`);
  // 1) Чинна версія: товар недоступний у постачальника.
  await fsp.writeFile(path.join(x.dir, "supplier.xml"), flip(x.w.xml, "false"));
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  assert.equal(avail((await L.publisher_read(x)).xml), "false", "передумова: у чинній версії товар недоступний");
  // 2) Запит коду зняття; постачальник повернув наявність → новий кандидат публікатора має товар ДОСТУПНИМ.
  L.h.setCells(x.w, ID, { [L.SALE]: HOLD });
  assert.ok(["COMMITTED", "PENDING"].includes((await x.cc()).state));
  L.h.setCells(x.w, ID, { [L.SALE]: `${HOLD} ${L.h.codeOf(x.w, ID, HOLD)}` });
  await fsp.writeFile(path.join(x.dir, "supplier.xml"), flip(x.w.xml, "true")); x.clock.now += 60_000;
  // 3) Затриманий PUT перемикання: тим часом CC перехоплює оренду й фіксує зняття (A: чинна версія вже безпечна — нічого не пише).
  const raw = x.store.putJson.bind(x.store), key = L.manifestKey("main");
  let fired = false, actor, during;
  x.store.putJson = async (k, v, ...o) => {
    if (!fired && k === key && o[0]?.ifMatch !== undefined && v?.fence?.scope === "publisher" && v.active?.key && (await x.store.getJson(k))?.active?.key !== v.active.key) {
      fired = true; x.clock.now += 20 * 60_000; actor = await x.cc();
      try { return await raw(k, v, ...o); } finally { const r = await L.worker.fetch(new Request("https://local.invalid/feeds/main.xml?key=TEST_E20"), { FEEDS_BUCKET: L.r2(x.store), FEED_ACCESS_KEY: "TEST_E20", FEEDS: "main" }); during = r.status === 200 ? avail(await r.text()) : "не обслуговується"; }
    }
    return raw(k, v, ...o);
  };
  const u = await x.publish();
  x.store.putJson = raw;
  assert.ok(fired);
  assert.equal(actor.state, "COMMITTED");
  assert.ok((await x.controls.state()).held.has(ID));
  assert.notEqual(u.feeds[0].state, "PUBLISHED", "затриманий PUT не мав пройти");
  assert.notEqual(during, "true", "знятий товар не обслуговується як доступний");
});

test("A + B: робочий режим — активований контракт без сховища фідів → BLOCKED (обмеження не фіксуються); неактивований — NOT_ACTIVATED (рішення CC)", { skip }, async () => {
  const L = await load();
  const x = await world(L);
  const base = { sheets: x.w.mem, readBook: x.w.readBook, gateway: x.gateway, config: x.config, stamp: new Date(x.clock.now).toISOString(), mode: "apply", protection: L.h.PROTECTION_OK };
  const r1 = await L.prod.runCatalogControls({ ...base, contract: L.h.ACTIVE_CONTRACT });
  assert.equal(r1.state, "BLOCKED");
  assert.match(r1.reason, /протокол A/);
  const r2 = await L.prod.runCatalogControls({ ...base, contract: { ...L.h.ACTIVE_CONTRACT, activated: false, activatedAt: null } });
  assert.equal(r2.state, "NOT_ACTIVATED");
});
