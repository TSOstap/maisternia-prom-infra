/** Аналіз свіжого xlsx-експорту робочої книги проти архіву, LIVE MTY та NEW92 Codex. Лише читання.
 *
 *  node tools/analysis/fresh-export.mjs --fresh=<xlsx> [--archive=<xlsx|inspect.ndjson>] [--new92=<New92Config.gs>] [--out=.data/analysis]
 *
 *  Звіт: <out>/fresh-export.json (лише агрегати й ID, без описів). У консоль — короткий підсумок.
 *  Адреси (у т.ч. посилання з ключем на «Налаштуваннях») маскуються і не потрапляють у звіт. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { readXlsx } from "../lib/xlsx-read.mjs";
import { approvalManifest, rowSeal, idsSha, YML_HEADERS, GROUP_HEADERS, FROZEN_COLUMNS } from "../../src/core/seal.mjs";
import { objectsFromValues, buildYml, memorySink } from "../../src/core/yml.mjs";
import { mtPrices, mtSameDiscount } from "../../src/core/pricing.mjs";
import { LIVE_COLUMNS } from "../../src/core/sync-plan.mjs";
import { verifyYmlStream } from "../../src/core/xml-verify.mjs";
import { loadLiveAppsScript } from "../../test/helpers/apps-script-vm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const mask = (v) => String(v).replace(/https?:\/\/\S+/g, "[адресу приховано]");

async function loadBook(file) {
  if (file.endsWith(".ndjson")) {
    const sheets = {};
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) if (line.startsWith('{"kind":"table"')) { const t = JSON.parse(line); sheets[t.sheet] = t.values; }
    return sheets;
  }
  return Object.fromEntries(readXlsx(file).sheets.map((s) => [s.name, s.values]));
}

function mtyFrom(file) {
  const src = fs.readFileSync(file, "utf8");
  const pick = (k) => (new RegExp(k + ":'([a-f0-9]{64})'").exec(src) || [])[1];
  return { count: Number((/count:(\d+)/.exec(src) || [])[1]), idsSha: pick("idsSha"), contentSha: pick("contentSha"), groupsSha: pick("groupsSha") };
}

const freshFile = arg("fresh");
if (!freshFile) { console.error("Потрібен --fresh=<xlsx>"); process.exit(2); }
const out = path.resolve(arg("out", path.join(root, ".data", "analysis")));
const fresh = await loadBook(freshFile);
const archive = arg("archive") ? await loadBook(arg("archive")) : null;
const live = mtyFrom(path.join(root, "reference", "apps-script-live", "Yml.LIVE-CURRENT.gs"));
const report = { fresh: path.basename(freshFile), freshMtime: fs.statSync(freshFile).mtime.toISOString(), archive: arg("archive") ? path.basename(arg("archive")) : null };

// ---------- 1. Аркуші ----------
report.sheets = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length - 1]));
const groups = objectsFromValues(fresh["Групи"], GROUP_HEADERS);
const rowsOf = (book, name) => (book[name] ? objectsFromValues(book[name], YML_HEADERS) : []);
const main = rowsOf(fresh, "Основний каталог");
const queue = rowsOf(fresh, "Нові товари");
const deferred = rowsOf(fresh, "Відкладені товари");

// ---------- 2. Печатки й паспорти ----------
const sealCheck = (rows) => rows.filter((r) => rowSeal(r) !== String(r["SHA256 незмінних полів"])).map((r) => String(r["Offer ID"]));
const mMain = approvalManifest(main, groups);
report.main = {
  count: main.length, sealMismatches: sealCheck(main),
  vsLive: { count: mMain.count === live.count, idsSha: mMain.idsSha === live.idsSha, contentSha: mMain.contentSha === live.contentSha, groupsSha: mMain.groupsSha === live.groupsSha },
  computed: { idsSha: mMain.idsSha, contentSha: mMain.contentSha, groupsSha: mMain.groupsSha },
};
const mQueue = approvalManifest(queue, groups);
report.queue = { count: queue.length, sealMismatches: sealCheck(queue), computed: { idsSha: mQueue.idsSha, contentSha: mQueue.contentSha } };
if (arg("new92")) {
  const src = fs.readFileSync(arg("new92"), "utf8");
  const cfg = JSON.parse(/var MT92=(\{[\s\S]*?\});/.exec(src)[1]);
  const qIds = new Set(queue.map((r) => String(r["Offer ID"])));
  report.queue.vsNew92 = {
    version: cfg.version, idsSha: mQueue.idsSha === cfg.idsSha, contentSha: mQueue.contentSha === cfg.contentSha, groupsSha: mQueue.groupsSha === cfg.groupsSha,
    missingFromQueue: cfg.ids.filter((id) => !qIds.has(id)), extraInQueue: [...qIds].filter((id) => !cfg.ids.includes(id)),
  };
}
const allIds = [...main, ...queue, ...deferred].map((r) => String(r["Offer ID"]));
report.crossSheetDuplicates = allIds.filter((id, i) => allIds.indexOf(id) !== i);
report.deferred = { count: deferred.length, inMainOrQueue: deferred.filter((r) => main.concat(queue).some((x) => x["Offer ID"] === r["Offer ID"])).length };

// ---------- 3. Різниця з архівом ----------
if (archive) {
  const diff = {};
  for (const name of ["Основний каталог", "Нові товари", "Відкладені товари"]) {
    const a = new Map(rowsOf(archive, name).map((r) => [String(r["Offer ID"]), r]));
    const f = new Map(rowsOf(fresh, name).map((r) => [String(r["Offer ID"]), r]));
    const changedCols = {};
    let changedRows = 0;
    for (const [id, r] of f) {
      const o = a.get(id);
      if (!o) continue;
      let any = false;
      for (const k of FROZEN_COLUMNS) if (String(o[k]) !== String(r[k])) { changedCols[k] = (changedCols[k] || 0) + 1; any = true; }
      if (any) changedRows++;
    }
    diff[name] = {
      archive: a.size, fresh: f.size,
      added: [...f.keys()].filter((id) => !a.has(id)).length, removed: [...a.keys()].filter((id) => !f.has(id)),
      frozenChangedRows: changedRows, frozenChangedColumns: changedCols,
    };
  }
  const aGroups = archive["Групи"] ? approvalManifest([], objectsFromValues(archive["Групи"], GROUP_HEADERS)).groupsSha : null;
  diff.groupsEqual = aGroups === mMain.groupsSha;
  report.diffVsArchive = diff;
}

// ---------- 4. Операційні колонки F:M ----------
function opCheck(rows) {
  const status = {}, availability = {}, stamps = {}, stampTypes = {};
  const formula = [], discount = [], qtyBad = [];
  for (const r of rows) {
    const st = String(r["Стан синхронізації"]);
    status[st] = (status[st] || 0) + 1;
    availability[String(r["Наявність"])] = (availability[String(r["Наявність"])] || 0) + 1;
    stamps[String(r["Оновлено"])] = (stamps[String(r["Оновлено"])] || 0) + 1;
    stampTypes[typeof r["Оновлено"]] = (stampTypes[typeof r["Оновлено"]] || 0) + 1;
    const price = Number(r["Ціна постачальника"]);
    if (r["Наявність"] === "+" || r["Наявність"] === "-") {
      try {
        const p = mtPrices(price, r["Наявність"] === "+");
        if (Number(r["Ціна"]) !== p.base || Number(r["Ціна кінцева"]) !== p.final) formula.push(String(r["Offer ID"]));
        if (!mtSameDiscount(r["Знижка"], p.discount) && String(r["Знижка"]) !== p.discount) discount.push(String(r["Offer ID"]));
      } catch { formula.push(String(r["Offer ID"])); }
    }
    const q = r["Кількість постачальника"];
    if (q !== "" && !/^\d+(?:\.\d+)?$/.test(String(q))) qtyBad.push(String(r["Offer ID"]));
  }
  const topStamps = Object.entries(stamps).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return { status, availability, stampTypes, distinctStamps: Object.keys(stamps).length, topStamps, formulaMismatch: formula, discountMismatch: discount, quantityInvalid: qtyBad };
}
report.operational = { main: opCheck(main), queue: opCheck(queue) };

// ---------- 5. YML: LIVE mtBuildYml_ з LIVE MTY на реальних F:M ----------
{
  const stamp = report.operational.main.topStamps[0]?.[0];
  const meta = { syncState: "OK", lastSuccess: stamp, now: new Date(Date.parse(stamp) + 60000).toISOString() };
  const gas = loadLiveAppsScript();
  let liveRes, liveErr;
  try { liveRes = gas.mtBuildYml_(fresh["Основний каталог"], fresh["Групи"], meta); } catch (e) { liveErr = e.message; }
  const sink = memorySink();
  let mine, mineErr;
  try {
    mine = await buildYml({
      rows: main, groups, meta, manifest: live, maximumBytes: 50_000_000, sink,
      config: { maximumSyncAgeHours: 12, shopName: "Майстерня Маркет", company: "Майстерня Маркет", timeZone: "Europe/Kyiv" },
    });
  } catch (e) { mineErr = e.message; }
  const yml = { lastSuccessUsed: stamp, liveError: liveErr || null, mineError: mineErr || null };
  if (liveRes && mine) {
    const xml = sink.text();
    const v = await verifyYmlStream([xml], { count: live.count, idsSha: live.idsSha, sha256: liveRes.sha256 });
    Object.assign(yml, { identical: xml === liveRes.xml, bytes: mine.bytes, liveBytes: liveRes.bytes, sha256: mine.sha256, sourceDigest: mine.sourceDigest, validatorCount: v.count, headroomBytes: 50_000_000 - mine.bytes });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "fresh-main.yml"), xml);
  }
  report.yml = yml;
}

// ---------- 6. Журнал і Налаштування (без адрес) ----------
if (fresh["Журнал"]) {
  const log = fresh["Журнал"].slice(1);
  const byField = {};
  for (const r of log) { const k = `${r[1]}:${r[3]}`; byField[k] = (byField[k] || 0) + 1; }
  const system = log.filter((r) => r[1] === "СИСТЕМА" || r[1] === "YML");
  report.journal = {
    rows: log.length,
    byField: Object.fromEntries(Object.entries(byField).sort((a, b) => b[1] - a[1]).slice(0, 25)),
    lastSystem: system.slice(-12).map((r) => [r[0], r[1], r[3], mask(String(r[6])).slice(0, 220)]),
    lastErrors: log.filter((r) => r[3] === "ПОМИЛКА" && (r[1] === "СИСТЕМА" || r[1] === "YML")).slice(-5).map((r) => [r[0], r[1], mask(String(r[6])).slice(0, 220)]),
  };
}
if (fresh["Налаштування"]) {
  const s = fresh["Налаштування"].slice(1);
  const names = {};
  for (const r of s) names[String(r[0])] = (names[String(r[0])] || 0) + 1;
  report.settings = {
    rows: s.length,
    distinctParams: Object.keys(names).length,
    service: s.filter((r) => /YML|оновлення|Автооновлення|Періодичність|Помилка|імпорт/i.test(String(r[0]))).slice(0, 20).map((r) => [String(r[0]), mask(r[1]).slice(0, 160)]),
    topParams: Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "fresh-export.json"), JSON.stringify(report, null, 2));
const short = (o) => JSON.stringify(o, (k, v) => (Array.isArray(v) && v.length > 8 ? [`…${v.length} шт.`, ...v.slice(0, 5)] : v));
console.log(short({ sheets: report.sheets, main: report.main, queue: report.queue, crossSheetDuplicates: report.crossSheetDuplicates, deferred: report.deferred }));
console.log("DIFF:", short(report.diffVsArchive));
console.log("OP:", short(report.operational));
console.log("YML:", short(report.yml));
console.log("ЖУРНАЛ:", short(report.journal));
console.log("НАЛАШТУВАННЯ:", short(report.settings));
