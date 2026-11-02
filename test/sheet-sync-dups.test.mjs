/** S1: можливі дублі (назви, фото, комплектація), «ПРИВ'ЯЗАТИ ДО» і скасування, заморожені ID, масова зміна наявності. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { rowSeal, SEAL_COLUMN } from "../src/core/seal.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, BINDINGS_SHEET, extractFullOffers, readPassport } from "../src/core/sheet-sync.mjs";
import { compareEntries, entryKeys, kitDifferences } from "../src/core/dup-check.mjs";
import { mergeNew92, syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
// Старий режим (явно): регресія прийнятої механіки — див. helpers/legacy-config.mjs (рішення власника 29–30.10).
import baseConfig from "./helpers/legacy-config.mjs";
import { syncAndIntake } from "./helpers/intake.mjs";
import { loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";
import { STATE_A } from "./helpers/state-a.mjs";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();
const config = structuredClone(baseConfig);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function world() {
  const s = generateSynthetic({ products: 120, queue: 12, deferred: 4, newOffers: 0, seed: 7, now: NOW });
  const book = {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
  const w = { s, book, sheets: new MemorySheets(book), readBook: async () => structuredClone(book), xml: s.supplierXml() };
  await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  return w;
}
const rows = (book, name) => readSheet(book[name], name).rows;
async function sync(w, xml) {
  return syncAndIntake(w, xml, { stamp: STAMP, now: NOW, config });
}
/** Додати offer у кінець фіду (з фото й характеристиками — як у повному XML). */
function addOffer(xml, o) {
  const pics = (o.pictures ?? [`https://images.prom.ua/39${String(o.id).slice(-8)}_t.jpg`]).map((u) => `<picture>${esc(u)}</picture>`).join("");
  const params = (o.params ?? [{ name: "Потужність", value: "1000", unit: "Вт" }]).map((p) => `<param name="${esc(p.name)}"${p.unit ? ` unit="${esc(p.unit)}"` : ""}>${esc(p.value)}</param>`).join("");
  const line = `<offer id="${o.id}" available="${o.available ?? true}"><url>${esc(o.url)}</url><price>${o.price ?? 500}</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>${esc(o.nameRu)}</name><name_ua>${esc(o.nameUa)}</name_ua><vendorCode>${esc(o.sku)}</vendorCode>${o.vendor ? `<vendor>${esc(o.vendor)}</vendor>` : ""}<description><![CDATA[<p>опис</p>]]></description><description_ua><![CDATA[<p>опис</p>]]></description_ua>${pics}${params}<quantity_in_stock></quantity_in_stock></offer>`;
  return xml.replace("\n</offers>", "\n" + line + "\n</offers>");
}
const card = (w, k) => rows(w.book, SHEET.main)[k];

/** Заблокований запуск: змінено лише «Журнал» — рівно один рядок «ОНОВЛЕННЯ ЗАБЛОКОВАНО» потрібного типу. */
function assertOnlyBlockedJournal(before, after, type) {
  for (const k of Object.keys(before)) if (k !== SHEET.journal) assert.deepEqual(after[k], before[k], "аркуш «" + k + "» не змінено");
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "нових аркушів немає");
  const added = after[SHEET.journal].slice(before[SHEET.journal].length);
  assert.equal(added.length, 1, "у «Журналі» рівно один новий рядок");
  assert.equal(added[0][1], "СИСТЕМА");
  assert.equal(added[0][3], "ОНОВЛЕННЯ ЗАБЛОКОВАНО");
  assert.equal(added[0][4], type);
  assert.ok(String(added[0][6]).length > 10, "є зрозуміла причина");
}
const queueRow = (w, id) => rows(w.book, SHEET.queue).find((r) => mtText(r["Offer ID"]) === id);
function setDecision(w, id, value, sheet = SHEET.queue, keyCol = "Offer ID") {
  const v = w.book[sheet];
  const h = v[0].map(mtText);
  const r = v.find((x, i) => i > 0 && mtText(x[h.indexOf(keyCol)]) === id);
  r[h.indexOf("Рішення")] = value;
}

test("комплектація: без АКБ ↔ 2 АКБ 4 Ah, різна к-сть акумуляторів і зарядний у характеристиках — «ІНША КОМПЛЕКТАЦІЯ»", () => {
  const a = entryKeys({ id: "1", sheet: "Основний каталог", sku: "X18", nameUa: "Шурупокрут ABC X-18 без АКБ", nameRu: "Шуруповерт ABC X-18 без АКБ", photos: [], params: [{ name: "Кількість акумуляторів у комплекті", value: "0", unit: "" }, { name: "Зарядний пристрій", value: "Ні", unit: "" }] });
  const b = entryKeys({ id: "2", sku: "X18-2", nameUa: "Шурупокрут ABC X-18 2 АКБ 4 Ah", nameRu: "Шуруповерт ABC X-18 2 АКБ 4 Ah", photos: [], params: [{ name: "Кількість акумуляторів у комплекті", value: "2", unit: "шт" }, { name: "Зарядний пристрій", value: "Так", unit: "" }, { name: "Кейс", value: "Так", unit: "" }] });
  const diff = kitDifferences(a, b);
  assert.ok(diff.includes("з АКБ / без АКБ"), diff.join());
  assert.ok(diff.includes("кількість АКБ") && diff.includes("зарядний пристрій"), diff.join());
  const cmp = compareEntries(a, b);
  assert.equal(cmp.level, "ІНША КОМПЛЕКТАЦІЯ / МОДИФІКАЦІЯ?");
});

test("фото: усі спільні → сильна ознака; різні → показано закінчення обох посилань (не остаточне рішення)", () => {
  const p = (n) => `https://images.prom.ua/${n}_tovar.jpg`;
  const a = entryKeys({ id: "1", sheet: "Основний каталог", sku: "A1", nameUa: "Пила ABC", nameRu: "Пила ABC", photos: [p(1115432), p(1115433)] });
  const same = compareEntries(a, entryKeys({ id: "2", sku: "B2", nameUa: "Пила ABC", nameRu: "Пила ABC", photos: [p(1115432), p(1115433)] }));
  assert.deepEqual([same.photo.shared, same.level], [2, "ЙМОВІРНО ТОЙ САМИЙ"]);
  const diff = compareEntries(a, entryKeys({ id: "3", sku: "A1", nameUa: "Пила ABC", nameRu: "Пила ABC", photos: [p(2226583)] }));
  assert.equal(diff.photo.shared, 0);
  assert.deepEqual([diff.photo.cardSample, diff.photo.offerSample], ["…5432", "…6583"]);
  assert.equal(diff.level, "ЙМОВІРНО ТОЙ САМИЙ", "артикул і назви збігаються — фото самі по собі не вирішують");
});

test("дубль лише за назвою (інший ID і артикул) → у черзі з «МОЖЛИВИЙ ДУБЛЬ» і посиланням на товар основного каталогу", async () => {
  const w = await world();
  await sync(w, w.xml);
  const c = card(w, 5);
  const xml = addOffer(w.xml, { id: "2950000001", sku: "OTHER-SKU", nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000001-insha-storinka.html" });
  const r = await sync(w, xml);
  assert.equal(r.state, "SYNCED");
  const q = queueRow(w, "2950000001");
  assert.ok(q, "додано в чергу, не відкинуто");
  assert.match(q["Перевірка"], new RegExp(`МОЖЛИВИЙ ДУБЛЬ: ${c["Offer ID"]} \\(«Основний каталог»\\)`));
  assert.match(q["Перевірка"], /назва UA, назва RU/);
  assert.equal(rows(w.book, SHEET.main).length, 132, "в основний каталог автоматично не потрапив");
});

test("зміна ID постачальника → дубль із підказкою → «ПРИВ'ЯЗАТИ ДО» зберігає Offer ID і SEO, пише історію; повтор без дублів; скасування повертає як було", async () => {
  const w = await world();
  await sync(w, w.xml);
  const c = card(w, 7);
  const oldSupplier = mtText(c["ID постачальника"]);
  const seo = [c["Назва UA"], c["Опис UA"], c["Фото JSON"], c["Характеристики JSON"]];
  const photos = JSON.parse(c["Фото JSON"]);
  // Постачальник перевипустив товар під новим ID (той самий артикул, назви, фото)
  let xml = perturb.drop(w.xml, [oldSupplier]);
  xml = addOffer(xml, { id: "2950000007", sku: c["Артикул постачальника"], nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000007-tovar.html", pictures: photos, available: true, price: 1234 });
  let r = await sync(w, xml);
  assert.equal(r.state, "SYNCED");
  assert.equal(card(w, 7)["Наявність"], "-", "стара картка — «немає в наявності»");
  const q = queueRow(w, "2950000007");
  assert.match(q["Перевірка"], /ЙМОВІРНО ТОЙ САМИЙ/);
  assert.match(q["Перевірка"], /зник із фіду/);
  assert.match(q["Перевірка"], new RegExp(`ПРИВ'ЯЗАТИ ДО ${c["Offer ID"]}`));
  assert.match(q["Перевірка"], new RegExp(`фото: спільних ${photos.length} з ${photos.length}`));
  // Автоматичної прив'язки немає
  assert.equal(mtText(card(w, 7)["ID постачальника"]), oldSupplier);

  setDecision(w, "2950000007", `ПРИВ'ЯЗАТИ ДО ${c["Offer ID"]}`);
  const passportBefore = readPassport(w.book[SHEET.passport]);
  r = await sync(w, xml);
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  assert.equal(r.stats.bound, 1);
  const b = card(w, 7);
  assert.equal(mtText(b["Offer ID"]), mtText(c["Offer ID"]), "Offer ID Prom збережено");
  assert.deepEqual([b["Назва UA"], b["Опис UA"], b["Фото JSON"], b["Характеристики JSON"]], seo, "SEO, фото, характеристики збережено");
  assert.equal(mtText(b["ID постачальника"]), "2950000007");
  assert.equal(b["Наявність"], "+");
  assert.equal(b["Ціна постачальника"], 1234);
  assert.equal(rowSeal(b), b[SEAL_COLUMN]);
  // ENG-27 (Hermes INT N3): рядок черги з командою лишається (B6: видалення заблоковано), рішення власника не стерто.
  assert.equal(mtText(queueRow(w, "2950000007")["Рішення"]), `ПРИВ'ЯЗАТИ ДО ${c["Offer ID"]}`, "рядок і рішення власника лишились");
  assert.equal(r.queueRemoval.state, "BLOCKED_B6");
  assert.ok(r.queueRemoval.keys.includes("2950000007"));
  assert.equal(rows(w.book, SHEET.main).length, 132, "дубль не створено");
  const hist = w.book[BINDINGS_SHEET];
  assert.equal(hist.length, 2);
  assert.equal(hist[1][2], oldSupplier, "старий ID постачальника в історії");
  assert.equal(hist[1][15], "АКТИВНА");
  assert.notEqual(readPassport(w.book[SHEET.passport]).contentSha, passportBefore.contentSha, "паспорт оновлено");
  r = await sync(w, xml);
  assert.equal(r.stats.added, 0, "повторний запуск не повертає позицію в чергу");
  assert.equal(r.stats.bound, 0, "команда в черзі вдруге не виконується (ідемпотентність за «Історією прив'язок»)");
  assert.equal(w.book[BINDINGS_SHEET].length, 2, "історія без повторного запису");
  assert.match(queueRow(w, "2950000007")["Перевірка"], /ПРИВ'ЯЗАНО РАНІШЕ/);

  // Скасування помилкової прив'язки
  setDecision(w, c["Offer ID"], "СКАСУВАТИ", BINDINGS_SHEET);
  r = await sync(w, xml);
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  assert.equal(r.stats.unbound, 1);
  assert.equal(mtText(card(w, 7)["ID постачальника"]), oldSupplier, "повернуто старий ID постачальника");
  assert.equal(card(w, 7)["Наявність"], "-");
  assert.match(w.book[BINDINGS_SHEET][1][15], /^СКАСОВАНА/);
  assert.ok(queueRow(w, "2950000007"), "позиція знову в черзі для рішення");
  assert.ok(rows(w.book, SHEET.main).every((x) => rowSeal(x) === x[SEAL_COLUMN]));
  // ENG-27 (N3): команда «ПРИВ'ЯЗАТИ ДО», що лишилась у черзі, скасовану власником прив'язку не відновлює.
  r = await sync(w, xml);
  assert.equal(r.stats.bound, 0, "скасовану прив'язку не відновлено");
  assert.equal(mtText(card(w, 7)["ID постачальника"]), oldSupplier);
  assert.match(queueRow(w, "2950000007")["Перевірка"], /скасовано власником/);
  assert.equal(w.book[BINDINGS_SHEET].length, 2);
});

test("конфлікти прив'язки: стара позиція досі у фіді; ID уже має інший товар; різні фото без «(ПІДТВЕРДЖУЮ)» — не прив'язано, з поясненням", async () => {
  const w = await world();
  await sync(w, w.xml);
  const c = card(w, 3);
  const photos = JSON.parse(c["Фото JSON"]);
  // 1) стара позиція товару 3 досі у фіді
  let xml = addOffer(w.xml, { id: "2950000003", sku: c["Артикул постачальника"], nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000003-x.html", pictures: photos });
  await sync(w, xml);
  setDecision(w, "2950000003", `ПРИВ'ЯЗАТИ ДО ${c["Offer ID"]}`);
  let r = await sync(w, xml);
  assert.equal(r.stats.bound, 0);
  assert.match(queueRow(w, "2950000003")["Перевірка"], /НЕ ПРИВ'ЯЗАНО: .*досі є у фіді/);
  // 2) різні фото: потрібне «(ПІДТВЕРДЖУЮ)»
  const d = card(w, 4);
  xml = perturb.drop(xml, [mtText(d["ID постачальника"])]);
  xml = addOffer(xml, { id: "2950000004", sku: d["Артикул постачальника"], nameUa: d["Назва постачальника UA"], nameRu: d["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000004-x.html", pictures: ["https://images.prom.ua/9996583_inshe.jpg"] });
  await sync(w, xml);
  setDecision(w, "2950000004", `ПРИВ'ЯЗАТИ ДО ${d["Offer ID"]}`);
  r = await sync(w, xml);
  assert.equal(r.stats.bound, 0);
  assert.match(queueRow(w, "2950000004")["Перевірка"], /фото різні .*ПІДТВЕРДЖУЮ/);
  setDecision(w, "2950000004", `ПРИВ'ЯЗАТИ ДО ${d["Offer ID"]} (ПІДТВЕРДЖУЮ)`);
  r = await sync(w, xml);
  assert.equal(r.stats.bound, 1, "власник підтвердив попри сумнів");
  assert.match(w.book[BINDINGS_SHEET].at(-1)[14], /підтверджено власником попри: фото різні/);
});

test("заморожені ID: сильний збіг із товаром, що зник із фіду → у черзі з позначкою; слабкий збіг із живим товаром → ігнор (без старого шуму)", async () => {
  const w = await world();
  await sync(w, w.xml);
  const c = card(w, 9), live = card(w, 10);
  w.book[SHEET.frozen].push(["2950000009"], ["2950000010"]);
  let xml = perturb.drop(w.xml, [mtText(c["ID постачальника"])]);
  xml = addOffer(xml, { id: "2950000009", sku: c["Артикул постачальника"], nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000009-x.html" });
  xml = addOffer(xml, { id: "2950000010", sku: live["Артикул постачальника"], nameUa: live["Назва постачальника UA"] + " 2 АКБ", nameRu: live["Назва постачальника RU"] + " 2 АКБ", url: "https://market-tools.com.ua/p2950000010-x.html" });
  const r = await sync(w, xml);
  assert.equal(r.state, "SYNCED");
  assert.match(queueRow(w, "2950000009")["Перевірка"], /МОЖЛИВИЙ ДУБЛЬ \(ID у «Заморожених ID»\)/);
  assert.ok(!queueRow(w, "2950000010"), "заморожений шум не повернувся");
});

test("повернення товару з тим самим ID оновлює ціну й наявність; масова зміна наявності у фіді — нічого не записано", async () => {
  const w = await world();
  await sync(w, w.xml);
  const c = card(w, 11);
  const id = mtText(c["ID постачальника"]);
  await sync(w, perturb.drop(w.xml, [id]));
  assert.equal(card(w, 11)["Наявність"], "-");
  const back = perturb.tag(w.xml, id, "price", "4321");
  await sync(w, back);
  assert.equal(card(w, 11)["Ціна постачальника"], 4321);
  assert.equal(card(w, 11)["Стан синхронізації"], "ЗІСТАВЛЕНО");
  const snap = structuredClone(w.book);
  const allOff = back.replace(/available="true"/g, 'available="false"');
  const r = await sync(w, allOff);
  assert.equal(r.state, "ABORTED");
  assert.match(r.reason, /«немає в наявності» стало \d+ товарів/);
  assertOnlyBlockedJournal(snap, w.book, "МАСОВА ЗМІНА НАЯВНОСТІ");
});

test("конфлікти прив'язки: ID постачальника вже має інший товар; дві позиції на один товар; черга змінена під час запуску — нічого не прив'язано", async () => {
  const w = await world();
  let xml = w.xml;
  const a = card(w, 20), b = card(w, 21), t = card(w, 22);
  xml = perturb.drop(xml, [mtText(t["ID постачальника"])]);
  xml = addOffer(xml, { id: "2950000022", sku: t["Артикул постачальника"], nameUa: t["Назва постачальника UA"], nameRu: t["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000022-x.html" });
  xml = addOffer(xml, { id: "2950000023", sku: t["Артикул постачальника"], nameUa: t["Назва постачальника UA"], nameRu: t["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000023-x.html" });
  await sync(w, xml);
  // Дві позиції прив'язують до одного товару
  setDecision(w, "2950000022", `ПРИВ'ЯЗАТИ ДО ${t["Offer ID"]}`);
  setDecision(w, "2950000023", `ПРИВ'ЯЗАТИ ДО ${t["Offer ID"]}`);
  let r = await sync(w, xml);
  assert.equal(r.stats.bound, 0);
  assert.match(queueRow(w, "2950000022")["Перевірка"], /кілька позицій/);
  // ID постачальника позиції черги вже використовує інший товар (ручна правка рядка черги)
  setDecision(w, "2950000023", "");
  const h = w.book[SHEET.queue][0].map(mtText);
  const qr = w.book[SHEET.queue].find((x) => mtText(x[0]) === "2950000022");
  qr[h.indexOf("ID постачальника")] = mtText(a["ID постачальника"]);
  r = await sync(w, xml);
  assert.equal(r.stats.bound, 0);
  assert.match(queueRow(w, "2950000022")["Перевірка"], new RegExp(`вже використовує товар ${a["Offer ID"]}`));
  qr[h.indexOf("ID постачальника")] = "2950000022";
  setDecision(w, "2950000022", `ПРИВ'ЯЗАТИ ДО ${t["Offer ID"]} (ПІДТВЕРДЖУЮ)`); // фото немає — без підтвердження прив'язка не пройде
  // Черга змінилась між читанням і записом, а в ній є прив'язка → нічого не записано
  const snap = structuredClone(w.book);
  let calls = 0;
  const racy = async () => { calls++; const bk = structuredClone(w.book); if (calls === 2) bk[SHEET.queue][1][0] = "змінено"; return bk; };
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  r = await syncSheet({ sheets: w.sheets, readBook: racy, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config, now: NOW, catalog: loadPromCatalog(undefined, STATE_A) });
  assert.equal(r.state, "SKIPPED_CONCURRENT_EDIT");
  assert.deepEqual(w.book, snap);
  assert.ok(b);
});

test("ENG-27 N3: «ПРИВ'ЯЗАТИ ДО» власник змінив одразу після запису картки — CONFLICT «після запису» (не SYNCED); нове рішення не стерто, рядок черги не видалено", async () => {
  const w = await world();
  await sync(w, w.xml);
  const c = card(w, 7);
  const oldSupplier = mtText(c["ID постачальника"]);
  let xml = perturb.drop(w.xml, [oldSupplier]);
  xml = addOffer(xml, { id: "2950000007", sku: c["Артикул постачальника"], nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000007-tovar.html", pictures: JSON.parse(c["Фото JSON"]), available: true, price: 1234 });
  await sync(w, xml);
  assert.ok(queueRow(w, "2950000007"), "передумова: позиція в черзі");
  setDecision(w, "2950000007", `ПРИВ'ЯЗАТИ ДО ${c["Offer ID"]}`);
  const qLen = w.book[SHEET.queue].length;
  // Власник змінює рішення одразу після запису історії прив'язки (картку вже записано).
  const raw = w.sheets.appendRows.bind(w.sheets);
  let injected = 0;
  w.sheets.appendRows = async (t, rws) => { const res = await raw(t, rws); if (t === BINDINGS_SHEET && !injected) { injected++; setDecision(w, "2950000007", "нотатка власника"); } return res; };
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  const r = await syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config, now: NOW, catalog: loadPromCatalog(undefined, STATE_A) });
  w.sheets.appendRows = raw;
  assert.equal(injected, 1);
  assert.equal(r.state, "CONFLICT_OWNER_EDIT", JSON.stringify(r).slice(0, 400));
  assert.ok(r.queueConflicts.some((x) => x.key === "2950000007" && /після запису/.test(x.phase)), "про виконану прив'язку за зміненим рішенням — звіт");
  assert.equal(mtText(queueRow(w, "2950000007")["Рішення"]), "нотатка власника", "нове рішення власника не стерто");
  assert.equal(w.book[SHEET.queue].length, qLen, "рядок черги не видалено");
});

test("ENG-27 N3: «ПРИВ'ЯЗАТИ ДО» змінено після перевірки черги, але до запису картки — нічого не записано (SKIPPED_CONCURRENT_EDIT), картку не прив'язано", async () => {
  const w = await world();
  await sync(w, w.xml);
  const c = card(w, 7);
  const oldSupplier = mtText(c["ID постачальника"]);
  let xml = perturb.drop(w.xml, [oldSupplier]);
  xml = addOffer(xml, { id: "2950000007", sku: c["Артикул постачальника"], nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], url: "https://market-tools.com.ua/p2950000007-tovar.html", pictures: JSON.parse(c["Фото JSON"]), available: true, price: 1234 });
  await sync(w, xml);
  setDecision(w, "2950000007", `ПРИВ'ЯЗАТИ ДО ${c["Offer ID"]}`);
  const histBefore = structuredClone(w.book[BINDINGS_SHEET] || null);
  // Правка власника — під час читання «Основного каталогу» перед записом (після перевірки незмінності черги).
  let injected = 0;
  const readBook = async (names) => { if (!injected && Array.isArray(names) && names.length === 1 && names[0] === SHEET.main) { injected++; setDecision(w, "2950000007", "нотатка власника"); } return w.readBook(names); };
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  const r = await syncSheet({ sheets: w.sheets, readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config, now: NOW, catalog: loadPromCatalog(undefined, STATE_A) });
  assert.equal(injected, 1);
  assert.equal(r.state, "SKIPPED_CONCURRENT_EDIT", JSON.stringify(r).slice(0, 400));
  assert.ok(r.queueConflicts?.some((x) => x.key === "2950000007"));
  assert.equal(mtText(card(w, 7)["ID постачальника"]), oldSupplier, "картку не прив'язано");
  assert.deepEqual(w.book[BINDINGS_SHEET] || null, histBefore, "історія без змін");
  assert.equal(mtText(queueRow(w, "2950000007")["Рішення"]), "нотатка власника");
});
