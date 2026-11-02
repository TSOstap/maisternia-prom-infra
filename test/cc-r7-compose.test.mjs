/** CC R7 × Engineering — композиція зі СПРАВЖНІМ Catalog Controls (acceptance matrix A1 / A2 / G2 / G3 / P5).
 *  Без модуля CC (до злиття гілок) — пропуск. */
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
  const [prod, store, gw, helpers, common, seal, yml, sheetSync, sources, local, update, publisher, legacy] = await Promise.all([
    import("../src/pipeline/production.mjs"), import("../src/pipeline/safe-write/store.mjs"), import("../src/pipeline/safe-write/gateway.mjs"),
    import("./helpers/controls.mjs"), import("../src/core/controls-common.mjs"), import("../src/core/seal.mjs"), import("../src/core/yml.mjs"),
    import("../src/core/sheet-sync.mjs"), import("../src/pipeline/sources.mjs"), import("../src/storage/local.mjs"), import("../src/pipeline/update.mjs"),
    import("../src/publish/publisher.mjs"), import("./helpers/legacy-config.mjs"),
  ]);
  return { prod, EngStore: store.MemoryStore, WriteGateway: gw.WriteGateway, ...helpers, SALE_DECISION: common.SALE_DECISION, seal, yml, SHEET: sheetSync.SHEET, sources, LocalObjectStore: local.LocalObjectStore, runUpdate: update.runUpdate, readActiveXml: publisher.readActiveXml, baseConfig: (() => { const c = structuredClone(legacy.default); delete c.ownerPriority; return c; })() };
};
/** Світ CC (prepared) + шлюз W2 над сховищем Engineering + корінь запуску CC (apply, активований контракт тестів).
 *  ENG-23 (рішення власника Q4): apply — лише через протокол A: робочий конфіг (w2.required) і ОДНЕ сховище фідів світу (стіл квитків
 *  сховища W2 прив'язується до нього). */
async function world(h) {
  const w = await h.prepared();
  const store = new h.EngStore();
  const gateway = new h.WriteGateway({ sheets: w.mem, read: (n) => w.mem.read(n), store });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-cc7-"));
  const feeds = new h.LocalObjectStore(path.join(dir, "objects"));
  const ccConfig = h.prod.productionConfig(structuredClone(h.baseConfig));
  // Захист для видалення — двійник CC (PROTECTION_OK); робочий шлях бере loadProtection (FZ / MM_FREEZE_IDS / MM_OWNER_VALUES).
  const ccRun = (stamp, extra = {}) => h.prod.runCatalogControls({ sheets: w.mem, readBook: w.readBook, gateway, config: ccConfig, stamp, mode: "apply", contract: h.ACTIVE_CONTRACT, protection: h.PROTECTION_OK, feedStore: feeds, ...extra });
  const adapter = (extra = {}) => h.prod.loadCatalogControls({ loadBook: async () => structuredClone(w.book), store, config: h.baseConfig, contract: h.ACTIVE_CONTRACT, ...extra });
  return { w, store, gateway, ccRun, adapter, dir, feeds };
}

test("G3 + A1: команда власника «ЗНЯТИ З ПРОДАЖУ» через робочий корінь запуску CC (readiness / integrity / контракт) → COMMITTED; робочий адаптер бачить активований CC і held", { skip }, async () => {
  const h = await load();
  const { w, ccRun, adapter } = await world(h);
  h.setCells(w, ID, { [h.SALE_DECISION]: "ЗНЯТИ З ПРОДАЖУ" });
  const r1 = await ccRun(h.later(1));
  assert.ok(["COMMITTED", "PENDING"].includes(r1.state), JSON.stringify(r1).slice(0, 300));
  h.setCells(w, ID, { [h.SALE_DECISION]: `ЗНЯТИ З ПРОДАЖУ ${h.codeOf(w, ID, "ЗНЯТИ З ПРОДАЖУ")}` });
  const r2 = await ccRun(h.later(2));
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2).slice(0, 300));
  const st = await (await adapter()).state();
  assert.equal(st.blocked, false, JSON.stringify(st.reasons));
  assert.equal(st.active, true, "A1: активований контракт дійшов до CC");
  assert.ok(st.held.has(ID), "команда виконана — товар знято");
});
test("A2: контракт CC із problems — робочий адаптер blocked; запуск CC — BLOCKED, 0 записів", { skip }, async () => {
  const h = await load();
  const { w, ccRun, adapter } = await world(h);
  const bad = { ...h.ACTIVE_CONTRACT, v: 2, deletion: "AVAILABLE_FALSE" }; // контракт v2 (старе правило видалення) — CC відхиляє
  const st = await (await adapter({ contract: bad })).state();
  assert.equal(st.blocked, true);
  const before = JSON.stringify(w.book);
  assert.equal((await ccRun(h.later(1), { contract: bad })).state, "BLOCKED");
  assert.equal(JSON.stringify(w.book), before, "нічого не записано");
});
test("G2: контракт репозиторію (activated:false) — робочий шлях fail-closed: адаптер blocked, update BLOCKED_CC; запуск CC apply — NOT_ACTIVATED", { skip }, async () => {
  const h = await load();
  const { w, store, gateway } = await world(h);
  const prodAdapter = await h.prod.loadCatalogControls({ loadBook: async () => structuredClone(w.book), store, config: h.baseConfig }); // контракт із репозиторію
  const st = await prodAdapter.state();
  assert.equal(st.blocked, true);
  assert.match(st.reasons.join(" "), /не активовано/);
  const r = await h.prod.runCatalogControls({ sheets: w.mem, readBook: w.readBook, gateway, config: {}, stamp: h.later(1), mode: "apply" });
  assert.equal(r.state, "NOT_ACTIVATED");
});
test("P5: запит коду власником між двома публікаціями — відбиток CC той самий → REUSED (наскрізно: runUpdate + робочий адаптер + запуск CC)", { skip }, async () => {
  const h = await load();
  const { w, store, gateway, ccRun, adapter, dir, feeds } = await world(h);
  assert.ok(["COMMITTED", "PENDING"].includes((await ccRun(h.later(0))).state)); // ініціалізація контрольної точки
  const supplier = path.join(dir, "supplier.xml"), catalog = path.join(dir, "catalog");
  await h.sources.writeCatalogSnapshot(catalog, { sheets: w.book, groups: w.book[h.SHEET.groups] });
  await fsp.writeFile(supplier, w.xml);
  await feeds.putJson("approved/main.json", h.seal.approvalManifest(h.mainRows(w), h.yml.objectsFromValues(w.book[h.SHEET.groups], h.seal.GROUP_HEADERS)));
  const config = h.prod.productionConfig(structuredClone(h.baseConfig)); config.supplier.minimumOffers = 10;
  const controls = await adapter({ feedStore: feeds });
  // ENG-17: публікація під орендою того самого координатора W2, що й запуск CC.
  const ctx = () => ({ store: feeds, config, catalog: new h.sources.NdjsonCatalogSource(catalog), supplier: new h.sources.FileSupplierSource(supplier), now: () => h.NOW, tmpDir: dir, controls, coordinator: gateway.committer });
  const r1 = await h.runUpdate(ctx());
  assert.equal(r1.feeds[0].state, "PUBLISHED", JSON.stringify(r1.feeds[0]).slice(0, 300));
  h.setCells(w, ID, { [h.SALE_DECISION]: "ЗНЯТИ З ПРОДАЖУ" }); // запит коду (команда без коду)
  assert.ok(["COMMITTED", "PENDING"].includes((await ccRun(h.later(1))).state));
  assert.match(String(h.viewOf(w, ID)?.["Коди підтвердження"] || ""), /ЗНЯТИ З ПРОДАЖУ\s+[0-9A-F]{6}/, "код видано");
  const r2 = await h.runUpdate(ctx());
  assert.equal(r2.feeds[0].state, "REUSED", JSON.stringify(r2.feeds[0]).slice(0, 300));
  assert.ok(store);
});

test("Наскрізно: «Видалити товар» (запуск CC) → перенесення в архів через шлюз → YML без offer → «ЗАВЕРШЕНО» → стадія CC DONE; повтор — без змін", { skip }, async () => {
  const h = await load();
  const { w, gateway, ccRun, adapter, dir, feeds } = await world(h);
  const { offersById } = h.yml;
  assert.ok(["COMMITTED", "PENDING"].includes((await ccRun(h.later(0))).state));
  const supplier = path.join(dir, "supplier.xml"), catalog = path.join(dir, "catalog");
  const snapshot = async () => h.sources.writeCatalogSnapshot(catalog, { sheets: w.book, groups: w.book[h.SHEET.groups] });
  await snapshot();
  await fsp.writeFile(supplier, w.xml);
  await feeds.putJson("approved/main.json", h.seal.approvalManifest(h.mainRows(w), h.yml.objectsFromValues(w.book[h.SHEET.groups], h.seal.GROUP_HEADERS)));
  const config = h.prod.productionConfig(structuredClone(h.baseConfig)); config.supplier.minimumOffers = 10;
  const controls = await adapter({ feedStore: feeds });
  const ctx = (t) => ({ store: feeds, config, catalog: new h.sources.NdjsonCatalogSource(catalog), supplier: new h.sources.FileSupplierSource(supplier), now: () => t, tmpDir: dir, controls, coordinator: gateway.committer });
  assert.equal((await h.runUpdate(ctx(h.NOW))).feeds[0].state, "PUBLISHED");
  assert.ok(offersById((await h.readActiveXml(feeds, "main")).xml).has(ID));
  // Власник: «Видалити товар» (одна дія, з кодом) — виконує CC через робочий корінь запуску.
  const DEL = `ВИДАЛИТИ ТОВАР ${ID}`;
  h.setCells(w, ID, { [h.SALE_DECISION]: DEL });
  await ccRun(h.later(1));
  h.setCells(w, ID, { [h.SALE_DECISION]: `${DEL} ${h.codeOf(w, ID, DEL)}` });
  assert.equal((await ccRun(h.later(2))).state, "COMMITTED");
  const st = await controls.state();
  assert.ok(st.removed.has(ID) && st.moves?.toArchive?.includes(ID), JSON.stringify(st.moves));
  // Перенесення (шлюз W2): рядок у «Видалених товарах», у каталозі немає.
  const a1 = await h.prod.runArchiveStep({ readBook: w.readBook, gateway, controls, stamp: h.later(3), feedStore: feeds, config });
  assert.equal(a1.state, "ARCHIVED", JSON.stringify(a1).slice(0, 300));
  assert.ok(!h.mainRows(w).some((r) => String(r["Offer ID"]) === ID));
  assert.ok(w.book["Видалені товари"].slice(1).some((r) => String(r[0]) === ID));
  // Публікація: новий YML без offer (знімок аркушів — після перенесення).
  await snapshot();
  const u = await h.runUpdate(ctx(h.NOW + 60_000));
  assert.ok(["PUBLISHED", "REUSED"].includes(u.feeds[0].state), JSON.stringify(u.feeds[0]).slice(0, 300));
  assert.equal(offersById((await h.readActiveXml(feeds, "main")).xml).has(ID), false);
  // Завершення: «ЗАВЕРШЕНО» за активною версією; стадія CC — DONE (publication).
  const a2 = await h.prod.runArchiveStep({ readBook: w.readBook, gateway, controls, stamp: h.later(4), feedStore: feeds, config });
  assert.equal(a2.state, "ARCHIVED");
  // ENG-23 (Q4: apply лише через протокол A): коміт видалення вже прибирає offer з обслуговуваної версії (аварійний патч), тож
  // «ЗАВЕРШЕНО» може настати вже на першому кроці архіву — рівно один раз за обидва кроки.
  assert.deepEqual([...(a1.published?.done || []), ...(a2.published?.done || [])], [ID], JSON.stringify({ a1: a1.published, a2: a2.published }));
  assert.equal((await controls.state()).tombstoned.get(ID)?.stage, "DONE");
  const a3 = await h.prod.runArchiveStep({ readBook: w.readBook, gateway, controls, stamp: h.later(5), feedStore: feeds, config });
  assert.deepEqual(a3.published?.done ?? [], [], "повтор — без змін");
});

test("Робочий захист видалення: без FZ / переліку захищених / OV (MM_FREEZE_IDS, MM_OWNER_VALUES) CC відмовляє лише видаленню — товар у каталозі, без доручень", { skip }, async () => {
  const h = await load();
  const { w, ccRun } = await world(h);
  assert.ok(["COMMITTED", "PENDING"].includes((await ccRun(h.later(0), { protection: undefined })).state));
  const DEL = `ВИДАЛИТИ ТОВАР ${ID}`;
  h.setCells(w, ID, { [h.SALE_DECISION]: DEL });
  await ccRun(h.later(1), { protection: undefined });
  h.setCells(w, ID, { [h.SALE_DECISION]: `${DEL} ${h.codeOf(w, ID, DEL)}` });
  await ccRun(h.later(2), { protection: undefined });
  assert.match(JSON.stringify(h.viewOf(w, ID)), /не виконано: захист FZ/);
  assert.ok(h.mainRows(w).some((r) => String(r["Offer ID"]) === ID));
});

test("ENG15-P2 (справжній CC): видалення, ініційоване в момент перемикання маніфесту відкату, не комітиться (BUSY — спільна оренда W2); після відкату комітиться, наступна публікація прибирає товар", { skip }, async () => {
  const h = await load();
  const { w, gateway, ccRun, adapter, dir, feeds } = await world(h);
  const { offersById } = h.yml;
  assert.ok(["COMMITTED", "PENDING"].includes((await ccRun(h.later(0))).state));
  const supplier = path.join(dir, "supplier.xml"), catalog = path.join(dir, "catalog");
  await h.sources.writeCatalogSnapshot(catalog, { sheets: w.book, groups: w.book[h.SHEET.groups] });
  await fsp.writeFile(supplier, w.xml);
  await feeds.putJson("approved/main.json", h.seal.approvalManifest(h.mainRows(w), h.yml.objectsFromValues(w.book[h.SHEET.groups], h.seal.GROUP_HEADERS)));
  const config = h.prod.productionConfig(structuredClone(h.baseConfig)); config.supplier.minimumOffers = 10;
  const controls = await adapter({ feedStore: feeds });
  const coordinator = gateway.committer; // той самий ресурс оренди, що й запуск CC (readiness.committer шлюзу)
  const ctx = (t) => ({ store: feeds, config, catalog: new h.sources.NdjsonCatalogSource(catalog), supplier: new h.sources.FileSupplierSource(supplier), now: () => t, tmpDir: dir, controls, coordinator });
  assert.equal((await h.runUpdate(ctx(h.NOW))).feeds[0].state, "PUBLISHED");
  await fsp.writeFile(supplier, w.xml.replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 1) + b));
  assert.equal((await h.runUpdate(ctx(h.NOW + 60_000))).feeds[0].state, "PUBLISHED");
  // Ін'єкція Hermes: у момент PUT маніфесту відкату — команда власника «Видалити товар» через робочий запуск CC.
  const DEL = `ВИДАЛИТИ ТОВАР ${ID}`;
  const injected = [];
  const raw = feeds.putJson.bind(feeds);
  // ENG-22: перехоплювач передає умову запису (opts) — обгортку, що її губить, функціональна CAS-проба fencing справедливо відхиляє (NO_CAS).
  feeds.putJson = async (k, v, ...o) => {
    if (k === "feeds/main/manifest.json" && v?.rolledBackAt && !injected.length) {
      h.setCells(w, ID, { [h.SALE_DECISION]: DEL });
      injected.push((await ccRun(h.later(1))).state);
    }
    return raw(k, v, ...o);
  };
  const { guardedRollback } = await import("../src/pipeline/update.mjs");
  const r = await guardedRollback({ store: feeds, feed: "main", controls, coordinator });
  feeds.putJson = raw;
  assert.ok(r.active, "відкат виконано");
  assert.deepEqual(injected, ["BUSY"], "запуск CC у вікні відкату не отримав оренди — видалення не зафіксовано до перемикання");
  assert.equal((await controls.state()).removed.has(ID), false);
  // Після відкату — видалення комітиться (запит коду + підтвердження), наступна публікація прибирає товар.
  await ccRun(h.later(2));
  h.setCells(w, ID, { [h.SALE_DECISION]: `${DEL} ${h.codeOf(w, ID, DEL)}` });
  assert.equal((await ccRun(h.later(3))).state, "COMMITTED");
  assert.ok((await controls.state()).removed.has(ID));
  const u = await h.runUpdate(ctx(h.NOW + 120_000));
  assert.ok(["PUBLISHED", "REUSED"].includes(u.feeds[0].state), JSON.stringify(u.feeds[0]).slice(0, 300));
  assert.equal(offersById((await h.readActiveXml(feeds, "main")).xml).has(ID), false);
});
