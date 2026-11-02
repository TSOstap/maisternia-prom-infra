/** ENG-28 — dry-run міграції тестової копії (tools/migration-dry-run.mjs): чистий розрахунок без записів. Синтетика. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, QUEUE_HEADERS } from "../src/core/sheet-sync.mjs";

const NOW = Date.parse("2026-10-22T10:00:00Z");
function book() {
  const s = generateSynthetic({ products: 30, queue: 5, deferred: 2, newOffers: 0, seed: 9, now: NOW });
  return {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"], [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups,
    "Журнал": [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Причина"], ["2026-10-29T18:21:32.156Z", "СИСТЕМА", "", "ЗАВЕРШЕНО", "", 5256, JSON.stringify({ mode: "ОНОВЛЕННЯ", feedDate: "2026-10-29 21:00", offers: 5256 })]],
  };
}

test("ENG-28 dry-run: чистий розрахунок — точні зміни перенесення (рядки, колонки, заголовок черги, позначки, паспорт), QA, блокери; книга не змінюється", async () => {
  const { dryRun } = await import("../tools/migration-dry-run.mjs");
  const b = book();
  const qa = mtText(b[SHEET.main][2][0]);
  const before = JSON.stringify(b);
  const r = dryRun({ book: b, stamp: "2026-11-01T10:00:00.000Z", qaIds: [qa], feed: { available: false, reason: "немає" } });
  assert.equal(JSON.stringify(b), before, "книга не змінена");
  assert.equal(r.transfer.state, "READY", JSON.stringify(r.transfer.checks.filter((c) => !c.ok)));
  assert.equal(r.after.main.rows, r.before.main.rows + 5);
  assert.equal(r.after.queue.rows, 5, "рядки черги лишаються");
  assert.equal(r.after.queue.columns, QUEUE_HEADERS.length);
  assert.ok(r.changes.some((c) => c.sheet === SHEET.main && /рядки/.test(c.kind) && c.count === 5));
  assert.ok(r.changes.some((c) => c.sheet === SHEET.queue && /НЕ видаляються/.test(c.kind)));
  assert.ok(r.changes.some((c) => c.sheet === SHEET.passport && c.passport.count === r.after.main.rows));
  assert.ok(r.blockers.some((x) => /актуальний повний YML/.test(x.what)));
  assert.ok(r.blockers.some((x) => /R-N3W/.test(x.what)));
  // Печатка основного каталогу зламана → перенесення заблоковане з ID.
  const h = b[SHEET.main][0].map(mtText);
  b[SHEET.main][2][h.indexOf("Опис UA")] = "<p>змінено після QA</p>";
  const r2 = dryRun({ book: b, stamp: "2026-11-01T10:00:00.000Z", qaIds: [qa], feed: { available: false } });
  assert.equal(r2.transfer.state, "PRECONDITION_FAILED");
  assert.ok(r2.blockers.some((x) => /печатки основного каталогу/.test(x.what) && x.detail.includes(qa)));
  assert.equal(r2.qa.items[0].seal, "MISMATCH");
});
