/** Планування очищення застарілих характеристик карток Prom (власник, 24.10.2026): лише прев'ю, резервна копія,
 *  відновлення, звірка. Випадки — з реальних тестів імпорту (GMIG-305P, GRH 300); у Prom нічого не змінюється. */
import test from "node:test";
import assert from "node:assert/strict";
import { SRC } from "../src/core/prom-attributes.mjs";
import { ACTION, cleanupBackup, cleanupPreviewRows, planStaleCleanup, promExportChars, restoreFromBackup, verifyAfterCleanup } from "../src/core/prom-cleanup.mjs";
import { loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";

const catalog = loadPromCatalog();
const P = (name, value, unit = "") => ({ name, value, unit });
const plan = (cat, o) => planStaleCleanup({ schema: catalog.schemas.get(cat), mapping: catalog.mappings.get(cat), names: catalog.names, units: catalog.units, ...o });
const act = (p) => Object.fromEntries(p.rows.map((r) => [r.name, r.action]));

test("експорт Prom: характеристики — трійки колонок назва / одиниця / значення; порожні пропускаються", () => {
  const h = ["Код_товару", "Назва_Характеристики", "Одиниця_виміру_Характеристики", "Значення_Характеристики", "Назва_Характеристики", "Одиниця_виміру_Характеристики", "Значення_Характеристики"];
  assert.deepEqual(promExportChars(h, ["1", "Вага", "кг", "7", "", "", ""]), [{ name: "Вага", unit: "кг", value: "7" }]);
});

test("застарілі мовні дублі (GMIG-305P): ВИДАЛИТИ лише підтверджений дубль, коли точний запис нового набору вже в картці; ручні, унікальні, ПОТРЕБУЄ ПЕРЕВІРКИ — не видаляються", () => {
  const prepared = [P("Частота мережі", "50/60 Гц"), P("Цифровий дисплей", "є"), P("Вага апарата", "7 кг"), P("Вага", "7", "кг"), P("Моя примітка", "перевірено"), P("Стан", "новий")];
  const items = [{ s: SRC.DESC, a: "" }, { s: SRC.DESC, a: "" }, { s: SRC.DESC, a: "" }, { s: SRC.XML, a: "12" }, { s: SRC.MANUAL, a: "" }, { s: SRC.DESC, a: "" }];
  const prom = [P("Частота сети", "50/60 Гц;"), P("Частота мережі", "50/60 Гц;"), P("Цифровой дисплей", "есть;"), P("Цифровий дисплей", "є;"), P("Вес аппарата", "7 кг;"), P("Вага апарата", "7 кг;"),
    P("Моя примітка", "перевірено"), P("Тип охлаждения", "примусове повітряне;"), P("Тип підключення рукава", "Вбудований"), P("Состояние", "Новое"), P("Цифровой дисплей", "нет")];
  const p = plan("14400105", { prom, prepared, items, review: ["Тип охолодження"] });
  const a = act(p);
  assert.equal(p.rows.find((r) => r.name === "Частота сети").action, ACTION.REMOVE);
  assert.equal(a["Частота мережі"], ACTION.KEEP);
  assert.equal(a["Вес аппарата"], ACTION.REMOVE);
  assert.equal(a["Вага апарата"], ACTION.KEEP);
  assert.equal(a["Моя примітка"], ACTION.KEEP, "ручна характеристика власника");
  assert.equal(a["Тип охлаждения"], ACTION.CHECK, "у новому наборі ПОТРЕБУЄ ПЕРЕВІРКИ");
  assert.equal(a["Тип підключення рукава"], ACTION.KEEP, "унікальна — не видаляється");
  assert.equal(a["Состояние"], ACTION.CHECK, "точного «Стан» у картці немає — імовірно та сама характеристика іншою мовою");
  assert.deepEqual(p.rows.filter((r) => r.name === "Цифровой дисплей").map((r) => r.action), [ACTION.REMOVE, ACTION.CHECK], "те саме значення — дубль; інше («нет» ≠ «є») — ПЕРЕВІРИТИ");
  assert.deepEqual(p.summary, { prom: 11, prepared: 6, keep: 5, remove: 3, check: 3 });
  // Прев'ю: заголовок + рядок на кожну характеристику картки
  const rows = cleanupPreviewRows("3128080201", p);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[0].slice(0, 3), ["ID товару", "Дія", "Причина"]);
});

test("Prom показує нашу характеристику під іншою мовою (GRH 300: «Номінальний струм» → «Номинальный ток») — не видаляти; кілька кандидатів — ПЕРЕВІРИТИ", () => {
  const prepared = [P("Номінальний струм", "55 А"), P("Коефіцієнт корисної дії", "75 %")];
  const prom = [P("Номинальный ток", "55 А"), P("ККД", "75 %"), P("Коефіцієнт корисної дії (ККД)", "75%;")];
  const p = plan("14400105", { prom, prepared, items: [{ s: SRC.DESC, a: "" }, { s: SRC.RAW, a: "" }] });
  assert.deepEqual(p.rows.map((r) => r.action), [ACTION.CHECK, ACTION.CHECK, ACTION.CHECK]);
  assert.match(p.rows[0].reason, /іншою мовою/);
  assert.match(p.rows[1].reason, /кандидатів кілька/);
  // Після імпорту нового набору точний запис з'явився — старі синоніми з тим самим значенням — дублі
  const after = plan("14400105", { prom: [...prom, P("Коефіцієнт корисної дії", "75 %")], prepared, items: [{ s: SRC.DESC, a: "" }, { s: SRC.RAW, a: "" }] });
  assert.deepEqual(after.rows.map((r) => r.action), [ACTION.CHECK, ACTION.REMOVE, ACTION.REMOVE, ACTION.KEEP]);
});

test("поле з вадою довідника Prom («Частота: 50 GHz», 14209803) — ВИДАЛИТИ, коли новий набір містить заміну «Частота мережі»; поля категорії без вади — не видаляються", () => {
  const prepared = [P("Частота мережі", "50 Гц"), P("Вага", "70", "кг")];
  const p = plan("14209803", { prom: [P("Частота", "50", "GHz"), P("Вага", "68", "кг")], prepared, items: [{ s: SRC.DESC, a: "" }, { s: SRC.XML, a: catalog.schemas.get("14209803").attributes.find((a) => a.nameUK === "Вага").id }] });
  assert.deepEqual(p.rows.map((r) => r.action), [ACTION.REMOVE, ACTION.KEEP]);
  assert.match(p.rows[1].reason, /оновить імпорт/);
  // Заміни в новому наборі немає — лише ПЕРЕВІРИТИ
  assert.equal(plan("14209803", { prom: [P("Частота", "50", "GHz")], prepared: [], items: [] }).rows[0].action, ACTION.CHECK);
});

test("резервна копія й відновлення: повний перелік з SHA-256; пошкоджена копія не відновлюється; звірка після очищення", () => {
  const prom = [P("Частота сети", "50/60 Гц;"), P("Частота мережі", "50/60 Гц;")];
  const b = cleanupBackup({ productId: 1, prom, source: "export.xlsx", takenAt: "2026-10-24T00:00:00Z" });
  assert.equal(b.count, 2);
  assert.deepEqual(restoreFromBackup(b), prom.map((x) => ({ name: x.name, unit: x.unit, value: x.value })));
  assert.throws(() => restoreFromBackup({ ...b, prom: [prom[0]] }), /SHA-256/);
  prom[0].value = "змінено"; assert.equal(b.prom[0].value, "50/60 Гц;", "копія не залежить від вихідного масиву");
  const p = plan("14400105", { prom: b.prom, prepared: [P("Частота мережі", "50/60 Гц")], items: [{ s: SRC.DESC, a: "" }] });
  assert.equal(verifyAfterCleanup(p, [P("Частота мережі", "50/60 Гц;")], [P("Частота мережі", "50/60 Гц")]).ok, true);
  const bad = verifyAfterCleanup(p, b.prom, [P("Частота мережі", "50/60 Гц")]);
  assert.equal(bad.ok, false); assert.match(bad.problems[0], /не видалено/);
  assert.match(verifyAfterCleanup(p, [], [P("Частота мережі", "50/60 Гц")]).problems.join(" "), /зникло|немає характеристики/);
});

test("аудит одиниць схем (власник, 24.10.2026): у 48 схемах — лише відома вада «Частота» в GHz (14209803, 143109); інша величина й масштаб частоти виявляються; правильні — ні", async () => {
  const { auditSchemaUnits } = await import("../src/core/prom-unit-audit.mjs");
  const f = auditSchemaUnits([...catalog.schemas.values()], catalog.units, catalog.knownIssues);
  assert.deepEqual(f.map((x) => [x.category, x.id, x.finding, x.known]).sort(), [["14209803", "1493", "масштаб частоти", true], ["143109", "1493", "масштаб частоти", true]]);
  const syn = [{ id: "1", nameUK: "Т", attributes: [
    { id: "a", nameUK: "Потужність двигуна", unitUK: "кг" }, { id: "b", nameUK: "Частота струму", unitUK: "Гц" }, { id: "c", nameUK: "Частота мережі", unitUK: "МГц" },
    { id: "d", nameUK: "Частота обертання шпинделя", unitUK: "кГц" }, { id: "e", nameUK: "Вага", unitUK: "г" }, { id: "f", nameUK: "Довжина шини", unitUK: "см" }] }];
  assert.deepEqual(auditSchemaUnits(syn, catalog.units).map((x) => [x.id, x.finding]), [["a", "інша величина"], ["c", "масштаб частоти"]]);
});

test("очищення: ручна характеристика власника з іншим значенням, ніж у Prom, — ЛИШИТИ (ніколи не видаляти й не позначати як дубль)", () => {
  const p = plan("14400105", { prom: [P("Моя примітка", "інше")], prepared: [P("Моя примітка", "перевірено")], items: [{ s: SRC.MANUAL, a: "" }] });
  assert.equal(p.rows[0].action, ACTION.KEEP);
  assert.match(p.rows[0].reason, /ручна/);
});
