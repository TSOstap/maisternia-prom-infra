/** OV, R1 (HERMES-OV1-REVIEW-1): обов'язкова прив'язка файлу рішень власника до переліку в репозиторії.
 *  Перелік (owner-values-index.json) читається ЗАВЖДИ; з блоком required { rev, date, fingerprint, products, items } файл рішень
 *  обов'язковий незалежно від ENV. Не задано / немає / порожній / пошкоджений / інша ревізія / інший відбиток вмісту (stale значення
 *  того самого набору полів, напр. ПВ 30 % замість 40 %) / перелік ≠ файлу; відсутній / пошкоджений перелік; некоректний required —
 *  окремий блокер типу OV («РІШЕННЯ ВЛАСНИКА (OV)»), не FZ; конвеєр — ABORTED, лише службова подія в «Журналі» (ціни теж не пишуться).
 *  F1 (HERMES-OV1-REVIEW-1-FOLLOWUP): перелік формату v2 — required обов'язковий; видалення маркера / формат v1 без явного legacy /
 *  невідомий формат — той самий блокер OV; генератор переліку не пише некоректний required (перевірка — в ізольованій копії).
 *  Відбиток рахується тут незалежно (канонічний JSON) — це формат прив'язки, не копія коду. Товари й значення — синтетичні. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadPromCatalog } from "../src/pipeline/prom-schemas.mjs";
import * as SS from "../src/core/sheet-sync.mjs";
const { refreshMainRow, RAW_PARAMS, SHEET, extractFullOffers } = SS;
const OV_BLOCK = "РІШЕННЯ ВЛАСНИКА (OV)"; // формат «Журналу»; збіг з експортом коду перевіряється нижче
import { mtText } from "../src/core/text.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { mergeNew92, syncSheet } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import baseConfig from "../config/default.json" with { type: "json" };
import { STATE_A, OWNER_INDEX_A } from "./helpers/state-a.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { intakeAll } from "./helpers/intake.mjs";

const canon = (x) => (Array.isArray(x) ? `[${x.map(canon).join(",")}]` : x && typeof x === "object" ? `{${Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + canon(x[k])).join(",")}}` : JSON.stringify(x));
const fsha = (x) => "sha256:" + crypto.createHash("sha256").update(canon(x), "utf8").digest("hex");
const WELD = "14400101", S1 = "2026-10-28T10:00:00.000Z", S2 = "2026-10-28T11:00:00.000Z";
const P = (name, value, unit = "") => ({ name, value, unit });
const fmt = (p) => `${p.name}: ${p.value}${p.unit ? " " + p.unit : ""}`;
const params = (r) => JSON.parse(r["Характеристики JSON"] || "[]").map(fmt);
const item = (o) => ({ action: "set", source: "тест", date: "2026-10-28", priority: 1, autoUpdate: false, ...o });
const productsOf = (pv) => ({ "91": { model: "TS-1", title: "тест", items: [
  item({ name: "Тривалість навантаження", field: "14577", value: pv, unit: "%", replaces: ["Номинальный рабочий цикл (%)"], supplier: ["60 %"] }),
  item({ name: "Номінальний зварювальний струм", action: "drop", replaces: ["Номинальный сварочный ток"], supplier: ["200 А"] }),
] } });
const fileOf = (pv = "40", rev = 3) => ({ v: 1, ...(rev === null ? {} : { rev }), date: "2026-10-28", source: "тест", products: productsOf(pv) });
// Перелік: те, що пише tools/owner-values.mjs index — назви / поля / replaces (без значень) + required.
const indexProductsOf = (products) => Object.fromEntries(Object.entries(products).sort(([a], [b]) => a.localeCompare(b)).map(([id, p]) => [id, { model: p.model, items: p.items.map((o) => ({ name: o.name, ...(o.field ? { field: String(o.field) } : {}), ...(o.replaces?.length ? { replaces: o.replaces } : {}) })) }]));
const requiredOf = (file) => ({ rev: file.rev, date: file.date, fingerprint: fsha(file.products), products: Object.keys(file.products).length, items: Object.values(file.products).reduce((n, p) => n + p.items.length, 0) });
const indexOf = (file, o = {}) => ({ required: requiredOf(file), _note: "тест", v: 2, date: file.date, products: indexProductsOf(file.products), ...o });
const withoutRequired = (ix) => { const { required, ...rest } = ix; return rest; }; // F1: маркер вилучено (ключа немає), не null / false

/** Каталог стану A для FZ (прийнятий rev 4) з тимчасовими переліком і файлом рішень. null — файл не створюється; рядок — сирий вміст.
 *  Тимчасовий перелік — у робочому режимі (без legacy), як перелік репозиторію; legacy — лише явно. */
function env({ file = fileOf(), index, envSet = true, legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ov-bind-"));
  const w = (n, x) => { const f = path.join(dir, n); if (x !== null) fs.writeFileSync(f, typeof x === "string" ? x : JSON.stringify(x)); return f; };
  const ff = w("owner.json", file);
  const ix = w("index.json", index === undefined ? indexOf(fileOf()) : index);
  const cat = loadPromCatalog(undefined, { ...STATE_A, ownerValuesIndexFile: ix, ownerIndexLegacy: legacy, ownerValuesFile: envSet ? ff : "" });
  return { cat, rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const RAW = [P("Номинальный сварочный ток", "200", "А"), P("Номинальный рабочий цикл (%)", "60", "%")];
const row0 = () => ({ "Offer ID": "91", "ID постачальника": "91", "Категорія Prom ID": WELD, "Виробник": "Test", "Назва постачальника UA": "Зварювальний інвертор TS-1", "Назва постачальника RU": "", [RAW_PARAMS]: JSON.stringify(RAW), "Характеристики JSON": JSON.stringify([P("Тривалість навантаження", "60", "%"), P("Номінальний зварювальний струм", "200", "А")]) });
const offer = { id: "91", vendor: "Test", model: "TS-1", sku: "", nameUa: "Зварювальний інвертор TS-1", nameRu: "", price: 100, available: true, currency: "UAH" };
const full = { params: RAW, pictures: [], descriptionUa: "", descriptionRu: "" };
const run = (cat, r = row0(), stamp = S1) => refreshMainRow({ ...r }, offer, full, { stamp, catalog: cat });

test("OV R1: валідна прив'язка (ревізія + відбиток вмісту) — рішення застосовано (ПВ 40 %, 200 А не передається), повтор без змін; старий перелік без required і без файлу — як раніше", () => {
  const e = env();
  assert.equal(e.cat.guard.blocked, false, JSON.stringify(e.cat.guard));
  assert.deepEqual([e.cat.ownerRequired?.required, e.cat.ownerRequired?.valid, e.cat.ownerRequired?.rev], [true, true, 3]);
  const a = run(e.cat);
  assert.ok(params(a.row).includes("Тривалість навантаження: 40 %") && !params(a.row).some((x) => /200 А|60 %/.test(x)), JSON.stringify(params(a.row)));
  const again = run(e.cat, a.row, S2);
  assert.equal(again.params, false);
  assert.equal(again.row["Характеристики JSON"], a.row["Характеристики JSON"]);
  const legacy = loadPromCatalog(undefined, { ...STATE_A, ownerValuesFile: "" });
  assert.equal(legacy.guard.blocked, false, "старий перелік без required — обов'язковості немає");
  e.rm();
});

test("OV R1: stale файл рішень (той самий набір ID / назв / полів, ПВ 30 % замість 40 %) — блокер OV; ні від початкового, ні від уже виправленого рядка 40 % не відкочується до 30 %", () => {
  const good = env(), corrected = run(good.cat).row;
  assert.ok(params(corrected).includes("Тривалість навантаження: 40 %"));
  good.rm();
  const e = env({ file: fileOf("30") });
  assert.equal(e.cat.guard.blocked, true);
  assert.equal(e.cat.guard.type, "OV", "саме блокер рішень власника, не FZ");
  assert.ok(e.cat.guard.reasons.some((x) => /owner-values: required/.test(x) && /відбиток вмісту/.test(x)), JSON.stringify(e.cat.guard.reasons));
  for (const [what, r] of [["початковий рядок", row0()], ["уже виправлений рядок (40 %)", corrected]]) {
    const a = run(e.cat, r);
    assert.ok(a.frozenBlock && a.changed === false, what);
    assert.deepEqual(a.row, r, `${what}: рядок без змін`);
    assert.ok(!params(a.row).includes("Тривалість навантаження: 30 %"), what);
  }
  e.rm();
});

test("OV R1: обов'язковий файл рішень — не задано (ENV знято) / немає / порожній / пошкоджений JSON / без products / стара ревізія / без rev / перелік ≠ файлу — блокер OV з точною причиною", () => {
  const f = fileOf();
  for (const [what, o, why] of [
    ["ENV знято", { envSet: false }, /MM_OWNER_VALUES\) не задано/], ["файлу немає", { file: null }, /недійсний.*не знайдено/], ["порожній файл", { file: "" }, /недійсний.*некоректний JSON/],
    ["пошкоджений JSON", { file: "{ зламаний" }, /недійсний.*некоректний JSON/], ["без products", { file: { v: 1, rev: 3, date: "2026-10-28" } }, /недійсний.*products/],
    ["стара ревізія (2)", { file: fileOf("40", 2) }, /ревізія 2 ≠ обов'язковій 3/], ["без rev", { file: fileOf("40", null) }, /ревізія немає ≠ обов'язковій 3/],
    ["перелік ≠ файлу (інша назва при тому самому відбитку)", { index: indexOf(f, { products: { "91": { model: "TS-1", items: [{ name: "Робочий цикл", field: "14577" }, { name: "Номінальний зварювальний струм", replaces: ["Номинальный сварочный ток"] }] } } }) }, /перелік у репозиторії ≠ файлу/],
  ]) {
    const e = env(o);
    assert.equal(e.cat.guard.blocked, true, what);
    assert.equal(e.cat.guard.type, "OV", what);
    assert.ok(e.cat.guard.reasons.some((x) => why.test(x)), `${what}: ${JSON.stringify(e.cat.guard.reasons)}`);
    assert.ok(run(e.cat).frozenBlock, what + ": refreshMainRow — структурований блокер");
    e.rm();
  }
});

test("OV R1: перелік у репозиторії — відсутній / пошкоджений / без products / required присутній, але null / неповний — блокер OV незалежно від файлу рішень", () => {
  const f = fileOf();
  for (const [what, index, why] of [
    ["переліку немає", null, /відсутній/], ["пошкоджений JSON", "{ зламаний", /некоректний JSON/], ["без products", { v: 2, required: requiredOf(f) }, /немає products/],
    ["required: null", indexOf(f, { required: null }), /required присутній, але некоректний/], ["required без fingerprint", indexOf(f, { required: { ...requiredOf(f), fingerprint: undefined } }), /required присутній, але некоректний/],
  ]) {
    for (const envSet of [true, false]) {
      const e = env({ index, envSet });
      assert.equal(e.cat.guard.blocked, true, what);
      assert.equal(e.cat.guard.type, "OV", what);
      assert.ok(e.cat.guard.reasons.some((x) => why.test(x)), `${what}: ${JSON.stringify(e.cat.guard.reasons)}`);
      e.rm();
    }
  }
});

test("OV F1: видалення маркера required не повертає старий режим — v2 без required, v1 без явного legacy, без формату / невідомий формат, required: false — блокер OV; stale ПВ 30 % не застосовується", () => {
  const f = fileOf();
  const v1NoMarker = { ...withoutRequired(indexOf(f)), v: 1 }; // точний сценарій probe Hermes: перелік v1 rev 3 без required
  for (const [what, index, why] of [
    ["v2, маркер вилучено", withoutRequired(indexOf(f)), /формат v2 без обов'язкового required/],
    ["v1 без required, без явного legacy", v1NoMarker, /формат v1 без обов'язкової прив'язки/],
    ["v1 з required, без явного legacy", { ...indexOf(f), v: 1 }, /формат v1 без обов'язкової прив'язки/],
    ["формату немає", (({ v, ...x }) => x)(withoutRequired(indexOf(f))), /невідомий формат \(v null\)/],
    ["невідомий формат v 3", { ...indexOf(f), v: 3 }, /невідомий формат \(v 3\)/],
    ["required: false", indexOf(f, { required: false }), /required присутній, але некоректний/],
  ]) {
    for (const [fw, file] of [["валідний файл", fileOf()], ["stale ПВ 30 %", fileOf("30")]]) {
      for (const envSet of [true, false]) {
        const e = env({ index, file, envSet });
        const tag = `${what} / ${fw} / ENV ${envSet ? "так" : "ні"}`;
        assert.equal(e.cat.guard.blocked, true, tag);
        assert.equal(e.cat.guard.type, "OV", tag);
        assert.ok(e.cat.guard.reasons.some((x) => why.test(x)), `${tag}: ${JSON.stringify(e.cat.guard.reasons)}`);
        assert.equal(e.cat.ownerValues, null, tag + ": рішення не застосовуються");
        const a = run(e.cat);
        assert.ok(a.frozenBlock && a.changed === false, tag + ": refreshMainRow — структурований блокер");
        assert.ok(!params(a.row).includes("Тривалість навантаження: 30 %"), tag);
        e.rm();
      }
    }
  }
  // legacy — лише явно й лише для формату v1: прапорець не послаблює v2 без required.
  const lv = env({ index: withoutRequired(indexOf(f)), legacy: true });
  assert.equal(lv.cat.guard.blocked, true, "legacy не послаблює v2 без required");
  assert.ok(lv.cat.guard.reasons.some((x) => /формат v2 без обов'язкового required/.test(x)), JSON.stringify(lv.cat.guard.reasons));
  lv.rm();
  // Історична фікстура стану до OV (v1 без required): з явним legacy — як раніше; без нього — блокер.
  assert.equal(loadPromCatalog(undefined, { ...STATE_A, ownerValuesFile: "" }).guard.blocked, false, "явний legacy (STATE_A)");
  const noFlag = loadPromCatalog(undefined, { ...STATE_A, ownerIndexLegacy: false, ownerValuesFile: "" });
  assert.equal(noFlag.guard.type, "OV");
  assert.ok(noFlag.guard.reasons.some((x) => /формат v1 без обов'язкової прив'язки/.test(x)), JSON.stringify(noFlag.guard.reasons));
  const { ownerIndexLegacy, ...noKey } = STATE_A; // типове значення (ключа немає) — не legacy
  assert.equal(noKey.ownerValuesIndexFile, OWNER_INDEX_A);
  assert.equal(loadPromCatalog(undefined, { ...noKey, ownerValuesFile: "" }).guard.type, "OV", "типовий виклик без прапорця — блокер");
});

test("OV F1: генератор переліку (tools/owner-values.mjs index, ізольована копія) — rev < 1 / 0 / без rev / дробовий, 0 товарів або записів — required не записується, перелік не змінено; валідний файл — v2 з точним required", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ov-index-cli-"));
  for (const d of ["src", "tools", "config", path.join("schemas", "prom")]) fs.cpSync(path.join(repo, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(repo, "package.json"), path.join(dir, "package.json"));
  const idxFile = path.join(dir, "schemas", "prom", "owner-values-index.json");
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^MM_/.test(k)));
  const cli = (file) => { const f = path.join(dir, "owner-in.json"); fs.writeFileSync(f, JSON.stringify(file)); return spawnSync(process.execPath, ["tools/owner-values.mjs", "index", f], { cwd: dir, env: cleanEnv, encoding: "utf8" }); };
  const before = fs.readFileSync(idxFile);
  for (const [what, file] of [
    ["rev -1", { ...fileOf(), rev: -1 }], ["rev 0", { ...fileOf(), rev: 0 }], ["без rev", fileOf("40", null)], ["rev 1.5", { ...fileOf(), rev: 1.5 }],
    ["0 товарів", { ...fileOf(), products: {} }], ["товар без записів", { ...fileOf(), products: { "91": { model: "TS-1", title: "тест", items: [] } } }],
  ]) {
    const r = cli(file);
    assert.equal(r.status, 1, `${what}: ${r.stdout}${r.stderr}`);
    assert.ok(fs.readFileSync(idxFile).equals(before), `${what}: довірений перелік не перезаписано`);
  }
  const good = fileOf("40", 5), r = cli(good);
  assert.equal(r.status, 0, r.stderr);
  const ix = JSON.parse(fs.readFileSync(idxFile, "utf8"));
  assert.equal(ix.v, 2);
  assert.deepEqual(ix.required, requiredOf(good));
  const ok = loadPromCatalog(undefined, { ...STATE_A, ownerValuesIndexFile: idxFile, ownerIndexLegacy: false, ownerValuesFile: path.join(dir, "owner-in.json") });
  assert.equal(ok.guard.blocked, false, JSON.stringify(ok.guard));
  fs.rmSync(dir, { recursive: true, force: true });
});
// ---------- конвеєр: syncSheet / intake з таблицею в пам'яті ----------
const NOW = Date.parse("2026-10-22T10:00:00Z"), WSTAMP = new Date(NOW).toISOString();
const config = structuredClone(baseConfig);
const WRITES = ["updateRanges", "appendRows", "deleteRows", "ensureSheet", "ensureColumns", "setPercentFormat"];
async function world() {
  const s = generateSynthetic({ products: 40, queue: 4, deferred: 2, newOffers: 2, seed: 7, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"], [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const readBook = async () => structuredClone(book);
  await mergeNew92({ sheets, readBook, stamp: WSTAMP });
  const xml = s.supplierXml();
  const w = { book, sheets, readBook, xml, parsed: await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true }), calls: [] };
  for (const m of WRITES) { const f = sheets[m].bind(sheets); sheets[m] = async (...a) => { w.calls.push([m, typeof a[0] === "string" ? a[0] : (a[0] || []).map((x) => x.title).join(",")]); return f(...a); }; }
  return w;
}

test("OV R1 конвеєр: stale / відсутній обов'язковий файл рішень — syncSheet і intake ABORTED (тип OV) до будь-яких записів даних, ціни й наявність теж; валідна прив'язка — SYNCED", async () => {
  for (const [what, o] of [["stale ПВ 30 %", { file: fileOf("30") }], ["ENV знято", { envSet: false }]]) {
    const w = await world(), e = env(o);
    const before = structuredClone(w.book);
    const r = await syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed: w.parsed, fetchFull: async (x) => extractFullOffers(w.xml, x), stamp: WSTAMP, config, now: NOW, catalog: e.cat });
    assert.equal(r.state, "ABORTED", what + ": " + JSON.stringify(r).slice(0, 300));
    assert.equal(r.block?.type, OV_BLOCK, what);
    assert.equal(SS.OV_BLOCK, OV_BLOCK);
    for (const k of Object.keys(before)) if (k !== SHEET.journal) assert.deepEqual(w.book[k], before[k], `${what}: аркуш «${k}» не змінено (ціни / наявність теж)`);
    assert.deepEqual(w.calls, [["appendRows", SHEET.journal]], what + ": лише службова подія в «Журналі»");
    const added = w.book[SHEET.journal].slice(before[SHEET.journal].length);
    assert.deepEqual([added.length, added[0][3], added[0][4]], [1, "ОНОВЛЕННЯ ЗАБЛОКОВАНО", OV_BLOCK], what);
    w.calls.length = 0;
    const ri = await intakeAll(w, w.xml, { stamp: WSTAMP, now: NOW, config, catalog: e.cat });
    assert.equal(ri.state, "ABORTED", what + " intake");
    assert.equal(ri.block?.type, OV_BLOCK, what + " intake");
    assert.deepEqual(w.calls, [["appendRows", SHEET.journal]], what + " intake: лише «Журнал»");
    e.rm();
  }
  const w = await world(), ok = env();
  const r = await syncSheet({ sheets: w.sheets, readBook: w.readBook, parsed: w.parsed, fetchFull: async (x) => extractFullOffers(w.xml, x), stamp: WSTAMP, config, now: NOW, catalog: ok.cat });
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 300));
  ok.rm();
});
