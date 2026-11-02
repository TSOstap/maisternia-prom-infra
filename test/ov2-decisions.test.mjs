/** Пакет OV, партія 2 (B2; HERMES-OV2-IMPLEMENTATION-RELEASE): точні регресії рішень власника поверх прийнятої партії 1.
 *  1) CSMH (2789189496): owner «Акумулятор у комплекті: Так» / «Зарядний пристрій у комплекті: Так» / «Кейс у комплекті: Ні» — майбутній
 *     XML із «Нет» / «Да» їх не змінює; повтор стабільний.
 *  2) DeWALT (2492383398): зарядний пристрій не підтверджено — owner «не передавати» без значення: XML «Да» або «Нет» не дає ні «Так», ні «Ні».
 *  3) Реальні дані (лише локально, файли поза репозиторієм; без MM_* — пропуск): точні очікування B2 — холостий хід LEX без XML 5200,
 *     EPTA, Einhell 105 / 2 швидкості без дублетів 120 / 20000 / 5, вага кущоріза без дублета, «до 5–10 мм» не під нативною real-назвою,
 *     OSRAM ≠ 635 нм, Metabo товщина / пропил, підошва Bosch, напруга двигуна Tex.AC, CSMH, DeWALT тощо.
 *  4) rev 8 (HOLD Hermes щодо rev 7, план OV2-12): №2 Zegor FORT4500-O (3147024588) — source-role, а не лише наявність рядка:
 *     «Кількість циліндрів: 1» — ВЛАСНИК (поле 116) з окремим рішенням 29.10; «Тип двигуна: Чотиритактний, OHV» — ВЛАСНИК із TXT №2;
 *     жодна характеристика з «одноциліндров…» не має походження ВЛАСНИК, жоден owner-запис не містить її без джерела, що це підтверджує.
 *  5) rev 9 (HOLD Hermes щодо rev 8, OV8-F1): №5 Metabo SLA 14.4-18 LED (3120604905) — у таблиці часу роботи явний кваліфікатор власника
 *     «Максимальна тривалість освітлення…» (TXT р. 309) збережено в назві; усі 8 пар АКБ ↔ час без змін; стандартне поле Prom
 *     «Світловий потік: 440 лм» (a=11377) не замінено користувацькою характеристикою.
 *  Схеми — справжні файли з schemas/prom; товари й значення в 1–2 — синтетичні. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCHEMAS_DIR, loadPromCatalog, loadOwnerValues } from "../src/pipeline/prom-schemas.mjs";
import { refreshMainRow, RAW_PARAMS, PARAMS_ORIGIN, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { STATE_A } from "./helpers/state-a.mjs";

const catalog = loadPromCatalog(undefined, STATE_A);
const SAW = "1250302", WRENCH = "141714";
const S1 = "2026-10-28T10:00:00.000Z", S2 = "2026-10-28T11:00:00.000Z";
const P = (name, value, unit = "") => ({ name, value, unit });
const OV = (o) => ({ action: "set", source: "тест", date: "2026-10-28", priority: 1, autoUpdate: false, ...o });
const fmt = (p) => `${p.name}: ${p.value}${p.unit ? " " + p.unit : ""}`;
const params = (r) => JSON.parse(r["Характеристики JSON"] || "[]").map(fmt);
const row = (id, cat, o = {}) => ({ "Offer ID": id, "ID постачальника": id, "Категорія Prom ID": cat, "Виробник": "Test", "Характеристики JSON": "[]", "Назва постачальника UA": "Інструмент тестовий TS-1", "Назва постачальника RU": "", ...o });
const offer = (id) => ({ id, vendor: "Test", model: "TS-1", sku: "", nameUa: "Інструмент тестовий TS-1", nameRu: "", price: 100, available: true, currency: "UAH" });

test("OV2 CSMH: майбутній XML «АКБ / ЗП — Нет», «Кейс — Да» не скасовує owner «Так» / «Так» / «Ні»; повтор без змін", () => {
  const cat = { ...catalog, ownerValues: new Map([["93", { model: "TS-1", items: [
    OV({ name: "Кейс у комплекті", value: "Ні", replaces: ["Кейс", "Кейс в комплекте", "Кейс в комплекті", "Наличие кейса", "Наявність кейса"], supplier: ["Так", "Да", "Є", "Есть"] }),
    // Записи — як у кандидаті rev 6: варіанти назв постачальника («в комплекті», RU) у replaces, «Ні / Нет» — у supplier.
    OV({ name: "Акумулятор у комплекті", value: "Так", replaces: ["Акумулятор в комплекті", "Аккумулятор в комплекте", "Наявність акумулятора", "Наличие аккумулятора"], supplier: ["Ні", "Нет"] }),
    OV({ name: "Зарядний пристрій у комплекті", value: "Так", replaces: ["Зарядний пристрій в комплекті", "Зарядное устройство в комплекте", "Наявність зарядного пристрою", "Наличие зарядного устройства"], supplier: ["Ні", "Нет"] }),
  ] }]]) };
  const raw = [P("Кейс в комплекте", "Да"), P("Аккумулятор в комплекте", "Нет"), P("Зарядное устройство в комплекте", "Нет"), P("Питание", "Аккумулятор")];
  const full = { params: raw, pictures: [], descriptionUa: "", descriptionRu: "" };
  const a = refreshMainRow(row("93", SAW, { [RAW_PARAMS]: JSON.stringify(raw) }), offer("93"), full, { stamp: S1, catalog: cat });
  const p = params(a.row);
  for (const m of ["Кейс у комплекті: Ні", "Акумулятор у комплекті: Так", "Зарядний пристрій у комплекті: Так"]) assert.ok(p.includes(m), `${m}: ${JSON.stringify(p)}`);
  assert.ok(!p.some((x) => /^(Акумулятор|Аккумулятор|Зарядн).*: (Ні|Нет)$/.test(x)), "XML «Нет» не повертається: " + JSON.stringify(p));
  assert.ok(!p.some((x) => /^Кейс.*: (Так|Да)$/.test(x)), JSON.stringify(p));
  const again = refreshMainRow(a.row, offer("93"), full, { stamp: S2, catalog: cat });
  assert.equal(again.row["Характеристики JSON"], a.row["Характеристики JSON"]);
});

test("OV2 DeWALT: зарядний пристрій не підтверджено — XML «Да» або «Нет» не дає ні «Так», ні «Ні»; ємність АКБ 5 А·год у полі; комплект продавця", () => {
  const items = [
    OV({ name: "Комплектація", value: "гайковерт DCF897NT; акумулятор 5 А·год; валіза — 1 шт.", replaces: ["Комплектация"], supplier: [] }),
    OV({ name: "Акумулятор у комплекті", value: "Так", supplier: [] }),
    OV({ name: "Ємність акумулятору", field: "98", value: "5", unit: "А. г", supplier: [] }),
    OV({ name: "Зарядний пристрій у комплекті", action: "drop", replaces: ["Зарядное устройство в комплекте", "Зарядний пристрій в комплекті", "Зарядное устройство"], supplier: ["Так", "Да", "Ні", "Нет", "Є", "є", "Есть", "есть"] }),
  ];
  const cat = { ...catalog, ownerValues: new Map([["94", { model: "TS-1", items }]]) };
  for (const v of ["Да", "Нет"]) {
    const raw = [P("Зарядное устройство в комплекте", v), P("Комплектация", "Валіза - 1 шт з акумулятором 5 ампеер і зарядним пристроєм."), P("Питание", "Аккумулятор")];
    const full = { params: raw, pictures: [], descriptionUa: "", descriptionRu: "" };
    const a = refreshMainRow(row("94", WRENCH, { [RAW_PARAMS]: JSON.stringify(raw) }), offer("94"), full, { stamp: S1, catalog: cat });
    const p = params(a.row);
    assert.ok(!p.some((x) => /зарядн|зарядное/i.test(x.split(":")[0])), `XML «${v}»: зарядного немає взагалі — ${JSON.stringify(p)}`);
    assert.ok(p.includes("Ємність акумулятору: 5 А. г") && p.includes("Акумулятор у комплекті: Так") && p.includes("Комплектація: гайковерт DCF897NT; акумулятор 5 А·год; валіза — 1 шт."), JSON.stringify(p));
    const again = refreshMainRow(a.row, offer("94"), full, { stamp: S2, catalog: cat });
    assert.equal(again.row["Характеристики JSON"], a.row["Характеристики JSON"]);
  }
});

// ---------- реальні дані ----------
const REAL = process.env.MM_OWNER_VALUES && process.env.MM_REAL_TABLE && process.env.MM_REAL_SUPPLIER_XML && process.env.MM_PROM_CATEGORIES;
// [Offer ID, обов'язкові «назва: значення одиниця», заборонені, заборонені назви характеристик (регулярний вираз за назвою)]
const EXPECT = [
  ["3135267924", ["Число обертів холостого ходу: 3800 об/хв", "Діаметр посадкового отвору: 25.4 мм", "Частота мережі: 50 Гц", "Подвійний нахил: Так", "Ширина протяжки (пропилу): до 330–340 мм", "Ремінна передача: так", "Лазерний маркер: Так", "Живлення: Мережа 220 В"], ["Діаметр посадкового отвору: 30 мм"], /^Максимальна кількість обертів$/],
  ["3147024588", ["Об'єм паливного бака: 7.5 л", "Тип двигуна: Чотиритактний, OHV", "Кількість циліндрів: 1", "Охолодження двигуна: Примусове повітряне", "Тактность двигуна: Чотиритактний", "Тип генератора: Інверторний", "Повне гармонійне спотворення (THD): ≤ 5 %"], ["Об'єм паливного бака: 7 л", "Тип генератора: Бензиновий", "Тип двигуна: Одноциліндровий чотиритактний, OHV", "Тип двигуна: Одноциліндровий чотиритактний"]],
  ["1651785636", ["Енергія удару: 2.4 Дж", "Енергія удару (EPTA): 2.7 Дж", "Вага без мережевого кабелю та бічної рукоятки: 2.7 кг"], [], /^Сила удар[уа]$/],
  ["3109175049", ["Продуктивність: 105 м³/год", "Кількість швидкостей: 2", "Швидкість холостого ходу: 11500–15500 об/хв", "Вага: 1.22 кг", "Вага брутто: 1.85 кг"], ["Продуктивність: 120 м³/год", "Кількість швидкостей: 5"], /^(Максимальна кількість обертів|Максимальний об'єм повітряного потоку|Кількість режимів швидкості)$/],
  ["3190382511", ["Комплектація: пластиковий кейс; 3 бури (8, 10, 12 мм); піка; зубило; бічна ручка з обмежувачем глибини", "Вага: 3.5 кг", "Система погашення вібрації: Так"], ["Вага: 3.7 кг", "Система погашення вібрації: Ні"]],
  ["1505796784", ["Вага: 3.95 кг", "Вага брутто: 5.44 кг"], [], /^Вага нетто$/],
  ["2748211367", ["Допустимий розмір часток: до 5–10 мм", "Вага насоса без кабелю живлення та рідин: близько 1,3 кг", "Вага брутто: 10.3 кг", "Тип вимикача насоса: Поплавковий"], [], /^Діаметр перекачуваних частинок$/],
  ["3128129773", ["Потужність: 4600–5500 Вт"], ["Потужність: 5500 Вт"]],
  ["1505797098", ["Лазерний діод: 635 нм", "Виробник лазерного модуля: OSRAM", "Кількість променів: 2", "Кількість лазерних випромінювачів: 2"], ["Модуль лазера: 2 шт."], /^(Довжина хвилі лазера|Длина волны лазера)$/],
  ["3109304003", ["Товщина: 1.8 мм", "Товщина пропилу: 2.4 мм"], ["Товщина пропилу: 1.8 мм"], /^Товщина диска$/],
  ["3117192884", ["Матеріал підошви: Алюміній", "Напруга акумулятора (підтверджені значення): 10,8 | 12 В", "Тип двигуна: Безщітковий", "Електронний захист: EMP (двигун від перевантаження), ECP (акумулятор від перевантаження, перегріву, глибокого розряду)"], ["Матеріал підошви: Сталь"], /^Напруга акумулятору$/],
  ["2789189496", ["Кейс у комплекті: Ні", "Акумулятор у комплекті: Так", "Зарядний пристрій у комплекті: Так"], ["Акумулятор у комплекті: Ні", "Зарядний пристрій у комплекті: Ні", "Кейс у комплекті: Так"]],
  ["2492383398", ["Ємність акумулятору: 5 А. г", "Акумулятор у комплекті: Так", "Комплектація: гайковерт DCF897NT; акумулятор 5 А·год; валіза — 1 шт."], [], /зарядн/i],
  ["2298720379", ["Напруга двигуна: 20 В", "Тип двигуна: Щітковий", "Тип охолодження: Повітряний"], []],
  ["3198171196", ["Пиловідведення при сухому різі: обов'язкове", "Тип посадки: Різьбове з'єднання М14", "Матеріал обробки:: бетон, армований бетон, цегла, камінь, граніт"], [], /^Діаметр внутрішній$/],
  ["1518319917", ["Потужність двигуна (режим S6 40 %): 2500 Вт", "Ріжучий механізм: Фрезерний", "Габарити упаковки (Д × Ш × В): 550 × 315 × 617 мм"], ["Потужність двигуна: 2500 Вт"]],
  ["1505797104", ["Максимальна висота подачі: 38 м", "Максимальна висота всмоктування: 8 м"], []],
  ["2105155463", ["Матеріал корпусу насоса: Ударостійкий технополімер"], ["Матеріал корпусу: Ударостійкий технополімер"]],
  ["2673513290", ["Комплект поставки: газонокосарка; 2 акумулятори PT2080EP 8,0 А·год; двослотовий швидкий зарядний пристрій; травозбірник 50 л; насадки для бічного викиду та мульчування"], [], /^Комплектація$/],
  ["3158153340", ["Тривалість навантаження: 40 %", "Максимальний зварювальний струм: 120 А"], ["Тривалість навантаження: 30 %", "Номінальний зварювальний струм: 200 А"]],
  ["3087521840", ["Тип штанги: Телескопічна"], ["Форма штанги: Пряма"]],
  // HERMES-OV2-ALREADY-REVIEW: п. 1 — 0,5 кг власника; п. 2 — діапазон −45…45° зі знаком; п. 3 — «на вході»; п. 4 — EPTA; п. 5 — тип LED.
  ["3120604905", ["Вага без акумулятора: 0.5 кг"], ["Вага без акумулятора: 0,46 кг"]],
  // rev 9, OV8-F1: таблиця часу — з «максимальна»; неуточнена назва rev 8 заборонена; стандартне поле світлового потоку лишається.
  ["3120604905", ["Світловий потік: 440 лм"], [], /^(Тривалість роботи від одного заряду|Максимальний світловий потік)$/],
  ["3117192884", ["Діапазон кута нахилу: -45...45 °", "Нахил підошви: 45 град."], []],
  ["2925718711", ["Продуктивність на вході: 180 л/хв"], [], /^Продуктивність \(л\/хв\)$/],
  ["3141882196", ["Вага (EPTA): 1.2 кг", "Робоча вага з акумулятором: 1,1–1,2 кг"], [], /^Вага$/],
  ["2535406135", ["Тип дисплея: цифровий LED", "Цифровий дисплей: відображає рівень заряду батареї та кількість зроблених зрізів."], []],
];
// Реальні входи завантажуються один раз для обох тестів реальних даних.
let realOnce = null;
const loadReal = () => (realOnce ??= (async () => {
  const { readXlsx } = await import("../tools/lib/xlsx-read.mjs");
  const { parseSupplierText } = await import("../src/core/supplier-feed.mjs");
  const ov = loadOwnerValues(process.env.MM_OWNER_VALUES);
  assert.ok(ov.ok, JSON.stringify(ov.problems));
  const c = loadPromCatalog(undefined, { ...STATE_A, ownerIndexLegacy: false, ownerValuesIndexFile: path.join(SCHEMAS_DIR, "owner-values-index.json"), ownerValuesFile: process.env.MM_OWNER_VALUES });
  assert.equal(c.guard.blocked, false, JSON.stringify(c.guard));
  const s = readXlsx(process.env.MM_REAL_TABLE, { only: ["Основний каталог"] }).sheets[0];
  const h = s.values[0].map(String);
  const rows = new Map(s.values.slice(1).map((x) => Object.fromEntries(h.map((k, i) => [k, x[i] ?? ""]))).map((r) => [String(r["Offer ID"]), r]));
  const xml = fs.readFileSync(process.env.MM_REAL_SUPPLIER_XML, "utf8");
  const parsed = await parseSupplierText(xml, { maximumChars: 400_000_000, identityFields: true });
  const ids = EXPECT.map((e) => e[0]).filter((id) => rows.has(id));
  const full = extractFullOffers(xml, ids.map((id) => String(rows.get(id)["ID постачальника"])));
  const refresh = (id) => { const r = rows.get(id), sid = String(r["ID постачальника"]); return refreshMainRow({ ...r }, parsed.offers.get(sid), full.get(sid), { stamp: S1, catalog: c }); };
  return { rows, refresh };
})());
test("OV2 реальні дані: точні результати B2 (release A1–A3, B, C; watchlist) і збереження рішень партії 1", { skip: !REAL }, async () => {
  const { rows, refresh } = await loadReal();
  const problems = [];
  for (const [id, must, never, banned] of EXPECT) {
    if (!rows.has(id)) { problems.push(`${id}: немає в таблиці`); continue; }
    const a = refresh(id);
    const ps = JSON.parse(a.row["Характеристики JSON"] || "[]"), p = ps.map(fmt);
    for (const m of must) if (!p.includes(m)) problems.push(`${id}: немає «${m}»`);
    for (const n of never) if (p.includes(n)) problems.push(`${id}: є заборонене «${n}»`);
    if (banned) for (const x of ps) if (banned.test(x.name)) problems.push(`${id}: є характеристика «${fmt(x)}» із забороненою назвою ${banned}`);
  }
  assert.deepEqual(problems, []);
});

test("OV2 rev 8 №2 Zegor FORT4500-O (3147024588): source-role — «1 циліндр» лише з рішення власника 29.10, «Тип двигуна» лише з TXT №2", { skip: !REAL }, async () => {
  const { rows, refresh } = await loadReal();
  const ID = "3147024588", OWNER = "ВЛАСНИК";
  // Owner-записи: джерело кожного твердження — своє.
  const raw = JSON.parse(fs.readFileSync(process.env.MM_OWNER_VALUES, "utf8"));
  const items = raw.products[ID]?.items || [];
  const cyl = items.find((x) => x.field === "116");
  assert.ok(cyl && cyl.value === "1" && cyl.action === "set", "owner-запис поля 116 «Кількість циліндрів: 1»: " + JSON.stringify(cyl));
  assert.match(cyl.source, /2026-10-29-zegor-fort4500-o-1-циліндр/, "джерело «1 циліндр» — окреме рішення власника 29.10");
  const eng = items.find((x) => x.name === "Тип двигуна");
  assert.ok(eng && eng.value === "Чотиритактний, OHV", "«Тип двигуна» — лише підтверджене TXT №2: " + JSON.stringify(eng));
  assert.match(eng.source, /рішення власника\.txt.*4-х тактний.*OHV/s, "джерело «Тип двигуна» — TXT №2");
  for (const [pid, p] of Object.entries(raw.products)) for (const x of p.items) {
    if (/одноциліндр/i.test(`${x.name} ${x.value ?? ""}`)) assert.match(x.source, /одноциліндр|1 циліндр/i, `${pid}: owner-запис «${x.name}: ${x.value}» без джерела, що підтверджує одноциліндровість`);
  }
  // Фактичний вихід: значення й походження (аналог незалежного semantic-probe Hermes, який на rev 7 давав RED).
  assert.ok(rows.has(ID));
  const a = refresh(ID);
  const prov = JSON.parse(a.row[PARAMS_ORIGIN] || "{}").items || [];
  const at = (name, value) => prov.find((x) => { const [n, v] = String(x.k).split("\u0001"); return n === name && v === value; });
  assert.equal(at("Кількість циліндрів", "1")?.s, OWNER, "«Кількість циліндрів: 1» — ВЛАСНИК: " + JSON.stringify(at("Кількість циліндрів", "1")));
  assert.equal(at("Кількість циліндрів", "1")?.a, "116");
  assert.equal(at("Тип двигуна", "Чотиритактний, OHV")?.s, OWNER, "«Тип двигуна: Чотиритактний, OHV» — ВЛАСНИК");
  const bad = prov.filter((x) => x.s === OWNER && /одноциліндр/i.test(String(x.k)));
  assert.deepEqual(bad, [], "непідтверджений власником одноциліндровий тип не має отримувати ВЛАСНИК");
});

test("OV2 rev 9 №5 Metabo SLA 14.4-18 LED (3120604905): таблиця часу — явна «максимальна», усі 8 пар АКБ ↔ час; «Світловий потік: 440 лм» — стандартне поле", { skip: !REAL }, async () => {
  const { rows, refresh } = await loadReal();
  const ID = "3120604905", OWNER = "ВЛАСНИК";
  // Власник (TXT р. 309): «Максимальна тривалість освітлення на одному заряді акумулятора14,4 В / 2,0 А-год: 3,4 год / …».
  const PAIRS = ["14,4 В / 2,0 А·год — 3,4 год", "14,4 В / 4,0 А·год — 6,8 год", "18 В / 2,0 А·год — 4,5 год", "18 В / 4,0 А·год — 9,1 год", "18 В / 5,2 А·год — 11,8 год", "18 В / LiHD 3.1 — 7 год", "18 В / LiHD 5.5 — 12,4 год", "18 В / LiHD 6.2 — 14 год"];
  const raw = JSON.parse(fs.readFileSync(process.env.MM_OWNER_VALUES, "utf8"));
  const items = raw.products[ID]?.items || [];
  const tbl = items.filter((x) => x.action === "set" && PAIRS.every((p) => String(x.value).includes(p)));
  assert.equal(tbl.length, 1, "рівно один owner-запис таблиці часу з усіма 8 парами: " + JSON.stringify(items.map((x) => x.name)));
  assert.match(tbl[0].name, /максимальн/i, `кваліфікатор власника «максимальна» не втрачено — назва «${tbl[0].name}»`);
  assert.equal(tbl[0].value, PAIRS.join("; "), "числа й умови АКБ без змін");
  assert.ok(!items.some((x) => /максимальн/i.test(x.name) && /світлов/i.test(x.name)), "стандартне поле світлового потоку не замінюється користувацькою характеристикою");
  // Фактичний вихід.
  assert.ok(rows.has(ID));
  const a = refresh(ID);
  const ps = JSON.parse(a.row["Характеристики JSON"] || "[]");
  const prov = JSON.parse(a.row[PARAMS_ORIGIN] || "{}").items || [];
  const t = ps.filter((p) => String(p.value) === PAIRS.join("; "));
  assert.equal(t.length, 1, "таблиця часу в картці рівно один раз");
  assert.match(t[0].name, /^Максимальна тривалість/, `назва в картці — «${t[0].name}»`);
  assert.equal(prov.find((x) => String(x.k) === `${t[0].name}\u0001${t[0].value}\u0001`)?.s, OWNER, "таблиця часу — ВЛАСНИК");
  const flux = prov.find((x) => String(x.k) === "Світловий потік\u0001440\u0001лм");
  assert.equal(flux?.a, "11377", "«Світловий потік: 440 лм» лишається стандартним полем 11377: " + JSON.stringify(flux));
  assert.ok(!ps.some((p) => p.name === "Тривалість роботи від одного заряду"), "неуточнена назва rev 8 не повертається");
});