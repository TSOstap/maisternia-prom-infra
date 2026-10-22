/** S1: формат «Журналу» як у mtUpdate і записи про заблоковані оновлення. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { SHEET, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet, blockedEntry, feedBlock, recordBlocked } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets, GoogleSheetsWriter, VALUE_INPUT_OPTION } from "../src/pipeline/sheets-writer.mjs";
import baseConfig from "../config/default.json" with { type: "json" };
import { syncAndIntake } from "./helpers/intake.mjs";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();
const config = structuredClone(baseConfig);

async function world() {
  const s = generateSynthetic({ products: 120, queue: 12, deferred: 4, newOffers: 1, seed: 3, now: NOW });
  const book = {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
  const w = { book, sheets: new MemorySheets(book), readBook: async () => structuredClone(book), xml: s.supplierXml() };
  await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  return w;
}
async function sync(w, xml) {
  return syncAndIntake(w, xml, { stamp: STAMP, now: NOW, config });
}

test("формат «Журналу» = mtUpdate: наявність «+» і «-» без апострофів; рядок постачальника з «=» зберігається як є", async () => {
  const w = await world();
  // Нова позиція з назвою, що схожа на формулу
  const evil = '=HYPERLINK("https://example.invalid","x")';
  const xml = w.xml.replace("<name_ua>Новий товар 0</name_ua>", `<name_ua>${evil.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}</name_ua>`);
  const r = await sync(w, xml);
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  const avail = w.book[SHEET.journal].filter((e) => e[3] === "Наявність");
  assert.ok(avail.length > 0, "у синтетиці постачальник змінює наявність частини товарів");
  for (const e of avail) {
    assert.ok(["+", "-"].includes(e[4]) && ["+", "-"].includes(e[5]), `«${e[4]}» → «${e[5]}» без апострофів`);
  }
  assert.ok(!w.book[SHEET.journal].flat().some((v) => typeof v === "string" && /^'[+\-=@]/.test(v)), "жодного апострофа-префікса в «Журналі»");
  const q = readSheet(w.book[SHEET.queue], SHEET.queue).rows.find((x) => x["Назва постачальника UA"] === evil);
  assert.ok(q, "назва постачальника збережена буквально (як текст)");
});

test("запис у Google — лише режим RAW: формули й дати не розбираються, «+»/«-» лишаються текстом", async () => {
  assert.equal(VALUE_INPUT_OPTION, "RAW");
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    seen.push({ path: u.pathname, option: u.searchParams.get("valueInputOption") || (init.body ? JSON.parse(init.body).valueInputOption : null) });
    return new Response(JSON.stringify({ sheets: [{ properties: { title: "Журнал", sheetId: 1, gridProperties: { rowCount: 10, columnCount: 7 } } }] }), { status: 200 });
  };
  const wr = new GoogleSheetsWriter({ spreadsheetId: "COPY_SHEET_ID_0123456789abcdefXYZ", liveSpreadsheetId: "LIVE_SHEET_ID_0123456789abcdefXYZ", getAccessToken: async () => "t", fetchImpl, sleep: async () => {} });
  await wr.appendRows("Журнал", [["2026", "СИСТЕМА", "", "Наявність", "+", "-", "x"]]);
  await wr.updateRanges([{ title: "Журнал", row: 2, col: 1, values: [["=1+1"]] }]);
  assert.deepEqual(seen.map((s) => s.option), ["RAW", "RAW"]);
});

test("масова зміна наявності: оновлення заблоковано, товарні дані й черга не змінені, у «Журналі» — тип, зачеплено, поріг, причина", async () => {
  const w = await world();
  await sync(w, w.xml);
  const before = structuredClone(w.book);
  const r = await sync(w, w.xml.replace(/available="true"/g, 'available="false"'));
  assert.equal(r.state, "ABORTED");
  assert.equal(r.journalWritten, true);
  assert.equal(r.block.type, "МАСОВА ЗМІНА НАЯВНОСТІ");
  for (const k of Object.keys(before)) if (k !== SHEET.journal) assert.deepEqual(w.book[k], before[k], k);
  const added = w.book[SHEET.journal].slice(before[SHEET.journal].length);
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].slice(0, 5), [STAMP, "СИСТЕМА", "", "ОНОВЛЕННЯ ЗАБЛОКОВАНО", "МАСОВА ЗМІНА НАЯВНОСТІ"]);
  assert.match(added[0][5], /^зачеплено \d+; поріг 50$/);
  assert.match(added[0][6], /«немає в наявності» стало \d+ товарів/);
});

test("якщо запис у «Журнал» не вдався — нічого не змінено, причина лишається в результаті (для журналу GitHub)", async () => {
  const w = await world();
  await sync(w, w.xml);
  const before = structuredClone(w.book);
  w.sheets.armFailure("appendRows");
  const r = await sync(w, w.xml.replace(/available="true"/g, 'available="false"'));
  assert.equal(r.state, "ABORTED");
  assert.equal(r.journalWritten, false);
  assert.match(r.journalError, /імітований збій/);
  assert.match(r.reason, /немає в наявності/);
  assert.deepEqual(w.book, before, "таблиця повністю без змін");
});

test("неповний, застарілий і пошкоджений XML — зрозумілий тип і поріг для «Журналу»", async () => {
  assert.deepEqual(feedBlock("Неповний фід: різке зменшення кількості ID", { count: 3000, minimum: 4157 }), { type: "НЕПОВНИЙ XML", reason: "фід постачальника неповний: різке зменшення кількості позицій", affected: 3000, limit: 4157 });
  assert.equal(feedBlock("Застарілий або майбутній YML", { maxAgeHours: 48 }).type, "ЗАСТАРІЛИЙ XML");
  assert.equal(feedBlock("Застарілий або майбутній YML", { maxAgeHours: 48 }).limit, 48);
  assert.equal(feedBlock("Немає дати YML").type, "ПОШКОДЖЕНИЙ XML");
  assert.equal(feedBlock("розбір: Пошкоджений запис offer").type, "ПОШКОДЖЕНИЙ XML");
  assert.deepEqual(blockedEntry(STAMP, feedBlock("Неповний фід", { count: 3000, minimum: 4157 })), [STAMP, "СИСТЕМА", "", "ОНОВЛЕННЯ ЗАБЛОКОВАНО", "НЕПОВНИЙ XML", "зачеплено 3000; поріг 4157", "фід постачальника неповний: різке зменшення кількості позицій"]);
  // Запис події — єдина дія; інші аркуші не чіпаються
  const w = await world();
  const before = structuredClone(w.book);
  const rec = await recordBlocked(w.sheets, STAMP, feedBlock("Застарілий або майбутній YML", { maxAgeHours: 48 }));
  assert.equal(rec.journalWritten, true);
  for (const k of Object.keys(before)) if (k !== SHEET.journal) assert.deepEqual(w.book[k], before[k]);
  assert.deepEqual(w.book[SHEET.journal].at(-1).slice(3, 6), ["ОНОВЛЕННЯ ЗАБЛОКОВАНО", "ЗАСТАРІЛИЙ XML", "поріг 48"]);
});
