/** Словник синонімів брендів (погоджено 22.10.2026): лише порівняння, без зміни карток. */
import test from "node:test";
import assert from "node:assert/strict";
import { brandKey, BRAND_SYNONYMS } from "../src/core/identity.mjs";
import { resolveIdentity } from "../src/core/d1.mjs";
import { YML_HEADERS } from "../src/core/seal.mjs";

test("погоджені варіанти написання — один бренд; канонічне написання Felso", () => {
  assert.equal(brandKey("Felső"), "felso");
  assert.equal(brandKey("Felso"), "felso");
  assert.equal(brandKey("FELSŐ"), "felso");
  assert.equal(brandKey("Kärcher"), brandKey("Karcher"));
  assert.equal(brandKey("Кентавр"), brandKey("Kentavr"));
  assert.equal(brandKey("KENTAVR"), brandKey("Кентавр"));
  assert.equal(brandKey("Phiolent"), brandKey("Фиолент"));
  assert.equal(brandKey("Makita Corporation"), brandKey("Makita"));
});

test("непогоджені й різні бренди лишаються різними", () => {
  assert.notEqual(brandKey("Titan"), brandKey("Титан"), "без офіційного джерела — не синонім");
  assert.notEqual(brandKey("SEVER"), brandKey("Север"));
  assert.notEqual(brandKey("Makita"), brandKey("Maktec"));
  assert.notEqual(brandKey("СЛОН"), brandKey("Samsung"));
  assert.notEqual(brandKey("Grad"), brandKey("Sigma"));
  assert.notEqual(brandKey("kwb"), brandKey("Einhell"));
  assert.equal(brandKey(""), "");
  assert.ok(Object.isFrozen(BRAND_SYNONYMS));
});

const row = (oid, sku, ua, brand) => Object.fromEntries(YML_HEADERS.map((k) => [k, ""]).concat([["Offer ID", oid], ["ID постачальника", oid], ["Артикул постачальника", sku], ["Назва постачальника UA", ua], ["Назва постачальника RU", ua], ["Виробник", brand]]));
const offer = (id, sku, ua, vendor) => [id, { id, sku, nameUa: ua, nameRu: ua, vendor, url: "" }];

test("перевипуск ID: Felső у картці і Felso у постачальника — без хибного конфлікту бренду, картку не змінено", () => {
  const cards = [row("1", "GL100", "Болгарка 100 Вт", "Felső")];
  const offers = new Map([offer("9", "GL100", "Болгарка 100 Вт", "Felso")]); // ID картки зник, з'явився новий
  const r = resolveIdentity({ syncRows: cards, knownRows: cards, offers, links: null, autoRelink: true, now: Date.now() });
  assert.equal(r.relinked.length, 1);
  assert.equal(r.manual.length, 0);
  assert.equal(cards[0]["Виробник"], "Felső", "бренд у картці не перезаписано");
});

test("непогоджений варіант (Titan/Титан) — як і раніше конфлікт бренду → ручна перевірка", () => {
  const cards = [row("1", "BB10", "Гравер 100 Вт", "Titan")];
  const offers = new Map([offer("9", "BB10", "Гравер 100 Вт", "Титан")]);
  const r = resolveIdentity({ syncRows: cards, knownRows: cards, offers, links: null, autoRelink: true, now: Date.now() });
  assert.equal(r.relinked.length, 0);
  assert.equal(r.manual.length, 1);
});
