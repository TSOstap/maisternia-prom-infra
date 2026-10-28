/** Зміни постачальника під тим самим ID (погоджено 23.10.2026): приймаються автоматично в основному каталозі й у черзі.
 *  Модель, артикул, назви, характеристики, URL, фото (повним списком, у порядку постачальника), ціна, наявність.
 *  Наше SEO не перезаписується — лише інформаційне попередження. Offer ID незмінний. Захист від неповного / помилкового XML. */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { mtPrices } from "../src/core/pricing.mjs";
import { rowSeal, SEAL_COLUMN, approvalManifest } from "../src/core/seal.mjs";
import { objectsFromValues, offerXml } from "../src/core/yml.mjs";
import { GROUP_HEADERS } from "../src/core/seal.mjs";
import { SHEET, extractFullOffers, readPassport, samePassport } from "../src/core/sheet-sync.mjs";
import { syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";
import { WatchSim, fullOffer } from "./helpers/watch-sim.mjs";
import { STATE_A } from "./helpers/state-a.mjs";

const mainRows = (sim) => sim.rows(SHEET.main);
const card = (sim, offerId) => mainRows(sim).find((r) => mtText(r["Offer ID"]) === offerId);
/** Offer постачальника = поточні дані картки (як у фіді) + зміни. */
function supplierOf(c, over = {}) {
  return { id: mtText(c["ID постачальника"]), nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], sku: c["Артикул постачальника"], url: c["URL постачальника"],
    price: Number(c["Ціна постачальника"]), available: true, pictures: JSON.parse(c["Фото JSON"]), params: JSON.parse(c["Характеристики JSON"]), ...over };
}
const priceOk = (r) => { const p = mtPrices(Number(r["Ціна постачальника"]), r["Наявність"] === "+"); return Number(r["Ціна кінцева"]) === p.final && Number(r["Ціна"]) === p.base; };
async function syncWith(sim, fetchFull) {
  const xml = sim.xml();
  return syncSheet({ sheets: sim.sheets, readBook: sim.readBook, parsed: await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true }), fetchFull: fetchFull || (async (ids) => extractFullOffers(xml, ids)), stamp: sim.stamp(), config: sim.config, now: sim.now, catalog: loadPromCatalog(undefined, STATE_A) });
}
const passportOk = (sim) => samePassport(readPassport(sim.book[SHEET.passport]), approvalManifest(mainRows(sim), objectsFromValues(sim.book[SHEET.groups], GROUP_HEADERS)));

test("основний каталог: модель / артикул / назви / сирі характеристики / фото змінились під тим самим ID → прийнято автоматично; ціна й наявність оновлені; SEO збережено; Offer ID той самий; печатка й паспорт оновлено", async () => {
  const sim = new WatchSim();
  await sim.start();
  const c = mainRows(sim).find((r) => !mtText(r["Код товару Prom"]));
  const offerId = mtText(c["Offer ID"]);
  const seo = ["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Запити UA", "Запити RU"].map((k) => c[k]);
  sim.setOffer({ ...supplierOf(c), nameUa: "Зварювальний напівавтомат PROFI-TEC MIG-22FD Professional 6,3 кВт (008388)", nameRu: "Сварочный полуавтомат PROFI-TEC MIG-22FD Professional 6.3 кВт (008388)",
    sku: "008388", model: "MIG-22FD Professional", params: [{ name: "Максимальний зварювальний струм", value: "200", unit: "А" }], pictures: ["https://images.prom.ua/4900000002_b.jpg", "https://images.prom.ua/4900000001_a.jpg"], price: 14949, available: true });
  const r = await sim.sync();
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  const a = card(sim, offerId);
  assert.equal(mtText(a["Offer ID"]), offerId, "Offer ID незмінний");
  assert.match(a["Назва постачальника UA"], /MIG-22FD/);
  assert.equal(a["Артикул постачальника"], "008388");
  assert.equal(a["Код товару Prom"], "008388", "код Prom іде за артикулом (був порожній)");
  assert.equal(a["Модель"], "MIG-22FD Professional");
  assert.equal(a["Характеристики постачальника JSON"], JSON.stringify([{ name: "Максимальний зварювальний струм", value: "200", unit: "А" }]), "сирі характеристики — нові");
  assert.equal(a["Характеристики JSON"], c["Характеристики JSON"], "підготовлені характеристики без схеми категорії не перезаписано сирими");
  assert.equal(a["Фото JSON"], JSON.stringify(["https://images.prom.ua/4900000002_b.jpg", "https://images.prom.ua/4900000001_a.jpg"]));
  assert.deepEqual(["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Запити UA", "Запити RU"].map((k) => a[k]), seo, "наше SEO не змінено");
  assert.equal(a["Стан синхронізації"], "ЗІСТАВЛЕНО", "не ЗМІНА_ІДЕНТИЧНОСТІ — ціни не заблоковано");
  assert.equal(Number(a["Ціна постачальника"]), 14949);
  assert.ok(priceOk(a));
  assert.equal(a["Наявність"], "+");
  assert.equal(rowSeal(a), mtText(a[SEAL_COLUMN]), "печатку перераховано");
  assert.ok(passportOk(sim), "паспорт відповідає каталогу");
  const info = sim.book[SHEET.journal].filter((e) => e[2] === offerId && e[3] === "ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ");
  assert.equal(info.length, 1);
  assert.match(info[0][5], /артикул: було «[^»]+» → стало «008388»/);
  assert.match(info[0][6], /^ІНФОРМАЦІЙНО: наше SEO не змінено/);
  // Наступна синхронізація — без «змін поза затвердженням», без повторних попереджень
  const j = sim.book[SHEET.journal].length;
  const r2 = await sim.sync();
  assert.equal(r2.state, "SYNCED", JSON.stringify(r2));
  assert.equal(sim.book[SHEET.journal].slice(j).filter((e) => e[2] === offerId).length, 0);
});

test("основний каталог: фото — повним списком постачальника (заміна, додавання, видалення, порядок, головне фото)", async () => {
  const sim = new WatchSim();
  await sim.start();
  const c = mainRows(sim)[5];
  const old = JSON.parse(c["Фото JSON"]);
  const next = [old[2], "https://images.prom.ua/4911111111_new.jpg", old[0]]; // нове головне, одне нове, частину прибрано
  sim.setOffer(supplierOf(c, { pictures: next }));
  await sim.sync();
  assert.equal(card(sim, mtText(c["Offer ID"]))["Фото JSON"], JSON.stringify(next));
  // Лише змінений порядок — теж відображається
  sim.setOffer(supplierOf(c, { pictures: next.slice().reverse() }));
  await sim.sync();
  assert.equal(card(sim, mtText(c["Offer ID"]))["Фото JSON"], JSON.stringify(next.slice().reverse()));
});

test("фото не стираються: повний XML недоступний, неповний (< 95%) або без фото в позиції — список лишається; ціни при цьому оновлюються", async () => {
  const sim = new WatchSim();
  await sim.start();
  const c = mainRows(sim)[6];
  const id = mtText(c["Offer ID"]);
  const photos = c["Фото JSON"];
  // (а) повний XML недоступний
  sim.setOffer(supplierOf(c, { pictures: ["https://images.prom.ua/4922222222_x.jpg"], price: 5555 }));
  let r = await syncWith(sim, async () => { throw new Error("тайм-аут"); });
  assert.equal(r.state, "SYNCED");
  assert.equal(card(sim, id)["Фото JSON"], photos);
  assert.equal(Number(card(sim, id)["Ціна постачальника"]), 5555, "ціна оновлена");
  assert.ok(r.warnings.some((w) => /повний XML недоступний/.test(w)));
  // (б) повний XML неповний — лише декілька позицій
  const xml = sim.xml();
  r = await syncWith(sim, async (ids) => extractFullOffers(xml, ids.slice(0, 5)));
  assert.equal(card(sim, id)["Фото JSON"], photos);
  assert.ok(r.warnings.some((w) => /повний XML неповний/.test(w)));
  // (в) у повній позиції немає фото — не стираємо
  sim.setOffer(supplierOf(c, { pictures: [] }));
  await sim.sync();
  assert.equal(card(sim, id)["Фото JSON"], photos);
});

test("захист від помилкового фіду: назви / артикули змінились у багатьох товарах → нічого не записано (лише «Журнал»)", async () => {
  const sim = new WatchSim();
  sim.config.policy = { ...(sim.config.policy || {}), anomaly: { ...(sim.config.policy?.anomaly || {}), maxNewlyMissing: 3, maxNewlyMissingRatio: 0.01 } };
  await sim.start();
  for (const c of mainRows(sim).slice(0, 6)) sim.setOffer(supplierOf(c, { sku: "BROKEN-" + c["Offer ID"].slice(-3) }));
  const before = JSON.stringify(sim.book[SHEET.main]);
  const r = await sim.sync();
  assert.equal(r.state, "ABORTED");
  assert.equal(r.block.type, "МАСОВА ЗМІНА ДАНИХ ПОСТАЧАЛЬНИКА");
  assert.equal(JSON.stringify(sim.book[SHEET.main]), before);
});

test("«Код товару Prom»: власний код (≠ старому артикулу) не змінюється; новий артикул уже зайнятий іншою карткою — код не змінюється, примітка в «Журналі»", async () => {
  const sim = new WatchSim();
  await sim.start();
  const custom = mainRows(sim).find((r) => /^MT-/.test(mtText(r["Код товару Prom"])));
  sim.setOffer(supplierOf(custom, { sku: "NEWSKU-1" }));
  const empty = mainRows(sim).filter((r) => !mtText(r["Код товару Prom"]));
  const [x, y] = empty;
  sim.setOffer(supplierOf(x, { sku: mtText(y["Артикул постачальника"]) })); // артикул іншої картки
  await sim.sync();
  const a = card(sim, mtText(custom["Offer ID"]));
  assert.equal(a["Артикул постачальника"], "NEWSKU-1");
  assert.equal(a["Код товару Prom"], custom["Код товару Prom"], "власний код Prom не змінено");
  const b = card(sim, mtText(x["Offer ID"]));
  assert.equal(b["Код товару Prom"], "", "зайнятий артикул — код не змінено");
  assert.ok(sim.book[SHEET.journal].some((e) => e[2] === mtText(x["Offer ID"]) && /^НЕ ЗМІНЕНО: артикул/.test(e[6])));
});

test("YML: картка з новими даними постачальника формує offer з новими фото й кодом Prom; статус імпорту не змінено", async () => {
  const sim = new WatchSim();
  await sim.start();
  const c = mainRows(sim).find((r) => !mtText(r["Код товару Prom"]));
  sim.setOffer(supplierOf(c, { sku: "YML-NEW-1", pictures: ["https://images.prom.ua/4933333333_y.jpg"] }));
  await sim.sync();
  const a = card(sim, mtText(c["Offer ID"]));
  assert.equal(a["Статус імпорту"], "ДОЗВОЛЕНО");
  const groups = Object.fromEntries(objectsFromValues(sim.book[SHEET.groups], GROUP_HEADERS).map((g) => [mtText(g["Ідентифікатор_групи"]), g]));
  const xml = offerXml(a, Date.parse(a["Оновлено"]), groups);
  assert.match(xml, /<vendorCode>YML-NEW-1<\/vendorCode>/);
  assert.match(xml, /<picture>https:\/\/images\.prom\.ua\/4933333333_y\.jpg<\/picture>/);
  assert.equal((xml.match(/<picture>/g) || []).length, 1);
});

test("черга, власне SEO: модель / артикул / фото / ціна / наявність змінились → сирі дані й модель оновлено, фото — новим списком, ціни перераховано; SEO збережено; попередження є", async () => {
  const sim = new WatchSim();
  await sim.start();
  const ID = "2991000001";
  sim.setOffer(fullOffer(ID, { model: "MIG-20HB Master", sku: "008395", price: 11499, pictures: ["https://images.prom.ua/4944444441_a.jpg", "https://images.prom.ua/4944444442_b.jpg"] }));
  for (let k = 0; k < 3; k++) await sim.tick();
  sim.setCell(ID, "Назва UA", "Наш SEO: зварювальний апарат");
  await sim.sync();
  sim.setOffer({ id: ID, model: "MIG-22FD Professional", sku: "008388", price: 14949, available: false, pictures: ["https://images.prom.ua/4944444442_b.jpg", "https://images.prom.ua/4944444443_c.jpg"] });
  await sim.sync();
  const q = sim.queueRow(ID);
  assert.equal(q["Назва UA"], "Наш SEO: зварювальний апарат");
  assert.equal(q["Артикул постачальника"], "008388");
  assert.equal(q["Модель"], "MIG-22FD Professional");
  assert.equal(q["Фото JSON"], JSON.stringify(["https://images.prom.ua/4944444442_b.jpg", "https://images.prom.ua/4944444443_c.jpg"]));
  assert.equal(Number(q["Ціна постачальника"]), 14949);
  assert.equal(q["Наявність"], "-");
  assert.ok(priceOk(q));
  assert.match(q["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ: Постачальник змінив назву \/ артикул \/ модель товару\..*модель: було «MIG-20HB Master» → стало «MIG-22FD Professional»/);
  assert.match(q["Перевірка"], /фото: \+1 нових, −1 прибрано/);
});

test("черга, сире SEO: лише змінено порядок фото → новий порядок у таблиці, без попереджень", async () => {
  const sim = new WatchSim();
  await sim.start();
  const ID = "2991000002";
  const pics = ["https://images.prom.ua/4955555551_a.jpg", "https://images.prom.ua/4955555552_b.jpg", "https://images.prom.ua/4955555553_c.jpg"];
  sim.setOffer(fullOffer(ID, { pictures: pics }));
  for (let k = 0; k < 3; k++) await sim.tick();
  sim.setOffer({ id: ID, pictures: [pics[2], pics[0], pics[1]] });
  await sim.sync();
  assert.equal(sim.queueRow(ID)["Фото JSON"], JSON.stringify([pics[2], pics[0], pics[1]]));
  assert.doesNotMatch(sim.queueRow(ID)["Перевірка"], /ПОТРЕБУЄ/);
});
