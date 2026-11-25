/** ENG-29 — розмір журналу операцій W2 (сховище в Durable Object має межі розміру значення): довгі значення клітинок у намірі —
 *  відбитком SHA-256 (з'ясування порівнює лише рівність), намір ЗАВЕРШЕНОЇ операції стискається; відкриті — ніколи. */
import test from "node:test";
import assert from "node:assert/strict";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { OP, cellDigest, cellMatches, DIGEST_MIN_CHARS } from "../src/pipeline/safe-write/keyed-update.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { compactDetail, OpJournal, JOURNAL_MAX_ENTRIES } from "../src/pipeline/safe-write/journal.mjs";

const T = "Основний каталог";
const H = ["Offer ID", "ID постачальника", "Назва UA", "Опис постачальника UA", "Ціна", "Наявність", "Фото JSON", "SEO рішення"];
const LONG = (id) => "<p>" + ("Довгий опис постачальника " + id + ". ").repeat(40) + "</p>";
const book = () => ({ [T]: [H.slice(), ...["101", "102", "103"].map((id, i) => [id, "s" + id, "Назва " + id, "Опис " + id, String(100 + i), "+", `["f${id}"]`, ""])] });
const journalOf = async (store) => (await store.getJsonVersioned("state/write-journal/sheets-main.json")).value.entries;

test("відбиток клітинки: короткі — текстом, довгі — SHA-256; порівняння за текстом клітинки", () => {
  assert.equal(cellDigest("100"), "100");
  const d = cellDigest(LONG("101"));
  assert.ok(d["#sha256"] && d.len === LONG("101").length);
  assert.ok(LONG("101").length >= DIGEST_MIN_CHARS);
  assert.ok(cellMatches(LONG("101"), d));
  assert.ok(!cellMatches(LONG("102"), d));
  assert.ok(cellMatches("100", "100") && cellMatches(100, "100") && !cellMatches("101", "100"));
});

test("намір із довгими значеннями — відбитки; втрачена відповідь → з'ясування за відбитками → RECONCILED VERIFIED; після завершення намір стиснуто", async () => {
  let t = 1_000;
  const sh = new MemorySheets(book());
  const store = new MemoryStore();
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store, now: () => t, settleMs: 200_000 });
  const s = await gw.open({ writer: "sync" });
  sh.armFault({ op: "updateRanges", mode: "lost" });
  const ch = ["101", "102"].map((id) => ({ key: id, expect: { "Опис постачальника UA": "Опис " + id, "Ціна": sh.book[T].find((r) => r[0] === id)[4] }, set: { "Опис постачальника UA": LONG(id), "Ціна": "7" } }));
  const r = await s.updateByKey({ title: T, changes: ch, generation: "d" });
  assert.equal(r.outcome, OP.VERIFIED, "запис застосовано (відповідь втрачено), перевірка після запису за ключем — VERIFIED");
  // Тепер «невідомий» сценарій: відповідь втрачено, а наступне читання не встигло — імітуємо UNKNOWN через timeout без застосування.
  const sh2 = new MemorySheets(book());
  const store2 = new MemoryStore();
  const gw2 = new WriteGateway({ sheets: sh2, read: (n) => sh2.read(n), store: store2, now: () => t, settleMs: 200_000 });
  const s2 = await gw2.open({ writer: "sync" });
  sh2.armFault({ op: "updateRanges", mode: "delay" });
  const ch2 = ["101"].map((id) => ({ key: id, expect: { "Опис постачальника UA": "Опис " + id }, set: { "Опис постачальника UA": LONG(id) } }));
  const r2 = await s2.updateByKey({ title: T, changes: ch2, generation: "d2" });
  assert.equal(r2.outcome, OP.UNKNOWN);
  const intent = (await journalOf(store2)).find((e) => e.phase === "INTENT" && e.kind === "update");
  assert.ok(intent.detail.items[0].set["Опис постачальника UA"]["#sha256"], "довге значення в намірі — відбитком");
  assert.ok(!JSON.stringify(intent).includes("Довгий опис"), "повного тексту в журналі немає");
  sh2.flushDelayed(); // Google застосував запит пізніше
  t += 200_001;
  const rec = await s2.reconcile();
  assert.equal(rec[0].result, OP.VERIFIED, "з'ясування за відбитком: значення на місці");
  await s2.close();
  const after = await journalOf(store2);
  const i2 = after.find((e) => e.phase === "INTENT" && e.kind === "update");
  assert.ok(JSON.stringify(i2).length < 4096, "з відбитками намір малий (стиснення не потрібне)");
  await s.close();
});

test("стиснення не чіпає відкритих (невідомий результат) і тих, що чекають рішення людини", async () => {
  let t = 1_000;
  const sh = new MemorySheets(book());
  const store = new MemoryStore();
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store, now: () => t, settleMs: 200_000 });
  const s = await gw.open({ writer: "sync" });
  sh.armFault({ op: "updateRanges", mode: "timeout" });
  const big = ["101", "102", "103"].map((id) => ({ key: id, expect: { "Опис постачальника UA": "Опис " + id }, set: { "Опис постачальника UA": LONG(id) + "x".repeat(3000) } }));
  assert.equal((await s.updateByKey({ title: T, changes: big, generation: "u" })).outcome, OP.UNKNOWN);
  await s.close(); // RELEASE — ще одне дописування; намір відкритий
  const intent = (await journalOf(store)).find((e) => e.phase === "INTENT" && e.kind === "update");
  assert.ok(!intent.compacted, "відкритий намір не стиснуто");
  assert.ok(Array.isArray(intent.detail.items) && intent.detail.items[0].expect, "дані для з'ясування збережено");
  const cd = compactDetail({ title: T, keyColumn: "Offer ID", targets: [{ key: "1", row: 2 }], keysBefore: ["1", "2"], snapshots: { 1: ["x"] } });
  assert.deepEqual({ ...cd, compactedChars: 0 }, { title: T, keyColumn: "Offer ID", targets: 1, keys: ["1"], compactedChars: 0 });
  assert.ok(cd.compactedChars > 0);
});

test("журнал: намір ЗАВЕРШЕНОЇ операції (≥ 4 КБ) стискається при наступному дописуванні; відкритий — ні", async () => {
  const { OpJournal } = await import("../src/pipeline/safe-write/journal.mjs");
  const store = new MemoryStore();
  const j = new OpJournal({ store, resource: "sheets-main" });
  const lease = { token: 1, scope: "sync", assertCurrent: async () => {} };
  const big = (n) => ({ title: T, keyColumn: "Offer ID", items: Array.from({ length: n }, (_, i) => ({ key: String(1000 + i), row: i + 2, cols: ["Ціна"], set: { "Ціна": "1" }, expect: { "Ціна": "2" } })) });
  await j.append(lease, { opId: "op-a", phase: "INTENT", kind: "update", detail: big(100) });
  await j.append(lease, { opId: "op-b", phase: "INTENT", kind: "update", detail: big(100) });
  await j.append(lease, { opId: "op-a", phase: "VERIFIED", kind: "update", detail: {} });
  const e = await j.entries();
  const a = e.find((x) => x.opId === "op-a" && x.phase === "INTENT"), b = e.find((x) => x.opId === "op-b" && x.phase === "INTENT");
  assert.equal(a.compacted, true);
  assert.equal(a.detail.items, 100);
  assert.equal(a.detail.keys.length, 100);
  assert.ok(!a.detail.set && !JSON.stringify(a.detail).includes("expect"));
  assert.ok(!b.compacted, "відкритий намір не стиснуто");
  assert.equal((await j.intentOf("op-b")).detail.items.length, 100, "дані для з'ясування відкритої операції цілі");
  assert.deepEqual((await j.unresolved()).map((x) => x.opId), ["op-b"]);
});

test("25.11: журнал тримає останні 800 записів; відкрита операція (INTENT без результату) лишається, хоч і давня; номери й token не губляться", async () => {
  let t = 1_000;
  const store = new MemoryStore();
  const j = new OpJournal({ store, resource: "sheets-main", now: () => t });
  const lease = { token: 1, scope: "sync", assertCurrent: async () => {} };
  await j.append(lease, { phase: "INTENT", opId: "op-open", writer: "sync", detail: { title: T } });
  for (let i = 0; i < JOURNAL_MAX_ENTRIES; i++) { t++; await j.append({ ...lease, token: 2 + i }, { phase: i % 2 ? "VERIFIED" : "INTENT", opId: "op-" + Math.floor(i / 2), writer: "sync", detail: { title: T } }); }
  const e = await j.entries();
  assert.equal(e.length, JOURNAL_MAX_ENTRIES + 1, "800 останніх + відкрита");
  assert.ok(e.some((x) => x.opId === "op-open"));
  assert.equal(e.at(-1).seq, JOURNAL_MAX_ENTRIES + 1);
  assert.equal(Math.max(...e.map((x) => x.token)), JOURNAL_MAX_ENTRIES + 1);
  await assert.rejects(j.append({ ...lease, token: 5 }, { phase: "INTENT", opId: "op-stale" }), /STALE|відхилено/);
});
