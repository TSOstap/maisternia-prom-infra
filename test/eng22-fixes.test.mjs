/** ENG-22 — виправлення блокерів Hermes ENG-21 (F01, F03, F05, F07) без модуля CC: синтетика, LocalObjectStore, робочий конфіг,
 *  координатор W2, двійник CC, локальний Worker. Композиційні проби зі справжнім CC — eng22-compose.test.mjs.
 *  Модель — один хост: НЕ доказ поведінки R2 чи розгорнутого Worker. */
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { fenceFeeds, assertCasCapability, OPERATIONAL_KEY, CAS_PROBE_KEY } from "../src/publish/feed-fence.mjs";
import { manifestKey, servedChain, servedNames, readServedVersions } from "../src/publish/publisher.mjs";
import { runUpdate, guardedRollback, servedSafety, secureServed } from "../src/pipeline/update.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { PROVISIONAL_QUEUE_SPEC, UNDEFINED_B6_COLUMNS, withProvisionalQueue } from "../src/pipeline/safe-write/queue-ownership.mjs";
import { loadOwnership } from "../src/pipeline/safe-write/ownership.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { mergeNew92 } from "../src/pipeline/sheet-sync-run.mjs";
import { SHEET, QUEUE_HEADERS } from "../src/core/sheet-sync.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { offersById } from "../src/core/yml.mjs";
import { intakeAll, readyFromXml, EMPTY_CATALOG } from "./helpers/intake.mjs";
import worker from "../worker/src/index.js";
import { r2BindingFrom } from "./helpers/r2-fake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const tmp = (p) => fsp.mkdtemp(path.join(os.tmpdir(), p));
const KEY = manifestKey("main");
const NONE = { blocked: false, kind: "NONE" };
const ccOf = (removed = []) => ({ held: new Set(removed), removed: new Set(removed), tombstoned: new Map(removed.map((id) => [id, { stage: "REGISTERED" }])), blocked: false, reasons: [], fingerprint: "fp:" + removed.join(","), gate: { check: () => NONE } });
const noFence = ({ fence: _f, ...rest } = {}) => rest;

/** Інженерний світ: синтетика, LocalObjectStore, робочий конфіг, координатор W2 з віртуальним годинником, двійник CC (removed — змінний). */
async function feedWorld() {
  const T0 = Date.parse("2026-10-21T06:00:00.000Z");
  const dir = await tmp("mm-e22-world-");
  const s = generateSynthetic({ products: 40, queue: 2, deferred: 2, newOffers: 0, seed: 7, now: T0 });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  await fsp.writeFile(path.join(dir, "supplier.xml"), s.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = productionConfig(structuredClone(baseConfig));
  config.supplier.minimumOffers = 10;
  const clock = { now: T0 };
  const cc = { removed: [], state: async () => ccOf(cc.removed), verify: async (fp) => ({ ok: fp === ccOf(cc.removed).fingerprint, reasons: ["відбиток змінився"] }) };
  const coordinator = createCommitter({ store: new MemoryStore(), now: () => clock.now, ttlMs: 60_000, settleMs: 0 });
  const ctx = (extra = {}) => ({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(path.join(dir, "supplier.xml")), now: () => clock.now, tmpDir: dir, controls: cc, coordinator, ...extra });
  const get = async (method = "GET", st = store) => {
    const r = await worker.fetch(new Request("https://feeds.test/feeds/main.xml?key=" + "k".repeat(32), { method }), { FEEDS_BUCKET: r2BindingFrom(st), FEED_ACCESS_KEY: "k".repeat(32), FEEDS: "main" });
    return { status: r.status, version: r.headers.get("x-feed-version"), xml: method === "GET" && r.status === 200 ? await r.text() : null };
  };
  const supplierIdOf = (id) => String(s.sheets["Основний каталог"].find((r) => String(r[0]) === id)[1]);
  const bumpPrice = (ids, by = 17) => { let xml = s.supplierXml(); for (const id of ids) xml = xml.replace(new RegExp(`(<offer id="${supplierIdOf(id)}"[\\s\\S]*?<price>)([^<]+)(</price>)`), (_, a, p, b) => a + String(Number(p) + by) + b); return fsp.writeFile(path.join(dir, "supplier.xml"), xml); };
  return { T0, dir, s, store, config, clock, cc, coordinator, ctx, get, bumpPrice };
}

// ---------- F01: невідомий HEAD ----------
test("F01 / servedChain: помилка HEAD активної версії — не доказ відсутності: версія вважається такою, що МОЖЕ обслуговуватися (небезпечно), читання — unknown", async () => {
  const x = await feedWorld();
  assert.equal((await runUpdate(x.ctx())).feeds[0].state, "PUBLISHED");
  const m = await x.store.getJson(KEY);
  const flaky = new Proxy(x.store, { get(t, p) { if (p === "head") return async (k) => { if (k === m.active.key) throw new Error("synthetic HEAD outage"); return t.head(k); }; const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  const ch = await servedChain(flaky, "main");
  assert.equal(ch.links.active.metaOk, "unknown");
  assert.equal(ch.served.xml, "active");
  assert.ok(servedNames(ch).includes("active"));
  assert.equal(await readServedVersions(flaky, "main"), null, "вміст не підтверджено — unknown, не доказ публікації / відсутності");
  const safety = await servedSafety(flaky, "main", ccOf([]));
  assert.equal(safety.safe, false, "навіть без обмежень: невідома версія не перевірена");
  // Справді відсутній об'єкт (HEAD → null) — не обслуговується (як Worker).
  const gone = new Proxy(x.store, { get(t, p) { if (p === "head") return async (k) => (k === m.active.key ? null : t.head(k)); const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  assert.deepEqual(servedNames(await servedChain(gone, "main")), []);
});

test("F01 / secureServed: HEAD активної версії недоступний, товар видалено в CC → зняття з обслуговування (Worker 503 і після відновлення HEAD)", async () => {
  const x = await feedWorld();
  assert.equal((await runUpdate(x.ctx())).feeds[0].state, "PUBLISHED");
  const del = [...offersById((await x.get()).xml).keys()][3];
  const m = await x.store.getJson(KEY);
  let denied = 0;
  const flaky = new Proxy(x.store, { get(t, p) { if (p === "head") return async (k) => { if (k === m.active.key) { denied++; throw new Error("synthetic HEAD outage"); } return t.head(k); }; const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  const r = await secureServed({ store: flaky, feed: "main", controls: ccOf([del]) });
  assert.ok(denied > 0);
  assert.equal(r.activeSafety, "UNSAFE");
  assert.ok(r.withdraw?.withdrawn, JSON.stringify(r));
  for (const method of ["GET", "HEAD"]) assert.equal((await x.get(method)).status, 503, method);
});

// ---------- F07: CAS обов'язковий ----------
test("F07 / відкат: сховище без оголошеного CAS, без getJsonEtag або з обгорткою, що губить умову, → BLOCK до перемикання; маніфест не змінено", async () => {
  const x = await feedWorld();
  assert.equal((await runUpdate(x.ctx())).feeds[0].state, "PUBLISHED");
  await x.bumpPrice([]);
  await fsp.writeFile(path.join(x.dir, "supplier.xml"), x.s.supplierXml().replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 1) + b));
  x.clock.now += 120_000;
  assert.equal((await runUpdate(x.ctx())).feeds[0].state, "PUBLISHED");
  const m0 = noFence(await x.store.getJson(KEY));
  const proxy = (over) => new Proxy(x.store, { get(t, p) { if (p in over) return over[p]; const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  const variants = {
    noEtag: proxy({ getJsonEtag: undefined }),
    undeclared: proxy({ capabilities: undefined }),
    dropsCondition: proxy({ putJson: (k, v) => x.store.putJson(k, v) }),
  };
  for (const [name, st] of Object.entries(variants)) {
    x.clock.now += 120_000;
    await assert.rejects(guardedRollback({ store: st, feed: "main", controls: x.cc, coordinator: x.coordinator }), /Відкат заборонено: fencing маніфесту не виконано — сховище фідів без атомарного умовного запису \(CAS\), BLOCK/, name);
    assert.deepEqual(noFence(await x.store.getJson(KEY)), m0, name + ": маніфест не змінено");
  }
  await assert.rejects(assertCasCapability(variants.dropsCondition), (e) => e.code === "NO_CAS");
  await assertCasCapability(x.store);
  assert.equal((await x.store.getJson(CAS_PROBE_KEY)).kind, "CAS_PROBE_V1");
  // Робочий публікатор: те саме — BLOCKED_W2 (жодного безумовного перемикання).
  x.clock.now += 120_000;
  const r = await runUpdate(x.ctx({ store: variants.dropsCondition }));
  assert.equal(r.feeds[0].state, "BLOCKED_W2", JSON.stringify(r.feeds[0]).slice(0, 300));
  assert.match(r.feeds[0].reason, /NO_CAS/);
});

// ---------- F03: fencing операційного стану ----------
test("F03 / fencing: отримання оренди підвищує епоху state/operational.json; через fenced-сховище він пишеться лише умовно, безумовний put / delete заборонено", async () => {
  const s = new LocalObjectStore(await tmp("mm-e22-op-"));
  const lease = (token) => ({ token, leaseId: crypto.randomBytes(16).toString("hex"), scope: "publisher", assertCurrent: async () => {} }); // ENG-23: leaseId
  const f5 = await fenceFeeds({ store: s, feeds: ["main"], lease: lease(5) });
  assert.deepEqual(await s.getJson(OPERATIONAL_KEY), { fence: f5.fence.stamp }, "відсутній ключ — заглушка з епохою");
  await f5.putJson(OPERATIONAL_KEY, { kind: "OPERATIONAL_STATE_V1", rows: { 1: [1] } });
  await assert.rejects(f5.put(OPERATIONAL_KEY, "{}"), (e) => e.code === "NOT_CONDITIONAL");
  await assert.rejects(f5.delete(OPERATIONAL_KEY), (e) => e.code === "NOT_CONDITIONAL");
  const f6 = await fenceFeeds({ store: s, feeds: ["main"], lease: lease(6) });
  await assert.rejects(f5.putJson(OPERATIONAL_KEY, { kind: "OPERATIONAL_STATE_V1", rows: { 1: [2] } }), (e) => e.code === "STALE_FENCE");
  assert.deepEqual((await s.getJson(OPERATIONAL_KEY)).rows, { 1: [1] });
  assert.equal((await s.getJson(OPERATIONAL_KEY)).fence.epoch, 6);
  await f6.putJson(OPERATIONAL_KEY, { kind: "OPERATIONAL_STATE_V1", rows: { 1: [3] } });
  assert.deepEqual((await s.getJson(OPERATIONAL_KEY)).rows, { 1: [3] });
});

test("F03 / комміт синхронізації: перехоплення оренди (CC з fencing) після verify і до запису → запізнілий запис відхилено сховищем; ціна видаленого не оновлена", async () => {
  const x = await feedWorld();
  assert.equal((await runUpdate(x.ctx())).sync.state, "OK");
  const op0 = await x.store.getJson(OPERATIONAL_KEY);
  const del = Object.keys(op0.rows)[3];
  await x.bumpPrice([del]);
  const raw = x.store.putJson.bind(x.store);
  let fired = false, opts = null, took = null;
  x.store.putJson = async (k, v, o) => {
    if (!fired && k === OPERATIONAL_KEY && JSON.stringify(v.rows?.[del]) !== JSON.stringify(op0.rows[del])) {
      fired = true; opts = o;
      // Оренда публікатора спливає; «CC» перехоплює оренду, підвищує епоху (протокол A: fencing) і фіксує видалення.
      x.clock.now += 120_000;
      const lease = await x.coordinator.acquire("catalog-controls");
      took = lease.token;
      await fenceFeeds({ store: x.store, feeds: ["main"], lease, scope: "catalog-controls" });
      x.cc.removed = [del];
      await lease.release();
    }
    return raw(k, v, o);
  };
  let r;
  try { r = await runUpdate(x.ctx()); } finally { x.store.putJson = raw; }
  assert.ok(fired && took, "передумова: перехоплення у вікні між verify і записом");
  assert.equal(typeof opts?.ifMatch, "string", "запис операційного стану — умовний");
  assert.equal(r.sync.state, "ERROR", JSON.stringify(r.sync));
  assert.match(r.sync.error, /оренду W2 перехоплено|STALE_FENCE/);
  assert.deepEqual((await x.store.getJson(OPERATIONAL_KEY)).rows[del], op0.rows[del], "ціна видаленого не оновлена");
});

// ---------- F05: власність колонок черги ----------
test("F05 / тимчасовий контракт черги (B6): покриває всі 53 колонки; intake не пише ручні колонки, колонки sync і 6 невизначених (B6 «?»); затверджений розділ має пріоритет", async () => {
  assert.deepEqual([...PROVISIONAL_QUEUE_SPEC.columns.keys()].sort(), [...QUEUE_HEADERS].sort());
  const own = withProvisionalQueue(loadOwnership());
  assert.deepEqual(own.provisional, [SHEET.queue, SHEET.deferred]); // ENG-29: + тимчасовий розділ «Відкладені товари» (лише видалення sync)
  const spec = own.sheets.get(SHEET.queue);
  for (const col of [...UNDEFINED_B6_COLUMNS, "Запити UA", "Група ID", "Категорія Prom ID", "Виробник", "Код товару Prom", "Статус імпорту", "Виявлено", "ID постачальника"]) assert.deepEqual(spec.columns.get(col).writers, [], col);
  assert.deepEqual(spec.columns.get("Рішення"), { group: spec.columns.get("Рішення").group, writers: ["intake"], gate: "cmd-consume" });
  assert.deepEqual(spec.appendWriters, ["intake"]);
  // ENG-29 (рішення власника 02.11, змінює B6): перенесені рядки прибирає з черги лише sync (за ключем зі знімком; охоронець — лише режим transfer).
  assert.deepEqual(spec.deleteWriters, ["sync"]);
  const approved = { ...own, sheets: new Map([[SHEET.queue, { ...spec, provisional: false }]]) };
  assert.equal(withProvisionalQueue(approved).sheets.get(SHEET.queue), approved.sheets.get(SHEET.queue), "затверджений розділ «Нові товари» — без підміни");
});

async function queueWorld() {
  const NOW = Date.parse("2026-10-22T10:00:00Z");
  const s = generateSynthetic({ products: 20, queue: 0, deferred: 0, newOffers: 4, seed: 29, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const w = { s, sheets, readBook: async () => sheets.read(), xml: s.supplierXml(), NOW, STAMP: new Date(NOW).toISOString() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: w.STAMP });
  return w;
}
const OK_CC = { state: async () => ccOf([]), verify: async () => ({ ok: true }) };
/** Новинки фіду, яких ще немає в «Основному каталозі». */
const freshOf = (w) => { const main = w.sheets.book[SHEET.main], sc = main[0].indexOf("ID постачальника"); const known = new Set(main.slice(1).map((r) => String(r[sc]))); return readyFromXml(w.xml, w.NOW).filter((e) => !known.has(e.id)); };

test("F05 / шлюз: записи черги за ключем — ручна колонка, колонка sync і кожна з 6 невизначених → відмова ДО запиту; «Рішення» лише споживається (очищення саме команди)", async () => {
  const w = await queueWorld();
  const cfg = productionConfig(structuredClone(baseConfig));
  const fresh = freshOf(w);
  assert.ok(fresh.length >= 1);
  assert.equal((await intakeAll(w, w.xml, { stamp: w.STAMP, now: w.NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session: "auto", ready: fresh.slice(0, 1) })).state, "INTAKE_DONE");
  const q = w.sheets.book[SHEET.queue], h = q[0], key = String(q[1][h.indexOf("Offer ID")]);
  const writes0 = w.sheets.metrics.writes;
  const s = await new WriteGateway({ sheets: w.sheets, read: w.readBook, store: new MemoryStore() }).open({ writer: "intake" });
  try {
    for (const col of [...UNDEFINED_B6_COLUMNS, "Група ID", "Запити UA", "Код товару Prom"]) {
      await assert.rejects(s.updateByKey({ title: SHEET.queue, changes: [{ key, expect: { [col]: String(q[1][h.indexOf(col)] ?? "") }, set: { [col]: "X" } }] }), (e) => e.code === "OWNERSHIP", col);
    }
    const d = h.indexOf("Рішення");
    await assert.rejects(s.updateByKey({ title: SHEET.queue, changes: [{ key, expect: { "Рішення": "" }, set: { "Рішення": "ВІДХИЛЕНО" } }] }), (e) => e.code === "CMD_CONSUME");
    w.sheets.book[SHEET.queue][1][d] = "ПЕРЕВІРЕНО";
    const r = await s.updateByKey({ title: SHEET.queue, changes: [{ key, expect: { "Рішення": "ПЕРЕВІРЕНО" }, set: { "Рішення": "" } }] });
    assert.equal(r.outcome, "VERIFIED");
  } finally { await s.close(); }
  assert.equal(w.sheets.metrics.writes, writes0 + 1, "лише одне дозволене споживання команди");
});

test("F05 / intake: «Рішення» = ВІДХИЛИТИ, поставлене власником під час запису черги, зберігається; правка власника в колонці intake між читанням і записом → CONFLICT_OWNER_EDIT, без ack, її значення збережено", async () => {
  const w = await queueWorld();
  const cfg = productionConfig(structuredClone(baseConfig));
  const ready = freshOf(w);
  assert.ok(ready.length >= 3);
  assert.equal((await intakeAll(w, w.xml, { stamp: w.STAMP, now: w.NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session: "auto", ready: ready.slice(0, 1) })).state, "INTAKE_DONE");
  const h = w.sheets.book[SHEET.queue][0], d = h.indexOf("Рішення"), price = h.indexOf("Ціна постачальника");
  // 1) Будь-який запис черги (оновлення наявного рядка або дописування сусіда) — власник саме ставить «ВІДХИЛИТИ» в рядку 2.
  const xml2 = w.xml.replace(/(<price>)([\d.]+)(<\/price>)/g, (_, a, p, b) => a + String(Number(p) + 5) + b);
  const rawU = w.sheets.updateRanges.bind(w.sheets), rawA = w.sheets.appendRows.bind(w.sheets);
  let fired = 0;
  const owner = () => { if (!fired++) w.sheets.book[SHEET.queue][1][d] = "ВІДХИЛИТИ"; };
  w.sheets.updateRanges = async (ranges) => { if (ranges.some((r) => r.title === SHEET.queue && r.row >= 2)) owner(); return rawU(ranges); };
  w.sheets.appendRows = async (title, rows) => { if (title === SHEET.queue) owner(); return rawA(title, rows); };
  let r;
  try { r = await intakeAll(w, xml2, { stamp: w.STAMP, now: w.NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session: "auto", ready: ready.slice(1, 2) }); }
  finally { w.sheets.updateRanges = rawU; w.sheets.appendRows = rawA; }
  assert.ok(fired, "передумова: власник змінив рішення під час запису intake");
  assert.equal(r.state, "INTAKE_DONE", JSON.stringify(r).slice(0, 300));
  assert.equal(w.sheets.book[SHEET.queue][1][d], "ВІДХИЛИТИ", "рішення власника не перезаписано");
  // 2) Власник змінює ціну постачальника (колонка intake) між читанням intake і свіжим читанням шлюзу → CONFLICT_OWNER_EDIT.
  const xml3 = w.xml.replace(/(<price>)([\d.]+)(<\/price>)/g, (_, a, p, b) => a + String(Number(p) + 9) + b);
  let edited = false;
  // Перше свіже читання шлюзу (keyedUpdate: читання й перевірка expect безпосередньо перед записом) — власник щойно змінив ціну.
  const gwRead = async (names) => { if (!edited && names.length === 1 && names[0] === SHEET.queue) { edited = true; w.sheets.book[SHEET.queue][1][price] = "777"; } return w.readBook(names); };
  const s = await new WriteGateway({ sheets: w.sheets, read: gwRead, store: new MemoryStore() }).open({ writer: "intake" });
  let c;
  try { c = await intakeAll(w, xml3, { stamp: w.STAMP, now: w.NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session: s, ready: [] }); }
  finally { await s.close(); }
  assert.ok(edited, "передумова: правка власника перед записом шлюзу");
  assert.equal(c.state, "CONFLICT_OWNER_EDIT", JSON.stringify(c).slice(0, 400));
  assert.equal(c.ack, undefined);
  assert.equal(String(w.sheets.book[SHEET.queue][1][price]), "777", "правку власника збережено");
  assert.equal(w.sheets.book[SHEET.queue][1][d], "ВІДХИЛИТИ");
});

test("F05 / intake: план змінює колонку, якою intake не володіє за контрактом черги, → BLOCKED_OWNERSHIP ДО будь-якого запису (жодного запису в аркуш, ack немає)", async () => {
  const w = await queueWorld();
  const cfg = productionConfig(structuredClone(baseConfig));
  const ready = freshOf(w);
  assert.equal((await intakeAll(w, w.xml, { stamp: w.STAMP, now: w.NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session: "auto", ready: ready.slice(0, 1) })).state, "INTAKE_DONE");
  // Контракт, у якому «Ціна постачальника» черги нікому не належить (як 6 колонок B6 «?» до затвердження) — зміна ціни в плані intake.
  const base = withProvisionalQueue(loadOwnership()), spec = base.sheets.get(SHEET.queue);
  const columns = new Map(spec.columns);
  columns.set("Ціна постачальника", { ...columns.get("Ціна постачальника"), writers: Object.freeze([]) });
  const contract = { ...base, sheets: new Map([...base.sheets, [SHEET.queue, { ...spec, columns }]]) };
  const xml2 = w.xml.replace(/(<price>)([\d.]+)(<\/price>)/g, (_, a, p, b) => a + String(Number(p) + 4) + b);
  const q0 = structuredClone(w.sheets.book[SHEET.queue]), j0 = structuredClone(w.sheets.book[SHEET.journal]), writes0 = w.sheets.metrics.writes;
  const s = await new WriteGateway({ sheets: w.sheets, read: w.readBook, store: new MemoryStore(), contract }).open({ writer: "intake" });
  let r;
  try { r = await intakeAll(w, xml2, { stamp: w.STAMP, now: w.NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session: s, ready: [] }); }
  finally { await s.close(); }
  assert.equal(r.state, "BLOCKED_OWNERSHIP", JSON.stringify(r).slice(0, 300));
  assert.match(r.reason, /Ціна постачальника/);
  assert.equal(r.ack, undefined);
  assert.equal(w.sheets.metrics.writes, writes0, "0 записів");
  assert.deepEqual(w.sheets.book[SHEET.queue], q0);
  assert.deepEqual(w.sheets.book[SHEET.journal], j0);
});

test("F07 / функціональна проба CAS: сховище, що виконує лише If-None-Match і ігнорує If-Match (свіже, без ключа проби), → NO_CAS", async () => {
  const s = new LocalObjectStore(await tmp("mm-e22-inm-"));
  const onlyNoneMatch = new Proxy(s, { get(t, p) { if (p === "putJson") return (k, v, o) => (typeof o?.ifMatch === "string" ? t.putJson(k, v) : t.putJson(k, v, o)); const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  await assert.rejects(assertCasCapability(onlyNoneMatch), (e) => e.code === "NO_CAS" && /хибним If-Match/.test(e.message));
  await assertCasCapability(new LocalObjectStore(await tmp("mm-e22-ok-")));
});
