/** Публікація YML у Cloudflare Workers Static Assets (етап C3, Workers Free, без R2).
 *
 *  Версія = код Worker + частини фіду ≤24 MiB + manifest.json. Перемикання — деплой версії (атомарно для кожного запиту),
 *  адреса не змінюється. Порядок: перевірка YML → збірка → перевірка збірки → upload → deploy → readback SHA-256
 *  (+ одночасні запити) → при будь-якій невдачі після деплою — відкат на версію, що була активною до запуску.
 *
 *  Зовнішні дії (wrangler, HTTP) передаються функціями — логіку перевірено тестами без мережі (test/cf-publish.test.mjs). */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyYmlStream } from "../core/xml-verify.mjs";

export const PART_BYTES = 24 * 1024 * 1024; // запас до ліміту 25 MiB на asset
export const ASSET_LIMIT = 25 * 1024 * 1024;
export const MAX_PARTS = 48; // ASSETS.fetch рахується як subrequest: Free — 50 на запит (manifest + частини + запас)
export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Перевірка структури YML до публікації: коректний XML, корінь yml_catalog, унікальні числові ID offer, SHA-256. */
export async function checkYml(file, { minOffers = 1, maxBytes = Infinity } = {}) {
  const res = await verifyYmlStream(fs.createReadStream(file));
  if (res.count < minOffers) throw new Error(`YML: offer ${res.count} < мінімуму ${minOffers}`);
  if (res.bytes > maxBytes) throw new Error(`YML: ${res.bytes} Б > ліміту ${maxBytes}`);
  return res; // { count, idsSha, bytes, sha256 }
}

/** Збирає каталог версії: public/_feed/<feed>/{<sha12>.pN, manifest.json} + wrangler.json. */
export function buildVersion({ src, out, version, feed = "main", partBytes = PART_BYTES, keySha256, workerMain, workerName, offers = null, builtAt = new Date().toISOString() }) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(version)) throw new Error("невалідна мітка версії");
  if (partBytes > ASSET_LIMIT) throw new Error(`частина ${partBytes} Б > ліміту asset 25 MiB`);
  const data = fs.readFileSync(src);
  fs.rmSync(out, { recursive: true, force: true });
  const dir = path.join(out, "public", "_feed", feed);
  fs.mkdirSync(dir, { recursive: true });
  const digest = sha256(data);
  const parts = [];
  for (let off = 0, i = 0; off < data.length; off += partBytes, i++) {
    const chunk = data.subarray(off, Math.min(off + partBytes, data.length));
    const file = `${digest.slice(0, 12)}.p${i}`;
    fs.writeFileSync(path.join(dir, file), chunk);
    parts.push({ file, bytes: chunk.length });
  }
  if (parts.length > MAX_PARTS) throw new Error(`частин ${parts.length} > ${MAX_PARTS} (ліміт subrequests Workers Free)`);
  const manifest = { feed, version, sha256: digest, bytes: data.length, builtAt, parts, ...(offers != null ? { offers } : {}) };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
  const config = {
    name: workerName,
    main: path.relative(out, workerMain).split(path.sep).join("/"),
    compatibility_date: "2026-10-01",
    workers_dev: true,
    preview_urls: false,
    assets: { directory: "./public", binding: "ASSETS", run_worker_first: true },
    vars: { FEEDS: feed, FEED_KEY_SHA256: keySha256 },
    observability: { enabled: false },
  };
  fs.writeFileSync(path.join(out, "wrangler.json"), JSON.stringify(config, null, 1));
  return manifest;
}

/** Перевірка збірки перед завантаженням: усі частини є, розміри ≤ ліміту й = маніфесту, SHA-256 склеєного = маніфесту. */
export function verifyBuild(outDir, feed = "main") {
  const dir = path.join(outDir, "public", "_feed", feed);
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { return { ok: false, reason: "маніфест відсутній або пошкоджений" }; }
  const h = crypto.createHash("sha256");
  let total = 0;
  for (const p of m.parts) {
    const f = path.join(dir, p.file);
    if (!fs.existsSync(f)) return { ok: false, reason: `немає частини ${p.file}` };
    const b = fs.readFileSync(f);
    if (b.length !== p.bytes) return { ok: false, reason: `розмір частини ${p.file}: ${b.length} ≠ ${p.bytes}` };
    if (b.length > ASSET_LIMIT) return { ok: false, reason: `частина ${p.file} > 25 MiB` };
    h.update(b);
    total += b.length;
  }
  if (m.parts.length > MAX_PARTS) return { ok: false, reason: `частин ${m.parts.length} > ${MAX_PARTS}` };
  if (total !== m.bytes) return { ok: false, reason: `сума частин ${total} ≠ ${m.bytes}` };
  if (h.digest("hex") !== m.sha256) return { ok: false, reason: "SHA-256 склеєного файлу ≠ маніфесту" };
  return { ok: true, manifest: m };
}

/** Завантажує фід і рахує SHA-256 (потоком). fetchImpl — fetch-сумісна функція. */
export async function readbackFeed(fetchImpl, base, key, { feed = "main", gzip = false } = {}) {
  const url = new URL(`/feeds/${feed}.xml`, base);
  url.searchParams.set("key", key);
  const t = Date.now();
  const r = await fetchImpl(url, { headers: { "accept-encoding": gzip ? "gzip, br" : "identity" } });
  const h = crypto.createHash("sha256");
  let bytes = 0, streamError = null;
  try { if (r.body) for await (const c of r.body) { h.update(c); bytes += c.length; } } catch (e) { streamError = String(e?.cause?.code || e?.message || e).slice(0, 80); }
  return { status: r.status, bytes, sha256: h.digest("hex"), ms: Date.now() - t, streamError, version: r.headers.get("x-feed-version"), contentEncoding: r.headers.get("content-encoding") };
}

export async function feedStatus(fetchImpl, base, key, feed = "main") {
  const url = new URL(`/feeds/${feed}/status`, base);
  url.searchParams.set("key", key);
  const r = await fetchImpl(url, { headers: { "cache-control": "no-cache" } });
  if (!r.ok) return { status: r.status };
  return { status: r.status, ...(await r.json()) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Чекає, доки адреса стабільно (streak разів поспіль) віддає потрібну версію. */
export async function waitForVersion(fetchImpl, base, key, version, { limitMs = 120000, streak = 3, intervalMs = 1000 } = {}) {
  const t = Date.now();
  let ok = 0, polls = 0;
  while (Date.now() - t < limitMs) {
    const s = await feedStatus(fetchImpl, base, key).catch(() => ({}));
    polls++;
    ok = s.version === version ? ok + 1 : 0;
    if (ok >= streak) return { ok: true, ms: Date.now() - t, polls };
    await sleep(intervalMs);
  }
  return { ok: false, ms: Date.now() - t, polls };
}

/**
 * Повний цикл публікації вже зібраної версії.
 *  deps: { wrangler(args) → {code,out}, fetch, log(event) }
 *  opts: { buildDir, label, base, key, workerName, parallel=3, bypassGate=false (лише синтетичні тести) }
 * Повертає { state, ... }: PUBLISHED | GATE_FAILED | UPLOAD_FAILED | DEPLOY_FAILED+ROLLED_BACK | READBACK_FAILED+ROLLED_BACK | CRITICAL
 */
export async function publishVersion(deps, opts) {
  const { wrangler, fetch: fetchImpl, log = () => {} } = deps;
  const { buildDir, label, base, key, workerName, parallel = 3, bypassGate = false, waitOpts = {} } = opts;
  const cfg = path.join(buildDir, "wrangler.json");
  const res = { label, steps: {} };

  const gate = verifyBuild(buildDir);
  res.steps.gate = gate.ok ? "PASS" : "FAIL: " + gate.reason;
  log({ step: "gate", result: res.steps.gate });
  if (!gate.ok && !bypassGate) return { ...res, state: "GATE_FAILED" };
  const manifest = JSON.parse(fs.readFileSync(path.join(buildDir, "public", "_feed", "main", "manifest.json"), "utf8"));

  // Що зараз активне — щоб знати, куди відкочуватись.
  const before = await feedStatus(fetchImpl, base, key);
  const dep = await wrangler(["deployments", "status", "--name", workerName, "--json"]);
  let previousId = null;
  try { previousId = JSON.parse(dep.out.slice(dep.out.indexOf("{"))).versions?.[0]?.version_id || null; } catch { /* немає попереднього деплою */ }
  res.previous = { version: before.version || null, sha256: before.sha256 || null, offers: before.offers ?? null, hasId: Boolean(previousId) };
  log({ step: "before", version: res.previous.version });

  const up = await wrangler(["versions", "upload", "-c", cfg, "--tag", label, "--message", `publish ${label}`]);
  const id = /Worker Version ID:\s*([0-9a-f-]{36})/i.exec(up.out)?.[1];
  res.steps.upload = { code: up.code, ms: up.ms, ok: up.code === 0 && Boolean(id) };
  log({ step: "upload", ...res.steps.upload });
  if (!res.steps.upload.ok) {
    const now = await feedStatus(fetchImpl, base, key).catch(() => ({}));
    res.steps.liveAfterFailedUpload = now.version ?? null;
    return { ...res, state: "UPLOAD_FAILED", liveUnchanged: now.version === before.version };
  }

  const d = await wrangler(["versions", "deploy", `${id}@100%`, "-c", cfg, "--yes", "--message", `publish ${label}`]);
  res.steps.deploy = { code: d.code, ms: d.ms };
  log({ step: "deploy", ...res.steps.deploy });
  let failure = d.code !== 0 ? "DEPLOY_FAILED" : null;

  if (!failure) {
    res.steps.switch = await waitForVersion(fetchImpl, base, key, label, waitOpts);
    log({ step: "switch", ...res.steps.switch });
    if (!res.steps.switch.ok) failure = "SWITCH_TIMEOUT";
  }
  if (!failure) {
    const reads = await Promise.all(Array.from({ length: Math.max(1, parallel) }, () => readbackFeed(fetchImpl, base, key)));
    res.steps.readback = reads.map((r) => ({ status: r.status, bytes: r.bytes, ms: r.ms, match: r.status === 200 && !r.streamError && r.sha256 === manifest.sha256 && r.bytes === manifest.bytes, streamError: r.streamError, version: r.version }));
    log({ step: "readback", ok: res.steps.readback.filter((r) => r.match).length, of: reads.length });
    if (!res.steps.readback.every((r) => r.match)) failure = "READBACK_FAILED";
  }
  if (!failure) return { ...res, state: "PUBLISHED", versionId: id, manifest: { sha256: manifest.sha256, bytes: manifest.bytes, parts: manifest.parts.length, offers: manifest.offers ?? null } };

  // Відкат на версію, що була активна до запуску.
  if (!previousId) return { ...res, state: "CRITICAL", failure, reason: "немає попередньої версії для відкату" };
  const rb = await wrangler(["rollback", previousId, "--name", workerName, "--yes", "--message", `авто-відкат: ${failure} ${label}`]);
  const back = rb.code === 0 ? await waitForVersion(fetchImpl, base, key, res.previous.version, waitOpts) : { ok: false };
  let check = null;
  if (back.ok) {
    const r = await readbackFeed(fetchImpl, base, key);
    check = { status: r.status, match: r.status === 200 && r.sha256 === res.previous.sha256, version: r.version, ms: r.ms };
  }
  res.steps.rollback = { code: rb.code, ms: rb.ms, switch: back, readback: check };
  log({ step: "rollback", ok: Boolean(check?.match) });
  return { ...res, state: check?.match ? "ROLLED_BACK" : "CRITICAL", failure };
}
