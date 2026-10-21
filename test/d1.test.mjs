/** Рішення D1 (власник, 21.10.2026): зникнення, повернення, зміна ID постачальника, аномалії, власний залишок. */
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
import { kitConflict, validGtin, resolveUnknownOffers, cardKeys, applyRelink } from "../src/core/identity.mjs";
import { buildYml, memorySink } from "../src/core/yml.mjs";
import { YML_HEADERS } from "../src/core/seal.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const T0 = Date.parse("2026-10-21T06:00:00.000Z");
const H = 3600000;
const id = (n) => String(1500000000 + n * 7);

async function setup(opts = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-d1-"));
  const s = generateSynthetic({ products: 120, queue: 12, deferred: 4, newOffers: 0, seed: 31, now: T0, ...opts.synth });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  const supplierFile = path.join(dir, "supplier.xml");
  const baseXml = s.supplierXml();
  await fsp.writeFile(supplierFile, baseXml);
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = structuredClone(baseConfig);
  config.supplier.minimumOffers = 10;
  if (opts.config) opts.config(config);
  const run = (now = T0) => runUpdate({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(supplierFile), now: () => now, tmpDir: dir });
  const setXml = (fn) => fsp.writeFile(supplierFile, fn(baseXml));
  const yml = async () => {
    const m = await store.getJson(manifestKey("main"));
    return (await store.getBuffer(m.active.key)).toString("utf8");
  };
  return { s, store, config, run, setXml, yml, baseXml };
}

/** Видалити offer із фіду. */
const drop = (xml, ids) => xml.split("\n").filter((l) => !ids.some((x) => l.startsWith(`<offer id="${x}"`))).join("\n");
/** Перевипустити offer під новим ID (той самий артикул і назви). */
const reissue = (xml, from, to, edit = (l) => l) => xml.split("\n").map((l) => (l.startsWith(`<offer id="${from}"`) ? edit(l.replace(`<offer id="${from}"`, `<offer id="${to}"`).replace(`/p${from}-`, `/p${to}-`)) : l)).join("\n");
const offerOf = (xml, oid) => (new RegExp(`<offer id="${oid}"[^>]*>[\\s\\S]*?</offer>`).exec(xml) || [""])[0];

test("п.1–2, 10: зниклий товар не видаляється, публікується як «немає в наявності», фід не блокується", async () => {
  const { run, setXml, yml, store } = await setup();
  await setXml((x) => drop(x, [id(5)]));
  const r = await run();
  assert.equal(r.sync.state, "OK");
  assert.equal(r.feeds[0].state, "PUBLISHED", JSON.stringify(r.feeds));
  assert.equal(r.feeds[0].count, 120);
  assert.equal(r.feeds[0].unavailableMissing, 1);
  const offer = offerOf(await yml(), id(5));
  assert.match(offer, /available="false"/);
  assert.doesNotMatch(offer, /<oldprice>/);
  const op = await store.getJson("state/operational.json");
  assert.deepEqual(op.rows[id(5)].slice(3, 7), ["", "-", "", "ВІДСУТНІЙ_У_YML"]);
  assert.equal(op.missing[id(5)].since, new Date(T0).toISOString());
});

test("п.3: товар повернувся з тим самим ID — та сама картка знову ЗІСТАВЛЕНО, дата відсутності скинута", async () => {
  const { run, setXml, store, baseXml } = await setup();
  await setXml((x) => drop(x, [id(5)]));
  await run(T0);
  await setXml(() => baseXml);
  const r = await run(T0 + 4 * H);
  assert.equal(r.availability.returned, 1);
  const op = await store.getJson("state/operational.json");
  assert.equal(op.rows[id(5)][6], "ЗІСТАВЛЕНО");
  assert.equal(op.missing[id(5)], undefined);
});

test("п.4–5, 7: постачальник перевипустив товар з новим ID → та сама картка, прив'язка з історією, не новий товар", async () => {
  const { run, setXml, store, yml } = await setup();
  await run(T0);
  await setXml((x) => reissue(x, id(9), "2999999901").replace(/(<offer id="2999999901"[^>]*>[\s\S]*?<price>)[^<]+/, "$1444.44"));
  const r = await run(T0 + 4 * H);
  assert.equal(r.sync.state, "OK");
  assert.equal(r.identity.relinked, 1);
  const links = await store.getJson("state/links.json");
  assert.equal(links.cards[id(9)].supplierId, "2999999901");
  assert.equal(links.cards[id(9)].history[0].supplierId, id(9));
  assert.equal(links.retired[id(9)], id(9));
  const op = await store.getJson("state/operational.json");
  assert.equal(op.rows[id(9)][0], 444.44);
  assert.equal(op.rows[id(9)][6], "ЗІСТАВЛЕНО");
  const xml = await yml();
  assert.match(offerOf(xml, id(9)), /449\.44|561\.80/); // наш стабільний Offer ID з ціною нового offer
  assert.equal(offerOf(xml, "2999999901"), "");
  const news = await store.getJson("reports/new-products/latest.json");
  assert.ok(!news.candidates.some((c) => c.id === "2999999901"));
});

test("п.7, 3: після перев'язки колишній ID повернувся (а новий зник) — картка повертається до нього", async () => {
  const { run, setXml, store, baseXml } = await setup();
  await setXml((x) => reissue(x, id(9), "2999999901"));
  await run(T0);
  await setXml(() => baseXml);
  const r = await run(T0 + 4 * H);
  assert.equal(r.identity.relinked, 1);
  const links = await store.getJson("state/links.json");
  assert.equal(links.cards[id(9)].supplierId, id(9));
  assert.equal(links.cards[id(9)].history.length, 2);
  assert.equal(links.retired["2999999901"], id(9));
});

test("п.6: два нові offer претендують на одну картку → ручна перевірка, жодного склеювання", async () => {
  const { run, setXml, store } = await setup();
  await setXml((x) => {
    const lines = x.split("\n");
    const i = lines.findIndex((l) => l.startsWith(`<offer id="${id(9)}"`));
    const dup = lines[i].replace(`<offer id="${id(9)}"`, '<offer id="2999999902"');
    lines[i] = lines[i].replace(`<offer id="${id(9)}"`, '<offer id="2999999901"');
    lines.splice(i + 1, 0, dup);
    return lines.join("\n");
  });
  const r = await run();
  assert.equal(r.identity.relinked, 0);
  assert.equal(r.identity.manualReview, 2);
  const rep = await store.getJson("reports/identity/latest.json");
  assert.ok(rep.manualReview.every((m) => m.reason.includes("кілька")));
  const op = await store.getJson("state/operational.json");
  assert.equal(op.rows[id(9)][6], "ВІДСУТНІЙ_У_YML");
  const news = await store.getJson("reports/new-products/latest.json");
  assert.equal(news.total, 0, "неоднозначні offers не повинні потрапити в «нові товари»");
});

test("п.6: той самий артикул, інша комплектація в назві → ручна перевірка, не перев'язка", async () => {
  const { run, setXml, store } = await setup();
  await setXml((x) => reissue(x, id(9), "2999999901", (l) => l.replace(/<name_ua>([^<]*)<\/name_ua>/, "<name_ua>$1 2 АКБ 4 Аг</name_ua>").replace(/<name>([^<]*)<\/name>/, "<name>$1 2 АКБ 4 Ач</name>")));
  const r = await run();
  assert.equal(r.identity.relinked, 0);
  assert.equal(r.identity.manualReview, 1);
  const op = await store.getJson("state/operational.json");
  assert.equal(op.rows[id(9)][4], "-");
});

test("п.9: аномально багато зникнень за запуск (фід пройшов перевірку кількості) → синк зупинено, стан і фід без змін", async () => {
  // Поріг за замовчуванням max(50, 2%) — для реального каталогу; тут каталог малий, тому поріг 5.
  const { run, setXml, store } = await setup({ config: (c) => { c.policy.anomaly.maxNewlyMissing = 5; } });
  await run(T0);
  const before = await store.getJson(manifestKey("main"));
  const op = await store.getJson("state/operational.json");
  await setXml((x) => drop(x, Array.from({ length: 8 }, (_, i) => id(i))));
  const r = await run(T0 + 4 * H);
  assert.equal(r.sync.state, "ERROR");
  assert.match(r.sync.error, /Аномально багато/);
  assert.deepEqual(await store.getJson(manifestKey("main")), before);
  assert.deepEqual(await store.getJson("state/operational.json"), op);
});

test("п.2: підтверджений власний залишок — товар лишається доступним; прострочене підтвердження — ні", async () => {
  const { run, setXml, store, yml } = await setup();
  await run(T0);
  await setXml((x) => drop(x, [id(5), id(6)]));
  await store.putJson("state/own-stock.json", { items: {
    [id(5)]: { qty: 3, confirmedAt: new Date(T0).toISOString() },
    [id(6)]: { qty: 3, confirmedAt: new Date(T0 - 30 * 86400000).toISOString() },
  } });
  const r = await run(T0 + 4 * H);
  assert.equal(r.feeds[0].ownStock, 1);
  const xml = await yml();
  assert.match(offerOf(xml, id(5)), /available="true"[\s\S]*<oldprice>[\s\S]*<quantity_in_stock>3</);
  assert.match(offerOf(xml, id(6)), /available="false"/);
});

test("п.8: 60 і 90 днів відсутності — лише пропозиції, товар лишається у фіді", async () => {
  const { run, setXml, store } = await setup();
  await setXml((x) => drop(x, [id(5), id(6)]));
  await run(T0);
  const op = await store.getJson("state/operational.json");
  op.missing[id(5)].since = new Date(T0 - 61 * 86400000).toISOString();
  op.missing[id(6)].since = new Date(T0 - 91 * 86400000).toISOString();
  await store.putJson("state/operational.json", op);
  const r = await run(T0 + 4 * H);
  const rep = await store.getJson("reports/missing/latest.json");
  assert.deepEqual(rep.proposals.map((p) => [p.id, p.proposal]).sort(), [[id(5), "PROPOSE_HIDE"], [id(6), "PROPOSE_ARCHIVE"]]);
  assert.equal(r.feeds[0].count, 120);
});

test("невідомий offer збігається з ЖИВОЮ карткою (дубль у постачальника) → ручна перевірка, не новий товар", async () => {
  const { run, setXml, store } = await setup();
  await setXml((x) => {
    const line = x.split("\n").find((l) => l.startsWith(`<offer id="${id(9)}"`));
    return x.replace(line, line + "\n" + line.replace(`<offer id="${id(9)}"`, '<offer id="2999999903"'));
  });
  const r = await run();
  assert.equal(r.identity.relinked, 0);
  assert.equal(r.identity.manualReview, 1);
  const rep = await store.getJson("reports/identity/latest.json");
  assert.match(rep.manualReview[0].reason, /досі жива/);
  assert.equal((await store.getJson("reports/new-products/latest.json")).total, 0);
});

test("autoRelink=false: достовірний збіг лише пропонується (RELINK_PROPOSED)", async () => {
  const { run, setXml, store } = await setup({ config: (c) => { c.identity.autoRelink = false; } });
  await setXml((x) => reissue(x, id(9), "2999999901"));
  const r = await run();
  assert.equal(r.identity.relinked, 0);
  const rep = await store.getJson("reports/identity/latest.json");
  assert.equal(rep.manualReview[0].decision, "RELINK_PROPOSED");
});

test("identity: ознаки комплектації з кирилицею, GTIN, взаємна однозначність", () => {
  assert.deepEqual(kitConflict("Шуруповерт 18 В 2 АКБ 4 Аг", "Шуруповерт 18 В 1 АКБ 4 Аг"), ["batteries"]);
  assert.deepEqual(kitConflict("Шуруповерт 18 В без АКБ", "Шуруповерт 18 В 2 АКБ"), ["solo"]);
  assert.deepEqual(kitConflict("Пила 2000 Вт", "Пила 2000 Вт (ALTC200)"), []);
  assert.deepEqual(kitConflict("Дриль 18 В", "Дриль 12 В"), ["volts"]);
  assert.equal(validGtin("4006381333931"), "4006381333931");
  assert.equal(validGtin("4006381333932"), "");
  const row = (oid, sku, ua) => Object.fromEntries(YML_HEADERS.map((k) => [k, ""]).concat([["Offer ID", oid], ["ID постачальника", oid], ["Артикул постачальника", sku], ["Назва постачальника UA", ua], ["Назва постачальника RU", ua], ["Виробник", "X"]]));
  const cards = [cardKeys(row("1", "A1", "Товар A")), cardKeys(row("2", "A1", "Товар B"))];
  const res = resolveUnknownOffers({ offers: [{ id: "9", sku: "A1", nameUa: "Товар A", nameRu: "Товар A", vendor: "X" }], cards, orphanIds: new Set(["1", "2"]) });
  assert.equal(res[0].decision, "RELINK", "однаковий артикул, але інші назви — не суперник для STRONG");
  assert.equal(res[0].target, "1");
  const otherBrand = resolveUnknownOffers({ offers: [{ id: "9", sku: "A1", nameUa: "Товар A", nameRu: "Товар A", vendor: "Y" }], cards, orphanIds: new Set(["1", "2"]) });
  assert.equal(otherBrand[0].decision, "MANUAL_REVIEW", "інший бренд при тому самому артикулі й назві — не перев'язувати");
  assert.throws(() => applyRelink({ cards: { "2": { supplierId: "9" } } }, { offerId: "1", fromSupplierId: "1", toSupplierId: "9", at: "x" }), /іншої картки/);
});

test("YML: відсутній товар без жодної ціни ніколи не публікувався — виключається, решта фіду публікується", async () => {
  const s = generateSynthetic({ products: 10, seed: 3, now: T0 });
  const rows = s.sheets["Основний каталог"].slice(1).map((r) => Object.fromEntries(YML_HEADERS.map((k, i) => [k, r[i]])));
  const stamp = new Date(T0).toISOString();
  for (const r of rows) Object.assign(r, { "Стан синхронізації": "ЗІСТАВЛЕНО", "Оновлено": stamp });
  Object.assign(rows[2], { "Стан синхронізації": "ВІДСУТНІЙ_У_YML", "Наявність": "-", "Знижка": "", "Ціна постачальника": "", "Ціна": "", "Ціна кінцева": "" });
  // Печатку не перераховуємо: F:M не входять у незмінні поля.
  const groups = s.groups.slice(1).map((g) => ({ "Ідентифікатор_групи": g[0], "Назва_групи_укр": g[1], "Назва_групи": g[2], "Ідентифікатор_батьківської_групи": g[3] }));
  const sink = memorySink();
  const built = await buildYml({ rows, groups, meta: { syncState: "OK", lastSuccess: stamp, now: stamp }, manifest: s.manifestMain, config: baseConfig.yml, maximumBytes: 1e9, sink, missingPolicy: "unavailable" });
  assert.equal(built.count, 9);
  assert.deepEqual(built.excludedNeverPriced, [rows[2]["Offer ID"]]);
  await assert.rejects(buildYml({ rows, groups, meta: { syncState: "OK", lastSuccess: stamp, now: stamp }, manifest: s.manifestMain, config: baseConfig.yml, maximumBytes: 1e9, sink: memorySink() }), /Непідтверджений статус/);
});
