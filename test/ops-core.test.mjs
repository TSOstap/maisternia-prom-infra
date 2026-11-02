/** ENG-29 — диспетчер кнопок «mm-ops» (Durable Object): запуск операцій, «уже виконується», сховище W2 через SQL, вхідні файли.
 *  SQL Durable Object імітується node:sqlite (той самий діалект SQLite; синхронний exec, transactionSync — BEGIN / COMMIT / ROLLBACK). */
import test from "node:test";
import assert from "node:assert/strict";
import { OpsCore, roleFor, ACTIVE_MS, sha256Hex } from "../workers/ops/src/ops-core.mjs";
import { RemoteStore } from "../src/pipeline/safe-write/store.mjs";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* старий Node — тести пропускаються */ }
const skip = DatabaseSync ? false : "немає node:sqlite";

function fakeStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    sql: {
      exec(q, ...b) {
        const st = db.prepare(q);
        if (/^\s*SELECT/i.test(q)) { const rows = st.all(...b); return { toArray: () => rows }; }
        st.run(...b);
        return { toArray: () => [] };
      },
    },
    transactionSync(fn) { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
}
const ENV = { BUTTON_KEY: "b".repeat(32), RUNNER_KEY: "r".repeat(32), ADMIN_KEY: "a".repeat(32), GITHUB_TOKEN: "t".repeat(40), GITHUB_REPO: "TSOstap/maisternia-prom-infra", GITHUB_WORKFLOW: "ops.yml", GITHUB_REF: "main" };
function setup({ github = () => new Response(null, { status: 204 }) } = {}) {
  const c = { t: 1_000_000_000_000 }, dispatched = [];
  const core = new OpsCore(fakeStorage(), ENV, { now: () => c.t, fetchImpl: async (url, init) => { dispatched.push({ url, init }); return github(url, init); } });
  const call = async (method, path, body, key) => {
    const req = new Request("https://ops.test" + path, { method, headers: { authorization: "Bearer " + key, "content-type": "application/json" }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    assert.ok(roleFor(req, ENV), "ключ має відповідати ролі шляху");
    const res = await core.fetch(req);
    return { status: res.status, headers: res.headers, data: res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => null) : await res.text() };
  };
  return { c, core, call, dispatched };
}

test("кнопка: запуск workflow ops.yml; повторне натискання під час виконання — «уже виконується»; після завершення — знову можна", { skip }, async () => {
  const { c, call, dispatched } = setup();
  const r1 = await call("POST", "/button", { op: "transfer" }, ENV.BUTTON_KEY);
  assert.equal(r1.data.state, "STARTED");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].url, "https://api.github.com/repos/TSOstap/maisternia-prom-infra/actions/workflows/ops.yml/dispatches");
  assert.deepEqual(JSON.parse(dispatched[0].init.body), { ref: "main", inputs: { op: "transfer", run_id: r1.data.runId } });
  assert.equal(dispatched[0].init.headers.authorization, "Bearer " + ENV.GITHUB_TOKEN);
  const r2 = await call("POST", "/button", { op: "update" }, ENV.BUTTON_KEY);
  assert.equal(r2.data.state, "BUSY");
  assert.match(r2.data.message, /Перенести затверджені/);
  assert.equal(dispatched.length, 1);
  await call("POST", "/run/start", { runId: r1.data.runId, op: "transfer", ghRunId: "123" }, ENV.RUNNER_KEY);
  assert.equal((await call("GET", "/status", undefined, ENV.BUTTON_KEY)).data.active.status, "RUNNING");
  await call("POST", "/run/finish", { runId: r1.data.runId, ok: true, state: "TRANSFERRED", summary: "Перенесено 3 товари" }, ENV.RUNNER_KEY);
  const st = (await call("GET", "/status", undefined, ENV.BUTTON_KEY)).data;
  assert.equal(st.active, null);
  assert.equal(st.last[0].status, "DONE");
  assert.equal(st.last[0].summary, "Перенесено 3 товари");
  c.t += 1000;
  assert.equal((await call("POST", "/button", { op: "update" }, ENV.BUTTON_KEY)).data.state, "STARTED");
  // Завислий запуск (без звісток довше ACTIVE_MS) кнопку не блокує назавжди.
  c.t += ACTIVE_MS + 1;
  assert.equal((await call("POST", "/button", { op: "find-new" }, ENV.BUTTON_KEY)).data.state, "STARTED");
  assert.equal((await call("POST", "/button", { op: "delete-all" }, ENV.BUTTON_KEY)).data.state, "ERROR");
});

test("кнопка: GitHub відмовив — ERROR з причиною, запуск DISPATCH_FAILED, наступне натискання не блокується", { skip }, async () => {
  const { call } = setup({ github: () => new Response("{}", { status: 401 }) });
  const r = await call("POST", "/button", { op: "transfer" }, ENV.BUTTON_KEY);
  assert.equal(r.data.state, "ERROR");
  assert.match(r.data.message, /GitHub HTTP 401/);
  const st = (await call("GET", "/status", undefined, ENV.BUTTON_KEY)).data;
  assert.equal(st.active, null);
  assert.equal(st.last[0].status, "DISPATCH_FAILED");
});

test("ключі за ролями: кнопка не має доступу до W2 / вхідних файлів / адміністрування; запускач — до адміністрування", () => {
  const req = (path, key) => new Request("https://ops.test" + path, { headers: { authorization: "Bearer " + key } });
  assert.equal(roleFor(req("/button", ENV.BUTTON_KEY), ENV), "BUTTON_KEY");
  assert.equal(roleFor(req("/w2", ENV.BUTTON_KEY), ENV), null);
  assert.equal(roleFor(req("/inputs/owner-values", ENV.BUTTON_KEY), ENV), null);
  assert.equal(roleFor(req("/admin/w2-dump", ENV.RUNNER_KEY), ENV), null);
  assert.equal(roleFor(req("/w2", ENV.RUNNER_KEY), ENV), "RUNNER_KEY");
  assert.equal(roleFor(req("/admin/w2-seed", ENV.ADMIN_KEY), ENV), "ADMIN_KEY");
  assert.equal(roleFor(req("/button", ""), { ...ENV, BUTTON_KEY: "" }), null);
  assert.equal(roleFor(req("/other", ENV.ADMIN_KEY), ENV), null);
});

test("W2 через Durable Object (SQL): RemoteStore → /w2 — оренда, BUSY, шлюз запису, ідемпотентний повтор після втраченої відповіді", { skip }, async () => {
  const { core } = setup();
  let lose = 0;
  const fetchImpl = async (url, init) => {
    const res = await core.fetch(new Request(url, init));
    if (lose > 0) { lose--; throw new TypeError("fetch failed"); }
    return res;
  };
  const store = new RemoteStore({ url: "https://ops.test", key: ENV.RUNNER_KEY, fetchImpl, sleep: async () => {} });
  const c = { t: 5_000 };
  const cm = createCommitter({ store, now: () => c.t, ttlMs: 1000, settleMs: 0 });
  lose = 1; // відповідь на видачу оренди втрачено — повтор не видає другу оренду
  const a = await cm.acquire("sync");
  assert.equal(a.token, 1);
  await assert.rejects(cm.acquire("intake"), (e) => e.code === "BUSY");
  await a.release();
  const sheets = new MemorySheets({ "Аркуш": [["ID", "Ціна"], ["1", "10"]] });
  const gw = new WriteGateway({ sheets, read: async () => structuredClone(sheets.book), store, now: () => c.t, ttlMs: 60_000, settleMs: 0 });
  const s = await gw.open({ writer: "sync" });
  assert.equal(s.state, "READY");
  await s.sheets.updateRanges([{ title: "Аркуш", row: 2, col: 2, values: [["11"]] }]);
  await s.close();
  assert.equal(sheets.book["Аркуш"][1][1], "11");
  const lease = (await store.getJsonVersioned("state/write-lease/sheets-main.json")).value;
  assert.equal(lease.token, 2);
  assert.equal(lease.released, true);
});

test("W2: значення понад межу рядка SQLite (журнал операцій) зберігається частинами й читається цілим; менше значення прибирає частини", { skip }, async () => {
  const { core } = setup();
  const store = new RemoteStore({ url: "https://ops.test", key: ENV.RUNNER_KEY, fetchImpl: async (url, init) => core.fetch(new Request(url, init)), sleep: async () => {} });
  const big = { entries: Array.from({ length: 3000 }, (_, i) => ({ i, text: "Опис товару українською ".repeat(20) })) };
  assert.ok(JSON.stringify(big).length > 1_000_000);
  const v1 = (await store.putJsonIfVersion("state/write-journal/sheets-main.json", big, null)).version;
  assert.deepEqual((await store.getJsonVersioned("state/write-journal/sheets-main.json")).value, big);
  assert.ok(core.rows("SELECT COUNT(*) AS n FROM w2_chunk")[0].n >= 3);
  await store.putJsonIfVersion("state/write-journal/sheets-main.json", { entries: [] }, v1);
  assert.deepEqual((await store.getJsonVersioned("state/write-journal/sheets-main.json")).value, { entries: [] });
  assert.equal(core.rows("SELECT COUNT(*) AS n FROM w2_chunk")[0].n, 0);
});

test("вхідні файли й перенесення стану W2: SHA-256 на сервері, лише в порожнє сховище, вивантаження для звірки", { skip }, async () => {
  const { call } = setup();
  const body = JSON.stringify({ v: 1, owner: "значення" });
  const put = await call("PUT", "/admin/inputs/owner-values", body, ENV.ADMIN_KEY);
  assert.equal(put.data.result.sha256, await sha256Hex(body));
  const got = await call("GET", "/inputs/owner-values", undefined, ENV.RUNNER_KEY);
  assert.equal(JSON.stringify(got.data), body);
  assert.equal(got.headers.get("x-sha256"), put.data.result.sha256);
  assert.equal((await call("GET", "/inputs/none", undefined, ENV.RUNNER_KEY)).status, 404);
  assert.equal((await call("PUT", "/admin/inputs/Bad_Name", body, ENV.ADMIN_KEY)).data.error.code, "BAD_REQUEST");
  const entries = [{ key: "state/run-plan/current.json", value: { status: "DONE" }, version: "4" }, { key: "state/write-lease/sheets-main.json", value: { token: 9, released: true }, version: "12" }];
  assert.equal((await call("POST", "/admin/w2-seed", { entries }, ENV.ADMIN_KEY)).data.result.seeded, 2);
  assert.equal((await call("POST", "/admin/w2-seed", { entries }, ENV.ADMIN_KEY)).status, 409);
  const dump = (await call("GET", "/admin/w2-dump", undefined, ENV.ADMIN_KEY)).data.entries;
  assert.deepEqual(dump, [...entries].sort((x, y) => x.key.localeCompare(y.key)));
});
