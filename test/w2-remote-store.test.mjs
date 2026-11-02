/** ENG-29 (переїзд на сервер) — сховище W2 у Durable Object: клієнт RemoteStore (store.mjs) + серверне ядро w2-engine.mjs.
 *  Вимога: та сама поведінка, що MemoryStore / FileStore (cc-store-v1, fencing, печатки, квитки), плюс ідемпотентні повтори. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore, RemoteStore, SEALED_CHECKPOINT_KEY, SERVING_HEAD_KEY } from "../src/pipeline/safe-write/store.mjs";
import { w2Handle, w2Seed } from "../src/pipeline/safe-write/w2-engine.mjs";
import { createCommitter, leaseKeyOf } from "../src/pipeline/safe-write/committer.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { jcsHash } from "../src/pipeline/safe-write/jcs.mjs";
import { w2Coordinator } from "../src/pipeline/production.mjs";

const KEY = "k".repeat(32);
/** Сховище сервера в пам'яті — та сама форма, що SQL-адаптер Durable Object. */
export function memKv() {
  const m = new Map(), req = new Map();
  return {
    m, req,
    get: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    set: (k, value, version) => m.set(k, JSON.stringify({ value, version })),
    getReq: (id) => (req.has(id) ? JSON.parse(req.get(id)) : null),
    putReq: (id, at, res) => req.set(id, JSON.stringify(res)),
    count: () => m.size,
  };
}
/** Сервер /w2: ключ, JSON, w2Handle. faults: масив дій на кожен виклик ("drop-before" — запит не дійшов, "drop-after" — застосовано,
 *  відповідь втрачено, "500" — сервер відповів 500 без виконання). */
function server(kv, { faults = [], key = KEY } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const f = faults.shift();
    calls.push({ url, f });
    if (f === "drop-before") throw new TypeError("fetch failed");
    if (f === "500") return new Response("{}", { status: 500 });
    if (init.headers.authorization !== "Bearer " + key) return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "немає доступу" } }), { status: 401 });
    const res = w2Handle(kv, JSON.parse(init.body));
    if (f === "drop-after") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(res), { status: res.error && res.error.code === "BAD_REQUEST" ? 400 : 200 });
  };
  return { fetchImpl, calls };
}
const remote = (kv, o = {}) => { const s = server(kv, o); const st = new RemoteStore({ url: "https://w2.test", key: o.clientKey ?? KEY, fetchImpl: s.fetchImpl, sleep: async () => {} }); st.calls = s.calls; return st; };
const clock = (t0 = 1_000_000) => { const c = { t: t0, now: () => c.t }; return c; };
const codeOf = async (p) => { try { return { ok: await p }; } catch (e) { return { code: e.code || e.name, fencing: e.fencing || false }; } };

test("RemoteStore = MemoryStore: CAS, версії, копії значень, INVALID_KEY, печатки (диференційна перевірка на 400 випадкових операціях)", async () => {
  const rnd = (() => { let x = 12345; return (n) => { x = (x * 1103515245 + 12345) % 2 ** 31; return x % n; }; })();
  const mem = new MemoryStore(), rem = remote(memKv());
  const keys = ["state/a.json", "state/b.json", "STATE/a.json", "state/../x", SEALED_CHECKPOINT_KEY, SERVING_HEAD_KEY, "State/Catalog-Controls/checkpoint.json"];
  const versions = { mem: {}, rem: {} };
  for (let i = 0; i < 400; i++) {
    const k = keys[rnd(keys.length)], kind = rnd(3), val = { i, n: [rnd(9)] };
    if (kind === 0) {
      const a = await codeOf(mem.getJsonVersioned(k)), b = await codeOf(rem.getJsonVersioned(k));
      assert.deepEqual(b.code, a.code, `get ${k}`);
      if (a.ok) { assert.deepEqual(b.ok.value, a.ok.value); assert.equal(b.ok.version === null, a.ok.version === null); versions.mem[k] = a.ok.version; versions.rem[k] = b.ok.version; }
    } else {
      const stale = kind === 2;
      const vm = stale ? "999" : versions.mem[k] ?? null, vr = stale ? "999" : versions.rem[k] ?? null;
      const a = await codeOf(mem.putJsonIfVersion(k, val, vm)), b = await codeOf(rem.putJsonIfVersion(k, val, vr));
      assert.equal(b.code, a.code, `put ${k} (${stale ? "застаріла версія" : "чинна"})`);
      if (a.ok) { versions.mem[k] = a.ok.version; versions.rem[k] = b.ok.version; }
    }
  }
  // Значення копіюються: зміна прочитаного об'єкта не змінює збереженого.
  const r = await rem.getJsonVersioned("state/a.json");
  if (r.value) { r.value.i = -1; assert.notEqual((await rem.getJsonVersioned("state/a.json")).value.i, -1); }
});

test("оренда через RemoteStore: BUSY для другого записувача, fencing застарілої оренди (STALE_LEASE), scope, release", async () => {
  const c = clock(), st = remote(memKv());
  const cm = createCommitter({ store: st, now: c.now, ttlMs: 1000, settleMs: 0 });
  const a = await cm.acquire("sync");
  await assert.rejects(cm.acquire("intake"), (e) => e.code === "BUSY");
  const fence = { leaseKey: a.leaseKey, token: a.token, leaseId: a.leaseId, scope: "sync" };
  assert.deepEqual(await st.putJsonIfVersionFenced("state/run-plan/current.json", { x: 1 }, null, fence), { version: "1" });
  await assert.rejects(st.putJsonIfVersionFenced("state/run-plan/current.json", { x: 2 }, "1", { ...fence, scope: "intake" }), (e) => e.code === "STALE_LEASE" && e.fencing === true);
  await assert.rejects(st.putJsonIfVersionFenced("state/run-plan/current.json", { x: 2 }, "1", { ...fence, leaseId: "0".repeat(32) }), (e) => e.code === "STALE_LEASE");
  await a.release();
  await assert.rejects(st.putJsonIfVersionFenced("state/run-plan/current.json", { x: 2 }, "1", fence), (e) => e.code === "STALE_LEASE" && /звільнено/.test(e.message));
  c.t += 5000;
  const b = await cm.acquire("intake");
  assert.equal(b.token, a.token + 1);
  await assert.rejects(st.putJsonIfVersionFenced("state/run-plan/current.json", { x: 3 }, "1", fence), (e) => e.code === "STALE_LEASE");
  await assert.rejects(st.putJsonIfVersionFenced(a.leaseKey, {}, null, { leaseKey: a.leaseKey, token: b.token }), /ключ оренди не можна писати/);
});

test("контрольна точка CC: лише з квитком столу цього процесу; погашений / чужий / сплила оренда → CC_TICKET_REJECTED; без квитка → CC_KEY_SEALED", async () => {
  const c = clock(), kv = memKv(), st = remote(kv);
  const cm = createCommitter({ store: st, now: c.now, ttlMs: 1000, settleMs: 0 });
  const desk = st.claimDesk({ now: c.now }); desk.bind("feeds");
  assert.throws(() => st.claimDesk({ now: c.now }), (e) => e.code === "DESK_CLAIMED");
  const l = await cm.acquire("catalog-controls");
  const value = { checkpoint: 1 };
  const ticket = { v: 1, key: SEALED_CHECKPOINT_KEY, nextHash: jcsHash(value), expectedVersion: null, leaseToken: l.token, leaseId: l.leaseId, phase: "intents", nonce: crypto.randomBytes(16).toString("hex"), notAfter: l.expiresAt };
  desk.registerTicket(ticket);
  const fence = { leaseKey: l.leaseKey, token: l.token, leaseId: l.leaseId, scope: l.scope };
  await assert.rejects(st.putJsonIfVersion(SEALED_CHECKPOINT_KEY, value, null), (e) => e.code === "CC_KEY_SEALED");
  await assert.rejects(st.putJsonIfVersionFenced(SEALED_CHECKPOINT_KEY, value, null, fence), (e) => e.code === "CC_KEY_SEALED");
  await assert.rejects(st.putJsonIfVersionFenced(SEALED_CHECKPOINT_KEY, { other: 1 }, null, { ...fence, ticket }), (e) => e.code === "CC_TICKET_REJECTED" && e.reasons.some((r) => /nextHash/.test(r)));
  assert.deepEqual(await st.putJsonIfVersionFenced(SEALED_CHECKPOINT_KEY, value, null, { ...fence, ticket }), { version: "1" });
  await assert.rejects(st.putJsonIfVersionFenced(SEALED_CHECKPOINT_KEY, value, "1", { ...fence, ticket }), (e) => e.code === "CC_TICKET_REJECTED"); // погашений
  // Інший процес (інший екземпляр RemoteStore над тим самим сервером) квитка не знає.
  const other = remote(kv); other.claimDesk({ now: c.now });
  const t2 = { ...ticket, nonce: crypto.randomBytes(16).toString("hex"), expectedVersion: "1", nextHash: jcsHash({ checkpoint: 2 }) };
  desk.registerTicket(t2);
  await assert.rejects(other.putJsonIfVersionFenced(SEALED_CHECKPOINT_KEY, { checkpoint: 2 }, "1", { ...fence, ticket: t2 }), (e) => e.code === "CC_TICKET_REJECTED");
  // Сплила оренда — перевіряє сервер атомарно з CAS.
  c.t = l.expiresAt;
  const t3 = { ...t2, nonce: crypto.randomBytes(16).toString("hex"), notAfter: l.expiresAt + 10_000 };
  desk.registerTicket(t3);
  await assert.rejects(st.putJsonIfVersionFenced(SEALED_CHECKPOINT_KEY, { checkpoint: 2 }, "1", { ...fence, ticket: t3 }), (e) => e.code === "CC_TICKET_REJECTED" && /сплила/.test(e.message + e.reasons));
  assert.equal(kv.get(SEALED_CHECKPOINT_KEY).version, "1");
});

test("head протоколу serving — лише через стіл (putHead) з чинною орендою й leaseId; сирий запис → CC_KEY_SEALED", async () => {
  const c = clock(), st = remote(memKv());
  const cm = createCommitter({ store: st, now: c.now, ttlMs: 1000, settleMs: 0 });
  const desk = st.claimDesk({ now: c.now }); desk.bind("feeds");
  const l = await cm.acquire("catalog-controls");
  await assert.rejects(st.putJsonIfVersion(SERVING_HEAD_KEY, {}, null), (e) => e.code === "CC_KEY_SEALED");
  await assert.rejects(st.putJsonIfVersionFenced(SERVING_HEAD_KEY, {}, null, { leaseKey: l.leaseKey, token: l.token, leaseId: l.leaseId }), (e) => e.code === "CC_KEY_SEALED");
  assert.deepEqual(await desk.putHead({ epochHigh: 1 }, null, { leaseKey: l.leaseKey, token: l.token, leaseId: l.leaseId }), { version: "1" });
  await assert.rejects(desk.putHead({ epochHigh: 2 }, "1", { leaseKey: l.leaseKey, token: l.token }), (e) => e.code === "CC_KEY_SEALED");
  await l.release();
  await assert.rejects(desk.putHead({ epochHigh: 2 }, "1", { leaseKey: l.leaseKey, token: l.token, leaseId: l.leaseId }), (e) => e.code === "STALE_LEASE");
});

test("ідемпотентність: відповідь втрачено після запису → повтор з тим самим reqId повертає збережену відповідь, запис один", async () => {
  const kv = memKv(), st = remote(kv, { faults: ["drop-after"] });
  assert.deepEqual(await st.putJsonIfVersion("state/a.json", { a: 1 }, null), { version: "1" });
  assert.equal(st.calls.length, 2);
  assert.equal(kv.get("state/a.json").version, "1");
  // CAS-відмова теж зберігається: повтор не перетворює CONFLICT на успіх.
  const st2 = remote(kv, { faults: ["drop-after"] });
  await assert.rejects(st2.putJsonIfVersion("state/a.json", { a: 2 }, null), (e) => e.code === "CONFLICT");
  assert.equal(kv.get("state/a.json").value.a, 1);
});

test("недоступне сховище: 500 / мережа — повтори, потім W2_UNAVAILABLE; хибний ключ — відмова без повторів; нічого не записано", async () => {
  const kv = memKv();
  const ok = remote(kv, { faults: ["500", "drop-before"] });
  assert.deepEqual(await ok.putJsonIfVersion("state/a.json", { a: 1 }, null), { version: "1" });
  const down = remote(kv, { faults: ["500", "500", "drop-before", "500"] });
  await assert.rejects(down.putJsonIfVersion("state/a.json", { a: 2 }, "1"), (e) => e.code === "W2_UNAVAILABLE");
  const bad = remote(kv, { clientKey: "x".repeat(32) });
  await assert.rejects(bad.getJsonVersioned("state/a.json"), (e) => e.code === "UNAUTHORIZED");
  assert.equal(bad.calls.length, 1);
  assert.equal(kv.get("state/a.json").version, "1");
  assert.throws(() => new RemoteStore({ url: "http://w2.test", key: KEY }), /https/);
  assert.throws(() => new RemoteStore({ url: "https://w2.test", key: "short" }), /ключа/);
});

test("WriteGateway над RemoteStore: сесія (оренда + журнал операцій + fencing) пише в таблицю й закривається так само, як над MemoryStore", async () => {
  const run = async (store) => {
    const sheets = new MemorySheets({ "Аркуш": [["ID", "Ціна"], ["1", "10"]] });
    const c = clock();
    const gw = new WriteGateway({ sheets, read: async () => structuredClone(sheets.book), store, now: c.now, ttlMs: 60_000, settleMs: 0 });
    const s = await gw.open({ writer: "sync" });
    assert.equal(s.state, "READY");
    await s.sheets.updateRanges([{ title: "Аркуш", row: 2, col: 2, values: [["11"]] }]);
    await s.close();
    const again = await gw.open({ writer: "intake" });
    assert.equal(again.state, "READY");
    await again.close();
    return { book: sheets.book, lease: (await store.getJsonVersioned(leaseKeyOf("sheets-main"))).value };
  };
  const a = await run(new MemoryStore()), b = await run(remote(memKv()));
  assert.deepEqual(b.book, a.book);
  assert.equal(b.lease.token, a.lease.token);
  assert.equal(b.lease.released, true);
});

test("перенесення стану з FileStore (w2Seed): лише в порожнє сховище, версії збережено, далі CAS від тих самих версій", () => {
  const kv = memKv();
  assert.equal(w2Seed(kv, [{ key: "state/a.json", value: { a: 1 }, version: "7" }, { key: SEALED_CHECKPOINT_KEY, value: { p: 1 }, version: "3" }]).result.seeded, 2);
  assert.equal(w2Seed(kv, [{ key: "state/b.json", value: {}, version: "1" }]).error.code, "NOT_EMPTY");
  assert.equal(w2Seed(memKv(), [{ key: "STATE/a.json", value: {}, version: "1" }]).error.code, "INVALID_KEY");
  assert.equal(w2Seed(memKv(), [{ key: "state/a.json", value: {}, version: 1 }]).error.code, "BAD_REQUEST");
  const r = w2Handle(kv, { op: "cas", key: "state/a.json", value: { a: 2 }, version: "7", reqId: "a".repeat(32) });
  assert.deepEqual(r.result, { version: "8" });
});

test("координатор W2: режим do (адреса https + ключ) дозволений і в GitHub Actions; однохостовий — ні; після перенесення (MOVED-TO-DO.json) однохостовий запис заборонено", () => {
  assert.deepEqual(w2Coordinator({ GITHUB_ACTIONS: "true", MM_W2_MODE: "do", MM_W2_URL: "https://ops.example", MM_W2_KEY: KEY }), { kind: "durable-object", url: "https://ops.example", key: KEY });
  assert.throws(() => w2Coordinator({ MM_W2_MODE: "do", MM_W2_URL: "http://ops.example", MM_W2_KEY: KEY }), /MM_W2_URL/);
  assert.throws(() => w2Coordinator({ MM_W2_MODE: "do", MM_W2_URL: "https://ops.example", MM_W2_KEY: "x" }), /MM_W2_KEY/);
  assert.throws(() => w2Coordinator({ GITHUB_ACTIONS: "true", MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: "x" }), /GitHub Actions/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-w2-moved-"));
  assert.equal(w2Coordinator({ MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: dir }).kind, "single-host-file");
  fs.writeFileSync(path.join(dir, "MOVED-TO-DO.json"), "{}");
  assert.throws(() => w2Coordinator({ MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: dir }), /Durable Object/);
});
