/** Пакет OV (рішення власника щодо характеристик, 28.10.2026): застосування підтверджених рішень через чинні owner-values.
 *  1) Товар із рішенням власника, але без сирих характеристик постачальника (не А2): генератор лише застосовує рішення й зберігає
 *     наявні значення картки — опис не розбирається; повтор стабільний; товар без рішення — як раніше (генератор не викликається).
 *  2) Нове рішення того самого поля замінює старе (ПВ 40 % замість 30 %); «не передавати» прибирає помилкове значення XML і не
 *     повертає його при повторному оновленні; комплект «Кейс у комплекті: Ні» — помилкове «Так» постачальника не повертається.
 *  3) Реальні рішення партії 1 (лише локально, файли поза репозиторієм; без MM_* — пропуск): кожна трійка рішення (назва + значення +
 *     одиниця) є в картці, відкинуті значення постачальника не повертаються у своїй характеристиці, повторне оновлення — без змін;
 *     точні очікування виправленої партії 1 (R2–R4, R6); перевірка трійки має синтетичний негативний контроль (R5).
 *  Схеми — справжні файли з schemas/prom; товари й значення в 1–2 — синтетичні. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SCHEMAS_DIR, loadPromCatalog, loadOwnerValues } from "../src/pipeline/prom-schemas.mjs";
import path from "node:path";
import { refreshMainRow, PARAMS_ORIGIN, RAW_PARAMS, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { STATE_A } from "./helpers/state-a.mjs";

const catalog = loadPromCatalog(undefined, STATE_A);
const SAW = "1250302", WELD = "14400101";
const S1 = "2026-10-28T10:00:00.000Z", S2 = "2026-10-28T11:00:00.000Z";
const P = (name, value, unit = "") => ({ name, value, unit });
const OV = (o) => ({ action: "set", source: "тест", date: "2026-10-28", priority: 1, autoUpdate: false, ...o });
const fmt = (p) => `${p.name}: ${p.value}${p.unit ? " " + p.unit : ""}`;
const params = (r) => JSON.parse(r["Характеристики JSON"] || "[]").map(fmt);
const row = (id, cat = SAW, o = {}) => ({ "Offer ID": id, "ID постачальника": id, "Категорія Prom ID": cat, "Виробник": "Test", "Характеристики JSON": "[]", "Назва постачальника UA": "Пила тестова TS-1", "Назва постачальника RU": "", ...o });
const offer = (id) => ({ id, vendor: "Test", model: "TS-1", sku: "", nameUa: "Пила тестова TS-1", nameRu: "", price: 100, available: true, currency: "UAH" });
const DESC = { ua: "<ul><li>Потужність: 1100 Вт</li><li>Кейс у комплекті: так</li><li>Вага: 5 кг</li></ul>", ru: "<ul><li>Мощность: 1100 Вт</li><li>Вес: 5 кг</li></ul>" };
const fullOf = (o = {}) => ({ params: [], pictures: [], descriptionUa: DESC.ua, descriptionRu: DESC.ru, ...o });

test("OV: рішення власника для товару без сирих характеристик постачальника — застосовано; опис не розбирається; повтор стабільний; без рішення — як раніше", () => {
  const cat = { ...catalog, ownerValues: new Map([["77", { model: "TS-1", items: [OV({ name: "Вага брутто", value: "2.21", unit: "кг" }), OV({ name: "Кейс у комплекті", value: "Ні", supplier: ["Так"] })] }]]) };
  const a = refreshMainRow(row("77"), offer("77"), fullOf(), { stamp: S1, catalog: cat });
  assert.equal(a.row[RAW_PARAMS] ?? "", "", "сирих характеристик постачальника немає");
  assert.deepEqual(params(a.row).sort(), ["Вага брутто: 2.21 кг", "Кейс у комплекті: Ні"], JSON.stringify(params(a.row)));
  assert.ok(!params(a.row).some((x) => /Потужність|Вага: 5|так$/.test(x)), "опис не розібрано — нових характеристик з опису немає");
  assert.ok(JSON.parse(a.row[PARAMS_ORIGIN]).items.every((i) => i.s === "ВЛАСНИК"), a.row[PARAMS_ORIGIN]);
  const again = refreshMainRow(a.row, offer("77"), fullOf(), { stamp: S2, catalog: cat });
  assert.equal(again.params, false);
  assert.equal(again.row["Характеристики JSON"], a.row["Характеристики JSON"], "повтор стабільний");
  // Наявні значення картки зберігаються; додається лише рішення.
  const kept = refreshMainRow(row("77", SAW, { "Характеристики JSON": JSON.stringify([P("Гарантійний термін", "36", "міс")]) }), offer("77"), fullOf(), { stamp: S1, catalog: cat });
  assert.ok(params(kept.row).includes("Гарантійний термін: 36 міс") && params(kept.row).includes("Вага брутто: 2.21 кг"), JSON.stringify(params(kept.row)));
  // Без рішення власника — як раніше: генератор не викликається, картка без змін.
  const none = refreshMainRow(row("78"), offer("78"), fullOf(), { stamp: S1, catalog: cat });
  assert.equal(none.row["Характеристики JSON"], "[]");
  assert.equal(none.row[PARAMS_ORIGIN] ?? "", "");
  // Перелік у репозиторії без файлу рішень (лише назви): генератор утримує, але нічого не бере з опису.
  const idxOnly = { ...catalog, ownerValues: null, ownerIndex: new Map([["79", { model: "TS-1", items: [{ name: "Вага брутто" }] }]]) };
  const h = refreshMainRow(row("79"), offer("79"), fullOf(), { stamp: S1, catalog: idxOnly });
  assert.deepEqual(params(h.row), [], "лише перелік — нічого не вигадано й не взято з опису");
});

test("OV: нове рішення того самого поля замінює старе (40 % замість 30 %); «не передавати» прибирає 200 А з XML і не повертає при повторі; «Кейс у комплекті: Ні» не повертає «Так»", () => {
  const raw = [P("Номинальный сварочный ток", "200", "А"), P("Номинальный рабочий цикл (%)", "60", "%"), P("Кейс в комплекте", "Да")];
  const cat = { ...catalog, ownerValues: new Map([["91", { model: "TS-1", items: [
    OV({ name: "Тривалість навантаження", field: "14577", value: "40", unit: "%", replaces: ["Номінальний робочий цикл(%)", "Номинальный рабочий цикл (%)", "Робочий цикл"], supplier: ["60 %", "30 %"] }),
    OV({ name: "Номінальний зварювальний струм", action: "drop", replaces: ["Номинальный сварочный ток"], supplier: ["200 А", "200"] }),
    OV({ name: "Кейс у комплекті", value: "Ні", replaces: ["Кейс в комплекте", "Кейс в комплекті"], supplier: ["Так", "Да"] }),
  ] }]]) };
  const r0 = row("91", WELD, { [RAW_PARAMS]: JSON.stringify(raw), "Характеристики JSON": JSON.stringify([P("Тривалість навантаження", "30", "%"), P("Номінальний зварювальний струм", "200", "А")]) });
  const full = { params: raw, pictures: [], descriptionUa: "", descriptionRu: "" };
  const a = refreshMainRow(r0, offer("91"), full, { stamp: S1, catalog: cat });
  const p = params(a.row);
  assert.ok(p.includes("Тривалість навантаження: 40 %"), JSON.stringify(p));
  assert.ok(!p.some((x) => /: 30 %|: 60 %/.test(x)), "старі 30 % і XML 60 % не передаються");
  assert.ok(!p.some((x) => /зварювальний струм: 200|сварочный ток/i.test(x)), "200 А не передається");
  assert.ok(p.includes("Кейс у комплекті: Ні") && !p.some((x) => /Кейс.*(Так|Да)/.test(x)), JSON.stringify(p));
  const again = refreshMainRow(a.row, offer("91"), full, { stamp: S2, catalog: cat });
  assert.equal(again.row["Характеристики JSON"], a.row["Характеристики JSON"], "повторне оновлення з тим самим XML — без змін");
  assert.equal(again.params, false);
});

// R6 (HERMES-OV1-REVIEW-1): Zegor CSMH-21BL-8 — кейса немає, АКБ і ЗП є. Рішення «Кейс у комплекті: Ні» (записи — як у кандидаті) не забирає
// позитивних АКБ / ЗП, якщо майбутній XML їх передає, і не повертає «Да» для кейса; повтор стабільний.
test("OV R6: CSMH — майбутній XML із «Кейс в комплекте: Да» та АКБ / ЗП: кейс лишається «Ні», позитивні АКБ і ЗП не губляться, повтор без змін", () => {
  const cat = { ...catalog, ownerValues: new Map([["92", { model: "TS-1", items: [OV({ name: "Кейс у комплекті", value: "Ні", replaces: ["Кейс", "Кейс в комплекте", "Кейс в комплекті", "Наличие кейса", "Наявність кейса"], supplier: ["Так", "Да", "Є", "Есть"] })] }]]) };
  const raw = [P("Кейс в комплекте", "Да"), P("Аккумулятор в комплекте", "Да"), P("Зарядное устройство в комплекте", "Да"), P("Питание", "Аккумулятор")];
  const r0 = row("92", SAW, { [RAW_PARAMS]: JSON.stringify(raw), "Характеристики JSON": JSON.stringify([P("Кейс у комплекті", "Ні"), P("Живлення", "Акумулятор")]) });
  const full = { params: raw, pictures: [], descriptionUa: "", descriptionRu: "" };
  const a = refreshMainRow(r0, offer("92"), full, { stamp: S1, catalog: cat });
  const p = params(a.row);
  assert.ok(p.includes("Кейс у комплекті: Ні") && !p.some((x) => /^Кейс.*: (Так|Да|Є|Есть)$/.test(x)), JSON.stringify(p));
  assert.ok(p.some((x) => /^Акумулятор .*комплект.*: (Так|Да)$/.test(x)), "АКБ у комплекті — позитивне значення збережено: " + JSON.stringify(p));
  assert.ok(p.some((x) => /^Зарядний пристрій .*комплект.*: (Так|Да)$/.test(x)), "ЗП у комплекті — позитивне значення збережено: " + JSON.stringify(p));
  const again = refreshMainRow(a.row, offer("92"), full, { stamp: S2, catalog: cat });
  assert.equal(again.row["Характеристики JSON"], a.row["Характеристики JSON"]);
  assert.equal(again.params, false);
});

// R5 (HERMES-OV1-REVIEW-1): перевірка трійки — та сама характеристика (назва рішення / назва поля Prom за field / нормалізований збіг з
// назвою поля), значення й одиниця разом; заборонені значення — лише в тій самій характеристиці. Число в іншому полі — не PASS.
// Одиниця — та сама або фізично рівна за погодженими перерахунками schemas/prom/units.json (0.16 кг = 160 г в одиниці поля картки).
const nn = (s) => String(s || "").toLowerCase().replace(/[’ʼ`']/g, "'").replace(/[^\p{L}\p{N}']+/gu, "");
const nval = (v) => String(v ?? "").toLowerCase().replace(/,/g, ".").replace(/\s+/g, "");
function tripleProblems(params, o, schema = null, conversions = []) {
  const fieldName = o.field && schema ? schema.attributes.find((a) => String(a.id) === String(o.field))?.nameUK : null;
  const own = new Set([o.name, fieldName].filter(Boolean).map(nn));
  const all = new Set([...own, ...(o.replaces || []).map(nn)]);
  const inChar = params.filter((x) => all.has(nn(x.name)));
  const out = [];
  if (o.action === "drop") {
    if (inChar.some((x) => (o.supplier || []).some((v) => nval(`${x.value}${x.unit || ""}`) === nval(v) || nval(x.value) === nval(v)))) out.push(`«${o.name}»: відкинуте значення постачальника є в цій характеристиці`);
    return out;
  }
  const want = [nval(o.value), nval(String(o.value).replace(/,\s*/g, " | "))];
  const same = (x) => (want.includes(nval(x.value)) && nval(x.unit) === nval(o.unit)) || conversions.some((k) => k.from === o.unit && k.to === x.unit && Math.abs(Number(o.value) * k.factor - Number(x.value)) < 1e-9 * Math.max(1, Math.abs(Number(x.value))));
  if (!params.some((x) => own.has(nn(x.name)) && same(x))) out.push(`«${o.name}: ${o.value}${o.unit ? " " + o.unit : ""}»: немає такої трійки (назва + значення + одиниця)`);
  if (inChar.some((x) => (o.supplier || []).some((v) => nval(`${x.value}${x.unit || ""}`) === nval(v)) && !want.includes(nval(x.value)))) out.push(`«${o.name}»: у цій характеристиці повернулося значення постачальника`);
  return out;
}

test("OV R5: перевірка трійки — правильне число в іншій характеристиці або з іншою одиницею не дає PASS; заборонене значення шукається лише в своїй характеристиці", () => {
  const o = { name: "Тривалість навантаження", value: "40", unit: "%", action: "set", supplier: ["60 %"] };
  assert.deepEqual(tripleProblems([P("Тривалість навантаження", "40", "%")], o), []);
  assert.equal(tripleProblems([P("Коефіцієнт корисної дії", "40", "%")], o).length, 1, "40 % в іншому полі — не PASS");
  assert.equal(tripleProblems([P("Тривалість навантаження", "40", "")], o).length, 1, "без одиниці — не PASS");
  assert.equal(tripleProblems([P("Тривалість навантаження", "40", "%"), P("Тривалість навантаження", "60", "%")], o).length, 1, "значення постачальника в тій самій характеристиці — проблема");
  assert.deepEqual(tripleProblems([P("Тривалість навантаження", "40", "%"), P("Інше поле", "60", "%")], o), [], "60 % в іншому полі — не глобальна заборона");
  const w = { name: "Вага", value: "0.16", unit: "кг", action: "set" }, conv = catalog.units.conversions;
  assert.deepEqual(tripleProblems([P("Вага", "160", "г")], w, null, conv), [], "0.16 кг = 160 г");
  assert.equal(tripleProblems([P("Вага", "0.16", "г")], w, null, conv).length, 1, "0.16 г — інше значення");
  assert.equal(tripleProblems([P("Вага", "160", "кг")], w, null, conv).length, 1, "160 кг — інше значення");
  assert.equal(tripleProblems([P("Вага брутто", "0.16", "кг")], w, null, conv).length, 1, "та сама вага в іншій характеристиці — не PASS");
  const d = { name: "Номінальний зварювальний струм", action: "drop", replaces: ["Номинальный сварочный ток"], supplier: ["200 А"] };
  assert.equal(tripleProblems([P("Номинальный сварочный ток", "200", "А")], d).length, 1);
  assert.deepEqual(tripleProblems([P("Максимальний зварювальний струм", "200", "А")], d), [], "200 А в іншій характеристиці — не порушення drop");
});

// Реальні рішення партії 1 (кандидат owner-values поза репозиторієм) на реальній таблиці й XML 22.10 — лише локально. Каталог — з переліком
// репозиторію (обов'язкова прив'язка R1): файл MM_OWNER_VALUES має точно відповідати required.
const REAL = process.env.MM_OWNER_VALUES && process.env.MM_REAL_TABLE && process.env.MM_REAL_SUPPLIER_XML && process.env.MM_PROM_CATEGORIES;
async function realWorld() {
  const { readXlsx } = await import("../tools/lib/xlsx-read.mjs");
  const { parseSupplierText } = await import("../src/core/supplier-feed.mjs");
  const ov = loadOwnerValues(process.env.MM_OWNER_VALUES);
  const c = loadPromCatalog(undefined, { ...STATE_A, ownerValuesIndexFile: path.join(SCHEMAS_DIR, "owner-values-index.json"), ownerValuesFile: process.env.MM_OWNER_VALUES });
  const s = readXlsx(process.env.MM_REAL_TABLE, { only: ["Основний каталог"] }).sheets[0];
  const h = s.values[0].map(String);
  const rows = new Map(s.values.slice(1).map((x) => Object.fromEntries(h.map((k, i) => [k, x[i] ?? ""]))).map((r) => [String(r["Offer ID"]), r]));
  const xml = fs.readFileSync(process.env.MM_REAL_SUPPLIER_XML, "utf8");
  const parsed = await parseSupplierText(xml, { maximumChars: 400_000_000, identityFields: true });
  const ids = [...new Set([...ov.map.keys(), ...EXPECT.map((e) => e[0]), "1774128020"])].filter((id) => rows.has(id));
  const full = extractFullOffers(xml, ids.map((id) => String(rows.get(id)["ID постачальника"])));
  const refresh = (id, row = rows.get(id), stamp = S1) => { const sid = String(rows.get(id)["ID постачальника"]); return refreshMainRow({ ...row }, parsed.offers.get(sid), full.get(sid), { stamp, catalog: c }); };
  return { ov, c, rows, ids, refresh };
}
test("OV: реальні рішення власника (локальні файли поза репозиторієм): кожна трійка рішення в картці, відкинуті значення постачальника не повертаються у своїй характеристиці, повтор без зміни значень", { skip: !REAL }, async () => {
  const { ov, c, rows, refresh } = await realWorld();
  assert.ok(ov.ok, JSON.stringify(ov.problems));
  assert.equal(c.guard.blocked, false, "обов'язкова прив'язка валідна: " + JSON.stringify(c.guard));
  const problems = [];
  const ids = [...ov.map.keys()].filter((id) => rows.has(id));
  for (const id of ids) {
    const a = refresh(id);
    const p = JSON.parse(a.row["Характеристики JSON"] || "[]");
    const schema = c.schemas.get(String(rows.get(id)["Категорія Prom ID"]));
    for (const o of ov.map.get(id).items) for (const x of tripleProblems(p, o, schema, c.units.conversions)) problems.push(`${id} ${x}`);
    // Повтор: набір значень не змінюється (порядок на реальних рядках змінюється й без рішень власника — наявна властивість генератора).
    const again = refresh(id, a.row, S2);
    const set = (x) => JSON.stringify(JSON.parse(x["Характеристики JSON"] || "[]").map((q) => `${q.name}\u0001${q.value}\u0001${q.unit || ""}`).sort());
    if (set(again.row) !== set(a.row)) problems.push(`${id}: повторне оновлення змінило значення характеристик`);
  }
  assert.deepEqual(problems, []);
  assert.ok(ids.length >= 6, `товарів із рішеннями в таблиці: ${ids.length}`);
});

// R2–R4, R6 (HERMES-OV1-REVIEW-1, HERMES-OV-OWNER-BRIEF): точні очікування для виправленої партії 1 — [Offer ID, обов'язкові трійки, заборонені трійки].
const EXPECT = [
  ["1505797098", ["Кількість променів: 2"], ["Модуль лазера: 2 шт."]],
  ["2817421184", ["Кількість розеток: 2", "Розетки змінного струму 230 В: 1 × 16 А, 1 × 32 А"], ["Кількість розеток: 1 × 16 А, 1 × 32 А"]],
  ["3198171196", ["Тип посадки: Різьбове з'єднання М14"], ["Діаметр внутрішній: М14", "Діаметр внутрішній: 22.23 мм"]],
  ["1651785636", ["Вага без мережевого кабелю та бічної рукоятки: 2.7 кг"], ["Вага: 2.7 кг"]],
  ["1869167737", ["Вага без мережевого кабелю: 3.2 кг"], ["Вага: 3.2 кг"]],
  ["1898627378", ["Вага без аксесуарів: 3 кг", "Вага в спорядженому стані: 3.3 кг"], ["Вага: 5.17 кг", "Вага: 3 кг"]],
  ["3120925343", ["Вага без мережевого кабелю: 0.7 кг"], ["Вага: 0.9 кг", "Вага: 0.7 кг"]],
  ["3109257834", ["Вага: 160 г"], ["Вага: 510 г", "Вага без акумулятора: 0.16 кг"]], // рішення 0.16 кг; поле картки в грамах — 160 г
  ["3109175049", ["Вага: 1.22 кг"], []],
  ["3087509456", ["Тип штанги: Телескопічна", "Форма штанги: Пряма розсувна трубка"], ["Тип штанги: Пряма"]], // R4: поле — один вибір; форма — слова власника №68
  ["3087521840", ["Тип штанги: Телескопічна"], ["Тип штанги: Пряма", "Форма штанги: Пряма"]], // F2: «Пряма» №69 — лише XML, не owner-рішення
  ["3135267924", ["Живлення: Мережа 220 В"], ["Живлення: Мережа 230В"]],
  ["2748211367", ["Вага брутто: 10.3 кг"], ["Вага нетто: 1.3 кг", "Вага: 1.3 кг"]],
  ["2492383398", ["Акумулятор у комплекті: Так"], ["Зарядний пристрій у комплекті: Ні"]],
  ["3158153340", ["Тривалість навантаження: 40 %", "Максимальний зварювальний струм: 120 А"], ["Тривалість навантаження: 30 %", "Номінальний зварювальний струм: 200 А"]],
  ["2789189496", ["Кейс у комплекті: Ні"], []],
  ["1505797282", ["Робота в похилому положенні: Так"], ["Робота в похилому положенні: Ні"]],
  // HERMES-OV1-REV4-REVIEW: №4 — обидва значення власника користувацькою з окремою назвою; нативне real-поле 99 не отримує ні «|», ні XML 18 В.
  ["3117192884", ["Напруга акумулятора (підтверджені значення): 10,8 | 12 В"], ["Напруга акумулятору: 10,8 | 12 В", "Напруга акумулятору: 18 В"]],
];
test("OV R2–R4, R6: виправлена партія 1 на реальних даних — модулі лазера не вигадано, кількість розеток числом, М14 не в числовому отворі, кваліфікатори ваги збережено, тримери — телескопічна (форма «Пряма» №68 від власника, №69 — лише сирі XML), LEX 220 В, брутто Powercraft, DeWALT без «Ні» для зарядного; 1774128020 не змінено", { skip: !REAL }, async () => {
  const { ov, rows, refresh } = await realWorld();
  const fmtp = (x) => `${x.name}: ${x.value}${x.unit ? " " + x.unit : ""}`;
  const problems = [];
  for (const [id, must, never] of EXPECT) {
    if (!rows.has(id)) { problems.push(`${id}: немає в таблиці`); continue; }
    const p = JSON.parse(refresh(id).row["Характеристики JSON"] || "[]").map(fmtp);
    for (const m of must) if (!p.includes(m)) problems.push(`${id}: немає «${m}»`);
    for (const n of never) if (p.includes(n)) problems.push(`${id}: є заборонене «${n}»`);
  }
  // №4: під нативною назвою real-поля «Напруга акумулятору» (кат. 141713, атрибут 99) не передається жодне значення.
  if (JSON.parse(refresh("3117192884").row["Характеристики JSON"] || "[]").some((x) => x.name === "Напруга акумулятору")) problems.push("3117192884: є характеристика з нативною назвою «Напруга акумулятору»");
  // F2: для №69 3087521840 форма «Пряма» — значення XML, не рішення власника: owner-запису форми немає; сирі дані XML не знищено.
  if (ov.map.get("3087521840")?.items.some((i) => /форма штанги/i.test(i.name))) problems.push("3087521840: у файлі рішень є owner-запис форми штанги");
  const raw69 = String(refresh("3087521840").row[RAW_PARAMS] || "");
  if (!/Тип штанги/.test(raw69) || !/Прямая/.test(raw69)) problems.push("3087521840: сирі характеристики XML («Тип штанги: Прямая») не збережено");
  // 1774128020 (LEX LXCM305i) — окрема картка: рішення партії 1 для LEX 3135267924 її не чіпають (лише власні рішення 26.10);
  // за наявності прийнятого знімка N1-2-26 (MM_N12_SNAPSHOT) набір характеристик картки — той самий (порядок не порівнюється).
  if (ov.map.get("1774128020")?.items.some((i) => i.date !== "2026-10-26")) problems.push("1774128020: у файлі рішень є нові записи, крім 26.10");
  const snapFile = process.env.MM_N12_SNAPSHOT;
  if (snapFile) {
    const snap = JSON.parse(fs.readFileSync(snapFile, "utf8"));
    const set = (s) => JSON.parse(s || "[]").map(fmtp).sort().join("\n");
    if (set(refresh("1774128020").row["Характеристики JSON"]) !== set(snap.main["1774128020"].params)) problems.push("1774128020: характеристики відрізняються від прийнятого знімка N1-2-26");
  }
  assert.deepEqual(problems, []);
});