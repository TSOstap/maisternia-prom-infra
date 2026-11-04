// Рішення власника 04.11.2026: на аркуші «Попередження постачальника» — лише відкриті; опрацьовані → «Попередження — архів»;
// «Що змінилось» — короткий підсумок зміни.
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { WARN_SHEET, WARN_HEADER, ACTION, changeSummary, isResolved, warningRow } from "../src/pipeline/supplier-warnings.mjs";
import { archiveWarnings, WARN_ARCHIVE_SHEET } from "../src/pipeline/warnings-archive.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { guardedSheets, MODE_POLICIES, TEST_SHEET_ID } from "../src/pipeline/safe-write/write-target.mjs";

const OLD_HEADER = WARN_HEADER.slice(0, 13); // аркуш до 04.11 — без «Що змінилось»
const row = (key, { note = "", act = "", st = "", field = "Опис UA", before = "<p>Акумулятор 2Ач - 2шт</p>", after = "<p>Акумулятор 2Ач - 1шт</p>" } = {}) =>
  [key, "2026-11-03T14:53:08Z", "id-" + key, "SKU", "Товар " + key, field, before, after, "наше", "YML постачальника", note, act, st];

async function world(rows, policy = MODE_POLICIES.prices, onGatewayRead = null) {
  const raw = new MemorySheets({ [WARN_SHEET]: [OLD_HEADER.slice(), ...rows], "Журнал": [["ID події"]] });
  const readBook = async () => raw.read();
  const gwRead = async (t) => { onGatewayRead?.(raw, t); return raw.read(); };
  const sheets = guardedSheets(raw, { spreadsheetId: TEST_SHEET_ID, policy, headers: { [WARN_SHEET]: OLD_HEADER.slice() } });
  const session = await new WriteGateway({ sheets, read: gwRead, store: new MemoryStore() }).open({ writer: "sync" });
  return { raw, readBook, session };
}
const keysOf = (v) => v.slice(1).map((r) => mtText(r[0]));

test("04.11: «Що змінилось» — слова «було → стало», лише розмітка, характеристики попарно, порожнє → додано", () => {
  assert.equal(changeSummary("Опис UA", "<p>Акумулятор 2Ач - 2шт Зарядний</p>", "<p>Акумулятор 2Ач - 1шт Зарядний</p>"), "…Акумулятор 2Ач - «2шт» → «1шт»");
  assert.equal(changeSummary("Опис UA", "<p>Текст&nbsp;той</p>", "<div>Текст той</div>"), "лише розмітка (HTML) — текст той самий");
  assert.equal(changeSummary("Характеристики JSON (змінено характеристик постачальника: 2)", "Тип упаковки: (не було); Дополнительный аккумулятор: (не було)", "Тип упаковки: Пластиковый кейс; Дополнительный аккумулятор: Нет"),
    "Тип упаковки: (не було) → Пластиковый кейс; Дополнительный аккумулятор: (не було) → Нет");
  assert.match(changeSummary("Назва UA", "", "Нова назва"), /^додано: «Нова назва»/);
  assert.equal(changeSummary("Назва UA", "Стара", ""), "постачальник прибрав значення");
  assert.equal(warningRow({ key: "k", at: "t", offerId: "1", sku: "s", name: "n", field: "Опис UA", before: "<p>a b</p>", after: "<p>a c</p>", custom: "x", source: "YML" }).length, WARN_HEADER.length);
});

test("04.11: опрацьоване — «Залишити наше»; «Прийняти…» лише після ВИКОНАНО; позначка власника; невідома дія — ні", () => {
  const o = (note, act, st) => ({ "Позначка власника": note, "Дія власника": act, "Стан дії": st });
  assert.equal(isResolved(o("", ACTION.KEEP, "")), true);
  assert.equal(isResolved(o("", ACTION.ACCEPT, "")), false, "дію ще не виконано — рядок лишається");
  assert.equal(isResolved(o("Опрацьовано", ACTION.ACCEPT, "")), false, "позначка не скасовує невиконану дію");
  assert.equal(isResolved(o("", ACTION.ACCEPT, "ВИКОНАНО 2026-11-04")), true);
  assert.equal(isResolved(o("Опрацьовано", "", "")), true);
  assert.equal(isResolved(o("", "Залишити НАШЕ!", "")), false, "невідома дія — не опрацьовано");
  assert.equal(isResolved(o("", "", "")), false);
});

test("04.11: перенесення в архів — лише опрацьовані, за ключем зі знімком; заголовок і «Що змінилось» відкритим; повтор — нічого; нове попередження лишається", async () => {
  const w = await world([row("k1", { act: ACTION.KEEP }), row("k2"), row("k3", { act: ACTION.ACCEPT }), row("k4", { act: ACTION.ACCEPT, st: "ВИКОНАНО 2026-11-04" }), row("k5", { note: "Опрацьовано" })]);
  const r = await archiveWarnings({ session: w.session, readBook: w.readBook, stamp: "2026-11-04T20:00:00Z" });
  assert.equal(r.state, "WARNINGS_ARCHIVED"); assert.equal(r.archived, 3); assert.equal(r.open, 2); assert.equal(r.resolvedLeft, 0);
  const sheet = w.raw.book[WARN_SHEET], arch = w.raw.book[WARN_ARCHIVE_SHEET];
  assert.deepEqual(keysOf(sheet), ["k2", "k3"], "на аркуші — лише відкриті (k3 чекає виконання «Прийняти…»)");
  assert.deepEqual(keysOf(arch).sort(), ["k1", "k4", "k5"]);
  assert.equal(mtText(sheet[0][13]), "Що змінилось");
  assert.equal(mtText(sheet[1][13]), "…Акумулятор 2Ач - «2шт» → «1шт»");
  assert.equal(mtText(arch[0].at(-1)), "Архівовано"); assert.equal(mtText(arch[1].at(-1)), "2026-11-04T20:00:00Z");
  assert.equal(mtText(arch.find((x) => x[0] === "k1")[11]), ACTION.KEEP, "рішення власника збережено в архіві");
  // Повтор — нічого; новий рядок (нова зміна постачальника, новий ключ) — на аркуші, відкритий.
  assert.equal((await archiveWarnings({ session: w.session, readBook: w.readBook, stamp: "x" })).state, "NOTHING");
  w.raw.book[WARN_SHEET].push([...row("k6"), ""]);
  const r2 = await archiveWarnings({ session: w.session, readBook: w.readBook, stamp: "y" });
  assert.equal(r2.archived, 0); assert.equal(r2.summarized, 1);
  assert.deepEqual(keysOf(w.raw.book[WARN_SHEET]), ["k2", "k3", "k6"]);
});

test("04.11: власник змінив рядок між читанням і видаленням — рядок НЕ видаляється (знімок); архівний дубль не створюється при повторі", async () => {
  // Перше читання аркуша попереджень шлюзом (свіже читання в deleteByKeys) — власник щойно змінив «Наше значення» в a2.
  let once = false;
  const w = await world([row("a1", { act: ACTION.KEEP }), row("a2", { note: "ок" })], MODE_POLICIES.prices, (raw, t) => { if (!once && t.includes(WARN_SHEET)) { once = true; raw.book[WARN_SHEET][2][8] = "власник щойно змінив"; } });
  const r = await archiveWarnings({ session: w.session, readBook: w.readBook, stamp: "s" });
  assert.equal(r.archived, 1); assert.equal(r.conflicts, 1);
  assert.deepEqual(keysOf(w.raw.book[WARN_SHEET]), ["a2"], "змінений після читання рядок лишився");
  const r2 = await archiveWarnings({ session: w.session, readBook: w.readBook, stamp: "s2" });
  const arch = w.raw.book[WARN_ARCHIVE_SHEET];
  assert.equal(new Set(keysOf(arch)).size, keysOf(arch).length, "у архіві без дублів ключів");
  assert.deepEqual(keysOf(w.raw.book[WARN_SHEET]), [], "з другої спроби прибрано");
  assert.ok(["WARNINGS_ARCHIVED", "NOTHING"].includes(r2.state));
});

test("04.11: охоронець — режими «Ціни», «Оновити товари», warnings-archive можуть прибирати рядки лише з «Попередження постачальника»; інші аркуші — ні", async () => {
  for (const m of ["prices", "update", "warnings-archive"]) {
    assert.equal(MODE_POLICIES[m][WARN_SHEET].deleteRows, true, m);
    assert.ok(MODE_POLICIES[m][WARN_ARCHIVE_SHEET].ops.includes("appendRows"), m);
    assert.ok(!MODE_POLICIES[m][WARN_ARCHIVE_SHEET].ops.includes("deleteRows"), m + ": з архіву не видаляється");
  }
  assert.ok(!MODE_POLICIES.prices["Основний каталог"].ops.includes("deleteRows"));
  const w = await world([row("z1", { act: ACTION.KEEP })]);
  const guarded = guardedSheets(w.raw, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES.prices, headers: {} });
  await assert.rejects(() => guarded.deleteRows("Журнал", [2]), /видалення рядків заборонено/);
});
