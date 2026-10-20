/** Звірка нової системи з LIVE Apps Script на РЕАЛЬНОМУ знімку книги (лише читання, нічого не пише поруч із даними).
 *
 *  node tools/snapshot-parity.mjs --inspect=<шлях до *.xlsx.inspect.ndjson> [--yml=<Yml.gs з MTY для звірки>]
 *
 *  1. Печатки: кожен рядок «Основного каталогу» перераховується і звіряється з колонкою «SHA256 незмінних полів»;
 *     count/idsSha/contentSha/groupsSha порівнюються з MTY вказаного Yml.gs (за замовчуванням — reference LIVE).
 *  2. YML: F:M узгоджено синтезуються формулою (ціна постачальника + наявність), далі LIVE mtBuildYml_ у VM
 *     і Node-порт будують фід із реального контенту — порівнюються байт-у-байт; незалежний валідатор перевіряє XML.
 *  Формат вхідного файла — дамп Codex (рядки {"kind":"table","sheet":…,"values":[[…]]}). */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { approvalManifest, rowSeal, YML_HEADERS, GROUP_HEADERS } from "../src/core/seal.mjs";
import { objectsFromValues, buildYml, memorySink } from "../src/core/yml.mjs";
import { mtPrices } from "../src/core/pricing.mjs";
import { verifyYmlStream } from "../src/core/xml-verify.mjs";
import { loadLiveAppsScript } from "../test/helpers/apps-script-vm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const inspect = arg("inspect");
if (!inspect) { console.error("Потрібен --inspect=<файл>"); process.exit(2); }
const ymlFile = arg("yml", path.join(root, "reference", "apps-script-live", "Yml.LIVE-CURRENT.gs"));
const mty = Object.fromEntries(["idsSha", "contentSha", "groupsSha"].map((k) => [k, (new RegExp(k + ":'([a-f0-9]{64})'").exec(fs.readFileSync(ymlFile, "utf8")) || [])[1]]));
mty.count = Number((/count:(\d+)/.exec(fs.readFileSync(ymlFile, "utf8")) || [])[1]);

const tables = {};
const rl = readline.createInterface({ input: fs.createReadStream(inspect, { encoding: "utf8" }), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.startsWith('{"kind":"table"')) continue;
  const t = JSON.parse(line);
  if (t.sheet === "Основний каталог" || t.sheet === "Групи") tables[t.sheet] = t.values;
}
const rows = objectsFromValues(tables["Основний каталог"], YML_HEADERS);
const groups = objectsFromValues(tables["Групи"], GROUP_HEADERS);
const sealMismatches = rows.filter((r) => rowSeal(r) !== String(r["SHA256 незмінних полів"])).map((r) => r["Offer ID"]);
const m = approvalManifest(rows, groups);
const seals = {
  rows: rows.length, sealMismatches: sealMismatches.length, sample: sealMismatches.slice(0, 5),
  count: m.count === mty.count, idsSha: m.idsSha === mty.idsSha, contentSha: m.contentSha === mty.contentSha, groupsSha: m.groupsSha === mty.groupsSha,
  computed: { idsSha: m.idsSha, contentSha: m.contentSha, groupsSha: m.groupsSha },
};

// YML-паритет на реальному контенті
const stamp = new Date().toISOString();
const values = tables["Основний каталог"].map((r) => r.slice());
const h = values[0];
const c = (k) => h.indexOf(k);
for (const r of values.slice(1)) {
  const p = mtPrices(Number(r[c("Ціна постачальника")]), r[c("Наявність")] === "+");
  r[c("Ціна")] = p.base; r[c("Ціна кінцева")] = p.final; r[c("Знижка")] = p.discount; r[c("Наявність")] = p.availability;
  r[c("Стан синхронізації")] = "ЗІСТАВЛЕНО"; r[c("Оновлено")] = stamp;
}
const meta = { syncState: "OK", lastSuccess: stamp, now: new Date(Date.parse(stamp) + 60000).toISOString() };
const gas = loadLiveAppsScript();
Object.assign(gas.MTY, { count: m.count, idsSha: m.idsSha, contentSha: m.contentSha, groupsSha: m.groupsSha });
const live = gas.mtBuildYml_(values, tables["Групи"], meta);
const sink = memorySink();
const mine = await buildYml({
  rows: objectsFromValues(values, YML_HEADERS), groups, meta, manifest: m, maximumBytes: 50_000_000, sink,
  config: { maximumSyncAgeHours: 12, shopName: "Майстерня Маркет", company: "Майстерня Маркет", timeZone: "Europe/Kyiv" },
});
const xml = sink.text();
const v = await verifyYmlStream([xml], { count: m.count, idsSha: m.idsSha, sha256: live.sha256 });
const yml = { identical: xml === live.xml, bytes: mine.bytes, liveBytes: live.bytes, sha256Equal: mine.sha256 === live.sha256, sourceDigestEqual: mine.sourceDigest === live.sourceDigest, validatorCount: v.count };
console.log(JSON.stringify({ inspect: path.basename(inspect), mtyFrom: path.basename(ymlFile), seals, yml }, null, 2));
process.exitCode = seals.sealMismatches === 0 && yml.identical ? 0 : 1;
