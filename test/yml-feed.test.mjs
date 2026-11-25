/** YML для Prom на сервері mm-ops (рішення власника 03.11): повна збірка порціями, оновлення цін у готових offer, віддача потоком.
 *  Правила товару — ті самі, що в робочому buildYml (renderOffer); оновлення цін = повне формування того самого рядка. Мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { mtText } from "../src/core/text.mjs";
import { mtPrices } from "../src/core/pricing.mjs";
import { renderOffer, patchOfferLive, groupsForYml, objectsFromValues, GROUP_HEADERS, offersById } from "../src/core/yml.mjs";
import { verifyYmlStream } from "../src/core/xml-verify.mjs";
import { FeedStore, buildFeed, syncFeed, serveFeed, HOLD_DEFAULT, YML_COLUMNS } from "../workers/ops/src/yml-feed.mjs";
import { PRESENCE_COLUMN } from "../src/core/supplier-presence.mjs";
import { productionConfig } from "../src/pipeline/production.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* старий Node */ }
const skip = DatabaseSync ? false : "немає node:sqlite";
const NOW = Date.parse("2026-11-03T12:00:00Z");
const MAIN = "Основний каталог";
const config = productionConfig(structuredClone(baseConfig));
const pricing = config.pricing;

function book() {
  const s = generateSynthetic({ products: 50, queue: 0, deferred: 0, newOffers: 0, seed: 77, now: NOW });
  const main = s.sheets[MAIN].map((r, i) => [...r, i === 0 ? PRESENCE_COLUMN : ""]);
  return { [MAIN]: main, "Групи": s.groups };
}
const rowsOf = (b) => { const h = b[MAIN][0]; return b[MAIN].slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""]))); };
const groupMapOf = (b) => groupsForYml(objectsFromValues(b["Групи"], GROUP_HEADERS)).groupMap;
/** Ціни рядка за формулою (як записує «Ціни й наявність»). */
function setLive(row, { price, available, qty }) {
  const p = mtPrices(price, available, pricing);
  return { ...row, "Ціна постачальника": price, "Ціна": p.base, "Ціна кінцева": p.final, "Знижка": Number(String(p.discount).replace("%", "")) / 100 || p.discount, "Наявність": p.availability, "Кількість постачальника": qty };
}

test("оновлення цін у готовому offer = повне формування того самого рядка (ціна, наявність, кількість; «Готово до відправки»); невідповідність формулі — виняток", () => {
  const b = book(), gm = groupMapOf(b);
  const opt = (r) => ({ success: new Date(r["Оновлено"]).getTime(), groupMap: gm, pricing, missingPolicy: "unavailable", conflictPolicy: "isolate", inStock: true });
  let checked = 0;
  for (const r0 of rowsOf(b).slice(0, 30)) {
    const base = renderOffer(r0, opt(r0));
    if (base.kind !== "published") continue;
    for (const v of [{ price: Number(r0["Ціна постачальника"]) + 37, available: true, qty: 5 }, { price: Number(r0["Ціна постачальника"]) + 11, available: false, qty: "" }, { price: 99.5, available: true, qty: "" }]) {
      const r1 = setLive(r0, v);
      assert.equal(patchOfferLive(base.xml, r1, { pricing, inStock: true }), renderOffer(r1, opt(r1)).xml, mtText(r0["Offer ID"]));
      checked++;
    }
  }
  assert.ok(checked >= 30);
  const r0 = rowsOf(b)[0], x = renderOffer(r0, opt(r0)).xml;
  assert.throws(() => patchOfferLive(x, { ...setLive(r0, { price: 100, available: true, qty: "" }), "Ціна кінцева": 1 }, { pricing, inStock: true }), /формулі/);
  assert.throws(() => patchOfferLive(x, { ...r0, "Стан синхронізації": "ВІДСУТНІЙ_У_YML" }, { pricing, inStock: true }), /статус/);
});

// ---------------------------------------------------------------- збірка / оновлення / віддача
function db() {
  const d = new DatabaseSync(":memory:");
  const sql = { exec(q, ...b) { const st = d.prepare(q); if (/^\s*SELECT/i.test(q)) { const r = st.all(...b); return { toArray: () => r }; } st.run(...b); return { toArray: () => [] }; } };
  sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const tx = (fn) => { d.exec("BEGIN"); try { const r = fn(); d.exec("COMMIT"); return r; } catch (e) { d.exec("ROLLBACK"); throw e; } };
  return new FeedStore(sql, tx);
}
/** Підставний читач Sheets API над книгою (методи GoogleSheetsCatalogSource, зокрема порції рядків). */
function reader(b) {
  const calls = { chunks: 0 };
  return {
    calls,
    async metadata() { return Object.entries(b).map(([title, v]) => ({ title, rows: v.length + 7, columns: v[0].length })); },
    async load(names) { return { sheets: Object.fromEntries(names.filter((n) => b[n]).map((n) => [n, b[n]])), groups: b["Групи"] }; },
    async loadHeaders(titles) { return Object.fromEntries(titles.filter((t) => b[t]).map((t) => [t, [b[t][0].slice()]])); },
    async loadColumns(title, cols, rows = null) {
      const v = b[title]; if (!v) return null;
      if (rows) calls.chunks++;
      const keep = new Set(cols.map((c) => v[0].indexOf(c)).filter((i) => i >= 0));
      const from = rows ? rows.from : 2, to = rows?.to ?? v.length;
      return [v[0].slice(), ...v.slice(from - 1, to).map((r) => v[0].map((_, j) => (keep.has(j) ? r[j] ?? "" : "")))];
    },
  };
}
const cc0 = (o = {}) => ({ held: new Set(o.held || []), removed: new Set(o.removed || []), blocked: false });
async function served(feed) { const res = serveFeed(feed); assert.equal(res.status, 200); return res.text(); }

test("збірка: усі товари в порядку аркуша, крім видалених (CC) і тимчасово не публікованих; знятий — «немає в наявності»; XML коректний; порціями рядків", { skip }, async () => {
  const b = book(), feed = db(), rows = rowsOf(b), ids = rows.map((r) => mtText(r["Offer ID"]));
  feed.setHold([ids[0]]);
  const rd = reader(b);
  const r = await buildFeed({ feed, reader: rd, cc: cc0({ removed: [ids[1]], held: [ids[2]] }), now: NOW, config, chunkRows: 12, chunkBytes: 40000 });
  assert.equal(r.count, rows.length - 2); assert.ok(rd.calls.chunks >= 4, "порції рядків");
  // 04.11: offer зберігаються пачками (ліміт записаних рядків Workers Free) — рядків SQLite значно менше, ніж offer.
  const packs = feed.rows("SELECT COUNT(*) AS n FROM yml_chunk WHERE ver = ?", r.ver)[0].n;
  assert.ok(packs > 1 && packs < r.count / 2, `пачок ${packs} на ${r.count} offer`);
  assert.equal(feed.count(r.ver), r.count);
  assert.equal(feed.get(r.ver, ids[5]), offersById(await served(feed)).get(ids[5]));
  const xml = await served(feed);
  const v = await verifyYmlStream(Readable.from([xml]));
  assert.equal(v.count, rows.length - 2);
  const offers = offersById(xml);
  assert.deepEqual([...offers.keys()], ids.filter((id) => id !== ids[0] && id !== ids[1]), "порядок аркуша");
  assert.match(offers.get(ids[2]), /^<offer id="\d+" available="false" selling_type="r">/);
  assert.match(xml, /<yml_catalog date="2026-11-03 14:00">/);
  assert.ok(!xml.includes("{{YML_DATE}}"));
  // Кожен offer = renderOffer рядка (ті самі правила, що й buildYml).
  const gm = groupMapOf(b);
  for (const row of rows.slice(3, 10)) assert.equal(offers.get(mtText(row["Offer ID"])), renderOffer(row, { success: new Date(row["Оновлено"]).getTime(), groupMap: gm, pricing, missingPolicy: "unavailable", conflictPolicy: "isolate", inStock: true }).xml);
  assert.deepEqual(HOLD_DEFAULT.length, 5); assert.ok(YML_COLUMNS.includes("Опис UA") && YML_COLUMNS.includes(PRESENCE_COLUMN));
});

test("оновлення цін після «Цін»: змінені offer = повне формування; знятий / видалений не оновлюється; нова версія лише повною збіркою; неповне читання — стара версія лишається", { skip }, async () => {
  const b = book(), feed = db(), rows = rowsOf(b), ids = rows.map((r) => mtText(r["Offer ID"]));
  feed.setHold([]);
  await buildFeed({ feed, reader: reader(b), cc: cc0({ held: [ids[2]] }), now: NOW, config, chunkBytes: 40000 });
  const before = offersById(await served(feed));
  // Ціна товару 5 і наявність товару 6 змінились у таблиці (як записала «Ціни й наявність»); знятий 2 — теж змінився в таблиці.
  const h = b[MAIN][0], col = (k) => h.indexOf(k);
  for (const [i, v] of [[5, { price: 1234, available: true, qty: 3 }], [6, { price: Number(rows[6]["Ціна постачальника"]), available: rows[6]["Наявність"] !== "+", qty: "" }], [2, { price: 555, available: true, qty: "" }]]) {
    const nr = setLive(rows[i], v);
    for (const k of ["Ціна постачальника", "Ціна", "Ціна кінцева", "Знижка", "Наявність", "Кількість постачальника"]) b[MAIN][i + 1][col(k)] = nr[k];
  }
  const s = await syncFeed({ feed, reader: reader(b), cc: cc0({ held: [ids[2]] }), now: NOW + 60_000, config });
  assert.equal(s.patched, 2);
  const after = offersById(await served(feed));
  const gm = groupMapOf(b), r5 = rowsOf(b)[5];
  assert.equal(after.get(ids[5]), renderOffer(r5, { success: new Date(r5["Оновлено"]).getTime(), groupMap: gm, pricing, missingPolicy: "unavailable", conflictPolicy: "isolate", inStock: true }).xml);
  assert.match(after.get(ids[5]), /<price>[\d.]+<\/price><discount>20%<\/discount>/);
  assert.notEqual(after.get(ids[6]), before.get(ids[6]));
  assert.equal(after.get(ids[2]), before.get(ids[2]), "знятий не оновлюється");
  assert.equal(after.get(ids[7]), before.get(ids[7]));
  assert.equal(feed.meta().changedAt, NOW + 60_000);
  // Неповне читання (менше 90 % товарів) — нова версія не з'являється, поточна віддається далі.
  const ver = feed.meta().ver;
  const small = { ...b, [MAIN]: b[MAIN].slice(0, 20) };
  await assert.rejects(buildFeed({ feed, reader: reader(small), cc: cc0(), now: NOW + 120_000, config }), /90 %/);
  assert.equal(feed.meta().ver, ver); assert.equal(offersById(await served(feed)).size, rows.length);
  // Нова повна збірка: попередня версія лишається (її можуть дочитувати), старші — прибрано.
  await buildFeed({ feed, reader: reader(b), cc: cc0(), now: NOW + 180_000, config });
  const v2 = feed.meta().ver;
  await buildFeed({ feed, reader: reader(b), cc: cc0(), now: NOW + 240_000, config });
  assert.equal(feed.count(v2), rows.length); assert.equal(feed.count(ver), 0);
  // CC недостовірний — фід не змінюється.
  await assert.rejects(buildFeed({ feed, reader: reader(b), cc: { ...cc0(), blocked: true }, now: NOW, config }), /недостовірний/);
  await assert.rejects(syncFeed({ feed, reader: reader(b), cc: { ...cc0(), blocked: true }, now: NOW, config }), /недостовірний/);
});

test("віддача: до першої збірки — 503; HEAD — без тіла; заголовки XML", { skip }, async () => {
  const feed = db();
  assert.equal(serveFeed(feed).status, 503);
  await buildFeed({ feed, reader: reader(book()), cc: cc0(), now: NOW, config });
  const h = serveFeed(feed, { method: "HEAD" });
  assert.equal(h.status, 200); assert.equal(h.body, null);
  assert.match(h.headers.get("content-type"), /application\/xml/);
  assert.equal(h.headers.get("x-yml-offers"), String(feed.meta().count));
});

test("04.11: версія у старій таблиці yml_offer (до пачок) віддається без змін; оновлення цін — через повну збірку в пачки", { skip }, async () => {
  const b = book(), feed = db(), rows = rowsOf(b), ids = rows.map((r) => mtText(r["Offer ID"]));
  feed.setHold([]);
  await buildFeed({ feed, reader: reader(b), cc: cc0(), now: NOW, config });
  const xml = await served(feed), ver = feed.meta().ver;
  // Імітація стану до 04.11: та сама версія — рядок на offer у yml_offer, пачок немає.
  feed.sql.exec("CREATE TABLE IF NOT EXISTS yml_offer (ver INTEGER NOT NULL, ord INTEGER NOT NULL, id TEXT NOT NULL, xml TEXT NOT NULL, PRIMARY KEY (ver, id))");
  [...offersById(xml)].forEach(([id, x], i) => feed.sql.exec("INSERT INTO yml_offer (ver, ord, id, xml) VALUES (?, ?, ?, ?)", ver, i, id, x));
  feed.dropVersion(ver);
  const legacyFeed = new FeedStore(feed.sql, feed.tx);
  assert.equal(await served(legacyFeed), xml, "старий фід віддається байт-у-байт");
  assert.equal(legacyFeed.count(ver), rows.length);
  const s = await syncFeed({ feed: legacyFeed, reader: reader(b), cc: cc0(), now: NOW + 1, config });
  assert.equal(s.needBuild, true);
  assert.ok(ids.length);
});

test("25.11: список зниклих з наявності — і після «Цін» (sync), і після повної збірки (build); «з'явились» і ті самі — не входять", { skip }, async () => {
  const b = book(), feed = db(), rows = rowsOf(b), ids = rows.map((r) => mtText(r["Offer ID"]));
  feed.setHold([]);
  const h = b[MAIN][0], col = (k) => h.indexOf(k);
  const put = (i, v) => { const nr = setLive(rowsOf(b)[i], v); for (const k of ["Ціна постачальника", "Ціна", "Ціна кінцева", "Знижка", "Наявність", "Кількість постачальника"]) b[MAIN][i + 1][col(k)] = nr[k]; };
  const price = (i) => Number(rows[i]["Ціна постачальника"]);
  for (const i of [5, 6, 7]) put(i, { price: price(i), available: i !== 7, qty: "" });
  const first = await buildFeed({ feed, reader: reader(b), cc: cc0(), now: NOW, config });
  assert.deepEqual(first.gone, [], "перша збірка — порівнювати нема з чим");
  put(5, { price: price(5), available: false, qty: "" }); put(7, { price: price(7), available: true, qty: "" });
  const s = await syncFeed({ feed, reader: reader(b), cc: cc0(), now: NOW + 60_000, config });
  assert.deepEqual(s.gone, [ids[5]]);
  put(6, { price: price(6), available: false, qty: "" });
  const b2 = await buildFeed({ feed, reader: reader(b), cc: cc0(), now: NOW + 120_000, config });
  assert.deepEqual(b2.gone, [ids[6]], "у збірці — лише нове зникнення, 5-й уже був «немає»");
});
