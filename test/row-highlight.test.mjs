import test from "node:test";
import assert from "node:assert/strict";
import { warningFormula, addWarningHighlight, colLetter } from "../src/pipeline/row-highlight.mjs";
import { WARN_HEADER } from "../src/pipeline/supplier-warnings.mjs";

test("04.11: жовті рядки з відкритим попередженням — формула за заголовками; правило додається один раз; лише через охоронця", async () => {
  assert.equal(colLetter(0), "A"); assert.equal(colLetter(25), "Z"); assert.equal(colLetter(48), "AW");
  const main = ["Offer ID", "ID постачальника", ...Array(46).fill("x"), "Попередження постачальника", "Ціна власника"];
  const f = warningFormula(main, WARN_HEADER);
  assert.equal(f, `=COUNTIFS(INDIRECT("'Попередження постачальника'!$C:$C"),$A2,INDIRECT("'Попередження постачальника'!$K:$K"),"",INDIRECT("'Попередження постачальника'!$L:$L"),"")>0`);
  assert.throws(() => warningFormula(["Назва"], WARN_HEADER), /немає потрібних колонок/);
  const added = [], journal = [];
  const sheets = { async addRowHighlight(t, formula, rgb, opts) { assert.equal(opts.replaceMarker, "'Попередження постачальника'!"); if (added.some((x) => x.formula === formula)) return { already: true }; added.push({ t, formula }); return {}; }, async appendRows(t, rows) { journal.push(...rows); } };
  const readBook = async () => ({ "Основний каталог": [main], "Попередження постачальника": [WARN_HEADER.slice()] });
  assert.equal((await addWarningHighlight({ sheets, readBook, stamp: "s" })).state, "HIGHLIGHT_ADDED");
  assert.equal((await addWarningHighlight({ sheets, readBook, stamp: "s" })).state, "NOTHING");
  assert.equal(added.length, 1); assert.equal(added[0].t, "Основний каталог"); assert.equal(journal.length, 1);
  const { MODE_POLICIES } = await import("../src/pipeline/safe-write/write-target.mjs").catch(() => ({}));
  assert.ok(MODE_POLICIES?.["row-highlight"]?.["Основний каталог"]?.ops.includes("addRowHighlight"));
  assert.ok(!MODE_POLICIES?.["prosale-tariffs"]?.["Основний каталог"], "інші режими правил форматування не додають");
});

test("04.11: формула під локаль таблиці — uk_UA: «;» між аргументами, коми в лапках не чіпаються; en_US — без змін", async () => {
  const { localizeFormula } = await import("../src/pipeline/sheets-writer.mjs");
  const f = `=AND($AW2<>"",COUNTIFS(INDIRECT("'a,b'!$C:$C"),$A2)>0)`;
  assert.equal(localizeFormula(f, "uk_UA"), `=AND($AW2<>"";COUNTIFS(INDIRECT("'a,b'!$C:$C");$A2)>0)`);
  assert.equal(localizeFormula(f, "en_US"), f);
  assert.equal(localizeFormula(f, undefined), f);
});
