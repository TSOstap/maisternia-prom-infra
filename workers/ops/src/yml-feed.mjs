/** Постійний YML нової системи для Prom (рішення власника 03.11.2026: «підготуй постійне посилання… коли Cloudflare оновлює ціни в
 *  таблиці, новий YML також повинен оновлюватися»). Сервер mm-ops (Durable Object), Workers Free.
 *
 *  • Повна збірка (buildFeed): «Основний каталог» TEST — лише колонки YML, порціями рядків (повний аркуш 135 МБ > пам'яті Worker);
 *    кожен товар — renderOffer (ТІ САМІ правила, що й робочий buildYml: Catalog Controls — видалений без offer, знятий — «немає в
 *    наявності»; D1 / D1b; ізоляція рядка — останній опублікований offer примусово недоступний). XML товарів — у SQLite нової версії;
 *    перемикання версії атомарне, попередня версія лишається для запитів, що вже читають файл.
 *  • Оновлення цін (syncFeed): після «Ціни й наявність» — лише колонки цін і наявності; у готовому offer змінюються ціна / стара ціна /
 *    available / in_stock / кількість (patchOfferLive — ті самі перевірки формули). Без повного перечитування.
 *  • Тимчасово не публікуються (hold) — як LIVE MTY_TEMP_EXCLUDE_IDS, до рішення власника.
 *  • Віддача — потоком з SQLite (serveFeed): заголовок (дата останньої зміни) + offer у порядку аркуша + кінець. */
import defaultConfig from "../../../config/default.json" with { type: "json" };
import { productionConfig } from "../../../src/pipeline/production.mjs";
import { groupsForYml, headerXml, YML_FOOTER, renderOffer, patchOfferLive, objectsFromValues, GROUP_HEADERS } from "../../../src/core/yml.mjs";
import { formatYmlDate } from "../../../src/core/time.mjs";
import { PRESENCE, PRESENCE_COLUMN } from "../../../src/core/supplier-presence.mjs";
import { mtText } from "../../../src/core/text.mjs";
import { GoogleSheetsCatalogSource } from "../../../src/pipeline/google-sheets.mjs";
import { TEST_SHEET_ID } from "../../../src/pipeline/safe-write/write-target.mjs";
import { googleTokenSource } from "./google-auth.mjs";
import { sheetsReaders, narrowControls, approvedContract } from "./prices-job.mjs";

const MAIN = "Основний каталог";
/** Колонки, які читає offerXml (+ присутність у постачальника). */
export const YML_COLUMNS = Object.freeze(["Offer ID", "Статус імпорту", "Стан синхронізації", "Оновлено", "Валюта", "Наявність", "Ціна постачальника", "Знижка", "Ціна", "Ціна кінцева",
  "Назва UA", "Назва RU", "Опис UA", "Опис RU", "Група ID", "Категорія Prom ID", "Категорія Prom URL", "Фото JSON", "Характеристики JSON", "Код товару Prom", "Виробник", "Країна", "GTIN",
  "Запити RU", "Запити UA", "Модель", "Кількість постачальника", PRESENCE_COLUMN]);
/** Колонки для оновлення цін у готових offer. */
export const LIVE_SYNC_COLUMNS = Object.freeze(["Offer ID", "Статус імпорту", "Стан синхронізації", "Наявність", "Ціна постачальника", "Знижка", "Ціна", "Ціна кінцева", "Кількість постачальника", PRESENCE_COLUMN]);
/** Тимчасово не публікуються — як у LIVE (Yml.gs MTY_TEMP_EXCLUDE_IDS); рішення власника 03.11: «поки не змінюй їхній статус публікації». */
export const HOLD_DEFAULT = Object.freeze(["1561514532", "2560360931", "2689669665", "2894494274", "3166947187"]);
export const DATE_MARK = "{{YML_DATE}}";
// 04.11: offer зберігаються пачками (yml_chunk: ids — Offer ID через кому, offers — JSON-масив XML у порядку аркуша). Workers Free
// дозволяє 100 000 записаних рядків SQLite на добу; рядок на кожен offer (вставка + видалення старої версії ≈ 10 000 на збірку) вичерпав
// ліміт 03.11 → DO не запускався, фід віддавав 500. Пачка ≈ CHUNK_BYTES → ≈ 100 рядків на збірку. Стара таблиця yml_offer не читається.
export const FEED_SCHEMA = Object.freeze([
  "CREATE TABLE IF NOT EXISTS yml_chunk (ver INTEGER NOT NULL, ord INTEGER NOT NULL, n INTEGER NOT NULL, ids TEXT NOT NULL, offers TEXT NOT NULL, PRIMARY KEY (ver, ord))",
]);
/** Розмір пачки offer (символи JSON); межа значення SQLite DO — 2 МБ. */
export const CHUNK_BYTES = 500_000;
/** Мінімум товарів відносно попередньої версії (захист від неповного читання таблиці). */
export const MIN_RATIO = 0.9;
const ROWS_PER_CHUNK = 400;

/** SQL-доступ до фіду (той самий SQLite Durable Object). */
export class FeedStore {
  constructor(sql, tx) {
    this.sql = sql; this.tx = tx;
    // Ліміт записів Workers Free вичерпано — таблиця вже є з попередніх запусків; віддача фіду (лише читання) має працювати далі.
    try { for (const q of FEED_SCHEMA) sql.exec(q); } catch (e) { this.schemaError = String(e?.message || e); }
  }
  rows(q, ...b) { return this.sql.exec(q, ...b).toArray(); }
  meta() { const r = this.rows("SELECT v FROM meta WHERE k = 'yml'")[0]; return r ? JSON.parse(r.v) : null; }
  putMeta(m) { this.sql.exec("INSERT INTO meta (k, v) VALUES ('yml', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(m)); }
  hold() { const r = this.rows("SELECT v FROM meta WHERE k = 'yml-hold'")[0]; return new Set(r ? JSON.parse(r.v) : HOLD_DEFAULT); }
  setHold(ids) { this.sql.exec("INSERT INTO meta (k, v) VALUES ('yml-hold', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify([...new Set(ids.map(String))].sort())); }
  /** Версія, зібрана до 04.11, лежить у старій таблиці yml_offer (рядок на offer) — віддається звідти, доки не зібрано нову. */
  legacy(ver) {
    this.legacyCache ??= new Map();
    if (!this.legacyCache.has(ver)) {
      let chunked = false, old = false;
      try { chunked = this.rows("SELECT 1 AS x FROM yml_chunk WHERE ver = ? LIMIT 1", ver).length > 0; } catch { /* таблиці ще немає */ }
      if (!chunked) try { old = this.rows("SELECT 1 AS x FROM yml_offer WHERE ver = ? LIMIT 1", ver).length > 0; } catch { /* немає */ }
      this.legacyCache.set(ver, !chunked && old);
    }
    return this.legacyCache.get(ver);
  }
  /** XML одного offer версії ver (пошук пачки за списком ID). */
  get(ver, id) {
    if (this.legacy(ver)) return this.rows("SELECT xml FROM yml_offer WHERE ver = ? AND id = ?", ver, id)[0]?.xml ?? null;
    const c = this.rows("SELECT ids, offers FROM yml_chunk WHERE ver = ? AND instr(',' || ids || ',', ?) > 0", ver, "," + id + ",")[0];
    if (!c) return null;
    const i = c.ids.split(",").indexOf(String(id));
    return i < 0 ? null : JSON.parse(c.offers)[i] ?? null;
  }
  /** Наступна пачка після afterOrd: { ord, xml } — offer пачки, кожен з нового рядка (той самий текст фіду, що й раніше). */
  page(ver, afterOrd) {
    if (this.legacy(ver)) return this.rows("SELECT ord, xml FROM yml_offer WHERE ver = ? AND ord > ? ORDER BY ord LIMIT 300", ver, afterOrd);
    const c = this.rows("SELECT ord, offers FROM yml_chunk WHERE ver = ? AND ord > ? ORDER BY ord LIMIT 1", ver, afterOrd)[0];
    return c ? [{ ord: c.ord, xml: JSON.parse(c.offers).join("\n") }] : [];
  }
  /** Пачки версії по одній (пам'ять — одна пачка): fn({ ord, ids, offers }). */
  eachChunk(ver, fn) {
    let after = -1;
    for (;;) {
      const c = this.rows("SELECT ord, ids, offers FROM yml_chunk WHERE ver = ? AND ord > ? ORDER BY ord LIMIT 1", ver, after)[0];
      if (!c) return;
      after = c.ord;
      fn({ ord: c.ord, ids: c.ids.split(","), offers: JSON.parse(c.offers) });
    }
  }
  putChunk(ver, ord, ids, offers) { this.sql.exec("INSERT INTO yml_chunk (ver, ord, n, ids, offers) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ver, ord) DO UPDATE SET n = excluded.n, ids = excluded.ids, offers = excluded.offers", ver, ord, ids.length, ids.join(","), JSON.stringify(offers)); }
  dropVersion(ver) { this.sql.exec("DELETE FROM yml_chunk WHERE ver = ?", ver); }
  dropOlder(ver) { this.sql.exec("DELETE FROM yml_chunk WHERE ver < ?", ver); }
  count(ver) {
    if (this.legacy(ver)) return Number(this.rows("SELECT COUNT(*) AS n FROM yml_offer WHERE ver = ?", ver)[0].n);
    return Number(this.rows("SELECT COALESCE(SUM(n), 0) AS n FROM yml_chunk WHERE ver = ?", ver)[0].n);
  }
}

const configNow = () => productionConfig(structuredClone(defaultConfig));
const objects = (values) => { const h = values[0].map((x) => mtText(x)); return values.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""]))); };

/**
 * Повна збірка нової версії. reader — GoogleSheetsCatalogSource (або підставний із тими самими методами); cc — стан CC (held, removed).
 * → { ver, count, stats } | виняток (поточна версія лишається).
 */
export async function buildFeed({ feed, reader, cc, now = Date.now(), config = configNow(), chunkRows = ROWS_PER_CHUNK, chunkBytes = CHUNK_BYTES }) {
  if (!cc || cc.blocked) throw new Error("стан Catalog Controls недостовірний — фід не формується");
  const meta = feed.meta() || {};
  const prevVer = Number(meta.ver) || 0, ver = Math.max(prevVer, Number(meta.lastVer) || 0) + 1;
  const { groups } = await reader.load(["Групи"]);
  const { groupMap, categories } = groupsForYml(objectsFromValues(groups, GROUP_HEADERS));
  const header = (await reader.loadHeaders([MAIN]))[MAIN]?.[0];
  if (!header?.includes("Offer ID")) throw new Error("немає заголовка «Основного каталогу»");
  const total = (await reader.metadata()).find((s) => s.title === MAIN)?.rows || 0;
  const hold = feed.hold();
  const lastGood = { get: (id) => (prevVer ? feed.get(prevVer, id) : null) };
  const opts = { groupMap, pricing: config.pricing, missingPolicy: config.policy?.missing || "block", conflictPolicy: config.policy?.conflict || "block", removed: cc.removed, inStock: config.yml.readyToShip === true, isolateRows: true, lastGood };
  const stats = { published: 0, removed: 0, excluded: 0, held: 0, gone: 0, hold: 0, issues: [] };
  const seen = new Set();
  let ord = 0;
  let chunkOrd = 0, chunkIds = [], chunkOffers = [], chunkSize = 0;
  const flush = () => {
    if (!chunkIds.length) return;
    const [i, o, n] = [chunkIds, chunkOffers, chunkOrd++];
    feed.tx(() => feed.putChunk(ver, n, i, o));
    chunkIds = []; chunkOffers = []; chunkSize = 0;
  };
  feed.tx(() => feed.dropVersion(ver));
  try {
    for (let from = 2; from <= total; from += chunkRows) {
      const values = await reader.loadColumns(MAIN, YML_COLUMNS, { from, to: Math.min(total, from + chunkRows - 1), header });
      const batch = [];
      for (const r of objects(values)) {
        const id = mtText(r["Offer ID"]);
        if (!id) continue;
        if (!/^\d+$/.test(id) || seen.has(id)) throw new Error("невалідний або повторений Offer ID у «Основному каталозі»");
        seen.add(id);
        if (hold.has(id)) { stats.hold++; continue; }
        const gone = mtText(r[PRESENCE_COLUMN]).trim() === PRESENCE.GONE;
        const o = renderOffer(r, { ...opts, success: new Date(r["Оновлено"]).getTime(), forced: cc.held.has(id) || gone });
        if (o.issue) stats.issues.push(o.issue);
        if (o.kind === "removed") { stats.removed++; continue; }
        if (o.kind === "excluded") { stats.excluded++; continue; }
        if (o.forced) { if (gone) stats.gone++; else stats.held++; }
        batch.push([ord++, id, o.xml]);
        stats.published++;
      }
      for (const [, id, xml] of batch) {
        if (chunkSize && chunkSize + xml.length > chunkBytes) flush();
        chunkIds.push(id); chunkOffers.push(xml); chunkSize += xml.length;
      }
    }
    flush();
    const prevCount = Number(meta.count) || 0;
    if (!stats.published) throw new Error("у фіді немає жодного товару");
    if (prevCount && stats.published < Math.floor(prevCount * MIN_RATIO)) throw new Error(`товарів ${stats.published} < ${Math.round(MIN_RATIO * 100)} % попередньої версії (${prevCount}) — схоже на неповне читання`);
  } catch (e) { feed.tx(() => feed.dropVersion(ver)); feed.putMeta({ ...meta, lastVer: ver, lastError: { at: now, message: String(e?.message || e).slice(0, 300) } }); throw e; }
  feed.tx(() => {
    feed.putMeta({ ver, lastVer: ver, prev: prevVer || null, builtAt: now, changedAt: now, header: headerXml(DATE_MARK, config.yml, categories), timeZone: config.yml.timeZone, count: stats.published, stats: { ...stats, issues: stats.issues.slice(0, 20), issuesTotal: stats.issues.length }, lastError: null });
    // Попередня версія лишається (її можуть дочитувати); старші — прибираються.
    feed.dropOlder(prevVer || ver);
  });
  return { ver, count: stats.published, stats };
}

/**
 * Оновлення цін і наявності в готових offer поточної версії (без повного перечитування). Знятий / видалений / тимчасово не
 * публікований / «видалений у постачальника» — не оновлюється так (лише повною збіркою). → { patched, skipped, notPublished }
 */
export async function syncFeed({ feed, reader, cc, now = Date.now(), config = configNow() }) {
  if (!cc || cc.blocked) throw new Error("стан Catalog Controls недостовірний — фід не оновлюється");
  const meta = feed.meta();
  if (!meta?.ver) return { needBuild: true, patched: 0 };
  // Версія до 04.11 (стара таблиця) — оновлення цін через повну збірку в пачки.
  if (feed.legacy(meta.ver)) return { needBuild: true, patched: 0 };
  const hold = feed.hold();
  const rows = objects(await reader.loadColumns(MAIN, LIVE_SYNC_COLUMNS));
  const byId = new Map();
  for (const r of rows) {
    const id = mtText(r["Offer ID"]);
    if (!id || hold.has(id) || cc.removed.has(id) || cc.held.has(id) || mtText(r[PRESENCE_COLUMN]).trim() === PRESENCE.GONE) continue;
    byId.set(id, r);
  }
  const updates = [], changed = [];
  let skipped = 0, seen = 0;
  // Пачки по одній: змінені offer — у пам'яті лише змінені пачки (записуються одним рядком кожна).
  feed.eachChunk(meta.ver, (c) => {
    let touched = false;
    c.ids.forEach((id, i) => {
      const r = byId.get(id);
      if (!r) return;
      seen++;
      let next;
      try { next = patchOfferLive(c.offers[i], r, { pricing: config.pricing, inStock: config.yml.readyToShip === true }); } catch { skipped++; return; }
      if (next !== c.offers[i]) { c.offers[i] = next; updates.push(id); touched = true; }
    });
    if (touched) changed.push(c);
  });
  const notPublished = byId.size - seen;
  feed.tx(() => {
    for (const c of changed) feed.putChunk(meta.ver, c.ord, c.ids, c.offers);
    if (updates.length) feed.putMeta({ ...feed.meta(), changedAt: now, lastSync: { at: now, patched: updates.length } });
    else feed.putMeta({ ...feed.meta(), lastSync: { at: now, patched: 0 } });
  });
  return { patched: updates.length, skipped, notPublished };
}

/** Віддача фіду потоком (пам'ять — одна сторінка offer). */
export function serveFeed(feed, { method = "GET" } = {}) {
  const m = feed.meta();
  if (!m?.ver) return new Response("YML ще не сформовано", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "600" } });
  const headers = { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store", "x-yml-offers": String(m.count), "last-modified": new Date(m.changedAt).toUTCString() };
  if (method === "HEAD") return new Response(null, { headers });
  const enc = new TextEncoder();
  const ver = m.ver;
  let state = "head", after = -1;
  const stream = new ReadableStream({
    pull(c) {
      if (state === "head") { c.enqueue(enc.encode(m.header.replace(DATE_MARK, formatYmlDate(m.changedAt, m.timeZone || "Europe/Kyiv")))); state = "body"; return; }
      if (state === "done") { c.close(); return; }
      const page = feed.page(ver, after);
      if (!page.length) { c.enqueue(enc.encode("\n" + YML_FOOTER)); state = "done"; return; }
      after = page.at(-1).ord;
      c.enqueue(enc.encode(page.map((p) => "\n" + p.xml).join("")));
    },
  });
  return new Response(stream, { headers });
}

/**
 * Завдання сервера: kind "build" | "sync". env — GOOGLE_SA_KEY; store — W2 (контрольна точка CC); ccContractText — погоджений контракт.
 * Стан CC — із вузького каталогу (narrowControls); незавершені команди CC → фід не змінюється (повторить наступне завдання / GitHub).
 */
export async function runFeedJob({ kind, env, store, feed, ccContractText, sha256Hex, ccSha, fetchImpl = (...a) => fetch(...a), now = Date.now(), deps = {} }) {
  const t0 = Date.now();
  let calls = 0;
  const counted = (u, i) => { calls++; return fetchImpl(u, i); };
  const ct = await approvedContract(ccContractText, sha256Hex, ccSha);
  if (!ct.contract) return { state: "SKIPPED", reason: ct.reason };
  if (!deps.reader && !env.GOOGLE_SA_KEY) return { state: "SKIPPED", reason: "на сервері немає ключа Google (GOOGLE_SA_KEY)" };
  const reader = deps.reader || new GoogleSheetsCatalogSource({ spreadsheetId: TEST_SHEET_ID, getAccessToken: googleTokenSource(env.GOOGLE_SA_KEY, { fetchImpl: counted }), fetchImpl: counted, maxRequests: 45, maxRequestsPerMinute: 40, targetBytes: 4_000_000 });
  const { readBook, readColumns } = sheetsReaders(reader);
  const c = await narrowControls({ store, contract: ct.contract, readBook, readColumns });
  if (c.notQuiet) return { state: "SKIPPED", reason: c.notQuiet, metrics: { ms: Date.now() - t0, subrequests: calls } };
  const cc = { held: c.state.held instanceof Set ? c.state.held : new Set(c.state.held || []), removed: c.state.removed, blocked: c.state.blocked };
  const config = configNow();
  deps.configure?.(config);
  if (kind === "sync") {
    const r = await syncFeed({ feed, reader, cc, now, config });
    if (r.needBuild) { const b = await buildFeed({ feed, reader, cc, now, config }); return { state: "BUILT", ...b, metrics: { ms: Date.now() - t0, subrequests: calls } }; }
    return { state: "SYNCED", ...r, metrics: { ms: Date.now() - t0, subrequests: calls } };
  }
  const b = await buildFeed({ feed, reader, cc, now, config });
  return { state: "BUILT", ver: b.ver, count: b.count, stats: b.stats, metrics: { ms: Date.now() - t0, subrequests: calls } };
}
