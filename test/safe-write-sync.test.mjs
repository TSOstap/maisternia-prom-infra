/** E2 / S1 у справжньому syncSheet (Hermes CC-R3 I3 / H13) + регресія на 5 029 картках (синтетичні дані, fake transport).
 *  Перевіряється: правки власника (SEO, описи) під час синхронізації не перезаписуються; сортування до / після перевірки порядку не
 *  кладе ціни на чужі товари; через шлюз — оренда, журнал, жодного видалення рядків (черга скорочується очищенням хвоста);
 *  на 5 029 картках поза цільовими клітинками не змінюється нічого. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet, LIVE_COLUMNS } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, DECISION, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { EMPTY_CATALOG, intakeAll } from "./helpers/intake.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { OP } from "../src/pipeline/safe-write/keyed-update.mjs";
// Старий режим (явно): регресія прийнятої механіки — див. helpers/legacy-config.mjs (рішення власника 29–30.10).
import baseConfig from "./helpers/legacy-config.mjs";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const STAMP = new Date(NOW).toISOString();
const config = structuredClone(baseConfig);

async function world({ products = 60, queue = 6, newOffers = 0, seed = 11 } = {}) {
  const s = generateSynthetic({ products, queue, deferred: 2, newOffers, seed, now: NOW });
  const book = {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
  const sheets = new MemorySheets(book);
  const w = { s, book, sheets, readBook: async () => sheets.read(), xml: s.supplierXml() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: STAMP });
  return w;
}
async function sync(w, xml, { readBook, session = null, cfg = config } = {}) {
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  return syncSheet({ sheets: w.sheets, readBook: readBook || w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: STAMP, config: cfg, now: NOW, catalog: EMPTY_CATALOG, session });
}
const main = async (w) => readSheet((await w.sheets.read([SHEET.main]))[SHEET.main], SHEET.main).rows;
/** Видалення рядків лише з моменту позначки (підготовка світу — mergeNew92 / intake — не рахується). */
const deletesSince = (w, mark) => w.sheets.log.slice(mark).filter((x) => x.op === "deleteRows").length;
const byKey = (rows) => new Map(rows.map((r) => [mtText(r["Offer ID"]), r]));
const rowOf = (w, id) => w.sheets.book[SHEET.main].findIndex((r) => mtText(r[0]) === id) + 1;

test("S1 / H13: власник змінює SEO й опис картки під час синхронізації — правка зберігається, синхронізація не перезаписує її", async () => {
  const w = await world();
  assert.equal((await sync(w, w.xml)).state, "SYNCED");
  const t = (await main(w))[5], id = mtText(t["Offer ID"]), sid = mtText(t["ID постачальника"]);
  const oldSupplierName = mtText(t["Назва постачальника UA"]);
  const xml2 = perturb.tag(w.xml, sid, "name_ua", "Нова назва постачальника для перевірки");
  let first = true;
  const mark = w.sheets.log.length;
  w.sheets.beforeWrite = (op) => {
    if (op !== "updateRanges" || !first) return;
    first = false; // після запису блоку цін, до запису картки
    w.sheets.humanSet(SHEET.main, rowOf(w, id), "Назва UA", "SEO ВЛАСНИКА НОВЕ");
    w.sheets.humanSet(SHEET.main, rowOf(w, id), "Опис UA", "<p>опис власника</p>");
  };
  const r = await sync(w, xml2);
  w.sheets.beforeWrite = null;
  const now = byKey(await main(w)).get(id);
  assert.equal(mtText(now["Назва UA"]), "SEO ВЛАСНИКА НОВЕ", "SEO власника не перезаписано");
  assert.equal(mtText(now["Опис UA"]), "<p>опис власника</p>", "опис власника не перезаписано");
  assert.notEqual(r.state, "SYNCED", "печатка рядка не збігається — синхронізація не підтверджує стан, а відкочує свої клітинки");
  assert.equal(mtText(now["Назва постачальника UA"]), oldSupplierName, "наші клітинки картки повернуто за ключем");
  assert.equal(deletesSince(w, mark), 0, "жодного видалення рядків");
});

test("S1: без паралельних правок — дані постачальника оновлено лише в колонках синхронізації; SEO / описи — байт-у-байт", async () => {
  const w = await world();
  await sync(w, w.xml);
  const t = (await main(w))[7], id = mtText(t["Offer ID"]), sid = mtText(t["ID постачальника"]);
  const before = byKey(await main(w));
  const r = await sync(w, perturb.tag(w.xml, sid, "name_ua", "Оновлена назва постачальника"));
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 400));
  const after = byKey(await main(w));
  assert.equal(mtText(after.get(id)["Назва постачальника UA"]), "Оновлена назва постачальника");
  for (const [k, b] of before) for (const col of ["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Запити UA", "Запити RU"]) assert.equal(mtText(after.get(k)[col]), mtText(b[col]), `${k}/${col}`);
});

test("S1: сортування «Основного каталогу» людиною ДО запису — запуск нічого не пише (SKIPPED_CONCURRENT_EDIT)", async () => {
  const w = await world();
  await sync(w, w.xml);
  let calls = 0;
  const racy = async (n) => { calls++; if (n?.length === 1 && n[0] === SHEET.main) w.sheets.humanSort(SHEET.main, "Offer ID", true); return w.sheets.read(); };
  const writesBefore = w.sheets.log.length;
  const r = await sync(w, perturb.tag(w.xml, mtText((await main(w))[3]["ID постачальника"]), "price", "777"), { readBook: racy });
  assert.equal(r.state, "SKIPPED_CONCURRENT_EDIT");
  assert.equal(w.sheets.log.length, writesBefore, "жодного запиту запису");
  assert.ok(calls >= 2);
});

test("S1: сортування ПІСЛЯ перевірки порядку, до запису блоку цін — виявлено за ключем, ціни повернуто кожному товару", async () => {
  const w = await world();
  await sync(w, w.xml);
  const before = byKey(await main(w));
  const sid = mtText([...before.values()][3]["ID постачальника"]);
  let first = true;
  w.sheets.beforeWrite = (op) => { if (op === "updateRanges" && first) { first = false; w.sheets.humanSort(SHEET.main, "Offer ID", true); } };
  const r = await sync(w, perturb.tag(w.xml, sid, "price", "777"));
  w.sheets.beforeWrite = null;
  assert.notEqual(r.state, "SYNCED");
  assert.equal(r.verify?.opsWritten, false, "перевірка за ключем виявила ціни на чужих товарах");
  const after = byKey(await main(w));
  for (const [k, b] of before) for (const col of LIVE_COLUMNS) assert.equal(mtText(after.get(k)[col]), mtText(b[col]), `${k}/${col}: жоден товар не має чужих цін`);
});

test("S1 + E3: через шлюз — оренда й журнал; відхилена позиція → «Заморожені ID»; рядок черги й рішення власника лишаються (B6, ENG-27 N3), без видалення й очищення рядків", async () => {
  const w = await world({ newOffers: 3 });
  assert.equal((await sync(w, w.xml)).state, "SYNCED");
  await intakeAll(w, w.xml, { session: "auto", stamp: STAMP, now: NOW, config, catalog: EMPTY_CATALOG });
  const q = (await w.sheets.read([SHEET.queue]))[SHEET.queue];
  assert.ok(q.length >= 3, "у черзі є позиції");
  w.sheets.humanSet(SHEET.queue, 2, "Рішення", DECISION.REJECT);
  const gw = new WriteGateway({ sheets: w.sheets, read: w.readBook, store: new MemoryStore(), now: () => NOW });
  const s = await gw.open({ writer: "sync", scope: "sync" });
  const mark = w.sheets.log.length;
  const r = await sync(w, w.xml, { session: s });
  await s.close();
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 500));
  assert.equal(r.stats.rejected, 1);
  assert.equal(deletesSince(w, mark), 0, "жодного видалення рядків");
  const q2 = (await w.sheets.read([SHEET.queue]))[SHEET.queue];
  // ENG-27 (Hermes INT N3): видалення / очищення рядків черги заблоковано до B6 — довжина черги й рішення власника без змін.
  assert.equal(q2.length, q.length, "рядок не видалено й не очищено");
  const qh = q2[0].map(mtText), rid = mtText(q[1][qh.indexOf("Offer ID")]); // humanSet(…, 2, …) — рядок 2 аркуша = q[1]
  assert.equal(mtText(q2.find((x, i) => i > 0 && mtText(x[qh.indexOf("Offer ID")]) === rid)[qh.indexOf("Рішення")]), DECISION.REJECT, "рішення власника не стерто");
  assert.ok((await w.sheets.read([SHEET.frozen]))[SHEET.frozen].some((x) => mtText(x[0]) === rid), "ID — у «Заморожених»");
  assert.equal(r.queueRemoval.state, "BLOCKED_B6");
  assert.deepEqual(r.queueRemoval.keys, [rid]);
  const ent = await s.journal.entries();
  assert.ok(ent.some((e) => e.phase === "ACQUIRE") && ent.some((e) => e.phase === "RELEASE") && ent.some((e) => e.kind === "raw"));
});

test("Регресія 5 029 карток: запис 300 карток за ключем зі вставкою рядка й правками SEO людиною посеред операції — поза цільовими клітинками не змінилося нічого", async () => {
  const w = await world({ products: 5029, queue: 0 });
  const gw = new WriteGateway({ sheets: w.sheets, read: w.readBook, store: new MemoryStore(), now: () => NOW });
  const s = await gw.open({ writer: "sync" });
  const mark = w.sheets.log.length;
  // Початкове вирівнювання синтетичного аркуша з фідом: 221 «немає в наявності» > поріг 101 — для тестових даних поріг знято.
  const relaxed = structuredClone(config);
  relaxed.policy = { ...relaxed.policy, anomaly: { ...relaxed.policy?.anomaly, maxNewlyMissing: 1e9, maxNewlyMissingRatio: 1 } };
  assert.equal((await sync(w, w.xml, { session: s, cfg: relaxed })).state, "SYNCED");
  const before = byKey(await main(w));
  assert.equal(before.size, 5029);
  const ids = [...before.keys()];
  const targets = ids.filter((_, i) => i % 16 === 3).slice(0, 300);
  const seoEdits = ids.filter((_, i) => i % 97 === 5).slice(0, 50);
  const changes = targets.map((k) => ({ key: k, expect: { "Фото JSON": mtText(before.get(k)["Фото JSON"]) }, set: { "Фото JSON": `["https://images.prom.ua/new-${k}.jpg"]` } }));
  let once = true;
  w.sheets.beforeWrite = (op) => {
    if (op !== "updateRanges" || !once) return;
    once = false;
    for (const k of seoEdits) w.sheets.humanSet(SHEET.main, rowOf(w, k), "Назва UA", "SEO ВЛАСНИКА " + k);
    w.sheets.humanInsertRow(SHEET.main, 1000, ["9999999990", "9999999990", "ВСТАВЛЕНО ЛЮДИНОЮ"]);
  };
  const r1 = await s.updateByKey({ title: SHEET.main, changes, generation: "5029-photo" });
  w.sheets.beforeWrite = null;
  assert.equal(r1.outcome, OP.NEEDS_DECISION, "вставка зсунула рядки: частина записів лягла в чужі рядки — виявлено");
  assert.ok(r1.misplaced.length > 0);
  const comp = await s.compensateMisplaced(SHEET.main, r1.misplaced);
  assert.equal(comp.outcome, OP.VERIFIED, "чужі рядки відновлено за ключем");
  await s.decide(r1.opId, "перевірено: вставку рядка людиною, наслідки компенсовано за ключем");
  assert.equal(s.state, "READY");
  const r2 = await s.updateByKey({ title: SHEET.main, changes, generation: "5029-photo-retry" });
  assert.equal(r2.outcome, OP.VERIFIED);
  await s.close();
  // Звірка всіх 5 029 карток за ключем.
  const afterSheet = (await w.sheets.read([SHEET.main]))[SHEET.main];
  assert.equal(afterSheet.length, 5029 + 2, "заголовок + 5 029 + вставлений людиною; нічого не видалено");
  const after = byKey(readSheet(afterSheet.filter((r) => mtText(r[0]) !== "9999999990"), SHEET.main).rows);
  const T = new Set(targets), E = new Set(seoEdits);
  let changed = 0;
  for (const [k, b] of before) {
    const a = after.get(k);
    for (const col of Object.keys(b)) {
      const exp = T.has(k) && col === "Фото JSON" ? `["https://images.prom.ua/new-${k}.jpg"]` : E.has(k) && col === "Назва UA" ? "SEO ВЛАСНИКА " + k : mtText(b[col]);
      if (mtText(a[col]) !== exp) changed++;
    }
  }
  assert.equal(changed, 0, "жодної зайвої / втраченої клітинки");
  assert.equal(deletesSince(w, mark), 0);
});
