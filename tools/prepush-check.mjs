/** Перевірка перед будь-яким push (етап C1). Нічого не змінює і нікуди не надсилає.
 *  node tools/prepush-check.mjs
 *  1) у Git немає локальних даних (.data/), великих файлів, xlsx/yml з реальними даними;
 *  2) у відстежуваних файлах немає ознак секретів;
 *  3) npm test зелений.
 *  Додаткові приватні шаблони (напр. ID робочої таблиці) — через змінну середовища PREPUSH_EXTRA_PATTERNS (через «|»),
 *  щоб самі шаблони не потрапили в репозиторій. */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const problems = [];

const SECRET_PATTERNS = [
  [/hash_tag=[0-9a-f]{16,}/i, "посилання фіду постачальника з hash_tag"],
  [/products_feed\.xml\?[^\s"']*hash/i, "посилання фіду постачальника"],
  [/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/, "адреса вебзастосунку Apps Script"],
  [/[?&]key=[A-Za-z0-9]{24,}/, "посилання з ключем доступу"],
  [/AKIA[0-9A-Z]{16}/, "ключ доступу S3/AWS"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "приватний ключ"],
  [/"private_key_id"\s*:/, "файл service account Google"],
  [/"type"\s*:\s*"service_account"/, "JSON-ключ service account Google"],
  [/ya29\.[A-Za-z0-9_-]{60,}/, "access token Google OAuth"],
  [/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{30,}/, "посилання на Google-таблицю з ID"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "токен GitHub"],
  [/Bearer\s+[A-Za-z0-9_\-.]{30,}/, "Bearer-токен"],
];
for (const p of (process.env.PREPUSH_EXTRA_PATTERNS || "").split("|").filter(Boolean)) SECRET_PATTERNS.push([new RegExp(p), "приватний шаблон з PREPUSH_EXTRA_PATTERNS"]);

for (const f of files) {
  if (/^\.data\//.test(f) || /(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".env.example")) problems.push(`${f}: локальні дані/секрети не можна комітити`);
  if (/\.(xlsx|xls|yml\.gz)$/i.test(f) || /fresh-main\.yml$/.test(f)) problems.push(`${f}: файл із можливими реальними даними`);
  const full = path.join(root, f);
  const size = fs.statSync(full).size;
  if (size > 5_000_000) problems.push(`${f}: ${size} Б — завеликий для репозиторію коду`);
  if (size > 20_000_000) continue;
  const text = fs.readFileSync(full, "utf8");
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) problems.push(`${f}: ${what}`);
}

const testFiles = fs.readdirSync(path.join(root, "test")).filter((x) => x.endsWith(".test.mjs")).map((x) => path.join("test", x));
const tests = spawnSync(process.execPath, ["--test", ...testFiles], { cwd: root, encoding: "utf8" });
const pass = /ℹ pass (\d+)/.exec(tests.stdout)?.[1];
const fail = /ℹ fail (\d+)/.exec(tests.stdout)?.[1];
if (tests.status !== 0 || fail !== "0") problems.push(`npm test: pass ${pass}, fail ${fail}`);

console.log(JSON.stringify({ trackedFiles: files.length, tests: { pass: Number(pass), fail: Number(fail) }, problems }, null, 2));
process.exitCode = problems.length ? 1 : 0;
