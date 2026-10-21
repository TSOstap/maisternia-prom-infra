/** «Заморожені ID» у зіставленні ідентичності (виправлення шуму ручної черги, 22.10.2026). */
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveIdentity } from "../src/core/d1.mjs";
import { YML_HEADERS } from "../src/core/seal.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate } from "../src/pipeline/update.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const row = (oid, sku, ua, brand = "X") => Object.fromEntries(YML_HEADERS.map((k) => [k, ""]).concat([["Offer ID", oid], ["ID постачальника", oid], ["Артикул постачальника", sku], ["Назва постачальника UA", ua], ["Назва постачальника RU", ua], ["Виробник", brand]]));
const offer = (id, sku, ua, vendor = "X") => [id, { id, sku, nameUa: ua, nameRu: ua, vendor, url: "" }];

test("заморожений offer, схожий на ЖИВУ картку (комплект/слабкі ознаки), не йде в ручну чергу", () => {
  const cards = [row("1", "A1", "Дриль 18 В 2 АКБ")];
  const offers = new Map([offer("1", "A1", "Дриль 18 В 2 АКБ"), offer("9", "A1", "Дриль 18 В без АКБ")]);
  const before = resolveIdentity({ syncRows: cards, knownRows: cards, offers, links: null, autoRelink: true, now: Date.now() });
  assert.equal(before.manual.length, 1, "без урахування заморожених — шум у черзі (як у живому запуску)");
  const after = resolveIdentity({ syncRows: cards, knownRows: cards, offers, links: null, autoRelink: true, now: Date.now(), frozenIds: new Set(["9"]) });
  assert.equal(after.manual.length, 0);
  assert.deepEqual(after.frozen, { inFeed: 1, ignored: 1, flagged: 0 });
  assert.deepEqual(after.newOfferIds, []);
});

test("заморожений offer, схожий на картку-СИРОТУ (її ID зник) — у ручну чергу з позначкою, без автоприв'язки", () => {
  const cards = [row("1", "A1", "Дриль 18 В 2 АКБ")];
  const offers = new Map([offer("9", "A1", "Дриль 18 В 2 АКБ")]); // картки «1» у фіді немає
  const r = resolveIdentity({ syncRows: cards, knownRows: cards, offers, links: null, autoRelink: true, now: Date.now(), frozenIds: new Set(["9"]) });
  assert.equal(r.relinked.length, 0, "до замороженого offer автоматично не прив'язуємо");
  assert.equal(r.manual.length, 1);
  assert.equal(r.manual[0].frozen, true);
  assert.match(r.manual[0].reason, /заморожений/);
  assert.equal(r.frozen.flagged, 1);
  assert.equal(r.links.cards["1"], undefined, "реєстр прив'язок не змінено");
});

test("незаморожений невідомий offer зі схожістю — як і раніше в ручній черзі (реальні конфлікти не приховано)", () => {
  const cards = [row("1", "A1", "Дриль 18 В 2 АКБ")];
  const offers = new Map([offer("1", "A1", "Дриль 18 В 2 АКБ"), offer("9", "A1", "Дриль 18 В без АКБ"), offer("8", "Z9", "Зовсім інший товар")]);
  const r = resolveIdentity({ syncRows: cards, knownRows: cards, offers, links: null, autoRelink: true, now: Date.now(), frozenIds: new Set(["7"]) });
  assert.equal(r.manual.length, 1);
  assert.equal(r.manual[0].offerId, "9");
  assert.deepEqual(r.newOfferIds, ["8"], "нові товари не приховано");
});

test("конвеєр: дубль живої картки з ЗАМОРОЖЕНИМ ID — не в черзі; той самий дубль без заморожування — у черзі", async () => {
  const now = Date.parse("2026-10-21T06:00:00Z");
  const run = async (frozen) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-frozen-"));
    const s = generateSynthetic({ products: 120, queue: 12, seed: 91, now });
    const sheets = { ...s.sheets, ...(frozen ? { "Заморожені ID": [["Offer ID"], ["2999999911"]] } : {}) };
    await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets, groups: s.groups });
    const line = s.supplierXml().split("\n").find((l) => l.startsWith('<offer id="1500000063"'));
    await fsp.writeFile(path.join(dir, "supplier.xml"), s.supplierXml().replace(line, line + "\n" + line.replace('<offer id="1500000063"', '<offer id="2999999911"')));
    const store = new LocalObjectStore(path.join(dir, "store"));
    await store.putJson("approved/main.json", s.manifestMain);
    const config = structuredClone(baseConfig);
    config.supplier.minimumOffers = 10;
    return runUpdate({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(path.join(dir, "supplier.xml")), now: () => now, tmpDir: dir });
  };
  const withFrozen = await run(true);
  assert.equal(withFrozen.sync.state, "OK");
  assert.equal(withFrozen.identity.manualReview, 0);
  assert.equal(withFrozen.identity.frozenIgnored, 1);
  assert.equal(withFrozen.feeds[0].state, "PUBLISHED");
  const without = await run(false);
  assert.equal(without.identity.manualReview, 1);
});
