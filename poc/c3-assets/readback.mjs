/** PoC C3: readback — завантажує фід за публічною адресою і звіряє SHA-256 і розмір з очікуваними.
 *  node poc/c3-assets/readback.mjs --base=<https://…> [--expect=<build-dir>] [--n=1] [--parallel=1] [--slowMs=0] [--gzip]
 *  Ключ доступу читається з ~/.mm-feed-poc/feed-key.txt і НЕ виводиться; у виводі адреса без ключа. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { feedKey } from "./build.mjs";

export async function readback({ base, feed = "main", expect = null, slowMs = 0, gzip = false, method = "GET", key = feedKey(), path: p = null }) {
  const url = new URL(p ?? `/feeds/${feed}.xml`, base);
  url.searchParams.set("key", key);
  const started = Date.now();
  // undici розпаковує gzip/br сам; без --gzip просимо identity, щоб виміряти «сирий» потік.
  const r = await fetch(url, { method, headers: { "accept-encoding": gzip ? "gzip, br" : "identity" } });
  const h = crypto.createHash("sha256");
  let bytes = 0;
  let firstByteMs = null;
  let streamError = null;
  if (r.body) {
    try {
      for await (const chunk of r.body) {
        if (firstByteMs === null) firstByteMs = Date.now() - started;
        h.update(chunk);
        bytes += chunk.length;
        if (slowMs) await new Promise((res) => setTimeout(res, slowMs));
      }
    } catch (e) {
      streamError = String(e?.cause?.code || e?.message || e).slice(0, 120);
    }
  }
  const sha = h.digest("hex");
  const res = {
    status: r.status, bytes, ms: Date.now() - started, firstByteMs, streamError,
    sha256: sha.slice(0, 12) + "…", version: r.headers.get("x-feed-version"), contentLength: r.headers.get("content-length"),
    contentEncoding: r.headers.get("content-encoding"), contentType: r.headers.get("content-type"),
  };
  if (expect) res.match = r.status === 200 && !streamError && sha === expect.sha256 && bytes === expect.bytes;
  res.fullSha = sha; // для внутрішніх порівнянь; у звіт не виводиться (див. CLI нижче)
  return res;
}

export const manifestOf = (buildDir, feed = "main") => JSON.parse(fs.readFileSync(path.join(buildDir, "public", "_feed", feed, "manifest.json"), "utf8"));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
  const expect = arg("expect") ? manifestOf(arg("expect")) : null;
  const n = Number(arg("n", 1)), par = Number(arg("parallel", 1));
  const out = [];
  for (let i = 0; i < n; i += par) {
    const batch = await Promise.all(Array.from({ length: Math.min(par, n - i) }, () =>
      readback({ base: arg("base"), expect, slowMs: Number(arg("slowMs", 0)), gzip: process.argv.includes("--gzip"), method: arg("method", "GET") })));
    out.push(...batch);
  }
  for (const r of out) delete r.fullSha;
  console.log(JSON.stringify(out.length === 1 ? out[0] : { n: out.length, ok: out.filter((r) => r.match !== false && r.status === 200).length, statuses: [...new Set(out.map((r) => r.status))], msAvg: Math.round(out.reduce((s, r) => s + r.ms, 0) / out.length), sample: out[0] }));
}
