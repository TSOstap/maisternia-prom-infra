/** PoC C3: збирає одну версію Worker із синтетичного YML — обгортка над src/publish/cf-assets.mjs (спільна логіка з публікатором).
 *  node poc/c3-assets/build.mjs --src=<yml> --version=<мітка> [--out=poc/c3-assets/.build] [--corrupt=missing|size|byte]
 *  Ключ доступу береться з MM_FEED_KEY або локального файлу поза репозиторієм; у конфіг іде лише його SHA-256.
 *  --corrupt навмисно псує збірку ПІСЛЯ перевірки — лише для тестів захисту Worker і readback. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PART_BYTES, buildVersion, sha256, verifyBuild } from "../../src/publish/cf-assets.mjs";

export { PART_BYTES, sha256, verifyBuild };
export const SECRET_DIR = path.join(os.homedir(), ".mm-feed-poc");
export const WORKER_NAME = "mm-feed-poc";
const here = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_MAIN = path.join(here, "src", "worker.js");

export function feedKey() {
  if (process.env.MM_FEED_KEY) return process.env.MM_FEED_KEY.trim();
  const file = path.join(SECRET_DIR, "feed-key.txt");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(SECRET_DIR, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64url"), { mode: 0o600 });
  }
  return fs.readFileSync(file, "utf8").trim();
}

/** Псує готову збірку (лише тести захисту): missing — немає останньої частини, size — коротша на 1 Б, byte — підмінений байт. */
export function corruptBuild(out, kind, feed = "main") {
  const dir = path.join(out, "public", "_feed", feed);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const last = path.join(dir, m.parts.at(-1).file);
  if (kind === "missing") fs.rmSync(last);
  else if (kind === "size") fs.truncateSync(last, m.parts.at(-1).bytes - 1);
  else if (kind === "byte") { const f = path.join(dir, m.parts[0].file); const b = fs.readFileSync(f); b[b.length >> 1] ^= 0x01; fs.writeFileSync(f, b); }
  else throw new Error("невідомий вид пошкодження: " + kind);
}

export function build({ src, version, out = path.join(here, ".build"), corrupt = "", feed = "main", partBytes = PART_BYTES, keySha256 = null }) {
  if (!/^<\?xml/.test(fs.readFileSync(src).subarray(0, 10).toString("utf8"))) throw new Error("джерело не схоже на XML");
  buildVersion({ src, out, version: version.toLowerCase(), feed, partBytes, keySha256: keySha256 ?? sha256(feedKey()), workerMain: WORKER_MAIN, workerName: WORKER_NAME });
  // PoC використовував мітки у верхньому регістрі (A, B, X-…) — лишаємо їх у маніфесті.
  const mf = path.join(out, "public", "_feed", feed, "manifest.json");
  const manifest = { ...JSON.parse(fs.readFileSync(mf, "utf8")), version };
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 1));
  const check = verifyBuild(out, feed);
  if (!check.ok) throw new Error("збірка не пройшла перевірку: " + check.reason);
  if (corrupt) corruptBuild(out, corrupt, feed);
  return { out, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
  const r = build({ src: arg("src"), version: arg("version", "A"), out: arg("out", path.join(here, ".build")), corrupt: arg("corrupt", "") });
  console.log(JSON.stringify({ out: r.out, version: r.manifest.version, bytes: r.manifest.bytes, parts: r.manifest.parts.map((p) => p.bytes), sha256: r.manifest.sha256.slice(0, 12) + "…" }));
}
