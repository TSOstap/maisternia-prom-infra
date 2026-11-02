/** Catalog Controls — тимчасове зняття з продажу (редакція після BLOCK Hermes): команди з кодами, жодного запису в картку,
 *  стара команда не спрацьовує повторно, захист від копіювання команди, ліміти й перевірка конфігурації, YML «немає в наявності»,
 *  сумісність зі syncSheet. */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { planRows } from "../src/core/sync-plan.mjs";
import { GROUP_HEADERS, approvalManifest } from "../src/core/seal.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { buildYml, memorySink, objectsFromValues, STATUS_OWN_STOCK } from "../src/core/yml.mjs";
import { ACTION, SALE_DECISION } from "../src/core/controls-common.mjs";
import { holdPlan, holdRowsForYml, parseSaleCommand } from "../src/core/controls-sale.mjs";
import { syncAndIntake } from "./helpers/intake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };
import { STAMP, NOW, ccControls, prepared, run, parse, confirm, codeOf, viewOf, rowOf, mainRows, eventsOf, evField, setCells, touchedMain, later } from "./helpers/controls.mjs";

const config = structuredClone(baseConfig);
const ID = "1500000007";
const HOLD = "ЗНЯТИ З ПРОДАЖУ", RELEASE = "ПОВЕРНУТИ В ПРОДАЖ";
async function availableId(w) {
  const offers = (await parse(w.xml)).offers;
  return mainRows(w).map((r) => mtText(r["Offer ID"])).find((id) => offers.get(id)?.available === true);
}

test("parseSaleCommand: коди, причина в написанні власника, Offer ID для постійних команд", () => {
  assert.deepEqual(parseSaleCommand("  зняти з продажу  a1b2c3: брак упаковки "), { kind: "HOLD", code: "A1B2C3", reason: "брак упаковки" });
  assert.deepEqual(parseSaleCommand("ЗНЯТИ З ПРОДАЖУ: брак"), { kind: "HOLD", code: "", reason: "брак" });
  assert.deepEqual(parseSaleCommand("Повернути в продаж 0F0F0F"), { kind: "RELEASE", code: "0F0F0F", reason: "" });
  assert.deepEqual(parseSaleCommand("ВИДАЛИТИ ТОВАР 1500000007 ABCDEF"), { kind: "TOMBSTONE", id: "1500000007", code: "ABCDEF", reason: "" });
  assert.deepEqual(parseSaleCommand("повернути в каталог 1500000007"), { kind: "UNTOMBSTONE", id: "1500000007", code: "", reason: "" });
  assert.equal(parseSaleCommand("ВИДАЛИТИ ТОВАР").needsId, true);
  assert.equal(parseSaleCommand("ЗНЯТИ З ПРОДАЖУ ZZZ").kind, "UNKNOWN", "не код");
  assert.equal(parseSaleCommand("ЗВІЛЬНИТИ ID 1500000007").kind, "UNKNOWN", "звільнення ID прибрано");
  assert.equal(parseSaleCommand(""), null);
});

test("Зняти з продажу: запит → код → підтвердження; подія з поколінням; «Основний каталог», паспорт, SEO, характеристики — без системних записів; held у стані", async () => {
  const w = await prepared();
  const passport = structuredClone(w.book[SHEET.passport]);
  const { r1, r2, code } = await confirm(w, ID, SALE_DECISION, HOLD, { reason: "перевірка якості" });
  assert.equal(r1.stats.awaitingCode, 1);
  // R7 (F2): код видається лише на запит власника і зберігається в контрольній точці — проактивних кодів немає.
  assert.doesNotMatch(viewOf(w, ID)["Коди підтвердження"], new RegExp(`${RELEASE} [0-9A-F]{6}`), "без запиту — коду повернення немає");
  assert.equal(r2.state, "COMMITTED");
  const ev = eventsOf(w, ID, ACTION.HOLD);
  assert.equal(ev.length, 1);
  assert.equal(evField(ev[0], "Підстава"), "перевірка якості");
  assert.equal(evField(ev[0], "Покоління"), "sale:1");
  assert.ok(r2.held.has(ID));
  assert.equal(viewOf(w, ID)["Продаж"], "ЗНЯТО З ПРОДАЖУ з 2026-10-29: перевірка якості");
  assert.equal(rowOf(w, ID)[SALE_DECISION], `${HOLD} ${code}: перевірка якості`, "команду не очищено");
  assert.equal(touchedMain(w.sheets.calls).length, 0);
  assert.deepEqual(w.book[SHEET.passport], passport);
  setCells(w, ID, { [SALE_DECISION]: RELEASE });
  await run(w, { stamp: later(1) });
  assert.match(viewOf(w, ID)["Коди підтвердження"], new RegExp(`${RELEASE} [0-9A-F]{6}`), "на запит — код повернення");
});

test("XML-синхронізація не повертає в продаж: holdPlan — «-», ціни з XML; YML — available=false, price=Base, без oldprice / кількості; паспорт набору той самий", async () => {
  const w = await prepared();
  const id = await availableId(w);
  await confirm(w, id, SALE_DECISION, HOLD);
  const offers = (await parse(w.xml)).offers;
  const held = (await run(w, { stamp: later(1) })).held;
  const plan = planRows(mainRows(w), offers, later(1), config.pricing);
  const p = plan.find((x) => x.id === id);
  assert.equal(p.next[4], "+");
  const h = holdPlan(plan, held).find((x) => x.id === id);
  assert.deepEqual([h.next[3], h.next[4], h.next[5]], ["", "-", ""]);
  assert.deepEqual([h.next[0], h.next[1], h.next[2], h.next[6]], [p.next[0], p.next[1], p.next[2], p.next[6]]);
  assert.equal((await syncAndIntake({ ...w, sheets: w.mem }, w.xml, { stamp: STAMP, now: NOW, config, controls: await ccControls(w) })).state, "SYNCED");
  const rows = mainRows(w), groups = objectsFromValues(w.book[SHEET.groups], GROUP_HEADERS), manifest = approvalManifest(rows, groups);
  const { rows: ymlRows, problems } = holdRowsForYml(rows, held);
  assert.deepEqual(problems, []);
  const sink = memorySink();
  const built = await buildYml({ rows: ymlRows, groups, manifest, meta: { syncState: "OK", lastSuccess: STAMP, now: NOW + 60000 }, config: config.yml, maximumBytes: 50_000_000, sink, missingPolicy: "unavailable", conflictPolicy: "isolate" });
  const offer = new RegExp(`<offer id="${id}"[^>]*>[\\s\\S]*?</offer>`).exec(sink.text())[0];
  assert.match(offer, /available="false"/);
  assert.ok(offer.includes(`<price>${Number(rowOf(w, id)["Ціна"]).toFixed(2)}</price>`));
  assert.doesNotMatch(offer, /<oldprice>|<quantity_in_stock>/);
  assert.equal(built.contentSha, manifest.contentSha);
});

test("Повернути в продаж — лише кодом; стара команда в клітинці після зміни стану не спрацьовує повторно; очищена клітинка нічого не змінює", async () => {
  const w = await prepared();
  const { code: oldCode } = await confirm(w, ID, SALE_DECISION, HOLD);
  const { r2 } = await confirm(w, ID, SALE_DECISION, RELEASE, { stamp: later(1) });
  assert.ok(!r2.held.has(ID));
  // Власник повертає в клітинку стару команду зняття з тим самим кодом — вона вже виконана: нового зняття немає.
  const oldHold = eventsOf(w, ID, ACTION.HOLD)[0];
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${oldCode}` });
  const r3 = await run(w, { stamp: later(2) });
  assert.ok(!r3.held.has(ID), "стара команда не спрацьовує повторно");
  setCells(w, ID, { [SALE_DECISION]: HOLD }); // R7: новий код — на запит
  await run(w, { stamp: later(2) });
  assert.notEqual(codeOf(w, ID, HOLD), oldCode, "новий стан — новий код");
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} 000000` });
  assert.ok(!(await run(w, { stamp: later(2) })).held.has(ID), "чужий код не знімає з продажу");
  assert.match(viewOf(w, ID)["Попередження"], /код недійсний або застарів/);
  setCells(w, ID, { [SALE_DECISION]: "" });
  const r4 = await run(w, { stamp: later(3) });
  assert.ok(!r4.held.has(ID));
  assert.equal(eventsOf(w, ID, ACTION.HOLD).length, 1);
  assert.equal(evField(oldHold, "Покоління"), "sale:1");
  assert.equal(evField(eventsOf(w, ID, ACTION.RELEASE)[0], "Покоління"), "sale:2");
});

test("Команду з кодом скопійовано на інші рядки — для них код недійсний, нічого не виконано", async () => {
  const w = await prepared();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  await run(w);
  const cmd = `${HOLD} ${codeOf(w, ID, HOLD)}`;
  for (const id of [ID, "1500000014", "1500000021"]) setCells(w, id, { [SALE_DECISION]: cmd });
  const r = await run(w, { stamp: later(1) });
  assert.deepEqual([...r.held], [ID]);
  // R7: для інших товарів код не видано — відмова (раніше: «код недійсний»; гарантія та сама — нічого не виконано).
  for (const id of ["1500000014", "1500000021"]) assert.match(viewOf(w, id)["Попередження"], /код не видано|код недійсний або застарів/);
});

test("Ліміт 50 змін продажу (60 підтверджених кодами) — жодну не виконано; у межах ліміту — виконано; некоректна конфігурація лімітів — ABORTED", async () => {
  const w = await prepared({ products: 70 });
  const ids = mainRows(w).slice(0, 60).map((r) => r["Offer ID"]);
  for (const id of ids) setCells(w, id, { [SALE_DECISION]: HOLD });
  await run(w);
  for (const id of ids) setCells(w, id, { [SALE_DECISION]: `${HOLD} ${codeOf(w, id, HOLD)}` });
  const r = await run(w, { stamp: later(1) });
  assert.equal(r.held.size, 0);
  assert.ok(r.warnings.some((x) => /60 > ліміт 50/.test(x)));
  for (const id of ids.slice(50)) setCells(w, id, { [SALE_DECISION]: "" });
  const r2 = await run(w, { stamp: later(2) });
  assert.equal(r2.held.size, 50);
  for (const bad of [{ maxSaleChangesPerRun: 500 }, { maxSaleChangesPerRun: "50" }, { maxPermanentPerRun: 0 }, { unknownLimit: 1 }]) {
    const x = await run(w, { stamp: later(3), config: { controls: bad } });
    assert.equal(x.state, "ABORTED", JSON.stringify(bad));
    assert.match(x.reason, /некоректна конфігурація лімітів/);
  }
  assert.equal((await run(w, { stamp: later(3), config: { controls: { maxSaleChangesPerRun: 5 } } })).state, "COMMITTED", "зменшити — можна");
});

test("Сумісність зі syncSheet: Catalog Controls не пише в каталог — sync SYNCED, стан керування незмінний; колонки власника sync зберігає лише без конкурентної правки (вимога S1)", async () => {
  const w = await prepared();
  await confirm(w, ID, SALE_DECISION, HOLD);
  const cell = rowOf(w, ID)[SALE_DECISION];
  const photo = JSON.parse(rowOf(w, ID)["Фото JSON"])[0];
  const xml = w.xml.replace(`<picture>${photo}</picture>`, `<picture>${photo.replace(".jpg", "-v2.jpg")}</picture>`);
  const sync = await syncAndIntake({ ...w, sheets: w.mem }, xml, { stamp: later(1), now: NOW + 3600000, config, controls: await ccControls(w) });
  assert.equal(sync.state, "SYNCED", JSON.stringify(sync));
  assert.equal(rowOf(w, ID)[SALE_DECISION], cell, "без конкурентної правки повний рядок sync записав те саме");
  const r = await run(w, { stamp: later(2) });
  assert.ok(r.held.has(ID), "стан — у службових аркушах, sync його не торкається");
  assert.equal(eventsOf(w, ID).length, 1);
});

test("holdRowsForYml (R5-A): ВЛАСНИЙ_ЗАЛИШОК + зняття — зняття має найвищий пріоритет: рядок знято, фід НЕ зупиняється (problems порожні), товар позначено ownStockHeld", () => {
  const rows = [{ "Offer ID": "1", "Стан синхронізації": STATUS_OWN_STOCK, "Наявність": "+" }, { "Offer ID": "2", "Стан синхронізації": "ЗІСТАВЛЕНО", "Наявність": "+", "Знижка": "20%", "Кількість постачальника": 3 }];
  const r = holdRowsForYml(rows, new Set(["1", "2"]));
  assert.deepEqual(r.problems, [], "R4 → R5 (рішення A): власний залишок не блокує фід");
  assert.deepEqual(r.ownStockHeld, ["1"]);
  assert.equal(r.rows[0], rows[0], "рядок власного залишку не змінюється (offerXml вимагає «+»); зняття в YML — publisher за held (ENG-10 §1.2)");
  assert.deepEqual([r.rows[1]["Наявність"], r.rows[1]["Знижка"], r.rows[1]["Кількість постачальника"]], ["-", "", ""]);
});
