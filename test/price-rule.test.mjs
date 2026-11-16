// Рішення власника 16.11.2026 (реєстр № 63): ціни власника — ЯК НОВА РРЦ (+5, далі ProSale). «Ціна власника» — постійна; «Ціна вручну»
// — поки РРЦ та сама (якір «Ціна вручну: при ціні постачальника» пишуть «Ціни»); нижче дропу — не діє; «Надбавку» прибрано.
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import {
  mtPrices, rowPrices, effectiveCost, cellNumber, DEFAULT_PRICING, OWNER_PRICE_COLUMN,
  MANUAL_PRICE_COLUMN, MANUAL_ANCHOR_COLUMN, PRICE_RULE_COLUMNS,
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
  assert.equal(cellNumber("5 грн"), 5);
  assert.equal(cellNumber(18471), 18471);
  for (const v of ["", " ", null, undefined]) assert.equal(cellNumber(v), null, String(v));
  assert.ok(Number.isNaN(cellNumber("abc")));
});

test("№ 63: без цін власника — точно стара формула (+5, націнка, знижка) — і для товарів у наявності, і без", () => {
  for (const price of [100, 1855, 15777.05, 99999]) for (const av of [true, false]) {
    const { rule, ...rest } = rowPrices({}, price, av, DEFAULT_PRICING);
    assert.deepEqual(rest, mtPrices(price, av, DEFAULT_PRICING));
    assert.equal(rule.kind, "standard");
  }
});

test("№ 63: «Ціна вручну» — як нова РРЦ (+5); якоря немає — діє й «Ціни» запишуть якір; РРЦ = якорю — діє; РРЦ змінилась — знято", () => {
  // Постачальник написав «2000» — власник пише 2000: ціна 2005 (як РРЦ 2000).
  let r = effectiveCost(manual("2000", ""), 1800);
  assert.deepEqual([r.kind, r.cost, r.anchor], ["manual", 2000, "set"]);
  assert.equal(rowPrices(manual("2000", ""), 1800, true, DEFAULT_PRICING).final, 2005);
  r = effectiveCost(manual("2000", "1800"), 1800);
  assert.deepEqual([r.kind, r.cost, r.anchor], ["manual", 2000, null]);
  // Постачальник змінив РРЦ (1800 → 1900): ручна ціна знята, стандартна 1905.
  r = effectiveCost(manual("2000", "1800"), 1900);
  assert.deepEqual([r.kind, r.cost, r.anchor], ["standard", 1900, "stale"]);
  assert.match(r.notes[0], /змінилась/);
  assert.equal(rowPrices(manual("2000", "1800"), 1900, true, DEFAULT_PRICING).final, 1905);
  // Копійки РРЦ: рядок і число.
  assert.equal(effectiveCost(manual("18471", "15777.05"), 15777.05).kind, "manual");
  assert.equal(effectiveCost(manual(18471, 15777.05), 15777.06).anchor, "stale");
  // Якір — текст: як змінена РРЦ (знімається).
  assert.equal(effectiveCost(manual("2000", "abc"), 1800).anchor, "stale");
});

test("№ 63: «Ціна власника» — постійна (діє за будь-якої РРЦ), має перевагу над «Ціною вручну»; текст / 0 — не діє", () => {
  for (const rrp of [1000, 1500, 9000]) {
    const r = effectiveCost({ [OWNER_PRICE_COLUMN]: "2000" }, rrp);
    assert.deepEqual([r.kind, r.cost], ["owner", 2000], String(rrp));
  }
  assert.equal(effectiveCost({ [OWNER_PRICE_COLUMN]: "2000", ...manual("3000", "1000") }, 1000).cost, 2000, "обидві — діє «Ціна власника»");
  for (const v of ["abc", "0", "-5"]) assert.equal(effectiveCost({ [OWNER_PRICE_COLUMN]: v }, 1000).kind, "standard", v);
  for (const v of ["abc", "0"]) {
    const r = effectiveCost(manual(v, "1000"), 1000);
    assert.equal(r.kind, "standard");
    assert.match(r.notes.join(" "), /не число/);
  }
});

test("№ 63: нижче дропу — не діє (захист від помилки в клітинці); дропу немає — без цього захисту", () => {
  let r = effectiveCost({ [OWNER_PRICE_COLUMN]: "200" }, 2000, 1800);
  assert.equal(r.kind, "standard");
  assert.match(r.notes.join(" "), /нижча за дроп/);
  r = effectiveCost(manual("1700", ""), 2000, 1800);
  assert.equal(r.kind, "standard");
  assert.match(r.notes.join(" "), /нижча за дроп/);
  assert.equal(effectiveCost(manual("1800", ""), 2000, 1800).kind, "manual", "рівно дроп — діє");
  assert.equal(effectiveCost({ [OWNER_PRICE_COLUMN]: "200" }, 2000, null).kind, "owner");
});

test("№ 63: база й знижка від ціни власника — як завжди (base = кінцева × 1,25; у фіді <price> = base і 20 %)", () => {
  const p = rowPrices(manual("18466", "15777.05"), 15777.05, true, DEFAULT_PRICING);
  assert.equal(p.final, 18471);
  assert.equal(p.base, 23088.75);
  assert.equal(p.discount, "20%");
  assert.equal(p.availability, "+");
});

test("№ 63: «Оновити ціни» (planRows) — ручна ціна (з якорем / без) і постійна ціна власника; РРЦ змінилась — ручна знята, постійна лишається", async () => {
  const w = await world();
  const P = w.offer.price;
  const [a] = planRows([{ ...w.r, ...manual(String(P + 300), "") }], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(a.next[0], P, "РРЦ у таблиці — постачальника");
  assert.equal(a.next[2], P + 305);
  assert.equal(a.rule.anchor, "set");
  const [b] = planRows([{ ...w.r, ...manual(String(P + 300), String(P)) }], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(b.next[2], P + 305);
  assert.equal(b.rule.anchor, null);
  const [c] = planRows([{ ...w.r, ...manual(String(P + 300), String(P - 50)) }], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(c.next[2], P + 5);
  assert.equal(c.rule.anchor, "stale");
  const [d] = planRows([{ ...w.r, [OWNER_PRICE_COLUMN]: String(P + 1000) }], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(d.next[2], P + 1005);
  assert.equal(d.rule.kind, "owner");
});

test("№ 63: фід приймає рядок із ціною власника (повне формування й оновлення цін); довільна ціна в таблиці — як і раніше, ні", async () => {
  const w = await world();
  const P = w.offer.price;
  for (const cells of [manual(String(P + 300), String(P)), { [OWNER_PRICE_COLUMN]: String(P + 300) }]) {
    const row0 = { ...w.r, ...cells };
    const [p] = planRows([row0], w.offers, STAMP, DEFAULT_PRICING);
    const row = apply(row0, p);
    const o = renderOffer(row, opt(row, w.groupMap));
    assert.equal(o.kind, "published");
    assert.ok(!o.issue);
    assert.ok(o.xml.includes("<price>" + mtPrices(P + 300, true, DEFAULT_PRICING).base.toFixed(2) + "</price><discount>20%</discount>"), "<price> = база від ціни власника");
    assert.equal(patchOfferLive(o.xml, row, { pricing: DEFAULT_PRICING, inStock: true }), o.xml);
    assert.throws(() => renderOffer({ ...row, "Ціна кінцева": P + 299 }, opt(row, w.groupMap)), /не відповідають погодженій формулі/);
  }
});

test("№ 63: перехідний стан — ціну власника вже записано, «Ціни» ще не перерахували: фід приймає чинні стандартні ціни", async () => {
  const w = await world();
  const P = w.offer.price;
  const [p] = planRows([w.r], w.offers, STAMP, DEFAULT_PRICING);
  const std = apply(w.r, p);
  for (const cells of [manual(String(P + 300), ""), { [OWNER_PRICE_COLUMN]: String(P + 300) }]) {
    const row = { ...std, ...cells };
    const o = renderOffer(row, opt(row, w.groupMap));
    assert.equal(o.kind, "published");
    assert.ok(!o.issue, JSON.stringify(cells));
    assert.ok(o.xml.includes("<price>" + mtPrices(P, true, DEFAULT_PRICING).base.toFixed(2) + "</price>"), "поки що стандартна ціна");
  }
});

test("№ 63: «Турбо» + ціна власника — націнка ProSale від неї (+5); фід приймає", async () => {
  const w = await world();
  const P = w.offer.price;
  const row0 = { ...w.r, [PROSALE_TARIFF_COLUMN]: "Турбо", ...manual(String(P + 300), String(P)) };
  const [p] = planRows([row0], w.offers, STAMP, DEFAULT_PRICING);
  assert.equal(p.next[2], prosaleFinal(P + 305, prosaleFor(row0, DEFAULT_PRICING)));
  const row = apply(row0, p);
  const o = renderOffer(row, opt(row, w.groupMap));
  assert.equal(o.kind, "published");
  assert.ok(!o.issue);
});

test("№ 63: колонки цін власника читаються всюди, де рахуються ціни; «Ціни» пишуть лише якір і зняття; «Надбавки» немає", () => {
  assert.deepEqual([...PRICE_RULE_COLUMNS], [MANUAL_PRICE_COLUMN, MANUAL_ANCHOR_COLUMN]);
  for (const cols of [PRICE_READ_COLUMNS, YML_COLUMNS, LIVE_SYNC_COLUMNS]) for (const c of [...PRICE_RULE_COLUMNS, OWNER_PRICE_COLUMN]) assert.ok(cols.includes(c), c);
  for (const c of PRICE_RULE_COLUMNS) {
    assert.ok(!LIVE_COLUMNS.includes(c));
    assert.ok(OWNER_EDIT_TARGETS["Основний каталог"].columns.includes(c));
    assert.ok(MODE_POLICIES["owner-edits"]["Основний каталог"].columns.includes(c));
    assert.ok(MODE_POLICIES.prices["Основний каталог"].columns.includes(c), "«Ціни» пишуть якір / зняття");
  }
  for (const pol of Object.values(MODE_POLICIES)) for (const t of Object.values(pol)) assert.ok(!(Array.isArray(t?.columns) && t.columns.includes("Надбавка")), "«Надбавку» прибрано");
  assert.deepEqual(MODE_POLICIES["price-rule-columns"]["Основний каталог"].columns, [...PRICE_RULE_COLUMNS]);
});

test("№ 63: owner-edits — ціни власника лише додатним числом або порожньо (зняти)", () => {
  const e = (column, set, expect = "") => ({ sheet: "Основний каталог", key: "1", column, expect, set, source: "рішення власника 16.11" });
  assert.deepEqual(planProblems([e(MANUAL_PRICE_COLUMN, "18471"), e(MANUAL_ANCHOR_COLUMN, "15777.05"), e(OWNER_PRICE_COLUMN, "2000")]), []);
  assert.deepEqual(planProblems([e(MANUAL_PRICE_COLUMN, "", "18471"), e(MANUAL_ANCHOR_COLUMN, "", "15777.05")]), []);
  assert.match(planProblems([e(MANUAL_PRICE_COLUMN, "abc")]).join(" "), /не число/);
  assert.match(planProblems([e(MANUAL_PRICE_COLUMN, "-5")]).join(" "), /поза межами/);
});

test("14.11 / № 63: режим price-rule-columns — порожні колонки цін власника в кінці «Основного каталогу», подія в «Журналі»; повторно — нічого", async () => {
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
  assert.deepEqual(calls.slice(0, 2), [["ensureColumns", "Основний каталог", 5], ["updateRanges", "Основний каталог", 1, 4]]);
  assert.equal((await addPriceRuleColumns({ sheets, readBook, stamp: STAMP })).state, "NOTHING");
});
