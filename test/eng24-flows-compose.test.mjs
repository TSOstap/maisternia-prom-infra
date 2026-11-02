/** ENG-24 × CC R7.3 — робочі сценарії через протокол A (cc-serving-v2) і фактично обслуговуваний YML (Worker GET): зняття з
 *  продажу, повернення в продаж, підтвердження власника (без коду / хибний / правильний), видалення → архів → DONE. Повний
 *  productionConfig, FileStore W2, LocalObjectStore. Модель — один хост; без модуля CC R7.3 — пропуск. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ccFiles = ["../src/core/controls-plan.mjs", "../src/pipeline/controls-run.mjs", "./helpers/controls.mjs"].every((p) => fs.existsSync(new URL(p, import.meta.url)));
const r73 = ccFiles && /export function recoverCheckpoint/.test(fs.readFileSync(new URL("../src/core/controls-plan.mjs", import.meta.url), "utf8"));
const skip = r73 ? false : "модуль Catalog Controls R7.3 відсутній — композиційна проба";
const ID = "1500000007";
async function world() {
  const [prod, store, gw, h, common, seal, yml, sheetSync, sources, local, update, worker, r2, baseConfig] = await Promise.all([
    import("../src/pipeline/production.mjs"), import("../src/pipeline/safe-write/store.mjs"), import("../src/pipeline/safe-write/gateway.mjs"),
    import("./helpers/controls.mjs"), import("../src/core/controls-common.mjs"), import("../src/core/seal.mjs"), import("../src/core/yml.mjs"),
    import("../src/core/sheet-sync.mjs"), import("../src/pipeline/sources.mjs"), import("../src/storage/local.mjs"), import("../src/pipeline/update.mjs"),
    import("../worker/src/index.js"), import("./helpers/r2-fake.mjs"), import("../config/default.json", { with: { type: "json" } }),
  ]);
  const w = await h.prepared();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-e24f-"));
  const clock = { now: h.NOW };
  const state = new store.FileStore(path.join(dir, "w2"));
  const gateway = new gw.WriteGateway({ sheets: w.mem, read: (n) => w.mem.read(n), store: state, now: () => clock.now });
  const feeds = new local.LocalObjectStore(path.join(dir, "objects"));
  const config = prod.productionConfig(structuredClone(baseConfig.default));
  config.supplier.minimumOffers = 10;
  const contractFile = path.join(dir, "contract.json");
  await fsp.writeFile(contractFile, JSON.stringify(h.ACTIVE_CONTRACT));
  const cc = () => { clock.now += 60_000; return prod.runCatalogControls({ sheets: w.mem, readBook: w.readBook, gateway, config, stamp: new Date(clock.now).toISOString(), mode: "apply", contractFile, protection: h.PROTECTION_OK, feedStore: feeds }); };
  assert.ok(["COMMITTED", "PENDING"].includes((await cc()).state));
  const catalog = path.join(dir, "catalog"), supplier = path.join(dir, "supplier.xml");
  const snapshot = () => sources.writeCatalogSnapshot(catalog, { sheets: w.book, groups: w.book[sheetSync.SHEET.groups] });
  await snapshot();
  await fsp.writeFile(supplier, w.xml);
  await feeds.putJson("approved/main.json", seal.approvalManifest(h.mainRows(w), yml.objectsFromValues(w.book[sheetSync.SHEET.groups], seal.GROUP_HEADERS)));
  const controls = await prod.loadCatalogControls({ loadBook: async () => structuredClone(w.book), store: state, config, contractFile, feedStore: feeds });
  const ctx = { store: feeds, config, catalog: new sources.NdjsonCatalogSource(catalog), supplier: new sources.FileSupplierSource(supplier), now: () => clock.now, tmpDir: dir, controls, coordinator: gateway.committer };
  const publish = async () => { clock.now += 60_000; await snapshot(); return update.runUpdate(ctx); };
  const served = async (id = ID) => {
    const r = await worker.default.fetch(new Request("https://local.invalid/feeds/main.xml?key=TEST_E24F"), { FEEDS_BUCKET: r2.r2BindingFrom(feeds), FEED_ACCESS_KEY: "TEST_E24F", FEEDS: "main" });
    const xml = r.status === 200 ? await r.text() : "";
    return { status: r.status, xml, present: Boolean(xml) && yml.offersById(xml).has(id), available: new RegExp(`<offer id="${id}"[^>]*available="(true|false)"`).exec(xml)?.[1] ?? null };
  };
  return { h, w, prod, gateway, feeds, config, cc, controls, publish, served, SALE: common.SALE_DECISION, readBook: w.readBook };
}

test("Підтвердження власника: команда без коду → код видано (PENDING); хибний код → не виконано; правильний → COMMITTED; ЗНЯТИ → Worker available=\"false\"; ПОВЕРНУТИ В ПРОДАЖ → available=\"true\"", { skip }, async () => {
  const x = await world();
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  // Товар, який постачальник має в наявності (у синтетиці частина недоступна): саме для нього зняття / повернення видно в YML.
  const xml0 = (await x.served()).xml, main = new Set(x.h.mainRows(x.w).map((r) => String(r["Offer ID"])));
  const HID = [...xml0.matchAll(/<offer id="(\d+)"[^>]*available="true"/g)].map((m) => m[1]).find((id) => main.has(id) && id !== ID);
  assert.ok(HID, "передумова: є доступний товар");
  assert.equal((await x.served(HID)).available, "true");
  const HOLD = "ЗНЯТИ З ПРОДАЖУ";
  x.h.setCells(x.w, HID, { [x.SALE]: HOLD });
  const r1 = await x.cc();
  assert.ok(["PENDING", "COMMITTED"].includes(r1.state), JSON.stringify(r1).slice(0, 200));
  const code = x.h.codeOf(x.w, HID, HOLD);
  assert.match(code, /^[0-9A-F]{6}$/);
  x.h.setCells(x.w, HID, { [x.SALE]: `${HOLD} ${code === "000000" ? "111111" : "000000"}` });
  await x.cc();
  assert.equal((await x.controls.state()).held.has(HID), false, "хибний код не виконує");
  x.h.setCells(x.w, HID, { [x.SALE]: `${HOLD} ${x.h.codeOf(x.w, HID, HOLD)}` });
  assert.equal((await x.cc()).state, "COMMITTED");
  assert.ok((await x.controls.state()).held.has(HID));
  assert.notEqual((await x.served(HID)).available, "true", "протокол A: знятий не доступний уже після коміту");
  assert.ok(["PUBLISHED", "REUSED"].includes((await x.publish()).feeds[0].state));
  assert.equal((await x.served(HID)).available, "false");
  const REL = "ПОВЕРНУТИ В ПРОДАЖ";
  x.h.setCells(x.w, HID, { [x.SALE]: REL });
  await x.cc();
  x.h.setCells(x.w, HID, { [x.SALE]: `${REL} ${x.h.codeOf(x.w, HID, REL)}` });
  assert.equal((await x.cc()).state, "COMMITTED");
  assert.equal((await x.controls.state()).held.has(HID), false);
  assert.ok(["PUBLISHED", "REUSED"].includes((await x.publish()).feeds[0].state));
  assert.equal((await x.served(HID)).available, "true", "повернення в продаж — у фактично обслуговуваному YML");
});

test("Видалення: ВИДАЛИТИ ТОВАР → COMMITTED (Worker без offer одразу) → перенесення в архів через шлюз → публікація без offer → «ЗАВЕРШЕНО» → стадія DONE", { skip }, async () => {
  const x = await world();
  assert.equal((await x.publish()).feeds[0].state, "PUBLISHED");
  const DEL = `ВИДАЛИТИ ТОВАР ${ID}`;
  x.h.setCells(x.w, ID, { [x.SALE]: DEL });
  await x.cc();
  x.h.setCells(x.w, ID, { [x.SALE]: `${DEL} ${x.h.codeOf(x.w, ID, DEL)}` });
  assert.equal((await x.cc()).state, "COMMITTED");
  assert.equal((await x.served()).present, false);
  const a1 = await x.prod.runArchiveStep({ readBook: x.readBook, gateway: x.gateway, controls: x.controls, stamp: new Date(x.h.NOW + 9e6).toISOString(), feedStore: x.feeds, config: x.config });
  assert.equal(a1.state, "ARCHIVED", JSON.stringify(a1).slice(0, 300));
  assert.ok(!x.h.mainRows(x.w).some((r) => String(r["Offer ID"]) === ID));
  assert.ok(["PUBLISHED", "REUSED"].includes((await x.publish()).feeds[0].state));
  assert.equal((await x.served()).present, false);
  const a2 = await x.prod.runArchiveStep({ readBook: x.readBook, gateway: x.gateway, controls: x.controls, stamp: new Date(x.h.NOW + 9.1e6).toISOString(), feedStore: x.feeds, config: x.config });
  assert.deepEqual([...(a1.published?.done || []), ...(a2.published?.done || [])], [ID]);
  assert.equal((await x.controls.state()).tombstoned.get(ID)?.stage, "DONE");
});
