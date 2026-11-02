/** ENG-27 — регресії до ревю Hermes INT-ENG26-R741 (B/C BLOCK):
 *   N2 — підміна об'єкта активної версії фіду через API: версії write-once (канонічний ключ і псевдонім); у маніфесті — відбиток самих
 *        збережених байтів (storedSha256); Worker, servedChain, відкат і перевірка версії звіряють БАЙТИ, а не метадані записувача;
 *        «видалити й записати» під тим самим ключем не повертає видалене у відповідь 200.
 *   N3 — syncSheet: черга лише за Offer ID з очікуваними значеннями; рішення власника sync не стирає й не змінює; правка власника під час
 *        запуску → CONFLICT (не SYNCED); 6 колонок B6 «?» і ручні колонки — без змін; видалення рядків черги — ЗАБЛОКОВАНО (B6);
 *        службові команди виконує лише intake (рядок із командою sync не оновлює); звіт для Worker — за фактично записаним.
 *  Лише синтетика й тимчасові каталоги; мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate, guardedRollback } from "../src/pipeline/update.mjs";
import * as publisher from "../src/publish/publisher.mjs"; // простір імен: без нових експортів (до ENG-27) падають окремі тести, а не весь файл
const { manifestKey, readServedVersions, servedChain, expectedStoredSha, storedBytesOk, verifyStoredVersion, META_UNKNOWN } = publisher;
import { offersById } from "../src/core/yml.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import worker from "../worker/src/index.js";
import { r2BindingFrom } from "./helpers/r2-fake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, DECISION, extractFullOffers, readPassport, ackFor } from "../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { EMPTY_CATALOG, intakeAll } from "./helpers/intake.mjs";
import { UNDEFINED_B6_COLUMNS } from "../src/pipeline/safe-write/queue-ownership.mjs";
import legacyConfig from "./helpers/legacy-config.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ================================================================ N2
const T0 = Date.parse("2026-10-21T06:00:00.000Z");
const KEY = "k".repeat(32);
function cc({ removed = [], tag = "" } = {}) {
  const st = () => ({ held: new Set(removed), removed: new Set(removed), tombstoned: new Map(removed.map((id) => [id, { stage: "REGISTERED" }])), blocked: false, reasons: [], fingerprint: "fp:" + removed.join(",") + tag });
  return { state: async () => st(), verify: async (fp) => ({ ok: fp === st().fingerprint, reasons: [] }) };
}
async function feedWorld({ gzip = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-e27-"));
  const s = generateSynthetic({ products: 40, queue: 2, deferred: 2, newOffers: 0, seed: 7, now: T0 });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  const supplierFile = path.join(dir, "supplier.xml");
  await fsp.writeFile(supplierFile, s.supplierXml());
  const root = path.join(dir, "store");
  const store = new LocalObjectStore(root);
  await store.putJson("approved/main.json", s.manifestMain);
  const config = productionConfig(structuredClone(baseConfig));
  config.supplier.minimumOffers = 10;
  if (gzip) for (const f of config.feeds) f.gzip = true;
  const coordinator = createCommitter({ store: new MemoryStore() });
  const ctx = (controls, now = T0) => ({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(supplierFile), now: () => now, tmpDir: dir, coordinator, controls });
  const env = { FEEDS_BUCKET: r2BindingFrom(store), FEED_ACCESS_KEY: KEY, FEEDS: "main" };
  const get = (p, method = "GET") => worker.fetch(new Request("https://feeds.test" + p + "?key=" + KEY, { method }), env);
  const bump = () => fsp.writeFile(supplierFile, s.supplierXml().replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 1) + b));
  return { dir, root, s, store, config, ctx, supplierFile, get, bump, coordinator };
}
/** Байти тієї самої довжини з іншим вмістом (одна цифра ціни). */
function forgeSameLength(buf) {
  const out = Buffer.from(buf);
  const i = out.indexOf(Buffer.from("<price>")) + 7;
  out[i] = out[i] === 0x31 ? 0x32 : 0x31;
  return out;
}
/** Підміна в обхід write-once: видалити й записати під тим самим ключем, підробивши метадані (розмір і sha256 — як у маніфесті). */
async function substitute(store, entry, bytes) {
  await store.delete(entry.key);
  await store.put(entry.key, bytes, { contentType: "application/xml", metadata: { sha256: entry.sha256 } });
}

test("ENG-27 N2: версії write-once — перезапис канонічним ключем → OBJECT_IMMUTABLE (байти й метадані без змін); той самий вміст — повтор без запису; псевдонім ключа не змінює обслуговуваного", async () => {
  const x = await feedWorld();
  assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
  const m = await x.store.getJson(manifestKey("main"));
  const file = path.join(x.root, ...m.active.key.split("/"));
  const bytes0 = fs.readFileSync(file), meta0 = fs.readFileSync(file + ".meta", "utf8");
  await assert.rejects(x.store.put(m.active.key, "<broken/>", { contentType: "application/xml" }), { code: "OBJECT_IMMUTABLE" });
  await assert.rejects(x.store.put(m.active.key, forgeSameLength(bytes0), { contentType: "application/xml", metadata: { sha256: m.active.sha256 } }), { code: "OBJECT_IMMUTABLE" }, "та сама довжина й підроблені метадані — теж відмова");
  assert.deepEqual(fs.readFileSync(file), bytes0, "байти без змін");
  assert.equal(fs.readFileSync(file + ".meta", "utf8"), meta0, "метадані без змін");
  const again = await x.store.put(m.active.key, bytes0, { contentType: "application/xml", metadata: { sha256: "інші-метадані" } });
  assert.equal(again.existed, true, "той самий вміст — повтор");
  assert.equal(fs.readFileSync(file + ".meta", "utf8"), meta0, "повтор не змінює метаданих");
  // Псевдонім (регістр): на NTFS / APFS — той самий файл → відмова; на регістрозалежній ФС — інший об'єкт, на який маніфест не вказує.
  const alias = m.active.key.replace(/T(\d\d)-/, "t$1-").replace(/Z-/, "z-");
  assert.notEqual(alias, m.active.key);
  await x.store.put(alias, "<broken/>", { contentType: "application/xml" }).catch((e) => assert.ok(["OBJECT_IMMUTABLE", "INVALID_KEY", "CC_KEY_SEALED"].includes(e.code), e.code));
  assert.deepEqual(fs.readFileSync(file), bytes0, "канонічні байти без змін після спроби через псевдонім");
  const r = await x.get("/feeds/main.xml");
  assert.equal(r.status, 200);
  assert.equal(sha(Buffer.from(await r.arrayBuffer())), m.active.storedSha256, "Worker віддає саме опубліковані байти");
});

for (const gzip of [false, true]) {
  test(`ENG-27 N2: маніфест містить storedSha256 = SHA-256 збережених байтів${gzip ? " (.xml.gz)" : ""}; для identity — дорівнює sha256 YML`, async () => {
    const x = await feedWorld({ gzip });
    assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
    await x.bump();
    assert.equal((await runUpdate(x.ctx(cc({ tag: "b" }), T0 + 60_000))).feeds[0].state, "PUBLISHED");
    const m = await x.store.getJson(manifestKey("main"));
    for (const e of [m.active, m.previous]) {
      assert.match(e.storedSha256, /^[0-9a-f]{64}$/);
      assert.equal(e.storedSha256, sha(await x.store.getBuffer(e.key)), "відбиток самих байтів");
      assert.equal(expectedStoredSha(e), e.storedSha256);
      assert.equal(await storedBytesOk(x.store, e), true);
      if (!gzip) assert.equal(e.storedSha256, e.sha256);
      else assert.notEqual(e.storedSha256, e.sha256, "gzip: байти ≠ YML");
    }
    // Worker віддає саме ці байти (відбиток збережених байтів, для gzip — архіву).
    const ext = gzip ? ".xml.gz" : ".xml";
    const r = await x.get("/feeds/main" + ext);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-feed-version"), "active");
    assert.equal(sha(Buffer.from(await r.arrayBuffer())), m.active.storedSha256);
    assert.equal((await x.get("/feeds/main" + ext, "HEAD")).status, 200);
  });
}

test("ENG-27 N2: маніфест до ENG-27 (без storedSha256) — identity Worker віддає (звірка за sha256 YML), gzip — 503 до нової публікації; нова публікація відновлює gzip", async () => {
  for (const gzip of [false, true]) {
    const x = await feedWorld({ gzip });
    assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
    const m = await x.store.getJson(manifestKey("main"));
    const strip = ({ storedSha256, ...e }) => e;
    await x.store.putJson(manifestKey("main"), { ...m, active: strip(m.active), ...(m.previous ? { previous: strip(m.previous) } : {}) });
    const ext = gzip ? ".xml.gz" : ".xml";
    const r = await x.get("/feeds/main" + ext);
    if (!gzip) {
      assert.equal(r.status, 200, "identity: сумісність за sha256");
      assert.equal(sha(Buffer.from(await r.arrayBuffer())), m.active.sha256);
    } else assert.equal(r.status, 503, "gzip без відбитка архіву — неперевірний (fail-closed)");
    await x.bump();
    assert.equal((await runUpdate(x.ctx(cc({ tag: "b" }), T0 + 60_000))).feeds[0].state, "PUBLISHED");
    assert.equal((await x.get("/feeds/main" + ext)).status, 200, "після нової публікації — обслуговується");
  }
});

test("ENG-27 N2: сумісність — запис без storedSha256: identity звіряється за sha256 YML; gzip — неперевірний (Worker не віддає, fail-closed)", () => {
  assert.equal(expectedStoredSha({ encoding: "identity", sha256: "a".repeat(64) }), "a".repeat(64));
  assert.equal(expectedStoredSha({ sha256: "a".repeat(64) }), "a".repeat(64));
  assert.equal(expectedStoredSha({ encoding: "gzip", sha256: "a".repeat(64) }), null);
  assert.equal(expectedStoredSha({ encoding: "gzip", sha256: "a".repeat(64), storedSha256: "b".repeat(64) }), "b".repeat(64));
  assert.equal(expectedStoredSha(null), null);
});

test("ENG-27 N2: «видалити й записати» активну версію з підробленими метаданими — Worker не віддає підмінених байтів (GET / HEAD), запасна — лише перевірена; publisher знімає з обслуговування; доказ публікації — unknown", async () => {
  const x = await feedWorld();
  assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
  await x.bump();
  assert.equal((await runUpdate(x.ctx(cc({ tag: "b" }), T0 + 60_000))).feeds[0].state, "PUBLISHED");
  const m = await x.store.getJson(manifestKey("main"));
  assert.equal(m.previousFallbackSafe, true);
  const forged = forgeSameLength(await x.store.getBuffer(m.active.key));
  await substitute(x.store, m.active, forged);
  const h = await x.store.head(m.active.key);
  assert.equal(h.size, m.active.storedBytes, "передумова: розмір той самий");
  assert.equal(h.metadata.sha256, m.active.sha256, "передумова: метадані підроблено");
  // Worker: лише байти з відбитком маніфесту — тут перевірена запасна (previous), не підміна.
  const g = await x.get("/feeds/main.xml");
  assert.equal(g.status, 200);
  assert.equal(g.headers.get("x-feed-version"), "previous");
  const body = Buffer.from(await g.arrayBuffer());
  assert.notEqual(sha(body), sha(forged), "підмінені байти не віддано");
  assert.equal(sha(body), m.previous.storedSha256);
  const hd = await x.get("/feeds/main.xml", "HEAD");
  assert.equal(hd.status, 200);
  assert.equal(hd.headers.get("x-feed-version"), "previous");
  // servedChain: метадані збігаються, байти — ні → «може обслуговуватися» (Worker до ENG-27), вміст неперевірений.
  const ch = await servedChain(x.store, "main");
  assert.equal(ch.links.active.metaOk, META_UNKNOWN);
  assert.equal(ch.links.active.xml, null);
  assert.equal(await readServedVersions(x.store, "main"), null, "доказ публікації неможливий");
  await assert.rejects(verifyStoredVersion(x.store, m.active), /Збережені байти версії не відповідають маніфесту/);
  // Наступний запуск зі збоєм постачальника: обслуговувана (можливо) версія неперевірена → зняття з обслуговування.
  await fsp.writeFile(x.supplierFile, "<broken>");
  const r = await runUpdate(x.ctx(cc({ tag: "b" }), T0 + 120_000));
  assert.equal(r.feeds[0].activeSafety, "UNSAFE");
  assert.ok((await x.store.getJson(manifestKey("main"))).withdrawn, "маніфест — знято з обслуговування");
  for (const method of ["GET", "HEAD"]) assert.equal((await x.get("/feeds/main.xml", method)).status, 503, method);
});

test("ENG-27 N2: підмінено й активну, й запасну — Worker 503 (жодних неперевірених байтів), а не 200", async () => {
  const x = await feedWorld();
  await runUpdate(x.ctx(cc()));
  await x.bump();
  await runUpdate(x.ctx(cc({ tag: "b" }), T0 + 60_000));
  const m = await x.store.getJson(manifestKey("main"));
  for (const e of [m.active, m.previous]) await substitute(x.store, e, forgeSameLength(await x.store.getBuffer(e.key)));
  for (const method of ["GET", "HEAD"]) assert.equal((await x.get("/feeds/main.xml", method)).status, 503, method);
});

test("ENG-27 N2: підміна з поверненням видаленого товару — Worker не віддає 200 з видаленим (YML тієї самої довжини з ID видаленого під ключем активної, підроблені метадані)", async () => {
  const x = await feedWorld();
  await runUpdate(x.ctx(cc()));
  const m1 = await x.store.getJson(manifestKey("main"));
  const old = await x.store.getBuffer(m1.active.key);
  const del = [...offersById(old.toString("utf8")).keys()][2];
  await x.bump();
  assert.equal((await runUpdate(x.ctx(cc({ removed: [del] }), T0 + 60_000))).feeds[0].state, "PUBLISHED");
  const m = await x.store.getJson(manifestKey("main"));
  assert.equal(offersById((await x.store.getBuffer(m.active.key)).toString("utf8")).has(del), false, "передумова: активна без видаленого");
  // Під ключем активної — YML тієї самої довжини, де ID іншого товару замінено на ID видаленого (як проба Hermes: Worker до ENG-27
  // перевіряв лише розмір і метадані → 200 з видаленим); метадані підроблено.
  const cur = (await x.store.getBuffer(m.active.key)).toString("utf8");
  const other = [...offersById(cur).keys()].find((id) => id !== del && id.length === del.length);
  const forged = Buffer.from(cur.replace(`<offer id="${other}"`, `<offer id="${del}"`));
  assert.equal(forged.length, m.active.storedBytes, "передумова: та сама довжина");
  assert.equal(offersById(forged.toString("utf8")).has(del), true, "передумова: підміна містить видалений товар");
  await substitute(x.store, m.active, forged);
  assert.ok(old.length > 0);
  for (const method of ["GET", "HEAD"]) {
    const r = await x.get("/feeds/main.xml", method);
    if (r.status === 200 && method === "GET") assert.equal(offersById(await r.text()).has(del), false, "видалений товар не повертається у 200");
    if (r.status === 200) assert.notEqual(r.headers.get("x-feed-version"), "active", method + ": підмінена активна не обслуговується");
  }
  const g = await x.get("/feeds/main.xml");
  assert.equal(g.status, 503, "запасна містить видалений (не запасна) — лишається 503, а не підміна");
});

test("ENG-27 N2: відкат до версії з підміненими байтами — відмова, маніфест без змін", async () => {
  const x = await feedWorld();
  await runUpdate(x.ctx(cc()));
  await x.bump();
  await runUpdate(x.ctx(cc({ tag: "b" }), T0 + 60_000));
  const m0 = await x.store.getJson(manifestKey("main"));
  await substitute(x.store, m0.previous, forgeSameLength(await x.store.getBuffer(m0.previous.key)));
  await assert.rejects(guardedRollback({ store: x.store, feed: "main", controls: cc({ tag: "b" }), coordinator: x.coordinator }));
  const m1 = await x.store.getJson(manifestKey("main"));
  assert.equal(m1.active.key, m0.active.key, "активна не перемкнута на підмінену");
  assert.equal(m1.active.storedSha256, m0.active.storedSha256);
});

// ================================================================ N3
const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();
const config = structuredClone(legacyConfig);

async function queueWorld() {
  const s = generateSynthetic({ products: 60, queue: 6, deferred: 2, newOffers: 4, seed: 11, now: NOW });
  const book = {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
  const sheets = new MemorySheets(book);
  const w = { s, book, sheets, readBook: async () => sheets.read(), xml: s.supplierXml() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: STAMP });
  assert.equal((await sync(w, w.xml)).state, "SYNCED");
  assert.equal((await intakeAll(w, w.xml, { session: "auto", stamp: STAMP, now: NOW, config, catalog: EMPTY_CATALOG })).state, "INTAKE_DONE");
  assert.ok(qRows(w).length >= 3, "передумова: у черзі є позиції");
  return w;
}
async function sync(w, xml) {
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  return syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config, now: NOW, catalog: EMPTY_CATALOG });
}
const qRows = (w) => readSheet(w.sheets.book[SHEET.queue], SHEET.queue).rows;
const qRow = (w, id) => qRows(w).find((r) => mtText(r["Offer ID"]) === id);
const qHeader = (w) => w.sheets.book[SHEET.queue][0].map(mtText);
const sheetRowOf = (w, id) => w.sheets.book[SHEET.queue].findIndex((r, i) => i > 0 && mtText(r[qHeader(w).indexOf("Offer ID")]) === id) + 1;
const setQ = (w, id, col, v) => w.sheets.humanSet(SHEET.queue, sheetRowOf(w, id), col, v);
const frozenHas = (w, id) => (w.sheets.book[SHEET.frozen] || []).some((r) => mtText(r[0]) === id);
const mainRows = (w) => readSheet(w.sheets.book[SHEET.main], SHEET.main).rows;
/** Оновити сирі дані постачальника для позиції черги (назва) — щоб sync мав що писати в цьому рядку. */
const renamed = (w, xml, id, name) => perturb.tag(xml, mtText(qRow(w, id)["ID постачальника"]), "name_ua", name);
function makeApprovable(w, id) {
  const groupId = w.sheets.book[SHEET.groups][1][0];
  for (const [k, v] of Object.entries({ "Назва UA": "SEO UA " + id, "Назва RU": "SEO RU " + id, "Опис UA": "<p>Опис</p>", "Опис RU": "<p>Описание</p>", "Група ID": groupId, "Категорія Prom ID": "123" })) setQ(w, id, k, v);
}
/** Перехоплення записів: блоки updateRanges, що торкаються аркуша черги. */
function captureQueueBlocks(w) {
  const blocks = [];
  const prev = w.sheets.beforeWrite;
  w.sheets.beforeWrite = async (op, args, self) => { if (op === "updateRanges") for (const b of args) if (b.title === SHEET.queue) blocks.push(b); if (prev) await prev(op, args, self); };
  return blocks;
}

test("ENG-27 N3 (точна проба Hermes): «ВІДХИЛИТИ» власника, поставлене під час запуску в рядку, який sync оновлює, — CONFLICT (не SYNCED), рішення не стерто, клітинки рядка не записано; наступний запуск виконує відхилення без видалення рядка", async () => {
  const w = await queueWorld();
  const id = mtText(qRows(w)[0]["Offer ID"]);
  const oldName = mtText(qRow(w, id)["Назва постачальника UA"]);
  const xml = renamed(w, w.xml, id, "Нова назва постачальника ENG-27");
  let injected = 0;
  const raw = w.sheets.updateRanges.bind(w.sheets);
  w.sheets.updateRanges = async (list) => { if (!injected && list.some((b) => b.title === SHEET.main)) { injected++; setQ(w, id, "Рішення", "ВІДХИЛИТИ"); } return raw(list); };
  const r = await sync(w, xml);
  w.sheets.updateRanges = raw;
  assert.equal(injected, 1);
  assert.equal(r.state, "CONFLICT_OWNER_EDIT", JSON.stringify(r).slice(0, 400));
  assert.ok(r.queueConflicts.some((c) => c.key === id), "конфлікт названо за Offer ID");
  assert.equal(mtText(qRow(w, id)["Рішення"]), "ВІДХИЛИТИ", "рішення власника збережено");
  assert.equal(mtText(qRow(w, id)["Назва постачальника UA"]), oldName, "клітинки конфліктного рядка не записано");
  assert.equal(frozenHas(w, id), false, "у цьому запуску не переміщено (рішення прочитано після плану)");
  assert.ok(w.sheets.book[SHEET.journal].some((e) => e[3] === "КОНФЛІКТ"), "конфлікт — у «Журналі»");
  // «ВІДХИЛИТИ» (текст проби) — не команда: наступний запуск лишає його й пояснює в «Перевірці», нічого не переміщує.
  const r1b = await sync(w, xml);
  assert.equal(r1b.stats.rejected, 0);
  assert.equal(mtText(qRow(w, id)["Рішення"]), "ВІДХИЛИТИ");
  assert.match(qRow(w, id)["Перевірка"], /невідоме «Рішення»/);
  // Власник ставить команду «ВІДХИЛЕНО»: відхилення за Offer ID; рядок і рішення лишаються (B6), повтор — ідемпотентний.
  setQ(w, id, "Рішення", DECISION.REJECT);
  const r2 = await sync(w, xml);
  assert.equal(r2.state, "SYNCED", JSON.stringify(r2).slice(0, 400));
  assert.equal(r2.stats.rejected, 1);
  assert.equal(frozenHas(w, id), true);
  assert.equal(mtText(qRow(w, id)["Рішення"]), DECISION.REJECT);
  assert.equal(r2.queueRemoval.state, "BLOCKED_B6");
  const r3 = await sync(w, xml);
  assert.equal(r3.stats.rejected, 0);
  assert.equal(w.sheets.book[SHEET.frozen].filter((x) => mtText(x[0]) === id).length, 1);
});

test("ENG-27 N3: затвердження — рішення змінено до перенесення → не перенесено, CONFLICT, паспорт і основний каталог без змін", async () => {
  const w = await queueWorld();
  const id = mtText(qRows(w)[0]["Offer ID"]);
  makeApprovable(w, id);
  setQ(w, id, "Рішення", DECISION.APPROVE);
  const mainBefore = mainRows(w).length, passBefore = readPassport(w.sheets.book[SHEET.passport]).count;
  let injected = 0;
  const raw = w.sheets.updateRanges.bind(w.sheets);
  w.sheets.updateRanges = async (list) => { if (!injected && list.some((b) => b.title === SHEET.main)) { injected++; setQ(w, id, "Рішення", ""); } return raw(list); };
  const r = await sync(w, w.xml);
  w.sheets.updateRanges = raw;
  assert.equal(injected, 1);
  assert.equal(r.state, "CONFLICT_OWNER_EDIT", JSON.stringify(r).slice(0, 400));
  assert.ok(r.queueConflicts.some((c) => c.key === id && /до запису/.test(c.phase)));
  assert.equal(r.stats.approved, 0);
  assert.equal(mainRows(w).length, mainBefore, "у основний каталог не перенесено");
  assert.ok(!mainRows(w).some((x) => mtText(x["Offer ID"]) === id));
  assert.equal(readPassport(w.sheets.book[SHEET.passport]).count, passBefore, "паспорт без приросту");
  assert.equal(mtText(qRow(w, id)["Рішення"]), "", "рішення власника (зняте) не відновлено");
});

test("ENG-27 N3: затвердження — рішення змінено одразу після перенесення → CONFLICT «після запису», нове рішення власника не стерто, рядок не видалено", async () => {
  const w = await queueWorld();
  const id = mtText(qRows(w)[0]["Offer ID"]);
  makeApprovable(w, id);
  setQ(w, id, "Рішення", DECISION.APPROVE);
  const qLen = w.sheets.book[SHEET.queue].length;
  const raw = w.sheets.appendRows.bind(w.sheets);
  let injected = 0;
  w.sheets.appendRows = async (t, rows) => { const res = await raw(t, rows); if (t === SHEET.main && !injected) { injected++; setQ(w, id, "Рішення", "ВІДХИЛИТИ"); } return res; };
  const r = await sync(w, w.xml);
  w.sheets.appendRows = raw;
  assert.equal(injected, 1);
  assert.equal(r.state, "CONFLICT_OWNER_EDIT", JSON.stringify(r).slice(0, 400));
  assert.ok(r.queueConflicts.some((c) => c.key === id && /після запису/.test(c.phase)));
  assert.ok(mainRows(w).some((x) => mtText(x["Offer ID"]) === id), "перенесення вже відбулося — про це звіт, не мовчання");
  assert.equal(mtText(qRow(w, id)["Рішення"]), "ВІДХИЛИТИ", "нове рішення власника не стерто");
  assert.equal(w.sheets.book[SHEET.queue].length, qLen, "рядок не видалено");
  assert.equal(frozenHas(w, id), false, "відхилення в цьому запуску не виконується");
});

test("ENG-27 N3: інваріанти — sync не змінює «Рішення» жодного рядка, 6 колонок B6 «?» і ручні колонки власника; не видаляє й не очищує рядків; черга пишеться лише поклітинково за ключем (без позиційного блоку й без колонки «Рішення»)", async () => {
  const w = await queueWorld();
  const ids = qRows(w).map((r) => mtText(r["Offer ID"]));
  const MANUAL = ["Запити UA", "Запити RU", "Група ID", "Група UA", "Група RU", "Категорія Prom ID", "Категорія Prom URL", "Виробник"];
  const hdr = qHeader(w);
  const present = [...UNDEFINED_B6_COLUMNS, ...MANUAL].filter((c) => hdr.includes(c));
  assert.ok(UNDEFINED_B6_COLUMNS.every((c) => hdr.includes(c)), "передумова: усі 6 колонок B6 є в черзі");
  ids.forEach((id, i) => { for (const c of present) setQ(w, id, c, `ВЛАСНИК ${c} ${i}`); });
  const decisions = ["ПЕРЕВІРЕНО", "SEO ПОСТАЧАЛЬНИКА", "якась нотатка власника", DECISION.APPROVE_NOT_DUP, "ПРИВ'ЯЗАТИ ДО 1"];
  ids.forEach((id, i) => setQ(w, id, "Рішення", decisions[i % decisions.length]));
  let xml = w.xml;
  for (const id of ids) xml = renamed(w, xml, id, "Оновлена назва " + id);
  const before = new Map(ids.map((id) => [id, { ...qRow(w, id) }]));
  const qLen = w.sheets.book[SHEET.queue].length;
  const mark = w.sheets.log.length;
  const blocks = captureQueueBlocks(w);
  const r = await sync(w, xml);
  w.sheets.beforeWrite = null;
  assert.ok(["SYNCED", "CONFLICT_OWNER_EDIT"].includes(r.state), JSON.stringify(r).slice(0, 400));
  for (const id of ids) {
    const now = qRow(w, id), was = before.get(id);
    assert.equal(mtText(now["Рішення"]), mtText(was["Рішення"]), id + ": «Рішення» не змінено");
    for (const c of present) assert.equal(mtText(now[c]), mtText(was[c]), `${id}: «${c}» не змінено`);
  }
  assert.equal(w.sheets.book[SHEET.queue].length, qLen, "кількість рядків черги та сама");
  assert.equal(w.sheets.log.slice(mark).filter((x) => x.op === "deleteRows").length, 0, "жодного видалення рядків");
  const dc = hdr.indexOf("Рішення") + 1;
  for (const b of blocks) {
    assert.equal(b.values.length, 1, "лише один рядок у блоці (поклітинково за ключем)");
    if (b.row === 1) continue; // заголовок (міграція колонок) — окремий запис
    assert.ok(!(b.col <= dc && dc < b.col + b.values[0].length), "блок не торкається колонки «Рішення»");
    for (const c of present) { const j = hdr.indexOf(c) + 1; assert.ok(!(b.col <= j && j < b.col + b.values[0].length), `блок не торкається «${c}»`); }
  }
});

test("ENG-27 N3: службова команда («ПЕРЕВІРЕНО») — sync рядок не оновлює (дані й SHA — ті, які бачив власник), «Журнал» — ОЧІКУЄ, звіт Worker — за фактично записаним; intake виконує й споживає команду", async () => {
  const w = await queueWorld();
  const id = mtText(qRows(w)[0]["Offer ID"]);
  setQ(w, id, "Назва UA", "Наше SEO власника"); // власне SEO: підтвердження прив'язане до даних, які бачив власник
  assert.equal((await sync(w, w.xml)).state, "SYNCED");
  setQ(w, id, "Рішення", "ПЕРЕВІРЕНО");
  const was = { ...qRow(w, id) };
  const sid = mtText(was["ID постачальника"]);
  const xml = renamed(w, w.xml, id, "Нові дані, яких власник не бачив");
  const expected = ackFor({ mainRows: [], queueRows: [was], deferredRows: [], frozenIds: new Set(), frozenFlag: new Set(), profile: "medium" });
  const r = await sync(w, xml);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 400));
  const now = qRow(w, id);
  assert.equal(mtText(now["Рішення"]), "ПЕРЕВІРЕНО");
  for (const c of ["Назва постачальника UA", "SHA даних постачальника", "Погоджено для SHA", "Перевірка"]) assert.equal(mtText(now[c]), mtText(was[c]), `«${c}» не змінено`);
  assert.ok(r.queueUpdate.skipped.some((x) => x.key === id && /службова команда/.test(x.reason)));
  assert.equal(r.stats.queueRaw.verified, 0, "план sync службових команд не виконує (окремий шар від пропуску рядка)");
  assert.ok(w.sheets.book[SHEET.journal].some((e) => e[3] === "ОЧІКУЄ"), "«Журнал»: команда чекає intake");
  assert.equal(r.ack.queue[sid], expected.queue[sid], "звіт Worker — відбиток рядка, який справді в черзі");
  // intake: команду виконано щодо даних, які бачив власник, і спожито (expect = команда); далі — нові дані → потрібна перевірка.
  const ir = await intakeAll(w, xml, { session: "auto", stamp: STAMP, now: NOW, config, catalog: EMPTY_CATALOG, ready: [] });
  assert.equal(ir.state, "INTAKE_DONE", JSON.stringify(ir).slice(0, 300));
  const after = qRow(w, id);
  assert.equal(mtText(after["Рішення"]), "", "intake спожив команду");
  assert.equal(mtText(after["Погоджено для SHA"]), mtText(was["SHA даних постачальника"]), "підтверджено саме те, що бачив власник");
  assert.equal(mtText(after["Назва постачальника UA"]), "Нові дані, яких власник не бачив");
  assert.notEqual(mtText(after["SHA даних постачальника"]), mtText(was["SHA даних постачальника"]));
  assert.match(after["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ/, "нові дані — знову потрібна перевірка");
});

test("ENG-27 N3: рядок черги, якого sync не записав (правка власника → CONFLICT), у звіті Worker — з прочитаними значеннями, не з запланованими", async () => {
  const w = await queueWorld();
  const id = mtText(qRows(w)[0]["Offer ID"]);
  const was = { ...qRow(w, id) };
  const sid = mtText(was["ID постачальника"]);
  const xml = renamed(w, w.xml, id, "Запланована назва");
  const expected = ackFor({ mainRows: [], queueRows: [was], deferredRows: [], frozenIds: new Set(), frozenFlag: new Set(), profile: "medium" });
  let injected = 0;
  const raw = w.sheets.updateRanges.bind(w.sheets);
  w.sheets.updateRanges = async (list) => { if (!injected && list.some((b) => b.title === SHEET.main)) { injected++; setQ(w, id, "Рішення", "нотатка власника"); } return raw(list); };
  const r = await sync(w, xml);
  w.sheets.updateRanges = raw;
  assert.equal(r.state, "CONFLICT_OWNER_EDIT");
  assert.equal(mtText(qRow(w, id)["Назва постачальника UA"]), mtText(was["Назва постачальника UA"]));
  assert.equal(r.ack.queue[sid], expected.queue[sid], "Worker не вважає рядок оновленим");
});

test("ENG-27 N3: відхилення — рішення «ВІДХИЛЕНО» знято до запису в «Заморожені ID» → не заморожено, CONFLICT, рішення власника не відновлено", async () => {
  const w = await queueWorld();
  const id = mtText(qRows(w)[0]["Offer ID"]);
  setQ(w, id, "Рішення", DECISION.REJECT);
  let injected = 0;
  const raw = w.sheets.updateRanges.bind(w.sheets);
  w.sheets.updateRanges = async (list) => { if (!injected && list.some((b) => b.title === SHEET.main)) { injected++; setQ(w, id, "Рішення", ""); } return raw(list); };
  const r = await sync(w, w.xml);
  w.sheets.updateRanges = raw;
  assert.equal(injected, 1);
  assert.equal(r.state, "CONFLICT_OWNER_EDIT", JSON.stringify(r).slice(0, 400));
  assert.ok(r.queueConflicts.some((c) => c.key === id && /відхилення, до запису/.test(c.phase)));
  assert.equal(r.stats.rejected, 0);
  assert.equal(frozenHas(w, id), false, "не заморожено за знятим рішенням");
  assert.equal(mtText(qRow(w, id)["Рішення"]), "");
});

test("ENG-27 N2: ті самі дані, а байти чинної версії підмінено (метадані підроблено) — не REUSE: нова версія опублікована, Worker віддає її перевірені байти", async () => {
  const x = await feedWorld();
  assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
  const m0 = await x.store.getJson(manifestKey("main"));
  await substitute(x.store, m0.active, forgeSameLength(await x.store.getBuffer(m0.active.key)));
  const r = await runUpdate(x.ctx(cc(), T0 + 60_000));
  assert.equal(r.feeds[0].state, "PUBLISHED", "підмінена версія не є чинною для повторного використання");
  const m1 = await x.store.getJson(manifestKey("main"));
  assert.notEqual(m1.active.key, m0.active.key);
  assert.equal(await storedBytesOk(x.store, m1.active), true);
  const g = await x.get("/feeds/main.xml");
  assert.equal(g.status, 200);
  assert.equal(sha(Buffer.from(await g.arrayBuffer())), m1.active.storedSha256);
});

test("ENG-27 N2: gzip з іншими байтами заголовка (MTIME) — той самий YML і розмір, але не ті байти, що в маніфесті: Worker їх не віддає, тож і доказ публікації — unknown (не «present»)", async () => {
  const x = await feedWorld({ gzip: true });
  assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
  const m = await x.store.getJson(manifestKey("main"));
  const gz = Buffer.from(await x.store.getBuffer(m.active.key));
  assert.equal(gz[0], 0x1f, "передумова: gzip");
  gz[4] ^= 0x01; // MTIME — вміст після розпакування той самий
  await substitute(x.store, m.active, gz);
  const ch = await servedChain(x.store, "main");
  assert.equal(ch.links.active.metaOk, META_UNKNOWN);
  assert.equal(ch.links.active.xml, null, "вміст — не з тих байтів, що обслуговуються за маніфестом");
  assert.equal(await readServedVersions(x.store, "main"), null, "доказ публікації неможливий");
  const r = await x.get("/feeds/main.xml.gz");
  assert.notEqual(r.status === 200 ? r.headers.get("x-feed-version") : "none", "active", "Worker не віддає байтів, яких немає в маніфесті");
});
