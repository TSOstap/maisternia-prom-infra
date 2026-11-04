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
 *    --source=api  : MM_TEST_SHEET_ID (копія, «Редактор»), MM_SHEET_ID (жива — лише для заборони); токен: режими запису — лише
 *                    короткоживучий токен mm-sheets-copy (gcloud → generateAccessToken, scope spreadsheets, tokeninfo; ENG-28a),
 *                    режими читання — GOOGLE_OAUTH_ACCESS_TOKEN;
 *                    MM_SUPPLIER_FEED_URL (повний фід; операційний — з тими самими параметрами, що в LIVE)
 *    --source=xlsx : локальний сухий прогін у пам'яті: --xlsx=<книга> --supplier-file=<операційний XML> --supplier-full-file=<повний XML>
 *  Вивід — лише агрегати; захист від витоку як у C2-C (секрети, числа з 10+ цифр). Коди: 0 OK, 1 FAIL/ABORT/ROLLED_BACK, 2 читання, 3 витік.
 *  CC R6 / рішення власника 29.10: sync / intake / scenario — лише в режимі пріоритету власника з Catalog Controls (productionConfig);
 *  sync пише лише через шлюз запису (оренда + журнал + fencing; сховище W2 — MM_SAFE_WRITE_DIR, для --source=xlsx — у пам'яті).
 *  Модуля CC немає / стан недостовірний → нічого не записано (ABORTED, подія в «Журналі»). */
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
import { limitReady } from "../src/core/intake.mjs";
import { intakeSheet, transferNew92, syncSheet, refreshCopyFromLive, recordBlocked, feedBlock, SYNC_SHEETS, REFRESH_SHEETS } from "../src/pipeline/sheet-sync-run.mjs";
import { updateProductsRun } from "../src/pipeline/update-products.mjs";
import { migrateQueueForTransfer, applyOwnerCorrection } from "../src/pipeline/eng28a-steps.mjs";
import { qaProducts, QA_IDS_0111 } from "../src/pipeline/qa-products.mjs";
import { findNewProducts } from "../src/pipeline/find-new.mjs";
import { updatePrices } from "../src/pipeline/prices-run.mjs";
import { applyOwnerEdits } from "../src/pipeline/owner-edits.mjs";
import { addProsaleColumns, applyProsaleTariffs } from "../src/pipeline/prosale-columns.mjs";
import { addWarningHighlight } from "../src/pipeline/row-highlight.mjs";
import { archiveWarnings, clearShiftedArchiveRows } from "../src/pipeline/warnings-archive.mjs";
import { styleWarningSheets } from "../src/pipeline/sheet-style.mjs";
import { addGroup } from "../src/pipeline/groups-add.mjs";
import { transferApproved } from "../src/pipeline/transfer-approved.mjs";
import { resolveDeferred, dropDeferredSheet } from "../src/pipeline/deferred-resolve.mjs";
import { feedScopeOf } from "../src/core/supplier-presence.mjs";
import { assertWriteTarget, guardedSheets, writerAccessToken, MODE_POLICIES, TEST_SHEET_ID, LIVE_SHEET_ID } from "../src/pipeline/safe-write/write-target.mjs";
import { obtainToken, assertTokenScope, COPY_SA } from "./copy-access-check.mjs";
import { findLastSync } from "../src/verify/supplier-shadow.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { readXlsx } from "./lib/xlsx-read.mjs";
import { productionConfig, loadCatalogControls, runCatalogControls, runArchiveStep, w2Coordinator, CC_BOOK_SHEETS } from "../src/pipeline/production.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { FileStore, MemoryStore, RemoteStore } from "../src/pipeline/safe-write/store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const mode = arg("mode", "sync");
// ENG-28c (рішення власника 01.11: три незалежні операції — жодна неявно не запускає іншу):
//   merge     — «Перенести підготовлені товари» (NEW92 «ОЧІКУЄ ПЕРЕНЕСЕННЯ» → «Основний каталог»);
//   find-new  — «Знайти нові товари» (лише «Нові товари» + «Журнал»; src/pipeline/find-new.mjs);
//   update    — «Оновити товари» (основний каталог: ціни, наявність, зміни постачальника; без новинок і без черги);
//   prices    — «Оновити ціни й наявність» (операційний фід; лише 8 колонок LIVE змінених рядків + «Журнал»; src/pipeline/prices-run.mjs);
//   qa        — QA погоджених товарів (лише їхні рядки; src/pipeline/qa-products.mjs). sync / intake — застарілі комбіновані режими.
//   reconcile — ENG-28d: з'ясування невідомих результатів записів W2 (лише читання таблиці; пише лише журнал операцій W2); рішення
//               людини щодо NEEDS_DECISION — лише явно: --decide=<opId> --note="пояснення".
//   transfer  — ENG-29: «Перенести затверджені» (кнопка): затверджені рядки черги → «Основний каталог», перенесені прибираються з черги
//               (src/pipeline/transfer-approved.mjs; план у сховищі W2, продовження після збою — той самий режим).
//   deferred  — ENG-29: розбір «Відкладених товарів» (рішення власника 03.11): у фіді — в «Основний каталог», немає — у «Видалені товари»;
//               --plan-only — лише план.
//   drop-deferred — ENG-29: прибрати порожню вкладку «Відкладені товари» (лише 0 рядків даних; --maintenance, оренда W2).
const WRITE_MODES = ["sync", "intake", "scenario", "scenario-mass", "controls", "archive", "merge", "refresh", "recover", "update", "structure", "correction", "qa", "find-new", "reconcile", "transfer", "deferred", "drop-deferred", "prices", "owner-edits", "prosale-columns", "prosale-tariffs", "row-highlight", "warnings-archive", "sheet-style", "warnings-archive-fix", "group-add"];
/** ENG-28c (М1): межа HTTP-запитів записувача на запуск. Типово 40 (GoogleSheetsWriter); «Оновити товари» / sync — 120: перший повний
 *  прохід пріоритету власника на 5 121 рядках потребує ≈ 45 запитів (з М2; без М2 — ≈ 69), темп записувача ≤ 50 запитів/хв (квота
 *  Google — 60 запитів запису / хв на користувача проєкту). Перед першим записом — оцінка (budgetCheck): більше за межу → нічого не пишемо. */
const WRITE_BUDGETS = Object.freeze({ update: 120, sync: 120, scenario: 120, refresh: 150 });
// ENG-24 (E8): recover — запуск CC mode "recover" (cc-recovery-v1) лише після окремого дозволу власника й установленої межі епох
// (tools/recover.mjs authorize / establish-floor); без них CC повертає RECOVERY_PENDING і нічого не пише.
// ENG-18 (Hermes ENG16-N2): КОЖЕН режим, що пише через API, — лише з допуском W2 (однохостовий координатор). merge / refresh —
// обслуговування копії: додатково явний --maintenance і оренда W2 на весь час операції (виключення з усіма записувачами).
// ENG-28a: structure / correction — разові кроки контрольованої міграції: теж лише з --maintenance і орендою W2 (виключення).
const MAINTENANCE_MODES = ["merge", "refresh", "drop-deferred", "structure", "correction", "owner-edits", "prosale-columns", "prosale-tariffs", "row-highlight", "sheet-style", "warnings-archive-fix", "group-add"];
// archive — перенесення за дорученнями CC (moves) і завершення видалень за активними фідами (--feed-store).
// controls — запуск Catalog Controls (CC R7 G3): тінь типово; --apply — застосування (лише активований CC, готовність, W2).
// ENG-29: невідомий режим — відмова (раніше потрапляв у гілку sync). Усі режими CLI пишуть, тож перелік — WRITE_MODES.
if (!WRITE_MODES.includes(mode)) { process.stderr.write(`НЕВІДОМИЙ РЕЖИМ: «${String(mode).slice(0, 40)}» — можна: ${WRITE_MODES.join(", ")}; нічого не записано\n`); process.exit(2); }
const config0 = JSON.parse(await fsp.readFile(path.join(root, "config", "default.json"), "utf8"));
const config = WRITE_MODES.includes(mode) ? productionConfig(config0) : config0;
const source = arg("source", "api");
const started = Date.now();

// ---------- захист від витоку ----------
const secrets = new Set();
const addSecret = (v) => { const s = v == null ? "" : String(v); if (s.length >= 8) secrets.add(s); };
for (const k of ["MM_SHEET_ID", "MM_TEST_SHEET_ID", "GOOGLE_OAUTH_ACCESS_TOKEN", "MM_WATCH_KEY", "MM_W2_KEY"]) addSecret(process.env[k]);
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

// ---------- допуск W2 — ДО будь-якого доступу до таблиці ----------
let w2Admission = null;
if (WRITE_MODES.includes(mode) && source === "api") {
  try { w2Admission = w2Coordinator(); } catch (e) { fail("НЕМАЄ КООРДИНАТОРА ЗАПИСУ (W2): ", e); }
  if (MAINTENANCE_MODES.includes(mode) && !process.argv.includes("--maintenance")) fail("ОБСЛУГОВУВАННЯ: ", new Error(`режим ${mode} пише в таблицю поза шлюзом — лише з явним --maintenance (і орендою W2)`));
}

// ---------- таблиця ----------
let sheets, readBook, readLive, readHeaders = null, journalTail = null;
const readStats = { calls: 0, ms: 0, sheets: {}, reader: null }; // ENG-29: розбивка часу (читання таблиці)
try {
  if (source === "api") {
    if (!process.env.MM_TEST_SHEET_ID) throw new Error("немає MM_TEST_SHEET_ID");
    // ENG-28a: ціль запису — лише TEST (жорстко в коді); LIVE — завжди BLOCK; MM_SHEET_ID має бути саме відомою живою таблицею.
    if (WRITE_MODES.includes(mode)) assertWriteTarget(process.env.MM_TEST_SHEET_ID);
    if (process.env.MM_SHEET_ID && process.env.MM_SHEET_ID !== LIVE_SHEET_ID) throw new Error("MM_SHEET_ID не збігається з відомою живою таблицею — відмова");
    // Режими запису — лише короткоживучий токен mm-sheets-copy (scope spreadsheets, tokeninfo); GOOGLE_OAUTH_ACCESS_TOKEN — лише читання.
    // ENG-29 (сервер): у GitHub Actions — той самий шлях: gcloud (облікові дані WIF ops.yml) → generateAccessToken mm-sheets-copy.
    const getAccessToken = WRITE_MODES.includes(mode) ? await writerAccessToken({ obtain: obtainToken, scopeOf: assertTokenScope, account: COPY_SA }) : envAccessToken();
    sheets = new GoogleSheetsWriter({ spreadsheetId: process.env.MM_TEST_SHEET_ID, liveSpreadsheetId: process.env.MM_SHEET_ID || LIVE_SHEET_ID, getAccessToken }); // кидає, якщо ID = живої
    if (WRITE_BUDGETS[mode]) sheets.maxRequests = WRITE_BUDGETS[mode];
    // ENG-28d (перший запуск у TEST 02.11): «Журнал» TEST ≈ 50 тис. рядків × 26 колонок ≈ 81 запит на одне повне читання, а QA /
    // перенесення читають його кілька разів («Журнал» за ключем «ID події»). Окремий читач на кожне читання мав власні межу 60 і
    // темп 50 / хв — разом вони перевищували квоту Google (60 читань / хв на користувача: HTTP 429). Тому — ОДИН читач на процес:
    // спільний темп ≤ 40 / хв (запас для мета-запитів записувача) і спільна межа 1000 запитів на запуск. Лише читання.
    // ENG-29: порції великих аркушів — за розміром відповіді (≈ 4 МБ, як порція основного каталогу), не за клітинками.
    const testReader = new GoogleSheetsCatalogSource({ spreadsheetId: process.env.MM_TEST_SHEET_ID, getAccessToken, maxRequests: 1000, maxRequestsPerMinute: 40, targetBytes: 4_000_000 });
    readStats.reader = testReader;
    // ENG-29: охоронцю цілі потрібні лише заголовки — один запит замість повного читання аркушів.
    readHeaders = async (names) => { testReader.metaCache = null; const t0 = Date.now(); const v = await testReader.loadHeaders(names); readStats.ms += Date.now() - t0; return v; };
    readBook = async (names) => {
      testReader.metaCache = null; // свіжі розміри аркушів щоразу (після дописування / нових колонок / аркушів); спільні лише темп і межа
      const t0 = Date.now(); // ENG-29: розбивка часу операції (для розкладу перед імпортом Prom)
      readStats.reader ??= testReader;
      const loaded = await testReader.load(names);
      readStats.calls++; readStats.ms += Date.now() - t0;
      for (const n of names || []) readStats.sheets[n] = (readStats.sheets[n] || 0) + 1;
      return { ...loaded.sheets, [SHEET.groups]: loaded.groups };
    };
    // Жива таблиця — ЛИШЕ читання (службовий акаунт там «Читач»); потрібна тільки для режиму refresh.
    readLive = async (names) => {
      const src = new GoogleSheetsCatalogSource({ spreadsheetId: process.env.MM_SHEET_ID || "", getAccessToken });
      const loaded = await src.load(names);
      return { ...loaded.sheets, [SHEET.groups]: loaded.groups };
    };
    if (mode !== "merge" && mode !== "refresh") {
      testReader.metaCache = null;
      const tj = Date.now();
      journalTail = await testReader.loadTail(SHEET.journal, { until: (rows) => findLastSync(rows) !== null });
      readStats.tailMs = Date.now() - tj;
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

// ENG-28c (М1): бюджет запитів запису для попередньої оцінки — з самого записувача (до обгортки охоронця).
const writer = sheets;
const writeBudget = WRITE_MODES.includes(mode) ? { maxRequests: writer?.maxRequests ?? 40, used: () => Number(writer?.metrics?.requests ?? 0), maxChunkChars: writer?.maxChunkChars ?? 2_000_000 } : null;
// ENG-28c: активований контракт Catalog Controls (окремий погоджений власником файл поза репозиторієм; шар Catalog не змінюється).
const ccContract = arg("cc-contract") ? { contractFile: arg("cc-contract") } : {};
// ENG-28a: кожна операція запису — через охоронця цілі за політикою режиму (аркуші / операції / колонки; видалення рядків — BLOCK).
if (WRITE_MODES.includes(mode)) {
  try {
    const policy = MODE_POLICIES[mode];
    if (!policy) throw new Error("немає політики запису для режиму " + mode);
    const need = Object.entries(policy).filter(([t, p]) => t !== "*" && (Array.isArray(p.columns) || p.clearOnly?.length || p.deny?.length)).map(([t]) => t);
    const hb = need.length ? await (readHeaders || readBook)(need) : {};
    sheets = guardedSheets(sheets, { spreadsheetId: source === "api" ? process.env.MM_TEST_SHEET_ID : TEST_SHEET_ID, policy, headers: Object.fromEntries(need.map((t) => [t, hb[t]?.[0] || []])) });
  } catch (e) { fail("ОХОРОНА ЦІЛІ ЗАПИСУ: ", e); }
}
const NOW = source === "xlsx" && arg("now") ? Date.parse(arg("now")) : Date.now(); // --now лише для локального сухого прогону
// Сховище W2 (оренди, журнал операцій, контрольна точка CC): робоча копія — лише постійний каталог поза репозиторієм.
let w2Store = null, controls = null;
if (WRITE_MODES.includes(mode)) {
  // W2 (не обходиться): координатора між машинами немає — лише явний однохостовий режим із постійним сховищем; інакше відмова.
  // ENG-29: спільне сховище W2 у Durable Object (MM_W2_MODE=do) — одна черга записувачів для сервера й локальних запусків.
  w2Store = source !== "api" ? new MemoryStore() : w2Admission.kind === "durable-object" ? new RemoteStore({ url: w2Admission.url, key: w2Admission.key }) : new FileStore(w2Admission.dir);
  controls = await loadCatalogControls({ loadBook: () => readBook(CC_BOOK_SHEETS), store: w2Store, config, ...ccContract });
}
const stamp = new Date(NOW).toISOString();
const report = { mode, source, at: stamp, result: null, metrics: {} };
/** Обслуговування (merge / refresh): оренда W2 на весь час операції — жоден інший записувач (CC, sync, intake, публікація) не діє. */
async function underMaintenanceLease(fn) {
  const lease = await new WriteGateway({ sheets, read: readBook, store: w2Store }).committer.acquire("maintenance");
  try { return await fn(); } finally { await lease.release().catch(() => {}); }
}
/** ENG-18 (знахідка ENG18-N2): подія «ОНОВЛЕННЯ ЗАБЛОКОВАНО» (пошкоджений / неповний фід) — теж лише через сесію шлюзу W2
 *  (оренда, журнал операцій, fencing). Шлюз зайнятий / не READY → подію не записано (причина — у звіті запуску). */
async function recordBlockedW2(stamp, block) {
  let session;
  try { session = await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "feed-block" }); }
  catch (e) { return { journalWritten: false, journalError: "шлюз запису: " + String(e?.message || e).slice(0, 180) }; }
  try { return session.state === "READY" ? await recordBlocked(session.sheets, stamp, block) : { journalWritten: false, journalError: "шлюз запису: " + session.state }; }
  finally { await session.close?.().catch(() => {}); }
}
try {
  if (mode === "merge") {
    // ENG-28: перенесення NEW92 — B6-сумісне (рядки черги НЕ видаляються; основний каталог — за ключем; паспорт) через шлюз W2.
    // Старий mergeNew92 (видаляв рядки черги) — лише для синтетичних тестів. Дата знімка LIVE — явно (позначка «відсутній у знімку»).
    if (!arg("snapshot-date")) fail("merge: ", new Error("потрібен --snapshot-date=<дата останнього оновлення LIVE> (для позначки «відсутній у знімку»)"));
    const session = await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "sync" });
    try { report.result = await transferNew92({ sheets, readBook, stamp, snapshotDate: arg("snapshot-date"), session, approvedBy: arg("by", "власник"), decisionRef: arg("note", "доручення власника 01.11.2026"), expectCount: Number(arg("expect-new92", "92")) }); }
    finally { await session.close?.().catch(() => {}); }
  } else if (mode === "owner-edits") {
    // Рішення власника 03.11: точкові правки власника за планом (--plan=<файл поза репозиторієм>) під орендою обслуговування W2.
    if (!arg("plan")) fail("owner-edits: ", new Error("потрібен --plan=<план правок власника>"));
    const edits = JSON.parse(fs.readFileSync(arg("plan"), "utf8"));
    report.result = await underMaintenanceLease(() => applyOwnerEdits({ sheets, readBook, stamp, edits }));
  } else if (mode === "prosale-columns") {
    // Рішення власника 04.11 (ProSale): дві колонки в кінці «Основного каталогу», під орендою обслуговування W2.
    report.result = await underMaintenanceLease(() => addProsaleColumns({ sheets, readBook, stamp }));
  } else if (mode === "prosale-tariffs") {
    // Рішення власника 04.11: «Тарифи ProSale» — лише «за замовлення» + тарифи за планом (--plan={"set":{"<ID>":"Турбо"}}).
    if (!arg("plan")) fail("prosale-tariffs: ", new Error("потрібен --plan=<файл із set>"));
    const p = JSON.parse(fs.readFileSync(arg("plan"), "utf8"));
    report.result = await underMaintenanceLease(() => applyProsaleTariffs({ sheets, readBook, stamp, set: p.set || {}, orderOnly: p.orderOnly !== false }));
  } else if (mode === "warnings-archive") {
    // Рішення власника 04.11: опрацьовані попередження → «Попередження — архів» (порціями по 40), «Що змінилось» для відкритих.
    const session = await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "sync" });
    try {
      if (session.state !== "READY") report.result = { state: "BLOCKED", reason: "шлюз запису: " + session.state };
      else {
        const runs = [];
        for (let k = 0; k < 20; k++) { const r = await archiveWarnings({ session, readBook, stamp }); runs.push(r); if (r.state !== "WARNINGS_ARCHIVED" || !r.resolvedLeft || session.state !== "READY") break; }
        const last = runs[runs.length - 1];
        report.result = { state: last.state === "INCOMPLETE" ? "INCOMPLETE" : "WARNINGS_ARCHIVED", archived: runs.reduce((a, r) => a + (r.archived || 0), 0), summarized: runs.reduce((a, r) => a + (r.summarized || 0), 0), conflicts: runs.reduce((a, r) => a + (r.conflicts || 0), 0), open: last.open, resolvedLeft: last.resolvedLeft, runs: runs.length, reason: last.reason || "" };
      }
    } finally { await session.close?.().catch(() => {}); }
  } else if (mode === "warnings-archive-fix") {
    report.result = await underMaintenanceLease(() => clearShiftedArchiveRows({ sheets, readBook, stamp }));
  } else if (mode === "group-add") {
    if (!arg("plan")) fail("group-add: ", new Error("потрібен --plan={id, ua, ru, parent}"));
    const group = JSON.parse(fs.readFileSync(arg("plan"), "utf8"));
    report.result = await underMaintenanceLease(() => addGroup({ sheets, readBook, stamp, group }));
  } else if (mode === "sheet-style") {
    report.result = await underMaintenanceLease(() => styleWarningSheets({ sheets, readBook, stamp }));
  } else if (mode === "row-highlight") {
    report.result = await underMaintenanceLease(() => addWarningHighlight({ sheets, readBook, stamp }));
  } else if (mode === "drop-deferred") {
    report.result = await underMaintenanceLease(() => dropDeferredSheet({ sheets, readBook, stamp }));
  } else if (mode === "transfer") {
    // ENG-29: «Перенести затверджені» — сесія «sync» (оренда + журнал + fencing); політика охоронця MODE_POLICIES.transfer.
    const session = await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "sync" });
    try { report.result = await transferApproved({ readBook, stamp, session, controls, config }); }
    finally { await session.close?.().catch(() => {}); }
  } else if (mode === "structure") {
    // ENG-28a, крок 1: «Нові товари» → заголовок черги + «ОЧІКУЄ ПЕРЕНЕСЕННЯ» (рядки не видаляються; sync / intake їх не змінюють).
    report.result = await underMaintenanceLease(() => migrateQueueForTransfer({ sheets, readBook, stamp }));
  } else if (mode === "correction") {
    // ENG-28a, крок 3: разове виправлення 1561514532 (лише 4 поля, погоджені заміни); --expected=<план dry-run, погоджений власником>.
    if (!arg("expected")) fail("correction: ", new Error("потрібен --expected=<план dry-run>, погоджений власником"));
    const expected = JSON.parse(fs.readFileSync(arg("expected"), "utf8"));
    report.result = await underMaintenanceLease(() => applyOwnerCorrection({ sheets, readBook, stamp, expected }));
  } else if (mode === "update" || mode === "qa" || mode === "find-new" || mode === "deferred") {
    // ENG-28: ПОВНИЙ сирий фід постачальника (MM_SUPPLIER_FEED_URL або --supplier-full-file). Адреса — лише секрет у пам'яті;
    // охоплення (group_ids тощо) визначається з адреси. Локальний файл адреси не має: охоплення задає --feed-scope=full|filtered
    // (типово filtered — невідоме джерело не доводить повноти, «видалений у постачальника» з нього не ставиться).
    const full = source === "api" ? process.env.MM_SUPPLIER_FEED_URL || "" : arg("supplier-full-file", "");
    if (source === "api") addUrlSecrets(full);
    const scopeSource = source === "api" ? full : arg("feed-scope", "filtered") === "full" ? "https://local.invalid/feed.xml" : "https://local.invalid/feed.xml?group_ids=local";
    const tf = Date.now();
    let fullXml;
    if (source === "api") { const c = []; for await (const x of new HttpSupplierSource(full, { timeoutMs: 180000, maxBytes: 300_000_000 }).chunks()) c.push(x); fullXml = Buffer.concat(c).toString("utf8"); }
    else fullXml = fs.readFileSync(full, "utf8");
    report.metrics.supplierFetchMs = Date.now() - tf;
    if (mode === "deferred") {
      // ENG-29: розбір «Відкладених товарів» — сесія «sync»; --plan-only — без сесії й без записів.
      const planOnly = process.argv.includes("--plan-only");
      const session = planOnly ? null : await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "sync" });
      try { report.result = await resolveDeferred({ readBook, xml: fullXml, stamp, session, config, planOnly }); }
      finally { await session?.close?.().catch(() => {}); }
    } else if (mode === "update") {
      // ENG-28c: «Оновити товари» — лише основний каталог (сесія «sync»); новинки — окремою командою --mode=find-new.
      if (process.argv.includes("--intake")) fail("update: ", new Error("новинки в чергу додає лише окрема команда --mode=find-new"));
      const openSession = (writer) => new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer });
      report.result = await updateProductsRun({ sheets, readBook, xml: fullXml, source: scopeSource, fetchedAt: stamp, stamp, now: NOW, config, profile: config.intake?.profile || "medium", controls, snapshotStore: w2Store, openSession, writeBudget });
      // Рішення власника 04.11: опрацьовані попередження (у т. ч. щойно виконані «Прийняти…») → архів.
      const ws = await openSession("sync").catch(() => null);
      try { if (ws?.state === "READY") report.result.warningsArchive = await archiveWarnings({ session: ws, readBook, stamp }).catch((e) => ({ state: "ERROR", reason: String(e?.message || e).slice(0, 200) })); }
      finally { await ws?.close?.().catch(() => {}); }
    } else if (mode === "qa") {
      // ENG-28c: QA погоджених товарів — лише їхні рядки; --expected=<план dry-run, погоджений власником> обов'язковий для запису.
      const ids = arg("ids") ? arg("ids").split(",").map((x) => x.trim()).filter(Boolean) : QA_IDS_0111.slice();
      const planOnly = process.argv.includes("--plan-only");
      if (source === "api" && !planOnly && !arg("expected")) fail("qa: ", new Error("потрібен --expected=<план QA dry-run>, погоджений власником"));
      const expected = arg("expected") ? JSON.parse(fs.readFileSync(arg("expected"), "utf8")) : null;
      const session = planOnly ? null : await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "sync" });
      try { report.result = await qaProducts({ sheets, readBook, xml: fullXml, source: scopeSource, fetchedAt: stamp, stamp, now: NOW, config, controls, snapshotStore: w2Store, session, ids, expected, planOnly }); }
      finally { await session?.close?.().catch(() => {}); }
      if (arg("plan-out") && report.result?.qaPlan) fs.writeFileSync(arg("plan-out"), JSON.stringify(report.result.qaPlan, null, 1));
    } else {
      // ENG-28c: «Знайти нові товари» — лише черга (сесія «intake»); основний каталог не змінюється (політика режиму цього не дозволяє).
      const session = await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "intake" });
      try { report.result = await findNewProducts({ sheets, readBook, xml: fullXml, source: scopeSource, fetchedAt: stamp, stamp, now: NOW, config, profile: config.intake?.profile || "medium", controls, snapshotStore: w2Store, session }); }
      finally { await session.close?.().catch(() => {}); }
    }
  } else if (mode === "prices") {
    // ENG-29 (рішення власника 03.11): «Оновити ціни й наявність» — ОПЕРАЦІЙНИЙ фід (ціни / наявність, без описів і фото), лише 8 колонок
    // LIVE «Основного каталогу» змінених рядків (сесія «sync», за ключем) і «Журнал». Решту даних постачальника — «Оновити товари».
    const full = source === "api" ? process.env.MM_SUPPLIER_FEED_URL || "" : "";
    let xml;
    const tf = Date.now();
    if (source === "api") {
      const op = operationalUrl(full, config.supplier);
      addUrlSecrets(full); addUrlSecrets(op);
      const c = []; for await (const x of new HttpSupplierSource(op, { timeoutMs: 180000, maxBytes: config.supplier.maximumChars * 2 }).chunks()) c.push(x);
      xml = Buffer.concat(c).toString("utf8");
    } else xml = fs.readFileSync(arg("supplier-file"), "utf8");
    report.metrics.supplierFetchMs = Date.now() - tf;
    const session = await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "sync" });
    // Вузьке читання (лише потрібні колонки) — лише для Sheets API; локальна книга читається цілою.
    const readColumns = readStats.reader ? async (title, columns) => { readStats.reader.metaCache = null; const t0 = Date.now(); const v = await readStats.reader.loadColumns(title, columns); readStats.ms += Date.now() - t0; readStats.sheets[title + " (колонки)"] = (readStats.sheets[title + " (колонки)"] || 0) + 1; return v; } : null;
    try {
      report.result = await updatePrices({ readBook, xml, stamp, now: NOW, config, controls, session, snapshotStore: w2Store, readColumns });
      if (session.state === "READY") report.result.warningsArchive = await archiveWarnings({ session, readBook, stamp }).catch((e) => ({ state: "ERROR", reason: String(e?.message || e).slice(0, 200) }));
    } finally { await session.close?.().catch(() => {}); }
  } else if (mode === "reconcile") {
    // ENG-28d: невідомий результат API → наступні записи BLOCKED, доки reconcile не з'ясує стан читанням за ключем (із вікном settle);
    // сліпого повтору немає. Таблиця лише читається (політика режиму: жодної операції запису).
    const session = await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "sync" });
    try {
      const results = session.state === "RECONCILE_REQUIRED" ? await session.reconcile() : [];
      if (arg("decide")) { if (!arg("note")) fail("reconcile: ", new Error("рішення людини потребує --note=<пояснення>")); await session.decide(arg("decide"), arg("note")); }
      report.result = { state: session.state === "READY" ? "RECONCILED" : session.state, results, unresolved: session.unresolved?.length || 0, blocking: (session.blocking || []).map((b) => ({ opId: b.opId, phase: b.phase, kind: b.kind, detail: b.detail })) };
    } finally { await session.close?.().catch(() => {}); }
  } else if (mode === "controls") {
    // CC R7 G3: команди власника виконує CC; readiness / integrity / publication / контракт — з робочої композиції.
    const gateway = new WriteGateway({ sheets, read: readBook, store: w2Store });
    const feedStore = arg("feed-store") ? new LocalObjectStore(arg("feed-store")) : null;
    report.result = await runCatalogControls({ sheets, readBook, gateway, config, stamp, mode: process.argv.includes("--apply") ? "apply" : "shadow", feedStore, ...ccContract });
  } else if (mode === "recover") {
    if (!arg("feed-store")) fail("recover: ", new Error("потрібен --feed-store (дзеркало реєстру й стан відновлення)"));
    const gateway = new WriteGateway({ sheets, read: readBook, store: w2Store });
    report.result = await runCatalogControls({ sheets, readBook, gateway, config, stamp, mode: "recover", feedStore: new LocalObjectStore(arg("feed-store")) });
  } else if (mode === "archive") {
    const feedStore = arg("feed-store") ? new LocalObjectStore(arg("feed-store")) : null;
    report.result = await runArchiveStep({ readBook, gateway: new WriteGateway({ sheets, read: readBook, store: w2Store }), controls, stamp, feedStore, config });
  } else if (mode === "refresh") {
    if (source === "api") sheets.maxRequests = 150; // основний каталог (~50 МБ) пишеться порціями ~2 МБ
    report.result = await underMaintenanceLease(() => refreshCopyFromLive({ sheets, readCopy: readBook, readLive, expectNew92: Number(arg("expect-new92", 92)) }));
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
      report.result = { state: "ABORTED", reason: block.reason, block, ...(await recordBlockedW2(stamp, block)) };
      throw Object.assign(new Error("BLOCKED"), { blocked: true });
    }
    const last = findLastSync(journalTail);
    // Повнота/свіжість фіду — як LIVE mtValidateFeed: несправний фід → нічого не пишемо.
    try { validateFeed(parsed, last?.offers, NOW, config.supplier); }
    catch (e) {
      const block = feedBlock(e.message, { count: parsed.count, minimum: Math.max(config.supplier.minimumOffers, Math.round(Number(last?.offers || 0) * config.supplier.dropRatio)), maxAgeHours: config.supplier.maximumAgeHours });
      report.result = { state: "ABORTED", reason: block.reason, block, ...(await recordBlockedW2(stamp, block)) };
    }
    if (!report.result) {
      const fetchFull = report.fetchFull;
      if (mode === "intake") {
        const list = await readyList();
        if (!list) report.result = { state: "SKIPPED", reason: "немає списку кандидатів (Worker не налаштовано) — новинки лишаються кандидатами" };
        else {
          // Контрольований тест: MM_INTAKE_LIMIT (вхід workflow «intake_limit», лише число) — передати не більше N кандидатів.
          const ready = limitReady(list.ready || [], process.env.MM_INTAKE_LIMIT || 0);
          report.intakeInput = { offeredByWatch: (list.ready || []).length, passed: ready.length, limit: Number(process.env.MM_INTAKE_LIMIT || 0) };
          // ENG-18 (I06): черга — лише через сесію шлюзу W2 (оренда, журнал, fencing).
          const session = await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "intake" });
          const feedScope = source === "api" ? (feedScopeOf(operationalUrl(process.env.MM_SUPPLIER_FEED_URL || "", config.supplier)).scope === "full" ? "full" : "filtered") : arg("feed-scope", "full");
          try { report.result = await intakeSheet({ sheets, readBook, parsed, fetchFull, stamp, config, now: NOW, ready, profile: list.profile || config.intake?.profile || "medium", controls, session, feedScope }); }
          finally { await session.close?.().catch(() => {}); }
        }
      } else {
        // W2 / S1: робочий запис — лише через шлюз (оренда, журнал операцій, fencing перед кожним записом, звірка UNKNOWN).
        // ENG-28c (Catalog R7.4.2, спостереження 2): охоплення операційного фіду — з його адреси (group_ids тощо → «filtered»: товар
        // поза фільтром не стає «немає в наявності» і не рахується у зниклих); локальний файл — --feed-scope (типово full, як раніше).
        const feedScope = source === "api" ? (feedScopeOf(operationalUrl(process.env.MM_SUPPLIER_FEED_URL || "", config.supplier)).scope === "full" ? "full" : "filtered") : arg("feed-scope", "full");
        const session = await new WriteGateway({ sheets, read: readBook, store: w2Store }).open({ writer: "sync" });
        try { report.result = await syncSheet({ sheets, readBook, parsed, fetchFull, stamp, config, now: NOW, profile: config.intake?.profile || "medium", feedScope, writeBudget, session, controls }); }
        finally { await session.close?.().catch(() => {}); }
      }
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
// ENG-29: де йде час — читання таблиці (кількість читань / мс / аркуші), запити до читача Google, сховище W2.
report.metrics.read = { calls: readStats.calls, ms: readStats.ms, tailMs: readStats.tailMs ?? null, requests: readStats.reader?.metrics?.requests ?? null, sheets: readStats.sheets };
report.metrics.w2 = w2Store?.stats ? { ...w2Store.stats } : null;
report.metrics.sheetsRequests = sheets?.metrics?.requests ?? null;
report.metrics.sheetsWrites = sheets?.metrics?.writes ?? null;
report.metrics.maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
if (report.result?.error) report.result.error = scrub(report.result.error);
if (report.result?.reason) report.result.reason = scrub(report.result.reason);
// ENG-28c: повний звіт (з Offer ID змінених товарів) — лише в локальний файл оператора (--report-file, поза репозиторієм); секрети
// (адреса фіду, ID таблиць, токени) туди теж не потрапляють — та сама перевірка, що й для виводу. У вивід — копія з маскованими
// довгими числами (раніше будь-який Offer ID у результаті блокував увесь вивід після вже виконаного запису).
if (arg("report-file")) {
  const full = JSON.stringify(report, null, 2);
  if ([...secrets].some((s) => full.includes(s))) { process.stderr.write("ЗАХИСТ ВІД ВИТОКУ: звіт-файл не записано\n"); process.exitCode = 3; }
  else fs.writeFileSync(arg("report-file"), full);
}
emit(JSON.stringify(report, null, 2).replace(/\d{10,}/g, "#ID"));

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
process.exitCode = process.exitCode === 3 ? 3 : mode === "scenario-mass" ? (report.result?.state === "ABORTED" ? 0 : 1) : ["MERGED", "TRANSFERRED", "MIGRATED", "CORRECTED", "NOTHING", "NO_CHANGES", "SYNCED", "REFRESHED", "INTAKE_DONE", "NOTHING_TO_WRITE", "SKIPPED", "SHADOW", "COMMITTED", "ARCHIVED", "RECOVERED", "QA_DONE", "PLANNED", "NOTHING_NEW", "WAITING_STABILITY", "NOTHING_COMPLETE", "RECONCILED", "JOURNAL_RECOVERED", "RUN_PLAN_ABANDONED", "DEFERRED_RESOLVED", "SHEET_REMOVED", "PRICES_UPDATED", "OWNER_EDITS_APPLIED", "PROSALE_COLUMNS_ADDED", "PROSALE_TARIFFS_SET", "HIGHLIGHT_ADDED", "WARNINGS_ARCHIVED", "STYLED", "SHIFTED_CLEARED", "GROUP_ADDED"].includes(report.result?.state) ? 0 : 1;
