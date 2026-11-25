/** Гібрид, варіант Б (рішення власника 16.11.2026): РРЦ, наявність і дроп — із «Excel (розширений)» Хорошопу постачальника,
 *  контент — як раніше (Prom-фід + наші картки). Синтетика, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readXlsxColumns } from "../src/core/xlsx-lite.mjs";
import { compactFromExcel, matchHoroshop, applyHoroshop, hybridOffers, excelIsNewer, horoshopFresh, namesAgree, pairProblem, normArticle, FEED_GONE_MAX, EXCEL_COLUMN_LIST, HOROSHOP_DATA_KEY, HOROSHOP_META_KEY } from "../src/core/horoshop.mjs";
import { refreshHoroshopExcel, loadHoroshopCompact, horoshopMeta, HOROSHOP_OVERRIDES } from "../src/pipeline/horoshop-source.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const XLSX = fs.readFileSync(path.join(here, "fixtures", "horoshop-mini.xlsx"));

test("16.11: читач xlsx — лише потрібні колонки, спільні рядки й числа, сутності XML; порожній артикул — далі відкидає compactFromExcel", () => {
  const r = readXlsxColumns(XLSX, EXCEL_COLUMN_LIST);
  assert.deepEqual(r.missing, ["Бренд"], "у тестовому файлі немає колонки «Бренд» (необовʼязкова)");
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows[0], ["DCB546", "DCB546", "9699.00", "8729.10", "11748.00", "В наявності", "0", "Акумулятор DeWalt DCB546 & XR", ""]);
  assert.deepEqual(r.rows[1].slice(0, 4), ["2800127025", "ED-21PBL", "2039", "1835.1"]);
  assert.ok(r.header.includes("Описание (UA)"), "заголовок — повністю");
  assert.deepEqual(readXlsxColumns(XLSX, ["Артикул", "Немає такої"]).missing, ["Немає такої"]);
  assert.throws(() => readXlsxColumns(Buffer.from("не zip"), EXCEL_COLUMN_LIST), /не zip/);
});

test("16.11: компактний список — РРЦ / дроп / стара ціна числами, наявність так / ні, без артикула — пропуск; немає колонки — помилка", () => {
  const c = compactFromExcel(readXlsxColumns(XLSX, EXCEL_COLUMN_LIST));
  assert.equal(c.count, 4);
  assert.deepEqual(c.rows[0], { a: "DCB546", d: "DCB546", p: 9699, dr: 8729.1, o: 11748, av: true, n: "Акумулятор DeWalt DCB546 & XR", b: "" });
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
  assert.equal(o.price, 9699); assert.equal(o.drop, 8729.1);
  assert.equal(o.available, false, "25.11 (№ 116): Excel «є», Prom-фід «немає» → «немає»"); assert.deepEqual(h.stats.feedGoneList, ["2492383482"]); assert.equal(o.source, "horoshop"); assert.equal(o.nameUa, "Акумулятор");
  assert.equal(h.offers.get("104").price, 999, "без пари — Prom-фід");
  assert.equal(h.stats.matched, 1); assert.equal(h.stats.withoutPair, 1); assert.equal(h.stats.priceChanged, 1);
  assert.match(h.stats.date, /16 Nov 2026/);
  const ap = applyHoroshop(parsed.offers, ROWS, new Map([["2492383482", 0]]));
  assert.equal(ap.stats.availableChanged, 0); assert.equal(ap.stats.drop, 1);
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
  assert.deepEqual(Object.keys(HOROSHOP_OVERRIDES).sort(), ["1505796771", "1589397066", "1755858542", "1834930772", "1925870056", "2800127025", "3128001246", "3230755031", "3236816949", "3251742263", "3264219912", "3266177617", "3269825815", "3269967625", "3277856248"]);
  assert.equal(HOROSHOP_OVERRIDES["3264219912"], "ED-21PBL", "16.11: рядок «2800127025» зник з Excel — власник: «ED-21PBL є на сайті»");
  assert.ok(!("1724170062" in HOROSHOP_OVERRIDES), "NG 502 — власник 16.11 «переводь»: звичайна пара за Offer ID");
});

test("16.11: «Excel новіший?» — за Last-Modified; списку немає — так; невідома дата — ні", () => {
  assert.equal(excelIsNewer("Mon, 16 Nov 2026 01:00:00 GMT", { lastModified: "Mon, 16 Nov 2026 00:36:28 GMT" }), true);
  assert.equal(excelIsNewer("Mon, 16 Nov 2026 00:36:28 GMT", { lastModified: "Mon, 16 Nov 2026 00:36:28 GMT" }), false);
  assert.equal(excelIsNewer("Mon, 16 Nov 2026 00:00:00 GMT", null), true);
  assert.equal(excelIsNewer("", { lastModified: "Mon, 16 Nov 2026 00:36:28 GMT" }), false);
});

test("16.11 (захист): «якщо товар за артикулом сходиться беремо» — ні різні назви, ні ціна вдвічі не блокують; блокує лише дроп > РРЦ (помилка Excel)", () => {
  const row = { a: "DCB546", d: "DCB546", p: 9699, o: 11748, av: true, n: "Акумулятор DeWalt DCB546 XR", dr: 8729.1 };
  assert.equal(pairProblem({ price: 11748, nameUa: "Генератор Einhell TC-IG 2000" }, row), null, "різні назви — не блокують (лише «для перевірки» в підсумку)");
  assert.equal(pairProblem({ price: 5899, nameUa: "Акумулятор DeWalt DCB546", sku: "DCB546" }, row), null, "постачальник змінив ціну — застосовується");
  assert.equal(pairProblem({ price: 3000, nameUa: "Акумулятор DCB546" }, row), null, "16.11 власник: зіставлені — лише Excel, ціна вдвічі не блокує (GS-0005: Prom 3748 → Excel 1199)");
  assert.equal(pairProblem({ price: 1124, nameUa: "Плита газова SIGMA 2903531" }, { a: "2903531", p: 279, dr: 800, n: "Плита газова SIGMA 2903531" }), "помилка в Excel: дроп більший за РРЦ", "2903531: РРЦ 279, дроп 800");
  assert.equal(pairProblem({ price: 100, nameUa: "Плита Kovar K-202" }, { a: "1", p: 150, dr: null, n: "Плита Kovar K-202" }), null, "дропу немає — не помилка");
  assert.equal(namesAgree({ nameUa: "Ніж пожежника kwb (14710)" }, { n: "Ніж складний KWB 014710" }), true, "нулі на початку номера");
  assert.equal(namesAgree({ nameUa: "Водяна помпа Bosna Тайфун 2" }, { n: "Насос вібраційний BOSNA-LG Тайфун-2" }), true, "кирилична серія без цифр");
  assert.equal(namesAgree({ nameUa: "Присоска BIHUI LFTBA" }, { n: "Присосок вібраційний BIHUI LFTBA" }), true, "латинська модель без цифр");
  assert.equal(namesAgree({ nameUa: "Пила ланцюгова", sku: "DCB546" }, { n: "Акумулятор DeWalt DCB546", a: "DCB546" }), false, "сам артикул не рахується");
  const offers = new Map([["1", { id: "1", price: 5000, available: false, nameUa: "Пила ланцюгова", sku: "DCB546" }]]);
  const ap = applyHoroshop(offers, [row], new Map([["1", 0]]));
  assert.equal(ap.offers.get("1").price, 9699, "за артикулом — з Excel, навіть коли назви різні");
  assert.deepEqual(ap.stats.skipped, []);
  assert.deepEqual(ap.stats.namesDiffer.map((x) => x.id), ["1"], "різні назви — у списку «для перевірки»");
  const ap2 = applyHoroshop(offers, [row], new Map([["1", 0]]), new Set(["1"]));
  assert.deepEqual(ap2.stats.namesDiffer, [], "виняток власника — не показується");
  const bad = applyHoroshop(offers, [{ ...row, p: 279, dr: 800 }], new Map([["1", 0]]));
  assert.equal(bad.offers.get("1").price, 5000, "дроп > РРЦ — ціна й наявність із Prom-фіду");
  assert.deepEqual(bad.stats.skipped.map((x) => x.reason), ["помилка в Excel: дроп більший за РРЦ"]);
});

test("16.11 (винятки власника): пари з винятків застосовуються й не показуються як «назви різні»; null — без пари", () => {
  const rows = [
    { a: "4331207", d: "4331207", p: 5226, dr: 4651, o: 4716, av: false, n: "(без АКБ та ЗП)" },
    { a: "4152590", d: "4152590", p: 31098, dr: 27366, o: 41997.6, av: false, n: "Насос садовий акумуляторний AQUINNA 36/38" },
    { a: "1724170062", d: "NG 502", p: 649, dr: 615, o: 1558.8, av: false, n: "Плита газова Nurgaz NG 502" },
  ];
  const offers = new Map([
    ["1505796771", { id: "1505796771", sku: "4331207", price: 5226, available: false, nameUa: "Пила циркулярна Einhell TE-CS 18/165-1 Li-Solo" }],
    ["1589397066", { id: "1589397066", sku: "4152590", price: 41998, available: false, nameUa: "Генератор Einhell TC-IG 2000" }],
    ["1724170062", { id: "1724170062", sku: "NG 502", price: 1559, available: false, nameUa: "Плита газова Nurgaz NG 502" }],
  ]);
  const ov = { "1505796771": "4331207", "1589397066": "4152590", "1724170062": null };
  const h = hybridOffers({ parsedOffers: offers, compact: { rows, count: rows.length }, overrides: ov });
  assert.equal(h.offers.get("1589397066").price, 31098, "виняток — застосовано попри різні назви");
  assert.equal(h.offers.get("1589397066").drop, 27366);
  assert.equal(h.offers.get("1505796771").source, "horoshop");
  assert.equal(h.offers.get("1724170062").price, 1559, "null — без пари (Prom-фід)");
  assert.equal(h.stats.skipped, 0);
  assert.equal(h.stats.namesDiffer, 0, "пари з винятків — не «назви різні»");
  // ті самі пари без винятків: за артикулом — з Excel (рішення власника), різні назви — лише «для перевірки»
  const h2 = hybridOffers({ parsedOffers: offers, compact: { rows, count: rows.length } });
  assert.equal(h2.offers.get("1589397066").price, 31098);
  assert.deepEqual(h2.stats.namesDifferList.map((x) => x.id).sort(), ["1505796771", "1589397066"]);
  assert.equal(h2.offers.get("1724170062").price, 649, "NG 502 — за Offer ID");
});

test("16.11 (захист): Excel старший за 36 год — не свіжий; дата файлу з Last-Modified", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(horoshopFresh({ lastModified: "Mon, 16 Nov 2026 00:36:28 GMT" }, now), true);
  assert.equal(horoshopFresh({ lastModified: "Fri, 13 Nov 2026 00:36:28 GMT" }, now), false);
  assert.equal(horoshopFresh({}, now), false);
});

test("25.11 (№ 116): «є» — лише коли Excel «є» і Prom-фід не «немає»; помилка Excel — як раніше; масова розбіжність — лише Excel", () => {
  const row = (a, av, x = {}) => ({ a, d: a, p: 100, dr: 90, o: null, av, n: "Товар " + a, ...x });
  const off = (id, available) => [id, { id, price: 100, available, nameUa: "Товар A" + id, sku: "A" + id }];
  const rows = [row("A1", true), row("A2", true), row("A3", false), row("A4", false), row("A5", true), row("A6", null), row("A7", true, { p: 10, dr: 90 })];
  const offers = new Map([off("1", true), off("2", false), off("3", true), off("4", false), off("5", null), off("6", false), off("7", false)]);
  const map = new Map(rows.map((_, i) => [String(i + 1), i]));
  const r = applyHoroshop(offers, rows, map);
  assert.deepEqual([...r.offers.values()].map((o) => o.available), [true, false, false, false, true, false, false]);
  assert.deepEqual(r.stats.feedGone, ["2"], "Excel «є», фід «немає»; помилка Excel (дроп > РРЦ) — не рахується");
  assert.equal(r.offers.get("2").price, 100, "ціна — з Excel"); assert.equal(r.offers.get("2").source, "horoshop");
  assert.equal(offers.get("2").available, false, "вхід не змінено");
  const stale = applyHoroshop(new Map([["1925870056", { id: "1925870056", price: 100, available: false, nameUa: "CUT-160", sku: "x" }]]), [row("PRO CUT-160", true)], new Map([["1925870056", 0]]));
  assert.equal(stale.offers.get("1925870056").available, true, "CUT-160: стара картка постачальника — наявність лише з Excel"); assert.deepEqual(stale.stats.feedGone, []);
  const big = FEED_GONE_MAX + 1, R = Array.from({ length: big }, (_, i) => row("B" + i, true)), O = new Map(R.map((x, i) => ["9" + i, { id: "9" + i, price: 1, available: false, nameUa: x.n, sku: x.a }]));
  const b = applyHoroshop(O, R, new Map(R.map((_, i) => ["9" + i, i])));
  assert.equal(b.stats.feedGoneIgnored, big); assert.deepEqual(b.stats.feedGone, []);
  assert.ok([...b.offers.values()].every((o) => o.available === true), "схоже на збій фіду — наявність з Excel");
});
