/** Один цикл оновлення (те, що зараз робить mtUpdate + mtAfterUpdate_), у shadow-режимі:
 *  результат пишеться лише в окреме сховище нової системи, робоча таблиця не змінюється.
 *
 *  1. Фід постачальника: потоковий розбір і перевірка повноти/свіжості.
 *  2. Знімок каталогу: аркуші синхронізації, дублікати ID між аркушами — зупинка.
 *  3. План F:M для всіх рядків; ЄДИНИЙ запис state/operational.json (комміт синхронізації).
 *  4. Кожен фід окремо: формування → незалежна перевірка → публікація. Збій фіду не скасовує синхронізацію
 *     і не зачіпає інші фіди; Prom продовжує отримувати попередню перевірену версію.
 *  5. Нові товари постачальника — лише звіт.
 *  6. Звіт запуску та лічильники використання (контроль безплатних квот). */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitize, mtText } from "../core/text.mjs";
import { parseSupplierFeed, validateFeed } from "../core/supplier-feed.mjs";
import { LIVE_COLUMNS, MATCH, changeEntries, planRows, readSheet } from "../core/sync-plan.mjs";
import { buildYml, objectsFromValues } from "../core/yml.mjs";
import { GROUP_HEADERS, YML_HEADERS } from "../core/seal.mjs";
import { detectNewProducts, duplicateReport } from "../core/catalog-guards.mjs";
import { publishFeed } from "../publish/publisher.mjs";
import { applyAvailabilityPolicy, planView, resolveIdentity } from "../core/d1.mjs";

const OPERATIONAL_KEY = "state/operational.json";
const SYNC_KEY = "state/sync.json";
const SEEN_KEY = "state/supplier-seen.json";
const LINKS_KEY = "state/links.json";
const OWN_STOCK_KEY = "state/own-stock.json";

function fileSink(file) {
  const out = fs.createWriteStream(file, { encoding: "utf8" });
  return {
    write(text) { return out.write(text) ? undefined : new Promise((r) => out.once("drain", r)); },
    close() { return new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve()))); },
    destroy() { out.destroy(); },
  };
}

function timer() {
  const start = Date.now();
  let last = start;
  const ms = {};
  return { lap(stage) { const now = Date.now(); ms[stage] = now - last; last = now; }, ms, total: () => Date.now() - start };
}

/** Поточні операційні значення: зі стану нової системи (shadow), інакше — зі знімка таблиці. */
function overlayOperational(rows, operational) {
  if (!operational?.rows) return rows;
  return rows.map((r) => {
    const saved = operational.rows[mtText(r["Offer ID"])];
    if (!saved) return r;
    const copy = { ...r };
    LIVE_COLUMNS.forEach((k, i) => { copy[k] = saved[i]; });
    return copy;
  });
}

/**
 * @param ctx { store, catalog, supplier, config, now?: () => ms, tmpDir?, manifests?: { feed: manifest } }
 */
export async function runUpdate(ctx) {
  const { store, catalog, supplier, config } = ctx;
  const now = ctx.now ? ctx.now() : Date.now();
  const stamp = new Date(now).toISOString();
  const t = timer();
  const report = { kind: "RUN_REPORT_V1", startedAt: stamp, mode: "SHADOW", sync: null, feeds: [], newProducts: null, warnings: [] };
  const syncState = (await store.getJson(SYNC_KEY)) || {};

  // ---------- синхронізація цін і наявності ----------
  let rowsBySheet;
  let operational;
  try {
    const parsed = await parseSupplierFeed(supplier.chunks(), { maximumChars: config.supplier.maximumChars, identityFields: true });
    validateFeed(parsed, syncState.lastFeedCount, now, config.supplier);
    t.lap("постачальник");

    const snapshot = await catalog.load(config.catalog.knownSheets);
    const previous = await store.getJson(OPERATIONAL_KEY);
    t.lap("каталог");

    const allIds = new Set();
    rowsBySheet = {};
    const plans = {};
    const sheetRows = {};
    for (const name of config.catalog.syncSheets) {
      const values = snapshot.sheets[name];
      if (!values) throw new Error("Немає аркуша " + name);
      const view = readSheet(values, name);
      if (name === config.catalog.requiredNonEmptySheet && !view.rows.length) throw new Error("Основний каталог порожній");
      for (const r of view.rows) {
        if (allIds.has(r["Offer ID"])) throw new Error("ID є в обох аркушах");
        allIds.add(r["Offer ID"]);
      }
      sheetRows[name] = overlayOperational(view.rows, previous);
    }
    const otherRows = config.catalog.knownSheets.filter((n) => !config.catalog.syncSheets.includes(n) && snapshot.sheets[n]?.length)
      .flatMap((n) => readSheet(snapshot.sheets[n], n).rows);

    // D1 п. 4–7: стабільна картка при зміні ID постачальника (до плану, щоб перев'язані картки оновились у цьому ж запуску).
    const syncAll = Object.values(sheetRows).flat();
    const identity = resolveIdentity({
      syncRows: syncAll, knownRows: [...syncAll, ...otherRows], offers: parsed.offers,
      links: await store.getJson(LINKS_KEY), autoRelink: config.identity?.autoRelink !== false, now,
    });
    for (const name of config.catalog.syncSheets) {
      const rows = sheetRows[name];
      plans[name] = planRows(rows.map((r) => planView(r, identity.effective)), parsed.offers, stamp, config.pricing);
    }
    // D1 п. 2, 3, 8, 9: власний залишок, облік відсутності, пропозиції, захист від масового «зникнення».
    const availability = applyAvailabilityPolicy({
      plans: Object.values(plans), previousMissing: previous?.missing || {}, ownStock: await store.getJson(OWN_STOCK_KEY),
      now, policy: config.policy, pricing: config.pricing,
    });
    if (availability.anomaly) {
      throw new Error(`Аномально багато товарів зникло за один запуск (${availability.anomaly.newlyMissing} > ${availability.anomaly.limit}): вважаємо фід несправним, стан і фіди не змінено`);
    }
    for (const name of config.catalog.syncSheets) {
      rowsBySheet[name] = sheetRows[name].map((r, i) => {
        const copy = { ...r };
        LIVE_COLUMNS.forEach((k, j) => { copy[k] = plans[name][i].next[j]; });
        return copy;
      });
    }
    t.lap("зіставлення");

    const opRows = {};
    for (const name of config.catalog.syncSheets) for (const p of plans[name]) opRows[p.id] = p.next;
    if (identity.relinked.length || !(await store.head(LINKS_KEY))) await store.putJson(LINKS_KEY, identity.links);
    operational = { kind: "OPERATIONAL_STATE_V1", syncState: "OK", lastSuccess: stamp, feedDate: parsed.date, feedCount: parsed.count, rows: opRows, missing: availability.missing };
    await store.putJson(OPERATIONAL_KEY, operational); // комміт синхронізації — один запис
    t.lap("запис стану");

    await store.putJson("reports/identity/latest.json", { generatedAt: stamp, relinked: identity.relinked, manualReview: identity.manual });
    await store.putJson("reports/missing/latest.json", {
      generatedAt: stamp, missing: Object.keys(availability.missing).length, newlyMissing: availability.newlyMissing,
      returned: availability.returned, proposals: availability.proposals, note: "Лише пропозиції. Автоматичного приховування/видалення немає.",
    });
    report.identity = { relinked: identity.relinked.length, manualReview: identity.manual.length };
    report.availability = { missing: Object.keys(availability.missing).length, newlyMissing: availability.newlyMissing.length, returned: availability.returned.length, proposals: availability.proposals.length };

    const changes = config.catalog.syncSheets.flatMap((name) => changeEntries(stamp, name, plans[name]));
    if (changes.length) await store.putJson(`runs/${stamp.slice(0, 7)}/${stamp.replace(/[:.]/g, "-")}-changes.json`, changes);

    report.sync = {
      state: "OK", feedDate: parsed.date, offers: parsed.count, changes: changes.length,
      sheets: config.catalog.syncSheets.map((name) => ({
        name, rows: plans[name].length,
        matched: plans[name].filter((x) => x.match === MATCH.OK).length,
        held: plans[name].filter((x) => x.match !== MATCH.OK).length,
        byStatus: plans[name].reduce((acc, x) => ((acc[x.match] = (acc[x.match] || 0) + 1), acc), {}),
      })),
    };
    const dups = duplicateReport(rowsBySheet);
    if (dups.supplierIdDuplicates.length) report.warnings.push({ code: "SUPPLIER_ID_DUPLICATES", count: dups.supplierIdDuplicates.length, sample: dups.supplierIdDuplicates.slice(0, 5) });

    // ---------- нові товари (лише звіт) ----------
    const knownIds = new Set();
    for (const values of Object.values(snapshot.sheets)) {
      if (!values.length) continue;
      const h = values[0].map(mtText);
      const i = h.indexOf("ID постачальника");
      const j = h.indexOf("Offer ID");
      for (const row of values.slice(1)) { if (i >= 0 && row[i] !== "" && row[i] != null) knownIds.add(mtText(row[i])); if (j >= 0 && row[j]) knownIds.add(mtText(row[j])); }
    }
    // Перев'язані та неоднозначні offers — не «нові товари» (щоб не створити другу картку).
    for (const r of identity.relinked) knownIds.add(r.to);
    for (const m of identity.manual) knownIds.add(m.offerId);
    const seen = (await store.getJson(SEEN_KEY)) || {};
    const detected = detectNewProducts({ offers: parsed.offers, knownIds, seen: seen.items || {}, now });
    await store.putJson(SEEN_KEY, { kind: "SUPPLIER_SEEN_V1", updatedAt: stamp, items: detected.seen });
    await store.putJson("reports/new-products/latest.json", { generatedAt: stamp, total: detected.candidates.length, newSinceLastRun: detected.newSinceLastRun, disappeared: detected.disappearedCandidates, candidates: detected.candidates });
    report.newProducts = { total: detected.candidates.length, newSinceLastRun: detected.newSinceLastRun.length };
    t.lap("нові товари");

    await store.putJson(SYNC_KEY, { ...syncState, state: "OK", lastSuccess: stamp, lastAttempt: stamp, lastError: "", lastFeedCount: parsed.count });
    ctx.groups = snapshot.groups;
  } catch (error) {
    const message = sanitize(error);
    await store.putJson(SYNC_KEY, { ...syncState, state: "ERROR", lastAttempt: stamp, lastError: message }).catch(() => {});
    report.sync = { state: "ERROR", error: message };
    report.timingsMs = t.ms;
    report.finishedAt = new Date().toISOString();
    report.usage = await recordUsage(store, report, t.total());
    await store.putJson("state/last-run.json", report).catch(() => {});
    return report;
  }

  // ---------- фіди (кожен ізольовано) ----------
  const groups = objectsFromValues(ctx.groups, GROUP_HEADERS);
  const tmpDir = ctx.tmpDir || os.tmpdir();
  for (const feed of config.feeds.filter((f) => f.enabled !== false)) {
    const result = { feed: feed.name };
    const file = path.join(tmpDir, `feed-${feed.name}-${process.pid}-${Date.now()}.xml`);
    try {
      const manifest = ctx.manifests?.[feed.name] || (await store.getJson(feed.manifest));
      if (!manifest) throw new Error("Немає погодженого паспорта набору для фіду " + feed.name);
      let rows = feed.sheets.flatMap((name) => rowsBySheet[name] || []);
      // Фід лише з погоджених ID (напр. NEW92 з черги, де можуть бути й непогоджені кандидати).
      if (feed.filterByManifest) {
        if (!Array.isArray(manifest.ids)) throw new Error("Паспорт фіду " + feed.name + " не містить списку ids");
        const allowed = new Set(manifest.ids);
        rows = rows.filter((r) => allowed.has(mtText(r["Offer ID"])));
      }
      for (const k of YML_HEADERS) if (rows.length && !(k in rows[0])) throw new Error("Немає унікальної колонки " + k);
      const sink = fileSink(file);
      let built;
      try {
        built = await buildYml({
          rows, groups, manifest, pricing: config.pricing, maximumBytes: feed.maximumBytes, sink, missingPolicy: config.policy?.missing || "block",
          meta: { syncState: operational.syncState, lastSuccess: operational.lastSuccess, now },
          config: config.yml,
        });
      } finally { await sink.close(); }
      t.lap("формування " + feed.name);
      const published = await publishFeed(store, feed.name, file, built, {
        retain: config.publish.retainVersions, readback: config.publish.readback, gzip: Boolean(feed.gzip),
        assertSourceUnchanged: async () => {
          const current = await store.getJson(OPERATIONAL_KEY);
          if (!current || current.lastSuccess !== operational.lastSuccess) throw new Error("Джерело змінилося під час формування YML");
        },
      });
      t.lap("публікація " + feed.name);
      Object.assign(result, { state: published.reused ? "REUSED" : "PUBLISHED", count: built.count, bytes: built.bytes, sha256: built.sha256, storedBytes: published.active.storedBytes, removedVersions: published.removed?.length || 0, unavailableMissing: built.unavailableMissing, ownStock: built.ownStock, excludedNeverPriced: built.excludedNeverPriced });
    } catch (error) {
      Object.assign(result, { state: "ERROR", error: sanitize(error) });
      await store.putJson(`state/feed-${feed.name}-error.json`, { at: stamp, error: result.error }).catch(() => {});
    } finally {
      await fsp.unlink(file).catch(() => {});
    }
    report.feeds.push(result);
  }
  report.timingsMs = t.ms;
  report.finishedAt = new Date().toISOString();
  report.usage = await recordUsage(store, report, t.total());
  await store.putJson("state/last-run.json", report);
  await store.putJson(`runs/${stamp.slice(0, 7)}/${stamp.replace(/[:.]/g, "-")}-report.json`, report);
  return report;
}

/** Накопичення використання за місяць: операції R2, байти, тривалість — основа контролю квот. */
async function recordUsage(store, report, durationMs) {
  const month = report.startedAt.slice(0, 7);
  const key = `usage/${month}.json`;
  const usage = (await store.getJson(key)) || { month, runs: 0, durationMs: 0, classA: 0, classB: 0, bytesUploaded: 0 };
  const ops = store.ops || {};
  usage.runs += 1;
  usage.durationMs += durationMs;
  // Лічильник сховища накопичувальний за процес; фіксуємо приріст від попереднього запису.
  const delta = (k) => (ops[k] || 0) - (store.__lastUsage?.[k] || 0);
  usage.classA += delta("classA") + 2; // +2: цей запис usage та last-run
  usage.classB += delta("classB");
  usage.bytesUploaded += delta("bytesUploaded");
  store.__lastUsage = { ...ops };
  await store.putJson(key, usage).catch(() => {});
  return usage;
}
