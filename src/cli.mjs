/** Командний рядок прототипу. Працює ЛИШЕ з локальним сховищем (--store) і локальними джерелами.
 *
 *  update   --store=DIR --catalog=DIR --supplier=FILE [--manifest=FILE] [--max-bytes=N] [--gzip]
 *  approve  --store=DIR --catalog=DIR [--feed=main] [--ids=FILE] [--allow-remove=FILE] [--by=ім'я] [--note=текст]
 *  rollback --store=DIR [--feed=main] [--to=KEY]
 *  status   --store=DIR [--feed=main]
 *
 *  Підключення R2/Google/постачальника — окремий погоджений етап (CONNECT-PLAN.md). */
import fsp from "node:fs/promises";
import { LocalObjectStore } from "./storage/local.mjs";
import { FileSupplierSource, NdjsonCatalogSource } from "./pipeline/sources.mjs";
import { runUpdate } from "./pipeline/update.mjs";
import { manifestKey, rollbackFeed } from "./publish/publisher.mjs";
import { approveSet } from "./core/catalog-guards.mjs";
import { readSheet } from "./core/sync-plan.mjs";
import { objectsFromValues } from "./core/yml.mjs";
import { GROUP_HEADERS } from "./core/seal.mjs";

const [command] = process.argv.slice(2);
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const need = (name) => { const v = arg(name); if (!v) throw new Error(`Потрібен параметр --${name}`); return v; };

async function loadConfig() {
  const file = arg("config", new URL("../config/default.json", import.meta.url));
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function main() {
  const config = await loadConfig();
  const store = new LocalObjectStore(need("store"));
  const feedName = arg("feed", "main");

  if (command === "update") {
    const manifests = {};
    if (arg("manifest")) manifests[feedName] = JSON.parse(await fsp.readFile(arg("manifest"), "utf8"));
    if (arg("max-bytes")) for (const f of config.feeds) f.maximumBytes = Number(arg("max-bytes"));
    if (flag("gzip")) for (const f of config.feeds) f.gzip = true;
    if (arg("min-offers")) config.supplier.minimumOffers = Number(arg("min-offers"));
    const report = await runUpdate({ store, config, manifests, catalog: new NdjsonCatalogSource(need("catalog")), supplier: new FileSupplierSource(need("supplier")) });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.sync.state === "OK" && report.feeds.every((f) => f.state !== "ERROR") ? 0 : 1;
  } else if (command === "approve") {
    const feed = config.feeds.find((f) => f.name === feedName);
    if (!feed) throw new Error("Невідомий фід " + feedName);
    const snapshot = await new NdjsonCatalogSource(need("catalog")).load(feed.sheets);
    let rows = feed.sheets.flatMap((name) => (snapshot.sheets[name] ? readSheet(snapshot.sheets[name], name).rows : []));
    // --ids=FILE: погодити лише підмножину (напр. 92 погоджені ID черги для фіду з filterByManifest).
    if (arg("ids")) {
      const wanted = new Set((await fsp.readFile(arg("ids"), "utf8")).split(/\s+/).filter(Boolean));
      rows = rows.filter((r) => wanted.has(String(r["Offer ID"])));
      if (rows.length !== wanted.size) throw new Error(`У каталозі знайдено ${rows.length} із ${wanted.size} ID зі списку`);
    }
    const previous = await store.getJson(feed.manifest);
    const allowRemove = arg("allow-remove") ? (await fsp.readFile(arg("allow-remove"), "utf8")).split(/\s+/).filter(Boolean) : [];
    const manifest = approveSet({
      rows, groups: objectsFromValues(snapshot.groups, GROUP_HEADERS), previous, allowRemove,
      maxRemoved: config.guards.maxRemovedWithoutApproval, approvedBy: arg("by", ""), note: arg("note", ""), now: Date.now(),
    });
    await store.putJson(feed.manifest, manifest);
    console.log(JSON.stringify({ feed: feedName, count: manifest.count, idsSha: manifest.idsSha, diff: { added: manifest.diff.added, removed: manifest.diff.removed } }));
  } else if (command === "rollback") {
    const m = await rollbackFeed(store, feedName, { toKey: arg("to") });
    console.log(JSON.stringify({ feed: feedName, active: m.active.key, previous: m.previous?.key }));
  } else if (command === "status") {
    const m = await store.getJson(manifestKey(feedName));
    const last = await store.getJson("state/last-run.json");
    const sync = await store.getJson("state/sync.json");
    console.log(JSON.stringify({ feed: feedName, active: m?.active || null, previous: m?.previous?.key || null, sync, lastRun: last && { startedAt: last.startedAt, sync: last.sync?.state, feeds: last.feeds } }, null, 2));
  } else {
    console.log("Команди: update | approve | rollback | status (див. заголовок src/cli.mjs)");
    process.exitCode = 2;
  }
}

main().catch((e) => { console.error("ПОМИЛКА: " + e.message); process.exitCode = 1; });
