/** Рішення власника 15.11.2026: розморозити свідомо виключені товари («Заморожені ID») — без дублів. Таблиця в пам'яті. */
import test from "node:test";
import assert from "node:assert/strict";
import { unfreezePlan, unfreezeIds, FROZEN_SHEET } from "../src/pipeline/unfreeze.mjs";
import * as WT from "../src/pipeline/safe-write/write-target.mjs";

const MAIN = "Основний каталог";
const book0 = () => ({
  [FROZEN_SHEET]: [["Offer ID"], ["100"], ["200"], ["300"], ["400"], ["500"]],
  [MAIN]: [["Offer ID", "Назва UA"], ["100", "Товар 100"], ["900", "Товар 900"]],
  "Журнал": [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
});

test("15.11: план розморожування — прибирає лише виключені; товар із каталогу й дубль власника лишаються; невідомий ID — у missing", () => {
  const b = book0();
  const p = unfreezePlan(b[FROZEN_SHEET], { ids: ["200", "300", "100", "400", "777"], keep: ["400"], mainIds: new Set(["100", "900"]) });
  assert.deepEqual(p.removed, ["200", "300"]);
  assert.deepEqual(p.values.map((r) => r[0]), ["100", "400", "500"]);
  assert.deepEqual(p.refused.map((r) => r.id).sort(), ["100", "400"]);
  assert.match(p.refused.find((r) => r.id === "400").reason, /дубль/);
  assert.match(p.refused.find((r) => r.id === "100").reason, /Основному каталозі/);
  assert.deepEqual(p.missing, ["777"]);
  assert.throws(() => unfreezePlan([["Щось"], ["1"]], { ids: ["1"] }), /Offer ID/);
});

test("15.11: розморожування пише на місці (рядки не видаляються), хвіст очищено, подія в «Журналі»; повтор — NOTHING", async () => {
  const b = book0(), writes = [];
  const sheets = {
    async updateRanges(list) { for (const u of list) { writes.push(u); u.values.forEach((row, i) => { b[u.title][u.row - 1 + i] = row.slice(); }); } },
    async appendRows(title, rows) { b[title].push(...rows); },
  };
  const readBook = async (names) => Object.fromEntries(names.filter((n) => b[n]).map((n) => [n, b[n].map((r) => r.slice())]));
  const r = await unfreezeIds({ sheets, readBook, stamp: "2026-11-15", ids: ["200", "500", "100"], keep: [] });
  assert.equal(r.state, "UNFROZEN"); assert.equal(r.removed, 2); assert.equal(r.kept, 3);
  assert.deepEqual(b[FROZEN_SHEET].map((x) => x[0]), ["Offer ID", "100", "300", "400", "", ""], "рядків стільки ж, хвіст порожній");
  assert.equal(writes.length, 1); assert.equal(writes[0].row, 2);
  assert.match(b["Журнал"].at(-1)[5], /розморожено 2/);
  assert.equal((await unfreezeIds({ sheets, readBook, stamp: "x", ids: ["200"] })).state, "NOTHING");
});

test("15.11: політика запису — розморожування лише переписує «Заморожені ID» і дописує «Журнал»", () => {
  const p = WT.MODE_POLICIES.unfreeze;
  assert.deepEqual(Object.keys(p).sort(), ["Журнал", FROZEN_SHEET].sort());
  assert.deepEqual(p[FROZEN_SHEET].ops, ["updateRanges"]);
  assert.ok(!p[MAIN], "основного каталогу не чіпає");
});
