/** ENG-29 — розбір «Відкладених товарів» (рішення власника 03.11): у фіді → «Основний каталог» (наші SEO, дані постачальника, ціни й
 *  наявність — з фіду), немає ні за ID / артикулом / назвою → «Видалені товари», дублі — лишаються зі звітом; перенесені прибираються з
 *  «Відкладених». Синтетика, таблиця в пам'яті, записи — через шлюз W2 і охоронця режиму deferred. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { rowSeal, SEAL_COLUMN } from "../src/core/seal.mjs";
import { SHEET, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { ARCHIVE_SHEET, REMOVAL, ARCHIVE_EXTRA } from "../src/core/archive.mjs";
import { DEFERRED_PLAN_KEY } from "../src/core/deferred-resolve.mjs";
import * as run from "../src/pipeline/sheet-sync-run.mjs";
import { resolveDeferred } from "../src/pipeline/deferred-resolve.mjs";
import { JOURNAL_SHEET } from "../src/pipeline/run-plan.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { guardedSheets, MODE_POLICIES, TEST_SHEET_ID } from "../src/pipeline/safe-write/write-target.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import legacyConfig from "./helpers/legacy-config.mjs";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();
const config = structuredClone(legacyConfig);
config.supplier.minimumOffers = 10;
const offerXml = (id, { name, sku, price = 500, available = true }) => `<offer id="${id}" available="${available}"><url>https://market-tools.com.ua/p${id}-new.html</url><price>${price}</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>${name} RU</name><name_ua>${name}</name_ua><vendorCode>${sku}</vendorCode><picture>https://images.prom.ua/${id}_new.jpg</picture><param name="Потужність" unit="Вт">1500</param><description>Опис постачальника ${id}</description></offer>`;

async function world() {
  const s = generateSynthetic({ products: 60, queue: 4, deferred: 4, newOffers: 0, seed: 17, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const raw = new MemorySheets(book);
  const w = { raw, readBook: async () => raw.read(), store: new MemoryStore() };
  await run.mergeNew92({ sheets: raw, readBook: w.readBook, stamp: STAMP });
  const xml0 = s.supplierXml();
  const parsed = await parseSupplierText(xml0, { maximumChars: 45_000_000, identityFields: true });
  assert.equal((await run.syncSheet({ sheets: raw, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml0, ids), stamp: STAMP, config, now: NOW, catalog: EMPTY_CATALOG })).state, "SYNCED");
  const dh = raw.book[SHEET.deferred][0].map(mtText), d = raw.book[SHEET.deferred].slice(1);
  const col = (k) => dh.indexOf(k);
  const mainRow = readSheet(raw.book[SHEET.main], SHEET.main).rows[5];
  // 0 і 1 — у фіді зі зміненою назвою постачальника; 2 — відсутній; 3 — дубль картки каталогу за артикулом (той самий артикул у фіді).
  const [a, b, gone, dup] = d.map((r) => ({ id: mtText(r[col("Offer ID")]), sid: mtText(r[col("ID постачальника")]), sku: mtText(r[col("Артикул постачальника")]), name: mtText(r[col("Назва UA")]) }));
  d[3][col("Артикул постачальника")] = mtText(mainRow["Артикул постачальника"]);
  const extra = [offerXml(a.sid, { name: "Нова назва постачальника " + a.sid, sku: a.sku }), offerXml(b.sid, { name: "Інша назва " + b.sid, sku: b.sku, available: false, price: 777 }), offerXml(dup.sid, { name: "Дубль " + dup.sid, sku: mtText(mainRow["Артикул постачальника"]) })];
  w.xml = xml0.replace("\n</offers>", "\n" + extra.join("\n") + "\n</offers>");
  Object.assign(w, { a, b, gone, dup, mainRow });
  return w;
}
const headers = (w) => Object.fromEntries(Object.entries(w.raw.book).map(([k, v]) => [k, (v[0] || []).slice()]));
async function resolve(w, { planOnly = false, stamp = STAMP } = {}) {
  const guarded = guardedSheets(w.raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES.deferred, headers: headers(w) });
  const session = planOnly ? null : await new WriteGateway({ sheets: guarded, read: w.readBook, store: w.store, settleMs: 0 }).open({ writer: "sync" });
  try { return await resolveDeferred({ readBook: w.readBook, xml: w.xml, stamp, session, config, planOnly }); }
  finally { await session?.close().catch(() => {}); }
}
const mainRows = (w) => readSheet(w.raw.book[SHEET.main], SHEET.main).rows;
const defRows = (w) => readSheet(w.raw.book[SHEET.deferred], SHEET.deferred).rows;

test("відкладені: план (нічого не записано) → у фіді — в каталог з даними постачальника, цінами й наявністю з фіду; немає — у «Видалені товари»; дубль — лишився зі звітом", async () => {
  const w = await world();
  const snap = JSON.stringify(w.raw.book);
  const p = await resolve(w, { planOnly: true });
  assert.equal(p.state, "PLANNED", JSON.stringify(p).slice(0, 300));
  assert.deepEqual(p.toMain.sort(), [w.a.id, w.b.id].sort());
  assert.deepEqual(p.toArchive, [w.gone.id]);
  assert.ok(p.keep.some((k) => k.offerId === w.dup.id && /можливий дубль/.test(k.reason)));
  assert.equal(JSON.stringify(w.raw.book), snap, "план нічого не пише");

  const mainBefore = mainRows(w).length;
  const r = await resolve(w);
  assert.equal(r.state, "DEFERRED_RESOLVED", JSON.stringify(r).slice(0, 400));
  assert.equal(mainRows(w).length, mainBefore + 2);
  const A = mainRows(w).find((x) => mtText(x["Offer ID"]) === w.a.id), Bx = mainRows(w).find((x) => mtText(x["Offer ID"]) === w.b.id);
  assert.equal(A["Назва UA"], w.a.name, "наша назва (SEO) не змінена");
  assert.equal(A["Назва постачальника UA"], "Нова назва постачальника " + w.a.sid, "дані постачальника — з фіду");
  assert.equal(A["Фото JSON"], JSON.stringify([`https://images.prom.ua/${w.a.sid}_new.jpg`]));
  assert.equal(Number(A["Ціна постачальника"]), 500);
  assert.equal(A["Наявність"], "+");
  assert.equal(Bx["Наявність"], "-", "немає в наявності у постачальника");
  assert.equal(Number(Bx["Ціна постачальника"]), 777);
  for (const x of [A, Bx]) {
    assert.equal(x["Стан синхронізації"], "ЗІСТАВЛЕНО");
    assert.equal(x["Статус імпорту"], "ДОЗВОЛЕНО");
    assert.equal(x[SEAL_COLUMN], rowSeal(x), "печатка нова й ціла");
  }
  const arch = readSheet(w.raw.book[ARCHIVE_SHEET], ARCHIVE_SHEET);
  assert.deepEqual(w.raw.book[ARCHIVE_SHEET][0].slice(-ARCHIVE_EXTRA.length), [...ARCHIVE_EXTRA]);
  const G = arch.rows.find((x) => mtText(x["Offer ID"]) === w.gone.id);
  assert.equal(G["Статус видалення"], REMOVAL.PENDING);
  assert.match(G["Операція видалення"], /ВІДКЛАДЕНІ → ВИДАЛЕНІ/);
  assert.deepEqual(defRows(w).map((x) => mtText(x["Offer ID"])), [w.dup.id], "у «Відкладених» лишився лише дубль");
  const j = w.raw.book[JOURNAL_SHEET];
  assert.ok(j.some((e) => e[2] === w.a.id && e[3] === "ПОВЕРНУТО З ВІДКЛАДЕНИХ"));
  assert.ok(j.some((e) => e[2] === w.gone.id && e[3] === "ВИДАЛЕНО"));
  assert.equal((await w.store.getJsonVersioned(DEFERRED_PLAN_KEY)).value.status, "DONE");
  // Повтор: переносити нічого — дубль лишається зі звітом.
  const r2 = await resolve(w, { stamp: new Date(NOW + 60_000).toISOString() });
  assert.equal(r2.state, "NOTHING");
  assert.ok(r2.keep.some((k) => k.offerId === w.dup.id));
  assert.equal(mainRows(w).length, mainBefore + 2);
});

test("відкладені: збій під час прибирання → INCOMPLETE, інші операції заблоковано; повтор продовжує за планом без дублів", async () => {
  const w = await world();
  w.raw.armFailure("deleteRows");
  const r1 = await resolve(w);
  assert.equal(r1.state, "INCOMPLETE", JSON.stringify(r1).slice(0, 300));
  const n = mainRows(w).length;
  const r2 = await resolve(w, { stamp: new Date(NOW + 120_000).toISOString() });
  assert.equal(r2.state, "DEFERRED_RESOLVED", JSON.stringify(r2).slice(0, 300));
  assert.equal(r2.resumed, true);
  assert.equal(mainRows(w).length, n, "без дублів у каталозі");
  assert.equal(readSheet(w.raw.book[ARCHIVE_SHEET], ARCHIVE_SHEET).rows.length, 1, "без дублів в архіві");
});

test("охоронець режиму deferred: лише дописування в каталог / архів і видалення з «Відкладених»; інші режими не видаляють «Відкладені»", async () => {
  const w = await world();
  const g = (mode) => guardedSheets(w.raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES[mode], headers: headers(w) });
  await assert.rejects(g("deferred").updateRanges([{ title: SHEET.main, row: 2, col: 1, values: [["x"]] }]), /не дозволена/);
  await assert.rejects(g("deferred").deleteRows(SHEET.main, [2]), /видалення рядків заборонено/);
  await assert.rejects(g("deferred").deleteRows(SHEET.queue, [2]), /видалення рядків заборонено/);
  for (const m of ["update", "find-new", "transfer", "qa"]) await assert.rejects(g(m).deleteRows(SHEET.deferred, [2]), /видалення рядків заборонено/, m);
});

test("прибрати вкладку «Відкладені товари»: deleteSheet лише в режимі drop-deferred і лише для цього аркуша; інші режими й аркуші — BLOCK; відсутність вкладки не ламає читання", async () => {
  const w = await world();
  const g = (mode) => guardedSheets(w.raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES[mode], headers: headers(w) });
  await assert.rejects(g("drop-deferred").deleteSheet(SHEET.main), /видалення аркуша заборонено/);
  for (const m of ["deferred", "update", "transfer", "find-new"]) await assert.rejects(g(m).deleteSheet(SHEET.deferred), /видалення аркуша заборонено/, m);
  await g("drop-deferred").deleteSheet(SHEET.deferred);
  assert.equal(w.raw.book[SHEET.deferred], undefined);
  // Без вкладки розбір нічого не робить, а пошук новинок / перенесення читають книгу як раніше.
  assert.equal((await resolve(w, { planOnly: true })).state, "NOTHING");
  for (const m of Object.keys(MODE_POLICIES)) for (const [title, p] of Object.entries(MODE_POLICIES[m])) assert.equal((p.ops || []).includes("deleteSheet") || p.deleteSheet === true, m === "drop-deferred" && title === SHEET.deferred, `${m}/${title}`);
});

test("dropDeferredSheet: непорожня вкладка — PRECONDITION_FAILED без видалення; порожня — прибрано й подія в «Журналі»; повтор — NOTHING", async () => {
  const { dropDeferredSheet } = await import("../src/pipeline/deferred-resolve.mjs");
  const w = await world();
  const g = guardedSheets(w.raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES["drop-deferred"], headers: headers(w) });
  assert.equal((await dropDeferredSheet({ sheets: g, readBook: w.readBook, stamp: STAMP })).state, "PRECONDITION_FAILED");
  assert.ok(w.raw.book[SHEET.deferred]);
  w.raw.book[SHEET.deferred] = [w.raw.book[SHEET.deferred][0]];
  assert.equal((await dropDeferredSheet({ sheets: g, readBook: w.readBook, stamp: STAMP })).state, "SHEET_REMOVED");
  assert.equal(w.raw.book[SHEET.deferred], undefined);
  assert.ok(w.raw.book[JOURNAL_SHEET].some((e) => e[3] === "ВКЛАДКУ ПРИБРАНО"));
  assert.equal((await dropDeferredSheet({ sheets: g, readBook: w.readBook, stamp: STAMP })).state, "NOTHING");
});
