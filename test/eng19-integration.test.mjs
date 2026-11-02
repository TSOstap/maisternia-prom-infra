/** ENG-19: регресії до попереднього ревю Hermes R7.1 / ENG-17 (components-20261030T124058, розд. 7 п. 4–5): допуск і оренда W2 для
 *  cli approve; еквівалентність мутації M16 ENG-18; intake через сесію після відновлення без видалень. Без модуля CC. */
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { productionConfig } from "../src/pipeline/production.mjs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { mergeNew92 } from "../src/pipeline/sheet-sync-run.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { FileStore, MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import { writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { intakeAll, readyFromXml, EMPTY_CATALOG } from "./helpers/intake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-10-22T10:00:00Z"), STAMP = new Date(NOW).toISOString();
const OK_CC = { state: async () => ({ held: new Set(), removed: new Set(), blocked: false, reasons: [], fingerprint: "fp", gate: { check: () => ({ blocked: false, kind: "NONE" }) } }), verify: async () => ({ ok: true }) };
const runCli = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, "src", "cli.mjs"), ...args], {
  encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
});

test("ENG19-A1 (Hermes «intake/approval»): cli approve — лише з допуском W2 і під орендою W2; відмова / оренда зайнята — паспорт не записано", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-e19-approve-"));
  const s = generateSynthetic({ products: 30, queue: 2, deferred: 1, newOffers: 0, seed: 11, now: NOW });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  const storeDir = path.join(dir, "store"), w2 = path.join(dir, "w2");
  const args = ["approve", `--store=${storeDir}`, `--catalog=${path.join(dir, "catalog")}`, "--by=тест"];
  const approved = () => new LocalObjectStore(storeDir).getJson("approved/main.json").catch(() => null);
  for (const [name, env, re] of [["без режиму W2", {}, /MM_W2_MODE=single-host/], ["GitHub Actions", { MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: w2, GITHUB_ACTIONS: "true" }, /GitHub Actions/], ["без сховища W2", { MM_W2_MODE: "single-host" }, /MM_SAFE_WRITE_DIR/]]) {
    const r = runCli(args, env);
    assert.equal(r.status, 1, name + ": " + r.stderr);
    assert.match(r.stderr, /НЕМАЄ КООРДИНАТОРА ЗАПИСУ \(W2\)/, name);
    assert.match(r.stderr, re, name);
  }
  assert.equal(await approved(), null, "до допуску — нічого не записано");
  // Оренду W2 тримає інший записувач (той самий ресурс, що й CC / sheet-sync / публікація) → відмова, паспорт не записано.
  const W2 = { MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: w2 };
  const busy = await createCommitter({ store: new FileStore(w2) }).acquire("sync");
  const r1 = runCli(args, W2);
  await busy.release();
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stderr, /BUSY|зайнят/);
  assert.equal(await approved(), null, "оренда зайнята — паспорт не записано");
  // Оренда вільна → паспорт записано.
  const r2 = runCli(args, W2);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const m = await approved();
  assert.ok(m && m.count > 0, JSON.stringify(m).slice(0, 200));
  // status — лише читання, без допуску W2.
  assert.equal(runCli(["status", `--store=${storeDir}`]).status, 0);
});

/** M16 (ENG-18, `noDelete` основного запису intake) — ЕКВІВАЛЕНТНА мутація: intake ніколи не пише менше рядків, ніж прочитав.
 *  (1) readSheet відхиляє порожній рядок усередині аркуша; (2) читання (Sheets API і MemorySheets) не повертає порожніх рядків у кінці;
 *  (3) planIntake: rows = [...усі прочитані рядки, ...новинки]. Тест нижче фіксує (1) і (2) — якщо їх змінять, аргумент еквівалентності
 *  перестане діяти й тест упаде. */
test("ENG19-M16 (запобіжник еквівалентності): порожній рядок усередині черги — відмова intake; порожні рядки в кінці аркуша не читаються", async () => {
  const { readSheet } = await import("../src/core/sync-plan.mjs");
  const q = generateSynthetic({ products: 10, queue: 3, deferred: 0, newOffers: 0, seed: 5, now: NOW }).sheets["Нові товари"];
  assert.equal(readSheet(q, SHEET.queue).rows.length, 3, "передумова: валідна черга читається");
  const blank = Array(q[0].length).fill("");
  assert.throws(() => readSheet([q[0], q[1], blank, q[2], q[3]], SHEET.queue), /Порожній рядок усередині/);
  const m = new MemorySheets({ [SHEET.queue]: [...q, blank, blank] });
  assert.deepEqual((await m.read([SHEET.queue]))[SHEET.queue], q);
});
test("ENG19-I1 / ENG-22 (F05): intake за ключем після непідтвердженого дописування — без позиційного видалення й очищення; наступний intake бачить рядок за ключем (без дубля), рядків не втрачено", async () => {
  const s = generateSynthetic({ products: 20, queue: 0, deferred: 0, newOffers: 3, seed: 29, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const w = { sheets, readBook: async () => sheets.read() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: STAMP });
  const cfg = productionConfig(structuredClone(baseConfig));
  const xml = s.supplierXml();
  const nonEmpty = () => sheets.book[SHEET.queue].filter((row, i) => i > 0 && row.some((v) => v !== "" && v != null)).map((row) => String(row[0]));
  // 0) Дві новинки — у чергу (успішно); третя — у кроці 1.
  const main = sheets.book[SHEET.main], sc = main[0].indexOf("ID постачальника");
  const known = new Set(main.slice(1).map((r) => String(r[sc])));
  const fresh = readyFromXml(xml, NOW).filter((e) => !known.has(e.id));
  assert.ok(fresh.length >= 3, "передумова: 3 новинки у фіді");
  assert.equal((await intakeAll(w, xml, { stamp: STAMP, now: NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session: "auto", ready: fresh.slice(0, 2) })).state, "INTAKE_DONE");
  const ids0 = nonEmpty();
  assert.equal(ids0.length, 2);
  // 1) Intake третьої новинки: перевірка після дописування (свіже читання шлюзу) не бачить рядка → INCOMPLETE, без ack;
  //    позиційного «відновлення» немає: рядок, що фактично дописано, лишається (не очищено, не видалено).
  let appended = false, deletes = 0;
  const rawAppend = sheets.appendRows.bind(sheets), rawDelete = sheets.deleteRows.bind(sheets);
  sheets.appendRows = async (title, rows) => { const r = await rawAppend(title, rows); if (title === SHEET.queue) appended = true; return r; };
  sheets.deleteRows = async (...a) => { deletes++; return rawDelete(...a); };
  const lying = async (names) => { const b = await w.readBook(names); if (appended && names.length === 1 && names[0] === SHEET.queue) b[SHEET.queue] = b[SHEET.queue].slice(0, 1 + ids0.length); return b; };
  let r1;
  try { r1 = await intakeAll(w, xml, { stamp: STAMP, now: NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session: "auto", readBook: lying, ready: fresh.slice(2, 3) }); }
  finally { sheets.appendRows = rawAppend; }
  assert.ok(appended, "передумова: дописування відправлено");
  assert.equal(r1.state, "INCOMPLETE", JSON.stringify(r1).slice(0, 300));
  assert.equal(r1.ack, undefined, "ack не надсилається");
  const ids1 = nonEmpty();
  assert.deepEqual(ids1.slice(0, ids0.length), ids0, "наявні рядки — на своїх місцях");
  assert.equal(ids1.length, ids0.length + 1, "фактично дописаний рядок не очищено й не видалено");
  const height1 = sheets.book[SHEET.queue].length;
  // 2) Наступний intake: та сама новинка знову в списку + зміна цін → рядок уже є за ключем (без дубля), ціни — за ключем; INTAKE_DONE.
  const xml2 = xml.replace(/(<price>)([\d.]+)(<\/price>)/g, (_, a, p, b) => a + String(Number(p) + 3) + b);
  const session = await new WriteGateway({ sheets, read: w.readBook, store: new MemoryStore() }).open({ writer: "intake" });
  const r = await intakeAll(w, xml2, { stamp: STAMP, now: NOW, config: cfg, catalog: EMPTY_CATALOG, controls: OK_CC, session, ready: fresh.slice(2, 3) });
  await session.close();
  sheets.deleteRows = rawDelete;
  assert.equal(r.state, "INTAKE_DONE", JSON.stringify(r).slice(0, 300));
  assert.deepEqual(nonEmpty(), ids1, "жоден рядок черги не втрачено й не задубльовано");
  assert.ok(sheets.book[SHEET.queue].length >= height1, "висота аркуша не зменшилась");
  assert.equal(deletes, 0, "позиційного видалення не було");
});
