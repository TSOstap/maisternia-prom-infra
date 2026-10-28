/** Пакет FZ (Frozen Attributes): збереження прийнятих характеристик новозахищених товарів. Дизайн — FZ-03 ред. 2 і рецензії Hermes
 *  (FZ-HERMES-рецензія-ред2, FZ-HERMES-06-Технічне-узгодження, 28.10.2026).
 *  Стан A — у кореневому контракті захисту немає requiresFrozenAttrs: FZ сплячий, N1-2 без змін.
 *  Стан B — requiresFrozenAttrs у кореневому контракті (читається незалежно від ENV): FZ обов'язковий; будь-яка відсутність /
 *  пошкодження / невідповідність — структурований BLOCK до записів; для FZ-товару — лише збережені params / provenance.
 *  Товари й значення — синтетичні. Відбиток рахується тут незалежно (канонічний JSON) — це формат контракту, не копія коду. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadPromCatalog, freezeFingerprint } from "../src/pipeline/prom-schemas.mjs";
import { OWNER_INDEX_A } from "./helpers/state-a.mjs"; // OV (R1): прийнятий перелік рішень без required
import { refreshMainRow, candidateRow, PARAMS_ORIGIN, SHEET, BINDINGS_SHEET, BINDINGS_HEADERS, extractFullOffers } from "../src/core/sheet-sync.mjs";
import { SEAL_COLUMN, rowSeal } from "../src/core/seal.mjs";
import { mtText } from "../src/core/text.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { mergeNew92, syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import baseConfig from "../config/default.json" with { type: "json" };
import { intakeAll } from "./helpers/intake.mjs";

// Канонічний JSON: ключі об'єктів відсортовано рекурсивно, порядок масивів збережено.
const canon = (x) => (Array.isArray(x) ? `[${x.map(canon).join(",")}]` : x && typeof x === "object" ? `{${Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + canon(x[k])).join(",")}}` : JSON.stringify(x));
const fsha = (x) => "sha256:" + crypto.createHash("sha256").update(canon(x), "utf8").digest("hex");
const fzFingerprint = (items, basis) => fsha({ basis, items: [...items].sort((a, b) => a.id.localeCompare(b.id)) });

const EMPTY = Object.freeze({ schemas: new Map(), mappings: new Map(), units: { conversions: [] }, problems: [] });
const STAMP = "2026-10-28T10:00:00.000Z";
const SAW = "1250302";
const UL = (items) => `<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`;
const P = (name, value, unit = "") => ({ name, value, unit });
const SAVED = [P("Вага", "4.7", "кг"), P("Довжина кабелю", "2 м")];
const PROV = { v: 1, cat: SAW, items: [{ k: "Вага\u00014.7\u0001кг", s: "ОПИС", a: "" }], x: [], notes: [] };
const BASIS = { snapshot: "тест.json", snapshotSha: "sha256:" + "0".repeat(64), acceptedCommit: "1961ef9ca886e496ceeea8005959d2c61de1bf65", acceptedBy: "тест" };

const baseRow = (id = "91", o = {}) => {
  const r = { "Offer ID": id, "ID постачальника": id, "Артикул постачальника": "TS-1", "Назва UA": "Пила тестова", "Назва RU": "Пила тестовая", "Категорія Prom ID": SAW, "Виробник": "Test", "Модель": "TS-1", "Характеристики JSON": "[]", [PARAMS_ORIGIN]: "", "Назва постачальника UA": "Пила тестова TS-1", "Назва постачальника RU": "Пила тестовая TS-1", "URL постачальника": `https://example.com/${id}.html`, "Фото JSON": "[]", ...o };
  r[SEAL_COLUMN] = rowSeal(r);
  return r;
};
// offer — операційний розбір з identityFields: true (як у production: tools/sheet-sync.mjs, pipeline/update.mjs) — з vendor і model.
const offerOf = (id = "91", o = {}) => ({ id, sku: "TS-1", nameUa: "Пила тестова TS-1", nameRu: "Пила тестовая TS-1", price: 100, available: true, currency: "UAH", quantity: "", url: `https://example.com/${id}.html`, gtin: "", vendor: "Test", model: "TS-1", ...o });
// full — повний XML (окремий фід у production) з read-only полями ідентичності: id, vendor, sku (vendorCode), categoryId постачальника.
const fullOf = (o = {}) => ({ nameUa: "Пила тестова TS-1", nameRu: "Пила тестовая TS-1", descriptionUa: UL(["Вага – 4.7 кг", "Довжина кабелю – 2 м", "Потужність – 1100 Вт"]), descriptionRu: UL(["Вес – 4.7 кг", "Длина кабеля – 2 м", "Мощность – 1100 Вт"]), pictures: [], params: [], country: "", model: "TS-1", id: "91", vendor: "Test", sku: "TS-1", categoryId: "77", ...o });
const OFFER_KEYS = ["id", "sku", "nameUa", "nameRu", "url", "vendor", "model"];
const FULL_KEYS = ["nameUa", "nameRu", "descriptionUa", "descriptionRu", "model", "id", "vendor", "sku", "categoryId", "params", "pictures"];
// Джерело знімка — лише ключі, які реально повернув парсер (відсутній ключ не стає undefined / порожнім значенням).
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.prototype.hasOwnProperty.call(o, k)).map((k) => [k, o[k]]));

// Збережений стан = звичайне оновлення даних постачальника (без генератора) + збережені params / provenance + печатка.
const savedRowOf = (row, offer, full) => {
  const raw = refreshMainRow({ ...row }, offer, full, { stamp: STAMP, catalog: EMPTY }).row;
  const r = { ...raw, "Характеристики JSON": JSON.stringify(SAVED), [PARAMS_ORIGIN]: JSON.stringify(PROV) };
  r[SEAL_COLUMN] = rowSeal(r);
  return r;
};
// schemaCategoryId — фактична категорія вибору схеми на момент знімка: категорія товару в експорті Prom, якщо є, інакше — таблиці.
const itemOf = (row = baseRow(), offer = offerOf(mtText(row["ID постачальника"])), full = fullOf({ id: mtText(row["ID постачальника"]) }), promCat = "") => {
  const saved = savedRowOf(row, offer, full);
  return {
    id: mtText(row["Offer ID"]), supplierId: mtText(row["ID постачальника"]), categoryId: mtText(row["Категорія Prom ID"]), schemaCategoryId: promCat || mtText(row["Категорія Prom ID"]), vendor: mtText(row["Виробник"]),
    params: SAVED, provenance: PROV,
    source: { offer: pick(offer, OFFER_KEYS), full: pick(full, FULL_KEYS) },
    expected: { paramsJson: mtText(row["Характеристики JSON"]), provenanceJson: mtText(row[PARAMS_ORIGIN]), seal: mtText(row[SEAL_COLUMN]) },
    saved: { paramsJson: saved["Характеристики JSON"], provenanceJson: saved[PARAMS_ORIGIN], seal: saved[SEAL_COLUMN] },
    reason: "тест",
  };
};
const fzContractOf = (items, basis = BASIS) => ({ v: 1, rev: 1, date: "2026-10-28", count: items.length, idsFingerprint: freezeFingerprint(items.map((x) => x.id)), fingerprint: fzFingerprint(items, basis), basis: { snapshotSha: basis.snapshotSha, acceptedCommit: basis.acceptedCommit } });
const fzFileOf = (items, basis = BASIS) => ({ v: 1, rev: 1, date: "2026-10-28", source: "тест", basis, count: items.length, fingerprint: fzFingerprint(items, basis), items });
const freezeFileOf = (ids, scope) => ({ v: 1, rev: 1, date: "2026-10-28", source: "тест", count: ids.length, ids, scope: { count: scope.length, ids: scope } });
const rootContractOf = (ids, scope, rq) => ({ v: 1, rev: 1, date: "2026-10-28", source: "тест", count: ids.length, fingerprint: freezeFingerprint(ids), scope: { count: scope.length, fingerprint: freezeFingerprint(scope) }, ...(rq === undefined ? {} : { requiresFrozenAttrs: rq }) });

/** Синтетичне середовище. null — файл не створюється; рядок — сирий вміст файлу; *EnvSet: false — змінна не задана. */
function env({ items = [itemOf()], active = true, protectedIds = ["91", "92"], scope = ["90", "91", "92"], freeze, root, fzFile, fzContract, freezeEnvSet = true, fzEnvSet = true, ownerFile = "", promCategories = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fz-"));
  const w = (n, x) => { const f = path.join(dir, n); if (x !== null) fs.writeFileSync(f, typeof x === "string" ? x : JSON.stringify(x)); return f; };
  const rq = fzContractOf(items);
  const ff = w("freeze.json", freeze === undefined ? freezeFileOf(protectedIds, scope) : freeze);
  const rk = w("freeze-contract.json", root === undefined ? rootContractOf(protectedIds, scope, active ? rq : undefined) : root);
  const zf = w("frozen.json", fzFile === undefined ? fzFileOf(items) : fzFile);
  const zk = w("frozen-contract.json", fzContract === undefined ? rq : fzContract);
  // Експорт категорій Prom (формат MM_PROM_CATEGORIES): { date, source, categories: { Offer ID: ID категорії } }.
  const pc = promCategories ? w("prom-categories.json", { date: "2026-10-28", source: "тест", categories: promCategories }) : "";
  const cat = loadPromCatalog(undefined, { ownerValuesIndexFile: OWNER_INDEX_A, ownerIndexLegacy: true, freezeFile: freezeEnvSet ? ff : "", freezeContractFile: rk, frozenAttrsFile: fzEnvSet ? zf : "", frozenAttrsContractFile: zk, a3PairsFile: "", n0CohortFile: "", ownerValuesFile: ownerFile, promCategoriesFile: pc });
  return { dir, cat, rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const run = (cat, row = baseRow(), offer = offerOf(mtText(row["ID постачальника"]) || "91"), full = fullOf()) => refreshMainRow({ ...row }, offer, full, { stamp: STAMP, catalog: cat });
const blocked = (a, re) => Boolean(a.frozenBlock) && a.changed === false && (!re || re.test(JSON.stringify(a.frozenBlock)));

test("FZ стан A: у кореневому контракті немає requiresFrozenAttrs — FZ сплячий, MM_FROZEN_ATTRS ігнорується з попередженням, рядок — як без FZ", () => {
  const a = env({ active: false }), none = env({ active: false, fzEnvSet: false });
  assert.equal(a.cat.guard?.blocked, false, JSON.stringify(a.cat.guard));
  assert.equal(a.cat.frozenInfo?.active, false);
  assert.equal(a.cat.frozenFor?.("91"), null);
  assert.ok(a.cat.problems.some((p) => /FZ не активовано/.test(p)), JSON.stringify(a.cat.problems));
  assert.ok(!none.cat.problems.some((p) => /FZ|frozen/.test(p)), JSON.stringify(none.cat.problems));
  assert.deepEqual(run(a.cat), run(none.cat), "результат той самий, що без FZ-файлу");
  assert.notDeepEqual(JSON.parse(run(a.cat).row["Характеристики JSON"]), SAVED, "захищений — як зараз, не збережені значення");
  a.rm(); none.rm();
});

test("FZ кореневий контракт захисту: відсутній / пошкоджений JSON / некоректна структура / requiresFrozenAttrs присутній, але null / false / неповний — НЕ ВИКОНАНО незалежно від ENV", () => {
  const ids = ["91", "92"], scope = ["90", "91", "92"], rq = fzContractOf([itemOf()]);
  const { count: _c, ...rqNoCount } = rq;
  for (const [what, root] of [
    ["немає файлу", null], ["пошкоджений JSON", "{ зламаний"], ["без області дії", { ...rootContractOf(ids, scope), scope: undefined }], ["некоректний відбиток", { ...rootContractOf(ids, scope), fingerprint: "x" }],
    ["requiresFrozenAttrs: null", rootContractOf(ids, scope, null)], ["requiresFrozenAttrs: false", rootContractOf(ids, scope, false)],
    ["requiresFrozenAttrs без count", rootContractOf(ids, scope, rqNoCount)], ["requiresFrozenAttrs без basis", rootContractOf(ids, scope, { ...rq, basis: undefined })],
  ]) {
    for (const envSet of [true, false]) {
      const e = env({ root, freezeEnvSet: envSet, fzEnvSet: envSet });
      const how = `${what}, ENV ${envSet ? "задано" : "знято"}`;
      assert.equal(e.cat.guard?.blocked, true, `${how}: ${JSON.stringify(e.cat.guard)}`);
      if (/^requiresFrozenAttrs/.test(what)) assert.ok(e.cat.guard.reasons.some((p) => /requiresFrozenAttrs присутній, але некоректний/.test(p)), how + ": пошкодження, не «FZ не активовано»: " + JSON.stringify(e.cat.guard.reasons));
      const a = run(e.cat);
      assert.ok(blocked(a), how + ": refreshMainRow — структурований блокер без змін");
      assert.equal(a.row["Характеристики JSON"], "[]", how);
      e.rm();
    }
  }
});

test("FZ стан B: застосування — точно збережені params / provenance, печатка = збереженій; повторний запуск — нуль змін і записів «Журналу»", () => {
  const e = env(), it = itemOf();
  assert.equal(e.cat.guard?.blocked, false, JSON.stringify(e.cat.problems));
  assert.equal(e.cat.frozenInfo?.valid, true, JSON.stringify(e.cat.problems));
  const a = run(e.cat);
  assert.equal(a.frozenBlock, undefined, JSON.stringify(a.frozenBlock));
  assert.equal(a.row["Характеристики JSON"], it.saved.paramsJson);
  assert.equal(a.row[PARAMS_ORIGIN], it.saved.provenanceJson);
  assert.equal(a.row[SEAL_COLUMN], it.saved.seal);
  assert.ok(a.entries.some((x) => /ЗБЕРЕЖЕНІ ХАРАКТЕРИСТИКИ/.test(String(x[6]))), JSON.stringify(a.entries));
  const again = run(e.cat, a.row);
  assert.equal(again.frozenBlock, undefined, JSON.stringify(again.frozenBlock));
  assert.equal(again.changed, false, "уже збережено — нічого");
  assert.deepEqual(again.entries, [], "без записів «Журналу»");
  assert.deepEqual(again.row, a.row);
  assert.equal(e.cat.frozenFor("92"), null, "захищений без FZ-запису — як зараз");
  e.rm();
});

test("FZ стан B: обов'язкові входи — знято MM_FREEZE_IDS / MM_FROZEN_ATTRS, немає FZ-файлу / FZ-контракту / обох, пошкоджені, FZ-контракт ≠ requiresFrozenAttrs, перелік без FZ-товару — frozen: required, BLOCK для будь-якого рядка", () => {
  const rq = fzContractOf([itemOf()]);
  // Причина — саме та перевірка, що відповідає входу (без підміни іншою, пізнішою).
  for (const [what, o, why] of [
    ["знято MM_FREEZE_IDS", { freezeEnvSet: false }, /MM_FREEZE_IDS/], ["знято MM_FROZEN_ATTRS", { fzEnvSet: false }, /\(MM_FROZEN_ATTRS\) не задано/], ["знято обидві змінні", { freezeEnvSet: false, fzEnvSet: false }, /MM_FREEZE_IDS/],
    ["немає FZ-файлу", { fzFile: null }, /не знайдено/], ["немає FZ-контракту", { fzContract: null }, /FZ-контракт у репозиторії: відсутній/], ["немає FZ-файлу й FZ-контракту", { fzFile: null, fzContract: null }, /не знайдено/],
    ["пошкоджений FZ-файл", { fzFile: "{ зламаний" }, /некоректний JSON/], ["пошкоджений FZ-контракт", { fzContract: "{ зламаний" }, /FZ-контракт у репозиторії: некоректний JSON/],
    ["FZ-контракт ≠ requiresFrozenAttrs", { fzContract: { ...rq, date: "2026-10-27" } }, /≠ requiresFrozenAttrs/],
    ["пошкоджений перелік захищених", { freeze: "{ зламаний" }, /MM_FREEZE_IDS/],
    ["FZ-товар не в переліку захищених", { protectedIds: ["92"] }, /не захищені валідним переліком/],
  ]) {
    const e = env(o);
    assert.equal(e.cat.guard?.blocked, true, what + ": " + JSON.stringify(e.cat.problems));
    assert.ok(e.cat.problems.some((p) => /frozen: required/.test(p) && why.test(p)), what + ": " + JSON.stringify(e.cat.problems));
    for (const id of ["91", "90"]) assert.ok(blocked(run(e.cat, baseRow(id), offerOf(id))), `${what}: рядок ${id}`);
    e.rm();
  }
});

test("FZ fail-closed відбиток: підробка лише params / provenance / seal / джерела / expected / vendor / basis — FZ-файл недійсний, BLOCK", () => {
  const it = itemOf(), good = fzFileOf([it]);
  for (const [what, file] of [
    ["лише params", { ...good, items: [{ ...it, params: [...SAVED, P("Колір", "синій")] }] }],
    ["лише provenance", { ...good, items: [{ ...it, provenance: { ...PROV, notes: ["x"] } }] }],
    ["лише saved.seal", { ...good, items: [{ ...it, saved: { ...it.saved, seal: "b".repeat(64) } }] }],
    ["лише expected.provenanceJson", { ...good, items: [{ ...it, expected: { ...it.expected, provenanceJson: "{}" } }] }],
    ["лише source.full.model", { ...good, items: [{ ...it, source: { ...it.source, full: { ...it.source.full, model: "TS-2" } } }] }],
    ["лише vendor", { ...good, items: [{ ...it, vendor: "Other" }] }],
    ["лише schemaCategoryId", { ...good, items: [{ ...it, schemaCategoryId: "4305" }] }],
    ["лише source.offer.vendor", { ...good, items: [{ ...it, source: { ...it.source, offer: { ...it.source.offer, vendor: "Other" } } }] }],
    ["інший basis", { ...good, basis: { ...BASIS, acceptedCommit: "e8ebe0a" + "0".repeat(33) } }],
    ["узгоджено переписаний відбиток файлу (контракт старий)", fzFileOf([{ ...it, vendor: "Other" }])],
  ]) {
    const e = env({ fzFile: file });
    assert.equal(e.cat.frozenInfo?.valid, false, what);
    assert.equal(e.cat.guard?.blocked, true, what);
    assert.equal(e.cat.frozenFor?.("91") ?? null, null, what);
    e.rm();
  }
});

test("FZ структура запису: без schemaCategoryId (або порожній), без source.offer.vendor / model, без source.full.id / vendor / sku / categoryId, source.full.id ≠ supplierId — запис некоректний навіть з узгодженими відбитком і контрактом", () => {
  const without = (mut) => { const x = structuredClone(itemOf()); mut(x); return x; };
  for (const [what, bad] of [
    ["без schemaCategoryId", without((x) => delete x.schemaCategoryId)], ["порожній schemaCategoryId", without((x) => { x.schemaCategoryId = ""; })],
    ...["vendor", "model"].map((k) => [`без source.offer.${k}`, without((x) => delete x.source.offer[k])]),
    ...["id", "vendor", "sku", "categoryId"].map((k) => [`без source.full.${k}`, without((x) => delete x.source.full[k])]),
    ["source.full.id ≠ supplierId", without((x) => { x.source.full.id = "92"; })],
    ["source.offer.id ≠ supplierId", without((x) => { x.source.offer.id = "92"; })],
    ["params ≠ saved.paramsJson", without((x) => { x.params = [...x.params, P("Колір", "синій")]; })],
    ["provenance ≠ saved.provenanceJson", without((x) => { x.provenance = { ...x.provenance, notes: ["x"] }; })],
    ["saved.seal не 64 hex", without((x) => { x.saved.seal = "X".repeat(64); })],
    ["expected.seal не 64 hex", without((x) => { x.expected.seal = ""; })],
  ]) {
    const e = env({ items: [bad] });
    assert.equal(e.cat.frozenInfo?.valid, false, what);
    assert.equal(e.cat.guard?.blocked, true, what);
    assert.ok(e.cat.problems.some((p) => /запис №1 некоректний/.test(p)), what + ": " + JSON.stringify(e.cat.problems));
    e.rm();
  }
  // Повторений Offer ID (обидва записи коректні, відбиток і контракт узгоджені) — файл недійсний.
  const dup = env({ items: [itemOf(), itemOf()] });
  assert.equal(dup.cat.guard?.blocked, true, "повторений Offer ID");
  assert.ok(dup.cat.problems.some((p) => /повторені Offer ID/.test(p)), JSON.stringify(dup.cat.problems));
  dup.rm();
});

test("FZ узгодженість: requiresFrozenAttrs ≠ FZ-контракту при FZ-контракті = файлу; застаріле поле fingerprint файлу при узгодженому контракті — BLOCK", () => {
  const it = itemOf(), rq = fzContractOf([it]);
  const root = env({ root: rootContractOf(["91", "92"], ["90", "91", "92"], { ...rq, date: "2026-10-27" }) });
  assert.equal(root.cat.guard?.blocked, true, JSON.stringify(root.cat.problems));
  assert.ok(root.cat.problems.some((p) => /≠ requiresFrozenAttrs/.test(p)), JSON.stringify(root.cat.problems));
  root.rm();
  const tampered = { ...it, reason: "інша причина" }; // запис змінено; контракт перераховано, а поле fingerprint у файлі старе
  const stale = env({ items: [tampered], fzFile: { ...fzFileOf([tampered]), fingerprint: fzFingerprint([it], BASIS) } });
  assert.equal(stale.cat.guard?.blocked, true, JSON.stringify(stale.cat.problems));
  assert.ok(stale.cat.problems.some((p) => /відбиток не збігається з записами/.test(p)), JSON.stringify(stale.cat.problems));
  stale.rm();
});

test("FZ повнота offer / full — за ключами, не за truthiness: немає offer / full, full = {}, без будь-якого обов'язкового ключа (і порожнього), не той тип — BLOCK, рядок без змін", () => {
  // Порожні, але присутні значення (назва RU, опис RU) — валідні; відсутній ключ — ні.
  const row = baseRow("91", { "Назва постачальника RU": "" }), offer = offerOf("91", { nameRu: "" }), full = fullOf({ nameRu: "", descriptionRu: "" });
  const e = env({ items: [itemOf(row, offer, full)] });
  assert.equal(run(e.cat, row, offer, full).frozenBlock, undefined, "порожні присутні значення — валідні");
  const cases = [["offer = null", null, full], ["full = null", offer, null], ["full = {}", offer, {}], ["full.params не масив", offer, { ...full, params: "" }], ["full.pictures не масив", offer, { ...full, pictures: null }]];
  // offer без vendor / model — операційний розбір без identityFields: ідентичність невідома — BLOCK, не «порожній виробник».
  for (const k of FULL_KEYS) { const f = { ...full }; delete f[k]; cases.push([`full без «${k}»`, offer, f]); }
  for (const k of OFFER_KEYS) { const o = { ...offer }; delete o[k]; cases.push([`offer без «${k}»`, o, full]); }
  for (const [what, o, f] of cases) {
    const a = run(e.cat, row, o, f);
    // Саме блокер повноти (OFFER / FULL) — не підміна пізнішою звіркою джерела.
    assert.ok(blocked(a, new RegExp(`"kind":"${/^offer/.test(what) ? "OFFER" : "FULL"}"`)), what + ": " + JSON.stringify(a.frozenBlock));
    assert.equal(a.row["Характеристики JSON"], "[]", what);
  }
  e.rm();
});

test("FZ джерело: зміна кожного поля поточних offer / full (повні значення, без нормалізації) — BLOCK з очікуваного і зі збереженого стану; збережене не стирається", () => {
  const e = env(), saved = run(e.cat).row;
  for (const [what, o, f] of [
    ["offer.sku", offerOf("91", { sku: "TS-1 " }), fullOf()], ["offer.nameUa", offerOf("91", { nameUa: "Пила тестова TS-2" }), fullOf()], ["offer.nameRu", offerOf("91", { nameRu: "пила тестовая TS-1" }), fullOf()], ["offer.url", offerOf("91", { url: "https://example.com/x.html" }), fullOf()],
    ["full.nameUa (комплектація)", offerOf(), fullOf({ nameUa: "Пила тестова TS-1 (з кейсом)" })], ["full.nameRu", offerOf(), fullOf({ nameRu: "Пила тестовая TS-1 " })], ["full.descriptionUa", offerOf(), fullOf({ descriptionUa: UL(["Вага – 5 кг"]) })], ["full.descriptionRu", offerOf(), fullOf({ descriptionRu: "" })],
    ["full.model", offerOf(), fullOf({ model: "TS-1 " })], ["full.params", offerOf(), fullOf({ params: [P("Вес", "4.7", "кг")] })], ["full.pictures", offerOf(), fullOf({ pictures: ["https://example.com/1.jpg"] })],
    // Ідентичність з обох джерел: одне джерело не маскує зміну іншого (операційний і повний XML — різні фіди).
    ["offer.vendor", offerOf("91", { vendor: "Other" }), fullOf()], ["offer.model при старому full", offerOf("91", { model: "TS-2" }), fullOf()],
    ["full.vendor при старому offer", offerOf(), fullOf({ vendor: "Other" })], ["full.sku при старому offer", offerOf(), fullOf({ sku: "TS-2" })],
    ["full.categoryId постачальника", offerOf(), fullOf({ categoryId: "78" })], ["full.id", offerOf(), fullOf({ id: "92" })],
  ]) {
    assert.ok(blocked(run(e.cat, baseRow(), o, f)), what + " (очікуваний стан)");
    const b = run(e.cat, saved, o, f);
    assert.ok(blocked(b), what + " (збережений стан — не «вже збережено»)");
    assert.equal(b.row["Характеристики JSON"], saved["Характеристики JSON"], what + ": збережене не стирається");
  }
  e.rm();
});

test("FZ локальна ідентичність і печатка: ID постачальника / категорія / «Виробник» / артикул / назви постачальника / модель / наша назва — з перерахованою печаткою і зі старою — BLOCK; поточна печатка ≠ рядку — BLOCK до «вже збережено»", () => {
  const e = env(), saved = run(e.cat).row;
  for (const [col, v] of [["ID постачальника", "92"], ["Категорія Prom ID", "4305"], ["Виробник", "Other"], ["Артикул постачальника", "TS-9"], ["Назва постачальника UA", "Пила тестова TS-1 комплект"], ["Назва постачальника RU", "x"], ["Модель", "TS-2"], ["Назва UA", "Пила тестова нова"]]) {
    for (const [state, r0] of [["очікуваний", baseRow()], ["збережений", saved]]) {
      const resealed = { ...r0, [col]: v };
      resealed[SEAL_COLUMN] = rowSeal(resealed);
      for (const [how, r] of [["печатку перераховано", resealed], ["стара печатка", { ...r0, [col]: v }]]) {
        const a = run(e.cat, r, offerOf("91"));
        assert.ok(blocked(a), `${col} (${state}, ${how}): ${JSON.stringify(a.frozenBlock)}`);
        assert.deepEqual(a.row, r, `${col} (${state}, ${how}): рядок без змін`);
      }
    }
  }
  e.rm();
});

test("FZ запис, чия локальна ідентичність (vendor / categoryId) не відповідає рядку знімка, а печатки — відповідають (відбиток і контракт узгоджені) — BLOCK ІДЕНТИЧНІСТЬ, не застосування", () => {
  for (const [what, it] of [["vendor", { ...itemOf(), vendor: "Other" }], ["categoryId", { ...itemOf(), categoryId: "4305" }]]) {
    const e = env({ items: [it] });
    assert.equal(e.cat.frozenInfo?.valid, true, what + ": " + JSON.stringify(e.cat.problems));
    const r0 = baseRow(), a = run(e.cat, r0);
    assert.ok(blocked(a, /ІДЕНТИЧНІСТЬ/), what + ": " + JSON.stringify(a.frozenBlock));
    assert.deepEqual(a.row, r0, what + ": рядок без змін");
    e.rm();
  }
});

test("FZ фактична категорія вибору схеми (schemaCategory: експорт Prom має пріоритет над таблицею): експорт змінився при старій локальній — BLOCK з очікуваного і збереженого стану; знімок за експортом, а експорт зник / без товару / інший — BLOCK; та сама — валідно", () => {
  const clean = env(), saved = run(clean.cat).row;
  const same = env({ promCategories: { "91": SAW } });
  assert.equal(run(same.cat).frozenBlock, undefined, "експорт із тією самою категорією — валідно");
  const moved = env({ promCategories: { "91": "4305" } });
  for (const [state, r0] of [["очікуваний", baseRow()], ["збережений", saved]]) {
    const a = run(moved.cat, r0);
    assert.ok(blocked(a, /Категорія/), `${state}: ${JSON.stringify(a.frozenBlock)}`);
    assert.deepEqual(a.row, r0, `${state}: рядок без змін`);
  }
  const it = itemOf(baseRow(), undefined, undefined, "4305"); // знімок, коли експорт Prom давав 4305 (таблиця — SAW)
  const withExport = env({ items: [it], promCategories: { "91": "4305" } });
  assert.equal(run(withExport.cat).frozenBlock, undefined, "знімок за експортом, експорт той самий — валідно");
  for (const [what, pcs] of [["експорт зник (фактична — таблиці)", null], ["експорт без товару", { "90": "4305" }], ["експорт — інша категорія", { "91": "4306" }]]) {
    const e = env({ items: [it], promCategories: pcs });
    assert.ok(blocked(run(e.cat), /Категорія/), what);
    e.rm();
  }
  for (const e of [clean, same, moved, withExport]) e.rm();
});

test("FZ ручний drift: лише JSON / лише provenance / лише печатка — з очікуваного і зі збереженого стану — BLOCK, нічого не перезаписано", () => {
  const e = env(), saved = run(e.cat).row;
  for (const [state, r0] of [["очікуваний", baseRow()], ["збережений", saved]]) {
    const json = { ...r0, "Характеристики JSON": JSON.stringify([P("Вага", "5", "кг")]) };
    json[SEAL_COLUMN] = rowSeal(json);
    for (const [what, r] of [["JSON (печатку перераховано)", json], ["лише provenance", { ...r0, [PARAMS_ORIGIN]: JSON.stringify({ v: 1, items: [] }) }], ["лише печатка", { ...r0, [SEAL_COLUMN]: "c".repeat(64) }]]) {
      const a = run(e.cat, r);
      assert.ok(blocked(a), `${state}: ${what}: ${JSON.stringify(a.frozenBlock)}`);
      assert.deepEqual(a.row, r, `${state}: ${what} — рядок без змін`);
    }
  }
  e.rm();
});

test("FZ рішення власника для FZ-товару (навіть невалідне) — BLOCK до нової погодженої ревізії; збережений набір не губиться", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fz-own-"));
  const ok = path.join(dir, "owner.json"), bad = path.join(dir, "owner-bad.json");
  fs.writeFileSync(ok, JSON.stringify({ v: 1, date: "2026-10-28", products: { "91": { items: [{ name: "Вага", value: "6", unit: "кг", action: "set", source: "тест", date: "2026-10-28", priority: 1 }] } } }));
  fs.writeFileSync(bad, JSON.stringify({ v: 1, date: "2026-10-28", products: { "91": { items: [{ name: "Вага", value: "6", unit: "кг", action: "set" }] } } }));
  const broken = path.join(dir, "owner-broken.json");
  fs.writeFileSync(broken, "{ зламаний"); // файл рішень не прочитано — рішення для FZ-товару невідомі
  const clean = env(), saved = run(clean.cat).row;
  for (const file of [ok, bad, broken]) {
    const e = env({ ownerFile: file });
    for (const [state, r0] of [["очікуваний", baseRow()], ["збережений", saved]]) {
      const a = run(e.cat, r0);
      assert.ok(blocked(a, /власник/i), `${path.basename(file)}, ${state}: ${JSON.stringify(a.frozenBlock)}`);
      assert.equal(a.row["Характеристики JSON"], r0["Характеристики JSON"], `${state}: 29 з 30 не губляться — рядок без змін`);
    }
    e.rm();
  }
  // Валідний файл рішень без FZ-товару — не блокер: FZ застосовується.
  const other = path.join(dir, "owner-other.json");
  fs.writeFileSync(other, JSON.stringify({ v: 1, date: "2026-10-28", products: { "90": { items: [{ name: "Вага", value: "6", unit: "кг", action: "set", source: "тест", date: "2026-10-28", priority: 1 }] } } }));
  const o = env({ ownerFile: other });
  assert.equal(o.cat.ownerValuesOk, true, JSON.stringify(o.cat.problems));
  const a = run(o.cat);
  assert.equal(a.frozenBlock, undefined, JSON.stringify(a.frozenBlock));
  assert.equal(a.row["Характеристики JSON"], itemOf().saved.paramsJson);
  o.rm();
  clean.rm();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("FZ запис із печаткою, що не відповідає збереженим характеристикам (відбиток і контракт узгоджені) — після застосування печатка ≠ збереженій: BLOCK, рядок без змін", () => {
  const it = { ...itemOf(), saved: { ...itemOf().saved, seal: "a".repeat(64) } };
  const e = env({ items: [it] });
  assert.equal(e.cat.frozenInfo?.valid, true, JSON.stringify(e.cat.problems));
  const r0 = baseRow(), a = run(e.cat, r0);
  assert.ok(blocked(a, /ПЕЧАТКА/), JSON.stringify(a.frozenBlock));
  assert.deepEqual(a.row, r0, "рядок без змін");
  e.rm();
});

test("FZ область: FZ-запис для незахищеного товару — файл недійсний (BLOCK); у стані B незахищений і захищений без FZ-запису — як зараз", () => {
  const out = env({ items: [itemOf(baseRow("90"))] });
  assert.equal(out.cat.guard?.blocked, true, JSON.stringify(out.cat.problems));
  out.rm();
  const e = env();
  assert.equal(e.cat.frozenFor("92"), null);
  assert.equal(e.cat.frozenFor("90"), null);
  const a = run(e.cat, baseRow("90"), offerOf("90"));
  assert.equal(a.frozenBlock, undefined, "незахищений у стані B — генератор як зараз");
  e.rm();
});

// ---------- інтеграційний конвеєр: syncSheet з таблицею в пам'яті ----------
const NOW = Date.parse("2026-10-22T10:00:00Z");
const WSTAMP = new Date(NOW).toISOString();
const config = structuredClone(baseConfig);
const WRITES = ["updateRanges", "appendRows", "deleteRows", "ensureSheet", "ensureColumns", "setPercentFormat"];

/** Тег у записі offer XML: замінити значення або додати перед </offer> (реальний шлях XML → parser → FZ). */
const withTag = (xml, sid, tag, v) => xml.replace(new RegExp(`(<offer\\b[^>]*\\bid="${sid}"[^>]*>)([\\s\\S]*?)(</offer>)`), (_, a, b, c) => {
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  return a + (re.test(b) ? b.replace(re, () => `<${tag}>${v}</${tag}>`) : b + `<${tag}>${v}</${tag}>`) + c;
});
const parseXml = (xml) => parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });

/** Синтетичний світ після NEW92; FZ-товар — перший рядок основного каталогу, присутній у фіді; у його записі XML є <vendor> і <model>. */
async function fzWorld({ prepare = () => {} } = {}) {
  const s = generateSynthetic({ products: 60, queue: 6, deferred: 2, newOffers: 2, seed: 7, now: NOW });
  const book = {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
  const sheets = new MemorySheets(book);
  const readBook = async () => structuredClone(book);
  await mergeNew92({ sheets, readBook, stamp: WSTAMP });
  const xml0 = s.supplierXml();
  const inFeed = (await parseXml(xml0)).offers;
  const main = readSheet(book[SHEET.main], SHEET.main).rows;
  const row = main.find((r) => inFeed.has(mtText(r["ID постачальника"])));
  const sid = mtText(row["ID постачальника"]);
  const xml = withTag(withTag(xml0, sid, "vendor", "Test"), sid, "model", "TS-1");
  const parsed = await parseXml(xml);
  assert.equal(parsed.offers.get(sid).vendor, "Test", "передумова: vendor з реального XML");
  const it = itemOf(row, parsed.offers.get(sid), extractFullOffers(xml, [sid]).get(sid));
  const ids = main.map((r) => mtText(r["Offer ID"]));
  const w = { book, sheets, readBook, xml, parsed, row, sid, it, ids, fetchFull: async (x) => extractFullOffers(xml, x) };
  prepare(w);
  const calls = [];
  for (const m of WRITES) { const f = sheets[m].bind(sheets); sheets[m] = async (...a) => { calls.push([m, typeof a[0] === "string" ? a[0] : (a[0] || []).map((x) => x.title).join(",")]); return f(...a); }; }
  w.calls = calls;
  return w;
}
const fzCatalog = (w, o = {}) => env({ items: [w.it], protectedIds: [w.it.id], scope: w.ids, ...o });
const syncFz = (w, cat, parsed = w.parsed) => syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed, fetchFull: w.fetchFull, stamp: WSTAMP, config, now: NOW, catalog: cat });

test("FZ конвеєр: будь-який FZ-блокер (каталог, немає offer / full, drift, рішення власника) — ABORTED до записів даних; єдиний запис — службова подія «ОНОВЛЕННЯ ЗАБЛОКОВАНО» в «Журналі»", async () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "fz-own-"));
  const cases = [
    ["кореневий контракт відсутній", (w) => ({ e: fzCatalog(w, { root: null }) })],
    ["немає offer FZ-товару", (w) => { const p = { ...w.parsed, offers: new Map(w.parsed.offers) }; p.offers.delete(w.sid); return { e: fzCatalog(w), parsed: p }; }],
    ["немає full FZ-товару", (w) => { w.fetchFull = async (x) => { const m = extractFullOffers(w.xml, x); m.delete(w.sid); return m; }; return { e: fzCatalog(w) }; }],
    ["ручний drift provenance", (w) => { const h = w.book[SHEET.main][0]; let j = h.indexOf(PARAMS_ORIGIN); if (j < 0) { h.push(PARAMS_ORIGIN); j = h.length - 1; for (const r of w.book[SHEET.main].slice(1)) r[j] = ""; } const i = w.book[SHEET.main].findIndex((r) => mtText(r[h.indexOf("Offer ID")]) === w.it.id); w.book[SHEET.main][i][j] = JSON.stringify({ v: 1, items: [] }); return { e: fzCatalog(w) }; }],
    // preflight проходить (рядок = очікуваному), блокер — лише після оновлення (печатка ≠ збереженій) — пізня перевірка lateFz.
    ["збережена печатка ≠ збереженим характеристикам", (w) => ({ e: fzCatalog(w, { items: [{ ...w.it, saved: { ...w.it.saved, seal: "a".repeat(64) } }] }) })],
    ["рішення власника", (w) => { const f = path.join(own, "owner.json"); fs.writeFileSync(f, JSON.stringify({ v: 1, date: "2026-10-28", products: { [w.it.id]: { items: [{ name: "Вага", value: "6", unit: "кг", source: "тест", date: "2026-10-28" }] } } })); return { e: fzCatalog(w, { ownerFile: f }) }; }],
  ];
  for (const [what, setup] of cases) {
    const w = await fzWorld();
    const { e, parsed } = setup(w);
    const before = structuredClone(w.book);
    const r = await syncFz(w, e.cat, parsed || w.parsed);
    assert.equal(r.state, "ABORTED", what + ": " + JSON.stringify(r).slice(0, 300));
    assert.equal(r.block?.type, "ЗАХИСТ ХАРАКТЕРИСТИК (FZ)", what);
    for (const k of Object.keys(before)) if (k !== SHEET.journal) assert.deepEqual(w.book[k], before[k], `${what}: аркуш «${k}» не змінено (ціни / наявність теж)`);
    assert.deepEqual(w.calls, [["appendRows", SHEET.journal]], what + ": жодного запису даних; лише службова подія в «Журналі»");
    const added = w.book[SHEET.journal].slice(before[SHEET.journal].length);
    assert.equal(added.length, 1, what);
    assert.deepEqual([added[0][3], added[0][4]], ["ОНОВЛЕННЯ ЗАБЛОКОВАНО", "ЗАХИСТ ХАРАКТЕРИСТИК (FZ)"], what);
    // Недійсний каталог зупиняє прохід одразу (одна причина), а не переліком блокерів кожного рядка.
    if (what === "кореневий контракт відсутній") assert.match(r.reason, /^прохід НЕ ВИКОНАНО: кореневий контракт захисту/, what);
    e.rm();
  }
  fs.rmSync(own, { recursive: true, force: true });
});

test("FZ intake (GitHub, лише черга): заблокований каталог — ABORTED до запису черги, лише службова подія в «Журналі»; валідний FZ — intake не блокується", async () => {
  const w = await fzWorld();
  const bad = fzCatalog(w, { root: null });
  const before = structuredClone(w.book);
  const r = await intakeAll(w, w.xml, { stamp: WSTAMP, now: NOW, config, catalog: bad.cat });
  assertFzAborted(w, r, before, "intake за заблокованого каталогу");
  bad.rm();
  const w2 = await fzWorld();
  const ok = fzCatalog(w2);
  const r2 = await intakeAll(w2, w2.xml, { stamp: WSTAMP, now: NOW, config, catalog: ok.cat });
  assert.notEqual(r2.state, "ABORTED", JSON.stringify(r2).slice(0, 300));
  ok.rm();
});

test("FZ конвеєр: FZ-товару немає в основному каталозі (захищений і в області дії) — ABORTED до записів даних", async () => {
  const w = await fzWorld();
  const it = { ...w.it, id: "2999999999" };
  const e = fzCatalog(w, { items: [it], protectedIds: [it.id], scope: [...w.ids, it.id] });
  assert.equal(e.cat.frozenInfo?.valid, true, JSON.stringify(e.cat.problems));
  const before = structuredClone(w.book);
  const r = await syncFz(w, e.cat);
  assertFzAborted(w, r, before, "FZ-товару немає в основному каталозі");
  assert.match(r.reason, /2999999999: немає в основному каталозі/);
  e.rm();
});

test("FZ конвеєр: застосування — SYNCED, у FZ-рядку збережені params / provenance; повторний запуск — FZ-рядок без змін і без записів «Журналу» для нього", async () => {
  const w = await fzWorld();
  const e = fzCatalog(w);
  const r = await syncFz(w, e.cat);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 400));
  const rowNow = () => readSheet(w.book[SHEET.main], SHEET.main).rows.find((x) => mtText(x["Offer ID"]) === w.it.id);
  assert.equal(mtText(rowNow()["Характеристики JSON"]), w.it.saved.paramsJson);
  assert.equal(mtText(rowNow()[PARAMS_ORIGIN]), w.it.saved.provenanceJson);
  assert.equal(mtText(rowNow()[SEAL_COLUMN]), w.it.saved.seal);
  const after1 = structuredClone(rowNow()), journal1 = w.book[SHEET.journal].length;
  const r2 = await syncFz(w, e.cat);
  assert.equal(r2.state, "SYNCED", JSON.stringify(r2).slice(0, 400));
  const frozenCols = Object.keys(after1).filter((k) => !["Оновлено", "Стан синхронізації"].includes(k));
  for (const k of frozenCols) assert.equal(mtText(rowNow()[k]), mtText(after1[k]), `повторний запуск: «${k}» без змін`);
  assert.ok(!w.book[SHEET.journal].slice(journal1).some((x) => mtText(x[2]) === w.it.id && !["Оновлено", "Стан синхронізації"].includes(mtText(x[3]))), "без записів «Журналу» для FZ-рядка, крім службових живих колонок");
  e.rm();
});

/** Заблокований прохід: ABORTED із типом FZ, дані не змінено, єдиний запис — службова подія в «Журналі». */
function assertFzAborted(w, r, before, how) {
  assert.equal(r.state, "ABORTED", how + ": " + JSON.stringify(r).slice(0, 300));
  assert.equal(r.block?.type, "ЗАХИСТ ХАРАКТЕРИСТИК (FZ)", how);
  for (const k of Object.keys(before)) if (k !== SHEET.journal) assert.deepEqual(w.book[k], before[k], `${how}: аркуш «${k}» не змінено`);
  assert.deepEqual(w.calls, [["appendRows", SHEET.journal]], how + ": жодного запису даних; лише службова подія в «Журналі»");
}

test("FZ конвеєр, реальний XML → parser → план: лише <vendor> обох фідів, лише <model> операційного при старому повному, лише <vendor> / <vendorCode> / <categoryId> повного при старому операційному — ABORTED з очікуваного і зі збереженого стану", async () => {
  const same = (x) => x;
  for (const state of ["очікуваний", "збережений"]) {
    for (const [what, op, full] of [
      ["<vendor> обох фідів", (x, sid) => withTag(x, sid, "vendor", "Other"), (x, sid) => withTag(x, sid, "vendor", "Other")],
      ["<model> лише операційного фіду", (x, sid) => withTag(x, sid, "model", "TS-2"), same],
      ["<vendor> лише повного фіду", same, (x, sid) => withTag(x, sid, "vendor", "Other")],
      ["<vendorCode> лише повного фіду", same, (x, sid) => withTag(x, sid, "vendorCode", "ZZ-9")],
      ["<categoryId> постачальника лише повного фіду", same, (x, sid) => withTag(x, sid, "categoryId", "2")],
    ]) {
      const how = `${what} (${state} стан)`;
      const w = await fzWorld();
      const e = fzCatalog(w);
      if (state === "збережений") {
        const r0 = await syncFz(w, e.cat);
        assert.equal(r0.state, "SYNCED", how + ": " + JSON.stringify(r0).slice(0, 300));
        w.calls.length = 0;
      }
      const opXml = op(w.xml, w.sid), fullXml = full(w.xml, w.sid);
      assert.ok(opXml !== w.xml || fullXml !== w.xml, how + ": передумова — XML змінено");
      w.fetchFull = async (x) => extractFullOffers(fullXml, x);
      const before = structuredClone(w.book);
      const r = await syncFz(w, e.cat, await parseXml(opXml));
      assertFzAborted(w, r, before, how);
      assert.match(r.reason, new RegExp(`${w.it.id}: ДЖЕРЕЛО`), how + ": блокер саме від зміни джерела");
      e.rm();
    }
  }
});

test("FZ конвеєр, масовий запобіжник характеристик: перевищення порога за активного FZ — ABORTED, без обходу через refreshAll(null); FZ рахується в статистиці; у стані A — як раніше", async () => {
  const tight = structuredClone(baseConfig);
  tight.characteristics = { ...(tight.characteristics || {}), maxChangedRows: 0 }; // поріг лише в тесті: FZ-застосування = 1 > 0
  const w = await fzWorld();
  const e = fzCatalog(w);
  const before = structuredClone(w.book);
  const r = await syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed: w.parsed, fetchFull: w.fetchFull, stamp: WSTAMP, config: tight, now: NOW, catalog: e.cat });
  assertFzAborted(w, r, before, "масова зміна за активного FZ");
  assert.match(r.reason, /МАСОВ/);
  assert.ok(r.block.affected >= 1 && r.block.limit === 0, JSON.stringify(r.block));
  e.rm();
  const wa = await fzWorld();
  const a = fzCatalog(wa, { active: false });
  const ra = await syncSheet({ sheets: wa.sheets, readBook: wa.readBook, parsed: wa.parsed, fetchFull: wa.fetchFull, stamp: WSTAMP, config: tight, now: NOW, catalog: a.cat });
  assert.equal(ra.state, "SYNCED", "стан A — чинна поведінка масового запобіжника: " + JSON.stringify(ra).slice(0, 300));
  a.rm();
});

test("FZ конвеєр, прив'язка до FZ-товару («ПРИВ'ЯЗАТИ ДО … (ПІДТВЕРДЖУЮ)», стара позиція зникла з фіду) — ABORTED: картка, змінена прив'язкою, не проходить зі старим FZ-набором", async () => {
  const w = await fzWorld();
  const e = fzCatalog(w);
  // Нова позиція фіду (немає ні в основному каталозі, ні в черзі) — у чергу як рядок кандидата з рішенням власника.
  const known = new Set(readSheet(w.book[SHEET.main], SHEET.main).rows.flatMap((r) => [mtText(r["ID постачальника"]), mtText(r["Offer ID"])]));
  const fresh = [...w.parsed.offers.values()].find((o) => !known.has(o.id) && mtText(o.sku));
  assert.ok(fresh, "передумова: у фіді є нова позиція з артикулом");
  const q = w.book[SHEET.queue], cand = candidateRow(fresh, extractFullOffers(w.xml, [fresh.id]).get(fresh.id), WSTAMP, config.pricing);
  cand["Рішення"] = `ПРИВ'ЯЗАТИ ДО ${w.it.id} (ПІДТВЕРДЖУЮ)`;
  q.push(q[0].map((k) => cand[mtText(k)] ?? ""));
  const offers = new Map(w.parsed.offers);
  offers.delete(w.sid);
  const before = structuredClone(w.book);
  const r = await syncFz(w, e.cat, { ...w.parsed, offers });
  assertFzAborted(w, r, before, "прив'язка до FZ-товару");
  assert.match(r.reason, new RegExp(`${w.it.id}: змінено прив'язкою`), "блокер саме від прив'язки цього запуску");
  e.rm();
});

test("FZ конвеєр, скасування прив'язки FZ-товару («СКАСУВАТИ» в «Історії прив'язок») — ABORTED: ідентичність, змінена скасуванням, не проходить через пропуск рядка в refreshAll", async () => {
  const w = await fzWorld();
  const e = fzCatalog(w);
  const v = Object.fromEntries(BINDINGS_HEADERS.map((k) => [k, ""]));
  Object.assign(v, {
    "Дата": WSTAMP, "Offer ID": w.it.id, "Старий ID постачальника": "2999999991", "Новий ID постачальника": w.sid,
    "Старий артикул": "OLD-FZ-1", "Новий артикул": mtText(w.row["Артикул постачальника"]), "Старий Код товару Prom": "OLD-FZ-1", "Новий Код товару Prom": mtText(w.row["Код товару Prom"]),
    "Стара назва постачальника UA": "Стара позиція", "Стара назва постачальника RU": "Старая позиция", "Старий URL постачальника": "https://example.com/old.html",
    "Підстава": "тест", "Стан": "АКТИВНА", "Рішення": "СКАСУВАТИ",
  });
  w.book[BINDINGS_SHEET] = [BINDINGS_HEADERS.slice(), BINDINGS_HEADERS.map((k) => v[k])];
  const before = structuredClone(w.book);
  const r = await syncFz(w, e.cat);
  assertFzAborted(w, r, before, "скасування прив'язки FZ-товару");
  assert.match(r.reason, new RegExp(`${w.it.id}: змінено прив'язкою`), "блокер саме від скасування цього запуску");
  e.rm();
});
