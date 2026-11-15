/** Рішення власника 15.11.2026: «Ціна власника» діє, поки ціна у фіді постачальника не зміниться (або не стане такою самою),
 *  як «Наявність власника»: тоді «Оновити ціни й наявність» очищує клітинку, і далі ціна — з фіду. Синтетика, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet, LIVE_COLUMNS, MATCH } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { mtPrices, OWNER_PRICE_COLUMN as OWNP } from "../src/core/pricing.mjs";
import { ownerPriceCaughtUp } from "../src/core/prices-only.mjs";
import { OWNER_AVAILABILITY_COLUMN as OWN } from "../src/core/owner-availability.mjs";
import { updatePrices } from "../src/pipeline/prices-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import * as WT from "../src/pipeline/safe-write/write-target.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { PRESENCE_COLUMN } from "../src/core/supplier-presence.mjs";
import { ownerSummary } from "../src/pipeline/ops-summary.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const NOW = Date.parse("2026-11-15T08:00:00Z");
const MAIN = "Основний каталог", JOURNAL = "Журнал";
const cfg = () => { const c = productionConfig(structuredClone(baseConfig)); c.supplier.minimumOffers = 10; return c; };
const okCc = () => Object.freeze({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp-", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
const dated = (xml, min = 0) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 2 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });

function world() {
  const s = generateSynthetic({ products: 60, queue: 0, deferred: 0, newOffers: 0, seed: 43, now: NOW });
  const head = s.sheets[MAIN][0];
  const extra = [PRESENCE_COLUMN, OWN, OWNP].filter((c) => !head.includes(c));
  const mainValues = s.sheets[MAIN].map((r, i) => [...r, ...extra.map((c) => (i === 0 ? c : ""))]);
  const book = { [MAIN]: mainValues, "Групи": s.groups, [JOURNAL]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
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

test("15.11: правило «Ціни власника» — діє, поки ціна у фіді та сама; змінилась або дорівнює ціні власника — очистити", () => {
  const row = (own, sup) => ({ [OWNP]: own, "Ціна постачальника": sup });
  assert.equal(ownerPriceCaughtUp(row("", 5899), { price: 5899 }), null, "порожня клітинка");
  assert.equal(ownerPriceCaughtUp(row("9699", 5899), { price: 5899 }), null, "фід ще старий — діє");
  assert.deepEqual(ownerPriceCaughtUp(row("9699", 5899), { price: 9699 }), { before: "9699" }, "фід = ціна власника");
  assert.deepEqual(ownerPriceCaughtUp(row("9 699 грн", 5899), { price: 9500 }), { before: "9 699 грн" }, "фід змінився на інше — теж знімається");
  assert.deepEqual(ownerPriceCaughtUp(row("5899", 5899), { price: 5899 }), { before: "5899" }, "власник вписав ту саму ціну, що у фіді");
  assert.equal(ownerPriceCaughtUp(row("абв", 5899), { price: 9699 }), null, "невалідна клітинка не діє й не чіпається");
  assert.equal(ownerPriceCaughtUp(row("9699", 5899), undefined), null, "немає у фіді — не чіпати");
});

test("15.11: «Ціни» — ціна власника діє (ціна від неї), постачальник змінив ціну у фіді — клітинку очищено, далі ціна з фіду", async () => {
  const w = world();
  const r0 = await prices(w, 0);
  assert.ok(["PRICES_UPDATED", "NO_CHANGES"].includes(r0.state), JSON.stringify(r0).slice(0, 300));
  const ok = rows(w).filter((r) => r["Стан синхронізації"] === MATCH.OK && r["Наявність"] === "+");
  assert.ok(ok.length >= 3);
  const [A, B, C] = ok, a = mtText(A["Offer ID"]), b = mtText(B["Offer ID"]), c = mtText(C["Offer ID"]);
  const pa = Number(A["Ціна постачальника"]), pb = Number(B["Ціна постачальника"]), pc = Number(C["Ціна постачальника"]);
  const outside = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !LIVE_COLUMNS.includes(k) && k !== OWNP));
  const before = Object.fromEntries(rows(w).map((r) => [mtText(r["Offer ID"]), outside(r)]));

  // 1) власник знає нову ціну раніше за фід: A і B; C — та сама ціна, що й у фіді (знімається одразу, ціна не змінюється)
  setCell(w, a, OWNP, String(pa + 1000)); setCell(w, b, OWNP, String(pb + 700)); setCell(w, c, OWNP, String(pc));
  const r1 = await prices(w, 1);
  assert.equal(r1.state, "PRICES_UPDATED", JSON.stringify(r1).slice(0, 300));
  assert.equal(Number(rowOf(w, a)["Ціна кінцева"]), sale(pa + 1000)); assert.equal(Number(rowOf(w, a)["Ціна постачальника"]), pa, "ціна постачальника — з фіду");
  assert.equal(Number(rowOf(w, b)["Ціна кінцева"]), sale(pb + 700));
  assert.equal(rowOf(w, a)[OWNP], String(pa + 1000)); assert.equal(rowOf(w, b)[OWNP], String(pb + 700));
  assert.equal(rowOf(w, c)[OWNP], "", "та сама ціна, що у фіді — знято"); assert.equal(Number(rowOf(w, c)["Ціна кінцева"]), sale(pc));
  assert.deepEqual(r1.stats.ownerPrice, { active: 2, cleared: 1 });
  assert.match(ownerSummary("prices", { result: r1 }), /«Ціна власника»: діє 2; знято 1/);
  assert.equal((await prices(w, 2)).state, "NO_CHANGES", "стабільно, поки фід не змінився");

  // 2) постачальник оновив фід: A — рівно до ціни власника, B — до іншої ціни; обидві клітинки очищено, ціна з фіду, події в «Журналі»
  supplierPrice(w, A["ID постачальника"], pa + 1000); supplierPrice(w, B["ID постачальника"], pb + 300);
  const r3 = await prices(w, 3);
  assert.equal(r3.state, "PRICES_UPDATED", JSON.stringify(r3).slice(0, 300));
  assert.equal(rowOf(w, a)[OWNP], ""); assert.equal(Number(rowOf(w, a)["Ціна постачальника"]), pa + 1000); assert.equal(Number(rowOf(w, a)["Ціна кінцева"]), sale(pa + 1000));
  assert.equal(rowOf(w, b)[OWNP], ""); assert.equal(Number(rowOf(w, b)["Ціна кінцева"]), sale(pb + 300), "після зміни фіду — ціна з фіду, не з клітинки власника");
  assert.deepEqual(r3.stats.ownerPrice, { active: 0, cleared: 2 });
  for (const id of [a, b]) assert.ok(w.sheets.book[JOURNAL].some((e) => e[2] === id && e[3] === OWNP && e[5] === ""), "подія очищення: " + id);
  assert.equal((await prices(w, 4)).state, "NO_CHANGES");

  // Поза LIVE і «Ціною власника» нічого не змінено
  for (const r of rows(w)) assert.deepEqual(outside(r), before[mtText(r["Offer ID"])], mtText(r["Offer ID"]));
});

test("15.11: власник змінив «Ціну власника» між читанням і записом — очищення не пишеться (правка людини має пріоритет)", async () => {
  const w = world();
  await prices(w, 0);
  const A = rows(w).find((r) => r["Стан синхронізації"] === MATCH.OK && r["Наявність"] === "+"), a = mtText(A["Offer ID"]);
  const pa = Number(A["Ціна постачальника"]);
  setCell(w, a, OWNP, String(pa + 500));
  await prices(w, 1);
  supplierPrice(w, A["ID постачальника"], pa + 200);
  const orig = w.readBook;
  let first = true;
  w.readBook = async (names) => { const b = await orig(names); if (first && names?.includes(MAIN)) { first = false; } else if (names?.includes(MAIN)) setCell(w, a, OWNP, String(pa + 900)); return orig(names); };
  await prices(w, 2);
  w.readBook = orig;
  assert.equal(rowOf(w, a)[OWNP], String(pa + 900), "нова правка власника не стерта");
});
