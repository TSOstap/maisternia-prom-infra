/** Автопошук новинок у mm-ops (рішення власника 03.11.2026): alarm Durable Object → ID фіду проти знімка «Знайти нові товари» →
 *  запуск тієї самої операції, що й кнопка. Мережі немає: фід і GitHub — підставні; SQL Durable Object — node:sqlite. */
import test from "node:test";
import assert from "node:assert/strict";
import { OpsCore } from "../workers/ops/src/ops-core.mjs";
import * as NI from "../workers/ops/src/new-items.mjs";
import { FIND_NEW_SEEN_KEY } from "../src/pipeline/find-new.mjs";
import { FEED_FILTER_PARAMS } from "../src/core/supplier-presence.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* старий Node — тести пропускаються */ }
const skip = DatabaseSync ? false : "немає node:sqlite";

const FEED = "https://market-tools.com.ua/products_feed.xml?hash_tag=x&group_ids=1,2&nested_group_ids=3&exclude_fields=&extra_fields=quantityInStock";
const xmlOf = (ids) => `<?xml version="1.0"?><yml_catalog date="2026-11-03 10:00"><shop><offers>\n${ids.map((id) => `<offer id="${id}" available="true"><name>Т ${id}</name></offer>`).join("\n")}\n</offers></shop></yml_catalog>`;
const BASE = Array.from({ length: 50 }, (_, i) => String(1_000_000_000 + i));
const seenOf = (ids, at, extra = {}) => ({ v: 1, ids: [...ids].sort(), count: ids.length, scope: "full", source: "market-tools.com.ua/products_feed.xml", seenAt: new Date(at).toISOString(), fetchedAt: new Date(at).toISOString(), ...extra });

test("автопошук: константи збігаються з основним кодом (ключ знімка, фільтр охоплення, параметри фіду лише з ID, дозволений хост)", () => {
  assert.equal(NI.FIND_NEW_SEEN_KEY, FIND_NEW_SEEN_KEY);
  assert.deepEqual([...NI.FILTER_PARAMS], [...FEED_FILTER_PARAMS]);
  const cfg = baseConfig;
  assert.deepEqual({ ...NI.ID_PARAMS }, cfg.supplier.operationalParams);
  assert.equal(NI.FEED_URL_RE.source.replace(/\\\//g, "/"), cfg.supplier.allowedUrlPattern.replace(/\\\//g, "/"));
});

test("автопошук: адреса лише з ID — фільтр груп знято (повний фід, як у «Знайти нові товари»), описи / фото / характеристики виключено", () => {
  const u = new URL(NI.idsFeedUrl(FEED));
  for (const p of ["group_ids", "nested_group_ids"]) assert.equal(u.searchParams.get(p), "");
  assert.equal(u.searchParams.get("exclude_fields"), "description,picture,param,keywords");
  assert.equal(u.searchParams.get("extra_fields"), "0");
  assert.equal(u.searchParams.get("hash_tag"), "x");
  assert.equal(u.host + u.pathname, NI.hostPath(FEED));
});

test("автопошук: розбір ID — повтори, обірваний документ, offer без ID → помилка", () => {
  assert.deepEqual([...NI.scanIds(xmlOf(["1", "2"]))], ["1", "2"]);
  assert.deepEqual([...NI.scanIds(`<yml_catalog><offers><offer available="true" id="7"></offer></offers></yml_catalog>`)], ["7"], "інший порядок атрибутів");
  assert.throws(() => NI.scanIds(xmlOf(["1", "1"])), /повторені/);
  assert.throws(() => NI.scanIds(xmlOf(["1", "2"]).slice(0, -20)), /неповний/);
  assert.throws(() => NI.scanIds(`<yml_catalog><offer group_id="5"></offer></yml_catalog>`), /без числового ID/);
});

test("автопошук: рішення — нових немає / нові ID / очікування стабільності / ліміти / пауза після невдачі / неповний фід / інший фід", () => {
  const now = Date.parse("2026-11-03T10:00:00Z"), M = 60_000;
  const ids = (extra = []) => new Set([...BASE, ...extra]);
  const seen = seenOf(BASE, now - 30 * M);
  assert.equal(NI.decideWatch({ seen, ids: ids(), now }).result, "NOTHING_NEW");
  const d = NI.decideWatch({ seen, ids: ids(["2000000001", "2000000002"]), now });
  assert.equal(d.result, "DISPATCH"); assert.equal(d.fresh, 2);
  // Новинки, що чекають стабільності: раніше 12 хв від знімка — чекати; після — повторний запуск; зникли з фіду — не чекають.
  const waitSeen = seenOf([...BASE, "2000000001"], now - 5 * M, { waiting: ["2000000001"] });
  assert.equal(NI.decideWatch({ seen: waitSeen, ids: ids(["2000000001"]), now }).result, "WAITING");
  assert.equal(NI.decideWatch({ seen: waitSeen, ids: ids(["2000000001"]), now: now + 8 * M }).result, "DISPATCH");
  assert.equal(NI.decideWatch({ seen: waitSeen, ids: ids(), now: now + 8 * M }).result, "NOTHING_NEW");
  // Ліміт доби, інтервал між автозапусками, пауза після невдалого автозапуску.
  const fresh = ids(["2000000003"]);
  assert.equal(NI.decideWatch({ seen, ids: fresh, now, w: { day: "2026-11-03", count: NI.WATCH.maxPerDay } }).result, "LIMIT");
  assert.equal(NI.decideWatch({ seen, ids: fresh, now, w: { day: "2026-11-02", count: 99 } }).result, "DISPATCH", "нова доба — лічильник з нуля");
  assert.equal(NI.decideWatch({ seen, ids: fresh, now, w: { lastDispatchAt: now - 5 * M } }).result, "GAP");
  assert.equal(NI.decideWatch({ seen, ids: fresh, now, lastAuto: { status: "FAILED", state: "ERROR", updated: now - 10 * M } }).result, "HOLD");
  assert.equal(NI.decideWatch({ seen, ids: fresh, now, lastAuto: { status: "DONE", state: "ABORTED", updated: now - 10 * M } }).result, "HOLD", "фід не пройшов перевірку в GitHub — теж пауза");
  assert.equal(NI.decideWatch({ seen, ids: fresh, now, lastAuto: { status: "DONE", state: "INTAKE_DONE", updated: now - 10 * M } }).result, "DISPATCH");
  assert.equal(NI.decideWatch({ seen, ids: fresh, now, lastAuto: { status: "FAILED", state: "ERROR", updated: now - 61 * M } }).result, "DISPATCH");
  assert.equal(NI.decideWatch({ seen, ids: new Set(BASE.slice(0, 30)), now }).result, "FEED_INCOMPLETE");
  // Передумови: немає адреси, немає знімка, знімок з іншого / фільтрованого фіду.
  assert.equal(NI.watchPrecheck({ seen, feedUrl: "" }).result, "NO_URL");
  assert.equal(NI.watchPrecheck({ seen, feedUrl: "https://evil.example/products_feed.xml" }).result, "NO_URL");
  assert.equal(NI.watchPrecheck({ seen: null, feedUrl: FEED }).result, "NO_BASE");
  assert.equal(NI.watchPrecheck({ seen: { ...seen, scope: "filtered" }, feedUrl: FEED }).result, "SOURCE_MISMATCH");
  assert.equal(NI.watchPrecheck({ seen: { ...seen, source: "market-tools.com.ua/other.xml" }, feedUrl: FEED }).result, "SOURCE_MISMATCH");
  assert.equal(NI.watchPrecheck({ seen, feedUrl: FEED }), null);
});

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
const ENV = { BUTTON_KEY: "b".repeat(32), RUNNER_KEY: "r".repeat(32), ADMIN_KEY: "a".repeat(32), GITHUB_TOKEN: "t".repeat(40), GITHUB_REPO: "TSOstap/maisternia-prom-infra", GITHUB_WORKFLOW: "ops.yml", GITHUB_REF: "main", SUPPLIER_FEED_URL: FEED };

test("автопошук у mm-ops: alarm → нові ID → запуск «Знайти нові товари» (автоматично); виконується — нового запуску немає; очікування стабільності → повтор через ≥ 12 хв; вимкнено — нічого", { skip }, async () => {
  const c = { t: Date.parse("2026-11-03T10:00:00Z") }, M = 60_000;
  const calls = { feed: [], github: [] };
  let feedIds = [...BASE, "2000000001"];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://market-tools.com.ua/")) { calls.feed.push(String(url)); assert.equal(init.redirect, "manual"); return new Response(xmlOf(feedIds), { status: 200 }); }
    if (String(url).startsWith("https://api.github.com/")) { calls.github.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error("неочікувана адреса: " + url);
  };
  const storage = fakeStorage();
  const core = new OpsCore(storage, ENV, { now: () => c.t, fetchImpl });
  core.tx(() => core.kv.set(FIND_NEW_SEEN_KEY, seenOf(BASE, c.t - 60 * M), "1"));

  // Вимкнено — alarm нічого не робить; разова перевірка (dry) — лише рішення, без запуску.
  await core.alarm();
  assert.equal(calls.feed.length, 0);
  const dry = await core.watchCheck(c.t, { dry: true });
  assert.equal(dry.result, "DISPATCH"); assert.equal(dry.fresh, 1); assert.equal(calls.github.length, 0);
  assert.ok(!new URL(calls.feed[0]).searchParams.get("group_ids"), "фід без фільтра груп");

  // Увімкнено: перша перевірка за хвилину; alarm → запуск find-new із міткою автозапуску; наступний alarm — через 15 хв.
  const on = await core.watchSwitch(true);
  assert.equal(on.on, true); assert.equal(on.alarmAt, c.t + M);
  c.t += M;
  await core.alarm();
  assert.equal(await storage.getAlarm(), c.t + NI.WATCH.everyMinutes * M);
  assert.equal(calls.github.length, 1); assert.equal(calls.github[0].inputs.op, "find-new");
  const run1 = core.recentRuns(1)[0];
  assert.equal(run1.by, NI.AUTO_BY); assert.equal(run1.label, "Знайти нові товари (автоматично)");
  assert.equal(core.watchGet().last.result, "DISPATCHED");

  // Запуск ще виконується — нового запуску немає, фід навіть не завантажується.
  const feedBefore = calls.feed.length;
  c.t += 15 * M;
  await core.alarm();
  assert.equal(core.watchGet().last.result, "BUSY"); assert.equal(calls.feed.length, feedBefore); assert.equal(calls.github.length, 1);

  // GitHub завершив перший запуск: новинка зафіксована у знімку й чекає стабільності.
  core.runStart({ runId: run1.id, op: "find-new" });
  core.runFinish({ runId: run1.id, ok: true, state: "WAITING_STABILITY", summary: "нові ID чекають стабільності (1)" });
  core.tx(() => core.kv.set(FIND_NEW_SEEN_KEY, seenOf(feedIds, c.t - 2 * M, { waiting: ["2000000001"] }), "2"));
  c.t += 5 * M;
  await core.alarm();
  assert.equal(core.watchGet().last.result, "WAITING", JSON.stringify(core.watchGet().last));
  c.t += 15 * M;
  await core.alarm();
  assert.equal(core.watchGet().last.result, "DISPATCHED"); assert.equal(calls.github.length, 2);

  // Другий запуск додав новинку — у знімку її більше немає в очікуванні; нових немає — запусків немає.
  const run2 = core.recentRuns(1)[0];
  core.runFinish({ runId: run2.id, ok: true, state: "INTAKE_DONE", summary: "додано 1" });
  core.tx(() => core.kv.set(FIND_NEW_SEEN_KEY, seenOf(feedIds, c.t, { waiting: [] }), "3"));
  c.t += 15 * M;
  await core.alarm();
  assert.equal(core.watchGet().last.result, "NOTHING_NEW"); assert.equal(calls.github.length, 2);
  assert.equal(core.watchGet().count, 2);

  // Стан для меню «Стан останньої операції»: рядок автоперевірки поруч із запусками.
  const st = core.status();
  assert.ok(st.last.some((x) => x.op === "watch" && /нових товарів у фіді немає/.test(x.summary)));

  // Постачальник обмежив частоту — пауза 30 хв без повторних запитів.
  feedIds = [...feedIds, "2000000002"];
  const busyFetch = async (url, init) => (String(url).startsWith("https://market-tools.com.ua/") ? (calls.feed.push(String(url)), new Response("", { status: 429 })) : fetchImpl(url, init));
  core.fetchImpl = busyFetch;
  c.t += 15 * M;
  await core.alarm();
  assert.equal(core.watchGet().last.result, "PAUSE");
  const n = calls.feed.length;
  c.t += 15 * M;
  await core.alarm();
  assert.equal(core.watchGet().last.result, "PAUSE"); assert.equal(calls.feed.length, n, "під час паузи фід не запитується");

  // Вимкнути — alarm видалено.
  const off = await core.watchSwitch(false);
  assert.equal(off.on, false); assert.equal(off.alarmAt, null);
});

test("автопошук у mm-ops: маршрути оператора лише з ключем адміністратора; кнопка не може ввімкнути автоперевірку", { skip }, async () => {
  const { roleFor } = await import("../workers/ops/src/ops-core.mjs");
  const req = (path, key) => new Request("https://ops.test" + path, { method: "POST", headers: { authorization: "Bearer " + key } });
  assert.equal(roleFor(req("/admin/watch", ENV.ADMIN_KEY), ENV), "ADMIN_KEY");
  assert.equal(roleFor(req("/admin/watch", ENV.BUTTON_KEY), ENV), null);
  assert.equal(roleFor(req("/admin/watch-check", ENV.RUNNER_KEY), ENV), null);
});
