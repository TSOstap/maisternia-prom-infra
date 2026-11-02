#!/usr/bin/env node
/** ENG-24 (E8, cc-recovery-v1): керування відновленням Catalog Controls — лише сховища, без Google Sheets і без мережі.
 *
 *   node tools/recover.mjs status          --feed-store=DIR
 *   node tools/recover.mjs declare         --feed-store=DIR --type=FULL|UNKNOWN --reason="…"
 *     (ENG-25, e2: CP_ONLY / W2_ONLY оголошує лише система — виявлення таблиці 2.6 / межа епох; оператор — код 2)
 *   node tools/recover.mjs authorize       --feed-store=DIR --id=<id> --by="<власник>" --confirm="ВІДНОВИТИ <id>"
 *   node tools/recover.mjs establish-floor --feed-store=DIR
 *  Далі — запуск CC: node tools/sheet-sync.mjs --mode=recover --feed-store=DIR (окремо, з доступом до тестової копії таблиці).
 *
 *  Допуск W2 — як у робочих точках запуску: MM_W2_MODE=single-host + MM_SAFE_WRITE_DIR, не в GitHub Actions (w2Coordinator).
 *  Сирого відновлення сховищ (копіювання каталогів) інструмент не робить. Дозвіл — лише власник: точний id, ім'я, «ВІДНОВИТИ <id>».
 *  Коди виходу: 0 — успіх; 1 — відмова процедури; 2 — допуск / аргументи. */
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { w2Coordinator, productionConfig } from "../src/pipeline/production.mjs";
import { FileStore } from "../src/pipeline/safe-write/store.mjs";
import { createCommitter, leaseKeyOf } from "../src/pipeline/safe-write/committer.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { readRecovery, declareRecovery, authorizeRecover, establishFloor, confirmationFor } from "../src/pipeline/recovery.mjs";
import { epochFloor } from "../src/pipeline/safe-write/epoch-floor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cmd = process.argv[2];
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const out = (o) => console.log(JSON.stringify(o, null, 2));
const stop = (code, message) => { console.error("ПОМИЛКА: " + message); process.exit(code); };

if (!["status", "declare", "authorize", "establish-floor"].includes(cmd)) stop(2, "команди: status | declare | authorize | establish-floor");
let admission;
try { admission = w2Coordinator(); } catch (e) { stop(2, "НЕМАЄ КООРДИНАТОРА ЗАПИСУ (W2): " + e.message + "; нічого не записано"); }
if (!arg("feed-store")) stop(2, "потрібен --feed-store");
const config = productionConfig(JSON.parse(await fsp.readFile(path.join(root, "config", "default.json"), "utf8")));
const feeds = config.feeds.filter((f) => f.enabled !== false).map((f) => f.name);
const feedStore = new LocalObjectStore(arg("feed-store")), w2Store = new FileStore(admission.dir);

try {
  if (cmd === "status") {
    const { recovery, mirror } = await readRecovery(feedStore);
    const { floor, parts } = await epochFloor({ w2Store, feedStore, feeds });
    const lease = (await w2Store.getJsonVersioned(leaseKeyOf("sheets-main"))).value;
    out({ recovery, confirmation: recovery.id ? confirmationFor(recovery.id) : null, floor, parts, leaseToken: lease?.token ?? 0, leaseBelowFloor: (lease?.token ?? 0) < floor, mirror: mirror ? { generation: mirror.generation, epochHigh: mirror.epochHigh, committed: mirror.committed?.cpHash ?? null, prepared: mirror.prepared?.cpHash ?? null } : null });
  } else if (cmd === "declare") {
    const type = arg("type", "FULL");
    if (!["FULL", "UNKNOWN"].includes(type)) stop(2, `declare: оператор оголошує лише FULL або UNKNOWN (тип ${type} з доведеною межею виявляє система); нічого не записано`);
    out(await declareRecovery({ feedStore, type, reason: arg("reason", "оголошено оператором"), declaredBy: "operator" }));
  } else if (cmd === "authorize") {
    out(await authorizeRecover({ feedStore, id: arg("id"), authorizedBy: arg("by"), confirm: arg("confirm") }));
  } else if (cmd === "establish-floor") {
    out(await establishFloor({ feedStore, w2Store, committer: createCommitter({ store: w2Store }), feeds }));
  }
} catch (e) { stop(1, String(e?.message || e)); }
