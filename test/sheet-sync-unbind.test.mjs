/** S1: відв'язування в будь-який момент, «Код товару Prom» при прив'язці, сумніви комплектації, відкат посеред операції. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { rowSeal, SEAL_COLUMN } from "../src/core/seal.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, BINDINGS_SHEET, extractFullOffers, readPassport } from "../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();
const config = structuredClone(baseConfig);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const NEW_ID = "2950000007";

async function world() {
  const s = generateSynthetic({ products: 120, queue: 12, deferred: 4, newOffers: 0, seed: 7, now: NOW });
  const book = {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
  const w = { s, book, sheets: new MemorySheets(book), readBook: async () => structuredClone(book), xml: s.supplierXml() };
  await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  await sync(w, w.xml);
  return w;
}
const rows = (book, name) => readSheet(book[name], name).rows;
async function sync(w, xml) {
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  return syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config, now: NOW });
}
function offerLine(o) {
  const pics = (o.pictures || []).map((u) => `<picture>${esc(u)}</picture>`).join("");
  return `<offer id="${o.id}" available="${o.available ?? true}"><url>${esc(o.url)}</url><price>${o.price ?? 500}</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>${esc(o.nameRu)}</name><name_ua>${esc(o.nameUa)}</name_ua><vendorCode>${esc(o.sku)}</vendorCode><description><![CDATA[<p>опис</p>]]></description><description_ua><![CDATA[<p>опис</p>]]></description_ua>${pics}<quantity_in_stock></quantity_in_stock></offer>`;
}
const addOffer = (xml, o) => xml.replace("\n</offers>", "\n" + offerLine(o) + "\n</offers>");
const card = (w, k) => rows(w.book, SHEET.main)[k];
const byOffer = (w, id) => rows(w.book, SHEET.main).find((r) => mtText(r["Offer ID"]) === id);
const queueRow = (w, id) => rows(w.book, SHEET.queue).find((r) => mtText(r["Offer ID"]) === id);
function setDecision(w, sheet, keyCol, id, value) {
  const v = w.book[sheet];
  const h = v[0].map(mtText);
  v.find((x, i) => i > 0 && mtText(x[h.indexOf(keyCol)]) === id)[h.indexOf("Рішення")] = value;
}
const uniqueSupplierIds = (w) => { const ids = [...rows(w.book, SHEET.main), ...rows(w.book, SHEET.deferred)].map((r) => mtText(r["ID постачальника"])); return new Set(ids).size === ids.length; };
const sealsOk = (w) => rows(w.book, SHEET.main).every((r) => rowSeal(r) === r[SEAL_COLUMN]);

/** Товар 7 перевипущено під NEW_ID з НОВИМ артикулом; власник прив'язує. Повертає контекст. */
async function boundWorld({ newSku = "NEW-SKU-7" } = {}) {
  const w = await world();
  const c = card(w, 7);
  const ctx = { offerId: mtText(c["Offer ID"]), oldId: mtText(c["ID постачальника"]), oldSku: mtText(c["Артикул постачальника"]), oldCode: mtText(c["Код товару Prom"]),
    seo: [c["Назва UA"], c["Назва RU"], c["Опис UA"], c["Фото JSON"], c["Характеристики JSON"]], photos: JSON.parse(c["Фото JSON"]), oldLine: null };
  ctx.oldLine = new RegExp(`<offer\\b[^>]*\\bid="${ctx.oldId}"[^>]*>[\\s\\S]*?</offer>`).exec(w.xml)[0];
  ctx.newOffer = { id: NEW_ID, sku: newSku, nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], url: `https://market-tools.com.ua/p${NEW_ID}-tovar.html`, pictures: ctx.photos, price: 1234, available: true };
  ctx.xml = addOffer(perturb.drop(w.xml, [ctx.oldId]), ctx.newOffer);
  await sync(w, ctx.xml);
  setDecision(w, SHEET.queue, "Offer ID", NEW_ID, `ПРИВ'ЯЗАТИ ДО ${ctx.offerId}`);
  const r = await sync(w, ctx.xml);
  assert.equal(r.stats.bound, 1, JSON.stringify(r));
  return { w, ctx };
}

test("прив'язка: «Код товару Prom» = новий артикул навіть якщо старий код ≠ старому артикулу; старий код — в історії", async () => {
  const { w, ctx } = await boundWorld();
  assert.notEqual(ctx.oldCode, ctx.oldSku, "передумова тесту: код Prom відрізнявся від артикулу");
  const b = byOffer(w, ctx.offerId);
  assert.equal(b["Код товару Prom"], "NEW-SKU-7");
  assert.equal(b["Артикул постачальника"], "NEW-SKU-7");
  const h = w.book[BINDINGS_SHEET][0];
  const last = w.book[BINDINGS_SHEET].at(-1);
  assert.equal(last[h.indexOf("Старий Код товару Prom")], ctx.oldCode);
  assert.equal(last[h.indexOf("Новий Код товару Prom")], "NEW-SKU-7");
});

test("відв'язування через кілька оновлень: старі ID/артикул/код повернуто, ціна й наявність — з АКТУАЛЬНОЇ старої позиції (не з моменту прив'язки), SEO збережено, нова позиція знову в черзі, без дублів", async () => {
  const { w, ctx } = await boundWorld();
  // Кілька оновлень ціни й наявності за новим ID
  let xml = ctx.xml;
  for (const [price, av] of [[1300, true], [1400, false], [1450, true]]) {
    xml = addOffer(perturb.drop(xml, [NEW_ID]), { ...ctx.newOffer, price, available: av });
    await sync(w, xml);
  }
  assert.equal(byOffer(w, ctx.offerId)["Ціна постачальника"], 1450);
  // Стара позиція тим часом повернулась у фід з актуальною ціною — і потрапила в чергу як «нова»
  xml = xml.replace("\n</offers>", "\n" + ctx.oldLine.replace(/<price>[^<]*<\/price>/, "<price>777</price>").replace(/available="(true|false)"/, 'available="true"') + "\n</offers>");
  await sync(w, xml);
  assert.ok(!queueRow(w, ctx.oldId), "у чергу не додано: її ID = Offer ID картки (дубль Offer ID неможливий)");
  const hh = w.book[BINDINGS_SHEET][0];
  assert.match(w.book[BINDINGS_SHEET].at(-1)[hh.indexOf("Стан")], /УВАГА: стара позиція постачальника знову у фіді/, "попередження в «Історії прив'язок»");
  // Скасування
  setDecision(w, BINDINGS_SHEET, "Offer ID", ctx.offerId, "СКАСУВАТИ");
  const r = await sync(w, xml);
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  assert.equal(r.stats.unbound, 1);
  const c = byOffer(w, ctx.offerId);
  assert.equal(mtText(c["ID постачальника"]), ctx.oldId);
  assert.equal(mtText(c["Артикул постачальника"]), ctx.oldSku);
  assert.equal(mtText(c["Код товару Prom"]), ctx.oldCode);
  assert.deepEqual([c["Назва UA"], c["Назва RU"], c["Опис UA"], c["Фото JSON"], c["Характеристики JSON"]], ctx.seo, "SEO, фото, характеристики збережено");
  assert.equal(c["Ціна постачальника"], 777, "ціна — з актуальної старої позиції, не 1234/1450");
  assert.equal(c["Наявність"], "+");
  assert.equal(c["Стан синхронізації"], "ЗІСТАВЛЕНО");
  assert.ok(!queueRow(w, ctx.oldId), "стара позиція не в черзі — її повернула картка");
  assert.ok(queueRow(w, NEW_ID), "відв'язана нова позиція — знову в черзі");
  assert.match(queueRow(w, NEW_ID)["Перевірка"], /МОЖЛИВИЙ ДУБЛЬ/);
  const h = w.book[BINDINGS_SHEET][0];
  assert.match(w.book[BINDINGS_SHEET].at(-1)[h.indexOf("Стан")], /^СКАСОВАНА .* повернуто ID постачальника/);
  assert.ok(w.book[SHEET.journal].some((e) => e[3] === "ВІДВ'ЯЗАНО"));
  assert.equal(rows(w.book, SHEET.main).length, 132, "дублів немає");
  assert.ok(uniqueSupplierIds(w) && sealsOk(w));
  assert.equal(readPassport(w.book[SHEET.passport]).count, 132);
  // Повторний запуск стабільний
  const r2 = await sync(w, xml);
  assert.equal(r2.stats.added, 0);
  assert.equal(r2.stats.unbound, 0);
});

test("відв'язування, коли старої позиції немає у фіді: «немає в наявності», ціна не повертається з історії", async () => {
  const { w, ctx } = await boundWorld();
  const xml = addOffer(perturb.drop(ctx.xml, [NEW_ID]), { ...ctx.newOffer, price: 1500 });
  await sync(w, xml);
  setDecision(w, BINDINGS_SHEET, "Offer ID", ctx.offerId, "СКАСУВАТИ");
  await sync(w, xml);
  const c = byOffer(w, ctx.offerId);
  assert.equal(mtText(c["ID постачальника"]), ctx.oldId);
  assert.equal(c["Наявність"], "-");
  assert.equal(c["Стан синхронізації"], "ВІДСУТНІЙ_У_YML");
  assert.equal(c["Ціна постачальника"], 1500, "остання відома ціна збережена до повторної синхронізації (не ціна з моменту прив'язки)");
  assert.ok(queueRow(w, NEW_ID));
});

test("конфлікти: відв'язування неможливе, якщо старий ID тепер у іншої картки; прив'язка неможлива, якщо артикул уже має інший товар", async () => {
  const { w, ctx } = await boundWorld();
  // Хтось поставив старий ID постачальника відкладеному товару
  const d = w.book[SHEET.deferred];
  const dh = d[0].map(mtText);
  d[1][dh.indexOf("ID постачальника")] = ctx.oldId;
  setDecision(w, BINDINGS_SHEET, "Offer ID", ctx.offerId, "СКАСУВАТИ");
  await sync(w, ctx.xml);
  const h = w.book[BINDINGS_SHEET][0];
  assert.match(w.book[BINDINGS_SHEET].at(-1)[h.indexOf("Стан")], /скасувати неможливо: старий ID постачальника тепер використовує товар/);
  assert.equal(mtText(byOffer(w, ctx.offerId)["ID постачальника"]), NEW_ID, "картка не змінена");

  // Прив'язка з артикулом, що вже є в іншого товару
  const w2 = await world();
  const other = card(w2, 30), t = card(w2, 31);
  const x2 = addOffer(perturb.drop(w2.xml, [mtText(t["ID постачальника"])]), { id: "2950000031", sku: mtText(other["Код товару Prom"]) || mtText(other["Артикул постачальника"]), nameUa: t["Назва постачальника UA"], nameRu: t["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000031-x.html", pictures: JSON.parse(t["Фото JSON"]) });
  await sync(w2, x2);
  setDecision(w2, SHEET.queue, "Offer ID", "2950000031", `ПРИВ'ЯЗАТИ ДО ${t["Offer ID"]} (ПІДТВЕРДЖУЮ)`);
  const r = await sync(w2, x2);
  assert.equal(r.stats.bound, 0);
  assert.match(queueRow(w2, "2950000031")["Перевірка"], new RegExp(`уже використовує товар ${other["Offer ID"]}`));
});

test("комплектація: інші назви (2 АКБ) і частково інші фото — звичайна прив'язка заборонена, показано конкретні відмінності", async () => {
  const w = await world();
  const t = card(w, 12);
  const photos = JSON.parse(t["Фото JSON"]);
  const xml = addOffer(perturb.drop(w.xml, [mtText(t["ID постачальника"])]), { id: "2950000012", sku: t["Артикул постачальника"], nameUa: t["Назва постачальника UA"] + " 2 АКБ 4 Ah", nameRu: t["Назва постачальника RU"] + " 2 АКБ 4 Ah", url: "https://market-tools.com.ua/p2950000012-x.html", pictures: [photos[0], "https://images.prom.ua/9990001_akb.jpg"] });
  await sync(w, xml);
  setDecision(w, SHEET.queue, "Offer ID", "2950000012", `ПРИВ'ЯЗАТИ ДО ${t["Offer ID"]}`);
  const r = await sync(w, xml);
  assert.equal(r.stats.bound, 0);
  const note = queueRow(w, "2950000012")["Перевірка"];
  assert.match(note, /потрібна додаткова ручна перевірка/);
  assert.match(note, /назви постачальника відрізняються/);
  assert.match(note, /фото частково різні/);
  assert.equal(mtText(byOffer(w, mtText(t["Offer ID"]))["ID постачальника"]), mtText(t["ID постачальника"]), "автоматичного об'єднання немає");
});

test("відкат посеред операції: збій під час прив'язки і під час відв'язування — картка, черга, історія як до запуску", async () => {
  const w = await world();
  const c = card(w, 7);
  const oldId = mtText(c["ID постачальника"]);
  const xml = addOffer(perturb.drop(w.xml, [oldId]), { id: NEW_ID, sku: "NEW-SKU-7", nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], url: `https://market-tools.com.ua/p${NEW_ID}-tovar.html`, pictures: JSON.parse(c["Фото JSON"]), price: 1234 });
  await sync(w, xml);
  setDecision(w, SHEET.queue, "Offer ID", NEW_ID, `ПРИВ'ЯЗАТИ ДО ${mtText(c["Offer ID"])}`);
  const mainBefore = structuredClone(w.book[SHEET.main]);
  const queueBefore = structuredClone(w.book[SHEET.queue]);
  w.sheets.armFailure("appendRows#1"); // запис історії прив'язок — після запису картки
  let r = await sync(w, xml);
  assert.equal(r.state, "ROLLED_BACK", JSON.stringify(r));
  assert.deepEqual(w.book[SHEET.main].map((x) => x.map(mtText)), mainBefore.map((x) => x.map(mtText)), "картку й ціни повернуто");
  assert.deepEqual(w.book[SHEET.queue].map((x) => x.map(mtText)), queueBefore.map((x) => x.map(mtText)), "черга як до запуску");
  assert.ok(!w.book[BINDINGS_SHEET] || w.book[BINDINGS_SHEET].length === 1, "історія без нових рядків");
  // Без збою — прив'язується
  r = await sync(w, xml);
  assert.equal(r.stats.bound, 1);
  // Збій посеред відв'язування (3-й updateRanges — стан у «Історії прив'язок», після запису картки)
  setDecision(w, BINDINGS_SHEET, "Offer ID", mtText(c["Offer ID"]), "СКАСУВАТИ");
  const mainBound = structuredClone(w.book[SHEET.main]);
  const histBound = structuredClone(w.book[BINDINGS_SHEET]);
  w.sheets.armFailure("updateRanges#3");
  r = await sync(w, xml);
  assert.equal(r.state, "ROLLED_BACK", JSON.stringify(r));
  assert.deepEqual(w.book[SHEET.main].map((x) => x.map(mtText)), mainBound.map((x) => x.map(mtText)), "картка лишилась прив'язаною");
  assert.deepEqual(w.book[BINDINGS_SHEET].map((x) => x.map(mtText)), histBound.map((x) => x.map(mtText)), "історія без змін");
  // Повтор без збою — відв'язується
  r = await sync(w, xml);
  assert.equal(r.stats.unbound, 1);
  assert.equal(mtText(byOffer(w, mtText(c["Offer ID"]))["ID постачальника"]), oldId);
  assert.ok(uniqueSupplierIds(w) && sealsOk(w));
});

test("подвійна прив'язка A→B→C: B повертається у фід (у черзі як нова) — скасування C→B забирає її з черги; ланцюжок історії збережено", async () => {
  const { w, ctx } = await boundWorld(); // картка: Offer ID = A, ID постачальника B (= NEW_ID)
  const C = "2950000077";
  let xml = addOffer(perturb.drop(ctx.xml, [NEW_ID]), { ...ctx.newOffer, id: C, sku: "NEW-SKU-77", url: `https://market-tools.com.ua/p${C}-tovar.html`, price: 2000 });
  await sync(w, xml);
  setDecision(w, SHEET.queue, "Offer ID", C, `ПРИВ'ЯЗАТИ ДО ${ctx.offerId}`);
  let r = await sync(w, xml);
  assert.equal(r.stats.bound, 1);
  assert.equal(mtText(byOffer(w, ctx.offerId)["ID постачальника"]), C);
  // B повертається у фід → у черзі як нова (її ID ≠ жодному Offer ID)
  xml = addOffer(xml, { ...ctx.newOffer, price: 999 });
  await sync(w, xml);
  assert.ok(queueRow(w, NEW_ID), "B у черзі");
  // Скасовуємо НОВІШУ прив'язку (B→C): картка повертає B і забирає її з черги
  const hist = w.book[BINDINGS_SHEET];
  const h = hist[0];
  hist.at(-1)[h.indexOf("Рішення")] = "СКАСУВАТИ";
  r = await sync(w, xml);
  assert.equal(r.stats.unbound, 1, JSON.stringify(r));
  const c = byOffer(w, ctx.offerId);
  assert.equal(mtText(c["ID постачальника"]), NEW_ID);
  assert.equal(c["Ціна постачальника"], 999, "ціна — з актуальної позиції B");
  assert.ok(!queueRow(w, NEW_ID), "B забрано з черги");
  assert.ok(queueRow(w, C), "C — знову в черзі");
  assert.ok(w.book[SHEET.journal].some((e) => e[3] === "ПОВЕРНУТО КАРТЦІ"));
  assert.match(hist[1][h.indexOf("Стан")], /^АКТИВНА/, "перша прив'язка A→B лишається активною");
  assert.ok(uniqueSupplierIds(w) && sealsOk(w));
  assert.equal(rows(w.book, SHEET.main).length, 132);
});
