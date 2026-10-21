/** Етап C2-C: shadow-звірка з фідом постачальника — модульні тести й наскрізний CLI на синтетиці (без мережі). */
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findLastSync, timeMode, compareWithSheet, perturb } from "../src/verify/supplier-shadow.mjs";
import { planRows, readSheet, LIVE_COLUMNS } from "../src/core/sync-plan.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { approvalManifest, GROUP_HEADERS, YML_HEADERS } from "../src/core/seal.mjs";
import { objectsFromValues } from "../src/core/yml.mjs";
import { formatYmlDate } from "../src/core/time.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const H = 3600000;
const sysRow = (at, feedDate, offers, mode = "ОНОВЛЕННЯ") => [at, "СИСТЕМА", "", "ЗАВЕРШЕНО", "", offers, JSON.stringify({ mode, feedDate, offers, sheets: [], changes: 3 })];

test("журнал: останній успішний mtUpdate; рядки YML і preview пропускаються; помилка після успіху позначається", () => {
  const j = [
    ["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"],
    sysRow("2026-10-21T05:20:00.000Z", "2026-10-21 08:20", 5220),
    ["2026-10-21T05:22:00.000Z", "YML", "", "СФОРМОВАНО", "", "", "…"],
    sysRow("2026-10-21T09:20:48.911Z", "2026-10-21 12:20", 5223),
    ["2026-10-21T09:21:00.000Z", "Основний каталог", "1", "Ціна", 1, 2, "ЗІСТАВЛЕНО"],
    sysRow("2026-10-21T09:30:00.000Z", "", 0, "ПЕРЕВІРКА_БЕЗ_ЗАПИСУ"),
    ["2026-10-21T13:20:00.000Z", "СИСТЕМА", "", "ПОМИЛКА", "", "", "Неповний YML"],
  ];
  const s = findLastSync(j);
  assert.equal(s.at, "2026-10-21T09:20:48.911Z");
  assert.equal(s.feedDate, "2026-10-21 12:20");
  assert.equal(s.offers, 5223);
  assert.equal(s.errorAfter.at, "2026-10-21T13:20:00.000Z");
  assert.equal(findLastSync([["h"]]), null);
});

test("режим часу: той самий знімок / новіший / старіший / невідомо (і неузгоджена мітка рядків)", () => {
  const lastSync = { at: "2026-10-21T09:20:48.911Z", feedDate: "2026-10-21 12:20" };
  assert.equal(timeMode({ feedDate: "2026-10-21 12:20", lastSync, rowsStamp: lastSync.at }).mode, "SAME_SNAPSHOT");
  const newer = timeMode({ feedDate: "2026-10-21 15:05", lastSync, rowsStamp: lastSync.at });
  assert.deepEqual([newer.mode, newer.minutesAfterSync], ["NEWER_FEED", 165]);
  assert.equal(timeMode({ feedDate: "2026-10-21 11:00", lastSync, rowsStamp: lastSync.at }).mode, "OLDER_FEED");
  assert.equal(timeMode({ feedDate: "2026-10-21 15:05", lastSync: null }).mode, "UNKNOWN");
  assert.equal(timeMode({ feedDate: "2026-10-21 15:05", lastSync, rowsStamp: "2026-10-20T21:20:00.000Z" }).mode, "UNKNOWN");
});

async function synthCase(o = {}) {
  const now = Date.now();
  const s = generateSynthetic({ products: 400, queue: 12, deferred: 4, newOffers: 5, seed: 51, now, ...o.synth });
  const rows = readSheet(s.sheets["Основний каталог"], "x").rows;
  const parsed = await parseSupplierText(s.supplierXml());
  return { s, rows, parsed, now };
}

test("класифікація NEWER_FEED: зміни постачальника — нормальні; неузгоджений рядок таблиці при тих самих даних — LOGIC_DIFF", async () => {
  const { rows, parsed } = await synthCase({ synth: { missingFromSupplier: [String(1500000000 + 3 * 7)], identityConflicts: [String(1500000000 + 5 * 7)] } });
  const stamp = new Date().toISOString();
  const plan = planRows(rows, parsed.offers, stamp);
  const r = compareWithSheet({ rows, plan, offers: parsed.offers, mode: "NEWER_FEED" });
  assert.equal(r.logicDiffs, 0);
  assert.equal(r.byClass.SUPPLIER_REMOVED, 1);
  assert.equal(r.byClass.STATUS_CHANGE, 1);
  assert.deepEqual(r.statusChanges, { "ЗІСТАВЛЕНО → ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ": 1, "ЗІСТАВЛЕНО → ВІДСУТНІЙ_У_YML": 1 });
  assert.ok(r.verifiedRows > 300 && r.comparableRows === rows.length);
  assert.ok(r.byClass.SUPPLIER_CHANGE > 10 && r.byClass.UNCHANGED > 200, JSON.stringify(r.byClass));
  // «Помилка логіки»: у таблиці Base не відповідає формулі, хоча постачальник нічого не змінив.
  const i = plan.findIndex((p, k) => p.match === "ЗІСТАВЛЕНО" && Number(rows[k]["Ціна постачальника"]) === parsed.offers.get(rows[k]["ID постачальника"]).price && (rows[k]["Наявність"] === "+") === parsed.offers.get(rows[k]["ID постачальника"]).available);
  const tampered = rows.map((x, k) => (k === i ? { ...x, "Ціна": x["Ціна"] + 1 } : x));
  const plan2 = planRows(tampered, parsed.offers, stamp);
  assert.equal(compareWithSheet({ rows: tampered, plan: plan2, offers: parsed.offers, mode: "NEWER_FEED" }).logicDiffs, 1);
  // Без синхронізованого знімка висновок неможливий — усе змінене стає UNCONFIRMED.
  const u = compareWithSheet({ rows, plan, offers: parsed.offers, mode: "UNKNOWN" });
  assert.equal(u.logicDiffs, 0);
  assert.ok(u.byClass.UNCONFIRMED > 10);
});

test("збурення XML працюють і на багаторядкових offer (реальний формат постачальника)", () => {
  const xml = '<yml_catalog date="x"><shop><offers>\n<offer id="11" available="true">\n<url>https://market-tools.com.ua/p11-a.html</url>\n<price>10</price>\n<currencyId>UAH</currencyId>\n<vendorCode>A</vendorCode>\n<name_ua>Н</name_ua>\n</offer>\n<offer id="22" available="false">\n<price>20</price>\n</offer>\n</offers></shop></yml_catalog>';
  assert.ok(!perturb.drop(xml, ["11"]).includes('id="11"'));
  const re = perturb.reissue(xml, new Map([["11", "99"]]));
  assert.ok(re.includes('id="99"') && re.includes("/p99-") && !re.includes('id="11"'));
  assert.ok(perturb.tag(xml, "22", "price", "0").includes("<price>0</price>"));
  assert.ok(perturb.tag(xml, "11", "price", "0").includes("<price>20</price>"), "інші offer не зачіпаються");
  const d = perturb.duplicate(xml, "22", "33");
  assert.ok(d.includes('id="22"') && d.includes('id="33"'));
});

async function cliSetup() {
  const now = Date.now();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-c2c-cli-"));
  const s = generateSynthetic({ products: 400, queue: 12, deferred: 4, newOffers: 5, seed: 61, now });
  const previousStamp = new Date(now - 4 * H).toISOString(); // = «Оновлено» у синтетичних рядках
  const journal = [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"], sysRow(previousStamp, formatYmlDate(now - 4 * H, "Europe/Kyiv"), s.offers.length)];
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: { ...s.sheets, "Журнал": journal, "Заморожені ID": [["Offer ID"], ["2900000013"]] }, groups: s.groups });
  await fsp.writeFile(path.join(dir, "supplier.xml"), s.supplierXml());
  const config = structuredClone(baseConfig);
  config.supplier.minimumOffers = 10;
  await fsp.writeFile(path.join(dir, "config.json"), JSON.stringify(config));
  const groups = objectsFromValues(s.groups, GROUP_HEADERS);
  const q = objectsFromValues(s.sheets["Нові товари"], YML_HEADERS);
  await fsp.writeFile(path.join(dir, "expected.json"), JSON.stringify({ main: s.manifestMain, new92: approvalManifest(q, groups) }));
  const run = (env = {}, extra = []) => spawnSync(process.execPath, [path.join(root, "tools", "supplier-shadow.mjs"), "--source=snapshot", `--catalog=${path.join(dir, "catalog")}`, `--supplier-file=${path.join(dir, "supplier.xml")}`, `--config=${path.join(dir, "config.json")}`, `--expected=${path.join(dir, "expected.json")}`, `--tmp=${dir}`, ...extra], { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
  return { s, dir, run };
}

test("CLI на синтетиці: усі перевірки PASS (паритет LIVE, класифікація, D1/D1b сценарії); у виводі немає секретів і Offer ID", async () => {
  const { s, run } = await cliSetup();
  const env = { MM_SHEET_ID: "FAKE_SHEET_ID_0123456789_abcdefghij", MM_SUPPLIER_FEED_URL: "https://market-tools.com.ua/feed.xml?hash_tag=FAKEHASHzzzzNOTREALzzzzTESTONLYzz&languages=uk%2Cru" };
  const r = run(env, ["--scenarios", "--summary=" + path.join(os.tmpdir(), `c2c-summary-${process.pid}.md`)]);
  assert.equal(r.status, 0, r.stderr + r.stdout.slice(0, 3000));
  const rep = JSON.parse(r.stdout);
  assert.deepEqual(rep.failed, []);
  assert.equal(rep.time.mode, "NEWER_FEED");
  assert.equal(rep.parity.planDiff, 0);
  assert.equal(rep.parity.offersDiff, 0);
  assert.equal(rep.compare.main.logicDiffs, 0);
  assert.equal(rep.universe.decisions.NEW, 4, "5 нових offers мінус 1 у «Заморожених ID»");
  assert.equal(rep.scenarios.S3_reissue5.relinked, 5);
  assert.equal(rep.scenarios.S6_mass.sync, "ERROR");
  assert.equal(rep.scenarios.S6_mass.anomaly, true, "має спрацювати саме поріг аномалії D1");
  for (const secret of [env.MM_SHEET_ID, "FAKEHASHzzzzNOTREALzzzzTESTONLYzz"]) assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
  const ids = s.sheets["Основний каталог"].slice(1).map((x) => String(x[0]));
  assert.ok(!ids.some((id) => r.stdout.includes(id)), "Offer ID не повинні потрапляти у вивід");
  const summary = await fsp.readFile(path.join(os.tmpdir(), `c2c-summary-${process.pid}.md`), "utf8");
  assert.match(summary, /PASS/);
});

test("захист від витоку: якщо фрагмент секрету опинився у звіті — нічого не виводиться, код 3", async () => {
  const { run } = await cliSetup();
  const r = run({ MM_SHEET_ID: "ЗІСТАВЛЕНО" }); // штучно: «секрет», що гарантовано є у звіті
  assert.equal(r.status, 3);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /ЗАХИСТ ВІД ВИТОКУ/);
});

test("без синхронізованого знімка (журнал без успішного mtUpdate) — висновок про логіку прямо позначено як неможливий", async () => {
  const { dir, run } = await cliSetup();
  await fsp.writeFile(path.join(dir, "catalog", "sheets", "Журнал.ndjson"), JSON.stringify(["Дата / час", "Аркуш"]) + "\n");
  const r = run();
  assert.equal(r.status, 4, "окремий код «висновок неможливий»");
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.time.mode, "UNKNOWN");
  assert.equal(rep.inconclusive, true);
  assert.ok(rep.failed.includes("порівняння з таблицею достовірне"));
  assert.equal(rep.parity.planDiff, 0, "паритет логіки на тому самому XML не залежить від часу");
});
