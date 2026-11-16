/** № 62 (рішення власника 16.11: зіставлені — ціна й наявність ЛИШЕ з Excel): «Оновити товари» (syncSheet) бере ціни й наявність
 *  зіставлених товарів з Excel Хорошопу, як і «Оновити ціни й наявність»; без пари — Prom-фід; Excel старший за 36 год — Prom-фід. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { syncSheet, mergeNew92 } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import baseConfig from "./helpers/legacy-config.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();

async function run(age) {
  const s = generateSynthetic({ products: 30, queue: 0, deferred: 0, newOffers: 0, seed: 7, now: NOW });
  const book = {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
  const sheets = new MemorySheets(book);
  const readBook = async () => structuredClone(book);
  const xml = s.supplierXml();
  const m = await mergeNew92({ sheets, readBook, stamp: STAMP }); // черга в режим черги (як у робочій таблиці)
  if (m.state !== "MERGED") throw new Error(JSON.stringify(m));
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  const first = readSheet(book[SHEET.main], SHEET.main).rows[0];
  const id = mtText(first["ID постачальника"]);
  const offer = parsed.offers.get(id);
  const xl = { price: Math.round(offer.price * 0.8) + 1, available: !offer.available };
  // «Артикул» Excel = Offer ID (як у постачальника для товарів, перенесених із Prom); назва — та сама
  const horoshop = { rows: [{ a: id, d: "", p: xl.price, dr: Math.round(xl.price * 0.9), o: null, av: xl.available, n: offer.nameUa }], count: 1, lastModified: new Date(NOW - age * 3600_000).toUTCString() };
  const r = await syncSheet({ sheets, readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config: structuredClone(baseConfig), now: NOW, catalog: EMPTY_CATALOG, controls: null, horoshop });
  const after = readSheet(book[SHEET.main], SHEET.main).rows.find((x) => mtText(x["Offer ID"]) === mtText(first["Offer ID"]));
  return { r, after, offer, xl };
}

test("№ 62: «Оновити товари» — ціни й наявність зіставлених з Excel (свіжий Excel); Excel старший за 36 год — Prom-фід", async () => {
  const a = await run(1);
  assert.equal(a.r.state, "SYNCED", JSON.stringify(a.r).slice(0, 300));
  assert.equal(Number(a.after["Ціна постачальника"]), a.xl.price, "РРЦ — з Excel");
  assert.equal(mtText(a.after["Наявність"]), a.xl.available ? "+" : "-", "наявність — з Excel");
  assert.equal(a.r.horoshop.matched, 1);
  const b = await run(72);
  assert.equal(b.r.state, "SYNCED");
  assert.equal(Number(b.after["Ціна постачальника"]), b.offer.price, "Excel застарів — ціна з Prom-фіду");
  assert.match(b.r.horoshop.error, /застарів/);
});
