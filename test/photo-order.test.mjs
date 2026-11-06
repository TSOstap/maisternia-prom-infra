// Рішення власника 06.11: власний порядок фото зберігається, поки постачальник не змінив сам набір фото.
import test from "node:test";
import assert from "node:assert/strict";
import { supplierPhotos } from "../src/core/sheet-sync.mjs";

const u = (n) => `https://images.prom.ua/${n}_tool.jpg`;

test("той самий набір в іншому порядку — лишається порядок каталогу", () => {
  const ours = JSON.stringify([u(2), u(1), u(3)]);
  assert.equal(supplierPhotos(ours, [u(1), u(2), u(3)]), ours);
});

test("постачальник додав або прибрав фото — повний список постачальника", () => {
  const ours = JSON.stringify([u(2), u(1), u(3)]);
  assert.equal(supplierPhotos(ours, [u(1), u(2), u(3), u(4)]), JSON.stringify([u(1), u(2), u(3), u(4)]));
  assert.equal(supplierPhotos(ours, [u(1), u(2)]), JSON.stringify([u(1), u(2)]));
  assert.equal(supplierPhotos(ours, [u(1), u(2), u(5)]), JSON.stringify([u(1), u(2), u(5)]));
});

test("порожній / зламаний каталог і понад 10 фото — список постачальника (перші 10)", () => {
  const many = Array.from({ length: 12 }, (_, i) => u(i + 1));
  assert.equal(supplierPhotos("", [u(1)]), JSON.stringify([u(1)]));
  assert.equal(supplierPhotos("{не json", [u(1)]), JSON.stringify([u(1)]));
  assert.equal(supplierPhotos(JSON.stringify(many.slice(0, 10).reverse()), many), JSON.stringify(many.slice(0, 10).reverse()));
});

test("той самий ID фото з іншою назвою файлу — порядок каталогу лишається", () => {
  const ours = JSON.stringify([`https://images.prom.ua/2_a.jpg`, `https://images.prom.ua/1_a.jpg`]);
  assert.equal(supplierPhotos(ours, [`https://images.prom.ua/1_b.jpg`, `https://images.prom.ua/2_b.jpg`]), ours);
});
