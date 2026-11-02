/** ENG-28: DRY-RUN міграції ТЕСТОВОЇ копії «Інструменти — ТЕСТ нової системи» — ЛИШЕ ЧИТАННЯ, жодного запису в Google Sheets.
 *
 *  Що рахує (доручення власника 01.11.2026, розд. 3–6):
 *   1. структура: колонки й аркуші, яких бракує новій системі (перенесення, перша «Оновити товари», аркуші на вимогу);
 *   2. перенесення NEW92 → «Основний каталог» (planTransferNew92): перевірки, точні зміни клітинок / рядків, паспорт;
 *   3. QA п'яти погоджених товарів (planQa): факти, причини, потрібні дії, блокери;
 *   4. блокери й умови виконання (актуальний повний фід, R-N3W — вікно без CAS, N4).
 *  Джерела:
 *   --source=xlsx --xlsx=<вигрузка копії>                — локальний файл, без мережі;
 *   --source=api                                          — Sheets API лише GET, токен mm-sheets-copy зі scope ЛИШЕ spreadsheets.readonly
 *                                                           (obtainToken + tokeninfo з tools/copy-access-check.mjs), ID — лише тестова копія.
 *  --decisions=<manifest.json зареєстрованих рішень власника> --out=<тека звіту поза репозиторієм>.
 *  Вивід у stdout — агрегати; список змін з Offer ID — лише у файл звіту. Коди: 0 — звіт сформовано; 2 — помилка читання / запобіжника. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readXlsx } from "./lib/xlsx-read.mjs";
import { mtText } from "../src/core/text.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { SHEET, CONTENT_COLUMNS, QUEUE_HEADERS, BINDINGS_SHEET } from "../src/core/sheet-sync.mjs";
import { OP_MAIN_COLUMNS } from "../src/core/owner-priority.mjs";
import { PRESENCE_COLUMNS } from "../src/core/supplier-presence.mjs";
import { WARN_SHEET, CLASSIFY_SHEET } from "../src/pipeline/supplier-warnings.mjs";
import { planTransferNew92 } from "../src/core/transfer-new92.mjs";
import { planQa } from "../src/core/qa-plan.mjs";
import { findLastSync } from "../src/verify/supplier-shadow.mjs";

const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
export const QA_IDS = Object.freeze(["1561514532", "2560360931", "2689669665", "2894494274", "3166947187"]);
const JOURNAL = "Журнал";
const t = (v) => mtText(v).trim();

/** Чистий розрахунок dry-run на книзі (values аркушів). */
export function dryRun({ book, sheetTitles, stamp, decisions = [], feed = { available: false, reason: "" }, qaIds = QA_IDS }) {
  const journal = book[JOURNAL] || [];
  const lastSync = findLastSync(journal);
  const snapshotDate = lastSync?.at || "";
  const mainHeader = (book[SHEET.main]?.[0] || []).map(t);
  const qHeader = (book[SHEET.queue]?.[0] || []).map(t);
  const transfer = planTransferNew92({ book, stamp, snapshotDate });
  const mainRows = readSheet(book[SHEET.main], SHEET.main).rows;
  const qa = planQa({ rows: mainRows, ids: qaIds, decisions, feed });
  const titles = sheetTitles || Object.keys(book);
  const changes = [];
  // Перенесення (запис transferNew92 після дозволу): точні зміни.
  if (transfer.addMainColumns?.length) changes.push({ step: "перенесення", sheet: SHEET.main, kind: "колонки", add: transfer.addMainColumns, at: `після колонки ${mainHeader.length}` });
  if (transfer.moveRows?.length) changes.push({ step: "перенесення", sheet: SHEET.main, kind: "рядки (за ключем Offer ID, без дублів)", count: transfer.moveRows.length, ids: transfer.moveRows.map((r) => t(r["Offer ID"])) });
  for (const m of transfer.absentMarks || []) changes.push({ step: "перенесення", sheet: SHEET.main, kind: "клітинки", offerId: m.offerId, set: { "Стан у постачальника": m.presence, "Знімок постачальника JSON": m.meta } });
  if (transfer.queueColumnsAdded?.length) changes.push({ step: "перенесення", sheet: SHEET.queue, kind: "заголовок (рядок 1)", add: transfer.queueColumnsAdded, before: qHeader.length, after: QUEUE_HEADERS.length });
  if (transfer.queueMarks?.length) changes.push({ step: "перенесення", sheet: SHEET.queue, kind: "клітинки «Перевірка» (рядки НЕ видаляються, B6)", count: transfer.queueMarks.length, example: transfer.queueMarks[0]?.check });
  if (transfer.passportAfter) changes.push({ step: "перенесення", sheet: SHEET.passport, kind: titles.includes(SHEET.passport) ? "оновлення" : "новий аркуш", passport: { count: transfer.passportAfter.count, idsSha: transfer.passportAfter.idsSha.slice(0, 12), contentSha: transfer.passportAfter.contentSha.slice(0, 12), groupsSha: transfer.passportAfter.groupsSha.slice(0, 12) } });
  changes.push({ step: "перенесення", sheet: JOURNAL, kind: "рядки", count: 1 + (transfer.absentMarks?.length || 0) });
  // Перша «Оновити товари» / синхронізація нової системи (окремий запуск і дозвіл): колонки, які вона додасть.
  const afterTransferMain = [...mainHeader, ...(transfer.addMainColumns || [])];
  const syncAdds = [...CONTENT_COLUMNS, ...OP_MAIN_COLUMNS, ...PRESENCE_COLUMNS].filter((k) => !afterTransferMain.includes(k));
  if (syncAdds.length) changes.push({ step: "перша «Оновити товари» (окремо)", sheet: SHEET.main, kind: "колонки", add: syncAdds });
  const onDemand = [BINDINGS_SHEET, WARN_SHEET, CLASSIFY_SHEET].filter((s) => !titles.includes(s));
  if (onDemand.length) changes.push({ step: "на вимогу (sync / intake)", kind: "нові аркуші", add: onDemand });
  const blockers = [];
  if (transfer.state === "PRECONDITION_FAILED") for (const c of transfer.checks.filter((x) => !x.ok)) blockers.push({ what: "перенесення: " + c.name, detail: c.detail });
  for (const x of qa.items.filter((i) => !i.applicable)) blockers.push({ what: "QA " + x.offerId, detail: x.blockers });
  if (!feed.available) blockers.push({ what: "актуальний повний YML постачальника", detail: feed.reason || "немає — старим знімком не підміняю" });
  blockers.push({ what: "R-N3W (Hermes): у Sheets API немає CAS", detail: "реальний запис — лише за окремим дозволом, поза вікном mtUpdate (:10–:35 UTC), тригери Apps Script вимкнено, власник не редагує таблицю" });
  return {
    snapshotDate, lastSyncOffers: lastSync?.offers ?? null,
    before: { sheets: titles.length, main: { rows: mainRows.length, columns: mainHeader.length }, queue: { rows: Math.max(0, (book[SHEET.queue]?.length || 1) - 1), columns: qHeader.length } },
    after: { main: { rows: transfer.counts?.mainAfter ?? mainRows.length, columns: afterTransferMain.length + syncAdds.length }, queue: { rows: transfer.counts?.queueRowsKept ?? 0, columns: QUEUE_HEADERS.length }, newSheets: [...(titles.includes(SHEET.passport) ? [] : [SHEET.passport]), ...onDemand] },
    transfer: { state: transfer.state, checks: transfer.checks, counts: transfer.counts, absentInSnapshot: (transfer.absentMarks || []).map((x) => x.offerId) },
    qa, changes, blockers,
  };
}

/** Зареєстровані рішення власника (manifest.json пакета) → [{ offerId, date, wrong }]. */
export function decisionsFrom(manifest) {
  return (manifest?.decisions || []).map((d) => ({ offerId: t(d.offerId), date: t(manifest.registeredAt).slice(0, 10), wrong: d.wrong || [] }));
}

async function loadBook(source) {
  if (source === "xlsx") {
    const file = arg("xlsx");
    if (!file) throw new Error("потрібен --xlsx=<вигрузка копії>");
    const book = readXlsx(file);
    return { book: Object.fromEntries(book.sheets.filter((s) => s.values).map((s) => [s.name, s.values])), titles: book.sheets.map((s) => s.name), via: "xlsx" };
  }
  // API — лише читання: токен readonly (tokeninfo), лише тестова копія, лише GET.
  const acc = await import("./copy-access-check.mjs");
  const { GoogleSheetsCatalogSource } = await import("../src/pipeline/google-sheets.mjs");
  const token = await acc.obtainToken();
  await acc.assertReadonlyToken(token);
  const src = new GoogleSheetsCatalogSource({ spreadsheetId: acc.TEST_SHEET_ID, getAccessToken: async () => token });
  const loaded = await src.load([SHEET.main, SHEET.queue, SHEET.deferred, SHEET.frozen]);
  const journal = await src.loadTail(JOURNAL, { until: (rows) => findLastSync(rows) !== null });
  const meta = await acc.checkCopy({ token }); // GET метаданих + запобіжники (scope, ID, назва «ТЕСТ»)
  return { book: { ...loaded.sheets, [SHEET.groups]: loaded.groups, [JOURNAL]: journal }, titles: meta.sheetTitles, via: "api (readonly)" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report;
  try {
    const { book, titles, via } = await loadBook(arg("source", "xlsx"));
    const manifest = arg("decisions") ? JSON.parse(fs.readFileSync(arg("decisions"), "utf8")) : null;
    report = { via, at: new Date().toISOString(), ...dryRun({ book, sheetTitles: titles, stamp: new Date().toISOString(), decisions: decisionsFrom(manifest), feed: { available: false, reason: arg("feed-reason", "актуального повного YML постачальника немає (локальні знімки 21–22.10); URL постачальника в середовищі відсутній") } }) };
  } catch (e) {
    process.stderr.write("ПОМИЛКА DRY-RUN: " + mtText(e?.message || e).replace(/ya29\.[A-Za-z0-9._-]+/g, "***") + "\n");
    process.exit(2);
  }
  if (arg("out")) { fs.mkdirSync(arg("out"), { recursive: true }); fs.writeFileSync(path.join(arg("out"), "migration-dry-run.json"), JSON.stringify(report, null, 1)); }
  const summary = { via: report.via, snapshotDate: report.snapshotDate, before: report.before, after: report.after, transfer: { state: report.transfer.state, failed: report.transfer.checks.filter((c) => !c.ok).map((c) => c.name), counts: report.transfer.counts }, qa: { applicable: report.qa.applicable.length, blocked: report.qa.blocked.length }, changes: report.changes.length, blockers: report.blockers.length };
  process.stdout.write(JSON.stringify(summary, null, 1) + "\n");
}
