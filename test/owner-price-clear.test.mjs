/** Рішення власника 16.11.2026 (реєстр № 63; замінює правило 15.11): «Ціна власника» — ПОСТІЙНА (не очищується; постачальник змінив
 *  РРЦ — рядок у «Попередження постачальника»); «Ціна вручну» — поки РРЦ та сама: нова — «Ціни» записують якір (поточна РРЦ), РРЦ
 *  змінилась — «Ціни» очищують ціну й якір. Обидві — як нова РРЦ (+5). Синтетика, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet, LIVE_COLUMNS, MATCH } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { mtPrices, OWNER_PRICE_COLUMN as OWNP, MANUAL_PRICE_COLUMN as MAN, MANUAL_ANCHOR_COLUMN as ANC } from "../src/core/pricing.mjs";
import { OWNER_AVAILABILITY_COLUMN as OWN } from "../src/core/owner-availability.mjs";
import { updatePrices } from "../src/pipeline/prices-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import * as WT from "../src/pipeline/safe-write/write-target.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { PRESENCE_COLUMN } from "../src/core/supplier-presence.mjs";
import { WARN_SHEET, WARN_HEADER, pendingActions } from "../src/pipeline/supplier-warnings.mjs";
import { ownerSummary } from "../src/pipeline/ops-summary.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const NOW = Date.parse("2026-11-16T08:00:00Z");
const MAIN = "Основний каталог", JOURNAL = "Журнал";
const cfg = () => { const c = productionConfig(structuredClone(baseConfig)); c.supplier.minimumOffers = 10; return c; };
const okCc = () => Object.freeze({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp-", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
const dated = (xml, min = 0) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 2 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });

function world() {
  const s = generateSynthetic({ products: 60, queue: 0, deferred: 0, newOffers: 0, seed: 43, now: NOW });
  const head = s.sheets[MAIN][0];
  const extra = [PRESENCE_COLUMN, OWN, OWNP, MAN, ANC].filter((c) => !head.includes(c));
  const mainValues = s.sheets[MAIN].map((r, i) => [...r, ...extra.map((c) => (i === 0 ? c : ""))]);
  const book = { [MAIN]: mainValues, "Групи": s.groups, [JOURNAL]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]], [WARN_SHEET]: [WARN_HEADER.slice()] };
  const w = { s, sheets: new MemorySheets(book), w2: new MemoryStore(), xml: s.supplierXml() };
  w.readBook = async (names) => { const b = await w.sheets.read(); return names ? Object.fromEntries(names.filter((n) => b[n]).map((n) => [n, b[n]])) : b; };
  return w;
}
const rows = (w) => readSheet(w.sheets.book[MAIN], MAIN).rows;
const headers = (w) => Object.fromEntries(Object.entries(w.sheets.book).map(([k, v]) => [k, (v[0] || []).slice()]));
async function prices(w, min) {
  const sheets = WT.guardedSheets(w.sheets, { spreadsheetId: WT.TEST_SHEET_ID, policy: WT.MODE_POLICIES.prices, headers: headers(w) });
  const session = await new WriteGateway({ sheets, read: w.readBook, store: w.w2 }).open({ writer: "sync" });
  const stamp = new Date(NOW + min * 60_000).toISOString();
  try { return await updatePrices({ readBook: w.readBook, xml: dated(w.xml, min), stamp, now: NOW + min * 60_000, config: cfg(), controls: okCc(), session, snapshotStore: w.w2 }); }
  finally { await session.close(); }
}
function setCell(w, id, col, value) {
  const v = w.sheets.book[MAIN], h = v[0], r = v.findIndex((x, i) => i > 0 && mtText(x[h.indexOf("Offer ID")]) === id);
  v[r][h.indexOf(col)] = value;
}
const rowOf = (w, id) => rows(w).find((r) => mtText(r["Offer ID"]) === id);
/** Ціна товару у фіді постачальника (синтетичний XML). */
function supplierPrice(w, sid, price) {
  const re = new RegExp(`(<offer id="${sid}"[^>]*>[\\s\\S]*?<price>)([^<]*)(</price>)`);
  assert.ok(re.test(w.xml), "немає оферти " + sid);
  w.xml = w.xml.replace(re, `$1${price}$3`);
}
const sale = (cost) => mtPrices(cost, true, cfg().pricing).final;
const warnRows = (w) => w.sheets.book[WARN_SHEET].slice(1);

test("№ 63: «Ціна власника» постійна — діє (як РРЦ, +5); постачальник змінив РРЦ — клітинка лишається, ціна власника діє, рядок у «Попередження постачальника» (один раз)", async () => {
  const w = world();
  const r0 = await prices(w, 0);
  assert.ok(["PRICES_UPDATED", "NO_CHANGES"].includes(r0.state), JSON.stringify(r0).slice(0, 300));
  const A = rows(w).find((r) => r["Стан синхронізації"] === MATCH.OK && r["Наявність"] === "+"), a = mtText(A["Offer ID"]);
  const pa = Number(A["Ціна постачальника"]);
  const outside = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !LIVE_COLUMNS.includes(k) && ![OWNP, MAN, ANC].includes(k)));
  const before = Object.fromEntries(rows(w).map((r) => [mtText(r["Offer ID"]), outside(r)]));

  setCell(w, a, OWNP, String(pa + 1000));
  const r1 = await prices(w, 1);
  assert.equal(r1.state, "PRICES_UPDATED", JSON.stringify(r1).slice(0, 300));
  assert.equal(Number(rowOf(w, a)["Ціна кінцева"]), sale(pa + 1000));
  assert.equal(Number(rowOf(w, a)["Ціна постачальника"]), pa, "РРЦ — постачальника");
  assert.equal(r1.stats.ownerPrice.active, 1);
  assert.match(ownerSummary("prices", { result: r1 }), /«Ціна власника» \(постійна\): діє 1/);
  assert.equal((await prices(w, 2)).state, "NO_CHANGES", "стабільно, поки РРЦ та сама");

  supplierPrice(w, A["ID постачальника"], pa + 300);
  const r3 = await prices(w, 3);
  assert.equal(r3.state, "PRICES_UPDATED", JSON.stringify(r3).slice(0, 300));
  assert.equal(rowOf(w, a)[OWNP], String(pa + 1000), "«Ціна власника» не очищується");
  assert.equal(Number(rowOf(w, a)["Ціна постачальника"]), pa + 300);
  assert.equal(Number(rowOf(w, a)["Ціна кінцева"]), sale(pa + 1000), "далі діє ціна власника");
  assert.equal(r3.stats.ownerPrice.rrpChanged, 1);
  assert.equal(r3.stats.ownerWarnings?.appended, 1, JSON.stringify(r3.stats.ownerWarnings));
  const h = WARN_HEADER;
  const wr = warnRows(w);
  assert.equal(wr.length, 1);
  assert.equal(wr[0][h.indexOf("Ключ")], `rrp-owner:${a}:${pa + 300}`);
  assert.equal(wr[0][h.indexOf("Поле")], "РРЦ (діє «Ціна власника»)");
  assert.equal(String(wr[0][h.indexOf("Було (постачальник)")]), String(pa));
  assert.equal(String(wr[0][h.indexOf("Стало (постачальник)")]), String(pa + 300));
  assert.match(ownerSummary("prices", { result: r3 }), /постачальник змінив РРЦ у 1/);
  // Власник обрав «Прийняти значення постачальника» — система цей рядок не «виконує» (лише інформація; ціну власник змінює в каталозі).
  const book = structuredClone(w.sheets.book[WARN_SHEET]);
  book[1][h.indexOf("Дія власника")] = "Прийняти значення постачальника";
  assert.deepEqual(pendingActions(book), []);
  assert.equal((await prices(w, 4)).state, "NO_CHANGES");
  assert.equal(warnRows(w).length, 1, "повтор — без дублікатів");
  for (const r of rows(w)) assert.deepEqual(outside(r), before[mtText(r["Offer ID"])], mtText(r["Offer ID"]));
});

test("№ 63: «Ціна вручну» — нова: «Ціни» записують якір (поточна РРЦ) і ціну від неї (+5); РРЦ змінилась — очищують ціну й якір; події в «Журналі»", async () => {
  const w = world();
  await prices(w, 0);
  const B = rows(w).find((r) => r["Стан синхронізації"] === MATCH.OK && r["Наявність"] === "+"), b = mtText(B["Offer ID"]);
  const pb = Number(B["Ціна постачальника"]);
  setCell(w, b, MAN, String(pb + 200));
  const r1 = await prices(w, 1);
  assert.equal(r1.state, "PRICES_UPDATED", JSON.stringify(r1).slice(0, 300));
  assert.equal(Number(rowOf(w, b)[ANC]), pb, "якір = РРЦ на момент запису");
  assert.equal(Number(rowOf(w, b)["Ціна кінцева"]), sale(pb + 200));
  assert.deepEqual(r1.stats.manualPrice, { active: 1, anchored: 1, cleared: 0 });
  assert.match(ownerSummary("prices", { result: r1 }), /«Ціна вручну» \(поки РРЦ та сама\): діє 1; нових 1/);
  assert.ok(w.sheets.book[JOURNAL].some((e) => e[2] === b && e[3] === ANC && String(e[5]) === String(pb)), "подія якоря");
  assert.equal((await prices(w, 2)).state, "NO_CHANGES");

  supplierPrice(w, B["ID постачальника"], pb + 50);
  const r3 = await prices(w, 3);
  assert.equal(r3.state, "PRICES_UPDATED");
  assert.equal(rowOf(w, b)[MAN], "");
  assert.equal(rowOf(w, b)[ANC], "");
  assert.equal(Number(rowOf(w, b)["Ціна кінцева"]), sale(pb + 50), "далі стандартна ціна від нової РРЦ");
  assert.equal(r3.stats.manualPrice.cleared, 1);
  for (const k of [MAN, ANC]) assert.ok(w.sheets.book[JOURNAL].some((e) => e[2] === b && e[3] === k && e[5] === ""), "подія зняття: " + k);
  assert.equal((await prices(w, 4)).state, "NO_CHANGES");
});

test("№ 63: власник змінив «Ціну вручну» між читанням і записом — зняття не пишеться (правка людини має пріоритет)", async () => {
  const w = world();
  await prices(w, 0);
  const A = rows(w).find((r) => r["Стан синхронізації"] === MATCH.OK && r["Наявність"] === "+"), a = mtText(A["Offer ID"]);
  const pa = Number(A["Ціна постачальника"]);
  setCell(w, a, MAN, String(pa + 500));
  await prices(w, 1);
  assert.equal(Number(rowOf(w, a)[ANC]), pa);
  supplierPrice(w, A["ID постачальника"], pa + 200);
  const orig = w.readBook;
  let first = true;
  w.readBook = async (names) => { const b = await orig(names); if (first && names?.includes(MAIN)) { first = false; } else if (names?.includes(MAIN)) setCell(w, a, MAN, String(pa + 900)); return orig(names); };
  await prices(w, 2);
  w.readBook = orig;
  assert.equal(rowOf(w, a)[MAN], String(pa + 900), "нова правка власника не стерта");
});

test("15.11 / № 63: owner-edits може записати «Ціну власника» від імені власника — лише додатне число або порожньо (зняти)", async () => {
  const { planProblems, OWNER_EDIT_TARGETS } = await import("../src/pipeline/owner-edits.mjs");
  assert.ok(OWNER_EDIT_TARGETS["Основний каталог"].columns.includes(OWNP));
  const e = (set, expect = "") => [{ sheet: MAIN, key: "1", column: OWNP, expect, set, source: "рішення власника 16.11 (тест)" }];
  assert.deepEqual(planProblems(e("9699")), []);
  assert.deepEqual(planProblems(e("9 699,50")), []);
  assert.deepEqual(planProblems(e("", "9699")), [], "зняти ціну власника");
  assert.match(planProblems(e("дорого")).join(" "), /не додатне число/);
  assert.match(planProblems(e("0")).join(" "), /не додатне число/);
});
