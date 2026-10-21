/** Наскрізний shadow-прогін нового конвеєра на РЕАЛЬНОМУ знімку каталогу (лише локально, .data/ не комітиться).
 *
 *  node tools/analysis/shadow-replay.mjs --fresh=<xlsx робочої книги> [--drop=3] [--reissue=5] [--out=.data/replay]
 *
 *  Фід постачальника НЕ завантажується: він відтворюється з останньої синхронізації (ціна постачальника + наявність
 *  + опорні поля рядків). Прогін 1 — без змін: перевіряємо, що sourceDigest = LIVE-збірці на тих самих даних.
 *  Прогін 2 — сценарій D1: N товарів зникли, M перевипущені з новими ID. Паспорт main = LIVE MTY; new92 = зі знімка. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readXlsx } from "../lib/xlsx-read.mjs";
import { writeCatalogSnapshot, NdjsonCatalogSource, FileSupplierSource } from "../../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../../src/storage/local.mjs";
import { runUpdate } from "../../src/pipeline/update.mjs";
import { approvalManifest, YML_HEADERS, GROUP_HEADERS } from "../../src/core/seal.mjs";
import { objectsFromValues, xmlEscape } from "../../src/core/yml.mjs";
import { formatYmlDate } from "../../src/core/time.mjs";
import { manifestKey } from "../../src/publish/publisher.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const out = path.resolve(arg("out", path.join(root, ".data", "replay")));
await fsp.rm(out, { recursive: true, force: true });
const book = Object.fromEntries(readXlsx(arg("fresh")).sheets.map((s) => [s.name, s.values]));
const sheets = { "Основний каталог": book["Основний каталог"], "Нові товари": book["Нові товари"], "Відкладені товари": book["Відкладені товари"] };
await writeCatalogSnapshot(path.join(out, "catalog"), { sheets, groups: book["Групи"] });

const src = fs.readFileSync(path.join(root, "reference", "apps-script-live", "Yml.LIVE-CURRENT.gs"), "utf8");
const pick = (k) => new RegExp(k + ":'([a-f0-9]{64})'").exec(src)[1];
const liveMain = { count: Number(/count:(\d+)/.exec(src)[1]), idsSha: pick("idsSha"), contentSha: pick("contentSha"), groupsSha: pick("groupsSha") };
const groups = objectsFromValues(book["Групи"], GROUP_HEADERS);
const queueRows = objectsFromValues(book["Нові товари"], YML_HEADERS);
const new92 = { ...approvalManifest(queueRows, groups), ids: queueRows.map((r) => String(r["Offer ID"])).sort() };

const syncRows = [...objectsFromValues(book["Основний каталог"], YML_HEADERS), ...queueRows];
function supplierXml(now, { drop = [], reissue = new Map() } = {}) {
  const offers = syncRows.filter((r) => !drop.includes(String(r["ID постачальника"]))).map((r) => {
    const sid = String(r["ID постачальника"]);
    const oid = reissue.get(sid) || sid;
    return `<offer id="${oid}" available="${r["Наявність"] === "+"}"><url>${xmlEscape(String(r["URL постачальника"]).replace(`/p${sid}-`, `/p${oid}-`))}</url><price>${r["Ціна постачальника"]}</price><currencyId>UAH</currencyId><name>${xmlEscape(r["Назва постачальника RU"])}</name><name_ua>${xmlEscape(r["Назва постачальника UA"])}</name_ua><vendorCode>${xmlEscape(r["Артикул постачальника"])}</vendorCode><vendor>${xmlEscape(r["Виробник"])}</vendor><quantity_in_stock>${r["Кількість постачальника"]}</quantity_in_stock></offer>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="${formatYmlDate(now - 15 * 60000, "Europe/Kyiv")}"><shop><offers>\n${offers.join("\n")}\n</offers></shop></yml_catalog>\n`;
}

const config = JSON.parse(await fsp.readFile(path.join(root, "config", "default.json"), "utf8"));
config.feeds.push({ name: "new92", sheets: ["Нові товари"], manifest: "approved/new92.json", maximumBytes: 50000000, filterByManifest: true });
const store = new LocalObjectStore(path.join(out, "store"));
const supplierFile = path.join(out, "supplier.xml");
const run = async (now, opts) => {
  await fsp.writeFile(supplierFile, supplierXml(now, opts));
  return runUpdate({ store, config, manifests: { main: liveMain, new92 }, catalog: new NdjsonCatalogSource(path.join(out, "catalog")), supplier: new FileSupplierSource(supplierFile), now: () => now, tmpDir: out });
};
const brief = (r) => ({ sync: r.sync.state, error: r.sync.error, sheets: r.sync.sheets?.map((s) => [s.name, s.matched, s.held, s.byStatus]), identity: r.identity, availability: r.availability, feeds: r.feeds.map((f) => ({ feed: f.feed, state: f.state, count: f.count, bytes: f.bytes, unavailableMissing: f.unavailableMissing, error: f.error })), ms: r.timingsMs });

const t0 = Date.now();
const r1 = await run(t0);
const m1 = await store.getJson(manifestKey("main"));
console.log("ПРОГІН 1 (без змін):", JSON.stringify(brief(r1)));
console.log("  main sourceDigest:", m1?.active?.sourceDigest);

const drop = syncRows.slice(100, 100 + Number(arg("drop", 3))).map((r) => String(r["ID постачальника"]));
const reissue = new Map(syncRows.slice(200, 200 + Number(arg("reissue", 5))).map((r, i) => [String(r["ID постачальника"]), String(3900000000 + i)]));
const r2 = await run(t0 + 4 * 3600000, { drop, reissue });
console.log("ПРОГІН 2 (D1: зникли " + drop.length + ", перевипущено " + reissue.size + "):", JSON.stringify(brief(r2)));
const idr = await store.getJson("reports/identity/latest.json");
console.log("  перев'язки:", JSON.stringify(idr.relinked.map((x) => [x.offerId, x.from, "→", x.to, (x.evidence || []).join("+")])));
const correct = idr.relinked.filter((x) => reissue.get(x.from) === x.to).length;
console.log("  правильних перев'язок:", correct, "із", reissue.size, "; хибних:", idr.relinked.length - correct, "; ручних:", idr.manualReview.length);
const news = await store.getJson("reports/new-products/latest.json");
console.log("  нових товарів у звіті:", news.total);
