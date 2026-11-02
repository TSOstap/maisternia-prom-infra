/** ENG-18: регресії до попереднього ревю Hermes ENG-16 + R7 (preliminary-20261030T025531): ENG16-N1 (G3 / повний productionConfig),
 *  ENG16-N2 (допуск W2 для merge / refresh), ENG16-OPEN-I06 (intake лише через сесію шлюзу). Без модуля CC; композиція —
 *  cc-r71-compose.test.mjs. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ccConfigOf, ENGINEERING_CONTROLS_KEYS, productionConfig } from "../src/pipeline/production.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { mergeNew92 } from "../src/pipeline/sheet-sync-run.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { intakeAll, EMPTY_CATALOG } from "./helpers/intake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-10-22T10:00:00Z"), STAMP = new Date(NOW).toISOString();
const OK_CC = { state: async () => ({ held: new Set(), removed: new Set(), blocked: false, reasons: [], fingerprint: "fp", gate: { check: () => ({ blocked: false, kind: "NONE" }) } }), verify: async () => ({ ok: true }) };

test("ENG16-N1 / G3: до CC іде конфіг без ключів Engineering (лише required); інші ключі — як є (строга перевірка CC не вимкнена)", () => {
  assert.deepEqual(ENGINEERING_CONTROLS_KEYS, ["required"]);
  const cfg = productionConfig(structuredClone(baseConfig));
  assert.equal(cfg.controls.required, true, "допуск fail-closed Engineering лишився");
  const cc = ccConfigOf(cfg);
  assert.equal("required" in cc.controls, false);
  assert.equal(cfg.controls.required, true, "вхідний конфіг не змінено");
  const other = ccConfigOf({ ...cfg, controls: { required: true, maxCommands: 7, bogus: 1 } });
  assert.deepEqual(other.controls, { maxCommands: 7, bogus: 1 }, "невідомий / ліміт — до CC без фільтрації");
  assert.equal(other.pricing, cfg.pricing);
});

async function queueWorld() {
  const s = generateSynthetic({ products: 20, queue: 0, deferred: 0, newOffers: 3, seed: 29, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const w = { s, sheets, readBook: async () => sheets.read(), xml: s.supplierXml() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: STAMP });
  return w;
}
test("ENG16-OPEN-I06: intake у робочому режимі без сесії шлюзу — ABORTED, жодного запису (черга, «Журнал»); через сесію — INTAKE_DONE, операції в журналі W2", async () => {
  const cfg = productionConfig(structuredClone(baseConfig));
  const w = await queueWorld();
  const q0 = structuredClone(w.sheets.book[SHEET.queue]), j0 = structuredClone(w.sheets.book[SHEET.journal]), writes0 = w.sheets.metrics.writes;
  const r = await intakeAll(w, w.xml, { stamp: STAMP, now: NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session: null });
  assert.equal(r.state, "ABORTED");
  assert.match(r.reason, /лише через сесію шлюзу запису W2/);
  assert.deepEqual(w.sheets.book[SHEET.queue], q0);
  assert.deepEqual(w.sheets.book[SHEET.journal], j0);
  assert.equal(w.sheets.metrics.writes, writes0, "0 записів");
  const w2 = new MemoryStore();
  const session = await new WriteGateway({ sheets: w.sheets, read: w.readBook, store: w2 }).open({ writer: "intake" });
  const ok = await intakeAll(w, w.xml, { stamp: STAMP, now: NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session });
  await session.close();
  assert.equal(ok.state, "INTAKE_DONE", JSON.stringify(ok).slice(0, 300));
  assert.equal(ok.viaGateway, true);
  assert.ok(w.sheets.book[SHEET.queue].length > q0.length, "новинки додано");
  const ops = (await w2.getJsonVersioned("state/write-journal/sheets-main.json")).value?.entries || [];
  const intakeOps = ops.filter((e) => e.scope === "intake" && e.phase === "VERIFIED");
  assert.ok(intakeOps.length >= 2, "записи черги й «Журналу» — операції шлюзу (INTENT → VERIFIED), а не сирі: " + JSON.stringify(ops.map((e) => [e.scope, e.phase, e.op])).slice(0, 300));
  // Сесія не READY (невідомий результат попереднього запису / потрібне рішення людини) — BLOCKED, 0 записів.
  const w3 = await queueWorld(), q3 = structuredClone(w3.sheets.book[SHEET.queue]), writes3 = w3.sheets.metrics.writes;
  const stuck = { state: "NEEDS_DECISION", sheets: w3.sheets };
  const b = await intakeAll(w3, w3.xml, { stamp: STAMP, now: NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session: stuck });
  assert.equal(b.state, "BLOCKED");
  assert.match(b.reason, /NEEDS_DECISION/);
  assert.deepEqual(w3.sheets.book[SHEET.queue], q3);
  assert.equal(w3.sheets.metrics.writes, writes3);
});

test("ENG16-OPEN-I06 / ENG-22 (F05): невдала перевірка дописування intake за ключем — INCOMPLETE без ack; позиційного «відновлення» (перезапис / очищення / видалення рядків черги) немає", async () => {
  const cfg = productionConfig(structuredClone(baseConfig));
  const w = await queueWorld();
  const q0 = structuredClone(w.sheets.book[SHEET.queue]);
  const kc = q0[0].indexOf("Offer ID"), keys0 = q0.slice(1).map((row) => String(row[kc]));
  // Перевірка після дописування (свіже читання шлюзу за ключем) не бачить доданих рядків → дописування не підтверджено.
  let appended = false, deletes = 0;
  const rawAppend = w.sheets.appendRows.bind(w.sheets), rawDelete = w.sheets.deleteRows.bind(w.sheets);
  w.sheets.appendRows = async (title, rows) => { const r = await rawAppend(title, rows); if (title === SHEET.queue) appended = true; return r; };
  w.sheets.deleteRows = async (...a) => { deletes++; return rawDelete(...a); };
  const lying = async (names) => { const b = await w.readBook(names); if (appended && names.length === 1 && names[0] === SHEET.queue) b[SHEET.queue] = b[SHEET.queue].slice(0, q0.length); return b; };
  const session = await new WriteGateway({ sheets: w.sheets, read: lying, store: new MemoryStore() }).open({ writer: "intake" });
  let r;
  try { r = await intakeAll(w, w.xml, { stamp: STAMP, now: NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session, readBook: lying }); }
  finally { await session.close(); w.sheets.appendRows = rawAppend; w.sheets.deleteRows = rawDelete; }
  assert.ok(appended, "передумова: intake дописував новинки");
  assert.equal(r.state, "INCOMPLETE", JSON.stringify(r).slice(0, 300));
  assert.equal(r.ack, undefined, "ack для Worker не надсилається");
  assert.equal(r.restore, undefined, "позиційного відновлення немає");
  assert.equal(deletes, 0, "жодного видалення рядків");
  const q1 = w.sheets.book[SHEET.queue];
  assert.deepEqual(q1.slice(1, q0.length).map((row) => String(row[kc])), keys0, "наявні рядки черги — на своїх місцях");
  assert.ok(q1.slice(1).every((row) => row.some((v) => v !== "" && v != null)), "жодного очищеного рядка");
});

const runTool = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, "tools", "sheet-sync.mjs"), ...args], {
  encoding: "utf8", timeout: 60_000,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MM_TEST_SHEET_ID: "TEST_SHEET_ID_FIXTURE_000000", GOOGLE_OAUTH_ACCESS_TOKEN: "fixture-token-not-used", ...env },
});
test("ENG16-N2: КОЖЕН режим запису через API (зокрема merge / refresh) — лише з допуском W2; merge / refresh — ще й з явним --maintenance; відмова до доступу до таблиці", async () => {
  const tool = fs.readFileSync(path.join(ROOT, "tools", "sheet-sync.mjs"), "utf8");
  const modes = JSON.parse(/const WRITE_MODES = (\[[^;]+\]);/.exec(tool)[1]);
  for (const m of ["sync", "intake", "scenario", "scenario-mass", "controls", "archive", "merge", "refresh"]) assert.ok(modes.includes(m), m);
  for (const m of ["merge", "refresh", "intake", "sync"]) {
    const r = runTool(["--source=api", "--mode=" + m]);
    assert.equal(r.status, 2, m + ": " + r.stderr);
    assert.match(r.stderr, /НЕМАЄ КООРДИНАТОРА ЗАПИСУ \(W2\)/, m);
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-n2-"));
  for (const m of ["merge", "refresh"]) {
    const r = runTool(["--source=api", "--mode=" + m], { MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: dir });
    assert.equal(r.status, 2, m + ": " + r.stderr);
    assert.match(r.stderr, /ОБСЛУГОВУВАННЯ: .*--maintenance/, m);
  }
  const gh = runTool(["--source=api", "--mode=merge", "--maintenance"], { MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: dir, GITHUB_ACTIONS: "true" });
  assert.equal(gh.status, 2);
  assert.match(gh.stderr, /GitHub Actions/);
  assert.deepEqual(await fsp.readdir(dir), [], "до відмови нічого не записано навіть у сховище W2");
});

test("ENG18-N2: інвентар маршрутів запису tools/sheet-sync — подія блокування фіду, intake, sync — лише через сесію шлюзу; merge / refresh — під орендою обслуговування; сирих записів у таблицю немає", () => {
  const tool = fs.readFileSync(path.join(ROOT, "tools", "sheet-sync.mjs"), "utf8");
  assert.doesNotMatch(tool, /recordBlocked\(sheets/, "подія блокування — не сирим записом");
  assert.equal((tool.match(/await recordBlockedW2\(stamp, block\)/g) || []).length, 2, "обидві події (розбір / перевірка фіду) — через шлюз");
  assert.match(tool, /open\(\{ writer: "feed-block" \}\)[\s\S]*recordBlocked\(session\.sheets, stamp, block\)/);
  assert.match(tool, /async function underMaintenanceLease\(fn\) \{\r?\n\s+const lease = await new WriteGateway\(\{ sheets, read: readBook, store: w2Store \}\)\.committer\.acquire\("maintenance"\);\r?\n\s+try \{ return await fn\(\); \} finally \{ await lease\.release\(\)/, "оренда обслуговування — до операції, звільнення — після");
  // ENG-28: merge — B6-сумісне перенесення (transferNew92) через сесію шлюзу (оренда + журнал + fencing), без видалень рядків черги.
  assert.doesNotMatch(tool, /mergeNew92\(/, "старий mergeNew92 (видаляв рядки черги) з робочої точки прибрано");
  assert.match(tool, /transferNew92\(\{[^}]*\bsession\b[^}]*\}\)/);
  assert.match(tool, /underMaintenanceLease\(\(\) => refreshCopyFromLive\(/);
  // ENG-28b: «Оновити товари» — updateProductsRun з openSession (сесія «sync», потім окрема «intake») — теж лише через шлюз W2.
  for (const call of tool.match(/(intakeSheet|syncSheet|updateProducts|updateProductsRun|transferNew92)\(\{[^}]*\}\)/g) || []) assert.match(call, /\bsession\b|\bopenSession\b/, call.slice(0, 80));
  assert.equal((tool.match(/(updateProductsRun|transferNew92)\(\{[^}]*\}\)/g) || []).length, 2, "ENG-28: «Оновити товари» і перенесення — обидва через сесію");
  assert.match(tool, /const openSession = \(writer\) => new WriteGateway\(\{ sheets, read: readBook, store: w2Store \}\)\.open\(\{ writer \}\);/);
  assert.doesNotMatch(tool, /sheets\.(updateRanges|appendRows|deleteRows|setPercentFormat|ensureSheet|ensureColumns)\(/, "прямих викликів запису в таблицю немає");
});
test("ENG18-N2: подія «ОНОВЛЕННЯ ЗАБЛОКОВАНО» через сесію шлюзу — записана й є в журналі операцій W2; оренду тримає інший записувач — не записано, без винятку", async () => {
  const { recordBlocked, feedBlock } = await import("../src/pipeline/sheet-sync-run.mjs");
  const w = await queueWorld();
  const j0 = w.sheets.book[SHEET.journal].length;
  const store = new MemoryStore();
  const gw = new WriteGateway({ sheets: w.sheets, read: w.readBook, store });
  const s = await gw.open({ writer: "feed-block" });
  const r = await recordBlocked(s.sheets, STAMP, feedBlock("Неповний фід: 10 < 100", { count: 10, minimum: 100 }));
  await s.close();
  assert.equal(r.journalWritten, true);
  assert.equal(w.sheets.book[SHEET.journal].length, j0 + 1);
  assert.match(String(w.sheets.book[SHEET.journal].at(-1)[3]), /ОНОВЛЕННЯ ЗАБЛОКОВАНО/);
  assert.ok([...store.map.keys()].length > 0, "операцію записано в журнал W2");
  const held = await gw.committer.acquire("sync"); // інший записувач тримає оренду
  let busy = null;
  try { await new WriteGateway({ sheets: w.sheets, read: w.readBook, store }).open({ writer: "feed-block" }); } catch (e) { busy = e; }
  await held.release();
  assert.ok(busy, "сесію не відкрито, поки оренду тримає інший записувач");
  assert.equal(w.sheets.book[SHEET.journal].length, j0 + 1, "нічого не дописано");
});

test("ENG17-P3 (Hermes, read-TOCTOU): об'єкт змінено між читаннями — перевіряються й використовуються ТІ САМІ байти; підміна після перевірки не дає absent / DONE", async () => {
  const { generateSynthetic: gen } = await import("../src/synth/generator.mjs");
  const { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } = await import("../src/pipeline/sources.mjs");
  const { LocalObjectStore } = await import("../src/storage/local.mjs");
  const { runUpdate } = await import("../src/pipeline/update.mjs");
  const { manifestKey, readActiveXml, readVerifiedXml, readServedVersions } = await import("../src/publish/publisher.mjs");
  const { offersById } = await import("../src/core/yml.mjs");
  const { activeXmlsOf } = await import("../src/pipeline/production.mjs");
  const { publicationFrom } = await import("../src/pipeline/controls-adapter.mjs");
  const { createCommitter } = await import("../src/pipeline/safe-write/committer.mjs");
  const { Readable } = await import("node:stream");
  const T0 = Date.parse("2026-10-21T06:00:00.000Z");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-p3t-"));
  const s = gen({ products: 40, queue: 2, deferred: 2, newOffers: 0, seed: 7, now: T0 });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  await fsp.writeFile(path.join(dir, "supplier.xml"), s.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = productionConfig(structuredClone(baseConfig));
  config.supplier.minimumOffers = 10;
  const NONE = { blocked: false, kind: "NONE" };
  const controls = { state: async () => ({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp", gate: { check: () => NONE } }), verify: async () => ({ ok: true, reasons: [] }) };
  const r = await runUpdate({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(path.join(dir, "supplier.xml")), now: () => T0, tmpDir: dir, controls, coordinator: createCommitter({ store: new MemoryStore() }) });
  assert.equal(r.feeds[0].state, "PUBLISHED");
  const id = [...offersById((await readActiveXml(store, "main")).xml).keys()][0];
  const m = await store.getJson(manifestKey("main"));
  // Ін'єкція: перше читання вмісту — справжній об'єкт; кожне наступне — «<broken>» (як у пробі Hermes: stream A / stream B).
  const raw = store.getStream.bind(store);
  let reads = 0;
  store.getStream = async (k) => (k === m.active.key && reads++ > 0 ? Readable.from([Buffer.from("<broken>")]) : raw(k));
  const xml = await readVerifiedXml(store, m.active);
  assert.equal(reads, 1, "вміст прочитано рівно один раз");
  assert.ok(offersById(xml).has(id), "повернено саме перевірений текст");
  reads = 0;
  const pub = Object.fromEntries([...publicationFrom(await activeXmlsOf(store, config)(), [id])].map(([k, v]) => [k, v.feed]));
  assert.notEqual(pub[id], "absent", "підміна після перевірки не перетворюється на доказ відсутності");
  // Обернена підміна: перше читання — «<broken>» → перевірка не пройдена → null (unknown), а не текст другого читання.
  reads = 0;
  store.getStream = async (k) => (k === m.active.key && reads++ === 0 ? Readable.from([Buffer.from("<broken>")]) : raw(k));
  assert.equal(await readVerifiedXml(store, m.active), null);
  reads = 0;
  assert.equal(await readServedVersions(store, "main"), null, "обслуговувана версія не доведена");
  store.getStream = raw;
});

test("ENG17-P4 (Hermes, late delete): видалення CC між першим читанням стану й операційним коммітом — комміт НЕ відбувається (verify під орендою W2); наступний запуск заморожує видалений", async () => {
  const { generateSynthetic: gen } = await import("../src/synth/generator.mjs");
  const { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } = await import("../src/pipeline/sources.mjs");
  const { LocalObjectStore } = await import("../src/storage/local.mjs");
  const { runUpdate } = await import("../src/pipeline/update.mjs");
  const { readActiveXml } = await import("../src/publish/publisher.mjs");
  const { offersById } = await import("../src/core/yml.mjs");
  const { createCommitter } = await import("../src/pipeline/safe-write/committer.mjs");
  const T0 = Date.parse("2026-10-21T06:00:00.000Z");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-p4l-"));
  const s = gen({ products: 40, queue: 2, deferred: 2, newOffers: 0, seed: 7, now: T0 });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  const supplierFile = path.join(dir, "supplier.xml");
  await fsp.writeFile(supplierFile, s.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = productionConfig(structuredClone(baseConfig));
  config.supplier.minimumOffers = 10;
  const coordinator = createCommitter({ store: new MemoryStore() });
  const NONE = { blocked: false, kind: "NONE" };
  /** Двійник CC: після `flipAfter` читань стану — видалення del зафіксовано (новий відбиток); verify — проти поточного стану. */
  const twin = (del, flipAfter = Infinity) => {
    let reads = 0;
    const cur = () => (reads >= flipAfter ? [del] : []);
    const st = () => { const removed = cur(); return { held: new Set(removed), removed: new Set(removed), tombstoned: new Map(removed.map((id) => [id, { stage: "REGISTERED" }])), blocked: false, reasons: [], fingerprint: "fp:" + removed.join(","), gate: { check: () => NONE } }; };
    return { state: async () => { const s = st(); reads++; return s; }, verify: async (fp) => ({ ok: fp === st().fingerprint, reasons: fp === st().fingerprint ? [] : ["відбиток змінився"] }) };
  };
  const ctx = (controls, now) => ({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(supplierFile), now: () => now, tmpDir: dir, coordinator, controls });
  assert.equal((await runUpdate(ctx(twin("-"), T0))).sync.state, "OK");
  const op0 = await store.getJson("state/operational.json");
  const [del, other] = Object.keys(op0.rows).slice(3, 5);
  const supplierIdOf = (id) => String(s.sheets["Основний каталог"].find((r) => String(r[0]) === id)[1]);
  let xml = s.supplierXml();
  for (const id of [del, other]) xml = xml.replace(new RegExp(`(<offer id="${supplierIdOf(id)}"[\\s\\S]*?<price>)([^<]+)(</price>)`), (_, a, p, b) => a + String(Number(p) + 17) + b);
  await fsp.writeFile(supplierFile, xml);
  // Перше читання стану (план синхронізації) — без видалення; далі CC уже зафіксував видалення del.
  const r = await runUpdate(ctx(twin(del, 1), T0 + 3600_000));
  assert.equal(r.sync.state, "ERROR", JSON.stringify(r.sync));
  assert.match(r.sync.error, /змінився під час синхронізації/);
  const noFence = ({ fence: _f, ...rest } = {}) => rest; // ENG-22 (F03): штамп fencing змінює кожне отримання оренди — не дані
  assert.deepEqual(noFence(await store.getJson("state/operational.json")), noFence(op0), "операційний стан не записано — ціна видаленого не оновлена");
  assert.equal(offersById((await readActiveXml(store, "main")).xml).has(del), false, "захист активної версії — на свіжий стан CC");
  // Наступний запуск зі стабільним станом: видалений заморожено, інший оновлено.
  const r2 = await runUpdate(ctx(twin(del, 0), T0 + 7200_000));
  assert.equal(r2.sync.state, "OK");
  assert.equal(r2.sync.removedFrozen, 1);
  const op2 = (await store.getJson("state/operational.json")).rows;
  assert.deepEqual(op2[del], op0.rows[del]);
  assert.notDeepEqual(op2[other], op0.rows[other]);
  // Оренда W2 зайнята в момент комміту — операційний стан теж не записується.
  const busy = await coordinator.acquire("catalog-controls");
  await fsp.writeFile(supplierFile, xml.replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 1) + b));
  const r3 = await runUpdate(ctx(twin(del, 0), T0 + 10800_000));
  await busy.release();
  assert.equal(r3.sync.state, "ERROR");
  assert.match(r3.sync.error, /комміт синхронізації: оренду W2 не отримано/);
  assert.deepEqual((await store.getJson("state/operational.json")).rows, op2);
});

const runCli = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, "src", "cli.mjs"), ...args], {
  encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
});
test("ENG18-N1: cli update / rollback — лише з допуском W2 і --cc-store = MM_SAFE_WRITE_DIR (один координатор на хості); відмова — код 1, до будь-якого запису", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-n1cli-"));
  const store = path.join(dir, "store"), w2 = path.join(dir, "w2"), other = path.join(dir, "other");
  const W2 = { MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: w2 };
  const cases = [
    ["update без режиму W2", ["update", `--store=${store}`, `--cc-store=${w2}`], {}, /MM_W2_MODE=single-host/],
    ["update у GitHub Actions", ["update", `--store=${store}`, `--cc-store=${w2}`], { ...W2, GITHUB_ACTIONS: "true" }, /GitHub Actions/],
    ["update без --cc-store", ["update", `--store=${store}`], W2, /не вказано --cc-store/],
    ["update з іншим сховищем CC", ["update", `--store=${store}`, `--cc-store=${other}`], W2, /--cc-store має бути сховищем W2/],
    ["rollback з іншим сховищем CC", ["rollback", `--store=${store}`, `--cc-store=${other}`], W2, /--cc-store має бути сховищем W2/],
  ];
  for (const [name, args, env, re] of cases) {
    const r = runCli(args, env);
    assert.equal(r.status, 1, name + ": " + r.stdout + r.stderr);
    assert.match(r.stderr, /НЕМАЄ КООРДИНАТОРА ЗАПИСУ \(W2\)/, name);
    assert.match(r.stderr, re, name);
  }
  assert.deepEqual(await fsp.readdir(dir), [], "жодного файлу: ні сховища фідів, ні W2");
  // Допуск пройдено (той самий шлях, інше написання) — далі звичайна перевірка параметрів, не W2.
  const ok = runCli(["update", `--store=${store}`, `--cc-store=${w2}${path.sep}`], W2);
  assert.doesNotMatch(ok.stderr, /W2/, ok.stderr);
  assert.match(ok.stderr, /Потрібен параметр --catalog/);
  // status / approve — не під допуском W2 (status лише читає; approve — див. відкриті пункти).
  assert.doesNotMatch(runCli(["status", `--store=${store}`]).stderr, /W2/);
});
