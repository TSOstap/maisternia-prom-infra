/** Паритет з чинною системою: справжній LIVE-код Apps Script проти Node-порту на тих самих даних. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadLiveAppsScript, plain } from "./helpers/apps-script-vm.mjs";
import { mtPrices, mtSameDiscount } from "../src/core/pricing.mjs";
import { parseSupplierText, validateFeed } from "../src/core/supplier-feed.mjs";
import { matchOffer, planRows, LIVE_COLUMNS } from "../src/core/sync-plan.mjs";
import { buildYml, memorySink, objectsFromValues } from "../src/core/yml.mjs";
import { GROUP_HEADERS, YML_HEADERS } from "../src/core/seal.mjs";
import { generateSynthetic, prng } from "../src/synth/generator.mjs";
import config from "../config/default.json" with { type: "json" };

const gas = loadLiveAppsScript();
const NOW = Date.parse("2026-10-21T09:00:00.000Z");

test("LIVE mtSelfTest проходить у VM (заглушки коректні)", () => {
  gas.MTY.count = 5029; // самоперевірка LIVE жорстко очікує 5029
  assert.equal(gas.mtSelfTest(), true);
});

test("mtPrices: 20 000 випадкових цін × наявність — ідентично LIVE", () => {
  const rand = prng(7);
  for (let i = 0; i < 20000; i++) {
    const price = i < 50 ? [0.01, 0.005, 1, 99.99, 100, 104.995, 1234.565, 0.1 + 0.2][i % 8] : Math.round(rand() * 5_000_000) / 100;
    for (const available of [true, false]) {
      let a, b, ea, eb;
      try { a = plain(gas.mtPrices(price, available)); } catch (e) { ea = e.message; }
      try { b = mtPrices(price, available, config.pricing); } catch (e) { eb = e.message; }
      assert.deepEqual(b, a, `price=${price}`);
      assert.equal(eb, ea);
    }
  }
  for (const bad of [0, -1, NaN, Infinity, "100", null]) assert.throws(() => mtPrices(bad, true), /Невалідні/);
});

test("mtSameDiscount_: ті самі рішення, що LIVE", () => {
  const cases = ["", null, "20%", " 20%", "0,2", 0.2, 0.2000000001, 20, "20.0%", "10%", 0];
  for (const a of cases) for (const b of cases) assert.equal(mtSameDiscount(a, b), gas.mtSameDiscount_(a, b), `${a} vs ${b}`);
});

test("mtParse: однакові offer/count/date на синтетичному фіді", async () => {
  const s = generateSynthetic({ products: 300, queue: 20, deferred: 5, newOffers: 7, seed: 3, now: NOW });
  const xml = s.supplierXml();
  const live = plain(gas.mtParse(xml));
  const mine = await parseSupplierText(xml);
  assert.equal(mine.count, live.count);
  assert.equal(mine.date, live.date);
  assert.deepEqual(plain(Object.fromEntries(mine.offers)), live.offers);
  // Потоковий режим: дрібні шматки з розривами всередині тегів дають той самий результат.
  const chunks = [];
  for (let i = 0; i < xml.length; i += 97) chunks.push(xml.slice(i, i + 97));
  const streamed = await (await import("../src/core/supplier-feed.mjs")).parseSupplierFeed(chunks);
  assert.deepEqual(plain(Object.fromEntries(streamed.offers)), live.offers);
});

test("mtParse: ті самі відмови на пошкоджених фідах", async () => {
  const ok = '<?xml version="1.0"?><yml_catalog date="2026-10-21 10:00"><shop><offers><offer id="1" available="true"><price>1</price></offer></offers></shop></yml_catalog>';
  const bad = [
    ok.replace("</yml_catalog>", ""),
    ok.replace('id="1"', 'id="x"'),
    ok.replace("</offers>", '<offer id="1" available="true"><price>1</price></offer></offers>'),
    '<!DOCTYPE yml_catalog SYSTEM "a" [<!ENTITY x "y">]>' + ok.replace('<?xml version="1.0"?>', ""),
    ok.replace("<offers>", "").replace("</offers>", ""),
    ok.replace("</offer>", '<offer id="2"></offer>'),
  ];
  for (const xml of bad) {
    let live, mine;
    try { gas.mtParse(xml); } catch (e) { live = e.message; }
    try { await parseSupplierText(xml); } catch (e) { mine = e.message; }
    assert.ok(live, "LIVE мав відмовити: " + xml.slice(0, 80));
    assert.equal(mine, live);
  }
});

test("mtValidateFeed: ті самі рішення щодо кількості й віку", () => {
  const date = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 16);
  const cases = [
    [{ count: 5000, date: date(NOW - 3600000) }, 5100],
    [{ count: 4000, date: date(NOW) }, 0],
    [{ count: 5000, date: date(NOW) }, 7000],
    [{ count: 5000, date: date(NOW - 49 * 3600000) }, 0],
    [{ count: 5000, date: date(NOW + 3 * 3600000) }, 0],
    [{ count: 5000, date: "" }, 0],
    [{ count: 5000, date: date(Date.parse("2026-12-15T10:00:00Z")) }, 0, Date.parse("2026-12-15T12:00:00Z")],
  ];
  for (const [parsed, prev, now = NOW] of cases) {
    let live, mine;
    try { gas.mtValidateFeed(parsed, prev, now); } catch (e) { live = e.message; }
    try { validateFeed(parsed, prev, now, config.supplier); } catch (e) { mine = e.message; }
    if (live && /Unparseable/.test(live)) live = "Немає дати YML"; // LIVE кидає помилку Utilities замість власного тексту
    assert.equal(mine, live, JSON.stringify(parsed));
  }
});

test("mtMatch + mtPlan: однакові статуси та F:M, включно з відсутніми й конфліктами", async () => {
  const ids = (n) => String(1500000000 + n * 7);
  const s = generateSynthetic({ products: 400, queue: 30, seed: 11, now: NOW, missingFromSupplier: [ids(5), ids(50)], identityConflicts: [ids(7), ids(77)] });
  const xml = s.supplierXml()
    .replace(`<offer id="${ids(9)}" available="true">`, `<offer id="${ids(9)}" available="maybe">`)
    .replace(`<offer id="${ids(9)}" available="false">`, `<offer id="${ids(9)}" available="maybe">`)
    .replace(new RegExp(`(<offer id="${ids(11)}"[^>]*>[\\s\\S]*?<currencyId>)UAH`), "$1USD")
    .replace(new RegExp(`(<offer id="${ids(13)}"[^>]*>[\\s\\S]*?<quantity_in_stock>)`), "$1abc");
  const liveParsed = gas.mtParse(xml);
  const mine = await parseSupplierText(xml);
  const rows = s.sheets["Основний каталог"].slice(1).map((r) => Object.fromEntries(YML_HEADERS.map((k, i) => [k, r[i]])));
  rows[20]["Артикул постачальника"] = "INTENTIONAL-CONFLICT";
  rows[21]["Назва постачальника UA"] = ""; rows[21]["Назва постачальника RU"] = "";
  rows[22]["Знижка"] = 0.2;
  for (const r of rows) assert.equal(matchOffer(r, mine.offers.get(r["ID постачальника"])), gas.mtMatch(r, liveParsed.offers[r["ID постачальника"]]));
  const stamp = new Date(NOW).toISOString();
  const live = plain(gas.mtPlan(rows, liveParsed, stamp));
  const ours = plain(planRows(rows, mine.offers, stamp, config.pricing));
  assert.deepEqual(ours, live);
  const statuses = new Set(ours.map((p) => p.match));
  for (const st of ["ЗІСТАВЛЕНО", "ВІДСУТНІЙ_У_YML", "ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ", "КОНФЛІКТ_АРТИКУЛА", "НЕМАЄ_ОПОРНОЇ_НАЗВИ", "НЕВІДОМА_НАЯВНІСТЬ", "НЕВІДОМА_ВАЛЮТА", "НЕВАЛІДНА_КІЛЬКІСТЬ"]) {
    assert.ok(statuses.has(st), "сценарій не покрито: " + st);
  }
});

async function buildBoth(s, mutate) {
  const stamp = new Date(NOW).toISOString();
  const parsed = await parseSupplierText(s.supplierXml());
  const values = s.sheets["Основний каталог"];
  const header = values[0];
  const rows = values.slice(1).map((r) => Object.fromEntries(header.map((k, i) => [k, r[i]])));
  const plan = planRows(rows, parsed.offers, stamp, config.pricing);
  const updated = [header, ...rows.map((r, i) => header.map((k) => { const j = LIVE_COLUMNS.indexOf(k); return j >= 0 ? plan[i].next[j] : r[k]; }))];
  if (mutate) mutate(updated);
  const meta = { syncState: "OK", lastSuccess: stamp, now: new Date(NOW + 60000).toISOString() };
  const m = s.manifestMain;
  Object.assign(gas.MTY, { count: m.count, idsSha: m.idsSha, contentSha: m.contentSha, groupsSha: m.groupsSha });
  let live, liveError;
  try { live = gas.mtBuildYml_(updated, s.groups, meta); } catch (e) { liveError = e.message; }
  const sink = memorySink();
  let mine, mineError;
  try {
    mine = await buildYml({
      rows: objectsFromValues(updated, YML_HEADERS), groups: objectsFromValues(s.groups, GROUP_HEADERS), meta, manifest: m,
      config: config.yml, pricing: config.pricing, maximumBytes: 50_000_000, sink,
    });
  } catch (e) { mineError = e.message; }
  return { live, liveError, mine, mineError, xml: sink.text() };
}

test("mtBuildYml_: XML байт-у-байт, SHA, байти, sourceDigest — ідентичні LIVE", async () => {
  const s = generateSynthetic({ products: 250, queue: 10, seed: 5, now: NOW });
  const { live, liveError, mine, mineError, xml } = await buildBoth(s);
  assert.equal(liveError, undefined, liveError);
  assert.equal(mineError, undefined, mineError);
  assert.equal(xml, live.xml);
  assert.equal(mine.sha256, live.sha256);
  assert.equal(mine.bytes, live.bytes);
  assert.equal(mine.sourceDigest, live.sourceDigest);
  assert.equal(mine.count, live.count);
  assert.equal(mine.generatedAt, live.generatedAt);
});

test("mtBuildYml_: ті самі відмови (відсутній товар, зміна печатки, ціна, порожній опис, фото)", async () => {
  const s = generateSynthetic({ products: 60, seed: 9, now: NOW, missingFromSupplier: [] });
  const col = (name) => YML_HEADERS.indexOf(name);
  const mutations = [
    (v) => { v[3][col("Стан синхронізації")] = "ВІДСУТНІЙ_У_YML"; },
    (v) => { v[4][col("Опис UA")] += " змінено"; },
    (v) => { v[5][col("Ціна")] = 1; },
    (v) => { v[6][col("Фото JSON")] = "[]"; },
    (v) => { v.splice(7, 1); },
    (v) => { v[8][col("Оновлено")] = "2026-10-20T00:00:00.000Z"; },
    (v) => { v[9][col("Знижка")] = "15%"; },
  ];
  for (const mutate of mutations) {
    const r = await buildBoth(s, mutate);
    assert.ok(r.liveError, "LIVE мав відмовити");
    assert.equal(r.mineError, r.liveError);
  }
  // Відсутній у фіді постачальника товар блокує ВЕСЬ фід (чинна поведінка, задокументована як ризик R1).
  const missing = generateSynthetic({ products: 40, seed: 2, now: NOW, missingFromSupplier: [String(1500000000 + 3 * 7)] });
  const r = await buildBoth(missing);
  assert.match(r.liveError, /Непідтверджений статус/);
  assert.equal(r.mineError, r.liveError);
});
