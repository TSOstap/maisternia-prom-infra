/** Перевірка підключення до ТЕСТОВОЇ КОПІЇ Google Sheets — ЛИШЕ ЧИТАННЯ (ENG-14).
 *
 *  Токен без JSON-ключа (імперсонація, документований шлях Google IAM):
 *   1) `gcloud auth print-access-token` — токен ВАШОГО входу (gcloud auth login); лише для одного виклику п. 2;
 *   2) IAM Service Account Credentials API generateAccessToken для mm-sheets-copy зі scope ЛИШЕ spreadsheets.readonly
 *      (у `gcloud auth print-access-token` прапорця --scopes немає — тому scope задається тут явно).
 *  Потрібна роль «Service Account Token Creator» вашого облікового запису на mm-sheets-copy (ENG-14). Токени лише в пам'яті процесу:
 *  не друкуються, не пишуться у файли. Альтернатива для тестів — змінна GOOGLE_OAUTH_ACCESS_TOKEN.
 *
 *  Запобіжники (до читання значень):
 *   1. ID таблиці — лише тестова копія (allowlist); будь-який інший ID — відмова;
 *   2. токен: scope — рівно spreadsheets.readonly (tokeninfo); інакше — відмова (запис технічно неможливий);
 *   3. назва таблиці містить «ТЕСТ»; інакше — відмова;
 *   4. лише GET; вивід — агрегати (кількості, збіги), без Offer ID і токенів.
 *  Звірка з XLSX копії (--xlsx): аркуші, заголовки, набори Offer ID «Основного каталогу», «Нових товарів», «Відкладених»,
 *  кількість «Заморожених ID».
 *
 *  node tools/copy-access-check.mjs [--xlsx=<вигрузка копії>] [--out=<звіт.json>]
 *  Коди виходу: 0 — підключення й звірка OK; 1 — розбіжність; 2 — відмова запобіжника / доступу. */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readXlsx } from "./lib/xlsx-read.mjs";

export const TEST_SHEET_ID = "1th8VXOUeN08Lk9QNrjdt4GK3Z0nTnU8Awkb5pLvWOxs";
export const COPY_SA = "mm-sheets-copy@maisternia-prom-infra.iam.gserviceaccount.com";
export const READONLY = "https://www.googleapis.com/auth/spreadsheets.readonly";
const API = "https://sheets.googleapis.com/v4/spreadsheets/";
const SHEETS = { main: "Основний каталог", queue: "Нові товари", deferred: "Відкладені товари", frozen: "Заморожені ID" };
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const t = (v) => String(v ?? "").trim();

export const GENERATE_URL = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${COPY_SA}:generateAccessToken`;
export const READWRITE = "https://www.googleapis.com/auth/spreadsheets";
/** Токен mm-sheets-copy з ОДНИМ scope (типово readonly): gcloud (токен входу) → generateAccessToken. Ніде не друкується.
 *  Змінна GOOGLE_OAUTH_ACCESS_TOKEN — лише для readonly (тести); токен запису — завжди окремий, короткоживучий, з gcloud. */
export async function obtainToken({ env = process.env, run = spawnSync, fetchImpl = fetch, scope = READONLY } = {}) {
  if (![READONLY, READWRITE].includes(scope)) throw new Error("невідомий scope — відмова");
  if (scope === READONLY && env.GOOGLE_OAUTH_ACCESS_TOKEN) return env.GOOGLE_OAUTH_ACCESS_TOKEN;
  // Windows: gcloud — це gcloud.cmd; .cmd запускається лише через оболонку (аргументи — сталі, без даних користувача).
  const r = run("gcloud", ["auth", "print-access-token"], { encoding: "utf8", shell: process.platform === "win32" });
  const user = t(r.stdout).split(/\r?\n/).filter(Boolean).pop() || "";
  if (r.status !== 0 || !user) {
    const why = t(r.stderr).split(/\r?\n/).filter((l) => !/ya29\./.test(l)).slice(-3).join(" | ");
    throw new Error("gcloud не видав токен входу: " + (why || "невідома причина") + " (спершу: gcloud auth login)");
  }
  const res = await fetchImpl(GENERATE_URL, { method: "POST", headers: { Authorization: "Bearer " + user, "Content-Type": "application/json" }, body: JSON.stringify({ scope: [scope] }) });
  const text = await res.text();
  if (!res.ok) {
    let status = "", message = ""; try { const e = JSON.parse(text)?.error; status = e?.status || ""; message = t(e?.message).slice(0, 200); } catch { /* */ }
    throw new Error(`generateAccessToken HTTP ${res.status} ${status}`.trim() + (res.status === 403 ? " — потрібна роль Service Account Token Creator на " + COPY_SA + " (IAM, поширення 2–7 хв)" : "") + (message ? ": " + message.replace(/ya29\.[A-Za-z0-9._-]+/g, "***") : ""));
  }
  let token = ""; try { token = t(JSON.parse(text)?.accessToken); } catch { /* */ }
  if (!token) throw new Error("generateAccessToken: у відповіді немає accessToken");
  return token;
}

/** Запобіжник: scope токена — рівно очікуваний (tokeninfo — офіційна кінцева точка Google OAuth2). */
export async function assertTokenScope(token, scope, fetchImpl = fetch) {
  const res = await fetchImpl("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(token));
  if (!res.ok) throw new Error("tokeninfo HTTP " + res.status + " — токен недійсний або прострочений");
  const info = await res.json();
  const scopes = t(info.scope).split(/\s+/).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== scope) throw new Error(`токен має не лише ${scope === READONLY ? "readonly" : "очікуваний"} scope (` + scopes.join(", ") + ") — відмова");
  const exp = Number(info.exp);
  return { scopes, expiresIn: Number.isFinite(exp) ? Math.max(0, Math.round(exp - Date.now() / 1000)) : null };
}
export const assertReadonlyToken = (token, fetchImpl = fetch) => assertTokenScope(token, READONLY, fetchImpl);

async function get(token, path, params = [], fetchImpl = fetch) {
  if (!path.startsWith(encodeURIComponent(TEST_SHEET_ID))) throw new Error("запит не до тестової копії — відмова");
  const qs = new URLSearchParams(params).toString();
  const res = await fetchImpl(API + path + (qs ? "?" + qs : ""), { method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    let status = ""; try { status = JSON.parse(text)?.error?.status || ""; } catch { /* */ }
    throw new Error(`Sheets API HTTP ${res.status} ${status}`.trim() + (res.status === 403 ? " — немає доступу (поділіться копією з " + COPY_SA + ") або вимкнено Sheets API в проєкті" : ""));
  }
  return JSON.parse(text);
}

export async function checkCopy({ token, xlsx = null, fetchImpl = fetch }) {
  const id = encodeURIComponent(TEST_SHEET_ID);
  const tok = await assertReadonlyToken(token, fetchImpl);
  const meta = await get(token, id, [["fields", "properties.title,sheets.properties(title,gridProperties(rowCount,columnCount))"]], fetchImpl);
  const title = t(meta.properties?.title);
  if (!/ТЕСТ/.test(title)) throw new Error("назва таблиці не містить «ТЕСТ» — відмова (очікувано «Інструменти — ТЕСТ нової системи»)");
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const present = Object.values(SHEETS).filter((s) => titles.includes(s));
  const ranges = present.flatMap((s) => [`${q(s)}!1:1`, `${q(s)}!A2:A`]);
  const vals = await get(token, id + "/values:batchGet", [...ranges.map((r) => ["ranges", r]), ["valueRenderOption", "UNFORMATTED_VALUE"], ["majorDimension", "ROWS"]], fetchImpl);
  const api = {};
  present.forEach((s, k) => {
    const header = (vals.valueRanges?.[2 * k]?.values?.[0] || []).map(t);
    const ids = (vals.valueRanges?.[2 * k + 1]?.values || []).map((r) => t(r?.[0])).filter(Boolean);
    api[s] = { header, ids };
  });
  const report = { at: new Date().toISOString(), title, token: { scopeReadonlyOnly: true, expiresInSec: tok.expiresIn }, requests: { tokeninfo: 1, get: 2, writes: 0 },
    sheets: titles.length, sheetTitles: titles, perSheet: Object.fromEntries(present.map((s) => [s, { columns: api[s].header.length, ids: api[s].ids.length, unique: new Set(api[s].ids).size }])) };
  if (xlsx) {
    const book = new Map(readXlsx(xlsx).sheets.map((s) => [s.name, s.values]));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    report.xlsx = {
      sheetsEqual: same([...book.keys()].sort(), [...titles].sort()),
      perSheet: Object.fromEntries(present.map((s) => {
        const v = book.get(s) || [[]];
        const hx = (v[0] || []).map(t), ix = v.slice(1).map((r) => t(r?.[0])).filter(Boolean);
        return [s, { headerEqual: same(hx, api[s].header), idsEqual: same([...ix].sort(), [...api[s].ids].sort()), xlsxIds: ix.length, apiIds: api[s].ids.length }];
      })),
    };
    report.ok = report.xlsx.sheetsEqual && Object.values(report.xlsx.perSheet).every((x) => x.headerEqual && x.idsEqual);
  } else report.ok = present.length === Object.values(SHEETS).length;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report;
  try {
    const token = await obtainToken();
    report = await checkCopy({ token, xlsx: arg("xlsx", null) });
  } catch (e) {
    process.stderr.write("ВІДМОВА / ПОМИЛКА: " + t(e?.message || e).replace(/ya29\.[A-Za-z0-9._-]+/g, "***") + "\n");
    process.exit(2);
  }
  const text = JSON.stringify(report, null, 2);
  if (/ya29\./.test(text) || /\b\d{10}\b/.test(text)) { process.stderr.write("ЗАХИСТ ВІД ВИТОКУ: вивід заблоковано\n"); process.exit(2); }
  if (arg("out")) fs.writeFileSync(arg("out"), text);
  process.stdout.write(text + "\n");
  process.exit(report.ok ? 0 : 1);
}
