// Рішення власника 18.11.2026 (реєстр № 87): ціни без копійок, округлення вниз. «Ціна» (база, у фід) кратна 5 грн, тоді
// «Ціна кінцева» = база × 0,8 теж ціла; покупець платить на 0–3,99 грн менше; не нижче РРЦ. Перехідний стан: фід приймає й чинні
// ціни з копійками, доки «Ціни» не перерахували рядок.
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { mtPrices, rowPrices, wholeStep, DEFAULT_PRICING, MANUAL_PRICE_COLUMN, MANUAL_ANCHOR_COLUMN } from "../src/core/pricing.mjs";
import { prosaleFinal } from "../src/core/prosale.mjs";
import { renderOffer, patchOfferLive, groupsForYml, objectsFromValues, GROUP_HEADERS } from "../src/core/yml.mjs";
import { planRows, LIVE_COLUMNS } from "../src/core/sync-plan.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import CONFIG from "../config/default.json" with { type: "json" };

const W = Object.freeze({ ...DEFAULT_PRICING, whole: true });
const NOW = Date.parse("2026-11-18T12:00:00Z");
const STAMP = new Date(NOW).toISOString();

test("№ 87: крок бази — при якому база × (1 − знижка) ціла (20 % → 5 грн)", () => {
  assert.equal(wholeStep(20), 5);
  assert.equal(wholeStep(10), 10);
  assert.equal(wholeStep(25), 4);
  assert.equal(wholeStep(0), 1);
});

test("№ 87: конфіг увімкнено (whole), решта формули без змін", () => {
  assert.equal(CONFIG.pricing.whole, true);
  assert.deepEqual({ ...CONFIG.pricing, whole: undefined }, { ...DEFAULT_PRICING, whole: undefined });
});

test("№ 87: база кратна 5, кінцева = база × 0,8 ціла; вниз на 0–3,99 грн від формули з копійками; не нижче РРЦ — і в наявності, і без", () => {
  for (const price of [1, 7, 100, 1476, 1596, 1855, 3995, 4381, 11248.75, 15777.05, 58794, 99999]) for (const av of [true, false]) {
    const old = mtPrices(price, av, DEFAULT_PRICING), p = mtPrices(price, av, W);
    assert.equal(p.base % 5, 0, `база ${p.base} (${price})`);
    assert.ok(Number.isInteger(p.final), `кінцева ${p.final} (${price})`);
    assert.equal(p.final, p.base * 0.8);
    const down = Math.round((old.final - p.final) * 100) / 100;
    assert.ok(down >= 0 && down < 4, `${price}: ${old.final} → ${p.final}`);
    assert.ok(p.final >= price, `${price}: не нижче РРЦ`);
    assert.deepEqual([p.discount, p.availability], [old.discount, old.availability]);
  }
  // Приклади: 4381 + 5 = 4386 → база 5482,5 → 5480, кінцева 4384; рівно кратне — без втрат (4000 → 5000 / 4000).
  assert.deepEqual([mtPrices(4381, true, W).base, mtPrices(4381, true, W).final], [5480, 4384]);
  assert.deepEqual([mtPrices(3995, true, W).base, mtPrices(3995, true, W).final], [5000, 4000]);
});

test("№ 87: без прапорця — точно як раніше (з копійками)", () => {
  for (const price of [100, 1855, 15777.05]) for (const av of [true, false]) {
    assert.deepEqual(mtPrices(price, av, { ...DEFAULT_PRICING, whole: false }), mtPrices(price, av, DEFAULT_PRICING));
  }
  assert.equal(mtPrices(4381, true, DEFAULT_PRICING).base, 5482.5);
});

test("№ 87: ProSale — округлення вниз від ціни з націнкою тарифу; ціни власника — як нова РРЦ, теж без копійок", () => {
  const ps = { k: 2, rate: 5 };
  for (const price of [999, 4381, 25717]) {
    const raw = prosaleFinal(price + 5, ps), p = mtPrices(price, true, W, ps);
    assert.equal(p.base % 5, 0);
    assert.ok(raw - p.final >= 0 && raw - p.final < 4, `${raw} → ${p.final}`);
  }
  const m = rowPrices({ [MANUAL_PRICE_COLUMN]: "2000", [MANUAL_ANCHOR_COLUMN]: "1800" }, 1800, true, W);
  assert.deepEqual([m.rule.kind, m.base, m.final], ["manual", 2505, 2004]);
});

test("№ 87: захист «не нижче РРЦ» — якби +5 не перекривало округлення, крок угору", () => {
  const tight = { ...W, extra: 1 };
  const p = mtPrices(1002, true, tight); // 1003 × 1,25 = 1253,75 → 1250 / 1000 < 1002 → 1255 / 1004
  assert.deepEqual([p.base, p.final], [1255, 1004]);
});

async function world() {
  const s = generateSynthetic({ products: 12, queue: 0, deferred: 0, newOffers: 0, seed: 11, now: NOW });
  const h = s.sheets["Основний каталог"][0];
  const rows = s.sheets["Основний каталог"].slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])));
  const r = rows.find((x) => x["Наявність"] === "+" && x["Стан синхронізації"] === "ЗІСТАВЛЕНО" && x["Статус імпорту"] === "ДОЗВОЛЕНО");
  const parsed = await parseSupplierText(s.supplierXml(), { maximumChars: 45_000_000, identityFields: true });
  const offers = parsed.offers instanceof Map ? parsed.offers : new Map(Object.entries(parsed.offers));
  return { r, offers, groupMap: groupsForYml(objectsFromValues(s.groups, GROUP_HEADERS)).groupMap };
}
const apply = (row, p) => Object.fromEntries(Object.entries(row).map(([k, v]) => { const i = LIVE_COLUMNS.indexOf(k); return [k, i >= 0 ? p.next[i] : v]; }));
const opt = (r, groupMap, pricing) => ({ success: new Date(r["Оновлено"]).getTime(), groupMap, pricing, missingPolicy: "unavailable", conflictPolicy: "isolate", inStock: true });

test("№ 87: «Ціни» (planRows) пишуть цілі ціни; фід приймає рядок і ставить <price> без копійок", async () => {
  const w = await world();
  const [p] = planRows([w.r], w.offers, STAMP, W);
  const row = apply(w.r, p);
  assert.equal(Number(row["Ціна"]) % 5, 0);
  assert.ok(Number.isInteger(Number(row["Ціна кінцева"])));
  const o = renderOffer(row, opt(row, w.groupMap, W));
  assert.equal(o.kind, "published");
  assert.ok(o.xml.includes("<price>" + Number(row["Ціна"]).toFixed(2) + "</price><discount>20%</discount>"));
  assert.equal(patchOfferLive(o.xml, row, { pricing: W, inStock: true }), o.xml);
  assert.throws(() => renderOffer({ ...row, "Ціна кінцева": Number(row["Ціна кінцева"]) - 1 }, opt(row, w.groupMap, W)), /не відповідають погодженій формулі/);
});

test("№ 87: перехідний стан — рядок ще з копійками (до перерахунку «Цінами»): фід приймає чинні ціни, не ізолює товар", async () => {
  const w = await world();
  const [p] = planRows([w.r], w.offers, STAMP, DEFAULT_PRICING);
  const legacy = apply(w.r, p);
  const o = renderOffer(legacy, opt(legacy, w.groupMap, W));
  assert.equal(o.kind, "published");
  assert.ok(!o.issue);
  assert.ok(o.xml.includes("<price>" + Number(legacy["Ціна"]).toFixed(2) + "</price>"), "у фіді — ціна рядка (як у таблиці)");
  assert.equal(patchOfferLive(o.xml, legacy, { pricing: W, inStock: true }), o.xml);
  // Наступні «Ціни» перерахують рядок у цілі ціни.
  const [q] = planRows([legacy], w.offers, STAMP, W);
  const next = apply(legacy, q);
  assert.equal(Number(next["Ціна"]) % 5, 0);
  assert.ok(Number(next["Ціна кінцева"]) <= Number(legacy["Ціна кінцева"]));
});
