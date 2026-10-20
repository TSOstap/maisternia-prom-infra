/** Масштабний тест на синтетиці: генерація → повний цикл update (shadow, локальне сховище) для кількох розмірів.
 *  Кожен розмір — окремий дочірній процес, щоб чесно виміряти пікову пам'ять (maxRSS).
 *  node tools/scale-test.mjs [--sizes=5121,10000,30000] [--out=.data/scale]
 *  Результат: <out>/results.json і таблиця в консолі. Це локальна машина, не GitHub runner — див. TESTS.md. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

if (process.argv.includes("--child")) {
  // Дочірній режим: один повний цикл update з виміром часу й пам'яті.
  const { LocalObjectStore } = await import("../src/storage/local.mjs");
  const { FileSupplierSource, NdjsonCatalogSource } = await import("../src/pipeline/sources.mjs");
  const { runUpdate } = await import("../src/pipeline/update.mjs");
  const dir = arg("dir");
  const config = JSON.parse(await fsp.readFile(path.join(root, "config", "default.json"), "utf8"));
  config.feeds[0].maximumBytes = 2_000_000_000; // для моделювання: ліміт Prom/R2 перевіряється окремо, не тут
  const store = new LocalObjectStore(path.join(dir, "store"));
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, "approved-main.json"), "utf8"));
  const started = Date.now();
  const report = await runUpdate({
    store, config, manifests: { main: manifest }, tmpDir: dir,
    catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(path.join(dir, "supplier.xml")),
  });
  const totalMs = Date.now() - started;
  const ru = process.resourceUsage();
  console.log(JSON.stringify({ report: { sync: report.sync?.state, syncError: report.sync?.error, feeds: report.feeds, timingsMs: report.timingsMs, usage: report.usage }, totalMs, maxRssMb: Math.round(ru.maxRSS / 1024) }));
  process.exit(0);
}

const sizes = arg("sizes", "5121,10000,30000").split(",").map(Number);
const out = path.resolve(arg("out", path.join(root, ".data", "scale")));
const results = [];
for (const n of sizes) {
  const dir = path.join(out, String(n));
  await fsp.rm(dir, { recursive: true, force: true });
  const gen = spawnSync(process.execPath, [path.join(root, "tools", "synth.mjs"), `--products=${n}`, "--new=25", `--out=${dir}`, "--seed=42"], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (gen.status !== 0) throw new Error("synth: " + gen.stderr);
  const run = spawnSync(process.execPath, [path.join(root, "tools", "scale-test.mjs"), "--child", `--dir=${dir}`], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error("run: " + run.stderr);
  const r = JSON.parse(run.stdout.trim().split("\n").at(-1));
  const feed = r.report.feeds[0] || {};
  let gzipBytes = null;
  const versions = path.join(dir, "store", "feeds", "main", "versions");
  if (fs.existsSync(versions)) {
    const file = path.join(versions, fs.readdirSync(versions).find((f) => f.endsWith(".xml") && !f.endsWith(".meta")));
    let size = 0;
    const counter = new (await import("node:stream")).Writable({ write(c, _e, cb) { size += c.length; cb(); } });
    await pipeline(fs.createReadStream(file), zlib.createGzip({ level: 9 }), counter);
    gzipBytes = size;
  }
  const row = {
    products: n, sync: r.report.sync, syncError: r.report.syncError, feed: feed.state, error: feed.error,
    ymlBytes: feed.bytes, ymlMB: feed.bytes ? +(feed.bytes / 1e6).toFixed(1) : null, bytesPerOffer: feed.bytes ? Math.round(feed.bytes / n) : null,
    gzipMB: gzipBytes ? +(gzipBytes / 1e6).toFixed(1) : null, totalSec: +(r.totalMs / 1000).toFixed(1), maxRssMb: r.maxRssMb, timingsMs: r.report.timingsMs,
    r2Ops: { classA: r.report.usage?.classA, classB: r.report.usage?.classB },
  };
  results.push(row);
  console.log(JSON.stringify(row));
}
await fsp.mkdir(out, { recursive: true });
await fsp.writeFile(path.join(out, "results.json"), JSON.stringify({ at: new Date().toISOString(), node: process.version, platform: process.platform, results }, null, 2));
console.table(results.map(({ timingsMs, r2Ops, ...rest }) => rest));
