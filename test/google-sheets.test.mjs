/** Етап C2-B: адаптер Google Sheets API (імітація API, без мережі) і перевірка каталогу на синтетиці. */
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoogleSheetsCatalogSource, a1Range, columnLetter } from "../src/pipeline/google-sheets.mjs";
import { NdjsonCatalogSource, FileSupplierSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate } from "../src/pipeline/update.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { approvalManifest, GROUP_HEADERS, YML_HEADERS } from "../src/core/seal.mjs";
import { objectsFromValues } from "../src/core/yml.mjs";
import { verifyCatalog, pipelineReplay, SHEETS } from "../src/verify/catalog-verify.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
// Старий режим (явно): регресія прийнятої механіки — див. helpers/legacy-config.mjs (рішення власника 29–30.10).
import baseConfig from "./helpers/legacy-config.mjs";

const SHEET_ID = "TEST_SPREADSHEET_ID_0123456789abcdef";
const TOKEN = "ya29.TEST-TOKEN-SHOULD-NEVER-LEAK";

/** Імітація Sheets API v4 поверх книги {назва: values2D}: обрізає порожні хвости рядків і діапазонів, як справжній API. */
function fakeSheetsApi(book, { extraRows = 50, extraCols = 3, failures = [], log = [] } = {}) {
  const grid = Object.fromEntries(Object.entries(book).map(([t, v]) => [t, { rows: v.length + extraRows, cols: (v[0]?.length || 1) + extraCols }]));
  const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return async (url, init) => {
    const u = new URL(url);
    log.push({ path: u.pathname, auth: init?.headers?.Authorization, params: [...u.searchParams.entries()] });
    const f = failures.shift();
    if (f) return new Response(JSON.stringify({ error: { status: f.reason || "UNAVAILABLE", message: "secret detail " + TOKEN } }), { status: f.status, headers: f.headers || {} });
    if (init?.headers?.Authorization !== "Bearer " + TOKEN) return new Response("{}", { status: 401 });
    if (!u.pathname.includes(encodeURIComponent(SHEET_ID))) return new Response("{}", { status: 404 });
    if (u.pathname.endsWith("/values:batchGet")) {
      assert.equal(u.searchParams.get("valueRenderOption"), "UNFORMATTED_VALUE");
      assert.equal(u.searchParams.get("dateTimeRenderOption"), "FORMATTED_STRING");
      const valueRanges = u.searchParams.getAll("ranges").map((range) => {
        const m = /^'((?:[^']|'')+)'!A(\d+):([A-Z]+)(\d+)$/.exec(range);
        const title = m[1].replace(/''/g, "'");
        const from = Number(m[2]), to = Number(m[4]), cols = colIndex(m[3]);
        const src = book[title] || [];
        let rows = [];
        for (let i = from - 1; i < to; i++) {
          const r = (src[i] || []).slice(0, cols);
          let w = r.length;
          while (w > 0 && (r[w - 1] === "" || r[w - 1] == null)) w--;
          rows.push(r.slice(0, w));
        }
        while (rows.length && !rows.at(-1).length) rows.pop();
        return rows.length ? { range, majorDimension: "ROWS", values: rows } : { range, majorDimension: "ROWS" };
      });
      return new Response(JSON.stringify({ spreadsheetId: SHEET_ID, valueRanges }), { status: 200 });
    }
    assert.match(u.searchParams.get("fields"), /gridProperties/);
    return new Response(JSON.stringify({ sheets: Object.entries(grid).map(([title, g]) => ({ properties: { title, gridProperties: { rowCount: g.rows, columnCount: g.cols } } })) }), { status: 200 });
  };
}

function bookFrom(s) {
  return { [SHEETS.main]: s.sheets["Основний каталог"], [SHEETS.queue]: s.sheets["Нові товари"], [SHEETS.deferred]: s.sheets["Відкладені товари"], [SHEETS.groups]: s.groups };
}
const source = (book, o = {}) => {
  const sleeps = [];
  let clock = 0;
  const src = new GoogleSheetsCatalogSource({
    spreadsheetId: SHEET_ID, getAccessToken: async () => TOKEN, fetchImpl: fakeSheetsApi(book, o.api), chunkRows: o.chunkRows || 50,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock, ...o.src,
  });
  return { src, sleeps };
};

test("A1-нотація: колонки й апострофи в назві аркуша", () => {
  assert.equal(columnLetter(1), "A");
  assert.equal(columnLetter(26), "Z");
  assert.equal(columnLetter(27), "AA");
  assert.equal(columnLetter(40), "AN");
  assert.equal(a1Range("Відкладені товари", 1, 400, 40), "'Відкладені товари'!A1:AN400");
  assert.equal(a1Range("Аркуш 'Х'", 2, 3, 2), "'Аркуш ''Х'''!A2:B3");
});

test("читання порціями: результат = getDataRange (прямокутний, хвости обрізано), печатки цілі, мінімум запитів", async () => {
  const s = generateSynthetic({ products: 120, queue: 12, deferred: 4, seed: 7, now: Date.now() });
  const book = bookFrom(s);
  const { src } = source(book);
  const loaded = await src.load([SHEETS.main, SHEETS.queue, SHEETS.deferred, SHEETS.frozen]);
  assert.deepEqual(loaded.sheets[SHEETS.main], book[SHEETS.main]);
  assert.deepEqual(loaded.sheets[SHEETS.queue], book[SHEETS.queue]);
  assert.deepEqual(loaded.groups, book[SHEETS.groups]);
  assert.equal(loaded.sheets[SHEETS.frozen], undefined, "відсутній аркуш пропускається");
  const m = approvalManifest(readSheet(loaded.sheets[SHEETS.main], "x").rows, objectsFromValues(loaded.groups, GROUP_HEADERS));
  assert.equal(m.idsSha, s.manifestMain.idsSha);
  assert.equal(m.contentSha, s.manifestMain.contentSha);
  // 1 metadata + batchGet з бюджетом 50×40 клітинок на запит (grid: дані + 50 порожніх рядків, +3 колонки)
  const cells = (171 * 43) + (63 * 43) + (55 * 43) + (170 * 7);
  assert.ok(src.metrics.requests <= 1 + Math.ceil(cells / 2000) + 4, JSON.stringify(src.metrics));
  assert.ok(src.metrics.bytes > 100000);
});

test("порожній рядок усередині каталогу на межі порції лишається на місці → readSheet зупиняє (як LIVE)", async () => {
  const s = generateSynthetic({ products: 120, seed: 8, now: Date.now() });
  const book = bookFrom(s);
  book[SHEETS.main] = book[SHEETS.main].map((r, i) => (i === 50 ? r.map(() => "") : r)); // рядок 51 = кінець 1-ї порції
  const { src } = source(book);
  const loaded = await src.load([SHEETS.main]);
  assert.equal(loaded.sheets[SHEETS.main].length, 121, "позиції наступних рядків не зсунулися");
  assert.deepEqual(loaded.sheets[SHEETS.main][51], book[SHEETS.main][51]);
  assert.throws(() => readSheet(loaded.sheets[SHEETS.main], SHEETS.main), /Порожній рядок/);
});

test("429 з Retry-After → повтор; стійкий 503 → помилка без токена й адрес; 403 → без повторів, з підказкою", async () => {
  const s = generateSynthetic({ products: 20, seed: 9, now: Date.now() });
  const book = bookFrom(s);
  const a = source(book, { api: { failures: [{ status: 429, reason: "RESOURCE_EXHAUSTED", headers: { "Retry-After": "2" } }] } });
  await a.src.load([SHEETS.main]);
  assert.equal(a.src.metrics.retries, 1);
  assert.ok(a.sleeps.includes(2000));

  const b = source(book, { api: { failures: Array(9).fill({ status: 503 }) }, src: { maxAttempts: 3 } });
  const e1 = await b.src.load([SHEETS.main]).catch((e) => e);
  assert.match(e1.message, /HTTP 503/);
  assert.ok(!e1.message.includes(TOKEN) && !e1.message.includes(SHEET_ID) && !/https?:/.test(e1.message));
  assert.equal(b.src.metrics.requests, 3);

  const c = source(book, { api: { failures: [{ status: 403, reason: "PERMISSION_DENIED" }] } });
  const e2 = await c.src.load([SHEETS.main]).catch((e) => e);
  assert.match(e2.message, /HTTP 403 PERMISSION_DENIED: .*«Читач»/);
  assert.equal(c.src.metrics.requests, 1);
});

test("сітка з десятками тисяч порожніх рядків: порції лише для даних + ОДИН запит перевірки залишку", async () => {
  const s = generateSynthetic({ products: 120, seed: 12, now: Date.now() });
  const book = bookFrom(s);
  const { src } = source(book, { api: { extraRows: 40000 } });
  const loaded = await src.load([SHEETS.main]);
  assert.deepEqual(loaded.sheets[SHEETS.main], book[SHEETS.main]);
  // metadata + main (121 рядок по 46 на порцію = 3 порції + 1 перевірка залишку) + «Групи» (1 порція + 1 перевірка) = 7
  assert.ok(src.metrics.requests <= 7, JSON.stringify(src.metrics));
  assert.equal(src.metrics.tailProbes, 2, "по одній перевірці залишку на кожен великий аркуш (main і «Групи»)");
  assert.equal(src.metrics.dataAfterGap || 0, 0);
});

test("дані після порожнього проміжку: позиції збережено, аномалію позначено, readSheet зупиняє (як LIVE)", async () => {
  const s = generateSynthetic({ products: 120, seed: 13, now: Date.now() });
  const book = bookFrom(s);
  const main = book[SHEETS.main];
  const blank = main[0].map(() => "");
  book[SHEETS.main] = [...main.slice(0, 45), blank, ...main.slice(45)]; // рядок 46 — останній у 1-й порції (46 рядків) — порожній
  const { src } = source(book, { api: { extraRows: 5000 } });
  const loaded = await src.load([SHEETS.main]);
  assert.equal(loaded.sheets[SHEETS.main].length, book[SHEETS.main].length);
  assert.deepEqual(loaded.sheets[SHEETS.main].at(-1), book[SHEETS.main].at(-1));
  assert.equal(src.metrics.dataAfterGap, 1);
  assert.throws(() => readSheet(loaded.sheets[SHEETS.main], SHEETS.main), /Порожній рядок/);
});

test("вузький аркуш (1 колонка, тисячі рядків) читається одним запитом", async () => {
  const frozen = [["Offer ID"], ...Array.from({ length: 5143 }, (_, i) => [String(1500000000 + i)])];
  const s = generateSynthetic({ products: 5, seed: 2, now: Date.now() });
  const { src } = source({ [SHEETS.frozen]: frozen, [SHEETS.groups]: s.groups }, { chunkRows: 400, api: { extraRows: 0, extraCols: 0 } });
  const loaded = await src.load([SHEETS.frozen]);
  assert.equal(loaded.sheets[SHEETS.frozen].length, 5144);
  assert.equal(src.metrics.requests, 2, "metadata + один batchGet");
});

test("захист квоти: темп ≤ N запитів/хв і жорстка межа запитів на запуск", async () => {
  const s = generateSynthetic({ products: 120, seed: 10, now: Date.now() });
  const book = bookFrom(s);
  const a = source(book, { src: { maxRequestsPerMinute: 2 } });
  await a.src.load([SHEETS.main]);
  assert.ok(a.sleeps.some((ms) => ms > 59000), "мала бути пауза до наступної хвилини");
  const b = source(book, { src: { maxRequests: 2 } });
  await assert.rejects(b.src.load([SHEETS.main]), /межу 2 запитів/);
});

test("невалідний ID таблиці або відсутнє джерело токена — помилка до будь-якого запиту", () => {
  assert.throws(() => new GoogleSheetsCatalogSource({ spreadsheetId: "../x", getAccessToken: async () => "t" }), /ID таблиці/);
  assert.throws(() => new GoogleSheetsCatalogSource({ spreadsheetId: SHEET_ID }), /токена/);
});

test("конвеєр із джерелом Sheets API дає той самий фід, що й із локального знімка", async () => {
  const now = Date.parse("2026-10-21T06:00:00Z");
  const s = generateSynthetic({ products: 120, queue: 12, deferred: 4, newOffers: 3, seed: 21, now });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-gs-"));
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  await fsp.writeFile(path.join(dir, "supplier.xml"), s.supplierXml());
  const config = structuredClone(baseConfig);
  config.supplier.minimumOffers = 10;
  const run = async (catalog, name) => {
    const store = new LocalObjectStore(path.join(dir, name));
    return runUpdate({ store, config, manifests: { main: s.manifestMain }, catalog, supplier: new FileSupplierSource(path.join(dir, "supplier.xml")), now: () => now, tmpDir: dir });
  };
  const viaFiles = await run(new NdjsonCatalogSource(path.join(dir, "catalog")), "a");
  const viaApi = await run(source(bookFrom(s)).src, "b");
  assert.equal(viaApi.sync.state, "OK");
  assert.equal(viaApi.feeds[0].state, "PUBLISHED");
  assert.equal(viaApi.feeds[0].sha256, viaFiles.feeds[0].sha256);
  assert.equal(viaApi.newProducts.total, viaFiles.newProducts.total);
});

async function synthVerify(mutate) {
  const s = generateSynthetic({ products: 120, queue: 12, deferred: 4, seed: 33, now: Date.now() });
  const book = bookFrom(s);
  const groups = objectsFromValues(s.groups, GROUP_HEADERS);
  const q = objectsFromValues(s.sheets["Нові товари"], YML_HEADERS);
  const expected = { main: s.manifestMain, new92: approvalManifest(q, groups) };
  if (mutate) mutate(book);
  const config = structuredClone(baseConfig);
  config.supplier.minimumOffers = 10;
  const report = await verifyCatalog({ book, expected, ymlConfig: config.yml, replay: (a) => pipelineReplay({ ...a, config }) });
  return { report, s };
}

test("перевірка каталогу на справних даних: усі перевірки PASS, конвеєр (D1/D1b) без ізоляцій, YML = LIVE-формула", async () => {
  const { report } = await synthVerify();
  assert.deepEqual(report.checks.filter((c) => !c.ok).map((c) => c.name), []);
  assert.equal(report.ok, true);
  assert.equal(report.totalActive, 132);
  assert.equal(report.replay.sync, "OK");
  assert.deepEqual(report.replay.feeds.map((f) => [f.feed, f.state, f.count]), [["main", "PUBLISHED", 120], ["new92", "PUBLISHED", 12]]);
});

test("перевірка ловить зміну контенту, ціни, SEO і дубль; у звіті немає Offer ID і текстів товарів", async () => {
  const col = (k) => YML_HEADERS.indexOf(k);
  const { report, s } = await synthVerify((book) => {
    const m = book[SHEETS.main];
    m[3][col("Опис UA")] += " правка без QA";
    m[4][col("Ціна")] = 1;
    m[5][col("Запити UA")] = "x".repeat(1100);
    book[SHEETS.deferred] = [...book[SHEETS.deferred], m[6].slice()];
  });
  const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  for (const name of ["main: contentSha = еталон", "main: печатки всіх рядків", "main: ціни F:H за формулою", "main: контент — keywordsTooLong", "немає Offer ID у кількох аркушах"]) {
    assert.ok(failed.includes(name), "мала спрацювати перевірка: " + name);
  }
  assert.equal(report.ok, false);
  const text = JSON.stringify(report);
  const ids = s.sheets["Основний каталог"].slice(1).map((r) => String(r[0]));
  assert.ok(!ids.some((id) => text.includes(id)), "Offer ID не повинні потрапляти у звіт");
  assert.ok(!text.includes("правка без QA") && !text.includes(String(s.sheets["Основний каталог"][1][col("Назва UA")])), "тексти товарів не повинні потрапляти у звіт");
});
