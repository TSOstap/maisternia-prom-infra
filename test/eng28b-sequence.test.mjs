/** ENG-28b — повна послідовність у робочому режимі (productionConfig → характеристики «preserve») зі справжньою схемою категорії:
 *  структура → CC (двійник) → виправлення 1561514532 → QA (штатне «Оновити товари», фід group_ids) → перенесення NEW92 → повторне
 *  «Оновити товари». Перевіряється: характеристики ВСІХ товарів основного каталогу побайтово ті самі; QA приймає назви постачальника,
 *  наше SEO не змінюється; перенесені рядки — з їхніми характеристиками, описами, запитами, категоріями байт-у-байт; наступне
 *  оновлення їх не перебудовує. Синтетика, таблиця в пам'яті, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { rowSeal, SEAL_COLUMN, YML_HEADERS } from "../src/core/seal.mjs";
import * as SS from "../src/core/sheet-sync.mjs";
import * as run from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import * as P from "../src/core/supplier-presence.mjs";
import { updateProducts } from "../src/pipeline/update-products.mjs";
import * as steps from "../src/pipeline/eng28a-steps.mjs";
import * as WT from "../src/pipeline/safe-write/write-target.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const { SHEET } = SS;
const NOW = Date.parse("2026-10-22T10:00:00Z");
const at = (min) => new Date(NOW + min * 60_000).toISOString();
const FIX = "1561514532";
const real = loadPromCatalog();
const CATS = ["500", "501", "502", "503", "504", "505", "506", "507", "508", "509"];
const catalog = { schemas: new Map(CATS.map((c) => [c, real.schemas.get("1250302")])), mappings: new Map(), units: real.units, names: real.names, problems: [] };
const cfg = () => { const c = productionConfig(structuredClone(baseConfig)); c.supplier.minimumOffers = 10; c.policy.anomaly = { ...c.policy.anomaly, maxNewlyMissingRatio: 1 }; return c; };
const okCc = () => Object.freeze({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp-", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
const FILTERED_URL = "https://market-tools.com.ua/feed.xml?key=SECRET&group_ids=101,102";
const LIVE_PARAMS = JSON.stringify([{ name: "Гарантия", unit: "", value: "36 мес." }, { name: "Живлення", unit: "", value: "Акумулятор" }]);
const DESC = "<ul><li>Довжина шини: 250 мм</li><li>Вага: 3 кг</li></ul>";
const offerRe = (sid) => new RegExp(`<offer id="${sid}"[\\s\\S]*?</offer>`);
const setOffer = (xml, sid) => xml.replace(offerRe(sid), (o) => o.replace(/<param [\s\S]*?<\/param>/g, "").replace(/<description>[\s\S]*?<\/description>/g, "").replace("</offer>", `<param name="Гарантия">36 мес.</param><param name="Питание">Аккумулятор</param><description>${DESC}</description></offer>`));
const full = (xml) => xml.replace(/<\/offer>/g, "<description>Опис постачальника</description></offer>");
const dated = (xml, min) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 3 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });
const SEO = ["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Запити UA", "Запити RU", "Характеристики JSON", "Категорія Prom ID", "Група ID"];

function world() {
  const s = generateSynthetic({ products: 60, queue: 8, deferred: 2, newOffers: 0, seed: 31, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const h = book[SHEET.main][0].map(mtText);
  const reseal = (v) => { v[h.indexOf(SEAL_COLUMN)] = rowSeal(Object.fromEntries(h.map((k, j) => [k, v[j] ?? ""]))); };
  const fix = book[SHEET.main][5];
  fix[h.indexOf("Offer ID")] = FIX;
  fix[h.indexOf("Опис UA")] = "<p>Потужність 1700 Вт, енергія удару 6 Дж; 5,6 Дж — молодша модель.</p>";
  fix[h.indexOf("Опис RU")] = "<p>Мощность 1700 Вт, энергия удара 6 Дж.</p>";
  fix[h.indexOf("Запити UA")] = "перфоратор 1700 Вт, перфоратор 6 Дж";
  fix[h.indexOf("Запити RU")] = "перфоратор 1700 Вт";
  reseal(fix);
  let xml = full(s.supplierXml());
  const live = [8, 16, 24, 32, 40];
  for (const i of live) { const v = book[SHEET.main][i]; v[h.indexOf("Характеристики JSON")] = LIVE_PARAMS; reseal(v); xml = setOffer(xml, mtText(v[h.indexOf("ID постачальника")])); }
  // Аналог 3236816949: у знімку LIVE «ВІДСУТНІЙ_У_YML», поза охопленням фіду group_ids.
  const qh = book[SHEET.queue][0].map(mtText);
  const absent = book[SHEET.queue][3];
  absent[qh.indexOf("Стан синхронізації")] = "ВІДСУТНІЙ_У_YML";
  absent[qh.indexOf("Наявність")] = "-";
  const qRows0 = readSheet(book[SHEET.queue], SHEET.queue).rows;
  xml = perturb.drop(xml, [mtText(qRows0[2]["ID постачальника"])]);
  // QA: чотири товари зі зміненими назвами постачальника.
  const mainRows = readSheet(book[SHEET.main], SHEET.main).rows;
  const renamed = mainRows.slice(10, 14).map((r) => ({ offerId: mtText(r["Offer ID"]), sid: mtText(r["ID постачальника"]) }));
  for (const r of renamed) xml = perturb.tag(xml, r.sid, "name_ua", "Нова назва постачальника " + r.sid);
  const sheets = new MemorySheets(book);
  return { sheets, readBook: async () => sheets.read(), store: new MemoryStore(), xml, renamed, absentId: mtText(absent[0]), queueIds: qRows0.map((r) => mtText(r["Offer ID"])) };
}
const headersOf = (w) => Object.fromEntries(Object.entries(w.sheets.book).map(([k, v]) => [k, (v[0] || []).slice()]));
const guarded = (w, mode) => WT.guardedSheets(w.sheets, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES[mode], headers: headersOf(w) });
const qa = (w, min) => updateProducts({ sheets: guarded(w, "update"), readBook: w.readBook, xml: dated(w.xml, min), source: FILTERED_URL, fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config: cfg(), catalog, controls: okCc(), snapshotStore: w.store });
const main = (w) => readSheet(w.sheets.book[SHEET.main], SHEET.main).rows;
const queue = (w) => readSheet(w.sheets.book[SHEET.queue], SHEET.queue).rows;
const byId = (rows, id) => rows.find((r) => mtText(r["Offer ID"]) === id);
const val = (k, x) => (k === "Знижка" ? String(run.sheetDiscount(x)) : mtText(x));

test("ENG-28b послідовність (робочий режим, справжня схема): QA п'яти товарів без перебудови характеристик; 5 029-аналог — характеристики побайтово; перенесення з характеристиками, описами, SEO; наступне оновлення нічого не перебудовує", async () => {
  const w = world();
  const main0 = main(w), q0 = queue(w);
  const chars0 = new Map(main0.map((r) => [mtText(r["Offer ID"]), mtText(r["Характеристики JSON"])]));
  const seo0 = new Map(main0.map((r) => [mtText(r["Offer ID"]), Object.fromEntries(SEO.map((k) => [k, mtText(r[k])]))]));
  // 1. Структура. 2. CC — двійник. 3. Виправлення.
  assert.equal((await steps.migrateQueueForTransfer({ sheets: guarded(w, "structure"), readBook: w.readBook, stamp: at(0) })).state, "MIGRATED");
  const plan = steps.planOwnerCorrection(w.sheets.book[SHEET.main]);
  assert.equal((await steps.applyOwnerCorrection({ sheets: guarded(w, "correction"), readBook: w.readBook, stamp: at(1), expected: plan })).state, "CORRECTED");
  const fixed = { ...byId(main(w), FIX) };
  // 4. QA — штатне «Оновити товари».
  const r = await qa(w, 3);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 500));
  assert.equal(r.report.supplierChanges.characteristics, "preserve");
  assert.equal(r.report.supplierChanges.characteristicsChanged, 0);
  for (const row of main(w)) assert.equal(mtText(row["Характеристики JSON"]), chars0.get(mtText(row["Offer ID"])), "характеристики не змінено: " + mtText(row["Offer ID"]));
  assert.deepEqual(main(w).filter((x) => rowSeal(x) !== mtText(x[SEAL_COLUMN])).map((x) => mtText(x["Offer ID"])), [], "печатки узгоджено штатно");
  for (const t of w.renamed) {
    const row = byId(main(w), t.offerId);
    assert.equal(mtText(row["Назва постачальника UA"]), "Нова назва постачальника " + t.sid, "назву постачальника прийнято");
    for (const k of SEO) assert.equal(mtText(row[k]), seo0.get(t.offerId)[k], `${t.offerId}: «${k}» не змінено`);
  }
  for (const k of ["Опис UA", "Опис RU", "Запити UA", "Запити RU"]) assert.equal(mtText(byId(main(w), FIX)[k]), mtText(fixed[k]), "виправлення 1561514532 збережено");
  // 5. Перенесення 8 (аналог 92).
  const t5 = await run.transferNew92({ sheets: guarded(w, "merge"), readBook: w.readBook, stamp: at(5), snapshotDate: "2026-10-29T18:20:40.743Z", expectCount: w.queueIds.length });
  assert.equal(t5.state, "TRANSFERRED", JSON.stringify(t5).slice(0, 500));
  const m5 = main(w), ids5 = m5.map((x) => mtText(x["Offer ID"]));
  assert.equal(m5.length, main0.length + q0.length);
  assert.equal(new Set(ids5).size, ids5.length, "нуль дублів");
  for (const id of w.queueIds) {
    const a = byId(q0, id), b = byId(m5, id);
    for (const k of YML_HEADERS.filter((k) => !["Стан синхронізації", "Наявність"].includes(k))) assert.equal(val(k, b[k]), val(k, a[k]), `${id}: «${k}» перенесено байт-у-байт`);
  }
  assert.equal(mtText(byId(m5, w.absentId)[P.PRESENCE_COLUMN]), P.PRESENCE.ABSENT_IN_SNAPSHOT);
  assert.match(JSON.parse(byId(m5, w.absentId)[P.PRESENCE_META_COLUMN]).note, /Відсутній у знімку YML постачальника від 2026-10-29T18:20:40\.743Z/);
  // 6. Наступне «Оновити товари»: нічого не перебудовано, перенесені — з їхніми характеристиками.
  const chars5 = new Map(m5.map((x) => [mtText(x["Offer ID"]), mtText(x["Характеристики JSON"])]));
  const r6 = await qa(w, 6);
  assert.ok(["SYNCED", "NO_CHANGES"].includes(r6.state), JSON.stringify(r6).slice(0, 400));
  for (const row of main(w)) assert.equal(mtText(row["Характеристики JSON"]), chars5.get(mtText(row["Offer ID"])));
  assert.equal(mtText(byId(main(w), w.absentId)[P.PRESENCE_COLUMN]), P.PRESENCE.ABSENT_IN_SNAPSHOT, "поза охопленням — позначка збережена, не «видалений»");
  assert.equal((await run.transferNew92({ sheets: guarded(w, "merge"), readBook: w.readBook, stamp: at(7), snapshotDate: "2026-10-29T18:20:40.743Z", expectCount: w.queueIds.length })).state, "NOTHING", "повтор — без дублів");
  // Після синхронізації позначки черги — «ПЕРЕНЕСЕНО: товар уже в…» (N4 / B6): повтор структури — теж NOTHING, без записів.
  const mark = w.sheets.log.length;
  assert.equal((await steps.migrateQueueForTransfer({ sheets: guarded(w, "structure"), readBook: w.readBook, stamp: at(8) })).state, "NOTHING");
  assert.equal(w.sheets.log.length, mark);
});
