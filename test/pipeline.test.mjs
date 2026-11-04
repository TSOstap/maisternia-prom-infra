/** Наскрізні сценарії shadow-конвеєра на синтетичних даних: синк → стан → YML → публікація → Worker. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate } from "../src/pipeline/update.mjs";
import { manifestKey, rollbackFeed } from "../src/publish/publisher.mjs";
import { verifyYmlStream } from "../src/core/xml-verify.mjs";
import { YML_HEADERS } from "../src/core/seal.mjs";
import worker from "../worker/src/index.js";
import { r2BindingFrom } from "./helpers/r2-fake.mjs";
// Старий режим (явно): регресія прийнятої механіки — див. helpers/legacy-config.mjs (рішення власника 29–30.10).
import baseConfig from "./helpers/legacy-config.mjs";

const T0 = Date.parse("2026-10-21T06:00:00.000Z");
const KEY = "test-access-key-not-secret";

async function setup(opts = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-infra-"));
  const s = generateSynthetic({ products: 120, queue: 12, deferred: 4, newOffers: 5, seed: 21, now: T0, ...opts.synth });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  const supplierFile = path.join(dir, "supplier.xml");
  await fsp.writeFile(supplierFile, s.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"), opts.store);
  await store.putJson("approved/main.json", s.manifestMain);
  const config = structuredClone(baseConfig);
  config.supplier.minimumOffers = 10;
  if (opts.config) opts.config(config);
  const ctx = (now = T0) => ({
    store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(supplierFile),
    now: () => now, tmpDir: dir,
  });
  const env = { FEEDS_BUCKET: r2BindingFrom(store), FEED_ACCESS_KEY: KEY, FEEDS: "main" };
  const get = (p, method = "GET") => worker.fetch(new Request("https://feeds.example" + p, { method }), env);
  return { dir, s, store, config, ctx, supplierFile, get };
}

async function bodyText(res) {
  return Buffer.from(await res.arrayBuffer());
}

test("1-й запуск: синк OK, фід опубліковано, Worker віддає перевірений XML", async () => {
  const { store, ctx, get, s } = await setup();
  const report = await runUpdate(ctx());
  assert.equal(report.sync.state, "OK");
  assert.equal(report.feeds[0].state, "PUBLISHED", JSON.stringify(report.feeds));
  assert.equal(report.newProducts.total, 5);
  const res = await get("/feeds/main.xml?key=" + KEY);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-feed-version"), "active");
  const xml = await bodyText(res);
  const v = await verifyYmlStream([xml], { count: s.manifestMain.count, idsSha: s.manifestMain.idsSha });
  assert.equal(res.headers.get("etag"), `"${v.sha256}"`);
  const usage = await store.getJson("usage/2026-10.json");
  assert.equal(usage.runs, 1);
  assert.ok(usage.classA > 0 && usage.classB > 0);
});

test("повтор без змін цін: файл повторно використано (без нового PUT)", async () => {
  const { ctx } = await setup();
  await runUpdate(ctx(T0));
  const second = await runUpdate(ctx(T0 + 4 * 3600000 - 60000));
  assert.equal(second.sync.state, "OK");
  assert.equal(second.feeds[0].state, "REUSED");
});

test("зміна ціни → нова версія; попередня збережена; зникнення активної → Worker віддає попередню; відкат", async () => {
  const { store, ctx, supplierFile, get } = await setup();
  await runUpdate(ctx());
  const first = (await store.getJson(manifestKey("main"))).active;
  const xml = await fsp.readFile(supplierFile, "utf8");
  await fsp.writeFile(supplierFile, xml.replace(/(<offer id="1500000000"[^>]*>[\s\S]*?<price>)[^<]+/, "$1777.77"));
  const r2 = await runUpdate(ctx(T0 + 3600000));
  assert.equal(r2.feeds[0].state, "PUBLISHED");
  const m = await store.getJson(manifestKey("main"));
  assert.notEqual(m.active.key, first.key);
  assert.equal(m.previous.key, first.key);
  assert.ok((await bodyText(await get("/feeds/main.xml?key=" + KEY))).toString().includes("978.46"), "04.11: <price> — базова ціна (782.77 × 1.25)");

  await store.delete(m.active.key); // аварія активного об'єкта
  // Правило 8 (Hermes E7): попередня версія — запасна ЛИШЕ якщо publisher перевірив її на стан CC (previousFallbackSafe).
  // Старий режим без CC такої перевірки не має → 503, а не неперевірена стара версія.
  assert.equal(m.previousFallbackSafe, false);
  assert.equal((await get("/feeds/main.xml?key=" + KEY)).status, 503);
  await store.putJson(manifestKey("main"), { ...m, previousFallbackSafe: true }); // як після перевірки candidateGuard
  const res = await get("/feeds/main.xml?key=" + KEY);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-feed-version"), "previous");

  // Механіка відкату; перевірка стану CC (обов'язкова, правило 8) — тут «порушень немає».
  await assert.rejects(rollbackFeed(store, "main", { toKey: m.active.key, violations: () => [] }), /відсутня/);
  const rolled = await rollbackFeed(store, "main", { violations: () => [] });
  assert.equal(rolled.active.key, first.key);
});

test("пошкоджений фід постачальника: синк ERROR, стан і опублікований фід не змінені", async () => {
  const { store, ctx, supplierFile } = await setup();
  await runUpdate(ctx());
  const before = await store.getJson(manifestKey("main"));
  const op = await store.getJson("state/operational.json");
  const xml = await fsp.readFile(supplierFile, "utf8");
  await fsp.writeFile(supplierFile, xml.slice(0, Math.floor(xml.length / 2)));
  const r = await runUpdate(ctx(T0 + 3600000));
  assert.equal(r.sync.state, "ERROR");
  assert.match(r.sync.error, /Пошкоджений запис offer|Неповний YML/);
  assert.deepEqual(await store.getJson(manifestKey("main")), before);
  assert.deepEqual(await store.getJson("state/operational.json"), op);
  assert.equal((await store.getJson("state/sync.json")).state, "ERROR");
});

test("різке падіння кількості товарів у фіді (>20%) — синк зупинено", async () => {
  const { ctx, supplierFile, store } = await setup();
  await runUpdate(ctx());
  const xml = await fsp.readFile(supplierFile, "utf8");
  const offers = xml.split("\n");
  const cut = [offers[0], ...offers.slice(1, -1).slice(0, 60), offers.at(-2).includes("</offers>") ? offers.at(-2) : "</offers></shop></yml_catalog>"].join("\n");
  await fsp.writeFile(supplierFile, cut.endsWith("</yml_catalog>") ? cut : cut + "\n</offers></shop></yml_catalog>");
  const r = await runUpdate(ctx(T0 + 3600000));
  assert.equal(r.sync.state, "ERROR");
  assert.match(r.sync.error, /різке зменшення/);
  assert.equal((await store.getJson(manifestKey("main"))).active.count, 120);
});

test("режим block (чинна поведінка LIVE): зниклий товар блокує весь фід (ризик R1)", async () => {
  const { ctx, store } = await setup({ synth: { missingFromSupplier: ["1500000035"] }, config: (c) => { c.policy.missing = "block"; } });
  const r = await runUpdate(ctx());
  assert.equal(r.sync.state, "OK");
  assert.equal(r.sync.sheets[0].byStatus["ВІДСУТНІЙ_У_YML"], 1);
  const op = await store.getJson("state/operational.json");
  assert.equal(op.rows["1500000035"][4], "-");
  assert.equal(r.feeds[0].state, "ERROR");
  assert.match(r.feeds[0].error, /Непідтверджений статус/);
  assert.equal(await store.getJson(manifestKey("main")), null);
});

test("контент змінено після погодження: фід ERROR, синк OK, попередня версія лишається", async () => {
  const { ctx, store, dir } = await setup();
  await runUpdate(ctx());
  const before = await store.getJson(manifestKey("main"));
  const file = path.join(dir, "catalog", "sheets", "Основний каталог.ndjson");
  const lines = (await fsp.readFile(file, "utf8")).trim().split("\n");
  const row = JSON.parse(lines[3]);
  row[YML_HEADERS.indexOf("Опис UA")] += " (ручна правка без QA)";
  lines[3] = JSON.stringify(row);
  await fsp.writeFile(file, lines.join("\n") + "\n");
  const r = await runUpdate(ctx(T0 + 3600000));
  assert.equal(r.sync.state, "OK");
  assert.equal(r.feeds[0].state, "ERROR");
  assert.match(r.feeds[0].error, /змінено після QA/);
  assert.deepEqual(await store.getJson(manifestKey("main")), before);
});

test("відмова сховища на readback кандидата: кандидат прибрано, активна версія не змінена", async () => {
  let failReadback = false;
  const { ctx, store, supplierFile } = await setup({ store: { failOn: (op, key) => failReadback && op === "get" && key.includes("/versions/") } });
  await runUpdate(ctx());
  const before = await store.getJson(manifestKey("main"));
  const xml = await fsp.readFile(supplierFile, "utf8");
  await fsp.writeFile(supplierFile, xml.replace(/(<offer id="1500000007"[^>]*>[\s\S]*?<price>)[^<]+/, "$1555.55"));
  failReadback = true;
  const r = await runUpdate(ctx(T0 + 3600000));
  assert.equal(r.feeds[0].state, "ERROR");
  assert.deepEqual(await store.getJson(manifestKey("main")), before);
  const versions = await store.list("feeds/main/versions/");
  assert.deepEqual(versions, [before.active.key]);
});

test("ротація версій: зберігаються лише retain останніх", async () => {
  const { ctx, store, supplierFile } = await setup({ config: (c) => { c.publish.retainVersions = 2; } });
  for (let i = 0; i < 5; i++) {
    const xml = await fsp.readFile(supplierFile, "utf8");
    await fsp.writeFile(supplierFile, xml.replace(/(<offer id="1500000000"[^>]*>[\s\S]*?<price>)[^<]+/, `$1${300 + i}`));
    const r = await runUpdate(ctx(T0 + i * 600000));
    assert.equal(r.feeds[0].state, "PUBLISHED");
  }
  const versions = await store.list("feeds/main/versions/");
  assert.ok(versions.length <= 3, versions.join());
});

test("gzip-варіант: Worker віддає .xml.gz, розпакований вміст = перевірений знімок", async () => {
  const { ctx, get, s } = await setup({ config: (c) => { c.feeds[0].gzip = true; } });
  const r = await runUpdate(ctx());
  assert.equal(r.feeds[0].state, "PUBLISHED");
  assert.ok(r.feeds[0].storedBytes < r.feeds[0].bytes / 2, "gzip має суттєво зменшити розмір");
  assert.equal((await get("/feeds/main.xml?key=" + KEY)).status, 503);
  const res = await get("/feeds/main.xml.gz?key=" + KEY);
  assert.equal(res.status, 200);
  const xml = zlib.gunzipSync(await bodyText(res));
  await verifyYmlStream([xml], { count: s.manifestMain.count, idsSha: s.manifestMain.idsSha, sha256: r.feeds[0].sha256 });
});

test("Worker: доступ, методи, невідомий фід, стан, HEAD; без даних — 503, не порожній каталог", async () => {
  const { ctx, get } = await setup();
  assert.equal((await get("/feeds/main.xml?key=wrong")).status, 403);
  assert.equal((await get("/feeds/main.xml")).status, 403);
  assert.equal((await get("/feeds/main.xml?key=" + KEY)).status, 503);
  await runUpdate(ctx());
  assert.equal((await get("/feeds/other.xml?key=" + KEY)).status, 404);
  assert.equal((await get("/feeds/main.xml?key=" + KEY, "POST")).status, 405);
  assert.equal((await get("/robots.txt")).status, 404);
  const head = await get("/feeds/main.xml?key=" + KEY, "HEAD");
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get("content-length")) > 1000);
  const status = await (await get("/feeds/main/status?key=" + KEY)).json();
  assert.equal(status.count, 120);
  assert.equal(status.hasPrevious, false);
});

test("звіт нових товарів і стан першої появи зберігаються між запусками", async () => {
  const { ctx, store } = await setup();
  await runUpdate(ctx());
  const r1 = await store.getJson("reports/new-products/latest.json");
  assert.equal(r1.total, 5);
  assert.equal(r1.newSinceLastRun.length, 5);
  await runUpdate(ctx(T0 + 4 * 3600000));
  const r2 = await store.getJson("reports/new-products/latest.json");
  assert.equal(r2.newSinceLastRun.length, 0);
  assert.equal(r2.candidates[0].firstSeen, new Date(T0).toISOString());
});

test("ID в обох аркушах (main і queue) — синк зупинено до будь-якого запису", async () => {
  const { ctx, store, dir } = await setup();
  const mainFile = path.join(dir, "catalog", "sheets", "Основний каталог.ndjson");
  const queueFile = path.join(dir, "catalog", "sheets", "Нові товари.ndjson");
  const firstMain = (await fsp.readFile(mainFile, "utf8")).split("\n")[1];
  await fsp.appendFile(queueFile, firstMain + "\n");
  const r = await runUpdate(ctx());
  assert.equal(r.sync.state, "ERROR");
  assert.match(r.sync.error, /в обох аркушах/);
  assert.equal(await store.getJson("state/operational.json"), null);
});

test("кілька фідів: main 120 + new92-подібний із погоджених ID черги + об'єднаний; неперетинні й незалежні", async () => {
  const { ctx, store, s, get } = await setup({ config: (c) => {
    c.feeds.push({ name: "queue", sheets: ["Нові товари"], manifest: "approved/queue.json", maximumBytes: 50_000_000, filterByManifest: true });
    c.feeds.push({ name: "all", sheets: ["Основний каталог", "Нові товари"], manifest: "approved/all.json", maximumBytes: 50_000_000, filterByManifest: true });
  } });
  const { approvalManifest } = await import("../src/core/seal.mjs");
  const header = s.sheets["Нові товари"][0];
  const toObj = (r) => Object.fromEntries(header.map((k, i) => [k, r[i]]));
  const queueRows = s.sheets["Нові товари"].slice(1).map(toObj).slice(0, 9); // 9 із 12 погоджені
  const mainRows = s.sheets["Основний каталог"].slice(1).map(toObj);
  const groups = s.groups.slice(1).map((g) => ({ "Ідентифікатор_групи": g[0], "Назва_групи_укр": g[1], "Назва_групи": g[2], "Ідентифікатор_батьківської_групи": g[3] }));
  const mk = (rows) => ({ ...approvalManifest(rows, groups), ids: rows.map((r) => r["Offer ID"]).sort() });
  await store.putJson("approved/queue.json", mk(queueRows));
  await store.putJson("approved/all.json", mk([...mainRows, ...queueRows]));
  const r = await runUpdate(ctx());
  assert.deepEqual(r.feeds.map((f) => [f.feed, f.state, f.count]), [["main", "PUBLISHED", 120], ["queue", "PUBLISHED", 9], ["all", "PUBLISHED", 129]]);
  const env2 = await get("/feeds/main.xml?key=" + KEY);
  assert.equal(env2.status, 200);
  // Пошкоджений паспорт одного фіду не зачіпає інші.
  await store.putJson("approved/queue.json", { ...mk(queueRows), contentSha: "0".repeat(64) });
  const xml = await fsp.readFile(path.join(ctx().tmpDir, "supplier.xml"), "utf8");
  await fsp.writeFile(path.join(ctx().tmpDir, "supplier.xml"), xml.replace(/(<offer id="1500000000"[^>]*>[\s\S]*?<price>)[^<]+/, "$1321"));
  const r2 = await runUpdate(ctx(T0 + 3600000));
  assert.deepEqual(r2.feeds.map((f) => [f.feed, f.state]), [["main", "PUBLISHED"], ["queue", "ERROR"], ["all", "PUBLISHED"]]);
});
