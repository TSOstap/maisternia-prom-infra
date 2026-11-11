import test from "node:test";
import assert from "node:assert/strict";
import { queueFormulas, addQueueHighlight, GREY_MARKER, YELLOW_MARKER, REJECTED_RGB } from "../src/pipeline/queue-highlight.mjs";
import { HIGHLIGHT_RGB } from "../src/pipeline/row-highlight.mjs";

test("11.11: «Нові товари» — сірий для «ВІДХИЛЕНО», жовтий для позначки в «Перевірці»; формули за заголовками; правила один раз", async () => {
  const header = ["Offer ID", "ID постачальника", "Артикул постачальника", "Перевірка", ...Array(37).fill("x"), "Рішення"];
  const f = queueFormulas(header);
  assert.equal(f.grey, `=AND(UPPER(TRIM($AP2))="ВІДХИЛЕНО","${GREY_MARKER}"<>"")`);
  assert.equal(f.yellow, `=AND(LEN(TRIM($D2))>0,NOT(UPPER(TRIM($AP2))="ВІДХИЛЕНО"),"${YELLOW_MARKER}"<>"")`);
  assert.throws(() => queueFormulas(["Offer ID", "Перевірка"]), /немає колонок/);

  const added = [], journal = [];
  const sheets = {
    async addRowHighlight(t, formula, rgb, opts) {
      if (added.some((x) => x.formula === formula)) return { already: true };
      added.push({ t, formula, rgb, marker: opts.replaceMarker });
      return {};
    },
    async appendRows(t, rows) { journal.push([t, rows]); },
  };
  const readBook = async () => ({ "Нові товари": [header] });
  assert.equal((await addQueueHighlight({ sheets, readBook, stamp: "s" })).state, "HIGHLIGHT_ADDED");
  assert.equal((await addQueueHighlight({ sheets, readBook, stamp: "s" })).state, "NOTHING");
  assert.equal(added.length, 2);
  // спершу жовте, потім сіре (сіре додається останнім → стає першим правилом, вищий пріоритет)
  assert.deepEqual(added.map((x) => [x.t, x.marker, x.rgb]), [["Нові товари", YELLOW_MARKER, HIGHLIGHT_RGB], ["Нові товари", GREY_MARKER, REJECTED_RGB]]);
  assert.equal(journal.length, 1);
  assert.equal((await addQueueHighlight({ sheets, readBook: async () => ({}), stamp: "s" })).state, "BLOCKED");

  const { MODE_POLICIES } = await import("../src/pipeline/safe-write/write-target.mjs");
  assert.deepEqual(MODE_POLICIES["queue-highlight"]["Нові товари"].ops, ["addRowHighlight"]);
  assert.ok(!MODE_POLICIES["queue-highlight"]["Основний каталог"], "лише «Нові товари» і «Журнал»");
});
