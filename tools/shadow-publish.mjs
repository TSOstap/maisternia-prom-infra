/** Етап C3-2: тіньова публікація РЕАЛЬНОГО основного YML (лише читання таблиці й постачальника; без Prom).
 *
 *  Що робить в одному запуску (один знімок даних):
 *   A. Генератор: YML з ПОТОЧНОЇ таблиці — новий buildYml проти справжнього LIVE mtBuildYml_ (Apps Script у VM).
 *      Це те, що зараз опубліковано чинною системою (якщо таблицю не змінювали після останньої публікації).
 *   B. Повний цикл: новий конвеєр (зіставлення, ціни, «Заморожені ID», D1/D1b) на таблиці + XML постачальника
 *      проти LIVE у VM (mtParse → mtPlan → mtBuildYml_) на ТИХ САМИХ даних. Очікується байт-у-байт (крім date).
 *   C. Перевірка результату B: структура XML, кількість/набір ID, ціни, знижки, наявність.
 *   D. Лише якщо A–C пройдені і передано --publish: частини → Cloudflare Workers Free (тіньовий ключ) → readback → відкат.
 *
 *  У GitHub Actions (режим shadow-publish у sheets-verify.yml):
 *    node tools/shadow-publish.mjs --source=api --supplier=env --publish --summary="$GITHUB_STEP_SUMMARY" --tmp="$RUNNER_TEMP"
 *  Локально (без публікації):
 *    node tools/shadow-publish.mjs --source=xlsx --xlsx=<книга> --supplier-file=<xml> [--details=<папка поза репо>] [--ref-yml=<чинний YML>]
 *
 *  Вивід — лише агрегати через emit(): блокується будь-який фрагмент секрету й числа з 10+ цифр (Offer ID). Код 3 — спрацював захист.
 *  Коди: 0 — PASS; 1 — FAIL перевірок або публікації (жива версія збережена/відкочена); 2 — помилка читання; 3 — захист від витоку. */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleSheetsCatalogSource, envAccessToken } from "../src/pipeline/google-sheets.mjs";
import { FileSupplierSource, HttpSupplierSource } from "../src/pipeline/sources.mjs";
import { operationalUrl } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { sanitize, mtText } from "../src/core/text.mjs";
import { approvalManifest, GROUP_HEADERS } from "../src/core/seal.mjs";
import { buildYml, memorySink, objectsFromValues } from "../src/core/yml.mjs";
import { verifyYmlStream } from "../src/core/xml-verify.mjs";
import { SHEETS } from "../src/verify/catalog-verify.mjs";
import { findLastSync, timeMode } from "../src/verify/supplier-shadow.mjs";
import { loadLiveAppsScript } from "../src/verify/live-vm.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate } from "../src/pipeline/update.mjs";
import { buildVersion, publishVersion, sha256 } from "../src/publish/cf-assets.mjs";
import { liveLimitStatus } from "../src/verify/size-watch.mjs";
import { readXlsx } from "./lib/xlsx-read.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const flag = (n) => process.argv.includes(`--${n}`);
const config = JSON.parse(await fsp.readFile(arg("config") && process.env.GITHUB_ACTIONS !== "true" ? arg("config") : path.join(root, "config", "default.json"), "utf8")); // --config лише локально (мутаційна перевірка)
const expected = JSON.parse(await fsp.readFile(path.join(root, "config", "expected-live.json"), "utf8"));
const JOURNAL = "Журнал";
const WORKER_NAME = "mm-feed-poc";
const POC = path.join(root, "poc", "c3-assets");
const CI = process.env.GITHUB_ACTIONS === "true";

// ---------- захист від витоку (як у supplier-shadow) ----------
const secrets = new Set();
const addSecret = (v) => { const s = v == null ? "" : String(v); if (s.length >= 8) secrets.add(s); };
for (const k of ["MM_SHEET_ID", "GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "MM_SHADOW_FEED_KEY", "MM_FEED_KEY"]) addSecret(process.env[k]);
const addUrlSecrets = (raw) => {
  addSecret(raw);
  try { const u = new URL(raw); addSecret(u.search); addSecret(u.search.slice(1)); addSecret(u.host + u.pathname + u.search); for (const [, v] of u.searchParams) { addSecret(v); addSecret(encodeURIComponent(v)); } } catch { /* */ }
};
if (process.env.MM_SUPPLIER_FEED_URL) addUrlSecrets(process.env.MM_SUPPLIER_FEED_URL);
const scrub = (e) => sanitize(e).replace(/\d{6,}/g, "***");
function emit(stream, text) {
  const leaks = [...secrets].filter((s) => text.includes(s)).length;
  const idLike = /\d{10,}/.test(text);
  if (leaks || idLike) {
    process.stderr.write(`ЗАХИСТ ВІД ВИТОКУ: вивід заблоковано (${leaks ? "фрагмент секрету" : "число, схоже на Offer ID"})\n`);
    process.exit(3);
  }
  (stream === "err" ? process.stderr : process.stdout).write(text.endsWith("\n") ? text : text + "\n");
}
const fail = (prefix, e) => { emit("err", prefix + scrub(e?.message || e)); process.exit(2); };
const progress = (o) => emit("out", JSON.stringify({ t: Math.round((Date.now() - started) / 1000), ...o }));
const started = Date.now();

// ---------- розбір offer для порівняння за змістом (лише в пам'яті) ----------
const TAG = (name) => new RegExp(`<${name}>([^<]*)</${name}>`);
function offerMap(xml) {
  const m = new Map();
  for (const x of xml.matchAll(/<offer id="(\d+)" available="(true|false)"[^>]*>([\s\S]*?)<\/offer>/g)) {
    const body = x[3];
    const rest = body.replace(TAG("price"), "").replace(TAG("oldprice"), "").replace(TAG("quantity_in_stock"), "");
    m.set(x[1], { available: x[2], price: TAG("price").exec(body)?.[1] ?? null, oldprice: TAG("oldprice").exec(body)?.[1] ?? null, qty: TAG("quantity_in_stock").exec(body)?.[1] ?? null, rest: crypto.createHash("sha256").update(rest).digest("hex") });
  }
  return m;
}
/** Розбіжності двох YML за змістом: лише кількості (ID — тільки в локальний файл деталей). */
function contentDiff(a, b) {
  const A = offerMap(a), B = offerMap(b);
  const d = { offersA: A.size, offersB: B.size, onlyA: [], onlyB: [], available: [], price: [], oldprice: [], quantity: [], otherContent: [] };
  for (const [id, x] of A) {
    const y = B.get(id);
    if (!y) { d.onlyA.push(id); continue; }
    for (const [k, f] of [["available", "available"], ["price", "price"], ["oldprice", "oldprice"], ["quantity", "qty"], ["otherContent", "rest"]]) if (x[f] !== y[f]) d[k].push(id);
  }
  for (const id of B.keys()) if (!A.has(id)) d.onlyB.push(id);
  const counts = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]));
  return { counts, ids: d };
}
/** Бізнес-перевірка цін/знижок/наявності в готовому YML (формула LIVE: Base = Final × 1,25 → знижка 20%). */
function priceChecks(xml) {
  const r = { offers: 0, available: 0, unavailable: 0, badPrice: 0, availableWithoutOldprice: 0, unavailableWithOldprice: 0, discountNot20: 0 };
  for (const [, o] of offerMap(xml)) {
    r.offers++;
    const p = Number(o.price), op = o.oldprice == null ? null : Number(o.oldprice);
    if (!(p > 0) || !/^\d+\.\d{2}$/.test(o.price || "")) r.badPrice++;
    if (o.available === "true") {
      r.available++;
      if (op == null) r.availableWithoutOldprice++;
      else if (Math.abs(Math.round(Math.round(p * 1.25 / 0.01) * 0.01 * 100) / 100 - op) > 0.005) r.discountNot20++;
    } else {
      r.unavailable++;
      if (op != null) r.unavailableWithOldprice++;
    }
  }
  return r;
}
const digestNoDate = (xml) => sha256(xml.replace(/^(<\?xml version="1\.0" encoding="UTF-8"\?>\n<yml_catalog date=")[^"]*"/, '$1"'));

// ---------- 1. Дані ----------
const wanted = [SHEETS.main, SHEETS.queue, SHEETS.deferred, SHEETS.frozen];
let book, journal;
try {
  if (arg("source", "api") === "api") {
    const src = new GoogleSheetsCatalogSource({ spreadsheetId: process.env.MM_SHEET_ID || "", getAccessToken: envAccessToken() });
    const loaded = await src.load(wanted);
    book = { ...loaded.sheets, [SHEETS.groups]: loaded.groups };
    journal = await src.loadTail(JOURNAL, { until: (rows) => findLastSync(rows) !== null });
  } else {
    const sheets = Object.fromEntries(readXlsx(arg("xlsx"), { only: [...wanted, SHEETS.groups, JOURNAL] }).sheets.filter((s) => s.values).map((s) => [s.name, s.values]));
    journal = sheets[JOURNAL];
    delete sheets[JOURNAL];
    book = sheets;
  }
} catch (e) { fail("ПОМИЛКА ЧИТАННЯ ТАБЛИЦІ: ", e); }
const tSheets = Date.now() - started;

let xml;
const tf = Date.now();
try {
  if (arg("supplier", "") === "env") {
    const op = operationalUrl(process.env.MM_SUPPLIER_FEED_URL || "", config.supplier);
    addUrlSecrets(op);
    const chunks = [];
    for await (const c of new HttpSupplierSource(op, { timeoutMs: config.supplier.fetchTimeoutMs || 120000, maxBytes: config.supplier.maximumChars * 2 }).chunks()) chunks.push(c);
    xml = Buffer.concat(chunks).toString("utf8");
  } else xml = await fsp.readFile(arg("supplier-file"), "utf8");
} catch (e) { fail("ПОМИЛКА ОТРИМАННЯ ФІДУ ПОСТАЧАЛЬНИКА: ", e); }
const tFetch = Date.now() - tf;

const report = { ok: false, checks: [], warnings: [], time: {}, generator: {}, full: {}, yml: {}, prices: {}, pipeline: {}, publish: null, metrics: {} };
const check = (name, ok, detail) => report.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const tmp = await fsp.mkdtemp(path.join(arg("tmp") || os.tmpdir(), "mm-c3-2-"));
let oursFull = null;
try {
  const gas = loadLiveAppsScript();
  const mainValues = book[SHEETS.main], groupValues = book[SHEETS.groups];
  const mainRows = readSheet(mainValues, SHEETS.main).rows;
  const groups = objectsFromValues(groupValues, GROUP_HEADERS);
  const lastSync = findLastSync(journal);
  const stamps = mainRows.reduce((a, r) => ((a[mtText(r["Оновлено"])] = (a[mtText(r["Оновлено"])] || 0) + 1), a), {});
  const rowsStamp = Object.entries(stamps).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const T = arg("now") && !CI ? Date.parse(arg("now")) : Date.now(); // --now лише локально: момент, коли знімок XML був свіжим
  const stamp = new Date(T).toISOString();
  const liveParsed = gas.mtParse(xml);
  const tm = timeMode({ feedDate: liveParsed.date, lastSync, rowsStamp });
  report.time = { mode: tm.mode, minutesAfterSync: tm.minutesAfterSync ?? null, feedOffers: liveParsed.count, lastSyncOffers: lastSync?.offers ?? null, distinctRowStamps: Object.keys(stamps).length };

  // A. Генератор на поточній таблиці (= що зараз опубліковано чинною системою)
  const metaSheet = { syncState: "OK", lastSuccess: rowsStamp, now: new Date(Date.parse(rowsStamp) + 60000).toISOString() };
  let liveSheet = null, liveSheetErr = null;
  try { liveSheet = gas.mtBuildYml_(mainValues, groupValues, metaSheet); } catch (e) { liveSheetErr = scrub(e.message); }
  const sink = memorySink();
  const oursSheet = await buildYml({ rows: mainRows, groups, meta: metaSheet, manifest: expected.main, config: config.yml, pricing: config.pricing, maximumBytes: 50_000_000, sink });
  report.generator = { liveBuilt: Boolean(liveSheet), liveError: liveSheetErr, bytes: oursSheet.bytes, sourceDigest: oursSheet.sourceDigest.slice(0, 16), equal: Boolean(liveSheet) && liveSheet.sourceDigest === oursSheet.sourceDigest };
  check("A. генератор: YML з поточної таблиці = LIVE mtBuildYml_ (байт-у-байт, крім date)", report.generator.equal, liveSheetErr || undefined);
  if (arg("ref-yml") && !CI) {
    const ref = fs.readFileSync(arg("ref-yml"), "utf8");
    report.generator.refEqual = digestNoDate(ref) === oursSheet.sourceDigest;
    report.generator.refDiff = report.generator.refEqual ? null : contentDiff(ref, sink.text()).counts;
  }
  progress({ step: "A", equal: report.generator.equal });

  // B1. LIVE у VM: mtParse → mtValidateFeed → mtPlan → запис F:M → mtBuildYml_ (як mtUpdate + mtPublishYml_)
  let liveFull = null, liveFullErr = null, liveValidateErr = null;
  try { gas.mtValidateFeed(liveParsed, lastSync?.offers, T); } catch (e) { liveValidateErr = scrub(e.message); }
  try {
    const view = gas.mtHeaders(mainValues);
    if (view.rows.length !== mainValues.length - 1) throw new Error("порожні рядки в каталозі");
    const plan = gas.mtPlan(view.rows, liveParsed, stamp);
    const next = mainValues.map((r) => r.slice());
    plan.forEach((p, i) => p.next.forEach((v, j) => { next[i + 1][view.start + j] = v; }));
    liveFull = gas.mtBuildYml_(next, groupValues, { syncState: "OK", lastSuccess: stamp, now: new Date(T + 60000).toISOString() });
    report.full.liveMatch = plan.reduce((a, p) => ((a[p.match] = (a[p.match] || 0) + 1), a), {});
  } catch (e) { liveFullErr = scrub(e.message); }

  // B2. Новий конвеєр (D1/D1b, «Заморожені ID») на тих самих даних
  const supplierFile = path.join(tmp, "supplier.xml");
  await fsp.writeFile(supplierFile, xml);
  const cfg = structuredClone(config);
  cfg.feeds = [{ ...cfg.feeds.find((f) => f.name === "main") }]; // лише основний YML; NEW92 та інші фіди не чіпаємо
  const store = new LocalObjectStore(path.join(tmp, "store"));
  const catalog = { load: async (names) => ({ sheets: Object.fromEntries(names.filter((n) => book[n]).map((n) => [n, book[n]])), groups: groupValues }) };
  const rep = await runUpdate({ store, config: cfg, manifests: { main: expected.main }, catalog, supplier: new FileSupplierSource(supplierFile), now: () => T, tmpDir: tmp });
  const feed = rep.feeds.find((f) => f.feed === "main");
  report.pipeline = { sync: rep.sync.state, feed: feed?.state, identity: rep.identity, conflicts: rep.conflicts, availability: rep.availability, isolatedConflicts: feed?.isolatedConflicts ?? null, unavailableMissing: feed?.unavailableMissing ?? null };
  check("B. новий конвеєр: синк OK і основний YML сформовано", rep.sync.state === "OK" && feed?.state === "PUBLISHED", rep.sync.error ? scrub(rep.sync.error) : undefined);
  const vdir = path.join(tmp, "store", "feeds", "main", "versions");
  const yFile = fs.existsSync(vdir) ? fs.readdirSync(vdir).find((f) => f.endsWith(".xml")) : null;
  if (yFile) oursFull = path.join(vdir, yFile);
  const oursText = oursFull ? fs.readFileSync(oursFull, "utf8") : "";
  report.full = { ...report.full, liveBuilt: Boolean(liveFull), liveError: liveFullErr, liveValidateError: liveValidateErr, equal: Boolean(liveFull && oursText) && liveFull.sourceDigest === digestNoDate(oursText) };
  if (liveFull && oursText && !report.full.equal) report.full.diff = contentDiff(liveFull.xml, oursText).counts;
  check("B. той самий знімок: YML нового конвеєра = YML LIVE (VM) байт-у-байт, крім date", report.full.equal, report.full.diff || liveFullErr || undefined);
  check("B. перевірка повноти фіду постачальника (LIVE mtValidateFeed)", !liveValidateErr, liveValidateErr || undefined);
  progress({ step: "B", equal: report.full.equal });

  // C. Перевірка результату
  if (oursText) {
    const v = await verifyYmlStream([oursText], { count: expected.main.count, idsSha: expected.main.idsSha });
    report.yml = { offers: v.count, bytes: v.bytes, sha256: v.sha256.slice(0, 12) + "…", sourceDigest: digestNoDate(oursText).slice(0, 16), liveLimitBytes: 50_000_000 };
    check(`C. структура XML, ${expected.main.count} унікальних ID = погодженому набору`, v.count === expected.main.count);
    check("C. розмір ≤ 50 000 000 Б (ліміт LIVE) і ≤ 180 МБ (Prom)", v.bytes <= 50_000_000, v.bytes);
    // Моніторинг: попередження про наближення до ліміту чинної системи (сам ліміт не змінюється).
    report.liveLimit = liveLimitStatus(v.bytes);
    if (report.liveLimit.level !== "OK") report.warnings.push(report.liveLimit.message);
    report.prices = priceChecks(oursText);
    const p = report.prices;
    check("C. ціни: усі > 0 і з двома знаками", p.badPrice === 0, p.badPrice);
    check("C. наявні: є oldprice і знижка рівно 20% (Base = Final × 1,25)", p.availableWithoutOldprice === 0 && p.discountNot20 === 0, { без_oldprice: p.availableWithoutOldprice, не_20: p.discountNot20 });
    check("C. відсутні: без oldprice (без знижки)", p.unavailableWithOldprice === 0, p.unavailableWithOldprice);
    if (arg("details") && !CI) {
      const det = { generatedAt: new Date().toISOString(), generator: report.generator, full: report.full, diffVsLive: liveFull ? contentDiff(liveFull.xml, oursText).ids : null };
      fs.mkdirSync(arg("details"), { recursive: true });
      fs.writeFileSync(path.join(arg("details"), `shadow-details-${stamp.replace(/[:.]/g, "-")}.json`), JSON.stringify(det, null, 1));
    }
  } else check("C. YML нового конвеєра існує", false);
} catch (e) {
  check("обробка без винятків", false, scrub(e.message));
}
const tProcess = Date.now() - started - tSheets - tFetch;

// ---------- D. Публікація (лише після PASS усіх перевірок) ----------
const allOk = report.checks.every((c) => c.ok);
if (flag("publish") && allOk && oursFull) {
  try {
    for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "MM_SHADOW_FEED_KEY", "MM_FEED_KEY"]) if (!process.env[k]) throw new Error("немає " + k);
    if (process.env.MM_SHADOW_FEED_KEY.length < 32 || process.env.MM_SHADOW_FEED_KEY === process.env.MM_FEED_KEY) throw new Error("MM_SHADOW_FEED_KEY має бути окремим ключем ≥32 символи");
    const api = (p) => fetch("https://api.cloudflare.com/client/v4" + p, { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } }).then((r) => r.json());
    const sub = (await api(`/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`)).result?.subdomain;
    if (!sub) throw new Error("немає доступу до Workers API");
    addSecret(sub);
    const base = `https://${WORKER_NAME}.${sub}.workers.dev`;
    const runTag = process.env.GITHUB_RUN_NUMBER ? `r${process.env.GITHUB_RUN_NUMBER}-${process.env.GITHUB_RUN_ATTEMPT || 1}` : `l${new Date().toISOString().replace(/\D/g, "").slice(2, 12)}`;
    const label = `shadow-${runTag}`;
    const out = path.join(tmp, "build");
    const v = await verifyYmlStream(fs.createReadStream(oursFull));
    buildVersion({ src: oursFull, out, version: label, keySha256: sha256(process.env.MM_SHADOW_FEED_KEY), workerMain: path.join(POC, "src", "worker.js"), workerName: WORKER_NAME, offers: v.count });
    const wrangler = (args) => {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [path.join(POC, "node_modules", "wrangler", "bin", "wrangler.js"), ...args], {
        cwd: POC, encoding: "utf8", maxBuffer: 1 << 26,
        // Дочірньому процесу — лише потрібне: без токена Google, ID таблиці, адреси постачальника й ключів фіду.
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MM_|GOOGLE_|GITHUB_TOKEN)/.test(k)).concat([["WRANGLER_SEND_METRICS", "false"], ["CI", "1"], ["NO_COLOR", "1"]])),
      });
      const outText = (r.stdout || "") + (r.stderr || "");
      if (/payment|billing|subscription|credit card|paid plan/i.test(outText) && r.status !== 0) throw new Error("Cloudflare вимагає оплату — СТОП");
      return { code: r.status, out: outText, ms: Date.now() - t0 };
    };
    const res = await publishVersion({ wrangler, fetch, log: (e) => progress({ publish: e.step, ...(e.ok !== undefined ? { ok: e.ok } : {}), ...(e.ms !== undefined ? { ms: e.ms } : {}) }) },
      { buildDir: out, label, base, key: process.env.MM_SHADOW_FEED_KEY, previousKeys: [process.env.MM_FEED_KEY], workerName: WORKER_NAME, parallel: 3 });
    report.publish = { label, state: res.state, failure: res.failure ?? null, previous: res.previous?.version ?? null, upload: res.steps.upload, deploy: res.steps.deploy, switch: res.steps.switch,
      readback: res.steps.readback?.map((r) => ({ status: r.status, bytes: r.bytes, ms: r.ms, match: r.match })), rollback: res.steps.rollback ? { ok: Boolean(res.steps.rollback.readback?.match) } : null, parts: res.manifest?.parts ?? null };
    check("D. тіньова публікація: PUBLISHED, readback SHA-256 збігся", res.state === "PUBLISHED");
  } catch (e) {
    report.publish = { state: "ERROR", error: scrub(e.message) };
    check("D. тіньова публікація", false, report.publish.error);
  }
} else if (flag("publish")) {
  report.publish = { state: "SKIPPED", reason: "перевірки A–C не пройдені — реальні дані в Cloudflare не завантажувались" };
}
await fsp.rm(tmp, { recursive: true, force: true }); // реальний YML і XML не лишаються на диску runner

const ru = process.resourceUsage();
report.metrics = { sheetsReadMs: tSheets, supplierFetchMs: tFetch, processMs: tProcess, totalMs: Date.now() - started, maxRssMb: Math.round(ru.maxRSS / 1024) };
report.ok = report.checks.every((c) => c.ok);
report.failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
emit("out", JSON.stringify(report, null, 2));

if (arg("summary")) {
  const p = report.publish;
  const lines = [
    `### C3-2: тіньова публікація реального основного YML — ${report.ok ? "PASS" : "FAIL"}`,
    "",
    `Режим часу: **${report.time.mode}** (${report.time.minutesAfterSync ?? "?"} хв після mtUpdate); offer у фіді постачальника: ${report.time.feedOffers}`,
    "",
    "| Перевірка | Результат |", "|---|---|",
    ...report.checks.map((c) => `| ${c.name} | ${c.ok ? "PASS" : "FAIL"} |`),
    "",
    `YML: ${report.yml.offers ?? "—"} offer, ${report.yml.bytes ?? "—"} Б; наявних ${report.prices.available ?? "—"}, відсутніх ${report.prices.unavailable ?? "—"}`,
    ...(report.warnings.length ? ["", ...report.warnings.map((w) => "> " + w)] : []),
    p ? `Публікація: ${p.state}${p.upload ? `, upload ${p.upload.ms} мс` : ""}${p.switch ? `, перемикання ${p.switch.ms} мс` : ""}${p.readback ? `, readback ${p.readback.filter((r) => r.match).length}/${p.readback.length}` : ""}` : "Публікація: не запитувалась",
    `Час: таблиця ${report.metrics.sheetsReadMs} мс, постачальник ${report.metrics.supplierFetchMs} мс, обробка ${report.metrics.processMs} мс, разом ${report.metrics.totalMs} мс; пам'ять ${report.metrics.maxRssMb} МБ`,
  ].join("\n") + "\n";
  if ([...secrets].some((x) => lines.includes(x)) || /\d{10,}/.test(lines)) { process.stderr.write("ЗАХИСТ ВІД ВИТОКУ: summary не записано\n"); process.exit(3); }
  fs.appendFileSync(arg("summary"), lines);
}
process.exitCode = report.ok ? 0 : 1;
