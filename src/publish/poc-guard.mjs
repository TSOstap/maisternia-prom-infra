/** ENG-20 (рішення власника 30.10, п. 4): PoC-публікатори C3 (tools/cf-publish.mjs, tools/shadow-publish.mjs → Worker «mm-feed-poc»)
 *  — ЛИШЕ для ізольованих тестів. Вони формують YML без Catalog Controls і поза W2, тому НЕ можуть бути джерелом для живого Prom.
 *  Явна заборона: запуск у робочому середовищі записувачів (W2 single-host: MM_W2_MODE / MM_SAFE_WRITE_DIR), з не-PoC Worker або з
 *  прапорцем production → відмова ДО будь-якого читання / публікації. Чинні ручні запуски PoC (workflow c3-publish, режим shadow-publish
 *  у sheets-verify) цих змінних не мають — їх не змінено. */
export const POC_WORKER = "mm-feed-poc";
export const POC_NOT_FOR_PROM = "PoC C3 — НЕ джерело для живого Prom: YML без Catalog Controls і поза W2 (рішення власника 30.10)";

export function assertPocIsolated({ env = process.env, argv = process.argv, workerName = POC_WORKER } = {}) {
  const reasons = [];
  if (workerName !== POC_WORKER) reasons.push(`Worker «${workerName}» — не PoC «${POC_WORKER}»`);
  if (env.MM_W2_MODE || env.MM_SAFE_WRITE_DIR) reasons.push("робоче середовище записувачів W2 (MM_W2_MODE / MM_SAFE_WRITE_DIR)");
  if (env.MM_PRODUCTION === "1") reasons.push("MM_PRODUCTION=1");
  if (argv.some((a) => /^--(prom|production)(=|$)/.test(String(a)))) reasons.push("прапорець --prom / --production");
  if (reasons.length) throw Object.assign(new Error("PoC C3 заборонено як робочий публікатор / джерело для Prom: " + reasons.join("; ")), { code: "POC_FORBIDDEN" });
  return { notForProm: true, banner: POC_NOT_FOR_PROM };
}
