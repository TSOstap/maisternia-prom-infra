// Рішення власника 04.11: аркуші попереджень — лише оформлення (дані й порядок колонок не змінюються).
import test from "node:test";
import assert from "node:assert/strict";
import { warningsStyle, styleWarningSheets } from "../src/pipeline/sheet-style.mjs";
import { WARN_SHEET, WARN_HEADER, ACTION } from "../src/pipeline/supplier-warnings.mjs";
import { WARN_ARCHIVE_SHEET } from "../src/pipeline/warnings-archive.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { guardedSheets, MODE_POLICIES, TEST_SHEET_ID } from "../src/pipeline/safe-write/write-target.mjs";

test("04.11: оформлення попереджень — за заголовками; список дій лише на робочому аркуші; дані не змінюються; лише режим sheet-style", async () => {
  const s = warningsStyle(WARN_HEADER);
  const at = (k) => WARN_HEADER.indexOf(k);
  assert.deepEqual(s.hidden, [at("Ключ"), at("Джерело")]);
  assert.equal(s.wrap[at("Було (постачальник)")], "CLIP"); assert.equal(s.wrap[at("Що змінилось")], "WRAP");
  assert.deepEqual(s.list, { col: at("Дія власника"), values: [ACTION.KEEP, ACTION.ACCEPT] });
  assert.equal(s.frozenRows, 1); assert.equal(s.autoRows, true);
  const a = warningsStyle([...WARN_HEADER, "Архівовано"], { archive: true });
  assert.equal(a.list, undefined); assert.equal(a.widths[WARN_HEADER.length], 140);
  const rows = [["k1", "t", "1", "s", "n", "Опис UA", "<p>a</p>", "<p>b</p>", "x", "YML", "", "", "", "…"]];
  const raw = new MemorySheets({ [WARN_SHEET]: [WARN_HEADER.slice(), ...rows], [WARN_ARCHIVE_SHEET]: [[...WARN_HEADER, "Архівовано"]], "Журнал": [["ID події"]] });
  const before = JSON.stringify(raw.book[WARN_SHEET]);
  const sheets = guardedSheets(raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES["sheet-style"], headers: {} });
  const r = await styleWarningSheets({ sheets, readBook: async () => raw.read(), stamp: "s" });
  assert.equal(r.state, "STYLED"); assert.deepEqual(r.sheets, [WARN_SHEET, WARN_ARCHIVE_SHEET]);
  assert.equal(JSON.stringify(raw.book[WARN_SHEET]), before, "дані не змінено");
  assert.ok(raw.styles[WARN_SHEET].list && !raw.styles[WARN_ARCHIVE_SHEET].list);
  await assert.rejects(() => sheets.formatColumns("Основний каталог", {}), /не дозволено/);
  const other = guardedSheets(raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES.prices, headers: {} });
  await assert.rejects(() => other.formatColumns(WARN_SHEET, {}), /не дозволена/);
});
