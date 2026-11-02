/** ENG-25 (Hermes ENG-24 N1) — псевдоніми ключів на регістронезалежній ФС: регістр, «\», кінцеві крапки / пробіли, «.» / «..»,
 *  порожні сегменти, NFKC, імена пристроїв, зарезервовані суфікси. Перевірено на рівні КОЖНОГО сховища й API: FileStore, MemoryStore,
 *  ccReadiness, протокол A (сховище), LocalObjectStore, обгортка fencing, Worker. Без модуля CC. Модель — один хост (Q6). */
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
import { jcsHash } from "../src/pipeline/safe-write/jcs.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { keyIdentity, sameKey, canonicalStateKey, canonicalObjectKey } from "../src/storage/keys.mjs";
import { fenceFeeds, fencedStore, REGISTRY_KEY, OPERATIONAL_KEY } from "../src/publish/feed-fence.mjs";
import { manifestKey } from "../src/publish/publisher.mjs";
import worker from "../worker/src/index.js";
import { r2BindingFrom } from "./helpers/r2-fake.mjs";

const tmp = (p) => fsp.mkdtemp(path.join(os.tmpdir(), p));
const CK = SEALED_CHECKPOINT_KEY, HEAD = SERVING_HEAD_KEY;
/** Псевдоніми, що на NTFS / APFS або через нормалізацію адресують той самий фізичний ключ. */
const aliasesOf = (k) => [...new Set([
  k.toUpperCase(),
  k.replace(/^state/, "STATE"),
  k.replace(/\.json$/, ".JSON"),
  k.replace(/\//g, "\\"),
  k + ".",
  k + " ",
  k.replace("/", "//"),
  k.replace("/", "/./"),
  "./" + k,
  k.replace(/^state/, "ｓｔａｔｅ").replace(/^feeds/, "ｆｅｅｄｓ"), // NFKC → «state» / «feeds»
  k.replace(/^feeds/, "FEEDS"),
])].filter((a) => a !== k);
const INVALID_STATE = ["", "/a.json", "a.json/", "a//b.json", "a/../b.json", "a/./b.json", "A.json", "a\\b.json", "a/b.json.", "a/b .json", "a/con.json", "nul", "a/%2F.json", "a/ü.json", 5, null];

test("N1 / keys: keyIdentity зводить усі псевдоніми до одного фізичного ключа; канонічна граматика їх не приймає", () => {
  for (const k of [CK, HEAD, REGISTRY_KEY, manifestKey("main")]) {
    for (const a of aliasesOf(k)) {
      assert.equal(keyIdentity(a), keyIdentity(k), a);
      assert.ok(sameKey(a, k), a);
      assert.notEqual(a, k);
    }
  }
  for (const k of [CK, HEAD, leaseKeyOf("sheets-main"), leaseKeyOf("catalog-controls:readiness-probe"), "state/write-journal/sheets-main.json", "state/catalog-controls/readiness-probe.json"]) assert.equal(canonicalStateKey(k), k);
  for (const a of [...aliasesOf(CK), ...INVALID_STATE]) assert.throws(() => canonicalStateKey(a), (e) => e.code === "INVALID_KEY", String(a));
  for (const k of ["feeds/main/manifest.json", "feeds/main/versions/2026-10-31T06-00-00-000Z-0123456789ab.xml.gz", "journal/conflicts/2026-10/2026-10-31T06-00-00-000Z.json", "state/cc-registry/head.json", "approved/main.json"]) assert.equal(canonicalObjectKey(k), k);
  for (const a of [...aliasesOf(REGISTRY_KEY), ...aliasesOf(manifestKey("main")), "feeds/main/Manifest.json", "FEEDS/main/versions/x.xml", "feeds/main/versions/x.XML", "feeds/main/x.json.cas/v000000000001", "feeds/main/versions/x.xml.meta", "feeds/main/versions/x.xml.tmp-ab", "feeds/aux/manifest.json", "approved/Main.json"]) {
    assert.throws(() => canonicalObjectKey(a), (e) => e.code === "INVALID_KEY", a);
  }
});

for (const [label, mk] of [["MemoryStore", async () => new MemoryStore()], ["FileStore", async () => new FileStore(await tmp("mm-e25-fs-"))]]) {
  test(`N1 / ${label}: будь-який псевдонім ключа точки й head — CC_KEY_SEALED (putJsonIfVersion і fenced з ЧИННОЮ орендою та ЧИННИМ квитком); канонічний файл не змінено; інші неканонічні ключі — INVALID_KEY`, async () => {
    const st = await mk(), c = { t: 1_000_000, now: () => c.t };
    const desk = st.claimDesk({ now: c.now }); desk.bind("test-feeds");
    const cm = createCommitter({ store: st, now: c.now, ttlMs: 60_000, settleMs: 0 });
    const lease = await cm.acquire("catalog-controls");
    const v0 = { v: 4, ops: [], pending: [], aborted: [], at: "x" };
    const t0 = { v: 1, key: CK, nextHash: jcsHash(v0), expectedVersion: null, leaseToken: lease.token, leaseId: lease.leaseId, phase: "init", nonce: crypto.randomBytes(16).toString("hex"), notAfter: lease.expiresAt };
    desk.registerTicket(t0);
    const fence = (ticket) => ({ leaseKey: lease.leaseKey, token: lease.token, leaseId: lease.leaseId, scope: lease.scope, ...(ticket ? { ticket } : {}) });
    const w0 = await st.putJsonIfVersionFenced(CK, v0, null, fence(t0)); // канонічний запис з квитком — контроль
    const before = await st.getJsonVersioned(CK);
    assert.equal(before.version, w0.version);
    for (const a of aliasesOf(CK)) {
      const forged = { ...v0, at: "підробка " + a };
      const t = { v: 1, key: CK, nextHash: jcsHash(forged), expectedVersion: before.version, leaseToken: lease.token, leaseId: lease.leaseId, phase: "intents", nonce: crypto.randomBytes(16).toString("hex"), notAfter: lease.expiresAt };
      desk.registerTicket(t);
      await assert.rejects(st.putJsonIfVersion(a, forged, before.version), (e) => e.code === "CC_KEY_SEALED", "put " + a);
      await assert.rejects(st.putJsonIfVersionFenced(a, forged, before.version, fence(t)), (e) => e.code === "CC_KEY_SEALED", "fenced " + a);
      desk.revokeTicket(t.nonce);
    }
    for (const a of aliasesOf(HEAD)) {
      await assert.rejects(st.putJsonIfVersion(a, { v: 1, forged: true }, null), (e) => e.code === "CC_KEY_SEALED", "head put " + a);
      await assert.rejects(st.putJsonIfVersionFenced(a, { v: 1, forged: true }, null, fence()), (e) => e.code === "CC_KEY_SEALED", "head fenced " + a);
    }
    const after = await st.getJsonVersioned(CK);
    assert.deepEqual(after, before, "канонічна точка не змінилась");
    assert.deepEqual(await st.getJsonVersioned(HEAD), { value: null, version: null }, "head не створено");
    // Інші ключі: лише канонічні (зокрема ключ оренди — неможливо обійти CAS / fencing оренди через псевдонім).
    for (const a of [...aliasesOf(leaseKeyOf("sheets-main")).filter((x) => !sameKey(x, CK)), ...INVALID_STATE]) {
      await assert.rejects(st.putJsonIfVersion(a, { token: 999 }, null), (e) => e.code === "INVALID_KEY", "put " + String(a));
      await assert.rejects(st.getJsonVersioned(a), (e) => e.code === "INVALID_KEY", "get " + String(a));
    }
    await assert.rejects(st.putJsonIfVersionFenced("state/other/x.json", { a: 1 }, null, { ...fence(), leaseKey: lease.leaseKey.toUpperCase() }), (e) => e.code === "INVALID_KEY", "псевдонім ключа оренди");
    const lr = await st.getJsonVersioned(lease.leaseKey);
    assert.equal(lr.value.token, lease.token, "запис оренди не змінено");
    if (st instanceof FileStore) {
      const names = fs.readdirSync(st.dir).filter((n) => !n.endsWith(".lock"));
      assert.equal(names.filter((n) => n.toLowerCase() === (encodeURIComponent(CK) + ".json").toLowerCase()).length, 1, "один файл точки");
      assert.ok(names.every((n) => n === n.toLowerCase().replace(/%[0-9a-f]{2}/g, (m) => m.toUpperCase())), "лише канонічні імена файлів: " + names.join(", "));
    }
  });
}

test("N1 / ccReadiness і сховище протоколу A: псевдоніми ключа точки й head — CC_KEY_SEALED; псевдонім службового ключа CC не знімає вимоги оренди; канонічні ключі без змін", async () => {
  const dir = await tmp("mm-e25-gw-"), st = new FileStore(path.join(dir, "w2"));
  const mem = new MemorySheets({}), now = () => 1_000_000;
  const gw = new WriteGateway({ sheets: mem, read: (n) => mem.read(n), store: st, now });
  const feedStore = new LocalObjectStore(path.join(dir, "objects"));
  const surfaces = {
    ccReadiness: gw.ccReadiness().store,
    protocolA: gw.ccProtocolA({ feedStore, config: { feeds: [{ name: "main" }] }, loadBook: async () => ({}), contract: {}, mods: { plan: {} }, activeXmlsOf: () => async () => [], base: gw.ccReadiness() }).store,
  };
  for (const [name, s] of Object.entries(surfaces)) {
    for (const a of [...aliasesOf(CK), ...aliasesOf(HEAD)]) {
      await assert.rejects(s.putJsonIfVersion(a, { forged: true }, null), (e) => e.code === "CC_KEY_SEALED", `${name} ${a}`);
      await assert.rejects(s.putJsonIfVersion(a, { forged: true }, null, { lease: { scope: "catalog-controls", token: 1, leaseId: "a".repeat(32) }, ticket: { v: 1 } }), (e) => e.code === "CC_KEY_SEALED", `${name} + оренда й квиток ${a}`);
    }
    for (const a of aliasesOf("state/catalog-controls/readiness-probe.json")) {
      await assert.rejects(s.putJsonIfVersion(a, { probe: 1 }, null), (e) => ["STALE_LEASE", "INVALID_KEY"].includes(e.code), `${name} проба без оренди ${a}`);
    }
  }
  assert.deepEqual(await st.getJsonVersioned(CK), { value: null, version: null });
  assert.deepEqual(await st.getJsonVersioned(HEAD), { value: null, version: null });
  assert.deepEqual(await st.getJsonVersioned("state/catalog-controls/readiness-probe.json"), { value: null, version: null });
});

test("N1 / LocalObjectStore і fencing: псевдоніми маніфесту, дзеркала реєстру й операційного стану — INVALID_KEY (put / putJson / get / delete); через обгортку fencing — NOT_FENCED / NOT_CONDITIONAL; канонічний вміст без змін; версії з верхнім регістром у мітці часу — дозволені", async () => {
  const st = new LocalObjectStore(await tmp("mm-e25-obj-"));
  await st.putJson(manifestKey("main"), { kind: "FEED_MANIFEST_V1", feed: "main", active: null, previous: null, history: [] });
  await st.putJson(REGISTRY_KEY, { v: 1, committed: { cpHash: "a".repeat(64) } });
  await st.putJson(OPERATIONAL_KEY, { v: 1 });
  const snap = async () => [await st.getJsonEtag(manifestKey("main")), await st.getJsonEtag(REGISTRY_KEY), await st.getJsonEtag(OPERATIONAL_KEY)];
  const s0 = await snap();
  for (const k of [manifestKey("main"), REGISTRY_KEY, OPERATIONAL_KEY]) {
    for (const a of aliasesOf(k).filter((x) => !/^\.\//.test(x) || true)) {
      await assert.rejects(st.putJson(a, { forged: true }), (e) => e.code === "INVALID_KEY", "putJson " + a);
      await assert.rejects(st.put(a, "forged"), (e) => e.code === "INVALID_KEY", "put " + a);
      await assert.rejects(st.getJson(a), (e) => e.code === "INVALID_KEY", "get " + a);
      await assert.rejects(st.delete(a), (e) => e.code === "INVALID_KEY", "delete " + a);
    }
  }
  assert.deepEqual(await snap(), s0, "канонічні маніфест / дзеркало / операційний стан не змінено");
  // Обгортка fencing: псевдонім розпізнано як ключ під fencing (за ідентичністю), а не «звичайний» ключ.
  const lease = { token: 7, leaseId: "b".repeat(32), scope: "catalog-controls", assertCurrent: async () => true };
  const fstore = await fenceFeeds({ store: st, feeds: ["main"], lease, scope: "catalog-controls" });
  const s1 = await snap();
  for (const a of ["STATE/cc-registry/head.json", "FEEDS/main/manifest.json", "feeds/main/MANIFEST.json", "state/operational.JSON"]) {
    await assert.rejects(fstore.putJson(a, { forged: true }), (e) => e.code === "NOT_FENCED", "fenced putJson " + a);
    await assert.rejects(fstore.put(a, "x"), (e) => e.code === "NOT_CONDITIONAL", "fenced put " + a);
    await assert.rejects(fstore.delete(a), (e) => e.code === "NOT_CONDITIONAL", "fenced delete " + a);
  }
  assert.deepEqual(await snap(), s1);
  // Незмінні версії й журнали з міткою часу (…T…Z) — законні ключі.
  const vk = "feeds/main/versions/2026-10-31T06-00-00-000Z-0123456789ab.xml";
  await st.put(vk, "<yml/>");
  assert.equal((await st.getBuffer(vk)).toString(), "<yml/>");
  await st.putJson("journal/conflicts/2026-10/2026-10-31T06-00-00-000Z.json", [{ a: 1 }]);
  assert.deepEqual(await st.list("feeds/main/versions/"), [vk]);
});

test("N1 / Worker: маніфест, що вказує на псевдонім (регістр каталогу фіду, службовий ключ) — 503, не обслуговується", async () => {
  const st = new LocalObjectStore(await tmp("mm-e25-wk-"));
  await st.put("feeds/main/versions/v1.xml", "<yml_catalog><offer id=\"1\"/></yml_catalog>", { contentType: "application/xml" });
  for (const key of ["FEEDS/main/versions/v1.xml", "feeds/MAIN/versions/v1.xml", "STATE/cc-registry/head.json", "feeds/main/../state/cc-registry/head.json"]) {
    await st.putJson(manifestKey("main"), { kind: "FEED_MANIFEST_V1", feed: "main", active: { key, sha256: "0".repeat(64), size: 1 }, previous: null, history: [] });
    for (const method of ["GET", "HEAD"]) {
      const r = await worker.fetch(new Request("https://local.invalid/feeds/main.xml?key=K", { method }), { FEEDS_BUCKET: r2BindingFrom(st), FEED_ACCESS_KEY: "K", FEEDS: "main" });
      assert.equal(r.status, 503, `${method} ${key}`);
    }
  }
});
