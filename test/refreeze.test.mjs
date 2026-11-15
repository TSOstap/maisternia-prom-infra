/** Рішення власника 16.11.2026: товар з «Основного каталогу» → «Видалені товари» + «Заморожені ID» (лише явний список ID).
 *  Таблиця в пам'яті, запис — через шлюз W2 (сесія «sync») і охоронця цілі з політикою режиму refreeze. */
import test from "node:test";
import assert from "node:assert/strict";
import { refreezePlan, refreezeIds, FROZEN_SHEET, ARCHIVE_SHEET_REFREEZE } from "../src/pipeline/unfreeze.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { guardedSheets, MODE_POLICIES, TEST_SHEET_ID } from "../src/pipeline/safe-write/write-target.mjs";

const MAIN = "Основний каталог";
const STAMP = "2026-11-16T01:00:00.000Z";
const ARCH_HEADER = ["Offer ID", "Назва UA", "Ціна", "Видалено", "Операція видалення", "Статус видалення", "YML без товару"];
const book0 = () => ({
  // «Ціна вручну» — нова колонка каталогу, якої немає в старішому архіві
  [MAIN]: [["Offer ID", "Назва UA", "Ціна", "Ціна вручну"], ["100", "Товар 100", "10", ""], ["200", "Порошок 200", "20", ""], ["300", "Товар 300", "30", "35"]],
  [ARCHIVE_SHEET_REFREEZE]: [ARCH_HEADER.slice(), ["900", "Старий 900", "", "2026-11-01", "", "", ""]],
  [FROZEN_SHEET]: [["Offer ID"], ["555"]],
  "Журнал": [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
});

test("16.11: план — копія рядка за заголовком АРХІВУ зі службовими колонками; відмова, якщо загубилась би непорожня колонка; дубль ключа — відмова", () => {
  const b = book0();
  const p = refreezePlan(b[MAIN], b[ARCHIVE_SHEET_REFREEZE], { ids: ["200", "300", "777", "abc"], stamp: STAMP, reason: "рішення власника" });
  assert.deepEqual(p.moves.map((m) => m.id), ["200"]);
  assert.deepEqual(p.moves[0].archiveRow, ["200", "Порошок 200", "20", STAMP, "refreeze:" + STAMP, "рішення власника", ""]);
  assert.deepEqual(p.moves[0].expect, { "Offer ID": "200", "Назва UA": "Порошок 200", "Ціна": "20", "Ціна вручну": "" });
  assert.match(p.refused.find((r) => r.id === "300").reason, /Ціна вручну/, "непорожня колонка, якої немає в архіві");
  assert.match(p.refused.find((r) => r.id === "abc").reason, /цифри/);
  assert.deepEqual(p.missing, ["777"]);
  const dup = refreezePlan([["Offer ID"], ["200"], ["200"]], [["Offer ID"]], { ids: ["200"] });
  assert.match(dup.refused[0].reason, /2 рядки/);
});

async function press(raw, ids) {
  const sheets = guardedSheets(raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES.refreeze });
  const store = new MemoryStore();
  const session = await new WriteGateway({ sheets, read: async () => raw.read(), store, settleMs: 0 }).open({ writer: "sync" });
  try { return await refreezeIds({ session, sheets, readBook: async () => raw.read(), stamp: STAMP, ids, reason: "рішення власника 16.11: не продаємо" }); }
  finally { await session.close().catch(() => {}); }
}

test("16.11: виконання — рядок в архіві, з каталогу прибрано (решта на місці), ID у «Заморожених ID», подія в «Журналі»; повтор — NOTHING", async () => {
  const raw = new MemorySheets(book0());
  const r = await press(raw, ["200"]);
  assert.equal(r.state, "REFROZEN", JSON.stringify(r));
  assert.deepEqual(r.deleted, ["200"]);
  const b = raw.book;
  assert.deepEqual(b[MAIN].slice(1).map((x) => String(x[0])), ["100", "300"], "у каталозі лишились інші товари");
  const arch = b[ARCHIVE_SHEET_REFREEZE].find((x) => String(x[0]) === "200");
  assert.ok(arch, "копія в архіві");
  assert.equal(String(arch[1]), "Порошок 200");
  assert.equal(String(arch[ARCH_HEADER.indexOf("Статус видалення")]), "рішення власника 16.11: не продаємо");
  assert.deepEqual(b[FROZEN_SHEET].slice(1).map((x) => String(x[0])), ["555", "200"]);
  assert.match(String(b["Журнал"].at(-1)[5]), /200/);
  assert.equal((await press(raw, ["200"])).state, "NOTHING");
});

test("16.11: політика refreeze — видалення лише з «Основного каталогу», архів і «Заморожені ID» — лише дописування; інші режими каталог не видаляють", async () => {
  const p = MODE_POLICIES.refreeze;
  assert.deepEqual(p[MAIN], { ops: ["deleteRows"], deleteRows: true });
  assert.deepEqual(p[ARCHIVE_SHEET_REFREEZE].ops, ["appendRows"]);
  assert.deepEqual(p[FROZEN_SHEET].ops, ["appendRows"]);
  const raw = new MemorySheets(book0());
  for (const m of ["transfer", "update", "find-new", "owner-edits", "unfreeze"]) {
    const g = guardedSheets(raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES[m] });
    await assert.rejects(g.deleteRows(MAIN, [2]), /видалення рядків заборонено|не дозволено|заборонено/, m);
  }
  const g = guardedSheets(raw, { spreadsheetId: TEST_SHEET_ID, policy: p });
  await assert.rejects(g.deleteRows(ARCHIVE_SHEET_REFREEZE, [2]), /заборонено|не дозволено/, "з архіву не видаляється");
});
