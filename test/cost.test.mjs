import test from "node:test";
import assert from "node:assert/strict";
import { monthlyUsage, budgetVerdict } from "../src/cost/model.mjs";

const base = { bytesPerOffer: 9750, gzipRatio: 0.12, runsPerDay: 6, extraRunsPerMonth: 30, ciMinutesPerMonth: 60, retainVersions: 7, publishShare: 1, promFetchesPerDay: 24, statusChecksPerDay: 6 };

test("модель квот: 5121 товар, 3 хв/запуск — у межах безплатних квот", () => {
  const u = monthlyUsage({ ...base, products: 5121, gzip: false, minutesPerRun: 3 });
  assert.equal(u.runs, 216);
  assert.equal(u.actionsMinutes, 216 * 3 + 60);
  assert.ok(u.actionsPct < 50);
  assert.ok(u.r2ClassAPct < 1 && u.r2ClassBPct < 1);
  assert.equal(budgetVerdict(u).state, "OK");
});

test("модель квот: хвилини округлюються вгору; 10 хв/запуск → STOP (понад 80% з 2000)", () => {
  const u = monthlyUsage({ ...base, products: 30000, gzip: true, minutesPerRun: 9.1 });
  assert.equal(u.actionsMinutes, 216 * 10 + 60);
  assert.equal(budgetVerdict(u).state, "STOP");
});

test("модель квот: 30 000 без gzip потребує ≥2 фідів для рекомендації Prom 180 МБ", () => {
  const u = monthlyUsage({ ...base, products: 30000, gzip: false, minutesPerRun: 5 });
  assert.ok(u.ymlMB > 180);
  assert.ok(u.feedsNeededFor180Mb >= 2);
});
