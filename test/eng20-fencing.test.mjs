/** ENG-20 (рішення власника 30.10): B — умовне перемикання маніфесту з ETag та епохою fencing; заборона PoC C3 у production.
 *  Модель — LocalObjectStore (умова й запис атомарні на одному хості). НЕ доказ поведінки справжнього R2 чи розгорнутого Worker.
 *  Композиція зі справжнім CC (протокол A, takeover, затриманий PUT, Worker GET / HEAD) — лабораторні проби ENG-20 (e20-ab-protocol). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { fenceFeeds, fencedStore, compensationStore, MANIFEST_RE } from "../src/publish/feed-fence.mjs";
import { manifestKey, readActiveXml } from "../src/publish/publisher.mjs";
import { assertPocIsolated, POC_WORKER } from "../src/publish/poc-guard.mjs";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { runUpdate } from "../src/pipeline/update.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { offersById } from "../src/core/yml.mjs";
import worker from "../worker/src/index.js";
import { r2BindingFrom } from "./helpers/r2-fake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (p) => fsp.mkdtemp(path.join(os.tmpdir(), p));
const KEY = manifestKey("main");
/** Оренда-двійник з токеном (епоха) і керованою чинністю. */
// ENG-23 (F04): кожна видача оренди має власний leaseId (cc-committer-v2); повтор власного запису — лише за ним.
const leaseOf = (token) => { const l = { token, leaseId: crypto.randomBytes(16).toString("hex"), scope: "publisher", lost: false, assertCurrent: async () => { if (l.lost) throw new Error("оренду втрачено"); } }; return l; };

test("B / сховище: умовний запис — If-Match з чужим ETag → 412, нічого не записано; null — лише якщо ключа немає; конкуренти з тим самим ETag — переможець один", async () => {
  const s = new LocalObjectStore(await tmp("mm-e20-cas-"));
  const a = await s.putJson("feeds/main/manifest.json", { v: 1 }, { ifMatch: null });
  await assert.rejects(s.putJson("feeds/main/manifest.json", { v: 2 }, { ifMatch: null }), (e) => e.code === "PRECONDITION_FAILED" && e.status === 412);
  await assert.rejects(s.putJson("feeds/main/manifest.json", { v: 2 }, { ifMatch: '"чужий"' }), /412/);
  assert.deepEqual(await s.getJson("feeds/main/manifest.json"), { v: 1 }, "відмова нічого не записала");
  const { etag } = await s.getJsonEtag("feeds/main/manifest.json");
  assert.equal(etag, a.etag);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => s.putJson("feeds/main/manifest.json", { v: 10 + i }, { ifMatch: etag })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "рівно один умовний запис з тим самим ETag");
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "PRECONDITION_FAILED"));
});

test("B / епоха: fencing створює заглушку (без active) або додає епоху, active не змінює; більша епоха → STALE_EPOCH; маніфест без fencing — NOT_FENCED; інші ключі — без змін", async () => {
  const s = new LocalObjectStore(await tmp("mm-e20-fence-"));
  await s.putJson(KEY, { kind: "FEED_MANIFEST_V1", feed: "main", active: { key: "feeds/main/versions/a.xml" }, previous: null, history: [] });
  const f5 = await fenceFeeds({ store: s, feeds: ["main", "new92"], lease: leaseOf(5), scope: "publisher" });
  const m = await s.getJson(KEY);
  assert.equal(m.fence.epoch, 5);
  assert.equal(m.active.key, "feeds/main/versions/a.xml");
  const stub = await s.getJson(manifestKey("new92"));
  assert.equal(stub.active, null, "заглушка: Worker нічого не віддає");
  assert.equal(stub.fence.epoch, 5);
  await assert.rejects(fenceFeeds({ store: s, feeds: ["main"], lease: leaseOf(4) }), (e) => e.code === "STALE_EPOCH");
  await assert.rejects(f5.putJson(manifestKey("other"), {}), (e) => e.code === "NOT_FENCED");
  await f5.putJson("state/x.json", { ok: 1 });
  assert.deepEqual(await s.getJson("state/x.json"), { ok: 1 });
  assert.ok(MANIFEST_RE.test(KEY) && !MANIFEST_RE.test("feeds/main/versions/a.xml"));
});

test("B / застарілий записувач: старий власник з НЕЗМІНЕНИМ власним ETag після fencing нового власника → STALE_FENCE (412 у сховищі); новий власник пише; компенсація старого — теж 412", async () => {
  const s = new LocalObjectStore(await tmp("mm-e20-stale-"));
  const oldLease = leaseOf(7), newLease = leaseOf(8);
  const old = await fenceFeeds({ store: s, feeds: ["main"], lease: oldLease });
  const etagOld = old.fence.expected.get(KEY);
  // Нова оренда (перехоплення) → fencing новою епохою.
  const neu = await fenceFeeds({ store: s, feeds: ["main"], lease: newLease });
  assert.notEqual(neu.fence.expected.get(KEY), etagOld);
  assert.equal(old.fence.expected.get(KEY), etagOld, "старий записувач тримає свій незмінений ETag");
  await assert.rejects(old.putJson(KEY, { kind: "FEED_MANIFEST_V1", feed: "main", active: { key: "old.xml" } }), (e) => e.code === "STALE_FENCE");
  oldLease.lost = true;
  await assert.rejects(compensationStore(old).putJson(KEY, { kind: "FEED_MANIFEST_V1", feed: "main", active: null, withdrawn: { at: "t" } }), (e) => e.code === "STALE_FENCE");
  await neu.putJson(KEY, { kind: "FEED_MANIFEST_V1", feed: "main", active: { key: "new.xml" } });
  const m = await s.getJson(KEY);
  assert.equal(m.active.key, "new.xml");
  assert.equal(m.fence.epoch, 8);
});

test("B / компенсація: оренду втрачено, але після нашої епохи маніфест ніхто не змінював → зменшення обслуговування проходить умовно; публікація через звичайне сховище — відмова", async () => {
  const s = new LocalObjectStore(await tmp("mm-e20-comp-"));
  const lease = leaseOf(3);
  const f = await fenceFeeds({ store: s, feeds: ["main"], lease });
  await f.putJson(KEY, { kind: "FEED_MANIFEST_V1", feed: "main", active: { key: "a.xml" } });
  lease.lost = true;
  await assert.rejects(f.putJson(KEY, { kind: "FEED_MANIFEST_V1", feed: "main", active: { key: "b.xml" } }), /оренду втрачено/);
  await compensationStore(f).putJson(KEY, { kind: "FEED_MANIFEST_V1", feed: "main", active: { key: "a.xml" }, withdrawn: { at: "t", reason: "компенсація" } });
  assert.ok((await s.getJson(KEY)).withdrawn);
});

/** Інженерний світ: синтетика, LocalObjectStore, робочий конфіг, координатор W2 (MemoryStore), двійник CC. */
async function feedWorld() {
  const T0 = Date.parse("2026-10-21T06:00:00.000Z");
  const dir = await tmp("mm-e20-world-");
  const s = generateSynthetic({ products: 40, queue: 2, deferred: 2, newOffers: 0, seed: 7, now: T0 });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  await fsp.writeFile(path.join(dir, "supplier.xml"), s.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = productionConfig(structuredClone(baseConfig));
  config.supplier.minimumOffers = 10;
  const NONE = { blocked: false, kind: "NONE" };
  const cc = { state: async () => ({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp", gate: { check: () => NONE } }), verify: async () => ({ ok: true, reasons: [] }) };
  const coordinator = createCommitter({ store: new MemoryStore() });
  const ctx = (now = T0, extra = {}) => ({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(path.join(dir, "supplier.xml")), now: () => now, tmpDir: dir, controls: cc, coordinator, ...extra });
  const get = async (method = "GET") => worker.fetch(new Request("https://feeds.test/feeds/main.xml?key=" + "k".repeat(32), { method }), { FEEDS_BUCKET: r2BindingFrom(store), FEED_ACCESS_KEY: "k".repeat(32), FEEDS: "main" });
  return { T0, dir, s, store, config, ctx, get, coordinator };
}

test("B / Worker: маніфест з міткою fence обслуговується як звичайно (GET / HEAD 200, той самий вміст); епоха = token оренди публікатора", async () => {
  const x = await feedWorld();
  assert.equal((await runUpdate(x.ctx())).feeds[0].state, "PUBLISHED");
  const m = await x.store.getJson(KEY);
  assert.ok(Number.isInteger(m.fence?.epoch) && m.fence.scope === "publisher", JSON.stringify(m.fence));
  const r = await x.get();
  assert.equal(r.status, 200);
  assert.equal(offersById(await r.text()).size, offersById((await readActiveXml(x.store, "main")).xml).size);
  assert.equal((await x.get("HEAD")).status, 200);
});

test("B / робочий режим: сховище фідів без умовного запису → публікація BLOCKED_W2 (fail-closed), маніфест не створено", async () => {
  const x = await feedWorld();
  const noCas = new Proxy(x.store, { get(t, p) { if (p === "getJsonEtag") return undefined; const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  const r = await runUpdate({ ...x.ctx(), store: noCas });
  assert.equal(r.feeds[0].state, "BLOCKED_W2", JSON.stringify(r.feeds[0]));
  assert.match(r.feeds[0].reason, /NO_CAS/);
  assert.equal(await x.store.getJson(KEY), null);
});

test("B / два публікатори: старий (затриманий PUT) після перехоплення оренди НОВИМ публікатором → STALE_FENCE, обслуговується версія нового", async () => {
  const x = await feedWorld();
  let clock = x.T0;
  const coordinator = createCommitter({ store: new MemoryStore(), now: () => clock, ttlMs: 60_000, settleMs: 0 });
  assert.equal((await runUpdate(x.ctx(x.T0, { coordinator }))).feeds[0].state, "PUBLISHED");
  await fsp.writeFile(path.join(x.dir, "supplier.xml"), x.s.supplierXml().replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 1) + b));
  const raw = x.store.putJson.bind(x.store);
  let fired = false, newer = null;
  x.store.putJson = async (k, v, o) => {
    if (!fired && k === KEY && o?.ifMatch !== undefined && v?.fence?.scope === "publisher" && v.updatedAt && v.active && (await x.store.getJson(k))?.active?.key !== v.active.key) {
      fired = true;
      clock += 120_000; // оренда старого сплила; новий публікатор отримує оренду й публікує (fencing → новий ETag)
      x.store.putJson = raw;
      newer = await runUpdate(x.ctx(x.T0 + 7_200_000, { coordinator }));
    }
    return raw(k, v, o);
  };
  const older = await runUpdate(x.ctx(x.T0 + 3_600_000, { coordinator }));
  x.store.putJson = raw;
  assert.ok(fired);
  assert.equal(newer.feeds[0].state, "PUBLISHED", JSON.stringify(newer.feeds[0]));
  assert.notEqual(older.feeds[0].state, "PUBLISHED");
  assert.match(String(older.feeds[0].error || ""), /STALE_FENCE/);
  const m = await x.store.getJson(KEY);
  assert.equal(m.active.sha256, newer.feeds[0].sha256, "обслуговується версія нового власника");
});

test("ENG20-C3: PoC-публікатори — заборона в робочому середовищі / з не-PoC Worker / з прапорцем production; чинні ізольовані запуски не зачеплено", async () => {
  assert.equal(assertPocIsolated({ env: {}, argv: [] }).notForProm, true);
  for (const [env, argv, worker_, re] of [
    [{ MM_W2_MODE: "single-host" }, [], POC_WORKER, /W2/],
    [{ MM_SAFE_WRITE_DIR: "x" }, [], POC_WORKER, /W2/],
    [{ MM_PRODUCTION: "1" }, [], POC_WORKER, /MM_PRODUCTION/],
    [{}, ["--prom"], POC_WORKER, /--prom/],
    [{}, [], "mm-feed", /не PoC/],
  ]) assert.throws(() => assertPocIsolated({ env, argv, workerName: worker_ }), re);
  // Справжні інструменти: у робочому середовищі W2 — код 2 до будь-якого читання / мережі.
  for (const tool of ["cf-publish.mjs", "shadow-publish.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, "tools", tool), "utf8");
    assert.match(src, /assertPocIsolated\(/, tool);
    const r = spawnSync(process.execPath, [path.join(ROOT, "tools", tool), "--synthetic=10"], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: os.tmpdir() } });
    assert.equal(r.status, 2, tool + ": " + r.stderr.slice(0, 300));
    assert.match(r.stderr, /PoC C3 заборонено/, tool);
  }
});
