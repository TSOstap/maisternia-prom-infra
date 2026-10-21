/** Перевірка реального каталогу для етапу C2-B. Лише читання; у stdout/summary — тільки агрегати.
 *
 *  У GitHub Actions (джерело — Sheets API):
 *    MM_SHEET_ID=… GOOGLE_OAUTH_ACCESS_TOKEN=… node tools/sheets-verify.mjs --source=api --replay --summary="$GITHUB_STEP_SUMMARY"
 *  Локально (джерело — xlsx-експорт):
 *    node tools/sheets-verify.mjs --source=xlsx --xlsx=<файл> [--replay] [--show-ids]
 *
 *  Код виходу: 0 — усі перевірки PASS; 1 — є FAIL; 2 — помилка читання/доступу. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleSheetsCatalogSource, envAccessToken } from "../src/pipeline/google-sheets.mjs";
import { verifyCatalog, pipelineReplay, SHEETS } from "../src/verify/catalog-verify.mjs";
import { sanitize } from "../src/core/text.mjs";
import { readXlsx } from "./lib/xlsx-read.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const config = JSON.parse(await fsp.readFile(path.join(root, "config", "default.json"), "utf8"));
const expected = JSON.parse(await fsp.readFile(path.join(root, "config", "expected-live.json"), "utf8"));
const wanted = [SHEETS.main, SHEETS.queue, SHEETS.deferred, SHEETS.frozen];
const started = Date.now();

let book;
let metrics = null;
try {
  if (arg("source", "api") === "api") {
    const src = new GoogleSheetsCatalogSource({ spreadsheetId: process.env.MM_SHEET_ID || "", getAccessToken: envAccessToken() });
    const loaded = await src.load(wanted);
    book = { ...loaded.sheets, [SHEETS.groups]: loaded.groups };
    metrics = { ...src.metrics };
  } else {
    const file = arg("xlsx");
    if (!file) throw new Error("Потрібен --xlsx=<файл>");
    book = Object.fromEntries(readXlsx(file, { only: [...wanted, SHEETS.groups] }).sheets.filter((s) => s.values).map((s) => [s.name, s.values]));
  }
} catch (e) {
  console.error("ПОМИЛКА ЧИТАННЯ: " + sanitize(e));
  process.exit(2);
}
const readMs = Date.now() - started;

const report = await verifyCatalog({
  book, expected, ymlConfig: config.yml, redact: !flag("show-ids"), tmpDir: arg("tmp"), replay: flag("replay") ? (a) => pipelineReplay({ ...a, config }) : null,
});
const ru = process.resourceUsage();
report.metrics = { readMs, totalMs: Date.now() - started, maxRssMb: Math.round(ru.maxRSS / 1024), sheetsApi: metrics };

const failed = report.checks.filter((c) => !c.ok);
console.log(JSON.stringify({ ok: report.ok, failed: failed.map((c) => c.name), sheets: report.sheets, totalActive: report.totalActive, feeds: report.feeds, replay: report.replay, metrics: report.metrics }, null, 2));

const summaryFile = arg("summary");
if (summaryFile) {
  const lines = [
    `### Перевірка каталогу через Sheets API — ${report.ok ? "PASS" : "FAIL"}`,
    "",
    `Активних товарів: **${report.totalActive}** (main ${report.feeds.main?.rows}, new92 ${report.feeds.new92?.rows}); перевірок: ${report.checks.length}, FAIL: ${failed.length}`,
    "",
    "| Фід | Рядків | idsSha | contentSha | groupsSha | Печатки | YML, байт |",
    "|---|---|---|---|---|---|---|",
    ...["main", "new92"].map((f) => {
      const x = report.feeds[f] || {};
      const b = (v) => (v ? "✅" : "❌");
      return `| ${f} | ${x.rows} | ${b(x.vsExpected?.idsSha)} | ${b(x.vsExpected?.contentSha)} | ${b(x.vsExpected?.groupsSha)} | ${x.sealMismatches === 0 ? "✅" : "❌ " + x.sealMismatches} | ${x.yml?.bytes ?? "—"} |`;
    }),
    "",
    report.replay ? `Конвеєр (D1/D1b): синк ${report.replay.sync}; фіди ${report.replay.feeds.map((f) => `${f.feed} ${f.state}`).join(", ")}` : "Конвеєр: не запускався",
    "",
    `Читання: ${readMs} мс; Sheets API: ${metrics ? `${metrics.requests} запитів, ${metrics.retries} повторів, ${(metrics.bytes / 1e6).toFixed(1)} МБ` : "—"}; пам'ять: ${report.metrics.maxRssMb} МБ`,
    ...(failed.length ? ["", "FAIL:", ...failed.map((c) => `- ${c.name}`)] : []),
  ];
  fs.appendFileSync(summaryFile, lines.join("\n") + "\n");
}
process.exitCode = report.ok ? 0 : 1;
