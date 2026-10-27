/** Пакет N1-2 (Hermes, 27.10.2026; план N0-00, розд. 5): запасне джерело для картки когорти N0 без <param>, у якої звичайні пари
 *  опису не дають жодної характеристики, — однорідні списки «Назва – значення», рядки «• Назва: значення», «Назва: значення» у
 *  таблиці-обгортці. Розбір — окрема функція (спільний descriptionPairs не змінюється); діапазони, комплектація / склад набору,
 *  речення, тире на початку значення, одиниця не тієї величини, числа через пробіл, невідома сутність — не передаються, поіменно
 *  з причиною. Товари й значення — синтетичні. */
import test from "node:test";
import assert from "node:assert/strict";
import { descriptionPairs, n1ListPairs } from "../src/core/prom-attributes.mjs";

const UL = (items) => `<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`;
const kv = (r) => r.pairs.map((p) => [p.key, p.value]);
const why = (r, k) => r.skipped.find((x) => x.key.startsWith(k))?.why || "";

test("N1-2 розбір: однорідний список «Назва – значення» (≥ 3 пункти, ≥ 2/3 — пари); короткий / неоднорідний — без розбору", () => {
  const r = n1ListPairs(UL(["Потужність - 1100 Вт", "Вага – 4.7 кг", "Число обертів на холостому ходу (об/хв) — 600"]));
  assert.deepEqual(kv(r), [["Потужність", "1100 Вт"], ["Вага", "4.7 кг"], ["Число обертів на холостому ходу (об/хв)", "600"]]);
  assert.ok(r.pairs.every((p) => p.via === "list" && p.end > p.start));
  assert.deepEqual(n1ListPairs(UL(["Потужність - 1100 Вт", "Вага - 4.7 кг"])).pairs, [], "менше 3 пунктів");
  assert.deepEqual(n1ListPairs(UL(["Потужність - 1100 Вт", "Надійний корпус", "Зручна рукоятка", "Легкий старт"])).pairs, [], "переваги, пар менше 2/3");
  // роздільник — лише тире з пробілами з обох боків; дефіс у слові / моделі не розділяє
  assert.deepEqual(kv(n1ListPairs(UL(["Тип акумулятора - Li-Ion", "Модель - ХТ-100", "Напруга - 18 В"]))), [["Тип акумулятора", "Li-Ion"], ["Модель", "ХТ-100"], ["Напруга", "18 В"]]);
  assert.deepEqual(n1ListPairs(UL(["Li-Ion батарея", "ХТ-100 модель", "Pro-серія"])).pairs, []);
  // спільний descriptionPairs — як раніше (списки з тире не розбирає)
  assert.deepEqual(descriptionPairs(UL(["Потужність - 1100 Вт", "Вага - 4.7 кг", "Напруга - 230 В"])), []);
});

test("N1-2 розбір: діапазон, комплектація / склад набору, речення, тире на початку значення — не передаються, поіменно", () => {
  const r = n1ListPairs(UL([
    "Обороти на холостому ходу 800 – 3 000 об / хв",
    "Генератор - 1шт",
    "Вилка штепсельна - 2 шт.",
    "Висока точність різання – розташування лінії різу завжди одне і те ж, незалежно від кута нахилу.",
    "Маса - - 720 грамів",
    "Потужність - 1100 Вт",
    "Вага - 4.7 кг",
    "Напруга - 230 В",
  ]));
  assert.deepEqual(kv(r), [["Потужність", "1100 Вт"], ["Вага", "4.7 кг"], ["Напруга", "230 В"]]);
  assert.match(why(r, "Обороти"), /закінчується числом/);
  assert.match(why(r, "Генератор"), /комплектац|склад/);
  assert.match(why(r, "Вилка"), /комплектац|склад/);
  assert.match(why(r, "Висока точність"), /речення|не характеристика/);
  assert.match(why(r, "Маса"), /тире на початку/);
  // «N шт» під ключем кількості — характеристика (не склад набору)
  assert.deepEqual(kv(n1ListPairs(UL(["Кількість в упаковці – 3000 шт.", "Висота – 25 мм", "Ширина – 12 мм"]))), [["Кількість в упаковці", "3000 шт."], ["Висота", "25 мм"], ["Ширина", "12 мм"]]);
});

test("N1-2 розбір: одиниця не тієї величини, числа через пробіл, невідома сутність — ні; кінцева крапка — лише після числа / одиниці", () => {
  const r = n1ListPairs(UL([
    "Напруга - 230 Вт",
    "Потужність - 220 В",
    "Частота - 50 кВт",
    "Діапазон струмів - 5 160 А",
    "cos &phi; - 0,99",
    "Потужність двигуна - 1200Вт.",
    "Діаметр - 200мм.",
    "Товщина кола - 1.3.",
    "Потужність двигуна приводу - 5.5 л. с.",
    "Країна - Німеччина.",
  ]));
  assert.match(why(r, "Напруга"), /одиниц/);
  assert.match(why(r, "Потужність - ") || r.skipped.find((x) => x.key === "Потужність")?.why || "", /одиниц/);
  assert.match(why(r, "Частота"), /одиниц/);
  assert.match(why(r, "Діапазон струмів"), /через пробіл/);
  assert.match(why(r, "cos"), /сутність/);
  assert.deepEqual(kv(r), [["Потужність двигуна", "1200Вт"], ["Діаметр", "200мм"], ["Товщина кола", "1.3"], ["Потужність двигуна приводу", "5.5 л. с."], ["Країна", "Німеччина."]]);
});

test("N1-2 розбір: «• Назва: значення» — знімається лише маркер; «Назва: значення» у таблиці-обгортці (1 клітинка) — як поза таблицею", () => {
  const b = n1ListPairs("<p>• Місткість: 5 А·год<br>• Габарити упаковки: 131х88х78 мм<br>- Країна-виробник: Китай<br>• Маса: - 720 грамів</p>");
  assert.deepEqual(kv(b), [["Місткість", "5 А·год"], ["Габарити упаковки", "131х88х78 мм"], ["Країна-виробник", "Китай"]]);
  assert.match(why(b, "Маса"), /тире на початку/);
  // склад набору з маркером — не характеристика (deferred audit)
  const kit = n1ListPairs("<p>• Головка шестигранна торцева 1/2\" (12 шт.): 14, 15, 16, 17 мм<br>• Г-подібні шестигранні ключі 3 шт.: 1.5, 2, 2.5 мм</p>");
  assert.deepEqual(kit.pairs, []);
  assert.ok(kit.skipped.every((x) => /склад|комплектац/.test(x.why)), JSON.stringify(kit.skipped));
  // таблиця-обгортка: рядок з однією клітинкою зі списком «Назва: значення»
  const lt = n1ListPairs(`<table><tr><td colspan="2"><h3>Технічні характеристики:</h3></td></tr><tr><td><ul><li>Тип шліфувальні машини: стрічкова</li><li>Потужність: 1050 Вт</li><li>Довжина кабелю: 1.5 м</li></ul></td></tr></table>`);
  assert.deepEqual(kv(lt), [["Тип шліфувальні машини", "стрічкова"], ["Потужність", "1050 Вт"], ["Довжина кабелю", "1.5 м"]]);
  // таблиця з парами в двох клітинках — не обгортка (її розбирає descriptionPairs), тут — нічого
  assert.deepEqual(n1ListPairs(`<table><tr><td>Потужність</td><td>1050 Вт</td></tr></table>`).pairs, []);
  // без маркера рядки «Назва: значення» поза таблицею — це вже звичайні пари (descriptionPairs), N1-2 їх не дублює
  assert.deepEqual(n1ListPairs("<p>Потужність: 1050 Вт</p>").pairs, []);
});

// ---------- генератор: межа N1-2 і UA ↔ RU ----------
import { buildCharacteristics } from "../src/core/prom-attributes.mjs";
import { TECH_RULES, loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";
const catalog = loadPromCatalog(undefined, { freezeFile: "", a3PairsFile: "", n0CohortFile: "" }); // ізольовано від MM_*
const SAW = "1250302";
const B = (o) => buildCharacteristics({ schema: catalog.schemas.get(SAW), categoryId: SAW, current: [], names: catalog.names, mapping: catalog.mappings.get(SAW), units: catalog.units, mode: "main", brand: "Test", ...o });
const N1 = { techRules: [...TECH_RULES, "N1"] };
const hard = (r) => r.needsReview.filter((x) => x.kind !== "інформаційно");
const has = (r, re, v) => r.params.some((p) => re.test(p.name) && (v === undefined || `${p.value}${p.unit ? " " + p.unit : ""}` === v || p.value === v));
const UA = UL(["Споживана потужність - 1100 Вт", "Вага - 4.7 кг", "Країна походження - Німеччина", "Генератор - 1шт"]);
const RU = UL(["Потребляемая мощность - 1100 Вт", "Вес - 4.7 кг", "Страна происхождения - Германия", "Генератор - 1шт"]);

test("N1-2 генератор: лише з N1, лише без <param> і коли звичайні пари не дають нічого; інакше — як раніше", () => {
  assert.deepEqual(B({ descUa: UA, descRu: RU, techRules: [...TECH_RULES] }).params, [], "без N1 — як раніше");
  const on = B({ descUa: UA, descRu: RU, ...N1 });
  assert.ok(has(on, /Споживана потужність/) && has(on, /^Вага/) && has(on, /Країна походження/), JSON.stringify(on.params));
  assert.ok(!on.params.some((p) => /Генератор/.test(p.name)), "склад набору не передається");
  assert.ok(on.listSkipped.some((x) => /Генератор/.test(x.key) && /склад|комплектац/.test(x.why)), JSON.stringify(on.listSkipped));
  // є звичайна пара «Назва: значення» — N1-2 не вмикається (лише запасне джерело)
  const colon = B({ descUa: "<p>Довжина шини: 400 мм</p>" + UA, descRu: "<p>Длина шины: 400 мм</p>" + RU, ...N1 });
  assert.ok(has(colon, /Довжина шини/) && !has(colon, /Країна походження/), JSON.stringify(colon.params));
  // є <param> у XML — N1-2 не вмикається
  const xml = B({ rawParams: [{ name: "Состояние", value: "Новое", unit: "" }], descUa: UA, descRu: RU, ...N1 });
  assert.ok(!has(xml, /Країна походження/), JSON.stringify(xml.params));
});

test("N1-2 генератор: RU-пари — лише для перевірки підтверджених словником назв; окремо (RU-назвою / RU-полем) — ніколи", () => {
  const on = B({ descUa: UA, descRu: RU, ...N1 });
  assert.ok(!on.params.some((p) => /Страна|Потребляемая|^Вес/.test(p.name)), "RU-назви не передаються: " + JSON.stringify(on.params));
  assert.equal(on.ruOnly, 0);
  // словник підтверджує назву, значення різні — справжній конфлікт (як для звичайних пар)
  const diff = B({ descUa: UL(["Споживана потужність - 1100 Вт", "Вага - 4.7 кг", "Довжина кабелю - 2 м"]), descRu: UL(["Потребляемая мощность - 1200 Вт", "Вес - 4.7 кг", "Длина кабеля - 2 м"]), ...N1 });
  assert.equal(hard(diff).length, 1, JSON.stringify(diff.needsReview));
  // поле категорії лише в RU-списку — не заповнюється з RU
  const ruField = B({ descUa: UL(["Країна походження - Німеччина", "Колір - синій", "Матеріал - сталь"]), descRu: UL(["Страна происхождения - Германия", "Цвет - синий", "Потребляемая мощность - 1100 Вт"]), ...N1 });
  assert.ok(!has(ruField, /Споживана потужність/), "поле з RU-пари N1-2 не заповнюється: " + JSON.stringify(ruField.params));
});

test("N1-2 генератор: бренд ≠ «Виробник» — не передається (аудит); рішення власника вище; повторний запуск стабільний", () => {
  const br = B({ descUa: UL(["Виробник - Угорщина", "Вага - 4.7 кг", "Колір - синій"]), descRu: UL(["Производитель - Венгрия", "Вес - 4.7 кг", "Цвет - синий"]), ...N1 });
  assert.ok(!br.params.some((p) => /Виробник|Бренд/.test(p.name) && /Угорщина|Венгрия/.test(p.value)), JSON.stringify(br.params));
  assert.ok(br.listSkipped.some((x) => /Виробник/.test(x.key) && /бренд/i.test(x.why)), JSON.stringify(br.listSkipped));
  const same = B({ descUa: UL(["Виробник - Test", "Вага - 4.7 кг", "Колір - синій"]), descRu: UL(["Производитель - Test", "Вес - 4.7 кг", "Цвет - синий"]), ...N1 });
  assert.ok(same.params.some((p) => /Виробник|Бренд/.test(p.name) && p.value === "Test"), JSON.stringify(same.params));
  // бренд — офіційне написання з «Виробник» (не варіант опису «TEST.»)
  const off = B({ descUa: UL(["Виробник - TEST.", "Вага - 4.7 кг", "Колір - синій"]), descRu: UL(["Производитель - TEST.", "Вес - 4.7 кг", "Цвет - синий"]), ...N1 });
  assert.ok(off.params.some((p) => /Виробник|Бренд/.test(p.name) && p.value === "Test"), JSON.stringify(off.params));
  const own = B({ descUa: UA, descRu: RU, ...N1, ownerValues: [{ name: "Країна походження", value: "Китай", action: "set", source: "тест", date: "2026-10-27", priority: 1, autoUpdate: false }] });
  assert.ok(has(own, /Країна походження/, "Китай") && !has(own, /Країна походження/, "Німеччина"), JSON.stringify(own.params));
  const r1 = B({ descUa: UA, descRu: RU, ...N1 });
  const r2 = B({ descUa: UA, descRu: RU, current: r1.params, provenance: r1.provenance, ...N1 });
  assert.deepEqual(r2.params, r1.params);
  assert.equal(r2.changed, false);
});

test("N1-2 розбір: список переваг, кілька пар в одному пункті, довгий опис без чисел, одиниця не до всіх величин ключа — ні", () => {
  // «характеристика – перевага» (специфікація в назві, пояснення в значенні) — увесь список у аудит
  const adv = n1ListPairs(UL(["Різьба 1 1/4\" UNC – сумісність з більшістю професійних алмазних установок.", "Діаметр 182 мм, довжина 450 мм – для глибокого буріння великих отворів.", "Сегментована конструкція – оптимальне охолодження, швидке буріння, тривалий ресурс.", "Призначене для мокрого буріння – максимальна продуктивність і мінімальний знос."]));
  assert.deepEqual(adv.pairs, []);
  assert.ok(adv.skipped.length === 4 && adv.skipped.every((x) => /переваг/.test(x.why)), JSON.stringify(adv.skipped));
  // звичайний список з короткими словесними значеннями — не переваги
  assert.equal(n1ListPairs(UL(["Системи пиловидалення - для промислових пилососів", "Клас - побутовий", "Тип комплектуючого - мішки для пилу", "Країна походження - Німеччина"])).pairs.length, 4);
  const r = n1ListPairs(UL([
    "Тип приладу - лінійний кут самовирівнювання - 4 град.",
    "Комплектація - Акумуляторна батарея - 1 шт.",
    "Додатково - Регульована насадка, Надійний механізм, Металева помпа, Надійні колеса для транспортування",
    "Габаритні розміри Маса - 40 кг",
    "Довжина кабелю - 1.5 м",
    "Режими роботи - свердління з ударом, свердління, довбання",
    "Вага - 4.8",
  ]));
  assert.deepEqual(kv(r), [["Довжина кабелю", "1.5 м"], ["Режими роботи", "свердління з ударом, свердління, довбання"], ["Вага", "4.8"]]);
  assert.match(why(r, "Тип приладу"), /кілька пар/);
  assert.match(why(r, "Комплектація"), /кілька пар|склад|комплектац/);
  assert.match(why(r, "Додатково"), /опис|переваг/);
  assert.match(why(r, "Габаритні розміри Маса"), /одиниц/);
});

test("N1-2 розбір: розміри «A×B×C мм» (латинська / кирилична «х», «×», «*») — одиниця після останнього числа", () => {
  const r = n1ListPairs(UL(["Габарити упаковки - 131х88х78 мм", "Розмір - 480 × 300 × 270 мм", "Довжина - 330*235 мм", "Висота - 12 кг"]));
  assert.deepEqual(kv(r), [["Габарити упаковки", "131х88х78 мм"], ["Розмір", "480 × 300 × 270 мм"], ["Довжина", "330*235 мм"]]);
  assert.match(why(r, "Висота"), /одиниц/);
  // одиниця після розмірів перевіряється: «480 × 300 × 270 кг» для розміру — ні
  assert.match(why(n1ListPairs(UL(["Розмір - 480 × 300 × 270 кг", "Вага - 4.7 кг", "Напруга - 230 В"])), "Розмір"), /одиниця «кг»/);
});

test("N1-2: розміри без одиниці після чисел («62х48.5х53») — без хибної одиниці «х»; список лише з відкинутих пунктів — аудит не губиться", () => {
  const d = n1ListPairs(UL(["Габарити ВхШхГ, см - 62х48.5х53", "Вага генератора, кг - 45", "Об'єм бака, л - 15"]));
  assert.deepEqual(kv(d), [["Габарити ВхШхГ, см", "62х48.5х53"], ["Вага генератора, кг", "45"], ["Об'єм бака, л", "15"]]);
  const adv = B({ descUa: UL(["Різьба 1 1/4\" UNC – сумісність з більшістю професійних алмазних установок.", "Діаметр 182 мм – для глибокого буріння великих отворів.", "Сегментована конструкція – оптимальне охолодження, швидке буріння, тривалий ресурс."]), descRu: "", ...N1 });
  assert.deepEqual(adv.params, []);
  assert.ok(adv.listSkipped.length === 3 && adv.listSkipped.every((x) => /переваг/.test(x.why)), JSON.stringify(adv.listSkipped));
});

// ---------- синхронізація ----------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cohortFingerprint, freezeFingerprint } from "../src/pipeline/prom-schemas.mjs";
test("N1-2 синхронізація: лише refreshMainRow для когорти; повторний запуск (з уже переданими характеристиками) стабільний; черга й нові — як раніше", async () => {
  const { refreshMainRow, refreshQueueRow, candidateRow } = await import("../src/core/sheet-sync.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n12-"));
  const w = (n, x) => { const f = path.join(dir, n); fs.writeFileSync(f, JSON.stringify(x)); return f; };
  const prot = ["91"], scope = ["90", "91", "222"], co = ["90"];
  const ff = w("freeze.json", { v: 1, rev: 1, date: "2026-10-27", source: "тест", count: 1, ids: prot, scope: { count: scope.length, ids: scope } });
  const fk = w("freeze-contract.json", { v: 1, rev: 1, date: "2026-10-27", source: "тест", count: 1, fingerprint: freezeFingerprint(prot), scope: { count: scope.length, fingerprint: freezeFingerprint(scope) } });
  const cf = w("cohort.json", { v: 1, rev: 1, date: "2026-10-27", source: "тест", count: 1, fingerprint: cohortFingerprint(co), ids: co });
  const ck = w("cohort-contract.json", { v: 1, rev: 1, date: "2026-10-27", source: "тест", count: 1, fingerprint: cohortFingerprint(co) });
  const on = loadPromCatalog(undefined, { freezeFile: ff, freezeContractFile: fk, a3PairsFile: "", n0CohortFile: cf, n0CohortContractFile: ck });
  const off = loadPromCatalog(undefined, { freezeFile: ff, freezeContractFile: fk, a3PairsFile: "", n0CohortFile: "" });
  const full = { params: [], pictures: [], descriptionUa: UA, descriptionRu: RU };
  const row = (id) => ({ "Offer ID": id, "ID постачальника": id, "Категорія Prom ID": SAW, "Виробник": "Test", "Характеристики JSON": "[]", "Назва постачальника UA": "Пила тестова", "Назва постачальника RU": "" });
  const offer = (id) => ({ id, vendor: "Test", sku: "", nameUa: "Пила тестова", nameRu: "", price: 100, available: true, currency: "UAH" });
  const run = (id, c, r0 = row(id)) => refreshMainRow(r0, offer(id), full, { stamp: "2026-10-27T10:00:00.000Z", catalog: c });
  const a = run("90", on);
  assert.ok(JSON.parse(a.row["Характеристики JSON"]).some((p) => /Країна походження/.test(p.name)), a.row["Характеристики JSON"]);
  for (const [what, id] of [["поза когортою", "222"], ["захищений", "91"]]) assert.deepEqual(run(id, on).row, run(id, off).row, what);
  assert.deepEqual(JSON.parse(run("90", off).row["Характеристики JSON"]), [], "без когорти — як раніше");
  const again = refreshMainRow(a.row, offer("90"), full, { stamp: "2026-10-27T11:00:00.000Z", catalog: on });
  assert.equal(again.row["Характеристики JSON"], a.row["Характеристики JSON"], "повторний запуск з уже переданими N1-2");
  assert.equal(again.params, false);
  const pricing = JSON.parse(fs.readFileSync(new URL("../config/default.json", import.meta.url), "utf8")).pricing;
  const pc = { date: "2026-10-27", map: new Map([["90", SAW]]) };
  const qo = { ...offer("90"), nameRu: "Пила", url: "https://example.com/p.html", quantity: "" };
  const ca = candidateRow(qo, full, "2026-10-27T10:00:00.000Z", pricing, { ...on, promCategories: pc }), cb = candidateRow(qo, full, "2026-10-27T10:00:00.000Z", pricing, { ...off, promCategories: pc });
  assert.deepEqual(ca, cb, "новий товар");
  assert.deepEqual(refreshQueueRow({ ...ca, "Категорія Prom ID": SAW }, qo, full, { stamp: "2026-10-27T11:00:00.000Z", catalog: { ...on, promCategories: pc } }).row, refreshQueueRow({ ...cb, "Категорія Prom ID": SAW }, qo, full, { stamp: "2026-10-27T11:00:00.000Z", catalog: { ...off, promCategories: pc } }).row, "черга");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("N1-2 межа (посилення за мутаціями): позначки звичайних пар зупиняють N1-2; поточні ручні значення й рішення власника — ні (проба лише з даних постачальника)", () => {
  // звичайні пари дали лише конфлікт (жодної характеристики) — N1-2 не вмикається
  const cf = B({ descUa: "<p>Довжина шини: 400 мм</p>" + UA, descRu: "<p>Длина шины: 500 мм</p>" + RU, ...N1 });
  assert.ok(!has(cf, /Країна походження/) && hard(cf).length >= 1, JSON.stringify([cf.params, cf.needsReview]));
  // ручне значення в таблиці (без походження) — N1-2 вмикається, ручне значення збережено
  const man = B({ descUa: UA, descRu: RU, current: [{ name: "Колір", value: "синій", unit: "" }], provenance: null, ...N1 });
  assert.ok(has(man, /Країна походження/) && has(man, /^Вага/) && has(man, /^Колір/, "синій"), JSON.stringify(man.params));
  // рішення власника для іншої характеристики — N1-2 вмикається, рішення власника на місці
  const own = B({ descUa: UA, descRu: RU, ...N1, ownerValues: [{ name: "Гарантійний термін", value: "12", unit: "міс", action: "set", source: "тест", date: "2026-10-27", priority: 1, autoUpdate: false }] });
  assert.ok(has(own, /Країна походження/) && has(own, /^Вага/) && has(own, /Гарантійний термін/), JSON.stringify(own.params));
});

test("N1-2 розбір (посилення за мутаціями): рівно половина пар, пункт з <br>, список у таблиці, діапазон без «чисел через пробіл», назва > 7 слів, службовий текст", () => {
  assert.deepEqual(n1ListPairs(UL(["Потужність - 1100 Вт", "Вага - 4.7 кг", "Надійний корпус", "Зручна рукоятка"])).pairs, [], "2 з 4 — менше 2/3");
  assert.deepEqual(n1ListPairs(UL(["Потужність - 1100 Вт<br>Напруга - 230 В", "Вага - 4.7 кг", "Довжина кабелю - 2 м"])).pairs, [], "пункт з <br> — список без розбору");
  assert.deepEqual(n1ListPairs(`<table><tr><td>${UL(["Потужність - 1100 Вт", "Вага - 4.7 кг", "Довжина кабелю - 2 м"])}</td></tr></table>`).pairs, [], "список «Назва – значення» у таблиці — без розбору");
  const r = n1ListPairs(UL(["Частота обертання 2200 – 5200 об/хв", "Максимальна глибина пропилу під кутом сорок п'ять градусів - 46 мм", "Рекомендуємо - переглянути інші моделі", "Вага - 4.7 кг", "Напруга - 230 В"]));
  assert.deepEqual(kv(r), [["Вага", "4.7 кг"], ["Напруга", "230 В"]]);
  assert.match(why(r, "Частота обертання"), /закінчується числом/);
  assert.match(why(r, "Максимальна глибина"), /7 слів/);
  assert.match(why(r, "Рекомендуємо"), /службов/);
});

test("N1-2 таблиця-обгортка (посилення за мутаціями): лише рядок з однією клітинкою; вкладені таблиці — без розбору", () => {
  assert.deepEqual(n1ListPairs(`<table><tr><td><p>Потужність: 1050 Вт</p><p>Вага: 3 кг</p></td><td>фото</td></tr></table>`).pairs, [], "рядок з двома клітинками — не обгортка");
  assert.deepEqual(n1ListPairs(`<table><tr><td><table><tr><td>x</td></tr></table><ul><li>Потужність: 1050 Вт</li><li>Вага: 3 кг</li></ul></td></tr></table>`).pairs, [], "вкладена таблиця — без розбору");
  assert.deepEqual(n1ListPairs(`<table><tr><td><ul><li>Потужність: 1050 Вт</li><li>Вага: 3 кг</li></ul><table><tr><td>x</td></tr></table></td></tr></table>`).pairs, [], "вкладена таблиця після списку — теж без розбору");
  assert.deepEqual(kv(n1ListPairs(`<table><tr><td><ul><li>Потужність: 1050 Вт</li><li>Вага: 3 кг</li></ul></td></tr></table>`)), [["Потужність", "1050 Вт"], ["Вага", "3 кг"]]);
});
