/** ENG-24 — процедура відновлення cc-recovery-v1 (E8), блокування публікації й відкату (E7), ручні правки після відкату W2 (E9),
 *  допуск tools/recover.mjs — без модуля CC (синтетика, двійник CC). Композиційні сценарії зі справжнім CC R7.3 —
 *  eng24-recovery-compose.test.mjs. Модель — один хост. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { MemoryStore, FileStore } from "../src/pipeline/safe-write/store.mjs";
import { createCommitter, leaseKeyOf } from "../src/pipeline/safe-write/committer.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { REGISTRY_KEY } from "../src/publish/feed-fence.mjs";
import { manifestKey } from "../src/publish/publisher.mjs";
import { readRecovery, declareRecovery, authorizeRecover, establishFloor, confirmationFor } from "../src/pipeline/recovery.mjs";
import { runUpdate, guardedRollback } from "../src/pipeline/update.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (p) => fsp.mkdtemp(path.join(os.tmpdir(), p));
const NONE = { blocked: false, kind: "NONE" };
const OK_CC = { state: async () => ({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp", gate: { check: () => NONE } }), verify: async () => ({ ok: true, reasons: [] }) };

test("E8: declareRecovery — тип із переліку, повторне оголошення зберігає id; authorizeRecover — лише точний id, ім'я власника й «ВІДНОВИТИ <id>»; ENG-25 (e1 / e2): CP_ONLY / W2_ONLY оголошує лише система, тип без доведеної межі — FLOOR_NOT_PROVEN без зняття блокування", async () => {
  const feeds = new LocalObjectStore(await tmp("mm-e24-rec-"));
  assert.equal((await readRecovery(feeds)).recovery.state, "NORMAL");
  await assert.rejects(declareRecovery({ feedStore: feeds, type: "WHATEVER" }), /невідомий тип/);
  for (const declaredBy of [undefined, "operator", "api"]) await assert.rejects(declareRecovery({ feedStore: feeds, type: "CP_ONLY", declaredBy }), (e) => e.code === "RECOVERY_TYPE_FORBIDDEN");
  assert.equal((await readRecovery(feeds)).recovery.state, "NORMAL", "відмова нічого не записала");
  const a = await declareRecovery({ feedStore: feeds, type: "CP_ONLY", reason: "тест", declaredBy: "system" });
  assert.equal(a.state, "RECOVERY_PENDING");
  assert.match(a.id, /^[0-9a-f]{12}$/);
  const b = await declareRecovery({ feedStore: feeds, type: "W2_ONLY", reason: "ще раз", declaredBy: "system" });
  assert.equal(b.id, a.id, "активне відновлення не перезаписується (тип із доведеною межею — без ескалації)");
  const bad = (e) => e.code === "RECOVERY_NOT_AUTHORIZED";
  await assert.rejects(authorizeRecover({ feedStore: feeds, id: "000000000000", authorizedBy: "В", confirm: confirmationFor("000000000000") }), bad);
  await assert.rejects(authorizeRecover({ feedStore: feeds, id: a.id, authorizedBy: "  ", confirm: confirmationFor(a.id) }), bad);
  await assert.rejects(authorizeRecover({ feedStore: feeds, id: a.id, authorizedBy: "Власник", confirm: "ВІДНОВИТИ" }), bad);
  assert.equal((await readRecovery(feeds)).recovery.state, "RECOVERY_PENDING", "відмови нічого не змінили");
  const ok = await authorizeRecover({ feedStore: feeds, id: a.id, authorizedBy: "Власник", confirm: confirmationFor(a.id) });
  assert.equal(ok.state, "RECOVERY_AUTHORIZED"); assert.equal(ok.floorProven, true); assert.equal(ok.authorizedBy, "Власник");
  await assert.rejects(authorizeRecover({ feedStore: feeds, id: a.id, authorizedBy: "Власник", confirm: confirmationFor(a.id) }), bad, "повторний дозвіл — не в PENDING");
  const f2 = new LocalObjectStore(await tmp("mm-e24-rec2-"));
  const c = await declareRecovery({ feedStore: f2, type: "FULL" });
  await assert.rejects(authorizeRecover({ feedStore: f2, id: c.id, authorizedBy: "Власник", confirm: confirmationFor(c.id) }), (e) => e.code === "FLOOR_NOT_PROVEN", "FULL без незалежного координатора — межу не доведено");
  const r2 = (await readRecovery(f2)).recovery;
  assert.equal(r2.state, "RECOVERY_PENDING", "дозвіл блокування не знімає"); assert.equal(r2.ownerAck.by, "Власник"); assert.equal(r2.floorProven, undefined);
  // Запис ENG-24, де оператор оголосив W2_ONLY (тоді CLI це дозволяв), — тип не виявлено системою: межу не доведено.
  const f3 = new LocalObjectStore(await tmp("mm-e24-rec3-"));
  await f3.putJson(REGISTRY_KEY, { v: 1, recovery: { state: "RECOVERY_PENDING", type: "W2_ONLY", id: "abcdefabcdef", since: "2026-10-31T00:00:00.000Z", reason: "ENG-24", declaredBy: "operator" } });
  await assert.rejects(authorizeRecover({ feedStore: f3, id: "abcdefabcdef", authorizedBy: "Власник", confirm: confirmationFor("abcdefabcdef") }), (e) => e.code === "FLOOR_NOT_PROVEN");
  assert.equal((await readRecovery(f3)).recovery.state, "RECOVERY_PENDING");
});

test("E8: establishFloor — без дозволу / для FULL відмова; для W2_ONLY (ENG-25: ознака — лічильник оренди W2 нижчий за епоху маніфесту) лічильник оренди лише зростає, покоління + 1, чинна оренда → BUSY; повтор — той самий результат", async () => {
  const feeds = new LocalObjectStore(await tmp("mm-e24-floor-")), w2 = new MemoryStore();
  let t = 1_000_000;
  const cm = createCommitter({ store: w2, now: () => t, ttlMs: 1000, settleMs: 0 });
  for (let i = 0; i < 4; i++) { const l = await cm.acquire("sync"); await l.release(); }
  await feeds.putJson(manifestKey("main"), { fence: { epoch: 9, leaseId: "a".repeat(32) } });
  const d = await declareRecovery({ feedStore: feeds, type: "W2_ONLY", declaredBy: "system" });
  await assert.rejects(establishFloor({ feedStore: feeds, w2Store: w2, committer: cm, feeds: ["main"] }), (e) => e.code === "RECOVERY_NOT_AUTHORIZED");
  await authorizeRecover({ feedStore: feeds, id: d.id, authorizedBy: "Власник", confirm: confirmationFor(d.id) });
  const held = await cm.acquire("publisher");
  await assert.rejects(establishFloor({ feedStore: feeds, w2Store: w2, committer: cm, feeds: ["main"] }), (e) => e.code === "BUSY");
  await held.release();
  const fl = await establishFloor({ feedStore: feeds, w2Store: w2, committer: cm, feeds: ["main"] });
  assert.deepEqual({ floor: fl.floor, generation: fl.generation }, { floor: 9, generation: 1 });
  assert.equal((await w2.getJsonVersioned(leaseKeyOf("sheets-main"))).value.token, 9);
  assert.deepEqual(await establishFloor({ feedStore: feeds, w2Store: w2, committer: cm, feeds: ["main"] }), fl);
  const next = await cm.acquire("catalog-controls", { floor: 9 });
  assert.equal(next.token, 10); assert.equal(next.generation, 1);
  await next.release();
  // FULL — межу не доведено.
  const f2 = new LocalObjectStore(await tmp("mm-e24-floor2-"));
  const e = await declareRecovery({ feedStore: f2, type: "FULL" });
  await assert.rejects(authorizeRecover({ feedStore: f2, id: e.id, authorizedBy: "Власник", confirm: confirmationFor(e.id) }), (x) => x.code === "FLOOR_NOT_PROVEN");
  const tokenBefore = (await w2.getJsonVersioned(leaseKeyOf("sheets-main"))).value.token;
  await assert.rejects(establishFloor({ feedStore: f2, w2Store: w2, committer: cm, feeds: ["main"] }), (x) => x.code === "FLOOR_NOT_PROVEN");
  assert.equal((await w2.getJsonVersioned(leaseKeyOf("sheets-main"))).value.token, tokenBefore, "лічильник оренди не змінено");
  // Лічильник не зменшується.
  const r = await cm.raiseFloor("catalog-controls", { floor: 2 });
  assert.equal(r.token, 10);
  // Покоління — новіше за дзеркало (W2 відкочено на копію до попереднього відновлення: запис оренди з меншим поколінням).
  const f3 = new LocalObjectStore(await tmp("mm-e24-floor3-")), w3 = new MemoryStore();
  const cm3 = createCommitter({ store: w3, now: () => t, ttlMs: 1000, settleMs: 0 });
  await f3.putJson(REGISTRY_KEY, { v: 1, generation: 5, epochHigh: 3, leaseId: null, committed: null, prepared: null });
  const g = await declareRecovery({ feedStore: f3, type: "W2_ONLY", declaredBy: "system" });
  await authorizeRecover({ feedStore: f3, id: g.id, authorizedBy: "Власник", confirm: confirmationFor(g.id) });
  const fl3 = await establishFloor({ feedStore: f3, w2Store: w3, committer: cm3, feeds: ["main"] });
  assert.deepEqual({ floor: fl3.floor, generation: fl3.generation }, { floor: 3, generation: 6 });
  const l3 = await cm3.acquire("catalog-controls", { floor: fl3.floor });
  assert.equal(l3.generation, 6); assert.ok(l3.token > fl3.floor);
  await l3.release();
});

async function feedWorld() {
  const T0 = Date.parse("2026-10-21T06:00:00.000Z");
  const dir = await tmp("mm-e24-world-");
  const s = generateSynthetic({ products: 40, queue: 2, deferred: 2, newOffers: 0, seed: 7, now: T0 });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  await fsp.writeFile(path.join(dir, "supplier.xml"), s.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = productionConfig(structuredClone(baseConfig));
  config.supplier.minimumOffers = 10;
  const clock = { now: T0 };
  const coordinator = createCommitter({ store: new MemoryStore(), now: () => clock.now, ttlMs: 60_000, settleMs: 0 });
  const ctx = () => ({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(path.join(dir, "supplier.xml")), now: () => clock.now, tmpDir: dir, controls: OK_CC, coordinator });
  return { dir, s, store, clock, ctx, coordinator };
}

test("E7: під час відновлення (стан у дзеркалі) — публікатор нічого не публікує (RECOVERY_PENDING), відкат відхилено; після NORMAL — звичайна публікація", async () => {
  const x = await feedWorld();
  assert.equal((await runUpdate(x.ctx())).feeds[0].state, "PUBLISHED");
  await fsp.writeFile(path.join(x.dir, "supplier.xml"), x.s.supplierXml().replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 1) + b));
  x.clock.now += 120_000;
  assert.equal((await runUpdate(x.ctx())).feeds[0].state, "PUBLISHED");
  const d = await declareRecovery({ feedStore: x.store, type: "UNKNOWN", reason: "тест E7" });
  const m0 = await x.store.getJson(manifestKey("main"));
  await fsp.writeFile(path.join(x.dir, "supplier.xml"), x.s.supplierXml().replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 7) + b));
  x.clock.now += 120_000;
  const r = await runUpdate(x.ctx());
  assert.equal(r.feeds[0].state, "RECOVERY_PENDING", JSON.stringify(r.feeds[0]).slice(0, 300));
  assert.match(r.feeds[0].reason, new RegExp(d.id));
  const m1 = await x.store.getJson(manifestKey("main"));
  assert.equal(m1.active.key, m0.active.key, "нової версії не опубліковано");
  x.clock.now += 120_000;
  await assert.rejects(guardedRollback({ store: x.store, feed: "main", controls: OK_CC, coordinator: x.coordinator }), (e) => e.code === "RECOVERY_PENDING");
  assert.equal((await x.store.getJson(manifestKey("main"))).active.key, m0.active.key);
  // Стан дзеркала не читається — так само заборона (fail-closed).
  const broken = new Proxy(x.store, { get(t, p) { if (p === "getJsonEtag") return async (k) => { if (k === REGISTRY_KEY) throw new Error("synthetic"); return t.getJsonEtag(k); }; const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  x.clock.now += 120_000;
  await assert.rejects(guardedRollback({ store: broken, feed: "main", controls: OK_CC, coordinator: x.coordinator }), (e) => e.code === "RECOVERY_PENDING");
  // Ранній вихід (фід постачальника не сформовано) — аварійний патч активної версії теж публікація: під час відновлення його немає.
  const good = await fsp.readFile(path.join(x.dir, "supplier.xml"), "utf8");
  await fsp.writeFile(path.join(x.dir, "supplier.xml"), "<yml_catalog>зламано");
  x.clock.now += 120_000;
  const early = await runUpdate(x.ctx());
  assert.equal(early.sync.state, "ERROR");
  assert.equal(early.feeds[0].state, "RECOVERY_PENDING", JSON.stringify(early.feeds[0]).slice(0, 300));
  assert.equal((await x.store.getJson(manifestKey("main"))).active.key, m0.active.key, "аварійного патча не опубліковано");
  await fsp.writeFile(path.join(x.dir, "supplier.xml"), good);
  // Повернення в NORMAL (як після afterCommit фази recover) — публікація знову можлива.
  const { value, etag } = await x.store.getJsonEtag(REGISTRY_KEY);
  await x.store.putJson(REGISTRY_KEY, { ...value, recovery: { state: "NORMAL", type: null, id: null, since: null, reason: "" } }, { ifMatch: etag });
  x.clock.now += 120_000;
  assert.equal((await runUpdate(x.ctx())).feeds[0].state, "PUBLISHED");
});

test("E9 / F08-8: ручні правки власника після резервної копії W2 — після відкату W2 (оренда й журнал операцій) синхронізація через шлюз їх не перезаписує (стан полів — в аркуші, не в W2)", async () => {
  const NOW = Date.parse("2026-10-22T10:00:00Z"), STAMP = new Date(NOW).toISOString();
  const s = generateSynthetic({ products: 30, queue: 2, deferred: 2, newOffers: 0, seed: 13, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"], [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book), readBook = async () => sheets.read(), xml = s.supplierXml();
  await mergeNew92({ sheets, readBook, stamp: STAMP });
  const w2dir = await tmp("mm-e24-e9-"), snap = w2dir + "-snap";
  const cfg = structuredClone(baseConfig); cfg.ownerPriority = { enabled: true };
  const OK = { held: new Set(), removed: new Set(), blocked: false, reasons: [], fingerprint: "fp-ok", gate: { check: () => NONE } };
  const sync = async (stamp) => {
    const session = await new WriteGateway({ sheets, read: readBook, store: new FileStore(w2dir) }).open({ writer: "sync" });
    try { return await syncSheet({ sheets, readBook, parsed: await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true }), fetchFull: async (ids) => extractFullOffers(xml, ids), stamp, config: cfg, now: NOW, catalog: EMPTY_CATALOG, controls: OK, session }); }
    finally { await session.close().catch(() => {}); }
  };
  assert.equal((await sync(STAMP)).state, "SYNCED");
  fs.cpSync(w2dir, snap, { recursive: true }); // резервна копія W2
  const rows = () => readSheet(sheets.book[SHEET.main], SHEET.main).rows;
  const id = mtText(rows()[4]["Offer ID"]), rowNo = sheets.book[SHEET.main].findIndex((r) => mtText(r[0]) === id) + 1;
  sheets.humanSet(SHEET.main, rowNo, "Назва UA", "Назва власника після копії");
  sheets.humanSet(SHEET.main, rowNo, "Запити UA", "запит власника");
  assert.equal((await sync(new Date(NOW + 60_000).toISOString())).state, "SYNCED");
  fs.rmSync(w2dir, { recursive: true, force: true }); fs.cpSync(snap, w2dir, { recursive: true }); // відкат W2
  const r = await sync(new Date(NOW + 120_000).toISOString());
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 300));
  const row = rows().find((x) => mtText(x["Offer ID"]) === id);
  assert.equal(mtText(row["Назва UA"]), "Назва власника після копії");
  assert.equal(mtText(row["Запити UA"]), "запит власника");
});

test("E8 / tools/recover.mjs: без допуску W2 — код 2 до будь-якого запису; ENG-25 (e1 / e2): оператор оголошує лише FULL / UNKNOWN (CP_ONLY / W2_ONLY — код 2, нічого не записано); дозвіл FULL — код 1 FLOOR_NOT_PROVEN, стан RECOVERY_PENDING; W2_ONLY, виявлений системою, — authorize (невірне підтвердження — код 1) / establish-floor", async () => {
  const dir = await tmp("mm-e24-tool-"), w2 = path.join(dir, "w2"), feeds = path.join(dir, "objects");
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, "tools", "recover.mjs"), ...args], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
  const ENV = { MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: w2 };
  for (const env of [{}, { ...ENV, GITHUB_ACTIONS: "true" }, { MM_W2_MODE: "single-host" }]) {
    const r = run(["status", "--feed-store=" + feeds], env);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /W2/);
  }
  assert.equal(fs.existsSync(feeds), false, "без допуску нічого не створено");
  const st = run(["status", "--feed-store=" + feeds], ENV);
  assert.equal(st.status, 0, st.stderr);
  assert.equal(JSON.parse(st.stdout).recovery.state, "NORMAL");
  for (const type of ["CP_ONLY", "W2_ONLY"]) {
    const d = run(["declare", "--feed-store=" + feeds, "--type=" + type, "--reason=тест"], ENV);
    assert.equal(d.status, 2, type + ": " + d.stderr);
    assert.match(d.stderr, /FULL або UNKNOWN/);
  }
  assert.equal(JSON.parse(run(["status", "--feed-store=" + feeds], ENV).stdout).recovery.state, "NORMAL", "відмова оператора нічого не записала");
  const dec = run(["declare", "--feed-store=" + feeds, "--type=FULL", "--reason=тест"], ENV);
  assert.equal(dec.status, 0, dec.stderr);
  const fid = JSON.parse(dec.stdout).id;
  const fullAuth = run(["authorize", "--feed-store=" + feeds, "--id=" + fid, "--by=Власник", "--confirm=ВІДНОВИТИ " + fid], ENV);
  assert.equal(fullAuth.status, 1);
  assert.match(fullAuth.stderr, /FLOOR_NOT_PROVEN|не доведено/);
  const fst = JSON.parse(run(["status", "--feed-store=" + feeds], ENV).stdout).recovery;
  assert.equal(fst.state, "RECOVERY_PENDING"); assert.equal(fst.ownerAck.by, "Власник");
  assert.equal(run(["establish-floor", "--feed-store=" + feeds], ENV).status, 1);
  // W2_ONLY, виявлений системою (запис оренди W2 нижчий за епоху маніфесту — ознака в сховищах).
  const feeds2 = path.join(dir, "objects2"), fs2 = new LocalObjectStore(feeds2);
  await fs2.putJson(manifestKey("main"), { fence: { epoch: 9, leaseId: "a".repeat(32) } });
  const id = (await declareRecovery({ feedStore: fs2, type: "W2_ONLY", declaredBy: "system" })).id;
  const badAuth = run(["authorize", "--feed-store=" + feeds2, "--id=" + id, "--by=Власник", "--confirm=так"], ENV);
  assert.equal(badAuth.status, 1);
  const auth = run(["authorize", "--feed-store=" + feeds2, "--id=" + id, "--by=Власник", "--confirm=ВІДНОВИТИ " + id], ENV);
  assert.equal(auth.status, 0, auth.stderr);
  const fl = run(["establish-floor", "--feed-store=" + feeds2], ENV);
  assert.equal(fl.status, 0, fl.stderr);
  assert.equal(JSON.parse(fl.stdout).generation, 1);
});
