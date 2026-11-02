/** ENG-28 — N4 (Hermes ENG-27: зміна вже виконаного рішення), перенесення NEW92 (B6: рядки черги не видаляються) і план QA п'яти
 *  товарів (лише читання). Синтетика, таблиця в пам'яті. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { rowSeal, SEAL_COLUMN } from "../src/core/seal.mjs";
import { SHEET, DECISION, QUEUE_HEADERS, extractFullOffers, readPassport } from "../src/core/sheet-sync.mjs";
import * as run from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { EMPTY_CATALOG, intakeAll } from "./helpers/intake.mjs";
import legacyConfig from "./helpers/legacy-config.mjs";

const { mergeNew92, syncSheet } = run;
const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();
const config = structuredClone(legacyConfig);
const SNAP_DATE = "2026-10-29T18:20:40.743Z";

function book0(s) {
  return { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
}
async function queueWorld() {
  const s = generateSynthetic({ products: 60, queue: 6, deferred: 2, newOffers: 4, seed: 11, now: NOW });
  const sheets = new MemorySheets(book0(s));
  const w = { s, sheets, readBook: async () => sheets.read(), xml: s.supplierXml() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: STAMP });
  assert.equal((await sync(w)).state, "SYNCED");
  assert.equal((await intakeAll(w, w.xml, { session: "auto", stamp: STAMP, now: NOW, config, catalog: EMPTY_CATALOG })).state, "INTAKE_DONE");
  return w;
}
async function new92World() {
  const s = generateSynthetic({ products: 60, queue: 6, deferred: 2, newOffers: 0, seed: 21, now: NOW });
  const sheets = new MemorySheets(book0(s));
  return { s, sheets, readBook: async () => sheets.read(), xml: s.supplierXml() };
}
async function sync(w, xml = w.xml) {
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  return syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config, now: NOW, catalog: EMPTY_CATALOG });
}
const qRows = (w) => readSheet(w.sheets.book[SHEET.queue], SHEET.queue).rows;
const qRow = (w, id) => qRows(w).find((r) => mtText(r["Offer ID"]) === id);
const mainRows = (w) => readSheet(w.sheets.book[SHEET.main], SHEET.main).rows;
const qh = (w) => w.sheets.book[SHEET.queue][0].map(mtText);
const setQ = (w, id, col, v) => w.sheets.humanSet(SHEET.queue, w.sheets.book[SHEET.queue].findIndex((r, i) => i > 0 && mtText(r[qh(w).indexOf("Offer ID")]) === id) + 1, col, v);
const frozenHas = (w, id) => (w.sheets.book[SHEET.frozen] || []).some((r) => mtText(r[0]) === id);
function makeApprovable(w, id) {
  const groupId = w.sheets.book[SHEET.groups][1][0];
  for (const [k, v] of Object.entries({ "Назва UA": "SEO UA " + id, "Назва RU": "SEO RU " + id, "Опис UA": "<p>Опис</p>", "Опис RU": "<p>Описание</p>", "Група ID": groupId, "Категорія Prom ID": "123" })) setQ(w, id, k, v);
}

// ---------------------------------------------------------------- N4
test("ENG-28 N4: ЗАТВЕРДЖЕНО виконано, потім власник ставить ВІДХИЛЕНО — не виконується: товар лишається в каталозі, у «Заморожені» не додано, пояснення в «Перевірці» й «Журналі»", async () => {
  const w = await queueWorld();
  const id = mtText(qRows(w)[0]["Offer ID"]);
  makeApprovable(w, id);
  setQ(w, id, "Рішення", DECISION.APPROVE);
  assert.equal((await sync(w)).stats.approved, 1);
  assert.ok(mainRows(w).some((r) => mtText(r["Offer ID"]) === id));
  setQ(w, id, "Рішення", DECISION.REJECT);
  const r = await sync(w);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 300));
  assert.equal(r.stats.rejected, 0, "відхилення не виконано");
  assert.equal(frozenHas(w, id), false, "у «Заморожені ID» не додано");
  assert.ok(mainRows(w).some((r) => mtText(r["Offer ID"]) === id), "товар лишився в каталозі (знімати — лише через CC)");
  assert.ok(r.decisionRefused.some((x) => x.offerId === id));
  assert.match(qRow(w, id)["Перевірка"], /НЕ ВІДХИЛЕНО: товар уже в «Основному каталозі»/);
  assert.ok(w.sheets.book[SHEET.journal].some((e) => e[2] === id && e[3] === "РІШЕННЯ НЕ ВИКОНАНО"));
  assert.ok(!w.sheets.book[SHEET.journal].some((e) => e[2] === id && e[3] === "ВІДХИЛЕНО"), "«ВІДХИЛЕНО» в «Журнал» не пишеться");
});

test("ENG-28 N4: ВІДХИЛЕНО виконано, потім власник ставить ЗАТВЕРДЖЕНО — не переноситься: ID лишається в «Заморожених», у каталог не додано, пояснення", async () => {
  const w = await queueWorld();
  const id = mtText(qRows(w)[1]["Offer ID"]);
  setQ(w, id, "Рішення", DECISION.REJECT);
  assert.equal((await sync(w)).stats.rejected, 1);
  assert.equal(frozenHas(w, id), true);
  makeApprovable(w, id);
  setQ(w, id, "Рішення", DECISION.APPROVE);
  const r = await sync(w);
  assert.equal(r.stats.approved, 0);
  assert.ok(!mainRows(w).some((x) => mtText(x["Offer ID"]) === id), "у каталог не додано");
  assert.ok(r.decisionRefused.some((x) => x.offerId === id));
  assert.match(qRow(w, id)["Перевірка"], /НЕ ПЕРЕНЕСЕНО: ID у «Заморожених ID»/);
});

// ---------------------------------------------------------------- перенесення NEW92
test("ENG-28 перенесення NEW92: усі рядки в основний каталог байт-у-байт; рядки черги НЕ видалено (позначка «ПЕРЕНЕСЕНО»); заголовок черги; паспорт; «ВІДСУТНІЙ_У_YML» → «ВІДСУТНІЙ_У_ЗНІМКУ» з датою, не «видалений»; повтор — нічого", async () => {
  const w = await new92World();
  const q0 = readSheet(w.sheets.book[SHEET.queue], SHEET.queue).rows;
  const absentId = mtText(q0[2]["Offer ID"]);
  const h0 = w.sheets.book[SHEET.queue][0].map(mtText);
  const ri = w.sheets.book[SHEET.queue].findIndex((r, i) => i > 0 && mtText(r[0]) === absentId);
  w.sheets.book[SHEET.queue][ri][h0.indexOf("Стан синхронізації")] = "ВІДСУТНІЙ_У_YML";
  w.sheets.book[SHEET.queue][ri][h0.indexOf("Наявність")] = "-";
  const qLen = w.sheets.book[SHEET.queue].length, mainBefore = mainRows(w).length;
  const mark = w.sheets.log.length;
  const r = await run.transferNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP, snapshotDate: SNAP_DATE });
  assert.equal(r.state, "TRANSFERRED", JSON.stringify(r).slice(0, 600));
  assert.equal(r.moved, q0.length);
  assert.equal(mainRows(w).length, mainBefore + q0.length);
  assert.equal(w.sheets.book[SHEET.queue].length, qLen, "рядки черги не видалено");
  assert.equal(w.sheets.log.slice(mark).filter((x) => x.op === "deleteRows").length, 0);
  assert.deepEqual(w.sheets.book[SHEET.queue][0].map(mtText), QUEUE_HEADERS.slice());
  for (const qr of q0) {
    const m = mainRows(w).find((x) => mtText(x["Offer ID"]) === mtText(qr["Offer ID"]));
    assert.ok(m, "перенесено " + qr["Offer ID"]);
    for (const k of ["Offer ID", "Артикул постачальника", "Категорія Prom ID", "Характеристики JSON", "Ціна постачальника", "Назва UA", "Опис UA", SEAL_COLUMN]) assert.equal(mtText(m[k]), mtText(qr[k]), k);
    assert.match(qRow(w, mtText(qr["Offer ID"]))["Перевірка"], /^ПЕРЕНЕСЕНО В «ОСНОВНИЙ КАТАЛОГ»/);
  }
  const ab = mainRows(w).find((x) => mtText(x["Offer ID"]) === absentId);
  assert.equal(mtText(ab["Стан у постачальника"]), "ВІДСУТНІЙ_У_ЗНІМКУ", "не «ВИДАЛЕНИЙ_У_ПОСТАЧАЛЬНИКА»");
  assert.match(JSON.parse(ab["Знімок постачальника JSON"]).note, new RegExp(`Відсутній у знімку YML постачальника від ${SNAP_DATE}`));
  assert.deepEqual(r.absentInSnapshot, [absentId]);
  assert.equal(readPassport(w.sheets.book[SHEET.passport]).count, mainBefore + q0.length);
  // Повтор — нічого (без дублів).
  const r2 = await run.transferNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP, snapshotDate: SNAP_DATE });
  assert.equal(r2.state, "NOTHING");
  assert.equal(mainRows(w).length, mainBefore + q0.length);
  // Подальша синхронізація: перенесені рядки черги — «ПЕРЕНЕСЕНО», без повторного перенесення; «ВІДХИЛЕНО» на них — відмова (N4).
  setQ(w, mtText(q0[0]["Offer ID"]), "Рішення", DECISION.REJECT);
  const s = await sync(w);
  assert.equal(s.state, "SYNCED", JSON.stringify(s).slice(0, 300));
  assert.equal(s.stats.approved, 0);
  assert.equal(s.stats.rejected, 0);
  assert.equal(mainRows(w).length, mainBefore + q0.length);
  assert.ok(s.decisionRefused.some((x) => x.offerId === mtText(q0[0]["Offer ID"])));
  assert.match(qRow(w, mtText(q0[1]["Offer ID"]))["Перевірка"], /^ПЕРЕНЕСЕНО/);
});

test("ENG-28 перенесення NEW92: печатка основного каталогу зламана (вміст змінено після QA) — PRECONDITION_FAILED із цим ID, жодного запису", async () => {
  const w = await new92World();
  const v = w.sheets.book[SHEET.main], h = v[0].map(mtText);
  const bad = mtText(v[3][h.indexOf("Offer ID")]);
  v[3][h.indexOf("Опис UA")] = "<p>змінено після QA</p>";
  const mark = w.sheets.log.length;
  const r = await run.transferNew92({ sheets: w.sheets, readBook: w.readBook, stamp: STAMP, snapshotDate: SNAP_DATE });
  assert.equal(r.state, "PRECONDITION_FAILED");
  const c = r.checks.find((x) => /печатки основного каталогу/.test(x.name));
  assert.equal(c.ok, false);
  assert.deepEqual(c.detail, [bad]);
  assert.equal(w.sheets.log.length, mark, "жодного запису");
});

// ---------------------------------------------------------------- QA
test("ENG-28 QA: план лише читає — зміна ідентичності потребує актуального повного фіду; печатка → класифікація; заборонені значення з рішення власника блокують; «5,6 Дж» ≠ «6 Дж»", async () => {
  const { planQa, forbiddenPatterns } = await import("../src/core/qa-plan.mjs");
  const s = generateSynthetic({ products: 10, queue: 1, deferred: 1, newOffers: 0, seed: 4, now: NOW });
  const rows = readSheet(s.sheets["Основний каталог"], "Основний каталог").rows.map((r) => ({ ...r }));
  const [a, b, c] = rows;
  a["Стан синхронізації"] = "ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ";
  b["Стан синхронізації"] = "ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ"; b["Опис UA"] = "<p>Потужність 1700 Вт, енергія удару 6 Дж</p>"; // печатку зламано
  c["Опис UA"] = "<p>Енергія удару 5,6 Дж</p>"; c[SEAL_COLUMN] = rowSeal(c);
  const sealsBefore = rows.map((r) => r[SEAL_COLUMN]);
  const decisions = [{ offerId: mtText(b["Offer ID"]), date: "29.10.2026", wrong: [{ subject: "потужність", value: "1700", unit: "Вт" }, { subject: "енергія удару", value: "6", unit: "Дж" }] },
    { offerId: mtText(c["Offer ID"]), date: "29.10.2026", wrong: [{ subject: "енергія удару", value: "6", unit: "Дж" }] }];
  const ids = [a, b, c].map((r) => mtText(r["Offer ID"])).concat(["9999999999"]);
  const p0 = planQa({ rows, ids, decisions, feed: { available: false } });
  const [qa, qb, qc, qx] = p0.items;
  assert.equal(qa.applicable, false);
  assert.match(qa.blockers.join(), /немає актуального повного фіду/);
  assert.equal(qb.seal, "MISMATCH");
  assert.ok(qb.reasons.some((x) => /печатка не збігається/.test(x)));
  assert.ok(qb.blockers.some((x) => /неправильними/.test(x)));
  assert.match(qb.reasons.join(), /1700 Вт \(потужність\) у «Опис UA»/);
  assert.match(qb.reasons.join(), /6 Дж \(енергія удару\) у «Опис UA»/);
  assert.equal(qc.applicable, true, "«5,6 Дж» — не заборонене «6 Дж»");
  assert.equal(qx.found, false);
  const p1 = planQa({ rows, ids: [mtText(a["Offer ID"]), mtText(b["Offer ID"])], decisions, feed: { available: true } });
  assert.equal(p1.items[0].applicable, true, "з актуальним фідом зміна ідентичності застосовна наявним механізмом");
  assert.equal(p1.items[1].applicable, false, "заборонені значення блокують і з фідом");
  assert.deepEqual(rows.map((r) => r[SEAL_COLUMN]), sealsBefore, "печатки не змінено");
  const re = forbiddenPatterns(decisions[0]).map((x) => x.re);
  assert.ok(re[1].test("6Дж") && re[1].test("удару 6 Дж,") && !re[1].test("5,6 Дж") && !re[1].test("16 Дж"));
});
