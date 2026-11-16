/** Гібрид, варіант Б (рішення власника 16.11.2026): РРЦ, наявність і дроп — із «Excel (розширений)» Хорошопу постачальника,
 *  контент — як раніше (Prom-фід + наші картки). Синтетика, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readXlsxColumns } from "../src/core/xlsx-lite.mjs";
import { compactFromExcel, matchHoroshop, applyHoroshop, hybridOffers, excelIsNewer, normArticle, EXCEL_COLUMN_LIST, HOROSHOP_DATA_KEY, HOROSHOP_META_KEY } from "../src/core/horoshop.mjs";
import { refreshHoroshopExcel, loadHoroshopCompact, horoshopMeta, HOROSHOP_OVERRIDES } from "../src/pipeline/horoshop-source.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const XLSX = fs.readFileSync(path.join(here, "fixtures", "horoshop-mini.xlsx"));

test("16.11: читач xlsx — лише потрібні колонки, спільні рядки й числа, сутності XML; порожній артикул — далі відкидає compactFromExcel", () => {
  const r = readXlsxColumns(XLSX, EXCEL_COLUMN_LIST);
  assert.deepEqual(r.missing, []);
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows[0], ["DCB546", "DCB546", "9699.00", "8729.10", "11748.00", "В наявності", "0"]);
  assert.deepEqual(r.rows[1].slice(0, 4), ["2800127025", "ED-21PBL", "2039", "1835.1"]);
  assert.ok(r.header.includes("Описание (UA)"), "заголовок — повністю");
  assert.deepEqual(readXlsxColumns(XLSX, ["Артикул", "Немає такої"]).missing, ["Немає такої"]);
  assert.throws(() => readXlsxColumns(Buffer.from("не zip"), EXCEL_COLUMN_LIST), /не zip/);
});

test("16.11: компактний список — РРЦ / дроп / стара ціна числами, наявність так / ні, без артикула — пропуск; немає колонки — помилка", () => {
  const c = compactFromExcel(readXlsxColumns(XLSX, EXCEL_COLUMN_LIST));
  assert.equal(c.count, 4);
  assert.deepEqual(c.rows[0], { a: "DCB546", d: "DCB546", p: 9699, dr: 8729.1, o: 11748, av: true });
  assert.equal(c.rows[1].av, false);
  assert.throws(() => compactFromExcel({ rows: [], missing: ["Цена"] }), /немає колонок Цена/);
});

const ROWS = compactFromExcel(readXlsxColumns(XLSX, EXCEL_COLUMN_LIST)).rows;

test("16.11: зіставлення — «Артикул» = Offer ID → «Артикул» = артикул → артикул на сайті; кілька кандидатів — без пари; виняток власника", () => {
  const prom = new Map([["2492383482", { sku: "DCB546" }], ["2800127025", { sku: "ED-21PBL" }], ["3264219912", { sku: "ED-21PBL" }], ["1925870056", { sku: "Expert CUT-160" }], ["777", { sku: "NONE" }]]);
  const m = matchHoroshop(prom, ROWS, { "1925870056": "PRO CUT-160" });
  assert.equal(ROWS[m.map.get("2492383482")].a, "DCB546", "за «Артикулом»");
  assert.equal(ROWS[m.map.get("2800127025")].a, "2800127025", "«Артикул» = Offer ID (товар, перенесений постачальником із Prom)");
  assert.equal(ROWS[m.map.get("3264219912")].a, "ED-21PBL", "інший ED-21PBL — свій рядок");
  assert.equal(ROWS[m.map.get("1925870056")].a, "PRO CUT-160", "виняток власника");
  assert.ok(!m.map.has("777"));
  assert.equal(m.stats.byId, 1); assert.equal(m.stats.override, 1);
  // артикул на сайті, коли «Артикул» інший; кілька рядків з тим самим артикулом на сайті — без пари
  const rows2 = [{ a: "1505797099", d: "LXTC250-127", p: 100 }, { a: "X1", d: "DUP", p: 1 }, { a: "X2", d: "DUP", p: 2 }];
  const m2 = matchHoroshop(new Map([["9", { sku: "lxtc250-127" }], ["10", { sku: "DUP" }]]), rows2);
  assert.equal(m2.map.get("9"), 0); assert.equal(m2.stats.byDisplay, 1);
  assert.ok(!m2.map.has("10") && m2.stats.ambiguous.includes("10"));
  // один рядок для двох офферів: лишається єдиний найсильніший збіг (Offer ID > «Артикул»); рівні — обидва без пари
  const m3 = matchHoroshop(new Map([["a", { sku: "DCB546" }], ["DCB546", { sku: "x" }]]), ROWS);
  assert.deepEqual([...m3.map.keys()], ["DCB546"], "лишається збіг за Offer ID");
  assert.deepEqual(m3.stats.ambiguous, ["a"]);
  const m4 = matchHoroshop(new Map([["a", { sku: "lxtc250-127" }], ["b", { sku: "LXTC250-127" }]]), [{ a: "1505797099", d: "LXTC250-127", p: 1 }]);
  assert.equal(m4.map.size, 0, "рівні за силою — без пари");
  assert.equal(normArticle("  ab  2 "), "AB 2");
});

test("16.11: підстановка — РРЦ, наявність і дроп для зіставлених, решта — Prom-фід; вхідні оффери не змінюються", async () => {
  const PROM = `<?xml version="1.0" encoding="UTF-8"?><yml_catalog date="2026-11-16 08:00"><shop><currencies><currency id="UAH" rate="1"/></currencies><categories><category id="1">К</category></categories><offers>
<offer id="2492383482" available="false"><price>11748</price><currencyId>UAH</currencyId><vendorCode>DCB546</vendorCode><name_ua>Акумулятор</name_ua><name>Аккумулятор</name></offer>
<offer id="104" available="true"><price>999</price><currencyId>UAH</currencyId><vendorCode>NONE-1</vendorCode><name_ua>Д</name_ua><name>Д</name></offer>
</offers></shop></yml_catalog>`;
  const parsed = await parseSupplierText(PROM, { maximumChars: 1e7, identityFields: true });
  const before = JSON.stringify([...parsed.offers.entries()]);
  const h = hybridOffers({ parsedOffers: parsed.offers, compact: { rows: ROWS, count: ROWS.length, lastModified: "Mon, 16 Nov 2026 00:36:28 GMT" } });
  assert.equal(JSON.stringify([...parsed.offers.entries()]), before);
  const o = h.offers.get("2492383482");
  assert.equal(o.price, 9699); assert.equal(o.available, true); assert.equal(o.drop, 8729.1); assert.equal(o.source, "horoshop"); assert.equal(o.nameUa, "Акумулятор");
  assert.equal(h.offers.get("104").price, 999, "без пари — Prom-фід");
  assert.equal(h.stats.matched, 1); assert.equal(h.stats.withoutPair, 1); assert.equal(h.stats.priceChanged, 1);
  assert.match(h.stats.date, /16 Nov 2026/);
  const ap = applyHoroshop(parsed.offers, ROWS, new Map([["2492383482", 0]]));
  assert.equal(ap.stats.availableChanged, 1); assert.equal(ap.stats.drop, 1);
});

test("16.11: оновлення списку — у сховище (дані + мітка), неповний / зламаний файл і HTTP-помилка не чіпають список; читання на обох шляхах", async () => {
  const store = new MemoryStore();
  const ok = (body, lm = "Mon, 16 Nov 2026 00:36:28 GMT") => async () => new Response(body, { headers: { "last-modified": lm } });
  assert.equal((await refreshHoroshopExcel({ url: "", store })).state, "SKIPPED");
  const r = await refreshHoroshopExcel({ url: "u", store, fetchImpl: ok(XLSX), minRows: 3 });
  assert.equal(r.state, "REFRESHED"); assert.equal(r.count, 4);
  const c = await loadHoroshopCompact(store);
  assert.equal(c, null, "у сховищі менше 4000 рядків — «Ціни» список не використовують (захист)");
  assert.equal((await store.getJsonVersioned(HOROSHOP_DATA_KEY)).value.rows.length, 4);
  assert.equal((await horoshopMeta(store)).lastModified, "Mon, 16 Nov 2026 00:36:28 GMT");
  assert.equal((await store.getJsonVersioned(HOROSHOP_META_KEY)).value.count, 4);
  const v0 = (await store.getJsonVersioned(HOROSHOP_DATA_KEY)).version;
  assert.match((await refreshHoroshopExcel({ url: "u", store, fetchImpl: ok(XLSX) })).reason, /неповний/);
  assert.match((await refreshHoroshopExcel({ url: "u", store, fetchImpl: async () => new Response("x", { status: 503 }) })).reason, /HTTP 503/);
  assert.match((await refreshHoroshopExcel({ url: "u", store, fetchImpl: ok("не zip"), minRows: 1 })).reason, /не розібрано/);
  assert.equal((await store.getJsonVersioned(HOROSHOP_DATA_KEY)).version, v0, "список не змінено");
  // великий список (≥ 4000) — «Ціни» його читають, разом із винятками власника
  const big = { v: 1, at: "t", lastModified: "lm", count: 4000, rows: Array.from({ length: 4000 }, (_, i) => ({ a: "A" + i, d: "", p: 1, dr: 1, o: null, av: true })) };
  await store.putJsonIfVersion(HOROSHOP_DATA_KEY, big, (await store.getJsonVersioned(HOROSHOP_DATA_KEY)).version);
  const L = await loadHoroshopCompact(store);
  assert.equal(L.count, 4000); assert.equal(L.overrides["1925870056"], "PRO CUT-160");
  assert.deepEqual(Object.keys(HOROSHOP_OVERRIDES).sort(), ["1925870056", "2800127025", "3264219912"]);
});

test("16.11: «Excel новіший?» — за Last-Modified; списку немає — так; невідома дата — ні", () => {
  assert.equal(excelIsNewer("Mon, 16 Nov 2026 01:00:00 GMT", { lastModified: "Mon, 16 Nov 2026 00:36:28 GMT" }), true);
  assert.equal(excelIsNewer("Mon, 16 Nov 2026 00:36:28 GMT", { lastModified: "Mon, 16 Nov 2026 00:36:28 GMT" }), false);
  assert.equal(excelIsNewer("Mon, 16 Nov 2026 00:00:00 GMT", null), true);
  assert.equal(excelIsNewer("", { lastModified: "Mon, 16 Nov 2026 00:36:28 GMT" }), false);
});
