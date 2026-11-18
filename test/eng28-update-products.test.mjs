/** ENG-28 — «Оновити товари» і стан «Видалений у постачальника» (доручення власника 01.11.2026, розд. 1–2).
 *  Справжній syncSheet у режимі пріоритету власника (двійник стану CC), повний синтетичний фід, сховище знімків W2 у пам'яті. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { mtPrices } from "../src/core/pricing.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { mergeNew92 } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import { updateProducts } from "../src/pipeline/update-products.mjs";
import * as presenceMod from "../src/core/supplier-presence.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const P = presenceMod; // простір імен: до ENG-28 модуля немає — падають окремі тести, а не файл
const NOW = Date.parse("2026-10-22T10:00:00Z");
const at = (min) => new Date(NOW + min * 60_000).toISOString();
// ENG-28b: поріг МАСОВОГО ЗНИКНЕННЯ синхронізації — менший із «50» і «2 %» каталогу; тут перевіряється HOLD присутності, тож
// синхронізаційний поріг — абсолютний (частка 1), щоб на малому синтетичному каталозі не випереджати HOLD.
const cfg = (presence) => { const c = structuredClone(baseConfig); c.ownerPriority = { enabled: true }; c.supplier.minimumOffers = 10; c.policy.anomaly = { ...c.policy.anomaly, maxNewlyMissingRatio: 1 }; if (presence) c.presence = presence; return c; };
const okCc = (removed = []) => Object.freeze({ held: new Set(removed), removed: new Set(removed), tombstoned: new Map(removed.map((id) => [id, { stage: "REGISTERED" }])), blocked: false, reasons: [], fingerprint: "fp-" + removed.join(","), gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
/** Повний фід: опис у кожному offer (синтетичний генератор описів не пише). */
const full = (xml) => xml.replace(/<\/offer>/g, "<description>Опис постачальника</description></offer>");
const operational = (xml) => xml.replace(/<picture>[\s\S]*?<\/picture>/g, "").replace(/<param [\s\S]*?<\/param>/g, "");

async function world() {
  const s = generateSynthetic({ products: 40, queue: 4, deferred: 2, newOffers: 0, seed: 13, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const w = { s, sheets, readBook: async () => sheets.read(), xml: full(s.supplierXml()), store: new MemoryStore() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: at(0) });
  return w;
}
const runUp = (w, xml, o) => run(w, xml, o);
const run = (w, xml, { min = 1, config = cfg(), removed = [] } = {}) => updateProducts({ sheets: w.sheets, readBook: w.readBook, xml, source: "https://market-tools.com.ua/feed.xml?key=SECRET", fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config, catalog: EMPTY_CATALOG, controls: okCc(removed), snapshotStore: w.store });
const main = (w) => readSheet(w.sheets.book[SHEET.main], SHEET.main).rows;
const byId = (w, id) => main(w).find((r) => mtText(r["Offer ID"]) === id);
const meta = (r) => JSON.parse(mtText(r[P.PRESENCE_META_COLUMN]) || "{}");
/** Рядок фіду зі зміненою датою (кожен запуск «Оновити товари» — новий фід). */
const dated = (xml, min) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 3 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });

test("ENG-28 знімок: повний / частковий / операційний фід, джерело без ключа, обірваний документ — виняток", () => {
  const s = generateSynthetic({ products: 20, queue: 2, deferred: 1, newOffers: 0, seed: 3, now: NOW });
  const x = s.supplierXml();
  assert.equal(P.snapshotFromXml(full(x)).kind, "full");
  assert.equal(P.snapshotFromXml(x).kind, "partial", "без описів — не повний");
  assert.equal(P.snapshotFromXml(operational(x)).kind, "operational");
  const sn = P.snapshotFromXml(full(x), { source: "https://market-tools.com.ua/feed.xml?key=SECRET&x=1" });
  assert.equal(sn.source, "market-tools.com.ua/feed.xml");
  assert.ok(!JSON.stringify(sn).includes("SECRET"));
  assert.equal(sn.count, sn.ids.length);
  assert.throws(() => P.snapshotFromXml(full(x).slice(0, -200)), /неповний/);
});

test("ENG-28 доказ повноти: не повний фід, різке падіння проти ПІДТВЕРДЖЕНОГО знімка, застарілий, старіший за підтверджений — не доведено", () => {
  const s = generateSynthetic({ products: 30, queue: 2, deferred: 1, newOffers: 0, seed: 5, now: NOW });
  const sc = cfg().supplier;
  const good = P.snapshotFromXml(full(s.supplierXml()));
  assert.deepEqual(P.proveComplete(good, { previous: null, now: NOW, supplierConfig: sc }), { complete: true, reasons: [] });
  assert.match(P.proveComplete(P.snapshotFromXml(s.supplierXml()), { now: NOW, supplierConfig: sc }).reasons.join(), /не повний/);
  const dropped = P.snapshotFromXml(perturb.drop(full(s.supplierXml()), good.ids.slice(0, 12)));
  assert.match(P.proveComplete(dropped, { previous: good, now: NOW, supplierConfig: sc }).reasons.join(), /Неповний фід/);
  assert.match(P.proveComplete(good, { previous: null, now: NOW + 72 * 3600_000, supplierConfig: sc }).reasons.join(), /Застарілий/);
  assert.match(P.proveComplete(good, { previous: good, now: NOW, supplierConfig: sc }).reasons.join(), /той самий знімок/, "той самий знімок — не нові дані");
  const newer = { ...good, id: "sn-x", feedDate: "2026-10-23 10:00" };
  assert.match(P.proveComplete(good, { previous: newer, now: NOW, supplierConfig: sc }).reasons.join(), /старіший/);
});

test("ENG-28 план присутності: зник із підтвердженого → ВИДАЛЕНИЙ; повторно — дата не змінюється; повернувся → ПОВЕРНУВСЯ → далі присутній; без підтвердженого — лише «відсутній у знімку»; видалений власником — не позначається; неповний фід — SKIP", () => {
  // ENG-28a: «видалений» — лише для пари ПОВНИХ знімків (scope: "full"); поріг HOLD — окремі тести на межі (eng28a).
  const prev = { id: "sn-prev", ids: ["1", "2", "3", "4"], count: 4, fp: {}, scope: "full" };
  const snap = { id: "sn-new", ids: ["1", "3", "4", "5"], count: 4, fp: {}, feedDate: "d", source: "s", scope: "full" };
  const rows = [{ offerId: "10", supplierId: "1" }, { offerId: "20", supplierId: "2" }, { offerId: "30", supplierId: "3", presence: P.PRESENCE.GONE, meta: JSON.stringify({ since: "t0" }) }, { offerId: "60", supplierId: "6" }, { offerId: "40", supplierId: "4", presence: P.PRESENCE.RETURNED }, { offerId: "70", supplierId: "2" }];
  const pp = P.planPresence({ rows, previous: prev, snapshot: snap, proof: { complete: true }, stamp: "T", removed: new Set(["70"]), limits: { maxGoneAbsolute: 50, maxGoneRatio: 0 } });
  assert.equal(pp.decision, "APPLY");
  assert.deepEqual(pp.gone, ["20"]);
  assert.equal(pp.updates.get("20").presence, P.PRESENCE.GONE);
  assert.equal(JSON.parse(pp.updates.get("20").meta).previousSnapshotId, "sn-prev");
  assert.deepEqual(pp.returned, ["30"]);
  assert.equal(JSON.parse(pp.updates.get("30").meta).since, "t0", "дата зникнення збережена в історії повернення");
  assert.equal(pp.updates.get("40").presence, "", "ПОВЕРНУВСЯ → присутній");
  assert.deepEqual(pp.absent, ["60"], "не було й у підтвердженому — лише «відсутній у знімку»");
  assert.ok(!pp.updates.has("70"), "видалений власником (CC) — інший стан, не позначається");
  // Уже ВИДАЛЕНИЙ і досі відсутній — без змін (since не перезаписується).
  const again = P.planPresence({ rows: [{ offerId: "20", supplierId: "2", presence: P.PRESENCE.GONE, meta: JSON.stringify({ since: "T" }) }], previous: prev, snapshot: snap, proof: { complete: true }, stamp: "T2" });
  assert.equal(again.updates.size, 0);
  const skip = P.planPresence({ rows, previous: prev, snapshot: snap, proof: { complete: false, reasons: ["x"] }, stamp: "T" });
  assert.equal(skip.decision, "SKIP");
  assert.equal(skip.updates.size, 0);
  const base = P.planPresence({ rows: [{ offerId: "20", supplierId: "2" }], previous: null, snapshot: snap, proof: { complete: true }, stamp: "T", limits: { maxGoneAbsolute: 50, maxGoneRatio: 0 } });
  assert.equal(base.updates.get("20").presence, P.PRESENCE.ABSENT_IN_SNAPSHOT, "без підтвердженого знімка «видалений» не ставиться");
  const hold = P.planPresence({ rows: rows.slice(0, 2), previous: prev, snapshot: { ...snap, ids: ["3", "4", "5"] }, proof: { complete: true }, stamp: "T", limits: { maxGoneAbsolute: 1, maxGoneRatio: 0 } });
  assert.equal(hold.decision, "HOLD");
  assert.equal(hold.updates.size, 0, "HOLD — нічого не застосовано");
  assert.equal(P.exportAvailability({ [P.PRESENCE_COLUMN]: P.PRESENCE.GONE }).available, false);
  assert.equal(P.exportAvailability({ [P.PRESENCE_COLUMN]: P.PRESENCE.GONE }).removeFromProm, false);
});

test("ENG-28 «Оновити товари»: перший повний фід — ціни й наявність за чинними правилами, базовий знімок підтверджено, позначок «видалений» немає", async () => {
  const w = await world();
  const [a, b] = main(w).slice(2, 4);
  let xml = perturb.tag(w.xml, mtText(a["ID постачальника"]), "price", "777");
  xml = xml.replace(new RegExp(`<offer id="${mtText(b["ID постачальника"])}" available="true"`), `<offer id="${mtText(b["ID постачальника"])}" available="false"`);
  const r = await run(w, xml);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 500));
  assert.equal(r.presence.decision, "APPLY");
  assert.equal(r.presence.baseline, true);
  assert.equal(r.presence.gone, 0);
  assert.equal(r.confirmed, true);
  const ra = byId(w, mtText(a["Offer ID"]));
  const p = mtPrices(777, mtText(ra["Наявність"]) === "+", cfg().pricing); // № 87: та сама формула, що в синхронізації (робочий конфіг)
  assert.equal(Number(ra["Ціна постачальника"]), 777);
  assert.equal(Number(ra["Ціна кінцева"]), p.final);
  assert.equal(mtText(byId(w, mtText(b["Offer ID"]))["Наявність"]), "-");
  assert.equal((await w.store.getJsonVersioned(P.CONFIRMED_SNAPSHOT_KEY)).value.id, r.snapshot.id);
});

test("ENG-28 «Оновити товари»: не повний (операційний) або обірваний фід — ABORTED, жодного запису, знімок не підтверджено", async () => {
  const w = await world();
  const mark = w.sheets.log.length;
  const r1 = await run(w, operational(w.xml));
  assert.equal(r1.state, "ABORTED");
  assert.match(r1.reason, /не повний/);
  const r2 = await run(w, w.xml.slice(0, -300), { min: 2 });
  assert.equal(r2.state, "ABORTED");
  assert.match(r2.reason, /пошкоджений|обірваний/);
  assert.equal(w.sheets.log.length, mark, "жодного запису в таблицю");
  assert.equal((await w.store.getJsonVersioned(P.CONFIRMED_SNAPSHOT_KEY)).value, null);
});

test("ENG-28 «Оновити товари»: товар зник із нового повного фіду — «ВИДАЛЕНИЙ_У_ПОСТАЧАЛЬНИКА» з датою, джерелом і id знімків; картку не видалено, SEO й ручні правки збережено; повтор — дата не змінюється; повернення — «ПОВЕРНУВСЯ», далі присутній", async () => {
  const w = await world();
  // ENG-28a: малий синтетичний каталог (47 offer) — 2 % < 1 товару; поріг задано явно, межу HOLD перевіряють тести eng28a.
  const config = cfg({ limits: { maxGoneAbsolute: 50, maxGoneRatio: 0.1 } });
  const run = (w, xml, o = {}) => runUp(w, xml, { config, ...o });
  assert.equal((await run(w, w.xml)).confirmed, true);
  const [g] = main(w).slice(5, 6), id = mtText(g["Offer ID"]);
  w.sheets.humanSet(SHEET.main, w.sheets.book[SHEET.main].findIndex((x) => mtText(x[0]) === id) + 1, "Назва UA", "Назва власника (вручну)");
  const before = { ...byId(w, id) };
  const xml2 = dated(perturb.drop(w.xml, [mtText(g["ID постачальника"])]), 2);
  const r = await run(w, xml2, { min: 2 });
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 500));
  assert.equal(r.presence.gone, 1);
  assert.equal(r.confirmed, true);
  const row = byId(w, id);
  assert.ok(row, "картку не видалено");
  assert.equal(mtText(row[P.PRESENCE_COLUMN]), P.PRESENCE.GONE);
  const m = meta(row);
  assert.equal(m.since, at(2));
  assert.equal(m.source, "market-tools.com.ua/feed.xml");
  assert.ok(m.snapshotId && m.previousSnapshotId && m.snapshotId !== m.previousSnapshotId);
  assert.equal(mtText(row["Наявність"]), "-", "D1: зниклий — «немає в наявності»");
  assert.equal(mtText(row["Назва UA"]), "Назва власника (вручну)", "ручна правка збережена");
  for (const k of ["Опис UA", "Опис RU", "Характеристики JSON", "Назва RU"]) assert.equal(mtText(row[k]), mtText(before[k]), k + " не змінено");
  assert.ok(w.sheets.book[SHEET.journal].some((e) => e[2] === id && e[3] === P.PRESENCE_COLUMN && e[5] === P.PRESENCE.GONE));
  // Повтор без товару — дата не змінюється.
  const r3 = await run(w, dated(xml2, 3), { min: 3 });
  assert.equal(r3.state, "SYNCED");
  assert.equal(meta(byId(w, id)).since, at(2));
  // Повернення.
  const r4 = await run(w, dated(w.xml, 4), { min: 4 });
  assert.equal(r4.presence.returned, 1);
  assert.equal(mtText(byId(w, id)[P.PRESENCE_COLUMN]), P.PRESENCE.RETURNED);
  assert.equal(meta(byId(w, id)).since, at(2), "історія зникнення збережена");
  const r5 = await run(w, dated(w.xml, 5), { min: 5 });
  assert.equal(r5.state, "SYNCED");
  assert.equal(mtText(byId(w, id)[P.PRESENCE_COLUMN]), "", "після повернення — присутній");
});

test("ENG-28 «Оновити товари»: аномальне зникнення — HOLD і звіт до будь-якого запису (ціни теж не пишуться), знімок не підтверджено", async () => {
  const w = await world();
  const config = cfg({ limits: { maxGoneAbsolute: 2, maxGoneRatio: 0 } });
  assert.equal((await run(w, w.xml, { config })).confirmed, true);
  const snap1 = (await w.store.getJsonVersioned(P.CONFIRMED_SNAPSHOT_KEY)).value.id;
  const drop = main(w).slice(0, 4).map((r) => mtText(r["ID постачальника"]));
  const price = main(w)[10];
  let xml = dated(perturb.drop(w.xml, drop), 2);
  xml = perturb.tag(xml, mtText(price["ID постачальника"]), "price", "999");
  const before = JSON.stringify(w.sheets.book[SHEET.main]);
  const r = await run(w, xml, { min: 2, config });
  assert.equal(r.state, "HOLD_SUPPLIER_DISAPPEARANCE", JSON.stringify(r).slice(0, 400));
  assert.match(r.reason, /аномальне зникнення: 4/);
  assert.equal(JSON.stringify(w.sheets.book[SHEET.main]), before, "основний каталог без змін (і ціни)");
  assert.ok(w.sheets.book[SHEET.journal].some((e) => e[3] === "ОНОВЛЕННЯ ЗАБЛОКОВАНО" && e[4] === "АНОМАЛЬНЕ ЗНИКНЕННЯ ТОВАРІВ"));
  assert.equal(r.confirmed, false);
  assert.equal((await w.store.getJsonVersioned(P.CONFIRMED_SNAPSHOT_KEY)).value.id, snap1);
});

test("ENG-28 «Оновити товари»: видалений власником (Catalog Controls) і зниклий у постачальника — НЕ позначається «видалений у постачальника»", async () => {
  const w = await world();
  await run(w, w.xml);
  const r0 = main(w)[7], id = mtText(r0["Offer ID"]);
  const r = await run(w, dated(perturb.drop(w.xml, [mtText(r0["ID постачальника"])]), 2), { min: 2, removed: [id] });
  assert.ok(["SYNCED", "CONFLICT_OWNER_EDIT"].includes(r.state), JSON.stringify(r).slice(0, 400));
  assert.notEqual(mtText(byId(w, id)?.[P.PRESENCE_COLUMN] ?? ""), P.PRESENCE.GONE);
});

test("ENG-28 «Оновити товари»: зміна назви постачальника — у знімку позначено змінені поля; сирі поля оновлено, наше SEO не змінено; той самий фід удруге — NO_CHANGES без записів", async () => {
  const w = await world();
  await run(w, w.xml);
  const r0 = main(w)[9], id = mtText(r0["Offer ID"]);
  const xml2 = dated(perturb.tag(w.xml, mtText(r0["ID постачальника"]), "name_ua", "Нова назва постачальника"), 2);
  const r = await run(w, xml2, { min: 2 });
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 400));
  assert.ok(r.presence.changed >= 1);
  const m = meta(byId(w, id));
  assert.ok(m.lastChange?.parts.includes("назва UA"), JSON.stringify(m));
  assert.equal(mtText(byId(w, id)[P.PRESENCE_COLUMN]), "", "стан — присутній");
  assert.equal(mtText(byId(w, id)["Назва UA"]), mtText(r0["Назва UA"]), "наше SEO не змінено");
  const mark = w.sheets.log.length;
  const r2 = await run(w, xml2, { min: 3 });
  assert.equal(r2.state, "NO_CHANGES");
  assert.equal(w.sheets.log.length, mark);
});

test("ENG-28 «Оновити товари»: нові ID у повному фіді — підсумок для наявного intake (повні / неповні), у таблицю sync їх не додає", async () => {
  const w = await world();
  const extra = `<offer id="2990000001" available="true"><url>https://market-tools.com.ua/p2990000001-x.html</url><price>500</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>Новий</name><name_ua>Новий</name_ua><vendorCode>NEW-1</vendorCode><picture>https://images.prom.ua/1_n.jpg</picture><param name="Потужність" unit="Вт">10</param><description>Опис</description></offer>`;
  const xml = w.xml.replace("\n</offers>", "\n" + extra + "\n</offers>");
  const r = await run(w, xml);
  assert.equal(r.state, "SYNCED");
  assert.equal(r.newItems.total, 1);
  assert.deepEqual(r.newItems.ready, ["2990000001"]);
  assert.ok(!main(w).some((x) => mtText(x["Offer ID"]) === "2990000001"));
  assert.ok(!readSheet(w.sheets.book[SHEET.queue], SHEET.queue).rows.some((x) => mtText(x["Offer ID"]) === "2990000001"), "чергу формує intake, не sync");
});
