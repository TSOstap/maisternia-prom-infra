/** Catalog Controls R5 / R6 — «Видалити товар» з аркушем «Видалені товари» (рішення власника 29.10.2026): реєстр видалень у
 *  довіреній контрольній точці; R6: «Видалити товар» — одна дія, у новий YML товар не передається (жодного <offer>) на будь-якій
 *  стадії; REGISTERED → (Engineering переносить одразу після підтвердженого рішення) ARCHIVED → DONE (активний опублікований YML
 *  без цього Offer ID; підтвердження Prom не потрібне); MOVING — перенесення перервано після копії; ANOMALY — ізоляція товару без
 *  зупинки каталогу; повторне додавання заборонене (gate); повернення з архіву — окремою командою з кодом і перевірками лише цієї
 *  картки (B, N3); вердикт M3 (C); захист FZ / перелік / OV; ліміти; свідки й регрес точки. Перенесення — двійник Engineering. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mtText } from "../src/core/text.mjs";
import { GROUP_HEADERS, SEAL_COLUMN, approvalManifest, rowSeal } from "../src/core/seal.mjs";
import { SHEET, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { buildYml, memorySink, objectsFromValues } from "../src/core/yml.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { ACTION, ARCHIVE_SHEET, CC_SHEET, SALE_DECISION } from "../src/core/controls-common.mjs";
import { controlsRowsForYml } from "../src/core/controls-sale.mjs";
import { controlsState } from "../src/core/controls-plan.mjs";
import { syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { CHECKPOINT_KEY, loadProtection } from "../src/pipeline/controls-run.mjs";
import { loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import { STATE_A } from "./helpers/state-a.mjs";
import baseConfig from "../config/default.json" with { type: "json" };
import { ACTIVE_CONTRACT, NOW, PROTECTION_OK, ccControls, prepared, run, parse, confirm, codeOf, viewOf, rowOf, mainRows, eventsOf, evField, setCells, touchedMain, later } from "./helpers/controls.mjs";

const config = structuredClone(baseConfig);
const ID = "1500000007", ID2 = "1500000014";
const HOLD = "ЗНЯТИ З ПРОДАЖУ", DEL = `ВИДАЛИТИ ТОВАР ${ID}`, BACK = `ПОВЕРНУТИ З АРХІВУ ${ID}`;
const ctxOf = (w, extra = {}) => ({ contract: ACTIVE_CONTRACT, checkpoint: w.store.data.get(CHECKPOINT_KEY) ?? null, integrity: w.integrity ?? null, publication: w.publication ?? null, ...extra });
const stateOf = (w, extra = {}) => controlsState(structuredClone(w.book), ctxOf(w, extra));
const groupsOf = (w) => objectsFromValues(w.book[SHEET.groups], GROUP_HEADERS);
const archiveRow = (w, id) => readSheet(w.book[ARCHIVE_SHEET], ARCHIVE_SHEET).rows.find((r) => mtText(r["Offer ID"]) === id);
/** R6: стан АКТИВНОЇ опублікованої версії YML від Engineering: Map(Offer ID → { feed: "absent" | "present" | "unknown" }). */
const published = (feed, ids = [ID]) => new Map(ids.map((id) => [id, { feed }]));
/** YML за еталонною проєкцією CC (двійник publisher S6 / R6) з рядків «Основного каталогу». */
async function ymlOf(w, st) {
  const rows = controlsRowsForYml(mainRows(w), st).rows, groups = groupsOf(w), sink = memorySink();
  const success = mtText(mainRows(w)[0]["Оновлено"]);
  await buildYml({ rows, groups, manifest: approvalManifest(rows, groups), meta: { syncState: "OK", lastSuccess: success, now: Date.parse(success) + 60000 }, config: config.yml, maximumBytes: 50_000_000, sink, missingPolicy: "unavailable", conflictPolicy: "isolate" });
  return sink.text();
}

/** Двійник перенесення Engineering (ідемпотентне «копія → перевірка → прибрати джерело»); stop: "afterCopy" — збій після копії. */
function engineeringMove(book, id, from, to, { stop = "" } = {}) {
  const src = book[from];
  if (!book[to]?.length) book[to] = [src[0].slice()];
  const i = src.findIndex((r, k) => k > 0 && mtText(r[0]) === id);
  assert.ok(i > 0, `немає ${id} у «${from}»`);
  if (!book[to].some((r, k) => k > 0 && mtText(r[0]) === id)) book[to].push(src[i].slice());
  if (stop === "afterCopy") return;
  src.splice(i, 1);
}
/** Перерахувати печатку рядка (власник / Engineering затвердили картку). */
function reseal(w, sheet, id) {
  const v = w.book[sheet], h = v[0].map(mtText);
  const i = v.findIndex((r, k) => k > 0 && mtText(r[0]) === id);
  v[i][h.indexOf(SEAL_COLUMN)] = rowSeal(Object.fromEntries(h.map((k, j) => [k, v[i][j] ?? ""])));
}
/** Команда з кодом у заданому аркуші (потік власника: без коду → код зі «Стану керування» → з кодом). */
async function confirmIn(w, sheet, id, words, hours, opts = {}) {
  setCells(w, id, { [SALE_DECISION]: words }, sheet);
  await run(w, { stamp: later(hours), ...opts });
  setCells(w, id, { [SALE_DECISION]: `${words} ${codeOf(w, id, words)}` }, sheet);
  return run(w, { stamp: later(hours + 0.5), ...opts });
}

/** Знято з продажу → «Видалити товар» (обидва кроки з кодами). cpBefore — контрольна точка до видалення (для регресу). */
async function tombstoned(opts) {
  const w = await prepared(opts);
  await confirm(w, ID, SALE_DECISION, HOLD);
  const cpBefore = structuredClone(w.store.data.get(CHECKPOINT_KEY));
  const before = { row: structuredClone(w.book[SHEET.main].find((r) => r[0] === ID)), header: w.book[SHEET.main][0].slice() };
  const { r2 } = await confirm(w, ID, SALE_DECISION, DEL, { stamp: later(1) });
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2));
  return { w, r: r2, before, cpBefore };
}
/** Видалено й перенесено в «Видалені товари» (R6: доручення — одразу після підтвердженого рішення). */
async function archived() {
  const t = await tombstoned();
  assert.deepEqual(stateOf(t.w).moves.toArchive, [ID], "передумова: доручення перенесення");
  engineeringMove(t.w.book, ID, SHEET.main, ARCHIVE_SHEET);
  return t;
}

test("R6 — «Видалити товар» одна дія: товар у продажу видаляється однією командою з кодом (внутрішнє зняття записує система, ті самі наміри); код недійсний / чужий Offer ID — відмова; «ЗВІЛЬНИТИ ID» — невідома команда", async () => {
  const w = await prepared();
  setCells(w, ID, { [SALE_DECISION]: DEL });
  await run(w);
  // R7 (F2): код — лише на запит (тут — запит видалення); товар у продажу отримує його без попереднього зняття.
  assert.match(viewOf(w, ID)["Коди підтвердження"], new RegExp(`^${DEL} [0-9A-F]{6}$`), "товар у продажу: код видалення видається без попереднього зняття");
  const code = codeOf(w, ID, DEL);
  setCells(w, ID, { [SALE_DECISION]: `${DEL} ABCDEF` });
  await run(w, { stamp: later(1) });
  assert.match(viewOf(w, ID)["Попередження"], /код недійсний або застарів/);
  setCells(w, ID, { [SALE_DECISION]: `ВИДАЛИТИ ТОВАР ${ID2} ABCDEF` });
  await run(w, { stamp: later(2) });
  assert.match(viewOf(w, ID)["Попередження"], new RegExp(`Offer ID у команді \\(${ID2}\\) — не цього товару`));
  setCells(w, ID, { [SALE_DECISION]: `ЗВІЛЬНИТИ ID ${ID}` });
  await run(w, { stamp: later(3) });
  assert.match(viewOf(w, ID)["Попередження"], /невідома команда/);
  assert.equal(eventsOf(w, ID).length, 0, "відмови нічого не записують");
  // одна дія власника
  setCells(w, ID, { [SALE_DECISION]: `${DEL} ${code}` });
  const r = await run(w, { stamp: later(4) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  const ev = eventsOf(w, ID).sort((a, b) => evField(a, "Покоління").localeCompare(evField(b, "Покоління")));
  assert.deepEqual(ev.map((e) => [evField(e, "Дія"), evField(e, "Покоління")]), [[ACTION.HOLD, "sale:1"], [ACTION.TOMBSTONE, "sale:2"]]);
  assert.match(evField(ev[0], "Підстава"), /внутрішній захисний перехід перед видаленням/);
  assert.notEqual(evField(ev[0], "Operation ID"), evField(ev[1], "Operation ID"));
  assert.ok(r.held.has(ID) && r.tombstoned.get(ID)?.confirmed && r.gate.knownIds.has(ID));
  assert.equal(r.stats.tombstoned, 1);
  // повтор із тією самою командою — нічого нового
  await run(w, { stamp: later(5) });
  assert.equal(eventsOf(w, ID).length, 2, "без дублів");
});

test("REGISTERED (R6): рядок лишається в «Основному каталозі» до перенесення, але в новий YML уже не передається; доручення перенесення — одразу після підтвердженого рішення, незалежно від стану фіду; подія з мінімальною ідентичністю; held + фільтр; жодного запису в каталог і жодного deleteRows", async () => {
  const { w, r, before } = await tombstoned();
  const dec = before.header.indexOf(SALE_DECISION);
  const now = w.book[SHEET.main].find((x) => x[0] === ID);
  const but = (row) => before.header.map((_, j) => (j === dec ? "" : mtText(row[j])));
  assert.deepEqual(but(now), but(before.row), "рядок картки той самий (змінилась лише команда власника)");
  const ev = eventsOf(w, ID, ACTION.TOMBSTONE);
  assert.equal(ev.length, 1);
  const idn = JSON.parse(evField(ev[0], "Стало"));
  assert.equal(idn.supplierId, mtText(rowOf(w, ID)["ID постачальника"]));
  assert.equal(idn.sku, mtText(rowOf(w, ID)["Артикул постачальника"]));
  assert.deepEqual(r.tombstoned.get(ID), { stage: "REGISTERED", opId: evField(ev[0], "Operation ID"), at: later(1), confirmed: true });
  assert.ok(r.held.has(ID) && r.gate.knownIds.has(ID));
  assert.deepEqual(r.moves, { toArchive: [ID], toCatalog: [] }, "R6: переносити одразу");
  for (const feed of ["present", "unknown", "absent"]) assert.deepEqual(stateOf(w, { publication: published(feed) }).moves.toArchive, [ID], feed);
  const xml = await ymlOf(w, stateOf(w));
  assert.ok(!new RegExp(`<offer id="${ID}"[\\s>]`).test(xml), "жодного <offer> для видаленого — уже до перенесення");
  assert.ok(new RegExp(`<offer id="${ID2}"[\\s>]`).test(xml), "інші товари публікуються");
  assert.match(viewOf(w, ID)["Виключення"], /ВИДАЛЕННЯ ЗАРЕЄСТРОВАНО — у новий YML товар не передається; очікує перенесення в «Видалені товари» \(не завершено\)/);
  assert.match(viewOf(w, ID)["Продаж"], /^ПОЗА ПРОДАЖЕМ: товар видалено — у новий YML не передається/);
  assert.equal(touchedMain(w.sheets.calls).length, 0);
  assert.equal(w.sheets.calls.filter((c) => c.op === "deleteRows").length, 0);
  assert.ok(mainRows(w).every((x) => rowSeal(x) === mtText(x[SEAL_COLUMN])));
});

test("Перенесення і завершення (R6): збій після копії — MOVING і те саме доручення; ARCHIVED — доки активний опублікований YML не підтверджено без товару (внутрішній стан, без дій власника); DONE — рішення + архів + YML без Offer ID; підтвердження Prom не потрібне й не враховується; повтор — без нових подій; різні копії — ANOMALY без доручень і без зупинки каталогу", async () => {
  const { w } = await tombstoned();
  // (а) збій Engineering після копії — ідемпотентне завершення тим самим дорученням
  engineeringMove(w.book, ID, SHEET.main, ARCHIVE_SHEET, { stop: "afterCopy" });
  let s = stateOf(w);
  assert.deepEqual([s.tombstoned.get(ID).stage, s.moves.toArchive, s.blocked], ["MOVING", [ID], false]);
  assert.ok(s.held.has(ID) && !s.damaged.has(ID));
  engineeringMove(w.book, ID, SHEET.main, ARCHIVE_SHEET);
  assert.equal(w.book[ARCHIVE_SHEET].filter((x) => x[0] === ID).length, 1, "без дубля в архіві");
  // (б) ARCHIVED: стан опублікованого YML невідомий / ще містить товар
  s = stateOf(w);
  assert.deepEqual([s.tombstoned.get(ID).stage, s.moves.toArchive], ["ARCHIVED", []]);
  const n = eventsOf(w).length;
  const r = await run(w, { stamp: later(2) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.equal(eventsOf(w).length, n, "перенесення не створює подій; повтор — нічого");
  assert.match(viewOf(w, ID)["Виключення"], /В АРХІВІ «Видалені товари» — очікує підтвердження, що опублікований YML уже не містить цього товару \(не завершено\)/);
  assert.doesNotMatch(viewOf(w, ID)["Виключення"] + viewOf(w, ID)["Попередження"], /Prom/, "жодної вимоги підтвердження Prom");
  w.publication = published("present");
  await run(w, { stamp: later(3) });
  assert.equal(stateOf(w).tombstoned.get(ID).stage, "ARCHIVED");
  assert.match(viewOf(w, ID)["Попередження"], /опублікований YML ще містить цей Offer ID — очікує публікації нової версії без нього \(внутрішній стан; дій власника не потрібно\)/);
  w.publication = new Map([[ID, { feed: "unknown", promConfirmed: true }]]);
  assert.equal(stateOf(w).tombstoned.get(ID).stage, "ARCHIVED", "підтвердження Prom не враховується");
  // (в) DONE — за активним опублікованим YML без цього Offer ID
  w.publication = published("absent");
  await run(w, { stamp: later(4) });
  assert.match(viewOf(w, ID)["Виключення"], /ВИДАЛЕНО — рішення зафіксовано, товар в архіві, опублікований YML його не містить/);
  assert.equal(stateOf(w).tombstoned.get(ID).stage, "DONE");
  assert.ok(stateOf(w).held.has(ID) && stateOf(w).gate.knownIds.has(ID), "завершене видалення лишається в реєстрі");
  const xml = await ymlOf(w, stateOf(w));
  assert.ok(!xml.includes(`<offer id="${ID}"`), "видалений товар не потрапляє в новий YML");
  // (г) різні копії в обох аркушах — ANOMALY: товар ізольовано, доручень немає, решта каталогу працює
  const copy = w.book[ARCHIVE_SHEET].find((x) => x[0] === ID).slice();
  copy[w.book[SHEET.main][0].indexOf("Назва UA")] = "інша копія";
  w.book[SHEET.main].push(copy);
  s = stateOf(w);
  assert.deepEqual([s.tombstoned.get(ID).stage, s.moves.toArchive, s.moves.toCatalog, s.blocked], ["ANOMALY", [], [], false]);
  assert.ok(s.held.has(ID) && s.damaged.has(ID) && !s.held.has(ID2));
  assert.ok(s.tombstoned.has(ID), "ANOMALY — теж поза YML");
});

test("Видалений товар у фіді: навіть якщо чинна синхронізація (без контракту R6 Engineering) оновила сирі дані рядка до перенесення — рішення не змінюється, у новому YML offer'а немає; фільтр повторного створення: той самий ID — EXCLUDED, повторне використання ID — ID_REUSE_CONFLICT, сильний збіг під новим ID — EXCLUDED_NEW_ID, схожий — лише позначка; «Код товару Prom» не є ідентичністю", async () => {
  const { w } = await tombstoned();
  const offers = (await parse(w.xml)).offers;
  const old = offers.get(ID);
  const xml = w.xml.replace(`<name_ua>${old.nameUa}</name_ua>`, `<name_ua>${old.nameUa} (оновлено)</name_ua>`);
  const parsed = await parse(xml);
  const t = NOW + 2 * 3600000;
  const sync = await syncSheet({ sheets: w.mem, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: later(2), config, now: t, catalog: EMPTY_CATALOG, controls: await ccControls(w) });
  assert.equal(sync.state, "SYNCED", JSON.stringify(sync));
  const st = stateOf(w);
  assert.equal(st.tombstoned.get(ID).confirmed, true, "перейменування з артикулом — той самий фізичний товар; рішення чинне");
  const yml = await ymlOf(w, st);
  assert.ok(!new RegExp(`<offer id="${ID}"[\\s>]`).test(yml), "у новому YML offer'а немає");
  const gate = st.gate;
  assert.equal(gate.check(parsed.offers.get(ID)).kind, "EXCLUDED");
  assert.equal(gate.check({ ...old, sku: "OTHER-777", nameUa: "Інше", nameRu: "Другое" }).kind, "ID_REUSE_CONFLICT");
  const strong = { id: "2999999991", sku: old.sku, nameUa: old.nameUa, nameRu: old.nameRu, url: "https://market-tools.com.ua/p2999999991-x.html" };
  assert.equal(gate.check(strong).kind, "EXCLUDED_NEW_ID");
  assert.ok(gate.check(strong).blocked);
  assert.equal(gate.check({ ...strong, nameUa: "інша", nameRu: "другая" }).kind, "SIMILAR_TO_EXCLUDED");
  setCells(w, ID, { "Код товару Prom": "MANUAL-777" });
  assert.equal(stateOf(w).tombstoned.get(ID).confirmed, true, "ручна правка «Коду товару Prom» не змінює ідентичність і не блокує");
  assert.equal(stateOf(w).blocked, false);
});

// R7.4.2: каталог 100 рядків — одне зникнення нижче порогу за будь-якого чинного правила (ENG-28b: менший із 50 і ⌈2 % × 100⌉ = 2,
// при досягненні; раніше: більший і «>»). Межі порогу — окремі тести нижче (зокрема: 44 рядки — те саме зникнення вже HOLD).
test("Умова 8: видалений товар зник із фіду — sync рахує його у зниклих (поріг «МАСОВЕ ЗНИКНЕННЯ» без маскування); журнал Catalog Controls синхронізація не змінює; видалення чинне", async () => {
  const { w } = await tombstoned({ products: 96 });
  assert.equal(mainRows(w).length, 100, "передумова: 100 рядків «Основного каталогу»");
  const cc = structuredClone(w.book[CC_SHEET.history]);
  const xml = perturb.drop(w.xml, [mtText(rowOf(w, ID)["ID постачальника"])]);
  const parsed = await parse(xml);
  const sync = await syncSheet({ sheets: w.mem, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: later(2), config, now: NOW + 2 * 3600000, catalog: EMPTY_CATALOG, controls: await ccControls(w) });
  assert.equal(sync.state, "SYNCED", JSON.stringify(sync));
  assert.equal(sync.stats.main.missingInFeed, 1, "видалений товар рахується серед зниклих — Catalog Controls його не приховує");
  assert.deepEqual(w.book[CC_SHEET.history], cc);
  assert.equal(stateOf(w).tombstoned.get(ID)?.confirmed, true);
});

// ---------------------------------------------------------------- Умова 8 × поріг HOLD (рішення власника 01.11; ENG-28b)
// Погоджено: «МАСОВЕ ЗНИКНЕННЯ» — коли кількість зниклих k ДОСЯГАЄ меншого з 50 і 2 % попереднього підтвердженого каталогу (N рядків
// «Основного каталогу»). Для цілого k: k ≥ 0,02·N ⇔ k ≥ ⌈2N / 100⌉ — округлення вгору точне (не послаблення й не посилення).
// k = 0 — ніколи. Рахуються лише товари в доведено порівнюваному охопленні. Видалений власником товар (CC) рахується як усі інші.
// Лише в дереві з правилом Engineering ENG-28b (src/core/supplier-presence.mjs); у дереві CC (main) чинне попереднє правило.
const RULE_0111 = fs.existsSync(new URL("../src/core/supplier-presence.mjs", import.meta.url));
const skip0111 = RULE_0111 ? false : "поріг HOLD 01.11 (ENG-28b, src/core/supplier-presence.mjs) відсутній у дереві — лише в композиції з Engineering";
/** Очікуваний поріг за погодженим правилом — цілочисельно, незалежно від реалізації Engineering. */
const ownerLimit = (n) => Math.min(50, Math.floor((2 * n + 99) / 100));
/** Фікстура: наявність у фіді = наявність у картці. Синтетика навмисно перевертає її в ~10 % товарів — на великих каталогах це
 *  спрацьовує окремий захист «МАСОВА ЗМІНА НАЯВНОСТІ», що не є предметом цих тестів. Пороги не змінюються. */
function steadyXml(w) {
  const avail = new Map(mainRows(w).map((r) => [mtText(r["ID постачальника"]), mtText(r["Наявність"]) === "+"]));
  return w.xml.replace(/<offer id="(\d+)" available="(?:true|false)"/g, (m, id) => (avail.has(id) ? `<offer id="${id}" available="${avail.get(id)}"` : m));
}
/** Світ із видаленим (CC) товаром ID і каталогом заданого розміру. */
async function sized(products) {
  const t = await tombstoned({ products });
  const sid = (r) => mtText(r["ID постачальника"]);
  return { ...t, xml: steadyXml(t.w), idSid: sid(rowOf(t.w, ID)), others: mainRows(t.w).filter((r) => mtText(r["Offer ID"]) !== ID).map(sid) };
}
/** Синхронізація на НЕЗАЛЕЖНІЙ копії книги; зникає k товарів «Основного каталогу», першим — видалений власником ID. */
async function syncWithout(t, k) {
  const book = structuredClone(t.w.book), mem = new MemorySheets(book);
  const w = { ...t.w, book, mem, readBook: async () => structuredClone(book) };
  const xml = perturb.drop(t.xml, k ? [t.idSid, ...t.others.slice(0, k - 1)] : []);
  const parsed = await parse(xml);
  const main0 = structuredClone(book[SHEET.main]), cc0 = structuredClone(book[CC_SHEET.history]);
  const sync = await syncSheet({ sheets: mem, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: later(2), config, now: NOW + 2 * 3600000, catalog: EMPTY_CATALOG, controls: await ccControls(w) });
  return { sync, w, main0, cc0 };
}
for (const c of [
  { products: 40, n: 44, limit: 1, ks: [0, 1, 2], why: "малий: 2 % = 0,88 → 1 — одне зникнення (сам видалений товар) уже HOLD" },
  { products: 97, n: 101, limit: 3, ks: [2, 3], why: "2 % = 2,02 → 3: округлення вгору, не вниз" },
  { products: 146, n: 150, limit: 3, ks: [2, 3, 4], why: "2 % = 3 рівно: рівність порогу — HOLD" },
  { products: 1996, n: 2000, limit: 40, ks: [39, 40, 41], why: "великий: 2 % = 40 < 50 — діє частка" },
  { products: 2996, n: 3000, limit: 50, ks: [49, 50, 51], why: "великий: 50 < 2 % = 60 — діє абсолютний поріг" },
]) {
  test(`Умова 8 × поріг HOLD, N = ${c.n} (${c.why}): нижче порогу — SYNCED і видалений товар серед зниклих; рівно на порозі й вище — «МАСОВЕ ЗНИКНЕННЯ» без жодного запису товарів; журнал CC і видалення без змін`, { skip: skip0111 }, async () => {
    assert.equal(ownerLimit(c.n), c.limit, "самоперевірка очікуваного порогу");
    const t = await sized(c.products);
    assert.equal(mainRows(t.w).length, c.n, "передумова: розмір «Основного каталогу»");
    for (const k of c.ks) {
      const { sync, w, main0, cc0 } = await syncWithout(t, k);
      const at = `N = ${c.n}, k = ${k}, поріг ${c.limit}: `;
      if (k >= 1 && k >= c.limit) {
        assert.equal(sync.state, "ABORTED", at + JSON.stringify(sync).slice(0, 300));
        assert.equal(sync.block?.type, "МАСОВЕ ЗНИКНЕННЯ", at + JSON.stringify(sync.block));
        assert.deepEqual([Number(sync.block.affected), Number(sync.block.limit)], [k, c.limit], at + "кількість і поріг у блоці");
        assert.deepEqual(w.book[SHEET.main], main0, at + "HOLD — до будь-якого запису товарів");
      } else {
        assert.equal(sync.state, "SYNCED", at + JSON.stringify(sync).slice(0, 300));
        assert.equal(sync.stats.main.missingInFeed, k, at + "видалений товар рахується серед зниклих — CC його не приховує");
      }
      assert.deepEqual(w.book[CC_SHEET.history], cc0, at + "журнал Catalog Controls синхронізація не змінює");
      assert.equal(stateOf(w).tombstoned.get(ID)?.confirmed, true, at + "видалення чинне");
    }
  });
}

test("Умова 8 × частковий фід: фільтроване охоплення — зниклих 0, HOLD немає, наявність / ціни поза охопленням без змін, видалений товар не «зник»; той самий фід як повний — «МАСОВЕ ЗНИКНЕННЯ» (різниця — охоплення, а не поріг)", { skip: skip0111 }, async () => {
  const [{ planSheetSync }, { syncControlsState }] = await Promise.all([import("../src/core/sheet-sync.mjs"), import("../src/pipeline/sheet-sync-run.mjs")]);
  const t = await sized(146);
  const keep = new Set(t.others.slice(0, 10));
  const xml = perturb.drop(t.xml, [t.idSid, ...t.others.filter((s) => !keep.has(s))]);
  const parsed = await parse(xml), full0 = await parse(t.xml);
  // Стан CC — так само, як його готує syncSheet (режим пріоритету власника вимагає його; без нього — fail-closed).
  const controls = await syncControlsState(await ccControls(t.w), config);
  const plan = (p, feedScope) => planSheetSync({ book: structuredClone(t.w.book), parsed: p, stamp: later(2), config, now: NOW + 2 * 3600000, groupsRows: groupsOf(t.w), fullById: new Map(), catalog: EMPTY_CATALOG, controls, queueCommands: false, feedScope });
  const base = plan(full0, "full"), filtered = plan(parsed, "filtered"), asFull = plan(parsed, "full");
  assert.equal(base.abort, null, "передумова: повний фід без зникнень");
  assert.equal(filtered.abort, null, "фільтрований фід — без HOLD: " + filtered.abort);
  assert.equal(filtered.stats.main.missingInFeed, 0, "поза охопленням — не «зниклі»");
  assert.equal(filtered.stats.outOfFeedScope, 150 - 10, "поза охопленням — усі, кого немає у фільтрованому фіді");
  for (const k of ["becameUnavailable", "availabilityChanged", "supplierPriceChanged", "salePriceChanged"]) {
    assert.ok(filtered.stats.main[k] <= base.stats.main[k], `${k}: поза охопленням нічого не змінено (${filtered.stats.main[k]} > ${base.stats.main[k]})`);
  }
  assert.equal(asFull.block?.type, "МАСОВЕ ЗНИКНЕННЯ", "той самий фід як повний — HOLD");
  assert.deepEqual([Number(asFull.block.affected), Number(asFull.block.limit)], [140, ownerLimit(150)]);
  assert.equal(stateOf(t.w).tombstoned.get(ID)?.confirmed, true);
});

test("Умова 8 × присутність у постачальника: фільтрований знімок нікого не позначає «видаленим у постачальника» (поза охопленням); пара повних — нижче порогу позначки, рівно на порозі — HOLD без жодної позначки; видалений власником товар поза присутністю", { skip: skip0111 }, async () => {
  const { planPresence, PRESENCE } = await import("../src/core/supplier-presence.mjs");
  const t = await sized(146);
  const rows = mainRows(t.w).map((r) => ({ offerId: mtText(r["Offer ID"]), supplierId: mtText(r["ID постачальника"]), presence: "", meta: "" }));
  const all = rows.map((r) => r.supplierId), snap = (scope, ids, id) => ({ v: 1, id, feedDate: "2026-11-01 10:00:00", source: "synthetic", scope, ids, count: ids.length, fp: {} });
  const previous = snap("full", all, "sn-prev"), proof = { complete: true, reasons: [] }, removed = new Set([ID]);
  const run = (scope, ids) => planPresence({ rows, previous, snapshot: snap(scope, ids, "sn-" + scope + ids.length), proof, stamp: later(2), removed });
  const kept = t.others.slice(0, 10);
  const f = run("filtered", kept);
  assert.equal(f.decision, "APPLY");
  assert.deepEqual([f.gone.length, f.absent.length, f.updates.size], [0, 0, 0], "фільтрований знімок — жодних позначок");
  assert.equal(f.outOfScope.length, 150 - 10 - 1, "поза охопленням — усі відсутні, крім видаленого власником");
  assert.ok(!f.outOfScope.includes(ID), "видалений власником (CC) — поза присутністю");
  const limit = ownerLimit(150);
  const below = run("full", all.filter((s) => !t.others.slice(0, limit - 1).includes(s)));
  assert.equal(below.decision, "APPLY");
  assert.equal([...below.updates.values()].filter((u) => u.presence === PRESENCE.GONE).length, limit - 1, "нижче порогу — позначки «видалений у постачальника» лише зниклим");
  const at = run("full", all.filter((s) => !t.others.slice(0, limit).includes(s)));
  assert.deepEqual([at.decision, at.disappearing, at.limit, at.updates.size], ["HOLD", limit, limit, 0], "рівно на порозі — HOLD, позначок немає");
  const mass = run("full", kept);
  assert.deepEqual([mass.decision, mass.updates.size], ["HOLD", 0], "масова відсутність у повному знімку — HOLD без позначок");
});

test("Конфлікт ідентичності: постачальник повторно використав ID для іншої моделі — позначено на ручну перевірку (подія одна), нічого не перенесено й не додано; «Було → Стало» у вигляді", async () => {
  const { w } = await tombstoned();
  const parsed = await parse(w.xml);
  const other = { ...parsed.offers.get(ID), sku: "OTHER-777", nameUa: "Зовсім інший товар", nameRu: "Совсем другой товар" };
  parsed.offers.set(ID, other);
  const main0 = structuredClone(w.book[SHEET.main]), queue0 = structuredClone(w.book[SHEET.queue]);
  const fp0 = stateOf(w).fingerprint;
  const r = await run(w, { stamp: later(2), parsed });
  assert.equal(r.stats.conflicts, 1);
  assert.notEqual(stateOf(w).fingerprint, fp0, "підтверджена подія конфлікту входить у відбиток");
  assert.equal(eventsOf(w, ID, ACTION.CONFLICT).length, 1);
  assert.equal(r.gate.check(other).kind, "ID_REUSE_CONFLICT");
  assert.ok(r.gate.check(other).blocked);
  assert.deepEqual(w.book[SHEET.main], main0);
  assert.deepEqual(w.book[SHEET.queue], queue0);
  assert.equal(w.book[ARCHIVE_SHEET], undefined, "CC не переносить рядків");
  await run(w, { stamp: later(3), parsed });
  assert.equal(eventsOf(w, ID, ACTION.CONFLICT).length, 1, "повтор — без нової події");
  assert.equal((await run(w, { stamp: later(3), parsed, mode: "shadow" })).planned.events, 0, "повтор нічого не планує");
  setCells(w, ID, { "Артикул постачальника": "OTHER-777" });
  await run(w, { stamp: later(4) });
  assert.match(viewOf(w, ID)["Попередження"], /КОНФЛІКТ ІДЕНТИЧНОСТІ — фізична ідентичність картки відрізняється від реєстру видалення \(Було → Стало\): Артикул постачальника: «[^»]+» → «OTHER-777»/);
});

test("Повернення з архіву: команда в «Видалених товарах» → RESTORE_REQUESTED і доручення toCatalog; після перенесення — RESTORED, товар у каталозі, лишається знятим з продажу, фільтр не блокує; «ПОВЕРНУТИ В ПРОДАЖ» — окремою командою; команди продажу в архіві не діють; B: пошкодження ІНШОЇ картки не заважає", async () => {
  const { w } = await archived();
  const parsed = await parse(w.xml);
  // команди продажу в архіві не виконуються
  setCells(w, ID, { [SALE_DECISION]: "ПОВЕРНУТИ В ПРОДАЖ ABCDEF" }, ARCHIVE_SHEET);
  await run(w, { stamp: later(2) });
  assert.match(viewOf(w, ID)["Попередження"], /«ПОВЕРНУТИ В ПРОДАЖ» діє лише в «Основний каталог»/);
  assert.equal(eventsOf(w, ID, ACTION.RELEASE).length, 0);
  // B: картка іншого товару пошкоджена — не перевіряється для цього повернення
  const i2 = w.book[SHEET.main].findIndex((x) => x[0] === ID2);
  w.book[SHEET.main][i2][w.book[SHEET.main][0].indexOf(SEAL_COLUMN)] = "0".repeat(64);
  const r = await confirmIn(w, ARCHIVE_SHEET, ID, BACK, 3);
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.equal(eventsOf(w, ID, ACTION.UNTOMBSTONE).length, 1);
  let s = stateOf(w);
  assert.ok(!s.tombstoned.has(ID) && s.held.has(ID));
  assert.deepEqual(s.moves, { toArchive: [], toCatalog: [ID] });
  assert.match(viewOf(w, ID)["Виключення"], /ПОВЕРНЕННЯ З АРХІВУ ЗАРЕЄСТРОВАНО — очікує перенесення в «Основний каталог»/);
  assert.equal(s.gate.check(parsed.offers.get(ID)).kind, "NONE");
  engineeringMove(w.book, ID, ARCHIVE_SHEET, SHEET.main);
  s = stateOf(w);
  assert.deepEqual(s.moves, { toArchive: [], toCatalog: [] });
  assert.ok(s.held.has(ID), "повернення з архіву не повертає в продаж");
  await run(w, { stamp: later(4) });
  // R7: код повернення в продаж — на запит (не проактивно); confirm нижче — запит → код → команда.
  assert.doesNotMatch(viewOf(w, ID)["Коди підтвердження"], /ПОВЕРНУТИ В ПРОДАЖ [0-9A-F]{6}/);
  const { r2 } = await confirm(w, ID, SALE_DECISION, "ПОВЕРНУТИ В ПРОДАЖ", { stamp: later(5) });
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2));
  assert.ok(!stateOf(w).held.has(ID), "у продажу — лише окремою підтвердженою командою");
});

test("Непідтверджене повернення з архіву (коміт точки не вдався) не знімає видалення: реєстр, фільтр і held тримаються, доручення toCatalog немає", async () => {
  const { w } = await archived();
  setCells(w, ID, { [SALE_DECISION]: BACK }, ARCHIVE_SHEET);
  await run(w, { stamp: later(2) });
  setCells(w, ID, { [SALE_DECISION]: `${BACK} ${codeOf(w, ID, BACK)}` }, ARCHIVE_SHEET);
  const put = w.store.putJsonIfVersion.bind(w.store);
  w.store.putJsonIfVersion = async (k, v, ver, o) => { if (k === CHECKPOINT_KEY && v.ops.length > (w.store.data.get(k)?.ops.length || 0)) throw new Error("імітовано: коміт не вдався"); return put(k, v, ver, o); };
  const r = await run(w, { stamp: later(3) });
  w.store.putJsonIfVersion = put;
  assert.equal(r.state, "UNCONFIRMED", JSON.stringify(r));
  assert.equal(eventsOf(w, ID, ACTION.UNTOMBSTONE).length, 1, "передумова: рядок повернення в журналі");
  const s = stateOf(w);
  assert.ok(s.tombstoned.has(ID) && s.gate.knownIds.has(ID) && s.held.has(ID));
  assert.deepEqual(s.moves.toCatalog, []);
});

test("Повернення з архіву — відмови лише за перевірками цієї картки: інша фізична ідентичність; повторне використання ID у фіді; ID постачальника / «Код товару Prom» зайнятий активною карткою; товар уже в «Нових товарах»; N3 — нечитабельні «Нові товари» / «Відкладені»; копії в обох аркушах", async () => {
  const { w } = await archived();
  setCells(w, ID, { [SALE_DECISION]: BACK }, ARCHIVE_SHEET);
  await run(w, { stamp: later(2) });
  setCells(w, ID, { [SALE_DECISION]: `${BACK} ${codeOf(w, ID, BACK)}` }, ARCHIVE_SHEET);
  const refused = async (hours, re, opts = {}) => {
    const r = await run(w, { stamp: later(hours), ...opts });
    assert.equal(r.stats.untombstoned, 0, String(re));
    assert.match(viewOf(w, ID)["Попередження"], re);
    assert.ok(stateOf(w).tombstoned.has(ID));
  };
  // (а) повторне використання ID у фіді
  const parsed = await parse(w.xml);
  parsed.offers.set(ID, { ...parsed.offers.get(ID), sku: "OTHER-777", nameUa: "Інший", nameRu: "Другой" });
  await refused(3, /постачальник повторно використав ID для іншого товару/, { parsed });
  // (б) ID постачальника / «Код товару Prom» в іншої активної картки
  const sid = mtText(archiveRow(w, ID)["ID постачальника"]), code = mtText(archiveRow(w, ID)["Код товару Prom"]);
  assert.ok(code, "у синтетиці код є");
  const otherSid = mtText(rowOf(w, ID2)["ID постачальника"]), otherCode = mtText(rowOf(w, ID2)["Код товару Prom"]);
  setCells(w, ID2, { "ID постачальника": sid });
  await refused(4, new RegExp(`ID постачальника вже використовує товар ${ID2}`));
  setCells(w, ID2, { "ID постачальника": otherSid, "Код товару Prom": code });
  await refused(5, new RegExp(`«Код товару Prom» уже використовує товар ${ID2}`));
  setCells(w, ID2, { "Код товару Prom": otherCode });
  // (в) N3: «Нові товари» не читається — перевірку не виконано
  const q0 = structuredClone(w.book[SHEET.queue]);
  w.book[SHEET.queue] = [["зламаний заголовок"]];
  await refused(6, /«Нові товари» не вдалося прочитати — перевірку конфліктів не виконано/);
  w.book[SHEET.queue] = q0;
  const d0 = structuredClone(w.book[SHEET.deferred]);
  w.book[SHEET.deferred] = [["зламаний заголовок"]];
  await refused(7, /«Відкладені товари» не вдалося прочитати/);
  w.book[SHEET.deferred] = d0;
  // (г) товар (той самий ID постачальника) уже в «Нових товарах»
  const qh = w.book[SHEET.queue][0].map(mtText);
  w.book[SHEET.queue].push(qh.map((k) => (k === "Offer ID" ? "2999999995" : k === "ID постачальника" ? sid : k === "Артикул постачальника" ? "Q-1" : "")));
  await refused(8, /цей товар уже є в «Нових товарах» або «Відкладених»/);
  w.book[SHEET.queue] = q0;
  // (д) інша фізична ідентичність картки в архіві (печатку перераховано — це не пошкодження, а інший товар)
  const a0 = structuredClone(w.book[ARCHIVE_SHEET]);
  setCells(w, ID, { "Артикул постачальника": "OTHER-NEW-SKU" }, ARCHIVE_SHEET);
  reseal(w, ARCHIVE_SHEET, ID);
  await run(w, { stamp: later(9) });
  setCells(w, ID, { [SALE_DECISION]: `${BACK} ${codeOf(w, ID, BACK)}` }, ARCHIVE_SHEET);
  await refused(10, /фізична ідентичність картки відрізняється від реєстру видалення \(Артикул постачальника: «[^»]+» → «OTHER-NEW-SKU»\)/);
  w.book[ARCHIVE_SHEET] = a0;
  // (е) однакова копія в обох аркушах — команди не виконуються, доки Engineering не завершить перенесення
  w.book[SHEET.main].push(w.book[ARCHIVE_SHEET].find((x) => x[0] === ID).slice());
  await refused(11, /рядків із цим Offer ID/);
  assert.equal(stateOf(w).tombstoned.get(ID).stage, "MOVING");
  assert.equal(eventsOf(w, ID, ACTION.UNTOMBSTONE).length, 0);
});

test("C (M3): дозволена ручна правка (OWNER_EDIT) не блокує «Видалити товар» і «Повернути з архіву»; CORRUPT / UNVERIFIED — відмова лише цій картці", async () => {
  const w = await prepared();
  await confirm(w, ID, SALE_DECISION, HOLD);
  const i = w.book[SHEET.main].findIndex((x) => x[0] === ID);
  w.book[SHEET.main][i][w.book[SHEET.main][0].indexOf(SEAL_COLUMN)] = "0".repeat(64); // правка, яку без M3 не відрізнити
  setCells(w, ID, { [SALE_DECISION]: DEL });
  await run(w, { stamp: later(1) });
  setCells(w, ID, { [SALE_DECISION]: `${DEL} ${codeOf(w, ID, DEL)}` });
  await run(w, { stamp: later(2) });
  assert.match(viewOf(w, ID)["Попередження"], /картка не пройшла перевірку цілісності \(UNVERIFIED/);
  w.integrity = { cardVerdict: (row) => ({ verdict: mtText(row["Offer ID"]) === ID ? "CORRUPT" : "OK", reasons: ["тест: пошкодження"] }) };
  await run(w, { stamp: later(3) });
  assert.match(viewOf(w, ID)["Попередження"], /картка не пройшла перевірку цілісності \(CORRUPT: тест: пошкодження\)/);
  assert.equal(stateOf(w).tombstoned.size, 0);
  w.integrity = { cardVerdict: () => ({ verdict: "OWNER_EDIT", reasons: ["змінено поле власника"] }) };
  const r = await run(w, { stamp: later(4) });
  assert.equal(r.stats.tombstoned, 1, JSON.stringify(r.warnings));
  assert.equal(stateOf(w).tombstoned.get(ID).confirmed, true);
  assert.deepEqual(stateOf(w).moves.toArchive, [ID]);
  engineeringMove(w.book, ID, SHEET.main, ARCHIVE_SHEET);
  w.integrity = { cardVerdict: (row) => ({ verdict: mtText(row["Offer ID"]) === ID ? "CORRUPT" : "OK", reasons: [] }) };
  await confirmIn(w, ARCHIVE_SHEET, ID, BACK, 5);
  assert.match(viewOf(w, ID)["Попередження"], /картка не пройшла перевірку цілісності \(CORRUPT\)/);
  w.integrity = { cardVerdict: () => ({ verdict: "OWNER_EDIT", reasons: [] }) };
  await run(w, { stamp: later(6) });
  assert.equal(eventsOf(w, ID, ACTION.UNTOMBSTONE).length, 1, "OWNER_EDIT не блокує повернення з архіву");
});

test("Захищені: FZ / перелік захищених / OV / захист не перевірено — видалення не виконується; loadProtection: стан A і B без входів — недійсний, OV-товари з переліку репозиторію враховано", async () => {
  for (const protection of [{ ...PROTECTION_OK, fzIds: new Set([ID]) }, { ...PROTECTION_OK, protectedIds: new Set([ID]) }, { ...PROTECTION_OK, ovIds: new Set([ID]) }, { valid: false, reasons: ["перевірка"] }, null]) {
    const w = await prepared();
    await confirm(w, ID, SALE_DECISION, HOLD);
    await confirm(w, ID, SALE_DECISION, DEL, { stamp: later(1), protection });
    assert.equal(stateOf(w).tombstoned.size, 0, JSON.stringify(protection?.reasons || protection));
    assert.match(viewOf(w, ID)["Попередження"], protection?.valid ? /захищений товар \(FZ \/ перелік захищених \/ рішення власника OV\)/ : /захист FZ \/ перелік захищених \/ OV не перевірено/);
  }
  const a = loadProtection({ catalog: loadPromCatalog(undefined, STATE_A), freezeFile: "", contractFile: STATE_A.freezeContractFile });
  assert.equal(a.valid, false);
  assert.ok(a.reasons.some((x) => /MM_FREEZE_IDS/.test(x)));
  const b = loadProtection({ catalog: loadPromCatalog(undefined, { freezeFile: "", frozenAttrsFile: "" }), freezeFile: "" });
  assert.equal(b.valid, false);
  const c = loadProtection({ catalog: { ownerValueIds: new Set(["1"]), ownerValues: new Map([["2", {}]]), ownerIndex: new Map([["3", {}]]), frozenIds: ["4"] }, freezeFile: "" });
  assert.deepEqual([...c.ovIds].sort(), ["1", "2", "3"]);
  assert.deepEqual([...c.fzIds], ["4"]);
});

test("Ліміт 10 видалень (11 підтверджених кодами) — жодного; у межах — виконано", async () => {
  const w = await prepared();
  const ids = mainRows(w).slice(0, 11).map((r) => r["Offer ID"]);
  for (const id of ids) await confirm(w, id, SALE_DECISION, HOLD);
  for (const id of ids) setCells(w, id, { [SALE_DECISION]: `ВИДАЛИТИ ТОВАР ${id}` });
  await run(w, { stamp: later(1) });
  for (const id of ids) setCells(w, id, { [SALE_DECISION]: `ВИДАЛИТИ ТОВАР ${id} ${codeOf(w, id, `ВИДАЛИТИ ТОВАР ${id}`)}` });
  const r = await run(w, { stamp: later(2) });
  assert.equal(r.tombstoned.size, 0);
  assert.ok(r.warnings.some((x) => /11 > ліміт 10/.test(x)));
  setCells(w, ids[10], { [SALE_DECISION]: "" });
  assert.equal((await run(w, { stamp: later(3) })).tombstoned.size, 10);
});

test("Свідки (fail-closed, без загальної зупинки): рядок в архіві без рішення CC — UNREGISTERED; подію видалення прибрано з журналу — реєстр у точці тримає, apply дописує рядок; регрес точки (бекап до видалення) — видалений товар не відроджується (UNBOUND); архів не читається — UNKNOWN; рядок зник з обох аркушів — ANOMALY; ручна зміна покоління — пошкодження", async () => {
  const { w, cpBefore } = await archived();
  const cp = w.store.data.get(CHECKPOINT_KEY);
  const at = (book, extra = {}) => controlsState(book, { ...ctxOf(w), checkpoint: cp, ...extra });
  // (а) товар вручну перенесено в «Видалені товари» без рішення CC
  const a = structuredClone(w.book);
  engineeringMove(a, ID2, SHEET.main, ARCHIVE_SHEET);
  const sa = at(a);
  assert.deepEqual([sa.tombstoned.get(ID2)?.stage, sa.blocked], ["UNREGISTERED", false]);
  assert.ok(sa.held.has(ID2) && sa.gate.knownIds.has(ID2));
  assert.ok(!sa.moves.toCatalog.includes(ID2), "без рішення CC — жодного повернення");
  // (б) рядок видалення прибрано з журналу — довірений реєстр у точці
  const b = structuredClone(w.book);
  b[CC_SHEET.history] = b[CC_SHEET.history].filter((r) => r[3] !== ACTION.TOMBSTONE);
  const sb = at(b);
  assert.deepEqual([sb.tombstoned.get(ID)?.confirmed, sb.blocked], [true, false]);
  assert.ok(sb.held.has(ID) && sb.damaged.has(ID) && sb.gate.knownIds.has(ID));
  // (в) регрес точки: відновлено бекап до видалення — рядок «ТОВАР ВИДАЛЕНО» без прив'язки діє (захисний)
  const sc = at(structuredClone(w.book), { checkpoint: cpBefore });
  assert.deepEqual([sc.tombstoned.get(ID)?.stage, sc.blocked], ["UNBOUND", false]);
  assert.ok(sc.held.has(ID) && sc.gate.knownIds.has(ID), "видалений товар не відроджується");
  // (г) «Видалені товари» не читається
  const d = structuredClone(w.book); d[ARCHIVE_SHEET] = [["зламаний заголовок"]];
  const sd = at(d);
  assert.deepEqual([sd.tombstoned.get(ID)?.stage, sd.moves, sd.blocked], ["UNKNOWN", { toArchive: [], toCatalog: [] }, false]);
  assert.ok(sd.held.has(ID) && sd.issues.some((x) => /«Видалені товари» не читається/.test(x)));
  // (д) рядок зник з обох аркушів
  const e = structuredClone(w.book); e[ARCHIVE_SHEET] = [e[ARCHIVE_SHEET][0]];
  const se = at(e);
  assert.deepEqual([se.tombstoned.get(ID)?.stage, se.blocked], ["ANOMALY", false]);
  assert.ok(se.held.has(ID) && se.gate.knownIds.has(ID));
  // (е) ручна зміна покоління (без печатки) — пошкодження товару
  const f = structuredClone(w.book);
  const k = f[CC_SHEET.history].findIndex((r) => r[3] === ACTION.HOLD);
  f[CC_SHEET.history][k][8] = "sale:7";
  const sf = controlsState(f, { contract: { ...ACTIVE_CONTRACT, activated: false } });
  assert.ok(sf.damaged.has(ID) && sf.held.has(ID));
  // apply після (б): рядок дописано з точки
  w.book[CC_SHEET.history] = b[CC_SHEET.history]; // на місці: writer тримає посилання на книгу
  const r = await run(w, { stamp: later(9) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.equal(eventsOf(w, ID, ACTION.TOMBSTONE).length, 1);
  assert.ok(!stateOf(w).damaged.has(ID));
});
