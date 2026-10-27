/** Пакет А1 (власник через Hermes, 27.10.2026): достовірні технічні рівнозначності. А1–А5 — UA і RU записано по-різному,
 *  але технічно те саме → передається одне значення; В1–В4 — поле / наявне значення передано, опис лише сумісно уточнює →
 *  позначка інформаційна (обидва значення в позначці, опис не змінюється). Новий режим діє лише з валідним зовнішнім переліком
 *  захищених товарів (fail-closed); для захищених — як без режиму. Схеми — справжні файли; товари й значення — синтетичні. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { a1Equivalent, buildCharacteristics } from "../src/core/prom-attributes.mjs";
import { TECH_RULES, freezeFingerprint, loadFreeze, loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";

const catalog = loadPromCatalog(undefined, { freezeFile: "" });
const P = (name, value, unit = "") => ({ name, value, unit });
const SAW = "1250302";
const B = (o) => buildCharacteristics({ schema: catalog.schemas.get(SAW), categoryId: SAW, current: [], names: catalog.names, mapping: catalog.mappings.get(SAW), units: catalog.units, mode: "main", ...o });
const pair = (k, ua, ru, more = {}) => B({ descUa: `<p>${k}: ${ua}</p>`, descRu: `<p>${more.ruKey || k}: ${ru}</p>`, ...more });
const A1 = { techRules: ["A1"] };
const has = (r, name, value) => r.params.some((p) => p.name === name && p.value === value);
const hard = (r) => r.needsReview.filter((x) => x.kind !== "інформаційно");
const info = (r) => r.needsReview.filter((x) => x.kind === "інформаційно");

test("А1 наявність: «1 шт.» = «Есть» — лише для наявності (кількість не губиться); кількість, комплект, акумулятор, кейс — ні", () => {
  const before = pair("Зубило", "1шт.", "Есть");
  assert.equal(hard(before).length, 1, "без режиму — як раніше");
  const r = pair("Зубило", "1шт.", "Есть", A1);
  assert.ok(has(r, "Зубило", "1шт."), JSON.stringify(r.params));
  assert.deepEqual(r.needsReview, []);
  assert.ok(has(pair("Захисний кожух", "Є", "1 шт.", A1), "Захисний кожух", "1 шт."), "передається форма з кількістю");
  for (const [k, ua, ru] of [["Кількість дисків", "1 шт.", "Есть"], ["Кейс", "1 шт.", "Есть"], ["Зубило", "2 шт.", "Есть"], ["Акумулятор", "1 шт.", "Есть"], ["Комплектація", "1 шт.", "Есть"]]) assert.equal(hard(pair(k, ua, ru, A1)).length, 1, k);
});

test("А2 розміри мм / см (ті самі виміри в тому самому порядку, обидва з одиницею); інший порядок, інші розміри або без одиниці — ні", () => {
  const r = pair("Розміри в упаковці", "161x84x200 мм", "16.1 × 8.4 × 20 см", A1);
  assert.ok(has(r, "Розміри в упаковці", "161x84x200 мм") && !hard(r).length, JSON.stringify(r.params));
  // Порядок вимірів без доказу орієнтації не переставляємо (Hermes, фінальний safety-review А1)
  assert.equal(hard(pair("Розміри в упаковці", "161x84x200 мм", "20 × 8.4 × 16.1 см", A1)).length, 1, "зворотний порядок — конфлікт");
  assert.equal(a1Equivalent("Розміри", "10x20x30 мм", "30x20x10 мм"), null);
  assert.equal(hard(pair("Розміри в упаковці", "121.5 × 20.5 × 12.2 см", "1230 x 370 x 245 мм", A1)).length, 1);
  assert.equal(hard(pair("Розміри в упаковці", "161x84x200", "20 × 8.4 × 16.1 см", A1)).length, 1);
});

test("А3 та сама величина точною одиницею («близько» = «около»); приблизне ≠ точне, різні числа, к.с. ↔ кВт — ні", () => {
  assert.ok(has(pair("Вага", "близько 2,5 кг", "около 2,5 кг", A1), "Вага", "близько 2,5 кг"));
  assert.ok(has(pair("Вага нетто", "2500 г", "2,5 кг", A1), "Вага нетто", "2500 г"));
  assert.ok(has(pair("Час роботи", "близько 6 годин", "около 6 часов", A1), "Час роботи", "близько 6 годин"));
  for (const [k, ua, ru] of [["Вага", "3.76 кг", "около 3,8 кг"], ["Діаметр патрона", "10 мм", "13 мм"], ["Вага", "270 г", "593 г"], ["Потужність двигуна", "1 к. с.", "0,75 кВт"], ["Вага", "6,26 кг", "5,94 кг"]]) assert.equal(hard(pair(k, ua, ru, A1)).length, 1, `${ua} / ${ru}`);
  assert.equal(hard(pair("Вага виробу", "2,5 кг", "около 2,5 кг", A1)).length, 1, "точне ≠ приблизне (користувацька; «Вага» у пилках — поле)");
  assert.equal(hard(pair("Параметр мотора", "2 кВт", "2000 В", A1)).length, 1, "те саме число в базових одиницях, але різні величини");
  // атм і бар — різні одиниці (приблизний коефіцієнт не вводимо)
  assert.equal(a1Equivalent("Тиск", "1 атм", "1 бар"), null);
  assert.equal(hard(pair("Тиск робочий", "8 атм", "8 бар", A1)).length, 1);
  assert.ok(has(pair("Тиск робочий", "8 бар", "8 bar", A1), "Тиск робочий", "8 бар"), "та сама одиниця різним письмом");
});

test("А4 формат чисел і одиниць: роздільник тисяч (крапка, підтверджено іншою мовою), «хв / мин», «л. с.», «Li Ion»; кома — десяткова", () => {
  assert.ok(has(pair("Потужність", "550 Вт /0,8 л. с.", "550 Вт /0,8 л.с.", A1), "Потужність", "550 Вт /0,8 л. с."));
  // «Кількість обертів» у пилках — поле схеми (макс. 13000), тому рівнозначність перевіряється на користувацькій характеристиці
  assert.ok(has(pair("Кількість обертів шпинделя", "35000 об/хв", "35.000/мин", A1), "Кількість обертів шпинделя", "35000 об/хв"));
  assert.ok(has(pair("Кількість обертів холостого ходу", "600 об /хв", "600 /мин", A1), "Кількість обертів холостого ходу", "600 об /хв"));
  assert.equal(hard(pair("Подача", "10 л/хв", "10 /мин", A1)).length, 1, "«/мин» без «об» — лише для обертів");
  assert.equal(hard(pair("Подача", "10 /хв", "10 об/мин", A1)).length, 1, "«/хв» = «об/хв» — лише для обертів");
  assert.equal(hard(pair("Кількість обертів шпинделя", "35.000 об/хв", "35000 об/мин", A1)).length, 1, "крапка в UA — не передаємо двозначне «35.000», RU-текст як UA не передається");
  // Поле схеми (пилки: «Кількість обертів», макс. 13000): RU «12.000» без режиму читається як 12 і дає конфлікт; з А1 — поле з UA
  const fld = (ua, ru, more = {}) => B({ descUa: `<p>Кількість обертів: ${ua}</p>`, descRu: `<p>Количество оборотов: ${ru}</p>`, ...more });
  assert.equal(hard(fld("12000 об/хв", "12.000 об/мин")).length, 1, "без режиму — як раніше");
  const f1 = fld("12000 об/хв", "12.000 об/мин", A1);
  assert.deepEqual([f1.params, f1.provenance.items.map((i) => [i.s, i.a]), f1.needsReview], [[P("Кількість обертів", "12000", "об/хв")], [["ОПИС", "18151"]], []]);
  assert.equal(hard(fld("12000 об/хв", "1200 об/мин", A1)).length, 1, "різні числа — конфлікт");
  assert.equal(hard(fld("12.000 об/хв", "12000 об/мин", A1)).length, 1, "крапка в UA — поле «12» не передаємо");
  // Крапка як роздільник тисяч — лише оберти / удари / ходи та лічильне поле без одиниці; маса, тиск, напруга — ні (може бути десятковою).
  assert.ok(has(pair("Кількість ударів шпинделя", "4000 уд/хв", "4.000 уд/мин", A1), "Кількість ударів шпинделя", "4000 уд/хв"));
  assert.ok(has(pair("Кількість стібків", "1000", "1.000", A1), "Кількість стібків", "1000"));
  for (const [k, ua, ru] of [["Вага нетто без упаковки", "1475 г (нетто)", "1.475 г (нетто)"], ["Тиск робочий", "1000 бар (макс.)", "1.000 бар (макс.)"], ["Напруга пікова", "18000 В (пік)", "18.000 В (пік)"], ["Діаметр диска", "1250 мм (зовн.)", "1.250 мм (зовн.)"], ["Кількість олії", "1200 мл (макс.)", "1.200 мл (макс.)"]]) assert.equal(hard(pair(k, ua, ru, A1)).length, 1, `${k}: ${ua} / ${ru}`);
  assert.ok(has(pair("Час заряджання 18 В", "100 хв/Ач", "100 мин/Ач", A1), "Час заряджання 18 В", "100 хв/Ач"));
  assert.ok(has(pair("Напруга", "21 В Li Ion батарея", "21В Li-Ion батарея", A1), "Напруга", "21 В Li Ion батарея"));
  assert.equal(hard(pair("Розміри в упаковці", "1005 х 130 х 170 мм", "1,005 x 130 x 170 мм", A1)).length, 1, "кома — десяткова, не тисячі");
  assert.equal(hard(pair("Вага", "1,005 кг", "1005 кг", A1)).length, 1);
  assert.equal(hard(pair("Кількість обертів", "35000 об/хв", "35 об/мин", A1)).length, 1);
});

test("А5 той самий час (1:00 = 1 час); різний час — ні", () => {
  assert.ok(has(pair("Час зарядки", "1:00", "1 час", A1), "Час зарядки", "1:00"));
  assert.equal(hard(pair("Час зарядки", "75 хвилин", "1 час 30 минут", A1)).length, 1);
  // Г:ХХ — хвилини лише 00–59
  assert.equal(a1Equivalent("Час", "1:99", "159 мин"), null);
  assert.equal(hard(pair("Час зарядки", "1:60", "2 часа", A1)).length, 1);
  assert.ok(has(pair("Час зарядки", "1:30", "90 минут", A1), "Час зарядки", "1:30"));
});

test("В1 мережа: поле «Мережа 220В» і опис «220–240 В / 50 Гц» — інформаційно (обидва значення в позначці); 230 В, акумулятор — конфлікт", () => {
  const raw = [P("Питание", "Сеть 220В")];
  const r = B({ rawParams: raw, descUa: "<p>Живлення: 220-240 В / 50 Гц</p>", ...A1 });
  assert.ok(has(r, "Живлення", "Мережа 220В"));
  assert.deepEqual(hard(r), [], JSON.stringify(r.needsReview));
  assert.ok(info(r).some((x) => x.values.some((v) => /220-240 В/.test(v.value)) && /уточнення опису сумісне/.test(x.reason)));
  assert.equal(hard(B({ rawParams: raw, descUa: "<p>Живлення: 220-240 В / 50 Гц</p>" })).length, 1, "без режиму — як раніше");
  for (const d of ["230V - 50Hz", "акумулятор 18 В", "мережа 380 В", "мережа 220 В або акумулятор 18 В", "мережа 220 В, 2000 Вт"]) assert.equal(hard(B({ rawParams: raw, descUa: `<p>Живлення: ${d}</p>`, ...A1 })).length, 1, d);
  // Уточнення — лише з опису: інше значення XML проти наявного лишається конфліктом
  const x = B({ current: [P("Живлення", "Мережа 220В")], rawParams: [P("Питание", "220-240 В / 50 Гц")], ...A1 });
  assert.equal(hard(x).length, 1, JSON.stringify(x.needsReview));
});

test("В2 / В3: «Батарейки» + AA, «Акумулятор» + «від акумулятора 18 В» — інформаційно; мережа — конфлікт", () => {
  const b = B({ current: [P("Живлення", "Батарейки")], descUa: "<p>Живлення: 2 батарейки AA</p>", ...A1 });
  assert.deepEqual(hard(b), []);
  assert.equal(info(b).length, 1);
  const a = B({ rawParams: [P("Питание", "Аккумулятор")], descUa: "<p>Живлення: від акумулятора 18 В</p>", ...A1 });
  assert.ok(has(a, "Живлення", "Акумулятор") && !hard(a).length, JSON.stringify(a.needsReview));
  assert.equal(hard(B({ rawParams: [P("Питание", "Аккумулятор")], descUa: "<p>Живлення: мережа 220 В</p>", ...A1 })).length, 1);
});

test("В4 суворо: та сама величина й одиниця, решта чисел — інший вимір або позначка; інше значення того самого виміру — конфлікт", () => {
  const ok = (cur, d) => { const r = B({ current: [cur], descUa: `<p>${cur.name}: ${d}</p>`, ...A1 }); return !hard(r).length && info(r).length === 1; };
  assert.ok(ok(P("Кількість фаз", "1"), "1 фаза 220 В (50 Гц)"));
  assert.ok(ok(P("Кількість променів", "16"), "16 (4D)"));
  assert.ok(ok(P("Максимальний тиск", "10 атм"), "10 атм. (кг/см2)"));
  assert.ok(ok(P("Напруга", "220 В"), "220В / Частота: 50 Гц"));
  assert.ok(!ok(P("Вага", "7.7 кг"), "7,7 кг / 8,9 кг"), "друга вага того самого виміру");
  assert.ok(!ok(P("Довжина шини", "305 мм"), "12/305 мм"), "число без одиниці — не доведено");
  assert.ok(!ok(P("Тип двигуна", "Бензиновий"), "4-тактний"), "без числа в полі — не В4");
  assert.ok(!ok(P("Потужність", "2 кВт"), "2 кВт / 3 кВт макс."));
  assert.ok(!ok(P("Напруга", "220 В"), "220–240 В"), "діапазон — не уточнення одного значення");
});

test("рішення власника вище за А1; повторний запуск стабільний", () => {
  const own = pair("Зубило", "1шт.", "Есть", { ...A1, ownerValues: [{ name: "Зубило", value: "2 шт.", action: "set", source: "тест", date: "2026-10-27", priority: 1, autoUpdate: false }] });
  assert.deepEqual(own.params.filter((p) => p.name === "Зубило"), [P("Зубило", "2 шт.")]);
  const r1 = pair("Зубило", "1шт.", "Есть", A1);
  const r2 = B({ descUa: "<p>Зубило: 1шт.</p>", descRu: "<p>Зубило: Есть</p>", current: r1.params, provenance: r1.provenance, ...A1 });
  assert.deepEqual(r2.params, r1.params);
  assert.equal(r2.changed, false);
});

// Контракт актуального знімка (у репозиторії лише відбитки наборів, без ID) і файл переліку поза репозиторієм:
// ids — захищені, scope — знімок основного каталогу, якому погоджено зміни (типово — захищені + «90» і «222»).
const scopeOf = (ids) => [...new Set([...ids, "90", "222"])];
const fileOf = (ids, scope = scopeOf(ids), more = {}) => ({ v: 1, rev: 1, date: "2026-10-27", source: "тест", count: ids.length, ids, scope: { count: scope.length, ids: scope }, ...more });
const contractOf = (ids, date = "2026-10-27", scope = scopeOf(ids), rev = 1) => ({ v: 1, rev, date, source: "тест", count: ids.length, fingerprint: freezeFingerprint(ids), scope: { count: scope.length, fingerprint: freezeFingerprint(scope) } });
const freezeEnv = (ids, file = fileOf(ids), contract = contractOf(ids)) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freeze-"));
  const f = path.join(dir, "freeze.json"), k = path.join(dir, "freeze-contract.json");
  fs.writeFileSync(f, typeof file === "string" ? file : JSON.stringify(file));
  if (contract) fs.writeFileSync(k, typeof contract === "string" ? contract : JSON.stringify(contract));
  return { dir, f, k, cat: loadPromCatalog(undefined, { freezeFile: f, freezeContractFile: k }) };
};

test("перелік захищених товарів (fail-closed): без файлу / пошкоджений / неузгоджений — режим вимкнено для всіх; валідний — лише в області дії, крім захищених", () => {
  assert.deepEqual(TECH_RULES, ["A1"]);
  const none = loadPromCatalog(undefined, { freezeFile: "" });
  assert.deepEqual([none.techRulesFor("111"), none.freezeInfo.valid], [[], false]);
  const ok = freezeEnv(["111", "112"]);
  assert.deepEqual([ok.cat.techRulesFor("111"), ok.cat.techRulesFor("222"), ok.cat.techRulesFor("333"), ok.cat.techRulesFor(""), ok.cat.freezeInfo], [[], ["A1"], [], [], { valid: true, file: "freeze.json", rev: 1, date: "2026-10-27", count: 2, scope: 4, source: "тест", parts: null }], "поза областю дії (новий / черга) — як у 83206c4");
  const sc = scopeOf(["111", "112"]), sco = { count: sc.length, ids: sc };
  // кожен файл — з правильною ревізією, щоб відсікала саме його вада (count / ID / дата / дублікати), а не ревізія
  for (const bad of ["{ зламаний", JSON.stringify({ v: 1, rev: 1, date: "2026-10-27", count: 3, ids: ["111", "112"], scope: sco }), JSON.stringify({ v: 1, rev: 1, date: "2026-10-27", count: 1, ids: ["x"], scope: sco }), JSON.stringify({ v: 1, rev: 1, count: 1, ids: ["111"], scope: sco }), JSON.stringify({ v: 1, rev: 1, date: "2026-10-27", count: 2, ids: ["111", "111"], scope: sco })]) {
    fs.writeFileSync(ok.f, bad);
    const c = loadPromCatalog(undefined, { freezeFile: ok.f, freezeContractFile: ok.k });
    assert.deepEqual([c.techRulesFor("222"), c.freezeInfo.valid], [[], false], bad);
    assert.ok(c.problems.some((p) => /переліку захищених/.test(p)), bad);
  }
  assert.ok(loadPromCatalog(undefined, { freezeFile: path.join(ok.dir, "немає.json"), freezeContractFile: ok.k }).problems.some((p) => /не знайдено/.test(p)));
  assert.equal(loadFreeze(path.join(ok.dir, "немає.json"), contractOf(["111"])).valid, false);
  fs.rmSync(ok.dir, { recursive: true, force: true });
});

test("перелік захищених товарів: порожній, неповний, інший набір / дата / область, без контракту — режим вимкнено для всіх (не fail-open)", () => {
  const two = ["111", "112"];
  const cases = [
    ["порожній перелік", freezeEnv([])],
    ["порожній перелік і контракт без count", freezeEnv([], undefined, { ...contractOf([]), count: 0 })],
    ["неповний перелік (1 з 2)", freezeEnv(["111"], fileOf(["111"], scopeOf(two)), contractOf(two))],
    ["інший набір тієї самої довжини", freezeEnv(["111", "113"], fileOf(["111", "113"], scopeOf(two)), contractOf(two))],
    ["інший набір у межах області (лише відбиток інший)", freezeEnv(["111", "90"], fileOf(["111", "90"], scopeOf(two)), contractOf(two))],
    ["дублікати при узгодженому контракті", freezeEnv(["111", "111"], fileOf(["111", "111"], scopeOf(two)), { ...contractOf(two), count: 2, fingerprint: freezeFingerprint(["111"]) })],
    ["інша ревізія переліку", freezeEnv(two, undefined, contractOf(two, "2026-10-27", scopeOf(two), 2))],
    ["контракт без ревізії", freezeEnv(two, undefined, { ...contractOf(two), rev: undefined })],
    ["інша дата знімка", freezeEnv(two, undefined, contractOf(two, "2026-10-26"))],
    ["відбиток у файлі не збігається з ids", freezeEnv(two, fileOf(two, undefined, { fingerprint: freezeFingerprint(["111"]) }))],
    ["немає області дії", freezeEnv(two, { v: 1, date: "2026-10-27", source: "тест", count: 2, ids: two })],
    ["порожня область дії", freezeEnv(two, fileOf(two, []))],
    ["ширша область дії, ніж у контракті", freezeEnv(two, fileOf(two, [...scopeOf(two), "333"]))],
    ["вужча область дії", freezeEnv(two, fileOf(two, two))],
    ["захищені поза областю дії", freezeEnv(two, fileOf(two, ["111", "90"]), contractOf(two, "2026-10-27", ["111", "90"]))],
    ["контракт без області дії", freezeEnv(two, undefined, { ...contractOf(two), scope: undefined })],
    ["немає контракту в репозиторії", freezeEnv(two, undefined, null)],
    ["пошкоджений контракт", freezeEnv(two, undefined, "{ зламаний")],
  ];
  for (const [what, e] of cases) {
    assert.deepEqual([e.cat.techRulesFor("222"), e.cat.techRulesFor("90"), e.cat.techRulesFor("111"), e.cat.freezeInfo.valid], [[], [], [], false], what);
    assert.ok(e.cat.problems.some((p) => /переліку захищених|контракт/.test(p)), what);
    fs.rmSync(e.dir, { recursive: true, force: true });
  }
  // Справжній контракт репозиторію (типовий шлях) не приймає синтетичний перелік: лише точний актуальний знімок.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freeze-"));
  const f = path.join(dir, "freeze.json");
  fs.writeFileSync(f, JSON.stringify(fileOf(two)));
  const real = loadPromCatalog(undefined, { freezeFile: f });
  assert.deepEqual([real.techRulesFor("222"), real.freezeInfo.valid], [[], false]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(freezeFingerprint(["2", "1"]), freezeFingerprint(["1", "2"]), "відбиток не залежить від порядку");
});

test("локально: зовнішній перелік (MM_FREEZE_IDS) точно відповідає контракту репозиторію", { skip: !process.env.MM_FREEZE_IDS && "немає MM_FREEZE_IDS" }, () => {
  const c = loadPromCatalog(undefined, { freezeFile: process.env.MM_FREEZE_IDS });
  const k = JSON.parse(fs.readFileSync(new URL("../schemas/prom/freeze-contract.json", import.meta.url), "utf8"));
  assert.deepEqual([c.freezeInfo.valid, c.freezeInfo.count, c.freezeInfo.scope, c.freezeInfo.date], [true, k.count, k.scope.count, k.date], JSON.stringify(c.problems));
});

test("синхронізація: техрежим лише для основного каталогу за Offer ID з області дії (захищений, поза областю — як раніше); черга й нові — як у 83206c4", async () => {
  const { refreshMainRow, candidateRow, refreshQueueRow } = await import("../src/core/sheet-sync.mjs");
  const { dir, cat } = freezeEnv(["91"]);
  const full = { params: [P("Состояние", "Новое")], pictures: [], descriptionUa: "<p>Зубило: 1шт.</p>", descriptionRu: "<p>Зубило: Есть</p>" };
  const run = (id, c = cat) => {
    const row = { "Offer ID": id, "ID постачальника": id, "Категорія Prom ID": SAW, "Виробник": "Test", "Характеристики JSON": "[]", "Назва постачальника UA": "Пила тестова", "Назва постачальника RU": "" };
    const offer = { id, vendor: "Test", sku: "", nameUa: "Пила тестова", nameRu: "", price: 100, available: true, currency: "UAH" };
    return JSON.parse(refreshMainRow(row, offer, full, { stamp: "2026-10-27T10:00:00.000Z", catalog: c }).row["Характеристики JSON"]);
  };
  assert.ok(run("90").some((p) => p.name === "Зубило"), "незахищений в області дії — рівнозначність застосовано");
  assert.ok(!run("91").some((p) => p.name === "Зубило"), "захищений — як без режиму");
  assert.ok(!run("95").some((p) => p.name === "Зубило"), "поза знімком основного каталогу (напр. щойно перенесений з черги) — як без режиму");
  // Новий товар і черга «Нові товари» (напрям Г — лише аудит): з валідним переліком — рядок той самий, що без нього (83206c4).
  const pricing = JSON.parse(fs.readFileSync(new URL("../config/default.json", import.meta.url), "utf8")).pricing;
  const pc = { date: "2026-10-27", map: new Map([["90", SAW], ["91", SAW]]) };
  const on = { ...cat, promCategories: pc }, off = { ...catalog, promCategories: pc };
  const qOffer = (id) => ({ id, vendor: "Test", sku: "", nameUa: "Пила тестова", nameRu: "Пила тестовая", url: "https://example.com/p.html", quantity: "", price: 100, available: true, currency: "UAH" });
  for (const id of ["90", "91"]) {
    const a = candidateRow(qOffer(id), full, "2026-10-27T10:00:00.000Z", pricing, on), b = candidateRow(qOffer(id), full, "2026-10-27T10:00:00.000Z", pricing, off);
    assert.deepEqual(a, b, `новий товар ${id}`);
    assert.ok(!JSON.parse(a["Характеристики JSON"]).some((p) => p.name === "Зубило"), `новий товар ${id}: без А1`);
    const qa = refreshQueueRow({ ...a, "Категорія Prom ID": SAW }, qOffer(id), full, { stamp: "2026-10-27T11:00:00.000Z", catalog: on }).row;
    const qb = refreshQueueRow({ ...b, "Категорія Prom ID": SAW }, qOffer(id), full, { stamp: "2026-10-27T11:00:00.000Z", catalog: off }).row;
    assert.deepEqual(qa, qb, `черга ${id}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // Без файлу / пошкоджений / порожній / з дублями — результат як без режиму, синхронізація не блокується.
  for (const [what, e] of [["пошкоджений", freezeEnv(["91"], "{ зламаний")], ["порожній", freezeEnv([])], ["з дублями", freezeEnv(["91"], fileOf(["91", "91"]))]]) {
    assert.ok(!run("90", e.cat).some((p) => p.name === "Зубило"), what);
    fs.rmSync(e.dir, { recursive: true, force: true });
  }
  const { WatchSim } = await import("./helpers/watch-sim.mjs");
  const sim = new WatchSim({ catalog: { ...catalog } });
  const r = await sim.start();
  assert.ok(r.warnings.some((w) => /технічні нормалізації .*не активні/.test(w)), JSON.stringify(r.warnings));
});
