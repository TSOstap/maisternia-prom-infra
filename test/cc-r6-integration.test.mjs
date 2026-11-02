/** CC R6 → Engineering: сім залежностей (CC-R6-CONTRACT-for-Engineering §8 пп. 1–7), двійники форми controlsState.
 *  1 S5 — фільтр повторного створення в intake / затвердженні / прив'язках; blocked → новинок не приймати.
 *  2 Ручний відкат — лише зі свіжим достовірним станом CC (бібліотека й CLI).
 *  3 Робочі точки запуску — лише пріоритет власника (паспорт — аудит; видалення не зупиняє фід).
 *  4 renderProbe «cc-publisher-v2» — тим самим шляхом, що робочий фід.
 *  5 publication і integrity (M3 cardVerdict) для CC.
 *  6 Правило 5 — видалений не оновлюється синхронізацією до перенесення; рядки архіву — ніколи.
 *  7 W2 / S1 — робочий запис лише через шлюз (оренда, журнал, fencing). Справжній CC R6 — окрема композиційна проба (ENG-13). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { mtText } from "../src/core/text.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { SHEET, DECISION, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { ARCHIVE_SHEET } from "../src/core/archive.mjs";
import { runArchiveMoves } from "../src/pipeline/archive-run.mjs";
import { EMPTY_CATALOG, intakeAll } from "./helpers/intake.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate, guardedRollback } from "../src/pipeline/update.mjs";
import { manifestKey, readActiveXml, rollbackFeed } from "../src/publish/publisher.mjs";
import { offersById } from "../src/core/yml.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { STATE_COLUMN } from "../src/core/field-control.mjs";
import { cardVerdict, systemHash, SYSTEM_HASH_COLUMNS, OWNER_EDITABLE_COLUMNS } from "../src/core/owner-priority.mjs";
import { publicationFrom, catalogControlsAdapter, controlsFromState } from "../src/pipeline/controls-adapter.mjs";
import { ccPublisher, CC_PUBLISHER_CONTRACT } from "../src/pipeline/cc-publisher.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import { YML_HEADERS, SEAL_COLUMN, rowSeal, approvalManifest } from "../src/core/seal.mjs";
import { mtPrices, DEFAULT_PRICING } from "../src/core/pricing.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-10-22T10:00:00Z"), STAMP = new Date(NOW).toISOString();
const cfg = () => { const c = structuredClone(baseConfig); c.ownerPriority = { enabled: true }; return c; };
const NONE = { blocked: false, kind: "NONE" };
/** Двійник адаптера CC (форма controlsFromState): removed — tombstoned; gate — за ID постачальника; verify — за відбитком. */
const ccTwin = ({ removed = [], blocked = false, gate = {}, verifyOk = true } = {}) => {
  const fingerprint = "fp:" + JSON.stringify([removed, blocked, Object.keys(gate)]);
  const st = { held: new Set(removed), removed: new Set(removed), tombstoned: new Map(removed.map((id) => [id, { stage: "REGISTERED" }])), blocked, reasons: blocked ? ["точка недійсна"] : [], fingerprint,
    gate: { check: (o) => gate[mtText(o?.id)] || NONE } };
  return { state: async () => st, verify: async (fp) => (verifyOk && fp === fingerprint ? { ok: true, reasons: [] } : { ok: false, reasons: ["відбиток змінився"] }) };
};
const OK_CC = ccTwin();

async function world({ products = 30, newOffers = 0, queue = 2, seed = 17 } = {}) {
  const s = generateSynthetic({ products, queue, deferred: 2, newOffers, seed, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const w = { s, sheets, readBook: async () => sheets.read(), read: async (n) => sheets.read(n), xml: s.supplierXml() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: STAMP });
  w.sync = async (xml = w.xml, controls = OK_CC, extra = {}) => syncSheet({ sheets, readBook: w.readBook, parsed: await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true }), fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config: cfg(), now: NOW, catalog: EMPTY_CATALOG, controls, ...extra });
  assert.equal((await w.sync()).state, "SYNCED"); // міграція станів полів
  return w;
}
const mainRows = (w) => readSheet(w.sheets.book[SHEET.main], SHEET.main).rows;
const rowById = (w, id) => w.sheets.book[SHEET.main].find((r) => mtText(r[0]) === id);

// ---------- 6. Правило 5 ----------
test("Правило 5: видалений (tombstone CC), рядок ще в каталозі — синхронізація не змінює жодної клітинки; сусід оновлюється", async () => {
  const w = await world();
  const [del, other] = mainRows(w).slice(3, 5);
  const delId = mtText(del["Offer ID"]), otherId = mtText(other["Offer ID"]);
  let xml = w.xml;
  for (const r of [del, other]) {
    const sid = mtText(r["ID постачальника"]);
    xml = perturb.tag(xml, sid, "price", String(Number(r["Ціна постачальника"]) + 77));
    xml = perturb.tag(xml, sid, "name_ua", "Перейменовано постачальником " + sid);
  }
  const before = structuredClone(rowById(w, delId));
  const otherBefore = structuredClone(rowById(w, otherId));
  const r = await w.sync(xml, ccTwin({ removed: [delId] }));
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 400));
  assert.deepEqual(rowById(w, delId), before, "рядок видаленого — байт-у-байт (ні цін, ні назви постачальника, ні стану)");
  assert.notDeepEqual(rowById(w, otherId), otherBefore, "сусід оновлено (не блокує інших — правило 7)");
  assert.equal(r.ownerPriority.removedInMain, 1);
  assert.ok(w.sheets.book[SHEET.journal].some((e) => mtText(e[2]) === delId && /ВИДАЛЕНО \(рішення Catalog Controls\)/.test(mtText(e[6]))), "причина в «Журналі»");
});

test("Правило 5: рядок «Видалених товарів» синхронізація не оновлює ніколи; товар не повертається в каталог / чергу", async () => {
  const w = await world();
  const del = mainRows(w)[6], delId = mtText(del["Offer ID"]), sid = mtText(del["ID постачальника"]);
  const gw = new WriteGateway({ sheets: w.sheets, read: w.read, store: new MemoryStore(), now: () => NOW });
  const s = await gw.open({ writer: "sync" });
  try { assert.equal((await runArchiveMoves({ session: s, read: w.read, controls: { removed: new Set([delId]), blocked: false }, stamp: STAMP })).state, "OK"); } finally { await s.close(); }
  const arch = structuredClone(w.sheets.book[ARCHIVE_SHEET]);
  const xml = perturb.tag(perturb.tag(w.xml, sid, "price", "99999"), sid, "name_ua", "Інша назва");
  assert.equal((await w.sync(xml, ccTwin({ removed: [delId] }))).state, "SYNCED");
  assert.deepEqual(w.sheets.book[ARCHIVE_SHEET], arch, "архів — без жодної зміни");
  assert.ok(!w.sheets.book[SHEET.main].some((r) => mtText(r[0]) === delId), "не повернувся в каталог");
  assert.ok(!w.sheets.book[SHEET.queue].some((r) => r.map(mtText).includes(sid)), "не потрапив у «Нові товари»");
});

test("Правило 5: рішення про видалення під час запуску (відбиток CC змінився до запису) — нічого не записано; CC blocked — ABORTED", async () => {
  const w = await world();
  const before = structuredClone(w.sheets.book[SHEET.main]);
  const xml = perturb.tag(w.xml, mtText(mainRows(w)[2]["ID постачальника"]), "price", "12345");
  const r1 = await w.sync(xml, ccTwin({ verifyOk: false }));
  assert.equal(r1.state, "SKIPPED_CONCURRENT_EDIT", JSON.stringify(r1).slice(0, 300));
  assert.match(r1.reason, /Catalog Controls змінився/);
  assert.deepEqual(w.sheets.book[SHEET.main], before);
  const r2 = await w.sync(xml, ccTwin({ blocked: true }));
  assert.equal(r2.state, "ABORTED");
  assert.match(r2.reason, /Catalog Controls недостовірний/);
  const r3 = await w.sync(xml, null);
  assert.equal(r3.state, "ABORTED", "без CC у режимі пріоритету власника — нічого не пишемо");
  assert.deepEqual(w.sheets.book[SHEET.main], before, "каталог не змінено");
});

test("Правило 5: прив'язка позиції черги до видаленого товару — відмова, картка не змінюється", async () => {
  const w = await newcomers();
  await intakeAll(w, w.xml, { session: "auto", stamp: STAMP, now: NOW, config: cfg(), catalog: EMPTY_CATALOG, controls: OK_CC });
  const delId = mtText(mainRows(w)[1]["Offer ID"]);
  const q = w.sheets.book[SHEET.queue], qh = q[0].map(mtText);
  q[1][qh.indexOf("Рішення")] = `ПРИВ'ЯЗАТИ ДО ${delId}`;
  const before = structuredClone(rowById(w, delId));
  const r = await w.sync(w.xml, ccTwin({ removed: [delId] }));
  assert.equal(r.state, "SYNCED");
  assert.deepEqual(rowById(w, delId), before);
  assert.match(mtText(w.sheets.book[SHEET.queue].find((x) => mtText(x[qh.indexOf("Рішення")]).includes(delId))?.[qh.indexOf("Перевірка")]), /видалено \(Catalog Controls\)/);
});

// ---------- 1. S5 ----------
async function newcomers(seed = 29) {
  const w = await world({ queue: 0, newOffers: 3, seed });
  const known = new Set(mainRows(w).map((r) => mtText(r["ID постачальника"])));
  const parsed = await parseSupplierText(w.xml, { maximumChars: 45_000_000, identityFields: true });
  w.fresh = [...parsed.offers.keys()].filter((id) => !known.has(id)).sort();
  assert.equal(w.fresh.length, 3);
  return w;
}
test("S5 intake: той самий видалений товар під новим ID / конфлікт ID — не додається; схожий — додається з позначкою; результат — Worker", async () => {
  const w = await newcomers();
  const [a, b, c] = w.fresh;
  const controls = ccTwin({ removed: ["9000000001"], gate: { [a]: { blocked: true, kind: "EXCLUDED_NEW_ID", reason: `схоже, це видалений товар 9000000001 під новим ID ${a}` }, [b]: { blocked: false, kind: "SIMILAR_TO_EXCLUDED", reason: "схожий на видалений товар 9000000001 — лише позначка" } } });
  const r = await intakeAll(w, w.xml, { session: "auto", stamp: STAMP, now: NOW, config: cfg(), catalog: EMPTY_CATALOG, controls });
  assert.equal(r.state, "INTAKE_DONE", JSON.stringify(r).slice(0, 300));
  const q = w.sheets.book[SHEET.queue], qh = q[0].map(mtText), ids = q.slice(1).map((x) => mtText(x[qh.indexOf("ID постачальника")]));
  assert.ok(!ids.includes(a), "EXCLUDED_NEW_ID — не в черзі");
  assert.ok(ids.includes(b) && ids.includes(c), "схожий і звичайний — у черзі (не хибне зіставлення різних моделей)");
  assert.match(mtText(q.find((x) => mtText(x[qh.indexOf("ID постачальника")]) === b)[qh.indexOf("Перевірка")]), /СХОЖИЙ НА ВИДАЛЕНИЙ/);
  assert.doesNotMatch(mtText(q.find((x) => mtText(x[qh.indexOf("ID постачальника")]) === c)[qh.indexOf("Перевірка")]), /ВИДАЛЕН/);
  assert.equal(r.ack.results[a].status, "ВИДАЛЕНИЙ ТОВАР");
  assert.ok(r.ack.known.includes("9000000001"), "«Сторож новинок»: видалений ID — відомий, не пропонується");
});
test("S5 intake: видалений (tombstone CC), рядка немає в жодному аркуші (архівний рядок стерто вручну) — не повертається як новинка", async () => {
  const w = await newcomers();
  const [a] = w.fresh;
  const r = await intakeAll(w, w.xml, { session: "auto", stamp: STAMP, now: NOW, config: cfg(), catalog: EMPTY_CATALOG, controls: ccTwin({ removed: [a] }) });
  assert.equal(r.state, "INTAKE_DONE");
  const q = w.sheets.book[SHEET.queue], qh = q[0].map(mtText);
  assert.ok(!q.slice(1).some((x) => mtText(x[qh.indexOf("ID постачальника")]) === a), "реєстр CC тримає видалення без рядка аркуша");
  assert.equal(r.ack.results[a].status, "ВИДАЛЕНИЙ ТОВАР");
});
test("S5 intake: стан CC blocked / не підключено — новинок не приймати, черга без змін", async () => {
  const w = await newcomers();
  const q0 = structuredClone(w.sheets.book[SHEET.queue]);
  for (const controls of [ccTwin({ blocked: true }), null]) {
    const r = await intakeAll(w, w.xml, { session: "auto", stamp: STAMP, now: NOW, config: cfg(), catalog: EMPTY_CATALOG, controls });
    assert.equal(r.state, "ABORTED");
    assert.deepEqual(w.sheets.book[SHEET.queue], q0);
  }
});
async function approveWorld(gate, decision) {
  const w = await newcomers(31);
  await intakeAll(w, w.xml, { session: "auto", stamp: STAMP, now: NOW, config: cfg(), catalog: EMPTY_CATALOG, controls: OK_CC });
  const q = w.sheets.book[SHEET.queue], qh = q[0].map(mtText);
  const gv = w.sheets.book[SHEET.groups], gid = mtText(gv[1][gv[0].map(mtText).indexOf("Ідентифікатор_групи")]);
  for (const r of q.slice(1)) {
    r[qh.indexOf("Опис UA")] = "<p>Опис власника</p>"; r[qh.indexOf("Опис RU")] = "<p>Описание</p>";
    r[qh.indexOf("Група ID")] = gid; r[qh.indexOf("Категорія Prom ID")] = "410402"; r[qh.indexOf("Рішення")] = decision;
  }
  const r = await w.sync(w.xml, ccTwin({ gate }));
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 300));
  w.inMain = (sid) => mainRows(w).some((x) => mtText(x["ID постачальника"]) === sid);
  w.note = (sid) => mtText(w.sheets.book[SHEET.queue].find((x) => mtText(x[qh.indexOf("ID постачальника")]) === sid)?.[qh.indexOf("Перевірка")]);
  return w;
}
test("S5 затвердження: видалений під новим ID — не переноситься (причина в «Перевірці»); схожий — лише з «НЕ ДУБЛЬ»", async () => {
  const probe = await newcomers(31);
  const [a, b, c] = probe.fresh;
  const gate = { [a]: { blocked: true, kind: "ID_REUSE_CONFLICT", reason: `ID ${a} належить видаленому товару, фізично інший — ручна перевірка` }, [b]: { blocked: false, kind: "SIMILAR_TO_EXCLUDED", reason: "схожий на видалений товар 9000000002" } };
  const notDup = await approveWorld(gate, DECISION.APPROVE_NOT_DUP);
  assert.ok(!notDup.inMain(a), "ID_REUSE_CONFLICT — не затверджено навіть із «НЕ ДУБЛЬ»");
  assert.match(notDup.note(a), /НЕ ПЕРЕНЕСЕНО: .*видаленому товару/);
  assert.ok(notDup.inMain(b) && notDup.inMain(c), "схожий + «НЕ ДУБЛЬ» і звичайний — затверджено");
  const plainCtl = await approveWorld({}, DECISION.APPROVE);
  const plain = await approveWorld({ [c]: gate[b] }, DECISION.APPROVE);
  assert.ok(plainCtl.inMain(c), "контроль: без позначки CC звичайне «ЗАТВЕРДИТИ» переносить");
  assert.ok(!plain.inMain(c), "схожий на видалений — звичайне «ЗАТВЕРДИТИ» не переносить (як можливий дубль)");
  assert.match(plain.note(c), /СХОЖИЙ НА ВИДАЛЕНИЙ/);
});

// ---------- 5. integrity (M3) і publication ----------
test("M3 cardVerdict: після синхронізації — OK; правка назви — OWNER_EDIT; ідентичність / службові — CORRUPT; без стану / sysh — UNVERIFIED", async () => {
  const w = await world();
  const rows = mainRows(w);
  assert.ok(rows.every((r) => cardVerdict(r).verdict === "OK"), "усі картки після запису системи — OK");
  assert.ok(rows.every((r) => JSON.parse(r[STATE_COLUMN]).sysh === systemHash(r)), "стан містить sysh");
  const reseal = (r) => r; // печатку НЕ перераховуємо — так робить людина в аркуші
  const edit = (k, v) => { const r = { ...rows[3] }; r[k] = v; return reseal(r); };
  assert.equal(cardVerdict(edit("Назва UA", "Наша назва")).verdict, "OWNER_EDIT");
  assert.equal(cardVerdict(edit("Код товару Prom", "МІЙ-1")).verdict, "OWNER_EDIT");
  assert.equal(cardVerdict(edit("Артикул постачальника", "ІНШИЙ")).verdict, "CORRUPT");
  assert.equal(cardVerdict(edit("URL постачальника", "https://x/p1.html")).verdict, "CORRUPT");
  assert.equal(cardVerdict(edit("ID постачальника", "1")).verdict, "CORRUPT");
  assert.equal(cardVerdict(edit("Offer ID", "")).verdict, "CORRUPT");
  assert.equal(cardVerdict({ ...edit("Назва UA", "x"), [STATE_COLUMN]: "" }).verdict, "UNVERIFIED");
  const noSysh = JSON.parse(rows[3][STATE_COLUMN]); delete noSysh.sysh;
  assert.equal(cardVerdict({ ...edit("Назва UA", "x"), [STATE_COLUMN]: JSON.stringify(noSysh) }).verdict, "UNVERIFIED");
  assert.equal(cardVerdict({ ...edit("Назва UA", "x"), [STATE_COLUMN]: "{зламано" }).verdict, "CORRUPT");
  assert.equal(SYSTEM_HASH_COLUMNS.filter((k) => OWNER_EDITABLE_COLUMNS.includes(k)).length, 0);
  for (const k of ["Offer ID", "ID постачальника", "Артикул постачальника", "Назва постачальника UA", "Назва постачальника RU", "URL постачальника"]) assert.ok(SYSTEM_HASH_COLUMNS.includes(k), k);
});
test("M3 після запису системи: постачальник змінив ідентичність (назву постачальника) — sync оновив і стан, вердикт OK", async () => {
  const w = await world();
  const r0 = mainRows(w)[5], sid = mtText(r0["ID постачальника"]);
  assert.equal((await w.sync(perturb.tag(w.xml, sid, "name_ua", "Нова назва постачальника"))).state, "SYNCED");
  const r1 = mainRows(w).find((r) => mtText(r["ID постачальника"]) === sid);
  assert.equal(mtText(r1["Назва постачальника UA"]), "Нова назва постачальника");
  assert.equal(cardVerdict(r1).verdict, "OK");
});
test("publication: present / absent лише за прочитаними активними версіями всіх фідів; інакше unknown", () => {
  const x1 = '<offers><offer id="1" available="true"></offer></offers>', x2 = '<offers><offer id="2" available="false"></offer></offers>';
  const p = publicationFrom([x1, x2], ["1", "2", "3"]);
  assert.deepEqual([...p].map(([k, v]) => k + ":" + v.feed), ["1:present", "2:present", "3:absent"]);
  assert.ok([...publicationFrom([x1, null], ["1", "3"]).values()].every((v) => v.feed === "unknown"), "один фід не прочитано — не доказ");
  assert.ok([...publicationFrom([], ["1"]).values()].every((v) => v.feed === "unknown"));
});
test("Адаптер CC: integrity (M3) і publication передаються в controlsState і verifyControlsSnapshot однаково", async () => {
  const calls = [];
  const book = { [SHEET.main]: [["Offer ID"], ["11"], ["12"]], [ARCHIVE_SHEET]: [["Offer ID"], ["13"]] };
  const api = {
    controlsState: (b, ctx) => { calls.push(["state", ctx]); return { held: new Set(), tombstoned: new Map([["13", {}]]), blocked: false, reasons: [], fingerprint: "f" }; },
    verifyControlsSnapshot: (b, ctx, fp) => { calls.push(["verify", ctx]); return { ok: fp === "f", reasons: [] }; },
  };
  const a = catalogControlsAdapter({ loadBook: async () => book, store: new MemoryStore(), contract: { activated: true }, api, activeXmls: async () => ['<offer id="11" available="true"></offer>'] });
  const st = await a.state();
  assert.deepEqual([...st.removed], ["13"]);
  assert.equal((await a.verify("f")).ok, true);
  for (const [, ctx] of calls) {
    assert.equal(typeof ctx.integrity.cardVerdict, "function");
    assert.deepEqual(Object.fromEntries([...ctx.publication].map(([k, v]) => [k, v.feed])), { 11: "present", 12: "absent", 13: "absent" });
  }
  assert.equal(controlsFromState({ held: new Set(), tombstoned: new Map() }).blocked, true, "без явного blocked:false — fail-closed");
});

// ---------- 4. renderProbe ----------
function probeInputs() {
  const t = "2026-01-01T00:00:00.000Z", p = mtPrices(100, true, DEFAULT_PRICING);
  const card = (id, n) => {
    const row = Object.fromEntries(YML_HEADERS.map((k) => [k, ""]));
    Object.assign(row, { "Offer ID": id, "ID постачальника": id, "Артикул постачальника": `P-${n}`, "Назва UA": `Перевірка ${n}`, "Назва RU": `Проверка ${n}`,
      "Ціна постачальника": 100, "Ціна": p.base, "Ціна кінцева": p.final, "Знижка": p.discount, "Наявність": "+", "Стан синхронізації": "ЗІСТАВЛЕНО", "Оновлено": t, "Валюта": "UAH",
      "Опис UA": "<p>Перевірка</p>", "Опис RU": "<p>Проверка</p>", "Фото JSON": JSON.stringify([`https://images.prom.ua/${n}_p.jpg`]), "Характеристики JSON": "[]", "Група ID": "990001",
      "Група UA": "Перевірка", "Група RU": "Проверка", "Категорія Prom ID": "1", "Назва постачальника UA": `Перевірка ${n}`, "Назва постачальника RU": `Проверка ${n}`,
      "URL постачальника": `https://market-tools.com.ua/p${id}-p.html`, "Статус імпорту": "ДОЗВОЛЕНО", "Поля Prom JSON": "{}" });
    row[SEAL_COLUMN] = rowSeal(row);
    return row;
  };
  const rows = [card("9999999990", 1), card("9999999991", 2)];
  const groups = [{ "Ідентифікатор_групи": "990001", "Назва_групи_укр": "Перевірка", "Назва_групи": "Проверка", "Ідентифікатор_батьківської_групи": "" }];
  return { rows, groups, manifest: approvalManifest(rows, groups), meta: { syncState: "OK", lastSuccess: t, now: "2026-01-01T00:01:00.000Z" }, config: { maximumSyncAgeHours: 12, shopName: "Перевірка", company: "Перевірка", timeZone: "Europe/Kyiv" } };
}
const probeState = (held, blocked, removed = []) => ({ held: new Set([...held, ...removed]), tombstoned: new Map(removed.map((id) => [id, { stage: "REGISTERED" }])), blocked, reasons: blocked ? ["перевірка"] : [], fingerprint: "probe" });
test("renderProbe cc-publisher-v2: знятий — false; без зняття — true; видалений — без offer, сусід — true; blocked — виняток", async () => {
  const pub = ccPublisher({ config: baseConfig });
  assert.equal(pub.contract, CC_PUBLISHER_CONTRACT);
  const av = (xml, id) => new RegExp(`<offer id="${id}"[^>]*available="(true|false)"`).exec(xml)?.[1] || "";
  assert.equal(av(await pub.renderProbe({ ...probeInputs(), ccState: probeState(["9999999990"], false) }), "9999999990"), "false");
  assert.equal(av(await pub.renderProbe({ ...probeInputs(), ccState: probeState([], false) }), "9999999990"), "true");
  const removed = await pub.renderProbe({ ...probeInputs(), ccState: probeState([], false, ["9999999990"]) });
  assert.ok(!/<offer id="9999999990"[\s>]/.test(removed), "видалений — жодного offer");
  assert.equal(av(removed, "9999999991"), "true");
  await assert.rejects(pub.renderProbe({ ...probeInputs(), ccState: probeState([], true) }), /blocked/);
  // Паспорт — аудит (пріоритет власника): відсутній у рядках товар не зупиняє формування.
  const inp = probeInputs();
  assert.equal(av(await pub.renderProbe({ ...inp, rows: inp.rows.slice(1), ccState: probeState([], false) }), "9999999991"), "true");
});

// ---------- 2. Ручний відкат ----------
async function feedWorld() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-cc-r6-"));
  const s = generateSynthetic({ products: 40, queue: 2, deferred: 2, newOffers: 0, seed: 7, now: Date.parse("2026-10-21T06:00:00.000Z") });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  const supplierFile = path.join(dir, "supplier.xml");
  await fsp.writeFile(supplierFile, s.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = productionConfig(structuredClone(baseConfig));
  config.supplier.minimumOffers = 10;
  const T0 = Date.parse("2026-10-21T06:00:00.000Z");
  // ENG-17: робочий режим (w2.required) — перемикання маніфестів лише під орендою координатора W2.
  const coordinator = createCommitter({ store: new MemoryStore() });
  const ctx = (controls, now = T0) => ({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(supplierFile), now: () => now, tmpDir: dir, coordinator, ...(controls ? { controls } : {}) });
  return { dir, s, store, config, ctx, T0, coordinator };
}
test("Відкат: без стану CC — відмова (бібліотека); blocked — відмова; версія з видаленим — відмова; зміна стану до перемикання — відмова; чиста — так", async () => {
  const { store, ctx, s, T0, coordinator } = await feedWorld();
  assert.equal((await runUpdate(ctx(OK_CC))).feeds[0].state, "PUBLISHED");
  const xml1 = (await readActiveXml(store, "main")).xml;
  const del = [...offersById(xml1).keys()][2];
  const r2 = await runUpdate(ctx(ccTwin({ removed: [del] }), T0 + 3600_000));
  assert.equal(r2.feeds[0].state, "PUBLISHED", JSON.stringify(r2.feeds[0]));
  const m0 = await store.getJson(manifestKey("main"));
  await assert.rejects(rollbackFeed(store, "main"), /без перевірки стану Catalog Controls/);
  await assert.rejects(guardedRollback({ store, feed: "main", controls: null, coordinator }), /не підключено/);
  await assert.rejects(guardedRollback({ store, feed: "main", controls: OK_CC }), /без координатора W2/);
  await assert.rejects(guardedRollback({ store, feed: "main", controls: ccTwin({ blocked: true }), coordinator }), /недостовірний/);
  await assert.rejects(guardedRollback({ store, feed: "main", controls: ccTwin({ removed: [del] }), coordinator }), /видалений товар у фіді/);
  await assert.rejects(guardedRollback({ store, feed: "main", controls: ccTwin({ verifyOk: false }), coordinator }), /змінився/);
  // ENG-20 (B): відмови після отримання оренди лишають лише мітку епохи fencing (fence) — обслуговування (active / previous / прапорці) те саме.
  const serving = ({ fence: _f, ...m } = {}) => m;
  assert.deepEqual(serving(await store.getJson(manifestKey("main"))), serving(m0), "маніфест не змінено жодною відмовою (крім мітки fencing)");
  const ok = await guardedRollback({ store, feed: "main", controls: OK_CC, coordinator });
  assert.equal(ok.active.key, m0.previous.key);
  assert.ok(s);
});
test("Відкат через CLI: без модуля / сховища CC — відмова, маніфест не змінено", async () => {
  const { store, ctx, dir } = await feedWorld();
  assert.equal((await runUpdate(ctx(OK_CC))).feeds[0].state, "PUBLISHED");
  assert.equal((await runUpdate(ctx(ccTwin({ gate: { x: NONE } }), Date.parse("2026-10-21T07:00:00.000Z")))).feeds[0].state, "PUBLISHED"); // інший відбиток CC → нова версія
  const m0 = await store.getJson(manifestKey("main"));
  // ENG-18 (ENG18-N1): спершу допуск W2 (single-host + --cc-store = MM_SAFE_WRITE_DIR); без нього — відмова до будь-якого запису.
  const w2dir = path.join(dir, "w2");
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: w2dir };
  const noW2 = spawnSync(process.execPath, [path.join(ROOT, "src", "cli.mjs"), "rollback", `--store=${path.join(dir, "store")}`], { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  assert.equal(noW2.status, 1, noW2.stdout + noW2.stderr);
  assert.match(noW2.stderr, /НЕМАЄ КООРДИНАТОРА ЗАПИСУ \(W2\)/);
  const r = spawnSync(process.execPath, [path.join(ROOT, "src", "cli.mjs"), "rollback", `--store=${path.join(dir, "store")}`, `--cc-store=${w2dir}`], { encoding: "utf8", env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Відкат заборонено: Catalog Controls не підключено/);
  assert.deepEqual(await store.getJson(manifestKey("main")), m0);
});

// ---------- 3. Робочі точки запуску — лише пріоритет власника ----------
test("productionConfig: пріоритет власника й CC обов'язкові; явне вимкнення — відмова; робочі точки запуску його використовують", () => {
  const c = productionConfig(structuredClone(baseConfig));
  assert.equal(c.ownerPriority.enabled, true);
  assert.equal(c.controls.required, true);
  assert.throws(() => productionConfig({ ...baseConfig, ownerPriority: { enabled: false } }), /обов'язковий/);
  const cli = fs.readFileSync(path.join(ROOT, "src", "cli.mjs"), "utf8"), tool = fs.readFileSync(path.join(ROOT, "tools", "sheet-sync.mjs"), "utf8");
  assert.match(cli, /\["update", "rollback"\]\.includes\(command\) \? productionConfig\(loaded\)/);
  assert.match(tool, /WRITE_MODES\.includes\(mode\) \? productionConfig\(config0\)/);
  assert.doesNotMatch(cli, /rollbackFeed\(/, "CLI не викликає відкат в обхід guardedRollback");
});
test("Правило 7: видалений рядок перенесено з каталогу (паспорт ще зі старим набором) — фід публікується без offer, інші — як були", async () => {
  const { store, ctx, s, T0, dir } = await feedWorld();
  assert.equal((await runUpdate(ctx(OK_CC))).feeds[0].state, "PUBLISHED");
  const xml1 = (await readActiveXml(store, "main")).xml;
  const del = [...offersById(xml1).keys()][5], other = [...offersById(xml1).keys()][6];
  const sheets = structuredClone(s.sheets);
  sheets["Основний каталог"] = sheets["Основний каталог"].filter((r, i) => i === 0 || mtText(r[0]) !== del);
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets, groups: s.groups });
  const r = await runUpdate(ctx(ccTwin({ removed: [del] }), T0 + 3600_000));
  assert.equal(r.feeds[0].state, "PUBLISHED", JSON.stringify(r.feeds[0]));
  const xml2 = (await readActiveXml(store, "main")).xml;
  assert.equal(offersById(xml2).has(del), false);
  assert.equal(offersById(xml2).get(other), offersById(xml1).get(other));
});
test("Кожен кандидат перевіряється: REUSE чинної версії з видаленим (лише архів, CC без tombstone) не відбувається", async () => {
  const { store, ctx, T0 } = await feedWorld();
  assert.equal((await runUpdate(ctx(OK_CC))).feeds[0].state, "PUBLISHED");
  const xml1 = (await readActiveXml(store, "main")).xml;
  const del = [...offersById(xml1).keys()][1];
  // Той самий стан CC (відбиток) і ті самі рядки → був би REUSE; але CC тепер вважає товар видаленим → новий кандидат без нього.
  const r = await runUpdate(ctx(ccTwin({ removed: [del] }), T0));
  assert.equal(r.feeds[0].state, "PUBLISHED", JSON.stringify(r.feeds[0]));
  assert.equal(offersById((await readActiveXml(store, "main")).xml).has(del), false);
});

test("publishFeed: перевірка кандидата стоїть і на REUSE, і на новому кандидаті (захист у глибину від вади формування)", async () => {
  const { store, ctx, dir } = await feedWorld();
  assert.equal((await runUpdate(ctx(OK_CC))).feeds[0].state, "PUBLISHED");
  const m0 = await store.getJson(manifestKey("main"));
  const xml = (await readActiveXml(store, "main")).xml;
  const del = [...offersById(xml).keys()][3];
  const { publishFeed } = await import("../src/publish/publisher.mjs");
  const { candidateGuard } = await import("../src/pipeline/update.mjs");
  const guard = candidateGuard(await ccTwin({ removed: [del] }).state());
  // REUSE: той самий відбиток джерела й CC, але чинна версія містить видалений товар.
  await assert.rejects(publishFeed(store, "main", path.join(dir, "none.xml"), { ...m0.active }, { checkCandidate: guard }), /суперечить стану Catalog Controls/);
  // Новий кандидат (інший відбиток) із видаленим offer — відмова ДО завантаження.
  const file = path.join(dir, "bad.xml");
  await fsp.writeFile(file, xml);
  await assert.rejects(publishFeed(store, "main", file, { ...m0.active, sourceDigest: "інший", sha256: "x" }, { checkCandidate: guard }), /суперечить стану Catalog Controls/);
  assert.deepEqual(await store.getJson(manifestKey("main")), m0, "нічого не перемкнуто");
});

// ---------- 7. W2 / S1: робочий запис через шлюз ----------
test("W2 / S1: робоча синхронізація (tools/sheet-sync) — лише через шлюз запису й зі сховищем координатора; без нього — відмова", () => {
  const tool = fs.readFileSync(path.join(ROOT, "tools", "sheet-sync.mjs"), "utf8");
  assert.match(tool, /new WriteGateway\(\{ sheets, read: readBook, store: w2Store \}\)\.open\(\{ writer: "sync" \}\)/);
  assert.match(tool, /syncSheet\(\{[^}]*session, controls \}\)/);
  // ENG-16: запобіжник W2 посилено — сховище лише через w2Coordinator (явний однохостовий режим; GitHub Actions — відмова; див. cc-r7-integration).
  // ENG-18 (Hermes ENG16-N2): допуск W2 — до будь-якого доступу до таблиці, для КОЖНОГО режиму запису через API (зокрема merge / refresh).
  assert.match(tool, /try \{ w2Admission = w2Coordinator\(\); \} catch \(e\) \{ fail\("НЕМАЄ КООРДИНАТОРА ЗАПИСУ \(W2\): ", e\); \}/);
  assert.match(tool, /new FileStore\(w2Admission\.dir\)/);
  assert.ok(tool.indexOf("w2Admission = w2Coordinator()") < tool.indexOf("// ---------- таблиця ----------"), "допуск W2 — до доступу до таблиці");
});
test("W2 / S1: синхронізація через шлюз — колонки CC і правки власника в момент запуску не перезаписуються; журнал операцій є", async () => {
  const w = await world();
  const store = new MemoryStore();
  const gw = new WriteGateway({ sheets: w.sheets, read: w.read, store, now: () => NOW });
  const s = await gw.open({ writer: "sync" });
  const id = mtText(mainRows(w)[4]["Offer ID"]), sid = mtText(mainRows(w)[4]["ID постачальника"]);
  const h = w.sheets.book[SHEET.main][0].map(mtText);
  // Людина редагує назву (поле власника) після читання синхронізацією, але до запису.
  let edited = false;
  const racy = async (names) => { const b = await w.sheets.read(); if (!edited && names?.length === 1 && names[0] === SHEET.main) { edited = true; rowById(w, id)[h.indexOf("Назва UA")] = "Правка власника під час запуску"; } return b; };
  const xml = perturb.tag(perturb.tag(w.xml, sid, "name_ua", "Нова назва постачальника"), sid, "price", "4321");
  const r = await syncSheet({ sheets: w.sheets, readBook: racy, parsed: await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true }), fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config: cfg(), now: NOW, catalog: EMPTY_CATALOG, session: s, controls: OK_CC });
  await s.close();
  assert.ok(["SYNCED", "SKIPPED_CONCURRENT_EDIT"].includes(r.state), JSON.stringify(r).slice(0, 300));
  assert.equal(mtText(rowById(w, id)[h.indexOf("Назва UA")]), "Правка власника під час запуску", "правку власника не перезаписано");
  assert.ok(store.map.size > 0, "оренда / журнал операцій — у сховищі W2");
});
