/** S1: запис нової системи в таблицю (варіант A) — на книзі в пам'яті, без мережі. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { rowSeal, SEAL_COLUMN, YML_HEADERS } from "../src/core/seal.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, QUEUE_HEADERS, DECISION, extractFullOffers, readPassport } from "../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet, refreshCopyFromLive } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets, GoogleSheetsWriter, rangeA1 } from "../src/pipeline/sheets-writer.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import baseConfig from "../config/default.json" with { type: "json" };
import { syncAndIntake } from "./helpers/intake.mjs";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();
const config = structuredClone(baseConfig);

function world({ products = 120, queue = 12, newOffers = 3, seed = 5 } = {}) {
  const s = generateSynthetic({ products, queue, deferred: 4, newOffers, seed, now: NOW });
  const book = {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
  const sheets = new MemorySheets(book);
  const readBook = async () => structuredClone(book);
  return { s, book, sheets, readBook, xml: s.supplierXml() };
}
const parse = (xml) => parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
const rows = (book, name) => readSheet(book[name], name).rows;
async function sync(w, xml = w.xml, extra = {}) {
  return syncAndIntake(w, xml, { stamp: STAMP, now: NOW, config, readBook: extra.readBook });
}
const sealsIntact = (book) => rows(book, SHEET.main).every((r) => rowSeal(r) === mtText(r[SEAL_COLUMN]));

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

test("NEW92 → основний каталог: усі рядки байт-у-байт, ті самі ID, черга порожня з колонками черги, паспорт створено", async () => {
  const w = world();
  const queueBefore = rows(w.book, SHEET.queue);
  const r = await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  assert.equal(r.state, "MERGED", JSON.stringify(r));
  assert.equal(r.count, 132);
  const main = rows(w.book, SHEET.main);
  for (const q of queueBefore) {
    const m = main.find((x) => x["Offer ID"] === q["Offer ID"]);
    assert.ok(m, "ID збережено");
    for (const k of YML_HEADERS) assert.equal(mtText(m[k]), mtText(q[k]), k);
  }
  assert.deepEqual(w.book[SHEET.queue][0], QUEUE_HEADERS.slice());
  assert.equal(w.book[SHEET.queue].length, 1);
  assert.equal(readPassport(w.book[SHEET.passport]).count, 132);
  assert.ok(sealsIntact(w.book));
  const again = await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  assert.equal(again.state, "PRECONDITION_FAILED", "повторне перенесення неможливе");
});

test("синхронізація: ціни й наявність оновлено, SEO не змінено; нові позиції в черзі з даними постачальника; повтор без дублікатів", async () => {
  const w = world();
  await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  const seoBefore = rows(w.book, SHEET.main).map((r) => [r["Offer ID"], r["Назва UA"], r["Опис UA"], r[SEAL_COLUMN]]);
  const r = await sync(w);
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  assert.equal(r.stats.added, 3);
  const main = rows(w.book, SHEET.main);
  assert.deepEqual(main.map((x) => [x["Offer ID"], x["Назва UA"], x["Опис UA"], x[SEAL_COLUMN]]), seoBefore, "SEO і печатки без змін");
  assert.ok(main.every((x) => x["Оновлено"] === STAMP));
  const offers = (await parse(w.xml)).offers;
  const changed = main.filter((x) => offers.get(x["ID постачальника"]) && Number(x["Ціна постачальника"]) === offers.get(x["ID постачальника"]).price);
  assert.equal(changed.length, main.length, "ціна постачальника = поточна з фіду");
  const q = rows(w.book, SHEET.queue);
  assert.equal(q.length, 3);
  assert.ok(q.every((x) => x["Статус імпорту"] === "НОВИЙ_ВІД_ПОСТАЧАЛЬНИКА" && x["Назва постачальника UA"] && x["Виявлено"] === new Date(NOW - 11 * 60000).toISOString()), "«Виявлено» = перше виявлення «Сторожем новинок»");
  assert.ok(w.book[SHEET.journal].some((e) => e[1] === "СИСТЕМА" && e[3] === "ЗАВЕРШЕНО"));
  const r2 = await sync(w);
  assert.equal(r2.stats.added, 0, "повторний запуск не дублює");
  assert.equal(rows(w.book, SHEET.queue).length, 3);
});

test("зміна ціни, зміна наявності і зникнення одного товару — відображено; масове зникнення — нічого не записано", async () => {
  const w = world();
  await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  await sync(w);
  const [a, b, c] = rows(w.book, SHEET.main).slice(0, 3).map((x) => x["ID постачальника"]);
  const offers = (await parse(w.xml)).offers;
  let xml = perturb.tag(w.xml, a, "price", String(offers.get(a).price + 100));
  xml = xml.replace(new RegExp(`(<offer id="${b}" available=")(true|false)`), (_, p, v) => p + (v === "true" ? "false" : "true"));
  xml = perturb.drop(xml, [c]);
  const r = await sync(w, xml);
  assert.equal(r.state, "SYNCED");
  const by = new Map(rows(w.book, SHEET.main).map((x) => [x["ID постачальника"], x]));
  assert.equal(by.get(a)["Ціна постачальника"], offers.get(a).price + 100);
  assert.equal(by.get(b)["Наявність"], offers.get(b).available ? "-" : "+");
  assert.equal(by.get(c)["Наявність"], "-");
  assert.equal(by.get(c)["Стан синхронізації"], "ВІДСУТНІЙ_У_YML");
  assert.ok(by.get(c)["Опис UA"], "картка й контент лишились");
  assert.ok(r.stats.main.supplierPriceChanged >= 1 && r.stats.main.availabilityChanged >= 1, JSON.stringify(r.stats.main));
  assert.equal(r.stats.main.missingInFeed, 1);
  assert.equal(r.stats.before.uniqueIds, r.stats.before.mainRows);
  assert.ok(sealsIntact(w.book));

  const snapshot = structuredClone(w.book);
  const mass = perturb.drop(w.xml, rows(w.book, SHEET.main).slice(0, 60).map((x) => x["ID постачальника"]));
  const r2 = await sync(w, mass);
  assert.equal(r2.state, "ABORTED");
  assert.match(r2.reason, /збій постачальника/);
  assertOnlyBlockedJournal(snapshot, w.book, "МАСОВЕ ЗНИКНЕННЯ");
  assert.match(w.book[SHEET.journal].at(-1)[5], /зачеплено 60; поріг 50/);
});

test("затвердження: без SEO — лишається з поясненням; з SEO — переноситься з тим самим ID і зникає з черги; паспорт оновлено", async () => {
  const w = world();
  await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  await sync(w);
  const header = w.book[SHEET.queue][0];
  const col = (k) => header.indexOf(k);
  const row = w.book[SHEET.queue][1];
  const id = row[col("Offer ID")];
  row[col("Рішення")] = DECISION.APPROVE;
  let r = await sync(w);
  assert.equal(r.stats.approved, 0);
  const q1 = rows(w.book, SHEET.queue).find((x) => x["Offer ID"] === id);
  assert.match(q1["Перевірка"], /НЕ ПЕРЕНЕСЕНО/);
  // Власник заповнює SEO
  const row2 = w.book[SHEET.queue].find((x) => x[col("Offer ID")] === id);
  Object.entries({ "Назва UA": "Новий товар — SEO UA", "Назва RU": "Новый товар — SEO RU", "Опис UA": "<p>Опис</p>", "Опис RU": "<p>Описание</p>",
    "Фото JSON": JSON.stringify(["https://images.prom.ua/1_x.jpg"]), "Характеристики JSON": "[]", "Група ID": w.book[SHEET.groups][1][0], "Категорія Prom ID": "123" })
    .forEach(([k, v]) => { row2[col(k)] = v; });
  const passportBefore = readPassport(w.book[SHEET.passport]);
  r = await sync(w);
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  assert.equal(r.stats.approved, 1);
  const moved = rows(w.book, SHEET.main).find((x) => x["Offer ID"] === id);
  assert.ok(moved, "той самий Offer ID в основному каталозі");
  assert.equal(moved["Статус імпорту"], "ДОЗВОЛЕНО");
  assert.equal(rowSeal(moved), moved[SEAL_COLUMN]);
  assert.ok(!rows(w.book, SHEET.queue).some((x) => x["Offer ID"] === id), "зник із черги");
  assert.equal(readPassport(w.book[SHEET.passport]).count, passportBefore.count + 1);
  const r3 = await sync(w);
  assert.equal(r3.stats.added, 0, "затверджений не повертається в чергу як новий");
});

test("відхилення: позиція зникає з черги, ID додається до «Заморожених», повторно не з'являється", async () => {
  const w = world();
  await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  await sync(w);
  const header = w.book[SHEET.queue][0];
  const row = w.book[SHEET.queue][1];
  const id = row[header.indexOf("Offer ID")];
  row[header.indexOf("Рішення")] = "відхилено";
  const r = await sync(w);
  assert.equal(r.stats.rejected, 1);
  assert.ok(w.book[SHEET.frozen].some((x) => x[0] === id));
  assert.ok(!rows(w.book, SHEET.queue).some((x) => x["Offer ID"] === id));
  assert.equal((await sync(w)).stats.added, 0);
});

test("захисти: зміна SEO поза затвердженням → нічого не записано; редагування черги під час запуску → лише ціни; збій запису → відкат", async () => {
  const w = world();
  await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  await sync(w);
  // 1. Хтось змінив назву в основному каталозі
  const hdr = w.book[SHEET.main][0];
  const saved = w.book[SHEET.main][1][hdr.indexOf("Назва UA")];
  w.book[SHEET.main][1][hdr.indexOf("Назва UA")] = saved + " (змінено)";
  const snap = structuredClone(w.book);
  const r1 = await sync(w);
  assert.equal(r1.state, "ABORTED");
  assert.match(r1.reason, /паспорту/);
  assertOnlyBlockedJournal(snap, w.book, "ЗМІНИ ПОЗА ЗАТВЕРДЖЕННЯМ");
  w.book[SHEET.main][1][hdr.indexOf("Назва UA")] = saved;
  // 2. Черга змінилась між читанням і записом
  let calls = 0;
  const racy = async (names) => { calls++; const b = structuredClone(w.book); if (calls === 2) b[SHEET.queue][1][0] = "змінено власником"; return b; };
  const queueBefore = structuredClone(w.book[SHEET.queue]);
  const r2 = await sync(w, w.xml, { readBook: racy });
  assert.equal(r2.state, "SYNCED");
  assert.equal(r2.queueChanged, true);
  assert.deepEqual(w.book[SHEET.queue].map((r) => r.map(mtText)), queueBefore.map((r) => r.map(mtText)), "черга не чіпана");
  // 3. Збій посеред запису → повернення
  const opsBefore = structuredClone(w.book[SHEET.main]);
  const header = w.book[SHEET.queue][0];
  w.book[SHEET.queue][1][header.indexOf("Рішення")] = DECISION.REJECT;
  const queueSnap = structuredClone(w.book[SHEET.queue]); // стан на початку запуску (з рішенням власника)
  const frozenSnap = structuredClone(w.book[SHEET.frozen]);
  w.sheets.failOn = "appendRows";
  const xml2 = perturb.tag(w.xml, rows(w.book, SHEET.main)[0]["ID постачальника"], "price", "777");
  const r3 = await sync(w, xml2);
  assert.equal(r3.state, "ROLLED_BACK");
  assert.deepEqual(w.book[SHEET.main].map((r) => r.map(mtText)), opsBefore.map((r) => r.map(mtText)), "ціни повернуто");
  assert.deepEqual(w.book[SHEET.frozen], frozenSnap, "заморожені без змін");
  assert.deepEqual(w.book[SHEET.queue].slice(1).map((r) => r.slice(0, queueSnap[0].length).map(mtText)), queueSnap.slice(1).map((r) => r.map(mtText)), "черга повернута");
  assert.ok(w.book[SHEET.journal].some((e) => e[3] === "ПОМИЛКА"), "помилку записано в журнал");
});

test("запис у ЖИВУ таблицю заборонено на рівні коду; діапазони A1 коректні", () => {
  const live = "LIVE_SHEET_ID_0123456789abcdefXYZ";
  assert.throws(() => new GoogleSheetsWriter({ spreadsheetId: live, liveSpreadsheetId: live, getAccessToken: async () => "x" }), /ЖИВА/);
  assert.throws(() => new GoogleSheetsWriter({ spreadsheetId: "COPY_SHEET_ID_0123456789abcdefXYZ", getAccessToken: async () => "x" }), /ID живої/);
  assert.equal(rangeA1("Основний каталог", 2, 6, 5121, 8), "'Основний каталог'!F2:M5122");
  assert.equal(rangeA1("O'K", 1, 1, 1, 43), "'O''K'!A1:AQ1");
});

test("повний XML постачальника: CDATA, фото, характеристики з одиницями", () => {
  const xml = `<offer id="9" available="true"><name>RU</name><name_ua>UA</name_ua><description><![CDATA[<p>опис RU</p>]]></description><description_ua><![CDATA[<p>опис</p>]]></description_ua><picture>https://x/1.jpg</picture><picture>https://x/2.jpg</picture><param name="Потужність" unit="Вт">800</param><param name="Колір">Червоний &amp; чорний</param><country_of_origin>Китай</country_of_origin></offer>`;
  const m = extractFullOffers(xml, ["9", "10"]).get("9");
  assert.equal(m.descriptionUa, "<p>опис</p>");
  assert.deepEqual(m.pictures, ["https://x/1.jpg", "https://x/2.jpg"]);
  assert.deepEqual(m.params, [{ name: "Потужність", value: "800", unit: "Вт" }, { name: "Колір", value: "Червоний & чорний", unit: "" }]);
  assert.equal(m.country, "Китай");
});

/** «Жива» книга після правок Claude1: «Код товару Prom» заповнено в усіх рядках NEW92, печатки перераховано. */
function liveAfterClaude1(book) {
  const live = structuredClone(book);
  const h = live[SHEET.queue][0];
  for (const r of live[SHEET.queue].slice(1)) {
    r[h.indexOf("Код товару Prom")] = "MT-NEW-" + r[0].slice(-4);
    const o = Object.fromEntries(h.map((k, i) => [k, r[i]]));
    r[h.indexOf(SEAL_COLUMN)] = rowSeal(o);
  }
  // mtUpdate у живій таблиці тим часом оновив ціни
  const mh = live[SHEET.main][0];
  live[SHEET.main][1][mh.indexOf("Ціна постачальника")] = 12345.67;
  return live;
}

test("освіжити копію: після Claude1 — копія = жива; лише ціни в основному каталозі, NEW92 повністю; усі коди й печатки на місці", async () => {
  const w = world({ queue: 12 });
  const live = liveAfterClaude1(w.book);
  const r = await refreshCopyFromLive({ sheets: w.sheets, readCopy: w.readBook, readLive: async () => structuredClone(live), expectNew92: 12 });
  assert.equal(r.state, "REFRESHED", JSON.stringify(r));
  assert.equal(r.actions[SHEET.main], "лише ціни/наявність");
  assert.equal(r.actions[SHEET.queue], "переписано повністю");
  assert.equal(r.verify.new92Codes, 12);
  assert.deepEqual(w.book[SHEET.queue].map((x) => x.map(mtText)), live[SHEET.queue].map((x) => x.map(mtText)));
  // далі перенесення бере вже оновлені коди
  const m = await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  assert.equal(m.state, "MERGED");
  assert.ok(rows(w.book, SHEET.main).slice(-12).every((x) => /^MT-NEW-/.test(x["Код товару Prom"])));
});

test("освіжити копію: Claude1 ще не закінчив (порожній код) або печатку не перераховано — у копію нічого не пишеться", async () => {
  for (const spoil of ["code", "seal"]) {
    const w = world({ queue: 12 });
    const live = liveAfterClaude1(w.book);
    const h = live[SHEET.queue][0];
    if (spoil === "code") live[SHEET.queue][3][h.indexOf("Код товару Prom")] = "";
    else live[SHEET.queue][3][h.indexOf("Код товару Prom")] = "MT-БЕЗ-ПЕЧАТКИ";
    const before = structuredClone(w.book);
    const r = await refreshCopyFromLive({ sheets: w.sheets, readCopy: w.readBook, readLive: async () => structuredClone(live), expectNew92: 12 });
    assert.equal(r.state, "PRECONDITION_FAILED", spoil);
    assert.deepEqual(w.book, before, spoil + ": копія не змінена");
  }
});

test("освіжити копію після тестового перенесення: копія повністю повертається до стану живої (5029 + NEW92 окремо)", async () => {
  const w = world({ queue: 12 });
  const live = liveAfterClaude1(w.book);
  await mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP });
  const r = await refreshCopyFromLive({ sheets: w.sheets, readCopy: w.readBook, readLive: async () => structuredClone(live), expectNew92: 12 });
  assert.equal(r.state, "REFRESHED", JSON.stringify(r.verify));
  assert.equal(rows(w.book, SHEET.main).length, 120);
  assert.equal(rows(w.book, SHEET.queue).length, 12);
});
