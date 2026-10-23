/** Характеристики Prom (погоджено власником 23.10.2026): схеми категорій, перевірка значень, перенесення з XML і опису,
 *  збереження ручних виправлень, зміна категорії. Схеми — справжні файли з schemas/prom (жодних вигаданих атрибутів). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { categoryBlocks, parseSchemaText } from "../src/core/prom-schema.mjs";
import { SRC, alignPairs, buildCharacteristics, buildNames, cleanDescription, descriptionPairs, mapParam, sameValue, validateValue } from "../src/core/prom-attributes.mjs";
import { SCHEMAS_DIR, importSchemaFiles, loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";

const catalog = loadPromCatalog();
const S = (id, maybe = false) => { const s = catalog.schemas.get(id); if (!maybe) assert.ok(s, "схема " + id); return s; };
const GRIND = "141717", SAW = "1250302", GEN = "410402"; // Шліфувальні машини; Бензопили і електропили; Електрогенератори
const attrOf = (id, name) => S(id).attributes.find((a) => a.nameUK === name);
const P = (name, value, unit = "") => ({ name, value, unit });

test("схеми: 48 категорій із MANIFEST завантажено без помилок; порожні «…, загальне» — коректні, без атрибутів", () => {
  assert.deepEqual(catalog.problems, []);
  assert.equal(catalog.schemas.size, 48);
  assert.equal(S("141714").nameUK, "Електричні гайковерти");
  assert.equal(S("12110201").attributes.length, 16, "повна схема (обірваний фрагмент раніше не імпортовано)");
  assert.equal(S("410499").empty, true);
  assert.equal(S("52807").empty, true);
  assert.equal(S(GEN).attributes.length, 66);
  assert.equal(S("1250308").nameUK, "Газонокосарки");
});

test("розбір: самозакритий <category …/> не «поглинає» наступну категорію; текст браузера між XML ігнорується", () => {
  const text = `Назва\nThis XML file does not appear to have any style information.\n<categories>\n<category id="1" nameRU="А" nameUK="А"/>\n</categories>\n`
    + `Друга\n<categories>\n<category id="2" nameRU="Б" nameUK="Б">\n<attribute id="5" nameRU="Вес" type="real" nameUK="Вага" measureUnitRU="кг" min="0" max="20" measureUnitUK="кг"/>\n</category>\n</categories>`;
  assert.equal(categoryBlocks(text).length, 2);
  const [a, b] = parseSchemaText(text);
  assert.equal(a.schema.id, "1"); assert.equal(a.schema.attributes.length, 0); assert.deepEqual(a.problems, []);
  assert.equal(b.schema.id, "2"); assert.equal(b.schema.attributes[0].nameUK, "Вага");
});

test("імпорт: та сама категорія з різним вмістом → «КОНФЛІКТ», файл не записано; змінений файл (SHA ≠ MANIFEST) не використовується", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-schemas-"));
  const one = (n) => `<category id="7" nameRU="Т" nameUK="Т"><attribute id="5" nameRU="Вес" type="real" nameUK="Вага" measureUnitRU="кг" min="0" max="${n}" measureUnitUK="кг"/></category>`;
  const f1 = path.join(dir, "a.xml"), f2 = path.join(dir, "b.xml"), out = path.join(dir, "out");
  fs.writeFileSync(f1, one(20)); fs.writeFileSync(f2, one(30));
  const rep = importSchemaFiles([f1, f2], { dir: out });
  assert.ok(rep.every((r) => r.status === "КОНФЛІКТ"));
  assert.equal(fs.existsSync(path.join(out, "7.xml")), false);
  fs.writeFileSync(f1, one(20).replace(/></g, ">\r\n<")); // вихідний файл власника з CRLF
  importSchemaFiles([f1], { dir: out });
  assert.equal(loadPromCatalog(out).schemas.size, 1);
  const file = path.join(out, "7.xml");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n")); // git на Windows видав CRLF
  assert.equal(loadPromCatalog(out).schemas.size, 1, "SHA не залежить від кінців рядків");
  fs.appendFileSync(path.join(out, "7.xml"), " ");
  const c = loadPromCatalog(out);
  assert.equal(c.schemas.size, 0);
  assert.match(c.problems[0], /SHA файлу не збігається/);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(SCHEMAS_DIR, "MANIFEST.json")), "репозиторні схеми не зачеплено");
});

test("типи: real / integer / bool / singleselect — точна перевірка значення, одиниці, діапазону", () => {
  const weight = attrOf(GRIND, "Вага"), warranty = attrOf(GRIND, "Гарантійний термін"), led = attrOf(GRIND, "Підсвічування робочої зони"), power = attrOf(GRIND, "Живлення");
  assert.deepEqual(validateValue(weight, "2,5", "кг"), { value: "2.5", unit: "кг" });
  assert.deepEqual(validateValue(weight, "2.5", "Kg").reason !== undefined, true, "чужа одиниця");
  assert.match(validateValue(weight, "2.5", "").reason, /немає одиниці/, "без одиниці не вгадуємо");
  assert.match(validateValue(weight, "250", "кг").reason, /більше за максимум 200/);
  assert.match(validateValue(weight, "2-3", "кг").reason, /не одне число/);
  assert.match(validateValue(weight, "2500", "г").reason, /одиниця «г»/, "перерахунок лише з погодженої таблиці");
  assert.deepEqual(validateValue(weight, "2500", "г", { conversions: [{ from: "г", to: "кг", factor: 0.001 }] }), { value: "2.5", unit: "кг" });
  assert.deepEqual(validateValue(warranty, "36 мес.", ""), { value: "36", unit: "міс" }, "одиниця у значенні; RU-одиниця схеми");
  assert.match(validateValue(warranty, "36.5", "міс").reason, /не ціле/);
  assert.deepEqual(validateValue(led, "так", ""), { value: "Так", unit: "" });
  assert.deepEqual(validateValue(led, "Нет", ""), { value: "Ні", unit: "" });
  assert.match(validateValue(led, "можливо", "").reason, /не так\/ні/);
  assert.deepEqual(validateValue(power, "Сеть 220В", ""), { value: "Мережа 220В", unit: "" }, "RU-варіант → UA-назва варіанта");
  assert.match(validateValue(power, "Мережа 230В", "").reason, /немає серед допустимих/);
  // Варіант у постачальника «Новый», у схемі — «Новое» / «Новий»: лише за погодженим синонімом значення
  const state = attrOf(GRIND, "Стан");
  assert.match(validateValue(state, "Новый", "").reason, /немає серед допустимих/);
  assert.deepEqual(validateValue(state, "Новый", "", null, { "новый": "83769" }), { value: "Новий", unit: "" });
  assert.equal(mapParam(S(GRIND), P("Состояние", "Новый"), { mapping: { values: { 10006: { "новый": "83769" } } } }).out.value, "Новий");
});

test("multiselect (документація Prom: «GSM | CDMA»): допустимі варіанти через « | », UA-назви; будь-яка недопустима частина — поле не заповнюється", () => {
  const surface = attrOf(GRIND, "Оброблювана поверхня"); // справжня схема 141717, атрибут 18644
  assert.deepEqual(validateValue(surface, "По дереву", ""), { value: "По дереву", unit: "" }, "одне значення");
  assert.deepEqual(validateValue(surface, "По металлу, По камню", ""), { value: "По металу | По каменю", unit: "" }, "RU-варіанти → UA, роздільник « | »");
  assert.deepEqual(validateValue(surface, "По бетону | Для пола; По дереву", ""), { value: "По бетону | Для підлоги | По дереву", unit: "" });
  assert.deepEqual(validateValue(surface, "По дереву / по дереву", ""), { value: "По дереву", unit: "" }, "повтор варіанта — один раз");
  assert.match(validateValue(surface, "По дереву, По склу", "").reason, /«По склу» немає серед допустимих значень/, "частина поза довідником — нічого не вгадуємо");
  assert.match(validateValue(surface, "Универсальная", "").reason, /немає серед допустимих значень/);
  assert.match(validateValue(surface, "По дереву", "мм").reason, /одиниця/);
});

test("одиниці: лише погоджені перерахунки однієї величини (units.json: кВт↔Вт, кг↔г, см↔мм); різні величини не змішуються", () => {
  const units = catalog.units;
  const nominal = attrOf(GEN, "Номінальна потужність"); // кВт
  assert.deepEqual(validateValue(nominal, "2800", "Вт", units), { value: "2.8", unit: "кВт" });
  assert.match(validateValue(nominal, "3.8", "кВА", units).reason, /одиниця «кВА»/, "кВА — інша величина");
  assert.match(validateValue(nominal, "220", "В", units).reason, /одиниця «В»/, "напруга ≠ потужність");
  assert.deepEqual(validateValue(attrOf(GRIND, "Вага"), "1050", "г", units), { value: "1.05", unit: "кг" });
  assert.deepEqual(validateValue(attrOf(SAW, "Довжина шини"), "50", "см", units), { value: "500", unit: "мм" });
  assert.match(validateValue(attrOf(SAW, "Потужність двигуна"), "2.5", "кВт", units).reason, /одиниця «кВт» не відповідає «к. с.»/, "кВт → к. с. не погоджено");
  // Синоніми одиниць (однозначна технічна нормалізація, власник 23.10.2026): те саме написання тієї самої одиниці
  assert.deepEqual(validateValue(attrOf(GRIND, "Гарантійний термін"), "18", "місяців", units), { value: "18", unit: "міс" });
  assert.deepEqual(validateValue(attrOf(GRIND, "Гарантійний термін"), "36 месяцев", "", units), { value: "36", unit: "міс" });
  assert.deepEqual(validateValue(attrOf(GRIND, "Максимальна кількість обертів"), "11000", "об./мин", units), { value: "11000", unit: "об/хв" });
  assert.match(validateValue(attrOf(GRIND, "Гарантійний термін"), "3", "года", units).reason, /одиниця «года»/, "роки ≠ місяці: перерахунку немає");
});

test("назва атрибута з одиницею: «Мощность двигателя: 680 Вт» → «Потужність двигуна, Вт: 680», а не «Потужність двигуна» (к. с.) (реальний випадок 1250301)", () => {
  const brush = S("1250301");
  const m = mapParam(brush, P("Мощность двигателя", "680 Вт"), { units: catalog.units });
  assert.equal(m.attr.id, "15961"); assert.deepEqual(m.out, { name: "Потужність двигуна, Вт", value: "680", unit: "" });
  assert.equal(mapParam(brush, P("Мощность двигателя", "0.68", "кВт"), { units: catalog.units }).out.value, "680", "погоджений перерахунок");
  assert.equal(mapParam(brush, P("Мощность двигателя", "0.9", "л. с.")).attr.id, "15960", "«Потужність двигуна, л. с.»");
  assert.equal(mapParam(S(GEN), P("Мощность двигателя", "7", "л. с.")).attr.id, "344", "де є атрибут з одиницею в схемі — саме він");
  assert.equal(mapParam(brush, P("Потужність двигуна, Вт", "680")).out.value, "680");
  assert.equal(mapParam(brush, P("Мощность двигателя", "680", "В")).ok, false, "напруга — не потужність");
});

test("достовірність не оцінюється (власник): «Марка двигуна: 19.0 HP» передається з тим значенням, яке надав постачальник", () => {
  const brand = attrOf(GEN, "Марка двигуна"); // free
  assert.deepEqual(validateValue(brand, "19.0 HP", ""), { value: "19.0 HP", unit: "" });
  assert.deepEqual(validateValue(brand, "168F", ""), { value: "168F", unit: "" });
  const r = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [P("Марка двигателя", "19.0 HP")], current: [], mode: "queue" });
  assert.deepEqual(r.params, [P("Марка двигуна", "19.0 HP")], "офіційна назва поля, значення постачальника без змін");
  assert.equal(r.provenance.items[0].a, "1079");
});

test("потужність бензинового двигуна НЕ потрапляє в «Споживана потужність»: лише точна назва атрибута цієї категорії й одиниця", () => {
  const saw = S(SAW);
  assert.match(mapParam(saw, P("Потужність", "1800", "Вт")).reason, /немає такого атрибута/, "схожої назви недостатньо");
  assert.match(mapParam(saw, P("Потужність двигуна", "2.5", "кВт")).reason, /одиниця «кВт» не відповідає «к. с.»/);
  const engine = mapParam(saw, P("Мощность двигателя", "3", "к.с."));
  assert.equal(engine.attr.id, "344"); assert.deepEqual(engine.out, { name: "Потужність двигуна", value: "3", unit: "к. с." });
  const consumed = mapParam(saw, P("Потребляемая мощность", "1800", "Вт"));
  assert.equal(consumed.attr.id, "4"); assert.equal(consumed.out.name, "Споживана потужність");
  // Синонім — лише погоджений власником і лише для цієї категорії
  assert.equal(mapParam(saw, P("Потужність", "1800", "Вт"), { mapping: { synonyms: { "потужність": "4" } } }).attr.id, "4");
  assert.equal(mapParam(S(GRIND), P("Потужність двигуна", "3", "к. с.")).ok, false, "атрибута іншої категорії не підставляємо");
});

test("основний каталог, перше застосування схеми: перекладені вручну назви підтверджено як XML; невизначене збережено; нове поле й користувацькі (оригінальні значення) додано", () => {
  const raw = [P("Питание", "Сеть 220В"), P("Гарантия", "36 мес."), P("Вес", "2,2", "кг"), P("Состояние", "Новый"), P("Колір", "синій")];
  const current = [P("Гарантия", "36 мес."), P("Живлення", "Мережа 220В"), P("Тип шліфмашини", "Болгарка")]; // підготовлено раніше (CODEX/CLAUDE)
  const r = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: raw, current, mode: "main" });
  assert.deepEqual(r.params, [P("Гарантия", "36 мес."), P("Живлення", "Мережа 220В"), P("Тип шліфмашини", "Болгарка"), P("Вага", "2.2", "кг"), P("Стан", "Новый"), P("Колір", "синій")],
    "«Новый» не варіант схеми → користувацька з офіційною назвою «Стан» і оригінальним значенням; «Колір» — атрибута немає → користувацька");
  const by = Object.fromEntries(r.provenance.items.map((i) => [i.k.split("\u0001")[0], i]));
  assert.equal(by["Живлення"].s, SRC.XML);
  assert.equal(by["Гарантия"].s, SRC.RAW);
  assert.equal(by["Тип шліфмашини"].s, SRC.UNKNOWN, "походження не визначено — збережено");
  assert.equal(by["Вага"].s, SRC.XML);
  assert.equal(by["Стан"].a, "", "користувацька, не поле категорії");
  assert.match(r.notes.join(" "), /походження 1 характеристик не визначено/);
  // Постачальник змінив живлення → підтверджене поле оновлено автоматично; невизначене — без змін
  const raw2 = [P("Питание", "Аккумулятор"), P("Гарантия", "24 мес."), P("Вес", "2,2", "кг"), P("Состояние", "Новый"), P("Колір", "синій")];
  const r2 = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: raw2, current: r.params, provenance: r.provenance, mode: "main" });
  assert.deepEqual(r2.params, [P("Гарантия", "24 мес."), P("Живлення", "Акумулятор"), P("Тип шліфмашини", "Болгарка"), P("Вага", "2.2", "кг"), P("Стан", "Новый"), P("Колір", "синій")]);
  // Ідемпотентність
  const r3 = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: raw2, current: r2.params, provenance: r2.provenance, mode: "main" });
  assert.equal(r3.changed, false);
  // Власник прибрав користувацьку — не повертається
  const r4 = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: raw2, current: r2.params.filter((p) => p.name !== "Колір"), provenance: r2.provenance, mode: "main" });
  assert.ok(!r4.params.some((p) => p.name === "Колір"));
});

test("ручні виправлення мають перевагу: правку власника не перезаписано (конфлікт — у примітці); видалене власником поле не повертається", () => {
  const raw = [P("Питание", "Сеть 220В"), P("Вес", "2,2", "кг")];
  const r = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: raw, current: [], mode: "queue" });
  assert.deepEqual(r.params, [P("Живлення", "Мережа 220В"), P("Вага", "2.2", "кг")]);
  const edited = [P("Живлення", "Мережа 380В")]; // власник виправив живлення і прибрав вагу
  const r2 = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: raw, current: edited, provenance: JSON.stringify(r.provenance), mode: "queue" });
  assert.deepEqual(r2.params, [P("Живлення", "Мережа 380В")], "ручне значення збережено, вагу не повернуто");
  assert.equal(r2.provenance.items[0].s, SRC.MANUAL);
  assert.match(r2.conflicts.join(" "), /ручне значення «Мережа 380В» ≠ постачальник «Мережа 220В»/);
  const r3 = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Питание", "Аккумулятор"), P("Вес", "2,4", "кг")], current: r2.params, provenance: r2.provenance, mode: "queue" });
  assert.deepEqual(r3.params, [P("Живлення", "Мережа 380В")], "зміна постачальника не перекриває ручного");
});

test("без схеми: основний каталог — підготовлені характеристики не змінюються; черга — копія сирих (як раніше), ручні правки зберігаються", () => {
  const current = [P("Живлення", "Мережа 220В")];
  const m = buildCharacteristics({ schema: null, categoryId: "999", rawParams: [P("Питание", "Аккумулятор")], current, mode: "main" });
  assert.equal(m.changed, false);
  assert.deepEqual(m.params, current);
  // Навіть коли походження відоме (сирі записи), без схеми основний каталог нічого не змінює
  const known = buildCharacteristics({ schema: null, rawParams: [P("Питание", "Сеть 220В")], current: [], mode: "queue" });
  const m2 = buildCharacteristics({ schema: null, categoryId: "999", rawParams: [P("Питание", "Аккумулятор")], current: known.params, provenance: known.provenance, mode: "main" });
  assert.deepEqual(m2.params, [P("Питание", "Сеть 220В")]);
  assert.equal(m2.changed, false);
  const q1 = buildCharacteristics({ schema: null, rawParams: [P("Питание", "Сеть 220В")], current: [], mode: "queue" });
  assert.deepEqual(q1.params, [P("Питание", "Сеть 220В")]);
  const q2 = buildCharacteristics({ schema: null, rawParams: [P("Питание", "Аккумулятор")], current: q1.params, provenance: q1.provenance, mode: "queue" });
  assert.deepEqual(q2.params, [P("Питание", "Аккумулятор")], "сира копія оновлюється");
  const q3 = buildCharacteristics({ schema: null, rawParams: [P("Питание", "Сеть 220В")], current: [P("Живлення", "Акумулятор")], provenance: q2.provenance, mode: "queue" });
  assert.deepEqual(q3.params, [P("Живлення", "Акумулятор")], "ручну правку збережено, сире не додано поверх");
});

test("опис постачальника (приклад власника): поле категорії — за схемою; решта — користувацькі з оригінальними значеннями; конфлікт з XML — XML; очищення лише полів", () => {
  const desc = "<p>Виробник: Zegor<br>Напруга: 220 В<br>Розмір: 56 × 60 см<br>Має тепло нагрів: так</p><p>Опис товару.</p>";
  assert.deepEqual(descriptionPairs(desc).map((p) => p.key), ["Виробник", "Напруга", "Розмір", "Має тепло нагрів"]);
  const r = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [], descUa: desc, current: [], mode: "queue" });
  assert.deepEqual(r.params, [P("Напруга", "220", "В"), P("Виробник", "Zegor"), P("Розмір", "56 × 60 см"), P("Має тепло нагрів", "так")]);
  assert.ok(r.provenance.items.every((i) => i.s === SRC.DESC));
  assert.deepEqual(r.provenance.items.map((i) => Boolean(i.a)), [true, false, false, false]);
  const cleaned = cleanDescription(desc, r.descRanges.ua);
  assert.equal(cleaned, "<p>Виробник: Zegor<br>Розмір: 56 × 60 см<br>Має тепло нагрів: так</p><p>Опис товару.</p>", "прибрано лише перенесене в поле категорії; користувацькі лишаються в описі");
  // Таблиця з двома клітинками; рядок-заголовок «Характеристика | Значення» — не характеристика
  const table = "<table><tr><th>Характеристика</th><th>Значення</th></tr><tr><td>Напруга</td><td>230 В</td></tr><tr><td>Має тепло нагрів</td><td>так</td></tr></table><p>Текст</p>";
  const t = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [], descUa: table, current: [], mode: "queue" });
  assert.deepEqual(t.params, [P("Напруга", "230", "В"), P("Має тепло нагрів", "так")]);
  // XML і опис суперечать — XML; фрагмент опису не прибирається
  const c = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [P("Напряжение", "230", "В")], descUa: desc, current: [], mode: "queue" });
  assert.deepEqual(c.params[0], P("Напруга", "230", "В"));
  assert.match(c.conflicts.join(" "), /опис суперечить XML для «Напруга» — взято XML/);
  assert.deepEqual(c.descRanges.ua, []);
  // Два різні значення в описі — поле не заповнюється, ПОТРЕБУЄ ПЕРЕВІРКИ з обома оригіналами
  const d = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [], descUa: "<p>Напруга: 220 В</p><p>Напруга: 380 В</p>", current: [], mode: "queue" });
  assert.deepEqual(d.params, []);
  assert.deepEqual(d.ambiguous, ["2474"]);
  assert.deepEqual(d.needsReview[0].values.map((v) => v.value), ["Напруга: 220 В", "Напруга: 380 В"]);
  // HTML-сутності — як їх бачить покупець («20&ndash;60 мм» → «20–60 мм»), без інших змін значення
  const e = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [], descUa: "<p>Діапазон: 20&ndash;60 мм</p><p>Об&rsquo;єм бака для води: 5 л</p>", current: [], mode: "queue" });
  assert.deepEqual(e.params, [P("Діапазон", "20–60 мм"), P("Об’єм бака для води", "5 л")]);
});

test("зміна категорії: автоматичні поля перебудовано за схемою НОВОЇ категорії; невідповідні прибрано; ручні збережено з позначкою", () => {
  const raw = [P("Максимальный диаметр диска", "125", "мм"), P("Вес", "2", "кг")];
  const r = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: raw, current: [], mode: "main" });
  assert.deepEqual(r.params.map((p) => p.name), ["Максимальний діаметр диска", "Вага"]);
  const withManual = [...r.params, P("Мій коментар", "ручне")];
  const prov = { ...r.provenance, items: [...r.provenance.items, { k: ["Мій коментар", "ручне", ""].join("\u0001"), s: SRC.MANUAL, a: "" }] };
  const n = buildCharacteristics({ schema: S(SAW), categoryId: SAW, rawParams: raw, current: withManual, provenance: prov, mode: "main" });
  assert.deepEqual(n.params, [P("Вага", "2", "кг"), P("Мій коментар", "ручне"), P("Максимальный диаметр диска", "125", "мм")], "поля «діаметр диска» в бензопилах немає — прибрано; вага — за новою схемою");
  assert.equal(n.provenance.items[2].s, SRC.RAW, "незіставлене лишається сирою характеристикою постачальника, не полем Prom");
  assert.equal(n.provenance.items[2].a, "");
  assert.equal(n.provenance.cat, SAW);
  assert.match(n.notes.join(" "), /«Мій коментар» не перевірено для нової категорії 1250302/);
  assert.match(n.notes.join(" "), /прибрано .*Максимальний діаметр диска/);
});

test("неоднозначність назви: якщо в категорії кілька атрибутів з такою назвою — поле не заповнюється (синтетична схема лише для логіки)", () => {
  const schema = { id: "0", attributes: [
    { id: "1", nameUK: "Потужність", nameRU: "Мощность", type: "real", unitUK: "Вт", unitRU: "Вт", min: 0, max: 10000, values: [] },
    { id: "2", nameUK: "Потужність", nameRU: "Мощность двигателя", type: "real", unitUK: "к. с.", unitRU: "л. с.", min: 0, max: 10, values: [] },
  ] };
  const m = mapParam(schema, P("Потужність", "1500", "Вт"));
  assert.equal(m.ok, false);
  assert.match(m.reason, /кілька атрибутів категорії з такою назвою/);
  assert.equal(mapParam(schema, P("Мощность двигателя", "3", "л.с.")).attr.id, "2", "однозначна назва — так");
});

test("розбір фрагментів власника: неекрановані лапки (копія з браузера), атрибут із min > max виключається окремо, обірваний фрагмент не приймається", () => {
  const quoted = '<category id="9" nameRU="Т" nameUK="Т"><attribute id="6" nameRU="Тип патрона" type="singleselect" nameUK="Тип патрона">'
    + '<attribute_value id="8" nameRU="Квадрат 1"" nameUK="Квадрат 1""/><attribute_value id="39711" nameRU=""Мокрый"" nameUK="Мокрий"/></attribute>'
    + '<attribute id="11856" nameRU="Минимальное отклонения напряжения" type="integer" nameUK="Мінімальне відхилення напруги" measureUnitRU="%" min="0" max="-40" measureUnitUK="%"/>'
    + '<attribute id="5" nameRU="Вес" type="real" nameUK="Вага" measureUnitRU="кг" min="0" max="15" measureUnitUK="кг"/></category>';
  const [q] = parseSchemaText(quoted);
  assert.deepEqual(q.problems, []);
  assert.deepEqual(q.schema.attributes.find((a) => a.id === "6").values.map((v) => [v.nameRU, v.nameUK]), [['Квадрат 1"', 'Квадрат 1"'], ['"Мокрый"', "Мокрий"]]);
  assert.equal(q.schema.attributes.some((a) => a.id === "11856"), false, "атрибут з min > max не використовується");
  assert.deepEqual(q.schema.excluded.map((x) => x.id), ["11856"]);
  assert.ok(q.schema.attributes.some((a) => a.id === "5"), "решта схеми придатна");
  assert.ok(q.warnings.some((w) => /неекрановані лапки/.test(w)));
  const cut = parseSchemaText(' <categories>\n  <category id="12110201" nameRU="А" nameUK="Б">\n  <attribute id="100" nameRU="Г" type="integer" nameUK="Г"/>\n');
  assert.equal(cut.length, 1);
  assert.equal(cut[0].schema.id, "12110201");
  assert.match(cut[0].problems[0], /неповна категорія/);
  // Повторений id атрибута в категорії — блокує всю схему (не вибираємо версію)
  const dup = parseSchemaText('<category id="3" nameUK="Х"><attribute id="5" nameUK="Вага" type="real"/><attribute id="5" nameUK="Маса" type="real"/></category>');
  assert.match(dup[0].problems.join(" "), /повторений id атрибута/);
});

test("дослівне значення постачальника не підмінюється полем з ІНШОГО його параметра (реальний випадок: «Біметал HSS» → «Біметал»)", () => {
  const raw = [P("Матеріал", "Біметал HSS"), P("Материал", "Биметалл")];
  const r = buildCharacteristics({ schema: S("14201508"), categoryId: "14201508", rawParams: raw, current: [P("Матеріал", "Біметал HSS")], mode: "main" });
  assert.deepEqual(r.params, [P("Матеріал", "Біметал HSS")], "дані не втрачено, поле не задубльовано");
  assert.match(r.conflicts.join(" "), /наявне значення «Біметал HSS» залишено/);
  // Якщо ж поле Prom виведене з самого запису — заміна дозволена (RU-варіант → UA-варіант того самого поля)
  const r2 = buildCharacteristics({ schema: S("14201508"), categoryId: "14201508", rawParams: [P("Материал", "Биметалл")], current: [P("Материал", "Биметалл")], mode: "main" });
  assert.deepEqual(r2.params, [P("Матеріал", "Біметал")]);
});

test("смислові дублі (погоджено власником): той самий атрибут + сумісні одиниці + еквівалентні значення → одне поле Prom; дані не втрачаються (реальний випадок 141717)", () => {
  const raw = [P("Емкость аккумулятора", "2", "А·ч"), P("Емкость аккумулятора", "2"), P("Вес", "1.05", "кг")];
  const cur = [P("Ємність акумулятору", "2", "А. г"), P("Емкость аккумулятора", "2"), P("Вага", "1.05", "кг"), P("Вес", "1.05")];
  const r = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: raw, current: cur, mode: "main" });
  assert.deepEqual(r.params, [P("Ємність акумулятору", "2", "А. г"), P("Вага", "1.05", "кг")], "по одному полю на атрибут");
  assert.equal(r.merged.length, 3, JSON.stringify(r.merged));
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.rawOnly, [], "кожна характеристика постачальника представлена");
  // 1,05 ↔ 1.05 і RU-назва — те саме значення
  const d = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Вес", "1.05", "кг")], current: [P("Вага", "1,05 кг")], mode: "main" });
  assert.deepEqual(d.params, [P("Вага", "1.05", "кг")]);
  assert.deepEqual(d.conflicts, []);
  // Різні значення — не об'єднуються: обидва збережено, конфлікт позначено (не обираємо навмання)
  const c = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Вес", "1.05", "кг")], current: [P("Вага", "1.05", "кг"), P("Вес", "1.5")], mode: "main" });
  assert.deepEqual(c.params, [P("Вага", "1.05", "кг"), P("Вес", "1.5")]);
  assert.match(c.conflicts.join(" "), /«Вес»: наявне значення «1.5» ≠ постачальник «1.05»/);
  // Інша одиниця без погодженого перерахунку («гр») — не еквівалентне: наше збережено, конфлікт позначено
  const u = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Вес", "1.05", "кг")], current: [P("Вес", "1050 гр")], mode: "main" });
  assert.deepEqual(u.params, [P("Вес", "1050 гр")]);
  assert.deepEqual(u.merged, []);
  assert.match(u.conflicts.join(" "), /«1050 гр» ≠ постачальник «1.05»/);
});

test("«Гарантия» → «Гарантійний термін» (погоджений загальний синонім): лише де атрибут однозначний; ручне виправлення ніколи не прибирається", () => {
  const mapping = catalog.mappings.get(GRIND);
  assert.equal(mapping.synonyms["гарантия"], "100");
  const r = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Гарантия", "36 мес."), P("Гарантийный срок", "36", "мес")], current: [P("Гарантия", "36 мес.")], mapping, mode: "main" });
  assert.deepEqual(r.params, [P("Гарантійний термін", "36", "міс")]);
  assert.deepEqual(r.rawOnly, []);
  // Ручна правка з тим самим значенням — лишається (дубль позначено), поле Prom не додається поверх
  const q = buildCharacteristics({ schema: S(GRIND), rawParams: [P("Гарантийный срок", "36", "мес")], current: [], mapping, mode: "queue" });
  const manual = [P("Гарантия", "3 роки")];
  const m = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Гарантийный срок", "36", "мес")], current: manual, provenance: q.provenance, mapping, mode: "queue" });
  assert.deepEqual(m.params, manual, "ручне значення збережено");
  // Навіть еквівалентна ручна правка (власник написав «Гарантия: 36 мес.») не об'єднується — лишається як є
  const same = [P("Гарантійний термін", "36", "міс"), P("Гарантия", "36 мес.")];
  const e = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Гарантийный срок", "36", "мес")], current: same, provenance: q.provenance, mapping, mode: "queue" });
  assert.deepEqual(e.params, same);
  assert.equal(e.provenance.items[1].s, SRC.MANUAL);
  assert.deepEqual(e.merged, []);
  assert.match(e.duplicates.join(" "), /\(ручне\) дублює поле Prom/);
  // Категорія без такого атрибута — синоніма немає
  for (const [id, s] of catalog.schemas) if (!s.attributes.some((a) => a.nameUK === "Гарантійний термін")) assert.equal(catalog.mappings.get(id)?.synonyms?.["гарантия"], undefined, id);
});

test("користувацькі характеристики: без поля категорії — дослівно; значення, що не проходить поле, — користувацькою з офіційною назвою (без змін); без дублів; ліміти 100 / 70", () => {
  const raw = [P("Тип запуску", "Електростартер, Ручний"), P("Ступені висоти стрижки", "5"), P("Вес", "2", "кг")];
  const mower = S("1250308");
  const r = buildCharacteristics({ schema: mower, categoryId: "1250308", rawParams: raw, current: [], mode: "queue" });
  assert.deepEqual(r.params, [P("Вага", "2", "кг"), P("Тип запуску", "Електростартер, Ручний"), P("Ступені висоти стрижки", "5")]);
  assert.deepEqual(r.provenance.items.map((i) => i.a), ["5", "", ""]);
  assert.deepEqual(r.rawOnly, []);
  assert.deepEqual(r.customAttrNames, ["Тип запуску: Електростартер, Ручний"], "позначено: за документацією Prom імпортується як користувацька");
  // Поле категорії вже заповнене (з іншого джерела) — користувацька з тим самим атрибутом не дублюється
  const f = buildCharacteristics({ schema: mower, categoryId: "1250308", rawParams: [P("Вес", "2", "кг"), P("Вага", "2 кг.")], current: [], mode: "queue" });
  assert.deepEqual(f.params, [P("Вага", "2", "кг")]);
  // Понад 70 користувацьких — не додається, причина в overflow / rawOnly; загальний ліміт 100
  const many = Array.from({ length: 75 }, (_, i) => P(`Параметр ${i}`, String(i)));
  const o = buildCharacteristics({ schema: mower, categoryId: "1250308", rawParams: many, current: [], mode: "queue" });
  assert.equal(o.params.length, 70);
  assert.equal(o.overflow.length, 5);
  assert.match(o.rawOnly[0].reason, /ліміт Prom 70 користувацьких/);
  const many2 = Array.from({ length: 105 }, (_, i) => P(`Параметр ${i}`, String(i)));
  const prepared = buildCharacteristics({ schema: mower, categoryId: "1250308", rawParams: [], current: many2, mode: "main" });
  assert.equal(prepared.params.length, 100, "понад 100 — не передається");
});

test("UA/RU (власник): та сама характеристика за підтвердженою відповідністю назв — одна з українською назвою; різні значення — ПОТРЕБУЄ ПЕРЕВІРКИ з обома оригіналами", () => {
  const names = catalog.names;
  // Підтверджені пари назв — зі схем Prom (nameUK / nameRU)
  assert.equal(names.name.get("тип двигателя"), "Тип двигуна");
  // Однакові значення: одна характеристика, українська назва
  const same = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], descUa: "<p>Тип двигуна: безщітковий</p><p>Діаметр: 125 мм</p>", descRu: "<p>Тип двигателя: бесщеточный</p><p>Диаметр: 125 мм</p>", current: [], names, mode: "queue" });
  assert.deepEqual(same.params, [P("Тип двигуна", "Безщітковий"), P("Діаметр", "125 мм")]);
  assert.equal(same.uaRuMerged, 2, "поле категорії і користувацька — кожна по одній з UA і RU");
  // Різні значення — нічого не вибираємо: не передано, обидва оригінали для порівняння
  const diff = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], descUa: "<p>Тип запуску: ручний</p><p>Режим: 2</p>", descRu: "<p>Тип запуска: ручной</p><p>Режим: 3</p>", current: [], names, mode: "queue" });
  assert.ok(!diff.params.some((p) => p.name === "Режим"));
  const rv = diff.needsReview.find((x) => x.name === "Режим");
  assert.deepEqual(rv.values.map((v) => v.value), ["Режим: 2", "Режим: 3"]);
  assert.match(rv.reason, /UA і RU значення відрізняються/);
  // RU-пара без UA-відповідника при наявному UA-описі — окремо не додається (ruDup, якщо в UA те саме значення)
  const ru = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], descUa: "<p>Країна виробництва: Китай</p><p>Акумулятор у комплекті: немає</p>", descRu: "<p>Страна производства: Китай</p><p>Аккумулятор в комплекте: нет</p><p>Длина реза: 700 мм</p>", current: [], names, mode: "queue" });
  // Країна / Акумулятор — та сама позиція в описі й те саме значення: RU окремо не додається (не дубль іншою мовою);
  // «Длина реза» — лише в RU-описі, підтвердженого перекладу немає: передається з оригінальною назвою (не втрачається)
  assert.deepEqual(ru.params, [P("Країна виробництва", "Китай"), P("Акумулятор у комплекті", "немає"), P("Длина реза", "700 мм")]);
  assert.equal(ru.aligned, 2);
  assert.equal(ru.ruOnly, 1);
  assert.deepEqual(ru.needsReview, []);
  assert.ok(ru.proposals.names.some((x) => x.ru === "Страна производства" && x.ua === "Країна виробництва"), "пара — у пропозиції словника");
  // UA-опису немає — RU-пара єдине джерело: передається (назва — підтверджена українська, значення без перекладу)
  const only = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Режимы запуска", "Ручной")], descRu: "<p>Аккумулятор в комплекте: нет</p><p>Цвет корпуса: синий</p><p>Длина реза: 700 мм</p>", current: [], names, mode: "queue" });
  assert.deepEqual(only.params, [P("Режими запуску", "Ручной"), P("Акумулятор в комплекті", "нет"), P("Колір корпусу", "синий"), P("Длина реза", "700 мм")],
    "підтверджена UA-назва (схеми Prom) — українська; непідтверджена — як у постачальника");
});

test("однакові числа — НЕ підстава об'єднувати (власник): «Потужність двигуна» ≠ «Споживана потужність», «Номінальна» ≠ «Споживана»; обидві передаються, пара — у пропозиції синонімів", () => {
  const names = catalog.names, mapping = catalog.mappings.get(GRIND), units = catalog.units;
  const a = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Потребляемая мощность", "680", "Вт")], descUa: "<p>Потужність двигуна: 680 Вт</p>", current: [], names, mapping, units, mode: "queue" });
  assert.deepEqual(a.params, [P("Споживана потужність", "680", "Вт"), P("Потужність двигуна", "680 Вт")]);
  assert.deepEqual(a.merged, []); assert.equal(a.uaRuMerged, 0); assert.deepEqual(a.needsReview, []);
  assert.deepEqual(a.proposals.synonyms.map((x) => [x.name, x.other]), [["Потужність двигуна", "Споживана потужність"]]);
  const b = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], descUa: "<p>Номінальна потужність: 1800 Вт</p><p>Споживча потужність: 1800 Вт</p>", descRu: "<p>Номинальная мощность: 1800 Вт</p><p>Потребляемая мощность: 1800 Вт</p>", current: [], names, mapping, units, mode: "queue" });
  assert.deepEqual(b.params.map((p) => p.name).sort(), ["Номінальна потужність", "Споживана потужність"]);
  // Те саме число в іншій позиції опису — не та сама характеристика: «Длина кабеля» ≠ «Довжина шини»
  const c = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], descUa: "<p>Довжина шини: 40 см</p><p>Вага: 5 кг</p>", descRu: "<p>Вес: 5 кг</p><p>Длина кабеля: 40 см</p>", current: [], names, mapping, units, mode: "queue" });
  assert.deepEqual(c.params, [P("Вага", "5", "кг"), P("Довжина шини", "40 см"), P("Довжина кабелю", "40 см")], "кабель — окремо (назва — офіційний переклад зі схем Prom)");
  // Різні числа UA / RU — справжній конфлікт: не передається жодне, обидва оригінали
  const d = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], descUa: "<p>Діаметр: 125 мм</p>", descRu: "<p>Диаметр: 115 мм</p>", current: [], names, mapping, units, mode: "queue" });
  assert.deepEqual(d.params, []);
  assert.equal(d.needsReview[0].kind, "конфлікт");
  assert.deepEqual(d.needsReview[0].values.map((v) => v.value), ["Діаметр: 125 мм", "Диаметр: 115 мм"]);
});

test("підтверджені еквіваленти UA/RU (приклади власника) — одна характеристика без попередження; непідтверджене значення — ПОТРЕБУЄ ПЕРЕВІРКИ", () => {
  const names = catalog.names, mapping = catalog.mappings.get(GRIND), units = catalog.units;
  const B = (o) => buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], current: [], names, mapping, units, mode: "queue", ...o });
  // «Вага: 1,05 кг» = «Вес: 1.05 кг»
  const w = B({ descUa: "<p>Вага: 1,05 кг</p>", descRu: "<p>Вес: 1.05 кг</p>" });
  assert.deepEqual(w.params, [P("Вага", "1.05", "кг")]); assert.deepEqual(w.needsReview, []);
  // «Гарантія: 36 місяців» = «Гарантия: 36 месяцев» = «Гарантійний термін» (погоджено) — одне поле
  const g = B({ rawParams: [P("Гарантия", "36 мес.")], descUa: "<p>Гарантія: 36 місяців</p>", descRu: "<p>Гарантия: 36 месяцев</p>" });
  assert.deepEqual(g.params, [P("Гарантійний термін", "36", "міс")]); assert.deepEqual(g.needsReview, []);
  // «Стан: Новий» / «Состояние: Новый» — відповідність значень не підтверджена (у схемі «Новое») → ПОТРЕБУЄ ПЕРЕВІРКИ
  const st = B({ descUa: "<p>Стан: Новий</p>", descRu: "<p>Состояние: Новый</p>" });
  assert.deepEqual(st.params, [P("Стан", "Новий")]);
  assert.equal(st.needsReview.length, 1); assert.equal(st.needsReview[0].kind, "слова різні");
  // …після погодження пари значень — без попередження
  const approved = buildNames([...catalog.schemas.values()], {}, units.aliasMap, { "Новый": "Новий" });
  const st2 = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], current: [], names: approved, mapping, units, mode: "queue", descUa: "<p>Стан: Новий</p>", descRu: "<p>Состояние: Новый</p>" });
  assert.deepEqual(st2.needsReview, []);
  // Технічна нормалізація: латиниця-двійник («M14» / «М14»), одиниці й роздільники, декоративні символи
  const hg = B({ descUa: "<p>Різьба шпинделя: M14</p>", descRu: "<p>Резьба шпинделя: М14</p>" });
  assert.deepEqual(hg.params, [P("Різьба шпинделя", "M14")]);
  assert.deepEqual(hg.needsReview, [], "M14 (латиниця) = М14 (кирилиця) — без попередження");
  assert.ok(sameValue(P("x", "M14"), P("x", "М14"), names));
  assert.ok(sameValue(P("x", "400 об./мин, 1400 об/мин"), P("x", "400 об/хв, 1400 об/хв"), names));
  assert.ok(sameValue(P("x", "2 - 13 мм"), P("x", "2-13 мм"), names));
  assert.ok(sameValue(P("x", "✔ Без акумулятора"), P("x", "Без акумулятора"), names));
  assert.ok(!sameValue(P("x", "40 см"), P("x", "40 мм"), names), "різні одиниці — різні значення");
  assert.ok(!sameValue(P("x", "3 роки"), P("x", "3 міс"), names));
  // Одиниця в назві постачальника: «Вес, кг: 1.15» → поле «Вага»; «Гарантія, міс: 36» → «Гарантійний термін»
  assert.deepEqual(B({ rawParams: [P("Вес, кг", "1.15")], descUa: "<p>Гарантія, міс: 36</p>" }).params, [P("Вага", "1.15", "кг"), P("Гарантійний термін", "36", "міс")]);
  // Так/ні по порядку: кожна RU-пара — своя UA-пара; лише RU («Кейс») — передається
  const yn = B({ descUa: "<p>Акумулятор у комплекті: немає</p><p>Зарядний пристрій у комплекті: немає</p>", descRu: "<p>Аккумулятор в комплекте: нет</p><p>Зарядное устройство в комплекте: нет</p><p>Кейс: есть</p>" });
  assert.deepEqual(yn.params, [P("Акумулятор у комплекті", "немає"), P("Зарядний пристрій у комплекті", "немає"), P("Кейс", "есть")]);
  assert.equal(yn.aligned, 2);
});

test("вирівнювання UA/RU-описів: та сама назва — якір; однакове значення — за порядком; рівні проміжки — за позицією", () => {
  const U = ["a", "b", "c", "d"].map((k) => ({ k })), R = ["A", "x", "C", "D"].map((k) => ({ k }));
  const al = alignPairs(U, R, (u, r) => (u.k.toUpperCase() === r.k ? 2 : 0));
  assert.deepEqual(al.map((x) => [x.u.k, x.r.k, x.s]).sort(), [["a", "A", 2], ["b", "x", 0], ["c", "C", 2], ["d", "D", 2]]);
  assert.deepEqual(alignPairs(U, [], () => 1), []);
});

test("опис: однаковий конфлікт з UA- і RU-опису — один раз; очищення сирої копії лише від фрагментів, перенесених у поля категорії", () => {
  const ua = "<p>Напруга: 220 В</p><p>Виробник: Edon</p>", ru = "<p>Напряжение: 220 В</p><p>Производитель: Edon</p>";
  const r = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [P("Напряжение", "230", "В")], descUa: ua, descRu: ru, current: [], mode: "queue" });
  assert.deepEqual(r.conflicts, ["опис суперечить XML для «Напруга» — взято XML"]);
  assert.deepEqual(r.descRanges, { ua: [], ru: [] }, "суперечливий фрагмент не прибирається");
  const ok = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [], descUa: ua, descRu: ru, current: [], mode: "queue" });
  assert.equal(cleanDescription(ua, ok.descRanges.ua), "<p>Виробник: Edon</p>", "«Виробник» (без атрибута) лишається");
  assert.equal(cleanDescription(ru, ok.descRanges.ru), "<p>Производитель: Edon</p>");
});
