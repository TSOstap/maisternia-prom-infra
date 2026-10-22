/** Етап S1: застосування плану до таблиці (лише ТЕСТОВА КОПІЯ) з перевіркою після запису й поверненням попередніх значень.
 *  sheets   — GoogleSheetsWriter | MemorySheets (src/pipeline/sheets-writer.mjs)
 *  readBook — async (назви) => { [назва]: values2D } — свіже читання таблиці (для перевірки після запису). */
import { mtText } from "../core/text.mjs";
import { LIVE_COLUMNS, readSheet } from "../core/sync-plan.mjs";
import { YML_HEADERS, SEAL_COLUMN, approvalManifest, rowSeal } from "../core/seal.mjs";
import { objectsFromValues } from "../core/yml.mjs";
import { GROUP_HEADERS } from "../core/seal.mjs";
import { SHEET, QUEUE_HEADERS, PASSPORT_HEADER, BINDINGS_SHEET, BINDINGS_HEADERS, finalizeSheetSync, passportValues, planSheetSync, readPassport, samePassport } from "../core/sheet-sync.mjs";

export const SYNC_SHEETS = [SHEET.main, SHEET.queue, SHEET.deferred, SHEET.frozen, SHEET.passport, BINDINGS_SHEET];
const rowsEqual = (a, b) => a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((v, j) => mtText(v) === mtText(b[i][j])));
const pad = (r, n) => Array.from({ length: n }, (_, i) => (r[i] == null ? "" : r[i]));
const groupsOf = (book) => objectsFromValues(book[SHEET.groups], GROUP_HEADERS);
const JOURNAL_CHUNK = 2000;

async function appendJournal(sheets, entries) {
  for (let i = 0; i < entries.length; i += JOURNAL_CHUNK) await sheets.appendRows(SHEET.journal, entries.slice(i, i + JOURNAL_CHUNK).map((e) => e.map((v) => (typeof v === "string" && /^[=+\-@]/.test(v) ? "'" + v : v))));
}

/** Переписує дані аркуша (рядки 2..) на `values`: оновлення наявних рядків, дописування нових, видалення зайвих. */
async function rewriteData(sheets, title, oldCount, values) {
  const common = Math.min(oldCount, values.length);
  if (common) await sheets.updateRanges([{ title, row: 2, col: 1, values: values.slice(0, common) }]);
  if (values.length > oldCount) await sheets.appendRows(title, values.slice(oldCount));
  if (values.length < oldCount) await sheets.deleteRows(title, Array.from({ length: oldCount - values.length }, (_, i) => values.length + 2 + i));
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

/** Синхронізація (як майбутній запуск кожні 4 год): ціни/наявність, черга нових, рішення власника, паспорт, журнал. */
export async function syncSheet({ sheets, readBook, parsed, fetchFull, stamp, config, now }) {
  const book = await readBook(SYNC_SHEETS);
  const groupsRows = groupsOf(book);
  const plan = planSheetSync({ book, parsed, stamp, config, now, groupsRows });
  if (plan.abort) return { state: "ABORTED", reason: plan.abort };
  const full = plan.newIds.length ? await fetchFull(plan.newIds) : new Map();
  const fin = finalizeSheetSync(plan, { parsed, fullById: full, stamp, config, groupsRows, journalSummary: {} });

  // Таблицю редагували під час запуску? Тоді черга не чіпається (лише ціни основного каталогу).
  const fresh = await readBook([SHEET.queue]);
  const queueChanged = !rowsEqual(fresh[SHEET.queue], book[SHEET.queue]);
  // Ціни вже пораховано з урахуванням прив'язок/скасувань: якщо чергу змінили під час запуску, а такі рішення є — нічого не пишемо.
  if (queueChanged && plan.main.changedRows.size) return { state: "SKIPPED_CONCURRENT_EDIT", reason: "чергу змінено під час запуску, а в ній є прив'язки/скасування — нічого не записано, повтор наступного запуску" };
  const mainHeader = readSheet(book[SHEET.main], SHEET.main).header;
  const approve = queueChanged ? [] : plan.queue.approve;
  const reject = queueChanged ? [] : plan.queue.reject;
  const passportAfter = queueChanged ? plan.passportBefore : fin.passportAfter;
  const journal = queueChanged ? fin.journal.filter((e) => e[1] === SHEET.main && e[3] !== "ЗАТВЕРДЖЕНО" || e[1] === "СИСТЕМА") : fin.journal;

  const before = {
    mainOps: plan.main.plan.map((p) => p.before), queue: book[SHEET.queue].map((r) => r.slice()), mainLen: plan.main.rows.length,
    frozenLen: Math.max(0, (book[SHEET.frozen] || []).length), passport: book[SHEET.passport].map((r) => r.slice()),
    mainRowsFull: book[SHEET.main].map((r) => r.slice()), historyLen: (book[BINDINGS_SHEET] || [[]]).length, history: (book[BINDINGS_SHEET] || []).map((r) => r.slice()),
  };
  const changedRows = queueChanged ? [] : [...plan.main.changedRows];
  const fullRows = changedRows.map((i) => ({ title: SHEET.main, row: i + 2, col: 1, values: [mainHeader.map((k, j) => (LIVE_COLUMNS.includes(k) ? plan.main.plan[i].next[LIVE_COLUMNS.indexOf(k)] : plan.main.rows[i][k] ?? ""))] }));
  const history = queueChanged ? [] : plan.bindings.history;
  const undoCells = queueChanged ? [] : plan.bindings.undoCells;
  const stateCol = BINDINGS_HEADERS.indexOf("Стан") + 1;
  const done = new Set();
  const opsBlock = { title: SHEET.main, row: 2, col: plan.main.start + 1, values: plan.main.plan.map((p) => p.next) };
  try {
    await sheets.updateRanges([opsBlock]); done.add("mainOps");
    // Прив'язки/скасування змінюють і незмінні колонки картки — повний рядок (печатку перераховано).
    if (fullRows.length) { await sheets.updateRanges(fullRows); done.add("fullRows"); }
    if (history.length || undoCells.length) {
      await sheets.ensureSheet(BINDINGS_SHEET, BINDINGS_HEADERS.slice());
      if (history.length) { await sheets.appendRows(BINDINGS_SHEET, history); done.add("history"); }
      if (undoCells.length) { await sheets.updateRanges(undoCells.map((c) => ({ title: BINDINGS_SHEET, row: c.row, col: stateCol, values: [[c.state]] }))); done.add("undoCells"); }
    }
    if (approve.length) { await sheets.appendRows(SHEET.main, approve.map((r) => mainHeader.map((k) => r[k] ?? ""))); done.add("approve"); }
    if (!queueChanged) { await rewriteData(sheets, SHEET.queue, before.queue.length - 1, fin.queueValues); done.add("queue"); }
    if (reject.length) { await sheets.appendRows(SHEET.frozen, reject.map((r) => [mtText(r["Offer ID"])])); done.add("frozen"); }
    if (!samePassport(passportAfter, plan.passportBefore)) {
      await sheets.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: passportValues(passportAfter, `затверджено ${approve.length}`, stamp) }]);
      done.add("passport");
    }

    // Перевірка після запису
    const after = await readBook(SYNC_SHEETS);
    const m2 = readSheet(after[SHEET.main], SHEET.main);
    const opsOk = plan.main.plan.every((p, i) => LIVE_COLUMNS.every((k, j) => mtText(m2.rows[i][k]) === mtText(p.next[j])));
    const verify = {
      mainCount: m2.rows.length, expectedCount: passportAfter.count, opsWritten: opsOk,
      sealsIntact: m2.rows.every((r) => rowSeal(r) === mtText(r[SEAL_COLUMN])),
      passportOk: samePassport(approvalManifest(m2.rows, groupsRows), passportAfter) && samePassport(readPassport(after[SHEET.passport]), passportAfter),
      bindingsOk: changedRows.every((i) => mtText(m2.rows[i]["ID постачальника"]) === mtText(plan.main.rows[i]["ID постачальника"])),
      queueOk: queueChanged || rowsEqual(after[SHEET.queue].slice(1).filter((r) => r.some((v) => v !== "" && v != null)).map((r) => pad(r, fin.queueValues[0]?.length || QUEUE_HEADERS.length)), fin.queueValues),
    };
    if (!(verify.mainCount === verify.expectedCount && verify.opsWritten && verify.sealsIntact && verify.passportOk && verify.queueOk && verify.bindingsOk)) throw Object.assign(new Error("перевірка після запису не пройдена"), { verify });
    await appendJournal(sheets, journal);
    return {
      state: "SYNCED", queueChanged, verify, stats: { ...plan.stats, approved: approve.length, rejected: reject.length, added: queueChanged ? 0 : fin.newRows.length, possibleDuplicates: queueChanged ? 0 : fin.possibleDuplicates, bound: queueChanged ? 0 : plan.bindings.done, bindRefused: plan.bindings.refused, unbound: queueChanged ? 0 : plan.bindings.undone, mainCountAfter: verify.mainCount },
      warnings: plan.warnings, frozenSimilar: plan.frozenSimilar, journalEntries: journal.length,
    };
  } catch (e) {
    const restore = [];
    try {
      if (done.has("mainOps")) { await sheets.updateRanges([{ ...opsBlock, values: before.mainOps }]); restore.push("ціни/наявність"); }
      if (done.has("fullRows")) { await sheets.updateRanges(changedRows.map((i) => ({ title: SHEET.main, row: i + 2, col: 1, values: [before.mainRowsFull[i + 1]] }))); restore.push("прив'язані картки"); }
      if (done.has("history")) { await sheets.deleteRows(BINDINGS_SHEET, history.map((_, k) => before.historyLen + 1 + k)); restore.push("історія прив'язок"); }
      if (done.has("undoCells")) { await sheets.updateRanges(undoCells.map((c) => ({ title: BINDINGS_SHEET, row: c.row, col: stateCol, values: [[before.history[c.row - 1]?.[stateCol - 1] ?? ""]] }))); restore.push("стан скасувань"); }
      if (done.has("approve")) { await sheets.deleteRows(SHEET.main, approve.map((_, i) => before.mainLen + 2 + i)); restore.push("перенесені рядки"); }
      if (done.has("queue")) {
        const now2 = await readBook([SHEET.queue]);
        await rewriteData(sheets, SHEET.queue, now2[SHEET.queue].length - 1, before.queue.slice(1).map((r) => pad(r, QUEUE_HEADERS.length)));
        restore.push("черга");
      }
      if (done.has("frozen")) { await sheets.deleteRows(SHEET.frozen, reject.map((_, i) => before.frozenLen + 1 + i)); restore.push("заморожені"); }
      if (done.has("passport")) { await sheets.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: before.passport }]); restore.push("паспорт"); }
      await appendJournal(sheets, [[stamp, "СИСТЕМА", "", "ПОМИЛКА", "", "", "нова система (S1): " + e.message + "; відновлено: " + restore.join(", ")]]);
    } catch (re) { restore.push("ПОМИЛКА ВІДНОВЛЕННЯ: " + re.message); }
    return { state: "ROLLED_BACK", error: e.message, verify: e.verify, restore };
  }
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
