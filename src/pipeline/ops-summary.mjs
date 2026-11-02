/** ENG-29 — короткий підсумок операції кнопки для власника (вікно «Стан останньої операції» в таблиці TEST).
 *  Джерело — звіт tools/sheet-sync.mjs (--report-file). Текст іде лише в Durable Object mm-ops (приватно), не в журнали GitHub. */
import { mtText } from "../core/text.mjs";

export const STATE_UA = Object.freeze({
  SYNCED: "Оновлено", NO_CHANGES: "Змін немає", NOTHING: "Нічого робити", NOTHING_TO_WRITE: "Нічого записувати", NOTHING_NEW: "Нових товарів немає",
  WAITING_STABILITY: "Нові товари знайдено — чекають повторної перевірки", NOTHING_COMPLETE: "Нові товари без повних даних постачальника",
  INTAKE_DONE: "Нові товари додано", TRANSFERRED: "Перенесено", RECONCILED: "Звірено", JOURNAL_RECOVERED: "Журнал попереднього запуску відновлено",
  ABORTED: "Зупинено — нічого не записано", BLOCKED: "Заблоковано — потрібна звірка незавершених записів", BUSY: "Таблиця зайнята іншою операцією",
  RECONCILE_REQUIRED: "Потрібна звірка незавершених записів", ERROR: "Помилка", HOLD_SUPPLIER_DISAPPEARANCE: "Зупинено: забагато товарів зникло у постачальника",
  CONFLICT_OWNER_EDIT: "Зупинено: таблицю змінено під час операції", INCOMPLETE: "Виконано частково — потрібна звірка",
});
const n = (v) => Number(v || 0);
const clip = (s, max = 600) => { const t = mtText(s); return t.length > max ? t.slice(0, max) + "…" : t; };

export function ownerSummary(op, report) {
  const r = report?.result || {};
  const state = r.state || "ERROR";
  const lines = [`${STATE_UA[state] || state} (${state})`];
  if (r.error) lines.push("Причина: " + clip(r.error));
  else if (r.reason) lines.push("Причина: " + clip(r.reason));
  const rep = r.report || null;
  if (op === "update" && rep) {
    lines.push(`Ціни: постачальника ${n(rep.prices?.supplierPriceChanged)}, продажу ${n(rep.prices?.salePriceChanged)}; наявність: ${n(rep.availability?.changed)} (з'явились ${n(rep.availability?.becameAvailable)}, зникли ${n(rep.availability?.becameUnavailable)})`);
    if (rep.supplierChanges?.rows) lines.push(`Зміни постачальника в картках: ${n(rep.supplierChanges.rows)}`);
    if (rep.presence?.gone || rep.presence?.returned) lines.push(`Зникли у постачальника: ${n(rep.presence.gone)}; повернулися: ${n(rep.presence.returned)}`);
    if (rep.queue?.pendingDecisions) lines.push(`У «Нових товарах» чекають перенесення: ${n(rep.queue.pendingDecisions)} (кнопка «Перенести затверджені»)`);
    if (rep.conflicts?.isolated) lines.push(`Ізольовано рядків (не змінювались): ${n(rep.conflicts.isolated)}`);
  }
  if (op === "find-new" && rep) {
    lines.push(`Нових ID у фіді: ${n(rep.found?.total)} (повних ${n(rep.found?.complete)}, без повних даних ${n(rep.found?.incomplete)})`);
    if (rep.intake) lines.push(`Додано в «Нові товари»: ${n(rep.intake.added)}; можливих дублів: ${n(rep.intake.possibleDuplicates)}`);
    if (n(rep.found?.waiting)) lines.push(`Чекають повторної перевірки: ${n(rep.found.waiting)} — натисніть «Знайти нові товари» ще раз пізніше (товар має бути у фіді двічі поспіль без змін)`);
  }
  if (op === "transfer") {
    if (r.moved !== undefined) lines.push(`Перенесено в «Основний каталог»: ${n(r.moved)}${r.count ? `; у каталозі тепер ${n(r.count)}` : ""}`);
    if (r.removedFromQueue !== undefined) lines.push(`Прибрано з «Нових товарів»: ${n(r.removedFromQueue)}`);
    for (const p of (r.notTransferred || []).slice(0, 30)) lines.push(`Не перенесено ${mtText(p.offerId)}: ${clip(p.problems?.join("; ") || p.reason, 300)}`);
    if ((r.notTransferred || []).length > 30) lines.push(`… ще ${r.notTransferred.length - 30} — див. колонку «Перевірка» в «Нових товарах»`);
    for (const c of (r.conflicts || []).slice(0, 10)) lines.push(`Не прибрано з «Нових товарів» ${mtText(c.offerId)}: ${clip(c.why, 200)}`);
    if (r.next) lines.push("Далі: " + r.next);
  }
  if (op === "reconcile") {
    if (Array.isArray(r.results)) lines.push(`Звірено записів: ${r.results.length}; нерозв'язаних: ${n(r.unresolved)}`);
    if (r.blocking?.length) lines.push(`Потребують рішення: ${r.blocking.length}`);
  }
  if (r.recovery?.state) lines.push(`Відновлення попереднього запуску: ${r.recovery.state}`);
  return lines.join("\n");
}
