/** Регресії до ревю Hermes R6 (independent-20261029T230851), частина Engineering: E4 / E5 / E7 / F3 + запасний шлях Worker.
 *  Двійник адаптера CC — форма controlsFromState; справжній CC R6 — у cc-r6-hermes-compose.test.mjs (композиція). */
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate } from "../src/pipeline/update.mjs";
import * as publisherApi from "../src/publish/publisher.mjs";
import { manifestKey, readActiveXml, rollbackFeed } from "../src/publish/publisher.mjs";
import { offersById, controlsViolations } from "../src/core/yml.mjs";
import { planArchive, archiveHeader, ARCHIVE_SHEET } from "../src/core/archive.mjs";
import { catalogControlsAdapter } from "../src/pipeline/controls-adapter.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import { MemoryStore as W2Store } from "../src/pipeline/safe-write/store.mjs";
import { enabled as ownerPriorityEnabled } from "../src/core/owner-priority.mjs";
import worker from "../worker/src/index.js";
import { r2BindingFrom } from "./helpers/r2-fake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = Date.parse("2026-10-21T06:00:00.000Z");
const NONE = { blocked: false, kind: "NONE" };
const ccTwin = ({ removed = [], held = [], blocked = false, verifyOk = true, tag = "" } = {}) => {
  const fingerprint = "fp:" + JSON.stringify([removed, held, blocked, tag]);
  const st = { held: new Set([...held, ...removed]), removed: new Set(removed), tombstoned: new Map(removed.map((id) => [id, { stage: "REGISTERED" }])), blocked, reasons: blocked ? ["точка недійсна"] : [], fingerprint, gate: { check: () => NONE } };
  return { state: async () => st, verify: async (fp) => (verifyOk && fp === fingerprint ? { ok: true, reasons: [] } : { ok: false, reasons: ["відбиток змінився"] }) };
};
async function feedWorld() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-h6-"));
  const s = generateSynthetic({ products: 40, queue: 2, deferred: 2, newOffers: 0, seed: 7, now: T0 });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  const supplierFile = path.join(dir, "supplier.xml");
  await fsp.writeFile(supplierFile, s.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = productionConfig(structuredClone(baseConfig));
  config.supplier.minimumOffers = 10;
  const coordinator = createCommitter({ store: new W2Store() }); // ENG-17: робочий режим — перемикання лише під орендою W2
  const ctx = (controls, now = T0) => ({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(supplierFile), now: () => now, tmpDir: dir, coordinator, ...(controls ? { controls } : {}) });
  return { dir, s, store, config, ctx, supplierFile };
}
/** Worker над тим самим LocalObjectStore (двійник прив'язки R2 — як у pipeline.test). */
function workerGet(store) {
  const env = { FEEDS_BUCKET: r2BindingFrom(store), FEED_ACCESS_KEY: "k".repeat(32), FEEDS: "main" };
  return (p) => worker.fetch(new Request("https://feeds.test" + p + "?key=" + env.FEED_ACCESS_KEY), env);
}

test("E7: ранній збій (зламаний фід постачальника) — активну версію виправлено: видаленого offer немає, решта як була", async () => {
  const { store, ctx, supplierFile } = await feedWorld();
  assert.equal((await runUpdate(ctx(ccTwin()))).feeds[0].state, "PUBLISHED");
  const xml0 = (await readActiveXml(store, "main")).xml;
  const [del, other] = [...offersById(xml0).keys()].slice(2, 4);
  await fsp.writeFile(supplierFile, "<broken>");
  const r = await runUpdate(ctx(ccTwin({ removed: [del] }), T0 + 3600_000));
  assert.equal(r.sync.state, "ERROR");
  assert.equal(r.feeds[0].state, "STALE_ACTIVE");
  assert.equal(r.feeds[0].activeSafety, "VERIFIED");
  const xml1 = (await readActiveXml(store, "main")).xml;
  assert.equal(offersById(xml1).has(del), false, "видалений прибраний зі старої активної версії");
  assert.equal(offersById(xml1).get(other), offersById(xml0).get(other));
  assert.deepEqual(controlsViolations(xml1, { removed: new Set([del]) }), []);
});
test("E7: ранній збій + патч неможливий (стан CC нестабільний) — фід знято з обслуговування (Worker 503), не «успіх»", async () => {
  const { store, ctx, supplierFile } = await feedWorld();
  assert.equal((await runUpdate(ctx(ccTwin()))).feeds[0].state, "PUBLISHED");
  const del = [...offersById((await readActiveXml(store, "main")).xml).keys()][1];
  await fsp.writeFile(supplierFile, "<broken>");
  const r = await runUpdate(ctx(ccTwin({ removed: [del], verifyOk: false }), T0 + 3600_000));
  assert.equal(r.feeds[0].state, "WITHDRAWN");
  assert.equal(r.feeds[0].activeSafety, "UNSAFE");
  assert.equal(r.feeds[0].holdPatch.attempts, 2, "повторна спроба зі свіжим станом CC");
  assert.ok((await store.getJson(manifestKey("main"))).withdrawn);
  assert.equal((await workerGet(store)("/feeds/main.xml")).status, 503, "небезпечна версія не віддається");
});
test("E7: ранній збій + CC blocked — безпечність активної версії НЕ підтверджена (BLOCKED_CC, UNVERIFIED), CLI-успіху немає", async () => {
  const { ctx, supplierFile } = await feedWorld();
  assert.equal((await runUpdate(ctx(ccTwin()))).feeds[0].state, "PUBLISHED");
  await fsp.writeFile(supplierFile, "<broken>");
  const r = await runUpdate(ctx(ccTwin({ blocked: true }), T0 + 3600_000));
  assert.deepEqual([r.feeds[0].state, r.feeds[0].activeSafety], ["BLOCKED_CC", "UNVERIFIED"]);
});
test("Worker: попередня версія — лише перевірена на стан CC; знятий з обслуговування фід — 503", async () => {
  const { store, ctx } = await feedWorld();
  assert.equal((await runUpdate(ctx(ccTwin()))).feeds[0].state, "PUBLISHED");
  const xml0 = (await readActiveXml(store, "main")).xml;
  const del = [...offersById(xml0).keys()][3];
  // Друга публікація: товар видалено → попередня версія (з ним) НЕ безпечна як запасна.
  assert.equal((await runUpdate(ctx(ccTwin({ removed: [del] }), T0 + 3600_000))).feeds[0].state, "PUBLISHED");
  const m = await store.getJson(manifestKey("main"));
  assert.equal(m.previousFallbackSafe, false);
  const get = workerGet(store);
  assert.equal((await get("/feeds/main.xml")).status, 200);
  await store.delete(m.active.key);
  assert.equal((await get("/feeds/main.xml")).status, 503, "активної немає, попередня містить видалений — 503, не стара версія");
  // Третя публікація при тому самому стані: попередня (друга) — без видаленого → безпечна запасна.
  const w2 = await feedWorld();
  assert.equal((await runUpdate(w2.ctx(ccTwin({ removed: [del], tag: "a" })))).feeds[0].state, "PUBLISHED");
  assert.equal((await runUpdate(w2.ctx(ccTwin({ removed: [del], tag: "b" }), T0 + 3600_000))).feeds[0].state, "PUBLISHED");
  const m2 = await w2.store.getJson(manifestKey("main"));
  assert.equal(m2.previousFallbackSafe, true);
  await w2.store.delete(m2.active.key);
  const res = await workerGet(w2.store)("/feeds/main.xml");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-feed-version"), "previous");
});
test("Відкат: стара активна стає запасною лише без порушень CC; позначка зняття з обслуговування прибирається", async () => {
  const { store, ctx } = await feedWorld();
  await runUpdate(ctx(ccTwin()));
  const del = [...offersById((await readActiveXml(store, "main")).xml).keys()][2];
  await runUpdate(ctx(ccTwin({ removed: [del] }), T0 + 3600_000));
  await runUpdate(ctx(ccTwin({ removed: [del], tag: "x" }), T0 + 7200_000));
  const guard = { removed: new Set([del]), held: new Set() };
  const m = await store.getJson(manifestKey("main"));
  await store.putJson(manifestKey("main"), { ...m, withdrawn: { at: "t", reason: "тест" } });
  const r = await rollbackFeed(store, "main", { violations: (xml) => controlsViolations(xml, guard) });
  assert.equal(r.previousFallbackSafe, true);
  assert.equal(r.withdrawn, undefined);
});
test("E3: пріоритет власника — типова поведінка; старий режим лише за явного enabled:false (робочі точки його відхиляють)", () => {
  assert.equal(ownerPriorityEnabled({}), true);
  assert.equal(ownerPriorityEnabled(baseConfig), true, "config/default.json — пріоритет власника");
  assert.equal(ownerPriorityEnabled({ ownerPriority: { enabled: false } }), false);
  assert.throws(() => productionConfig({ ownerPriority: { enabled: false } }), /обов'язковий/);
});
test("Відкат: попередньою стає активна з видаленим товаром — запасною вона НЕ є", async () => {
  const { store, ctx } = await feedWorld();
  await runUpdate(ctx(ccTwin()));
  const withDel = (await store.getJson(manifestKey("main"))).active; // версія, що містить del
  const del = [...offersById((await readActiveXml(store, "main")).xml).keys()][2];
  await runUpdate(ctx(ccTwin({ removed: [del] }), T0 + 3600_000));
  const m = await store.getJson(manifestKey("main"));
  // Аварійно активною опинилась версія з видаленим (як до E7-патча); відкат на чисту версію.
  await store.putJson(manifestKey("main"), { ...m, active: withDel, previous: m.active });
  const guard = (xml) => controlsViolations(xml, { removed: new Set([del]), held: new Set() });
  const r = await rollbackFeed(store, "main", { violations: guard });
  assert.equal(r.active.key, m.active.key);
  assert.equal(r.previousFallbackSafe, false, "версія з видаленим товаром не стає запасною");
});
test("E4: робочий модуль publisher експортує контракт cc-publisher-v2 і renderProbe (функціонально — checkReadiness CC у композиції)", async () => {
  assert.equal(publisherApi.contract, "cc-publisher-v2");
  assert.equal(typeof publisherApi.renderProbe, "function");
});
test("E5: адаптер передає наданий publication (Map) і integrity у CC без змін", async () => {
  let ctx0 = null;
  const pub = new Map([["1", { feed: "absent" }]]), integrity = { cardVerdict: () => ({ verdict: "OWNER_EDIT", reasons: [] }) };
  const a = catalogControlsAdapter({ loadBook: async () => ({}), store: { getJson: async () => null }, contract: {}, publication: pub, integrity,
    api: { controlsState: (b, c) => { ctx0 = c; return { held: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "f" }; }, verifyControlsSnapshot: () => ({ ok: true }) } });
  await a.state();
  assert.equal(ctx0.publication, pub);
  assert.equal(ctx0.integrity, integrity);
});
test("F3: повернення з архіву — різні копії (новіша SEO-чернетка власника в архіві) → конфлікт, жодна копія не видаляється; однакові → архівну прибрано", () => {
  const h = ["Offer ID", "Назва UA", "SEO заголовок UA"];
  const ah = archiveHeader(h);
  const arch = (seo) => [ah, ah.map((k) => ({ "Offer ID": "7", "Назва UA": "Н", "SEO заголовок UA": seo }[k] ?? ""))];
  const main = [h, ["7", "Н", "OWNER_OLD"]];
  const p1 = planArchive({ mainValues: main, archiveValues: arch("OWNER_NEW"), restore: new Set(["7"]), at: "t" });
  assert.equal(p1.deleteFromArchive.length, 0);
  assert.match(p1.conflicts[0].reason, /SEO заголовок UA/);
  const p2 = planArchive({ mainValues: main, archiveValues: arch("OWNER_OLD"), restore: new Set(["7"]), at: "t" });
  assert.equal(p2.deleteFromArchive.length, 1);
  assert.equal(ARCHIVE_SHEET, "Видалені товари");
});
test("CLI update: успіх лише коли кожен фід PUBLISHED / REUSED (ранній збій із захищеною активною версією — код 1)", async () => {
  const src = await fsp.readFile(path.join(ROOT, "src", "cli.mjs"), "utf8");
  assert.match(src, /every\(\(f\) => \["PUBLISHED", "REUSED"\]\.includes\(f\.state\)/);
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "src", "cli.mjs"), "help", "--store=" + os.tmpdir()], { encoding: "utf8" }).status, 2);
});
