/** Таблиця прогнозу квот для кількох розмірів каталогу.
 *  node tools/cost-model.mjs [--bytes-per-offer=9750] [--gzip-ratio=0.12] [--minutes=4] */
import { monthlyUsage, budgetVerdict } from "../src/cost/model.mjs";

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : def;
};

const rows = [];
for (const products of [5121, 10000, 20000, 30000]) {
  for (const gzip of [false, true]) {
    const u = monthlyUsage({
      products, gzip, bytesPerOffer: arg("bytes-per-offer", 9750), gzipRatio: arg("gzip-ratio", 0.2),
      runsPerDay: 6, extraRunsPerMonth: 30, // C1 (21.10.2026): job update на runner — 9 с (5121) і 34 с (30 000) без мережі; 2 хв = з округленням і запасом на мережу
      minutesPerRun: arg("minutes", 2),
      ciMinutesPerMonth: 60, retainVersions: 7, publishShare: 1, promFetchesPerDay: 24, statusChecksPerDay: 6,
    });
    rows.push({
      products, gzip, ymlMB: u.ymlMB, storedMB: u.storedMB, feedsFor180MB: u.feedsNeededFor180Mb,
      actionsMin: u.actionsMinutes, "actions%": u.actionsPct, r2GB: u.r2StorageGb, "r2Stor%": u.r2StoragePct,
      classA: u.r2ClassA, "A%": u.r2ClassAPct, classB: u.r2ClassB, "B%": u.r2ClassBPct, "worker%/day": u.workerPct,
      verdict: budgetVerdict(u).state,
    });
  }
}
console.table(rows);
