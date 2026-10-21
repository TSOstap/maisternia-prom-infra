/** Етап C2-C: shadow-звірка нової системи з живим фідом постачальника. Лише читання; результат — агрегати.
 *
 *  Три незалежні частини:
 *   1. Паритет логіки на ТОМУ САМОМУ XML: справжній LIVE Apps Script (VM) проти Node-порту —
 *      mtParse / mtValidateFeed / mtPlan. Розбіжність тут = справжня розбіжність логіки (не залежить від часу).
 *   2. Порівняння з таблицею з урахуванням часу: F:M у таблиці — результат останнього mtUpdate (журнал),
 *      фід — отриманий пізніше. Кожен рядок класифікується: UNCHANGED / SUPPLIER_CHANGE / SUPPLIER_REMOVED /
 *      SUPPLIER_IDENTITY_CHANGE / LOGIC_DIFF / UNCONFIRMED.
 *   3. Сценарії D1/D1b на реальних даних (копії живого фіду зі штучними збуреннями) у тимчасовому сховищі.
 *  Нічого не пише в таблицю, Apps Script, YML чи Prom. */
import fsp from "node:fs/promises";
import path from "node:path";
import { mtSku, mtText } from "../core/text.mjs";
import { parseZonedDate } from "../core/time.mjs";
import { parseSupplierText, validateFeed } from "../core/supplier-feed.mjs";
import { LIVE_COLUMNS, MATCH, matchOffer, planRows, readSheet } from "../core/sync-plan.mjs";
import { approvalManifest, GROUP_HEADERS } from "../core/seal.mjs";
import { objectsFromValues } from "../core/yml.mjs";
import { resolveUnknownOffers, cardKeys, brandKey, modelKey } from "../core/identity.mjs";
import { FileSupplierSource } from "../pipeline/sources.mjs";
import { LocalObjectStore } from "../storage/local.mjs";
import { runUpdate } from "../pipeline/update.mjs";
import { manifestKey } from "../publish/publisher.mjs";
import { SHEETS } from "./catalog-verify.mjs";

const tally = (arr) => arr.reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {});
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Останній успішний штатний mtUpdate з аркуша «Журнал» (рядки: [час, 'СИСТЕМА', '', 'ЗАВЕРШЕНО', '', offers, JSON]). */
export function findLastSync(journalValues) {
  const rows = journalValues || [];
  let lastError = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] || [];
    if (r[1] !== "СИСТЕМА") continue;
    if (r[3] === "ПОМИЛКА" && !lastError) lastError = { at: mtText(r[0]) };
    if (r[3] !== "ЗАВЕРШЕНО") continue;
    let summary;
    try { summary = JSON.parse(mtText(r[6])); } catch { continue; }
    if (summary?.mode !== "ОНОВЛЕННЯ") continue;
    return { at: mtText(r[0]), feedDate: mtText(summary.feedDate), offers: Number(summary.offers), changes: summary.changes ?? null, errorAfter: lastError };
  }
  return null;
}

/** Режим порівняння за часом: той самий знімок фіду, новіший, старіший чи невідомо. */
export function timeMode({ feedDate, lastSync, rowsStamp, timeZone = "Europe/Kyiv" }) {
  if (!lastSync) return { mode: "UNKNOWN", reason: "у журналі немає успішного mtUpdate" };
  if (rowsStamp && lastSync.at && rowsStamp !== lastSync.at) return { mode: "UNKNOWN", reason: "мітка «Оновлено» в рядках не збігається з останнім mtUpdate у журналі" };
  const a = parseZonedDate(feedDate, timeZone);
  const b = parseZonedDate(lastSync.feedDate, timeZone);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { mode: "UNKNOWN", reason: "дата фіду або журналу не розпізнана" };
  if (a === b) return { mode: "SAME_SNAPSHOT", minutesAfterSync: 0 };
  return a > b ? { mode: "NEWER_FEED", minutesAfterSync: Math.round((a - b) / 60000) } : { mode: "OLDER_FEED", minutesAfterSync: Math.round((a - b) / 60000) };
}

/**
 * Порівняння плану нової системи з F:M таблиці (результат останнього штатного mtUpdate).
 *
 * Класи:
 *   UNCHANGED                 — статус і всі перевірені групи колонок збіглися;
 *   SUPPLIER_CHANGE           — постачальник змінив ціну / наявність / кількість; НЕзмінені групи перевірено окремо;
 *   SUPPLIER_REMOVED          — у таблиці ЗІСТАВЛЕНО (або інший стан), тепер зник із фіду (D1);
 *   STATUS_CHANGE             — статус змінився з вини даних постачальника (артикул, назва, валюта, ціна…) — D1b;
 *   RECOVERED                 — у таблиці не ЗІСТАВЛЕНО, тепер ЗІСТАВЛЕНО;
 *   NOT_SYNCED_YET            — рядок не належить останньому mtUpdate (порожнє/інше «Оновлено») — не порівнюється;
 *   LOGIC_DIFF                — справжня розбіжність: за тих самих вхідних даних інший результат;
 *   UNCONFIRMED               — режим часу не дозволяє висновку (OLDER_FEED / UNKNOWN).
 * Групи колонок і їхні входи: [F,G,H] ← ціна постачальника; [I,J] ← available; [K] ← quantity_in_stock.
 * SAME_SNAPSHOT: будь-яка розбіжність статусу або F:K = LOGIC_DIFF.
 */
export function compareWithSheet({ rows, plan, offers, mode, syncStamp }) {
  const classes = [];
  const changeKinds = [];
  const statusChanges = [];
  let verifiedRows = 0;
  let okRows = 0;
  const eq = (p, j) => mtText(p.before[j]) === mtText(p.next[j]);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const p = plan[i];
    const offer = offers.get(mtText(r["ID постачальника"]));
    const sheetStatus = mtText(p.before[6]);
    const stamp = mtText(r["Оновлено"]);
    let cls;
    if (!stamp || (syncStamp && stamp !== syncStamp)) cls = "NOT_SYNCED_YET";
    else if (mode === "SAME_SNAPSHOT") {
      cls = sheetStatus === p.match && [0, 1, 2, 3, 4, 5].every((j) => eq(p, j)) ? "UNCHANGED" : "LOGIC_DIFF";
      if (cls === "UNCHANGED") verifiedRows++;
    } else if (mode === "NEWER_FEED") {
      if (sheetStatus !== p.match) {
        if (p.match === MATCH.MISSING) cls = "SUPPLIER_REMOVED";
        else if (p.match === MATCH.OK) cls = "RECOVERED";
        else cls = "STATUS_CHANGE";
        statusChanges.push(`${sheetStatus || "—"} → ${p.match}`);
      } else if (p.match !== MATCH.OK) {
        // Той самий не-OK статус: план має лишити F:K як були (LIVE змінює лише L, M) — інакше розбіжність.
        cls = [0, 1, 2, 3, 4, 5].every((j) => eq(p, j)) ? "UNCHANGED" : "LOGIC_DIFF";
        if (cls === "UNCHANGED") verifiedRows++;
      } else {
        okRows++;
        const priceSame = Number(r["Ціна постачальника"]) === offer.price;
        const availSame = (r["Наявність"] === "+") === offer.available;
        const qtySame = offer.quantity === "" || mtText(r["Кількість постачальника"]) === mtText(Number(offer.quantity));
        let bad = false;
        let verified = false;
        if (priceSame) { verified = true; if (![0, 1, 2].every((j) => eq(p, j))) bad = true; } else changeKinds.push(offer.price > Number(r["Ціна постачальника"]) ? "ціна ↑" : "ціна ↓");
        if (availSame) { verified = true; if (![3, 4].every((j) => eq(p, j))) bad = true; } else changeKinds.push(offer.available ? "наявність - → +" : "наявність + → -");
        if (qtySame) { if (!eq(p, 5)) bad = true; } else changeKinds.push("кількість");
        if (verified && !bad) verifiedRows++;
        cls = bad ? "LOGIC_DIFF" : priceSame && availSame && qtySame ? "UNCHANGED" : "SUPPLIER_CHANGE";
      }
    } else cls = sheetStatus === p.match && [0, 1, 2, 3, 4, 5].every((j) => eq(p, j)) ? "UNCHANGED" : "UNCONFIRMED";
    classes.push(cls);
  }
  return {
    byClass: tally(classes), supplierChangeKinds: tally(changeKinds), statusChanges: tally(statusChanges),
    logicDiffs: classes.filter((c) => c === "LOGIC_DIFF").length,
    verifiedRows, comparableRows: classes.filter((c) => c !== "NOT_SYNCED_YET").length, okRows,
  };
}

/** Паритет на тому самому XML: LIVE (VM) проти Node-порту. Повертає лише кількості розбіжностей. */
export async function liveParity({ gas, xml, rows, stamp, previousCount, now, supplierConfig, pricing }) {
  const out = { parseCountEqual: false, offersDiff: null, validateEqual: false, planDiff: null, statusDiff: null };
  let live, liveErr, mine, mineErr;
  try { live = gas.mtParse(xml); } catch (e) { liveErr = e.message; }
  try { mine = await parseSupplierText(xml, { maximumChars: 45_000_000 }); } catch (e) { mineErr = e.message; }
  out.parseErrorsEqual = (liveErr || null) === (mineErr || null);
  // Тексти помилок не виводяться (лише факт): захист тримається не на припущенні про їхній вміст.
  if (!live || !mine) return { ...out, liveFailed: Boolean(liveErr), mineFailed: Boolean(mineErr) };
  out.parseCountEqual = live.count === mine.count;
  const lo = plain(live.offers);
  let offersDiff = 0;
  for (const [id, o] of mine.offers) if (JSON.stringify(plain(o)) !== JSON.stringify(lo[id])) offersDiff++;
  out.offersDiff = offersDiff + Math.abs(Object.keys(lo).length - mine.offers.size);
  let ve1, ve2;
  try { gas.mtValidateFeed(live, previousCount, now); } catch (e) { ve1 = e.message; }
  try { validateFeed(mine, previousCount, now, supplierConfig); } catch (e) { ve2 = e.message; }
  out.validateEqual = (ve1 || null) === (ve2 || null) || (/Unparseable/.test(ve1 || "") && ve2 === "Немає дати YML");
  out.validateFailed = Boolean(ve2);
  const lp = plain(gas.mtPlan(rows, live, stamp));
  const mp = plain(planRows(rows, mine.offers, stamp, pricing));
  let planDiff = 0, statusDiff = 0;
  for (let i = 0; i < mp.length; i++) {
    if (JSON.stringify(mp[i]) !== JSON.stringify(lp[i])) planDiff++;
    if (mp[i].match !== lp[i].match) statusDiff++;
  }
  out.planDiff = planDiff + Math.abs(lp.length - mp.length);
  out.statusDiff = statusDiff;
  out.rows = mp.length;
  return out;
}

// ---------- збурення живого XML для сценаріїв D1/D1b (лише в пам'яті / тимчасовому каталозі runner) ----------
const offerRe = (id) => new RegExp(`<offer\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</offer>`);
export const perturb = {
  drop: (xml, ids) => ids.reduce((x, id) => x.replace(offerRe(id), ""), xml),
  reissue: (xml, map) => [...map].reduce((x, [from, to]) => x.replace(offerRe(from), (b) => b.replace(`id="${from}"`, `id="${to}"`).replace(`/p${from}-`, `/p${to}-`)), xml),
  tag: (xml, id, tag, value) => xml.replace(offerRe(id), (b) => b.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`), `<${tag}>${value}</${tag}>`)),
  duplicate: (xml, id, newId) => xml.replace(offerRe(id), (b) => b + "\n" + b.replace(`id="${id}"`, `id="${newId}"`).replace(`/p${id}-`, `/p${newId}-`)),
};

/**
 * Сценарії D1/D1b на реальному каталозі й реальному фіді.
 * Повертає по кожному сценарію: синк, стани фідів, ізоляції, перев'язки, «нові» — і булеві очікування.
 */
export async function runScenarios({ book, xml, config, tmpDir, expected }) {
  const groups = objectsFromValues(book[SHEETS.groups], GROUP_HEADERS);
  const queueRows = readSheet(book[SHEETS.queue], SHEETS.queue).rows;
  const mainRows = readSheet(book[SHEETS.main], SHEETS.main).rows;
  const manifests = { main: expected.main, new92: { ...approvalManifest(queueRows, groups), ids: queueRows.map((r) => mtText(r["Offer ID"])).sort() } };
  const cfg = structuredClone(config);
  cfg.feeds = [{ ...cfg.feeds.find((f) => f.name === "main") }, { name: "new92", sheets: [SHEETS.queue], manifest: "approved/new92.json", maximumBytes: 50_000_000, filterByManifest: true }];
  const catalog = { load: async (names) => ({ sheets: Object.fromEntries(names.filter((n) => book[n]).map((n) => [n, book[n]])), groups: book[SHEETS.groups] }) };

  // Кандидати для збурень: картки main, які в живому фіді зіставляються (детерміновано за ID).
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000 });
  // Кандидати: зіставлені, з унікальним артикулом серед карток і обома опорними назвами — щоб результат
  // сценарію залежав від правила D1/D1b, а не від випадкових збігів у даних.
  const skuCount = new Map();
  for (const r of [...mainRows, ...queueRows]) { const k = mtSku(r["Артикул постачальника"]); if (k) skuCount.set(k, (skuCount.get(k) || 0) + 1); }
  const ok = mainRows.filter((r) => matchOffer(r, parsed.offers.get(mtText(r["ID постачальника"]))) === MATCH.OK
    && skuCount.get(mtSku(r["Артикул постачальника"])) === 1 && mtText(r["Назва постачальника UA"]).trim() && mtText(r["Назва постачальника RU"]).trim())
    .map((r) => mtText(r["ID постачальника"])).sort();
  // Масове зникнення: трохи понад поріг аномалії D1 (max(N, частка каталогу)), але менше 20% фіду —
  // щоб спрацював саме новий захист, а не правило LIVE «різке зменшення кількості».
  const totalRows = mainRows.length + queueRows.length;
  const limit = Math.max(cfg.policy.anomaly.maxNewlyMissing, Math.ceil(totalRows * cfg.policy.anomaly.maxNewlyMissingRatio));
  const massCount = limit + 20;
  if (massCount >= parsed.count * 0.2) throw new Error("Каталог замалий для сценарію масового зникнення");
  if (ok.length < 60 + massCount) throw new Error("Замало зіставлених карток для сценаріїв");
  const pick = (from, n) => ok.slice(from, from + n);
  const dropIds = pick(10, 3), conflictIds = pick(20, 4), reissueIds = pick(30, 5), dupId = pick(40, 1)[0], massIds = pick(60, massCount);
  const reissue = new Map(reissueIds.map((id, i) => [id, String(3990000000 + i)]));

  const t0 = Date.now();
  let n = 0;
  const run = async (storeName, text, now) => {
    const file = path.join(tmpDir, `s${++n}.xml`);
    await fsp.writeFile(file, text);
    const store = new LocalObjectStore(path.join(tmpDir, storeName));
    const r = await runUpdate({ store, config: cfg, manifests, catalog, supplier: new FileSupplierSource(file), now: () => now, tmpDir });
    await fsp.unlink(file).catch(() => {});
    return { r, store };
  };
  const brief = (r) => ({
    sync: r.sync.state, anomaly: /Аномально/.test(r.sync.error || ""),
    feeds: Object.fromEntries((r.feeds || []).map((f) => [f.feed, { state: f.state, count: f.count, missing: f.unavailableMissing, conflicts: f.isolatedConflicts }])),
    relinked: r.identity?.relinked ?? null, manual: r.identity?.manualReview ?? null, newProducts: r.newProducts?.total ?? null,
    missing: r.availability?.missing ?? null, returned: r.availability?.returned ?? null, conflictsOpen: r.conflicts?.open ?? null,
  });
  const S = {};
  const base = await run("s0", xml, t0);
  S.S0_baseline = brief(base.r);
  const b = S.S0_baseline;

  const s1 = await run("s1", perturb.drop(xml, dropIds), t0);
  S.S1_drop3 = brief(s1.r);
  const s4 = await run("s1", xml, t0 + 60000); // той самий стан: товари повернулися (зсув 1 хв — вік фіду не впливає)
  S.S4_return3 = brief(s4.r);

  let cx = xml;
  cx = perturb.tag(cx, conflictIds[0], "vendorCode", "SHADOW-CONFLICT");
  cx = perturb.tag(cx, conflictIds[1], "price", "0");
  cx = perturb.tag(cx, conflictIds[2], "currencyId", "USD");
  cx = perturb.tag(cx, conflictIds[3], "name_ua", "Інший комплект 2 АКБ");
  S.S2_conflict4 = brief((await run("s2", cx, t0)).r);

  S.S3_reissue5 = brief((await run("s3", perturb.reissue(xml, reissue), t0)).r);
  S.S5_duplicate = brief((await run("s5", perturb.duplicate(xml, dupId, "3990000100"), t0)).r);

  const before = await base.store.getJson(manifestKey("main"));
  const s6 = await run("s0", perturb.drop(xml, massIds), t0 + 60000);
  S.S6_mass = { ...brief(s6.r), dropped: massCount, anomalyLimit: limit, previousFeedKept: JSON.stringify(await base.store.getJson(manifestKey("main"))) === JSON.stringify(before) };

  const expect = {
    "S0: синк OK і обидва фіди опубліковано": b.sync === "OK" && b.feeds.main?.state === "PUBLISHED" && b.feeds.new92?.state === "PUBLISHED",
    "S1: 3 зниклі не видалено — опубліковано як «немає в наявності», фід не заблоковано": S.S1_drop3.feeds.main?.state === "PUBLISHED" && S.S1_drop3.feeds.main.count === b.feeds.main?.count && S.S1_drop3.feeds.main.missing === (b.feeds.main?.missing || 0) + 3,
    "S4: після повернення — ті самі картки знову зіставлено": S.S4_return3.returned === 3,
    "S2: 4 конфлікти ізольовано, решта каталогу опублікована": S.S2_conflict4.feeds.main?.state === "PUBLISHED" && S.S2_conflict4.feeds.main.conflicts === (b.feeds.main?.conflicts || 0) + 4,
    "S3: 5 перевипущених ID прив'язано до наявних карток, без дублів": S.S3_reissue5.relinked === 5 && S.S3_reissue5.newProducts === b.newProducts,
    "S5: дубль живої картки — у ручну чергу, не новий товар": S.S5_duplicate.manual === (b.manual || 0) + 1 && S.S5_duplicate.newProducts === b.newProducts,
    "S6: масове зникнення (поріг аномалії + 20) — синк зупинено саме захистом D1, попередній фід збережено": S.S6_mass.sync === "ERROR" && S.S6_mass.anomaly && S.S6_mass.previousFeedKept,
  };
  return { scenarios: S, expect, ms: Date.now() - t0 };
}

/** Нові/змінені/сумнівні offers постачальника відносно всіх відомих карток (без застосування змін). */
export function supplierUniverse({ book, offers }) {
  const known = [SHEETS.main, SHEETS.queue, SHEETS.deferred].filter((n) => book[n]).flatMap((n) => readSheet(book[n], n).rows);
  const frozen = new Set((book[SHEETS.frozen] || []).slice(1).map((r) => mtText(r[0])));
  const sync = [SHEETS.main, SHEETS.queue].flatMap((n) => readSheet(book[n], n).rows);
  const cards = known.map((r) => cardKeys(r));
  const knownIds = new Set([...known.map((r) => mtText(r["ID постачальника"])), ...known.map((r) => mtText(r["Offer ID"])), ...frozen]);
  const unknown = [...offers.values()].filter((o) => !knownIds.has(o.id));
  const orphanIds = new Set(sync.filter((r) => !offers.has(mtText(r["ID постачальника"]))).map((r) => mtText(r["Offer ID"])));
  const decisions = resolveUnknownOffers({ offers: unknown, cards, orphanIds });
  // Виробник і модель: лише якщо постачальник їх передає в операційному фіді.
  let vendorPresent = 0, vendorMismatch = 0, modelPresent = 0, modelMismatch = 0;
  for (const r of sync) {
    const o = offers.get(mtText(r["ID постачальника"]));
    if (!o) continue;
    if (o.vendor) { vendorPresent++; if (brandKey(o.vendor) !== brandKey(r["Виробник"])) vendorMismatch++; }
    if (o.model) { modelPresent++; if (mtText(r["Модель"]).trim() && modelKey(o.model) !== modelKey(r["Модель"])) modelMismatch++; }
  }
  return {
    feedOffers: offers.size, knownCards: known.length, frozenIds: frozen.size,
    frozenStillInFeed: [...frozen].filter((id) => offers.has(id)).length,
    unknownOffers: unknown.length, decisions: tally(decisions.map((d) => d.decision)),
    manualReasons: tally(decisions.filter((d) => d.decision === "MANUAL_REVIEW").map((d) => d.reason)),
    syncCardsMissingFromFeed: orphanIds.size,
    vendor: { present: vendorPresent, mismatch: vendorMismatch }, model: { present: modelPresent, mismatch: modelMismatch },
  };
}
