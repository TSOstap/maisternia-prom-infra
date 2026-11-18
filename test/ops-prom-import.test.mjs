/** Автоімпорт у Prom (рішення власника 18.11.2026): після зміни нашого YML — імпорт лише нашого посилання через Prom Public API
 *  (ціна, наявність, знижка; відсутні — без змін), не частіше ніж раз на 2 год і не більше 6 на добу.
 *  Мережі немає: Prom — підставний; SQL Durable Object — node:sqlite. */
import test from "node:test";
import assert from "node:assert/strict";
import { OpsCore, roleFor } from "../workers/ops/src/ops-core.mjs";
import * as PI from "../workers/ops/src/prom-import.mjs";

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* старий Node — тести пропускаються */ }
const skip = DatabaseSync ? false : "немає node:sqlite";

function fakeStorage() {
  const db = new DatabaseSync(":memory:");
  let alarm = null;
  return {
    sql: {
      exec(q, ...b) {
        const st = db.prepare(q);
        if (/^\s*SELECT/i.test(q)) { const rows = st.all(...b); return { toArray: () => rows }; }
        st.run(...b);
        return { toArray: () => [] };
      },
    },
    transactionSync(fn) { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
    async deleteAlarm() { alarm = null; },
  };
}
const FEED_URL = "https://mm-ops.example.workers.dev/yml/" + "k".repeat(43) + ".xml";
const ENV = { BUTTON_KEY: "b".repeat(32), RUNNER_KEY: "r".repeat(32), ADMIN_KEY: "a".repeat(32), GITHUB_TOKEN: "t".repeat(40), GITHUB_REPO: "TSOstap/maisternia-prom-infra", GITHUB_WORKFLOW: "ops.yml", GITHUB_REF: "main", PROM_API_TOKEN: "p".repeat(40), PROM_FEED_URL: FEED_URL };
const M = 60_000;

test("автоімпорт: тіло запиту — точно модель ImportProductURL (лише ціна, наявність, знижка; відсутні — без змін; без примусового оновлення)", () => {
  assert.deepEqual(PI.importBody(FEED_URL), { url: FEED_URL, force_update: false, only_available: false, mark_missing_product_as: "none", updated_fields: ["price", "presence", "discount"] });
  assert.equal(PI.PROM_IMPORT.minGapMinutes, 120);
  assert.equal(PI.PROM_IMPORT.maxPerDay, 6);
});

test("автоімпорт: готовність — без токена / чужа адреса фіду → ні; наш YML і токен → так", () => {
  assert.equal(PI.promImportReady({ PROM_FEED_URL: FEED_URL }).ok, false);
  assert.equal(PI.promImportReady({ PROM_API_TOKEN: "x", PROM_FEED_URL: "https://market-tools.com.ua/products_feed.xml?hash_tag=1" }).ok, false);
  assert.equal(PI.promImportReady({ PROM_API_TOKEN: "x", PROM_FEED_URL: "https://script.google.com/macros/s/abc/exec" }).ok, false);
  assert.equal(PI.promImportReady({ PROM_API_TOKEN: "x", PROM_FEED_URL: FEED_URL }).ok, true);
});

test("автоімпорт: рішення — вимкнено / немає фіду / іде імпорт / фід не змінився / зайнято / пауза / 2 год / 6 на добу / нова доба", () => {
  const now = Date.parse("2026-11-18T10:00:00Z");
  const base = { on: true, importedChangedAt: now - 60 * M };
  const d = (st, extra = {}) => PI.decidePromImport({ st, changedAt: now - 10 * M, now, ...extra });
  assert.equal(d({ on: false }).result, "OFF");
  assert.equal(PI.decidePromImport({ st: base, changedAt: 0, now }).result, "NO_FEED");
  assert.equal(d({ ...base, current: { id: "1", at: now - M } }).result, "RUNNING");
  assert.equal(d({ ...base, importedChangedAt: now - 10 * M }).result, "NO_CHANGES");
  assert.equal(d(base, { busy: "виконується «Оновити з Хорошопу»" }).result, "BUSY");
  assert.equal(d({ ...base, retryAt: now + M }).result, "PAUSE");
  assert.equal(d({ ...base, lastAt: now - 119 * M }).result, "GAP");
  assert.equal(d({ ...base, lastAt: now - 121 * M }).result, "START");
  assert.equal(d({ ...base, day: PI.kyivDay(now), count: 6 }).result, "LIMIT");
  const ok = d({ ...base, day: "2026-11-17", count: 6 });
  assert.equal(ok.result, "START"); assert.equal(ok.count, 0, "нова доба — лічильник з нуля");
  // Київська доба: 22:30 UTC 18.11 — уже 19.11 у Києві (UTC+2).
  assert.equal(PI.kyivDay(Date.parse("2026-11-18T22:30:00Z")), "2026-11-19");
  assert.equal(PI.kyivTime(Date.parse("2026-11-18T10:05:00Z")), "12:05");
});

test("автоімпорт: маршрут оператора — лише з ключем адміністратора", () => {
  const req = (key) => new Request("https://x/admin/prom-import", { method: "POST", headers: { authorization: "Bearer " + key } });
  assert.equal(roleFor(req(ENV.BUTTON_KEY), ENV), null);
  assert.equal(roleFor(req(ENV.ADMIN_KEY), ENV), "ADMIN_KEY");
});

test("автоімпорт у mm-ops: фід змінився → запуск (тіло й токен) → статус через ≥ 5 хв → нова зміна раніше 2 год — чекає → після 2 год — другий імпорт", { skip }, async () => {
  const c = { t: Date.parse("2026-11-18T08:00:00Z") };
  const calls = { post: [], status: [] };
  let statusReply = { status: "SUCCESS", total: 8, updated: 3, not_changed: 5, with_errors_count: 0 };
  let nextId = 77;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://my.prom.ua/api/v1/products/import_url") {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, "Bearer " + ENV.PROM_API_TOKEN);
      calls.post.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: String(nextId++), status: "success" }), { status: 200 });
    }
    if (u.startsWith("https://my.prom.ua/api/v1/products/import/status/")) { calls.status.push(u.split("/").pop()); return new Response(JSON.stringify(statusReply), { status: 200 }); }
    throw new Error("неочікувана адреса: " + u);
  };
  const storage = fakeStorage();
  const core = new OpsCore(storage, ENV, { now: () => c.t, fetchImpl });
  core.feed.putMeta({ ver: 1, count: 10, changedAt: c.t - 30 * M });

  // Вимкнено — alarm нічого не імпортує.
  await core.alarm();
  assert.equal(calls.post.length, 0);

  // Увімкнення — перший крок за хвилину; фід змінився (ще не імпортували) → запуск.
  const on = await core.fetch(new Request("https://x/admin/prom-import", { method: "POST", body: JSON.stringify({ action: "on" }) })).then((r) => r.json());
  assert.equal(on.on, true); assert.equal(on.decision, "запустився б зараз");
  assert.equal(await storage.getAlarm(), c.t + M);
  c.t += M;
  await core.alarm();
  assert.equal(calls.post.length, 1);
  assert.deepEqual(calls.post[0], PI.importBody(FEED_URL));
  let st = core.promImportGet();
  assert.equal(st.current.id, "77"); assert.equal(st.count, 1); assert.equal(st.last.result, "STARTED");
  assert.equal(await storage.getAlarm(), c.t + 5 * M, "статус — через 5 хв");
  assert.ok(core.status().last.some((x) => x.op === "prom-import" && x.status === "виконується"));

  // Через 5 хв — статус SUCCESS із лічильниками.
  c.t += 5 * M;
  await core.alarm();
  assert.deepEqual(calls.status, ["77"]);
  st = core.promImportGet();
  assert.equal(st.current, null); assert.equal(st.last.result, "SUCCESS");
  assert.match(st.last.message, /готово — оновлено 3, без змін 5, усього 8/);

  // Фід не змінився — нічого.
  c.t += 15 * M;
  await core.alarm();
  assert.equal(calls.post.length, 1); assert.equal(core.promImportGet().check.result, "NO_CHANGES");

  // Фід змінився раніше ніж через 2 год від першого імпорту — чекає (рядок у «Стані» каже, до котрої).
  core.feed.putMeta({ ...core.feed.meta(), changedAt: c.t });
  c.t += 15 * M;
  await core.alarm();
  assert.equal(calls.post.length, 1); assert.equal(core.promImportGet().check.result, "GAP");
  assert.ok(core.status().last.find((x) => x.op === "prom-import").summary.includes("чекає: попередній імпорт о 10:01"));

  // Минуло 2 год — другий імпорт.
  c.t = Date.parse("2026-11-18T08:01:00Z") + 121 * M;
  const due = core.promImportGet().nextAt; if (c.t < due) c.t = due;
  await core.alarm();
  assert.equal(calls.post.length, 2); assert.equal(core.promImportGet().count, 2);

  // Статус ще не готовий («в процесі») — повтор; 3 год без фінального статусу — завершено з невідомим результатом.
  statusReply = { status: "PROCESSING" };
  c.t += 5 * M; await core.alarm();
  assert.ok(core.promImportGet().current, "ще виконується");
  c.t += 181 * M; await core.alarm();
  st = core.promImportGet();
  assert.equal(st.current, null); assert.equal(st.last.result, "UNKNOWN");
});

test("автоімпорт у mm-ops: іде операція — імпорт чекає; Prom не приймає токен (403) — пауза 6 год і підказка; інша помилка — повтор за 30 хв", { skip }, async () => {
  const c = { t: Date.parse("2026-11-18T08:00:00Z") };
  let reply = { status: 403, body: { error: { status: 403, message: "Forbidden" } } };
  let posts = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.startsWith("https://api.github.com/")) return new Response(null, { status: 204 });
    if (u === "https://my.prom.ua/api/v1/products/import_url") { posts++; return new Response(JSON.stringify(reply.body), { status: reply.status }); }
    throw new Error("неочікувана адреса: " + u);
  };
  const storage = fakeStorage();
  const core = new OpsCore(storage, { ...ENV, PRICES_RUNNER: "github" }, { now: () => c.t, fetchImpl });
  core.feed.putMeta({ ver: 1, count: 10, changedAt: c.t - M });
  await core.promImportAdmin({ action: "on" });

  // Виконується «Оновити товари» — імпорт не запускається.
  assert.equal((await core.button({ op: "update" })).state, "STARTED");
  c.t += M; await core.alarm();
  assert.equal(posts, 0); assert.equal(core.promImportGet().check.result, "BUSY");
  const run = core.recentRuns(1)[0];
  core.runStart({ runId: run.id, op: "update" });
  await core.runFinish({ runId: run.id, ok: true, state: "DONE", summary: "" });
  core.metaDel("feed-job"); // збірку YML у цьому тесті не виконуємо

  // 403 — пауза 6 год і підказка про токен.
  c.t = core.promImportGet().nextAt; await core.alarm();
  assert.equal(posts, 1);
  let st = core.promImportGet();
  assert.equal(st.last.result, "START_FAILED"); assert.match(st.last.message, /перевірте токен Prom/);
  assert.equal(st.retryAt, c.t + 360 * M); assert.equal(st.count ?? 0, 0, "невдалий запуск не рахується в ліміт доби");
  c.t += 30 * M; await core.alarm();
  assert.equal(posts, 1, "у паузі — без запитів"); assert.equal(core.promImportGet().check.result, "PAUSE");

  // Оператор увімкнув ще раз (новий токен) — пауза знята, перевірка за хвилину.
  await core.promImportAdmin({ action: "on" });
  assert.equal(core.promImportGet().retryAt, 0); assert.equal(core.promImportGet().nextAt, c.t + M);

  // Інша помилка (Prom зайнятий) — повтор за 30 хв.
  c.t += M;
  reply = { status: 400, body: { error: { status: 400, message: "Import already in progress" } } };
  await core.alarm();
  assert.equal(posts, 2);
  st = core.promImportGet();
  assert.equal(st.retryAt, c.t + 30 * M); assert.doesNotMatch(st.last.message, /перевірте токен/);
});

test("автоімпорт у mm-ops: без токена не вмикається; фід щойно змінився (YML) — перевірка за хвилину, а не за 15", { skip }, async () => {
  const c = { t: Date.parse("2026-11-18T08:00:00Z") };
  const storage = fakeStorage();
  const bare = new OpsCore(fakeStorage(), { ...ENV, PROM_API_TOKEN: "" }, { now: () => c.t, fetchImpl: async () => { throw new Error("мережа не потрібна"); } });
  assert.equal((await bare.promImportAdmin({ action: "on" })).error.code, "NOT_READY");
  assert.equal(bare.promImportGet().on, false);

  const core = new OpsCore(storage, ENV, { now: () => c.t, fetchImpl: async () => { throw new Error("мережа не потрібна"); }, feedJobImpl: async () => ({ state: "SYNCED", patched: 2 }) });
  core.metaPut("prom-import", { on: true, nextAt: c.t + 15 * M });
  await core.runFeedQueued({ kind: "sync", reason: "тест" });
  assert.equal(core.promImportGet().nextAt, c.t + M);
  // Нічого не змінилось — розклад не чіпається.
  const core2 = new OpsCore(fakeStorage(), ENV, { now: () => c.t, fetchImpl: async () => { throw new Error("мережа не потрібна"); }, feedJobImpl: async () => ({ state: "SYNCED", patched: 0 }) });
  core2.metaPut("prom-import", { on: true, nextAt: c.t + 15 * M });
  await core2.runFeedQueued({ kind: "sync", reason: "тест" });
  assert.equal(core2.promImportGet().nextAt, c.t + 15 * M);
});

test("автоімпорт: PARTIAL — фінал лише коли оброблено всі позиції (18.11: спершу PARTIAL з нулями, потім 4 + 5468 = 5472)", () => {
  // 18.11 10:08: SUCCESS з нулями на початку обробки — ще не фінал; SUCCESS з повними лічильниками — фінал.
  assert.equal(PI.isFinal("SUCCESS", {}), false);
  assert.equal(PI.isFinal("SUCCESS", { total: 0, imported: 0, updated: 0, notChanged: 0, created: 0, withErrors: 0 }), false);
  assert.equal(PI.isFinal("SUCCESS", { total: 5472, imported: 390, updated: 390, notChanged: 5082, created: 0, withErrors: 0 }), true);
  assert.equal(PI.isFinal("SUCCESS", { total: 8, updated: 3, notChanged: 5, withErrors: 0 }), true, "без imported — за updated + created");
  assert.equal(PI.isFinal("FATAL", {}), true);
  assert.equal(PI.isFinal("PROCESSING", { total: 1, imported: 1 }), false);
  assert.equal(PI.isFinal("PARTIAL", { total: 5472, imported: 0, notChanged: 0, withErrors: 0 }), false);
  assert.equal(PI.isFinal("PARTIAL", { total: 5472, imported: 4, notChanged: 5468, withErrors: 0 }), true);
  assert.equal(PI.isFinal("PARTIAL", { total: 0 }), false);
  assert.equal(PI.statusText({ status: "PARTIAL", counts: { total: 5472, imported: 4, updated: 4, notChanged: 5468, created: 0, withErrors: 0 } }), "готово (статус Prom PARTIAL) — оновлено 4, без змін 5468, усього 5472");
});

test("автоімпорт у mm-ops: PARTIAL під час обробки — чекати далі; повні лічильники — завершено; «recheck» перечитує підсумок", { skip }, async () => {
  const c = { t: Date.parse("2026-11-18T01:53:00Z") };
  let reply = { status: "PARTIAL", total: 5472, imported: 0, updated: 0, not_changed: 0, with_errors_count: 0 };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith("/products/import_url")) return new Response(JSON.stringify({ id: "6afd", status: "success" }), { status: 200 });
    if (u.includes("/products/import/status/")) return new Response(JSON.stringify(reply), { status: 200 });
    throw new Error("неочікувана адреса: " + u);
  };
  const core = new OpsCore(fakeStorage(), ENV, { now: () => c.t, fetchImpl });
  core.feed.putMeta({ ver: 1, count: 5472, changedAt: c.t - M });
  await core.promImportAdmin({ action: "on" });
  c.t += M; await core.alarm();
  assert.equal(core.promImportGet().current.id, "6afd");
  c.t += 5 * M; await core.alarm();
  assert.ok(core.promImportGet().current, "PARTIAL з нулями — ще обробляється");
  reply = { status: "SUCCESS", total: 0, imported: 0, updated: 0, not_changed: 0, with_errors_count: 0 };
  c.t += 5 * M; await core.alarm();
  assert.ok(core.promImportGet().current, "SUCCESS з нулями (усього 0) — ще обробляється (18.11 10:08)");
  reply = { status: "PARTIAL", total: 5472, imported: 0, updated: 0, not_changed: 0, with_errors_count: 0 };
  reply = { ...reply, imported: 4, updated: 4, not_changed: 5468 };
  c.t += 5 * M; await core.alarm();
  let st = core.promImportGet();
  assert.equal(st.current, null); assert.equal(st.last.result, "PARTIAL");
  assert.match(st.last.message, /імпорт від 03:54: готово \(статус Prom PARTIAL\) — оновлено 4, без змін 5468, усього 5472/);
  // recheck: Prom згодом віддав інші лічильники — підсумок оновлюється; без завершеного імпорту — помилка.
  reply = { ...reply, status: "SUCCESS" };
  await core.promImportAdmin({ action: "recheck" });
  assert.match(core.promImportGet().last.message, /^імпорт від 03:54: готово — оновлено 4/);
  const bare = new OpsCore(fakeStorage(), ENV, { now: () => c.t, fetchImpl });
  assert.equal((await bare.promImportAdmin({ action: "recheck" })).error.code, "NOTHING");
});
