/** ENG-29 — серцебиття оренди W2: операція довша за ttl оренди не втрачає її, поки процес живий; без серцебиття — STALE (як раніше);
 *  close() чекає подовження в процесі й звільняє оренду; за замовчуванням серцебиття вмикає лише серверне сховище (RemoteStore). */
import test from "node:test";
import assert from "node:assert/strict";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemoryStore, RemoteStore } from "../src/pipeline/safe-write/store.mjs";

const T = "Аркуш";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const book = () => ({ [T]: [["Offer ID", "Ціна"], ["1", "10"]] });

test("серцебиття: оренда живе довше за ttl; запис після «довгого читання» проходить; close звільняє оренду", async () => {
  const sh = new MemorySheets(book()), store = new MemoryStore();
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store, ttlMs: 300, settleMs: 0, heartbeatMs: 80 });
  const s = await gw.open({ writer: "sync" });
  await wait(900); // «довге читання» без записів — утричі довше за ttl
  await s.assertCurrent();
  await s.sheets.updateRanges([{ title: T, row: 2, col: 2, values: [["11"]] }]);
  assert.equal(sh.book[T][1][1], "11");
  await s.close();
  const lease = (await store.getJsonVersioned("state/write-lease/sheets-main.json")).value;
  assert.equal(lease.released, true);
  const v = (await store.getJsonVersioned("state/write-lease/sheets-main.json")).version;
  await wait(250);
  assert.equal((await store.getJsonVersioned("state/write-lease/sheets-main.json")).version, v, "після close подовжень немає");
});

test("без серцебиття (локальні сховища за замовчуванням): оренда спливає — запис STALE, як і раніше", async () => {
  const sh = new MemorySheets(book()), store = new MemoryStore();
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store, ttlMs: 200, settleMs: 0 });
  assert.equal(gw.heartbeatMs, null);
  const s = await gw.open({ writer: "sync" });
  await wait(400);
  await assert.rejects(s.assertCurrent(), (e) => e.code === "STALE");
  assert.equal(new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: new RemoteStore({ url: "https://w2.test", key: "k".repeat(32), fetchImpl: async () => { throw new Error("не викликається"); } }) }).heartbeatMs, 240_000);
});

test("серцебиття зупиняється, якщо оренду перехоплено (наступний запис — STALE, без «воскресіння» чужої оренди)", async () => {
  const sh = new MemorySheets(book()), store = new MemoryStore();
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store, ttlMs: 300, settleMs: 0, heartbeatMs: 60 });
  const s = await gw.open({ writer: "sync" });
  const key = "state/write-lease/sheets-main.json";
  const { value, version } = await store.getJsonVersioned(key);
  await store.putJsonIfVersion(key, { ...value, token: value.token + 1, leaseId: "f".repeat(32) }, version); // інший записувач
  await wait(200);
  await assert.rejects(s.assertCurrent(), (e) => e.code === "STALE");
  assert.match(s.heartbeatError || "", /STALE/);
  assert.equal((await store.getJsonVersioned(key)).value.leaseId, "f".repeat(32), "чужу оренду не змінено");
  await s.close().catch(() => {});
});
