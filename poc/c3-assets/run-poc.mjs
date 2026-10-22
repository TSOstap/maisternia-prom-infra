/** PoC C3 у Cloudflare (Workers Free, ЛИШЕ синтетика). Кожна фаза — окремий запуск: node poc/c3-assets/run-poc.mjs <фаза>
 *  Облікові дані: файл із MM_CF_ENV (або ~/.mm-feed-poc/cloudflare.env) (CLOUDFLARE_ACCOUNT_ID=…, CLOUDFLARE_API_TOKEN=…) — поза репозиторієм.
 *  Токен і ID акаунта лише передаються дочірньому wrangler / в заголовок GraphQL і вирізаються з будь-якого виводу.
 *  Стан (адреса workers.dev, ID версій) — ~/.mm-feed-poc/state.json, теж поза репозиторієм. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_DIR, verifyBuild } from "./build.mjs";
import { readback, manifestOf } from "./readback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = "mm-feed-poc";
const STATE = path.join(SECRET_DIR, "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function creds() {
  const file = process.env.MM_CF_ENV || path.join(SECRET_DIR, "cloudflare.env"); // шлях до файлу власника; вміст не виводиться
  if (!fs.existsSync(file)) throw new Error(`немає файлу облікових даних (${file}) — див. інструкцію власнику`);
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN)\s*=\s*(\S+)\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  if (!/^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || "")) throw new Error("CLOUDFLARE_ACCOUNT_ID відсутній або не схожий на ID акаунта (32 hex)");
  if (!env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN.length < 30) throw new Error("CLOUDFLARE_API_TOKEN відсутній");
  return env;
}
const C = creds();
const scrub = (s) => String(s).split(C.CLOUDFLARE_API_TOKEN).join("***").split(C.CLOUDFLARE_ACCOUNT_ID).join("<account>")
  .replace(/\b[0-9a-f]{32}\b/g, "<hex32>").replace(/[?&]key=[^\s&"]+/g, "?key=***").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>");
const state = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { versions: {}, log: [] });
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));

function wrangler(args, { cwd = here } = {}) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, "node_modules", "wrangler", "bin", "wrangler.js"), ...args], {
    cwd, encoding: "utf8", maxBuffer: 1 << 26,
    env: { ...process.env, ...C, WRANGLER_SEND_METRICS: "false", CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  return { code: r.status, out, clean: scrub(out), ms: Date.now() - t };
}
function must(res, what) {
  if (res.code !== 0) {
    console.log(res.clean.split("\n").slice(-25).join("\n"));
    if (/payment|billing|subscription|credit card|upgrade your plan|paid plan/i.test(res.out)) console.log("СТОП: Cloudflare вимагає оплату/білінг — за умовами власника зупиняюсь.");
    throw new Error(`${what}: wrangler завершився з кодом ${res.code}`);
  }
  return res;
}
const buildDir = (label) => path.join(here, `.build-${label}`);

async function statusJson(base) {
  const u = new URL("/feeds/main/status", base);
  u.searchParams.set("key", (await import("./build.mjs")).feedKey());
  const r = await fetch(u, { headers: { "cache-control": "no-cache" } });
  return r.ok ? r.json() : { status: r.status };
}
/** Чекає, доки публічна адреса стабільно (3 рази поспіль) віддає потрібну версію. */
async function waitFor(base, version, limitMs = 180000) {
  const t = Date.now();
  let streak = 0, seen = [];
  while (Date.now() - t < limitMs) {
    const s = await statusJson(base).catch(() => ({}));
    seen.push(s.version || s.status);
    streak = s.version === version ? streak + 1 : 0;
    if (streak >= 3) return { ms: Date.now() - t, polls: seen.length, seen: [...new Set(seen)] };
    await sleep(1000);
  }
  throw new Error(`версія ${version} не стала активною за ${limitMs} мс; бачили: ${[...new Set(seen)].join(",")}`);
}
async function check(base, label, extra = {}) {
  const r = await readback({ base, expect: manifestOf(buildDir(label)), ...extra });
  delete r.fullSha;
  return r;
}
/** Публікатор: upload → deploy → readback; при невдачі readback — відкат на останню справну версію. */
async function publish(label, s) {
  const v = verifyBuild(buildDir(label));
  const gate = v.ok ? "PASS" : "FAIL: " + v.reason;
  if (!v.ok && !label.startsWith("X-")) throw new Error("перевірка перед деплоєм: " + v.reason);
  const up = must(wrangler(["versions", "upload", "-c", path.join(buildDir(label), "wrangler.json"), "--tag", label.toLowerCase(), "--message", `poc ${label}`]), "upload " + label);
  const id = /Worker Version ID:\s*([0-9a-f-]{36})/i.exec(up.out)?.[1];
  if (!id) throw new Error("не знайшов Version ID у виводі upload");
  const before = await statusJson(s.url);
  const dep = must(wrangler(["versions", "deploy", `${id}@100%`, "-c", path.join(buildDir(label), "wrangler.json"), "--yes", "--message", `poc ${label}`]), "deploy " + label);
  s.versions[label] = id;
  const switched = await waitFor(s.url, label).catch((e) => ({ error: e.message }));
  const rb = await check(s.url, label);
  const ok = rb.status === 200 && rb.match === true;
  let rollback = null;
  if (!ok) {
    const good = s.lastGood;
    const rr = must(wrangler(["rollback", s.versions[good], "--name", NAME, "--yes", "--message", `poc авто-відкат після невдалого readback ${label}`]), "rollback");
    const back = await waitFor(s.url, good).catch((e) => ({ error: e.message }));
    rollback = { to: good, wranglerMs: rr.ms, switch: back, readback: await check(s.url, good) };
  } else s.lastGood = label;
  const res = { label, preDeployGate: gate, uploadMs: up.ms, deployMs: dep.ms, liveBefore: before.version, switch: switched, readback: rb, ok, rollback };
  s.log.push({ at: new Date().toISOString(), ...res });
  save(s);
  return res;
}

const phase = process.argv[2];
const s = state();
const out = {};
if (phase === "auth") {
  // Перевірка токена без створення ресурсів: список версій неіснуючого Worker → очікуємо «не знайдено», а не помилку доступу.
  const r = wrangler(["versions", "list", "--name", NAME, "--json"]);
  out.code = r.code;
  out.tail = r.clean.split("\n").filter(Boolean).slice(-6);
} else if (phase === "deploy-a") {
  if (!verifyBuild(buildDir("A")).ok) throw new Error("збірка A не пройшла перевірку");
  const r = must(wrangler(["deploy", "-c", path.join(buildDir("A"), "wrangler.json"), "--message", "poc A"]), "deploy A");
  s.url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(r.out)?.[0];
  s.versions.A = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(r.out)?.[1];
  s.lastGood = "A";
  save(s);
  out.deployMs = r.ms;
  out.url = s.url ? s.url.replace(/\/\/[^.]+\.([^.]+)\./, "//mm-feed-poc.<subdomain>.") : null;
  out.versionId = Boolean(s.versions.A);
  out.tail = r.clean.split("\n").filter(Boolean).slice(-8);
  if (s.url) { out.switch = await waitFor(s.url, "A"); out.readback = await check(s.url, "A"); }
} else if (phase === "load") {
  // Послідовні й паралельні завантаження поточної версії; окремо — з дозволеним стисненням.
  const label = s.lastGood;
  const seq = [];
  for (let i = 0; i < 10; i++) seq.push(await check(s.url, label));
  const par = await Promise.all(Array.from({ length: 5 }, () => check(s.url, label)));
  const gz = await check(s.url, label, { gzip: true });
  const head = await readback({ base: s.url, method: "HEAD" });
  const summary = (a) => ({ n: a.length, ok: a.filter((r) => r.match).length, msMin: Math.min(...a.map((r) => r.ms)), msMax: Math.max(...a.map((r) => r.ms)), firstByteMsMax: Math.max(...a.map((r) => r.firstByteMs ?? 0)) });
  Object.assign(out, { label, sequential: summary(seq), parallel5: summary(par), gzipAccepted: { match: gz.match, contentEncoding: gz.contentEncoding, ms: gz.ms }, head: { status: head.status, contentLength: head.contentLength } });
} else if (phase === "access") {
  const { feedKey } = await import("./build.mjs");
  const m = manifestOf(buildDir(s.lastGood));
  const probe = async (p, key) => { const r = await readback({ base: s.url, path: p, key }); return r.status; };
  Object.assign(out, {
    noKey: await probe("/feeds/main.xml", ""), wrongKey: await probe("/feeds/main.xml", "wrong-key-zzzzzzzzzzzzzzzzzzzzzzzzzzzz"),
    partDirect: await probe(`/_feed/main/${m.parts[0].file}`, feedKey()), manifestDirect: await probe("/_feed/main/manifest.json", feedKey()),
    otherFeed: await probe("/feeds/other.xml", feedKey()), root: await probe("/", ""),
    httpWithKey: await fetch(s.url.replace("https://", "http://") + "/feeds/main.xml?key=" + encodeURIComponent(feedKey()), { redirect: "manual" }).then((r) => { r.body?.cancel(); return r.status; }).catch((e) => String(e.cause?.code || e)),
  });
} else if (phase === "atomic") {
  // Версію B завантажено, але не активовано → живою лишається попередня. Повільне завантаження старої версії
  // під час перемикання має завершитися ЦІЛИМ файлом старої версії (без змішування частин).
  const from = s.lastGood, to = process.argv[3] || "B";
  const up = must(wrangler(["versions", "upload", "-c", path.join(buildDir(to), "wrangler.json"), "--tag", to.toLowerCase(), "--message", `poc ${to}`]), "upload " + to);
  const id = /Worker Version ID:\s*([0-9a-f-]{36})/i.exec(up.out)?.[1];
  s.versions[to] = id; save(s);
  const afterUpload = await statusJson(s.url);
  const slow = check(s.url, from, { slowMs: 15 }); // ~49 МБ дрібними порціями: розтягується на десятки секунд
  await sleep(4000);
  const dep = must(wrangler(["versions", "deploy", `${id}@100%`, "-c", path.join(buildDir(to), "wrangler.json"), "--yes", "--message", `poc ${to}`]), "deploy " + to);
  const sw = await waitFor(s.url, to);
  const slowRes = await slow;
  const fresh = await check(s.url, to);
  s.lastGood = to; save(s);
  Object.assign(out, { from, to, uploadMs: up.ms, liveAfterUploadOnly: afterUpload.version, deployMs: dep.ms, switch: sw, slowDownloadStartedBefore: { ...slowRes, wholeOldVersion: slowRes.match }, freshAfterSwitch: fresh });
} else if (phase === "rollback") {
  const to = process.argv[3];
  const rr = must(wrangler(["rollback", s.versions[to], "--name", NAME, "--yes", "--message", `poc відкат на ${to}`]), "rollback");
  const sw = await waitFor(s.url, to);
  s.lastGood = to; save(s);
  Object.assign(out, { to, wranglerMs: rr.ms, switch: sw, readback: await check(s.url, to) });
} else if (phase === "publish") {
  Object.assign(out, await publish(process.argv[3], s));
} else if (phase === "versions") {
  const r = must(wrangler(["versions", "list", "--name", NAME, "--json"]), "versions list");
  const list = JSON.parse(r.out.slice(r.out.indexOf("[")));
  const d = must(wrangler(["deployments", "status", "--name", NAME, "--json"]), "deployments status");
  Object.assign(out, { versions: list.length, tags: list.map((v) => v.annotations?.["workers/tag"]).filter(Boolean), active: scrub(d.out.slice(d.out.indexOf("{"))).slice(0, 400) });
} else if (phase === "analytics") {
  const since = process.argv[3] || new Date(Date.now() - 6 * 3600e3).toISOString();
  const query = `query($acc: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $acc}) {
    workersInvocationsAdaptive(limit: 100, filter: {scriptName: "${NAME}", datetime_geq: $from, datetime_leq: $to}) {
      sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 cpuTimeP999 wallTimeP50 wallTimeP99 } max { cpuTime wallTime } dimensions { status scriptVersion } } } } }`;
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { authorization: `Bearer ${C.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { acc: C.CLOUDFLARE_ACCOUNT_ID, from: since, to: new Date().toISOString() } }),
  });
  const j = await r.json();
  out.httpStatus = r.status;
  out.errors = j.errors ? scrub(JSON.stringify(j.errors)).slice(0, 600) : null;
  const rows = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  out.rows = rows.map((x) => ({ ...x, dimensions: { ...x.dimensions, scriptVersion: x.dimensions.scriptVersion ? Object.entries(s.versions).find(([, id]) => id === x.dimensions.scriptVersion)?.[0] || "?" : null } }));
} else {
  console.log("фази: auth | deploy-a | access | load | atomic <label> | publish <label> | rollback <label> | versions | analytics [since]");
  process.exit(2);
}
console.log(scrub(JSON.stringify(out, null, 1)));
