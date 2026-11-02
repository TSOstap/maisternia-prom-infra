/** Пріоритет власника (фінальні вимоги 29.10.2026, розд. 1–3 і тести приймання 2–5, 8, 10, 11): попольовий стан S / C,
 *  виявлення ручних змін (подія або розбіжність), попередження «було → стало» без блокування, характеристики поштучно. */
import test from "node:test";
import assert from "node:assert/strict";
import { SRC, STATE_COLUMN, PARAMS_FIELD, readState, writeState, emptyState, detectEdits, applySupplier, acceptSupplier, markCustom, customFields, hv } from "../src/core/field-control.mjs";

const AT1 = "2026-10-30T08:00:00Z", AT2 = "2026-10-30T12:00:00Z", AT3 = "2026-10-30T16:00:00Z";
const ctx = { offerId: "3000000001", sku: "YT-2170", name: "Ключ", source: "YML постачальника" };
const P = (list) => JSON.stringify(list);
/** Запропонований конвеєром рядок (як якби всі поля вів постачальник): сирі колонки + ефективні = сирі. */
const proposedFrom = (raw) => ({
  "Назва UA": raw.nameUa, "Назва RU": raw.nameRu, "Опис UA": raw.descUa, "Опис RU": raw.descRu, [PARAMS_FIELD]: P(raw.params),
  "Назва постачальника UA": raw.nameUa, "Назва постачальника RU": raw.nameRu, "Опис постачальника UA": raw.descUa, "Опис постачальника RU": raw.descRu,
  "Характеристики постачальника JSON": P(raw.params), "Ціна": raw.price, "Наявність": raw.avail,
});
/** Один цикл синхронізації над рядком: виявлення → застосування; стан пишеться в той самий рядок. */
function cycle(row, raw, { edited = new Set(), at = AT2 } = {}) {
  const st0 = readState(row[STATE_COLUMN]);
  const d = detectEdits({ row, state: st0, edited, at });
  const a = applySupplier({ row, proposed: proposedFrom(raw), state: d.state, ctx, at });
  return { row: { ...a.row, [STATE_COLUMN]: writeState(a.state) }, warnings: a.warnings, changes: d.changes, rawChanged: a.rawChanged, state: a.state };
}
const RAW1 = { nameUa: "Ключ металевий Yato", nameRu: "Ключ металлический Yato", descUa: "<p>У комплекті кейс</p>", descRu: "<p>В комплекте кейс</p>", params: [{ name: "Розмір", value: "17", unit: "мм" }, { name: "Матеріал", value: "сталь" }], price: "100", avail: "true" };
const fresh = () => cycle({}, RAW1, { at: AT1 }).row; // новий товар: усе веде постачальник

test("2: нове поле ще не кастомне — нова назва постачальника застосовується", () => {
  const r0 = fresh();
  assert.equal(r0["Назва UA"], "Ключ металевий Yato");
  const r1 = cycle(r0, { ...RAW1, nameUa: "Yato ключ розвідний" });
  assert.equal(r1.row["Назва UA"], "Yato ключ розвідний");
  assert.equal(r1.warnings.length, 0, "поле постачальника — без попереджень");
  assert.deepEqual(r1.rawChanged, ["Назва постачальника UA"]);
});

test("3 + 4: власник змінив назву — постачальник її не перезаписує; інші поля далі веде постачальник", () => {
  const r0 = fresh();
  const edited = { ...r0, "Назва UA": "Ключ розвідний Yato 250 мм" }; // ручна правка (подію пропущено — виявлення за розбіжністю)
  const r1 = cycle(edited, { ...RAW1, nameUa: "Yato ключ розвідний", descUa: "<p>Новий опис постачальника</p>" });
  assert.equal(r1.row["Назва UA"], "Ключ розвідний Yato 250 мм", "наша назва");
  assert.equal(r1.row["Опис UA"], "<p>Новий опис постачальника</p>", "опис ще не кастомний — оновився");
  assert.deepEqual(r1.changes, [{ field: "Назва UA", by: "diff" }]);
  assert.equal(r1.row["Назва постачальника UA"], "Yato ключ розвідний", "сире значення збережено окремо");
  assert.deepEqual(customFields(r1.state), ["Назва UA"]);
  assert.equal(r1.warnings.length, 1, "сире джерело кастомного поля змінилось — попередження");
});

test("5: кастомне значення збігається з постачальником — кастомність не втрачається; подія редагування з тим самим значенням → C", () => {
  const r0 = fresh();
  const r1 = cycle({ ...r0, "Назва UA": "Yato ключ розвідний" }, RAW1).row;      // власник ввів своє
  const r2 = cycle(r1, { ...RAW1, nameUa: "Yato ключ розвідний" });             // постачальник «наздогнав» — збіг
  assert.equal(readState(r2.row[STATE_COLUMN]).f["Назва UA"].s, SRC.CUSTOM);
  const r3 = cycle(r2.row, { ...RAW1, nameUa: "Інша назва постачальника" });
  assert.equal(r3.row["Назва UA"], "Yato ключ розвідний", "лишилась наша");
  // Власник уводить у S-поле те саме значення, що вже є: розбіжності немає, але є подія редагування.
  const r4 = cycle(fresh(), RAW1, { edited: new Set(["Опис UA"]) });
  assert.equal(readState(r4.row[STATE_COLUMN]).f["Опис UA"].s, SRC.CUSTOM);
  assert.deepEqual(r4.changes, [{ field: "Опис UA", by: "edit" }]);
});

test("8 + приклад Zegor: постачальник змінив сирий опис кастомного поля — попередження «було → стало», наш опис без кейса", () => {
  const ours = "<p>Кейс до комплекту не входить</p>";
  const r1 = cycle({ ...fresh(), "Опис UA": ours }, RAW1).row;
  const r2 = cycle(r1, { ...RAW1, descUa: "<p>У комплекті кейс і додаткові аксесуари</p>" }, { at: AT3 });
  assert.equal(r2.row["Опис UA"], ours);
  assert.equal(r2.row["Опис постачальника UA"], "<p>У комплекті кейс і додаткові аксесуари</p>", "новий сирий опис збережено");
  assert.equal(r2.warnings.length, 1);
  const w = r2.warnings[0];
  assert.deepEqual({ offerId: w.offerId, sku: w.sku, name: w.name, field: w.field, before: w.before, after: w.after, custom: w.custom, at: w.at, source: w.source },
    { offerId: "3000000001", sku: "YT-2170", name: "Ключ", field: "Опис UA", before: "<p>У комплекті кейс</p>", after: "<p>У комплекті кейс і додаткові аксесуари</p>", custom: ours, at: AT3, source: "YML постачальника" });
  assert.equal(w.key, `3000000001|Опис UA|${hv("<p>У комплекті кейс і додаткові аксесуари</p>")}`);
});

test("10: повторний запуск із тими самими сирими даними не створює нових попереджень", () => {
  const r1 = cycle({ ...fresh(), "Опис UA": "наш" }, RAW1).row;
  const raw2 = { ...RAW1, descUa: "<p>нове</p>" };
  const r2 = cycle(r1, raw2);
  assert.equal(r2.warnings.length, 1);
  const r3 = cycle(r2.row, raw2);
  const r4 = cycle(r3.row, raw2);
  assert.equal(r3.warnings.length + r4.warnings.length, 0);
  assert.equal(r4.row[STATE_COLUMN], r3.row[STATE_COLUMN], "стан стабільний — ідемпотентно");
});

test("11: прийняття значення постачальника змінює лише обране поле", () => {
  const r1 = cycle({ ...fresh(), "Опис UA": "наш опис", "Назва UA": "наша назва" }, RAW1).row;
  const raw2 = { ...RAW1, descUa: "<p>нове сире</p>", nameUa: "нова сира назва" };
  const r2 = cycle(r1, raw2).row;
  const accepted = { ...r2, [STATE_COLUMN]: writeState(acceptSupplier(readState(r2[STATE_COLUMN]), "Опис UA", "", AT3)) };
  const r3 = cycle(accepted, raw2, { at: AT3 });
  assert.equal(r3.row["Опис UA"], "<p>нове сире</p>", "прийняте поле — від постачальника");
  assert.equal(r3.row["Назва UA"], "наша назва", "інше кастомне — без змін");
  assert.equal(readState(r3.row[STATE_COLUMN]).f["Опис UA"].s, SRC.SUPPLIER);
  assert.deepEqual(r3.changes, [], "прийняття не сприйнято як ручну правку");
});

test("характеристики поштучно: власник виправив одну — інші оновлюються від постачальника; додана / видалена власником зберігаються", () => {
  const r0 = fresh();
  const mine = [{ name: "Розмір", value: "17", unit: "мм" }, { name: "Матеріал", value: "хром-ванадієва сталь" }, { name: "Комплектація", value: "без кейса" }];
  const r1 = cycle({ ...r0, [PARAMS_FIELD]: P(mine) }, RAW1);
  assert.deepEqual(r1.changes.map((c) => [c.param, c.by]).sort(), [["комплектація", "added"], ["матеріал", "diff"]]);
  const raw2 = { ...RAW1, params: [{ name: "Розмір", value: "19", unit: "мм" }, { name: "Матеріал", value: "CrV" }, { name: "Вага", value: "0.3", unit: "кг" }] };
  const r2 = cycle(r1.row, raw2);
  const got = JSON.parse(r2.row[PARAMS_FIELD]);
  assert.deepEqual(got, [{ name: "Розмір", value: "19", unit: "мм" }, { name: "Матеріал", value: "хром-ванадієва сталь" }, { name: "Вага", value: "0.3", unit: "кг" }, { name: "Комплектація", value: "без кейса" }]);
  assert.deepEqual(r2.warnings.map((w) => w.field), [`${PARAMS_FIELD}: матеріал`], "попередження лише для кастомної характеристики, сире джерело якої змінилось");
  // Видалення власником: характеристика не повертається.
  const r3 = cycle({ ...r2.row, [PARAMS_FIELD]: P(got.filter((p) => p.name !== "Вага")) }, raw2);
  assert.ok(!JSON.parse(r3.row[PARAMS_FIELD]).some((p) => p.name === "Вага"));
});

test("невалідний JSON характеристик від власника — рівень поля C (нічого не перезаписується); від конвеєра — аномалія без зміни стану", () => {
  const r0 = fresh();
  const broken = cycle({ ...r0, [PARAMS_FIELD]: "[{name: Розмір" }, RAW1);
  assert.equal(broken.row[PARAMS_FIELD], "[{name: Розмір", "значення власника не перезаписано");
  assert.equal(readState(broken.row[STATE_COLUMN]).f[PARAMS_FIELD].by, "invalid-json");
  const st0 = readState(r0[STATE_COLUMN]);
  const a = applySupplier({ row: r0, proposed: { ...proposedFrom(RAW1), [PARAMS_FIELD]: "не json" }, state: st0, ctx, at: AT2 });
  assert.equal(a.row[PARAMS_FIELD], r0[PARAMS_FIELD]);
  assert.equal(a.anomalies.length, 1);
  assert.equal(a.state.f[PARAMS_FIELD].s, SRC.SUPPLIER, "аномалія конвеєра не робить поле кастомним");
});

test("пошкоджений стан у клітинці — захисно: жодне поле не перезаписується, позначка bad", () => {
  const r0 = fresh();
  const r1 = cycle({ ...r0, [STATE_COLUMN]: "{зламано", "Назва UA": "наша" }, { ...RAW1, nameUa: "нова" });
  assert.equal(r1.row["Назва UA"], "наша");
  assert.equal(r1.row["Опис UA"], r0["Опис UA"]);
  assert.equal(readState("{зламано").bad, true);
});

test("явна команда «зробити кастомним» для значення, що збігається з постачальником", () => {
  const r0 = fresh();
  const marked = { ...r0, [STATE_COLUMN]: writeState(markCustom(readState(r0[STATE_COLUMN]), "Назва RU", "", AT2)) };
  const r1 = cycle(marked, { ...RAW1, nameRu: "Новое имя" });
  assert.equal(r1.row["Назва RU"], RAW1.nameRu);
  assert.equal(r1.warnings.length, 1);
});

test("18 (ядро): однакові входи → однаковий результат байт-у-байт", () => {
  const a = cycle({ ...fresh(), "Назва UA": "x" }, { ...RAW1, descUa: "d2" });
  const b = cycle({ ...fresh(), "Назва UA": "x" }, { ...RAW1, descUa: "d2" });
  assert.deepEqual(a, b);
  assert.deepEqual(readState(writeState(emptyState())), emptyState());
});
