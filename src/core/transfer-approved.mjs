/** ENG-29 — «Перенести затверджені» (кнопка; рішення власника 02.11.2026): план перенесення затверджених рядків черги «Нові товари»
 *  в «Основний каталог». Чиста функція: лише читання книги → перевірки + точний план. Запис — src/pipeline/transfer-approved.mjs.
 *
 *  Правила:
 *   • переносяться рядки з «Рішення» = «ЗАТВЕРДЖЕНО» / «ЗАТВЕРДЖЕНО (НЕ ДУБЛЬ)», які проходять ті самі перевірки, що й затвердження
 *     в синхронізації (approvalProblems: назви й описи UA / RU, фото, характеристики, група, категорія, валюта, запити, зіставлення,
 *     дубль), а також: ID не в «Заморожених ID», ID постачальника не зайнятий карткою, фільтр видалених Catalog Controls;
 *   • не пройшов — рядок лишається в черзі, у «Перевірці» — «НЕ ПЕРЕНЕСЕНО: …» з літерою колонки (напр. «не заповнено колонку E
 *     «Назва UA»»), у підсумку — Offer ID і причини;
 *   • рядок основного каталогу — як при штатному затвердженні (toMainRow, «ДОЗВОЛЕНО», код Prom = Offer ID, якщо порожній, стан полів);
 *   • рішення власника 02.11 (змінює B6): перенесені рядки ПРИБИРАЮТЬСЯ з «Нових товарів» — і щойно перенесені, і перенесені раніше
 *     (системна позначка «ПЕРЕНЕСЕНО…», Offer ID уже в каталозі). Видалення — лише за ключем зі знімком усього рядка (зміна → не видаляється);
 *   • рядки «ОЧІКУЄ ПЕРЕНЕСЕННЯ» (NEW92) — окремий режим merge; тут не чіпаються. */
import crypto from "node:crypto";
import { mtText } from "./text.mjs";
import { readSheet } from "./sync-plan.mjs";
import { rowSeal, SEAL_COLUMN, approvalManifest, GROUP_HEADERS } from "./seal.mjs";
import { objectsFromValues } from "./yml.mjs";
import { SHEET, QUEUE_HEADERS, MAIN_HEADERS, DECISION, PENDING_TRANSFER_MARK, approvalProblems, toMainRow, gateFor } from "./sheet-sync.mjs";
import { buildDupIndex, findDuplicates, rowEntry } from "./dup-check.mjs";
import { STATE_COLUMN, WARNING_MARK_COLUMN } from "./field-control.mjs";
import { stateCell, approvalState } from "./owner-priority.mjs";

export const TRANSFER_APPROVED_KEY = "state/transfer-approved/plan.json";
export const NOT_TRANSFERRED = "НЕ ПЕРЕНЕСЕНО: ";
const t = (v) => mtText(v).trim();
const norm = (v) => mtText(v).trim().toUpperCase().replace(/\s+/g, " ");
export const rowHash = (row, header) => crypto.createHash("sha256").update(JSON.stringify(header.map((k) => mtText(row?.[k] ?? "")))).digest("hex").slice(0, 32);

/** Номер колонки (0 — A) → літера як у Google Sheets (A … Z, AA …). */
export function columnLetter(i) {
  let n = i + 1, s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
/** Причина з approvalProblems → текст для власника з літерою колонки. */
export function withColumn(problem, header) {
  const p = String(problem);
  const empty = /^порожнє «([^»]+)»$/.exec(p);
  const at = (name) => { const i = header.indexOf(name); return i >= 0 ? `колонка ${columnLetter(i)} «${name}»` : `«${name}»`; };
  if (empty) return `не заповнено: ${at(empty[1])}`;
  return p.replace(/«([^»]+)»/, (m, name) => (header.includes(name) ? at(name) : m));
}
/** Системна позначка рядка черги, чий товар уже перенесено в основний каталог. */
export const isTransferredMark = (s) => t(s).startsWith("ПЕРЕНЕСЕНО");

/**
 * book: { [аркуш]: values } — основний каталог, черга, відкладені, заморожені, групи. cc — стан Catalog Controls (syncControlsState) або null.
 * → { state: READY | NOTHING | PRECONDITION_FAILED, moveRows, removeRows, notTransferred, marks, mainHeader, queueHeader, passportAfter, counts }
 */
export function planTransferApproved({ book, stamp, cc = null }) {
  const qv = book[SHEET.queue] || [[]];
  const queueHeader = (qv[0] || []).map(t);
  const mainHeader = (book[SHEET.main]?.[0] || []).map(t);
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); return ok; };
  check("«Нові товари» у форматі черги", QUEUE_HEADERS.every((k) => queueHeader.includes(k)), QUEUE_HEADERS.filter((k) => !queueHeader.includes(k)));
  check("«Основний каталог» має всі колонки картки", MAIN_HEADERS.every((k) => mainHeader.includes(k)), MAIN_HEADERS.filter((k) => !mainHeader.includes(k)));
  if (!checks.every((c) => c.ok)) return { state: "PRECONDITION_FAILED", checks };
  const main = readSheet(book[SHEET.main], SHEET.main), queue = readSheet(qv, SHEET.queue);
  const mainIdList = main.rows.map((r) => t(r["Offer ID"]));
  const dupMain = mainIdList.filter((x, i) => x && mainIdList.indexOf(x) !== i);
  if (!check("Offer ID «Основного каталогу» унікальні", dupMain.length === 0, [...new Set(dupMain)].slice(0, 20))) return { state: "PRECONDITION_FAILED", checks };
  const mainIds = new Set(mainIdList), mainSupplier = new Set(main.rows.map((r) => t(r["ID постачальника"])).filter(Boolean));
  const qIds = queue.rows.map((r) => t(r["Offer ID"]));
  const qDup = new Set(qIds.filter((x, i) => x && qIds.indexOf(x) !== i));
  const groups = objectsFromValues(book[SHEET.groups], GROUP_HEADERS);
  const groupsById = new Map(groups.map((g) => [t(g["Ідентифікатор_групи"]), { ua: t(g["Назва_групи_укр"]), ru: t(g["Назва_групи"]) }]));
  const groupIds = new Set(groupsById.keys());
  const frozenIds = new Set((book[SHEET.frozen] || []).slice(1).map((r) => t(r?.[0])).filter(Boolean));
  const deferred = book[SHEET.deferred]?.length ? readSheet(book[SHEET.deferred], SHEET.deferred).rows : [];
  const index = buildDupIndex([...main.rows.map((r) => rowEntry(r, SHEET.main)), ...queue.rows.map((r) => rowEntry(r, SHEET.queue)), ...deferred.map((r) => rowEntry(r, SHEET.deferred))]);

  const moveRows = [], removeRows = [], notTransferred = [], marks = [];
  for (const r of queue.rows) {
    const id = t(r["Offer ID"]), check0 = t(r["Перевірка"]), decision = norm(r["Рішення"]);
    if (!id || check0.startsWith(PENDING_TRANSFER_MARK)) continue;
    if (mainIds.has(id) && !moveRows.some((m) => t(m["Offer ID"]) === id)) {
      // Перенесено раніше (системна позначка) — рядок черги прибирається; без позначки — не чіпаємо (рішення людини).
      if (isTransferredMark(check0) && !qDup.has(id)) removeRows.push({ offerId: id, row: r, earlier: true });
      continue;
    }
    if (decision !== DECISION.APPROVE && decision !== DECISION.APPROVE_NOT_DUP) continue;
    const problems = [];
    if (!/^\d+$/.test(id)) problems.push("«Offer ID» — лише цифри");
    if (qDup.has(id)) problems.push("Offer ID повторюється в «Нових товарах» — залиште один рядок");
    if (frozenIds.has(id)) problems.push("ID у «Заморожених ID» (відхилено раніше) — потрібне окреме рішення власника");
    if (mainSupplier.has(t(r["ID постачальника"]))) problems.push("цей «ID постачальника» уже має картка в «Основному каталозі» (можливо, «ПРИВ'ЯЗАТИ ДО …»)");
    const g = cc ? gateFor(cc, { row: r }) : null;
    const cands = findDuplicates(index, rowEntry(r, SHEET.queue));
    const blocking = cands.some((c) => c.sheet === SHEET.main || c.level === "ЙМОВІРНО ТОЙ САМИЙ") || Boolean(g && !g.blocked);
    problems.push(...approvalProblems(r, { groupIds, mainIds, dupFlag: blocking }));
    if (g?.blocked) problems.unshift(g.reason);
    if (problems.length) {
      const texts = problems.map((p) => withColumn(p, queueHeader));
      notTransferred.push({ offerId: id, problems: texts });
      const next = NOT_TRANSFERRED + texts.join("; ");
      if (check0 !== next) marks.push({ offerId: id, expect: mtText(r["Перевірка"]), set: next });
      continue;
    }
    const mr = toMainRow(r, groupsById);
    const code = t(mr["Код товару Prom"]);
    if (!code || code === t(mr["Артикул постачальника"])) { mr["Код товару Prom"] = id; mr[SEAL_COLUMN] = rowSeal(mr); }
    if (mainHeader.includes(STATE_COLUMN)) { mr[STATE_COLUMN] = stateCell(approvalState(mr, stamp), mr); if (mainHeader.includes(WARNING_MARK_COLUMN)) mr[WARNING_MARK_COLUMN] = ""; }
    moveRows.push(mr);
    mainIds.add(id); mainSupplier.add(t(r["ID постачальника"]));
    removeRows.push({ offerId: id, row: r, earlier: false });
  }
  const passportAfter = approvalManifest([...main.rows, ...moveRows], groups);
  const counts = { mainBefore: main.rows.length, moved: moveRows.length, mainAfter: main.rows.length + moveRows.length, removeFromQueue: removeRows.length, removeEarlier: removeRows.filter((x) => x.earlier).length, notTransferred: notTransferred.length, queueBefore: queue.rows.length };
  const state = moveRows.length || removeRows.length || marks.length ? "READY" : "NOTHING";
  return { state, checks, moveRows, removeRows, notTransferred, marks, mainHeader, queueHeader, passportAfter, counts };
}

/** Контрольний план у сховищі W2 (до першого запису): усе, що потрібно для продовження після збою без нового планування. */
export function controlPlanOf(plan, { stamp, opId, events }) {
  return {
    v: 1, kind: "transfer-approved", opId, stamp, status: "PLANNED", createdAt: stamp,
    mainHeader: plan.mainHeader, queueHeader: plan.queueHeader,
    moveIds: plan.moveRows.map((r) => t(r["Offer ID"])),
    moveValues: plan.moveRows.map((r) => plan.mainHeader.map((k) => mtText(r[k] ?? ""))),
    // Лише відбиток рядка черги (план — у сховищі W2, без повних описів); знімок для видалення береться зі свіжого читання, якщо відбиток збігся.
    remove: plan.removeRows.map((x) => ({ offerId: x.offerId, earlier: x.earlier, hash: rowHash(x.row, plan.queueHeader) })),
    marks: plan.marks, notTransferred: plan.notTransferred, passportAfter: plan.passportAfter, counts: plan.counts, events,
  };
}
