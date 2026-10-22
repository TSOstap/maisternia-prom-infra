/** Етап S1: запис нової системи в ТЕСТОВУ КОПІЮ таблиці (варіант A). Жива таблиця — лише ID для захисту, запис у неї заборонено.
 *
 *  Режими (--mode):
 *    merge     — одноразово: NEW92 («Нові товари») → «Основний каталог»; «Нові товари» → черга; «Паспорт каталогу»
 *    sync      — ціни/наявність, нові позиції в черзі, рішення власника, паспорт, журнал (майбутній запуск кожні 4 год)
 *    refresh   — освіжити ТЕСТОВУ КОПІЮ з ЖИВОЇ таблиці (жива — лише читання; перевірка печаток, «Код товару Prom» NEW92)
 *    scenario  — як sync, але XML навмисно змінено: ціна одного товару, наявність другого, зникнення третього,
 *                четвертий — «той самий товар під новим (тестовим) ID» (лише копія, лише в пам'яті запуску)
 *    scenario-mass — помилковий фід «усе немає в наявності»: очікується ABORTED, нічого не записано
 *    intake    — лише черга: додати кандидатів, стабільність яких підтвердив «Сторож новинок» (Worker), і оновити сирі дані
 *                позицій черги (варіант А). Список кандидатів — з Worker (MM_WATCH_URL + MM_WATCH_KEY, GET /intake) або
 *                локально --ready-file. ID кандидатів у вивід / журнали GitHub НЕ потрапляють — лише кількості.
 *  Після sync / intake звіт (база відомих ID, відбитки черги, результати) надсилається у Worker (POST /ack), якщо його
 *  налаштовано; локально — --ack-file=<шлях поза репозиторієм>.
 *  Джерела:
 *    --source=api  : MM_TEST_SHEET_ID (копія, «Редактор»), MM_SHEET_ID (жива — лише для заборони), GOOGLE_OAUTH_ACCESS_TOKEN,
 *                    MM_SUPPLIER_FEED_URL (повний фід; операційний — з тими самими параметрами, що в LIVE)
 *    --source=xlsx : локальний сухий прогін у пам'яті: --xlsx=<книга> --supplier-file=<операційний XML> --supplier-full-file=<повний XML>
 *  Вивід — лише агрегати; захист від витоку як у C2-C (секрети, числа з 10+ цифр). Коди: 0 OK, 1 FAIL/ABORT/ROLLED_BACK, 2 читання, 3 витік. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleSheetsCatalogSource, envAccessToken } from "../src/pipeline/google-sheets.mjs";
import { HttpSupplierSource } from "../src/pipeline/sources.mjs";
import { GoogleSheetsWriter, MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { operationalUrl, parseSupplierText, validateFeed } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { sanitize, mtText, sha256 } from "../src/core/text.mjs";
import { SHEET, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { intakeSheet, mergeNew92, syncSheet, refreshCopyFromLive, recordBlocked, feedBlock, SYNC_SHEETS, REFRESH_SHEETS } from "../src/pipeline/sheet-sync-run.mjs";
import { findLastSync } from "../src/verify/supplier-shadow.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { readXlsx } from "./lib/xlsx-read.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const config = JSON.parse(await fsp.readFile(path.join(root, "config", "default.json"), "utf8"));
const mode = arg("mode", "sync");
const source = arg("source", "api");
const started = Date.now();

// ---------- захист від витоку ----------
const secrets = new Set();
const addSecret = (v) => { const s = v == null ? "" : String(v); if (s.length >= 8) secrets.add(s); };
for (const k of ["MM_SHEET_ID", "MM_TEST_SHEET_ID", "GOOGLE_OAUTH_ACCESS_TOKEN", "MM_WATCH_KEY"]) addSecret(process.env[k]);
const addUrlSecrets = (raw) => { addSecret(raw); try { const u = new URL(raw); addSecret(u.search.slice(1)); addSecret(u.host + u.pathname + u.search); for (const [, v] of u.searchParams) { addSecret(v); addSecret(encodeURIComponent(v)); } } catch { /* */ } };
if (process.env.MM_SUPPLIER_FEED_URL) addUrlSecrets(process.env.MM_SUPPLIER_FEED_URL);
if (process.env.MM_WATCH_URL) addUrlSecrets(process.env.MM_WATCH_URL);

// ---------- «Сторож новинок» (Worker) ----------
const watchConfigured = () => Boolean(process.env.MM_WATCH_URL && process.env.MM_WATCH_KEY);
async function watchCall(pathname, init = {}) {
  const res = await fetch(new URL(pathname, process.env.MM_WATCH_URL), { ...init, redirect: "error", headers: { authorization: "Bearer " + process.env.MM_WATCH_KEY, "content-type": "application/json", ...(init.headers || {}) } });
  if (!res.ok) throw new Error("Worker HTTP " + res.status);
  return res.json();
}
async function readyList() {
  if (arg("ready-file")) return JSON.parse(fs.readFileSync(arg("ready-file"), "utf8"));
  if (!watchConfigured()) return null;
  return watchCall("/intake");
}
/** Звіт у Worker: лише туди (за ключем); у вивід — тільки «так / ні». */
async function sendAck(ack) {
  if (!ack) return "немає звіту";
  if (arg("ack-file")) { fs.writeFileSync(arg("ack-file"), JSON.stringify(ack)); return "у файл"; }
  if (!watchConfigured()) return "не налаштовано (MM_WATCH_URL / MM_WATCH_KEY)";
  try { await watchCall("/ack", { method: "POST", body: JSON.stringify(ack) }); return "так"; }
  catch (e) { return "ні: " + scrub(e); }
}
const scrub = (e) => sanitize(e?.message || e).replace(/\d{6,}/g, "***");
function emit(text) {
  if ([...secrets].some((s) => text.includes(s)) || /\d{10,}/.test(text)) { process.stderr.write("ЗАХИСТ ВІД ВИТОКУ: вивід заблоковано\n"); process.exit(3); }
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}
const fail = (prefix, e) => { process.stderr.write(prefix + scrub(e) + "\n"); process.exit(2); };

// ---------- таблиця ----------
let sheets, readBook, readLive, journalTail = null;
try {
  if (source === "api") {
    if (!process.env.MM_TEST_SHEET_ID) throw new Error("немає MM_TEST_SHEET_ID");
    const getAccessToken = envAccessToken();
    sheets = new GoogleSheetsWriter({ spreadsheetId: process.env.MM_TEST_SHEET_ID, liveSpreadsheetId: process.env.MM_SHEET_ID, getAccessToken }); // кидає, якщо ID = живої
    readBook = async (names) => {
      const src = new GoogleSheetsCatalogSource({ spreadsheetId: process.env.MM_TEST_SHEET_ID, getAccessToken });
      const loaded = await src.load(names);
      return { ...loaded.sheets, [SHEET.groups]: loaded.groups };
    };
    // Жива таблиця — ЛИШЕ читання (службовий акаунт там «Читач»); потрібна тільки для режиму refresh.
    readLive = async (names) => {
      const src = new GoogleSheetsCatalogSource({ spreadsheetId: process.env.MM_SHEET_ID || "", getAccessToken });
      const loaded = await src.load(names);
      return { ...loaded.sheets, [SHEET.groups]: loaded.groups };
    };
    if (mode !== "merge" && mode !== "refresh") {
      const src = new GoogleSheetsCatalogSource({ spreadsheetId: process.env.MM_TEST_SHEET_ID, getAccessToken });
      journalTail = await src.loadTail(SHEET.journal, { until: (rows) => findLastSync(rows) !== null });
    }
  } else {
    const all = [...SYNC_SHEETS, SHEET.groups, SHEET.journal];
    const book = Object.fromEntries(readXlsx(arg("xlsx"), { only: all }).sheets.filter((s) => s.values).map((s) => [s.name, s.values]));
    journalTail = book[SHEET.journal];
    book[SHEET.journal] = [book[SHEET.journal]?.[0] || ["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]];
    const liveBook = structuredClone(book); // локально «жива» таблиця = книга xlsx
    readLive = async () => structuredClone(liveBook);
    if (arg("state")) Object.assign(book, JSON.parse(fs.readFileSync(arg("state"), "utf8"))); // стан після попереднього локального прогону
    sheets = new MemorySheets(book);
    readBook = async () => structuredClone(book);
  }
} catch (e) { fail("ПОМИЛКА ДОСТУПУ ДО ТАБЛИЦІ: ", e); }

const NOW = source === "xlsx" && arg("now") ? Date.parse(arg("now")) : Date.now(); // --now лише для локального сухого прогону
const stamp = new Date(NOW).toISOString();
const report = { mode, source, at: stamp, result: null, metrics: {} };
try {
  if (mode === "merge") {
    report.result = await mergeNew92({ sheets, readBook, stamp });
  } else if (mode === "refresh") {
    if (source === "api") sheets.maxRequests = 150; // основний каталог (~50 МБ) пишеться порціями ~2 МБ
    report.result = await refreshCopyFromLive({ sheets, readCopy: readBook, readLive, expectNew92: Number(arg("expect-new92", 92)) });
  } else {
    // Фід постачальника: операційний (ціни/наявність — як LIVE) і, лише за потреби, повний (контент нових позицій).
    let xml, fullXml = null;
    const tf = Date.now();
    if (source === "api") {
      const full = process.env.MM_SUPPLIER_FEED_URL || "";
      const op = operationalUrl(full, config.supplier);
      addUrlSecrets(op);
      const get = async (url, maxBytes) => { const c = []; for await (const x of new HttpSupplierSource(url, { timeoutMs: 180000, maxBytes }).chunks()) c.push(x); return Buffer.concat(c).toString("utf8"); };
      xml = await get(op, config.supplier.maximumChars * 2);
      report.fetchFull = async (ids) => { fullXml ??= await get(full, 300_000_000); return extractFullOffers(fullXml, ids); };
    } else {
      xml = fs.readFileSync(arg("supplier-file"), "utf8");
      report.fetchFull = async (ids) => { fullXml ??= fs.readFileSync(arg("supplier-full-file"), "utf8"); return extractFullOffers(fullXml, ids); };
    }
    report.metrics.supplierFetchMs = Date.now() - tf;
    if (mode === "scenario") {
      // Детерміновано обрані 4 товари основного каталогу (за SHA ID, без виводу ID); лише в копії й лише в пам'яті запуску.
      const book = await readBook([SHEET.main]);
      const ids = readSheet(book[SHEET.main], SHEET.main).rows.map((r) => mtText(r["ID постачальника"])).sort((a, b) => sha256(a).localeCompare(sha256(b))).slice(0, 4);
      const pre = await parseSupplierText(xml, { maximumChars: config.supplier.maximumChars });
      const [a, b, c, d] = ids;
      // «Той самий товар під новим ID»: блок товару d зникає зі старим ID і з'являється з тестовим ID (у т.ч. в повному XML — з фото).
      const fakeId = "99" + d.slice(-8);
      const reissue = (text) => {
        const m = new RegExp(String.raw`<offer\b[^>]*\bid="` + d + String.raw`"[^>]*>[\s\S]*?</offer>`).exec(text);
        return m ? text.replace(m[0], m[0].replace(`id="${d}"`, `id="${fakeId}"`).replace(`/p${d}-`, `/p${fakeId}-`)) : text;
      };
      xml = reissue(xml);
      const baseFetch = report.fetchFull;
      report.fetchFull = async (want) => { const m = await baseFetch([...want, d]); if (m.has(d) && want.includes(fakeId)) m.set(fakeId, m.get(d)); return m; };
      if (pre.offers.get(a)) xml = perturb.tag(xml, a, "price", String(Math.round((pre.offers.get(a).price + 100) * 100) / 100));
      if (pre.offers.get(b)) xml = xml.replace(new RegExp(`(<offer\\b[^>]*\\bid="${b}"[^>]*\\bavailable=")(true|false)`), (_, p, v) => p + (v === "true" ? "false" : "true"));
      xml = perturb.drop(xml, [c]);
      report.scenario = { priceUp100: Boolean(pre.offers.get(a)), availabilityFlipped: Boolean(pre.offers.get(b)), dropped: 1, reissuedUnderTestId: Boolean(pre.offers.get(d)) };
    }
    if (mode === "scenario-mass") {
      // Помилковий фід: усі товари «немає в наявності». Очікується ABORTED — нічого не записано.
      xml = xml.replace(/(<offer\b[^>]*\bavailable=")true"/g, '$1false"');
      report.scenario = { allUnavailable: true, expected: "ABORTED" };
    }
    let parsed;
    try { parsed = await parseSupplierText(xml, { maximumChars: config.supplier.maximumChars, identityFields: true }); }
    catch (e) {
      // Пошкоджений XML: нічого не оновлюємо; лише подія в «Журналі» (причина лишається і в журналі GitHub).
      const block = feedBlock("розбір: " + e.message);
      report.result = { state: "ABORTED", reason: block.reason, block, ...(await recordBlocked(sheets, stamp, block)) };
      throw Object.assign(new Error("BLOCKED"), { blocked: true });
    }
    const last = findLastSync(journalTail);
    // Повнота/свіжість фіду — як LIVE mtValidateFeed: несправний фід → нічого не пишемо.
    try { validateFeed(parsed, last?.offers, NOW, config.supplier); }
    catch (e) {
      const block = feedBlock(e.message, { count: parsed.count, minimum: Math.max(config.supplier.minimumOffers, Math.round(Number(last?.offers || 0) * config.supplier.dropRatio)), maxAgeHours: config.supplier.maximumAgeHours });
      report.result = { state: "ABORTED", reason: block.reason, block, ...(await recordBlocked(sheets, stamp, block)) };
    }
    if (!report.result) {
      const fetchFull = report.fetchFull;
      if (mode === "intake") {
        const list = await readyList();
        if (!list) report.result = { state: "SKIPPED", reason: "немає списку кандидатів (Worker не налаштовано) — новинки лишаються кандидатами" };
        else report.result = await intakeSheet({ sheets, readBook, parsed, fetchFull, stamp, config, now: NOW, ready: list.ready || [], profile: list.profile || config.intake?.profile || "medium" });
      } else report.result = await syncSheet({ sheets, readBook, parsed, fetchFull, stamp, config, now: NOW, profile: config.intake?.profile || "medium" });
      // Звіт для Worker містить ID — у вивід не потрапляє.
      if (report.result?.ack !== undefined) { report.ackSent = await sendAck(report.result.ack); delete report.result.ack; }
    }
    delete report.fetchFull;
    report.feed = { offers: parsed.count };
  }
} catch (e) {
  if (!e?.blocked) report.result = { state: "ERROR", error: scrub(e) };
}
delete report.fetchFull;
if (source === "xlsx" && arg("save-state")) fs.writeFileSync(arg("save-state"), JSON.stringify(sheets.book)); // лише локальний файл поза репозиторієм
report.metrics.totalMs = Date.now() - started;
report.metrics.sheetsRequests = sheets?.metrics?.requests ?? null;
report.metrics.sheetsWrites = sheets?.metrics?.writes ?? null;
report.metrics.maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
if (report.result?.error) report.result.error = scrub(report.result.error);
if (report.result?.reason) report.result.reason = scrub(report.result.reason);
emit(JSON.stringify(report, null, 2));

if (arg("summary")) {
  const r = report.result || {};
  const lines = [
    `### S1 (тестова копія таблиці): ${mode} — ${r.state}`,
    "",
    r.reason ? `Причина: ${r.reason}` : "",
    r.block ? `Блокування: ${r.block.type}; зачеплено ${r.block.affected ?? "—"}; поріг ${r.block.limit ?? "—"}; запис у «Журнал»: ${r.journalWritten ? "так" : "НІ — причина лише тут"}` : "",
    r.error ? `Помилка: ${r.error}` : "",
    r.stats?.before ? `До запуску: основний каталог ${r.stats.before.mainRows} (унікальних ID ${r.stats.before.uniqueIds}, паспорт ${r.stats.before.passportCount}); у черзі ${r.stats.before.queueRows}` : "",
    r.stats?.results ? `Intake: кандидатів ${r.stats.ready}; ${Object.entries(r.stats.results).map(([k, v]) => `${k} — ${v}`).join(", ") || "—"}; додано в чергу ${r.stats.added}; можливих дублів ${r.stats.possibleDuplicates}` : "",
    r.stats?.queueRaw ? `Сирі дані черги: оновлено ${r.stats.queueRaw.changed}, потребують повторної перевірки ${r.stats.queueRaw.recheck}, «ПЕРЕВІРЕНО» ${r.stats.queueRaw.verified}, нових колонок ${r.stats.queueRaw.migratedColumns}` : "",
    report.ackSent ? `Звіт «Сторожу новинок»: ${report.ackSent}` : "",
    r.stats?.mainCountAfter !== undefined ? `Основний каталог: ${r.stats.mainCountAfter} товарів; змінено клітинок цін/наявності: ${r.stats.main?.changedCells}; черга: додано ${r.stats.added}, затверджено ${r.stats.approved}, відхилено ${r.stats.rejected}, можливих дублів ${r.stats.queue?.possibleDuplicates}` : "",
    r.stats?.main?.supplierPriceChanged !== undefined ? `Змінено: ціна постачальника — ${r.stats.main.supplierPriceChanged}, ціна продажу — ${r.stats.main.salePriceChanged}, наявність — ${r.stats.main.availabilityChanged} (стали в наявності ${r.stats.main.becameAvailable}, зникли з наявності ${r.stats.main.becameUnavailable}), кількість — ${r.stats.main.quantityChanged}; відсутніх у фіді ${r.stats.main.missingInFeed}` : "",
    r.count ? `Перенесено NEW92: ${r.moved}; основний каталог: ${r.count}` : "",
    r.actions ? `Освіження копії: ${Object.entries(r.actions).map(([k, v]) => `${k} — ${v}`).join("; ")}` : "",
    r.checks ? `Перевірки: ${r.checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("; ")}` : "",
    r.warnings?.length ? `Попередження: ${r.warnings.join("; ")}` : "",
    r.verify ? `Перевірка після запису: ${Object.entries(r.verify).map(([k, v]) => `${k}=${v}`).join(", ")}` : "",
    r.restore ? `Відновлено: ${r.restore.join(", ")}` : "",
    `Час: ${report.metrics.totalMs} мс; запитів запису Sheets: ${report.metrics.sheetsRequests ?? "—"}`,
  ].filter(Boolean).join("\n") + "\n";
  if ([...secrets].some((x) => lines.includes(x)) || /\d{10,}/.test(lines)) { process.stderr.write("ЗАХИСТ ВІД ВИТОКУ: summary не записано\n"); process.exit(3); }
  fs.appendFileSync(arg("summary"), lines);
}
process.exitCode = mode === "scenario-mass" ? (report.result?.state === "ABORTED" ? 0 : 1) : ["MERGED", "SYNCED", "REFRESHED", "INTAKE_DONE", "NOTHING_TO_WRITE", "SKIPPED"].includes(report.result?.state) ? 0 : 1;
