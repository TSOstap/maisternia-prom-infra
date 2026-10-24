/** Характеристики Prom (погоджено власником 23.10.2026): схеми категорій, перевірка значень, перенесення з XML і опису,
 *  збереження ручних виправлень, зміна категорії. Схеми — справжні файли з schemas/prom (жодних вигаданих атрибутів). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { categoryBlocks, parseSchemaText } from "../src/core/prom-schema.mjs";
import { SRC, alignPairs, buildCharacteristics, buildNames, charKey, cleanDescription, cleanValue, descriptionPairs, hoursValue, hoursWord, importRisks, mapParam, sameValue, sameValueIn, validateValue, wordsMatch, wordsMatchAnyOrder } from "../src/core/prom-attributes.mjs";
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
  // Позиція й однакове значення НЕ підтверджують відповідність (власник, 24.10.2026): RU-пари не об'єднуються й не
  // відкидаються — передаються окремо (назва — офіційний переклад зі схем Prom, якщо є, інакше оригінальна)
  assert.deepEqual(ru.params, [P("Країна виробництва", "Китай"), P("Акумулятор у комплекті", "немає"), P("Страна производства", "Китай"), P("Акумулятор в комплекті", "нет"), P("Длина реза", "700 мм")]);
  assert.equal(ru.aligned, 0);
  assert.equal(ru.ruOnly, 3);
  assert.deepEqual(ru.needsReview, []);
  assert.ok(ru.proposals.names.some((x) => x.ru === "Страна производства" && x.ua === "Країна виробництва"), "пара — лише пропозиція словника");
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
  // «Споживча потужність» (UA) і поле «Споживана потужність» (з RU «Потребляемая мощность») — слово в слово те саме (офіційний
  // переклад «потребляемая» → «споживана», та сама основа), значення однакові: одна характеристика (власник, 24.10.2026).
  assert.deepEqual(b.params.map((p) => p.name).sort(), ["Номінальна потужність", "Споживана потужність"]);
  assert.equal(b.lexMerged.length, 1);
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
  // «Стан: Новий» / «Состояние: Новый» — без погодженої пари значень (у схемі «Новое») → ПОТРЕБУЄ ПЕРЕВІРКИ
  const bare = buildNames([...catalog.schemas.values()], {}, units.aliasMap, {});
  const B0 = (o) => buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], current: [], names: bare, mapping, units, mode: "queue", ...o });
  const st = B0({ descUa: "<p>Стан: Новий</p>", descRu: "<p>Состояние: Новый</p>" });
  assert.deepEqual(st.params, [P("Стан", "Новий")]);
  // «Новий» / «Новый» — те саме слово в UA- і RU-написанні (пословна відповідність, 24.10.2026): без попередження
  assert.deepEqual(st.needsReview, []);
  // а різні слова без погодженої пари — ПОТРЕБУЄ ПЕРЕВІРКИ
  const st0 = B0({ descUa: "<p>Стан: Вживаний</p>", descRu: "<p>Состояние: Новый</p>" });
  assert.equal(st0.needsReview.length, 1);
  // …з погодженою парою (власник, 24.10.2026, №37 «новый» → «новий») — без попередження
  const st2 = B({ descUa: "<p>Стан: Новий</p>", descRu: "<p>Состояние: Новый</p>" });
  assert.deepEqual(st2.params, [P("Стан", "Новий")]);
  assert.deepEqual(st2.needsReview, []);
  // Технічна нормалізація: латиниця-двійник («M14» / «М14»), одиниці й роздільники, декоративні символи
  const hg = B({ descUa: "<p>Модель: M14</p>", descRu: "<p>Модель: М14</p>" }); // та сама назва — підтверджено
  assert.deepEqual(hg.params, [P("Модель", "M14")]);
  assert.deepEqual(hg.needsReview, [], "M14 (латиниця) = М14 (кирилиця) — без попередження");
  assert.ok(sameValue(P("x", "M14"), P("x", "М14"), names));
  assert.ok(sameValue(P("x", "400 об./мин, 1400 об/мин"), P("x", "400 об/хв, 1400 об/хв"), names));
  assert.ok(sameValue(P("x", "2 - 13 мм"), P("x", "2-13 мм"), names));
  assert.ok(sameValue(P("x", "✔ Без акумулятора"), P("x", "Без акумулятора"), names));
  assert.ok(!sameValue(P("x", "40 см"), P("x", "40 мм"), names), "різні одиниці — різні значення");
  assert.ok(!sameValue(P("x", "3 роки"), P("x", "3 міс"), names));
  // Одиниця в назві постачальника: «Вес, кг: 1.15» → поле «Вага»; «Гарантія, міс: 36» (характеристика) → «Гарантійний термін»
  assert.deepEqual(B({ rawParams: [P("Вес, кг", "1.15"), P("Гарантія, міс", "36")] }).params, [P("Вага", "1.15", "кг"), P("Гарантійний термін", "36", "міс")]);
  // Так/ні по порядку: кожна RU-пара — своя UA-пара; лише RU («Кейс») — передається
  const yn = B({ descUa: "<p>Акумулятор у комплекті: немає</p><p>Зарядний пристрій у комплекті: немає</p>", descRu: "<p>Аккумулятор в комплекте: нет</p><p>Зарядное устройство в комплекте: нет</p><p>Кейс: есть</p>" });
  // «у комплекті» (постачальник) ≠ офіційне «в комплекті» — назву не підтверджено: обидві передаються окремо
  // …а «Зарядное устройство в комплекте» — погоджена пара (власник, 24.10.2026, №24): одна характеристика
  assert.deepEqual(yn.params.map((p) => p.name), ["Акумулятор у комплекті", "Зарядний пристрій у комплекті", "Акумулятор в комплекті", "Кейс"]);
  assert.equal(yn.aligned, 0);
});

test("вирівнювання UA/RU-описів (лише для ПРОПОЗИЦІЙ словника): та сама назва — якір; однакове значення — за порядком; рівні проміжки — за позицією", () => {
  const U = ["a", "b", "c", "d"].map((k) => ({ k })), R = ["A", "x", "C", "D"].map((k) => ({ k }));
  const al = alignPairs(U, R, (u, r) => (u.k.toUpperCase() === r.k ? 2 : 0));
  assert.deepEqual(al.map((x) => [x.u.k, x.r.k, x.s]).sort(), [["a", "A", 2], ["b", "x", 0], ["c", "C", 2], ["d", "D", 2]]);
  assert.deepEqual(alignPairs(U, [], () => 1), []);
});

test("позиція / так-да / однакові числа НЕ підтверджують однаковість (власник, 24.10.2026): «Реверс — Так» ≠ «Подсветка — Да»; різний порядок пар з однаковими числами — нічого не зливається й не губиться", () => {
  const names = catalog.names, mapping = catalog.mappings.get(GRIND), units = catalog.units;
  const B = (o) => buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], current: [], names, mapping, units, mode: "queue", ...o });
  // та сама позиція, «Так» / «Да»: дві різні характеристики
  const a = B({ descUa: "<p>Реверс: Так</p>", descRu: "<p>Подсветка: Да</p>" });
  assert.deepEqual(a.params.map((p) => `${p.name}: ${p.value}`), ["Реверс: Так", "Подсветка: Да"]);
  assert.equal(a.aligned, 0); assert.equal(a.uaRuMerged, 0); assert.deepEqual(a.needsReview, []);
  // UA і RU у РІЗНОМУ порядку з однаковими числами: непідтверджені пари — кожна окремо
  const b = B({ descUa: "<p>Довжина ланцюга: 40 см</p><p>Ширина захвату: 25 см</p>", descRu: "<p>Ширина реза: 25 см</p><p>Длина шины: 40 см</p>" });
  assert.equal(b.params.length, 4, JSON.stringify(b.params));
  assert.ok(b.params.some((p) => p.name === "Ширина реза" && p.value === "25 см"));
  assert.ok(b.params.some((p) => p.name === "Довжина ланцюга" && p.value === "40 см"));
  assert.deepEqual(b.merged, []); assert.equal(b.uaRuMerged, 0);
  // Те саме з ОФІЦІЙНО підтвердженими назвами (схеми Prom) — порядок не важливий: зливаються лише підтверджені
  const c = B({ descUa: "<p>Довжина кабелю: 3 м</p><p>Вага: 3 кг</p>", descRu: "<p>Вес: 3 кг</p><p>Длина кабеля: 3 м</p>" });
  assert.deepEqual(c.params, [P("Вага", "3", "кг"), P("Довжина кабелю", "3 м")]);
  assert.equal(c.uaRuMerged, 2);
  // Однакове число, різні величини на тих самих позиціях — не зливаються
  const d = B({ descUa: "<p>Довжина шини: 40 см</p>", descRu: "<p>Ширина: 40 см</p>" });
  assert.equal(d.params.length, 2);
  // Жодна пара не зникла: кожна є в підсумку
  for (const r of [a, b, c, d]) assert.deepEqual(r.overflow, []);
});

test("словник назв — до кінцевої форми: ланцюжок погоджених відповідностей дає ОДИН ключ (без дублів)", () => {
  const units = catalog.units;
  const chain = buildNames([...catalog.schemas.values()], { "Источник питания": "Джерело живлення", "Джерело живлення": "Живлення" }, units.aliasMap, {});
  const B = (ua, ru) => buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [], current: [], names: chain, mapping: catalog.mappings.get(GRIND), units, mode: "queue", descUa: ua, descRu: ru });
  // «мережа» / «сеть» — офіційна пара значень зі схем Prom: одна характеристика з українською назвою й значенням
  assert.deepEqual(B("<p>Джерело живлення: мережа</p>", "<p>Источник питания: сеть</p>").params, [P("Живлення", "мережа")]);
  const r = B("<p>Джерело живлення: мережа 230 В</p>", "<p>Источник питания: сеть 220 В</p>");
  assert.equal(r.params.length, 0, "та сама характеристика, значення різні — ПОТРЕБУЄ ПЕРЕВІРКИ, не дві характеристики");
  assert.equal(r.needsReview.length, 1);
  assert.equal(r.needsReview[0].kind, "конфлікт");
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

test("погоджені словники (власник, 24.10.2026): №1–35 назви, №37/38/41/42 значення глобально, №36/39/40 — лише у своїй характеристиці", () => {
  const names = catalog.names, mapping = catalog.mappings.get(GRIND), units = catalog.units;
  const B = (o, cat = GRIND) => buildCharacteristics({ schema: S(cat), categoryId: cat, rawParams: [], current: [], names, mapping: catalog.mappings.get(cat), units, mode: "queue", ...o });
  assert.deepEqual(catalog.problems, []);
  // №1: одна характеристика з українською назвою; різні значення — ПОТРЕБУЄ ПЕРЕВІРКИ з обома оригіналами
  assert.deepEqual(B({ descUa: "<p>Виробник: DeWALT</p>", descRu: "<p>Производитель: DeWALT</p>" }).params, [P("Виробник", "DeWALT")]);
  const pr = B({ descUa: "<p>Виробник: DeWALT</p>", descRu: "<p>Производитель: Makita</p>" });
  assert.deepEqual(pr.params, []); assert.equal(pr.needsReview[0].kind, "конфлікт");
  assert.deepEqual(pr.needsReview[0].values.map((v) => v.value), ["Виробник: DeWALT", "Производитель: Makita"]);
  // №38 — глобально
  assert.deepEqual(B({ descUa: "<p>Підключення: Від мережі 220 В</p>", descRu: "<p>Подключение: От сети 220 В</p>" }).needsReview, []);
  // №36 «Есть» → «Має» — лише в характеристиках наявності, де пару погоджено
  const ok36 = B({ descUa: "<p>Захист від перегріву: Має</p>", descRu: "<p>Защита от перегрева: Есть</p>" });
  assert.deepEqual(ok36.params, [P("Захист від перегріву", "Має")]); assert.deepEqual(ok36.needsReview, []);
  const no36 = B({ descUa: "<p>Реверс: Має</p>", descRu: "<p>Реверс: Есть</p>" });
  assert.deepEqual(no36.params, []); assert.equal(no36.needsReview.length, 1, "поза погодженим контекстом — обидва значення, неоднозначність");
  // №39 — лише «Джерело живлення» (у шліфмашинах це атрибут «Живлення», №46); в іншій характеристиці — ні
  const p39 = B({ descUa: "<p>Джерело живлення: акумуляторне</p>", descRu: "<p>Источник питания: аккумуляторный</p>" });
  assert.deepEqual(p39.needsReview, []);
  assert.deepEqual(p39.params, [P("Живлення", "акумуляторне")], "UA і RU — та сама характеристика (офіційна пара + №46): одна, значення UA без змін");
  assert.equal(B({ descUa: "<p>Тип: акумуляторне</p>", descRu: "<p>Тип: аккумуляторный</p>" }).needsReview.length, 1);
  // №40 — лише «Охолодження»
  assert.deepEqual(B({ descUa: "<p>Охолодження: примусове</p>", descRu: "<p>Охлаждение: принудительное</p>" }).needsReview, []);
  assert.equal(B({ descUa: "<p>Режим: примусове</p>", descRu: "<p>Режим: принудительное</p>" }).needsReview.length, 1, "та сама назва, але не «Охолодження» — пара значень не діє");
  // непідтверджені назви («Вентиляція» / «Вентиляция») — окремі характеристики, нічого не зливається
  assert.equal(B({ descUa: "<p>Вентиляція: примусове</p>", descRu: "<p>Вентиляция: принудительное</p>" }).params.length, 2);
});

test("синоніми атрибутів (власник, 24.10.2026): №43–45 — стандартне поле лише якщо атрибут є в схемі й значення проходить перевірку; №46 — лише у 19 категоріях з атрибутом «Живлення»", () => {
  const names = catalog.names, units = catalog.units;
  const B = (o, cat = GRIND) => buildCharacteristics({ schema: S(cat), categoryId: cat, rawParams: [], current: [], names, mapping: catalog.mappings.get(cat), units, mode: "queue", ...o });
  const a = B({ rawParams: [P("Напруга акумулятора", "18", "В"), P("Ємність акумулятора", "4", "А·год"), P("Стан товару", "новий")] });
  assert.deepEqual(a.params, [P("Напруга акумулятору", "18", "В"), P("Ємність акумулятору", "4", "А. г"), P("Стан", "Новий")]);
  assert.ok(a.provenance.items.every((i) => i.a), "стандартні поля Prom");
  // Значення не проходить поле — не підганяється: користувацька з офіційною назвою, значення постачальника
  assert.deepEqual(B({ rawParams: [P("Напруга акумулятора", "18-20", "В")] }).params, [P("Напруга акумулятору", "18-20", "В")]);
  // Категорія без атрибута — синонім не діє, характеристика лишається як є
  const pump = "140309"; // Свердловинні насоси: «Живлення» немає
  assert.equal(catalog.mappings.get(pump)?.synonyms?.["джерело живлення"], undefined);
  assert.deepEqual(B({ rawParams: [P("Джерело живлення", "мережа")] }, pump).params, [P("Джерело живлення", "мережа")]);
  // №46 у категорії з атрибутом: «Джерело живлення: Акумулятор» → поле «Живлення»
  assert.deepEqual(B({ rawParams: [P("Джерело живлення", "Акумулятор")] }).params, [P("Живлення", "Акумулятор")]);
  const cats = [...catalog.mappings].filter(([, m]) => m.synonyms["джерело живлення"]).map(([id]) => id);
  assert.equal(cats.length, 19);
  for (const id of cats) assert.equal(S(id).attributes.find((x) => x.id === catalog.mappings.get(id).synonyms["джерело живлення"]).nameUK, "Живлення");
});

test("заборонені відповідності №47–50 ніколи не застосовуються — ні напряму, ні через словники / ланцюжки синонімів", () => {
  const forbidden = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, "synonyms.json"), "utf8")).forbidden;
  assert.deepEqual(forbidden, [["Вага брутто", "Вага"], ["Потужність", "Споживана потужність"], ["Вес без аккумулятора", "Вага"], ["Частота", "Частота струму"]]);
  // У жодній із 48 категорій — не один ключ
  for (const [id, schema] of catalog.schemas) for (const [x, y] of forbidden) {
    const opt = { mapping: catalog.mappings.get(id), names: catalog.names };
    assert.notEqual(charKey(schema, x, opt), charKey(schema, y, opt), `${id}: «${x}» = «${y}»`);
  }
  // Наскрізно: однакові значення — дві окремі характеристики, без попередження й без об'єднання
  const names = catalog.names, units = catalog.units, mapping = catalog.mappings.get(GRIND);
  const r = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, current: [], names, mapping, units, mode: "queue",
    rawParams: [P("Вес", "2", "кг"), P("Потребляемая мощность", "800", "Вт"), P("Частота тока", "50", "Гц")],
    descUa: "<p>Вага брутто: 2 кг</p><p>Потужність: 800 Вт</p><p>Частота: 50 Гц</p>", descRu: "<p>Вес без аккумулятора: 2 кг</p>" });
  for (const n of ["Вага", "Вага брутто", "Вес без аккумулятора", "Споживана потужність", "Потужність", "Частота"]) assert.ok(r.params.some((p) => p.name === n), n);
  assert.deepEqual(r.merged, []);
  // Якщо хтось додасть до словника ланцюжок, що веде до забороненої пари, — завантаження каталогу повідомляє про це
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-forbidden-"));
  fs.cpSync(SCHEMAS_DIR, dir, { recursive: true });
  const dict = JSON.parse(fs.readFileSync(path.join(dir, "names-ua-ru.json"), "utf8"));
  dict.names["Вага брутто"] = "Вес"; // «Вес» → «Вага» (схема) — ланцюжок до забороненої пари
  fs.writeFileSync(path.join(dir, "names-ua-ru.json"), JSON.stringify(dict));
  const bad = loadPromCatalog(dir);
  assert.ok(bad.problems.some((p) => /заборонена відповідність «Вага брутто» = «Вага»/.test(p)), JSON.stringify(bad.problems.slice(0, 3)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("формат, ПІДТВЕРДЖЕНИЙ першим реальним імпортом у Prom (власник, 24.10.2026; категорія 141725 «Перфоратори», 1 товар): стандартні поля — офіційні UA-назва й одиниця схеми; число окремо від одиниці; bool — «Так»; multiselect — допустимі варіанти через « | »; користувацька — окремо", () => {
  const cat = "141725";
  const r = buildCharacteristics({ schema: S(cat), categoryId: cat, current: [], names: catalog.names, mapping: catalog.mappings.get(cat), units: catalog.units, mode: "queue",
    rawParams: [P("Питание", "Аккумулятор"), P("Вес", "3,1", "кг"), P("Гарантийный срок", "24", "мес"), P("Реверс", "Да"), P("Режимы работы", "Сверление|Сверление с ударом|Долбление (удар)"), P("Напряжение аккумулятора", "20", "В"), P("Тестова характеристика", "значення")] });
  assert.deepEqual(r.params, [
    P("Живлення", "Акумулятор"), P("Вага", "3.1", "кг"), P("Гарантійний термін", "24", "міс"), P("Реверс", "Так"),
    P("Режими роботи", "Свердління | Свердління з ударом | Довбання (удар)"), P("Напруга акумулятору", "20", "В"), P("Тестова характеристика", "значення"),
  ]);
  assert.deepEqual(r.provenance.items.map((i) => Boolean(i.a)), [true, true, true, true, true, true, false]);
});

test("гарантія (власник, 24.10.2026): гарантійний термін — лише зі структурованих характеристик; опис не змінює й не створює гарантію; розбіжність — інформаційно, без ПОТРЕБУЄ ПЕРЕВІРКИ", () => {
  const cat = "14209803"; // Свердлильні верстати: «Гарантійний термін» max 24
  const B = (o, c = cat) => buildCharacteristics({ schema: S(c), categoryId: c, current: [], names: catalog.names, mapping: catalog.mappings.get(c), units: catalog.units, mode: "queue", rawParams: [], ...o });
  // Характеристики 24 міс, опис 36 місяців → 24 міс; попередження немає, примітка інформаційна
  const a = B({ rawParams: [P("Гарантийный срок", "24", "мес"), P("Гарантия", "24 мес.")], descUa: "<p>Гарантія: 36 місяців.</p>", descRu: "<p>Гарантия: 36 месяцев.</p>" });
  assert.deepEqual(a.params, [P("Гарантійний термін", "24", "міс")]);
  assert.deepEqual(a.needsReview, []);
  assert.deepEqual(a.warranty, { value: "Гарантійний термін: 24 міс", source: SRC.XML });
  assert.equal(a.notes.filter((n) => /гарантія з опису не використовується.*«Гарантія: 36 місяців\.» ≠ характеристика «Гарантійний термін: 24 міс»/.test(n)).length, 1);
  // Однакова гарантія в описі — без приміток
  assert.equal(B({ rawParams: [P("Гарантийный срок", "12", "мес")], descUa: "<p>Гарантія: 12 місяців</p>" }).notes.filter((n) => /гарантія/.test(n)).length, 0);
  // Лише в описі (у характеристиках немає) — гарантія НЕ заповнюється з опису
  const d = B({ descUa: "<p>Гарантія: 24 місяці</p><p>Гарантійний термін, міс: 24</p>", descRu: "<p>Гарантийный срок: 24 мес</p>" });
  assert.deepEqual(d.params, []); assert.equal(d.warranty, null);
  assert.ok(d.notes.some((n) => /у характеристиках гарантії немає/.test(n)));
  // Ручна гарантія власника має пріоритет; сирі значення постачальника не втрачаються (rawOnly / сирі дані)
  const q = B({ rawParams: [P("Гарантийный срок", "24", "мес")] });
  const m = buildCharacteristics({ schema: S(cat), categoryId: cat, current: [P("Гарантійний термін", "12", "міс")], provenance: q.provenance, names: catalog.names, mapping: catalog.mappings.get(cat), units: catalog.units, mode: "queue", rawParams: [P("Гарантийный срок", "24", "мес")], descUa: "<p>Гарантія: 36 місяців</p>" });
  assert.deepEqual(m.params, [P("Гарантійний термін", "12", "міс")]);
  assert.equal(m.warranty.source, SRC.MANUAL);
  // «Гарантія на акумулятор» — інша характеристика, правилом гарантії не зачіпається
  assert.ok(B({ descUa: "<p>Гарантія на акумулятор: 6 місяців</p>" }).params.some((p) => p.name === "Гарантія на акумулятор"));
});

test("очищення значень перед XML (власник, 24.10.2026): HTML-сутності (іменовані й числові), кінцева «;» опису; «;» усередині, числа, діапазони, моделі, одиниці — без змін", () => {
  assert.equal(cleanValue("Gr&ouml;sser;"), "Grösser");
  assert.equal(cleanValue("GMIG-305P Pulse Function;"), "GMIG-305P Pulse Function");
  assert.equal(cleanValue("IP21;"), "IP21");
  assert.equal(cleanValue("є;"), "є");
  assert.equal(cleanValue("0,8–1,0 мм;"), "0,8–1,0 мм", "десятковий роздільник і діапазон — без змін");
  assert.equal(cleanValue("15W-40; 10W-40; SAE30"), "15W-40; 10W-40; SAE30", "«;» усередині значення — частина змісту");
  assert.equal(cleanValue("&#216; 125 мм &#x2013; 1,6&nbsp;мм; ;"), "Ø 125 мм – 1,6 мм");
  assert.equal(cleanValue("Caf&eacute; &amp; Co &euro;"), "Café & Co €");
  assert.equal(cleanValue("230 В ±10%"), "230 В ±10%");
  assert.equal(cleanValue("3 &frasl; 8"), "3 ⁄ 8", "дріб у дюймах — символ зберігається");
  assert.equal(cleanValue("&unknown; 5"), "&unknown; 5", "невідома сутність — як є");
  // У підсумку: значення з опису очищено; сирі дані постачальника — без змін
  const raw = [P("Модель", "GMIG-305P Pulse Function;")];
  const r = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: raw, current: [], names: catalog.names, mapping: catalog.mappings.get(GRIND), units: catalog.units, mode: "queue", descUa: "<p>Виробник: Gr&ouml;sser;</p>" });
  assert.deepEqual(r.params, [P("Модель", "GMIG-305P Pulse Function"), P("Виробник", "Grösser")]);
  assert.equal(raw[0].value, "GMIG-305P Pulse Function;", "сирі дані не змінено");
  assert.ok(sameValue(P("x", "1.6-5.0 мм"), P("x", "1,6–5 мм"), catalog.names), "«5.0» = «5»");
});

test("мовні дублі (власник, 24.10.2026, реальний тест Grosser GMIG-305P): погоджені пари й пословна відповідність — одна характеристика з українською назвою; значення різні — не зливаємо", () => {
  const names = catalog.names, units = catalog.units, cat = "14400105";
  const B = (ua, ru, rawParams = []) => buildCharacteristics({ schema: S(cat), categoryId: cat, current: [], names, mapping: catalog.mappings.get(cat), units, mode: "queue", rawParams, descUa: ua, descRu: ru });
  // 7 погоджених прикладів власника
  const ex = [["Частота мережі", "50/60 Гц;", "Частота сети", "50/60 Гц;"], ["Діаметр котушки", "200 мм;", "Диаметр катушки", "200 мм;"], ["Типи зварювання", "MIG/MAG, MMA, TIG;", "Типы сварки", "MIG/MAG, MMA, TIG;"],
    ["Робочий цикл (ПВ)", "100%;", "Рабочий цикл (ПВ)", "100%;"], ["Функція Pulse", "є;", "Функция Pulse", "есть;"], ["Діаметр зварювального дроту", "0,8–1,0 мм;", "Диаметр сварочной проволоки", "0,8–1,0 мм;"], ["Вага апарата", "7 кг;", "Вес аппарата", "7 кг;"]];
  const r = B(ex.map(([n, v]) => `<p>${n}: ${v}</p>`).join(""), ex.map(([, , n, v]) => `<p>${n}: ${v}</p>`).join(""));
  assert.deepEqual(r.params.map((p) => `${p.name}: ${p.value}`), ex.map(([n, v]) => `${n}: ${cleanValue(v)}`));
  assert.deepEqual(r.needsReview, []);
  // Пословна відповідність (без окремого погодження): офіційні переклади слів Prom / те саме слово в UA- і RU-написанні
  const w = B("<p>Тип апарата: інверторний</p><p>Цифровий дисплей: є</p><p>Діапазон регулювання струму MMA: 20–305 А</p><p>Вихідна напруга: 15,5–24 В</p>",
    "<p>Тип аппарата: инверторный</p><p>Цифровой дисплей: есть</p><p>Диапазон регулировки тока MMA: 20–305 А</p><p>Выходное напряжение: 15,5–24 В</p>");
  assert.deepEqual(w.params.map((p) => p.name), ["Тип апарата", "Цифровий дисплей", "Діапазон регулювання струму MMA", "Вихідна напруга"]);
  assert.equal(w.lexMerged.length, 3, "«Тип аппарата» — з 24.10.2026 погоджена пара словника (не пословна)");
  // Назви відповідають, значення різні — НЕ зливаємо: обидві окремо + пропозиція (не ховаємо)
  const d = B("<p>Цифровий дисплей: є</p>", "<p>Цифровой дисплей: нет</p>");
  assert.equal(d.params.length, 2, JSON.stringify(d.params));
  assert.deepEqual(d.needsReview, []);
  assert.equal(d.proposals.lexDiff.length, 1);
  // Погоджені власником 24.10.2026 відповідності назв GMIG — одна характеристика за однакових значень
  const g = B("<p>Тип завантаження котушки: бічний</p><p>Номінальний вхідний струм: 30 А</p>", "<p>Тип загрузки катушки: боковой</p><p>Номинальный входящий ток: 30 А</p>");
  assert.deepEqual(g.params, [P("Тип завантаження котушки", "бічний"), P("Номінальний вхідний струм", "30 А")]);
  // Негативні контролі: різні характеристики не зливаються навіть з однаковими числами
  assert.equal(wordsMatch("Біт", "Бот", names), false, "короткі слова (< 4 літер) — лише точно або офіційний переклад");
  for (const [ua, ru] of [["Вага брутто", "Вес"], ["Потужність", "Потребляемая мощность"], ["Частота", "Частота тока"], ["Довжина шини", "Длина кабеля"], ["Максимальна потужність", "Номинальная мощность"]]) assert.equal(wordsMatch(ua, ru, names), false, `${ua} ≠ ${ru}`);
  const n = B("<p>Вага брутто: 7 кг</p><p>Довжина шини: 40 см</p>", "<p>Вес: 7 кг</p><p>Длина кабеля: 40 см</p>");
  assert.ok(n.params.some((p) => p.name === "Вага брутто") && n.params.some((p) => p.name === "Довжина шини") && n.params.some((p) => /кабел/i.test(p.name)));
});

test("еквівалентність значень (власник, 24.10.2026): погоджений перерахунок одиниць, «75 %» = «75%», «1,6–5» = «1.6–5.0»; «62 дБ» ≠ «62 дБ на 7 м»", () => {
  const n = catalog.names;
  for (const [a, b] of [["4,6 кВт", "4600 Вт"], ["1,1 кВт", "1100 Вт"], ["75 %", "75%"], ["1,6–5 мм", "1.6–5.0 мм"], ["3000 Вт / 3 кВт", "3 кВт"], ["0,5 кг", "500 г"], ["2,5 см", "25 мм"]]) {
    assert.ok(sameValue(P("x", a), P("x", b), n), `${a} = ${b}`);
    assert.ok(sameValue(P("x", b), P("x", a), n), `${b} = ${a}`);
  }
  for (const [a, b] of [["62 дБ", "62 дБ на 7 м"], ["50/60 Гц", "50 Гц"], ["1,1 кВт", "1100 В"], ["3000 Вт / 3,5 кВт", "3 кВт"], ["4,6 кВт", "4,6 Вт"], ["220 / 380 В", "220 В"], ["50 Гц", "50 GHz"]]) assert.equal(sameValue(P("x", a), P("x", b), n), false, `${a} ≠ ${b}`);
  // У картці: поле XML «3 кВт» і опис «3000 Вт / 3 кВт» — те саме (без ПОТРЕБУЄ ПЕРЕВІРКИ); «62 дБ на 7 м» — ні
  const r = buildCharacteristics({ schema: S(GEN), categoryId: GEN, current: [], names: n, mapping: catalog.mappings.get(GEN), units: catalog.units, mode: "queue",
    rawParams: [P("Номинальная мощность", "3", "кВт"), P("Уровень шума", "62", "дБ")], descUa: "<p>Номінальна потужність: 3000 Вт / 3 кВт</p><p>Рівень шуму: 62 дБ на 7 м</p>" });
  assert.deepEqual(r.needsReview.map((x) => x.name), ["Рівень шуму"]);
  assert.ok(r.params.some((p) => p.name === "Номінальна потужність" && p.value === "3"));
  // Нормалізація — лише для ТІЄЇ САМОЇ характеристики: різні назви з однаковою величиною не зливаються
  const d = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, current: [], names: n, mapping: catalog.mappings.get(GRIND), units: catalog.units, mode: "queue", descUa: "<p>Вхідна потужність: 1,1 кВт</p><p>Потужність на шпинделі: 1100 Вт</p>" });
  assert.equal(d.params.length, 2, JSON.stringify(d.params));
});

test("GMIG-305P (власник, 24.10.2026): погоджені відповідності НАЗВ; значення — окремо: «боковой» = «бічний» лише для типу завантаження котушки, «принудительное» ≠ «примусове повітряне», тип апарата — повний зміст", () => {
  const names = catalog.names, cat = "14400105";
  const B = (ua, ru, rawParams = []) => buildCharacteristics({ schema: S(cat), categoryId: cat, current: [], names, mapping: catalog.mappings.get(cat), units: catalog.units, mode: "queue", rawParams, descUa: ua, descRu: ru });
  const r = B("<p>Номінальний вхідний струм: 30 А;</p><p>Максимальна вага котушки зі зварювальним дротом: 1 кг;</p><p>Тип завантаження котушки: бічний;</p><p>Тип охолодження: примусове повітряне;</p><p>Тип апарата: інверторний зварювальний напівавтомат;</p>",
    "<p>Номинальный входящий ток: 30 А;</p><p>Максимальный вес катушки со сварочной проволокой: 1 кг;</p><p>Тип загрузки катушки: боковой;</p><p>Тип охлаждения: принудительное;</p><p>Тип аппарата: сварочный инверторный полуавтомат;</p>");
  assert.deepEqual(r.params, [P("Номінальний вхідний струм", "30 А"), P("Максимальна вага котушки зі зварювальним дротом", "1 кг"), P("Тип завантаження котушки", "бічний")]);
  // Справжні розбіжності — ПОТРЕБУЄ ПЕРЕВІРКИ з обома оригіналами, нічого не вибрано
  assert.deepEqual(r.needsReview.map((x) => [x.name, x.values.length]), [["Тип охолодження", 2], ["Тип апарата", 2]]);
  assert.equal(r.ruOnly, 0);
  // «боковой» = «бічний» — лише в контексті типу завантаження котушки
  assert.ok(sameValueIn(["Тип завантаження котушки"], P("x", "боковой"), P("x", "бічний"), names));
  assert.equal(sameValueIn(["Тип кріплення"], P("x", "боковой"), P("x", "бічний"), names), sameValue(P("x", "боковой"), P("x", "бічний"), names));
  // Повний зміст у будь-якому порядку слів: кожне слово має підтверджену пару; «полуавтомат» — без підтвердженого перекладу
  assert.ok(wordsMatchAnyOrder("інверторний зварювальний", "сварочный инверторный", names));
  assert.equal(wordsMatchAnyOrder("інверторний зварювальний напівавтомат", "сварочный инверторный полуавтомат", names), false);
  assert.equal(wordsMatchAnyOrder("інверторний зварювальний", "инверторный", names), false, "різна кількість слів");
  assert.equal(wordsMatchAnyOrder("інверторний інверторний", "сварочный инверторный", names), false, "слово не використовується двічі");
  const t = B("<p>Тип апарата: інверторний зварювальний</p>", "<p>Тип аппарата: сварочный инверторный</p>");
  assert.deepEqual(t.params, [P("Тип апарата", "інверторний зварювальний")]);
});

test("ККД (власник, 24.10.2026): ККД / Коефіцієнт корисної дії / Коэффициент полезного действия — одна характеристика з офіційною українською назвою; різні значення — конфлікт", () => {
  const names = catalog.names;
  const B = (cat, o) => buildCharacteristics({ schema: S(cat), categoryId: cat, current: [], names, mapping: catalog.mappings.get(cat), units: catalog.units, mode: "queue", ...o });
  const g = B("14400105", { rawParams: [P("ККД", "75 %")], descUa: "<p>Коефіцієнт корисної дії (ККД): 75%;</p>", descRu: "<p>Коэффициент полезного действия (КПД): 75%;</p>" });
  assert.deepEqual(g.params, [P("Коефіцієнт корисної дії", "75 %")]);
  assert.deepEqual(g.needsReview, []);
  // Категорія з таким атрибутом Prom (14400101) — одне поле категорії, без користувацького дубля
  const f = B("14400101", { rawParams: [P("ККД", "75 %")], descUa: "<p>Коефіцієнт корисної дії: 75%</p>" });
  assert.equal(f.params.length, 1, JSON.stringify(f.params));
  assert.equal(f.provenance.items[0].a, attrOf("14400101", "Коефіцієнт корисної дії").id);
  // Справді різні значення: UA ≠ RU — ПОТРЕБУЄ ПЕРЕВІРКИ; XML ≠ опис — XML (погоджений пріоритет) + конфлікт
  const d = B("14400105", { descUa: "<p>ККД: 75%</p>", descRu: "<p>Коэффициент полезного действия: 80%</p>" });
  assert.deepEqual(d.params, []);
  assert.equal(d.needsReview[0].kind, "конфлікт");
  const x = B("14400105", { rawParams: [P("ККД", "75 %")], descUa: "<p>Коефіцієнт корисної дії: 80%</p>" });
  assert.deepEqual(x.params, [P("Коефіцієнт корисної дії", "75 %")]);
  assert.ok(x.conflicts.some((c) => /опис суперечить XML/.test(c)));
  // «ККД, не менше» (410201) — інша характеристика
  assert.notEqual(charKey(S("410201"), "ККД, не менше", { mapping: catalog.mappings.get("410201"), names }), charKey(S("410201"), "ККД", { mapping: catalog.mappings.get("410201"), names }));
});

test("фізична сумісність одиниць (власник, 24.10.2026, «50 GHz» у GTM ZJ5132): поле з вадою довідника — користувацька «Частота мережі: 50 Гц»; без підтвердження — ПОТРЕБУЄ ПЕРЕВІРКИ; правильні поля — без змін", () => {
  const names = catalog.names;
  const B = (cat, o) => buildCharacteristics({ schema: S(cat), categoryId: cat, current: [], names, mapping: catalog.mappings.get(cat), units: catalog.units, mode: "queue", ...o });
  for (const cat of ["14209803", "143109"]) {
    const r = B(cat, { rawParams: [P("Частота", "50", "GHz")], descUa: "<p>Частота: 50 Гц</p>", descRu: "<p>Частота: 50 Гц</p>" });
    assert.deepEqual(r.params, [P("Частота мережі", "50 Гц")], cat);
    assert.equal(r.provenance.items[0].a, "", "користувацька, не поле «Частота (GHz)»");
    assert.deepEqual(r.needsReview, []);
    assert.deepEqual(r.rawOnly, [], "XML враховано (замінено підтвердженим значенням з опису)");
    // Лише XML «50 GHz» — число без перерахунку не передається
    const u = B(cat, { rawParams: [P("Частота", "50", "GHz")] });
    assert.deepEqual(u.params, []);
    assert.equal(u.needsReview.length, 1);
    assert.match(u.rawOnly[0].reason, /вада довідника Prom/);
    // Наявний запис «Частота: 50 GHz» у картці (з попередньої синхронізації) — не повертається
    const c = buildCharacteristics({ schema: S(cat), categoryId: cat, current: [P("Частота", "50", "GHz")], names, mapping: catalog.mappings.get(cat), units: catalog.units, mode: "queue", rawParams: [P("Частота", "50", "GHz")], descUa: "<p>Частота: 50 Гц</p>" });
    assert.deepEqual(c.params, [P("Частота мережі", "50 Гц")]);
  }
  // Той самий атрибут 1493 з правильною одиницею (Кущорізи 1250301, «Гц») — поле заповнюється як раніше
  const ok = B("1250301", { rawParams: [P("Частота", "50", "Гц")] });
  assert.deepEqual(ok.params, [P("Частота", "50", "Гц")]);
  assert.equal(ok.provenance.items[0].a, "1493");
  // Загальна перевірка (без відомої вади): те саме число з одиницями різного масштабу в XML і описі — поле не заповнюється
  const sc = B("141002", { rawParams: [P("Частота тока", "50", "Гц")], descUa: "<p>Частота струму: 50 кГц</p>" });
  assert.deepEqual(sc.params, []);
  assert.match(sc.needsReview[0].reason, /одиниці різного масштабу/);
  const w = B(GEN, { rawParams: [P("Номинальная мощность", "3", "кВт")], descUa: "<p>Номінальна потужність: 3 Вт</p>" });
  assert.ok(!w.params.some((p) => p.name === "Номінальна потужність"));
  assert.match(w.rawOnly[0].reason, /одиниці різного масштабу/);
  // Сумісні одиниці — без змін: той самий масштаб або погоджений перерахунок з відповідним числом
  assert.deepEqual(B("141002", { rawParams: [P("Частота тока", "50", "Гц")], descUa: "<p>Частота струму: 50 Гц</p>" }).params, [P("Частота струму", "50", "Гц")]);
  const cv = B(GEN, { rawParams: [P("Номинальная мощность", "3", "кВт")], descUa: "<p>Номінальна потужність: 3000 Вт</p>" });
  assert.ok(cv.params.some((p) => p.name === "Номінальна потужність" && p.value === "3") && cv.needsReview.length === 0);
  // Ризик автоперекладу: позначка для російської користувацької з «ч» (importRisks нічого не змінює)
  const risks = importRisks({ params: [P("Время работы при полной нагрузке", "до 4,1 ч")], provenance: { items: [{ a: "" }] }, categoryId: GEN, knownIssues: catalog.knownIssues });
  assert.deepEqual(risks.map((x) => x.kind), ["ризик автоперекладу Prom"]);
});

test("тривалість у годинах (власник, 24.10.2026, Optimat IE3500: «ч» → «рік»): однозначний український запис одиниці лише для показників тривалості; число не змінюється; сирі дані — без змін", () => {
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 20, 21, 22, 25, 101, 111].map((n) => hoursWord(String(n))), ["година", "години", "години", "годин", "годин", "годин", "годин", "годин", "година", "години", "годин", "година", "годин"]);
  assert.equal(hoursWord("4,1"), "години");
  const H = (name, value, ua, unit = "") => { const r = hoursValue(name, { value, unit }, ua); return r.unit ? `${r.value} ${r.unit}` : r.value; };
  assert.equal(H("Время работы при полной нагрузке", "до 4,1 ч", false), "до 4,1 години");
  assert.equal(H("Час роботи при повному навантаженні", "до 4,1 год", true), "до 4,1 години");
  assert.equal(H("Час роботи залежно від навантаження", "до 5 год за KMA", true), "до 5 годин за KMA");
  assert.equal(H("Час безперервної роботи", "1–1,5 год.", true), "1–1,5 години");
  assert.equal(H("Время зарядки", "21 час", false), "21 година");
  assert.equal(H("Тривалість роботи", "8", true, "год"), "8 годин");
  // Без змін: рос. «год» (= рік), інші показники, інші одиниці, повні слова
  assert.equal(H("Время работы", "2 год", false), "2 год");
  assert.equal(H("Гарантія", "1 год", true), "1 год");
  assert.equal(H("Термін служби", "5 років", true), "5 років");
  assert.equal(H("Витрата палива", "1,2 л/год", true), "1,2 л/год");
  assert.equal(H("Час заряджання", "60 хв", true), "60 хв");
  assert.equal(H("Час роботи", "до 5 годин", true), "до 5 годин");
  assert.equal(H("Частота", "50 Гц", true), "50 Гц");
  // Optimat IE3500: UA- і RU-пари — одна характеристика з українською назвою й однозначною одиницею
  const raw = [P("Время непрерывной работы", "5", "час")];
  const r = buildCharacteristics({ schema: S(GEN), categoryId: GEN, current: [], names: catalog.names, mapping: catalog.mappings.get(GEN), units: catalog.units, mode: "queue", rawParams: raw,
    descUa: "<p>Час роботи при повному навантаженні: до 4,1 год</p><p>Час роботи залежно від навантаження: до 5 год за KMA</p>",
    descRu: "<p>Время работы при полной нагрузке: до 4,1 ч</p><p>Время работы в зависимости от нагрузки: до 5 ч по KMA</p>" });
  assert.deepEqual(r.params, [P("Час безперервної роботи", "5", "годин"), P("Час роботи за повного навантаження", "до 4,1 години"), P("Час роботи залежно від навантаження", "до 5 годин за KMA")]);
  assert.deepEqual(r.needsReview, []);
  assert.ok(r.timeFixed.length >= 4);
  assert.deepEqual(importRisks({ params: r.params, provenance: r.provenance, categoryId: GEN, knownIssues: catalog.knownIssues }), []);
  assert.deepEqual(raw, [P("Время непрерывной работы", "5", "час")], "сирі дані постачальника не змінено");
  // RU-назва без погодженого відповідника — назва як є, одиниця однозначна
  const ru = buildCharacteristics({ schema: S(GEN), categoryId: GEN, current: [], names: catalog.names, mapping: catalog.mappings.get(GEN), units: catalog.units, mode: "queue", descRu: "<p>Время работы на одном баке: 2 ч</p>" });
  assert.deepEqual(ru.params, [P("Время работы на одном баке", "2 години")]);
});

test("значення без змісту (лише невидимі символи «&lrm;&lrm») — не передається на вітрину; примітка; інші — без змін", () => {
  assert.equal(cleanValue("&lrm;&lrm"), "");
  assert.equal(cleanValue("40 мм&lrm;"), "40 мм");
  const r = buildCharacteristics({ schema: S(SAW), categoryId: SAW, current: [], names: catalog.names, mapping: catalog.mappings.get(SAW), units: catalog.units, mode: "queue", descUa: "<p>Глибина розпилу: &lrm;&lrm</p><p>Матеріал: сталь</p>" });
  assert.deepEqual(r.params, [P("Матеріал", "сталь")]);
  assert.ok(r.notes.some((n) => /значення без змісту/.test(n)));
  assert.equal(r.emptyDesc.length, 1);
});

test("перевірка каталогу (24.10.2026): різні слова не збігаються пословно; мовний дубль з іншого джерела — одна характеристика з українською назвою; GHz в описі — не передається", () => {
  const names = catalog.names;
  // «переразряду» ≠ «перезаряду» (подвоєння після вилучення голосних), «перегрева» ≠ «перегрузки» (лише спільне «перегр»)
  assert.equal(wordsMatch("Захист від переразряду", "Захист від перезаряду", names), false);
  assert.equal(wordsMatch("Захист від перерозряду", "Защита от перезаряда", names), false);
  assert.equal(wordsMatch("- от перегрузки", "- от перегрева", names), false);
  assert.equal(wordsMatch("- от перегрева", "- от перегрузки", names), false);
  assert.ok(wordsMatch("Тип апарата", "Тип аппарата", names), "подвоєна літера в оригіналі — те саме слово");
  assert.equal(wordsMatch("Різьба вхідного патрубка", "Різьба вихідного патрубка", names), false, "однаковий кістяк, інше місце голосних — різні слова");
  assert.ok(wordsMatch("Вихідна напруга", "Выходное напряжение", names), "інше закінчення — те саме слово");
  const B = (cat, o) => buildCharacteristics({ schema: S(cat), categoryId: cat, current: [], names, mapping: catalog.mappings.get(cat), units: catalog.units, mode: "queue", ...o });
  // XML з російською назвою + UA-опис з тим самим значенням — одна, українською
  const x = B(GRIND, { rawParams: [P("Функция", "Функция 2в1")], descUa: "<p>Функція: Функція 2в1</p>" });
  assert.deepEqual(x.params, [P("Функція", "Функція 2в1")]);
  assert.equal(x.lexMerged.filter((m) => m.cross).length, 1);
  // Різні значення — обидві (не вибираємо)
  assert.equal(B(GRIND, { rawParams: [P("Функция", "Функция 2в1")], descUa: "<p>Функція: Функція 3в1</p>" }).params.length, 2);
  // Пари одного опису між собою не зливаються (постачальник перелічив різні характеристики)
  assert.equal(B(GRIND, { descUa: "<p>Захист від переразряду: Є</p><p>Захист від перезаряду: Є</p>" }).params.length, 2);
  // GHz у самому описі для поля з вадою довідника — ПОТРЕБУЄ ПЕРЕВІРКИ, не передається
  const g = B("143109", { descUa: "<p>Частота: 50 GHz</p>", descRu: "<p>Частота: 50 GHz</p>" });
  assert.deepEqual(g.params, []);
  assert.match(g.needsReview[0].reason, /вадою довідника/);
  // Українська назва без і/ї/є/ґ («Час заряджання») — «год» = година
  assert.deepEqual(B(GRIND, { rawParams: [P("Час заряджання", "3 год")] }).params, [P("Час заряджання", "3 години")]);
  assert.deepEqual(B(GRIND, { rawParams: [P("Максимальное время работы", "5 год")] }).params, [P("Максимальное время работы", "5 год")], "рос. «год» — без підтвердження годин не змінюється");
});

test("захисні випадки (мутаційна перевірка 24.10.2026): те саме число з несумісною одиницею — не дубль; «75 %» у тексті; вада довідника — лише те саме число; пари одного опису між собою не зливаються", () => {
  const names = catalog.names;
  const B = (cat, o) => buildCharacteristics({ schema: S(cat), categoryId: cat, current: [], names, mapping: catalog.mappings.get(cat), units: catalog.units, mode: "queue", ...o });
  // Поле «Частота струму: 50 Гц» і користувацька з тим самим ключем «50 кГц» — не той самий запис (ПОТРЕБУЄ ПЕРЕВІРКИ)
  const f = B(GEN, { rawParams: [P("Частота тока", "50", "Гц"), P("Частота струму", "50", "кГц")] });
  assert.deepEqual(f.params, [P("Частота струму", "50", "Гц")]);
  assert.equal(f.needsReview.length, 1);
  assert.ok(sameValue(P("x", "ККД 75 % при 220 В"), P("x", "ККД 75% при 220 В"), names));
  // Вада довідника: опис з ІНШИМ числом не замінює значення XML
  const g = B("14209803", { rawParams: [P("Частота", "50", "GHz")], descUa: "<p>Частота: 60 Гц</p>" });
  assert.ok(!g.params.some((p) => /50/.test(p.value)), JSON.stringify(g.params));
  assert.ok(g.needsReview.some((x) => /вадою довідника/.test(x.reason)));
  // Пари одного опису між собою (той самий запис іншим відмінком) — постачальник перелічив сам, не зливаємо
  assert.equal(B(GRIND, { descUa: "<p>Діаметр диска: 230 мм</p><p>Діаметр диску: 230 мм</p>" }).params.length, 2);
  // Кістяк — лише для слів різних мов: «оборотів» / «оборотов» — те саме; «вхідного» / «вихідного» — ні
  assert.ok(wordsMatch("Число оборотів", "Число оборотов", names));
  assert.ok(wordsMatch("Боковий викид", "Боковой выброс", names));
  assert.ok(wordsMatch("Мініімальна довжина", "Мінімальна довжина", names), "подвоєна літера (помилка набору)");
  assert.ok(wordsMatch("Потужність, Ват", "Мощность, Ватт", names), "подвоєна літера в короткому слові");
});
