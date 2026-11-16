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
  DEFERRED_RESOLVED: "Відкладені товари розібрано", PRICES_UPDATED: "Ціни й наявність оновлено", PARTIAL: "Оновлено частково", NOT_APPLIED: "Нічого не записано", JOURNAL_INCOMPLETE: "Записано, але «Журнал» неповний", SKIPPED_CONCURRENT_EDIT: "Пропущено: таблицю змінено під час операції", PLANNED: "План готовий — нічого не записано", PRECONDITION_FAILED: "Не виконано — умови не виконані",
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
    if (rep.products?.changed != null) lines.push(`Оновлено товарів: ${n(rep.products.changed)} (ціни, наявність або дані постачальника)`);
    lines.push(`Ціни: постачальника ${n(rep.prices?.supplierPriceChanged)}, продажу ${n(rep.prices?.salePriceChanged)}; наявність: ${n(rep.availability?.changed)} (з'явились ${n(rep.availability?.becameAvailable)}, зникли ${n(rep.availability?.becameUnavailable)})`);
    if (rep.supplierChanges?.rows) lines.push(`Зміни постачальника в картках: ${n(rep.supplierChanges.rows)}`);
    if (n(rep.products?.withWarnings)) lines.push(`Товари з попередженнями: ${n(rep.products.withWarnings)} (полів: ${n(rep.products.warnings)}) — постачальник змінив поле, яке у вас своє (наше значення збережено), або характеристики. Що саме й з якого значення на яке — аркуш «Попередження постачальника» (Поле, Було → Стало, Наше значення) і колонка «Попередження постачальника» в «Основному каталозі».`);
    if (n(rep.supplierChanges?.params)) lines.push(`Характеристики постачальника змінились у ${n(rep.supplierChanges.params)} товарах — наші характеристики не змінено.`);
    if (rep.presence?.gone || rep.presence?.returned) lines.push(`Зникли у постачальника: ${n(rep.presence.gone)}; повернулися: ${n(rep.presence.returned)}`);
    if (rep.queue?.pendingDecisions) lines.push(`У «Нових товарах» чекають перенесення: ${n(rep.queue.pendingDecisions)} (кнопка «Перенести затверджені»)`);
    if (rep.conflicts?.isolated) lines.push(`Ізольовано рядків (не змінювались): ${n(rep.conflicts.isolated)}`);
  }
  // Гібрид (рішення власника 16.11): «Оновити з Хорошопу» = оновлення списку з «Excel (розширений)» + «Ціни».
  const hr = report?.horoshopRefresh;
  if (op === "horoshop" && hr) lines.push(hr.state === "REFRESHED" ? `Excel Хорошопу оновлено: ${n(hr.count)} рядків (файл від ${hr.lastModified || "?"})` : `Excel Хорошопу: ${clip(hr.reason || hr.state)}`);
  if ((op === "prices" || op === "horoshop") && r.stats) {
    const st = r.stats, sk = st.skipped || {};
    if (st.written != null) lines.push(`Оновлено товарів: ${n(st.written)}${n(st.notWritten) ? `; не записано ${n(st.notWritten)} (таблицю змінено під час операції)` : ""}`);
    lines.push(`Ціни: постачальника ${n(st.supplierPriceChanged)}, продажу ${n(st.salePriceChanged)}; наявність: ${n(st.availabilityChanged)} (з'явились ${n(st.becameAvailable)}, зникли ${n(st.becameUnavailable)}); кількість: ${n(st.quantityChanged)}`);
    const oa = st.ownerAvailability || {};
    if (n(oa.active) || n(oa.cleared)) lines.push(`«Наявність власника»: діє ${n(oa.active)}${n(oa.cleared) ? `; знято ${n(oa.cleared)} (постачальник оновив наявність — далі його наявність)` : ""}`);
    const op = st.ownerPrice || {};
    if (n(op.active) || n(op.cleared)) lines.push(`«Ціна власника»: діє ${n(op.active)}${n(op.cleared) ? `; знято ${n(op.cleared)} (ціна у фіді постачальника змінилась — далі ціна з фіду)` : ""}`);
    const mism = Object.values(sk.mismatch || {}).reduce((a, b) => a + n(b), 0);
    if (mism) lines.push(`Не змінено ${mism}: у постачальника змінились назва / артикул тощо — спершу «Оновити товари»`);
    if (n(sk.missing)) lines.push(`Немає у фіді постачальника: ${n(sk.missing)} — їх перевіряє «Оновити товари»`);
    if (n(sk.removed) || n(sk.gone)) lines.push(`Пропущено видалені: ${n(sk.removed) + n(sk.gone)}`);
    if (r.feed?.offers) lines.push(`Товарів у фіді: ${n(r.feed.offers)}`);
    // Гібрид (рішення власника 16.11): звідки взято ціни й наявність.
    const hs = r.horoshop;
    if (hs?.error) lines.push(`Хорошоп: ${hs.error}`);
    else if (hs) {
      // Рішення власника 16.11: «якщо товар за артикулом сходиться беремо» — не застосовано лише помилку Excel (дроп більший за РРЦ).
      const ids = (xs, k = 5) => xs.slice(0, k).map((x) => x.id).join(", ") + (xs.length > k ? "…" : "");
      const skipped = n(hs.skipped) ? `; не застосовано ${n(hs.skipped)} — помилка в Excel (дроп більший за РРЦ), ціна й наявність з Prom-фіду: ${ids(hs.skippedList || [])}` : "";
      lines.push(`РРЦ і наявність із Хорошопу (Excel від ${hs.date || "?"}): ${n(hs.matched)} товарів, ціна змінилась у ${n(hs.priceChanged)}; без пари ${n(hs.withoutPair)} — з Prom-фіду${n(hs.ambiguous) ? `; неоднозначних ${n(hs.ambiguous)}` : ""}${skipped}`);
      if (n(hs.namesDiffer)) lines.push(`Назви в Excel і Prom-фіді різні (взято за артикулом, для перевірки): ${n(hs.namesDiffer)} — ${ids(hs.namesDifferList || [], 8)}`);
    }
    if (n(st.bigPriceChanges)) lines.push(`Ціна постачальника змінилась більш ніж удвічі: ${n(st.bigPriceChanges)} — перевірте: ${(st.bigPriceList || []).slice(0, 8).map((x) => `${x.id} (${x.from} → ${x.to})`).join(", ")}${n(st.bigPriceChanges) > 8 ? "…" : ""}`);
  }
  // Рішення власника 04.11: опрацьовані попередження постачальника переносяться в архів під час «Цін» і «Оновити товари».
  const wa = r.warningsArchive;
  if ((op === "prices" || op === "update") && wa) {
    if (n(wa.archived)) lines.push(`Опрацьовані попередження перенесено в «Попередження — архів»: ${n(wa.archived)}; відкритих лишилось: ${n(wa.open)}`);
    else if (wa.state === "ERROR" || wa.state === "INCOMPLETE" || wa.state === "BLOCKED") lines.push("Архів попереджень: не виконано (" + clip(wa.reason, 200) + ") — повтор наступного запуску");
  }
  if (op === "find-new" && rep) {
    lines.push(`Нових ID у фіді: ${n(rep.found?.total)} (повних ${n(rep.found?.complete)}, без повних даних ${n(rep.found?.incomplete)})`);
    if (rep.intake) {
      lines.push(`Додано в «Нові товари»: ${n(rep.intake.added)}; можливих дублів: ${n(rep.intake.possibleDuplicates)}`);
      const res = Object.entries(rep.intake.results || {}).filter(([, v]) => n(v));
      if (res.length) lines.push("Кандидати: " + res.map(([k, v]) => `${k} — ${n(v)}`).join("; "));
      if (rep.intake.reason) lines.push("Причина: " + clip(rep.intake.reason, 300));
      // Причини відмов (по кандидатах — у звіті intake); найчастіші — для власника.
      const why = {};
      for (const x of Object.values(r.intake?.ack?.results || {})) if (x?.status === "ВІДМОВА" && x.reason) why[x.reason.replace(/:.*$/, "")] = (why[x.reason.replace(/:.*$/, "")] || 0) + 1;
      for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 5)) lines.push(`Відмова (${v}): ${clip(k, 200)}`);
      if (Object.keys(why).some((k) => /стабільність не підтверджена/.test(k))) lines.push("Підказка: товар додається, коли пробуде у фіді без змін 10 хвилин від ПЕРШОГО виявлення; натисніть «Знайти нові товари» ще раз пізніше (повторні натискання відлік не скидають).");
    }
    const ex = Object.entries(rep.excluded || {}).filter(([, v]) => n(v));
    if (ex.length) lines.push("Не нові (уже відомі): " + ex.map(([k, v]) => `${k} — ${n(v)}`).join("; "));
    if (n(rep.found?.waiting)) lines.push(`Чекають перевірки стабільності: ${n(rep.found.waiting)} — додамо, коли пробудуть у фіді без змін 10 хв від першого виявлення; натисніть «Знайти нові товари» ще раз пізніше`);
  }
  if (op === "transfer") {
    if (r.moved !== undefined) lines.push(`Перенесено в «Основний каталог»: ${n(r.moved)}${r.count ? `; у каталозі тепер ${n(r.count)}` : ""}`);
    if (r.removedFromQueue !== undefined) lines.push(`Прибрано з «Нових товарів»: ${n(r.removedFromQueue)}`);
    if (n(r.rejected)) lines.push(`Відхилено (дублі / не беремо) → «Заморожені ID», прибрано з «Нових товарів»: ${n(r.rejected)}`);
    for (const x of (r.rejectSkipped || []).slice(0, 10)) lines.push(`Не відхилено ${mtText(x.offerId)}: ${clip(x.why, 200)}`);
    for (const p of (r.notTransferred || []).slice(0, 30)) lines.push(`Не перенесено ${mtText(p.offerId)}: ${clip(p.problems?.join("; ") || p.reason, 300)}`);
    if ((r.notTransferred || []).length > 30) lines.push(`… ще ${r.notTransferred.length - 30} — див. колонку «Перевірка» в «Нових товарах»`);
    if ((r.droppedColumns || []).length && n(r.moved)) lines.push(`Колонок немає в «Основному каталозі» — їх не перенесено: ${r.droppedColumns.join(", ")}`);
    for (const c of (r.conflicts || []).slice(0, 10)) lines.push(`Не прибрано з «Нових товарів» ${mtText(c.offerId)}: ${clip(c.why, 200)}`);
    if (r.next) lines.push("Далі: " + r.next);
  }
  if (op === "deferred" || op === "deferred-plan") {
    const toMain = r.toMain || [], toArchive = r.toArchive || [];
    lines.push(`${op === "deferred-plan" ? "За планом — " : ""}повернуто в «Основний каталог»: ${toMain.length}${toMain.length ? " (" + toMain.join(", ") + ")" : ""}`);
    lines.push(`${op === "deferred-plan" ? "За планом — " : ""}у «Видалені товари»: ${toArchive.length}${toArchive.length ? " (" + toArchive.join(", ") + ")" : ""}`);
    for (const k of (r.keep || []).slice(0, 30)) lines.push(`Лишено у «Відкладених» ${mtText(k.offerId)}: ${clip(k.reason, 300)}`);
    if (r.deferredLeft !== undefined) lines.push(`У «Відкладених товарах» лишилось рядків: ${n(r.deferredLeft)}`);
    for (const c of (r.conflicts || []).slice(0, 10)) lines.push(`Не прибрано ${mtText(c.offerId)}: ${clip(c.why, 200)}`);
    if (r.next) lines.push("Далі: " + r.next);
  }
  if (op === "reconcile") {
    if (Array.isArray(r.results)) lines.push(`Звірено записів: ${r.results.length}; нерозв'язаних: ${n(r.unresolved)}`);
    if (r.blocking?.length) lines.push(`Потребують рішення: ${r.blocking.length}`);
  }
  if (r.recovery?.state) lines.push(`Відновлення попереднього запуску: ${r.recovery.state}`);
  return lines.join("\n");
}
