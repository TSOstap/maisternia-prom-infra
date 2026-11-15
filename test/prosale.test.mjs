/** ProSale (рішення власника 04.11.2026): націнка, що перекриває додаткову комісію Prom на дорожчому тарифі. Мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { mtPrices, DEFAULT_PRICING } from "../src/core/pricing.mjs";
import { prosaleCommission, prosaleFinal, prosaleFor, TARIFFS, PROSALE_TARIFF_COLUMN } from "../src/core/prosale.mjs";
import { renderOffer, patchOfferLive, groupsForYml, objectsFromValues, GROUP_HEADERS } from "../src/core/yml.mjs";
import { planRows, readSheet } from "../src/core/sync-plan.mjs";
import RATES from "../config/prosale-rates.json" with { type: "json" };

const NOW = Date.parse("2026-11-04T12:00:00Z");
const MAIN = "Основний каталог";

test("комісія Prom = ставка × ціна до 10 000 + 1 % понад (Економ); реальне списання 03.11: 24 004 грн, 5,14 % → 653,54 грн", () => {
  assert.ok(Math.abs(prosaleCommission(24004, 5.14, 1) - 653.54) < 1);
  assert.equal(prosaleCommission(1000, 5, 1), 50);
  assert.equal(prosaleCommission(1000, 5, TARIFFS["турбо"]), 150);
  assert.deepEqual(TARIFFS, { "економ": 1, "звичайний": 2, "більше продажів": 2.5, "турбо": 3 });
});

test("націнка: після комісії лишається не менше, ніж на Економі (100 грн, 5 % → Турбо 111,76); копійки вгору", () => {
  for (const [P0, rate] of [[100, 5], [8691.25, 5.18], [24004, 5.14], [9999, 7.5], [10000, 12.5]]) {
    for (const k of [2, 2.5, 3]) {
      const P1 = prosaleFinal(P0, { k, rate });
      const keep0 = P0 - prosaleCommission(P0, rate, 1), keep1 = P1 - prosaleCommission(P1, rate, k);
      assert.ok(keep1 >= keep0 - 1e-9, `${P0} ${rate} ${k}`);
      assert.ok(keep1 - keep0 < 0.05, "не більше копійок зверху");
      assert.equal(Math.round(P1 * 100) / 100, P1);
    }
  }
  assert.equal(prosaleFinal(100, { k: 3, rate: 5 }), 111.77);
});

test("тариф рядка: порожній / Економ / невідомий / категорія «за перехід» або без ставки — без націнки; ціна точно як раніше", () => {
  const order = Object.entries(RATES.categories).find(([, c]) => Number.isFinite(c.order))[0];
  const click = Object.entries(RATES.categories).find(([, c]) => Number.isFinite(c.click))?.[0];
  for (const t of ["", "Економ", "економ ", "Супер"]) assert.equal(prosaleFor({ [PROSALE_TARIFF_COLUMN]: t, "Категорія Prom ID": order }), null);
  if (click) assert.equal(prosaleFor({ [PROSALE_TARIFF_COLUMN]: "Турбо", "Категорія Prom ID": click }), null);
  assert.equal(prosaleFor({ [PROSALE_TARIFF_COLUMN]: "Турбо", "Категорія Prom ID": "999999999" }), null);
  assert.deepEqual(prosaleFor({ [PROSALE_TARIFF_COLUMN]: "Турбо", "Категорія Prom ID": order }), { k: 3, rate: RATES.categories[order].order });
  assert.deepEqual(mtPrices(1000, true, DEFAULT_PRICING, null), mtPrices(1000, true, DEFAULT_PRICING));
  const t = mtPrices(1000, true, DEFAULT_PRICING, { k: 3, rate: 5 });
  assert.ok(t.final > 1005 && t.base === Math.round(t.final * 1.25 * 100) / 100 && t.discount === "20%");
});

function synth() {
  const s = generateSynthetic({ products: 12, queue: 0, deferred: 0, newOffers: 0, seed: 5, now: NOW });
  const h = s.sheets[MAIN][0];
  const order = Object.entries(RATES.categories).find(([, c]) => Number.isFinite(c.order))[0];
  const rows = s.sheets[MAIN].slice(1).map((r) => ({ ...Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])), "Категорія Prom ID": order }));
  return { s, rows, order, groupMap: groupsForYml(objectsFromValues(s.groups, GROUP_HEADERS)).groupMap };
}
const opt = (r, groupMap) => ({ success: new Date(r["Оновлено"]).getTime(), groupMap, pricing: DEFAULT_PRICING, missingPolicy: "unavailable", conflictPolicy: "isolate", inStock: true });

test("фід: тариф змінено, «Ціни» ще не перерахували — offer за чинними цінами рядка (не «немає в наявності»); після перерахунку — ціна з націнкою", () => {
  const { rows, groupMap } = synth();
  const r = rows.find((x) => x["Наявність"] === "+" && x["Стан синхронізації"] === "ЗІСТАВЛЕНО" && x["Статус імпорту"] === "ДОЗВОЛЕНО");
  assert.ok(r);
  const before = renderOffer(r, opt(r, groupMap));
  assert.equal(before.kind, "published");
  // Власник поставив «Турбо», ціни в рядку ще старі.
  const t = { ...r, [PROSALE_TARIFF_COLUMN]: "Турбо" };
  const mid = renderOffer(t, opt(t, groupMap));
  assert.equal(mid.kind, "published"); assert.equal(mid.xml, before.xml);
  assert.equal(patchOfferLive(before.xml, t, { pricing: DEFAULT_PRICING, inStock: true }), before.xml);
  // «Ціни» записали ціни з націнкою.
  const p = mtPrices(Number(r["Ціна постачальника"]), true, DEFAULT_PRICING, prosaleFor(t));
  const after = { ...t, "Ціна": p.base, "Ціна кінцева": p.final };
  const x = renderOffer(after, opt(after, groupMap));
  assert.equal(x.kind, "published");
  assert.match(x.xml, new RegExp("<price>" + p.base.toFixed(2).replace(".", "\\.") + "</price>"));
  assert.notEqual(x.xml, before.xml);
  // Ціни, що не відповідають жодному варіанту формули, — як і раніше помилка (ізоляція рядка).
  const bad = { ...t, "Ціна кінцева": p.final + 1 };
  assert.throws(() => renderOffer(bad, opt(bad, groupMap)), /не відповідають погодженій формулі/);
});

test("«Ціни й наявність» (sync-plan): рядок із тарифом — нова ціна з націнкою; без тарифу — без змін", () => {
  const { s, rows } = synth();
  const h = [...s.sheets[MAIN][0], "Категорія Prom ID", PROSALE_TARIFF_COLUMN].filter((k, i, a) => a.indexOf(k) === i);
  const ri = rows.findIndex((x) => x["Наявність"] === "+" && x["Стан синхронізації"] === "ЗІСТАВЛЕНО");
  const values = [h, ...rows.map((r, i) => h.map((k) => (k === PROSALE_TARIFF_COLUMN ? (i === ri ? "Турбо" : "") : r[k] ?? "")))];
  const offers = new Map(rows.map((r) => [String(r["ID постачальника"]), { id: String(r["ID постачальника"]), price: Number(r["Ціна постачальника"]), available: r["Наявність"] === "+", quantity: "", sku: r["Артикул постачальника"], name: r["Назва постачальника RU"], nameUa: r["Назва постачальника UA"], url: r["URL постачальника"] }]));
  const sheet = readSheet(values);
  const plan = planRows(sheet.rows, (sid) => offers.get(sid), "2026-11-04 12:00:00", DEFAULT_PRICING);
  const turbo = plan[ri], plain = plan.find((p, i) => i !== ri && p.match === "ЗІСТАВЛЕНО" && rows[i]["Наявність"] === "+");
  if (turbo.match === "ЗІСТАВЛЕНО") {
    const exp = mtPrices(Number(rows[ri]["Ціна постачальника"]), true, DEFAULT_PRICING, prosaleFor({ ...rows[ri], [PROSALE_TARIFF_COLUMN]: "Турбо" }));
    assert.equal(turbo.next[2], exp.final); assert.ok(exp.final > Number(rows[ri]["Ціна постачальника"]) + 5);
  }
  if (plain) { const i = plan.indexOf(plain); assert.equal(plain.next[2], mtPrices(Number(rows[i]["Ціна постачальника"]), true, DEFAULT_PRICING).final); }
});

test("тарифи категорій (аркуш «Тарифи ProSale»): категорія «Турбо» → націнка всім її товарам; тариф товару має перевагу; без аркуша — як раніше", async () => {
  const { withProsale, PROSALE_SHEET_HEADER } = await import("../src/core/prosale.mjs");
  const { prosaleSheetRows } = await import("../src/pipeline/prosale-columns.mjs");
  const order = Object.entries(RATES.categories).find(([, c]) => Number.isFinite(c.order))[0];
  const sheet = [PROSALE_SHEET_HEADER.slice(), [order, "x", "за замовлення", "5%", 3, "Турбо", "", "", ""], ["999", "y", "", "", 1, "Економ", "", "", ""]];
  const p = withProsale(DEFAULT_PRICING, sheet);
  assert.deepEqual(p.prosaleCategories, { [order]: "Турбо" });
  assert.equal(withProsale(DEFAULT_PRICING, undefined), DEFAULT_PRICING);
  assert.deepEqual(prosaleFor({ "Категорія Prom ID": order }, p), { k: 3, rate: RATES.categories[order].order });
  assert.equal(prosaleFor({ "Категорія Prom ID": order, [PROSALE_TARIFF_COLUMN]: "Економ" }, p), null, "товар виведено з кампанії");
  assert.deepEqual(prosaleFor({ "Категорія Prom ID": order, [PROSALE_TARIFF_COLUMN]: "Звичайний" }, p), { k: 2, rate: RATES.categories[order].order });
  assert.equal(prosaleFor({ "Категорія Prom ID": order }, DEFAULT_PRICING), null);
  // Рядки аркуша: ставка й готова націнка для кожного тарифу; «за перехід» і невідома ставка — без націнки.
  const rows = prosaleSheetRows([["Offer ID", "Категорія Prom ID"], ["1", order], ["2", order], ["3", "999999999"]]);
  assert.equal(rows[0][0], order); assert.equal(rows[0][4], 2); assert.match(rows[0][8], /^\d+(\.\d+)?%$/);
  assert.equal(rows[1][2], "ставка невідома"); assert.equal(rows[1][8], "—");
  assert.equal(rows[0].length, PROSALE_SHEET_HEADER.length);
});

test("04.11: «Тарифи ProSale» — лише «за замовлення», «Турбо» обраним категоріям; запис на місці, хвіст очищено; повтор — NOTHING; невідома категорія — BLOCKED", async () => {
  const { prosaleTariffPlan, applyProsaleTariffs } = await import("../src/pipeline/prosale-columns.mjs");
  const H = ["Категорія Prom ID", "Категорія Prom", "Комісія", "Ставка Економ", "Товарів", "Тариф", "Націнка Звичайний %", "Націнка Більше продажів %", "Націнка Турбо %"];
  let sheet = [H,
    ["410402", "Електрогенератори", "за замовлення", "5.52%", 144, "", "6.21%", "9.61%", "13.23%"],
    ["4305", "Фуганки", "за перехід 1.27 грн", "", 17, "", "—", "—", "—"],
    ["14400105", "Зварювальні напівавтомати", "за замовлення", "4.72%", 71, "", "5.21%", "8.03%", "11%"],
    ["240432", "", "ставка невідома", "", 12, "", "—", "—", "—"],
    ["141717", "Шліфувальні машини", "за замовлення", "5.56%", 390, "Більше продажів", "6.26%", "9.69%", "13.35%"]];
  const set = { "410402": "Турбо", "14400105": "Турбо" };
  const p = prosaleTariffPlan(sheet, { set });
  assert.deepEqual(p.removed, ["4305", "240432"]);
  assert.deepEqual(p.values.map((r) => [r[0], r[5]]), [["410402", "Турбо"], ["14400105", "Турбо"], ["141717", "Більше продажів"]], "тариф власника інших категорій збережено");
  assert.throws(() => prosaleTariffPlan(sheet, { set: { "410402": "Супер" } }), /невідомий тариф/);
  const writes = [], journal = [];
  const sheets = {
    async updateRanges(list) { for (const u of list) { writes.push(u); u.values.forEach((row, i) => { sheet[u.row - 1 + i] = row.slice(); }); } },
    async appendRows(title, rows) { journal.push(...rows); },
  };
  const readBook = async () => ({ "Тарифи ProSale": sheet.map((r) => r.slice()) });
  const r = await applyProsaleTariffs({ sheets, readBook, stamp: "2026-11-04", set });
  assert.equal(r.state, "PROSALE_TARIFFS_SET"); assert.equal(r.kept, 3); assert.equal(r.removed, 2);
  assert.equal(writes.length, 1); assert.equal(writes[0].row, 2);
  assert.deepEqual(sheet[4], Array(9).fill("")); assert.deepEqual(sheet[5], Array(9).fill(""), "звільнений хвіст очищено");
  assert.equal(journal.length, 1);
  assert.equal((await applyProsaleTariffs({ sheets, readBook, stamp: "x", set })).state, "NOTHING");
  assert.equal((await applyProsaleTariffs({ sheets, readBook, stamp: "x", set: { "4305": "Турбо" } })).state, "BLOCKED", "категорія «за перехід» — не ставиться");
});

test("15.11: нові категорії каталогу дописуються в «Тарифи ProSale» (add) із тарифом; «за перехід» / невідома — BLOCKED; повтор — NOTHING", async () => {
  const { prosaleTariffPlan, applyProsaleTariffs } = await import("../src/pipeline/prosale-columns.mjs");
  const { PROSALE_SHEET_HEADER, withProsale } = await import("../src/core/prosale.mjs");
  let sheet = [PROSALE_SHEET_HEADER.slice(), ["410402", "Електрогенератори", "за замовлення", "5.52%", 144, "Економ", "6.21%", "9.61%", "13.23%"]];
  const set = { "410402": "Звичайний", "14171602": "Звичайний" };
  const p = prosaleTariffPlan(sheet, { set, add: { "14171602": 1, "410402": 7 } });
  assert.deepEqual(p.added, ["14171602"], "наявна категорія не дублюється");
  assert.deepEqual(p.missing, []);
  assert.deepEqual(p.values[1].slice(0, 6), ["14171602", RATES.categories["14171602"].name, "за замовлення", `${RATES.categories["14171602"].order}%`, 1, "Звичайний"]);
  assert.deepEqual(withProsale(DEFAULT_PRICING, [PROSALE_SHEET_HEADER.slice(), ...p.values]).prosaleCategories, set);
  assert.deepEqual(prosaleTariffPlan(sheet, { set: {}, add: { "4305": 3 } }).missing, ["4305"], "«за перехід» не дописується");
  const sheets = {
    async updateRanges(list) { for (const u of list) u.values.forEach((row, i) => { sheet[u.row - 1 + i] = row.slice(); }); },
    async appendRows() {},
  };
  const readBook = async () => ({ "Тарифи ProSale": sheet.map((r) => r.slice()) });
  const r = await applyProsaleTariffs({ sheets, readBook, stamp: "2026-11-15", set, add: { "14171602": 1 } });
  assert.equal(r.state, "PROSALE_TARIFFS_SET"); assert.equal(r.added, 1); assert.equal(sheet.length, 3);
  assert.equal((await applyProsaleTariffs({ sheets, readBook, stamp: "x", set, add: { "14171602": 1 } })).state, "NOTHING");
  assert.equal((await applyProsaleTariffs({ sheets, readBook, stamp: "x", set: {}, add: { "999999999": 1 } })).state, "BLOCKED");
});
