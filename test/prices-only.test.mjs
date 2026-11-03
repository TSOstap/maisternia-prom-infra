/** ENG-29 — «Оновити ціни й наявність» (рішення власника 03.11.2026): лише 8 колонок LIVE змінених рядків «Основного каталогу»
 *  з операційного фіду, за ключем через шлюз W2, + «Журнал». Синтетика, таблиця в пам'яті, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet, LIVE_COLUMNS } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { planPrices } from "../src/core/prices-only.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { updatePrices } from "../src/pipeline/prices-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import * as WT from "../src/pipeline/safe-write/write-target.mjs";
import { RUN_PLAN_KEY } from "../src/pipeline/run-plan.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { PRESENCE_COLUMN } from "../src/core/supplier-presence.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const NOW = Date.parse("2026-11-03T08:00:00Z");
const MAIN = "Основний каталог", JOURNAL = "Журнал";
const cfg = (f) => { const c = productionConfig(structuredClone(baseConfig)); c.supplier.minimumOffers = 10; f?.(c); return c; };
const okCc = (removed = []) => Object.freeze({ held: new Set(), removed: new Set(removed), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp-", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
const dated = (xml, min = 0) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 2 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });

function world() {
  const s = generateSynthetic({ products: 60, queue: 0, deferred: 0, newOffers: 0, seed: 41, now: NOW });
  // Колонка присутності (як у TEST після ENG-28): порожньо — товар у постачальника є.
  const mainValues = s.sheets["Основний каталог"].map((r, i) => [...r, i === 0 ? PRESENCE_COLUMN : ""]);
  const book = { [MAIN]: mainValues, "Групи": s.groups, [JOURNAL]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const w = { s, sheets: new MemorySheets(book), w2: new MemoryStore(), xml: dated(s.supplierXml()) };
  w.readBook = async (names) => { const b = await w.sheets.read(); return names ? Object.fromEntries(names.filter((n) => b[n]).map((n) => [n, b[n]])) : b; };
  return w;
}
const rows = (w) => readSheet(w.sheets.book[MAIN], MAIN).rows;
const headers = (w) => Object.fromEntries(Object.entries(w.sheets.book).map(([k, v]) => [k, (v[0] || []).slice()]));
async function prices(w, min, o = {}) {
  const sheets = WT.guardedSheets(w.sheets, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES.prices, headers: headers(w) });
  const session = await new WriteGateway({ sheets, read: o.readBook || w.readBook, store: w.w2 }).open({ writer: "sync" });
  const stamp = new Date(NOW + min * 60_000).toISOString();
  try { return await updatePrices({ readBook: o.readBook || w.readBook, xml: o.xml || w.xml, stamp, now: NOW + min * 60_000, config: o.config || cfg(), controls: o.controls || okCc(), session, snapshotStore: w.w2, readColumns: o.narrow ? sparse(w) : null }); }
  finally { await session.close(); }
}
/** Вузьке читання, як GoogleSheetsCatalogSource.loadColumns: заголовок повністю, у рядках — лише вибрані колонки. */
const sparse = (w) => async (title, cols) => {
  const v = (await w.sheets.read())[title];
  if (!v) return null;
  const keep = new Set(cols.map((c) => v[0].indexOf(c)).filter((i) => i >= 0));
  return [v[0].slice(), ...v.slice(1).map((r) => v[0].map((_, j) => (keep.has(j) ? r[j] ?? "" : "")))];
};
const nonLive = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !LIVE_COLUMNS.includes(k)));

for (const narrow of [false, true]) test(`«Ціни й наявність»${narrow ? " (вузьке читання колонок)" : ""}: лише змінені рядки й лише 8 колонок LIVE; назви / артикул змінені, відсутні, видалені (CC), «видалений у постачальника» — не чіпаються; «Журнал» — події з ID; повтор — без змін`, async () => {
  const w = world();
  const P = (ww, min, o = {}) => prices(ww, min, { ...o, narrow });
  // Вирівнювання: перший запуск приводить ціни до чинних правил (синтетика може відрізнятись).
  const r0 = await P(w, 0);
  assert.ok(["PRICES_UPDATED", "NO_CHANGES"].includes(r0.state), JSON.stringify(r0).slice(0, 400));
  assert.equal((await P(w, 1)).state, "NO_CHANGES");

  const before = rows(w);
  const sid = (i) => mtText(before[i]["ID постачальника"]);
  const oid = (i) => mtText(before[i]["Offer ID"]);
  const parsedPrice = (i) => Number(before[i]["Ціна постачальника"]);
  let xml = perturb.tag(w.xml, sid(1), "price", String(parsedPrice(1) + 100));                 // A: ціна
  xml = xml.replace(new RegExp(`(<offer\\b[^>]*\\bid="${sid(2)}"[^>]*\\bavailable=")(true|false)`), (_, p, v) => p + (v === "true" ? "false" : "true")); // B: наявність
  xml = perturb.tag(xml, sid(3), "name_ua", "Зовсім інша назва " + sid(3));                     // C: змінились дані постачальника
  xml = perturb.tag(xml, sid(3), "price", String(parsedPrice(3) + 50));
  xml = perturb.drop(xml, [sid(4)]);                                                            // D: немає у фіді
  xml = perturb.tag(xml, sid(5), "price", String(parsedPrice(5) + 70));                         // E: видалено (CC)
  xml = perturb.tag(xml, sid(6), "price", String(parsedPrice(6) + 90));                         // F: «видалений у постачальника»
  const h = w.sheets.book[MAIN][0].map(mtText);
  w.sheets.book[MAIN][7][h.indexOf(PRESENCE_COLUMN)] = "ВИДАЛЕНИЙ_У_ПОСТАЧАЛЬНИКА";
  before[6][PRESENCE_COLUMN] = "ВИДАЛЕНИЙ_У_ПОСТАЧАЛЬНИКА";

  const plan = planPrices({ values: w.sheets.book[MAIN], offers: (await parseSupplierText(xml, { maximumChars: 1e8, identityFields: true })).offers, stamp: "s", pricing: cfg().pricing, removed: new Set([oid(5)]) });
  assert.deepEqual(plan.changed.map((i) => oid(i)).sort(), [oid(1), oid(2)].sort());
  assert.equal(plan.stats.skipped.removed, 1); assert.equal(plan.stats.skipped.missing, 1);
  assert.equal(Object.values(plan.stats.skipped.mismatch).reduce((a, b) => a + b, 0), 1);
  assert.equal(plan.stats.skipped.gone, 1);

  const r = await P(w, 10, { xml: dated(xml, 10), controls: okCc([oid(5)]) });
  assert.equal(r.state, "PRICES_UPDATED", JSON.stringify(r).slice(0, 500));
  assert.equal(r.stats.written, 2); assert.equal(r.stats.supplierPriceChanged, 1); assert.equal(r.stats.availabilityChanged, 1);
  const after = rows(w);
  for (let i = 0; i < before.length; i++) {
    assert.deepEqual(nonLive(after[i]), nonLive(before[i]), "інші колонки без змін: " + oid(i));
    if (![1, 2].includes(i)) assert.deepEqual(LIVE_COLUMNS.map((k) => mtText(after[i][k])), LIVE_COLUMNS.map((k) => mtText(before[i][k])), "рядок не змінено: " + oid(i));
  }
  assert.equal(Number(after[1]["Ціна постачальника"]), parsedPrice(1) + 100);
  assert.notEqual(mtText(after[1]["Оновлено"]), mtText(before[1]["Оновлено"]));
  assert.notEqual(mtText(after[2]["Наявність"]), mtText(before[2]["Наявність"]));
  // «Журнал»: лише зміни F:K записаних рядків, з «ID події»; план запуску закрито.
  const jh = w.sheets.book[JOURNAL][0].map(mtText);
  assert.ok(jh.includes("ID події"));
  const run10 = "prices:" + new Date(NOW + 10 * 60_000).toISOString();
  const ev = w.sheets.book[JOURNAL].slice(1).filter((e) => String(e[jh.indexOf("ID події")] || "").startsWith(run10));
  assert.ok(ev.length >= 2);
  assert.deepEqual([...new Set(ev.map((e) => mtText(e[2])))].sort(), [oid(1), oid(2)].sort());
  assert.equal((await w.w2.getJsonVersioned(RUN_PLAN_KEY)).value.status, "DONE");
  // Повтор тим самим фідом — нічого.
  assert.equal((await P(w, 11, { xml: dated(xml, 11), controls: okCc([oid(5)]) })).state, "NO_CHANGES");
  assert.equal(r.stats.skipped.gone, 1);
});

test("«Ціни й наявність»: масова зміна наявності → нічого не записано; Catalog Controls недоступний → BLOCKED; правка людини між читанням і записом → цей рядок не пишеться", async () => {
  const w = world();
  await prices(w, 0);
  const snap = JSON.stringify(w.sheets.book);
  // Масова зміна: робочий поріг — більший із 50 товарів і 2 % каталогу; у синтетиці (60 товарів) — поріг 5 для перевірки механізму.
  const allOff = w.xml.replace(/(<offer\b[^>]*\bavailable=")true"/g, '$1false"');
  const m = await prices(w, 5, { xml: dated(allOff, 5), config: cfg((c) => { c.policy.anomaly = { maxNewlyMissing: 5, maxNewlyMissingRatio: 0.02 }; }) });
  assert.equal(m.state, "ABORTED"); assert.match(m.reason, /МАСОВА|наявності/);
  assert.equal(JSON.stringify(w.sheets.book), snap, "нічого не записано");
  const b = await prices(w, 6, { controls: Object.freeze({ ...okCc(), blocked: true, reasons: ["тест"] }) });
  assert.equal(b.state, "BLOCKED");
  assert.equal(JSON.stringify(w.sheets.book), snap);

  // Правка людини: після планування, до запису — інша «Ціна» в рядку A.
  const before = rows(w);
  const sid = (i) => mtText(before[i]["ID постачальника"]);
  let xml = perturb.tag(w.xml, sid(1), "price", String(Number(before[1]["Ціна постачальника"]) + 100));
  xml = perturb.tag(xml, sid(2), "price", String(Number(before[2]["Ціна постачальника"]) + 100));
  let mainReads = 0;
  const readBook = async (names) => {
    if (names?.includes(MAIN) && ++mainReads === 2) { const h = w.sheets.book[MAIN][0].map(mtText); w.sheets.book[MAIN][2][h.indexOf("Ціна постачальника")] = 12345; }
    return w.readBook(names);
  };
  const r = await prices(w, 10, { xml: dated(xml, 10), readBook });
  assert.equal(r.state, "PARTIAL", JSON.stringify(r).slice(0, 400));
  assert.deepEqual(r.notWritten.map((x) => x.offerId), [mtText(before[1]["Offer ID"])]);
  assert.equal(Number(rows(w)[1]["Ціна постачальника"]), 12345, "правку людини не перезаписано");
  assert.equal(Number(rows(w)[2]["Ціна постачальника"]), Number(before[2]["Ціна постачальника"]) + 100);
});

test("«Ціни й наявність» (вузьке читання колонок): правка людини між читанням і записом → цей рядок не пишеться; «Журнал» дописано лише для записаного", async () => {
  const w = world();
  await prices(w, 0, { narrow: true });
  const before = rows(w);
  const sid = (i) => mtText(before[i]["ID постачальника"]);
  let xml = perturb.tag(w.xml, sid(1), "price", String(Number(before[1]["Ціна постачальника"]) + 100));
  xml = perturb.tag(xml, sid(2), "price", String(Number(before[2]["Ціна постачальника"]) + 100));
  const base = sparse(w);
  let mainReads = 0;
  const readColumns = async (title, cols) => {
    if (title === MAIN && ++mainReads === 2) { const h = w.sheets.book[MAIN][0].map(mtText); w.sheets.book[MAIN][2][h.indexOf("Ціна постачальника")] = 12345; }
    return base(title, cols);
  };
  const sheets = WT.guardedSheets(w.sheets, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES.prices, headers: headers(w) });
  const session = await new WriteGateway({ sheets, read: w.readBook, store: w.w2 }).open({ writer: "sync" });
  const stamp = new Date(NOW + 10 * 60_000).toISOString();
  let r;
  try { r = await updatePrices({ readBook: w.readBook, xml: dated(xml, 10), stamp, now: NOW + 10 * 60_000, config: cfg(), controls: okCc(), session, snapshotStore: w.w2, readColumns }); }
  finally { await session.close(); }
  assert.equal(r.state, "PARTIAL", JSON.stringify(r).slice(0, 400));
  assert.equal(Number(rows(w)[1]["Ціна постачальника"]), 12345, "правку людини не перезаписано");
  assert.equal(Number(rows(w)[2]["Ціна постачальника"]), Number(before[2]["Ціна постачальника"]) + 100);
  const jh = w.sheets.book[JOURNAL][0].map(mtText);
  const ev = w.sheets.book[JOURNAL].slice(1).filter((e) => String(e[jh.indexOf("ID події")] || "").startsWith("prices:" + stamp));
  assert.deepEqual([...new Set(ev.map((e) => mtText(e[2])))], [mtText(before[2]["Offer ID"])]);
});
