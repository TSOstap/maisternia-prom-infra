/** Характеристики в синхронізації та intake (погоджено власником 23.10.2026; виправлення 7e4cebc).
 *  Схема — справжній файл schemas/prom/141717.xml («Шліфувальні машини») і 410402.xml («Електрогенератори»), підставлені під
 *  синтетичні ID категорій тестового каталогу (500…). Жодних вигаданих атрибутів. */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { mtPrices } from "../src/core/pricing.mjs";
import { rowSeal, SEAL_COLUMN, approvalManifest, GROUP_HEADERS } from "../src/core/seal.mjs";
import { objectsFromValues } from "../src/core/yml.mjs";
import { SHEET, MAIN_HEADERS, RAW_PARAMS, RAW_DESC_UA, PARAMS_ORIGIN, readPassport, samePassport } from "../src/core/sheet-sync.mjs";
import { loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";
import { WatchSim, fullOffer } from "./helpers/watch-sim.mjs";

const real = loadPromCatalog();
const catalogWith = (map) => ({ schemas: new Map(Object.entries(map).map(([cat, id]) => [cat, real.schemas.get(id)])), mappings: new Map(), units: { conversions: [] }, problems: [] });
const P = (name, value, unit = "") => ({ name, value, unit });
const mainRows = (sim) => sim.rows(SHEET.main);
const card = (sim, id) => mainRows(sim).find((r) => mtText(r["Offer ID"]) === id);
const supplierOf = (c, over = {}) => ({ id: mtText(c["ID постачальника"]), nameUa: c["Назва постачальника UA"], nameRu: c["Назва постачальника RU"], sku: c["Артикул постачальника"], url: c["URL постачальника"],
  price: Number(c["Ціна постачальника"]), available: true, pictures: JSON.parse(c["Фото JSON"]), params: JSON.parse(c["Характеристики JSON"]), ...over });
const passportOk = (sim) => samePassport(readPassport(sim.book[SHEET.passport]), approvalManifest(mainRows(sim), objectsFromValues(sim.book[SHEET.groups], GROUP_HEADERS)));
const priceOk = (r) => { const p = mtPrices(Number(r["Ціна постачальника"]), r["Наявність"] === "+"); return Number(r["Ціна кінцева"]) === p.final && Number(r["Ціна"]) === p.base; };

test("основний каталог (як 2437 підготовлених карток): нові колонки додано автоматично; підготовлене не перезаписано сирими; підтверджені поля схеми додано; ціни, печатки й паспорт цілі", async () => {
  const sim = new WatchSim({ catalog: catalogWith({ 500: "141717" }) });
  const c = mainRows(sim).find((r) => mtText(r["Категорія Prom ID"]) === "500");
  const other = mainRows(sim).find((r) => mtText(r["Категорія Prom ID"]) === "501");
  const id = mtText(c["Offer ID"]);
  const prepared = JSON.parse(c["Характеристики JSON"]);
  assert.ok(prepared.length, "у картки є підготовлені характеристики");
  // Постачальник передає ІНШІ (сирі, російською) характеристики, ніж підготовлені в картці, — ще до першого запуску
  const raw = [P("Питание", "Сеть 220В"), P("Вес", "2,2", "кг"), P("Состояние", "Новый")];
  sim.setOffer(supplierOf(c, { params: raw, price: Number(c["Ціна постачальника"]) + 100 }));
  sim.setOffer(supplierOf(other, { params: [P("Питание", "Аккумулятор")] }));
  const j0 = sim.book[SHEET.journal].length;
  const r = await sim.start();
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  assert.deepEqual(sim.book[SHEET.main][0].map(mtText), MAIN_HEADERS.slice(), "колонки контенту — у кінці аркуша");
  const a = card(sim, id);
  assert.equal(a[RAW_PARAMS], JSON.stringify(raw), "сирі характеристики — окремо");
  const params = JSON.parse(a["Характеристики JSON"]);
  for (const p of prepared) assert.ok(params.some((x) => x.name === p.name && x.value === p.value), "підготовлене збережено: " + p.name);
  assert.ok(params.some((x) => x.name === "Живлення" && x.value === "Мережа 220В"), "поле Prom «Живлення»");
  assert.ok(params.some((x) => x.name === "Вага" && x.value === "2.2" && x.unit === "кг"), "поле Prom «Вага»");
  assert.ok(!params.some((x) => x.name === "Стан"), "«Состояние: Новый» ≠ варіанту схеми «Новое» — без погодженого синоніма поле не заповнюється");
  assert.equal(JSON.parse(a[PARAMS_ORIGIN]).cat, "500");
  assert.ok(JSON.parse(a[PARAMS_ORIGIN]).items.filter((i) => i.s === "НЕВІДОМО").length === prepared.length, "походження підготовленого не визначено — збережено як є");
  assert.equal(mtText(a["Категорія Prom ID"]), "500", "синхронізація не змінює категорію Prom");
  assert.ok(priceOk(a));
  assert.equal(card(sim, mtText(other["Offer ID"]))["Характеристики JSON"], other["Характеристики JSON"], "без схеми — не змінено");
  assert.equal(card(sim, mtText(other["Offer ID"]))[RAW_PARAMS], JSON.stringify([P("Питание", "Аккумулятор")]));
  assert.ok(mainRows(sim).every((x) => rowSeal(x) === mtText(x[SEAL_COLUMN])), "печатки цілі");
  assert.ok(passportOk(sim));
  const jr = sim.book[SHEET.journal].slice(j0);
  assert.ok(jr.some((e) => e[2] === id && e[3] === "Характеристики JSON" && /ЗА СХЕМОЮ PROM/.test(e[6])));
  assert.ok(!jr.some((e) => e[3] === RAW_PARAMS || e[3] === RAW_DESC_UA), "перше заповнення сирих колонок — без записів у «Журнал»");
  // Наступна синхронізація — нічого нового
  const j1 = sim.book[SHEET.journal].length;
  assert.equal((await sim.sync()).state, "SYNCED");
  assert.equal(sim.book[SHEET.journal].slice(j1).filter((e) => e[2] === id).length, 0, "ідемпотентно");
  // Постачальник змінив живлення → підтверджене поле оновлено автоматично
  sim.setOffer(supplierOf(c, { params: [P("Питание", "Аккумулятор"), P("Вес", "2,2", "кг"), P("Состояние", "Новый")] }));
  await sim.sync();
  assert.ok(JSON.parse(card(sim, id)["Характеристики JSON"]).some((x) => x.name === "Живлення" && x.value === "Акумулятор"));
  assert.ok(passportOk(sim));
});

test("масова зміна підготовлених характеристик: у цьому запуску не застосовано (попередження), ціни й сирі дані оновлено — синхронізацію не зупинено", async () => {
  const sim = new WatchSim({ catalog: catalogWith({ 500: "141717" }) });
  sim.config.characteristics = { maxChangedRows: 0 };
  await sim.start();
  const c = mainRows(sim).find((r) => mtText(r["Категорія Prom ID"]) === "500");
  sim.setOffer(supplierOf(c, { params: [P("Вес", "2,2", "кг")], price: Number(c["Ціна постачальника"]) + 50 }));
  const r = await sim.sync();
  assert.equal(r.state, "SYNCED");
  assert.ok(r.warnings.some((w) => /^МАСОВА ЗМІНА ХАРАКТЕРИСТИК/.test(w)), JSON.stringify(r.warnings));
  const a = card(sim, mtText(c["Offer ID"]));
  assert.equal(a["Характеристики JSON"], c["Характеристики JSON"], "не застосовано");
  assert.equal(a[RAW_PARAMS], JSON.stringify([P("Вес", "2,2", "кг")]), "сирі оновлено");
  assert.equal(Number(a["Ціна постачальника"]), Number(c["Ціна постачальника"]) + 50, "ціна оновлена");
  assert.ok(sim.book[SHEET.journal].some((e) => e[3] === "ХАРАКТЕРИСТИКИ НЕ ЗАСТОСОВАНО"));
});

const QID = "2980000001";
async function queued(catalog, over = {}) {
  const sim = new WatchSim({ catalog });
  await sim.start();
  sim.setOffer(fullOffer(QID, { params: [P("Питание", "Сеть 220В"), P("Вес", "1,8", "кг")], ...over }));
  for (let k = 0; k < 3; k++) await sim.tick();
  assert.ok(sim.queueRow(QID), "у черзі");
  return sim;
}

test("черга: без категорії — сирі характеристики як раніше; категорія зі схемою — поля Prom; ручна правка зберігається; SHA і «Сторож» — за сирими даними; затвердження переносить колонки контенту", async () => {
  const sim = await queued(catalogWith({ 500: "141717" }));
  let q = sim.queueRow(QID);
  assert.equal(q["Характеристики JSON"], q[RAW_PARAMS], "без категорії — копія сирих");
  const sha0 = q["SHA даних постачальника"];
  sim.setCell(QID, "Категорія Prom ID", "500");
  await sim.sync();
  q = sim.queueRow(QID);
  assert.deepEqual(JSON.parse(q["Характеристики JSON"]), [P("Живлення", "Мережа 220В"), P("Вага", "1.8", "кг")]);
  assert.equal(q["SHA даних постачальника"], sha0, "зіставлення не змінює SHA даних постачальника");
  assert.doesNotMatch(q["Перевірка"], /ПОТРЕБУЄ/);
  // Власник виправив поле; постачальник потім змінив живлення — наше не перезаписано
  sim.setCell(QID, "Характеристики JSON", JSON.stringify([P("Живлення", "Мережа 380В"), P("Вага", "1.8", "кг")]));
  await sim.sync();
  sim.setOffer({ id: QID, params: [P("Питание", "Аккумулятор"), P("Вес", "1,8", "кг")] });
  await sim.sync();
  q = sim.queueRow(QID);
  assert.deepEqual(JSON.parse(q["Характеристики JSON"]), [P("Живлення", "Мережа 380В"), P("Вага", "1.8", "кг")]);
  assert.match(q["Перевірка"], /ручне значення «Мережа 380В» ≠ постачальник «Акумулятор»/);
  // Затвердження: колонки контенту переходять разом із карткою
  sim.setCell(QID, "Група ID", mainRows(sim)[0]["Група ID"]);
  sim.setDecision(QID, "ЗАТВЕРДЖЕНО (НЕ ДУБЛЬ)");
  const r = await sim.sync();
  assert.equal(r.stats.approved, 1, JSON.stringify(r.stats));
  const m = card(sim, QID);
  assert.equal(m[RAW_PARAMS], JSON.stringify([P("Питание", "Аккумулятор"), P("Вес", "1,8", "кг")]));
  assert.ok(JSON.parse(m[PARAMS_ORIGIN]).items.length);
  assert.ok(passportOk(sim));
});

test("опис: очищення СИРОЇ копії вмикається лише окремо (cleanDescriptions); власний SEO-опис ніколи не чиститься; оригінал зберігається", async () => {
  const desc = "Виробник: Zegor\nНапруга: 220 В\nМає тепло нагрів: так";
  // (а) за замовчуванням — не чиститься
  const g = [P("Гарантия", "12 мес.")]; // в «Електрогенераторах» такої назви атрибута немає — лишається сирою характеристикою
  let sim = await queued(catalogWith({ 500: "410402" }), { descUa: desc, params: g });
  sim.setCell(QID, "Категорія Prom ID", "500");
  await sim.sync();
  let q = sim.queueRow(QID);
  assert.deepEqual(JSON.parse(q["Характеристики JSON"]), [...g, P("Напруга", "220", "В")]);
  assert.match(q["Опис UA"], /Напруга: 220 В/);
  // (б) увімкнено — з сирої копії прибрано лише перенесене; оригінал — у «Опис постачальника UA»
  sim = await queued(catalogWith({ 500: "410402" }), { descUa: desc, params: g });
  sim.config.characteristics = { cleanDescriptions: true };
  sim.setCell(QID, "Категорія Prom ID", "500");
  await sim.sync();
  q = sim.queueRow(QID);
  assert.equal(q["Опис UA"], "<p>Виробник: Zegor\nМає тепло нагрів: так</p>");
  assert.match(q[RAW_DESC_UA], /Напруга: 220 В/, "оригінал збережено");
  assert.doesNotMatch(q["Перевірка"], /ПОТРЕБУЄ/, "очищення сирої копії — не «власне SEO»");
  // (в) власний SEO-опис — не чиститься
  sim = await queued(catalogWith({ 500: "410402" }), { descUa: desc, params: g });
  sim.config.characteristics = { cleanDescriptions: true };
  sim.setCell(QID, "Опис UA", "<p>Наш опис. Напруга: 220 В</p>");
  sim.setCell(QID, "Категорія Prom ID", "500");
  await sim.sync();
  assert.equal(sim.queueRow(QID)["Опис UA"], "<p>Наш опис. Напруга: 220 В</p>");
});

test("дослівні характеристики постачальника (походження відоме) оновлюються й прибираються разом із ним; підготовлені відмінні — ні", async () => {
  const sim = new WatchSim({ catalog: catalogWith({ 500: "141717" }) });
  await sim.start();
  const c = mainRows(sim).find((r) => mtText(r["Категорія Prom ID"]) === "500");
  const id = mtText(c["Offer ID"]);
  const prepared = JSON.parse(c["Характеристики JSON"]);
  assert.equal(c[RAW_PARAMS], c["Характеристики JSON"], "підготовлене = сирому постачальника (дослівно)");
  const changed = prepared.map((p, i) => (i === 0 ? { ...p, value: p.value + " (нове)" } : p)).slice(0, -1);
  sim.setOffer(supplierOf(c, { params: changed }));
  await sim.sync();
  const got = JSON.parse(card(sim, id)["Характеристики JSON"]);
  assert.deepEqual(got, changed, "значення оновлено, прибране постачальником — прибрано");
  assert.ok(passportOk(sim));
});
