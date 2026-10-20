/** Прогноз місячного використання безплатних квот. Ліміти — з офіційної документації (COSTS.md, станом на 21.10.2026).
 *  Модель консервативна: округлення хвилин GitHub до цілої хвилини на job, запас на ручні запуски/повтори. */

export const FREE = Object.freeze({
  actionsMinutesPrivate: 2000, // GitHub Free, приватні репо, стандартні Linux runners
  r2StorageGbMonth: 10,
  r2ClassA: 1_000_000,
  r2ClassB: 10_000_000,
  workerRequestsPerDay: 100_000,
  promRecommendedYmlMb: 180, // Prom: рекомендований розмір YML
});

/**
 * @param p {
 *   products, bytesPerOffer, gzipRatio (стиснутий/повний), gzip (bool),
 *   runsPerDay (6 = кожні 4 год), extraRunsPerMonth (ручні/повтори),
 *   minutesPerRun (оцінка тривалості job, хв — округлюється вгору),
 *   ciMinutesPerMonth (тести на push), retainVersions,
 *   publishShare (частка запусків, що створюють НОВУ версію; решта — REUSED),
 *   promFetchesPerDay, statusChecksPerDay
 * }
 */
export function monthlyUsage(p) {
  const days = 31;
  const runs = p.runsPerDay * days + (p.extraRunsPerMonth || 0);
  const fullBytes = p.products * p.bytesPerOffer;
  const storedBytes = p.gzip ? fullBytes * p.gzipRatio : fullBytes;
  const publishes = Math.ceil(runs * p.publishShare);

  // Хвилини: кожен job округлюється вгору до хвилини.
  const actionsMinutes = runs * Math.ceil(p.minutesPerRun) + (p.ciMinutesPerMonth || 0);

  // R2 клас A на запуск: state/operational, state/sync, seen, new-products report, last-run, run report, usage, changes (~8),
  // + при публікації: PUT версії, PUT маніфесту, LIST для ротації (3).
  const classA = runs * 8 + publishes * 3;
  // Клас B на запуск: читання стану/маніфестів/usage (~6) + HEAD активної; при публікації — readback (GET + HEAD).
  // Worker: на кожне завантаження Prom — GET маніфесту + GET об'єкта.
  const classB = runs * 7 + publishes * 2 + (p.promFetchesPerDay + p.statusChecksPerDay) * days * 2;

  // Сховище: активна + попередня + історія, і стан/звіти (~1% від фіду, мінімум 5 МБ).
  const versions = Math.max(2, p.retainVersions);
  const storageGb = (storedBytes * versions + Math.max(5e6, fullBytes * 0.01) + runs * 50e3) / 1e9;
  const workerPerDay = p.promFetchesPerDay + p.statusChecksPerDay;

  const pct = (v, lim) => +((v / lim) * 100).toFixed(2);
  return {
    inputs: p,
    runs,
    publishes,
    ymlMB: +(fullBytes / 1e6).toFixed(1),
    storedMB: +(storedBytes / 1e6).toFixed(1),
    feedsNeededFor180Mb: Math.ceil(fullBytes / 1e6 / FREE.promRecommendedYmlMb),
    actionsMinutes, actionsPct: pct(actionsMinutes, FREE.actionsMinutesPrivate),
    r2StorageGb: +storageGb.toFixed(3), r2StoragePct: pct(storageGb, FREE.r2StorageGbMonth),
    r2ClassA: classA, r2ClassAPct: pct(classA, FREE.r2ClassA),
    r2ClassB: classB, r2ClassBPct: pct(classB, FREE.r2ClassB),
    workerPerDay, workerPct: pct(workerPerDay, FREE.workerRequestsPerDay),
  };
}

/** Пороги контролю: попередження на 50%, зупинка автоматики на 80% будь-якої квоти. */
export function budgetVerdict(u) {
  const worst = Math.max(u.actionsPct, u.r2StoragePct, u.r2ClassAPct, u.r2ClassBPct, u.workerPct);
  return { worstPct: worst, state: worst >= 80 ? "STOP" : worst >= 50 ? "WARN" : "OK" };
}
