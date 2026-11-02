/** ENG-29 — запускач операцій кнопок у GitHub Actions (workflow ops.yml; кнопка в таблиці TEST → Worker mm-ops → workflow_dispatch).
 *
 *  1. Звіт «почато» в mm-ops (POST /run/start).
 *  2. Погоджені файли поза репозиторієм (FZ, OV, A3, контракт CC) — з mm-ops (/inputs), SHA-256 = config/ops-inputs.json, інакше відмова.
 *  3. tools/sheet-sync.mjs у режимі операції: ціль — лише TEST, сховище W2 — Durable Object mm-ops (MM_W2_MODE=do), токен запису —
 *     mm-sheets-copy (gcloud з обліковими даними WIF → generateAccessToken; перевірку scope робить sheet-sync).
 *  4. Підсумок для власника — у mm-ops (POST /run/finish). У журнал GitHub — лише стан (без ID товарів і секретів).
 *  Змінні: MM_OPS_URL, MM_OPS_RUNNER_KEY, MM_OPS_RUN_ID (може бути порожнім), MM_SUPPLIER_FEED_URL (ціль — TEST_SHEET_ID з коду); облікові дані gcloud — WIF. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ownerSummary } from "../src/pipeline/ops-summary.mjs";
import { TEST_SHEET_ID } from "../src/pipeline/safe-write/write-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
/** Операція кнопки → режим sheet-sync. Лише реалізовані й погоджені операції. */
export const OP_MODES = Object.freeze({
  reconcile: { mode: "reconcile", cc: false },
  update: { mode: "update", cc: true },
  "find-new": { mode: "find-new", cc: true },
  transfer: { mode: "transfer", cc: true },
});
const op = arg("op");
const env = process.env;
const say = (s) => process.stdout.write(s + "\n");
const base = String(env.MM_OPS_URL || "");
const tmp = env.RUNNER_TEMP || fs.mkdtempSync(path.join(root, ".ops-tmp-"));
let runId = String(env.MM_OPS_RUN_ID || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40);

async function ops(p, body, { method = "POST" } = {}) {
  const res = await fetch(new URL(p, base), { method, redirect: "error", headers: { authorization: "Bearer " + env.MM_OPS_RUNNER_KEY, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return res;
}
/** Звіт про завершення — з повторами (перший реальний запуск 02.11: одноразова мережева помилка після 13 хв роботи — запуск лишився
 *  «виконується» в mm-ops, хоча операція завершилась). Повтор безпечний: той самий runId лише оновлює запис запуску. */
async function finish(ok, state, summary) {
  let last = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await ops("/run/finish", { runId, ok, state, summary });
      if (r.ok) return;
      last = "HTTP " + r.status;
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { last = String(e?.cause?.code || e?.name || "мережа").slice(0, 40); }
    await new Promise((res) => setTimeout(res, 2000 * attempt));
  }
  say("mm-ops: звіт про завершення не надіслано (" + last + ")");
}
async function stop(code, state, summary) {
  say(`СТАН: ${state}`);
  if (runId) await finish(false, state, summary);
  process.exit(code);
}

if (!OP_MODES[op]) { say("невідома операція: " + op.slice(0, 40)); process.exit(2); }
if (!/^https:\/\//.test(base) || String(env.MM_OPS_RUNNER_KEY || "").length < 20) { say("не налаштовано MM_OPS_URL / MM_OPS_RUNNER_KEY"); process.exit(2); }

// 1. Почато.
try {
  const r = await ops("/run/start", { runId, op, ghRunId: String(env.GITHUB_RUN_ID || "") });
  const j = await r.json().catch(() => ({}));
  if (j?.result?.runId) runId = j.result.runId;
} catch { say("mm-ops: звіт про початок не надіслано (продовжуємо)"); }

// 2. Погоджені файли.
const manifest = JSON.parse(fs.readFileSync(path.join(root, "config", "ops-inputs.json"), "utf8"));
const inputsDir = path.join(tmp, "ops-inputs");
fs.mkdirSync(inputsDir, { recursive: true });
const files = {};
for (const [varName, x] of Object.entries(manifest.inputs)) {
  let text;
  try {
    const r = await ops("/inputs/" + x.name, null, { method: "GET" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    text = await r.text();
  } catch (e) { await stop(2, "ERROR", `Немає погодженого файлу «${x.name}» на сервері (${e.message}) — нічого не записано`); }
  const sha = crypto.createHash("sha256").update(text, "utf8").digest("hex");
  if (sha !== x.sha256) await stop(2, "ERROR", `Файл «${x.name}» на сервері не збігається з погодженим (SHA-256) — нічого не записано`);
  const file = path.join(inputsDir, x.name + ".json");
  fs.writeFileSync(file, text);
  files[varName] = file;
}
say("Погоджені файли: " + Object.keys(files).length + " / " + Object.keys(manifest.inputs).length + " (SHA OK)");

// 3. Операція.
const { mode, cc } = OP_MODES[op];
const reportFile = path.join(tmp, "ops-report.json");
const args = ["--max-old-space-size=6144", path.join(root, "tools", "sheet-sync.mjs"), "--source=api", `--mode=${mode}`, `--report-file=${reportFile}`];
if (cc) args.push(`--cc-contract=${files.CC_CONTRACT}`);
if (env.GITHUB_STEP_SUMMARY) args.push(`--summary=${env.GITHUB_STEP_SUMMARY}`);
// Ціль — лише тестова копія, зафіксована в коді охоронця (write-target.mjs); секрет репозиторію MM_TEST_SHEET_ID (стара копія S1) не
// використовується.
const childEnv = { ...env, MM_TEST_SHEET_ID: TEST_SHEET_ID, MM_W2_MODE: "do", MM_W2_URL: base, MM_W2_KEY: env.MM_OPS_RUNNER_KEY };
for (const k of ["MM_FREEZE_IDS", "MM_FROZEN_ATTRS", "MM_OWNER_VALUES", "MM_A3_PAIRS"]) childEnv[k] = files[k];
delete childEnv.GOOGLE_OAUTH_ACCESS_TOKEN;
delete childEnv.MM_SAFE_WRITE_DIR;
const child = spawnSync(process.execPath, args, { cwd: root, env: childEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
// Вивід sheet-sync уже захищено від витоку (лише агрегати, ID — #ID); у журнал GitHub — лише стан і помилки.
const outState = /"state":\s*"([A-Z_]+)"/.exec(child.stdout || "")?.[1] || "";
// Звіт sheet-sync у журнал GitHub: він уже пройшов захист від витоку (лише агрегати, довгі числа — #ID, секрети — блок виводу).
if (child.stdout) say(String(child.stdout).slice(0, 60_000));
if (child.stderr) say(String(child.stderr).split("\n").filter(Boolean).slice(-5).join("\n"));
let report = null;
try { report = JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch { /* звіту немає — збій до запису звіту */ }
if (report?.metrics) say("МЕТРИКИ: " + JSON.stringify(report.metrics)); // лише числа (час, запити, пам'ять)
const state = report?.result?.state || outState || "ERROR";
const ok = child.status === 0;
const summary = report ? ownerSummary(op, report) : `Помилка виконання (код ${child.status ?? "—"})` + (child.stderr ? ": " + String(child.stderr).split("\n").filter(Boolean).slice(-1)[0].slice(0, 300) : "");
await finish(ok, state, summary);
say(`СТАН: ${state}; код ${child.status}`);
process.exit(child.status ?? 1);
