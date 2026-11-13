// Рішення власника 14.11.2026 (ціни за конкурентами): «Ціна вручну» діє лише поки ціна постачальника та сама, що під час
// встановлення («Ціна вручну: при ціні постачальника»); «Надбавка» −1…+5 замість +5. Межі, перехідний стан фіду, запис лише owner-edits.
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import {
  mtPrices, rowPrices, priceRule, cellNumber, DEFAULT_PRICING, OWNER_PRICE_COLUMN,
  MANUAL_PRICE_COLUMN, MANUAL_ANCHOR_COLUMN, EXTRA_COLUMN, PRICE_RULE_COLUMNS,
} from "../src/core/pricing.mjs";
import { prosaleFor, prosaleFinal, PROSALE_TARIFF_COLUMN } from "../src/core/prosale.mjs";
import { renderOffer, patchOfferLive, groupsForYml, objectsFromValues, GROUP_HEADERS } from "../src/core/yml.mjs";
import { planRows, LIVE_COLUMNS } from "../src/core/sync-plan.mjs";
import { PRICE_READ_COLUMNS } from "../src/pipeline/prices-run.mjs";
import { YML_COLUMNS, LIVE_SYNC_COLUMNS } from "../workers/ops/src/yml-feed.mjs";
import { planProblems, OWNER_EDIT_TARGETS } from "../src/pipeline/owner-edits.mjs";
import { MODE_POLICIES } from "../src/pipeline/safe-write/write-target.mjs";
import { addPriceRuleColumns } from "../src/pipeline/price-rule-columns.mjs";
import RATES from "../config/prosale-rates.json" with { type: "json" };
import { parseSupplierText } from "../src/core/supplier-feed.mjs";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const STAMP = new Date(NOW).toISOString();
async function world() {
  const s = generateSynthetic({ products: 12, queue: 0, deferred: 0, newOffers: 0, seed: 11, now: NOW });
  const h = s.sheets["Основний каталог"][0];
  const order = Object.entries(RATES.categories).find(([, c]) => Number.isFinite(c.order))[0];
  const rows = s.sheets["Основний каталог"].slice(1).map((r) => ({ ...Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])), "Категорія Prom ID": order }));
  const r = rows.find((x) => x["Наявність"] === "+" && x["Стан синхронізації"] === "ЗІСТАВЛЕНО" && x["Статус імпорту"] === "ДОЗВОЛЕНО");
  const parsed = await parseSupplierText(s.supplierXml(), { maximumChars: 45_000_000, identityFields: true });
  const offers = parsed.offers instanceof Map ? parsed.offers : new Map(Object.entries(parsed.offers));
  const offer = offers.get(r["ID постачальника"]);
  assert.ok(offer, "у синтетичному фіді є товар рядка");
  return { r, offer, offers, groupMap: groupsForYml(objectsFromValues(s.groups, GROUP_HEADERS)).groupMap };
}
const opt = (r, groupMap) => ({ success: new Date(r["Оновлено"]).getTime(), groupMap, pricing: DEFAULT_PRICING, missingPolicy: "unavailable", conflictPolicy: "isolate", inStock: true });
const apply = (row, p) => Object.fromEntries(Object.entries(row).map(([k, v]) => { const i = LIVE_COLUMNS.indexOf(k); return [k, i >= 0 ? p.next[i] : v]; }));
const manual = (price, anchor) => ({ [MANUAL_PRICE_COLUMN]: price, [MANUAL_ANCHOR_COLUMN]: anchor });

test("14.11: розбір клітинок — «1 234,50», «−1», «5 грн», число; порожньо → null; текст → NaN", () => {
  assert.equal(cellNumber("1 234,50"), 1234.5);
  assert.equal(cellNumber("−1"), -1);
  assert.equal(cellNumber("-1"), -1);
  assert.equal(cellNumber("5 грн"), 5);
  assert.equal(cellNumber(18471), 18471);
  for (const v of ["", " ", null, undefined]) assert.equal(cellNumber(v), null, String(v));
  assert.ok(Number.isNaN(cellNumber("abc")));
});

test("14.11: без нових клітинок — точно стара формула (+5, націнка, знижка) — і для товарів у наявності, і без", () => {
  for (const price of [100, 1855, 15777.05, 99999]) for (const av of [true, false]) {
    const p = rowPrices({}, price, av, DEFAULT_PRICING);
    const { rule, ...rest } = p;
    assert.deepEqual(rest, mtPrices(price, av, DEFAULT_PRICING));
    assert.equal(rule.kind, "standard");
  }
});

test("14.11: ручна ціна діє, лише поки ціна постачальника = ціні на момент встановлення; змінилась — стандартна формула (приклад власника)", () => {
  // Постачальник 120, ми поставили 185 (190 з прикладу власника — понад 1,5 × 125, запобіжник таку не пропускає).
  let r = priceRule(manual("185", "120"), 120, DEFAULT_PRICING);
  assert.equal(r.kind, "manual"); assert.equal(r.final0, 185);
  assert.equal(priceRule(manual("190", "120"), 120, DEFAULT_PRICING).kind, "standard");
  // Постачальник поставив 220 — ручна ціна не діє: 225, а НЕ 290 і НЕ 185.
  r = priceRule(manual("185", "120"), 220, DEFAULT_PRICING);
  assert.equal(r.kind, "standard"); assert.equal(r.final0, 225); assert.match(r.notes[0], /змінилась/);
  // Постачальник знизив до 100 — теж стандартна (105), ручна 185 не тримається.
  assert.equal(priceRule(manual("185", "120"), 100, DEFAULT_PRICING).final0, 105);
  // Копійки ціни постачальника: 15777.05 як рядок і як число.
  assert.equal(priceRule(manual("18471", "15777.05"), 15777.05, DEFAULT_PRICING).kind, "manual");
  assert.equal(priceRule(manual(18471, 15777.05), 15777.05, DEFAULT_PRICING).kind, "manual");
  assert.equal(priceRule(manual(18471, 15777.05), 15777.06, DEFAULT_PRICING).kind, "standard");
});

test("14.11: ручна ціна — межі: без ціни постачальника на момент встановлення, нижче за «постачальник − 1», вище за 1,5 × стандартної, текст — не діє", () => {
  const cost = 1000, std = 1005;
  for (const [cells, why] of [
    [{ [MANUAL_PRICE_COLUMN]: "1200" }, /немає/],
    [manual("1200", "abc"), /немає/],
    [manual("998.99", "1000"), /нижча/],
    [manual(String(std * 1.5 + 0.01), "1000"), /вища/],
    [manual("abc", "1000"), /не число/],
    [manual("0", "1000"), /не число/],
  ]) {
    const r = priceRule(cells, cost, DEFAULT_PRICING);
    assert.equal(r.kind, "standard", JSON.stringify(cells)); assert.equal(r.final0, std); assert.match(r.notes.join(" "), why);
  }
  // Межі включно: «постачальник − 1» і рівно 1,5 × стандартної — діють.
  assert.equal(priceRule(manual("999", "1000"), cost, DEFAULT_PRICING).final0, 999);
  assert.equal(priceRule(manual(String(std * 1.5), "1000"), cost, DEFAULT_PRICING).final0, std * 1.5);
});

test("14.11: «Надбавка» −1…+5 замість +5 і рухається разом із ціною постачальника; поза межами / текст — не діє", () => {
  assert.equal(priceRule({ [EXTRA_COLUMN]: "-1" }, 1000, DEFAULT_PRICING).final0, 999);
  assert.equal(priceRule({ [EXTRA_COLUMN]: "−1" }, 1200, DEFAULT_PRICING).final0, 1199);
  assert.equal(priceRule({ [EXTRA_COLUMN]: 0 }, 1000, DEFAULT_PRICING).final0, 1000);
  assert.equal(priceRule({ [EXTRA_COLUMN]: "5" }, 1000, DEFAULT_PRICING).final0, 1005);
  for (const v of ["-2", "-1.01", "6", "100", "abc"]) {
    const r = priceRule({ [EXTRA_COLUMN]: v }, 1000, DEFAULT_PRICING);
    assert.equal(r.kind, "standard", v); assert.equal(r.final0, 1005, v); assert.match(r.notes.join(" "), /Надбавка/);
  }
});

test("14.11: ручна ціна, коли діє, має перевагу над надбавкою; не діє (ціна постачальника змінилась) — діє надбавка", () => {
  const cells = { ...manual("1300", "1000"), [EXTRA_COLUMN]: "-1" };
  assert.deepEqual([priceRule(cells, 1000, DEFAULT_PRICING).kind, priceRule(cells, 1000, DEFAULT_PRICING).final0], ["manual", 1300]);
  const r = priceRule(cells, 1100, DEFAULT_PRICING);
  assert.equal(r.kind, "extra"); assert.equal(r.final0, 1099);
});

test("14.11: базова ціна й знижка від ручної ціни — як завжди (base = кінцева × 1,25; у фіді <price> = base і 20 %)", () => {
  const p = rowPrices(manual("18471", "15777.05"), 15777.05, true, DEFAULT_PRICING);
  assert.equal(p.final, 18471); assert.equal(p.base, 23088.75); assert.equal(p.discount, "20%"); assert.equal(p.availability, "+");
  const q = rowPrices({ [EXTRA_COLUMN]: "-1" }, 1855, true, DEFAULT_PRICING);
  assert.equal(q.final, 1854); assert.equal(q.base, 2317.5);
});

test("14.11: «Оновити ціни» (planRows) — ручна ціна й надбавка; ціна постачальника у фіді змінилась — рядок повертається до +5", async () => {
  const w = await world();
  const P = w.offer.price;
  const row = { ...w.r, ...manual(String(P + 300), String(P)) };
  const [p] = planRows([row], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(p.next[0], P); assert.equal(p.next[2], P + 300); assert.equal(p.next[1], mtPrices(P + 295, true, DEFAULT_PRICING).base);
  // Ціна постачальника на момент встановлення інша (постачальник змінив ціну) — стандартна.
  const [q] = planRows([{ ...w.r, ...manual(String(P + 300), String(P - 50)) }], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(q.next[2], P + 5);
  const [e] = planRows([{ ...w.r, [EXTRA_COLUMN]: "-1" }], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(e.next[2], P - 1);
});

test("14.11: «Ціна власника» + ручна ціна — порівнюється з ціною власника (від неї рахується ціна)", async () => {
  const w = await world();
  const own = w.offer.price + 1000;
  const [p] = planRows([{ ...w.r, [OWNER_PRICE_COLUMN]: String(own), ...manual(String(own + 200), String(own)) }], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(p.next[2], own + 200);
  const [q] = planRows([{ ...w.r, [OWNER_PRICE_COLUMN]: String(own), ...manual(String(own + 200), String(w.offer.price)) }], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(q.next[2], own + 5, "ручну ціну ставили від іншої ціни — не діє");
});

test("14.11: фід приймає рядок із ручною ціною (повне формування й оновлення цін); довільна ціна в таблиці — як і раніше, ні", async () => {
  const w = await world();
  const P = w.offer.price;
  const row0 = { ...w.r, ...manual(String(P + 300), String(P)) };
  const [p] = planRows([row0], w.offers, STAMP, DEFAULT_PRICING);
  const row = apply(row0, p);
  const o = renderOffer(row, opt(row, w.groupMap));
  assert.equal(o.kind, "published"); assert.ok(!o.issue);
  const base = mtPrices(P + 295, true, DEFAULT_PRICING).base;
  assert.ok(o.xml.includes("<price>" + base.toFixed(2) + "</price><discount>20%</discount>"), "<price> = база від ручної ціни");
  assert.equal(patchOfferLive(o.xml, row, { pricing: DEFAULT_PRICING, inStock: true }), o.xml);
  // Ті самі ціни без ручної ціни формулі не відповідають (захист лишається).
  assert.throws(() => renderOffer({ ...row, [MANUAL_PRICE_COLUMN]: "", [MANUAL_ANCHOR_COLUMN]: "" }, opt(row, w.groupMap)), /не відповідають погодженій формулі/);
  // Довільні ціни при чинній ручній ціні — теж ні.
  assert.throws(() => renderOffer({ ...row, "Ціна кінцева": P + 299 }, opt(row, w.groupMap)), /не відповідають погодженій формулі/);
});

test("14.11: перехідний стан — правило вже записано, «Ціни» ще не перерахували: фід приймає чинні стандартні ціни (товар не ізолюється)", async () => {
  const w = await world();
  const P = w.offer.price;
  const [p] = planRows([w.r], w.offers, STAMP, DEFAULT_PRICING);
  const std = apply(w.r, p);
  for (const cells of [manual(String(P + 300), String(P)), { [EXTRA_COLUMN]: "-1" }]) {
    const row = { ...std, ...cells };
    const o = renderOffer(row, opt(row, w.groupMap));
    assert.equal(o.kind, "published"); assert.ok(!o.issue, JSON.stringify(cells));
    assert.ok(o.xml.includes("<price>" + mtPrices(P, true, DEFAULT_PRICING).base.toFixed(2) + "</price>"), "поки що стандартна ціна");
    assert.equal(patchOfferLive(o.xml, row, { pricing: DEFAULT_PRICING, inStock: true }), o.xml);
  }
  // Після «Цін» — нова ціна; оновлення цін у готовому offer дає те саме, що повне формування.
  const row0 = { ...std, [EXTRA_COLUMN]: "-1" };
  const o0 = renderOffer(std, opt(std, w.groupMap));
  const [q] = planRows([row0], w.offers, STAMP, DEFAULT_PRICING);
  const row1 = apply(row0, q);
  assert.equal(row1["Ціна кінцева"], P - 1);
  const full = renderOffer(row1, opt(row1, w.groupMap)).xml;
  assert.equal(patchOfferLive(o0.xml, row1, { pricing: DEFAULT_PRICING, inStock: true }), full);
});

test("14.11: «Турбо» + ручна ціна — націнка ProSale від ручної ціни; фід приймає", async () => {
  const w = await world();
  const P = w.offer.price;
  const row0 = { ...w.r, [PROSALE_TARIFF_COLUMN]: "Турбо", ...manual(String(P + 300), String(P)) };
  const [p] = planRows([row0], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(p.next[2], prosaleFinal(P + 300, prosaleFor(row0, DEFAULT_PRICING)));
  const row = apply(row0, p);
  const o = renderOffer(row, opt(row, w.groupMap));
  assert.equal(o.kind, "published"); assert.ok(!o.issue);
  assert.equal(patchOfferLive(o.xml, row, { pricing: DEFAULT_PRICING, inStock: true }), o.xml);
});

test("14.11: нові колонки читаються всюди, де рахуються ціни; система їх не пише (не LIVE); пише лише owner-edits", () => {
  for (const cols of [PRICE_READ_COLUMNS, YML_COLUMNS, LIVE_SYNC_COLUMNS]) for (const c of PRICE_RULE_COLUMNS) assert.ok(cols.includes(c), c);
  for (const c of PRICE_RULE_COLUMNS) {
    assert.ok(!LIVE_COLUMNS.includes(c));
    assert.ok(OWNER_EDIT_TARGETS["Основний каталог"].columns.includes(c));
    assert.ok(MODE_POLICIES["owner-edits"]["Основний каталог"].columns.includes(c));
    assert.ok(!MODE_POLICIES.prices["Основний каталог"].columns.includes(c), "«Оновити ціни» правило не пише");
  }
  assert.deepEqual(MODE_POLICIES["price-rule-columns"]["Основний каталог"].columns, [...PRICE_RULE_COLUMNS]);
});

test("14.11: owner-edits — ціна / надбавка лише числом у межах або порожньо (зняти)", () => {
  const e = (column, set, expect = "") => ({ sheet: "Основний каталог", key: "1", column, expect, set, source: "рішення власника 14.11" });
  assert.deepEqual(planProblems([e(MANUAL_PRICE_COLUMN, "18471"), e(MANUAL_ANCHOR_COLUMN, "15777.05"), e(EXTRA_COLUMN, "-1")]), []);
  assert.deepEqual(planProblems([e(MANUAL_PRICE_COLUMN, "", "18471"), e(MANUAL_ANCHOR_COLUMN, "", "15777.05")]), []);
  assert.match(planProblems([e(MANUAL_PRICE_COLUMN, "abc")]).join(" "), /не число/);
  assert.match(planProblems([e(MANUAL_PRICE_COLUMN, "-5")]).join(" "), /поза межами/);
  assert.match(planProblems([e(EXTRA_COLUMN, "-2")]).join(" "), /поза межами/);
  assert.match(planProblems([e(EXTRA_COLUMN, "6")]).join(" "), /поза межами/);
});

test("14.11: режим price-rule-columns — три порожні колонки в кінці «Основного каталогу», подія в «Журналі»; повторно — нічого", async () => {
  const book = { "Основний каталог": [["Offer ID", "Назва UA", "Тариф ProSale"], ["1", "А", ""], ["2", "Б", "Турбо"]], "Журнал": [["Дата"]] };
  const calls = [];
  const sheets = {
    ensureColumns: async (t, n) => { calls.push(["ensureColumns", t, n]); },
    updateRanges: async (blocks) => { for (const b of blocks) { calls.push(["updateRanges", b.title, b.row, b.col]); b.values[0].forEach((v, i) => { book[b.title][b.row - 1][b.col - 1 + i] = v; }); } },
    appendRows: async (t, rows) => { calls.push(["appendRows", t]); book[t].push(...rows); },
  };
  const readBook = async (titles) => Object.fromEntries(titles.map((t) => [t, book[t].map((r) => r.slice())]));
  const r = await addPriceRuleColumns({ sheets, readBook, stamp: STAMP });
  assert.equal(r.state, "PRICE_RULE_COLUMNS_ADDED");
  assert.deepEqual(book["Основний каталог"][0], ["Offer ID", "Назва UA", "Тариф ProSale", ...PRICE_RULE_COLUMNS]);
  assert.deepEqual(book["Основний каталог"][1], ["1", "А", ""], "значення рядків не змінено");
  assert.deepEqual(calls.slice(0, 2), [["ensureColumns", "Основний каталог", 6], ["updateRanges", "Основний каталог", 1, 4]]);
  assert.equal(book["Журнал"].length, 2);
  assert.equal((await addPriceRuleColumns({ sheets, readBook, stamp: STAMP })).state, "NOTHING");
});
