/** Етап S1: застосування плану до таблиці (лише ТЕСТОВА КОПІЯ) з перевіркою після запису й поверненням попередніх значень.
 *  sheets   — GoogleSheetsWriter | MemorySheets (src/pipeline/sheets-writer.mjs)
 *  readBook — async (назви) => { [назва]: values2D } — свіже читання таблиці (для перевірки після запису). */
import { mtText } from "../core/text.mjs";
import { LIVE_COLUMNS, readSheet } from "../core/sync-plan.mjs";
import { YML_HEADERS, SEAL_COLUMN, approvalManifest, rowSeal } from "../core/seal.mjs";
import { objectsFromValues } from "../core/yml.mjs";
import { GROUP_HEADERS } from "../core/seal.mjs";
import { SHEET, QUEUE_HEADERS, PASSPORT_HEADER, BINDINGS_SHEET, BINDINGS_HEADERS, ackFor, finalizeSheetSync, passportValues, planIntake, planSheetSync, readPassport, samePassport } from "../core/sheet-sync.mjs";
import { loadPromCatalog } from "./prom-schemas.mjs";
import { keyedUpdate, appendMissingByKey, OP, ITEM } from "./safe-write/keyed-update.mjs";
import { WARN_SHEET, WARN_HEADER, warningRow, CLASSIFY_SHEET, CLASSIFY_HEADER, classifyRow } from "./supplier-warnings.mjs";
import { ARCHIVE_SHEET } from "../core/archive.mjs";
import { loadOwnership, writableColumns } from "./safe-write/ownership.mjs";
import { withProvisionalQueue } from "./safe-write/queue-ownership.mjs";
import { outcomeOf } from "./write-outcome.mjs";
import { enabled as ownerPriorityEnabled, cardVerdict } from "../core/owner-priority.mjs";
import { planPresence, planScopeMarks, presenceInputRows, PRESENCE_COLUMN, PRESENCE_META_COLUMN } from "../core/supplier-presence.mjs";
import { estimateRequests, DEFAULT_MAX_CHUNK_CHARS } from "./sheets-writer.mjs";
import { RUN_PLAN_KEY, TRANSFER_PLAN_KEY, PLAN, EVENT_ID_COLUMN, JOURNAL_SHEET, RECOVERY_DONE, openPlansGate, loadPlan, savePlan, isOpen, withEventIds, evidenceCell, appendEvents, journalIds } from "./run-plan.mjs";

/** CC R6: стан Catalog Controls для синхронізації / intake. controls — адаптер { state(), verify(fp) } (controls-adapter.mjs) або
 *  готовий стан. Будь-яка помилка читання → blocked (fail-closed). Без режиму пріоритету власника — не потрібен (null). */
export async function syncControlsState(controls, config) {
  if (!ownerPriorityEnabled(config)) return null;
  if (!controls) return null;
  try {
    const s = typeof controls.state === "function" ? await controls.state() : controls;
    return s && typeof s === "object" ? s : { blocked: true, reasons: ["стан Catalog Controls порожній"] };
  } catch (e) { return { blocked: true, reasons: ["стан Catalog Controls не прочитано: " + (e?.message || e)] }; }
}
/** Перед записом: стан CC той самий, що під час планування (новий tombstone між плануванням і записом → нічого не пишемо). */
export async function ccUnchanged(controls, st) {
  if (!st || typeof controls?.verify !== "function") return { ok: true };
  try { const v = await controls.verify(st.fingerprint); return v?.ok ? { ok: true } : { ok: false, reason: (v?.reasons || []).join("; ") || "відбиток змінився" }; }
  catch (e) { return { ok: false, reason: "перевірку не виконано: " + (e?.message || e) }; }
}

/** Схеми категорій Prom із репозиторію (schemas/prom); помилки схем — лише попередження (така схема не використовується). */
export function catalogFor(catalog, warnings) {
  const c = catalog ?? loadPromCatalog();
  for (const p of c.problems || []) warnings.push("схема Prom: " + p);
  // Підтверджені рішення власника щодо характеристик (файл поза репозиторієм, MM_OWNER_VALUES): без файлу не застосовуються —
  // попередження, щоб синхронізація без них не пройшла непомітно (не блокує).
  if (c.schemas?.size && !c.ownerValues) warnings.push(`рішення власника щодо характеристик не підключено (MM_OWNER_VALUES) — підтверджені виправлення не застосовуються${c.ownerIndex?.size ? `; характеристики ${c.ownerIndex.size} товарів з переліку рішень утримано (значення постачальника не передано)` : ""}`);
  // Технічні нормалізації (пакет А1 і далі) — лише з валідним переліком захищених товарів (MM_FREEZE_IDS); інакше вимкнено для всіх.
  if (c.schemas?.size && !c.freezeInfo?.valid) warnings.push("технічні нормалізації (A1, A2) не активні: немає валідного переліку захищених товарів (MM_FREEZE_IDS) — характеристики як до пакетів А1 / А2");
  if (c.schemas?.size && c.freezeInfo?.valid && !c.a3Info?.valid) warnings.push("точні пари А3 не активні: немає валідного переліку пар (MM_A3_PAIRS) — переклади як до пакета А3");
  if (c.schemas?.size && c.freezeInfo?.valid && !c.cohortInfo?.valid) warnings.push("правила N1 не активні: немає валідної когорти N0 (MM_N0_COHORT) — характеристики як до пакета N1");
  return c;
}

export const SYNC_SHEETS = [SHEET.main, SHEET.queue, SHEET.deferred, SHEET.frozen, SHEET.passport, BINDINGS_SHEET, "Аудит", WARN_SHEET, ARCHIVE_SHEET, CLASSIFY_SHEET];
const rowsEqual = (a, b) => a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((v, j) => mtText(v) === mtText(b[i][j])));
const pad = (r, n) => Array.from({ length: n }, (_, i) => (r[i] == null ? "" : r[i]));
export const groupsOf = (book) => objectsFromValues(book[SHEET.groups], GROUP_HEADERS);
const JOURNAL_CHUNK = 2000;
const DISCOUNT = "Знижка";

/** Знижка в таблиці — як у mtUpdate: ЧИСЛО (0.2) з форматом «0%» (Google показує «20%»).
 *  План (порт mtPlan) повертає «20%» — це рядок, який Apps Script при setValues сам перетворює на число 0.2;
 *  запис RAW цього не робить, тож перетворюємо тут. Формули цін і план не змінюються. */
export function sheetDiscount(v) {
  if (typeof v !== "string") return v;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*%\s*$/.exec(v);
  return m ? Math.round(Number(m[1].replace(",", ".")) * 10000) / 1000000 : v;
}
/** Рядок значень під заголовок: колонка «Знижка» — числом. */
const forSheet = (header, values) => values.map((v, j) => (header[j] === DISCOUNT ? sheetDiscount(v) : v));
/** Запис «Журналу»: для поля «Знижка» «було/стало» — числа, як у mtUpdate. */
export const journalRow = (e) => (e[3] === DISCOUNT ? [e[0], e[1], e[2], e[3], sheetDiscount(e[4]), sheetDiscount(e[5]), e[6]] : e);

/** Запис у «Журнал» у форматі mtUpdate: значення як є («+», «-» — текст). Формули не виконуються, бо запис іде лише в режимі
 *  RAW (GoogleSheetsWriter.VALUE_INPUT_OPTION): Google зберігає рядок буквально — і «=…» від постачальника лишається текстом.
 *  Апостроф НЕ додається: у RAW він зберігся б як частина тексту («'+» замість «+»). */
export async function appendJournal(sheets, entries) {
  for (let i = 0; i < entries.length; i += JOURNAL_CHUNK) await sheets.appendRows(SHEET.journal, entries.slice(i, i + JOURNAL_CHUNK).map(journalRow));
}

/** ENG-28c (М1): блоки keyedUpdate (як blocksFor у keyed-update.mjs: рядок × неперервні колонки) — для оцінки розміру запису. */
function keyedBlocks(title, header, changes) {
  const out = [];
  for (const c of changes) {
    const cols = Object.keys(c.set).sort((a, b) => header.indexOf(a) - header.indexOf(b));
    let run = [];
    const flush = () => { if (run.length) out.push({ title, row: 2, col: header.indexOf(run[0]) + 1, values: [run.map((k) => c.set[k])] }); run = []; };
    for (const k of cols) { if (run.length && header.indexOf(k) !== header.indexOf(run.at(-1)) + 1) flush(); run.push(k); }
    flush();
  }
  return out;
}
/** ENG-28c (М1): резерв запитів на запис події про збій у «Журнал» (шлях помилки) понад оцінку. */
export const BUDGET_RESERVE = 2;
/** writeBudget: { maxRequests, used (число або функція), maxChunkChars }. → { ok, estimate, available, reserve, byOp }. */
export function budgetCheck(writeBudget, ops) {
  const used = typeof writeBudget.used === "function" ? Number(writeBudget.used()) || 0 : Number(writeBudget.used) || 0;
  const available = Number(writeBudget.maxRequests) - used;
  const e = estimateRequests(ops, { maxChunkChars: writeBudget.maxChunkChars || DEFAULT_MAX_CHUNK_CHARS });
  return { ok: e.requests + BUDGET_RESERVE <= available, estimate: e.requests, reserve: BUDGET_RESERVE, available, maxRequests: Number(writeBudget.maxRequests), used, byOp: e.byOp };
}
/** ENG-28c (М1): запланована послідовність записів syncSheet (той самий порядок, що й нижче) → оцінка запитів. Верхня межа: дописування
 *  службових рядків і черга враховуються повністю (фактично — лише відсутні / змінені). */
function syncPreflight({ writeBudget, book, plan, mainHeader, opsBlock, cardChanges, rowsC, rowsW, history, undoCells, stateCol, approve, reject, queueOff, queueChanged, queueValues, journal, opMode, keyedJournal = false }) {
  const ops = [];
  if (rowsC.length) ops.push({ op: "ensureSheet", exists: Boolean(book[CLASSIFY_SHEET]) }, { op: "appendRows", rows: rowsC });
  if (rowsW.length) ops.push({ op: "ensureSheet", exists: Boolean(book[WARN_SHEET]) }, { op: "appendRows", rows: rowsW });
  if (plan.main.migrated.length) ops.push({ op: "ensureColumns", needed: true }, { op: "updateRanges", blocks: [{ title: SHEET.main, row: 1, col: 1, values: [mainHeader] }] });
  ops.push({ op: "updateRanges", blocks: [opsBlock] });
  const accepted = opMode ? plan.ownerPriority.accepted : [];
  if (accepted.length) ops.push({ op: "updateRanges", blocks: accepted.map((a) => ({ title: SHEET.main, row: 2, col: 1, values: [[a.intermediateState]] })) });
  if (cardChanges.length) ops.push({ op: "updateRanges", blocks: keyedBlocks(SHEET.main, mainHeader, cardChanges) });
  if (history.length) ops.push({ op: "ensureSheet", exists: Boolean(book[BINDINGS_SHEET]) }, { op: "appendRows", rows: history });
  if (undoCells.length) ops.push({ op: "updateRanges", blocks: undoCells.map((c) => ({ title: BINDINGS_SHEET, row: c.row, col: stateCol, values: [[c.state]] })) });
  if (approve.length) ops.push({ op: "appendRows", rows: approve.map((r) => mainHeader.map((k) => r[k] ?? "")) });
  if (!queueOff && !queueChanged) {
    if (plan.queue.migrated.length) ops.push({ op: "ensureColumns", needed: true }, { op: "updateRanges", blocks: [{ title: SHEET.queue, row: 1, col: 1, values: [plan.queue.header] }] });
    if (queueValues.length) ops.push({ op: "updateRanges", blocks: [{ title: SHEET.queue, row: 2, col: 1, values: queueValues }] });
  }
  ops.push({ op: "setPercentFormat" });
  if (reject.length) ops.push({ op: "appendRows", rows: reject.map((r) => [mtText(r["Offer ID"])]) });
  ops.push({ op: "updateRanges", blocks: [{ title: SHEET.passport, row: 1, col: 1, values: Array.from({ length: 8 }, () => ["", "x".repeat(80)]) }] });
  // ENG-28d: «Журнал» за «ID події» — одне дописування (порції — за розміром) + колонка ID (верхня межа: щоразу); інакше — старий шлях.
  if (keyedJournal) ops.push({ op: "ensureColumns", needed: true }, { op: "updateRanges", blocks: [{ title: SHEET.journal, row: 1, col: 8, values: [[EVENT_ID_COLUMN]] }] }, { op: "appendRows", rows: journal.map((e) => [...journalRow(e), "x".repeat(60)]) });
  else for (let i = 0; i < journal.length; i += JOURNAL_CHUNK) ops.push({ op: "appendRows", rows: journal.slice(i, i + JOURNAL_CHUNK).map(journalRow) });
  return budgetCheck(writeBudget, ops);
}

/** Рядок «Журналу» про заблоковане оновлення: [час, СИСТЕМА, —, ОНОВЛЕННЯ ЗАБЛОКОВАНО, тип, зачеплено/поріг, причина]. */
export function blockedEntry(stamp, block) {
  const scope = [block.affected !== "" && block.affected != null ? `зачеплено ${block.affected}` : "", block.limit !== "" && block.limit != null ? `поріг ${block.limit}` : ""].filter(Boolean).join("; ");
  return [stamp, "СИСТЕМА", "", "ОНОВЛЕННЯ ЗАБЛОКОВАНО", block.type, scope, block.reason];
}

/** Заблокований запуск: дозволено ЛИШЕ записати подію в «Журнал». Збій цього запису не приховує причину (вона в результаті). */
export async function recordBlocked(sheets, stamp, block) {
  try { await appendJournal(sheets, [blockedEntry(stamp, block)]); return { journalWritten: true }; }
  catch (e) { return { journalWritten: false, journalError: String(e?.message || e).slice(0, 200) }; }
}

/** Причина відмови перевірки фіду (validateFeed / розбір) → блокування для «Журналу». */
export function feedBlock(message, { count = "", minimum = "", maxAgeHours = "" } = {}) {
  const m = String(message || "");
  if (/Неповний фід/.test(m)) return { type: "НЕПОВНИЙ XML", reason: "фід постачальника неповний: різке зменшення кількості позицій", affected: count, limit: minimum };
  if (/Застарілий або майбутній/.test(m)) return { type: "ЗАСТАРІЛИЙ XML", reason: `фід постачальника застарілий або з датою в майбутньому (допустимо до ${maxAgeHours} год)`, affected: "", limit: maxAgeHours };
  if (/Немає дати/.test(m)) return { type: "ПОШКОДЖЕНИЙ XML", reason: "у фіді постачальника немає коректної дати", affected: "", limit: "" };
  return { type: "ПОШКОДЖЕНИЙ XML", reason: "фід постачальника не вдалося розібрати", affected: "", limit: "" };
}

/** Переписує дані аркуша (рядки 2..) на `values`: оновлення наявних рядків, дописування нових, видалення зайвих.
 *  noDelete (шлюз запису E3): зайві рядки в кінці НЕ видаляються, а очищаються (порожні значення); Sheets API порожніх рядків
 *  у кінці аркуша не повертає, тож для читання вони не існують. Позиційного видалення немає. */
/** ENG-27 (Hermes INT N3): рішення власника черги за Offer ID → { decision, supplier, dup }. Лише читання. */
/** ENG-28: рядки основного каталогу для плану присутності (поточні значення системних колонок; колонок ще немає — порожньо). */
function presenceRowsOf(values) {
  const h = (values?.[0] || []).map(mtText), k = (c) => h.indexOf(c);
  const [o, s, p, m] = ["Offer ID", "ID постачальника", PRESENCE_COLUMN, PRESENCE_META_COLUMN].map(k);
  return (values || []).slice(1).map((r) => ({ offerId: mtText(r?.[o]), supplierId: mtText(r?.[s]), presence: p < 0 ? "" : mtText(r?.[p]), meta: m < 0 ? "" : mtText(r?.[m]) }));
}
function presenceSummary(pp, applied) {
  return pp ? { decision: pp.decision, applied, baseline: pp.baseline, gone: pp.gone.length, returned: pp.returned.length, absent: pp.absent.length, changed: pp.changed.length, outOfScope: pp.outOfScope.length, disappearing: pp.disappearing ?? 0, limit: pp.limit ?? null, updates: pp.updates.size, reasons: pp.reasons } : null;
}
function presenceJournal(pp, stamp) {
  const out = [];
  for (const [offerId, u] of pp.updates) out.push([stamp, SHEET.main, offerId, PRESENCE_COLUMN, "", u.presence || "ПРИСУТНІЙ", u.reason]);
  return out;
}
function queueDecisions(values) {
  const h = (values?.[0] || []).map(mtText), k = h.indexOf("Offer ID"), d = h.indexOf("Рішення"), s = h.indexOf("ID постачальника");
  const m = new Map();
  for (const r of (values || []).slice(1)) {
    const key = mtText(r?.[k]);
    if (!key) continue;
    m.set(key, { decision: d < 0 ? "" : mtText(r?.[d]), supplier: s < 0 ? "" : mtText(r?.[s]), dup: m.has(key) });
  }
  return m;
}
/** Рядок черги з тим самим Offer ID досі має те саме «Рішення» й ідентичність, що й у плані? → null або причина розбіжності. */
function decisionDrift(planned, now, offerId) {
  const key = mtText(offerId), a = planned.get(key), b = now.get(key);
  if (!a || a.dup) return "рядок у плані відсутній або Offer ID у черзі не єдиний";
  if (!b) return "рядок зник із черги";
  if (b.dup) return "Offer ID у черзі не єдиний";
  if (b.decision !== a.decision) return `«Рішення» змінено: «${a.decision}» → «${b.decision}»`;
  if (b.supplier !== a.supplier) return `«ID постачальника» змінено: «${a.supplier}» → «${b.supplier}»`;
  return null;
}

async function rewriteData(sheets, title, oldCount, values, { noDelete = false, width = 0 } = {}) {
  const common = Math.min(oldCount, values.length);
  if (common) await sheets.updateRanges([{ title, row: 2, col: 1, values: values.slice(0, common) }]);
  if (values.length > oldCount) await sheets.appendRows(title, values.slice(oldCount));
  if (values.length < oldCount) {
    if (noDelete) {
      const w = Math.max(width, ...values.map((r) => r.length), 1);
      await sheets.updateRanges([{ title, row: values.length + 2, col: 1, values: Array.from({ length: oldCount - values.length }, () => Array(w).fill("")) }]);
    } else await sheets.deleteRows(title, Array.from({ length: oldCount - values.length }, (_, i) => values.length + 2 + i));
  }
}

/** Порядок рядків і заголовок аркуша не змінилися (блок цін пишеться за позиціями — інакше ліг би на чужі товари). */
function sameOrder(a, b, keyName = "Offer ID") {
  const ha = (a?.[0] || []).map(mtText), hb = (b?.[0] || []).map(mtText);
  if (ha.join("\u0001") !== hb.join("\u0001")) return false;
  const k = ha.indexOf(keyName);
  const keys = (v) => v.slice(1).map((r) => mtText(r?.[k])).filter((x, i, arr) => x || arr.slice(i).some(Boolean));
  return keys(a).join("\u0001") === keys(b).join("\u0001");
}

/** Одноразово: NEW92 («Нові товари», готові SEO-товари) → «Основний каталог»; «Нові товари» → порожня черга. */
export async function mergeNew92({ sheets, readBook, stamp }) {
  const book = await readBook([SHEET.main, SHEET.queue, SHEET.deferred, SHEET.passport]);
  const groups = groupsOf(book);
  const main = readSheet(book[SHEET.main], SHEET.main);
  const q = book[SHEET.queue];
  const qHeader = (q[0] || []).map(mtText);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  check("«Нові товари» ще у форматі NEW92 (40 колонок каталогу, без колонок черги)", qHeader.length === YML_HEADERS.length && qHeader.every((k, i) => k === YML_HEADERS[i]));
  if (!checks.every((c) => c.ok)) return { state: "PRECONDITION_FAILED", checks };
  const queue = readSheet(q, SHEET.queue);
  const mainIds = new Set(main.rows.map((r) => mtText(r["Offer ID"])));
  const deferredIds = new Set((book[SHEET.deferred] ? readSheet(book[SHEET.deferred], SHEET.deferred).rows : []).map((r) => mtText(r["Offer ID"])));
  check("усі рядки NEW92 «ДОЗВОЛЕНО»", queue.rows.every((r) => r["Статус імпорту"] === "ДОЗВОЛЕНО"), queue.rows.length);
  check("печатки всіх рядків NEW92 цілі", queue.rows.every((r) => rowSeal(r) === mtText(r[SEAL_COLUMN])));
  check("печатки основного каталогу цілі", main.rows.every((r) => rowSeal(r) === mtText(r[SEAL_COLUMN])));
  check("ID NEW92 не перетинаються з основним каталогом і відкладеними", queue.rows.every((r) => !mainIds.has(mtText(r["Offer ID"])) && !deferredIds.has(mtText(r["Offer ID"]))));
  if (!checks.every((c) => c.ok)) return { state: "PRECONDITION_FAILED", checks };

  const mainHeader = main.header;
  const moved = queue.rows.map((r) => mainHeader.map((k) => r[k] ?? ""));
  const manifest = approvalManifest([...main.rows, ...queue.rows], groups);
  const oldQueue = q.map((r) => r.slice());
  const done = [];
  try {
    await sheets.appendRows(SHEET.main, moved); done.push("main");
    await sheets.ensureColumns(SHEET.queue, QUEUE_HEADERS.length);
    await sheets.updateRanges([{ title: SHEET.queue, row: 1, col: 1, values: [QUEUE_HEADERS.slice()] }]); done.push("header");
    if (queue.rows.length) await sheets.deleteRows(SHEET.queue, queue.rows.map((_, i) => i + 2)); done.push("queue");
    await sheets.ensureSheet(SHEET.passport, PASSPORT_HEADER.slice());
    const pv = passportValues(manifest, `NEW92 (${queue.rows.length}) перенесено в основний каталог`, stamp);
    await sheets.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: pv }]); done.push("passport");
    await appendJournal(sheets, [[stamp, "СИСТЕМА", "", "NEW92 → ОСНОВНИЙ КАТАЛОГ", "", queue.rows.length, JSON.stringify({ mode: "ОБ'ЄДНАННЯ", count: manifest.count })]]);

    // Перевірка після запису: усі 92 рядки байт-у-байт, паспорт, порожня черга з новим заголовком.
    const after = await readBook([SHEET.main, SHEET.queue, SHEET.passport]);
    const m2 = readSheet(after[SHEET.main], SHEET.main);
    const byId = new Map(m2.rows.map((r) => [mtText(r["Offer ID"]), r]));
    const identical = queue.rows.every((r) => { const x = byId.get(mtText(r["Offer ID"])); return x && mainHeader.every((k) => mtText(x[k]) === mtText(r[k])); });
    const qAfter = after[SHEET.queue];
    const verify = {
      mainCount: m2.rows.length, expectedCount: manifest.count, movedIdentical: identical,
      passportOk: samePassport(readPassport(after[SHEET.passport]), manifest) && samePassport(approvalManifest(m2.rows, groups), manifest),
      queueEmpty: qAfter.slice(1).every((r) => !r.some((v) => v !== "" && v != null)), queueHeaderOk: (qAfter[0] || []).map(mtText).join("|") === QUEUE_HEADERS.join("|"),
    };
    const ok = verify.mainCount === manifest.count && verify.movedIdentical && verify.passportOk && verify.queueEmpty && verify.queueHeaderOk;
    if (!ok) throw Object.assign(new Error("перевірка після запису не пройдена"), { verify });
    return { state: "MERGED", checks, moved: queue.rows.length, count: manifest.count, passport: { idsSha: manifest.idsSha.slice(0, 8), contentSha: manifest.contentSha.slice(0, 8) } /* 8 символів: у виводі не буває 10 цифр поспіль */, verify };
  } catch (e) {
    // Повернення: прибрати дописані в основний рядки, відновити «Нові товари».
    const restore = [];
    try {
      const now = await readBook([SHEET.main, SHEET.queue]);
      const ids = new Set(queue.rows.map((r) => mtText(r["Offer ID"])));
      const rowsToDrop = now[SHEET.main].map((r, i) => (i > 0 && ids.has(mtText(r[0])) ? i + 1 : 0)).filter(Boolean);
      if (done.includes("main") && rowsToDrop.length) { await sheets.deleteRows(SHEET.main, rowsToDrop); restore.push("main"); }
      await sheets.updateRanges([{ title: SHEET.queue, row: 1, col: 1, values: [pad(oldQueue[0], QUEUE_HEADERS.length)] }]);
      await rewriteData(sheets, SHEET.queue, Math.max(0, now[SHEET.queue].length - 1), oldQueue.slice(1).map((r) => pad(r, QUEUE_HEADERS.length)));
      restore.push("queue");
    } catch (re) { restore.push("ПОМИЛКА ВІДНОВЛЕННЯ: " + re.message); }
    return { state: "ROLLED_BACK", error: e.message, verify: e.verify, restore, checks };
  }
}

/** Синхронізація (як майбутній запуск кожні 4 год): ціни/наявність, черга нових, рішення власника, паспорт, журнал.
 *
 *  E2 / S1 (ENG-01, Hermes CC-R3 I3 / H13):
 *   • картки пишуться ЛИШЕ зміненими колонками синхронізації, за Offer ID, з перевіркою очікуваних значень (keyedUpdate):
 *     наше SEO, описи, колонки власника Catalog Controls не пишуться взагалі; паралельна правка людини → CONFLICT, без перезапису;
 *   • блок цін / наявності (усі рядки, за позиціями) — лише якщо порядок рядків і заголовок не змінилися з моменту читання;
 *     перевірка після запису — за ключем, не за індексом;
 *   • збій — компенсація БЕЗ видалень: повертаються лише наші клітинки й лише ті, що досі містять записане нами;
 *     дописані рядки не видаляються (needsDecision). Повністю скомпенсовано → ROLLED_BACK; інакше → INCOMPLETE.
 *  session (E3, WriteGateway): оренда, журнал операцій, fence перед кожним записом, заборона видалень (черга — очищення хвоста). */
export async function syncSheet(o) {
  // ENG-28d (F-28B-1 / F-28B-2): контрольні плани — у сховищі W2 сесії. Незавершене перенесення → BLOCKED; незавершений попередній
  // запуск → спершу відновлення його журналу за планом (BLOCKED / INCOMPLETE — зупинка); після JOURNAL_RECOVERED / RUN_PLAN_ABANDONED
  // той самий запуск продовжує штатну синхронізацію (свіже читання), результат — з полем recovery. Без сесії — як раніше.
  const session = o.session ?? null;
  if (session?.gw?.store?.getJsonVersioned && session.state === "READY") {
    const gate = await openPlansGate({ store: session.gw.store, session, readBook: o.readBook, stamp: o.stamp });
    if (gate && !RECOVERY_DONE.has(gate.state)) return gate;
    if (gate) return { ...(await syncSheetRun(o)), recovery: gate };
  }
  return syncSheetRun(o);
}
async function syncSheetRun({ sheets, readBook, parsed, fetchFull, stamp, config, now, profile = "medium", catalog = null, session = null, contract = null, controls = null, presence = null, feedScope = null, queueMode = "full", writeBudget = null }) {
  const planStore = session?.gw?.store?.getJsonVersioned ? session.gw.store : null;
  // CC R6: стан CC читається ДО книги — tombstone, зареєстрований після цього читання, ловить перевірка відбитка перед записом.
  const ccState = await syncControlsState(controls, config);
  const book = await readBook(SYNC_SHEETS);
  // ENG-28: присутність у фіді постачальника — лише в режимі пріоритету власника і лише з доказом повноти повного фіду (presence.proof).
  if (presence && !ownerPriorityEnabled(config)) return { state: "BLOCKED", reason: "присутність у фіді постачальника — лише в режимі пріоритету власника (productionConfig)" };
  const presenceRows = presence ? presenceInputRows(presenceRowsOf(book[SHEET.main]), presence.snapshot) : null;
  const presencePlan = presence ? planPresence({ rows: presenceRows, previous: presence.previous ?? null, snapshot: presence.snapshot, proof: presence.proof, stamp, limits: presence.limits, removed: ccState?.removed || new Set() }) : null;
  const groupsRows = groupsOf(book);
  const warnings = [];
  const fullById = await fullForQueue(book, fetchFull, warnings, [], { parsed, withMain: true });
  // ENG-28c (Catalog R7.4.2, спостереження 2): охоплення фіду — з доказу присутності («Оновити товари») або ЯВНО від викликача
  // (--mode=sync / scenario: з адреси операційного фіду; фільтр group_ids тощо або невідома адреса → «filtered»). Раніше без presence
  // охоплення завжди вважалось повним — товари поза фільтром отримали б «немає в наявності». Поріг HOLD не змінюється.
  const scope = presence ? (presence.snapshot?.scope === "full" ? "full" : "filtered") : feedScope === "full" || feedScope == null ? "full" : "filtered";
  // ENG-27 (N3): sync не виконує службових команд у «Рішенні» («ПЕРЕВІРЕНО», «SEO ПОСТАЧАЛЬНИКА») — їх споживає лише intake (cmd-consume, B6).
  // ENG-28d: попередній запуск почав міграцію стану полів і не дійшов до перевірених товарних записів (план без productDoneAt і без
  // повного відновлення) — рядки без стану продовжують міграцію, а не ізолюються.
  const prevRun = planStore ? (await loadPlan(planStore, RUN_PLAN_KEY)).plan : null;
  const resumeStateMigration = Boolean(prevRun?.stateMigration && !prevRun.productDoneAt && !(prevRun.recovered && prevRun.recovered.partial === false));
  const plan = planSheetSync({ book, parsed, stamp, config, now, groupsRows, fullById, catalog: catalogFor(catalog, warnings), controls: ccState, queueCommands: false, presenceColumns: Boolean(presence), feedScope: scope, queueMode, resumeStateMigration });
  const queueOff = plan.queue?.mode === "off";
  plan.warnings.push(...warnings);
  if (plan.abort) {
    // Заблоковано: товарні дані не змінюються; лише подія в «Журналі».
    const rec = await recordBlocked(sheets, stamp, plan.block || { type: "ЗАБЛОКОВАНО", reason: plan.abort, affected: "", limit: "" });
    return { state: "ABORTED", reason: plan.abort, block: plan.block, ...rec };
  }
  // ENG-28: аномальне зникнення товарів — HOLD і звіт до будь-якого запису (ціни теж не пишуться); лише подія в «Журналі».
  if (presencePlan?.decision === "HOLD") {
    const block = { type: "АНОМАЛЬНЕ ЗНИКНЕННЯ ТОВАРІВ", reason: presencePlan.reasons.join("; "), affected: String(presencePlan.disappearing), limit: String(presencePlan.limit ?? "") };
    const rec = await recordBlocked(sheets, stamp, block);
    return { state: "HOLD_SUPPLIER_DISAPPEARANCE", reason: block.reason, block, presence: presenceSummary(presencePlan, false), ...rec };
  }
  // ENG-28: позначки присутності — лише дві системні колонки рядків основного каталогу (нічого іншого в картці не змінюється).
  // ENG-28c: + нейтральний стан «поза охопленням фіду» (planScopeMarks) — один раз при зміні стану, без «ПОМИЛКА» щозапуску.
  const presenceKeys = new Set();
  const scopeMarks = presencePlan?.decision === "APPLY" ? planScopeMarks({ rows: presenceRowsOf(book[SHEET.main]), snapshot: presence.snapshot, presencePlan, stamp, removed: ccState?.removed || new Set() }) : new Map();
  if (presencePlan?.decision === "APPLY" && (presencePlan.updates.size || scopeMarks.size)) {
    plan.main.rows.forEach((row, i) => {
      const u = presencePlan.updates.get(mtText(row["Offer ID"])) || scopeMarks.get(mtText(row["Offer ID"]));
      if (!u) return;
      row[PRESENCE_COLUMN] = u.presence; row[PRESENCE_META_COLUMN] = u.meta;
      plan.main.changedRows.add(i); presenceKeys.add(mtText(row["Offer ID"]));
    });
    plan.journal = [...(plan.journal || []), ...presenceJournal(presencePlan, stamp), ...presenceJournal({ updates: scopeMarks }, stamp)];
  }
  const fin = finalizeSheetSync(plan, { parsed, fullById: new Map(), stamp, config, groupsRows, journalSummary: {} });

  // Таблицю редагували під час запуску? Тоді черга не чіпається (лише ціни основного каталогу).
  // ENG-28c: queueMode "off" — черга не пишеться взагалі, тож правка черги під час запуску «Оновити товари» не заважає.
  const fresh = queueOff ? null : await readBook([SHEET.queue]);
  const queueChanged = queueOff ? false : !rowsEqual(fresh[SHEET.queue], book[SHEET.queue]);
  // Ціни вже пораховано з урахуванням прив'язок/скасувань: якщо чергу змінили під час запуску, а такі рішення є — нічого не пишемо.
  if (queueChanged && plan.main.changedRows.size) return { state: "SKIPPED_CONCURRENT_EDIT", reason: "чергу змінено під час запуску, а в ній є прив'язки/скасування — нічого не записано, повтор наступного запуску" };
  const mainHeader = plan.main.header; // з колонками контенту (додаються автоматично)
  const approve = queueChanged ? [] : plan.queue.approve;
  const reject = queueChanged ? [] : plan.queue.reject;
  let passportAfter = queueChanged ? plan.passportBefore : fin.passportAfter;
  // ENG-27 (N3): записи журналу про зміни полів черги — лише для рядків, які справді записано (див. перед appendJournal).
  const notQueueField = (e) => e[1] !== SHEET.queue || ["ВІДХИЛЕНО", "ПОВЕРНУТО КАРТЦІ", "НОВИЙ", "РІШЕННЯ НЕ ВИКОНАНО"].includes(e[3]);
  let journal = queueChanged ? fin.journal.filter((e) => e[1] === SHEET.main && e[3] !== "ЗАТВЕРДЖЕНО" || e[1] === "СИСТЕМА") : fin.journal;

  // ENG-28a: «Паспорта каталогу» немає (тестова копія до кроку структури; режим пріоритету власника план пропускає) — раніше TypeError
  // нижче; тепер чиста зупинка ДО будь-якого запису товарів (лише подія в «Журналі»). Паспорт створює migrateQueueForTransfer.
  if (!book[SHEET.passport]) {
    const block = { type: "НЕМАЄ ПАСПОРТА", reason: "немає аркуша «Паспорт каталогу» — спершу крок міграції структури (ENG-28a); нічого не записано", affected: "", limit: "" };
    const rec = await recordBlocked(sheets, stamp, block);
    return { state: "ABORTED", reason: block.reason, block, ...rec };
  }
  const before = {
    mainOps: plan.main.plan.map((p) => p.before), queue: book[SHEET.queue].map((r) => r.slice()), mainLen: plan.main.rows.length,
    frozenLen: Math.max(0, (book[SHEET.frozen] || []).length), passport: book[SHEET.passport].map((r) => r.slice()),
    mainRowsFull: book[SHEET.main].map((r) => r.slice()), historyLen: (book[BINDINGS_SHEET] || [[]]).length, history: (book[BINDINGS_SHEET] || []).map((r) => r.slice()),
  };
  const changedRows = queueChanged ? [] : [...plan.main.changedRows];
  const planned = queueDecisions(book[SHEET.queue]), queueConflicts = []; // ENG-27 (N3): рішення черги, як їх прочитано планом
  const ownQ = withProvisionalQueue(session?.gw?.contract || contract || loadOwnership());
  const queueKeyed = (o) => (session ? session.updateByKey(o) : keyedUpdate({ sheets, read: readBook, contract: ownQ, writer: "sync", ...o }));
  let qChanges = [], queueResult = null;
  const queueSkipped = [], unwrittenQ = new Set(), prevQueueRow = new Map(); // ENG-27 (N3): рядки, яких sync не оновив (для звіту Worker)
  // E2 / S1: замість повного рядка — лише змінені колонки синхронізації (без LIVE: їх пише блок цін), за Offer ID, з очікуваними значеннями.
  const beforeHeader = (book[SHEET.main][0] || []).map(mtText);
  const beforeCell = (i, k) => { const j = beforeHeader.indexOf(k); return j < 0 ? "" : mtText(book[SHEET.main][i + 1]?.[j]); };
  const cardChanges = changedRows.map((i) => {
    const vals = forSheet(mainHeader, mainHeader.map((k) => (LIVE_COLUMNS.includes(k) ? plan.main.plan[i].next[LIVE_COLUMNS.indexOf(k)] : plan.main.rows[i][k] ?? "")));
    const cols = mainHeader.filter((k, j) => !LIVE_COLUMNS.includes(k) && mtText(vals[j]) !== beforeCell(i, k));
    if (!cols.length) return null;
    return { key: mtText(plan.main.rows[i]["Offer ID"]), identity: { "ID постачальника": beforeCell(i, "ID постачальника") },
      expect: Object.fromEntries(cols.map((k) => [k, beforeCell(i, k)])), set: Object.fromEntries(cols.map((k) => [k, vals[mainHeader.indexOf(k)]])) };
  }).filter(Boolean);
  const history = queueChanged ? [] : plan.bindings.history;
  const undoCells = queueChanged ? [] : plan.bindings.undoCells;
  const stateCol = BINDINGS_HEADERS.indexOf("Стан") + 1;
  const done = new Set();
  const opsBlock = { title: SHEET.main, row: 2, col: plan.main.start + 1, values: plan.main.plan.map((p) => forSheet(LIVE_COLUMNS, p.next)) };
  const queueValues = fin.queueValues.map((r) => forSheet(plan.queue.header, r));
  // Транспорт запису: через шлюз (fence + журнал, без видалень) або напряму (старі виклики без шлюзу).
  const W = session ? session.sheets : sheets;
  const own = contract || loadOwnership();
  const keyed = (o) => (session ? session.updateByKey(o) : keyedUpdate({ sheets, read: readBook, contract: own, writer: "sync", ...o }));
  if (session && session.state !== "READY") return { state: "BLOCKED", reason: `шлюз запису: ${session.state} — спершу з'ясування попередніх операцій або рішення людини`, unresolved: session.unresolved?.length || 0, blocking: session.blocking?.length || 0 };
  // Блок цін пишеться за позиціями — лише якщо порядок рядків і заголовок «Основного каталогу» не змінилися з моменту читання.
  const guard = await readBook([SHEET.main]);
  if (!sameOrder(guard[SHEET.main], book[SHEET.main])) return { state: "SKIPPED_CONCURRENT_EDIT", reason: "порядок рядків або заголовок «Основного каталогу» змінено під час запуску — нічого не записано, повтор наступного запуску" };
  // Правило 5 (CC R6): рішення про видалення, прийняте під час запуску, — нічого не пишемо (наступний запуск ізолює товар).
  const ccNow = await ccUnchanged(controls, ccState);
  if (!ccNow.ok) return { state: "SKIPPED_CONCURRENT_EDIT", reason: "стан Catalog Controls змінився під час запуску (" + ccNow.reason + ") — нічого не записано, повтор наступного запуску" };
  // ENG-27 (N3): прив'язки виконуються за рішеннями «ПРИВ'ЯЗАТИ ДО», прочитаними планом; змінено до запису → нічого не пишемо.
  const boundRows = queueChanged ? [] : plan.queue.bound || [];
  if (boundRows.length) {
    const pre = queueDecisions((await readBook([SHEET.queue]))[SHEET.queue]);
    const drift = boundRows.map((r) => ({ key: mtText(r["Offer ID"]), phase: "прив'язка, до запису", reason: decisionDrift(planned, pre, r["Offer ID"]) })).filter((x) => x.reason);
    if (drift.length) return { state: "SKIPPED_CONCURRENT_EDIT", reason: "рішення «ПРИВ'ЯЗАТИ ДО» в «Нових товарах» змінено під час запуску — нічого не записано, повтор наступного запуску", queueConflicts: drift };
  }
  let cardResult = null;
  // Пріоритет власника (config.ownerPriority.enabled → plan.ownerPriority): ізоляція рядка замість відкату всього запуску.
  const opMode = Boolean(plan.ownerPriority);
  const ROW_LEVEL = [ITEM.CONFLICT, ITEM.FIELD_CUSTOM, ITEM.IDENTITY_MISMATCH, ITEM.MISSING];
  const STATE_COL = "Стан полів JSON";
  const isolatedOnWrite = new Map();
  let warnResult = null, classifyResult = null;
  // Крок вважається виконаним, якщо запис застосовано АБО результат невідомий (міг застосуватися); NOT_APPLIED — не виконано.
  const step = async (name, fn) => {
    try { const r = await fn(); done.add(name); return r; }
    catch (err) { if (outcomeOf(err) !== "NOT_APPLIED" || err?.appliedParts > 0) done.add(name); throw err; }
  };
  const applied = (o) => [OP.VERIFIED, OP.PARTIAL, OP.NEEDS_DECISION, OP.UNKNOWN].includes(o);
  // ENG-28c (М3): службові рядки пріоритету власника — «Класифікація полів» і «Попередження постачальника» (лише нові ключі).
  const rowsC = opMode && plan.ownerPriority.uncertainty.length ? plan.ownerPriority.uncertainty.map((x) => classifyRow(x.offerId, x)) : [];
  const rowsW = opMode && plan.ownerPriority.warnings.length ? [...new Map(plan.ownerPriority.warnings.map((w) => [w.key, w])).values()].map(warningRow) : [];
  const appendKeyed = (title, rows, gen) => (session ? session.appendMissingByKey({ title, rows, generation: gen + ":" + stamp })
    : appendMissingByKey({ sheets, read: readBook, contract: own, writer: "sync", title, rows, generation: gen + ":" + stamp }));
  // ENG-28c (М1): попередній розрахунок запитів запису ДО першого запису; більше за бюджет запуску → нічого не пишемо (fail-closed),
  // без часткового запису й без «сліпого» підняття межі. Бюджет — з записувача (tools/sheet-sync); без бюджету (тести) — без перевірки.
  const preflight = writeBudget ? syncPreflight({ writeBudget, book, plan, mainHeader, opsBlock, cardChanges, rowsC, rowsW, history, undoCells, stateCol, approve, reject, queueOff, queueChanged, queueValues, journal, opMode, keyedJournal: Boolean(planStore) }) : null;
  if (preflight && !preflight.ok) {
    const block = { type: "БЮДЖЕТ ЗАПИСУ", reason: `потрібно ≈${preflight.estimate} запитів запису (з резервом ${preflight.reserve}), доступно ${preflight.available} — нічого не записано; потрібне погоджене підвищення межі або менший обсяг`, affected: String(preflight.estimate), limit: String(preflight.available) };
    const rec = await recordBlocked(W, stamp, block);
    return { state: "ABORTED", reason: block.reason, block, preflight, ...rec };
  }
  // ENG-28d (F-28B-1): контрольний план ДО першого запису — заплановані події «Журналу» (стабільні ID) і докази: усі заплановані зміни
  // клітинок «Основного каталогу» (відбитки «було» / «стало»). Без плану нічого не пишемо.
  const runId = `${queueOff ? "update" : "sync"}:${stamp}`;
  let runPlan = null, runPlanVersion = null;
  if (planStore) {
    const evidence = [];
    plan.main.plan.forEach((p, i) => {
      const id = mtText(plan.main.rows[i]["Offer ID"]);
      LIVE_COLUMNS.forEach((k, j) => { if (k !== "Оновлено" && mtText(p.before[j]) !== mtText(p.next[j])) evidence.push(evidenceCell(id, k, p.before[j], forSheet([k], [p.next[j]])[0])); });
    });
    for (const c of cardChanges) for (const k of Object.keys(c.set)) evidence.push(evidenceCell(c.key, k, c.expect[k], c.set[k]));
    runPlan = { v: 1, kind: queueOff ? "update" : "sync", runId, stamp, status: PLAN.PLANNED, createdAt: stamp, evidence, events: withEventIds(runId, journal.map(journalRow)),
      stateMigration: (plan.ownerPriority?.migratedRows || 0) > 0 };
    try { runPlanVersion = await savePlan(planStore, RUN_PLAN_KEY, runPlan, (await loadPlan(planStore)).version); }
    catch (e) { return { state: "BLOCKED", reason: "контрольний план запуску не записано (сховище W2): " + String(e?.message || e).slice(0, 200) + " — нічого не записано" }; }
  }
  try {
    // ENG-28c (М3): службові рядки — ДО будь-якого запису товарних даних. Збій / невідомий результат → зупинка (стан рядків не
    // просунуто, попередження не втрачено; повтор після reconcile допише лише відсутні ключі). Раніше збій лише потрапляв у звіт,
    // а стан полів у рядку вже записано — попередження губилося назавжди.
    const serviceOk = (r) => r && [OP.VERIFIED, OP.NOTHING].includes(r.outcome);
    if (rowsC.length) {
      await W.ensureSheet(CLASSIFY_SHEET, CLASSIFY_HEADER.slice());
      classifyResult = await step("classify", () => appendKeyed(CLASSIFY_SHEET, rowsC, "classify"));
      if (!serviceOk(classifyResult)) throw Object.assign(new Error(`«${CLASSIFY_SHEET}»: ${classifyResult?.outcome} — товарні дані не записано`), { keyed: classifyResult });
    }
    if (rowsW.length) {
      await W.ensureSheet(WARN_SHEET, WARN_HEADER.slice());
      warnResult = await step("warnings", () => appendKeyed(WARN_SHEET, rowsW, "warnings"));
      if (!serviceOk(warnResult)) throw Object.assign(new Error(`«${WARN_SHEET}»: ${warnResult?.outcome} — товарні дані не записано`), { keyed: warnResult });
    }
    if (plan.main.migrated.length) {
      await W.ensureColumns(SHEET.main, mainHeader.length);
      await step("mainHeader", () => W.updateRanges([{ title: SHEET.main, row: 1, col: 1, values: [mainHeader] }]));
    }
    await step("mainOps", () => (session ? session.rawSupersedable("updateRanges", [[opsBlock]], "ціни / наявність (усі рядки)") : sheets.updateRanges([opsBlock])));
    // Дії власника «Прийняти значення постачальника», фаза 1: лише колонка стану (без воріт) → свіжий стан поля = S.
    const accepted = opMode ? plan.ownerPriority.accepted : [];
    if (accepted.length) {
      const perOffer = [...new Map(accepted.map((a) => [a.offerId, a])).values()]; // один запис стану на товар
      const sr = await step("acceptState", () => keyed({ title: SHEET.main, changes: perOffer.map((a) => ({ key: a.offerId, expect: { [STATE_COL]: a.originalState }, set: { [STATE_COL]: a.intermediateState } })), generation: "accept:" + stamp }));
      for (const x of sr.items) if (x.status !== ITEM.VERIFIED && x.status !== ITEM.ALREADY) isolatedOnWrite.set(x.key, "дію власника не застосовано: " + x.status);
      // Фаза 2 бачить проміжний стан: очікуване значення колонки стану для цих рядків — проміжне.
      for (const ch of cardChanges) { const a = accepted.find((y) => y.offerId === ch.key); if (a && STATE_COL in ch.expect) ch.expect[STATE_COL] = a.intermediateState; }
    }
    // Прив'язки / скасування / дані постачальника: лише змінені колонки синхронізації, за Offer ID.
    if (cardChanges.length) {
      try { cardResult = await keyed({ title: SHEET.main, changes: cardChanges, generation: "sync:" + stamp }); }
      catch (err) { if (outcomeOf(err) !== "NOT_APPLIED") done.add("fullRows"); throw err; }
      if (applied(cardResult.outcome)) done.add("fullRows");
      // Пріоритет власника: рядок, який НЕ записано через правку людини між читанням і записом (CONFLICT / ворота стану /
      // ідентичність / зник), — ізольовано лише його; невідомий результат або запис у чужий рядок — як і раніше, зупинка.
      if (opMode) for (const x of cardResult.items) if ([ITEM.CONFLICT, ITEM.FIELD_CUSTOM, ITEM.IDENTITY_MISMATCH, ITEM.MISSING].includes(x.status)) isolatedOnWrite.set(x.key, x.status);
      if (cardResult.outcome !== OP.VERIFIED && !(opMode && cardResult.outcome === OP.NOT_APPLIED && cardResult.items.every((x) => [ITEM.ALREADY, ITEM.VERIFIED, ...ROW_LEVEL].includes(x.status)))) throw Object.assign(new Error(`картки: ${cardResult.outcome} (${cardResult.items.filter((x) => x.status !== "VERIFIED").map((x) => `${x.key}: ${x.status}`).slice(0, 5).join("; ")})`), { keyed: cardResult });
    }
    if (history.length || undoCells.length) {
      await W.ensureSheet(BINDINGS_SHEET, BINDINGS_HEADERS.slice());
      if (history.length) await step("history", () => W.appendRows(BINDINGS_SHEET, history));
      if (undoCells.length) await step("undoCells", () => W.updateRanges(undoCells.map((c) => ({ title: BINDINGS_SHEET, row: c.row, col: stateCol, values: [[c.state]] }))));
    }
    // ENG-27 (Hermes INT N3): черга — лише читання. Рішення власника не стираються й не змінюються; позиційного перезапису черги
    // немає. Переміщення (затвердження → «Основний каталог», відхилення → «Заморожені ID») — лише за Offer ID і лише якщо «Рішення» й
    // ідентичність рядка досі ті, що в плані (свіже читання ДО і ПІСЛЯ запису); розбіжність → CONFLICT, а не SYNCED.
    // Видалення рядка з черги — B6 (deleteWriters не затверджено): ЗАБЛОКОВАНО, рядок лишається з рішенням власника.
    const execApprove = [], execReject = [];
    if (approve.length) {
      const pre = queueDecisions((await readBook([SHEET.queue]))[SHEET.queue]);
      for (const r of approve) { const why = decisionDrift(planned, pre, r["Offer ID"]); if (why) queueConflicts.push({ key: mtText(r["Offer ID"]), phase: "затвердження, до запису", reason: why }); else execApprove.push(r); }
    }
    if (execApprove.length) {
      const rowsA = execApprove.map((r) => forSheet(mainHeader, mainHeader.map((k) => r[k] ?? "")));
      if (session) {
        const ar = await step("approve", () => session.appendMissingByKey({ title: SHEET.main, rows: rowsA, generation: "approve:" + stamp }));
        if (ar.outcome !== OP.VERIFIED) { if (!applied(ar.outcome)) done.delete("approve"); throw new Error(`затвердження: ${ar.outcome}`); }
      } else await step("approve", () => sheets.appendRows(SHEET.main, rowsA));
    }
    if (!queueChanged && !queueOff && plan.queue.migrated.length) await step("queueHeader", () => writeQueueHeader(W, plan.queue.header));
    // ENG-27 (N3): оновлення черги — лише змінені клітинки, за Offer ID, з очікуваними значеннями (як intake); позиційного запису немає.
    // Колонки, яких sync не дозволено (рішення власника, ручні, B6 «?», «лише при додаванні»), — не пишуться (звіт); нових рядків sync
    // не додає. Правка власника між читанням і записом → CONFLICT. ENG-28c: queueMode "off" — черги не торкаємось.
    if (!queueChanged && !queueOff) {
      const qHeader = plan.queue.header, kq = qHeader.indexOf("Offer ID");
      const bh = (book[SHEET.queue][0] || []).map(mtText), kb = bh.indexOf("Offer ID");
      const prevByKey = new Map();
      for (const r of book[SHEET.queue].slice(1)) { const k = mtText(r?.[kb]); if (k && !prevByKey.has(k)) prevByKey.set(k, r); }
      for (const [k, r] of prevByKey) prevQueueRow.set(k, Object.fromEntries(bh.map((c, j) => [c, r[j] ?? ""])));
      const qSpec = ownQ.sheets.get(SHEET.queue), writableQ = new Set(writableColumns(ownQ, SHEET.queue, "sync"));
      for (const row of queueValues) {
        const key = mtText(row[kq]), prev = prevByKey.get(key);
        if (!key || !prev) { queueSkipped.push({ key, reason: "новий рядок черги — додає лише intake (B6)" }); unwrittenQ.add(key); continue; }
        const cur = (col) => { const j = bh.indexOf(col); return j < 0 ? "" : mtText(prev[j]); };
        // Службова команда власника («ПЕРЕВІРЕНО» / «SEO ПОСТАЧАЛЬНИКА») чекає intake: рядок не оновлюється, щоб команда стосувалася
        // саме тих даних (і SHA), які бачив власник, — інакше intake підтвердив би дані, яких власник не бачив.
        if (CONSUMABLE_DECISION.test(normDecision(cur("Рішення")))) { queueSkipped.push({ key, reason: "службова команда власника чекає intake — рядок не оновлено" }); unwrittenQ.add(key); continue; }
        const cols = qHeader.filter((col, j) => mtText(row[j]) !== cur(col));
        const ok = cols.filter((c) => writableQ.has(c));
        for (const c of cols.filter((x) => !writableQ.has(x))) queueSkipped.push({ key, column: c, reason: c === "Рішення" ? "рішення власника — sync не змінює й не стирає" : qSpec?.columns.get(c)?.group || "поза контрактом" });
        // «Рішення» — у перевірці рядка (identity), не в записі: власник змінив рішення між читанням і записом → рядок не пишеться (CONFLICT).
        if (ok.length) qChanges.push({ key, identity: { "ID постачальника": cur("ID постачальника"), "Рішення": cur("Рішення") }, expect: Object.fromEntries(ok.map((c) => [c, cur(c)])), set: Object.fromEntries(ok.map((c) => [c, row[qHeader.indexOf(c)]])) });
      }
      if (qChanges.length) {
        queueResult = await step("queueKeyed", () => queueKeyed({ title: SHEET.queue, changes: qChanges, generation: "sync-queue:" + stamp }));
        for (const x of queueResult.items) if (OWNER_EDIT.includes(x.status)) queueConflicts.push({ key: x.key, phase: "оновлення черги", reason: "правка власника між читанням і записом (" + x.status + ") — клітинки не записано" });
        const settledQ = queueResult.items.every((x) => [ITEM.ALREADY, ITEM.VERIFIED, ...OWNER_EDIT].includes(x.status)) && ![OP.UNKNOWN, OP.NEEDS_DECISION].includes(queueResult.outcome);
        if (!settledQ) throw Object.assign(new Error(`черга: ${queueResult.outcome}`), { keyed: queueResult });
      }
    }
    // Формат «0%» для колонки «Знижка» (як у mtUpdate): без нього число 0.2 показувалося б як «0,2».
    await W.setPercentFormat(SHEET.main, mainHeader.indexOf(DISCOUNT) + 1, 2, plan.main.rows.length + execApprove.length + 1);
    if (reject.length) {
      const fresh = await readBook([SHEET.queue, SHEET.frozen]);
      const pre = queueDecisions(fresh[SHEET.queue]);
      const frozenNow = new Set((fresh[SHEET.frozen] || []).slice(1).map((r) => mtText(r?.[0])).filter(Boolean));
      for (const r of reject) {
        const why = decisionDrift(planned, pre, r["Offer ID"]);
        if (why) queueConflicts.push({ key: mtText(r["Offer ID"]), phase: "відхилення, до запису", reason: why });
        else if (!frozenNow.has(mtText(r["Offer ID"]))) execReject.push(r); // уже в «Заморожених» — повтор нічого не дописує
      }
    }
    if (execReject.length) await step("frozen", () => W.appendRows(SHEET.frozen, execReject.map((r) => [mtText(r["Offer ID"])])));
    if (execApprove.length || execReject.length || boundRows.length) {
      const post = queueDecisions((await readBook([SHEET.queue]))[SHEET.queue]);
      for (const r of [...execApprove, ...execReject, ...boundRows]) {
        const why = decisionDrift(planned, post, r["Offer ID"]);
        if (why) queueConflicts.push({ key: mtText(r["Offer ID"]), phase: "після запису — потрібне рішення власника", reason: why });
      }
    }
    if (execApprove.length !== approve.length || execReject.length !== reject.length) {
      const fin2 = finalizeSheetSync({ ...plan, queue: { ...plan.queue, approve: execApprove, reject: execReject } }, { parsed, fullById: new Map(), stamp, config, groupsRows, journalSummary: {} });
      passportAfter = fin2.passportAfter;
      journal = fin2.journal;
    }
    const queueRemoval = { state: "BLOCKED_B6", reason: "видалення рядків «Нових товарів» не дозволено до затвердження B6 (deleteWriters); рядки лишаються з рішенням власника",
      keys: [...new Set([...approve, ...reject, ...(plan.queue.bound || []), ...(plan.queue.reclaimed || [])].map((r) => mtText(r["Offer ID"])).filter(Boolean))] };
    // Попередження постачальника (пріоритет власника): лише нові ключі; не блокують нічого (помилка запису — у звіт, без відкату).
    // Дії власника, фаза 3: «Стан дії» у рядку попередження (лише якщо поле записано).
    if (opMode && accepted.length) {
      for (const sheetName of [WARN_SHEET, CLASSIFY_SHEET]) {
        const doneKeys = accepted.filter((a) => (a.sheet || WARN_SHEET) === sheetName && !isolatedOnWrite.has(a.offerId)).map((a) => ({ key: a.key, expect: { "Стан дії": "" }, set: { "Стан дії": "ВИКОНАНО " + stamp } }));
        if (doneKeys.length) { try { await keyed({ title: sheetName, changes: doneKeys, generation: "accept-done:" + sheetName + ":" + stamp }); } catch { /* позначка — інформаційна; наступний запуск побачить стан уже змінений */ } }
      }
    }
    // ENG-28c (М3): «Класифікація полів» і «Попередження постачальника» записано на початку (до товарних даних) — див. вище.
    if (!samePassport(passportAfter, plan.passportBefore)) {
      await step("passport", () => W.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: passportValues(passportAfter, `затверджено ${approve.length}`, stamp) }]));
    }

    // Перевірка після запису — за ключем (Offer ID), не за індексом рядка.
    const after = await readBook(SYNC_SHEETS);
    const m2 = readSheet(after[SHEET.main], SHEET.main);
    const byKey = new Map(m2.rows.map((r) => [mtText(r["Offer ID"]), r]));
    const opsOk = plan.main.plan.every((p, i) => { const r = byKey.get(mtText(plan.main.rows[i]["Offer ID"])); const next = forSheet(LIVE_COLUMNS, p.next); return r && LIVE_COLUMNS.every((k, j) => mtText(r[k]) === mtText(next[j])); });
    // Пріоритет власника: печатки — лише записаних нами рядків (правки власника між запусками — його право, наступний запуск їх
    // зафіксує); паспорт — аудит. Ізольовані рядки не перевіряються (у них нічого не писали).
    const writtenKeys = new Set(changedRows.map((i) => mtText(plan.main.rows[i]["Offer ID"])).filter((k) => !isolatedOnWrite.has(k)));
    const verify = {
      mainCount: m2.rows.length, expectedCount: passportAfter.count, opsWritten: opsOk,
      // Пріоритет власника: печатка — аудит; записані картки перевіряються M3 (OK / OWNER_EDIT) — правка власника дозволеного поля
      // в момент запуску не відкочує весь запуск, а зміна ідентичності / службових (sysh) — так.
      sealsIntact: opMode ? m2.rows.filter((r) => writtenKeys.has(mtText(r["Offer ID"]))).every((r) => ["OK", "OWNER_EDIT"].includes(cardVerdict(r).verdict)) : m2.rows.every((r) => rowSeal(r) === mtText(r[SEAL_COLUMN])),
      passportOk: opMode ? true : samePassport(approvalManifest(m2.rows, groupsRows), passportAfter) && samePassport(readPassport(after[SHEET.passport]), passportAfter),
      bindingsOk: changedRows.every((i) => mtText(byKey.get(mtText(plan.main.rows[i]["Offer ID"]))?.["ID постачальника"]) === mtText(plan.main.rows[i]["ID постачальника"])),
      queueOk: true, queueWritten: qChanges.length > 0, // ENG-27 (N3): черга — лише keyedUpdate (сам перевіряє записане за ключем)
    };
    if (!(verify.mainCount === verify.expectedCount && verify.opsWritten && verify.sealsIntact && verify.passportOk && verify.queueOk && verify.bindingsOk)) throw Object.assign(new Error("перевірка після запису не пройдена"), { verify });
    // ENG-27 (N3): правка власника в черзі під час запуску — CONFLICT (не SYNCED); переміщення, яких не дозволяє B6, — у звіті й «Журналі».
    const conflictNote = queueConflicts.length ? `рішення власника в «Нових товарах» змінено під час запуску (${queueConflicts.length}) — ці рядки не переміщено або потребують рішення; їхніх рішень і клітинок sync не змінював` : "";
    if (queueConflicts.length) journal = [...journal, [stamp, "СИСТЕМА", "", "КОНФЛІКТ", "", "", "нова система (sync): " + conflictNote + ": " + queueConflicts.slice(0, 5).map((c) => `${c.key} (${c.phase}) — ${c.reason}`).join("; ")]];
    // ENG-28 (N4): зміна вже виконаного рішення — відмова з поясненням (у «Перевірці» рядка й тут), без «ВІДХИЛЕНО» / «Заморожених».
    const refusedDecisions = queueChanged ? [] : plan.queue.decisionRefused || [];
    // ENG-28c: «Оновити товари» (queueMode "off") — відмова лише у звіті, без щозапускового запису «Журналу».
    if (refusedDecisions.length && !queueOff) journal = [...journal, ...refusedDecisions.map((x) => [stamp, SHEET.queue, x.offerId, "РІШЕННЯ НЕ ВИКОНАНО", x.decision, "", x.reason])];
    const pendingCmd = queueSkipped.filter((x) => x.reason.startsWith("службова команда")).length;
    if (pendingCmd) journal = [...journal, [stamp, "СИСТЕМА", "", "ОЧІКУЄ", "", "", `службові команди власника («ПЕРЕВІРЕНО» / «SEO ПОСТАЧАЛЬНИКА») у ${pendingCmd} рядках «Нових товарів» виконає intake; sync їх не виконує й не стирає, ці рядки не оновлено`]];
    if (execApprove.length || execReject.length) journal = [...journal, [stamp, "СИСТЕМА", "", "ЗАБЛОКОВАНО", "", "", `B6: видалення ${execApprove.length + execReject.length} перенесених рядків із «Нових товарів» не дозволено до затвердження — рядки лишаються з рішенням власника`]];
    // Записані рядки черги (VERIFIED / ALREADY) і перенесені в «Основний каталог» (їхні оновлені дані записано туди).
    const writtenQ = new Set([...(queueResult?.items || []).filter((x) => [ITEM.VERIFIED, ITEM.ALREADY].includes(x.status)).map((x) => mtText(x.key)), ...execApprove.map((r) => mtText(r["Offer ID"]))]);
    journal = journal.filter((e) => notQueueField(e) || writtenQ.has(mtText(e[2])));
    // ENG-28d (F-28B-1): товарні записи вже перевірено читанням → план PRODUCT_DONE з остаточними подіями; «Журнал» — дописування
    // за «ID події». Збій журналу НЕ відкочує перевірених товарних даних і не повторює їх: стан JOURNAL_INCOMPLETE (не SYNCED), план
    // лишається відкритим — наступний запуск (після reconcile) допише лише відсутні за ID події.
    let journalOutcome = null;
    if (planStore) {
      const events = withEventIds(runId, journal.map(journalRow));
      journalOutcome = { runId, planned: events.length, ok: false, outcome: null };
      try {
        runPlanVersion = await savePlan(planStore, RUN_PLAN_KEY, { ...runPlan, status: PLAN.PRODUCT_DONE, events, productDoneAt: stamp }, runPlanVersion);
        const jr = await appendEvents({ session, journalValues: (await readBook([JOURNAL_SHEET]))[JOURNAL_SHEET], rows: events, generation: "journal:" + runId });
        journalOutcome = { ...journalOutcome, ok: jr.ok, outcome: jr.outcome, appended: jr.appended };
        if (jr.ok) runPlanVersion = await savePlan(planStore, RUN_PLAN_KEY, { ...runPlan, status: PLAN.DONE, events, productDoneAt: stamp, closedAt: stamp }, runPlanVersion);
      } catch (je) { journalOutcome = { ...journalOutcome, ok: false, outcome: outcomeOf(je), error: String(je?.message || je).slice(0, 200) }; }
    } else await appendJournal(W, journal);
    // ENG-27 (N3): звіт для Worker — за фактично записаним станом черги: рядок, який sync не оновив (службова команда, правка власника),
    // — з прочитаними значеннями; рядка, якого в черзі немає (sync рядків не додає), у звіті немає (Worker лишає його кандидатом для intake).
    for (const c of qChanges) if (!writtenQ.has(c.key)) unwrittenQ.add(c.key);
    const ackQueue = rowsOf(plan.queue.header, fin.queueValues).flatMap((r) => { const k = mtText(r["Offer ID"]); return !unwrittenQ.has(k) ? [r] : prevQueueRow.has(k) ? [prevQueueRow.get(k)] : []; });
    const ack = queueChanged ? null : ackFor({ ...plan.ackInput, queueRows: ackQueue, profile });
    const journalLost = Boolean(journalOutcome && !journalOutcome.ok);
    return {
      // ENG-28d: SYNCED лише коли всі події запуску є в «Журналі» за ID; інакше JOURNAL_INCOMPLETE (дані записано й перевірено).
      state: journalLost ? "JOURNAL_INCOMPLETE" : queueConflicts.length ? "CONFLICT_OWNER_EDIT" : "SYNCED",
      ...(journalLost ? { reason: `товарні записи перевірено, але «Журнал» запуску ${runId} неповний (${journalOutcome.outcome}) — наступний запуск після reconcile допише відсутні події` } : conflictNote ? { reason: conflictNote } : {}),
      journal: journalOutcome, queueConflicts, queueRemoval, decisionRefused: refusedDecisions,
      // ENG-28: позначки присутності вважаються застосованими лише якщо всі їхні рядки записано (VERIFIED / ALREADY); інакше знімок не підтверджується.
      presence: presenceSummary(presencePlan, presencePlan?.decision === "APPLY" && [...presenceKeys].every((k) => (cardResult?.items || []).some((x) => x.key === k && [ITEM.VERIFIED, ITEM.ALREADY].includes(x.status)))),
      queueUpdate: { outcome: queueResult?.outcome ?? (qChanges.length ? "NOT_RUN" : "NOTHING"), rows: qChanges.length, skipped: queueSkipped, mode: queueOff ? "off" : "full", pendingDecisions: plan.queue.pendingDecisions ?? 0 },
      preflight, feedScope: scope,
      queueChanged, verify, ack, stats: { ...plan.stats, approved: execApprove.length, rejected: execReject.length, added: 0, possibleDuplicates: queueChanged ? 0 : fin.possibleDuplicates, bound: queueChanged ? 0 : plan.bindings.done, bindRefused: plan.bindings.refused, unbound: queueChanged ? 0 : plan.bindings.undone, mainCountAfter: verify.mainCount },
      warnings: plan.warnings, frozenSimilar: plan.frozenSimilar, journalEntries: journal.length,
      // ENG-28b: режим характеристик і виявлені зміни сирих <param> постачальника (B) — для звіту; FZ без застосування (етап C).
      characteristicsMode: plan.characteristicsMode ?? null, supplierParamChanges: plan.supplierParamChanges ?? [], frozenPending: plan.frozenPending ?? [],
      ...(opMode ? { ownerPriority: {
        rawFieldsChanged: plan.ownerPriority.rawChanged, productsWithRawChanges: plan.ownerPriority.productsWithRawChanges,
        warnings: plan.ownerPriority.warnings.length, productsWithWarnings: new Set(plan.ownerPriority.warnings.map((w) => w.offerId)).size,
        warningsRecorded: warnResult?.outcome ?? "NOTHING", editsDetected: plan.ownerPriority.editsDetected, migratedRows: plan.ownerPriority.migratedRows,
        isolated: [...plan.ownerPriority.isolated, ...[...isolatedOnWrite].map(([offerId, status]) => ({ offerId, reason: "не записано: " + status }))],
        uncertainty: plan.ownerPriority.uncertainty.length, migrationClasses: plan.ownerPriority.migrationClasses, classifyRecorded: classifyResult?.outcome ?? "NOTHING", audit: plan.audit,
        removedInMain: plan.ownerPriority.removedInMain, ccFingerprint: ccState?.fingerprint ?? null } } : {}),
    };
  } catch (e) {
    // Компенсація БЕЗ видалень і без перезапису чужих правок: лише наші клітинки, лише якщо в них досі записане нами.
    const restore = [], needsDecision = [];
    const back = async (label, changes, gen) => {
      if (!changes.length) return;
      try {
        const r = await keyed({ title: SHEET.main, changes, generation: gen + ":" + stamp });
        if (r.outcome === OP.VERIFIED || r.outcome === OP.NOTHING) restore.push(label);
        else needsDecision.push(`${label}: компенсацію виконано не повністю (${r.outcome}; ${r.items.filter((x) => !["VERIFIED", "ALREADY"].includes(x.status)).map((x) => `${x.key}: ${x.status}`).slice(0, 5).join("; ")})`);
      } catch (ce) { needsDecision.push(`${label}: компенсацію не виконано — ${String(ce?.message || ce).slice(0, 160)}`); }
    };
    try {
      if (done.has("mainOps")) {
        // Ціни / наявність — лише системні колонки (людина їх не редагує): повертаються попередні значення ЗА КЛЮЧЕМ від свіжого
        // читання. Так виправляється й блок, що ліг на чужі рядки через сортування між перевіркою порядку й записом.
        const cur = (await readBook([SHEET.main]))[SHEET.main], ch = (cur[0] || []).map(mtText), kc = ch.indexOf("Offer ID");
        const at = new Map(); for (let r = 1; r < cur.length; r++) { const k = mtText(cur[r]?.[kc]); if (k && !at.has(k)) at.set(k, cur[r]); }
        await back("ціни/наявність", plan.main.plan.map((p, i) => {
          const key = mtText(plan.main.rows[i]["Offer ID"]), row = at.get(key);
          if (!row) return null;
          const cols = LIVE_COLUMNS.filter((k, j) => mtText(row[ch.indexOf(k)]) !== mtText(p.before[j]));
          return cols.length ? { key, expect: Object.fromEntries(cols.map((k) => [k, mtText(row[ch.indexOf(k)])])), set: Object.fromEntries(cols.map((k) => [k, p.before[LIVE_COLUMNS.indexOf(k)]])) } : null;
        }).filter(Boolean), "compensate-live");
      }
      if (done.has("queueKeyed") && qChanges.length) {
        try {
          const r = await queueKeyed({ title: SHEET.queue, changes: qChanges.map((c) => ({ key: c.key, identity: c.identity, expect: Object.fromEntries(Object.entries(c.set).map(([k, v]) => [k, mtText(v)])), set: c.expect })), generation: "compensate-queue:" + stamp });
          if (r.outcome === OP.VERIFIED || r.outcome === OP.NOTHING) restore.push("клітинки черги");
          else needsDecision.push(`клітинки черги: компенсацію виконано не повністю (${r.outcome})`);
        } catch (ce) { needsDecision.push("клітинки черги: компенсацію не виконано — " + String(ce?.message || ce).slice(0, 160)); }
      }
      if (done.has("fullRows")) await back("змінені картки", cardChanges.map((c) => ({ key: c.key, expect: Object.fromEntries(Object.entries(c.set).map(([k, v]) => [k, mtText(v)])), set: c.expect })), "compensate-cards");
      if (done.has("mainHeader")) needsDecision.push("заголовок основного каталогу: додані колонки контенту лишено (рядок заголовка не відкочується)");
      if (done.has("history")) needsDecision.push(`історія прив'язок: могло бути дописано ${history.length} рядк. — не видаляються, перевірити вручну`);
      if (done.has("undoCells")) {
        // Позиційні клітинки «Стан» історії: повертаються лише ті, що досі містять записаний нами стан.
        const nowB = (await readBook([BINDINGS_SHEET]))[BINDINGS_SHEET] || [];
        const ok = undoCells.filter((c) => mtText(nowB[c.row - 1]?.[stateCol - 1]) === mtText(c.state));
        if (ok.length) await W.updateRanges(ok.map((c) => ({ title: BINDINGS_SHEET, row: c.row, col: stateCol, values: [[before.history[c.row - 1]?.[stateCol - 1] ?? ""]] })));
        if (ok.length) restore.push("стан скасувань");
        if (ok.length < undoCells.length) needsDecision.push(`стан скасувань: ${undoCells.length - ok.length} клітинок змінено іншим — не відкочено`);
      }
      if (done.has("approve")) needsDecision.push(`затвердження: могло бути перенесено ${approve.length} рядк. в основний каталог — не видаляються; повторного перенесення не буде («такий Offer ID уже є в основному каталозі»)`);
      if (done.has("queueHeader")) needsDecision.push("заголовок черги: нові колонки лишено");
      if (done.has("frozen")) needsDecision.push(`«Заморожені ID»: могло бути дописано ${reject.length} ID — не видаляються (повтор безпечний)`);
      if (done.has("passport")) {
        const nowP = (await readBook([SHEET.passport]))[SHEET.passport];
        const wrote = passportValues(passportAfter, `затверджено ${approve.length}`, stamp);
        if (rowsEqual(nowP.map((r) => pad(r, 2)), wrote.map((r) => pad(r, 2)))) { await W.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: before.passport }]); restore.push("паспорт"); }
        else if (!rowsEqual(nowP.map((r) => pad(r, 2)), before.passport.map((r) => pad(r, 2)))) needsDecision.push("паспорт: змінено іншим — не відкочено");
      }
      await appendJournal(W, [[stamp, "СИСТЕМА", "", "ПОМИЛКА", "", "", "нова система (S1): " + e.message + "; відновлено: " + (restore.join(", ") || "—") + (needsDecision.length ? "; ПОТРЕБУЄ РІШЕННЯ: " + needsDecision.join(" | ") : "")]]);
    } catch (re) { needsDecision.push("ПОМИЛКА ВІДНОВЛЕННЯ: " + re.message); }
    const state = needsDecision.length ? "INCOMPLETE" : "ROLLED_BACK";
    // ENG-28d: ROLLED_BACK — товарних змін немає (не записано або повернуто з перевіркою за ключем): план закрито без подій. INCOMPLETE —
    // план лишається відкритим: після reconcile наступний запуск звірить клітинки-докази й відновить лише підтверджені події (або BLOCK).
    if (planStore && runPlan && state === "ROLLED_BACK") { try { await savePlan(planStore, RUN_PLAN_KEY, { ...runPlan, status: PLAN.ABANDONED, closedAt: stamp, closedBy: "rollback: товарних змін немає (перевірено)" }, runPlanVersion); } catch { /* план лишиться відкритим — наступний запуск звірить докази */ } }
    return { state, error: e.message, outcome: outcomeOf(e), verify: e.verify, restore, needsDecision, keyed: e.keyed || cardResult || undefined };
  }
}

const rowsOf = (header, values) => values.map((v) => Object.fromEntries(header.map((k, j) => [k, v[j] ?? ""])));
/** Повні дані (фото, характеристики, опис) для позицій черги — варіант А. Збій завантаження не зупиняє оновлення цін. */
/** Повні дані (фото, характеристики, опис, модель) для черги (і основного каталогу в синхронізації). Лише ПОВНИЙ перевірений XML:
 *  якщо в ньому < 95% позицій, що є в операційному фіді, — фото й характеристики не оновлюються зовсім (попередження).
 *  Полегшений фід без <picture> ніколи не використовується для фото. Збій завантаження не зупиняє оновлення цін. */
export const FULL_COVERAGE_MIN = 0.95;
export async function fullForQueue(book, fetchFull, warnings, extra = [], { parsed = null, withMain = false } = {}) {
  const idsOf = (name) => { const v = book[name] || []; const col = (v[0] || []).map(mtText).indexOf("ID постачальника"); return col < 0 ? [] : v.slice(1).map((r) => mtText(r[col])).filter(Boolean); };
  const ids = [...new Set([...idsOf(SHEET.queue), ...(withMain ? idsOf(SHEET.main) : []), ...extra])];
  if (!ids.length || !fetchFull) return new Map();
  let full;
  try { full = await fetchFull(ids); }
  catch (e) { warnings.push("повний XML недоступний — фото/характеристики не оновлено: " + String(e?.message || e).slice(0, 120)); return new Map(); }
  if (parsed) {
    const expected = ids.filter((id) => parsed.offers.has(id));
    const got = expected.filter((id) => full.has(id)).length;
    if (expected.length && got / expected.length < FULL_COVERAGE_MIN) {
      warnings.push(`повний XML неповний (${got} з ${expected.length} позицій) — фото й характеристики не оновлено`);
      return new Map();
    }
  }
  return full;
}
/** Нові колонки стану черги (додаються один раз): ширина аркуша + заголовок. */
async function writeQueueHeader(sheets, header) {
  await sheets.ensureColumns(SHEET.queue, header.length);
  await sheets.updateRanges([{ title: SHEET.queue, row: 1, col: 1, values: [header] }]);
}
export const INTAKE_SHEETS = [SHEET.main, SHEET.queue, SHEET.deferred, SHEET.frozen, "Аудит", ARCHIVE_SHEET];

/**
 * GitHub intake: лише черга «Нові товари» (+ «Журнал»). Основний каталог і паспорт не читаються на запис і не змінюються.
 *  ready — від «Сторожа новинок»; кожен кандидат повторно перевіряється за повним XML (planIntake → verifyReady).
 *  Повертає ack для Worker (база відомих ID, відбитки черги, результати) — навіть якщо записувати нічого.
 */
export async function intakeSheet({ sheets, readBook, parsed, fetchFull, stamp, config, now, ready = [], profile = "medium", catalog = null, controls = null, session = null, feedScope = "full" }) {
  // ENG-18 (Hermes ENG16-OPEN-I06): робочий режим — запис черги лише через сесію шлюзу W2 (оренда, журнал операцій, fencing перед
  // кожним записом, без видалень). Без сесії — відмова ДО будь-якого запису (зокрема в «Журнал»).
  if (ownerPriorityEnabled(config) && !session) return { state: "ABORTED", reason: "intake у робочому режимі — лише через сесію шлюзу запису W2 (оренда, журнал, fencing); нічого не записано" };
  if (session && session.state !== "READY") return { state: "BLOCKED", reason: `шлюз запису: ${session.state} — спершу з'ясування попередніх операцій або рішення людини` };
  const W = session ? session.sheets : sheets;
  const ccState = await syncControlsState(controls, config);
  const book = await readBook(INTAKE_SHEETS);
  const warnings = [];
  const fullById = await fullForQueue(book, fetchFull, warnings, ready.map((e) => mtText(e?.id)).filter(Boolean), { parsed });
  const plan = planIntake({ book, parsed, fullById, stamp, config, now, ready, profile, catalog: catalogFor(catalog, warnings), controls: ccState, feedScope: feedScope === "full" ? "full" : "filtered" });
  if (plan.abort) {
    const rec = await recordBlocked(W, stamp, plan.block);
    return { state: "ABORTED", reason: plan.abort, block: plan.block, ...rec };
  }
  const base = { stats: plan.stats, warnings: [...warnings, ...plan.warnings] };
  if (!plan.changed) return { state: "NOTHING_TO_WRITE", ack: plan.ack, ...base };
  // Чергу змінили під час запуску (власник редагує) — нічого не пишемо; Worker повторить після тайм-ауту підтвердження.
  const fresh = await readBook([SHEET.queue]);
  if (!rowsEqual(fresh[SHEET.queue], book[SHEET.queue])) return { state: "SKIPPED_CONCURRENT_EDIT", reason: "чергу змінено під час intake — повтор пізніше", ...base };
  const ccNow = await ccUnchanged(controls, ccState);
  if (!ccNow.ok) return { state: "SKIPPED_CONCURRENT_EDIT", reason: "стан Catalog Controls змінився під час intake (" + ccNow.reason + ") — повтор пізніше", ...base };
  // ENG-22 (Hermes ENG-21 F05): через сесію шлюзу — лише записи за ключем (intakeKeyed); позиційний перезапис черги нижче — тільки
  // явний старий режим без шлюзу (пріоритет власника вимкнено).
  if (session) return intakeKeyed({ session, plan, book, stamp, base });
  const before = book[SHEET.queue].map((r) => r.slice());
  const values = plan.queue.values.map((r) => forSheet(plan.queue.header, r));
  const done = new Set();
  try {
    if (plan.queue.migrated.length) { await writeQueueHeader(W, plan.queue.header); done.add("header"); }
    await rewriteData(W, SHEET.queue, before.length - 1, values, { noDelete: Boolean(session), width: plan.queue.header.length }); done.add("queue");
    if (values.length) await W.setPercentFormat(SHEET.queue, plan.queue.header.indexOf(DISCOUNT) + 1, 2, values.length + 1);
    const after = await readBook([SHEET.queue]);
    const got = after[SHEET.queue];
    const queueOk = rowsEqual([got[0].slice(0, plan.queue.header.length)], [plan.queue.header])
      && rowsEqual(got.slice(1).filter((r) => r.some((v) => v !== "" && v != null)).map((r) => pad(r, plan.queue.header.length)), values);
    if (!queueOk) throw Object.assign(new Error("перевірка черги після запису не пройдена"), { verify: { queueOk } });
    await appendJournal(W, plan.journal);
    return { state: "INTAKE_DONE", ack: plan.ack, verify: { queueOk }, journalEntries: plan.journal.length, viaGateway: Boolean(session), ...base };
  } catch (e) {
    const restore = [];
    try {
      if (done.has("queue")) {
        const now2 = await readBook([SHEET.queue]);
        await rewriteData(W, SHEET.queue, now2[SHEET.queue].length - 1, before.slice(1).map((r) => pad(r, plan.queue.header.length)), { noDelete: Boolean(session), width: plan.queue.header.length });
        restore.push("черга");
      }
      if (done.has("header")) { await W.updateRanges([{ title: SHEET.queue, row: 1, col: 1, values: [pad(before[0], plan.queue.header.length)] }]); restore.push("заголовок черги"); }
      await appendJournal(W, [[stamp, "СИСТЕМА", "", "ПОМИЛКА", "", "", "нова система (intake): " + e.message + "; відновлено: " + restore.join(", ")]]);
    } catch (re) { restore.push("ПОМИЛКА ВІДНОВЛЕННЯ: " + re.message); }
    return { state: "ROLLED_BACK", error: e.message, verify: e.verify, restore, ...base };
  }
}

/** Команди власника в «Рішенні», які intake споживає (refreshQueueRow): ПЕРЕВІРЕНО [SHA] / SEO ПОСТАЧАЛЬНИКА. */
const CONSUMABLE_DECISION = /^(ПЕРЕВІРЕНО(\s+\S+)?|SEO ПОСТАЧАЛЬНИКА)$/;
const normDecision = (v) => mtText(v).trim().toUpperCase().replace(/\s+/g, " ");
const OWNER_EDIT = [ITEM.CONFLICT, ITEM.IDENTITY_MISMATCH, ITEM.MISSING, ITEM.FIELD_CUSTOM];

/**
 * ENG-22 (Hermes ENG-21 F05): intake через сесію шлюзу пише чергу ЗА КЛЮЧЕМ (Offer ID):
 *  - наявні рядки — session.updateByKey лише змінених клітинок, з очікуваними значеннями з цього ж запуску (свіже читання й перевірка
 *    expect безпосередньо перед записом — у keyedUpdate); блок запису містить лише змінені колонки, тож правка власника в іншій колонці
 *    (напр. «Рішення» = ВІДХИЛИТИ між читанням і записом) не перезаписується, а правка в нашій колонці → CONFLICT, клітинку не записано;
 *  - лише колонки, якими intake володіє за контрактом власності черги (затверджений розділ «Нові товари»; до затвердження — тимчасовий,
 *    queue-ownership.mjs). План, що змінює ручну колонку власника, колонку sync або одну з 6 колонок без записувача (B6 «?») →
 *    BLOCKED_OWNERSHIP ДО будь-якого запису;
 *  - «Рішення» — лише споживання команди (ПЕРЕВІРЕНО… / SEO ПОСТАЧАЛЬНИКА → порожньо; expect = сама команда);
 *  - нові рядки — session.appendMissingByKey (без дублів за ключем);
 *  - позиційного перезапису й позиційного «відновлення» немає. INTAKE_DONE (і ack для Worker) — лише якщо всі записи VERIFIED / NOTHING;
 *    правка людини → CONFLICT_OWNER_EDIT (її клітинки не записано, повтор наступного запуску); невідомий результат → INCOMPLETE.
 *  Заголовок черги (міграція колонок режиму черги) — як і раніше, окремим записом рядка 1.
 */
async function intakeKeyed({ session, plan, book, stamp, base }) {
  const header = plan.queue.header;
  const own = withProvisionalQueue(session.gw?.contract || loadOwnership());
  const spec = own.sheets.get(SHEET.queue);
  const writable = new Set(writableColumns(own, SHEET.queue, session.writer));
  const before = book[SHEET.queue] || [[]];
  const bh = (before[0] || []).map(mtText), kb = bh.indexOf("Offer ID");
  const prevByKey = new Map();
  for (const r of before.slice(1)) { const k = mtText(r?.[kb]); if (k) prevByKey.set(k, r); }
  const kc = header.indexOf("Offer ID"), dc = header.indexOf("Рішення");
  const values = plan.queue.values.map((r) => forSheet(header, r));
  const changes = [], added = [], refused = [];
  for (const row of values) {
    const key = mtText(row[kc]);
    if (!key) { refused.push("рядок без Offer ID"); continue; }
    const prev = prevByKey.get(key);
    if (!prev) { added.push(row); continue; }
    const cur = (col) => { const j = bh.indexOf(col); return j < 0 ? "" : mtText(prev[j]); };
    // ENG-28c: «Знижка» «20%» (текст) і 0.2 (число) — те саме значення: лише зміна формату не переписує рядок (рядки «ОЧІКУЄ…» /
    // перенесені intake не веде — їхні клітинки не змінюються).
    const differs = (col, v) => (col === DISCOUNT ? String(sheetDiscount(v)) !== String(sheetDiscount(cur(col))) : mtText(v) !== cur(col));
    const cols = header.filter((col, j) => differs(col, row[j]));
    if (!cols.length) continue;
    for (const col of cols) {
      if (!writable.has(col)) refused.push(`${key}: «${col}» (${spec?.columns.get(col)?.group || "поза контрактом"})`);
      else if (col === "Рішення" && !(mtText(row[dc]) === "" && CONSUMABLE_DECISION.test(normDecision(cur(col))))) refused.push(`${key}: «Рішення» — дозволено лише споживання команди власника`);
    }
    changes.push({ key, identity: { "ID постачальника": cur("ID постачальника") }, expect: Object.fromEntries(cols.map((c) => [c, cur(c)])), set: Object.fromEntries(cols.map((c) => [c, row[header.indexOf(c)]])) });
  }
  if (refused.length) return { state: "BLOCKED_OWNERSHIP", reason: "план intake змінює колонки, якими intake не володіє (контракт власності черги" + (own.provisional?.includes(SHEET.queue) ? ", тимчасовий B6" : "") + ") — нічого не записано: " + refused.slice(0, 5).join("; "), refused: refused.length, ...base };
  const res = { header: false, update: null, append: null };
  const summary = () => ({
    header: res.header, updateOutcome: res.update?.outcome ?? null, appendOutcome: res.append?.outcome ?? null,
    updated: (res.update?.items || []).filter((x) => x.status === ITEM.VERIFIED).length, already: (res.update?.items || []).filter((x) => x.status === ITEM.ALREADY).length,
    ownerEdits: (res.update?.items || []).filter((x) => OWNER_EDIT.includes(x.status)).map((x) => ({ key: x.key, status: x.status })),
    appended: res.append?.appended?.length || 0, provisionalContract: Boolean(own.provisional?.includes(SHEET.queue)),
  });
  try {
    if (plan.queue.migrated.length) { await writeQueueHeader(session.sheets, header); res.header = true; }
    if (changes.length) res.update = await session.updateByKey({ title: SHEET.queue, changes, generation: "intake:" + stamp });
    if (added.length) res.append = await session.appendMissingByKey({ title: SHEET.queue, rows: added, generation: "intake:" + stamp });
    if (values.length) await session.sheets.setPercentFormat(SHEET.queue, header.indexOf(DISCOUNT) + 1, 2, values.length + 1);
  } catch (e) {
    await appendJournal(session.sheets, [[stamp, "СИСТЕМА", "", "ПОМИЛКА", "", "", "нова система (intake): " + e.message + " — позиційного відновлення немає, стан операцій — у журналі W2"]]).catch(() => {});
    return { state: "INCOMPLETE", error: e.message, keyed: summary(), viaGateway: true, ...base };
  }
  const keyed = summary();
  const fine = (r) => !r || r.outcome === OP.VERIFIED || r.outcome === OP.NOTHING;
  // keyedUpdate рахує підсумок лише за записаними рядками: VERIFIED можливий і за CONFLICT в інших — правка людини → не DONE.
  if (fine(res.update) && fine(res.append) && !keyed.ownerEdits.length) {
    await appendJournal(session.sheets, plan.journal);
    return { state: "INTAKE_DONE", ack: plan.ack, verify: { keyed }, journalEntries: plan.journal.length, viaGateway: true, ...base };
  }
  const settled = (r) => !r || ![OP.UNKNOWN, OP.NEEDS_DECISION].includes(r.outcome);
  const ownerEdit = keyed.ownerEdits.length > 0 && settled(res.update) && fine(res.append);
  const note = ownerEdit ? `правку людини виявлено (${keyed.ownerEdits.length} рядк.) — ці клітинки не записано, повтор наступного запуску` : `запис за ключем: оновлення ${keyed.updateOutcome ?? "—"}, додавання ${keyed.appendOutcome ?? "—"}`;
  await appendJournal(session.sheets, [[stamp, "СИСТЕМА", "", "ПОМИЛКА", "", "", "нова система (intake): " + note]]).catch(() => {});
  return { state: ownerEdit ? "CONFLICT_OWNER_EDIT" : "INCOMPLETE", reason: note, keyed, viaGateway: true, ...base };
}

/** Обрізає порожні хвости рядків/колонок і зводить значення до тексту — для порівняння копії з живою таблицею. */
function canon(values) {
  const rows = (values || []).map((r) => r.map((v) => mtText(v)));
  let w = 0;
  for (const r of rows) for (let j = r.length - 1; j >= 0; j--) if (r[j] !== "") { w = Math.max(w, j + 1); break; }
  let last = rows.length;
  while (last > 0 && !rows[last - 1].some((v) => v !== "")) last--;
  return rows.slice(0, last).map((r) => Array.from({ length: w }, (_, j) => r[j] ?? ""));
}
const sameSheet = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
export const REFRESH_SHEETS = [SHEET.main, SHEET.queue, SHEET.deferred, SHEET.frozen, SHEET.groups];

/**
 * Освіжити ТЕСТОВУ КОПІЮ з ЖИВОЇ таблиці (жива — лише читання). Погоджено власником 22.10.2026:
 * виконується після завершення робіт Claude1 над NEW92 і перевірки нового YML.
 *  Передумови (жива): печатки основного каталогу й NEW92 цілі; NEW92 у форматі 40 колонок; у всіх рядках NEW92 заповнено
 *  «Код товару Prom»; одна мітка останнього оновлення. Будь-що не так — нічого не пишемо в копію.
 *  Після запису копію перечитано й звірено з живою таблицею аркуш за аркушем.
 */
export async function refreshCopyFromLive({ sheets, readCopy, readLive, expectNew92 = 92 }) {
  // Спершу копія (лише читання): доступ до неї перевіряється навіть тоді, коли передумови живої не виконані й запису не буде.
  const copy = await readCopy(REFRESH_SHEETS);
  const live = await readLive(REFRESH_SHEETS);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  const main = readSheet(live[SHEET.main], SHEET.main);
  const q = live[SHEET.queue];
  const qHeader = (q[0] || []).map(mtText);
  check("жива: «Нові товари» у форматі NEW92 (40 колонок)", qHeader.join("|") === YML_HEADERS.join("|"));
  if (!checks.every((c) => c.ok)) return { state: "PRECONDITION_FAILED", checks };
  const new92 = readSheet(q, SHEET.queue);
  check(`жива: у «Нових товарах» ${expectNew92} рядків`, new92.rows.length === expectNew92, new92.rows.length);
  check("жива: печатки основного каталогу цілі", main.rows.every((r) => rowSeal(r) === mtText(r[SEAL_COLUMN])), main.rows.filter((r) => rowSeal(r) !== mtText(r[SEAL_COLUMN])).length);
  check("жива: печатки всіх рядків NEW92 цілі (після правок Claude1)", new92.rows.every((r) => rowSeal(r) === mtText(r[SEAL_COLUMN])), new92.rows.filter((r) => rowSeal(r) !== mtText(r[SEAL_COLUMN])).length);
  const noCode = new92.rows.filter((r) => !mtText(r["Код товару Prom"]).trim()).length;
  check("жива: «Код товару Prom» заповнено в усіх рядках NEW92", noCode === 0, noCode);
  const stamps = new Set([...main.rows, ...new92.rows].map((r) => mtText(r["Оновлено"])));
  check("жива: одна мітка останнього оновлення цін (дані узгоджені)", stamps.size === 1, stamps.size);
  const codes = [...main.rows, ...new92.rows].map((r) => mtText(r["Код товару Prom"]).trim()).filter(Boolean);
  const dupCodes = codes.length - new Set(codes).size;
  const warnings = dupCodes ? [`повторюваних «Код товару Prom» у каталозі: ${dupCodes} (Prom може об'єднати такі товари) — перевірити`] : [];
  if (!checks.every((c) => c.ok)) return { state: "PRECONDITION_FAILED", checks, warnings };

  const actions = {};
  for (const title of REFRESH_SHEETS) {
    const src = live[title] || [];
    const dst = copy[title] || [];
    if (sameSheet(src, dst)) { actions[title] = "без змін"; continue; }
    const width = Math.max(...src.map((r) => r.length), ...dst.map((r) => r.length), 1);
    if (title === SHEET.main) {
      // Якщо ID, порядок і печатки однакові — відрізняються лише операційні колонки: пишемо тільки їх.
      const c = readSheet(dst, title);
      const sameContent = c.rows.length === main.rows.length && c.rows.every((r, i) => mtText(r["Offer ID"]) === mtText(main.rows[i]["Offer ID"]) && mtText(r[SEAL_COLUMN]) === mtText(main.rows[i][SEAL_COLUMN]))
        && c.header.join("|") === main.header.join("|");
      if (sameContent) {
        await sheets.updateRanges([{ title, row: 2, col: main.start + 1, values: main.rows.map((r) => LIVE_COLUMNS.map((k) => r[k] ?? "")) }]);
        actions[title] = "лише ціни/наявність";
        continue;
      }
    }
    await sheets.ensureColumns(title, width);
    await sheets.updateRanges([{ title, row: 1, col: 1, values: [pad(src[0] || [], width)] }]);
    await rewriteData(sheets, title, Math.max(0, dst.length - 1), src.slice(1).map((r) => pad(r, width)));
    actions[title] = "переписано повністю";
  }

  const after = await readCopy(REFRESH_SHEETS);
  const verify = Object.fromEntries(REFRESH_SHEETS.map((t) => [t, sameSheet(live[t], after[t])]));
  const n2 = readSheet(after[SHEET.queue], SHEET.queue).rows;
  verify.new92Codes = n2.filter((r) => mtText(r["Код товару Prom"]).trim()).length;
  verify.new92SealsIntact = n2.every((r) => rowSeal(r) === mtText(r[SEAL_COLUMN]));
  const ok = REFRESH_SHEETS.every((t) => verify[t]) && verify.new92Codes === expectNew92 && verify.new92SealsIntact;
  return { state: ok ? "REFRESHED" : "VERIFY_FAILED", checks, warnings, actions, verify };
}

/** ENG-28: перенесення NEW92 → «Основний каталог» (погоджено власником 01.11.2026) — B6-сумісний записувач (план — planTransferNew92).
 *  Лише за окремим дозволом власника й поза вікном mtUpdate (Hermes R-N3W: у Sheets API немає CAS — власник не редагує, тригери Apps
 *  Script вимкнено). Без видалень рядків: основний каталог — appendMissingByKey (повтор не дублює), черга — заголовок + позначка
 *  «ПЕРЕНЕСЕНО» в «Перевірці» за ключем (рядки лишаються до рішення B6), паспорт, «Журнал». Перевірка після запису — за ключем.
 *  session — сесія шлюзу W2 (writer "sync"); без сесії — прямий запис із тим самим контрактом власності (лише тести / dry-run у пам'яті).
 *  ENG-28d (F-28B-2): із сесією W2 — КОНТРОЛЬНИЙ ПЛАН у сховищі W2 до першого запису (92 Offer ID, відбитки вхідних і цільових рядків,
 *  очікувані позначки, паспорт, події «Журналу» з ID, ID операції). Повторний запуск при відкритому плані — не повтор, а контрольоване
 *  продовження: лише після reconcile W2, свіже читання, стан кожного Offer ID (classifyTransfer); будь-який конфлікт → BLOCK і звіт;
 *  інакше — лише відсутні операції (append за ключем, позначки за ключем, паспорт, відсутні за ID події) і звірка за планом. Не транзакція:
 *  R-N3W відкритий. */
export async function transferNew92({ sheets, readBook, stamp, snapshotDate, session = null, contract = null, approvedBy, decisionRef, expectCount = null }) {
  const T = await import("../core/transfer-new92.mjs");
  const { planTransferNew92, TRANSFER_MARK } = T;
  const planStore = session?.gw?.store?.getJsonVersioned ? session.gw.store : null;
  if (planStore) {
    const open = await loadPlan(planStore, TRANSFER_PLAN_KEY);
    if (isOpen(open.plan)) return resumeTransfer({ T, cp: open.plan, version: open.version, planStore, session, readBook, stamp });
  }
  const book = await readBook([SHEET.main, SHEET.queue, SHEET.deferred, SHEET.frozen, SHEET.groups, SHEET.passport]);
  const plan = planTransferNew92({ book, stamp, snapshotDate, approvedBy, decisionRef, expectCount });
  if (plan.state === "ALREADY") return { state: "NOTHING", reason: "перенесення вже виконано", checks: plan.checks, counts: plan.counts };
  if (plan.state !== "READY") return { state: "PRECONDITION_FAILED", checks: plan.checks, counts: plan.counts };
  if (session && session.state !== "READY") return { state: "BLOCKED", reason: `шлюз запису: ${session.state}` };
  const W = session ? session.sheets : sheets;
  const own = contract || loadOwnership();
  const ownQ = withProvisionalQueue(session?.gw?.contract || own);
  const append = (o) => (session ? session.appendMissingByKey(o) : appendMissingByKey({ sheets, read: readBook, contract: own, writer: "sync", ...o }));
  const keyed = (o, c) => (session ? session.updateByKey(o) : keyedUpdate({ sheets, read: readBook, contract: c, writer: "sync", ...o }));
  const events0 = [[stamp, "СИСТЕМА", "", "NEW92 → ОСНОВНИЙ КАТАЛОГ", "", plan.counts.moved, JSON.stringify({ mode: "ПЕРЕНЕСЕННЯ (B6)", count: plan.passportAfter.count, absentInSnapshot: plan.absentMarks.map((x) => x.offerId) })],
    ...plan.absentMarks.map((x) => [stamp, SHEET.main, x.offerId, "Стан у постачальника", "", x.presence, `відсутній у знімку YML постачальника від ${snapshotDate}; не «видалений»; перевірити з актуальним повним фідом`])];
  // ENG-28d: контрольний план ДО першого запису; без нього (сховище W2 недоступне) — нічого не пишемо.
  let cp = null, cpVersion = null;
  if (planStore) {
    const opId = "transfer-new92:" + stamp;
    cp = { ...T.transferControlPlan(plan, { book, stamp, snapshotDate, approvedBy, decisionRef, opId }), events: withEventIds(opId, events0) };
    try { cpVersion = await savePlan(planStore, TRANSFER_PLAN_KEY, cp, (await loadPlan(planStore, TRANSFER_PLAN_KEY)).version); }
    catch (e) { return { state: "BLOCKED", reason: "контрольний план перенесення не записано (сховище W2): " + mtText(e?.message || e).slice(0, 200) + " — нічого не записано" }; }
  }
  const progress = async (status) => { if (!cp) return; cpVersion = await savePlan(planStore, TRANSFER_PLAN_KEY, { ...cp, status, progressAt: stamp }, cpVersion); cp = { ...cp, status }; };
  const done = [];
  try {
    if (plan.addMainColumns.length) {
      await W.ensureColumns(SHEET.main, plan.mainHeaderAfter.length);
      await W.updateRanges([{ title: SHEET.main, row: 1, col: 1, values: [plan.mainHeaderAfter] }]); done.push("mainHeader");
    }
    const ar = await append({ title: SHEET.main, rows: plan.moveRows.map((r) => plan.mainHeaderAfter.map((k) => r[k] ?? "")), generation: "transfer-new92:" + stamp });
    if (ar.outcome !== OP.VERIFIED && ar.outcome !== OP.NOTHING) throw Object.assign(new Error("основний каталог: " + ar.outcome), { keyed: ar });
    done.push("main"); await progress("MAIN_DONE");
    if (plan.queueColumnsAdded.length) { await writeQueueHeader(W, plan.queueHeaderAfter); done.push("queueHeader"); }
    const qr = await keyed({ title: SHEET.queue, changes: plan.queueMarks.map((m) => ({ key: m.offerId, expect: { "Перевірка": m.expect ?? "" }, set: { "Перевірка": m.check } })), generation: "transfer-mark:" + stamp }, ownQ);
    if (qr.outcome !== OP.VERIFIED) throw Object.assign(new Error("позначки черги: " + qr.outcome), { keyed: qr });
    done.push("queueMarks"); await progress("MARKS_DONE");
    await W.ensureSheet(SHEET.passport, PASSPORT_HEADER.slice());
    await W.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: passportValues(plan.passportAfter, `NEW92 (${plan.counts.moved}) перенесено в основний каталог; рядки черги збережено (B6)`, stamp) }]); done.push("passport");
    await progress("PASSPORT_DONE");
    if (cp) {
      const jr = await appendEvents({ session, journalValues: (await readBook([JOURNAL_SHEET]))[JOURNAL_SHEET], rows: cp.events, generation: "journal:" + cp.opId });
      if (!jr.ok) throw new Error("«Журнал» перенесення: " + jr.outcome);
    } else await appendJournal(W, events0);
    done.push("journal");
    // Перевірка після запису — за ключем; із планом — повна звірка за контрольним планом (5 121 / 92 / черга / паспорт / журнал).
    const after = await readBook([SHEET.main, SHEET.queue, SHEET.passport, ...(cp ? [JOURNAL_SHEET] : [])]);
    const m2 = readSheet(after[SHEET.main], SHEET.main), q2 = readSheet(after[SHEET.queue], SHEET.queue);
    const byId = new Map(m2.rows.map((r) => [mtText(r["Offer ID"]), r]));
    const qById = new Map(q2.rows.map((r) => [mtText(r["Offer ID"]), r]));
    const verify = {
      mainCount: m2.rows.length, expectedCount: plan.counts.mainAfter,
      movedIdentical: plan.moveRows.every((r) => { const x = byId.get(mtText(r["Offer ID"])); return x && YML_HEADERS.every((k) => mtText(x[k]) === mtText(r[k])); }),
      absentMarked: plan.absentMarks.every((m) => mtText(byId.get(m.offerId)?.["Стан у постачальника"]) === m.presence),
      queueRowsKept: plan.queueMarks.every((m) => mtText(qById.get(m.offerId)?.["Перевірка"]).startsWith(TRANSFER_MARK)),
      queueHeaderOk: (after[SHEET.queue][0] || []).map(mtText).join("|") === QUEUE_HEADERS.join("|"),
      passportOk: samePassport(readPassport(after[SHEET.passport]), plan.passportAfter),
      ...(cp ? { plan: T.verifyTransferState(cp, after, { journal: journalIds(after[JOURNAL_SHEET]), events: cp.events }) } : {}),
    };
    const planOk = !cp || (verify.plan.uniqueIds && verify.plan.allMovedIdentical && verify.plan.queueRowsKept && verify.plan.passportOk && verify.plan.journalOk);
    const ok = verify.mainCount === verify.expectedCount && verify.movedIdentical && verify.absentMarked && verify.queueRowsKept && verify.queueHeaderOk && verify.passportOk && planOk;
    if (!ok) throw Object.assign(new Error("перевірка після запису не пройдена"), { verify });
    await progress("DONE");
    return { state: "TRANSFERRED", moved: plan.counts.moved, counts: plan.counts, absentInSnapshot: plan.absentMarks.map((x) => x.offerId), verify, checks: plan.checks, ...(cp ? { controlPlan: { opId: cp.opId, status: cp.status } } : {}) };
  } catch (e) {
    // Без видалень і без позиційного «відновлення»: записане за ключем лишається. Із планом — наступний запуск: reconcile W2 → контрольоване
    // продовження за станом кожного Offer ID (або BLOCK); без плану — рішення людини.
    return { state: "INCOMPLETE", error: mtText(e?.message || e).slice(0, 300), done, verify: e?.verify, needsDecision: !cp, ...(cp ? { controlPlan: { opId: cp.opId, status: cp.status }, next: "--mode=reconcile → --mode=merge (контрольоване продовження)" } : {}) };
  }
}

/** ENG-28d (F-28B-2): контрольоване продовження перенесення за відкритим планом. Лише з сесією W2 READY (після reconcile — сліпого повтору
 *  немає). Свіже читання → стан кожного Offer ID → конфлікт: BLOCK і звіт (рішення власника); інакше лише відсутні операції. */
async function resumeTransfer({ T, cp, version, planStore, session, readBook, stamp }) {
  const base = { resumed: true, controlPlan: { opId: cp.opId, status: cp.status } };
  if (!session || session.state !== "READY") return { state: "BLOCKED", reason: `незавершене перенесення ${cp.opId}: спершу reconcile W2 (сесія ${session?.state ?? "відсутня"}) — сліпого повтору немає`, ...base };
  const book = await readBook([SHEET.main, SHEET.queue, SHEET.passport, SHEET.groups, JOURNAL_SHEET]);
  const cls = T.classifyTransfer(cp, book);
  if (cls.conflicts.length) return { state: "BLOCKED", reason: `незавершене перенесення ${cp.opId}: конфліктів ${cls.conflicts.length} — продовження небезпечне (нічого не записано), потрібне рішення власника`, classification: cls.counts, header: cls.header, conflicts: cls.conflicts.slice(0, 50), ...base };
  const ids = (s) => cls.items.filter((x) => s.includes(x.status)).map((x) => x.offerId);
  const notMoved = ids([T.MOVE.NOT_MOVED]), unmarked = ids([T.MOVE.NOT_MOVED, T.MOVE.MOVED_UNMARKED]);
  const W = session.sheets;
  let ver = version, cur = cp;
  const progress = async (status) => { ver = await savePlan(planStore, TRANSFER_PLAN_KEY, { ...cur, status, resumedAt: stamp, resume: { from: cp.status, ...cls.counts } }, ver); cur = { ...cur, status }; };
  const done = [];
  try {
    if (cls.header === "PENDING") { await W.ensureColumns(SHEET.main, cp.mainHeaderAfter.length); await W.updateRanges([{ title: SHEET.main, row: 1, col: 1, values: [cp.mainHeaderAfter] }]); done.push("mainHeader"); }
    if (notMoved.length) {
      const qRows = readSheet(book[SHEET.queue], SHEET.queue).rows;
      const rows = notMoved.map((id) => T.targetRowOf(qRows.find((r) => mtText(r["Offer ID"]) === id), { mainHeaderAfter: cp.mainHeaderAfter, stamp: cp.stamp, snapshotDate: cp.snapshotDate }));
      const bad = rows.filter((r) => T.rowHash(r, cp.mainHeaderAfter) !== cp.target[mtText(r["Offer ID"])]).map((r) => mtText(r["Offer ID"]));
      if (bad.length) return { state: "BLOCKED", reason: `незавершене перенесення ${cp.opId}: відтворений цільовий рядок не збігається з планом (${bad.length}) — нічого не записано`, conflicts: bad.map((offerId) => ({ offerId, why: "відтворений рядок ≠ плану" })), ...base };
      const ar = await session.appendMissingByKey({ title: SHEET.main, rows: rows.map((r) => cp.mainHeaderAfter.map((k) => r[k] ?? "")), generation: "transfer-resume:" + cp.opId });
      if (ar.outcome !== OP.VERIFIED && ar.outcome !== OP.NOTHING) throw new Error("основний каталог (продовження): " + ar.outcome);
      done.push("main");
    }
    await progress("MAIN_DONE");
    if (unmarked.length) {
      const qr = await session.updateByKey({ title: SHEET.queue, changes: unmarked.map((id) => ({ key: id, expect: { "Перевірка": cp.marks[id].expect }, set: { "Перевірка": cp.marks[id].set } })), generation: "transfer-resume-mark:" + cp.opId });
      const notDone = (qr.items || []).filter((x) => x.status !== ITEM.VERIFIED && x.status !== ITEM.ALREADY);
      if (qr.outcome !== OP.VERIFIED || notDone.length) throw new Error("позначки черги (продовження): " + qr.outcome + (notDone.length ? `; ${notDone.slice(0, 5).map((x) => `${x.key}: ${x.status}`).join("; ")}` : ""));
      done.push("queueMarks");
    }
    await progress("MARKS_DONE");
    if (!samePassport(readPassport(book[SHEET.passport]), cp.passportAfter)) {
      await W.ensureSheet(SHEET.passport, PASSPORT_HEADER.slice());
      await W.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: passportValues(cp.passportAfter, `NEW92 (${cp.counts.moved}) перенесено в основний каталог; рядки черги збережено (B6)`, cp.stamp) }]); done.push("passport");
    }
    await progress("PASSPORT_DONE");
    const note = withEventIds(`resume:${cp.opId}:${stamp}`, [[stamp, "СИСТЕМА", "", "ПРОДОВЖЕННЯ ПЕРЕНЕСЕННЯ", cp.opId, notMoved.length, JSON.stringify({ classification: cls.counts, header: cls.header, appendedToMain: notMoved.length, marked: unmarked.length })]]);
    const jr = await appendEvents({ session, journalValues: book[JOURNAL_SHEET], rows: [...cp.events, ...note], generation: "journal-resume:" + cp.opId + ":" + stamp });
    if (!jr.ok) throw new Error("«Журнал» (продовження): " + jr.outcome);
    done.push("journal");
    const after = await readBook([SHEET.main, SHEET.queue, SHEET.passport, JOURNAL_SHEET]);
    const v = T.verifyTransferState(cp, after, { journal: journalIds(after[JOURNAL_SHEET]), events: cp.events });
    if (!(v.mainCount === v.expectedCount && v.uniqueIds && v.allMovedIdentical && v.queueRowsKept && v.passportOk && v.journalOk)) throw Object.assign(new Error("звірка за контрольним планом не пройдена"), { verify: v });
    await progress("DONE");
    return { state: "TRANSFERRED", moved: cp.counts.moved, counts: cp.counts, absentInSnapshot: cp.absentInSnapshot, classification: cls.counts, appendedNow: notMoved.length, markedNow: unmarked.length, verify: v, ...base, controlPlan: { opId: cp.opId, status: "DONE" } };
  } catch (e) {
    return { state: "INCOMPLETE", error: mtText(e?.message || e).slice(0, 300), done, verify: e?.verify, classification: cls.counts, next: "--mode=reconcile → --mode=merge (контрольоване продовження)", ...base };
  }
}
