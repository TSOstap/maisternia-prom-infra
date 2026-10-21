/** Етап C2-C: shadow-звірка з живим фідом постачальника. Лише читання; у stdout/summary — тільки агрегати.
 *
 *  У GitHub Actions:
 *    MM_SHEET_ID=… GOOGLE_OAUTH_ACCESS_TOKEN=… MM_SUPPLIER_FEED_URL=… \
 *      node tools/supplier-shadow.mjs --source=api --supplier=env --scenarios --summary="$GITHUB_STEP_SUMMARY" --tmp="$RUNNER_TEMP"
 *  Локально (історичні/синтетичні дані, без мережі):
 *    node tools/supplier-shadow.mjs --source=xlsx --xlsx=<книга> --supplier-file=<xml> [--scenarios]
 *    node tools/supplier-shadow.mjs --source=snapshot --catalog=<каталог NDJSON> --supplier-file=<xml> [--config=…] [--expected=…]
 *
 *  Захист від витоку: перед виведенням увесь звіт перевіряється на фрагменти секретів (адреса постачальника,
 *  hash_tag, операційна адреса, ID таблиці). Збіг → нічого не друкується, код 3.
 *  Коди: 0 — PASS; 1 — є FAIL; 2 — помилка читання/доступу; 3 — спрацював захист від витоку; 4 — висновок неможливий (немає синхронізованого знімка). */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleSheetsCatalogSource, envAccessToken } from "../src/pipeline/google-sheets.mjs";
import { HttpSupplierSource, NdjsonCatalogSource } from "../src/pipeline/sources.mjs";
import { operationalUrl, parseSupplierText, validateFeed } from "../src/core/supplier-feed.mjs";
import { planRows, readSheet } from "../src/core/sync-plan.mjs";
import { sanitize, mtText } from "../src/core/text.mjs";
import { SHEETS } from "../src/verify/catalog-verify.mjs";
import { compareWithSheet, findLastSync, liveParity, runScenarios, supplierUniverse, timeMode } from "../src/verify/supplier-shadow.mjs";
import { loadLiveAppsScript } from "../src/verify/live-vm.mjs";
import { readXlsx } from "./lib/xlsx-read.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const config = JSON.parse(await fsp.readFile(arg("config", path.join(root, "config", "default.json")), "utf8"));
const expected = JSON.parse(await fsp.readFile(arg("expected", path.join(root, "config", "expected-live.json")), "utf8"));
const JOURNAL = "Журнал";
const wanted = [SHEETS.main, SHEETS.queue, SHEETS.deferred, SHEETS.frozen];
// Числа від 6 цифр (у т.ч. притиснуті до літер: «ID1234567», «p1500000001-…») → ***; URL у будь-якому регістрі приховано.
const scrub = (e) => sanitize(e).replace(/\d{6,}/g, "***");

// Фрагменти, яких НЕ може бути у виводі: точні значення секретів і похідні форми.
// ::add-mask:: свідомо НЕ використовується: рядок самої команди містив би похідне значення секрету,
// а поведінку його логування не перевірено. Натомість увесь вивід іде лише через emit() нижче.
const secrets = new Set();
const addSecret = (v) => {
  const s = v == null ? "" : String(v);
  if (s.length >= 8) secrets.add(s);
};
addSecret(process.env.MM_SHEET_ID);
addSecret(process.env.GOOGLE_OAUTH_ACCESS_TOKEN);
const addUrlSecrets = (raw) => {
  addSecret(raw);
  try {
    const u = new URL(raw);
    addSecret(u.search); addSecret(u.search.slice(1)); addSecret(u.host + u.pathname + u.search);
    for (const [, v] of u.searchParams) { addSecret(v); addSecret(encodeURIComponent(v)); }
  } catch { /* невалідна адреса — перевіриться нижче */ }
};
if (process.env.MM_SUPPLIER_FEED_URL) addUrlSecrets(process.env.MM_SUPPLIER_FEED_URL);

/** ЄДИНА точка виводу: будь-який текст перевіряється на секрети й на числа, схожі на Offer ID (10+ цифр). */
function emit(stream, text) {
  const leaks = [...secrets].filter((s) => text.includes(s)).length;
  const idLike = /\d{10,}/.test(text);
  if (leaks || idLike) {
    process.stderr.write(`ЗАХИСТ ВІД ВИТОКУ: вивід заблоковано (${leaks ? "фрагмент секрету" : ""}${leaks && idLike ? ", " : ""}${idLike ? "число, схоже на Offer ID" : ""})\n`);
    process.exit(3);
  }
  (stream === "err" ? process.stderr : process.stdout).write(text.endsWith("\n") ? text : text + "\n");
}
const fail = (prefix, e) => { emit("err", prefix + scrub(e)); process.exit(2); };

const t = { start: Date.now() };
let book, journal, sheetsMetrics = null;
try {
  if (arg("source", "api") === "api") {
    const src = new GoogleSheetsCatalogSource({ spreadsheetId: process.env.MM_SHEET_ID || "", getAccessToken: envAccessToken() });
    const loaded = await src.load(wanted);
    book = { ...loaded.sheets, [SHEETS.groups]: loaded.groups };
    journal = await src.loadTail(JOURNAL, { until: (rows) => findLastSync(rows) !== null });
    sheetsMetrics = { ...src.metrics };
  } else if (arg("source") === "snapshot") {
    const loaded = await new NdjsonCatalogSource(arg("catalog")).load([...wanted, JOURNAL]);
    journal = loaded.sheets[JOURNAL] || null;
    delete loaded.sheets[JOURNAL];
    book = { ...loaded.sheets, [SHEETS.groups]: loaded.groups };
  } else {
    const file = arg("xlsx");
    if (!file) throw new Error("Потрібен --xlsx=<файл>");
    const sheets = Object.fromEntries(readXlsx(file, { only: [...wanted, SHEETS.groups, JOURNAL] }).sheets.filter((s) => s.values).map((s) => [s.name, s.values]));
    journal = sheets[JOURNAL];
    delete sheets[JOURNAL];
    book = sheets;
  }
} catch (e) {
  fail("ПОМИЛКА ЧИТАННЯ ТАБЛИЦІ: ", e);
}
t.sheetsMs = Date.now() - t.start;

let xml;
const fetchStarted = Date.now();
try {
  if (arg("supplier", "") === "env") {
    const full = process.env.MM_SUPPLIER_FEED_URL || "";
    if (!full) throw new Error("Немає секрету MM_SUPPLIER_FEED_URL");
    const op = operationalUrl(full, config.supplier); // ті самі параметри, що mtOperationalUrl у LIVE
    addUrlSecrets(op);
    const chunks = [];
    // Ліміт байтів перевіряється ПІД ЧАС завантаження (UTF-8 кирилиця ≤ 2 байти на символ ліміту LIVE).
    for await (const c of new HttpSupplierSource(op, { timeoutMs: config.supplier.fetchTimeoutMs || 120000, maxBytes: config.supplier.maximumChars * 2 }).chunks()) chunks.push(c);
    xml = Buffer.concat(chunks).toString("utf8");
  } else {
    const file = arg("supplier-file");
    if (!file) throw new Error("Потрібен --supplier=env або --supplier-file=<xml>");
    xml = await fsp.readFile(file, "utf8");
  }
  if (xml.length > config.supplier.maximumChars) throw new Error("Фід перевищує безпечний розмір");
} catch (e) {
  fail("ПОМИЛКА ОТРИМАННЯ ФІДУ ПОСТАЧАЛЬНИКА: ", e);
}
t.fetchMs = Date.now() - fetchStarted;
const feedBytes = Buffer.byteLength(xml, "utf8");

const report = { ok: false, checks: [], warnings: [], time: {}, feed: {}, compare: {}, coverage: null, parity: null, universe: null, scenarios: null, metrics: {} };
const check = (name, ok, detail) => report.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });

try {
  const procStarted = Date.now();
  const parsed = await parseSupplierText(xml, { maximumChars: config.supplier.maximumChars, identityFields: true });
  const lastSync = findLastSync(journal);
  const syncRowsBySheet = { main: readSheet(book[SHEETS.main], SHEETS.main).rows, new92: readSheet(book[SHEETS.queue], SHEETS.queue).rows };
  const syncRows = [...syncRowsBySheet.main, ...syncRowsBySheet.new92];
  const stamps = syncRows.reduce((a, r) => ((a[mtText(r["Оновлено"])] = (a[mtText(r["Оновлено"])] || 0) + 1), a), {});
  const rowsStamp = Object.entries(stamps).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const tm = timeMode({ feedDate: parsed.date, lastSync, rowsStamp });

  let validateError = null;
  try { validateFeed(parsed, lastSync?.offers, Date.now(), config.supplier); } catch (e) { validateError = scrub(e); }
  // Довільні рядки зі сторонніх джерел (атрибут XML, клітинки журналу) — лише у суворому форматі дати.
  const asDate = (v, re) => (re.test(mtText(v)) ? mtText(v) : "(нерозпізнано)");
  const KYIV = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  report.feed = { offers: parsed.count, bytes: feedBytes, date: asDate(parsed.date, KYIV), healthy: !validateError, validateError };
  const syncedShare = lastSync ? syncRows.filter((r) => mtText(r["Оновлено"]) === lastSync.at).length / Math.max(1, syncRows.length) : 0;
  report.time = {
    mode: tm.mode, reason: tm.reason || null, minutesAfterSync: tm.minutesAfterSync ?? null,
    lastSyncAt: lastSync ? asDate(lastSync.at, ISO) : null, lastSyncFeedDate: lastSync ? asDate(lastSync.feedDate, KYIV) : null,
    lastSyncOffers: lastSync?.offers ?? null, errorAfterLastSync: Boolean(lastSync?.errorAfter),
    rowsStampEqualsJournal: Boolean(lastSync && rowsStamp === lastSync.at), distinctRowStamps: Object.keys(stamps).length, syncedRowsShare: +syncedShare.toFixed(4),
  };
  const warn = (text) => report.warnings.push(text);
  if (lastSync?.errorAfter) warn("після останнього успішного mtUpdate у журналі є помилка синхронізації");
  if (lastSync && syncedShare < 1) warn(`не всі рядки належать останньому mtUpdate (частка ${(syncedShare * 100).toFixed(1)}%) — решта класифікується як NOT_SYNCED_YET`);

  // Обсяг: жорстко лише для того самого знімка; у NEWER_FEED нормальний дрейф асортименту — попередження.
  const scopeDelta = lastSync ? parsed.count - lastSync.offers : null;
  report.feed.scopeDeltaVsLastSync = scopeDelta;
  const scopeOk = scopeDelta !== null && Math.abs(scopeDelta) <= Math.max(20, Math.round((lastSync?.offers || 0) * 0.01));
  if (tm.mode === "SAME_SNAPSHOT") check("обсяг фіду = обсягу mtUpdate (той самий знімок)", scopeDelta === 0, scopeDelta);
  else if (lastSync && !scopeOk) warn(`обсяг фіду відрізняється від останнього mtUpdate на ${scopeDelta} offer — нормальний дрейф асортименту або інше посилання (звірити з TOOLS_FEED_URL)`);
  check("фід постачальника пройшов перевірку повноти/свіжості (як LIVE)", !validateError, validateError || undefined);

  const stamp = new Date().toISOString();
  for (const [feed, rows] of Object.entries(syncRowsBySheet)) {
    const plan = planRows(rows, parsed.offers, stamp, config.pricing);
    report.compare[feed] = compareWithSheet({ rows, plan, offers: parsed.offers, mode: tm.mode, syncStamp: lastSync?.at });
    report.compare[feed].matchStatus = plan.reduce((a, p) => ((a[p.match] = (a[p.match] || 0) + 1), a), {});
  }
  const cm = report.compare;
  const logicDiffs = cm.main.logicDiffs + cm.new92.logicDiffs;
  const comparable = cm.main.comparableRows + cm.new92.comparableRows;
  const verified = cm.main.verifiedRows + cm.new92.verifiedRows;
  report.coverage = { comparableRows: comparable, verifiedRows: verified, share: comparable ? +(verified / comparable).toFixed(4) : 0 };
  if (tm.mode === "SAME_SNAPSHOT" || tm.mode === "NEWER_FEED") {
    check("0 справжніх розбіжностей логіки з таблицею (з урахуванням часу)", logicDiffs === 0, logicDiffs);
    // Без покриття «0 розбіжностей» нічого не доводить: потрібна перевірка щонайменше половини рядків.
    check("покриття: ≥50% порівнюваних рядків перевірено за незмінними входами", report.coverage.share >= 0.5, report.coverage.share);
  } else {
    report.inconclusive = true;
    check("порівняння з таблицею достовірне", false, "режим " + tm.mode + ": висновок про логіку за таблицею неможливий — " + (tm.reason || ""));
  }

  const gas = loadLiveAppsScript();
  // Паритет перевірки повноти — з параметрами LIVE (MT у Code.gs), незалежно від локального конфігу.
  const parity = await liveParity({ gas, xml, rows: syncRows, stamp, previousCount: lastSync?.offers, now: Date.now(), pricing: config.pricing, supplierConfig: { ...config.supplier, minimumOffers: gas.MT.minimumOffers, maximumAgeHours: gas.MT.maximumAgeHours } });
  report.parity = parity;
  check("паритет LIVE↔нова система: розбір фіду (кількість і всі поля offer)", parity.parseCountEqual && parity.offersDiff === 0, parity.offersDiff);
  check("паритет LIVE↔нова система: перевірка повноти/віку фіду", parity.validateEqual);
  check(`паритет LIVE↔нова система: статуси зіставлення ${syncRows.length} карток`, parity.statusDiff === 0, parity.statusDiff);
  check("паритет LIVE↔нова система: F:M (ціна, Base, Final, знижка, наявність, кількість)", parity.planDiff === 0, parity.planDiff);

  report.universe = supplierUniverse({ book, offers: parsed.offers });
  t.processMs = Date.now() - procStarted;

  if (flag("scenarios")) {
    const dir = await fsp.mkdtemp(path.join(arg("tmp") || os.tmpdir(), "mm-c2c-"));
    try {
      const sc = await runScenarios({ book, xml, config, tmpDir: dir, expected });
      report.scenarios = sc.scenarios;
      for (const [name, ok] of Object.entries(sc.expect)) check("D1/D1b " + name, ok);
      t.scenariosMs = sc.ms;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
} catch (e) {
  check("обробка без винятків", false, scrub(e));
}

const ru = process.resourceUsage();
report.metrics = { sheetsReadMs: t.sheetsMs, supplierFetchMs: t.fetchMs, processMs: t.processMs ?? null, scenariosMs: t.scenariosMs ?? null, totalMs: Date.now() - t.start, maxRssMb: Math.round(ru.maxRSS / 1024), sheetsApi: sheetsMetrics, supplierRequests: arg("supplier", "") === "env" ? 1 : 0 };
report.ok = report.checks.every((c) => c.ok);
report.failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
// «Висновок неможливий» (OLDER_FEED / UNKNOWN) — окремий код 4, якщо все інше пройшло.
const onlyInconclusive = Boolean(report.inconclusive) && report.failed.length === 1 && report.failed[0] === "порівняння з таблицею достовірне";

emit("out", JSON.stringify(report, null, 2));

const summaryFile = arg("summary");
if (summaryFile) {
  const c = report.compare;
  const n = (b, k) => (b && b[k]) || 0;
  const verdict = report.ok ? "PASS" : onlyInconclusive ? "ВИСНОВОК НЕМОЖЛИВИЙ" : "FAIL";
  const lines = [
    `### C2-C: shadow-звірка з живим фідом постачальника — ${verdict}`,
    "",
    `Фід: ${report.feed.offers} offer, ${(report.feed.bytes / 1e6).toFixed(2)} МБ, справний: ${report.feed.healthy ? "так" : "ні"}; режим часу: **${report.time.mode}** (${report.time.minutesAfterSync ?? "?"} хв після mtUpdate); покриття перевірки ${((report.coverage?.share || 0) * 100).toFixed(1)}%`,
    "",
    "| Фід | Без змін | Зміни постачальника | Зникли | Зміна статусу | Відновлені | Не синхронізовані | Розбіжність логіки | Непідтверджено |",
    "|---|---|---|---|---|---|---|---|---|",
    ...["main", "new92"].filter((f) => c[f]).map((f) => { const b = c[f].byClass; return `| ${f} | ${n(b, "UNCHANGED")} | ${n(b, "SUPPLIER_CHANGE")} | ${n(b, "SUPPLIER_REMOVED")} | ${n(b, "STATUS_CHANGE")} | ${n(b, "RECOVERED")} | ${n(b, "NOT_SYNCED_YET")} | ${n(b, "LOGIC_DIFF")} | ${n(b, "UNCONFIRMED")} |`; }),
    "",
    `Паритет LIVE↔нова система на тому самому XML: offers ${report.parity?.offersDiff ?? "—"}, статуси ${report.parity?.statusDiff ?? "—"}, F:M ${report.parity?.planDiff ?? "—"} розбіжностей`,
    `Перевірок: ${report.checks.length}, FAIL: ${report.failed.length}; час: таблиця ${report.metrics.sheetsReadMs} мс, фід ${report.metrics.supplierFetchMs} мс, обробка ${report.metrics.processMs ?? "—"} мс, сценарії ${report.metrics.scenariosMs ?? "—"} мс; пам'ять ${report.metrics.maxRssMb} МБ`,
    ...(report.warnings.length ? ["", "Попередження:", ...report.warnings.map((w) => "- " + w)] : []),
    ...(report.failed.length ? ["", "FAIL:", ...report.failed.map((x) => "- " + x)] : []),
  ].join("\n") + "\n";
  const leaks = [...secrets].some((x) => lines.includes(x)) || /\d{10,}/.test(lines);
  if (leaks) { process.stderr.write("ЗАХИСТ ВІД ВИТОКУ: summary не записано\n"); process.exit(3); }
  fs.appendFileSync(summaryFile, lines);
}
process.exitCode = report.ok ? 0 : onlyInconclusive ? 4 : 1;
