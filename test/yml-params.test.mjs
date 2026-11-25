// 25.11.2026 (№ 116): характеристики з одиницею й нечисловим значенням — одиниця в тексті (Prom приймає одиницю лише з числом).
import test from "node:test";
import assert from "node:assert/strict";
import { promParam } from "../src/core/yml.mjs";

const P = (v, u) => { const x = promParam(v, u); return x.unit ? x.value + " |" + x.unit : x.value; };

test("число з одиницею — без змін; без одиниці — без змін", () => {
  for (const [v, u] of [["1500", "Вт"], ["2.5", "кг"], ["2,5", "кг"], ["-5", "°C"]]) assert.deepEqual(promParam(v, u), { value: v, unit: u });
  for (const v of ["Так", "180×120", ""]) assert.deepEqual(promParam(v, ""), { value: v, unit: "" });
  assert.deepEqual(promParam("", "мм"), { value: "", unit: "мм" });
});

test("нечислове значення — одиниця в тексті", () => {
  assert.equal(P("180×120×200", "мм"), "180×120×200 мм");
  assert.equal(P("8–12", "мм"), "8–12 мм");
  assert.equal(P("До 400", "л/хв"), "До 400 л/хв");
  assert.equal(P("1/4", "дюйм"), "1/4 дюйм");
  assert.equal(P("±60", "°"), "±60°");
  assert.equal(P("-5…+40", "°C"), "-5…+40 °C");
  assert.equal(P("+40", "°C"), "+40 °C");
  assert.equal(P("40 (2×20)", "В"), "40 (2×20) В");
  assert.equal(P("1.6–3.2 (5 шт.)", "мм"), "1.6–3.2 мм (5 шт.)");
  assert.equal(P("10–120", "А·год"), "10–120 А·год");
  assert.equal(P("1.1 / 2.3 (з подовжувачем)", "м"), "1.1 / 2.3 м (з подовжувачем)");
  assert.equal(P("±1.5 (±3 за несприятливих умов)", "мм"), "±1.5 мм (±3 за несприятливих умов)");
  assert.equal(P("10 вгору, 10 вниз", "м"), "10 вгору, 10 вниз, м");
});

test("одиниця вже в тексті — не дублюється; частина іншого слова — не рахується", () => {
  assert.equal(P("180×120 мм", "мм"), "180×120 мм");
  assert.equal(P("2,5 кг (без АКБ)", "кг"), "2,5 кг (без АКБ)");
  assert.equal(P("1 в 1", "В"), "1 в 1 В");
  assert.equal(P("10 мм / 3", "м"), "10 мм / 3 м");
  assert.equal(P("3 л/хв і 5", "л/хв"), "3 л/хв і 5");
  assert.equal(P("5 (град.)", "град."), "5 (град.)");
});
