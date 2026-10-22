/** C3: публікація YML у Cloudflare Workers Free (Static Assets). Зараз — ЛИШЕ СИНТЕТИКА (погоджено 22.10.2026).
 *
 *  node tools/cf-publish.mjs --synthetic=5121 [--scenario=normal|corrupt-byte|missing-part|upload-fail] [--label=…]
 *
 *  Облікові дані: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, MM_FEED_KEY — зі змінних середовища (GitHub Secrets)
 *  або локально з файлу MM_CF_ENV і ~/.mm-feed-poc/feed-key.txt. Жодне значення не виводиться: вивід проходить scrub().
 *  Сценарії, крім normal, — навмисні збої для перевірки захисту (обхід перевірки збірки дозволено лише для синтетики).
 *  Коди виходу: 0 — очікуваний результат; 1 — неочікуваний (живу версію збережено або відкочено); 2 — CRITICAL. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVersion, checkYml, publishVersion, sha256, feedStatus, MAX_PARTS, ASSET_LIMIT } from "../src/publish/cf-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POC = path.join(root, "poc", "c3-assets");
const WORKER_NAME = "mm-feed-poc";
const WORKER_MAIN = path.join(POC, "src", "worker.js");
const WRANGLER = path.join(POC, "node_modules", "wrangler", "bin", "wrangler.js");
const LIMITS = { workersRequestsPerDay: 100_000, stopAtShare: 0.8, actionsMinutesPerMonth: 2000, promRecommendedBytes: 180_000_000 };
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const started = Date.now();

// ---------- облікові дані (без виводу) ----------
function creds() {
  const env = { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, MM_FEED_KEY: process.env.MM_FEED_KEY };
  if ((!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) && process.env.MM_CF_ENV) {
    const t = fs.readFileSync(process.env.MM_CF_ENV, "utf8");
    for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) env[k] ||= new RegExp(`^\\s*${k}\\s*=\\s*(\\S+)\\s*$`, "m").exec(t)?.[1];
  }
  if (!env.MM_FEED_KEY) {
    const f = path.join(os.homedir(), ".mm-feed-poc", "feed-key.txt");
    if (fs.existsSync(f)) env.MM_FEED_KEY = fs.readFileSync(f, "utf8").trim();
  }
  for (const [k, v] of Object.entries(env)) if (!v) throw new Error(`немає ${k} (GitHub Secret або локальний файл)`);
  if (!/^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID)) throw new Error("CLOUDFLARE_ACCOUNT_ID не схожий на ID акаунта");
  if (env.MM_FEED_KEY.length < 32) throw new Error("MM_FEED_KEY закороткий (потрібно ≥32 символи)");
  return env;
}
const C = creds();
let SUBDOMAIN = null;
const scrub = (s) => {
  let t = String(s);
  for (const v of [C.CLOUDFLARE_API_TOKEN, C.CLOUDFLARE_ACCOUNT_ID, C.MM_FEED_KEY, SUBDOMAIN]) if (v) t = t.split(v).join("***");
  return t.replace(/\x1b\[[0-9;]*m/g, "").replace(/\b[0-9a-f]{32}\b/g, "<hex32>").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>").replace(/[?&]key=[^\s&"]+/g, "?key=***");
};
const log = (e) => console.log(scrub(JSON.stringify({ t: Math.round((Date.now() - started) / 1000), ...e })));

function wrangler(args) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: POC, encoding: "utf8", maxBuffer: 1 << 26,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: C.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: C.CLOUDFLARE_ACCOUNT_ID, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) {
    log({ wrangler: args.slice(0, 2).join(" "), code: r.status, tail: out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => /ERROR|error|code:/i.test(l)).slice(-4) });
    if (/payment|billing|subscription|credit card|paid plan|upgrade your plan/i.test(out)) throw new Error("Cloudflare вимагає оплату/платний план — СТОП за умовою власника");
  }
  return { code: r.status, out, ms: Date.now() - t };
}
async function cfApi(p, init = {}) {
  const r = await fetch("https://api.cloudflare.com/client/v4" + p, { ...init, headers: { authorization: `Bearer ${C.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" } });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

// ---------- квоти ----------
async function workerRequestsToday() {
  const day = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
  const query = `query($a:String!,$f:Time!,$t:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:50,filter:{datetime_geq:$f,datetime_leq:$t}){sum{requests} dimensions{scriptName}}}}}`;
  const { status, j } = await cfApi("/graphql", { method: "POST", body: JSON.stringify({ query, variables: { a: C.CLOUDFLARE_ACCOUNT_ID, f: day, t: new Date().toISOString() } }) });
  const rows = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (status !== 200 || !rows) return { known: false };
  const all = rows.reduce((s, r) => s + r.sum.requests, 0); // ліміт Free — на весь акаунт, не на один Worker
  return { known: true, accountRequestsToday: all, thisWorker: rows.filter((r) => r.dimensions.scriptName === WORKER_NAME).reduce((s, r) => s + r.sum.requests, 0) };
}

// ---------- синтетика ----------
function synthetic(n, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [path.join(root, "tools", "scale-test.mjs"), `--sizes=${n}`, `--out=${dir}`], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error("генерація синтетики: " + (r.stderr || "").slice(-300));
  const vdir = path.join(dir, String(n), "store", "feeds", "main", "versions");
  const f = fs.readdirSync(vdir).find((x) => x.endsWith(".xml"));
  if (!f) throw new Error("синтетичний YML не створено");
  return path.join(vdir, f);
}

/** Лише для сценарію upload-fail: склеює дві частини в одну > 25 MiB — Cloudflare має відхилити завантаження. */
function oversizePart(out) {
  const dir = path.join(out, "public", "_feed", "main");
  const mf = path.join(dir, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  if (m.parts.length < 2) throw new Error("для upload-fail потрібно ≥2 частини");
  const [a, b] = m.parts;
  const joined = Buffer.concat([fs.readFileSync(path.join(dir, a.file)), fs.readFileSync(path.join(dir, b.file))]);
  fs.writeFileSync(path.join(dir, a.file), joined);
  fs.rmSync(path.join(dir, b.file));
  m.parts = [{ file: a.file, bytes: joined.length }, ...m.parts.slice(2)];
  fs.writeFileSync(mf, JSON.stringify(m, null, 1));
  return joined.length;
}

// ---------- основний сценарій ----------
const scenario = arg("scenario", "normal");
const EXPECT = { normal: "PUBLISHED", "corrupt-byte": "ROLLED_BACK", "missing-part": "ROLLED_BACK", "upload-fail": "UPLOAD_FAILED" };
if (!EXPECT[scenario]) throw new Error("невідомий сценарій " + scenario);
const products = Number(arg("synthetic", 5121));
if (!Number.isInteger(products) || products < 100 || products > 60000) throw new Error("--synthetic: ціле 100…60000");
const runTag = process.env.GITHUB_RUN_NUMBER ? `r${process.env.GITHUB_RUN_NUMBER}-${process.env.GITHUB_RUN_ATTEMPT || 1}` : `l${new Date().toISOString().replace(/\D/g, "").slice(2, 12)}`;
const label = arg("label", `${runTag}-${scenario}`).toLowerCase();
const work = path.join(root, ".data", "cf-publish", label);
const summary = { scenario, label, products, expected: EXPECT[scenario] };

try {
  const sub = await cfApi(`/accounts/${C.CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`);
  SUBDOMAIN = sub.j.result?.subdomain;
  if (sub.status !== 200 || !SUBDOMAIN) throw new Error(`немає доступу до Workers API (HTTP ${sub.status})`);
  const base = `https://${WORKER_NAME}.${SUBDOMAIN}.workers.dev`;

  const quota = await workerRequestsToday();
  summary.quota = { ...quota, limit: LIMITS.workersRequestsPerDay };
  log({ step: "quota", ...summary.quota });
  if (quota.known && quota.accountRequestsToday >= LIMITS.workersRequestsPerDay * LIMITS.stopAtShare) throw new Error("запити Workers сьогодні ≥80% ліміту Free — публікацію зупинено");

  const t0 = Date.now();
  const src = synthetic(products, path.join(work, "synth"));
  const yml = await checkYml(src, { minOffers: 1, maxBytes: MAX_PARTS * 24 * 1024 * 1024 });
  summary.yml = { offers: yml.count, bytes: yml.bytes, sha256: yml.sha256.slice(0, 12) + "…", genAndCheckMs: Date.now() - t0, overPromRecommendation: yml.bytes > LIMITS.promRecommendedBytes };
  log({ step: "yml", ...summary.yml });

  // Захист від масового зникнення: нова кількість offer не менша за 50% активної версії.
  const live = await feedStatus(fetch, base, C.MM_FEED_KEY).catch(() => ({}));
  if (live.offers && yml.count < live.offers * 0.5) throw new Error(`offer ${yml.count} < 50% активної версії (${live.offers}) — підозра на збій, публікацію зупинено`);

  const out = path.join(work, "build");
  const manifest = buildVersion({ src, out, version: label, keySha256: sha256(C.MM_FEED_KEY), workerMain: WORKER_MAIN, workerName: WORKER_NAME, offers: yml.count });
  if (manifest.sha256 !== yml.sha256) throw new Error("SHA збірки ≠ SHA перевіреного YML");
  summary.build = { parts: manifest.parts.length, maxPart: Math.max(...manifest.parts.map((p) => p.bytes)), assetLimit: ASSET_LIMIT, maxParts: MAX_PARTS };
  log({ step: "build", ...summary.build });

  let bypassGate = false;
  if (scenario !== "normal") {
    bypassGate = true; // лише синтетика: навмисний збій, щоб перевірити наступні рівні захисту
    if (scenario === "corrupt-byte") (await import("../poc/c3-assets/build.mjs")).corruptBuild(out, "byte");
    if (scenario === "missing-part") (await import("../poc/c3-assets/build.mjs")).corruptBuild(out, "missing");
    if (scenario === "upload-fail") summary.oversizePart = oversizePart(out);
  }

  const res = await publishVersion({ wrangler, fetch, log }, { buildDir: out, label, base, key: C.MM_FEED_KEY, workerName: WORKER_NAME, parallel: 5, bypassGate });
  Object.assign(summary, { state: res.state, failure: res.failure ?? null, previous: res.previous, steps: res.steps, liveUnchanged: res.liveUnchanged });
  const vl = wrangler(["versions", "list", "--name", WORKER_NAME, "--json"]);
  try { summary.versionsStored = JSON.parse(vl.out.slice(vl.out.indexOf("["))).length; } catch { summary.versionsStored = null; }
} catch (e) {
  summary.state = summary.state || "ERROR";
  summary.error = scrub(e.message).slice(0, 300);
}
summary.elapsedSec = Math.round((Date.now() - started) / 1000);
summary.actionsMinutesBilled = Math.ceil(summary.elapsedSec / 60); // хвилини округлюються вгору на job; без урахування checkout/npm ci
const passed = summary.state === summary.expected && (scenario !== "upload-fail" || summary.liveUnchanged === true);
summary.result = passed ? "PASS" : summary.state === "CRITICAL" ? "CRITICAL" : "FAIL";
fs.rmSync(work, { recursive: true, force: true }); // синтетика й збірки не лишаються на диску runner/ПК

const text = scrub(JSON.stringify(summary, null, 1));
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rb = summary.steps?.readback || [];
  const md = [
    `## C3 публікація (синтетика): ${summary.result}`,
    "",
    `| Показник | Значення |`, `|---|---|`,
    `| Сценарій / очікувано / фактично | ${scenario} / ${summary.expected} / ${summary.state} |`,
    `| YML | ${summary.yml?.offers ?? "—"} offer, ${summary.yml?.bytes ?? "—"} Б, частин ${summary.build?.parts ?? "—"} |`,
    `| Попередня → нова версія | ${summary.previous?.version ?? "—"} → ${label} |`,
    `| Upload / deploy, мс | ${summary.steps?.upload?.ms ?? "—"} / ${summary.steps?.deploy?.ms ?? "—"} |`,
    `| Перемикання, мс | ${summary.steps?.switch?.ms ?? "—"} |`,
    `| Readback (одночасних) | ${rb.filter((r) => r.match).length}/${rb.length} SHA-256 збіг |`,
    `| Відкат | ${summary.steps?.rollback ? (summary.steps.rollback.readback?.match ? "так, SHA попередньої збігся" : "НЕВДАЛИЙ") : "не потрібен"} |`,
    `| Запити Workers сьогодні (акаунт) | ${summary.quota?.accountRequestsToday ?? "?"} / ${LIMITS.workersRequestsPerDay} |`,
    `| Збережено версій Worker | ${summary.versionsStored ?? "?"} (відкат можливий до 100 останніх) |`,
    `| Час скрипта | ${summary.elapsedSec} с |`,
    summary.error ? `| Помилка | ${summary.error} |` : "",
  ].join("\n");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, scrub(md) + "\n");
}
process.exit(passed ? 0 : summary.result === "CRITICAL" ? 2 : 1);
