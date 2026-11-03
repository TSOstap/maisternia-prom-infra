/** ENG-28d (F-28B-1 / F-28B-2) — контрольний план запуску й відновлення «Журналу» після часткового збою.
 *
 *  Не транзакція: Google Sheets не має атомарного умовного запису (R-N3W відкритий). План лише робить стан ПІСЛЯ збою з'ясовним:
 *   1. До першого запису в сховищі W2 (умовний запис за версією) фіксується план: стабільний ID запуску, ВСІ заплановані події «Журналу»
 *      зі стабільними ID і «докази» — заплановані зміни клітинок «Основного каталогу» (відбитки «було» / «стало»).
 *   2. Події пишуться в «Журнал» дописуванням ЗА КЛЮЧЕМ «ID події» (appendMissingByKey): повтор не дублює, невідомий результат
 *      з'ясовується reconcile W2 за ключами (окремого «сирого» запису журналу немає).
 *   3. Стани плану: PLANNED (товарні записи не підтверджено) → PRODUCT_DONE (товарні записи перевірено читанням) → DONE (усі події
 *      є в «Журналі» за ID). ABANDONED — товарні записи не застосовано (відкочено) — подій не відновлюють.
 *   4. Відновлення (наступний запуск, лише з сесією W2 у стані READY, тобто після reconcile):
 *       PRODUCT_DONE → дописати відсутні за ID події (вони підтверджені перевіркою запуску);
 *       PLANNED     → перечитати клітинки-докази: «стало» → подію відновити; «було» → ні (зміни не було); інше значення → BLOCK
 *                     (правка людини / невідомий стан — рішення власника). Події без доказу (підсумок, «ЗАВЕРШЕНО», «ПОМИЛКА»…) —
 *                     лише якщо ВСІ докази «стало». Вигаданих подій немає: відновлюється лише записане в плані до запису.
 *   Товарні записи заради журналу не повторюються. */
import crypto from "node:crypto";
import { mtText } from "../core/text.mjs";
import { MANAGED_FIELDS } from "../core/field-control.mjs";
import { OP } from "./safe-write/keyed-update.mjs";

export const EVENT_ID_COLUMN = "ID події";
export const JOURNAL_SHEET = "Журнал";
export const JOURNAL_HEADER = Object.freeze(["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус", EVENT_ID_COLUMN]);
/** Один активний план товарного запуску («Оновити товари» / sync / QA) — записувач один (оренда W2). */
export const RUN_PLAN_KEY = "state/run-plan/current.json";
/** Контрольний план перенесення NEW92 (F-28B-2). */
export const TRANSFER_PLAN_KEY = "state/transfer-new92/plan.json";
/** ENG-29: контрольний план «Перенести затверджені» (src/core/transfer-approved.mjs — той самий ключ). */
export const TRANSFER_APPROVED_KEY = "state/transfer-approved/plan.json";
/** ENG-29: контрольний план розбору «Відкладених товарів» (src/core/deferred-resolve.mjs — той самий ключ). */
export const DEFERRED_PLAN_KEY = "state/deferred-resolve/plan.json";
export const PLAN = Object.freeze({ PLANNED: "PLANNED", PRODUCT_DONE: "PRODUCT_DONE", DONE: "DONE", ABANDONED: "ABANDONED" });
/** Закриті стани; будь-який інший (PLANNED / PRODUCT_DONE запуску; MAIN_DONE / MARKS_DONE / PASSPORT_DONE перенесення) — відкритий. */
const CLOSED = new Set([PLAN.DONE, PLAN.ABANDONED]);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const DISCOUNT = "Знижка";
/** Нормалізація клітинки для порівняння: «Знижка» «20%» (текст) = 0.2 (число) — як sheetDiscount. */
export function normCell(column, v) {
  if (column !== DISCOUNT || typeof v !== "string") return mtText(v);
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*%\s*$/.exec(v);
  return m ? String(Math.round(Number(m[1].replace(",", ".")) * 10000) / 1000000) : mtText(v);
}
export const cellHash = (column, v) => sha(normCell(column, v)).slice(0, 20);

/** Стабільні ID подій: ID запуску + відбиток вмісту рядка (7 колонок, у формі аркуша) + порядковий номер однакових. */
export function withEventIds(runId, rows) {
  const seen = new Map();
  return rows.map((r) => {
    const base = r.slice(0, 7).map((v) => mtText(v));
    const h = sha(JSON.stringify(base)).slice(0, 16);
    const k = (seen.get(h) || 0) + 1;
    seen.set(h, k);
    return [...r.slice(0, 7), `${runId}#${h}.${k}`];
  });
}
export const isOpen = (plan) => Boolean(plan && plan.status && !CLOSED.has(plan.status));
export async function loadPlan(store, key = RUN_PLAN_KEY) {
  const r = await store.getJsonVersioned(key);
  return { plan: r?.value || null, version: r?.version ?? null };
}
/** Запис плану — умовний за версією (паралельний запис → CONFLICT → виняток). */
export async function savePlan(store, key, plan, version) {
  const r = await store.putJsonIfVersion(key, plan, version);
  return r?.version ?? r;
}

/** Колонка «Журналу» «ID події»: ширина й заголовок (лише клітинка заголовка, решта рядка 1 не змінюється). */
export async function ensureEventIdColumn(W, journalValues) {
  const h = (journalValues?.[0] || []).map(mtText);
  if (h.includes(EVENT_ID_COLUMN)) return h.indexOf(EVENT_ID_COLUMN);
  const col = Math.max(JOURNAL_HEADER.length, h.length + 1);
  await W.ensureColumns(JOURNAL_SHEET, col);
  await W.updateRanges([{ title: JOURNAL_SHEET, row: 1, col, values: [[EVENT_ID_COLUMN]] }]);
  return col - 1;
}
/** Рядки подій під фактичний заголовок «Журналу» (ID — у колонці «ID події»). */
export function rowsForJournal(rows, journalHeader) {
  const h = journalHeader.map(mtText), k = h.indexOf(EVENT_ID_COLUMN);
  const width = Math.max(h.length, JOURNAL_HEADER.length);
  return rows.map((r) => { const x = Array.from({ length: width }, (_, j) => (j < 7 ? r[j] ?? "" : "")); x[k] = r[7]; return x; });
}
/** ID подій, що вже є в «Журналі». */
export function journalIds(values) {
  const h = (values?.[0] || []).map(mtText), k = h.indexOf(EVENT_ID_COLUMN);
  return new Set(k < 0 ? [] : (values || []).slice(1).map((r) => mtText(r?.[k])).filter(Boolean));
}

/** Докази: заплановані зміни клітинок «Основного каталогу» { offerId, column, b (відбиток «було»), a (відбиток «стало») }. */
export function evidenceCell(offerId, column, before, after) {
  return { offerId: mtText(offerId), column, b: cellHash(column, before), a: cellHash(column, after) };
}
const RAW_OF = new Map(MANAGED_FIELDS.filter((f) => f.raw).map((f) => [f.field, f.raw]));
/** Подія → ключі доказів (offerId|колонка), якщо подія описує заплановану зміну клітинки; інакше [] (подія рівня запуску). */
export function eventEvidenceKeys(row, evidenceIndex) {
  const offerId = mtText(row[2]), field = mtText(row[3]);
  if (!offerId) return [];
  const direct = `${offerId}|${field}`;
  if (evidenceIndex.has(direct)) return [direct];
  if (/^ПОПЕРЕДЖЕННЯ ПОСТАЧАЛЬНИКА/.test(mtText(row[6])) && RAW_OF.has(field)) { const k = `${offerId}|${RAW_OF.get(field)}`; if (evidenceIndex.has(k)) return [k]; }
  return [];
}

/** Класифікація доказів за свіжим читанням «Основного каталогу»: APPLIED / NOT_APPLIED / OTHER (інше значення, рядка немає, дубль). */
export function classifyEvidence(mainValues, evidence) {
  const h = (mainValues?.[0] || []).map(mtText), ko = h.indexOf("Offer ID");
  const rows = new Map(), dup = new Set();
  for (const r of (mainValues || []).slice(1)) { const k = mtText(r?.[ko]); if (!k) continue; if (rows.has(k)) dup.add(k); rows.set(k, r); }
  return evidence.map((c) => {
    if (dup.has(c.offerId)) return { ...c, status: "OTHER", why: "Offer ID у кількох рядках" };
    const r = rows.get(c.offerId), j = h.indexOf(c.column);
    if (!r) return { ...c, status: "OTHER", why: "рядка немає" };
    if (j < 0) return { ...c, status: c.b === cellHash(c.column, "") ? "NOT_APPLIED" : "OTHER", why: "колонки немає" };
    const now = cellHash(c.column, r[j] ?? "");
    return { ...c, status: now === c.a ? "APPLIED" : now === c.b ? "NOT_APPLIED" : "OTHER", why: now === c.a || now === c.b ? "" : "значення не збігається ні з «було», ні зі «стало» (правка людини або невідомий стан)" };
  });
}

/**
 * Які події плану відновлювати. plan.status PRODUCT_DONE — усі (товарні записи перевірено запуском); PLANNED — за доказами.
 * → { decision: "RECOVER" | "ABANDON" | "BLOCK", events: [рядки з ID], cells: {applied, notApplied, other}, other: [...] }
 */
export function planRecovery(plan, mainValues) {
  if (plan.status === PLAN.PRODUCT_DONE) return { decision: "RECOVER", events: plan.events, cells: null, other: [] };
  const cls = classifyEvidence(mainValues, plan.evidence || []);
  const other = cls.filter((c) => c.status === "OTHER");
  const cells = { applied: cls.filter((c) => c.status === "APPLIED").length, notApplied: cls.filter((c) => c.status === "NOT_APPLIED").length, other: other.length };
  if (other.length) return { decision: "BLOCK", events: [], cells, other: other.slice(0, 50).map(({ offerId, column, why }) => ({ offerId, column, why })) };
  const st = new Map(cls.map((c) => [`${c.offerId}|${c.column}`, c.status]));
  const allApplied = cls.every((c) => c.status === "APPLIED");
  // Немає доказів (зміни не підтверджуються жодною клітинкою) або жодна не застосована — нічого не стверджуємо: подій не відновлюємо.
  if (!cls.length || cls.every((c) => c.status === "NOT_APPLIED")) return { decision: "ABANDON", events: [], cells, other: [] };
  const events = plan.events.filter((row) => { const keys = eventEvidenceKeys(row, st); return keys.length ? keys.every((k) => st.get(k) === "APPLIED") : allApplied; });
  return { decision: "RECOVER", events, cells, other: [], partial: !allApplied };
}

/**
 * Відновлення відкритого плану (наступний запуск після збою). Лише з сесією W2 READY (reconcile виконано). Пише ЛИШЕ відсутні за ID
 * події плану (+ одна подія про відновлення) — товарних записів немає. Результат: JOURNAL_RECOVERED / RUN_PLAN_ABANDONED / BLOCKED.
 */
export async function recoverRunPlan({ store, key = RUN_PLAN_KEY, session, readBook, stamp, mainTitle = "Основний каталог" }) {
  const { plan, version } = await loadPlan(store, key);
  if (!isOpen(plan)) return { state: "NOTHING", reason: "відкритого плану немає" };
  if (!session || session.state !== "READY") return { state: "BLOCKED", reason: `незавершений запуск ${plan.runId}: спершу reconcile W2 (сесія ${session?.state ?? "відсутня"})`, plan: brief(plan) };
  const book = await readBook([mainTitle, JOURNAL_SHEET]);
  const rec = planRecovery(plan, book[mainTitle]);
  if (rec.decision === "BLOCK") return { state: "BLOCKED", reason: `незавершений запуск ${plan.runId}: стан клітинок не збігається з планом — відновлення журналу небезпечне, потрібне рішення власника`, cells: rec.cells, other: rec.other, plan: brief(plan) };
  if (rec.decision === "ABANDON") {
    await savePlan(store, key, { ...plan, status: PLAN.ABANDONED, closedAt: stamp, closedBy: "recovery: товарних змін плану немає (не застосовано або відкочено)" }, version);
    return { state: "RUN_PLAN_ABANDONED", reason: `незавершений запуск ${plan.runId}: жодна запланована зміна не застосована — подій не відновлено`, cells: rec.cells, plan: brief(plan) };
  }
  const have = journalIds(book[JOURNAL_SHEET]);
  const missing = rec.events.filter((r) => !have.has(mtText(r[7])));
  const note = withEventIds(`recovery:${plan.runId}`, [[stamp, "СИСТЕМА", "", "ВІДНОВЛЕННЯ ЖУРНАЛУ", plan.runId, missing.length, JSON.stringify({ planStatus: plan.status, planned: plan.events.length, recoverable: rec.events.length, present: rec.events.length - missing.length, appended: missing.length, partialProductWrite: Boolean(rec.partial), cells: rec.cells })]]);
  const res = await appendEvents({ session, journalValues: book[JOURNAL_SHEET], rows: [...missing, ...note], generation: "journal-recovery:" + plan.runId });
  if (!res.ok) return { state: "INCOMPLETE", reason: `відновлення журналу ${plan.runId}: ${res.outcome} — повтор після reconcile`, plan: brief(plan) };
  await savePlan(store, key, { ...plan, status: rec.partial ? PLAN.ABANDONED : PLAN.DONE, recovered: { at: stamp, appended: missing.length, partial: Boolean(rec.partial) }, closedAt: stamp }, version);
  return { state: "JOURNAL_RECOVERED", reason: `незавершений запуск ${plan.runId}: дописано ${missing.length} відсутніх подій (з ${rec.events.length} підтверджених)${rec.partial ? "; частина товарних змін не застосована — їх події не відновлено" : ""}`, appended: missing.length, recoverable: rec.events.length, cells: rec.cells, partial: Boolean(rec.partial), plan: brief(plan) };
}
const brief = (p) => ({ runId: p.runId, kind: p.kind, status: p.status, events: p.events?.length ?? 0, evidence: p.evidence?.length ?? 0, createdAt: p.createdAt });

/** Стани брами, після яких запуск ПРОДОВЖУЄ штатну роботу (журнал попереднього запуску повний або план закрито без подій). */
export const RECOVERY_DONE = Object.freeze(new Set(["JOURNAL_RECOVERED", "RUN_PLAN_ABANDONED"]));

/**
 * Брама перед новим товарним запуском («Оновити товари» / sync / QA / «Знайти нові товари»): незавершене перенесення → BLOCKED (спершу
 * --mode=merge відновлює його); незавершений план запуску → відновлення журналу (recover = true) або BLOCKED; інакше null (можна працювати).
 */
export async function openPlansGate({ store, session, readBook, stamp, recover = true }) {
  if (!store?.getJsonVersioned) return null;
  const t = (await loadPlan(store, TRANSFER_PLAN_KEY)).plan;
  if (isOpen(t)) return { state: "BLOCKED", reason: `незавершене перенесення ${t.opId} (${t.status}) — спершу --mode=merge (контрольоване продовження або рішення власника); інших записів немає`, transferPlan: { opId: t.opId, status: t.status } };
  // ENG-29: незавершене «Перенести затверджені» — спершу його продовження (та сама кнопка); інших товарних записів немає.
  const ta = (await loadPlan(store, TRANSFER_APPROVED_KEY)).plan;
  if (isOpen(ta)) return { state: "BLOCKED", reason: `незавершене «Перенести затверджені» ${ta.opId} (${ta.status}) — спершу натисніть «Перенести затверджені» ще раз (продовження); інших записів немає`, transferPlan: { opId: ta.opId, status: ta.status } };
  const dr = (await loadPlan(store, DEFERRED_PLAN_KEY)).plan;
  if (isOpen(dr)) return { state: "BLOCKED", reason: `незавершений розбір «Відкладених товарів» ${dr.opId} (${dr.status}) — спершу продовження тієї самої операції; інших записів немає`, transferPlan: { opId: dr.opId, status: dr.status } };
  const r = (await loadPlan(store, RUN_PLAN_KEY)).plan;
  if (!isOpen(r)) return null;
  if (!recover) return { state: "BLOCKED", reason: `незавершений запуск ${r.runId} (${r.status}) — спершу відновлення журналу («Оновити товари» або QA після reconcile)`, plan: brief(r) };
  return recoverRunPlan({ store, session, readBook, stamp });
}

/** Дописування подій за ключем «ID події» (через сесію W2: reconcile за ключами). → { ok, outcome, appended }. */
export async function appendEvents({ session, journalValues, rows, generation, read = null }) {
  if (!rows.length) return { ok: true, outcome: OP.NOTHING, appended: 0 };
  const idx = await ensureEventIdColumn(session.sheets, journalValues);
  const header = (journalValues?.[0] || []).map(mtText);
  const h = Array.from({ length: Math.max(header.length, idx + 1) }, (_, j) => header[j] ?? "");
  h[idx] = EVENT_ID_COLUMN;
  // ENG-29: read — вузьке читання «Журналу» (заголовок + «ID події»): дописуванню за ключем більше нічого не потрібно.
  const r = await session.appendMissingByKey({ title: JOURNAL_SHEET, rows: rowsForJournal(rows, h), generation, ...(read ? { read } : {}) });
  return { ok: [OP.VERIFIED, OP.NOTHING].includes(r.outcome), outcome: r.outcome, appended: r.appended?.length ?? 0 };
}
