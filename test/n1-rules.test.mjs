/** Пакет N1-1 (Hermes, 27.10.2026, msg_490e3d2d810e / msg_b8352343cc0e / msg_47d547bfb269): таблиця опису з ЯВНИМ
 *  заголовком «назва | значення | умова» («Параметр | Значення | Примітка»). Передаються лише рядки з порожньою умовою;
 *  умовні, неоднозначні, з невідомою сутністю, з іншою кількістю клітинок, не характеристики — не передаються й поіменно
 *  повертаються з причиною (лишаються в описі). Таблиця з об'єднаними клітинками, інший / невідомий заголовок — без розбору.
 *  Правило діє лише з техправилом N1: валідний перелік захищених + стабільна когорта N0 (890: 678 «лише технічних» + 212
 *  порожніх) — файл поза репозиторієм з контрактом (fail-closed). Спільний descriptionPairs не змінюється. Схеми — справжні
 *  файли; товари й значення — синтетичні. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCharacteristics, conditionTablePairs, conditionTablePairsUaRu, descriptionPairs } from "../src/core/prom-attributes.mjs";
import { TECH_RULES, cohortFingerprint, freezeFingerprint, loadCohort, loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";

const catalog = loadPromCatalog(undefined, { freezeFile: "", a3PairsFile: "", n0CohortFile: "" }); // ізольовано від MM_*
const WELD = "14400101";
const B = (o) => buildCharacteristics({ schema: catalog.schemas.get(WELD), categoryId: WELD, current: [], names: catalog.names, mapping: catalog.mappings.get(WELD), units: catalog.units, mode: "main", ...o });
const N1 = { techRules: [...TECH_RULES, "N1"] };
const hard = (r) => r.needsReview.filter((x) => x.kind !== "інформаційно");
const T3 = (rows, head = ["Параметр", "Значення", "Примітка"]) => `<table><tbody><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
const ROWS_UA = [
  ["Струм холостого ходу генератора, А", "0,8", "&nbsp;"],
  ["Робоча напруга живлення, В", "165 275", "Або еквівалентний опір мережі не більше 4 Ом"],
  ["Споживана потужність, кВт, не більше", "2,7 (12 А)", "За постійного вихідного струму до 110 А"],
  ["Діапазон регулювання вихідних струмів, А", "5 160", ""],
  ["cos &phi;", "0,99", ""],
  ["Робочий діапазон температур навколишнього середовища, &deg;С", "-30&hellip;+45", ""],
];
const ROWS_RU = [
  ["Ток холостого хода генератора, А", "0,8", "&nbsp;"],
  ["Рабочее напряжение питания, В", "165 275", "Или эквивалентное сопротивление сети не более 4 Ом"],
  ["Потребляемая мощность, кВт, не более", "2,7 (12 А)", "При постоянном выходном токе до 110 А"],
  ["Диапазон регулирования выходных токов, А", "5 160", ""],
  ["cos &phi;", "0,99", ""],
  ["Рабочий диапазон температур окружающей среды, &deg;С", "-30&hellip;+45", ""],
];
const HEAD_RU = ["Параметр", "Значение", "Примечание"];

test("N1-1 розбір: лише рядки з порожньою умовою; умовні, «два числа», невідома сутність — поіменно з причиною", () => {
  const r = conditionTablePairs(T3(ROWS_UA));
  assert.deepEqual(r.pairs.map((p) => [p.key, p.value, p.via]), [
    ["Струм холостого ходу генератора, А", "0,8", "table"],
    ["Робочий діапазон температур навколишнього середовища, °С", "-30…+45", "table"],
  ]);
  const why = (k) => r.skipped.find((x) => x.key.startsWith(k))?.why || "";
  assert.match(why("Робоча напруга"), /умов/);
  assert.match(why("Споживана потужність"), /умов/);
  assert.match(why("Діапазон регулювання"), /через пробіл/);
  assert.match(why("cos"), /сутність/);
  assert.equal(r.skipped.length, 4, JSON.stringify(r.skipped));
  // межі фрагмента — рядок таблиці в оригінальному описі
  const html = T3(ROWS_UA);
  assert.ok(r.pairs.every((p) => /^<tr>[\s\S]*<\/tr>$/.test(html.slice(p.start, p.end))));
  // RU-заголовок
  assert.deepEqual(conditionTablePairs(T3(ROWS_RU, HEAD_RU)).pairs.map((p) => p.key), ["Ток холостого хода генератора, А", "Рабочий диапазон температур окружающей среды, °С"]);
});

test("N1-1 розбір: інший / невідомий заголовок, без заголовка, заголовок не першим рядком, об'єднані клітинки — без розбору", () => {
  const rows = [["Струм холостого ходу, А", "0,8", ""]];
  for (const [what, html] of [
    ["без заголовка", `<table><tr><td>Струм холостого ходу, А</td><td>0,8</td><td></td></tr></table>`],
    ["назва | одиниця | значення", T3(rows, ["Параметр", "Од. виміру", "Значення"])],
    ["значення | назва | умова", T3(rows, ["Значення", "Параметр", "Примітка"])],
    ["4 колонки", T3([["Струм, А", "0,8", "", "x"]], ["Параметр", "Значення", "Примітка", "Режим"])],
    ["2 колонки", T3([["Струм, А", "0,8"]], ["Параметр", "Значення"])],
    ["режими (230 В / 400 В)", T3(rows, ["Параметр", "230 В", "400 В"])],
    ["назва | значення | режим (третя колонка — не умова)", T3(rows, ["Параметр", "Значення", "400 В"])],
    ["заголовок другим рядком", `<table><tr><td>Технічні характеристики</td><td></td><td></td></tr><tr><th>Параметр</th><th>Значення</th><th>Примітка</th></tr><tr><td>Струм, А</td><td>0,8</td><td></td></tr></table>`],
  ]) assert.deepEqual(conditionTablePairs(html).pairs, [], what);
  const span = conditionTablePairs(`<table><tr><th>Параметр</th><th>Значення</th><th>Примітка</th></tr><tr><td rowspan="2">Споживана потужність, кВт</td><td>2,7</td><td></td></tr><tr><td>3,5</td><td></td></tr></table>`);
  assert.deepEqual(span.pairs, [], "rowspan — не зливати варіанти");
  assert.match(span.skipped[0].why, /об'єднаними/);
  const col = conditionTablePairs(`<table><tr><th>Параметр</th><th>Значення</th><th>Примітка</th></tr><tr><td colspan="3">Живлення</td></tr><tr><td>Струм, А</td><td>0,8</td><td></td></tr></table>`);
  assert.deepEqual(col.pairs, [], "colspan — без розбору");
  // рядок не з 3 клітинок усередині таблиці з правильним заголовком — не передається, поіменно
  const odd = conditionTablePairs(T3([["Струм, А", "0,8"], ["Напруга, В", "220", ""]]));
  assert.deepEqual(odd.pairs.map((p) => p.key), ["Напруга, В"]);
  assert.match(odd.skipped[0].why, /2 клітинк/);
  // повтор заголовка — пропускається без причини; порожній рядок — теж
  assert.deepEqual(conditionTablePairs(T3([["Параметр", "Значення", "Примітка"], ["", "", ""], ["Напруга, В", "220", ""]])).skipped, []);
});

test("N1-1 розбір: вкладена таблиця, додатковий рядок заголовка — без розбору; числа через пробіл (з одиницею теж) — ні; діапазони, ±, мінус — як є", () => {
  const nested = `<table><tr><th>Параметр</th><th>Значення</th><th>Примітка</th></tr><tr><td>Таблиця варіантів</td><td><table><tr><td>Напруга</td><td>230 В</td><td></td></tr><tr><td>Напруга</td><td>400 В</td><td></td></tr></table></td><td></td></tr><tr><td>Вага, кг</td><td>4,2</td><td></td></tr></table>`;
  const n = conditionTablePairs(nested);
  assert.deepEqual(n.pairs, [], "вкладена таблиця: " + JSON.stringify(n.pairs));
  assert.match(n.skipped[0].why, /вкладен/);
  const inner = `<table><tr><td><table><tr><th>Параметр</th><th>Значення</th><th>Примітка</th></tr><tr><td>Вага, кг</td><td>4,2</td><td></td></tr></table></td></tr></table>`;
  assert.deepEqual(conditionTablePairs(inner).pairs, [], "таблиця з заголовком усередині таблиці-обгортки");
  const multi = `<table><tr><th>Параметр</th><th>Значення</th><th>Примітка</th></tr><tr><th></th><th>230 В</th><th>400 В</th></tr><tr><td>Струм, А</td><td>16</td><td>10</td></tr><tr><td>Вага, кг</td><td>4,2</td><td></td></tr></table>`;
  const mh = conditionTablePairs(multi);
  assert.deepEqual(mh.pairs, [], "додатковий рядок заголовка (режими) — без розбору");
  assert.match(mh.skipped[0].why, /заголов/);
  const amb = conditionTablePairs(T3([["Діапазон струмів", "5 160 А", ""], ["Напруга", "230 400 В", ""], ["Оберти", "3 000 об/хв", ""], ["Струм, А", "5 160", ""], ["Діапазон, А", "від 5 до 160", ""]]));
  assert.deepEqual(amb.pairs.map((p) => p.value), ["від 5 до 160"], JSON.stringify(amb.pairs));
  assert.ok(amb.skipped.every((x) => /через пробіл/.test(x.why)), JSON.stringify(amb.skipped));
  const ok = conditionTablePairs(T3([["Температура, °С", "-30…+45", ""], ["Точність", "±5 %", ""], ["Температура зберігання", "-10–+40 °С", ""], ["Діаметр дроту, мм", "0,6―1,2", ""], ["Напруга", "-12 В", ""], ["Габарити, мм", "480 × 300 × 270", ""]]));
  assert.deepEqual(ok.pairs.map((p) => p.value), ["-30…+45", "±5 %", "-10–+40 °С", "0,6―1,2", "-12 В", "480 × 300 × 270"]);
  assert.deepEqual(ok.skipped, []);
});

test("N1-1 UA ↔ RU: лише ПІДТВЕРДЖЕНИЙ ключ (погоджена повна пара) того самого рядка; позиція й однакові числа — не доказ; RU окремо — ніколи", () => {
  // переставлені ключі з однаковими значеннями на тих самих позиціях (RED Hermes): нічого не підтверджено
  const perm = conditionTablePairsUaRu(T3([["Напруга, В", "220", ""], ["Струм, А", "10", ""]]), T3([["Ток, А", "220", ""], ["Напряжение, В", "10", ""]], HEAD_RU));
  assert.deepEqual([perm.pairs, perm.conflicts], [[], []], JSON.stringify(perm));
  assert.equal(perm.skipped.length, 2);
  assert.ok(perm.skipped.every((x) => /ключ/.test(x.why)), JSON.stringify(perm.skipped));
  // погоджені повні пари (ціле поле з одиницею): той самий запис — UA; різні значення — справжній конфлікт (не лише аудит)
  const ok = conditionTablePairsUaRu(T3([["Струм холостого ходу генератора, А", "0,8", ""], ["Робочий діапазон температур навколишнього середовища, °С", "-30…+45", ""]]), T3([["Ток холостого хода генератора, А", "0,8", ""], ["Рабочий диапазон температур окружающей среды, °С", "-30…+45", ""]], HEAD_RU));
  assert.deepEqual(ok.pairs.map((p) => [p.key, p.value]), [["Струм холостого ходу генератора, А", "0,8"], ["Робочий діапазон температур навколишнього середовища, °С", "-30…+45"]]);
  const cf = conditionTablePairsUaRu(T3([["Струм холостого ходу генератора, А", "0,8", ""]]), T3([["Ток холостого хода генератора, А", "0,9", ""]], HEAD_RU));
  assert.deepEqual([cf.pairs, cf.conflicts.map((x) => [x.key, x.ua, x.ru])], [[], [["Струм холостого ходу генератора, А", "0,8", "0,9"]]]);
  // контекст у ключі: інша одиниця, інша мережа (230 / 400 В), макс. / мін. — не та сама характеристика
  for (const [u, r] of [["Струм холостого ходу генератора, А", "Ток холостого хода генератора, мА"], ["Струм холостого ходу генератора, А", "Максимальный ток холостого хода генератора, А"], ["Струм холостого ходу генератора (230 В), А", "Ток холостого хода генератора (400 В), А"], ["Струм холостого ходу генератора, А (макс.)", "Ток холостого хода генератора, А"]]) {
    const x = conditionTablePairsUaRu(T3([[u, "0,8", ""]]), T3([[r, "0,8", ""]], HEAD_RU));
    assert.deepEqual([x.pairs, x.conflicts], [[], []], u + " / " + r);
    assert.match(x.skipped[0].why, /ключ/);
  }
  // невідомі ключі (немає серед погоджених пар) — лише аудит, не конфлікт
  const unk = conditionTablePairsUaRu(T3([["ККД, %", "88", ""]]), T3([["КПД, %", "87", ""]], HEAD_RU));
  assert.deepEqual([unk.pairs, unk.conflicts], [[], []]);
  assert.match(unk.skipped[0].why, /ключ/);
  // ключ підтверджено, але рядок в іншому місці — не підтверджено (позиція — додатковий запобіжник)
  const order = conditionTablePairsUaRu(T3([["Струм холостого ходу генератора, А", "0,8", ""], ["Робочий діапазон температур навколишнього середовища, °С", "-30…+45", ""]]), T3([["Рабочий диапазон температур окружающей среды, °С", "-30…+45", ""], ["Ток холостого хода генератора, А", "0,8", ""]], HEAD_RU));
  assert.deepEqual([order.pairs, order.conflicts], [[], []]);
  assert.ok(order.skipped.every((x) => /порядок|ключ/.test(x.why)), JSON.stringify(order.skipped));
  // доказова рівнозначність значень (sameVal генератора) — лише після підтвердженого ключа
  assert.deepEqual(conditionTablePairsUaRu(T3([["ККД, %", "0,8", ""]]), T3([["КПД, %", "0.8", ""]], HEAD_RU), { sameVal: () => true }).pairs, [], "ключ не погоджено — sameVal не рятує");
  const eqv = conditionTablePairsUaRu(T3([["Струм холостого ходу генератора, А", "0,8", ""]]), T3([["Ток холостого хода генератора, А", "0.8", ""]], HEAD_RU), { sameVal: (a, b) => a.replace(",", ".") === b.replace(",", ".") });
  assert.deepEqual([eqv.pairs.map((p) => p.value), eqv.conflicts], [["0,8"], []], "доказова рівнозначність (десятковий роздільник) — не конфлікт");
  // UA втратив роздільники / RU з умовою — не передається
  const lost = conditionTablePairsUaRu(T3([["Струм холостого ходу генератора, А", "5 160", ""], ["Робочий діапазон температур навколишнього середовища, °С", "-30…+45", ""]]), T3([["Ток холостого хода генератора, А", "5―160", ""], ["Рабочий диапазон температур окружающей среды, °С", "-30…+45", "При 230 В"]], HEAD_RU));
  assert.deepEqual(lost.pairs, []);
  assert.match(lost.skipped[0].why, /через пробіл/);
  assert.match(lost.skipped[1].why, /RU-рядок/);
  assert.ok([...perm.skipped, ...lost.skipped].every((x) => x.lang === "ua"));
  // немає RU-таблиці, інша кількість таблиць або рядків — UA не підтверджено, нічого не передається
  assert.deepEqual(conditionTablePairsUaRu(T3([["Струм холостого ходу генератора, А", "0,8", ""]]), "").pairs, []);
  assert.match(conditionTablePairsUaRu(T3([["Струм холостого ходу генератора, А", "0,8", ""]]), "<p>Текст</p>").skipped[0].why, /немає паралельної/);
  assert.deepEqual(conditionTablePairsUaRu(T3([["Струм холостого ходу генератора, А", "0,8", ""], ["Вага, кг", "4,2", ""]]), T3([["Ток холостого хода генератора, А", "0,8", ""]], HEAD_RU)).pairs, [], "кількість рядків різна");
  // RU-таблиця без розбору (об'єднані клітинки) — UA не підтверджено, причина в аудиті саме «RU-таблиця: …»
  const ruSpan = conditionTablePairsUaRu(T3([["Струм холостого ходу генератора, А", "0,8", ""]]), `<table><tr><th>Параметр</th><th>Значение</th><th>Примечание</th></tr><tr><td rowspan="2">Ток холостого хода генератора, А</td><td>0,8</td><td></td></tr></table>`);
  assert.deepEqual(ruSpan.pairs, []);
  assert.match(ruSpan.skipped[0].why, /^RU-таблиця: .*об'єднаними/);
  // лише RU-таблиця — нічого (RU окремо не передається), поіменна причина
  const ro = conditionTablePairsUaRu("<p>Текст</p>", T3([["Ток холостого хода генератора, А", "0,8", ""]], HEAD_RU));
  assert.deepEqual([ro.pairs, ro.skipped.map((x) => x.lang)], [[], ["ru"]]);
});

test("N1-1 погоджені повні пари ключів SSVA (ціла назва + одиниця + уточнення); інше написання / уточнення — ні", () => {
  const PAIRS = [
    ["Номінальна напруга живлення, В", "Номинальное напряжение питания, B", "220"],
    ["Максимальний струм короткого замикання, А", "Максимальный ток короткого замыкания, А", "~ 250"],
    ["ККД, %, не менше", "КПД, %, не менее", "88"],
    ["Габаритні розміри (Д×Ш×В), мм", "Габаритные размеры (Д×Ш×В), мм", "480 × 300 × 270"],
    ["Потужність холостого ходу, Вт, не більше", "Потребляемая мощность холостого хода, Вт, не более", "35"],
    ["Споживана потужність, кВА, не більше", "Потребляемая мощность, кВА, не более", "17"],
    ["Номінальний струм автоматичного вимикача, А", "Номинальный ток автоматического выключателя, А", "40"],
    ["Опір ізоляції за напруги 2,5 кВ, МОм, не менше", "Сопротивление изоляции, при напряжении 2,5 кВ, МОм, не менее", "50"],
    ["Режими роботи", "Режимы работы", "MIG/MAG/MMA/TIG"],
  ];
  const r = conditionTablePairsUaRu(T3(PAIRS.map(([u, , v]) => [u, v, ""])), T3(PAIRS.map(([, q, v]) => [q, v, ""]), HEAD_RU));
  assert.deepEqual(r.pairs.map((p) => [p.key, p.value]), PAIRS.map(([u, , v]) => [u, v]), JSON.stringify(r.skipped));
  // інше написання (кирилична «В» замість латинської «B» у джерелі), інше уточнення (мережа 220 В, 16 А; кВт ≠ кВА) — не погоджено
  for (const [u, q] of [["Номінальна напруга живлення, В", "Номинальное напряжение питания, В"], ["Споживана потужність, кВА, не більше", "Потребляемая мощность (бытовая сеть 220 В, 16 А), кВт, не более"], ["ККД, %, не менше", "КПД, %"]]) {
    const x = conditionTablePairsUaRu(T3([[u, "17", ""]]), T3([[q, "17", ""]], HEAD_RU));
    assert.deepEqual([x.pairs, x.conflicts], [[], []], u + " / " + q);
  }
});

test("N1-1 IP-код (лише ступінь захисту): «ІР23» (кирилиця) = «IP23» → «IP23»; IR23 / IP32 / IP24 / не IP-код — ні; інший ключ — без нормалізації", () => {
  const ip = (ua, ru, ku = "Ступінь захисту", kr = "Степень защиты") => conditionTablePairsUaRu(T3([[ku, ua, ""]]), T3([[kr, ru, ""]], HEAD_RU));
  assert.deepEqual(ip("ІР23", "IP23").pairs.map((p) => p.value), ["IP23"]);
  assert.deepEqual(ip("IP23", "ІР23").pairs.map((p) => p.value), ["IP23"]);
  assert.deepEqual(ip("ІР54", "ІР54").pairs.map((p) => p.value), ["IP54"], "обидва кирилицею — теж код IP");
  for (const [ua, ru] of [["IR23", "IP23"], ["IP32", "IP23"], ["ІР24", "IP23"], ["ІР23", "IP23X"], ["ІР 2З", "IP23"]]) {
    const x = ip(ua, ru);
    assert.deepEqual(x.pairs, [], ua + " / " + ru);
    assert.equal(x.conflicts.length, 1, ua + " / " + ru + " — ключ підтверджено, значення різні");
  }
  // поза ключем ступеня захисту — без IP-нормалізації (той самий запис — як є, інший — конфлікт)
  const other = conditionTablePairsUaRu(T3([["Режими роботи", "ІР23", ""]]), T3([["Режимы работы", "IP23", ""]], HEAD_RU));
  assert.deepEqual([other.pairs, other.conflicts.length], [[], 1]);
  // генератор: ready-значення — латинський код
  const g = B({ descUa: T3([["Ступінь захисту", "ІР23", ""]]), descRu: T3([["Степень защиты", "IP23", ""]], HEAD_RU), ...N1 });
  assert.ok(g.params.some((p) => /захисту/i.test(p.name) && p.value === "IP23"), JSON.stringify(g.params));
  assert.deepEqual(hard(g), []);
  assert.equal(hard(B({ descUa: T3([["Ступінь захисту", "IP32", ""]]), descRu: T3([["Степень защиты", "IP23", ""]], HEAD_RU), ...N1 })).length, 1, "IP32 ≠ IP23 — жорстка позначка");
});

test("N1-1 той самий атрибут схеми ≠ той самий ключ: «Напруга холостого ходу, В» ↔ «Напряжение холостого хода, кВ» (обидва → 6978) — не підтверджено", async () => {
  const { normName } = await import("../src/core/prom-attributes.mjs");
  const base = catalog.mappings.get(WELD) || { synonyms: {}, values: {} };
  const mapping = { ...base, synonyms: { ...(base.synonyms || {}), [normName("Напруга холостого ходу, В")]: "6978", [normName("Напряжение холостого хода, кВ")]: "6978" } };
  const r = B({ mapping, descUa: T3([["Напруга холостого ходу, В", "220", ""]]), descRu: T3([["Напряжение холостого хода, кВ", "220", ""]], HEAD_RU), ...N1 });
  assert.deepEqual([r.params, r.tableConflicts], [[], []], "220 В ≠ 220 кВ: " + JSON.stringify(r.params));
  assert.match(r.tableSkipped[0].why, /ключ/);
  // і з однаковою одиницею схема / словник ключ N1-1 не підтверджують — лише погоджені повні пари
  const same = B({ mapping, descUa: T3([["Напруга холостого ходу, В", "220", ""]]), descRu: T3([["Напряжение холостого хода, кВ", "230", ""]], HEAD_RU), ...N1 });
  assert.deepEqual([same.params, hard(same)], [[], []]);
});

test("N1-1 розбір: реклама / речення / порожнє значення — не характеристика; спільний descriptionPairs без змін", () => {
  const r = conditionTablePairs(T3([
    ["Переваги", "Надійний і зручний апарат для дому, гаража та дачі, який служить роками без ремонту.", ""],
    ["Рекомендуємо", "переглянути інші моделі", ""],
    ["Вага, кг", "", ""],
    ["Вага, кг", "4,2", ""],
  ]));
  assert.deepEqual(r.pairs.map((p) => [p.key, p.value]), [["Вага, кг", "4,2"]]);
  assert.equal(r.skipped.length, 3, JSON.stringify(r.skipped));
  // descriptionPairs (без режиму, черга, нові, захищені) — 3-колонкова таблиця як раніше не дає пар
  assert.deepEqual(descriptionPairs(T3(ROWS_UA)), []);
});

test("N1-1 генератор: лише з N1; підтверджений ключ з різними UA / RU значеннями — конфлікт (жорстка позначка); два різні значення одного ключа — конфлікт; рішення власника вище", () => {
  const ua = T3(ROWS_UA), ru = T3(ROWS_RU, HEAD_RU);
  const off = B({ descUa: ua, descRu: ru, techRules: [...TECH_RULES] });
  assert.deepEqual([off.params, off.needsReview], [[], []], "без N1 — як раніше (порожня)");
  const on = B({ descUa: ua, descRu: ru, ...N1 });
  assert.ok(on.params.some((p) => /Струм холостого ходу генератора/.test(p.name) && /0[,.]8/.test(p.value)), JSON.stringify(on.params));
  assert.ok(on.params.some((p) => /Робочий діапазон температур/.test(p.name) && p.value === "-30…+45"), JSON.stringify(on.params));
  assert.ok(!on.params.some((p) => /Робоча напруга|Споживана потужність|Діапазон регулювання|cos/.test(p.name)), "умовні / неоднозначні не передано");
  assert.deepEqual(hard(on), [], JSON.stringify(on.needsReview));
  assert.equal(on.tableSkipped.length, 4, "поіменно (UA-рядки; RU — лише перевірка)");
  assert.ok(!on.params.some((p) => /Ток холостого|Рабочий диапазон|Рабочее напряжение/.test(p.name)), "RU-рядки окремо не передаються: " + JSON.stringify(on.params));
  assert.ok(on.tableSkipped.every((x) => x.lang && x.why));
  assert.ok(on.notes.some((n) => /Параметр \| Значення \| Примітка/.test(n)), JSON.stringify(on.notes));
  assert.equal(on.uaRuMerged, 0, "N1-пари — лише в UA-проході (RU-прохід їх не отримує й нічого не «зливає»)");
  // UA / RU з різними числами — не зливаються
  const diff = B({ descUa: T3([["Струм холостого ходу генератора, А", "0,8", ""]]), descRu: T3([["Ток холостого хода генератора, А", "0,9", ""]], HEAD_RU), ...N1 });
  assert.deepEqual(diff.params, [], "UA ≠ RU — не передається (ні UA, ні RU): " + JSON.stringify(diff.params));
  assert.equal(hard(diff).length, 1, "справжній конфлікт видно (картка не ready): " + JSON.stringify(diff.needsReview));
  assert.match(hard(diff)[0].reason, /UA і RU значення відрізняються/);
  // з іншим підтвердженим рядком картка не стає ready, конфлікт не ховається
  const mixed = B({ descUa: T3([["Струм холостого ходу генератора, А", "0,8", ""], ["Робочий діапазон температур навколишнього середовища, °С", "-30…+45", ""]]), descRu: T3([["Ток холостого хода генератора, А", "0,9", ""], ["Рабочий диапазон температур окружающей среды, °С", "-30…+45", ""]], HEAD_RU), ...N1 });
  assert.ok(mixed.params.some((p) => /Робочий діапазон/.test(p.name)) && hard(mixed).length === 1, JSON.stringify([mixed.params, mixed.needsReview]));
  // словник назв / схема генератора ключ N1-1 не підтверджують («Напряжение питания» = «Напруга живлення» у словнику — однаково
  // лише аудит); «Максимальный ток» ≠ «Мінімальний струм», однаковий текст ключа — теж ні
  for (const [ku, kr] of [["Напруга живлення", "Напряжение питания"], ["Мінімальний струм", "Максимальный ток"], ["Вага, кг", "Вес, кг"], ["Режим ТН", "Режим ТН"]]) {
    const x = B({ descUa: T3([[ku, "20", ""]]), descRu: T3([[kr, "20", ""]], HEAD_RU), ...N1 });
    assert.deepEqual([x.params, x.needsReview], [[], []], ku + " / " + kr);
    assert.match(x.tableSkipped[0].why, /ключ/, ku);
  }
  // погоджена пара, значення різні — справжній конфлікт; лише словник — ні (аудит)
  assert.equal(hard(B({ descUa: T3([["Номінальна напруга живлення, В", "220", ""]]), descRu: T3([["Номинальное напряжение питания, B", "230", ""]], HEAD_RU), ...N1 })).length, 1);
  assert.equal(hard(B({ descUa: T3([["Напруга живлення", "220 В", ""]]), descRu: T3([["Напряжение питания", "230 В", ""]], HEAD_RU), ...N1 })).length, 0);
  // доказові рівнозначності значень після погодженого ключа: десятковий роздільник (sameValueIn), формат запису (А1) — не конфлікт
  const dec = B({ descUa: T3([["Струм холостого ходу генератора, А", "0,8", ""]]), descRu: T3([["Ток холостого хода генератора, А", "0.8", ""]], HEAD_RU), ...N1 });
  assert.deepEqual([dec.params.map((p) => p.value), hard(dec)], [["0,8"], []], JSON.stringify(dec.needsReview));
  const fmtA1 = B({ descUa: T3([["Максимальний струм короткого замикання, А", "~ 250", ""]]), descRu: T3([["Максимальный ток короткого замыкания, А", "~250", ""]], HEAD_RU), ...N1 });
  assert.deepEqual([fmtA1.params.map((p) => p.value), hard(fmtA1)], [["~ 250"], []], JSON.stringify(fmtA1.needsReview));
  // невідомі ключі — не конфлікт і не характеристика (лише аудит)
  const unk = B({ descUa: T3([["ККД, %", "88", ""]]), descRu: T3([["КПД, %", "87", ""]], HEAD_RU), ...N1 });
  assert.deepEqual([unk.params, unk.needsReview], [[], []]);
  assert.match(unk.tableSkipped[0].why, /ключ/);
  // той самий ключ двічі з різними значеннями (умову не вказано) — конфлікт, не вибір одного
  const twice = B({ descUa: T3([["Струм холостого ходу генератора, А", "0,8", ""], ["Струм холостого ходу генератора, А", "1,0", ""]]), descRu: T3([["Ток холостого хода генератора, А", "0,8", ""], ["Ток холостого хода генератора, А", "1,0", ""]], HEAD_RU), ...N1 });
  assert.ok(hard(twice).length >= 1, JSON.stringify(twice.needsReview));
  assert.ok(!twice.params.some((p) => /Струм холостого ходу/.test(p.name) && /0[,.]8/.test(p.value)) || !twice.params.some((p) => /Струм холостого ходу/.test(p.name) && /1[,.]0/.test(p.value)));
  // рішення власника — вище за N1
  const own = B({ descUa: T3([["Струм холостого ходу генератора, А", "0,8", ""]]), descRu: T3([["Ток холостого хода генератора, А", "0,8", ""]], HEAD_RU), ...N1, ownerValues: [{ name: "Струм холостого ходу генератора, А", value: "1,2", action: "set", source: "тест", date: "2026-10-27", priority: 1, autoUpdate: false }] });
  assert.ok(own.params.some((p) => /Струм холостого ходу генератора/.test(p.name) && /1[,.]2/.test(p.value)), JSON.stringify(own.params));
  assert.ok(!own.params.some((p) => /Струм холостого ходу генератора/.test(p.name) && /0[,.]8/.test(p.value)));
  // повторний запуск стабільний
  const again = B({ descUa: ua, descRu: ru, current: on.params, provenance: on.provenance, ...N1 });
  assert.deepEqual(again.params, on.params);
  assert.equal(again.changed, false);
});

// ---------- когорта N0 (поза репозиторієм) + контракт ----------
const scopeOf = (ids) => [...new Set([...ids, "90", "222", "333"])];
const freezeFileOf = (ids, scope = scopeOf(ids)) => ({ v: 1, rev: 1, date: "2026-10-27", source: "тест", count: ids.length, ids, scope: { count: scope.length, ids: scope } });
const freezeContractOf = (ids, scope = scopeOf(ids)) => ({ v: 1, rev: 1, date: "2026-10-27", source: "тест", count: ids.length, fingerprint: freezeFingerprint(ids), scope: { count: scope.length, fingerprint: freezeFingerprint(scope) } });
const cohortFileOf = (ids, more = {}) => ({ v: 1, rev: 1, date: "2026-10-27", source: "тест", count: ids.length, fingerprint: cohortFingerprint(ids), ids, ...more });
const cohortContractOf = (ids, more = {}) => ({ v: 1, rev: 1, date: "2026-10-27", source: "тест", count: ids.length, fingerprint: cohortFingerprint(ids), ...more });
const env = ({ cohort = cohortFileOf(["90"]), contract = cohortContractOf(["90"]), protectedIds = ["91"], freezeOk = true } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n1-"));
  const w = (n, x) => { const f = path.join(dir, n); if (x !== null) fs.writeFileSync(f, typeof x === "string" ? x : JSON.stringify(x)); return f; };
  const ff = w("freeze.json", freezeOk ? freezeFileOf(protectedIds) : "{ зламаний"), fk = w("freeze-contract.json", freezeContractOf(protectedIds));
  const cf = w("cohort.json", cohort), ck = w("cohort-contract.json", contract);
  const cat = loadPromCatalog(undefined, { freezeFile: ff, freezeContractFile: fk, a3PairsFile: "", n0CohortFile: cf, n0CohortContractFile: ck });
  return { dir, cat, cf, ck, ff, fk };
};
const rm = (e) => fs.rmSync(e.dir, { recursive: true, force: true });

test("когорта N0: валідна — N1 лише для когорти в області дії (не захищені); решта правил — як раніше", () => {
  const e = env({ cohort: cohortFileOf(["90", "222"]), contract: cohortContractOf(["90", "222"]) });
  assert.equal(e.cat.cohortInfo.valid, true, JSON.stringify(e.cat.problems));
  assert.deepEqual([e.cat.cohortInfo.count, e.cat.cohortInfo.rev], [2, 1]);
  assert.deepEqual(e.cat.techRulesFor("90"), [...TECH_RULES, "N1"]);
  assert.deepEqual(e.cat.techRulesFor("222"), [...TECH_RULES, "N1"]);
  assert.deepEqual(e.cat.techRulesFor("333"), [...TECH_RULES], "в області, поза когортою — без N1");
  assert.deepEqual(e.cat.techRulesFor("91"), [], "захищений");
  assert.deepEqual(e.cat.techRulesFor("95"), [], "поза областю");
  assert.deepEqual(e.cat.problems.filter((p) => /когорт/i.test(p)), []);
  rm(e);
  const none = loadPromCatalog(undefined, { freezeFile: "", a3PairsFile: "", n0CohortFile: "" });
  assert.deepEqual([none.techRulesFor("90"), none.cohortInfo.valid], [[], false]);
});

test("когорта N0 + новий захищений (нове питання власника з 678): N1 вимкнено лише йому, решті когорти — як було; старі захищені — ні", () => {
  const e = env({ cohort: cohortFileOf(["90", "222", "91"]), contract: cohortContractOf(["90", "222", "91"]), protectedIds: ["91", "222"] });
  assert.equal(e.cat.cohortInfo.valid, true, JSON.stringify(e.cat.problems));
  assert.deepEqual(e.cat.techRulesFor("90"), [...TECH_RULES, "N1"]);
  assert.deepEqual(e.cat.techRulesFor("222"), [], "новий захищений у когорті");
  assert.deepEqual(e.cat.techRulesFor("91"), [], "старий захищений у когорті");
  assert.deepEqual(e.cat.problems.filter((p) => /когорт/i.test(p)), []);
  rm(e);
});

test("когорта N0 fail-closed: немає / пошкоджена / порожня / неповна / інша / без контракту / товар поза областю / недійсний перелік захищених — N1 ні для кого", () => {
  const ids = ["90", "222"];
  const cases = [
    ["файлу немає", { cohort: null }],
    ["пошкоджений JSON", { cohort: "{ зламаний" }],
    ["порожній перелік", { cohort: cohortFileOf([]), contract: cohortContractOf([]) }],
    ["count ≠ ids", { cohort: cohortFileOf(ids, { count: 3 }) }],
    ["повтор ID", { cohort: { ...cohortFileOf(ids), ids: ["90", "90"], count: 2 } }],
    ["не числовий ID", { cohort: cohortFileOf(["90", "x1"]), contract: cohortContractOf(["90", "x1"]) }],
    ["відбиток у файлі інший", { cohort: { ...cohortFileOf(ids), fingerprint: cohortFingerprint(["90"]) } }],
    ["немає v", { cohort: { ...cohortFileOf(ids), v: undefined } }],
    ["без контракту", { cohort: cohortFileOf(ids), contract: null }],
    ["контракт пошкоджений", { cohort: cohortFileOf(ids), contract: "{" }],
    ["контракт: інший count", { cohort: cohortFileOf(ids), contract: cohortContractOf(ids, { count: 3 }) }],
    ["контракт: інший відбиток", { cohort: cohortFileOf(ids), contract: cohortContractOf(["90", "333"], { count: 2 }) }],
    ["контракт: інша ревізія", { cohort: cohortFileOf(ids), contract: cohortContractOf(ids, { rev: 2 }) }],
    ["контракт: інша дата", { cohort: cohortFileOf(ids), contract: cohortContractOf(ids, { date: "2026-10-28" }) }],
    ["інший набір тієї ж довжини", { cohort: cohortFileOf(["90", "333"]), contract: cohortContractOf(ids) }],

    ["у когорті товар поза областю", { cohort: cohortFileOf(["90", "95"]), contract: cohortContractOf(["90", "95"]) }],
    ["перелік захищених недійсний", { cohort: cohortFileOf(ids), contract: cohortContractOf(ids), freezeOk: false }],
  ];
  for (const [what, o] of cases) {
    const e = env({ cohort: cohortFileOf(ids), contract: cohortContractOf(ids), ...o });
    for (const id of ["90", "222", "333", "91", "95"]) assert.ok(!e.cat.techRulesFor(id).includes("N1"), `${what}: ${id}`);
    assert.equal(e.cat.cohortInfo.valid, false, what);
    if (o.freezeOk !== false) {
      assert.deepEqual(e.cat.techRulesFor("90"), [...TECH_RULES], `${what}: A1 / A2 діють як раніше`);
      assert.ok(e.cat.problems.some((p) => /когорт/i.test(p)), `${what}: ${JSON.stringify(e.cat.problems)}`);
    } else assert.deepEqual(e.cat.techRulesFor("90"), [], what);
    rm(e);
  }
  // loadCohort окремо: без файлу — не валідна й без проблем (як не задано)
  assert.deepEqual([loadCohort("").valid, loadCohort("").problems], [false, []]);
});

test("N1-1 синхронізація: лише refreshMainRow для когорти; поза когортою, захищений, без когорти — рядок як раніше; черга й нові — як раніше", async () => {
  const { refreshMainRow, refreshQueueRow, candidateRow } = await import("../src/core/sheet-sync.mjs");
  const e = env({ cohort: cohortFileOf(["90"]), contract: cohortContractOf(["90"]) });
  const noCohort = loadPromCatalog(undefined, { freezeFile: e.ff, freezeContractFile: e.fk, a3PairsFile: "", n0CohortFile: "" });
  const full = { params: [], pictures: [], descriptionUa: T3(ROWS_UA), descriptionRu: T3(ROWS_RU, HEAD_RU) };
  const row = (id) => ({ "Offer ID": id, "ID постачальника": id, "Категорія Prom ID": WELD, "Виробник": "Test", "Характеристики JSON": "[]", "Назва постачальника UA": "Апарат тестовий", "Назва постачальника RU": "" });
  const offer = (id) => ({ id, vendor: "Test", sku: "", nameUa: "Апарат тестовий", nameRu: "", price: 100, available: true, currency: "UAH" });
  const run = (id, c) => refreshMainRow(row(id), offer(id), full, { stamp: "2026-10-27T10:00:00.000Z", catalog: c }).row;
  const params = (r) => JSON.parse(r["Характеристики JSON"]);
  const a = run("90", e.cat);
  assert.ok(params(a).some((p) => /Струм холостого ходу генератора/.test(p.name)), a["Характеристики JSON"]);
  assert.deepEqual(params(run("90", noCohort)), [], "без когорти — як до N1 (А2 таблицю з 3 колонками не розбирає)");
  for (const [what, id] of [["поза когортою", "222"], ["захищений", "91"], ["поза областю", "95"]]) assert.deepEqual(run(id, e.cat), run(id, noCohort), what);
  // повторний запуск стабільний
  const again = refreshMainRow(a, offer("90"), full, { stamp: "2026-10-27T11:00:00.000Z", catalog: e.cat });
  assert.equal(again.row["Характеристики JSON"], a["Характеристики JSON"]);
  assert.equal(again.params, false);
  // черга й нові кандидати — без N1 (однаково з когортою й без)
  const pricing = JSON.parse(fs.readFileSync(new URL("../config/default.json", import.meta.url), "utf8")).pricing;
  const pc = { date: "2026-10-27", map: new Map([["90", WELD]]) };
  const on = { ...e.cat, promCategories: pc }, off = { ...noCohort, promCategories: pc };
  const qo = { ...offer("90"), nameRu: "Аппарат", url: "https://example.com/p.html", quantity: "" };
  const ca = candidateRow(qo, full, "2026-10-27T10:00:00.000Z", pricing, on), cb = candidateRow(qo, full, "2026-10-27T10:00:00.000Z", pricing, off);
  assert.deepEqual(ca, cb, "новий товар");
  assert.deepEqual(refreshQueueRow({ ...ca, "Категорія Prom ID": WELD }, qo, full, { stamp: "2026-10-27T11:00:00.000Z", catalog: on }).row, refreshQueueRow({ ...cb, "Категорія Prom ID": WELD }, qo, full, { stamp: "2026-10-27T11:00:00.000Z", catalog: off }).row, "черга");
  // попередження: перелік захищених валідний, а когорти немає
  const { WatchSim } = await import("./helpers/watch-sim.mjs");
  const w = await new WatchSim({ catalog: noCohort }).start();
  assert.ok(w.warnings.some((x) => /правила N1 не активні/.test(x)), JSON.stringify(w.warnings));
  rm(e);
});

test("локально: когорта N0 (MM_N0_COHORT) точно відповідає контракту репозиторію і переліку захищених", { skip: !(process.env.MM_N0_COHORT && process.env.MM_FREEZE_IDS) && "немає MM_N0_COHORT / MM_FREEZE_IDS" }, () => {
  const c = loadPromCatalog(undefined, { a3PairsFile: "" });
  const k = JSON.parse(fs.readFileSync(new URL("../schemas/prom/n0-cohort-contract.json", import.meta.url), "utf8"));
  assert.deepEqual([c.cohortInfo.valid, c.cohortInfo.count, c.cohortInfo.rev], [true, k.count, k.rev], JSON.stringify(c.problems));
});
