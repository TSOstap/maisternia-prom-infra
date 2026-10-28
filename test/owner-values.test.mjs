/** Підтверджені рішення власника щодо окремих характеристик (власник, 26.10.2026): пріоритет над XML і описом, рішення щодо
 *  однієї характеристики не блокує решти, розбіжність постачальника — інформаційно, автооновлення, звірка моделі, файл поза
 *  репозиторієм, план очищення застарілих значень у Prom. Схеми — справжні файли з schemas/prom; товари й значення — синтетичні. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SRC, buildCharacteristics } from "../src/core/prom-attributes.mjs";
import { ACTION, planStaleCleanup } from "../src/core/prom-cleanup.mjs";
import { loadOwnerValues, loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";
import { STATE_A } from "./helpers/state-a.mjs";

const catalog = loadPromCatalog(undefined, STATE_A);
const P = (name, value, unit = "") => ({ name, value, unit });
const B = (cat, o) => buildCharacteristics({ schema: catalog.schemas.get(cat), categoryId: cat, current: [], names: catalog.names, mapping: catalog.mappings.get(cat), units: catalog.units, mode: "main", ...o });
const OV = (o) => ({ action: "set", source: "тест", date: "2026-10-26", priority: 1, autoUpdate: false, ...o });
const has = (r, name, value, unit = "") => r.params.some((p) => p.name === name && p.value === value && (p.unit || "") === unit);
const src = (r, name) => r.provenance.items[r.params.findIndex((p) => p.name === name)]?.s;
const WELD = "14400101", MITER = "14172702", CROWN = "14201508", SAW = "1250302", MOWER = "1250308";

test("рішення власника → поле Prom замість XML; решта характеристик — як звичайно; відоме значення постачальника — без позначки", () => {
  const r = B(SAW, { rawParams: [P("Состояние", "Б/У"), P("Тип двигателя", "Бесщеточный"), P("Питание", "Аккумулятор")], ownerValues: [OV({ name: "Стан", value: "Новий", supplier: ["Вживаний"] })] });
  assert.ok(has(r, "Стан", "Новий"), JSON.stringify(r.params));
  assert.equal(src(r, "Стан"), SRC.OWNER);
  assert.ok(!has(r, "Стан", "Вживаний"));
  assert.ok(has(r, "Тип двигуна", "Безщітковий") && has(r, "Живлення", "Акумулятор"), "інші характеристики — без змін");
  assert.deepEqual(r.needsReview, []);
  assert.match(r.rawOnly.find((x) => x.name === "Состояние").reason, /рішенням власника/);
  assert.deepEqual([r.owner[0].applied, r.owner[0].target], [true, "поле 10006"]);
});

test("постачальник пізніше змінив значення: рішення не перезаписується (позначка інформаційна); autoUpdate=true — нове значення постачальника", () => {
  const ov = OV({ name: "Фактичний зварювальний струм", field: "6977", value: "120", unit: "А", supplier: ["300 А"] });
  const known = B(WELD, { rawParams: [P("Максимальный сварочный ток", "300", "А"), P("Минимальный сварочный ток", "20", "А")], ownerValues: [ov] });
  assert.ok(has(known, "Максимальний зварювальний струм", "120", "А"), JSON.stringify(known.params));
  assert.ok(!known.params.some((p) => p.value === "300"), "300 з назви моделі не повертається");
  assert.ok(has(known, "Мінімальний зварювальний струм", "20", "А"), "інше поле — з XML");
  assert.deepEqual(known.needsReview, []);
  const changed = B(WELD, { rawParams: [P("Максимальный сварочный ток", "250", "А")], ownerValues: [ov] });
  assert.ok(has(changed, "Максимальний зварювальний струм", "120", "А"));
  assert.deepEqual(changed.needsReview.map((x) => x.kind), ["інформаційно"]);
  assert.match(changed.needsReview[0].reason, /передано підтверджене рішення власника/);
  const auto = B(WELD, { rawParams: [P("Максимальный сварочный ток", "250", "А")], ownerValues: [{ ...ov, autoUpdate: true }] });
  assert.ok(has(auto, "Максимальний зварювальний струм", "250", "А"));
  assert.deepEqual(auto.needsReview.map((x) => x.kind), ["інформаційно"]);
  assert.equal(auto.owner[0].applied, false);
  assert.ok(has(B(WELD, { rawParams: [P("Максимальный сварочный ток", "300", "А")], ownerValues: [{ ...ov, autoUpdate: true }] }), "Максимальний зварювальний струм", "120", "А"), "відоме значення постачальника — рішення діє");
});

test("значення не проходить поле — користувацька з назвою власника; поле постачальника (replaces) не заповнюється; конфлікт UA / RU вирішено", () => {
  const r = B(WELD, { rawParams: [P("Напряжение питания", "220 В"), P("Вес", "4.5", "кг")], descUa: "<p>Живлення: Від електричної мережі</p>", descRu: "<p>Питание: От электрической сети</p>", ownerValues: [OV({ name: "Живлення", value: "230 В", replaces: ["Напруга живлення"], supplier: ["220 В", "Від електричної мережі", "От электрической сети"] })] });
  assert.ok(has(r, "Живлення", "230 В"), JSON.stringify(r.params));
  assert.equal(src(r, "Живлення"), SRC.OWNER);
  assert.ok(!r.params.some((p) => p.name === "Напруга живлення" || p.name === "Питание" || /електричної/.test(p.value)), JSON.stringify(r.params));
  assert.ok(has(r, "Вага", "4.5", "кг"));
  assert.deepEqual(r.needsReview, [], "конфлікт UA / RU вирішено рішенням власника");
  assert.equal(r.owner[0].target, "користувацька");
});

test("«не передавати» (drop): значення постачальника UA і RU не передається; інший вид потужності не змінюється («не змішувати»)", () => {
  const r = B(MITER, {
    descUa: "<p>Номінальна потужність: 1800 Вт.</p><p>Споживана потужність: 1800 Вт</p><p>Потужність двигуна: 2000 Вт</p>",
    descRu: "<p>Номинальная мощность: 1800 Вт.</p><p>Потребляемая мощность: 1800 Вт</p><p>Мощность двигателя: 2000 Вт</p>",
    ownerValues: [OV({ name: "Споживана потужність", value: "3000", unit: "Вт", supplier: ["1800 Вт"] }), OV({ name: "Номінальна потужність", action: "drop", replaces: ["Номинальная мощность"], supplier: ["1800 Вт."] })],
  });
  assert.ok(has(r, "Споживана потужність", "3000", "Вт"), JSON.stringify(r.params));
  assert.ok(!r.params.some((p) => /1800/.test(p.value)), JSON.stringify(r.params));
  assert.ok(r.params.some((p) => /потужність двигуна/i.test(p.name) && /2000/.test(p.value)), "інший вид потужності — як у постачальника");
  assert.deepEqual(r.needsReview, []);
  assert.deepEqual(r.owner.map((o) => [o.applied, o.target]), [[true, "поле 4"], [true, "не передається"]]);
});

test("replaces: інша назва постачальника (UA / RU) — замінено; повний діапазон обертів не скорочується до одного числа", () => {
  const r = B(CROWN, {
    descUa: "<p>Робоча швидкість, об/хв: 8000-11000</p><p>Посадковий отвір: M14</p><p>Діаметр, мм: 25/40/60/70</p>",
    descRu: "<p>Рабочая скорость, об/мин: 8000-11000</p><p>Посадочное отверстие: M14</p><p>Диаметр, мм: 25/40/60/70</p>",
    ownerValues: [OV({ name: "Робоча швидкість", value: "10 000–14 000", unit: "об/хв", replaces: ["Робоча швидкість, об/хв", "Рабочая скорость, об/мин"], supplier: ["8000-11000"] }), OV({ name: "З'єднання", value: "M14", replaces: ["Посадковий отвір", "Посадочное отверстие"], supplier: ["M14"] })],
  });
  assert.ok(has(r, "Робоча швидкість", "10 000–14 000", "об/хв"), JSON.stringify(r.params));
  assert.ok(has(r, "З'єднання", "M14"));
  assert.ok(!r.params.some((p) => /8000/.test(p.value) || /Посадков|Посадочн|Рабочая/.test(p.name)), JSON.stringify(r.params));
  assert.ok(r.params.some((p) => /^Діаметр/.test(p.name) && p.value === "25/40/60/70"), "інші характеристики опису — як звичайно");
  assert.deepEqual(r.needsReview, []);
});

test("наявне значення картки тієї самої характеристики не повертається; повторна синхронізація стабільна; рішення прибрано — знову дані постачальника", () => {
  const ov = [OV({ name: "Стан", value: "Новий", supplier: ["Вживаний"] })];
  const raw = [P("Состояние", "Б/У"), P("Питание", "Аккумулятор")];
  const r1 = B(SAW, { rawParams: raw, current: [P("Стан", "Вживаний"), P("Живлення", "Акумулятор")], ownerValues: ov });
  assert.deepEqual(r1.params.filter((p) => p.name === "Стан"), [P("Стан", "Новий")]);
  assert.equal(r1.params.findIndex((p) => p.name === "Стан"), 0, "на місці наявного запису");
  assert.deepEqual(r1.needsReview, [], "наявне = відоме значення постачальника");
  const r2 = B(SAW, { rawParams: raw, current: r1.params, provenance: r1.provenance, ownerValues: ov });
  assert.deepEqual(r2.params, r1.params);
  assert.equal(r2.changed, false);
  assert.equal(src(r2, "Стан"), SRC.OWNER);
  const r3 = B(SAW, { rawParams: raw, current: r2.params, provenance: r2.provenance, ownerValues: null });
  assert.ok(has(r3, "Стан", "Вживаний"), "без рішення — дані постачальника");
  assert.ok(r3.notes.some((n) => /рішення власника для цієї характеристики більше немає/.test(n)));
  // наявне значення, якого постачальник на момент рішення не передавав, — інформаційна позначка
  const r4 = B(SAW, { rawParams: raw, current: [P("Стан", "Б/в")], ownerValues: ov });
  assert.ok(has(r4, "Стан", "Новий"));
  assert.deepEqual(r4.needsReview.map((x) => [x.kind, /наявне значення картки/.test(x.reason)]), [["інформаційно", true]]);
});

test("ручна правка картки (ВРУЧНУ) інша, ніж рішення власника, — передано рішення, позначка для перевірки (не інформаційна); інші ручні — без змін", () => {
  const r = B(SAW, { rawParams: [P("Состояние", "Б/У")], current: [P("Стан", "Вживаний"), P("Моя примітка", "x")], provenance: { v: 1, cat: SAW, items: [], x: [] }, ownerValues: [OV({ name: "Стан", value: "Новий", supplier: ["Вживаний"] })] });
  assert.ok(has(r, "Стан", "Новий") && has(r, "Моя примітка", "x"), JSON.stringify(r.params));
  const rv = r.needsReview.find((x) => /ручна правка картки/.test(x.reason));
  assert.ok(rv && rv.kind !== "інформаційно", JSON.stringify(r.needsReview));
});

test("звірка моделі: модель не знайдено в назві товару — рішення не застосовується; «LXCM305» ≠ «LXCM305i»; назва картки теж враховується", () => {
  const ov = { model: "RCS 20/12TK", items: [OV({ name: "Стан", value: "Новий" })] };
  assert.ok(has(B(SAW, { rawParams: [P("Состояние", "Б/У")], titles: ["Пила Riker RCS 20/12TK: без АКБ"], ownerValues: ov }), "Стан", "Новий"));
  const wrong = B(SAW, { rawParams: [P("Состояние", "Б/У")], titles: ["Пила Riker RCS 20/14TK"], cardTitles: ["Пила Riker RCS 20/14TK"], ownerValues: ov });
  assert.ok(has(wrong, "Стан", "Вживаний"));
  assert.match(wrong.needsReview[0].reason, /модель «RCS 20\/12TK» не знайдено/);
  assert.equal(wrong.owner[0].applied, false);
  const lx = { model: "LXCM305", items: [OV({ name: "Стан", value: "Новий" })] };
  assert.ok(has(B(SAW, { rawParams: [P("Состояние", "Б/У")], titles: ["Пила LEX LXCM305i: 1800 Вт"], cardTitles: ["Пила LEX LXCM305, 3000 Вт"], ownerValues: lx }), "Стан", "Новий"));
  assert.ok(has(B(SAW, { rawParams: [P("Состояние", "Б/У")], titles: ["Пила LEX LXCM305i: 1800 Вт"], ownerValues: lx }), "Стан", "Вживаний"));
});

test("пріоритет: 2 — значення власника лише без значення XML; 3 — лише коли постачальник нічого не передає; два рішення однієї характеристики — діє вищий пріоритет", () => {
  const base = OV({ name: "Стан", value: "Новий" });
  assert.ok(has(B(SAW, { rawParams: [P("Состояние", "Б/У")], ownerValues: [{ ...base, priority: 2 }] }), "Стан", "Вживаний"), "2: є XML — XML");
  assert.ok(has(B(SAW, { descUa: "<p>Стан: Вживаний</p>", ownerValues: [{ ...base, priority: 2 }] }), "Стан", "Новий"), "2: лише опис — власник");
  assert.ok(has(B(SAW, { descUa: "<p>Стан: Вживаний</p>", ownerValues: [{ ...base, priority: 3 }] }), "Стан", "Вживаний"), "3: є опис — постачальник");
  assert.ok(has(B(SAW, { rawParams: [P("Питание", "Аккумулятор")], ownerValues: [{ ...base, priority: 3 }] }), "Стан", "Новий"), "3: постачальник не передає — власник");
  const two = B(SAW, { rawParams: [P("Состояние", "Б/У")], ownerValues: [{ ...base, value: "Вживаний", priority: 2 }, base] });
  assert.ok(has(two, "Стан", "Новий"));
  assert.match(two.owner.find((o) => !o.applied).why, /вищим пріоритетом/);
});

test("помилковий запис (поля немає в схемі) не застосовується — решта рішень діє; без схеми категорії рішення не застосовується", () => {
  const r = B(SAW, { rawParams: [P("Состояние", "Б/У"), P("Питание", "Аккумулятор")], ownerValues: [OV({ name: "Х", field: "999999", value: "1" }), OV({ name: "Стан", value: "Новий" })] });
  assert.ok(has(r, "Стан", "Новий") && has(r, "Живлення", "Акумулятор"));
  assert.deepEqual([r.owner[0].applied, /немає в схемі/.test(r.owner[0].why)], [false, true]);
  const n = buildCharacteristics({ schema: null, categoryId: "999", current: [P("Стан", "Вживаний")], mode: "main", ownerValues: [OV({ name: "Стан", value: "Новий" })] });
  assert.deepEqual(n.params, [P("Стан", "Вживаний")]);
  assert.ok(n.notes.some((x) => /рішення власника не застосовано: немає схеми/.test(x)));
});

test("файл рішень власника (поза репозиторієм): формат, перевірка кожного запису, змінна MM_OWNER_VALUES / параметр loadPromCatalog", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-values-"));
  const file = path.join(dir, "owner-values.json");
  fs.writeFileSync(file, JSON.stringify({ v: 1, date: "2026-10-26", products: {
    "111": { model: "TEST-1", items: [OV({ name: "Стан", value: "Новий" }), { name: "Без джерела", value: "1", date: "2026-10-26" }, OV({ name: "Пріоритет", value: "1", priority: 5 }), OV({ name: "Дія", value: "1", action: "change" })] },
    "222": { items: [OV({ name: "Номінальна потужність", action: "drop", supplier: ["1800 Вт"] })] },
    "x": { items: [] },
  } }));
  const ov = loadOwnerValues(file);
  assert.deepEqual([...ov.map.keys()], ["111", "222"]);
  assert.equal(ov.items, 2);
  assert.equal(ov.map.get("111").model, "TEST-1");
  assert.deepEqual(ov.map.get("111").items.map((o) => [o.name, o.action, o.priority, o.autoUpdate]), [["Стан", "set", 1, false]]);
  assert.equal(ov.problems.length, 4, ov.problems.join("; "));
  assert.ok(ov.problems.some((p) => /№2: неправильне source/.test(p)) && ov.problems.some((p) => /priority/.test(p)) && ov.problems.some((p) => /action/.test(p)));
  const c = loadPromCatalog(undefined, { ownerValuesFile: file });
  assert.equal(c.ownerValues.get("222").items[0].action, "drop");
  assert.deepEqual(c.ownerValuesInfo, { file: "owner-values.json", date: "2026-10-26", products: 2, items: 2 });
  assert.equal(c.problems.filter((p) => /№\d+: неправильне|немає items/.test(p)).length, 4, c.problems.join("; "));
  assert.ok(c.problems.some((p) => /немає в переліку репозиторію/.test(p)) && c.problems.some((p) => /характеристику утримано/.test(p)), "звірка з переліком рішень у репозиторії");
  assert.equal(loadPromCatalog(undefined, { ownerValuesFile: "" }).ownerValues, null, "без файлу — рішень немає");
  assert.match(loadOwnerValues(path.join(dir, "немає.json")).problems[0], /не знайдено/);
  fs.writeFileSync(file, "{ зламаний");
  assert.match(loadOwnerValues(file).problems[0], /некоректний JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("синхронізація основного каталогу передає рішення власника за Offer ID; інший Offer ID — ні", async () => {
  const { refreshMainRow } = await import("../src/core/sheet-sync.mjs");
  const cat = { ...catalog, ownerValues: new Map([["77", { model: "", items: [OV({ name: "Стан", value: "Новий", supplier: ["Вживаний"] })] }]]) };
  const run = (id) => {
    const row = { "Offer ID": id, "ID постачальника": id, "Категорія Prom ID": SAW, "Виробник": "Test", "Характеристики JSON": "[]", "Назва постачальника UA": "Пила тестова", "Назва постачальника RU": "" };
    const offer = { id, vendor: "Test", sku: "", nameUa: "Пила тестова", nameRu: "", price: 100, available: true, currency: "UAH" };
    return JSON.parse(refreshMainRow(row, offer, { params: [P("Состояние", "Б/У")], pictures: [], descriptionUa: "", descriptionRu: "" }, { stamp: "2026-10-26T10:00:00.000Z", catalog: cat }).row["Характеристики JSON"]);
  };
  assert.deepEqual(run("77").filter((p) => p.name === "Стан"), [P("Стан", "Новий")]);
  assert.deepEqual(run("78").filter((p) => p.name === "Стан"), [P("Стан", "Вживаний")]);
  // перелік рішень є, файлу рішень немає — синхронізація утримує характеристику (значення постачальника не передає)
  cat.ownerIndex = new Map([["79", { model: "", items: [{ name: "Стан" }] }]]);
  assert.deepEqual(run("79").filter((p) => p.name === "Стан"), []);
  assert.deepEqual(run("78").filter((p) => p.name === "Стан"), [P("Стан", "Вживаний")], "інших товарів не стосується");
  // перелік рішень є, файлу рішень немає — синхронізація утримує характеристику (значення постачальника не передає)
  const held = { ...catalog, ownerValues: null, ownerIndex: new Map([["79", { model: "", items: [{ name: "Стан" }] }]]) };
  const row = { "Offer ID": "79", "ID постачальника": "79", "Категорія Prom ID": SAW, "Виробник": "Test", "Характеристики JSON": "[]", "Назва постачальника UA": "Пила тестова", "Назва постачальника RU": "" };
  const offer = { id: "79", vendor: "Test", sku: "", nameUa: "Пила тестова", nameRu: "", price: 100, available: true, currency: "UAH" };
  const out = JSON.parse(refreshMainRow(row, offer, { params: [P("Состояние", "Б/У"), P("Питание", "Аккумулятор")], pictures: [], descriptionUa: "", descriptionRu: "" }, { stamp: "2026-10-26T10:00:00.000Z", catalog: held }).row["Характеристики JSON"]);
  assert.ok(!out.some((p) => p.name === "Стан") && out.some((p) => p.name === "Живлення"), JSON.stringify(out));
});

test("комплектація, підтверджена власником, і власний перелік постачальника «Комплектація» — «у комплекті: Ні» не губиться (GTM, 26.10.2026)", () => {
  const kit = { titles: ["Газонокосарка акумуляторна 2×18 В без АКБ"], descUa: "<p>Комплектація: Картонна упаковка</p>", descRu: "<p>Комплектация: Картонная упаковка</p>" };
  const m = B(MOWER, { ...kit, kitOwner: { battery: false, charger: false } });
  assert.ok(has(m, "Комплектація", "Картонна упаковка"), JSON.stringify(m.params));
  assert.ok(has(m, "Акумулятор у комплекті", "Ні") && has(m, "Зарядний пристрій у комплекті", "Ні"), JSON.stringify(m.params));
  assert.ok(!m.params.some((p) => /у комплекті/.test(p.name) && p.value === "Так"));
  const n = B(MOWER, kit);
  assert.ok(!n.params.some((p) => /у комплекті/.test(p.name)), "без рішення власника — лише перелік постачальника");
});

test("план очищення Prom: характеристика під рішенням власника, якої немає в новому наборі, — застаріле значення (ВИДАЛИТИ); поле нового набору оновить імпорт", () => {
  const r = B(WELD, { rawParams: [P("Напряжение питания", "220 В"), P("Максимальный сварочный ток", "300", "А")], ownerValues: [OV({ name: "Живлення", value: "230 В", replaces: ["Напруга живлення"], supplier: ["220 В"] }), OV({ name: "Фактичний зварювальний струм", field: "6977", value: "120", unit: "А", supplier: ["300 А"] })] });
  const opt = { schema: catalog.schemas.get(WELD), mapping: catalog.mappings.get(WELD), names: catalog.names, units: catalog.units };
  const prom = [P("Напруга живлення", "220 В"), P("Максимальний зварювальний струм", "300", "А"), P("Живлення", "230 В")];
  const a = Object.fromEntries(planStaleCleanup({ prom, prepared: r.params, items: r.provenance.items, owner: r.owner, ...opt }).rows.map((x) => [x.name, x.action]));
  assert.deepEqual(a, { "Напруга живлення": ACTION.REMOVE, "Максимальний зварювальний струм": ACTION.KEEP, "Живлення": ACTION.KEEP });
  const before = planStaleCleanup({ prom: prom.slice(0, 1), prepared: r.params, items: r.provenance.items, ...opt });
  assert.notEqual(before.rows[0].action, ACTION.REMOVE, "без рішення власника — не видаляється");
});

test("ліміт Prom 70 користувацьких — рішення власника має пріоритет; поле з відомою вадою довідника не заповнюється й рішенням власника", () => {
  const descUa = Array.from({ length: 75 }, (_, i) => `<p>Параметр ${i + 1}: значення ${i + 1}</p>`).join("");
  const r = B(SAW, { descUa, ownerValues: [OV({ name: "Сумісний інструмент", value: "УШМ" })] });
  assert.ok(has(r, "Сумісний інструмент", "УШМ"));
  assert.equal(r.provenance.items.filter((i) => !i.a).length, 70);
  assert.equal(r.overflow.length, 6);
  assert.ok(!r.overflow.some((o) => o.name === "Сумісний інструмент"));
  const g = B("14209803", { ownerValues: [OV({ name: "Частота", field: "1493", value: "50", unit: "GHz" })] });
  assert.ok(!g.provenance.items.some((i) => i.a === "1493"), JSON.stringify(g.params));
  assert.ok(has(g, "Частота", "50", "GHz"), "користувацька з назвою власника");
});

test("синхронізація таблиці зі схемами, але без файлу рішень власника, — попередження (не блокує); з файлом — без попередження", async () => {
  const { WatchSim } = await import("./helpers/watch-sim.mjs");
  const none = new WatchSim({ catalog: { ...catalog, ownerValues: null } });
  const r = await none.start();
  assert.ok(r.warnings.some((w) => /рішення власника щодо характеристик не підключено.*характеристики \d+ товарів з переліку рішень утримано/.test(w)), JSON.stringify(r.warnings));
  const own = new WatchSim({ catalog: { ...catalog, ownerValues: new Map() } });
  const r2 = await own.start();
  assert.ok(!r2.warnings.some((w) => /рішення власника/.test(w)), JSON.stringify(r2.warnings));
});

test("файл рішень відсутній / пошкоджений / без запису — характеристики з переліку утримано: значення постачальника не повертається, наявне значення картки збережено, позначка не інформаційна", () => {
  const idx = { model: "", items: [{ name: "Стан" }, { name: "Номінальна потужність", replaces: ["Номинальная мощность"] }] };
  // без файлу: «Стан: Вживаний» з XML не передається; наявного значення немає — характеристики немає
  const r = B(SAW, { rawParams: [P("Состояние", "Б/У"), P("Питание", "Аккумулятор")], ownerIndex: idx });
  assert.ok(!r.params.some((p) => p.name === "Стан"), JSON.stringify(r.params));
  assert.ok(has(r, "Живлення", "Акумулятор"), "інші характеристики — як звичайно");
  const rv = r.needsReview.filter((x) => /рішення власника недоступне/.test(x.reason));
  assert.equal(rv.length, 2);
  assert.ok(rv.every((x) => x.kind !== "інформаційно"));
  assert.match(r.rawOnly.find((x) => x.name === "Состояние").reason, /утримано/);
  assert.deepEqual(r.owner.map((o) => [o.name, o.action, o.applied]), [["Стан", "hold", false], ["Номінальна потужність", "hold", false]]);
  // наявне значення картки (рішення власника з попереднього запуску) — без змін
  const prev = B(SAW, { rawParams: [P("Состояние", "Б/У")], ownerValues: [OV({ name: "Стан", value: "Новий", supplier: ["Вживаний"] })], ownerIndex: idx });
  const held = B(SAW, { rawParams: [P("Состояние", "Б/У")], current: prev.params, provenance: prev.provenance, ownerIndex: idx });
  assert.deepEqual(held.params.filter((p) => p.name === "Стан"), [P("Стан", "Новий")]);
  assert.equal(held.provenance.items[held.params.findIndex((p) => p.name === "Стан")].s, SRC.OWNER);
  // «не передавати» без файлу — значення постачальника теж не повертається
  const d = B(MITER, { descUa: "<p>Номінальна потужність: 1800 Вт.</p>", descRu: "<p>Номинальная мощность: 1800 Вт.</p>", ownerIndex: idx });
  assert.ok(!d.params.some((p) => /1800/.test(p.value)), JSON.stringify(d.params));
  // файл є, але без одного запису — цей утримано, інший застосовано
  const part = B(SAW, { rawParams: [P("Состояние", "Б/У")], descUa: "<p>Номінальна потужність: 900 Вт</p>", ownerValues: [OV({ name: "Стан", value: "Новий", supplier: ["Вживаний"] })], ownerIndex: idx });
  assert.ok(has(part, "Стан", "Новий") && !part.params.some((p) => /900/.test(p.value)), JSON.stringify(part.params));
  assert.deepEqual(part.owner.map((o) => [o.name, o.action, o.applied]), [["Стан", "set", true], ["Номінальна потужність", "hold", false]]);
  // рішення є, але свідомо не застосоване (пріоритет 2 і є XML) — не утримується
  assert.ok(has(B(SAW, { rawParams: [P("Состояние", "Б/У")], ownerValues: [OV({ name: "Стан", value: "Новий", priority: 2 })], ownerIndex: { items: [{ name: "Стан" }] } }), "Стан", "Вживаний"));
  // перелік іншої моделі (помилка в Offer ID) — нічого не утримується, позначка
  const other = B(SAW, { rawParams: [P("Состояние", "Б/У")], titles: ["Пила X-100"], ownerIndex: { model: "Y-200", items: [{ name: "Стан" }] } });
  assert.ok(has(other, "Стан", "Вживаний"));
  assert.match(other.needsReview[0].reason, /модель «Y-200» не знайдено/);
});

test("перелік рішень у репозиторії (без значень) звіряється з файлом рішень: відсутній запис і зайвий запис — попередження; модель — однакова", () => {
  assert.ok(catalog.ownerIndex instanceof Map);
  const items = [...catalog.ownerIndex.values()].flatMap((p) => p.items);
  assert.ok(items.every((x) => !("value" in x) && !("supplier" in x) && !("source" in x)), "у переліку немає значень");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-index-"));
  const file = path.join(dir, "owner-values.json");
  // файл, що повністю відповідає переліку (значення синтетичні — звіряються лише назви, поля й модель)
  const products = Object.fromEntries([...catalog.ownerIndex].map(([id, p]) => [id, { model: p.model, items: p.items.map((x) => OV({ ...x, value: "x" })) }]));
  fs.writeFileSync(file, JSON.stringify({ v: 1, date: "2026-10-26", products }));
  assert.deepEqual(loadPromCatalog(undefined, { ...STATE_A, ownerValuesFile: file }).problems, []);
  const [id0] = Object.keys(products);
  const less = structuredClone(products); less[id0].items.shift();
  const more = structuredClone(products); more[id0].items.push(OV({ name: "Нова характеристика", value: "1" }));
  const model = structuredClone(products); model[id0].model = "ІНША-МОДЕЛЬ";
  for (const [p, re] of [[less, /є в переліку репозиторію, але немає у файлі рішень — характеристику утримано/], [more, /є у файлі рішень, але немає в переліку репозиторію/], [model, /модель у файлі «ІНША-МОДЕЛЬ»/]]) {
    fs.writeFileSync(file, JSON.stringify({ v: 1, date: "2026-10-26", products: p }));
    assert.ok(loadPromCatalog(undefined, { ownerValuesFile: file }).problems.some((x) => re.test(x)), re.source);
  }
  fs.writeFileSync(file, "{ зламаний");
  const broken = loadPromCatalog(undefined, { ownerValuesFile: file });
  assert.ok(broken.problems.some((x) => /некоректний JSON/.test(x)) && broken.problems.filter((x) => /характеристику утримано/.test(x)).length === items.length, "пошкоджений файл: усі характеристики переліку утримано");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ліміт 70: рішення власника, для якого вже немає місця (70 наявних користувацьких), — у переліку переповнення, не губиться непомітно", () => {
  const current = Array.from({ length: 70 }, (_, i) => P(`Наявна ${i + 1}`, `значення ${i + 1}`));
  const r = B(SAW, { current, ownerValues: [OV({ name: "Сумісний інструмент", value: "УШМ" })] });
  assert.equal(r.provenance.items.filter((i) => !i.a).length, 70);
  assert.ok(r.overflow.some((o) => o.name === "Сумісний інструмент"), JSON.stringify(r.overflow));
});

// Реальні рішення власника 26.10.2026 на локальних знімках ПОЗА репозиторієм (лише якщо задано MM_OWNER_VALUES, MM_REAL_TABLE —
// xlsx таблиці, MM_REAL_SUPPLIER_XML — повний XML постачальника, MM_PROM_CATEGORIES — категорії Prom): старі помилки
// постачальника не повертаються, рішення застосовано до однозначно зіставлених товарів (Offer ID + модель).
const REAL = process.env.MM_OWNER_VALUES && process.env.MM_REAL_TABLE && process.env.MM_REAL_SUPPLIER_XML && process.env.MM_PROM_CATEGORIES;
test("реальні рішення власника 26.10.2026 (локальні знімки поза репозиторієм): 9 товарів, старі помилки постачальника не повертаються", { skip: !REAL }, async () => {
  const { readXlsx } = await import("../tools/lib/xlsx-read.mjs");
  const { extractFullOffers } = await import("../src/core/sheet-sync.mjs");
  const c = loadPromCatalog();
  assert.deepEqual(c.problems, []);
  const s = readXlsx(process.env.MM_REAL_TABLE, { only: ["Основний каталог"] }).sheets[0];
  const h = s.values[0].map(String);
  const rows = new Map(s.values.slice(1).map((x) => Object.fromEntries(h.map((k, i) => [k, x[i] ?? ""]))).map((r) => [String(r["Offer ID"]), r]));
  const ids = ["3146020548", "3168313373", "1822909979", "1774128020", "2212278908", "3158153340", "2572063884", "2572081588", "2571161463"];
  const full = extractFullOffers(fs.readFileSync(process.env.MM_REAL_SUPPLIER_XML, "utf8"), ids.map((id) => String(rows.get(id)["ID постачальника"])));
  const out = {};
  for (const id of ids) {
    const r = rows.get(id), cat = c.promCategories.map.get(id), f = full.get(String(r["ID постачальника"]));
    out[id] = buildCharacteristics({ schema: c.schemas.get(cat), categoryId: cat, rawParams: f.params, descUa: f.descriptionUa, descRu: f.descriptionRu, current: JSON.parse(String(r["Характеристики JSON"] || "[]")), mapping: c.mappings.get(cat), units: c.units, names: c.names, mode: "main", brand: r["Виробник"], titles: [r["Назва постачальника UA"], r["Назва постачальника RU"]], kitOwner: c.kitConfirmed.get(id) || null, multiOwner: c.multiConfirmed.get(id) || null, ownerValues: c.ownerValues.get(id) || null, cardTitles: [r["Назва UA"], r["Назва RU"]] });
  }
  const fm = (p) => `${p.name}: ${p.value}${p.unit ? " " + p.unit : ""}`;
  const all = (id) => out[id].params.map(fm);
  const want = (id, list) => { for (const x of list) assert.ok(all(id).includes(x), `${id}: немає «${x}» — ${all(id).join(" | ")}`); };
  const never = (id, re) => assert.ok(!all(id).some((x) => re.test(x)), `${id}: ${all(id).filter((x) => re.test(x)).join(" | ")}`);
  for (const id of ids.slice(0, 6)) assert.ok(out[id].owner.length && out[id].owner.every((o) => o.applied), `${id}: ${JSON.stringify(out[id].owner)}`);
  for (const id of ids.slice(0, 6)) assert.ok(!out[id].needsReview.some((x) => /рішення власника/.test(x.reason)), `${id}: ${JSON.stringify(out[id].needsReview)}`);
  want("3146020548", ["Стан: Новий"]); never("3146020548", /^Стан: Вживаний/);
  want("3168313373", ["Стан: Новий"]); never("3168313373", /^Стан: Вживаний/);
  want("1822909979", ["Тип приводу: Електродвигун (від мережі)", "Живлення: Електромережа"]); never("1822909979", /^Тип приводу: (Акумулятор|Електричний)/);
  want("1774128020", ["Споживана потужність: 3000 Вт", "Живлення: Мережа 220 В"]); never("1774128020", /1800/);
  want("2212278908", ["Робоча швидкість: 10 000–14 000 об/хв", "З'єднання: M14", "Сумісний інструмент: УШМ"]); never("2212278908", /8000|^(Посадковий отвір|Посадочное отверстие|Рабочая скорость)/);
  want("3158153340", ["Максимальний зварювальний струм: 120 А", "Мінімальний зварювальний струм: 20 А", "Живлення: 230 В", "Регулювання зварювального струму: 20–120 А", "Напруга холостого ходу: 60 В", "Діаметр електродів: 1,6–3,2 мм", "Тривалість навантаження: 30 %", "Коефіцієнт корисної дії: 85 %", "Клас ізоляції: F", "Ступінь захисту IP: 21", "Функції: HOT START, ARC FORCE, ANTI-STICK"]);
  never("3158153340", /: 300 А|^Напруга живлення|: 60 %|40%|FORSE|ругулювання|ругулирования|^ККД|^КПД|^Клас захисту корпуса/);
  for (const id of ["2572063884", "2572081588"]) { want(id, ["Акумулятор у комплекті: Ні", "Зарядний пристрій у комплекті: Ні"]); never(id, /у комплекті: Так|^Кількість акумуляторів у комплекті/); }
  want("2571161463", ["Акумулятор у комплекті: Так", "Кількість акумуляторів у комплекті: 1"]);
});
