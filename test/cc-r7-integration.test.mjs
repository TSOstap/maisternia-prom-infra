/** CC R7 × ENG-15 (CC-R7-INTEGRATION-ACCEPTANCE-MATRIX): розриви G1 / G2 / G3, F-3, W2 — двійники модулів CC (без мережі).
 *  Справжній CC R7 — cc-r7-compose.test.mjs (композиція; без модуля CC — пропуск). */
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCatalogControls, runCatalogControls, runArchiveStep, resolveContract, w2Coordinator, productionConfig } from "../src/pipeline/production.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { publishFeed } from "../src/publish/publisher.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { runUpdate } from "../src/pipeline/update.mjs";
import { syncControlsState, mergeNew92 } from "../src/pipeline/sheet-sync-run.mjs";
import { runArchiveMoves } from "../src/pipeline/archive-run.mjs";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

/** Двійник модулів CC: фіксує ctx кожного виклику. */
function fakeCC({ active = true, blocked = false, problems = [], contract = { activated: true, version: 3 } } = {}) {
  const calls = [];
  const st = { active, blocked, reasons: [], held: new Set(), tombstoned: new Map(), fingerprint: "fp", gate: { check: () => ({ blocked: false, kind: "NONE" }) } };
  const mods = {
    "controls-plan.mjs": { controlsState: (book, ctx) => { calls.push(["state", ctx]); return st; }, verifyControlsSnapshot: (book, ctx, fp) => { calls.push(["verify", ctx]); return { ok: fp === "fp", reasons: [] }; } },
    "controls-common.mjs": { loadControlsContract: () => ({ contract, problems }), validateContract: () => problems },
    "controls-run.mjs": { runControls: async (o) => { calls.push(["run", o]); return { state: o.mode === "apply" ? "COMMITTED" : "SHADOW" }; }, loadProtection: () => ({ valid: false, reasons: ["тест"] }) },
  };
  const importer = async (href) => { const k = Object.keys(mods).find((n) => href.endsWith(n)); if (!k) throw new Error("no module"); return mods[k]; };
  return { importer, calls };
}

test("G1: робочий шлях передає в CC САМ об'єкт контракту (activated), а не обгортку { contract, problems }", async () => {
  const cc = fakeCC();
  const a = await loadCatalogControls({ loadBook: async () => ({}), store: new MemoryStore(), config: baseConfig, importer: cc.importer });
  const st = await a.state();
  assert.equal(st.blocked, false);
  const ctx = cc.calls.find((c) => c[0] === "state")[1];
  assert.equal(ctx.contract.activated, true);
  assert.equal("problems" in ctx.contract, false, "не обгортка");
});
test("A2 / G1: контракт CC з problems — робочий шлях blocked (не стан «оцінки»), відбиток не підтверджується", async () => {
  const cc = fakeCC({ problems: ["контракт v2 відхилено"] });
  const a = await loadCatalogControls({ loadBook: async () => ({}), store: new MemoryStore(), config: baseConfig, importer: cc.importer });
  const st = await a.state();
  assert.equal(st.blocked, true);
  assert.match(st.reasons.join(" "), /контракт Catalog Controls недійсний/);
  assert.equal((await a.verify("fp")).ok, false);
  assert.equal(cc.calls.length, 0, "CC з недійсним контрактом не викликається");
  assert.equal(resolveContract({ loadControlsContract: () => ({ contract: null, problems: ["не читається"] }) }).contract, null);
});
test("G2: CC не активовано (active:false) — робочий шлях fail-closed; активовано — стан чинний", async () => {
  const off = await loadCatalogControls({ loadBook: async () => ({}), store: new MemoryStore(), config: baseConfig, importer: fakeCC({ active: false }).importer });
  const s1 = await off.state();
  assert.equal(s1.blocked, true);
  assert.match(s1.reasons.join(" "), /не активовано/);
  const on = await loadCatalogControls({ loadBook: async () => ({}), store: new MemoryStore(), config: baseConfig, importer: fakeCC({ active: true }).importer });
  assert.equal((await on.state()).blocked, false);
});
test("G3: запуск CC — integrity (M3), publication (активні версії), readiness (cc-publisher-v2 + committer + store шлюзу), той самий контракт; тінь типово", async () => {
  const cc = fakeCC();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-g3-"));
  // ENG-17 (I18): доказ публікації — лише з ПЕРЕВІРЕНОЇ обслуговуваної версії: публікуємо справжній фід (runUpdate).
  const gen = generateSynthetic({ products: 20, queue: 0, deferred: 0, newOffers: 0, seed: 9, now: Date.parse("2026-10-21T06:00:00.000Z") });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: gen.sheets, groups: gen.groups });
  await fsp.writeFile(path.join(dir, "supplier.xml"), gen.supplierXml());
  const feedStore = new LocalObjectStore(path.join(dir, "feeds"));
  await feedStore.putJson("approved/main.json", gen.manifestMain);
  const pubCfg = productionConfig(structuredClone(baseConfig)); pubCfg.supplier.minimumOffers = 10;
  const okCC = { state: async () => ({ held: new Set(), removed: new Set(), blocked: false, reasons: [], fingerprint: "fp" }), verify: async () => ({ ok: true, reasons: [] }) };
  assert.equal((await runUpdate({ store: feedStore, config: pubCfg, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(path.join(dir, "supplier.xml")), now: () => Date.parse("2026-10-21T06:00:00.000Z"), tmpDir: dir, controls: okCC, coordinator: createCommitter({ store: new MemoryStore() }) })).feeds[0].state, "PUBLISHED");
  const present = String(gen.sheets["Основний каталог"][1][0]);
  const book = { "Основний каталог": [["Offer ID"], [present], ["12"]], "Видалені товари": [["Offer ID"], ["13"]] };
  const sheets = new MemorySheets(structuredClone(book));
  const gateway = new WriteGateway({ sheets, read: async (n) => sheets.read(n), store: new MemoryStore() });
  const cfg = { ...productionConfig(structuredClone(baseConfig)), feeds: [{ name: "main" }] };
  const r = await runCatalogControls({ sheets, readBook: async (n) => sheets.read(n), gateway, config: cfg, stamp: "2026-10-30T00:00:00Z", feedStore, importer: cc.importer });
  assert.equal(r.state, "SHADOW");
  const o = cc.calls.find((c) => c[0] === "run")[1];
  assert.equal(o.mode, "shadow");
  assert.equal(o.contract.activated, true);
  assert.equal(typeof o.integrity.cardVerdict, "function");
  assert.equal(o.readiness.publisher.contract, "cc-publisher-v2");
  assert.equal(o.readiness.committer.contract, "cc-committer-v2");
  assert.equal(typeof o.readiness.store.putJsonIfVersion, "function");
  assert.ok(o.publication instanceof Map);
  assert.deepEqual(Object.fromEntries([...o.publication].map(([k, v]) => [k, v.feed])), { [present]: "present", 12: "absent", 13: "absent" });
  const r2 = await runCatalogControls({ sheets, readBook: async (n) => sheets.read(n), gateway: null, config: cfg, stamp: "t", mode: "apply", importer: cc.importer });
  assert.equal(r2.state, "BLOCKED", "apply без шлюзу W2 — відмова");
  const r3 = await runCatalogControls({ sheets, readBook: async (n) => sheets.read(n), gateway, config: cfg, stamp: "t", importer: async () => { throw new Error("немає"); } });
  assert.equal(r3.state, "BLOCKED", "без модуля CC — відмова");
});
test("F-3: state() кидає виняток — як blocked: update BLOCKED_CC (не успіх), синхронізація — стан blocked", async () => {
  const throwing = { state: async () => { throw new Error("сховище недоступне"); }, verify: async () => ({ ok: false }) };
  const s = await syncControlsState(throwing, productionConfig(structuredClone(baseConfig)));
  assert.equal(s.blocked, true);
  assert.match(s.reasons.join(" "), /не прочитано/);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-f3-"));
  const gen = generateSynthetic({ products: 30, queue: 2, deferred: 2, newOffers: 0, seed: 5, now: Date.parse("2026-10-21T06:00:00.000Z") });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: gen.sheets, groups: gen.groups });
  await fsp.writeFile(path.join(dir, "supplier.xml"), gen.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", gen.manifestMain);
  const config = productionConfig(structuredClone(baseConfig)); config.supplier.minimumOffers = 10;
  const r = await runUpdate({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(path.join(dir, "supplier.xml")), now: () => Date.parse("2026-10-21T06:00:00.000Z"), tmpDir: dir, controls: throwing, coordinator: createCommitter({ store: new MemoryStore() }) });
  assert.equal(r.feeds[0].state, "BLOCKED_CC");
});
test("W2: координатора між машинами немає — запис лише в явному однохостовому режимі; GitHub Actions — відмова", () => {
  assert.throws(() => w2Coordinator({ GITHUB_ACTIONS: "true", MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: "x" }), /GitHub Actions/);
  assert.throws(() => w2Coordinator({ MM_SAFE_WRITE_DIR: "x" }), /однохостовому режимі/);
  assert.throws(() => w2Coordinator({ MM_W2_MODE: "single-host" }), /MM_SAFE_WRITE_DIR/);
  assert.deepEqual(w2Coordinator({ MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: "D:/w2" }), { kind: "single-host-file", dir: "D:/w2" });
});

test("Перенесення: доручення CC змінилось між копією й видаленням (свіжий стан) — з каталогу нічого не видалено; незмінне доручення — видалено", async () => {
  const NOW = Date.parse("2026-10-22T10:00:00Z");
  for (const keep of [false, true]) {
    const s = generateSynthetic({ products: 12, queue: 1, deferred: 1, newOffers: 0, seed: 3, now: NOW });
    const book = { "Основний каталог": s.sheets["Основний каталог"], "Нові товари": s.sheets["Нові товари"], "Відкладені товари": s.sheets["Відкладені товари"], "Заморожені ID": [["Offer ID"]], "Групи": s.groups, "Журнал": [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
    const sheets = new MemorySheets(book);
    await mergeNew92({ sheets, readBook: async () => sheets.read(), stamp: new Date(NOW).toISOString() });
    const id = String(sheets.book["Основний каталог"][2][0]);
    const gw = new WriteGateway({ sheets, read: async (n) => sheets.read(n), store: new MemoryStore(), now: () => NOW });
    const session = await gw.open({ writer: "sync" });
    const moves = { toArchive: [id], toCatalog: [] };
    const r = await runArchiveMoves({ session, read: async (n) => sheets.read(n), stamp: "t", controls: { removed: new Set([id]), moves, blocked: false,
      refresh: async () => ({ blocked: false, moves: keep ? moves : { toArchive: [], toCatalog: [] } }) } });
    await session.close();
    const inMain = sheets.book["Основний каталог"].some((row) => String(row[0]) === id);
    if (keep) { assert.equal(r.state, "OK", JSON.stringify(r).slice(0, 300)); assert.equal(inMain, false); }
    else { assert.equal(r.state, "BLOCKED"); assert.match(r.reason, /доручення Catalog Controls змінилось/); assert.equal(inMain, true, "у каталозі лишився"); }
  }
});

test("Точка перенесення: CC blocked / не підключено / state() кидає / без шлюзу W2 — BLOCKED, жодної оренди й запису", async () => {
  let opened = 0;
  const gateway = { open: async () => { opened++; throw new Error("не мало відкриватись"); } };
  const blocked = { state: async () => ({ blocked: true, reasons: ["точка недійсна"] }), verify: async () => ({ ok: false }) };
  const throwing = { state: async () => { throw new Error("недоступно"); }, verify: async () => ({ ok: false }) };
  assert.equal((await runArchiveStep({ readBook: async () => ({}), gateway, controls: blocked, stamp: "t" })).state, "BLOCKED_CC");
  assert.equal((await runArchiveStep({ readBook: async () => ({}), gateway, controls: throwing, stamp: "t" })).state, "BLOCKED_CC");
  assert.equal((await runArchiveStep({ readBook: async () => ({}), gateway, controls: null, stamp: "t" })).state, "BLOCKED_CC");
  const ok = { state: async () => ({ blocked: false, moves: { toArchive: [], toCatalog: [] } }), verify: async () => ({ ok: true }) };
  assert.equal((await runArchiveStep({ readBook: async () => ({}), gateway: null, controls: ok, stamp: "t" })).state, "BLOCKED");
  assert.equal(opened, 0);
});
