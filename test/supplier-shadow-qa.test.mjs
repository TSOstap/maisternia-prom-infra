/** Тести, додані за результатами незалежного QA C2-C (21.10.2026). Без зовнішньої мережі: лише 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareWithSheet, liveParity } from "../src/verify/supplier-shadow.mjs";
import { planRows, readSheet } from "../src/core/sync-plan.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { HttpSupplierSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { GoogleSheetsCatalogSource } from "../src/pipeline/google-sheets.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { loadLiveAppsScript } from "../test/helpers/apps-script-vm.mjs";
import { formatYmlDate } from "../src/core/time.mjs";
import { approvalManifest, GROUP_HEADERS, YML_HEADERS } from "../src/core/seal.mjs";
import { objectsFromValues } from "../src/core/yml.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const H = 3600000;

async function base(o = {}) {
  const s = generateSynthetic({ products: 120, seed: 71, now: Date.now(), ...o });
  const rows = readSheet(s.sheets["Основний каталог"], "x").rows;
  const parsed = await parseSupplierText(s.supplierXml());
  return { s, rows, parsed };
}
const stampOf = (rows) => String(rows[0]["Оновлено"]);

test("QA-1: SAME_SNAPSHOT — однаковий не-OK статус у таблиці й у новій системі = UNCHANGED, а не LOGIC_DIFF", async () => {
  const missingId = String(1500000000 + 4 * 7);
  const { rows, parsed } = await base({ missingFromSupplier: [missingId] });
  // Таблиця вже містить результат LIVE для зниклого товару (як після mtUpdate).
  const i = rows.findIndex((r) => r["Offer ID"] === missingId);
  const synced = rows.map((r, k) => (k === i ? { ...r, "Знижка": "", "Наявність": "-", "Кількість постачальника": "", "Стан синхронізації": "ВІДСУТНІЙ_У_YML" } : r));
  // «Той самий знімок»: фід дає ті самі ціни й наявність, що в таблиці.
  const same = new Map([...parsed.offers].map(([id, o]) => {
    const r = synced.find((x) => x["ID постачальника"] === id);
    return [id, r ? { ...o, price: r["Ціна постачальника"], available: r["Наявність"] === "+" } : o];
  }));
  const plan = planRows(synced, same, new Date().toISOString());
  const c = compareWithSheet({ rows: synced, plan, offers: same, mode: "SAME_SNAPSHOT", syncStamp: stampOf(synced) });
  assert.equal(c.logicDiffs, 0, JSON.stringify(c.byClass));
  assert.equal(c.byClass.UNCHANGED, synced.length);
  // А розбіжність статусу (таблиця ЗІСТАВЛЕНО, нова система — інше) у тому самому знімку — справжній LOGIC_DIFF.
  const tampered = synced.map((r, k) => (k === i ? { ...r, "Стан синхронізації": "ЗІСТАВЛЕНО", "Наявність": "+" } : r));
  const plan2 = planRows(tampered, same, new Date().toISOString());
  assert.equal(compareWithSheet({ rows: tampered, plan: plan2, offers: same, mode: "SAME_SNAPSHOT", syncStamp: stampOf(tampered) }).logicDiffs, 1);
});

test("QA-3: постачальник змінив лише кількість, а Base у таблиці хибна — прихована помилка виявляється (LOGIC_DIFF)", async () => {
  const { rows, parsed } = await base();
  const id = rows[10]["ID постачальника"];
  const offers = new Map(parsed.offers);
  const o = offers.get(id);
  offers.set(id, { ...o, price: rows[10]["Ціна постачальника"], available: rows[10]["Наявність"] === "+", quantity: "7" });
  const bad = rows.map((r, k) => (k === 10 ? { ...r, "Ціна": r["Ціна"] + 3 } : r));
  const plan = planRows(bad, offers, new Date().toISOString());
  const c = compareWithSheet({ rows: bad, plan, offers, mode: "NEWER_FEED", syncStamp: stampOf(bad) });
  assert.equal(c.logicDiffs, 1);
  assert.equal(c.supplierChangeKinds["кількість"] >= 1, true);
});

test("QA-4: рядки, яких останній mtUpdate ще не синхронізував, — NOT_SYNCED_YET, не LOGIC_DIFF і не «зміна постачальника»", async () => {
  const { rows, parsed } = await base();
  const fresh = rows.map((r, k) => (k < 5 ? { ...r, "Оновлено": "", "Ціна постачальника": "", "Ціна": "", "Ціна кінцева": "", "Знижка": "", "Наявність": "", "Стан синхронізації": "ОЧІКУЄ_MTUPDATE" } : r));
  const plan = planRows(fresh, parsed.offers, new Date().toISOString());
  for (const mode of ["NEWER_FEED", "SAME_SNAPSHOT"]) {
    const c = compareWithSheet({ rows: fresh, plan, offers: parsed.offers, mode, syncStamp: stampOf(rows) });
    assert.equal(c.byClass.NOT_SYNCED_YET, 5, mode);
    assert.equal(c.comparableRows, rows.length - 5);
  }
});

test("QA-2: відновлення (у таблиці не ЗІСТАВЛЕНО → тепер ЗІСТАВЛЕНО) і зміна статусу класифікуються окремо", async () => {
  const { rows, parsed } = await base();
  const t = rows.map((r, k) => (k === 2 ? { ...r, "Стан синхронізації": "КОНФЛІКТ_АРТИКУЛА" } : r));
  const plan = planRows(t, parsed.offers, new Date().toISOString());
  const c = compareWithSheet({ rows: t, plan, offers: parsed.offers, mode: "NEWER_FEED", syncStamp: stampOf(t) });
  assert.equal(c.byClass.RECOVERED, 1);
  assert.equal(c.statusChanges["КОНФЛІКТ_АРТИКУЛА → ЗІСТАВЛЕНО"], 1);
});

test("QA: паритет справді ловить розбіжність (негативний тест: LIVE-план змінено в одному рядку)", async () => {
  const { s, rows } = await base();
  const gas = loadLiveAppsScript();
  const spoiled = Object.create(gas);
  spoiled.mtParse = gas.mtParse;
  spoiled.mtValidateFeed = gas.mtValidateFeed;
  spoiled.mtPlan = (r, p, st) => { const out = JSON.parse(JSON.stringify(gas.mtPlan(r, p, st))); out[3].next[1] += 1; return out; };
  const xml = s.supplierXml();
  const ok = await liveParity({ gas, xml, rows, stamp: "x", previousCount: 0, now: Date.now(), supplierConfig: { ...baseConfig.supplier, minimumOffers: 10 } });
  assert.equal(ok.planDiff, 0);
  const bad = await liveParity({ gas: spoiled, xml, rows, stamp: "x", previousCount: 0, now: Date.now(), supplierConfig: { ...baseConfig.supplier, minimumOffers: 10 } });
  assert.equal(bad.planDiff, 1);
});

/** Локальний HTTP-сервер (127.0.0.1) замість постачальника. */
async function server(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test("QA-7: отримання фіду — таймаут, ліміт розміру під час завантаження, не-200 — без адреси в повідомленні", async () => {
  const hang = await server(() => { /* не відповідає */ });
  await assert.rejects(async () => { for await (const _ of new HttpSupplierSource(hang.url + "/f?hash_tag=SECRET123456", { timeoutMs: 300 }).chunks()); }, (e) => /час очікування/.test(e.message) && !/SECRET|127\.0\.0\.1/.test(e.message));
  hang.close();
  const big = await server((req, res) => { res.writeHead(200); const chunk = "x".repeat(65536); let n = 0; const iv = setInterval(() => { if (n++ > 40) { clearInterval(iv); res.end(); } else res.write(chunk); }, 1); });
  await assert.rejects(async () => { for await (const _ of new HttpSupplierSource(big.url + "/f", { maxBytes: 200000 }).chunks()); }, /безпечний розмір/);
  big.close();
  const denied = await server((req, res) => { res.writeHead(403); res.end("denied for hash_tag=SECRET123456"); });
  await assert.rejects(async () => { for await (const _ of new HttpSupplierSource(denied.url + "/f?hash_tag=SECRET123456").chunks()); }, (e) => e.message === "HTTP 403");
  const redirect = await server((req, res) => { res.writeHead(302, { Location: "https://example.com/" }); res.end(); });
  await assert.rejects(async () => { for await (const _ of new HttpSupplierSource(redirect.url + "/f").chunks()); }, (e) => e.message === "HTTP 302", "редиректи заборонені, як у LIVE");
  await denied.close(); await redirect.close();
});

async function cliEnv(handler) {
  const now = Date.now();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-qa-cli-"));
  const s = generateSynthetic({ products: 400, queue: 12, seed: 81, now });
  const prev = new Date(now - 4 * H).toISOString();
  const journal = [["h"], [prev, "СИСТЕМА", "", "ЗАВЕРШЕНО", "", s.offers.length, JSON.stringify({ mode: "ОНОВЛЕННЯ", feedDate: formatYmlDate(now - 4 * H, "Europe/Kyiv"), offers: s.offers.length })]];
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: { ...s.sheets, "Журнал": journal }, groups: s.groups });
  const config = structuredClone(baseConfig);
  config.supplier.minimumOffers = 10;
  config.supplier.allowedUrlPattern = "^http://127\\.0\\.0\\.1:";
  config.supplier.fetchTimeoutMs = 1500;
  config.pricing = { ...config.pricing, whole: false }; // № 87: тіньова звірка з LIVE (Apps Script) — стара формула з копійками
  await fsp.writeFile(path.join(dir, "config.json"), JSON.stringify(config));
  const g = objectsFromValues(s.groups, GROUP_HEADERS), q = objectsFromValues(s.sheets["Нові товари"], YML_HEADERS);
  await fsp.writeFile(path.join(dir, "expected.json"), JSON.stringify({ main: s.manifestMain, new92: approvalManifest(q, g) }));
  const xml = s.supplierXml();
  const srv = await server((req, res) => handler(req, res, xml));
  const feedUrl = `${srv.url}/feed.xml?hash_tag=FAKEHASHzzzzNOTREALzzzzTESTONLYzz&languages=uk%2Cru`;
  const run = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, "tools", "supplier-shadow.mjs"), "--source=snapshot", `--catalog=${path.join(dir, "catalog")}`, "--supplier=env", `--config=${path.join(dir, "config.json")}`, `--expected=${path.join(dir, "expected.json")}`], { env: { ...process.env, MM_SUPPLIER_FEED_URL: feedUrl, GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.FAKE_TOKEN_FOR_TEST_ONLY" } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
  return { run, srv, feedUrl };
}

test("QA-6: шлях --supplier=env: операційні параметри LIVE додаються; секрет і токен не з'являються у виводі", async () => {
  let seen;
  const { run, srv } = await cliEnv((req, res, xml) => { seen = new URL(req.url, "http://x"); res.writeHead(200, { "Content-Type": "application/xml" }); res.end(xml); });
  const r = await run();
  await srv.close();
  assert.equal(r.code, 0, r.err + r.out.slice(0, 2000));
  assert.equal(seen.searchParams.get("exclude_fields"), "description,picture,param,keywords");
  assert.equal(seen.searchParams.get("html_description"), "0");
  assert.equal(seen.searchParams.get("extra_fields"), "0");
  for (const secret of ["FAKEHASHzzzzNOTREALzzzzTESTONLYzz", "ya29.FAKE_TOKEN_FOR_TEST_ONLY", "127.0.0.1"]) assert.ok(!r.out.includes(secret) && !r.err.includes(secret), secret);
  const rep = JSON.parse(r.out);
  assert.equal(rep.metrics.supplierRequests, 1);
});

test("QA-6: помилка постачальника (403 з секретом у тілі) — код 2, у stderr лише «HTTP 403», без адреси й секрету", async () => {
  const { run, srv } = await cliEnv((req, res) => { res.writeHead(403); res.end("denied FAKEHASHzzzzNOTREALzzzzTESTONLYzz"); });
  const r = await run();
  await srv.close();
  assert.equal(r.code, 2);
  assert.match(r.err, /HTTP 403/);
  assert.ok(!/0123456789abcdef|127\.0\.0\.1|hash_tag/.test(r.err + r.out));
});

test("QA-6: таймаут постачальника — код 2 з повідомленням про час очікування", async () => {
  const { run, srv } = await cliEnv(() => { /* мовчить */ });
  const r = await run();
  await srv.close();
  assert.equal(r.code, 2);
  assert.match(r.err, /час очікування/);
});

test("QA: хвіст «Журналу» читається кількома вікнами, доки не знайдено успішний mtUpdate", async () => {
  const rowsN = 7000;
  const journal = [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]];
  journal.push(["2026-10-21T09:20:48.911Z", "СИСТЕМА", "", "ЗАВЕРШЕНО", "", 5223, JSON.stringify({ mode: "ОНОВЛЕННЯ", feedDate: "2026-10-21 12:20", offers: 5223 })]);
  for (let i = 0; i < rowsN; i++) journal.push(["2026-10-21T09:21:00.000Z", "YML", "", "БЕЗ ЗМІН", "", "", "x"]);
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (!u.pathname.endsWith("/values:batchGet")) return new Response(JSON.stringify({ sheets: [{ properties: { title: "Журнал", gridProperties: { rowCount: journal.length + 500, columnCount: 26 } } }] }));
    const m = /A(\d+):([A-Z]+)(\d+)$/.exec(u.searchParams.get("ranges"));
    const values = journal.slice(Number(m[1]) - 1, Number(m[3]));
    while (values.length && !values.at(-1)?.length) values.pop();
    return new Response(JSON.stringify({ valueRanges: [values.length ? { values } : {}] }));
  };
  const src = new GoogleSheetsCatalogSource({ spreadsheetId: "TEST_SPREADSHEET_ID_0123456789abcdef", getAccessToken: async () => "t", fetchImpl, sleep: async () => {}, now: () => 0 });
  const { findLastSync } = await import("../src/verify/supplier-shadow.mjs");
  const tail = await src.loadTail("Журнал", { until: (rows) => findLastSync(rows) !== null });
  const last = findLastSync(tail);
  assert.equal(last?.feedDate, "2026-10-21 12:20");
  assert.ok(src.metrics.requests >= 5, "мало бути кілька вікон: " + src.metrics.requests);
});
