/** Характеристики Prom (погоджено власником 23.10.2026): схеми категорій, перевірка значень, перенесення з XML і опису,
 *  збереження ручних виправлень, зміна категорії. Схеми — справжні файли з schemas/prom (жодних вигаданих атрибутів). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { categoryBlocks, parseSchemaText } from "../src/core/prom-schema.mjs";
import { SRC, buildCharacteristics, cleanDescription, descriptionPairs, mapParam, validateValue } from "../src/core/prom-attributes.mjs";
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

test("типи: real / integer / bool / singleselect — точна перевірка значення, одиниці, діапазону; multiselect і невідоме — не заповнюються", () => {
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
  assert.match(validateValue(attrOf(GRIND, "Оброблювана поверхня"), "По дереву", "").reason, /формат передачі в YML не підтверджено/);
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

test("основний каталог, перше застосування схеми: перекладені вручну назви підтверджено як XML; невизначене збережено й позначено; нове підтверджене поле додано", () => {
  const raw = [P("Питание", "Сеть 220В"), P("Гарантия", "36 мес."), P("Вес", "2,2", "кг"), P("Состояние", "Новый"), P("Колір", "синій")];
  const current = [P("Гарантия", "36 мес."), P("Живлення", "Мережа 220В"), P("Тип шліфмашини", "Болгарка")]; // підготовлено раніше (CODEX/CLAUDE)
  const r = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: raw, current, mode: "main" });
  assert.deepEqual(r.params, [P("Гарантия", "36 мес."), P("Живлення", "Мережа 220В"), P("Тип шліфмашини", "Болгарка"), P("Вага", "2.2", "кг")],
    "незіставлені сирі («Состояние», «Колір») не додаються, поки є запис невизначеного походження — щоб не задублювати підготовлене");
  const by = Object.fromEntries(r.provenance.items.map((i) => [i.k.split("\u0001")[0], i.s]));
  assert.equal(by["Живлення"], SRC.XML);
  assert.equal(by["Гарантия"], SRC.RAW);
  assert.equal(by["Тип шліфмашини"], SRC.UNKNOWN, "походження не визначено — збережено");
  assert.equal(by["Вага"], SRC.XML);
  assert.match(r.notes.join(" "), /походження 1 характеристик не визначено/);
  // Постачальник змінив живлення → підтверджене поле оновлено автоматично; невизначене — без змін
  const r2 = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Питание", "Аккумулятор"), P("Гарантия", "24 мес."), P("Вес", "2,2", "кг"), P("Состояние", "Новый"), P("Колір", "синій")], current: r.params, provenance: r.provenance, mode: "main" });
  assert.deepEqual(r2.params, [P("Гарантия", "24 мес."), P("Живлення", "Акумулятор"), P("Тип шліфмашини", "Болгарка"), P("Вага", "2.2", "кг")]);
  // Ідемпотентність
  const r3 = buildCharacteristics({ schema: S(GRIND), categoryId: GRIND, rawParams: [P("Питание", "Аккумулятор"), P("Гарантия", "24 мес."), P("Вес", "2,2", "кг"), P("Состояние", "Новый"), P("Колір", "синій")], current: r2.params, provenance: r2.provenance, mode: "main" });
  assert.equal(r3.changed, false);
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

test("опис постачальника (приклад власника): переноситься лише підтверджене схемою; решта лишається в описі; конфлікт з XML — береться XML", () => {
  const desc = "<p>Виробник: Zegor<br>Напруга: 220 В<br>Розмір: 56 × 60 см<br>Має тепло нагрів: так</p><p>Опис товару.</p>";
  assert.deepEqual(descriptionPairs(desc).map((p) => p.key), ["Виробник", "Напруга", "Розмір", "Має тепло нагрів"]);
  const r = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [], descUa: desc, current: [], mode: "queue" });
  assert.deepEqual(r.params, [P("Напруга", "220", "В")]);
  assert.equal(r.provenance.items[0].s, SRC.DESC);
  const cleaned = cleanDescription(desc, r.descRanges.ua);
  assert.equal(cleaned, "<p>Виробник: Zegor<br>Розмір: 56 × 60 см<br>Має тепло нагрів: так</p><p>Опис товару.</p>", "прибрано лише перенесений фрагмент");
  // Таблиця з двома клітинками
  const table = "<table><tr><td>Напруга</td><td>230 В</td></tr><tr><td>Має тепло нагрів</td><td>так</td></tr></table><p>Текст</p>";
  const t = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [], descUa: table, current: [], mode: "queue" });
  assert.deepEqual(t.params, [P("Напруга", "230", "В")]);
  assert.equal(cleanDescription(table, t.descRanges.ua), "<table><tr><td>Має тепло нагрів</td><td>так</td></tr></table><p>Текст</p>");
  // XML і опис суперечать — XML; фрагмент опису не прибирається
  const c = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [P("Напряжение", "230", "В")], descUa: desc, current: [], mode: "queue" });
  assert.deepEqual(c.params, [P("Напруга", "230", "В")]);
  assert.match(c.conflicts.join(" "), /опис суперечить XML для «Напруга» — взято XML/);
  assert.deepEqual(c.descRanges.ua, []);
  // Два різні значення в описі — неоднозначно, поле не заповнюється
  const d = buildCharacteristics({ schema: S(GEN), categoryId: GEN, rawParams: [], descUa: "<p>Напруга: 220 В</p><p>Напруга: 380 В</p>", current: [], mode: "queue" });
  assert.deepEqual(d.params, []);
  assert.deepEqual(d.ambiguous, ["2474"]);
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
