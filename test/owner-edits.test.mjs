/** Точкові правки власника (рішення власника 03.11.2026): лише дозволені колонки, звірка всіх очікуваних значень до запису
 *  (розбіжність — нічого не записано), запис за ключем, «Журнал», охоронець режиму owner-edits. Таблиця в пам'яті. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { mtText } from "../src/core/text.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import * as WT from "../src/pipeline/safe-write/write-target.mjs";
import { applyOwnerEdits, planProblems } from "../src/pipeline/owner-edits.mjs";

const MAIN = "Основний каталог", WARN = "Попередження постачальника", JOURNAL = "Журнал";
function world() {
  const s = generateSynthetic({ products: 10, queue: 0, deferred: 0, newOffers: 0, seed: 5, now: Date.parse("2026-11-03T12:00:00Z") });
  const book = { [MAIN]: s.sheets[MAIN], [WARN]: [["Ключ", "Offer ID", "Поле", "Дія власника", "Стан дії"], ["k1", "x", "Назва UA", "", ""], ["k2", "y", "Назва RU", "", ""]], [JOURNAL]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const headers = Object.fromEntries(Object.entries(book).map(([k, v]) => [k, v[0].slice()]));
  const guarded = WT.guardedSheets(sheets, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES["owner-edits"], headers });
  const readBook = async (names) => { const b = await sheets.read(); return Object.fromEntries(names.filter((n) => b[n]).map((n) => [n, b[n]])); };
  return { sheets, guarded, readBook, book };
}
const cell = (w, sheet, keyCol, key, col) => { const v = w.sheets.book[sheet], h = v[0].map((x) => mtText(x)); return mtText(v.find((r) => mtText(r[h.indexOf(keyCol)]) === key)[h.indexOf(col)]); };

test("правки власника: назви / опис / характеристики товару і «Дія власника» в попередженнях — записано за ключем, «Журнал»; інші колонки без змін", async () => {
  const w = world();
  const id = mtText(w.book[MAIN][3][0]);
  const before = w.book[MAIN][3].slice();
  const edits = [
    { sheet: MAIN, key: id, column: "Назва UA", expect: cell(w, MAIN, "Offer ID", id, "Назва UA"), set: "Нова назва UA", source: "тест" },
    { sheet: MAIN, key: id, column: "Опис UA", expect: cell(w, MAIN, "Offer ID", id, "Опис UA"), set: "<p>Новий опис</p>", source: "тест" },
    { sheet: MAIN, key: id, column: "Характеристики JSON", expect: cell(w, MAIN, "Offer ID", id, "Характеристики JSON"), set: '[{"name":"Напруга","value":"40","unit":"В"}]', source: "тест" },
    { sheet: WARN, key: "k1", column: "Дія власника", expect: "", set: "Залишити наше", source: "тест" },
  ];
  const r = await applyOwnerEdits({ sheets: w.guarded, readBook: w.readBook, stamp: "2026-11-03T12:00:00Z", edits });
  assert.equal(r.state, "OWNER_EDITS_APPLIED", JSON.stringify(r)); assert.equal(r.applied, 4); assert.equal(r.products, 1);
  assert.equal(cell(w, MAIN, "Offer ID", id, "Назва UA"), "Нова назва UA");
  assert.equal(cell(w, WARN, "Ключ", "k1", "Дія власника"), "Залишити наше");
  assert.equal(cell(w, WARN, "Ключ", "k2", "Дія власника"), "");
  const h = w.book[MAIN][0].map((x) => mtText(x));
  const row = w.sheets.book[MAIN].find((x) => mtText(x[0]) === id);
  for (const [j, k] of h.entries()) if (!["Назва UA", "Опис UA", "Характеристики JSON"].includes(k)) assert.equal(mtText(row[j]), mtText(before[j]), k);
  const j = w.sheets.book[JOURNAL].slice(1);
  assert.equal(j.length, 4); assert.ok(j.every((e) => String(e[6]).startsWith("РІШЕННЯ ВЛАСНИКА 03.11")));
  assert.ok(!JSON.stringify(r).match(/\d{10,}/), "у результаті немає ID товарів (захист виводу)");
});

test("правки власника: значення змінилось після підготовки плану — нічого не записано; недозволена колонка / не JSON — план відхилено", async () => {
  const w = world();
  const id = mtText(w.book[MAIN][2][0]);
  const snap = JSON.stringify(w.sheets.book);
  const r = await applyOwnerEdits({ sheets: w.guarded, readBook: w.readBook, stamp: "s", edits: [
    { sheet: MAIN, key: id, column: "Назва UA", expect: cell(w, MAIN, "Offer ID", id, "Назва UA"), set: "A", source: "тест" },
    { sheet: MAIN, key: id, column: "Назва RU", expect: "не те значення", set: "B", source: "тест" },
  ] });
  assert.equal(r.state, "BLOCKED"); assert.equal(JSON.stringify(w.sheets.book), snap, "нічого не записано");
  assert.ok(planProblems([{ sheet: MAIN, key: id, column: "Ціна", expect: "1", set: "2", source: "т" }]).length);
  assert.ok(planProblems([{ sheet: MAIN, key: id, column: "Характеристики JSON", expect: "[]", set: "{", source: "т" }]).length);
  assert.ok(planProblems([{ sheet: "Групи", key: "1", column: "Назва", expect: "a", set: "b", source: "т" }]).length);
  // Охоронець режиму не дасть писати поза переліком навіть напряму.
  await assert.rejects(Promise.resolve().then(() => w.guarded.updateRanges([{ title: MAIN, row: 2, col: 6, values: [["1"]] }])));
});
