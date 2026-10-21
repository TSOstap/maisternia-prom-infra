/** PoC C3: збирає одну версію Worker із синтетичного YML — частини ≤24 MiB + manifest.json + конфіг wrangler.
 *  node poc/c3-assets/build.mjs --src=<yml> --version=<мітка> [--out=poc/c3-assets/.build] [--corrupt=missing|size|byte]
 *  Ключ доступу береться з локального файлу поза репозиторієм (створюється, якщо немає); у конфіг іде лише його SHA-256.
 *  --corrupt навмисно псує збірку ПІСЛЯ перевірки — лише для тестів захисту Worker і readback. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PART_BYTES = 24 * 1024 * 1024; // запас до ліміту 25 MiB на asset
export const SECRET_DIR = path.join(os.homedir(), ".mm-feed-poc");
const here = path.dirname(fileURLToPath(import.meta.url));

export function feedKey() {
  const file = path.join(SECRET_DIR, "feed-key.txt");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(SECRET_DIR, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64url"), { mode: 0o600 });
  }
  return fs.readFileSync(file, "utf8").trim();
}

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Перевірка збірки перед завантаженням: усі частини є, розміри й SHA-256 склеєного файлу = маніфесту. */
export function verifyBuild(outDir, feed = "main") {
  const dir = path.join(outDir, "public", "_feed", feed);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const h = crypto.createHash("sha256");
  let total = 0;
  for (const p of m.parts) {
    const f = path.join(dir, p.file);
    if (!fs.existsSync(f)) return { ok: false, reason: `немає частини ${p.file}` };
    const b = fs.readFileSync(f);
    if (b.length !== p.bytes) return { ok: false, reason: `розмір частини ${p.file}: ${b.length} ≠ ${p.bytes}` };
    if (b.length > 25 * 1024 * 1024) return { ok: false, reason: `частина ${p.file} > 25 MiB` };
    h.update(b);
    total += b.length;
  }
  const digest = h.digest("hex");
  if (total !== m.bytes) return { ok: false, reason: `сума частин ${total} ≠ ${m.bytes}` };
  if (digest !== m.sha256) return { ok: false, reason: "SHA-256 склеєного файлу ≠ маніфесту" };
  return { ok: true, manifest: m };
}

export function build({ src, version, out = path.join(here, ".build"), corrupt = "", feed = "main", partBytes = PART_BYTES, keySha256 = null }) {
  const data = fs.readFileSync(src);
  if (!/^<\?xml/.test(data.subarray(0, 10).toString("utf8"))) throw new Error("джерело не схоже на XML");
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
  const manifest = { feed, version, sha256: digest, bytes: data.length, builtAt: new Date().toISOString(), parts };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
  const config = {
    name: "mm-feed-poc",
    main: path.relative(out, path.join(here, "src", "worker.js")).split(path.sep).join("/"),
    compatibility_date: "2026-10-01",
    workers_dev: true,
    preview_urls: false,
    assets: { directory: "./public", binding: "ASSETS", run_worker_first: true },
    vars: { FEEDS: feed, FEED_KEY_SHA256: keySha256 ?? sha256(feedKey()) },
    observability: { enabled: false },
  };
  fs.writeFileSync(path.join(out, "wrangler.json"), JSON.stringify(config, null, 1));
  const check = verifyBuild(out, feed);
  if (!check.ok) throw new Error("збірка не пройшла перевірку: " + check.reason);
  if (corrupt) {
    const last = path.join(dir, parts.at(-1).file);
    if (corrupt === "missing") fs.rmSync(last);
    else if (corrupt === "size") fs.truncateSync(last, parts.at(-1).bytes - 1);
    else if (corrupt === "byte") { const f = path.join(dir, parts[0].file); const b = fs.readFileSync(f); b[b.length >> 1] ^= 0x01; fs.writeFileSync(f, b); }
    else throw new Error("невідомий --corrupt");
  }
  return { out, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
  const r = build({ src: arg("src"), version: arg("version", "A"), out: arg("out", path.join(here, ".build")), corrupt: arg("corrupt", "") });
  console.log(JSON.stringify({ out: r.out, version: r.manifest.version, bytes: r.manifest.bytes, parts: r.manifest.parts.map((p) => p.bytes), sha256: r.manifest.sha256.slice(0, 12) + "…" }));
}
