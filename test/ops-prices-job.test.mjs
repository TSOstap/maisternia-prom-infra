/** «Оновити ціни й наявність» на сервері Cloudflare (DO mm-ops, рішення власника 03.11): вхід у Google ключем сервісного акаунта,
 *  вузьке читання (повний «Основний каталог» / «Журнал» — ніколи), Catalog Controls із вузького каталогу, передача на GitHub, коли
 *  потрібне повне читання; кнопка → черга DO → alarm. Мережі немає: Google, фід і GitHub — підставні; таблиця — у пам'яті. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { googleTokenSource, parseServiceKey, ALLOWED_SA } from "../workers/ops/src/google-auth.mjs";
import { runPricesJob, CC_MAIN_COLUMNS } from "../workers/ops/src/prices-job.mjs";
import { OpsCore, PRICES_JOB_KEY } from "../workers/ops/src/ops-core.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet, LIVE_COLUMNS } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { CC_CHECKPOINT_KEY } from "../src/pipeline/safe-write/gateway.mjs";
import { emptyCheckpoint } from "../src/core/controls-plan.mjs";
import { RUN_PLAN_KEY } from "../src/pipeline/run-plan.mjs";
import { PRESENCE_COLUMN } from "../src/core/supplier-presence.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { ACTIVE_CONTRACT } from "./helpers/controls.mjs";

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* старий Node */ }
const skip = DatabaseSync ? false : "немає node:sqlite";

const NOW = Date.parse("2026-11-03T08:00:00Z");
const MAIN = "Основний каталог", JOURNAL = "Журнал";
const sha = async (s) => crypto.createHash("sha256").update(s).digest("hex");
const FEED = "https://market-tools.com.ua/products_feed.xml?hash_tag=x&group_ids=&exclude_fields=";
const dated = (xml) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + 2 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });

// ---------------------------------------------------------------- вхід у Google
function serviceKey(email = ALLOWED_SA) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { raw: JSON.stringify({ type: "service_account", client_email: email, private_key: privateKey.export({ type: "pkcs8", format: "pem" }), private_key_id: "kid1" }), publicKey };
}
test("Google: JWT RS256 підписано ключем сервісного акаунта (перевіряється відкритим ключем), токен кешується; інший акаунт — відмова", async () => {
  const k = serviceKey();
  let calls = 0, t = NOW;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url, "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.get("assertion").split(".");
    const dec = (x) => JSON.parse(Buffer.from(x, "base64url").toString("utf8"));
    assert.deepEqual(dec(h), { alg: "RS256", typ: "JWT", kid: "kid1" });
    const claims = dec(c);
    assert.equal(claims.iss, ALLOWED_SA); assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
    assert.equal(claims.scope, "https://www.googleapis.com/auth/spreadsheets"); assert.equal(claims.exp - claims.iat, 3600);
    assert.ok(crypto.verify("sha256", Buffer.from(h + "." + c), k.publicKey, Buffer.from(s, "base64url")), "підпис перевіряється");
    return new Response(JSON.stringify({ access_token: "tok-" + calls, expires_in: 3600 }), { status: 200 });
  };
  const get = googleTokenSource(k.raw, { fetchImpl, now: () => t });
  assert.equal(await get(), "tok-1");
  assert.equal(await get(), "tok-1", "кеш");
  t += 56 * 60_000;
  assert.equal(await get(), "tok-2", "оновлення за 5 хв до закінчення");
  assert.throws(() => parseServiceKey(serviceKey("other@x.iam.gserviceaccount.com").raw), /дозволено лише/);
  assert.throws(() => parseServiceKey("не json"), /не є JSON/);
  const bad = googleTokenSource(k.raw, { fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) });
  await assert.rejects(bad(), /HTTP 400, invalid_grant/);
});

// ---------------------------------------------------------------- серверна операція
function world() {
  const s = generateSynthetic({ products: 60, queue: 0, deferred: 0, newOffers: 0, seed: 52, now: NOW });
  const main = s.sheets["Основний каталог"].map((r, i) => [...r, i === 0 ? PRESENCE_COLUMN : ""]);
  const book = { [MAIN]: main, "Групи": s.groups, [JOURNAL]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус", "ID події"]], "Видалені товари": [["Offer ID", "ID постачальника"]] };
  const w = { s, sheets: new MemorySheets(book), store: new MemoryStore(), xml: dated(s.supplierXml()), heavy: [] };
  // Підставний читач Sheets API — ті самі методи, що GoogleSheetsCatalogSource (load / loadColumns / loadHeaders).
  w.reader = {
    async load(names) { const b = await w.sheets.read(); for (const n of names) if (n === MAIN || n === JOURNAL) w.heavy.push(n); return { sheets: Object.fromEntries(names.filter((n) => b[n]).map((n) => [n, b[n]])) }; },
    async loadColumns(title, cols) {
      const v = (await w.sheets.read())[title];
      if (!v) return null;
      const keep = new Set(cols.map((c) => v[0].indexOf(c)).filter((i) => i >= 0));
      return [v[0].slice(), ...v.slice(1).map((r) => v[0].map((_, j) => (keep.has(j) ? r[j] ?? "" : "")))];
    },
    async loadHeaders(titles) { const b = await w.sheets.read(); return Object.fromEntries(titles.filter((t) => b[t]).map((t) => [t, [b[t][0].slice()]])); },
  };
  return w;
}
const contractText = JSON.stringify(ACTIVE_CONTRACT);
async function job(w, o = {}) {
  // Контрольну точку CC пише лише CC під орендою (ключ запечатано) — у тесті кладемо напряму в сховище в пам'яті.
  if (!(await w.store.getJsonVersioned(CC_CHECKPOINT_KEY))?.value) w.store.map.set(CC_CHECKPOINT_KEY, { value: o.checkpoint || emptyCheckpoint(new Date(NOW).toISOString()), version: "1" });
  const fetchImpl = async (url) => { assert.ok(String(url).startsWith("https://market-tools.com.ua/"), "лише фід (Google — підставний читач)"); assert.match(String(url), /exclude_fields=description/); return new Response(o.xml || w.xml, { status: 200 }); };
  return runPricesJob({ env: { SUPPLIER_FEED_URL: FEED, ...(o.env || {}) }, store: w.store, ccContractText: o.contract ?? contractText, sha256Hex: sha, ccSha: await sha(contractText), fetchImpl, now: NOW + (o.min || 0) * 60_000, dry: o.dry || false, deps: { reader: w.reader, writer: w.sheets, configure: (c) => { c.supplier.minimumOffers = 10; } } });
}
const rows = (w) => readSheet(w.sheets.book[MAIN], MAIN).rows;

test("сервер: план без запису (dry) і запис лише змінених цін; повного читання «Основного каталогу» / «Журналу» немає; повтор — без змін", async () => {
  const w = world();
  const r0 = await job(w);
  assert.ok(["PRICES_UPDATED", "NO_CHANGES"].includes(r0.result?.state), JSON.stringify(r0).slice(0, 400));
  const before = rows(w);
  const sid = (i) => mtText(before[i]["ID постачальника"]);
  const xml = perturb.tag(w.xml, sid(3), "price", String(Number(before[3]["Ціна постачальника"]) + 100));
  const d = await job(w, { xml, dry: true, min: 5 });
  assert.equal(d.result.state, "PLANNED"); assert.equal(d.result.stats.changedProducts, 1); assert.equal(d.result.cc.blocked, false);
  assert.deepEqual(rows(w), before, "dry нічого не пише");
  const r = await job(w, { xml, min: 6 });
  assert.equal(r.result.state, "PRICES_UPDATED", JSON.stringify(r).slice(0, 400));
  assert.equal(r.result.stats.written, 1);
  assert.equal(Number(rows(w)[3]["Ціна постачальника"]), Number(before[3]["Ціна постачальника"]) + 100);
  assert.deepEqual(w.heavy, [], "повне читання важких аркушів не виконувалось");
  assert.equal((await w.store.getJsonVersioned(RUN_PLAN_KEY)).value.status, "DONE");
  assert.equal((await job(w, { xml, min: 7 })).result.state, "NO_CHANGES");
  assert.ok(CC_MAIN_COLUMNS.includes("SEO рішення") && CC_MAIN_COLUMNS.includes("ID постачальника"));
});

test("сервер → GitHub: незавершений план, наміри CC, команди CC у каталозі, чужий контракт, немає адреси фіду / ключа — запис не виконується", async () => {
  const w = world();
  await job(w);
  const snap = JSON.stringify(w.sheets.book);
  // Незавершений план товарного запуску.
  await w.store.putJsonIfVersion(RUN_PLAN_KEY, { v: 1, kind: "update", runId: "update:x", status: "PRODUCT_DONE", events: [], evidence: [] }, (await w.store.getJsonVersioned(RUN_PLAN_KEY))?.version ?? null);
  const a = await job(w, { min: 1 });
  assert.equal(a.fallback, "github"); assert.match(a.reason, /незавершений/);
  await w.store.putJsonIfVersion(RUN_PLAN_KEY, { v: 1, kind: "update", runId: "update:x", status: "DONE", events: [], evidence: [] }, (await w.store.getJsonVersioned(RUN_PLAN_KEY)).version);
  // Наміри в контрольній точці CC (окремий світ: точку пише лише CC під орендою).
  const w2 = world();
  const pend = await job(w2, { checkpoint: { ...emptyCheckpoint(new Date(NOW).toISOString()), pending: [{ op: "x" }] } });
  assert.equal(pend.fallback, "github"); assert.match(pend.reason, /наміри/);
  // Команда CC у колонці «Продаж рішення».
  const m = w.sheets.book[MAIN];
  m[0].push("Продаж рішення"); m.slice(1).forEach((r, i) => r.push(i === 4 ? "ЗНЯТИ З ПРОДАЖУ" : ""));
  assert.match((await job(w, { min: 3 })).reason, /команди Catalog Controls/);
  m[0].pop(); m.slice(1).forEach((r) => r.pop());
  // Контракт CC не той, що погоджено; немає адреси фіду.
  assert.match((await job(w, { min: 4, contract: contractText.replace("catalog-controls", "catalog-controls ") })).reason, /контракт/);
  assert.match((await job(w, { min: 5, env: { SUPPLIER_FEED_URL: "https://evil.example/feed.xml" } })).reason, /адреси фіду/);
  assert.equal(JSON.stringify(w.sheets.book), snap, "нічого не записано");
  assert.deepEqual(w.heavy, []);
});

// ---------------------------------------------------------------- кнопка → черга DO → alarm
function fakeStorage() {
  const db = new DatabaseSync(":memory:");
  let alarm = null;
  return {
    sql: { exec(q, ...b) { const st = db.prepare(q); if (/^\s*SELECT/i.test(q)) { const r = st.all(...b); return { toArray: () => r }; } st.run(...b); return { toArray: () => [] }; } },
    transactionSync(fn) { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; }, async deleteAlarm() { alarm = null; },
  };
}
const ENV = { BUTTON_KEY: "b".repeat(32), RUNNER_KEY: "r".repeat(32), ADMIN_KEY: "a".repeat(32), GITHUB_TOKEN: "t".repeat(40), GITHUB_REPO: "TSOstap/maisternia-prom-infra", GITHUB_WORKFLOW: "ops.yml", GITHUB_REF: "main", PRICES_RUNNER: "do" };

test("кнопка «Ціни» (PRICES_RUNNER=do): черга DO → alarm → підсумок; GitHub не запускається; повторне натискання — «уже виконується»; потрібне повне читання → той самий запуск іде на GitHub", { skip }, async () => {
  const c = { t: NOW }, github = [];
  let next = { result: { state: "PRICES_UPDATED", stats: { written: 3, supplierPriceChanged: 2, salePriceChanged: 2, availabilityChanged: 1, becameAvailable: 1, becameUnavailable: 0, quantityChanged: 0, skipped: {} }, feed: { offers: 5274 } }, metrics: { ms: 61000 } };
  const storage = fakeStorage();
  const core = new OpsCore(storage, ENV, { now: () => c.t, fetchImpl: async (url, init) => { github.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }, pricesJobImpl: async () => next });
  const b = await core.button({ op: "prices", by: "тест" });
  assert.equal(b.state, "STARTED"); assert.match(b.message, /на сервері/);
  assert.ok(core.metaGet(PRICES_JOB_KEY)); assert.equal(await storage.getAlarm(), c.t + 1000);
  assert.equal((await core.button({ op: "prices" })).state, "BUSY");
  c.t += 1000;
  await core.alarm();
  const run = core.recentRuns(1)[0];
  assert.equal(run.status, "DONE"); assert.match(run.summary, /Оновлено товарів: 3/); assert.match(run.summary, /сервер Cloudflare, 61 с/);
  assert.equal(github.length, 0, "GitHub не запускався");
  assert.equal(core.metaGet(PRICES_JOB_KEY), null); assert.equal(await storage.getAlarm(), null, "автопошук вимкнено — alarm не потрібен");
  // Передача на GitHub: той самий запуск, op prices.
  next = { fallback: "github", reason: "незавершений попередній запис" };
  await core.button({ op: "prices" });
  c.t += 2000;
  await core.alarm();
  const r2 = core.recentRuns(1)[0];
  assert.equal(r2.status, "QUEUED"); assert.equal(r2.runner, "github"); assert.match(r2.fallback, /незавершений/);
  assert.equal(github.length, 1); assert.equal(github[0].inputs.op, "prices"); assert.equal(github[0].inputs.run_id, r2.id);
});

test("один alarm на об'єкт: автопошук зберігає свій 15-хвилинний розклад, коли між перевірками запускається «Ціни»", { skip }, async () => {
  const c = { t: NOW };
  const storage = fakeStorage();
  const core = new OpsCore(storage, { ...ENV, SUPPLIER_FEED_URL: "" }, { now: () => c.t, fetchImpl: async () => new Response(null, { status: 204 }), pricesJobImpl: async () => ({ result: { state: "NO_CHANGES", stats: { skipped: {} } }, metrics: { ms: 1000 } }) });
  await core.watchSwitch(true);
  const first = await storage.getAlarm();
  assert.equal(first, c.t + 60_000);
  c.t = first; await core.alarm();
  const nextWatch = core.watchGet().nextAt;
  assert.equal(nextWatch, c.t + 15 * 60_000); assert.equal(await storage.getAlarm(), nextWatch);
  c.t += 5 * 60_000;
  await core.button({ op: "prices" });
  assert.equal(await storage.getAlarm(), c.t + 1000, "черга — одразу");
  c.t += 1000; await core.alarm();
  assert.equal(core.recentRuns(1)[0].status, "DONE");
  assert.equal(core.watchGet().nextAt, nextWatch, "розклад автопошуку не зсунувся");
  assert.equal(await storage.getAlarm(), nextWatch);
});

test("розклад «Цін» на сервері: типово вимкнено; увімкнено — запуск за розкладом без GitHub; виконується інша операція — пропуск; вимкнено — alarm не потрібен", { skip }, async () => {
  const { PRICES_SCHEDULE_KEY, SCHEDULE_BY } = await import("../workers/ops/src/ops-core.mjs");
  const c = { t: NOW }, github = [];
  let jobs = 0;
  const storage = fakeStorage();
  const core = new OpsCore(storage, ENV, { now: () => c.t, fetchImpl: async (u, init) => { github.push(init?.body); return new Response(null, { status: 204 }); }, pricesJobImpl: async () => { jobs++; return { result: { state: "NO_CHANGES", stats: { skipped: {} } }, metrics: { ms: 1000 } }; } });
  assert.equal(core.metaGet(PRICES_SCHEDULE_KEY), null, "типово розкладу немає");
  const s = await core.pricesSchedule({ on: true, everyMinutes: 120 });
  assert.equal(s.on, true); assert.equal(s.everyMinutes, 120); assert.equal(s.runner, "cloudflare"); assert.equal(s.alarmAt, c.t + 60_000);
  assert.equal((await core.pricesSchedule({ on: true, everyMinutes: 5 })).everyMinutes, 60, "не частіше разу на годину");
  await core.pricesSchedule({ on: true, everyMinutes: 120 });
  c.t += 60_000; await core.alarm();
  assert.equal(jobs, 1); assert.equal(github.length, 0);
  const run = core.recentRuns(1)[0];
  assert.equal(run.by, SCHEDULE_BY); assert.equal(run.status, "DONE");
  assert.equal(await storage.getAlarm(), c.t + 120 * 60_000, "наступний — через 2 год");
  // Наступного разу виконується інша операція — пропуск (без черги), розклад іде далі.
  c.t += 120 * 60_000;
  core.sql.exec("INSERT INTO runs (id, op, status, at, updated, info) VALUES ('x', 'update', 'RUNNING', ?, ?, '{}')", c.t - 60_000, c.t - 60_000);
  await core.alarm();
  assert.equal(jobs, 1); assert.equal(core.metaGet(PRICES_SCHEDULE_KEY).last.state, "BUSY");
  assert.equal(await storage.getAlarm(), c.t + 120 * 60_000);
  await core.pricesSchedule({ on: false });
  assert.equal(await storage.getAlarm(), null);
});
