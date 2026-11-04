// Рішення власника 04.11: нова підгрупа — лише дописування одного рядка з перевірками.
import test from "node:test";
import assert from "node:assert/strict";
import { addGroup } from "../src/pipeline/groups-add.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { guardedSheets, MODE_POLICIES, TEST_SHEET_ID } from "../src/pipeline/safe-write/write-target.mjs";

test("04.11: нова підгрупа — дописується один раз; немає батька / дубль назви / уже є — без запису; інші аркуші — заборонено", async () => {
  const H = ["Ідентифікатор_групи", "Назва_групи_укр", "Назва_групи", "Ідентифікатор_батьківської_групи"];
  const raw = new MemorySheets({ "Групи": [H, ["807000", "Верстати", "Станки", "800000"], ["807002", "Металообробні верстати", "Металлообрабатывающие станки", "807000"]], "Журнал": [["ID події"]], "Основний каталог": [["Offer ID"]] });
  const sheets = guardedSheets(raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES["group-add"], headers: {} });
  const readBook = async () => raw.read();
  const g = { id: "807004", ua: "Ножиці по металу", ru: "Ножницы по металлу", parent: "807000" };
  assert.equal((await addGroup({ sheets, readBook, stamp: "s", group: g })).state, "GROUP_ADDED");
  assert.deepEqual(raw.book["Групи"].at(-1), ["807004", "Ножиці по металу", "Ножницы по металлу", "807000"]);
  assert.equal((await addGroup({ sheets, readBook, stamp: "s", group: g })).state, "NOTHING");
  assert.equal((await addGroup({ sheets, readBook, stamp: "s", group: { ...g, id: "807005", parent: "999" } })).state, "BLOCKED");
  assert.equal((await addGroup({ sheets, readBook, stamp: "s", group: { ...g, id: "807005", ua: "металообробні ВЕРСТАТИ" } })).state, "BLOCKED");
  assert.equal(raw.book["Групи"].length, 4, "лише один новий рядок");
  await assert.rejects(() => sheets.appendRows("Основний каталог", [["1"]]), /не дозволено/);
});
