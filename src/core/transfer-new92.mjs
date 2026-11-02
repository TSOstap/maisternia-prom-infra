/** ENG-28 — план перенесення NEW92 («Нові товари» у форматі каталогу, 40 колонок) в «Основний каталог» (погоджено власником 01.11.2026).
 *  Чиста функція: лише читання книги → перевірки + точний план змін. Запис — transferNew92 (sheet-sync-run), лише після дозволу.
 *
 *  Відмінності від mergeNew92 (лише синтетичні тести):
 *   - рядки черги НЕ видаляються (B6): лишаються з позначкою «ПЕРЕНЕСЕНО» в «Перевірці»; видалення — окреме рішення B6;
 *   - рядки в основний каталог — за ключем (Offer ID): повтор нічого не дублює;
 *   - товар зі станом «ВІДСУТНІЙ_У_YML» (знімок LIVE) — «ВІДСУТНІЙ_У_ЗНІМКУ» з датою знімка, НЕ «ВИДАЛЕНИЙ_У_ПОСТАЧАЛЬНИКА»
 *     (старий знімок не доводить видалення; перевірка — з актуальним повним фідом; без рішення власника не виключати);
 *   - передумови суворі: цілі печатки NEW92 і основного каталогу, «ДОЗВОЛЕНО», унікальні ID, групи існують. */
import crypto from "node:crypto";
import { mtText } from "./text.mjs";
import { readSheet } from "./sync-plan.mjs";
import { YML_HEADERS, SEAL_COLUMN, rowSeal, approvalManifest, GROUP_HEADERS } from "./seal.mjs";
import { objectsFromValues } from "./yml.mjs";
import { SHEET, QUEUE_HEADERS, PENDING_TRANSFER_MARK, readPassport, samePassport } from "./sheet-sync.mjs";
import { STATE_COLUMN, WARNING_MARK_COLUMN } from "./field-control.mjs";
import { stateCell, approvalState } from "./owner-priority.mjs";
import { PRESENCE_COLUMNS, PRESENCE_COLUMN, PRESENCE_META_COLUMN, absentInSnapshotCell } from "./supplier-presence.mjs";

export const TRANSFER_MARK = "ПЕРЕНЕСЕНО В «ОСНОВНИЙ КАТАЛОГ»";
export { PENDING_TRANSFER_MARK };
const t = (v) => mtText(v).trim();

/** ENG-28a, крок 1 (міграція структури): «Нові товари» NEW92 (40 колонок) → заголовок черги (53), рядки лишаються, у «Перевірці» —
 *  «ОЧІКУЄ ПЕРЕНЕСЕННЯ…» (sync / intake такі рядки не змінюють — печатки NEW92 цілі до перенесення). Повтор — ALREADY. */
export function planQueueMigration({ book, stamp, decisionRef = "доручення власника 01.11.2026" }) {
  const q = book[SHEET.queue] || [[]];
  const h = (q[0] || []).map(t);
  const isNew92 = h.length === YML_HEADERS.length && h.every((k, i) => k === YML_HEADERS[i]);
  const isQueue = QUEUE_HEADERS.every((k) => h.includes(k));
  if (isQueue) {
    const rows = readSheet(q, SHEET.queue).rows;
    // ENG-28b: позначки після перенесення — системні («ПЕРЕНЕСЕНО…», а синхронізація пише «ПЕРЕНЕСЕНО: товар уже в…» / «НЕ ВІДХИЛЕНО: …»);
    // інші рядки після перенесення — новинки intake. До перенесення інший рядок (без «ОЧІКУЄ…») — часткова міграція → PRECONDITION_FAILED.
    const s = (r) => t(r["Перевірка"]);
    const pending = rows.filter((r) => s(r).startsWith(PENDING_TRANSFER_MARK)).length;
    const done = rows.filter((r) => s(r).startsWith("ПЕРЕНЕСЕНО") || s(r).startsWith("НЕ ВІДХИЛЕНО: товар уже в «Основному каталозі»")).length;
    const other = rows.length - pending - done;
    return { state: other === 0 || done > 0 ? "ALREADY" : "PRECONDITION_FAILED", checks: [{ name: "черга вже у форматі черги", ok: true, detail: { pending, done, other } }], marks: [] };
  }
  const checks = [{ name: "«Нові товари» у форматі NEW92 (40 колонок каталогу)", ok: isNew92, detail: h.length }];
  const rows = isNew92 ? readSheet(q, SHEET.queue).rows : [];
  const ids = rows.map((r) => t(r["Offer ID"]));
  checks.push({ name: "Offer ID унікальні й непорожні", ok: ids.length > 0 && new Set(ids).size === ids.length && ids.every(Boolean) });
  return { state: checks.every((c) => c.ok) ? "READY" : "PRECONDITION_FAILED", checks, header: QUEUE_HEADERS.slice(), columnsAdded: QUEUE_HEADERS.filter((k) => !h.includes(k)),
    marks: ids.map((id) => ({ offerId: id, expect: "", check: `${PENDING_TRANSFER_MARK} (${decisionRef}); підготовлено ${stamp}` })) };
}

/** Цільовий рядок «Основного каталогу» для рядка черги — детерміновано (той самий результат для плану й для продовження після збою):
 *  колонки mainHeaderAfter з рядка черги як є; «відсутній у знімку» для «ВІДСУТНІЙ_У_YML»; стан полів — як при штатному затвердженні.
 *  ENG-28a: основний каталог уже в режимі пріоритету власника — стан полів як при штатному затвердженні з черги (інакше рядок
 *  «без стану полів» ізолюється); позначка попереджень порожня. Печатка не змінюється (ті самі незмінні поля, що в NEW92). */
export function targetRowOf(r, { mainHeaderAfter, stamp, snapshotDate }) {
  const row = Object.fromEntries(mainHeaderAfter.map((k) => [k, r[k] ?? ""]));
  if (t(r["Стан синхронізації"]) === "ВІДСУТНІЙ_У_YML") {
    const cell = absentInSnapshotCell({ snapshotDate: t(snapshotDate), stamp });
    row[PRESENCE_COLUMN] = cell.presence; row[PRESENCE_META_COLUMN] = cell.meta;
  }
  if (mainHeaderAfter.includes(STATE_COLUMN)) { row[STATE_COLUMN] = stateCell(approvalState(row, stamp), row); if (mainHeaderAfter.includes(WARNING_MARK_COLUMN)) row[WARNING_MARK_COLUMN] = ""; }
  return row;
}
/** Відбиток рядка за переліком колонок (значення як текст). */
export const rowHash = (row, header) => crypto.createHash("sha256").update(JSON.stringify(header.map((k) => mtText(row?.[k] ?? "")))).digest("hex").slice(0, 32);
const setHash = (list) => crypto.createHash("sha256").update(JSON.stringify(list.slice().sort())).digest("hex").slice(0, 32);

/**
 * ENG-28d (F-28B-2): контрольний план перенесення — фіксується в сховищі W2 ДО першого запису. Містить: ID операції, 92 Offer ID,
 * відбитки вхідних рядків черги (усі колонки черги), відбитки очікуваних цільових рядків «Основного каталогу», очікувані позначки
 * черги (було → стало), очікуваний паспорт, заголовки до / після, відбитки решти рядків (контроль «жодного зайвого запису»).
 */
export function transferControlPlan(plan, { book, stamp, snapshotDate, approvedBy, decisionRef, opId }) {
  const qHeader = (book[SHEET.queue][0] || []).map(t), mainHeaderBefore = (book[SHEET.main][0] || []).map(t);
  const qRows = readSheet(book[SHEET.queue], SHEET.queue).rows, mainRows = readSheet(book[SHEET.main], SHEET.main).rows;
  const ids = plan.moveRows.map((r) => t(r["Offer ID"])), idSet = new Set(ids);
  const qById = new Map(qRows.map((r) => [t(r["Offer ID"]), r]));
  return {
    v: 1, kind: "transfer-new92", opId, stamp, snapshotDate: t(snapshotDate), approvedBy, decisionRef, status: "PLANNED", createdAt: stamp,
    ids, queueHeader: qHeader, mainHeaderBefore, mainHeaderAfter: plan.mainHeaderAfter,
    input: Object.fromEntries(ids.map((id) => [id, rowHash(qById.get(id), qHeader)])),
    target: Object.fromEntries(plan.moveRows.map((r) => [t(r["Offer ID"]), rowHash(r, plan.mainHeaderAfter)])),
    marks: Object.fromEntries(plan.queueMarks.map((m) => [m.offerId, { expect: m.expect, set: m.check }])),
    passportAfter: plan.passportAfter, counts: plan.counts, absentInSnapshot: plan.absentMarks.map((x) => x.offerId),
    othersHash: { main: setHash(mainRows.filter((r) => !idSet.has(t(r["Offer ID"]))).map((r) => rowHash(r, mainHeaderBefore))), queue: setHash(qRows.filter((r) => !idSet.has(t(r["Offer ID"]))).map((r) => rowHash(r, qHeader))) },
  };
}

export const MOVE = Object.freeze({ NOT_MOVED: "НЕ_ПЕРЕНЕСЕНО", MOVED_UNMARKED: "ПЕРЕНЕСЕНО_БЕЗ_ПОЗНАЧКИ", MOVED_DONE: "ПЕРЕНЕСЕНО_ПОВНІСТЮ", CONFLICT: "КОНФЛІКТ" });
/**
 * ENG-28d: стан кожного Offer ID плану за СВІЖИМ читанням (після reconcile W2). Безпечне продовження — лише якщо конфліктів немає.
 *  НЕ_ПЕРЕНЕСЕНО — у основному каталозі немає, рядок черги побайтово як у плані;
 *  ПЕРЕНЕСЕНО_БЕЗ_ПОЗНАЧКИ — рядок у каталозі рівно один і побайтово = запланованому, рядок черги як у плані (позначку не записано);
 *  ПЕРЕНЕСЕНО_ПОВНІСТЮ — те саме + позначка черги = запланованій (решта колонок черги — як у плані);
 *  КОНФЛІКТ — усе інше: дубль Offer ID, рядок каталогу змінено (власник / інший запис), рядок черги змінено або відсутній, позначка є без
 *  товару, заголовок не за планом.
 */
export function classifyTransfer(cp, book) {
  const h = (book[SHEET.main]?.[0] || []).map(t);
  const pad = (a, n) => Array.from({ length: n }, (_, i) => a[i] ?? "");
  const header = cp.mainHeaderAfter.every((k, i) => h[i] === k) ? "DONE"
    : cp.mainHeaderBefore.every((k, i) => h[i] === k) && pad(h, cp.mainHeaderAfter.length).slice(cp.mainHeaderBefore.length).every((x) => !x) ? "PENDING" : "CHANGED";
  const group = (rows) => { const m = new Map(); for (const r of rows) { const k = t(r["Offer ID"]); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const mainById = group(readSheet(book[SHEET.main], SHEET.main).rows), qById = group(readSheet(book[SHEET.queue], SHEET.queue).rows);
  const items = cp.ids.map((id) => {
    const c = (why) => ({ offerId: id, status: MOVE.CONFLICT, why });
    const q = qById.get(id) || [], m = mainById.get(id) || [];
    if (q.length !== 1) return c(q.length ? "Offer ID у черзі кілька разів" : "рядка черги немає");
    const inputSame = rowHash(q[0], cp.queueHeader) === cp.input[id];
    const marked = t(q[0]["Перевірка"]) === t(cp.marks[id]?.set) && rowHash({ ...q[0], "Перевірка": cp.marks[id]?.expect ?? "" }, cp.queueHeader) === cp.input[id];
    if (!inputSame && !marked) return c("рядок черги змінено після плану (рішення / SEO / B6 / позначка) — не перезаписується");
    if (m.length > 1) return c(`Offer ID в «Основному каталозі» ${m.length} рази — дубль`);
    if (m.length === 1) {
      if (header !== "DONE") return c("рядок є в каталозі, а заголовок не за планом");
      if (rowHash(m[0], cp.mainHeaderAfter) !== cp.target[id]) return c("рядок «Основного каталогу» відрізняється від запланованого (змінено після часткового перенесення) — не перезаписується");
      return { offerId: id, status: marked ? MOVE.MOVED_DONE : MOVE.MOVED_UNMARKED };
    }
    if (marked) return c("позначку «ПЕРЕНЕСЕНО» записано, а товару в «Основному каталозі» немає");
    return { offerId: id, status: MOVE.NOT_MOVED };
  });
  const counts = Object.fromEntries(Object.values(MOVE).map((s) => [s, items.filter((x) => x.status === s).length]));
  return { header, items, counts, conflicts: [...(header === "CHANGED" ? [{ offerId: "", status: MOVE.CONFLICT, why: "заголовок «Основного каталогу» змінено не за планом" }] : []), ...items.filter((x) => x.status === MOVE.CONFLICT)] };
}

/** ENG-28d: звірка після перенесення (першого або продовженого) за контрольним планом. journal — Set ID подій «Журналу». */
export function verifyTransferState(cp, book, { journal = null, events = [] } = {}) {
  const main = readSheet(book[SHEET.main], SHEET.main).rows, q = readSheet(book[SHEET.queue], SHEET.queue).rows;
  const ids = main.map((r) => t(r["Offer ID"])), idSet = new Set(cp.ids);
  const cls = classifyTransfer(cp, book);
  const mainHeaderNow = (book[SHEET.main][0] || []).map(t), qHeaderNow = (book[SHEET.queue][0] || []).map(t);
  return {
    mainCount: main.length, expectedCount: cp.counts.mainAfter, uniqueIds: new Set(ids).size === ids.length,
    allMovedIdentical: cls.items.every((x) => x.status === MOVE.MOVED_DONE), moved: cls.counts[MOVE.MOVED_DONE],
    queueRowsKept: cp.ids.every((id) => q.filter((r) => t(r["Offer ID"]) === id).length === 1),
    passportOk: samePassport(readPassport(book[SHEET.passport]), cp.passportAfter),
    journalOk: journal ? events.every((r) => journal.has(t(r[7]))) : null,
    othersMainUnchanged: setHash(main.filter((r) => !idSet.has(t(r["Offer ID"]))).map((r) => rowHash(r, cp.mainHeaderBefore))) === cp.othersHash.main && mainHeaderNow.length >= cp.mainHeaderBefore.length,
    othersQueueUnchanged: setHash(q.filter((r) => !idSet.has(t(r["Offer ID"]))).map((r) => rowHash(r, cp.queueHeader))) === cp.othersHash.queue && qHeaderNow.length >= cp.queueHeader.length,
    conflicts: cls.conflicts.slice(0, 20),
  };
}
/** book: { [аркуш]: values } (основний, черга, відкладені, заморожені, групи, паспорт). snapshotDate — дата знімка LIVE (останнє оновлення). */
/** ENG-28b: у черзі після міграції структури переносяться лише рядки «ОЧІКУЄ ПЕРЕНЕСЕННЯ»; інші рядки (напр. новинки intake) не
 *  чіпаються. expectCount — скільки рядків має чекати (рішення власника: 92); інша кількість (часткова міграція) → PRECONDITION_FAILED. */
export function planTransferNew92({ book, stamp, snapshotDate, approvedBy = "власник", decisionRef = "доручення власника 01.11.2026", expectCount = null }) {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); return ok; };
  const q = book[SHEET.queue] || [[]];
  const qHeader = (q[0] || []).map(t);
  const main = readSheet(book[SHEET.main], SHEET.main);
  const mainIds = new Set(main.rows.map((r) => t(r["Offer ID"])));
  const isNew92 = qHeader.length === YML_HEADERS.length && qHeader.every((k, i) => k === YML_HEADERS[i]);
  const isQueue = QUEUE_HEADERS.every((k) => qHeader.includes(k));
  const allQueueRows = isNew92 || isQueue ? readSheet(q, SHEET.queue).rows : [];
  const pendingRows = isQueue ? allQueueRows.filter((r) => t(r["Перевірка"]).startsWith(PENDING_TRANSFER_MARK)) : [];
  // Системні позначки рядка черги, чий товар уже в основному каталозі: «ПЕРЕНЕСЕНО В «ОСНОВНИЙ КАТАЛОГ»…» (transferNew92),
  // «ПЕРЕНЕСЕНО: товар уже в…» і «НЕ ВІДХИЛЕНО: товар уже в…» (синхронізація, N4 / B6). Інший текст — не системний.
  const systemDone = (r) => { const s = t(r["Перевірка"]); return s.startsWith("ПЕРЕНЕСЕНО") || s.startsWith("НЕ ВІДХИЛЕНО: товар уже в «Основному каталозі»"); };
  const transferredRows = isQueue ? allQueueRows.filter((r) => mainIds.has(t(r["Offer ID"])) && systemDone(r)) : [];
  const queueRows = isNew92 ? allQueueRows : pendingRows;
  const isPending = isQueue && pendingRows.length > 0;
  // Повтор після виконаного перенесення: рядків «ОЧІКУЄ…» немає, перенесені — в основному каталозі з позначкою → нічого не робити.
  // Рядок черги, чий ID уже в основному каталозі, але без позначки «ПЕРЕНЕСЕНО» (конфлікт позначки) — НЕ «виконано»: рішення людини.
  const unmarkedInMain = isQueue ? allQueueRows.filter((r) => mainIds.has(t(r["Offer ID"])) && !systemDone(r)) : [];
  if (isQueue && !pendingRows.length && !unmarkedInMain.length && transferredRows.length && transferredRows.every((r) => mainIds.has(t(r["Offer ID"])))) {
    return { state: "ALREADY", checks: [{ name: "перенесення вже виконано (усі ID в основному каталозі, позначки «ПЕРЕНЕСЕНО»)", ok: true }], moveRows: [], counts: { mainBefore: main.rows.length, moved: 0, mainAfter: main.rows.length } };
  }
  check("«Нові товари» у форматі NEW92 або підготовлені міграцією структури (позначка «ОЧІКУЄ ПЕРЕНЕСЕННЯ»)", isNew92 || isPending, qHeader.length);
  if (isQueue) check("немає рядків черги, уже перенесених без позначки «ПЕРЕНЕСЕНО» (незавершене попереднє перенесення)", !unmarkedInMain.length, unmarkedInMain.map((r) => t(r["Offer ID"])));
  if (expectCount != null) check(`рядків до перенесення рівно ${expectCount} (рішення власника)`, queueRows.length === Number(expectCount), queueRows.length);
  const deferred = book[SHEET.deferred] ? readSheet(book[SHEET.deferred], SHEET.deferred).rows : [];
  const deferredIds = new Set(deferred.map((r) => t(r["Offer ID"])));
  const groups = objectsFromValues(book[SHEET.groups], GROUP_HEADERS);
  const groupIds = new Set(groups.map((g) => t(g["Ідентифікатор_групи"])));
  const ids = queueRows.map((r) => t(r["Offer ID"]));
  const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
  const mainSupplier = new Set(main.rows.map((r) => t(r["ID постачальника"])));
  const sealBadNew = queueRows.filter((r) => rowSeal(r) !== t(r[SEAL_COLUMN])).map((r) => t(r["Offer ID"]));
  const sealBadMain = main.rows.filter((r) => rowSeal(r) !== t(r[SEAL_COLUMN])).map((r) => t(r["Offer ID"]));
  check("рядки NEW92 є", queueRows.length > 0, queueRows.length);
  check("усі рядки NEW92 «ДОЗВОЛЕНО»", queueRows.every((r) => r["Статус імпорту"] === "ДОЗВОЛЕНО"), queueRows.filter((r) => r["Статус імпорту"] !== "ДОЗВОЛЕНО").map((r) => t(r["Offer ID"])));
  check("печатки всіх рядків NEW92 цілі", sealBadNew.length === 0, sealBadNew);
  check("печатки основного каталогу цілі (зміни після QA — спершу QA-рішення)", sealBadMain.length === 0, sealBadMain);
  check("Offer ID NEW92 унікальні й лише цифри", dupIds.length === 0 && ids.every((x) => /^\d+$/.test(x)), dupIds);
  check("ID NEW92 не перетинаються з основним каталогом і відкладеними", ids.every((x) => !mainIds.has(x) && !deferredIds.has(x)), ids.filter((x) => mainIds.has(x) || deferredIds.has(x)));
  check("ID постачальника NEW92 не використовуються в основному каталозі", queueRows.every((r) => !mainSupplier.has(t(r["ID постачальника"]))), queueRows.filter((r) => mainSupplier.has(t(r["ID постачальника"]))).map((r) => t(r["Offer ID"])));
  check("групи NEW92 існують в аркуші «Групи»", queueRows.every((r) => groupIds.has(t(r["Група ID"]))), queueRows.filter((r) => !groupIds.has(t(r["Група ID"]))).map((r) => t(r["Offer ID"])));
  check("дата знімка LIVE відома (для позначки «відсутній у знімку»)", Boolean(t(snapshotDate)), t(snapshotDate));

  // Колонки основного каталогу після перенесення: наявні + колонки присутності (потрібні для позначки «відсутній у знімку»).
  const mainHeader = (book[SHEET.main][0] || []).map(t);
  const addMainColumns = PRESENCE_COLUMNS.filter((k) => !mainHeader.includes(k));
  const mainHeaderAfter = [...mainHeader, ...addMainColumns];
  const moveRows = queueRows.map((r) => targetRowOf(r, { mainHeaderAfter, stamp, snapshotDate }));
  const absentMarks = moveRows.filter((r) => r[PRESENCE_COLUMN]).map((r) => ({ offerId: t(r["Offer ID"]), presence: r[PRESENCE_COLUMN], meta: r[PRESENCE_META_COLUMN] }));
  const queueMarks = queueRows.map((r) => ({ offerId: t(r["Offer ID"]), expect: t(r["Перевірка"]), check: `${TRANSFER_MARK} ${stamp} (${decisionRef}; ${approvedBy}); рядок черги не видаляється до рішення B6` }));
  const passportAfter = approvalManifest([...main.rows, ...queueRows], groups);
  const ready = checks.every((c) => c.ok);
  return {
    state: ready ? "READY" : "PRECONDITION_FAILED", checks, moveRows, absentMarks, queueMarks,
    mainHeaderAfter, addMainColumns, queueHeaderAfter: QUEUE_HEADERS.slice(), queueColumnsAdded: QUEUE_HEADERS.filter((k) => !qHeader.includes(k)),
    passportAfter, counts: { mainBefore: main.rows.length, moved: queueRows.length, mainAfter: main.rows.length + queueRows.length, queueRowsKept: queueRows.length, queueOtherRows: allQueueRows.length - queueRows.length },
  };
}
