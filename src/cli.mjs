/** Командний рядок прототипу. Працює ЛИШЕ з локальним сховищем (--store) і локальними джерелами.
 *
 *  update   --store=DIR --catalog=DIR --supplier=FILE --cc-store=DIR [--manifest=FILE] [--max-bytes=N] [--gzip]
 *  approve  --store=DIR --catalog=DIR [--feed=main] [--ids=FILE] [--allow-remove=FILE] [--by=ім'я] [--note=текст]
 *  rollback --store=DIR --catalog=DIR --cc-store=DIR [--feed=main] [--to=KEY]
 *
 *  update / rollback — лише в режимі пріоритету власника з Catalog Controls (productionConfig): стан CC — з аркушів знімка (--catalog)
 *  і контрольної точки сховища W2 (--cc-store). Модуля CC немає (до злиття гілок) або сховища не вказано → update: BLOCKED_CC
 *  (нового YML немає), rollback: відмова.
 *  ENG-18: update / rollback — лише з допуском W2, як tools/sheet-sync (MM_W2_MODE=single-host + MM_SAFE_WRITE_DIR, не GitHub Actions),
 *  і --cc-store = MM_SAFE_WRITE_DIR (один координатор на хості). Інакше — відмова ДО будь-якого запису (код 1, як інші відмови).
 *  ENG-19 (Hermes ENG17 розд. 7 п. 5, «intake/approval»): approve — той самий допуск W2; паспорт погодження пишеться під орендою W2
 *  (той самий ресурс, що й публікація / CC / sheet-sync), читання попереднього паспорта — теж під нею.
 *  status   --store=DIR [--feed=main]
 *
 *  Підключення R2/Google/постачальника — окремий погоджений етап (CONNECT-PLAN.md). */
import fsp from "node:fs/promises";
import path from "node:path";
import { LocalObjectStore } from "./storage/local.mjs";
import { FileSupplierSource, NdjsonCatalogSource } from "./pipeline/sources.mjs";
import { runUpdate, guardedRollback } from "./pipeline/update.mjs";
import { manifestKey } from "./publish/publisher.mjs";
import { productionConfig, loadCatalogControls, w2Coordinator, CC_BOOK_SHEETS } from "./pipeline/production.mjs";
import { FileStore } from "./pipeline/safe-write/store.mjs";
import { createCommitter } from "./pipeline/safe-write/committer.mjs";
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

/** Стан CC для update / rollback: аркуші знімка + контрольна точка W2. Чогось бракує → null (споживач — fail-closed). */
async function controlsFor(config, store) {
  if (!arg("catalog") || !arg("cc-store")) return null;
  const catalog = new NdjsonCatalogSource(arg("catalog"));
  return loadCatalogControls({ loadBook: async () => (await catalog.load(CC_BOOK_SHEETS)).sheets, store: new FileStore(arg("cc-store")), config, feedStore: store });
}
/** ENG-17 (Hermes I07): координатор W2 — оренда над тим самим сховищем, що й контрольна точка CC (--cc-store). Немає — null (відмова). */
const coordinatorFor = () => (arg("cc-store") ? createCommitter({ store: new FileStore(arg("cc-store")) }) : null);
/** ENG-18 (знахідка ENG18-N1): допуск W2 для update / rollback. Оренда публікації виключає запуски CC / sheet-sync лише над ТИМ САМИМ
 *  сховищем: --cc-store ≠ MM_SAFE_WRITE_DIR → два координатори на хості, гонка P4 (видалений offer у новому маніфесті) досяжна. */
const samePath = (a, b) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
function w2Admission() {
  const adm = w2Coordinator();
  if (command === "approve") return adm; // approve не читає стан CC — лише оренда над сховищем W2 цього хоста
  if (!arg("cc-store")) throw new Error("не вказано --cc-store (сховище W2 і контрольної точки CC)");
  if (!samePath(arg("cc-store"), adm.dir)) throw new Error("--cc-store має бути сховищем W2 цього хоста (MM_SAFE_WRITE_DIR) — інакше оренда публікації не виключає запуски CC / sheet-sync");
  return adm;
}

async function main() {
  let admission = null;
  if (["update", "rollback", "approve"].includes(command)) {
    try { admission = w2Admission(); } catch (e) { console.error("ПОМИЛКА: НЕМАЄ КООРДИНАТОРА ЗАПИСУ (W2): " + e.message + "; нічого не записано"); process.exitCode = 1; return; }
  }
  const loaded = await loadConfig();
  // update / rollback — робочі точки запуску: пріоритет власника й Catalog Controls обов'язкові (рішення власника 29.10).
  const config = ["update", "rollback"].includes(command) ? productionConfig(loaded) : loaded;
  const store = new LocalObjectStore(need("store"));
  const feedName = arg("feed", "main");

  if (command === "update") {
    const manifests = {};
    if (arg("manifest")) manifests[feedName] = JSON.parse(await fsp.readFile(arg("manifest"), "utf8"));
    if (arg("max-bytes")) for (const f of config.feeds) f.maximumBytes = Number(arg("max-bytes"));
    if (flag("gzip")) for (const f of config.feeds) f.gzip = true;
    if (arg("min-offers")) config.supplier.minimumOffers = Number(arg("min-offers"));
    const controls = await controlsFor(config, store);
    const coordinator = coordinatorFor();
    const report = await runUpdate({ store, config, manifests, catalog: new NdjsonCatalogSource(need("catalog")), supplier: new FileSupplierSource(need("supplier")), ...(controls ? { controls } : {}), ...(coordinator ? { coordinator } : {}) });
    console.log(JSON.stringify(report, null, 2));
    // BLOCKED_CC (стан Catalog Controls недостовірний) і невдалий аварійний патч — не успіх (CC R5 S6).
    // Успіх — лише коли КОЖЕН фід опубліковано або безпечно перевикористано (Hermes E7: небезпечна / неперевірена активна версія,
    // знятий з обслуговування фід, BLOCKED_CC, невдалий патч — не успіх).
    process.exitCode = report.sync.state === "OK" && report.feeds.length > 0 && report.feeds.every((f) => ["PUBLISHED", "REUSED"].includes(f.state) && !f.holdPatch?.error) ? 0 : 1;
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
    const allowRemove = arg("allow-remove") ? (await fsp.readFile(arg("allow-remove"), "utf8")).split(/\s+/).filter(Boolean) : [];
    // Читання попереднього паспорта → запис нового — під орендою W2 (зайнято → відмова, нічого не записано).
    const lease = await createCommitter({ store: new FileStore(admission.dir) }).acquire("approve");
    let manifest;
    try {
      const previous = await store.getJson(feed.manifest);
      manifest = approveSet({
        rows, groups: objectsFromValues(snapshot.groups, GROUP_HEADERS), previous, allowRemove,
        maxRemoved: config.guards.maxRemovedWithoutApproval, approvedBy: arg("by", ""), note: arg("note", ""), now: Date.now(),
      });
      await lease.assertCurrent();
      await store.putJson(feed.manifest, manifest);
    } finally { await lease.release().catch(() => {}); }
    console.log(JSON.stringify({ feed: feedName, count: manifest.count, idsSha: manifest.idsSha, diff: { added: manifest.diff.added, removed: manifest.diff.removed } }));
  } else if (command === "rollback") {
    // CC R6 правило 8: відкат лише зі свіжим достовірним станом CC; без нього — відмова (guardedRollback).
    const m = await guardedRollback({ store, feed: feedName, toKey: arg("to"), controls: await controlsFor(config, store), coordinator: coordinatorFor() });
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
