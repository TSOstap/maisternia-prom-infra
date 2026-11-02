/** Пріоритет власника в справжньому syncSheet (config.ownerPriority.enabled; фінальні вимоги 29.10; Hermes CC4-REQ-MANUAL).
 *  Ручна правка контенту — не глобальна зупинка; поле постачальника йде за фідом; кастомне — ні, але «було → стало» в аркуші
 *  попереджень без дублів; критична зміна ідентичності / правка між читанням і записом — ізоляція лише цього товару. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import { STATE_COLUMN, readState, SRC } from "../src/core/field-control.mjs";
import { WARN_SHEET } from "../src/pipeline/supplier-warnings.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const NOW = Date.parse("2026-10-22T10:00:00Z"), STAMP = new Date(NOW).toISOString();
// op = false — ЯВНИЙ старий режим (порівняння з прийнятою поведінкою); типово пріоритет власника увімкнено.
const cfg = (op) => { const c = structuredClone(baseConfig); c.ownerPriority = { enabled: Boolean(op) }; return c; };
// CC R6: у режимі пріоритету власника синхронізація вимагає достовірного стану CC (двійник: нічого не видалено, фільтр пропускає).
const OK_CC = Object.freeze({ held: new Set(), removed: new Set(), blocked: false, reasons: [], fingerprint: "fp-ok", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });

async function world() {
  const s = generateSynthetic({ products: 40, queue: 4, deferred: 2, newOffers: 0, seed: 13, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const w = { s, sheets, readBook: async () => sheets.read(), xml: s.supplierXml() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: STAMP });
  return w;
}
async function sync(w, xml, { op = true, stamp = STAMP } = {}) {
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  return syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp, config: cfg(op), now: NOW, catalog: EMPTY_CATALOG, controls: op ? OK_CC : null });
}
const rows = async (w) => readSheet((await w.sheets.read([SHEET.main]))[SHEET.main], SHEET.main).rows;
const byKey = async (w) => new Map((await rows(w)).map((r) => [mtText(r["Offer ID"]), r]));
const rowNo = (w, id) => w.sheets.book[SHEET.main].findIndex((r) => mtText(r[0]) === id) + 1;
const setState = (w, id, mutate) => { const v = w.sheets.book[SHEET.main], c = v[0].indexOf(STATE_COLUMN), r = v[rowNo(w, id) - 1]; const o = JSON.parse(r[c]); mutate(o); r[c] = JSON.stringify(o); };

test("CC4-REQ-MANUAL: ручна правка назви / опису / запитів одного товару — без прапорця глобальний ABORT, з прапорцем SYNCED і правки збережено", async () => {
  // Без прапорця — чинна прийнята поведінка (Hermes відтворив ABORTED).
  const w0 = await world();
  assert.equal((await sync(w0, w0.xml, { op: false })).state, "SYNCED");
  const id0 = mtText((await rows(w0))[3]["Offer ID"]);
  w0.sheets.humanSet(SHEET.main, rowNo(w0, id0), "Назва UA", "Назва власника");
  assert.equal((await sync(w0, w0.xml, { op: false })).state, "ABORTED");
  // З прапорцем: міграція станів, потім ручні правки — не зупинка.
  const w = await world();
  const r1 = await sync(w, w.xml);
  assert.equal(r1.state, "SYNCED", JSON.stringify(r1).slice(0, 400));
  assert.ok(r1.ownerPriority.migratedRows >= 40);
  const id = mtText((await rows(w))[3]["Offer ID"]);
  for (const [col, v] of [["Назва UA", "Назва власника"], ["Опис UA", "<p>Опис власника</p>"], ["Запити UA", "ключ власника"]]) w.sheets.humanSet(SHEET.main, rowNo(w, id), col, v);
  const r2 = await sync(w, w.xml);
  assert.equal(r2.state, "SYNCED", JSON.stringify(r2).slice(0, 600));
  const row = (await byKey(w)).get(id);
  assert.equal(mtText(row["Назва UA"]), "Назва власника");
  assert.equal(mtText(row["Опис UA"]), "<p>Опис власника</p>");
  assert.equal(mtText(row["Запити UA"]), "ключ власника");
  assert.equal(readState(row[STATE_COLUMN]).f["Назва UA"].s, SRC.CUSTOM);
});

test("Кастомне поле: постачальник змінив сиру назву → «було → стало» в аркуші попереджень, наша назва лишається; повтор — без дублів", async () => {
  const w = await world();
  await sync(w, w.xml);
  const t = (await rows(w))[5], id = mtText(t["Offer ID"]), sid = mtText(t["ID постачальника"]), ours = mtText(t["Назва UA"]);
  const xml2 = perturb.tag(w.xml, sid, "name_ua", "Нова назва постачальника");
  const r = await sync(w, xml2);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 600));
  const row = (await byKey(w)).get(id);
  assert.equal(mtText(row["Назва UA"]), ours, "наше значення (міграція → C) збережено");
  assert.equal(mtText(row["Назва постачальника UA"]), "Нова назва постачальника", "сире значення оновлено");
  assert.match(mtText(row["Попередження постачальника"]), /Назва UA/);
  assert.equal(r.ownerPriority.warnings, 1);
  assert.equal(r.ownerPriority.productsWithWarnings, 1);
  assert.ok(r.ownerPriority.rawFieldsChanged >= 1);
  const warn = (await w.sheets.read([WARN_SHEET]))[WARN_SHEET];
  assert.equal(warn.length, 2, "заголовок + 1 попередження");
  assert.equal(mtText(warn[1][2]), id);
  const r2 = await sync(w, xml2);
  assert.equal(r2.state, "SYNCED");
  assert.equal(r2.ownerPriority.warnings, 0, "те саме сире значення — нового попередження немає");
  assert.equal((await w.sheets.read([WARN_SHEET]))[WARN_SHEET].length, 2);
});

test("Поле постачальника (S): нова назва постачальника застосовується; інші кастомні поля того самого товару — без змін", async () => {
  const w = await world();
  await sync(w, w.xml);
  const t = (await rows(w))[7], id = mtText(t["Offer ID"]), sid = mtText(t["ID постачальника"]);
  const descBefore = mtText(t["Опис UA"]);
  setState(w, id, (o) => { o.f["Назва UA"].s = "S"; }); // власник повернув поле постачальнику (дія «Прийняти значення постачальника»)
  const r = await sync(w, perturb.tag(w.xml, sid, "name_ua", "Yato ключ розвідний"));
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 600));
  const row = (await byKey(w)).get(id);
  assert.equal(mtText(row["Назва UA"]), "Yato ключ розвідний");
  assert.equal(mtText(row["Опис UA"]), descBefore);
  assert.equal(r.ownerPriority.warnings, 0);
});

test("Дія власника «Прийняти значення постачальника» в аркуші попереджень — лише це поле стає S і отримує значення постачальника в тому самому запуску; «Стан дії» = ВИКОНАНО", async () => {
  const w = await world();
  await sync(w, w.xml);
  const t = (await rows(w))[8], id = mtText(t["Offer ID"]), sid = mtText(t["ID постачальника"]);
  const descBefore = mtText(t["Опис UA"]);
  const xml2 = perturb.tag(w.xml, sid, "name_ua", "Нова назва від постачальника");
  await sync(w, xml2); // попередження «було → стало» (назва — C після міграції)
  const warn = w.sheets.book[WARN_SHEET];
  const h = warn[0];
  warn[1][h.indexOf("Дія власника")] = "Прийняти значення постачальника";
  const r = await sync(w, xml2);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 600));
  const row = (await byKey(w)).get(id);
  assert.equal(mtText(row["Назва UA"]), "Нова назва від постачальника", "прийняте поле — від постачальника");
  assert.equal(mtText(row["Опис UA"]), descBefore, "інше поле не змінено");
  assert.equal(readState(row[STATE_COLUMN]).f["Назва UA"].s, SRC.SUPPLIER);
  assert.match(mtText(w.sheets.book[WARN_SHEET][1][h.indexOf("Стан дії")]), /^ВИКОНАНО/);
  const r2 = await sync(w, xml2);
  assert.equal(r2.state, "SYNCED");
  assert.equal(mtText((await byKey(w)).get(id)["Назва UA"]), "Нова назва від постачальника", "повтор — стабільно");
});

test("Міграція: збіг із фідом — НЕ доказ (невизначене, без перезапису); без джерела постачальника — наше; «Класифікація полів» — рішення власника", async () => {
  const w = await world(); // без прапорця синхронізації ще не було: перший запуск із прапорцем — міграція
  const all = await rows(w);
  const a = all[2], b = all[3];
  const ida = mtText(a["Offer ID"]), sida = mtText(a["ID постачальника"]), idb = mtText(b["Offer ID"]), sidb = mtText(b["ID постачальника"]);
  w.sheets.humanSet(SHEET.main, rowNo(w, ida), "Назва UA", mtText(a["Назва постачальника UA"])); // збігається з постачальником → однаково НЕВИЗНАЧЕНЕ (рішення власника 29.10)
  const xml1 = perturb.tag(w.xml, sida, "name_ua", "Перейменовано постачальником");
  const r1 = await sync(w, xml1);
  assert.equal(r1.state, "SYNCED", JSON.stringify(r1).slice(0, 600));
  assert.equal(mtText((await byKey(w)).get(ida)["Назва UA"]), mtText(a["Назва постачальника UA"]), "міграція не змінює значення");
  assert.equal(readState((await byKey(w)).get(ida)[STATE_COLUMN]).f["Назва UA"].s, SRC.CUSTOM, "збіг із фідом — не доказ: C (невизначене)");
  assert.ok(r1.ownerPriority.migrationClasses["НЕВИЗНАЧЕНЕ"] > 0 && !r1.ownerPriority.migrationClasses["ПОСТАЧАЛЬНИКА"]);
  assert.ok(r1.ownerPriority.migrationClasses["НАШЕ"] > 0, "поля без джерела постачальника (запити, виробник) — наші");
  const cls = w.sheets.book["Класифікація полів"];
  assert.ok(cls && cls.length > 1, "невизначені поля — в аркуші класифікації");
  const ncls = cls.find((r) => mtText(r[1]) === ida && mtText(r[2]) === "Назва UA");
  assert.ok(ncls, "назва, що збіглася з фідом, — теж у класифікації");
  const r2 = await sync(w, xml1);
  assert.equal(mtText((await byKey(w)).get(ida)["Назва UA"]), mtText(a["Назва постачальника UA"]), "невизначене не перезаписується й на другому запуску");
  // Рішення власника: «Постачальника» для назви товару b, «Наше» для опису товару b.
  const h = cls[0];
  const rowFor = (field) => cls.find((r) => mtText(r[h.indexOf("Offer ID")]) === idb && mtText(r[h.indexOf("Поле")]) === field);
  rowFor("Назва UA")[h.indexOf("Рішення власника")] = "Постачальника";
  rowFor("Опис UA")[h.indexOf("Рішення власника")] = "Наше";
  const descB = mtText((await byKey(w)).get(idb)["Опис UA"]);
  const r3 = await sync(w, xml1);
  assert.equal(r3.state, "SYNCED", JSON.stringify(r3).slice(0, 600));
  const rb = (await byKey(w)).get(idb), st = readState(rb[STATE_COLUMN]);
  assert.equal(mtText(rb["Назва UA"]), mtText(b["Назва постачальника UA"]), "«Постачальника» → значення постачальника");
  assert.equal(st.f["Назва UA"].s, SRC.SUPPLIER);
  assert.equal(mtText(rb["Опис UA"]), descB, "«Наше» → значення не змінено");
  assert.equal(st.f["Опис UA"].s, SRC.CUSTOM);
  assert.match(mtText(rowFor("Назва UA")[h.indexOf("Стан дії")]), /^ВИКОНАНО/);
  assert.match(mtText(rowFor("Опис UA")[h.indexOf("Стан дії")]), /^ВИКОНАНО/);
  assert.ok(sidb);
});

test("«Код товару Prom»: новий товар при затвердженні — Offer ID (код = артикулу / порожній); код власника зберігається; за артикулом не ходить", async () => {
  const { intakeAll } = await import("./helpers/intake.mjs");
  const { DECISION } = await import("../src/core/sheet-sync.mjs");
  const s = generateSynthetic({ products: 30, queue: 0, deferred: 0, newOffers: 3, seed: 29, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const w = { s, sheets, readBook: async () => sheets.read(), xml: s.supplierXml() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: STAMP });
  assert.equal((await sync(w, w.xml)).state, "SYNCED");
  await intakeAll(w, w.xml, { session: "auto", stamp: STAMP, now: NOW, config: cfg(true), catalog: EMPTY_CATALOG, controls: OK_CC });
  const q = sheets.book[SHEET.queue], qh = q[0];
  assert.ok(q.length >= 3, "новинки в черзі");
  const [a, b] = [q[1], q[2]];
  const ida = mtText(a[qh.indexOf("Offer ID")]), idb = mtText(b[qh.indexOf("Offer ID")]);
  a[qh.indexOf("Код товару Prom")] = a[qh.indexOf("Артикул постачальника")]; // системне значення = артикул
  b[qh.indexOf("Код товару Prom")] = "МІЙ-КОД-1";                            // введено власником
  // Власник підготував товари: описи, група, категорія Prom.
  const gv = sheets.book[SHEET.groups], gid = mtText(gv[1][gv[0].map(mtText).indexOf("Ідентифікатор_групи")]);
  for (const r of [a, b]) {
    r[qh.indexOf("Опис UA")] = "<p>Опис власника</p>"; r[qh.indexOf("Опис RU")] = "<p>Описание</p>";
    r[qh.indexOf("Група ID")] = gid; r[qh.indexOf("Категорія Prom ID")] = "410402";
    r[qh.indexOf("Рішення")] = DECISION.APPROVE_NOT_DUP;
  }
  const r = await sync(w, w.xml);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 500));
  const m = await byKey(w);
  assert.ok(m.has(ida) && m.has(idb), "затверджено: " + JSON.stringify(sheets.book[SHEET.queue].slice(1).map((x) => x[qh.indexOf("Перевірка")])).slice(0, 300));
  assert.equal(mtText(m.get(ida)["Код товару Prom"]), ida, "за замовчуванням — Offer ID");
  assert.equal(mtText(m.get(idb)["Код товару Prom"]), "МІЙ-КОД-1", "код власника зберігається");
  assert.equal(JSON.parse(mtText(m.get(ida)[STATE_COLUMN])).sid, mtText(m.get(ida)["ID постачальника"]), "затверджений товар — зі станом полів і ідентичністю");
});

test("Критична зміна ідентичності одного товару («ID постачальника» поза системою) — ізоляція лише його; решта синхронізується", async () => {
  const w = await world();
  await sync(w, w.xml);
  const all = await rows(w);
  const bad = mtText(all[2]["Offer ID"]), other = all[9], otherId = mtText(other["Offer ID"]);
  const badBefore = { ...(await byKey(w)).get(bad) };
  w.sheets.humanSet(SHEET.main, rowNo(w, bad), "ID постачальника", mtText(all[4]["ID постачальника"])); // ID ІНШОГО наявного товару
  const xml2 = perturb.tag(perturb.tag(w.xml, mtText(all[2]["ID постачальника"]), "price", "999"), mtText(other["ID постачальника"]), "price", "777");
  const r = await sync(w, xml2);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 600));
  assert.deepEqual(r.ownerPriority.isolated.map((x) => x.offerId), [bad]);
  const after = await byKey(w);
  for (const k of ["Ціна постачальника", "Ціна", "Наявність", "Стан синхронізації", "Оновлено", "Назва UA", "Назва постачальника UA", "Артикул постачальника"]) assert.equal(mtText(after.get(bad)[k]), mtText(badBefore[k]), "ізольований товар: " + k);
  assert.equal(mtText(after.get(otherId)["Ціна постачальника"]), "777", "інший товар оновлено");
});

test("Правка поля постачальника людиною між читанням і записом — рядок ізольовано (CONFLICT), правка збережена, запуск SYNCED", async () => {
  const w = await world();
  await sync(w, w.xml);
  const t = (await rows(w))[6], id = mtText(t["Offer ID"]), sid = mtText(t["ID постачальника"]);
  setState(w, id, (o) => { o.f["Назва UA"].s = "S"; });
  let once = true;
  w.sheets.beforeWrite = (op) => { if (op === "updateRanges" && once) { once = false; w.sheets.humanSet(SHEET.main, rowNo(w, id), "Назва UA", "Власник саме зараз"); } };
  const r = await sync(w, perturb.tag(w.xml, sid, "name_ua", "Нова від постачальника"));
  w.sheets.beforeWrite = null;
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 600));
  assert.equal(mtText((await byKey(w)).get(id)["Назва UA"]), "Власник саме зараз");
  assert.ok(r.ownerPriority.isolated.some((x) => x.offerId === id && /CONFLICT/.test(x.reason)));
});
