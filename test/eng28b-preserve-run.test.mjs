/** ENG-28b (рішення власника 01.11.2026) — звичайне «Оновити товари» (productionConfig) ЗБЕРІГАЄ характеристики основного каталогу:
 *  A — ціни й наявність оновлюються; B — зміни сирих <param> постачальника виявляються й потрапляють у звіт, але не застосовуються;
 *  C (перебудова за схемою / з описів) — окремий майбутній етап, у робочому шляху недоступний. FZ лишається активним. Поріг масового
 *  зникнення — менший із «50» і «2 %», при досягненні (синхронізація й D1). Перенесення — лише рядки «ОЧІКУЄ…», рівно очікувана
 *  кількість. Новинки — ENG-28c: лише окрема команда «Знайти нові товари» (не «Оновити товари»). Схема категорії — справжній файл schemas/prom/1250302.xml під синтетичними
 *  ID категорій 500…509. Синтетика, таблиця в пам'яті, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { rowSeal, SEAL_COLUMN, YML_HEADERS } from "../src/core/seal.mjs";
import * as SS from "../src/core/sheet-sync.mjs";
import * as run from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import * as P from "../src/core/supplier-presence.mjs";
import * as UP from "../src/pipeline/update-products.mjs";
import { planTransferNew92, PENDING_TRANSFER_MARK, TRANSFER_MARK } from "../src/core/transfer-new92.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const { SHEET, PARAMS_ORIGIN, RAW_PARAMS } = SS;
const NOW = Date.parse("2026-10-22T10:00:00Z");
const at = (min) => new Date(NOW + min * 60_000).toISOString();
const real = loadPromCatalog();
const SCHEMA = "1250302";
const CATS = ["500", "501", "502", "503", "504", "505", "506", "507", "508", "509"];
const catalog = (extra = {}) => ({ schemas: new Map(CATS.map((c) => [c, real.schemas.get(SCHEMA)])), mappings: new Map(), units: real.units, names: real.names, problems: [], ...extra });
/** Робоча точка (CLI): productionConfig → characteristics.main = "preserve". Поріг зникнення синхронізації тут абсолютний (частка 1):
 *  на малому синтетичному каталозі 2 % < 1 товару — межу min / ≥ перевіряє окремий тест. */
const prodCfg = (f) => { const c = productionConfig(structuredClone(baseConfig)); c.supplier.minimumOffers = 10; c.policy.anomaly = { ...c.policy.anomaly, maxNewlyMissingRatio: 1 }; f?.(c); return c; };
/** Як до ENG-28b (ENG-28a): пріоритет власника без productionConfig — генератор перебудовує характеристики. Лише для контрасту. */
const rebuildCfg = () => { const c = structuredClone(baseConfig); c.ownerPriority = { enabled: true }; c.supplier.minimumOffers = 10; c.policy.anomaly = { ...c.policy.anomaly, maxNewlyMissingRatio: 1 }; return c; };
const okCc = () => Object.freeze({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp-", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
const FULL_URL = "https://market-tools.com.ua/feed.xml?key=SECRET";
const LIVE_PARAMS = JSON.stringify([{ name: "Гарантия", unit: "", value: "36 мес." }, { name: "Живлення", unit: "", value: "Акумулятор" }]);
const DESC = "<ul><li>Довжина шини: 250 мм</li><li>Вага: 3 кг</li><li>Швидкість ланцюга: 4,3 м/с</li></ul>";
const offerRe = (sid) => new RegExp(`<offer id="${sid}"[\\s\\S]*?</offer>`);
const xmlParam = (p) => `<param name="${p.name}"${p.unit ? ` unit="${p.unit}"` : ""}>${p.value}</param>`;
/** Сирі <param> і опис офера (як у реального постачальника: рос. назви, перелік характеристик в описі). */
const setOffer = (xml, sid, params, desc = DESC) => xml.replace(offerRe(sid), (o) => o.replace(/<param [\s\S]*?<\/param>/g, "").replace(/<description>[\s\S]*?<\/description>/g, "").replace("</offer>", params.map(xmlParam).join("") + `<description>${desc}</description><description_ua>${desc}</description_ua></offer>`));
const full = (xml) => xml.replace(/<\/offer>/g, "<description>Опис постачальника</description></offer>");
const dated = (xml, min) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 3 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });
const RU = [{ name: "Гарантия", value: "36 мес.", unit: "" }, { name: "Питание", value: "Аккумулятор", unit: "" }];

/** Каталог після перенесення NEW92 (черга у форматі черги); 6 карток — «як у LIVE»: рос. назви в «Характеристики JSON», постачальник
 *  передає рос. <param> і перелік характеристик в описі (новий генератор перейменував би й додав би поля з опису). */
async function world({ products = 40 } = {}) {
  const s = generateSynthetic({ products, queue: 4, deferred: 2, newOffers: 0, seed: 17, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const w = { s, sheets, readBook: async () => sheets.read(), store: new MemoryStore() };
  await run.mergeNew92({ sheets, readBook: w.readBook, stamp: at(0) });
  const h = book[SHEET.main][0].map(mtText);
  w.live = [];
  let xml = full(s.supplierXml());
  for (const i of [3, 6, 9, 12, 15, 18]) {
    const v = book[SHEET.main][i];
    v[h.indexOf("Характеристики JSON")] = LIVE_PARAMS;
    v[h.indexOf(SEAL_COLUMN)] = rowSeal(Object.fromEntries(h.map((k, j) => [k, v[j] ?? ""])));
    const sid = mtText(v[h.indexOf("ID постачальника")]);
    w.live.push({ offerId: mtText(v[h.indexOf("Offer ID")]), sid });
    xml = setOffer(xml, sid, RU);
  }
  w.xml = xml;
  return w;
}
const runUp = (w, xml, { min = 1, config = prodCfg(), cat = catalog(), source = FULL_URL, controls = okCc() } = {}) =>
  UP.updateProducts({ sheets: w.sheets, readBook: w.readBook, xml, source, fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config, catalog: cat, controls, snapshotStore: w.store });
const main = (w) => readSheet(w.sheets.book[SHEET.main], SHEET.main).rows;
const byId = (w, id) => main(w).find((r) => mtText(r["Offer ID"]) === id);
const chars = (w) => new Map(main(w).map((r) => [mtText(r["Offer ID"]), mtText(r["Характеристики JSON"])]));
const rowNo = (w, id) => w.sheets.book[SHEET.main].findIndex((r, i) => i > 0 && mtText(r[0]) === id) + 1;

// ================================================================ A: характеристики зберігаються, ціни й наявність — оновлюються
test("ENG-28b «Оновити товари» (productionConfig): характеристики всіх товарів основного каталогу побайтово ті самі; опис не стає характеристиками; ціни й наявність оновлено; контраст — режим перебудови змінив би їх", async () => {
  assert.equal(prodCfg().characteristics.main, "preserve", "робоча точка — лише збереження");
  const w = await world();
  const before = chars(w);
  const [p, a] = main(w).slice(25, 27);
  let xml = perturb.tag(w.xml, mtText(p["ID постачальника"]), "price", "777");
  xml = xml.replace(new RegExp(`<offer id="${mtText(a["ID постачальника"])}" available="true"`), `<offer id="${mtText(a["ID постачальника"])}" available="false"`);
  const r = await runUp(w, xml);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 500));
  assert.equal(r.report.supplierChanges.characteristics, "preserve");
  assert.equal(r.report.supplierChanges.characteristicsChanged, 0);
  assert.deepEqual(chars(w), before, "«Характеристики JSON» — побайтово ті самі в усіх рядках");
  for (const { offerId } of w.live) {
    const row = byId(w, offerId);
    assert.equal(mtText(row[PARAMS_ORIGIN]), "", "походження не створюється (немає перебудови)");
    assert.ok(!/Довжина шини|Швидкість ланцюга|Гарантія/.test(mtText(row["Характеристики JSON"])), "ні полів з опису, ні перейменування");
    assert.equal(mtText(row[RAW_PARAMS]), JSON.stringify(RU), "сирі <param> постачальника — окремою колонкою");
  }
  assert.equal(Number(byId(w, mtText(p["Offer ID"]))["Ціна постачальника"]), 777, "ціна оновлена");
  assert.equal(mtText(byId(w, mtText(a["Offer ID"]))["Наявність"]), "-", "наявність оновлена");
  assert.equal(r.report.prices.supplierPriceChanged >= 1 && r.report.availability.changed >= 1, true);
  assert.ok(!w.sheets.book[SHEET.journal].some((e) => e[3] === "Характеристики JSON"), "у «Журналі» немає змін характеристик");
  // Контраст: той самий каталог у режимі перебудови (ENG-28a) змінив би характеристики LIVE-карток.
  const w2 = await world();
  const r2 = await runUp(w2, xml, { config: rebuildCfg() });
  assert.equal(r2.state, "SYNCED");
  assert.ok(w.live.some(({ offerId }) => mtText(byId(w2, offerId)["Характеристики JSON"]) !== LIVE_PARAMS), "без preserve генератор перебудовує");
});

test("ENG-28b refreshMainRow: preserve — без генератора навіть із технічними правилами N1 / A2 і без <param> (лише опис); rebuild — додав би поля з опису", () => {
  const cat = catalog({ techRulesFor: () => ["N1", "A2"] });
  const row = { "Offer ID": "1700000001", "ID постачальника": "1700000001", "Артикул постачальника": "A-1", "Назва UA": "Пила", "Назва RU": "Пила", "Категорія Prom ID": "500", "Виробник": "Einhell",
    "Назва постачальника UA": "Пила", "Назва постачальника RU": "Пила", "URL постачальника": "https://x/p1", "Модель": "M", "Фото JSON": JSON.stringify(["https://images.prom.ua/1.jpg"]), "Характеристики JSON": LIVE_PARAMS };
  row[SEAL_COLUMN] = rowSeal(row);
  const offer = { id: "1700000001", nameUa: "Пила", nameRu: "Пила", sku: "A-1", url: "https://x/p1", price: 100, available: true };
  for (const params of [RU, []]) {
    const fullO = { model: "M", pictures: ["https://images.prom.ua/1.jpg"], params, descriptionUa: DESC, descriptionRu: DESC };
    const keep = SS.refreshMainRow({ ...row }, offer, fullO, { stamp: "T", catalog: cat, ownerPriority: true, characteristics: "preserve" });
    assert.equal(keep.params, false);
    assert.equal(keep.row["Характеристики JSON"], LIVE_PARAMS);
    assert.equal(mtText(keep.row[PARAMS_ORIGIN]), "");
    const rebuilt = SS.refreshMainRow({ ...row }, offer, fullO, { stamp: "T", catalog: cat, ownerPriority: true, characteristics: "rebuild" });
    assert.equal(rebuilt.params, true, "контраст: генератор додав би поля з опису");
    assert.match(rebuilt.row["Характеристики JSON"], /Довжина шини/);
  }
});

// ================================================================ B: зміни <param> постачальника — виявлено, у звіт, не застосовано
test("ENG-28b зміни XML-параметрів постачальника: виявлено (звіт з Offer ID, «Журнал», сира колонка, знімок), характеристики не змінено; ручна правка власника збережена", async () => {
  const w = await world();
  assert.equal((await runUp(w, w.xml)).state, "SYNCED");
  const [x, y] = w.live;
  const before = chars(w);
  // Власник вручну змінив характеристики іншої картки між запусками.
  const own = main(w)[30], ownId = mtText(own["Offer ID"]);
  w.sheets.humanSet(SHEET.main, rowNo(w, ownId), "Характеристики JSON", JSON.stringify([{ name: "Колір", unit: "", value: "червоний (власник)" }]));
  const ownVal = mtText(byId(w, ownId)["Характеристики JSON"]);
  let xml = setOffer(w.xml, x.sid, [...RU, { name: "Вес", value: "5.1", unit: "кг" }]);
  xml = setOffer(xml, y.sid, [{ name: "Гарантия", value: "12 мес.", unit: "" }, RU[1]]);
  const j0 = w.sheets.book[SHEET.journal].length;
  const r = await runUp(w, dated(xml, 2), { min: 2 });
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 500));
  assert.equal(r.report.supplierChanges.params, 2);
  assert.deepEqual([...r.report.supplierChanges.paramsOfferIds].sort(), [x.offerId, y.offerId].sort());
  assert.equal(mtText(byId(w, x.offerId)[RAW_PARAMS]), JSON.stringify([...RU, { name: "Вес", value: "5.1", unit: "кг" }]));
  for (const [id, v] of before) if (id !== ownId) assert.equal(mtText(byId(w, id)["Характеристики JSON"]), v, "не застосовано: " + id);
  assert.equal(mtText(byId(w, ownId)["Характеристики JSON"]), ownVal, "ручна правка власника збережена");
  const jr = w.sheets.book[SHEET.journal].slice(j0);
  assert.ok(jr.some((e) => e[2] === x.offerId && e[3] === RAW_PARAMS), "зміна сирих характеристик — у «Журналі»");
  assert.ok(jr.some((e) => e[2] === y.offerId && e[3] === SS.RECHECK && /характеристик/.test(mtText(e[5]))), "інформаційна позначка «перевірте»");
  assert.ok(!jr.some((e) => e[3] === "Характеристики JSON"));
  assert.ok(JSON.parse(mtText(byId(w, x.offerId)[P.PRESENCE_META_COLUMN])).lastChange?.parts?.length, "у знімку постачальника позначено змінені частини");
});

// ================================================================ FZ лишається активним
test("ENG-28b FZ активний: масова зміна сирих <param> постачальника понад поріг — увесь прохід НЕ ВИКОНАНО (нічого не записано); без FZ — попередження, характеристики не змінено", async () => {
  const fz = { frozenInfo: { active: true, rev: 1 }, frozenIds: [], frozenFor: () => null };
  const w = await world();
  const cfg = prodCfg((c) => { c.characteristics = { ...c.characteristics, maxChangedRows: 2 }; });
  assert.equal((await runUp(w, w.xml, { config: cfg, cat: catalog(fz) })).state, "SYNCED");
  let xml = w.xml;
  for (const { sid } of w.live.slice(0, 3)) xml = setOffer(xml, sid, [{ name: "Гарантия", value: "6 мес.", unit: "" }]);
  const before = JSON.stringify(w.sheets.book[SHEET.main]);
  const r = await runUp(w, dated(xml, 2), { min: 2, config: cfg, cat: catalog(fz) });
  assert.equal(r.state, "ABORTED", JSON.stringify(r).slice(0, 400));
  assert.match(r.reason, /МАСОВА ЗМІНА ХАРАКТЕРИСТИК ПОСТАЧАЛЬНИКА за активного FZ: 3 товарів \(поріг 2\)/);
  assert.equal(JSON.stringify(w.sheets.book[SHEET.main]), before, "нічого не записано (і ціни)");
  // Без активного FZ — попередження, сирі дані оновлено, підготовлені характеристики не змінено.
  const w2 = await world();
  await runUp(w2, w2.xml, { config: cfg });
  const b2 = chars(w2);
  const r2 = await runUp(w2, dated(xml, 2), { min: 2, config: cfg });
  assert.equal(r2.state, "SYNCED");
  assert.ok(r2.sync.warnings.some((x) => /МАСОВА ЗМІНА ХАРАКТЕРИСТИК ПОСТАЧАЛЬНИКА: 3/.test(x)));
  assert.deepEqual(chars(w2), b2);
});

test("ENG-28b FZ-товар: збережені FZ не застосовуються (у звіті «очікує етапу C»), рядок не ізольовано, ціна оновлена; зміна даних постачальника FZ-товару — блок FZ, як і раніше", async () => {
  const w = await world();
  const target = main(w)[20], id = mtText(target["Offer ID"]), sid = mtText(target["ID постачальника"]);
  const parsed = await parseSupplierText(w.xml, { maximumChars: 400_000_000, identityFields: true });
  const offer = parsed.offers.get(sid), fullO = SS.extractFullOffers(w.xml, [sid]).get(sid);
  const rowM = SS.readMain(w.sheets.book[SHEET.main]).rows.find((r) => mtText(r["Offer ID"]) === id);
  const savedParams = JSON.stringify([{ name: "Збережена характеристика", unit: "", value: "FZ" }]);
  const item = { id, supplierId: sid, categoryId: mtText(target["Категорія Prom ID"]), schemaCategoryId: mtText(target["Категорія Prom ID"]), vendor: mtText(target["Виробник"]),
    source: { offer: { ...offer }, full: { ...fullO } },
    expected: { paramsJson: mtText(rowM["Характеристики JSON"]), provenanceJson: "", seal: mtText(rowM[SEAL_COLUMN]) },
    saved: { paramsJson: savedParams, provenanceJson: "", seal: "інша-печатка" } };
  const fz = { frozenInfo: { active: true, rev: 1 }, frozenIds: [id], frozenFor: (x) => (x === id ? item : null) };
  const priced = perturb.tag(w.xml, sid, "price", "999");
  const r = await runUp(w, priced, { cat: catalog(fz) });
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 500));
  assert.deepEqual(r.report.supplierChanges.frozenPending, [id], "у звіті: збережені FZ очікують етапу C");
  const row = byId(w, id);
  assert.equal(mtText(row["Характеристики JSON"]), mtText(target["Характеристики JSON"]), "збережені FZ не застосовано");
  assert.equal(Number(row["Ціна постачальника"]), 999, "рядок не ізольовано: ціна оновлена");
  assert.ok(!(r.sync.ownerPriority?.isolated || []).some((x) => x.offerId === id));
  // Зміна назви постачальника FZ-товару — FZ блокує (ДЖЕРЕЛО): у режимі пріоритету власника рядок ізольовано, нічого в ньому не пишеться.
  const w2 = await world();
  const before = { ...byId(w2, id) };
  const r2 = await runUp(w2, perturb.tag(w2.xml, sid, "name_ua", "Інша назва"), { cat: catalog(fz) });
  assert.ok(["SYNCED", "CONFLICT_OWNER_EDIT"].includes(r2.state), JSON.stringify(r2).slice(0, 400));
  assert.ok((r2.sync.ownerPriority?.isolated || []).some((x) => x.offerId === id && /FZ/.test(x.reason)), JSON.stringify(r2.sync.ownerPriority?.isolated));
  assert.equal(mtText(byId(w2, id)["Назва постачальника UA"]), mtText(before["Назва постачальника UA"]));
});

// ================================================================ поріг зникнення в синхронізації: min / ≥
test("ENG-28b синхронізація: МАСОВЕ ЗНИКНЕННЯ — менший із «50» і «⌈2 % каталогу⌉», при досягненні; фільтрований фід масово відсутніх не рахує", async () => {
  const s = generateSynthetic({ products: 120, queue: 2, deferred: 1, newOffers: 0, seed: 23, now: NOW });
  const mk = () => { const b = { [SHEET.main]: structuredClone(s.sheets["Основний каталог"]), [SHEET.queue]: structuredClone(s.sheets["Нові товари"]), [SHEET.deferred]: structuredClone(s.sheets["Відкладені товари"]), [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] }; const m = new MemorySheets(b); return { sheets: m, readBook: async () => m.read() }; };
  const cfg = structuredClone(baseConfig); cfg.ownerPriority = { enabled: true }; cfg.supplier.minimumOffers = 10; // 50 / 0,02 із config
  const sync = async (w, xml) => run.syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed: await parseSupplierText(xml, { maximumChars: 400_000_000, identityFields: true }), fetchFull: async (ids) => SS.extractFullOffers(xml, ids), stamp: at(1), config: cfg, now: NOW + 60_000, catalog: EMPTY_CATALOG, controls: okCc() });
  const w0 = mk(); await run.mergeNew92({ sheets: w0.sheets, readBook: w0.readBook, stamp: at(0) });
  const n = readSheet(w0.sheets.book[SHEET.main], SHEET.main).rows.length;
  const lim = P.holdLimit({ maxGoneAbsolute: 50, maxGoneRatio: 0.02 }, n);
  assert.equal(lim, Math.min(50, Math.ceil(0.02 * n)));
  const sids = readSheet(w0.sheets.book[SHEET.main], SHEET.main).rows.map((r) => mtText(r["ID постачальника"]));
  const xml0 = full(s.supplierXml());
  for (const [k, want] of [[lim - 1, "SYNCED"], [lim, "ABORTED"], [lim + 1, "ABORTED"]]) {
    const w = mk(); await run.mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: at(0) });
    const r = await sync(w, perturb.drop(xml0, sids.slice(0, k)));
    assert.equal(r.state, want, `${k} зниклих: ${JSON.stringify(r).slice(0, 200)}`);
    if (want === "ABORTED") assert.match(r.reason, new RegExp(`зникло ${k} товарів основного каталогу \\(поріг ${lim}\\)`));
  }
  // Фільтрований фід (presence scope filtered): відсутні — поза охопленням, у поріг не рахуються, наявність не змінюється.
  const w = mk(); await run.mergeNew92({ sheets: w.sheets, readBook: w.readBook, stamp: at(0) });
  const store = new MemoryStore();
  const cfgF = structuredClone(cfg); cfgF.characteristics = { main: "preserve" };
  const dropped = sids.slice(0, lim + 3);
  const before = new Map(readSheet(w.sheets.book[SHEET.main], SHEET.main).rows.map((r) => [mtText(r["ID постачальника"]), mtText(r["Наявність"])]));
  const r = await UP.updateProducts({ sheets: w.sheets, readBook: w.readBook, xml: perturb.drop(xml0, dropped), source: "https://market-tools.com.ua/feed.xml?group_ids=1", fetchedAt: at(1), stamp: at(1), now: NOW + 60_000, config: cfgF, catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: store });
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 300));
  assert.equal(r.report.outOfFeedScope, dropped.length, "поза обсягом перевіреного фіду — окремо у звіті");
  for (const sid of dropped) assert.equal(mtText(readSheet(w.sheets.book[SHEET.main], SHEET.main).rows.find((x) => mtText(x["ID постачальника"]) === sid)["Наявність"]), before.get(sid));
});

// ================================================================ перенесення: лише «ОЧІКУЄ…», рівно очікувана кількість
test("ENG-28b перенесення: лише рядки «ОЧІКУЄ ПЕРЕНЕСЕННЯ», інші рядки черги не чіпаються; кількість ≠ очікуваній — PRECONDITION_FAILED; рядок у main без позначки — повтор не «виконано»", () => {
  const s = generateSynthetic({ products: 30, queue: 5, deferred: 1, newOffers: 0, seed: 29, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"], [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups };
  const mig = SS.QUEUE_HEADERS;
  const q0 = readSheet(book[SHEET.queue], SHEET.queue).rows;
  const toQueue = (rows) => [mig.slice(), ...rows.map((r) => mig.map((k) => r[k] ?? ""))];
  const pending = q0.map((r) => ({ ...r, "Перевірка": `${PENDING_TRANSFER_MARK} (тест)` }));
  const intakeRow = { ...q0[0], "Offer ID": "2990000555", "ID постачальника": "2990000555", "Перевірка": "", "Статус імпорту": "" };
  book[SHEET.queue] = toQueue([...pending, intakeRow]);
  const p = planTransferNew92({ book, stamp: "T", snapshotDate: "2026-10-29", expectCount: 5 });
  assert.equal(p.state, "READY", JSON.stringify(p.checks.filter((c) => !c.ok)));
  assert.deepEqual(p.moveRows.map((r) => mtText(r["Offer ID"])).sort(), q0.map((r) => mtText(r["Offer ID"])).sort());
  assert.equal(p.counts.queueOtherRows, 1, "рядок новинки — не переноситься");
  assert.equal(planTransferNew92({ book, stamp: "T", snapshotDate: "2026-10-29", expectCount: 6 }).state, "PRECONDITION_FAILED", "кількість ≠ очікуваній");
  // Після перенесення: усі «ПЕРЕНЕСЕНО» → ALREADY; один рядок у main без позначки (конфлікт позначки) → не «виконано».
  const mainAfter = [...readSheet(book[SHEET.main], SHEET.main).rows, ...q0];
  const done = { ...book, [SHEET.main]: [book[SHEET.main][0], ...mainAfter.map((r) => book[SHEET.main][0].map((k) => r[k] ?? ""))], [SHEET.queue]: toQueue([...q0.map((r) => ({ ...r, "Перевірка": `${TRANSFER_MARK} T` })), intakeRow]) };
  assert.equal(planTransferNew92({ book: done, stamp: "T2", snapshotDate: "2026-10-29", expectCount: 5 }).state, "ALREADY");
  const partial = { ...done, [SHEET.queue]: toQueue([...q0.map((r, i) => ({ ...r, "Перевірка": i === 2 ? "власник: правка" : `${TRANSFER_MARK} T` })), intakeRow]) };
  const pp = planTransferNew92({ book: partial, stamp: "T2", snapshotDate: "2026-10-29", expectCount: 5 });
  assert.equal(pp.state, "PRECONDITION_FAILED");
  assert.deepEqual(pp.checks.find((c) => /без позначки «ПЕРЕНЕСЕНО»/.test(c.name)).detail, [mtText(q0[2]["Offer ID"])]);
});

// ================================================================ новинки: ENG-28c — лише окрема команда «Знайти нові товари»
// (рішення власника 01.11: «Оновити товари» новинок у чергу не додає й неявно intake не запускає; ENG-28b робив це окремою сесією).
test("ENG-28c «Оновити товари» новинок у чергу не додає (лише аналітика, сесія intake не відкривається); «Знайти нові товари» додає стабільну новинку рівно один раз; повтор без дубля; звіт", async () => {
  const { findNewProducts } = await import("../src/pipeline/find-new.mjs");
  const w = await world();
  const extra = `<offer id="2990000777" available="true"><url>https://market-tools.com.ua/p2990000777-x.html</url><price>500</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>Новий</name><name_ua>Новий</name_ua><vendorCode>NEW-777</vendorCode><picture>https://images.prom.ua/1_n.jpg</picture><param name="Потужність" unit="Вт">10</param><description>Опис</description></offer>`;
  const xml = w.xml.replace("\n</offers>", "\n" + extra + "\n</offers>");
  const w2Store = new MemoryStore();
  const opened = [];
  const openSession = async (writer) => { opened.push(writer); return new WriteGateway({ sheets: w.sheets, read: w.readBook, store: w2Store }).open({ writer }); };
  const go = (x, min) => UP.updateProductsRun({ sheets: w.sheets, readBook: w.readBook, xml: x, source: FULL_URL, fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config: prodCfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, openSession });
  const inQueue = () => readSheet(w.sheets.book[SHEET.queue], SHEET.queue).rows.filter((x) => mtText(x["ID постачальника"]) === "2990000777").length;
  const q0 = JSON.stringify(w.sheets.book[SHEET.queue]);
  const r1 = await go(xml, 1);
  assert.equal(r1.state, "SYNCED", JSON.stringify(r1).slice(0, 400));
  assert.equal(r1.report.newItems.waiting, 1, "новинка вперше — чекає стабільності");
  const r2 = await go(dated(xml, 40), 40);
  assert.equal(r2.state, "SYNCED", JSON.stringify(r2).slice(0, 400));
  assert.equal(r2.report.newItems.candidates, 1, "стабільна новинка — лише в аналітичному підсумку");
  assert.equal(r2.report.newItems.addedToQueue, 0);
  assert.equal(r2.intake, null);
  assert.deepEqual(opened, ["sync", "sync"], "сесія intake не відкривається");
  assert.equal(JSON.stringify(w.sheets.book[SHEET.queue]), q0, "«Оновити товари» «Нових товарів» не змінює");
  for (const k of ["prices", "availability", "outOfFeedScope", "newItems", "supplierChanges", "presence", "conflicts", "hold", "queue", "serviceRows"]) assert.ok(k in r2.report, "звіт: " + k);
  assert.ok(!JSON.stringify(r2.report).includes("SECRET"), "у звіті немає параметрів адреси");
  // «Знайти нові товари»: база стабільності — підтверджений знімок «Оновити товари»; лише черга; повтор — без дубля.
  const mainBefore = JSON.stringify(w.sheets.book[SHEET.main]);
  const find = async (x, min) => { const s = await new WriteGateway({ sheets: w.sheets, read: w.readBook, store: w2Store }).open({ writer: "intake" }); try { return await findNewProducts({ sheets: w.sheets, readBook: w.readBook, xml: x, source: FULL_URL, fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config: prodCfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, session: s }); } finally { await s.close(); } };
  const f1 = await find(dated(xml, 80), 80);
  assert.equal(f1.state, "INTAKE_DONE", JSON.stringify(f1).slice(0, 500));
  assert.equal(f1.report.found.total, 1);
  assert.equal(f1.report.intake.added, 1);
  assert.equal(inQueue(), 1);
  assert.equal(JSON.stringify(w.sheets.book[SHEET.main]), mainBefore, "«Знайти нові товари» основного каталогу не змінює");
  const f2 = await find(dated(xml, 120), 120);
  assert.equal(f2.state, "NOTHING_NEW", JSON.stringify(f2).slice(0, 300));
  assert.equal(f2.report.excluded.queue, 1, "уже в черзі — не новинка");
  assert.equal(inQueue(), 1, "повтор без дубля");
  assert.equal(JSON.stringify(w.sheets.book[SHEET.main]), mainBefore);
});

test("ENG-28c «Оновити товари» з intake: true — параметр проігноровано (попередження у звіті), у чергу нічого; CLI: --intake для update відхиляється, --no-intake більше не потрібен", async () => {
  const w = await world();
  const extra = `<offer id="2990000888" available="true"><url>https://market-tools.com.ua/p2990000888-x.html</url><price>500</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>Новий</name><name_ua>Новий</name_ua><vendorCode>NEW-888</vendorCode><picture>https://images.prom.ua/1_n.jpg</picture><param name="Потужність" unit="Вт">10</param><description>Опис</description></offer>`;
  const xml = w.xml.replace("\n</offers>", "\n" + extra + "\n</offers>");
  const go = (x, min) => UP.updateProductsRun({ sheets: w.sheets, readBook: w.readBook, xml: x, source: FULL_URL, fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config: prodCfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store, intake: true,
    openSession: async (writer) => new WriteGateway({ sheets: w.sheets, read: w.readBook, store: new MemoryStore() }).open({ writer }) });
  await go(xml, 1);
  const r = await go(dated(xml, 40), 40);
  assert.equal(r.state, "SYNCED");
  assert.equal(r.report.newItems.candidates, 1, "у звіті — кандидат");
  assert.equal(r.report.newItems.addedToQueue, 0);
  assert.equal(r.intake, null);
  assert.match(r.intakeIgnored, /Знайти нові товари/);
  assert.ok(!readSheet(w.sheets.book[SHEET.queue], SHEET.queue).rows.some((x) => mtText(x["ID постачальника"]) === "2990000888"));
  const fs = await import("node:fs");
  const tool = fs.readFileSync(new URL("../tools/sheet-sync.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(tool, /--no-intake"\)/, "перемикача --no-intake немає: update ніколи не додає новинок");
  assert.match(tool, /process\.argv\.includes\("--intake"\)\) fail\("update: "/);
});
