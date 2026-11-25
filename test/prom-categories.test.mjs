/** Категорія Prom — джерело істини (рішення власника 23.10.2026): не повертаємо стару, не вигадуємо невідому,
 *  Offer ID не змінюється, YML віддає нову категорію (наступний імпорт не поверне стару). */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { rowSeal, SEAL_COLUMN, approvalManifest, GROUP_HEADERS } from "../src/core/seal.mjs";
import { objectsFromValues, offerXml } from "../src/core/yml.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { CATEGORY_CONFIRMED, planPromCategories, promCategoriesFromExport } from "../src/core/prom-categories.mjs";
import { WatchSim } from "./helpers/watch-sim.mjs";

const D1 = "2026-10-21", D0 = "2026-10-15";

test("категорія з Prom має пріоритет: ID і посилання оновлено, підтвердження з датою, «Журнал», печатка; Offer ID той самий; YML — нова категорія", async () => {
  const sim = new WatchSim();
  await sim.start();
  const rows = sim.rows(SHEET.main);
  const [a, b, c] = rows;
  const prom = new Map([
    [mtText(a["Offer ID"]), { categoryId: "999001", url: "https://prom.ua/Nova-kategoriya" }],
    [mtText(b["Offer ID"]), { categoryId: mtText(b["Категорія Prom ID"]), url: mtText(b["Категорія Prom URL"]) }],
  ]);
  const plan = planPromCategories(rows, prom, { date: D1, stamp: "T", sheet: SHEET.main });
  const na = plan.rows[0];
  assert.equal(mtText(na["Offer ID"]), mtText(a["Offer ID"]));
  assert.equal(na["Категорія Prom ID"], "999001");
  assert.equal(na["Категорія Prom URL"], "https://prom.ua/Nova-kategoriya");
  assert.equal(na[CATEGORY_CONFIRMED], "PROM " + D1);
  assert.equal(rowSeal(na), na[SEAL_COLUMN], "печатку перераховано");
  assert.ok(plan.entries.some((e) => e[3] === "Категорія Prom ID" && e[4] === mtText(a["Категорія Prom ID"]) && e[5] === "999001" && /експорт Prom 2026-10-21/.test(e[6])));
  assert.equal(plan.categoryChanged, 1);
  assert.equal(plan.rows[1][CATEGORY_CONFIRMED], "PROM " + D1, "та сама категорія — лише підтвердження");
  assert.ok(plan.unknown.includes(mtText(c["Offer ID"])), "немає в експорті — невідомо");
  assert.equal(plan.rows[2]["Категорія Prom ID"], c["Категорія Prom ID"], "невідому не вигадуємо й не змінюємо");
  assert.notEqual(approvalManifest(plan.rows, objectsFromValues(sim.book[SHEET.groups], GROUP_HEADERS)).contentSha, approvalManifest(rows, objectsFromValues(sim.book[SHEET.groups], GROUP_HEADERS)).contentSha, "паспорт потребує оновлення (окремий погоджений запис)");
  const groups = Object.fromEntries(objectsFromValues(sim.book[SHEET.groups], GROUP_HEADERS).map((g) => [mtText(g["Ідентифікатор_групи"]), g]));
  const xml = offerXml(na, Date.parse(na["Оновлено"]), groups);
  // 25.11 (№ 116): бренд, якого немає в довіднику Prom, не відправляється; звичайний — відправляється.
  assert.match(offerXml({ ...na, "Виробник": "Bosch" }, Date.parse(na["Оновлено"]), groups), /<vendor>Bosch<\/vendor>/);
  assert.doesNotMatch(offerXml({ ...na, "Виробник": "Gabra" }, Date.parse(na["Оновлено"]), groups), /<vendor>/);
  assert.match(xml, /<portal_category_id>999001<\/portal_category_id>/);
  assert.match(xml, /<portal_category_url>https:\/\/prom\.ua\/Nova-kategoriya<\/portal_category_url>/);
});

test("старіший експорт не повертає попередню категорію; повторений товар в експорті — категорія невідома", () => {
  const row = { "Offer ID": "1", "Категорія Prom ID": "777", "Категорія Prom URL": "https://prom.ua/A", [CATEGORY_CONFIRMED]: "PROM " + D1 };
  const stale = planPromCategories([row], new Map([["1", { categoryId: "555", url: "https://prom.ua/B" }]]), { date: D0, stamp: "T", sheet: SHEET.main, seal: false });
  assert.equal(stale.rows[0]["Категорія Prom ID"], "777");
  assert.deepEqual(stale.stale, ["1"]);
  assert.equal(stale.changed.size, 0);
  const values = [["Ідентифікатор_товару", "Ідентифікатор_підрозділу", "Посилання_підрозділу"], ["1", "555", "https://prom.ua/B"], ["1", "556", "https://prom.ua/C"], ["2", "", ""], ["3", "600", "https://prom.ua/D"]];
  const m = promCategoriesFromExport(values);
  assert.equal(m.has("1"), false, "повтор — не вибираємо");
  const p = planPromCategories([{ "Offer ID": "2", "Категорія Prom ID": "1" }, { "Offer ID": "3", "Категорія Prom ID": "1" }], m, { date: D1, stamp: "T", sheet: SHEET.main, seal: false });
  assert.deepEqual(p.unknown, ["2"], "порожня категорія в експорті — невідома");
  assert.equal(p.rows[1]["Категорія Prom ID"], "600");
  assert.throws(() => planPromCategories([], m, { date: "21.10.2026", stamp: "T", sheet: SHEET.main }), /YYYY-MM-DD/);
});
