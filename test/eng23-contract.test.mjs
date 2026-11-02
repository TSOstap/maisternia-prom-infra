/** ENG-23 — узгоджений контракт CC ↔ Engineering F04 / F06 / F08 (E1–E6 + E10 для дзеркала), рядки матриці розд. 8 з позначкою
 *  «Engineering»: leaseId і межа епох, печатка ключа точки й head, квитки beforeCommit (атомарно з CAS), fencing за leaseId,
 *  дзеркало реєстру поза публічним Worker. Без модуля CC. Модель — один хост; прямі зміни файлів — поза моделлю загроз (Q6). */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore, FileStore, SEALED_CHECKPOINT_KEY, SERVING_HEAD_KEY } from "../src/pipeline/safe-write/store.mjs";
import { createCommitter, leaseKeyOf } from "../src/pipeline/safe-write/committer.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { jcs, jcsHash } from "../src/pipeline/safe-write/jcs.mjs";
import { epochFloor } from "../src/pipeline/safe-write/epoch-floor.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { fenceFeeds, REGISTRY_KEY, FENCED_STATE_KEYS } from "../src/publish/feed-fence.mjs";
import { manifestKey, servedChain, rollbackFeed } from "../src/publish/publisher.mjs";
import worker from "../worker/src/index.js";
import { r2BindingFrom } from "./helpers/r2-fake.mjs";

const tmp = (p) => fsp.mkdtemp(path.join(os.tmpdir(), p));
const clock = (t0 = 1_000_000) => { const c = { t: t0, now: () => c.t }; return c; };
const CK = SEALED_CHECKPOINT_KEY;
const deskOf = (store, now) => { const d = store.claimDesk({ now }); d.bind("test-feeds"); return d; };
const ticketFor = (desk, lease, value, expectedVersion, over = {}) => {
  const t = { v: 1, key: CK, nextHash: jcsHash(value), expectedVersion, leaseToken: lease.token, leaseId: lease.leaseId, phase: "intents", nonce: crypto.randomBytes(16).toString("hex"), notAfter: lease.expiresAt, ...over };
  desk.registerTicket(t);
  return t;
};
const fenceOf = (lease, ticket) => ({ leaseKey: lease.leaseKey, token: lease.token, leaseId: lease.leaseId, scope: lease.scope, ...(ticket ? { ticket } : {}) });

// ---------- E1 / F04 ----------
test("E1: leaseId — 32 hex, новий на кожну видачу, у записі оренди; assertCurrent / renew / release звіряють і leaseId (підміна запису з тим самим токеном → STALE)", async () => {
  const c = clock(), st = new MemoryStore(), cm = createCommitter({ store: st, now: c.now, ttlMs: 1000, settleMs: 0 });
  const ids = new Set();
  for (let i = 0; i < 5; i++) { const l = await cm.acquire("sync"); assert.match(l.leaseId, /^[0-9a-f]{32}$/); assert.equal(l.generation, 0); ids.add(l.leaseId); await l.release(); }
  assert.equal(ids.size, 5);
  const l = await cm.acquire("catalog-controls");
  const rec = await st.getJsonVersioned(leaseKeyOf("sheets-main"));
  assert.equal(rec.value.leaseId, l.leaseId);
  assert.equal(rec.value.expiresAt, l.expiresAt);
  await st.putJsonIfVersion(leaseKeyOf("sheets-main"), { ...rec.value, leaseId: "0".repeat(32) }, rec.version); // запис оренди з тим самим токеном, інший leaseId
  await assert.rejects(l.assertCurrent(), (e) => e.code === "STALE");
  await assert.rejects(l.renew(), (e) => e.code === "STALE");
  await assert.rejects(l.release(), (e) => e.code === "STALE");
});

test("F04-3: рівна епоха з ІНШИМ leaseId — STALE_EPOCH навіть за однакових scope і at; F04-2: повтор власного fencing після «втраченої» відповіді — тим самим leaseId — проходить", async () => {
  const s = new LocalObjectStore(await tmp("mm-e23-f04-"));
  const NativeDate = globalThis.Date, at = NativeDate.now();
  globalThis.Date = class extends NativeDate { constructor(...a) { super(...(a.length ? a : [at])); } static now() { return at; } };
  try {
    const lease = (token, leaseId = crypto.randomBytes(16).toString("hex")) => ({ token, leaseId, scope: "catalog-controls", assertCurrent: async () => {} });
    await fenceFeeds({ store: s, feeds: ["main"], lease: lease(2), scope: "catalog-controls" });
    await assert.rejects(fenceFeeds({ store: s, feeds: ["main"], lease: lease(2), scope: "catalog-controls" }), (e) => e.code === "STALE_EPOCH", "той самий штамп { epoch, scope, at } іншої видачі — не повтор");
    const own = lease(3);
    const raw = s.putJson.bind(s);
    let lost = false;
    s.putJson = async (k, v, o) => { const r = await raw(k, v, o); if (!lost && k === manifestKey("main") && o?.ifMatch !== undefined) { lost = true; throw Object.assign(new Error("412 (втрачена відповідь)"), { code: "PRECONDITION_FAILED" }); } return r; };
    await fenceFeeds({ store: s, feeds: ["main"], lease: own, scope: "catalog-controls" });
    s.putJson = raw;
    assert.ok(lost);
    assert.deepEqual({ epoch: (await s.getJson(manifestKey("main"))).fence.epoch, leaseId: (await s.getJson(manifestKey("main"))).fence.leaseId }, { epoch: 3, leaseId: own.leaseId });
    await assert.rejects(fenceFeeds({ store: s, feeds: ["main"], lease: { token: 4, scope: "x", assertCurrent: async () => {} } }), (e) => e.code === "NO_LEASE", "без leaseId fencing неможливий");
  } finally { globalThis.Date = NativeDate; }
});

test("F04-4: Date.now — константа, потім назад, протягом 50 оренд: токени строго зростають, fencing кожної оренди проходить (хибних STALE немає)", async () => {
  const c = clock(5_000_000), st = new MemoryStore(), feeds = new LocalObjectStore(await tmp("mm-e23-f044-"));
  const cm = createCommitter({ store: st, now: c.now, ttlMs: 60_000, settleMs: 0 });
  const NativeDate = globalThis.Date, at = NativeDate.now();
  globalThis.Date = class extends NativeDate { constructor(...a) { super(...(a.length ? a : [at])); } static now() { return at; } };
  const tokens = [];
  try {
    for (let i = 0; i < 50; i++) {
      if (i === 25) c.t -= 30_000; // годинник «назад»
      const l = await cm.acquire(i % 2 ? "publisher" : "catalog-controls");
      await fenceFeeds({ store: feeds, feeds: ["main"], lease: l, scope: l.scope });
      tokens.push(l.token);
      await l.release();
    }
  } finally { globalThis.Date = NativeDate; }
  for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i] > tokens[i - 1]);
  assert.equal((await feeds.getJson(manifestKey("main"))).fence.epoch, tokens.at(-1));
});

// ---------- E2: межа епох ----------
test("E2: межа епох = max(head W2, епохи fencing маніфестів і FENCED_STATE_KEYS, дзеркало реєстру); токен у записі нижчий за межу → RECOVERY_PENDING, запис оренди не змінено", async () => {
  const c = clock(), st = new MemoryStore(), feeds = new LocalObjectStore(await tmp("mm-e23-floor-"));
  assert.deepEqual(FENCED_STATE_KEYS, ["state/operational.json", REGISTRY_KEY]);
  const cm = createCommitter({ store: st, now: c.now, ttlMs: 1000, settleMs: 0 });
  for (let i = 0; i < 3; i++) { const l = await cm.acquire("sync"); await l.release(); }
  assert.equal((await epochFloor({ w2Store: st, feedStore: feeds, feeds: ["main"] })).floor, 0);
  await feeds.putJson(REGISTRY_KEY, { v: 1, epochHigh: 7 });
  await feeds.putJson(manifestKey("main"), { fence: { epoch: 5 } });
  const f = await epochFloor({ w2Store: st, feedStore: feeds, feeds: ["main"] });
  assert.equal(f.floor, 7);
  assert.deepEqual(f.parts.fences[manifestKey("main")], 5);
  const before = await st.getJsonVersioned(leaseKeyOf("sheets-main"));
  await assert.rejects(cm.acquire("catalog-controls", { floor: f.floor }), (e) => e.code === "RECOVERY_PENDING");
  assert.deepEqual(await st.getJsonVersioned(leaseKeyOf("sheets-main")), before, "лічильник не піднято мовчки");
  const ok = await cm.acquire("catalog-controls", { floor: 3 });
  assert.equal(ok.token, 4);
});

// ---------- E3 / E4 / F06 ----------
test("F06-2 / F06-3: ключ точки й head запечатані — ccReadiness / engineeringReadiness (з чинною орендою), сирий putJsonIfVersion і fenced-запис без квитка (MemoryStore і FileStore) → CC_KEY_SEALED", async () => {
  for (const make of [() => new MemoryStore(), async () => new FileStore(await tmp("mm-e23-seal-"))]) {
    const c = clock(), st = await make();
    const gw = new WriteGateway({ sheets: new MemorySheets({ A: [["x"]] }), read: async () => ({}), store: st, now: c.now, ttlMs: 1000, settleMs: 0 });
    const pair = gw.ccReadiness();
    const l = await pair.committer.acquire("catalog-controls");
    assert.match(l.leaseId, /^[0-9a-f]{32}$/);
    await assert.rejects(pair.store.putJsonIfVersion(CK, { v: 1 }, null, { lease: { scope: "catalog-controls", token: l.token } }), (e) => e.code === "CC_KEY_SEALED");
    await assert.rejects(st.putJsonIfVersion(CK, { v: 1 }, null), (e) => e.code === "CC_KEY_SEALED");
    await assert.rejects(st.putJsonIfVersionFenced(CK, { v: 1 }, null, { leaseKey: l.leaseKey, token: l.token }), (e) => e.code === "CC_KEY_SEALED", "без leaseId");
    await assert.rejects(st.putJsonIfVersionFenced(CK, { v: 1 }, null, { leaseKey: l.leaseKey, token: l.token, leaseId: l.leaseId }), (e) => e.code === "CC_KEY_SEALED", "без квитка");
    for (const write of [() => st.putJsonIfVersion(SERVING_HEAD_KEY, { v: 1 }, null), () => st.putJsonIfVersionFenced(SERVING_HEAD_KEY, { v: 1 }, null, { leaseKey: l.leaseKey, token: l.token, leaseId: l.leaseId })]) await assert.rejects(write(), (e) => e.code === "CC_KEY_SEALED");
    assert.equal((await st.getJsonVersioned(CK)).value, null);
    // Стіл квитків уже в шлюзу: повторно його не видати нікому (у т.ч. «сирому» коду з доступом до сховища).
    assert.throws(() => st.claimDesk({ now: c.now }), (e) => e.code === "DESK_CLAIMED");
    await l.release();
  }
});

test("F06-4 / F06-5: квиток для X, запис X' → CC_TICKET_REJECTED; повтор погашеного квитка, квиток іншої оренди, прострочений, змінений, незареєстрований, іншого екземпляра сховища → CC_TICKET_REJECTED; дійсний — проходить і погашається", async () => {
  const c = clock(), d = await tmp("mm-e23-tk-"), A = new FileStore(d), B = new FileStore(d);
  const deskA = deskOf(A, c.now), deskB = deskOf(B, c.now);
  assert.throws(() => deskA.bind("other-feeds"), (e) => e.code === "DESK_BOUND");
  const cm = createCommitter({ store: A, now: c.now, ttlMs: 1000, settleMs: 0 });
  const l = await cm.acquire("catalog-controls");
  const X = { v: 4, ops: ["a"] }, X2 = { v: 4, ops: ["a", "b"] };
  const rejected = (e) => e.code === "CC_TICKET_REJECTED";
  // X → X'
  await assert.rejects(A.putJsonIfVersionFenced(CK, X2, null, fenceOf(l, ticketFor(deskA, l, X, null, { phase: "init" }))), rejected);
  // незареєстрований (підроблений) квиток
  const forged = { v: 1, key: CK, nextHash: jcsHash(X), expectedVersion: null, leaseToken: l.token, leaseId: l.leaseId, phase: "init", nonce: "1".repeat(32), notAfter: l.expiresAt };
  await assert.rejects(A.putJsonIfVersionFenced(CK, X, null, fenceOf(l, forged)), rejected);
  // іншого екземпляра сховища (інший «процес»)
  await assert.rejects(A.putJsonIfVersionFenced(CK, X, null, fenceOf(l, ticketFor(deskB, l, X, null, { phase: "init" }))), rejected);
  // змінений після видачі
  const t0 = ticketFor(deskA, l, X, null, { phase: "init" });
  await assert.rejects(A.putJsonIfVersionFenced(CK, X, null, fenceOf(l, { ...t0, phase: "issued" })), rejected);
  // прострочений
  const tLate = ticketFor(deskA, l, X, null, { phase: "init", notAfter: c.t - 1 });
  await assert.rejects(A.putJsonIfVersionFenced(CK, X, null, fenceOf(l, tLate)), rejected);
  // дійсний — проходить; повтор — відхилено
  const w = await A.putJsonIfVersionFenced(CK, X, null, fenceOf(l, t0));
  assert.ok(w.version);
  await assert.rejects(A.putJsonIfVersionFenced(CK, X, null, fenceOf(l, t0)), rejected, "повтор погашеного квитка");
  // квиток іншої оренди (після перехоплення)
  const tOld = ticketFor(deskA, l, X2, w.version);
  c.t += 1000;
  const l2 = await cm.acquire("catalog-controls");
  await assert.rejects(A.putJsonIfVersionFenced(CK, X2, w.version, { ...fenceOf(l2), ticket: tOld }), rejected);
  await assert.rejects(A.putJsonIfVersionFenced(CK, X2, w.version, fenceOf(l, tOld)), (e) => e.fencing === true || rejected(e), "стара оренда");
  assert.deepEqual((await A.getJsonVersioned(CK)).value, X, "точка лише з дійсного квитка");
  assert.equal(jcs({ b: 1, a: [2, { d: 1, c: "ї" }] }), '{"a":[2,{"c":"ї","d":1}],"b":1}', "JCS: ключі впорядковано, без пробілів");
});

// ---------- E10: дзеркало реєстру поза публічним Worker ----------
test("F08-10 / пункт 4: маніфест із active.key = state/cc-registry/head.json (або будь-який ключ поза feeds/<фід>/) — Worker не обслуговує, servedChain не вважає обслуговуваним, відкат відхиляє", async () => {
  const s = new LocalObjectStore(await tmp("mm-e23-e10-"));
  await s.putJson(REGISTRY_KEY, { v: 1, committed: { registry: { ops: ["секрет"] } } });
  // Об'єкт поза feeds/ з ПРАВИЛЬНИМИ метаданими (як у версії фіду): без правила E10 Worker віддав би його за маніфестом.
  const xml = '<?xml version="1.0"?><yml_catalog><shop><offers><offer id="1"/></offers></shop></yml_catalog>', buf = Buffer.from(xml);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  await s.put("state/cc-registry/copy.xml", buf, { metadata: { sha256: sha } });
  const entry = { storedBytes: buf.length, bytes: buf.length, sha256: sha, encoding: "identity", count: 1, generatedAt: "x" };
  for (const key of ["state/cc-registry/copy.xml", REGISTRY_KEY, "state/operational.json", "feeds/other/versions/x.xml", "feeds/main/../state/x.json"]) {
    await s.putJson(manifestKey("main"), { kind: "FEED_MANIFEST_V1", feed: "main", active: { ...entry, key }, previous: { ...entry, key }, previousFallbackSafe: true, history: [{ ...entry, key }] });
    for (const method of ["GET", "HEAD"]) {
      const r = await worker.fetch(new Request("https://feeds.test/feeds/main.xml?key=" + "k".repeat(32), { method }), { FEEDS_BUCKET: r2BindingFrom(s), FEED_ACCESS_KEY: "k".repeat(32), FEEDS: "main" });
      assert.equal(r.status, 503, key + " " + method);
    }
    const ch = await servedChain(s, "main");
    assert.equal(ch.served.xml, null, key);
    await assert.rejects(rollbackFeed(s, "main", { toKey: key, violations: () => [] }), /поза feeds\/main\/|Немає попередньої/);
  }
});
