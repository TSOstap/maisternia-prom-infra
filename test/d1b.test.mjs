/** Рішення D1b (власник, 21.10.2026): конфлікт однієї картки ізолює лише її, а не весь YML. */
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate } from "../src/pipeline/update.mjs";
import { manifestKey } from "../src/publish/publisher.mjs";
import { buildYml, memorySink } from "../src/core/yml.mjs";
import { YML_HEADERS } from "../src/core/seal.mjs";
import { verifyYmlStream } from "../src/core/xml-verify.mjs";
import { formatYmlDate } from "../src/core/time.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const T0 = Date.parse("2026-10-21T06:00:00.000Z");
const H = 3600000;
const DAY = 24 * H;
const id = (n) => String(1500000000 + n * 7);

async function setup(opts = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-d1b-"));
  const s = generateSynthetic({ products: 120, queue: 12, deferred: 4, newOffers: opts.newOffers ?? 0, seed: 41, now: T0 });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  if (opts.frozen) await fsp.writeFile(path.join(dir, "catalog", "sheets", "Заморожені ID.ndjson"), [["Offer ID"], ...opts.frozen.map((x) => [x])].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const supplierFile = path.join(dir, "supplier.xml");
  const baseXml = s.supplierXml();
  await fsp.writeFile(supplierFile, baseXml);
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = structuredClone(baseConfig);
  config.supplier.minimumOffers = 10;
  config.policy.anomaly.maxNewlyMissing = 5;
  if (opts.config) opts.config(config);
  const run = (now = T0) => runUpdate({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(supplierFile), now: () => now, tmpDir: dir });
  const setXml = (fn) => fsp.writeFile(supplierFile, fn(baseXml));
  const yml = async () => {
    const m = await store.getJson(manifestKey("main"));
    return (await store.getBuffer(m.active.key)).toString("utf8");
  };
  const row = (oid) => {
    const r = s.sheets["Основний каталог"].find((x) => x[0] === oid);
    return Object.fromEntries(YML_HEADERS.map((k, i) => [k, r[i]]));
  };
  return { s, store, config, run, setXml, yml, row, baseXml };
}

/** Змінити рядок offer у фіді. */
const edit = (xml, oid, fn) => xml.split("\n").map((l) => (l.startsWith(`<offer id="${oid}"`) ? fn(l) : l)).join("\n");
const offerOf = (xml, oid) => (new RegExp(`<offer id="${oid}"[^>]*>[\\s\\S]*?</offer>`).exec(xml) || [""])[0];
const setTag = (tag, value) => (l) => l.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), `<${tag}>${value}</${tag}>`);
const events = async (store) => {
  const keys = await store.list("journal/conflicts/");
  return (await Promise.all(keys.map((k) => store.getJson(k)))).flat();
};

test("п.1–4, 6: конфлікт артикула ізолює лише одну картку — «немає в наявності», остання перевірена ціна і контент збережені, подію записано", async () => {
  const { run, setXml, yml, store, row } = await setup();
  await setXml((x) => edit(x, id(4), setTag("vendorCode", "INTRUDER-1")));
  const r = await run();
  assert.equal(r.sync.state, "OK");
  assert.equal(r.feeds[0].state, "PUBLISHED", JSON.stringify(r.feeds));
  assert.equal(r.feeds[0].count, 120);
  assert.equal(r.feeds[0].isolatedConflicts, 1);
  const card = row(id(4));
  const offer = offerOf(await yml(), id(4));
  assert.match(offer, /available="false"/);
  assert.match(offer, new RegExp(`<price>${card["Ціна"].toFixed(2)}</price>`), "ціна = остання перевірена Base");
  assert.ok(offer.includes(card["Назва UA"].split(" — ")[0]) && offer.includes("<description_ua>"), "назва та опис збережені");
  const op = await store.getJson("state/operational.json");
  assert.deepEqual(op.rows[id(4)].slice(0, 7), [card["Ціна постачальника"], card["Ціна"], card["Ціна кінцева"], "", "-", "", "КОНФЛІКТ_АРТИКУЛА"]);
  const ev = await events(store);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].event, ev[0].offerId, ev[0].reason], ["OPENED", id(4), "КОНФЛІКТ_АРТИКУЛА"]);
  assert.equal(ev[0].old.sku, card["Артикул постачальника"]);
  assert.equal(ev[0].new.sku, "INTRUDER-1");
  assert.ok(ev[0].at);
  const rep = await store.getJson("reports/conflicts/latest.json");
  assert.equal(rep.open, 1);
});

test("п.1: невалідна ціна, чужа валюта, зміна назви/комплекту — кожен ізолюється окремо, фід публікується", async () => {
  const { run, setXml, yml, store, row } = await setup();
  await setXml((x) => {
    x = edit(x, id(4), setTag("price", "0"));
    x = edit(x, id(5), setTag("currencyId", "USD"));
    x = edit(x, id(6), (l) => l.replace(/<name_ua>([^<]*)<\/name_ua>/, "<name_ua>$1 + 2 АКБ</name_ua>"));
    return x;
  });
  const r = await run();
  assert.equal(r.feeds[0].state, "PUBLISHED");
  assert.equal(r.feeds[0].isolatedConflicts, 3);
  const rep = await store.getJson("reports/conflicts/latest.json");
  assert.deepEqual(rep.byReason, { "НЕВАЛІДНА_ЦІНА": 1, "НЕВІДОМА_ВАЛЮТА": 1, "ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ": 1 });
  const xml = await yml();
  for (const n of [4, 5, 6]) {
    assert.match(offerOf(xml, id(n)), /available="false"/);
    assert.match(offerOf(xml, id(n)), new RegExp(`<price>${row(id(n))["Ціна"].toFixed(2)}</price>`));
  }
});

test("п.8: після виправлення конфлікту — та сама картка, звичайне оновлення, подія RESOLVED", async () => {
  const { run, setXml, store, baseXml, yml } = await setup();
  await setXml((x) => edit(x, id(4), setTag("vendorCode", "INTRUDER-1")));
  await run(T0);
  await setXml(() => edit(baseXml, id(4), setTag("price", "1000")));
  const r = await run(T0 + 4 * H);
  assert.equal(r.conflicts.resolved, 1);
  const op = await store.getJson("state/operational.json");
  assert.equal(op.rows[id(4)][6], "ЗІСТАВЛЕНО");
  assert.equal(op.rows[id(4)][0], 1000);
  assert.equal(op.conflicts[id(4)], undefined);
  assert.match(offerOf(await yml(), id(4)), /<price>(1005\.00|1256\.25)<\/price>/);
  const ev = await events(store);
  assert.deepEqual(ev.map((e) => e.event), ["OPENED", "RESOLVED"]);
});

test("п.6: зміна причини конфлікту — подія CHANGED; повторний той самий конфлікт — без дубля події", async () => {
  const { run, setXml, store } = await setup();
  await setXml((x) => edit(x, id(4), setTag("vendorCode", "INTRUDER-1")));
  await run(T0);
  await run(T0 + 4 * H);
  await setXml((x) => edit(x, id(4), setTag("currencyId", "USD")));
  await run(T0 + 8 * H);
  const ev = await events(store);
  assert.deepEqual(ev.map((e) => [e.event, e.reason]), [["OPENED", "КОНФЛІКТ_АРТИКУЛА"], ["CHANGED", "НЕВІДОМА_ВАЛЮТА"]]);
  const op = await store.getJson("state/operational.json");
  assert.equal(op.conflicts[id(4)].since, new Date(T0).toISOString(), "дата відкриття зберігається");
});

test("п.5: підтверджений власний залишок + свіжа перевірена ціна — продаж зберігається; стара ціна — ні", async () => {
  const { run, setXml, store, yml } = await setup();
  await run(T0); // усі ціни перевірені в T0
  await store.putJson("state/own-stock.json", { items: {
    [id(4)]: { qty: 2, confirmedAt: new Date(T0 + 3 * H).toISOString() },
  } });
  await setXml((x) => edit(x, id(4), setTag("vendorCode", "INTRUDER-1")));
  const fresh = await run(T0 + 4 * H);
  assert.equal(fresh.feeds[0].ownStock, 1);
  assert.match(offerOf(await yml(), id(4)), /available="true"[\s\S]*<quantity_in_stock>2</);
  const ev = await events(store);
  assert.equal(ev[0].sale, "OWN_STOCK");

  await store.putJson("state/own-stock.json", { items: { [id(4)]: { qty: 2, confirmedAt: new Date(T0 + 4 * DAY).toISOString() } } });
  // Свіжа дата фіду (інакше фід >48 год і синк правильно відхиляє його цілком).
  await setXml((x) => edit(x, id(4), setTag("vendorCode", "INTRUDER-1")).replace(/date="[^"]*"/, `date="${formatYmlDate(T0 + 4 * DAY, "Europe/Kyiv")}"`));
  const stale = await run(T0 + 4 * DAY + H); // ціна перевірена 4 доби тому > 3 діб
  assert.equal(stale.feeds[0].ownStock, 0);
  assert.match(offerOf(await yml(), id(4)), /available="false"/);
});

test("п.9: багато конфліктів одночасно (системна зміна назв) → фід не публікується, остання справна версія лишається", async () => {
  const { run, setXml, store } = await setup();
  await run(T0);
  const before = await store.getJson(manifestKey("main"));
  const op = await store.getJson("state/operational.json");
  await setXml((x) => {
    for (let n = 0; n < 10; n++) x = edit(x, id(n), (l) => l.replace(/<name>([^<]*)<\/name>/, "<name>$1 v2</name>"));
    return x;
  });
  const r = await run(T0 + 4 * H);
  assert.equal(r.sync.state, "ERROR");
  assert.match(r.sync.error, /нових конфліктів 10/);
  assert.deepEqual(await store.getJson(manifestKey("main")), before);
  assert.deepEqual(await store.getJson("state/operational.json"), op);
});

test("п.9: зникнення і конфлікти рахуються разом (3 + 3 > 5)", async () => {
  const { run, setXml } = await setup();
  await setXml((x) => {
    x = x.split("\n").filter((l) => ![0, 1, 2].some((n) => l.startsWith(`<offer id="${id(n)}"`))).join("\n");
    for (const n of [3, 4, 5]) x = edit(x, id(n), setTag("vendorCode", "X" + n));
    return x;
  });
  const r = await run();
  assert.equal(r.sync.state, "ERROR");
  assert.match(r.sync.error, /нових зникнень 3, нових конфліктів 3; поріг 5/);
});

test("п.7, 10: нові й сумнівні товари не потрапляють у YML; ID у фіді = лише погоджені Offer ID; «Заморожені ID» не вважаються новими", async () => {
  const { run, store, yml, s } = await setup({ newOffers: 4, frozen: ["2900000013"] });
  const r = await run();
  assert.equal(r.feeds[0].state, "PUBLISHED");
  const v = await verifyYmlStream([await yml()], { count: s.manifestMain.count, idsSha: s.manifestMain.idsSha });
  assert.equal(v.count, 120);
  const news = await store.getJson("reports/new-products/latest.json");
  assert.deepEqual(news.candidates.map((c) => c.id).sort(), ["2900000000", "2900000026", "2900000039"]);
});

test("конфлікт моделі: діє лише коли постачальник передає <model>", async () => {
  const { run, setXml, store, row } = await setup();
  await setXml((x) => {
    x = edit(x, id(4), (l) => l.replace("</vendorCode>", "</vendorCode><model>OTHER-MODEL</model>"));
    x = edit(x, id(5), (l) => l.replace("</vendorCode>", `</vendorCode><model>${row(id(5))["Модель"]}</model>`));
    return x;
  });
  const r = await run();
  const op = await store.getJson("state/operational.json");
  assert.equal(op.rows[id(4)][6], "КОНФЛІКТ_МОДЕЛІ");
  assert.equal(op.rows[id(5)][6], "ЗІСТАВЛЕНО");
  assert.equal(r.feeds[0].isolatedConflicts, 1);
});

test("режим block (чинна поведінка LIVE): конфлікт однієї картки блокує весь фід, подія все одно записується", async () => {
  const { run, setXml, store } = await setup({ config: (c) => { c.policy.conflict = "block"; } });
  await setXml((x) => edit(x, id(4), setTag("vendorCode", "INTRUDER-1")));
  const r = await run();
  assert.equal(r.feeds[0].state, "ERROR");
  assert.match(r.feeds[0].error, /Непідтверджений статус/);
  assert.equal((await events(store))[0].sale, "BLOCKS_FEED");
});

test("YML: конфліктна картка без жодної перевіреної ціни виключається (ніколи не публікувалась), решта фіду публікується", async () => {
  const s = generateSynthetic({ products: 8, seed: 5, now: T0 });
  const rows = s.sheets["Основний каталог"].slice(1).map((r) => Object.fromEntries(YML_HEADERS.map((k, i) => [k, r[i]])));
  const stamp = new Date(T0).toISOString();
  for (const r of rows) Object.assign(r, { "Стан синхронізації": "ЗІСТАВЛЕНО", "Оновлено": stamp });
  Object.assign(rows[1], { "Стан синхронізації": "КОНФЛІКТ_АРТИКУЛА", "Наявність": "-", "Знижка": "", "Ціна постачальника": "", "Ціна": "", "Ціна кінцева": "" });
  Object.assign(rows[2], { "Стан синхронізації": "НЕВІДОМА_ВАЛЮТА", "Наявність": "+" });
  const groups = s.groups.slice(1).map((g) => ({ "Ідентифікатор_групи": g[0], "Назва_групи_укр": g[1], "Назва_групи": g[2], "Ідентифікатор_батьківської_групи": g[3] }));
  const args = { rows, groups, meta: { syncState: "OK", lastSuccess: stamp, now: stamp }, manifest: s.manifestMain, config: baseConfig.yml, maximumBytes: 1e9, conflictPolicy: "isolate" };
  // Конфліктна картка, що досі «+», не може бути опублікована як доступна (п. 4).
  await assert.rejects(buildYml({ ...args, sink: memorySink() }), /Непідтверджений статус/);
  Object.assign(rows[2], { "Наявність": "-", "Знижка": "" });
  const built = await buildYml({ ...args, sink: memorySink() });
  assert.equal(built.count, 7);
  assert.deepEqual(built.excludedNeverPriced, [rows[1]["Offer ID"]]);
  assert.equal(built.isolatedConflicts, 1);
});
