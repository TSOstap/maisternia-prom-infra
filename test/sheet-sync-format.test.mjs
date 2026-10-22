/** S1: знижка числом 0.2 з форматом «0%» (як mtUpdate), актуальна підказка прив'язки, позначка нетоварних записів. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet, LIVE_COLUMNS } from "../src/core/sync-plan.mjs";
import { mtPrices } from "../src/core/pricing.mjs";
import { offerXml } from "../src/core/yml.mjs";
import { rowSeal, SEAL_COLUMN } from "../src/core/seal.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, extractFullOffers, nonProductReason } from "../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet, sheetDiscount } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets, GoogleSheetsWriter } from "../src/pipeline/sheets-writer.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();
const config = structuredClone(baseConfig);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function world({ newOffers = 1 } = {}) {
  const s = generateSynthetic({ products: 120, queue: 12, deferred: 4, newOffers, seed: 5, now: NOW });
  const book = {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
  const w = { s, book, sheets: new MemorySheets(book), readBook: async () => structuredClone(book), xml: s.supplierXml() };
  await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  return w;
}
const rows = (book, name) => readSheet(book[name], name).rows;
async function sync(w, xml, stamp = STAMP) {
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  return syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp, config, now: NOW });
}
function addOffer(xml, o) {
  const pics = (o.pictures || []).map((u) => `<picture>${esc(u)}</picture>`).join("");
  const line = `<offer id="${o.id}" available="${o.available ?? true}"><url>${esc(o.url)}</url><price>${o.price ?? 500}</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>${esc(o.nameRu)}</name><name_ua>${esc(o.nameUa)}</name_ua>${o.sku ? `<vendorCode>${esc(o.sku)}</vendorCode>` : ""}<description><![CDATA[<p>опис</p>]]></description><description_ua><![CDATA[<p>опис</p>]]></description_ua>${pics}<quantity_in_stock></quantity_in_stock></offer>`;
  return xml.replace("\n</offers>", "\n" + line + "\n</offers>");
}
const queueRow = (w, id) => rows(w.book, SHEET.queue).find((r) => mtText(r["Offer ID"]) === id);

// ---------- 1. Знижка ----------

test("знижка: «20%» → число 0.2; інші значення без змін; формула цін не змінилася", () => {
  assert.equal(sheetDiscount("20%"), 0.2);
  assert.equal(sheetDiscount("12,5%"), 0.125);
  assert.equal(sheetDiscount(0.2), 0.2, "число лишається числом");
  for (const v of ["", "+", "-", "20", "знижка 20%", null]) assert.equal(sheetDiscount(v), v);
  // Формула mtPrices та її рядкове подання «20%» не змінюються — перетворення лише на запису в таблицю
  assert.deepEqual(mtPrices(100, true), { base: 131.25, final: 105, discount: "20%", availability: "+" });
  assert.deepEqual(mtPrices(100, false), { base: 131.25, final: 105, discount: "", availability: "-" });
});

test("після синхронізації «Знижка» — число 0.2 (тип number) з форматом «0%» у каталозі й черзі; ціни за формулою", async () => {
  const w = await world();
  const r = await sync(w, w.xml);
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  const main = rows(w.book, SHEET.main);
  const avail = main.filter((x) => x["Наявність"] === "+");
  assert.ok(avail.length > 50);
  for (const x of avail) {
    assert.equal(typeof x["Знижка"], "number", "тип — число, не рядок «20%»");
    assert.equal(x["Знижка"], 0.2);
    const p = mtPrices(Number(x["Ціна постачальника"]), true);
    assert.equal(x["Ціна"], p.base);
    assert.equal(x["Ціна кінцева"], p.final);
  }
  for (const x of main.filter((y) => y["Наявність"] === "-")) assert.equal(x["Знижка"], "", "без наявності — без знижки");
  assert.ok(!w.book[SHEET.main].flat().includes("20%"), "у каталозі немає жодного рядка «20%»");
  // Нова позиція в черзі — теж числом
  const q = rows(w.book, SHEET.queue).filter((x) => x["Наявність"] === "+");
  assert.ok(q.length > 0);
  for (const x of q) assert.equal(x["Знижка"], 0.2);
  // Формат «0%» на колонці «Знижка» обох аркушів (Google показує «20%»)
  const mh = w.book[SHEET.main][0], qh = w.book[SHEET.queue][0];
  const fm = w.sheets.formats[SHEET.main + "!" + (mh.indexOf("Знижка") + 1)];
  const fq = w.sheets.formats[SHEET.queue + "!" + (qh.indexOf("Знижка") + 1)];
  assert.deepEqual({ type: fm.type, pattern: fm.pattern, fromRow: fm.fromRow, toRow: fm.toRow }, { type: "PERCENT", pattern: "0%", fromRow: 2, toRow: w.book[SHEET.main].length });
  assert.deepEqual({ type: fq.type, pattern: fq.pattern, fromRow: fq.fromRow, toRow: fq.toRow }, { type: "PERCENT", pattern: "0%", fromRow: 2, toRow: w.book[SHEET.queue].length });
  // Печатки й паспорт цілі (знижка — операційна колонка, не «незмінна»)
  assert.ok(main.every((x) => rowSeal(x) === mtText(x[SEAL_COLUMN])));
});

test("«Журнал»: знижка «було/стало» числами (0.2 ↔ порожньо), як у mtUpdate; повторний запуск без змін не пише знижку", async () => {
  const w = await world();
  await sync(w, w.xml);
  const main = rows(w.book, SHEET.main);
  const on = main.find((x) => x["Наявність"] === "+");
  const off = main.find((x) => x["Наявність"] === "-" && x["Стан синхронізації"] === "ЗІСТАВЛЕНО");
  let xml = w.xml.replace(new RegExp(`(<offer id="${on["ID постачальника"]}" available=")true"`), '$1false"');
  if (off) xml = xml.replace(new RegExp(`(<offer id="${off["ID постачальника"]}" available=")false"`), '$1true"');
  const len = w.book[SHEET.journal].length;
  const r = await sync(w, xml, "2026-10-22T14:00:00.000Z");
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  const disc = w.book[SHEET.journal].slice(len).filter((e) => e[3] === "Знижка");
  const down = disc.find((e) => e[2] === mtText(on["Offer ID"]));
  assert.deepEqual([down[4], down[5]], [0.2, ""], "зникла знижка: 0.2 → порожньо");
  if (off) {
    const up = disc.find((e) => e[2] === mtText(off["Offer ID"]));
    assert.deepEqual([up[4], up[5]], ["", 0.2], "з'явилася знижка: порожньо → 0.2");
  }
  assert.ok(!w.book[SHEET.journal].flat().includes("20%"), "у «Журналі» немає рядка «20%»");
  // Збереження: ще один запуск тим самим фідом — знижка не «змінюється» (0.2 = «20%»), записів про неї немає
  const len2 = w.book[SHEET.journal].length;
  const r2 = await sync(w, xml, "2026-10-22T18:00:00.000Z");
  assert.equal(r2.state, "SYNCED");
  assert.equal(w.book[SHEET.journal].slice(len2).filter((e) => e[3] === "Знижка").length, 0);
  for (const x of rows(w.book, SHEET.main).filter((y) => y["Наявність"] === "+")) assert.equal(x["Знижка"], 0.2);
});

test("YML: число 0.2 дає той самий offer, що й «20%»; інша знижка — відмова", async () => {
  const w = await world();
  await sync(w, w.xml);
  const r = rows(w.book, SHEET.main).find((x) => x["Наявність"] === "+" && x["Стан синхронізації"] === "ЗІСТАВЛЕНО" && x["Статус імпорту"] === "ДОЗВОЛЕНО");
  assert.ok(r, "є готова до YML картка");
  const success = Date.parse(r["Оновлено"]);
  const groups = { [mtText(r["Група ID"])]: true };
  const xmlNum = offerXml(r, success, groups);
  assert.equal(typeof r["Знижка"], "number");
  assert.equal(offerXml({ ...r, "Знижка": "20%" }, success, groups), xmlNum);
  assert.match(xmlNum, /<oldprice>/);
  assert.throws(() => offerXml({ ...r, "Знижка": 0.3 }, success, groups), /знижка/);
});

test("Google: формат «0%» — один batchUpdate repeatCell лише на колонку «Знижка», лише numberFormat", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ path: new URL(url).pathname, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ sheets: [{ properties: { title: "Основний каталог", sheetId: 77, gridProperties: { rowCount: 6000, columnCount: 40 } } }] }), { status: 200 });
  };
  const wr = new GoogleSheetsWriter({ spreadsheetId: "COPY_SHEET_ID_0123456789abcdefXYZ", liveSpreadsheetId: "LIVE_SHEET_ID_0123456789abcdefXYZ", getAccessToken: async () => "t", fetchImpl, sleep: async () => {} });
  await wr.setPercentFormat("Основний каталог", 9, 2, 5122);
  const call = seen.find((s) => s.path.endsWith(":batchUpdate"));
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body.requests, [{ repeatCell: {
    range: { sheetId: 77, startRowIndex: 1, endRowIndex: 5122, startColumnIndex: 8, endColumnIndex: 9 },
    cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0%" } } }, fields: "userEnteredFormat.numberFormat",
  } }]);
  // Захист від запису в чинну таблицю — без змін
  assert.throws(() => new GoogleSheetsWriter({ spreadsheetId: "LIVE_SHEET_ID_0123456789abcdefXYZ", liveSpreadsheetId: "LIVE_SHEET_ID_0123456789abcdefXYZ", getAccessToken: async () => "t", fetchImpl }));
});

// ---------- 2. Підказка прив'язки ----------

test("стара картка повернулася у фід: «ПРИВ'ЯЗАТИ ДО» зникає, позиція лишається в черзі як можливий дубль із поясненням", async () => {
  const w = await world({ newOffers: 0 });
  await sync(w, w.xml);
  const c = rows(w.book, SHEET.main)[9];
  const oldSupplier = mtText(c["ID постачальника"]);
  const photos = JSON.parse(c["Фото JSON"]);
  const reissue = { id: "2950000099", sku: c["Артикул постачальника"], nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000099-tovar.html", pictures: photos, price: 777 };
  // 1) Стара позиція зникла, нова з'явилася → підказка прив'язки є
  let r = await sync(w, addOffer(perturb.drop(w.xml, [oldSupplier]), reissue));
  assert.equal(r.state, "SYNCED");
  let q = queueRow(w, "2950000099");
  assert.match(q["Перевірка"], new RegExp(`ПРИВ'ЯЗАТИ ДО ${c["Offer ID"]}`));
  // 2) Стара позиція повернулася у фід → підказки немає, пояснення є, позиція в черзі, рішення не прийнято автоматично
  r = await sync(w, addOffer(w.xml, reissue), "2026-10-22T14:00:00.000Z");
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  q = queueRow(w, "2950000099");
  assert.ok(q, "позиція лишилася в черзі");
  assert.doesNotMatch(q["Перевірка"], /ПРИВ'ЯЗАТИ ДО/);
  assert.doesNotMatch(q["Перевірка"], /зник із фіду/);
  assert.match(q["Перевірка"], /МОЖЛИВИЙ ДУБЛЬ/);
  assert.match(q["Перевірка"], /ЙМОВІРНО ТОЙ САМИЙ/);
  assert.match(q["Перевірка"], new RegExp(`${c["Offer ID"]} знову є у фіді постачальника`));
  assert.equal(mtText(q["Рішення"]), "");
  const back = rows(w.book, SHEET.main).find((x) => mtText(x["Offer ID"]) === mtText(c["Offer ID"]));
  assert.equal(mtText(back["ID постачальника"]), oldSupplier, "картку не перев'язано");
  assert.equal(back["Стан синхронізації"], "ЗІСТАВЛЕНО", "картка знову зіставлена зі своєю позицією постачальника");
});

// ---------- 3. Нетоварні записи ----------

test("нетоварний запис («Співпраця по дропшипінгу», без артикулу): позначка «НЕТОВАРНИЙ ЗАПИС», без видалення й рішення", async () => {
  const w = await world({ newOffers: 0 });
  await sync(w, w.xml);
  const xml = addOffer(w.xml, { id: "2950000500", nameUa: "Співпраця по дропшипінгу", nameRu: "Сотрудничество по дропшиппингу", url: "https://market-tools.com.ua/p2950000500-drop.html", price: 1 });
  let r = await sync(w, xml, "2026-10-22T14:00:00.000Z");
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  let q = queueRow(w, "2950000500");
  assert.match(q["Перевірка"], /^НЕТОВАРНИЙ ЗАПИС/);
  // Наступний запуск: позначка лишається, не дублюється; запис не видалено й не затверджено
  r = await sync(w, xml, "2026-10-22T18:00:00.000Z");
  q = queueRow(w, "2950000500");
  assert.ok(q);
  assert.equal(q["Перевірка"].match(/НЕТОВАРНИЙ ЗАПИС/g).length, 1);
  assert.equal(mtText(q["Рішення"]), "");
  assert.ok(!rows(w.book, SHEET.main).some((x) => mtText(x["ID постачальника"]) === "2950000500"));
  // Звичайний товар без артикулу позначку не отримує
  assert.equal(nonProductReason({ "Offer ID": "1", "Артикул постачальника": "", "Назва постачальника UA": "Шуруповерт акумуляторний" }), "");
  assert.equal(nonProductReason({ "Offer ID": "1", "Артикул постачальника": "ABC-1", "Назва постачальника UA": "Співпраця" }), "", "з артикулом — за ознаками не позначаємо");
});

test("нетоварний запис за аркушем «Аудит» (позначка НЕТОВАРНИЙ_… у «Тип» або «Причина») — позначка навіть без ознак у назві", async () => {
  const w = await world({ newOffers: 0 });
  await sync(w, w.xml);
  w.book["Аудит"] = [["Offer ID", "Тип", "Причина", "Доказ / деталі"], ["2950000600", "СИНХРОНІЗАЦІЯ", "НЕТОВАРНИЙ_ЗАПИС_ПОЗА_FROZEN"]];
  const xml = addOffer(w.xml, { id: "2950000600", sku: "X-600", nameUa: "Позиція 600", nameRu: "Позиция 600", url: "https://market-tools.com.ua/p2950000600-x.html" });
  const r = await sync(w, xml, "2026-10-22T14:00:00.000Z");
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  assert.match(queueRow(w, "2950000600")["Перевірка"], /НЕТОВАРНИЙ ЗАПИС \(за «Аудитом»\)/);
  assert.deepEqual(w.book["Аудит"], [["Offer ID", "Тип", "Причина", "Доказ / деталі"], ["2950000600", "СИНХРОНІЗАЦІЯ", "НЕТОВАРНИЙ_ЗАПИС_ПОЗА_FROZEN"]], "«Аудит» лише читається");
});

test("операційні колонки не змінили порядок (знижка — 4-та)", () => {
  assert.equal(LIVE_COLUMNS[3], "Знижка");
});
