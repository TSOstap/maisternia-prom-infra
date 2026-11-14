/** Рішення власника 14.11.2026: «Наявність власника» діє, поки постачальник не змінить свою наявність; далі — знову постачальник
 *  («Оновити ціни й наявність» очищує клітинку власника). Синтетика, таблиця в пам'яті, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet, planRows, LIVE_COLUMNS, MATCH } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { ownerAvailabilityValue, effectiveAvailability, OWNER_AVAILABILITY_COLUMN as OWN } from "../src/core/owner-availability.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { updatePrices } from "../src/pipeline/prices-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import * as WT from "../src/pipeline/safe-write/write-target.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { PRESENCE_COLUMN } from "../src/core/supplier-presence.mjs";
import { ownerSummary } from "../src/pipeline/ops-summary.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const NOW = Date.parse("2026-11-14T08:00:00Z");
const MAIN = "Основний каталог", JOURNAL = "Журнал";
const cfg = () => { const c = productionConfig(structuredClone(baseConfig)); c.supplier.minimumOffers = 10; return c; };
const okCc = () => Object.freeze({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp-", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
const dated = (xml, min = 0) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 2 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });

function world() {
  const s = generateSynthetic({ products: 60, queue: 0, deferred: 0, newOffers: 0, seed: 41, now: NOW });
  const mainValues = s.sheets[MAIN].map((r, i) => [...r, i === 0 ? PRESENCE_COLUMN : "", i === 0 ? OWN : ""]);
  const book = { [MAIN]: mainValues, "Групи": s.groups, [JOURNAL]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const w = { s, sheets: new MemorySheets(book), w2: new MemoryStore(), xml: s.supplierXml() };
  w.readBook = async (names) => { const b = await w.sheets.read(); return names ? Object.fromEntries(names.filter((n) => b[n]).map((n) => [n, b[n]])) : b; };
  return w;
}
const rows = (w) => readSheet(w.sheets.book[MAIN], MAIN).rows;
const headers = (w) => Object.fromEntries(Object.entries(w.sheets.book).map(([k, v]) => [k, (v[0] || []).slice()]));
const sparse = (w) => async (title, cols) => {
  const v = (await w.sheets.read())[title];
  if (!v) return null;
  const keep = new Set(cols.map((c) => v[0].indexOf(c)).filter((i) => i >= 0));
  return [v[0].slice(), ...v.slice(1).map((r) => v[0].map((_, j) => (keep.has(j) ? r[j] ?? "" : "")))];
};
async function prices(w, min, narrow) {
  const sheets = WT.guardedSheets(w.sheets, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES.prices, headers: headers(w) });
  const session = await new WriteGateway({ sheets, read: w.readBook, store: w.w2 }).open({ writer: "sync" });
  const stamp = new Date(NOW + min * 60_000).toISOString();
  try { return await updatePrices({ readBook: w.readBook, xml: dated(w.xml, min), stamp, now: NOW + min * 60_000, config: cfg(), controls: okCc(), session, snapshotStore: w.w2, readColumns: narrow ? sparse(w) : null }); }
  finally { await session.close(); }
}
/** Клітинка «Основного каталогу» за Offer ID (лише в тесті — пряма правка «людиною»). */
function setCell(w, id, col, value) {
  const v = w.sheets.book[MAIN], h = v[0], r = v.findIndex((x, i) => i > 0 && mtText(x[h.indexOf("Offer ID")]) === id);
  v[r][h.indexOf(col)] = value;
}
const rowOf = (w, id) => rows(w).find((r) => mtText(r["Offer ID"]) === id);
const supplierAvail = (w, sid, on) => { w.xml = w.xml.replace(new RegExp(`(<offer id="${sid}" available=")(true|false)(")`), `$1${on}$3`); };

test("«Наявність власника»: розпізнавання значень і правило «поки постачальник не змінить»", () => {
  const v = (x) => ownerAvailabilityValue({ [OWN]: x });
  assert.equal(v(""), null); assert.equal(v("  "), null);
  for (const x of ["+", "так", "Є", "в наявності"]) assert.equal(v(x), true, x);
  for (const x of ["-", "−", "–", "ні", "Немає", "немає в наявності"]) assert.equal(v(x), false, x);
  assert.equal(v("може"), undefined); assert.equal(v("0"), undefined);
  assert.deepEqual(effectiveAvailability({}, true), { available: true, rule: "none", clear: false });
  assert.deepEqual(effectiveAvailability({ [OWN]: "-" }, true), { available: false, rule: "owner", clear: false });
  assert.deepEqual(effectiveAvailability({ [OWN]: "+" }, false), { available: true, rule: "owner", clear: false });
  assert.deepEqual(effectiveAvailability({ [OWN]: "-" }, false), { available: false, rule: "caught-up", clear: true });
  assert.deepEqual(effectiveAvailability({ [OWN]: "абв" }, true), { available: true, rule: "invalid", clear: false });
});

test("planRows: «−» власника при наявності у постачальника — «немає в наявності» і ціна як для відсутнього (без знижки)", async () => {
  const w = world();
  const parsed = await parseSupplierText(w.xml, { identityFields: true });
  const all = rows(w), plan0 = planRows(all, parsed.offers, "t0");
  const i = plan0.findIndex((p) => p.match === MATCH.OK && p.next[4] === "+");
  assert.ok(i >= 0);
  const row = { ...all[i], [OWN]: "-" };
  const [p] = planRows([row], parsed.offers, "t1");
  assert.equal(p.next[LIVE_COLUMNS.indexOf("Наявність")], "-");
  assert.equal(p.next[LIVE_COLUMNS.indexOf("Знижка")], "");
  // Форма результату planRows не змінилась (паритет з LIVE mtPlan)
  assert.deepEqual(Object.keys(p).sort(), ["before", "id", "match", "next"]);
  // Без «Наявності власника» — як раніше (наявність постачальника)
  const [q] = planRows([all[i]], parsed.offers, "t2");
  assert.equal(q.next[LIVE_COLUMNS.indexOf("Наявність")], "+");
});

for (const narrow of [false, true]) test(`«Ціни»${narrow ? " (вузьке читання)" : ""}: наявність власника діє, а коли постачальник оновив — клітинка очищується і далі веде постачальник`, async () => {
  const w = world();
  const r0 = await prices(w, 0, narrow);
  assert.ok(["PRICES_UPDATED", "NO_CHANGES"].includes(r0.state), JSON.stringify(r0).slice(0, 300));
  const okRows = rows(w).filter((r) => r["Стан синхронізації"] === MATCH.OK);
  const A = okRows.find((r) => r["Наявність"] === "+"), B = okRows.find((r) => r["Наявність"] === "-");
  assert.ok(A && B, "потрібні товари в наявності і без");
  const a = mtText(A["Offer ID"]), b = mtText(B["Offer ID"]);
  const C = okRows.find((r) => r["Наявність"] === "+" && r !== A), c = mtText(C["Offer ID"]);
  const nonOwn = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !LIVE_COLUMNS.includes(k) && k !== OWN));
  const before = Object.fromEntries(rows(w).map((r) => [mtText(r["Offer ID"]), nonOwn(r)]));

  // 1) власник знає раніше: A «−» (у фіді ще є), B «+» (у фіді ще немає), C — нерозпізнаний текст
  setCell(w, a, OWN, "-"); setCell(w, b, OWN, "+"); setCell(w, c, OWN, "може");
  const r1 = await prices(w, 1, narrow);
  assert.equal(r1.state, "PRICES_UPDATED", JSON.stringify(r1).slice(0, 300));
  assert.equal(rowOf(w, a)["Наявність"], "-"); assert.equal(rowOf(w, a)["Знижка"], "");
  assert.equal(rowOf(w, b)["Наявність"], "+");
  assert.equal(rowOf(w, c)["Наявність"], "+");
  assert.equal(rowOf(w, a)[OWN], "-"); assert.equal(rowOf(w, b)[OWN], "+"); assert.equal(rowOf(w, c)[OWN], "може");
  assert.deepEqual(r1.stats.ownerAvailability, { active: 2, cleared: 0 });
  assert.match(ownerSummary("prices", { result: r1 }), /«Наявність власника»: діє 2/);
  assert.equal((await prices(w, 2, narrow)).state, "NO_CHANGES");

  // 2) постачальник оновив A (теж «немає») — клітинку власника очищено, наявність та сама; подія в «Журналі»
  supplierAvail(w, A["ID постачальника"], false);
  const r3 = await prices(w, 3, narrow);
  assert.equal(r3.state, "PRICES_UPDATED", JSON.stringify(r3).slice(0, 300));
  assert.equal(rowOf(w, a)[OWN], ""); assert.equal(rowOf(w, a)["Наявність"], "-");
  assert.equal(rowOf(w, b)[OWN], "+"); assert.equal(rowOf(w, c)[OWN], "може");
  assert.deepEqual(r3.stats.ownerAvailability, { active: 1, cleared: 1 });
  assert.ok(w.sheets.book[JOURNAL].some((e) => e[2] === a && e[3] === OWN && e[4] === "-" && e[5] === ""), "подія очищення в «Журналі»");
  assert.match(ownerSummary("prices", { result: r3 }), /знято 1/);

  // 3) товар A повернувся у постачальника — тепер наявність постачальника (стара позначка власника не ховає товар)
  supplierAvail(w, A["ID постачальника"], true);
  const r4 = await prices(w, 4, narrow);
  assert.equal(r4.state, "PRICES_UPDATED");
  assert.equal(rowOf(w, a)["Наявність"], "+"); assert.notEqual(rowOf(w, a)["Знижка"], "");

  // 4) B з'явився у постачальника — клітинку очищено, наявність «+» лишається
  supplierAvail(w, B["ID постачальника"], true);
  const r5 = await prices(w, 5, narrow);
  assert.equal(rowOf(w, b)[OWN], ""); assert.equal(rowOf(w, b)["Наявність"], "+");
  assert.deepEqual(r5.stats.ownerAvailability, { active: 0, cleared: 1 });

  // Поза LIVE і «Наявністю власника» нічого не змінено
  for (const r of rows(w)) assert.deepEqual(nonOwn(r), before[mtText(r["Offer ID"])], mtText(r["Offer ID"]));
});

test("«Ціни»: власник змінив клітинку між читанням і записом — очищення не пишеться (правка людини має пріоритет)", async () => {
  const w = world();
  await prices(w, 0, false);
  const A = rows(w).find((r) => r["Стан синхронізації"] === MATCH.OK && r["Наявність"] === "-"), a = mtText(A["Offer ID"]);
  setCell(w, a, OWN, "-"); // постачальник теж «−» → очищення
  const readBook = w.readBook;
  let first = true;
  w.readBook = async (names) => { const b = await readBook(names); if (first && names?.includes(MAIN)) { first = false; setCell(w, a, OWN, "так"); } return b; };
  const r = await prices(w, 1, false);
  w.readBook = readBook;
  assert.ok(["NOT_APPLIED", "PARTIAL", "PRICES_UPDATED"].includes(r.state), JSON.stringify(r).slice(0, 300));
  assert.equal(rowOf(w, a)[OWN], "так");
});
