/** Три аркуші (рішення власника 29.10): «Основний каталог» ⇄ «Видалені товари» за станом Catalog Controls, через шлюз запису.
 *  Видалення: архів (повна картка, «ОЧІКУЄ ПІДТВЕРДЖЕННЯ») → видалення з каталогу за ключем зі знімком; повтор / збій / сортування;
 *  анти-повторне створення з фіду; фід — removed = tombstone CC ∪ архів (захист не залежить лише від CC); відновлення; підтвердження Prom. */
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { ARCHIVE_SHEET, REMOVAL, archiveHeader } from "../src/core/archive.mjs";
import { runArchiveMoves, markPublished } from "../src/pipeline/archive-run.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate } from "../src/pipeline/update.mjs";
import { readActiveXml } from "../src/publish/publisher.mjs";
import { offersById } from "../src/core/yml.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const NOW = Date.parse("2026-10-22T10:00:00Z"), STAMP = new Date(NOW).toISOString();
const cfg = () => { const c = structuredClone(baseConfig); c.ownerPriority = { enabled: true }; return c; };
// CC R6: у режимі пріоритету власника синхронізація вимагає достовірного стану CC (двійник: нічого не видалено, фільтр пропускає).
const OK_CC = Object.freeze({ held: new Set(), removed: new Set(), blocked: false, reasons: [], fingerprint: "fp-ok", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
async function world() {
  const s = generateSynthetic({ products: 30, queue: 2, deferred: 2, newOffers: 0, seed: 17, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const w = { s, sheets, read: async (n) => sheets.read(n), readAll: async () => sheets.read(), xml: s.supplierXml() };
  await mergeNew92({ sheets, readBook: w.readAll, stamp: STAMP });
  w.sync = async (xml = w.xml, controls = OK_CC) => syncSheet({ sheets, readBook: w.readAll, parsed: await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true }), fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config: cfg(), now: NOW, catalog: EMPTY_CATALOG, controls });
  assert.equal((await w.sync()).state, "SYNCED");
  w.gw = new WriteGateway({ sheets, read: w.read, store: new MemoryStore(), now: () => NOW });
  w.move = async (controls) => { const s2 = await w.gw.open({ writer: "sync" }); try { return await runArchiveMoves({ session: s2, read: w.read, controls, stamp: STAMP }); } finally { await s2.close(); } };
  return w;
}
const keys = (v) => v.slice(1).map((r) => mtText(r[0])).filter(Boolean);
const rowOf = (v, id) => v.find((r) => mtText(r[0]) === id);

test("Видалити товар: повна картка в архіві («ОЧІКУЄ ПУБЛІКАЦІЇ YML»), у каталозі зникла; решта каталогу байт-у-байт; повтор — без дублів", async () => {
  const w = await world();
  const main0 = structuredClone(w.sheets.book[SHEET.main]);
  const id = keys(main0)[4];
  const r = await w.move({ removed: new Set([id]), blocked: false });
  assert.equal(r.state, "OK", JSON.stringify(r));
  assert.deepEqual(r.archived, [id]);
  assert.deepEqual(r.pendingPublication, [id], "до публікації YML без товару — не «Завершено»");
  const main1 = w.sheets.book[SHEET.main], arch = w.sheets.book[ARCHIVE_SHEET];
  assert.ok(!keys(main1).includes(id));
  assert.deepEqual(arch[0], archiveHeader(main0[0]));
  const a = rowOf(arch, id), m = rowOf(main0, id);
  main0[0].forEach((h, j) => assert.equal(mtText(a[j]), mtText(m[j]), "архів зберігає «" + h + "»"));
  assert.equal(mtText(a[arch[0].indexOf("Статус видалення")]), REMOVAL.PENDING);
  for (const k of keys(main0).filter((k) => k !== id)) assert.deepEqual(rowOf(main1, k), rowOf(main0, k), "інший товар " + k);
  const r2 = await w.move({ removed: new Set([id]), blocked: false });
  assert.deepEqual([r2.archived, keys(w.sheets.book[ARCHIVE_SHEET])], [[], [id]], "повтор нічого не робить, дубля немає");
  assert.equal((await w.move({ removed: new Set([id]), blocked: true })).state, "BLOCKED", "стан CC недостовірний — перенесень немає");
});

test("Збій між дописуванням в архів і видаленням з каталогу — повтор завершує перехід; товар не губиться й не дублюється", async () => {
  const w = await world();
  const id = keys(w.sheets.book[SHEET.main])[2];
  w.sheets.armFault({ op: "deleteRows", mode: "reject" });
  const r1 = await w.move({ removed: new Set([id]) });
  assert.equal(r1.state, "INCOMPLETE");
  assert.ok(keys(w.sheets.book[SHEET.main]).includes(id) && keys(w.sheets.book[ARCHIVE_SHEET]).includes(id), "проміжний стан: в обох, нічого не втрачено");
  const r2 = await w.move({ removed: new Set([id]) });
  assert.equal(r2.state, "OK", JSON.stringify(r2));
  assert.ok(!keys(w.sheets.book[SHEET.main]).includes(id));
  assert.equal(keys(w.sheets.book[ARCHIVE_SHEET]).filter((k) => k === id).length, 1);
});

test("Сортування людиною між читанням і видаленням — чужий рядок виявлено й повернуто зі знімка (без втрат), NEEDS_DECISION", async () => {
  const w = await world();
  const before = keys(w.sheets.book[SHEET.main]), id = before[3];
  const snap = new Map(w.sheets.book[SHEET.main].slice(1).map((r) => [mtText(r[0]), r.map(mtText)]));
  let once = true;
  w.sheets.beforeWrite = (op) => { if (op === "deleteRows" && once) { once = false; w.sheets.humanSort(SHEET.main, "Offer ID", true); } };
  const r = await w.move({ removed: new Set([id]) });
  w.sheets.beforeWrite = null;
  assert.equal(r.state, "NEEDS_DECISION", JSON.stringify(r));
  const after = w.sheets.book[SHEET.main];
  for (const k of before.filter((k) => k !== id)) assert.deepEqual(rowOf(after, k).map(mtText), snap.get(k), "товар " + k + " на місці з тими самими даними");
  assert.equal(keys(after).filter((k) => k === id).length <= 1, true);
});

test("Власник змінив картку між архівуванням і видаленням — рядок НЕ видаляється (знімок не збігся), правка збережена, конфлікт у звіті", async () => {
  const w = await world();
  const id = keys(w.sheets.book[SHEET.main])[1];
  const rowNo = () => w.sheets.book[SHEET.main].findIndex((r) => mtText(r[0]) === id) + 1;
  let once = true;
  w.sheets.beforeWrite = (op) => { if (op === "appendRows" && once) { once = false; w.sheets.humanSet(SHEET.main, rowNo(), "Назва UA", "Правка власника в останню мить"); } };
  const r = await w.move({ removed: new Set([id]) });
  w.sheets.beforeWrite = null;
  assert.notEqual(r.state, "OK");
  assert.ok(r.conflicts.some((c) => c.id === id), JSON.stringify(r));
  const m = w.sheets.book[SHEET.main].find((x) => mtText(x[0]) === id);
  assert.equal(mtText(m[w.sheets.book[SHEET.main][0].indexOf("Назва UA")]), "Правка власника в останню мить", "рядок із правкою не видалено");
  const r2 = await w.move({ removed: new Set([id]) });
  assert.ok(r2.conflicts.some((c) => c.id === id && /змінено після архівування/.test(c.reason)), "повтор: розбіжність архіву й каталогу — рішення людини, без втрат");
});

test("Видалений товар постачальник і далі передає у фіді — синхронізація не повертає його ні в каталог, ні в «Нові товари»", async () => {
  const w = await world();
  const id = keys(w.sheets.book[SHEET.main])[5];
  await w.move({ removed: new Set([id]) });
  const r = await w.sync();
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 400));
  assert.ok(!keys(w.sheets.book[SHEET.main]).includes(id));
  assert.ok(!keys(w.sheets.book[SHEET.queue]).includes(id));
  assert.ok(r.ack.known.includes(id), "ID архіву — відомий для сторожа новинок");
});

test("Повернути з архіву — лише за дозволом CC: товар знову в каталозі з тими самими даними, з архіву прибрано; повтор — без дублів", async () => {
  const w = await world();
  const m0 = structuredClone(w.sheets.book[SHEET.main]), id = keys(m0)[6];
  await w.move({ removed: new Set([id]) });
  assert.equal((await w.move({ removed: new Set(), restore: new Set() })).restored.length, 0, "без дозволу — архів не чіпаємо");
  const r = await w.move({ removed: new Set(), restore: new Set([id]) });
  assert.deepEqual(r.restored, [id], JSON.stringify(r));
  const h = m0[0], got = rowOf(w.sheets.book[SHEET.main], id), exp = rowOf(m0, id);
  h.forEach((k, j) => assert.equal(mtText(got[j]), mtText(exp[j]), "відновлено «" + k + "»"));
  assert.ok(!keys(w.sheets.book[ARCHIVE_SHEET]).includes(id));
  await w.move({ removed: new Set(), restore: new Set([id]) });
  assert.equal(keys(w.sheets.book[SHEET.main]).filter((k) => k === id).length, 1);
});

test("Завершення видалення — лише за ОПУБЛІКОВАНИМ фідом без offer (без Prom): є в активній версії → «ОЧІКУЄ»; немає → «ЗАВЕРШЕНО»", async () => {
  const w = await world();
  const [a, b] = keys(w.sheets.book[SHEET.main]).slice(7, 9);
  await w.move({ removed: new Set([a, b]) });
  const s = await w.gw.open({ writer: "sync" });
  const xml = `<offers><offer id="${b}" available="false"><name>x</name></offer></offers>`; // активна версія ще містить b
  const cc = { removed: new Set([a, b]), blocked: false };
  const none = await markPublished({ session: s, read: w.read, activeXml: undefined, controls: cc, stamp: STAMP });
  const blockedR = await markPublished({ session: s, read: w.read, activeXml: "<offers/>", controls: { ...cc, blocked: true }, stamp: STAMP });
  const notCC = await markPublished({ session: s, read: w.read, activeXml: xml, controls: { removed: new Set([b]), blocked: false }, stamp: STAMP }); // a немає у фіді, але CC його не вважає видаленим
  const r = await markPublished({ session: s, read: w.read, activeXml: xml, controls: cc, stamp: STAMP });
  await s.close();
  assert.equal(none.done.length, 0, "немає опублікованої версії — нічого не завершено");
  assert.equal(blockedR.done.length, 0, "стан CC недостовірний — архів нічого не «завершує»");
  assert.deepEqual(notCC.done, [], "лише ID з рішенням CC: a без рішення CC не «завершується», b ще у фіді");
  assert.deepEqual(r.done, [a]);
  const arch = w.sheets.book[ARCHIVE_SHEET], c = arch[0].indexOf("Статус видалення");
  assert.equal(mtText(rowOf(arch, a)[c]), REMOVAL.DONE);
  assert.equal(mtText(rowOf(arch, b)[c]), REMOVAL.PENDING);
});

async function feedWorld() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-arch-"));
  const T0 = Date.parse("2026-10-21T06:00:00.000Z");
  const s = generateSynthetic({ products: 40, queue: 2, deferred: 2, newOffers: 0, seed: 23, now: T0 });
  const write = (sheets) => writeCatalogSnapshot(path.join(dir, "catalog"), { sheets, groups: s.groups });
  await write(s.sheets);
  await fsp.writeFile(path.join(dir, "supplier.xml"), s.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = structuredClone(baseConfig); config.supplier.minimumOffers = 10; config.ownerPriority = { enabled: true };
  const okCC = { state: async () => ({ held: new Set(), removed: new Set(), blocked: false, reasons: [], fingerprint: "fp-ok" }), verify: async () => ({ ok: true, reasons: [] }) };
  const ctx = (now, controls) => ({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(path.join(dir, "supplier.xml")), now: () => now, tmpDir: dir, controls: controls ?? okCC });
  await runUpdate(ctx(T0));
  const xml0 = (await readActiveXml(store, "main")).xml;
  const id = [...offersById(xml0)].find(([, o]) => /available="true"/.test(o.slice(0, 200)))[0];
  const sheets = structuredClone(s.sheets);
  const mh = sheets["Основний каталог"][0], row = sheets["Основний каталог"].find((r) => String(r[0]) === id);
  sheets["Основний каталог"] = sheets["Основний каталог"].filter((r) => r !== row);
  sheets[ARCHIVE_SHEET] = [archiveHeader(mh.map(String)), [...row, STAMP, "op-test", REMOVAL.PENDING, ""]];
  await write(sheets);
  return { store, ctx, id, T0 };
}

test("Фід: видалений (є в архіві, CC ще без tombstone) — архів лише ДОДАЄ виключення: жодного offer; старий не повертається", async () => {
  const { store, ctx, id, T0 } = await feedWorld();
  const r1 = await runUpdate(ctx(T0 + 60_000));
  assert.equal(r1.feeds[0].state, "PUBLISHED", JSON.stringify(r1.feeds[0]));
  assert.equal(offersById((await readActiveXml(store, "main")).xml).has(id), false);
});

test("Рішення CC авторитетне: контрольна точка недостовірна (blocked) — архів її НЕ обходить: нового «успішного» фіду немає", async () => {
  const { store, ctx, T0 } = await feedWorld();
  const m0 = await store.getJson("feeds/main/manifest.json");
  const blocked = { state: async () => ({ held: new Set(), removed: new Set(), blocked: true, reasons: ["контрольна точка пошкоджена"], fingerprint: "x" }), verify: async () => ({ ok: false, reasons: ["blocked"] }) };
  const r = await runUpdate(ctx(T0 + 60_000, blocked));
  assert.equal(r.feeds[0].state, "BLOCKED_CC");
  // ENG-17 (Hermes ENG15-P1a / I17): ні нової версії, ні REUSED як успіху; безпечність чинної неможливо довести → знято з обслуговування.
  const m1 = await store.getJson("feeds/main/manifest.json");
  assert.equal(m1.active.key, m0.active.key, "активна версія та сама");
  assert.ok(m1.withdrawn, "знято з обслуговування (Worker 503)");
  assert.equal(r.feeds[0].activeSafety, "UNVERIFIED");
});
