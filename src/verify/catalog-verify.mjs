/** Перевірка реального каталогу (етап C2-B): обидва активні фіди (main 5029 + new92 92 = 5121).
 *  Повертає ЛИШЕ агрегати (кількості, хеші, байти, час). Offer ID — тільки якщо redact=false (локально).
 *  Нічого не пише в таблицю; тимчасові файли (YML, сховище replay) — у tmpDir і видаляються. */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approvalManifest, rowSeal, SEAL_COLUMN, YML_HEADERS, GROUP_HEADERS } from "../core/seal.mjs";
import { buildYml, memorySink, objectsFromValues, xmlEscape } from "../core/yml.mjs";
import { verifyYmlStream } from "../core/xml-verify.mjs";
import { mtPrices, mtSameDiscount } from "../core/pricing.mjs";
import { readSheet, MATCH } from "../core/sync-plan.mjs";
import { mtText } from "../core/text.mjs";
import { formatYmlDate } from "../core/time.mjs";
import { FileSupplierSource } from "../pipeline/sources.mjs";
import { LocalObjectStore } from "../storage/local.mjs";
import { runUpdate } from "../pipeline/update.mjs";
import { manifestKey } from "../publish/publisher.mjs";

export const SHEETS = Object.freeze({ main: "Основний каталог", queue: "Нові товари", deferred: "Відкладені товари", frozen: "Заморожені ID", groups: "Групи" });

const duplicates = (list) => { const seen = new Set(), dup = new Set(); for (const x of list) (seen.has(x) ? dup : seen).add(x); return [...dup]; };
const tally = (arr) => arr.reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {});

function contentChecks(rows) {
  const bad = { emptyName: [], emptyDescription: [], photos: [], params: [], keywordsTooLong: [], keywordsEmpty: [], category: [], importStatus: [] };
  for (const r of rows) {
    const id = mtText(r["Offer ID"]);
    if (!mtText(r["Назва UA"]).trim() || !mtText(r["Назва RU"]).trim()) bad.emptyName.push(id);
    if (!mtText(r["Опис UA"]).trim() || !mtText(r["Опис RU"]).trim()) bad.emptyDescription.push(id);
    try {
      const p = JSON.parse(mtText(r["Фото JSON"]));
      if (!Array.isArray(p) || !p.length || p.length > 10 || p.some((u) => typeof u !== "string" || !/^https?:\/\/[^\s<>"']+$/.test(u))) bad.photos.push(id);
    } catch { bad.photos.push(id); }
    try {
      const c = JSON.parse(mtText(r["Характеристики JSON"]));
      if (!Array.isArray(c) || c.length > 100 || c.some((x) => !x || typeof x.name !== "string" || !x.name.trim() || typeof x.value !== "string" || typeof x.unit !== "string")) bad.params.push(id);
    } catch { bad.params.push(id); }
    if (mtText(r["Запити UA"]).length > 1024 || mtText(r["Запити RU"]).length > 1024) bad.keywordsTooLong.push(id);
    if (!mtText(r["Запити UA"]).trim() || !mtText(r["Запити RU"]).trim()) bad.keywordsEmpty.push(id);
    if (!/^\d+$/.test(mtText(r["Категорія Prom ID"])) || !/^\d+$/.test(mtText(r["Група ID"]))) bad.category.push(id);
    if (r["Статус імпорту"] !== "ДОЗВОЛЕНО") bad.importStatus.push(id);
  }
  return bad;
}

function operationalChecks(rows) {
  const formula = [], discount = [], quantity = [];
  for (const r of rows) {
    const id = mtText(r["Offer ID"]);
    const avail = r["Наявність"];
    if (avail !== "+" && avail !== "-") { formula.push(id); continue; }
    try {
      const p = mtPrices(Number(r["Ціна постачальника"]), avail === "+");
      if (Number(r["Ціна"]) !== p.base || Number(r["Ціна кінцева"]) !== p.final) formula.push(id);
      if (!mtSameDiscount(r["Знижка"], p.discount) && mtText(r["Знижка"]) !== p.discount) discount.push(id);
    } catch { formula.push(id); }
    const q = r["Кількість постачальника"];
    if (q !== "" && !/^\d+(?:\.\d+)?$/.test(mtText(q))) quantity.push(id);
  }
  const stamps = tally(rows.map((r) => mtText(r["Оновлено"])));
  const top = Object.entries(stamps).sort((a, b) => b[1] - a[1])[0];
  return {
    status: tally(rows.map((r) => mtText(r["Стан синхронізації"]))), availability: tally(rows.map((r) => mtText(r["Наявність"]))),
    distinctStamps: Object.keys(stamps).length, lastSuccess: top?.[0] || null, formula, discount, quantity,
  };
}

const same = (m, e) => ({ count: m.count === e.count, idsSha: m.idsSha === e.idsSha, contentSha: m.contentSha === e.contentSha, groupsSha: m.groupsSha === e.groupsSha });

/**
 * @param book     { [назва аркуша]: values2D } — включно з «Групи»
 * @param expected { main: {count, idsSha, contentSha, groupsSha}, new92: {...} }
 * @param replay   async ({ book, manifests, tmpDir }) => звіт runUpdate (необов'язково)
 */
export async function verifyCatalog({ book, expected, ymlConfig, maximumBytes = 50_000_000, redact = true, tmpDir, replay }) {
  const ids = (list) => (redact ? list.length : list);
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); return ok; };
  const report = { sheets: {}, feeds: {}, checks };

  for (const key of ["main", "queue", "deferred", "groups"]) check(`аркуш «${SHEETS[key]}» присутній`, book[SHEETS[key]]?.length > 0);
  for (const [k, v] of Object.entries(book)) report.sheets[k] = Math.max(0, v.length - 1);
  if (checks.some((c) => !c.ok)) return { ...report, ok: false };

  const groups = objectsFromValues(book[SHEETS.groups], GROUP_HEADERS);
  const main = readSheet(book[SHEETS.main], SHEETS.main).rows;
  const queue = readSheet(book[SHEETS.queue], SHEETS.queue).rows;
  const deferred = readSheet(book[SHEETS.deferred], SHEETS.deferred).rows;
  const frozen = new Set((book[SHEETS.frozen] || []).slice(1).map((r) => mtText(r[0])).filter(Boolean));

  // Дублікати й перетини між аркушами
  const all = [...main, ...queue, ...deferred].map((r) => mtText(r["Offer ID"]));
  const dupIds = duplicates(all);
  check("немає Offer ID у кількох аркушах", dupIds.length === 0, ids(dupIds));
  const supplierIds = [...main, ...queue].map((r) => mtText(r["ID постачальника"]));
  const dupSupplier = duplicates(supplierIds);
  check("немає ID постачальника у двох картках фідів", dupSupplier.length === 0, ids(dupSupplier));
  report.frozenIds = frozen.size;
  report.totalActive = main.length + queue.length;

  const manifests = {};
  for (const [feed, rows] of [["main", main], ["new92", queue]]) {
    const exp = expected[feed];
    const sealBad = rows.filter((r) => rowSeal(r) !== mtText(r[SEAL_COLUMN])).map((r) => mtText(r["Offer ID"]));
    const m = { ...approvalManifest(rows, groups), ids: rows.map((r) => mtText(r["Offer ID"])).sort() };
    manifests[feed] = m;
    const vs = same(m, exp);
    const op = operationalChecks(rows);
    const content = contentChecks(rows);
    report.feeds[feed] = {
      rows: rows.length, vsExpected: vs, sealMismatches: ids(sealBad),
      operational: { status: op.status, availability: op.availability, distinctStamps: op.distinctStamps, formulaMismatches: ids(op.formula), discountMismatches: ids(op.discount), quantityInvalid: ids(op.quantity) },
      content: Object.fromEntries(Object.entries(content).map(([k, v]) => [k, ids(v)])),
    };
    check(`${feed}: кількість = ${exp.count}`, vs.count, rows.length);
    check(`${feed}: idsSha = еталон`, vs.idsSha);
    check(`${feed}: contentSha = еталон`, vs.contentSha);
    check(`${feed}: groupsSha = еталон`, vs.groupsSha);
    check(`${feed}: печатки всіх рядків`, sealBad.length === 0, sealBad.length);
    check(`${feed}: ціни F:H за формулою`, op.formula.length === 0, op.formula.length);
    check(`${feed}: знижка відповідає наявності`, op.discount.length === 0, op.discount.length);
    check(`${feed}: кількість постачальника валідна`, op.quantity.length === 0, op.quantity.length);
    check(`${feed}: усі рядки ЗІСТАВЛЕНО`, (op.status[MATCH.OK] || 0) === rows.length, op.status);
    check(`${feed}: одна мітка останнього оновлення`, op.distinctStamps === 1, op.distinctStamps);
    for (const [k, v] of Object.entries(content)) check(`${feed}: контент — ${k}`, v.length === 0, v.length);

    // YML так само, як LIVE (політика block: на справному каталозі ізоляцій бути не повинно)
    const meta = { syncState: "OK", lastSuccess: op.lastSuccess, now: new Date(Date.parse(op.lastSuccess) + 60000).toISOString() };
    const sink = memorySink();
    try {
      const built = await buildYml({ rows, groups, meta, manifest: exp.count === m.count && vs.idsSha && vs.contentSha && vs.groupsSha ? exp : m, config: ymlConfig, maximumBytes, sink });
      const v = await verifyYmlStream([sink.text()], { count: rows.length, idsSha: m.idsSha, sha256: built.sha256 });
      report.feeds[feed].yml = { bytes: built.bytes, headroomBytes: maximumBytes - built.bytes, sha256: built.sha256, sourceDigest: built.sourceDigest, offers: v.count };
      check(`${feed}: YML сформовано й незалежно перевірено`, true);
      check(`${feed}: YML ≤ ${maximumBytes} байтів`, built.bytes <= maximumBytes, built.bytes);
    } catch (e) {
      report.feeds[feed].yml = { error: redact ? e.message.replace(/ID \d+/g, "ID ***") : e.message };
      check(`${feed}: YML сформовано й незалежно перевірено`, false);
    }
  }
  check("разом активних товарів 5121", report.totalActive === expected.main.count + expected.new92.count, report.totalActive);

  if (replay) {
    const dir = await fsp.mkdtemp(path.join(tmpDir || os.tmpdir(), "mm-verify-"));
    try {
      const r = await replay({ book, manifests: { main: expected.main, new92: manifests.new92 }, tmpDir: dir });
      report.replay = {
        sync: r.sync.state, error: r.sync.error ? (redact ? r.sync.error.replace(/ID \d+/g, "ID ***") : r.sync.error) : undefined,
        feeds: r.feeds.map((f) => ({ feed: f.feed, state: f.state, count: f.count, bytes: f.bytes, isolatedConflicts: f.isolatedConflicts, unavailableMissing: f.unavailableMissing })),
        identity: r.identity, conflicts: r.conflicts, availability: r.availability,
      };
      check("конвеєр (D1/D1b, зіставлення): синк OK", r.sync.state === "OK");
      check("конвеєр: обидва фіди опубліковано", r.feeds.length === 2 && r.feeds.every((f) => f.state === "PUBLISHED"));
      check("конвеєр: 0 конфліктів, 0 зникнень, 0 перев'язок на справному каталозі", r.conflicts?.open === 0 && r.availability?.missing === 0 && r.identity?.relinked === 0);
      const mainFeed = r.feeds.find((f) => f.feed === "main");
      check("конвеєр: YML main = YML LIVE-збірки (sourceDigest)", Boolean(mainFeed) && report.feeds.main.yml?.sourceDigest && mainFeed.sha256 && r.mainSourceDigest === report.feeds.main.yml.sourceDigest);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
  report.ok = checks.every((c) => c.ok);
  return report;
}

/** Фід постачальника, відтворений з останньої синхронізації (без звернення до постачальника). */
export function replaySupplierXml(rows, now) {
  const offers = rows.map((r) => `<offer id="${mtText(r["ID постачальника"])}" available="${r["Наявність"] === "+"}"><url>${xmlEscape(r["URL постачальника"])}</url><price>${r["Ціна постачальника"]}</price><currencyId>UAH</currencyId><name>${xmlEscape(r["Назва постачальника RU"])}</name><name_ua>${xmlEscape(r["Назва постачальника UA"])}</name_ua><vendorCode>${xmlEscape(r["Артикул постачальника"])}</vendorCode><vendor>${xmlEscape(r["Виробник"])}</vendor><quantity_in_stock>${xmlEscape(r["Кількість постачальника"])}</quantity_in_stock></offer>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="${formatYmlDate(now - 15 * 60000, "Europe/Kyiv")}"><shop><offers>\n${offers.join("\n")}\n</offers></shop></yml_catalog>\n`;
}

/** Повний цикл нового конвеєра (зіставлення, D1, D1b, YML, публікація в локальне тимчасове сховище) на цих даних.
 *  Фід постачальника відтворено з останньої синхронізації — постачальник не викликається. */
export async function pipelineReplay({ book, manifests, tmpDir, config }) {
  const syncRows = [...readSheet(book[SHEETS.main], SHEETS.main).rows, ...readSheet(book[SHEETS.queue], SHEETS.queue).rows];
  const now = Date.now();
  const supplierFile = path.join(tmpDir, "supplier.xml");
  await fsp.writeFile(supplierFile, replaySupplierXml(syncRows, now));
  const cfg = structuredClone(config);
  cfg.feeds = [
    { ...cfg.feeds.find((f) => f.name === "main") },
    { name: "new92", sheets: [SHEETS.queue], manifest: "approved/new92.json", maximumBytes: 50_000_000, filterByManifest: true },
  ];
  const store = new LocalObjectStore(path.join(tmpDir, "store"));
  const catalog = { load: async (names) => ({ sheets: Object.fromEntries(names.filter((n) => book[n]).map((n) => [n, book[n]])), groups: book[SHEETS.groups] }) };
  const report = await runUpdate({ store, config: cfg, manifests, catalog, supplier: new FileSupplierSource(supplierFile), now: () => now, tmpDir });
  const m = await store.getJson(manifestKey("main"));
  report.mainSourceDigest = m?.active?.sourceDigest || null;
  return report;
}

export { YML_HEADERS };
