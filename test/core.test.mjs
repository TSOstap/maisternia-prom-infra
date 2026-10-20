import test from "node:test";
import assert from "node:assert/strict";
import { formatYmlDate, parseZonedDate } from "../src/core/time.mjs";
import { parseSupplierFeed, operationalUrl } from "../src/core/supplier-feed.mjs";
import { verifyYmlStream } from "../src/core/xml-verify.mjs";
import { approveSet, detectNewProducts, duplicateReport } from "../src/core/catalog-guards.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { YML_HEADERS } from "../src/core/seal.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import config from "../config/default.json" with { type: "json" };

test("час Києва: літній +3, зимовий +2 (перехід 25.10.2026)", () => {
  assert.equal(formatYmlDate(Date.parse("2026-10-21T10:00:00Z"), "Europe/Kyiv"), "2026-10-21 13:00");
  assert.equal(formatYmlDate(Date.parse("2026-11-02T10:00:00Z"), "Europe/Kyiv"), "2026-11-02 12:00");
  assert.equal(parseZonedDate("2026-10-21 13:00", "Europe/Kyiv"), Date.parse("2026-10-21T10:00:00Z"));
  assert.equal(parseZonedDate("2026-11-02 12:00", "Europe/Kyiv"), Date.parse("2026-11-02T10:00:00Z"));
  assert.ok(Number.isNaN(parseZonedDate("21.10.2026", "Europe/Kyiv")));
});

test("операційна адреса: лише market-tools HTTPS, параметри без описів/фото", () => {
  const url = operationalUrl("https://market-tools.com.ua/feed.xml?a=1&html_description=1", config.supplier);
  assert.match(url, /exclude_fields=description%2Cpicture%2Cparam%2Ckeywords/);
  assert.match(url, /html_description=0/);
  assert.match(url, /extra_fields=0/);
  assert.match(url, /a=1/);
  assert.throws(() => operationalUrl("http://market-tools.com.ua/x", config.supplier), /HTTPS/);
  assert.throws(() => operationalUrl("https://evil.example/x", config.supplier), /HTTPS/);
});

test("потоковий парсер: Buffer-шматки з розривом UTF-8 і тегів; <offers> на межі шматка", async () => {
  const s = generateSynthetic({ products: 50, seed: 4, now: Date.now() });
  const bytes = Buffer.from(s.supplierXml(), "utf8");
  for (const size of [1, 7, 64, 1000]) {
    const chunks = [];
    for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
    const parsed = await parseSupplierFeed(chunks);
    assert.equal(parsed.count, 50);
    assert.equal(parsed.offers.get("1500000000").nameUa, s.offers[0].nameUa);
  }
});

test("потоковий парсер: ліміт розміру", async () => {
  await assert.rejects(parseSupplierFeed(["<yml_catalog>", "x".repeat(100)], { maximumChars: 50 }), /безпечний розмір/);
});

test("верифікатор XML: приймає коректний, відхиляє пошкоджений, звіряє ID", async () => {
  const good = '<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="x"><shop><offers><offer id="1" a="b&amp;c"><d><![CDATA[<p>a]]></d></offer><offer id="2"/></offers></shop></yml_catalog>';
  const r = await verifyYmlStream([good]);
  assert.equal(r.count, 2);
  for (const bad of [
    good.replace("</d>", ""),
    good.replace("&amp;", "&"),
    good.replace('id="2"', 'id="1"'),
    good + "<extra/>",
    good.replace("<d>", "<d>\u0001"),
    good.replace("<?xml", " <?xml").replace("\n<yml", "<?xml version=\"1.0\"?><yml"),
    good.slice(0, -5),
  ]) await assert.rejects(verifyYmlStream([bad]), /XML/);
  await assert.rejects(verifyYmlStream([good], { count: 3 }), /кількість/);
});

test("погодження набору: видалення без явного списку заборонене", () => {
  const s = generateSynthetic({ products: 30, seed: 1, now: Date.now() });
  const rows = readSheet(s.sheets["Основний каталог"], "x").rows;
  const groups = s.groups.slice(1).map((g) => ({ "Ідентифікатор_групи": g[0], "Назва_групи_укр": g[1], "Назва_групи": g[2], "Ідентифікатор_батьківської_групи": g[3] }));
  const first = approveSet({ rows, groups, now: Date.now() });
  assert.equal(first.count, 30);
  const fewer = rows.slice(2);
  assert.throws(() => approveSet({ rows: fewer, groups, previous: first, now: Date.now() }), /без явного погодження/);
  const removedIds = rows.slice(0, 2).map((r) => r["Offer ID"]);
  const ok = approveSet({ rows: fewer, groups, previous: first, allowRemove: removedIds, now: Date.now() });
  assert.equal(ok.diff.removed, 2);
  assert.throws(() => approveSet({ rows: fewer, groups, previous: first, allowRemove: [...removedIds, "999"], now: Date.now() }), /яких не видаляють/);
  const more = approveSet({ rows, groups, previous: ok, now: Date.now() });
  assert.equal(more.diff.added, 2);
});

test("нові товари: лише невідомі ID, дата першої появи зберігається", () => {
  const offers = new Map([["1", { sku: "a" }], ["2", { sku: "b" }], ["3", { sku: "c" }]]);
  const r1 = detectNewProducts({ offers, knownIds: new Set(["1"]), seen: {}, now: Date.parse("2026-10-21T00:00:00Z") });
  assert.deepEqual(r1.candidates.map((c) => c.id), ["2", "3"]);
  assert.deepEqual(r1.newSinceLastRun, ["2", "3"]);
  offers.delete("3");
  const r2 = detectNewProducts({ offers, knownIds: new Set(["1"]), seen: r1.seen, now: Date.parse("2026-10-21T04:00:00Z") });
  assert.equal(r2.candidates[0].firstSeen, "2026-10-21T00:00:00.000Z");
  assert.deepEqual(r2.newSinceLastRun, []);
  assert.deepEqual(r2.disappearedCandidates, ["3"]);
});

test("звіт дублікатів: однаковий ID постачальника у двох аркушах", () => {
  const row = (id, sid) => ({ "Offer ID": id, "ID постачальника": sid, "Артикул постачальника": "A" });
  const r = duplicateReport({ a: [row("1", "9")], b: [row("2", "9")] });
  assert.equal(r.supplierIdDuplicates.length, 1);
  assert.equal(r.skuDuplicates.length, 1);
});

test("readSheet: короткі рядки Sheets API доповнюються; порожній рядок усередині — помилка", () => {
  const header = YML_HEADERS.slice();
  const row = header.map((k) => (k === "Offer ID" ? "1" : ""));
  const short = row.slice(0, 3);
  assert.equal(readSheet([header, short], "x").rows[0]["Модель"], "");
  assert.throws(() => readSheet([header, row, [], row], "x"), /Порожній рядок/);
  const swapped = header.slice();
  [swapped[5], swapped[6]] = [swapped[6], swapped[5]];
  assert.throws(() => readSheet([swapped], "x"), /порядок/);
});
