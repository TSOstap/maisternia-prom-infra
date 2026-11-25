/** 25.11.2026 (власник «так»): завислі запуски закриваються самі; автоімпорт не чекає «Знайти нові товари»; новий Excel постачальника —
 *  перед автоперевіркою новинок; імпорт «файл не змінився» (лічильники нулі) не тримає наступний. Мережі немає, SQL — node:sqlite. */
import test from "node:test";
import assert from "node:assert/strict";
import { OpsCore, STALE_MS, HOROSHOP_CHECK_KEY, HOROSHOP_RETRY_MINUTES, staleLimit } from "../workers/ops/src/ops-core.mjs";
import { PROM_IMPORT } from "../workers/ops/src/prom-import.mjs";

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* старий Node — тести пропускаються */ }
const skip = DatabaseSync ? false : "немає node:sqlite";
const M = 60_000;

function fakeStorage() {
  const db = new DatabaseSync(":memory:");
  let alarm = null, depth = 0;
  return {
    sql: { exec: (q, ...a) => { const st = db.prepare(q); const rows = /^\s*(SELECT|PRAGMA)/i.test(q) ? st.all(...a) : (st.run(...a), []); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } },
    transactionSync: (fn) => {
      const sp = "s" + depth++;
      db.exec("SAVEPOINT " + sp);
      try { const r = fn(); db.exec("RELEASE " + sp); return r; } catch (e) { db.exec("ROLLBACK TO " + sp); db.exec("RELEASE " + sp); throw e; } finally { depth--; }
    },
    getAlarm: async () => alarm, setAlarm: async (t) => { alarm = t; }, deleteAlarm: async () => { alarm = null; },
  };
}
const ENV = {
  BUTTON_KEY: "b".repeat(32), RUNNER_KEY: "r".repeat(32), ADMIN_KEY: "a".repeat(32), GITHUB_TOKEN: "t".repeat(40), GITHUB_REPO: "TSOstap/maisternia-prom-infra", GITHUB_WORKFLOW: "ops.yml", GITHUB_REF: "main",
  PRICES_RUNNER: "github", PROM_API_TOKEN: "p".repeat(40), PROM_FEED_URL: "https://mm-ops.example.workers.dev/yml/" + "k".repeat(40) + ".xml",
};
const github = async (url) => { if (String(url).startsWith("https://api.github.com/")) return new Response(null, { status: 204 }); throw new Error("неочікувана адреса: " + url); };

test("завислі запуски: на сервері й у черзі — через 20 хв, на GitHub — через 65 хв; раніше не чіпаються; справжній результат потім записується", { skip }, async () => {
  const c = { t: Date.parse("2026-11-25T10:00:00Z") };
  const core = new OpsCore(fakeStorage(), ENV, { now: () => c.t, fetchImpl: github });
  assert.equal(staleLimit({ status: "RUNNING", runner: "cloudflare" }), STALE_MS.cloudflare);
  const a = await core.button({ op: "update" });
  assert.equal(a.state, "STARTED");
  c.t += STALE_MS.queued - M; await core.alarm();
  assert.equal(core.recentRuns(1)[0].status, "QUEUED", "19 хв у черзі — ще чекаємо");
  c.t += M; await core.alarm();
  let r = core.recentRuns(1)[0];
  assert.equal(r.status, "FAILED"); assert.equal(r.state, "STALE"); assert.match(r.summary, /Закрито сервером: 20 хв/);
  assert.equal(core.activeRun(), null);
  // GitHub таки взяв запуск: виконується, потім готово — справжній стан.
  core.runStart({ runId: a.runId, op: "update", ghRunId: "5" });
  c.t += STALE_MS.running - M; await core.alarm();
  assert.equal(core.recentRuns(1)[0].status, "RUNNING", "64 хв на GitHub — межа job 60 хв + запас");
  await core.runFinish({ runId: a.runId, ok: true, state: "SYNCED", summary: "готово" });
  r = core.recentRuns(1)[0];
  assert.equal(r.status, "DONE"); assert.equal(r.summary, "готово");
  core.metaDel("feed-job");
  // Запуск на сервері (PRICES_RUNNER=do, як до 25.11) завис — закрито через 20 хв.
  core.sql.exec("INSERT INTO runs (id, op, status, at, updated, info) VALUES ('x1', 'prices', 'RUNNING', ?, ?, ?)", c.t, c.t, JSON.stringify({ runner: "cloudflare" }));
  c.t += STALE_MS.cloudflare; await core.alarm();
  assert.equal(core.recentRuns(1)[0].state, "STALE");
});

test("автоімпорт не чекає «Знайти нові товари» (YML не змінює), але чекає «Ціни»", { skip }, async () => {
  const c = { t: Date.parse("2026-11-25T10:00:00Z") };
  let posts = 0;
  const fetchImpl = async (url) => { if (String(url) === "https://my.prom.ua/api/v1/products/import_url") { posts++; return new Response(JSON.stringify({ id: "1", status: "success" }), { status: 200 }); } return github(url); };
  const core = new OpsCore(fakeStorage(), ENV, { now: () => c.t, fetchImpl });
  core.feed.putMeta({ ver: 1, count: 10, changedAt: c.t - M });
  await core.promImportAdmin({ action: "on" });
  assert.equal((await core.button({ op: "find-new" })).state, "STARTED");
  assert.equal(core.promBusy(), "");
  c.t += M; await core.alarm();
  assert.equal(posts, 1, "імпорт пішов під час «Знайти нові товари»");
  const run = core.recentRuns(1)[0];
  await core.runFinish({ runId: run.id, ok: true, state: "NOTHING", summary: "" });
  c.t += M;
  assert.equal((await core.button({ op: "prices" })).state, "STARTED");
  assert.match(core.promBusy(), /виконується/);
});

test("новий Excel постачальника: іде інша операція — новинки не запускаються, повторна перевірка через 3 хв; вільно — «Оновити з Хорошопу»", { skip }, async () => {
  const c = { t: Date.parse("2026-11-25T12:00:00Z") };
  const dispatched = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://tools-store.example/excel.xlsx") { assert.equal(init.method, "HEAD"); return new Response(null, { status: 200, headers: { "last-modified": "Wed, 25 Nov 2026 11:43:03 GMT" } }); }
    if (u.startsWith("https://api.github.com/")) { dispatched.push(JSON.parse(init.body).inputs.op); return new Response(null, { status: 204 }); }
    throw new Error("неочікувана адреса: " + u);
  };
  const core = new OpsCore(fakeStorage(), { ...ENV, HOROSHOP_EXCEL_URL: "https://tools-store.example/excel.xlsx", SUPPLIER_FEED_URL: "https://market-tools.com.ua/products_feed.xml?hash_tag=x" }, { now: () => c.t, fetchImpl });
  await core.watchSwitch(true);
  assert.equal((await core.button({ op: "update" })).state, "STARTED");
  c.t += M; await core.alarm();
  const hc = core.metaGet(HOROSHOP_CHECK_KEY);
  assert.equal(hc.last.newer, true); assert.equal(hc.nextAt, c.t + HOROSHOP_RETRY_MINUTES * M);
  assert.equal(core.watchGet().last.result, "BUSY"); assert.match(core.watchGet().last.message, /новий Excel/);
  assert.deepEqual(dispatched, ["update"]);
  // «Оновити товари» завершилась — через 3 хв іде «Оновити з Хорошопу», а не новинки.
  const run = core.recentRuns(1)[0];
  await core.runFinish({ runId: run.id, ok: true, state: "SYNCED", summary: "" });
  core.metaDel("feed-job");
  core.watchPut({ ...core.watchGet(), nextAt: c.t });
  c.t += HOROSHOP_RETRY_MINUTES * M; await core.alarm();
  assert.deepEqual(dispatched, ["update", "horoshop"]);
  assert.equal(core.metaGet(HOROSHOP_CHECK_KEY).last.state, "STARTED");
});

test("новий Excel, але GitHub не приймає запуск — без повторів щотри хвилини (звичайний проміжок) і новинки не блокуються назавжди", { skip }, async () => {
  const c = { t: Date.parse("2026-11-25T12:00:00Z") };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === "https://tools-store.example/excel.xlsx") return new Response(null, { status: 200, headers: { "last-modified": "Wed, 25 Nov 2026 11:43:03 GMT" } });
    if (u.startsWith("https://api.github.com/")) return new Response("{}", { status: 401 });
    throw new Error("неочікувана адреса: " + u);
  };
  const core = new OpsCore(fakeStorage(), { ...ENV, HOROSHOP_EXCEL_URL: "https://tools-store.example/excel.xlsx" }, { now: () => c.t, fetchImpl });
  await core.alarm();
  const hc = core.metaGet(HOROSHOP_CHECK_KEY);
  assert.equal(hc.last.state, "ERROR"); assert.equal(hc.nextAt, c.t + 15 * M);
});

test("імпорт «файл не змінився»: лічильники так і лишаються нулями — через 60 хв завершено (EMPTY), наступний імпорт не тримається 3 год", { skip }, async () => {
  const c = { t: Date.parse("2026-11-25T11:18:00Z") };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === "https://my.prom.ua/api/v1/products/import_url") return new Response(JSON.stringify({ id: "9", status: "success" }), { status: 200 });
    if (u.startsWith("https://my.prom.ua/api/v1/products/import/status/")) return new Response(JSON.stringify({ status: "SUCCESS", total: 0, updated: 0, not_changed: 0, with_errors_count: 0 }), { status: 200 });
    throw new Error("неочікувана адреса: " + u);
  };
  const core = new OpsCore(fakeStorage(), ENV, { now: () => c.t, fetchImpl });
  core.feed.putMeta({ ver: 1, count: 10, changedAt: c.t - M });
  await core.promImportAdmin({ action: "on" });
  c.t += M; await core.alarm();
  assert.ok(core.promImportGet().current);
  c.t += 50 * M; await core.alarm();
  assert.ok(core.promImportGet().current, "50 хв — ще може бути черга Prom");
  c.t += (PROM_IMPORT.emptyMinutes - 50 + 1) * M; await core.alarm();
  const st = core.promImportGet();
  assert.equal(st.current, null); assert.equal(st.last.result, "EMPTY"); assert.match(st.last.message, /не змінився/);
});
