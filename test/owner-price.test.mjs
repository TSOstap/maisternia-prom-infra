// Рішення власника 06.11.2026: «Ціна власника» — ціна постачальника, яку власник знає раніше за фід. Заповнена — замість ціни з фіду
// (+5, націнка «Турбо», знижка — як завжди); порожня — ціна з фіду. Фід (YML) приймає рядок, перерахований за ціною власника.
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { mtPrices, DEFAULT_PRICING, ownerCost, OWNER_PRICE_COLUMN } from "../src/core/pricing.mjs";
import { prosaleFor, prosaleFinal, PROSALE_TARIFF_COLUMN } from "../src/core/prosale.mjs";
import { renderOffer, patchOfferLive, groupsForYml, objectsFromValues, GROUP_HEADERS } from "../src/core/yml.mjs";
import { planRows, LIVE_COLUMNS } from "../src/core/sync-plan.mjs";
import { PRICE_READ_COLUMNS } from "../src/pipeline/prices-run.mjs";
import { YML_COLUMNS, LIVE_SYNC_COLUMNS } from "../workers/ops/src/yml-feed.mjs";
import RATES from "../config/prosale-rates.json" with { type: "json" };
import { parseSupplierText } from "../src/core/supplier-feed.mjs";

const NOW = Date.parse("2026-11-06T12:00:00Z");
async function world() {
  const s = generateSynthetic({ products: 12, queue: 0, deferred: 0, newOffers: 0, seed: 7, now: NOW });
  const h = s.sheets["Основний каталог"][0];
  const order = Object.entries(RATES.categories).find(([, c]) => Number.isFinite(c.order))[0];
  const rows = s.sheets["Основний каталог"].slice(1).map((r) => ({ ...Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])), "Категорія Prom ID": order }));
  const r = rows.find((x) => x["Наявність"] === "+" && x["Стан синхронізації"] === "ЗІСТАВЛЕНО" && x["Статус імпорту"] === "ДОЗВОЛЕНО");
  const parsed = await parseSupplierText(s.supplierXml(), { maximumChars: 45_000_000, identityFields: true });
  const offers = parsed.offers instanceof Map ? parsed.offers : new Map(Object.entries(parsed.offers));
  const offer = offers.get(r["ID постачальника"]);
  assert.ok(offer, "у синтетичному фіді є товар рядка");
  return { r, offer, offers, order, groupMap: groupsForYml(objectsFromValues(s.groups, GROUP_HEADERS)).groupMap };
}
const opt = (r, groupMap) => ({ success: new Date(r["Оновлено"]).getTime(), groupMap, pricing: DEFAULT_PRICING, missingPolicy: "unavailable", conflictPolicy: "isolate", inStock: true });
const apply = (row, p) => Object.fromEntries(Object.entries(row).map(([k, v]) => { const i = LIVE_COLUMNS.indexOf(k); return [k, i >= 0 ? p.next[i] : v]; }));

test("06.11: «Ціна власника» — розбір: «5 890,00», 5890, «5890 грн» → 5890; порожньо / текст / 0 / мінус → немає", () => {
  for (const v of ["5 890,00", 5890, "5890 грн", " 5890 "]) assert.equal(ownerCost({ [OWNER_PRICE_COLUMN]: v }), 5890, String(v));
  for (const v of ["", "abc", 0, "-5", null, undefined]) assert.equal(ownerCost({ [OWNER_PRICE_COLUMN]: v }), null, String(v));
});

test("06.11: заповнена «Ціна власника» — ціни рядка за нею (+5, знижка); «Ціна постачальника» лишається з фіду; порожня — знову з фіду", async () => {
  const w = await world();
  const own = w.offer.price + 1000;
  const [p] = planRows([{ ...w.r, [OWNER_PRICE_COLUMN]: String(own) }], w.offers, new Date(NOW).toISOString(), DEFAULT_PRICING);
  const e = mtPrices(own, true, DEFAULT_PRICING);
  assert.equal(p.next[0], w.offer.price, "«Ціна постачальника» — з фіду");
  assert.equal(p.next[1], e.base); assert.equal(p.next[2], e.final); assert.equal(p.next[2], own + 5);
  const [q] = planRows([{ ...apply(w.r, p), [OWNER_PRICE_COLUMN]: "" }], w.offers, new Date(NOW).toISOString(), DEFAULT_PRICING);
  assert.equal(q.next[2], w.offer.price + 5, "клітинку очищено — ціна з фіду");
});

test("06.11: «Турбо» + «Ціна власника» — націнка рахується від ціни власника; фід приймає рядок (і повне формування, і оновлення цін)", async () => {
  const w = await world();
  const own = w.offer.price + 500;
  const row0 = { ...w.r, [PROSALE_TARIFF_COLUMN]: "Турбо", [OWNER_PRICE_COLUMN]: String(own) };
  const [p] = planRows([row0], w.offers, new Date(NOW).toISOString(), DEFAULT_PRICING);
  const want = prosaleFinal(own + 5, prosaleFor(row0, DEFAULT_PRICING));
  assert.equal(p.next[2], want);
  const row = apply(row0, p);
  const o = renderOffer(row, opt(row, w.groupMap));
  assert.equal(o.kind, "published"); assert.ok(!o.issue, "рядок не ізольовано");
  assert.match(o.xml, new RegExp("<price>" + mtPrices(own, true, DEFAULT_PRICING, prosaleFor(row0)).base.toFixed(2).replace(".", "\.") + "</price><discount>20%</discount>"));
  assert.equal(patchOfferLive(o.xml, row, { pricing: DEFAULT_PRICING, inStock: true }), o.xml);
  // Без «Ціни власника» ті самі ціни рядка формулі не відповідають — фід бере саме ціну власника.
  assert.throws(() => renderOffer({ ...row, [OWNER_PRICE_COLUMN]: "" }, { ...opt(row, w.groupMap), }), /не відповідають погодженій формулі/);
});

test("06.11: «Ціна власника» читається всюди, де рахуються ціни: «Оновити ціни», повне формування фіду, оновлення цін у фіді", () => {
  for (const cols of [PRICE_READ_COLUMNS, YML_COLUMNS, LIVE_SYNC_COLUMNS]) assert.ok(cols.includes(OWNER_PRICE_COLUMN));
  assert.ok(!LIVE_COLUMNS.includes(OWNER_PRICE_COLUMN), "система «Ціну власника» не пише — лише власник");
});
