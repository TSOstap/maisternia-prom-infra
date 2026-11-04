/** ENG-28a (доручення власника 01.11.2026) — 1) охорона цілі запису й токена; 2) поріг HOLD: менший із «50 товарів» і «2 % попереднього
 *  підтвердженого знімка», спрацювання при досягненні (≥) — межа, нижче, вище; 3) фід із фільтром охоплення (group_ids): поза
 *  охопленням наявність не змінюється, «Видалений у постачальника» не ставиться. Синтетика, таблиця в пам'яті, мережі немає. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { mergeNew92 } from "../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
import { EMPTY_CATALOG } from "./helpers/intake.mjs";
import * as P from "../src/core/supplier-presence.mjs";
import * as UP from "../src/pipeline/update-products.mjs";
import baseConfig from "../config/default.json" with { type: "json" };
// Новий модуль ENG-28a — динамічно: у кандидатах без нього (RED на ENG-28) падають окремі тести, а не файл.
const WT = await import("../src/pipeline/safe-write/write-target.mjs").catch(() => ({}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-10-22T10:00:00Z");
const at = (min) => new Date(NOW + min * 60_000).toISOString();

// ================================================================ 1. охорона цілі запису
const LIVE = "1AhQUz1bUB2LiQX4OKBbvTCSmTMWoKPcdQUtr3-TK2L8";
const TEST = "1th8VXOUeN08Lk9QNrjdt4GK3Z0nTnU8Awkb5pLvWOxs";
const SA = "mm-sheets-copy@maisternia-prom-infra.iam.gserviceaccount.com";
const blocked = (fn, re) => assert.throws(fn, (e) => e.code === "WRITE_TARGET_BLOCK" && (!re || re.test(e.message)));
const blockedAsync = (p, re) => assert.rejects(p, (e) => e.code === "WRITE_TARGET_BLOCK" && (!re || re.test(e.message)));

test("ENG-28a охорона: ціль — лише TEST за ID; LIVE і будь-який інший ID — BLOCK (назва таблиці не враховується)", () => {
  assert.equal(WT.TEST_SHEET_ID, TEST);
  assert.equal(WT.LIVE_SHEET_ID, LIVE);
  assert.equal(WT.assertWriteTarget(TEST), TEST);
  assert.equal(WT.assertWriteTarget(" " + TEST + " "), TEST);
  blocked(() => WT.assertWriteTarget(LIVE), /ЖИВА/);
  blocked(() => WT.assertWriteTarget("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"), /не тестова копія/);
  blocked(() => WT.assertWriteTarget(""), /немає ID/);
  blocked(() => WT.assertWriteTarget(null), /немає ID/);
});

test("ENG-28a охорона токена: лише mm-sheets-copy, рівно один scope spreadsheets, короткоживучий (≤ 1 год); інакше BLOCK до запису", async () => {
  assert.equal(WT.assertWriterToken({ scopes: [WT.WRITE_SCOPE], account: SA }), true);
  blocked(() => WT.assertWriterToken({ scopes: [WT.WRITE_SCOPE, "https://www.googleapis.com/auth/drive"], account: SA }), /рівно/);
  blocked(() => WT.assertWriterToken({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"], account: SA }), /рівно/);
  blocked(() => WT.assertWriterToken({ scopes: [WT.WRITE_SCOPE], account: "owner@gmail.com" }), /дозволеного переліку/);
  blocked(() => WT.assertWriterToken({}), /рівно/);
  const calls = [];
  const obtain = async (o) => { calls.push(o); return "tok-123456789"; };
  const scopeOf = (ttl, scopes = [WT.WRITE_SCOPE]) => async (token, scope) => { calls.push({ token, scope }); return { scopes, expiresIn: ttl }; };
  const get = await WT.writerAccessToken({ obtain, scopeOf: scopeOf(3599), account: SA });
  assert.equal(await get(), "tok-123456789");
  assert.deepEqual(calls[0], { scope: WT.WRITE_SCOPE }, "токен запитано саме зі scope spreadsheets");
  assert.equal(calls[1].scope, WT.WRITE_SCOPE);
  await blockedAsync(WT.writerAccessToken({ obtain, scopeOf: scopeOf(7200), account: SA }), /короткоживучим/);
  await blockedAsync(WT.writerAccessToken({ obtain, scopeOf: scopeOf(null), account: SA }), /короткоживучим/);
  await blockedAsync(WT.writerAccessToken({ obtain, scopeOf: scopeOf(0), account: SA }), /короткоживучим/);
  await blockedAsync(WT.writerAccessToken({ obtain, scopeOf: scopeOf(600, ["https://www.googleapis.com/auth/spreadsheets.readonly"]), account: SA }), /рівно/);
  await blockedAsync(WT.writerAccessToken({ obtain, scopeOf: scopeOf(600), account: "other@x.iam.gserviceaccount.com" }), /дозволеного переліку/);
});

function smallBook() {
  return {
    [SHEET.main]: [["Offer ID", "ID постачальника", "Назва UA", "Опис UA", "Опис RU", "Запити UA", "Запити RU"], ["1", "11", "Н", "о", "о", "з", "з"]],
    [SHEET.queue]: [["Offer ID", "Рішення", "Перевірка"], ["2", "", ""]],
    [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
}
const headersOf = (book) => Object.fromEntries(Object.entries(book).map(([k, v]) => [k, v[0]]));

test("ENG-28a охорона: кожна операція перевіряється ДО виклику API — аркуш, операція, колонки; видалення рядків і невідомі методи — BLOCK", async () => {
  const book = smallBook();
  const raw = new MemorySheets(book);
  blocked(() => WT.guardedSheets(raw, { spreadsheetId: LIVE, policy: WT.MODE_POLICIES.structure }), /ЖИВА/);
  const g = WT.guardedSheets(raw, { spreadsheetId: TEST, policy: WT.MODE_POLICIES.structure, headers: headersOf(book) });
  const before = JSON.stringify(book);
  await blockedAsync(g.updateRanges([{ title: SHEET.main, row: 2, col: 3, values: [["X"]] }]), /не дозволено/);
  await blockedAsync(g.updateRanges([{ title: SHEET.queue, row: 2, col: 2, values: [["ЗАТВЕРДЖЕНО"]] }]), /колонка «Рішення»/);
  await blockedAsync(g.updateRanges([{ title: SHEET.queue, row: 2, col: 2, values: [["", "x"]] }]), /колонка «Рішення»/, "блок ширший за дозволену колонку");
  await blockedAsync(g.deleteRows(SHEET.queue, [2]), /видалення рядків/);
  await blockedAsync(g.appendRows(SHEET.queue, [["3"]]), /appendRows/);
  await blockedAsync(g.ensureSheet("Новий аркуш", ["a"]), /не дозволено/);
  blocked(() => g.armFailure("updateRanges"), /невідома операція/);
  // Блок, що містить дозволену й недозволену колонки, відхиляється цілком (жодна клітинка не пишеться).
  await blockedAsync(g.updateRanges([{ title: SHEET.queue, row: 2, col: 3, values: [["ok"]] }, { title: SHEET.queue, row: 2, col: 1, values: [["9"]] }]), /Offer ID/);
  assert.equal(JSON.stringify(book), before, "жодної зміни");
  assert.equal(raw.log.length, 0, "жодного виклику записувача");
  // Дозволене: «Перевірка» черги, заголовок черги (header: true), «Журнал» — дописування.
  await g.updateRanges([{ title: SHEET.queue, row: 2, col: 3, values: [["ОЧІКУЄ"]] }]);
  await g.updateRanges([{ title: SHEET.queue, row: 1, col: 1, values: [["Offer ID", "Рішення", "Перевірка", "Виявлено"]] }]);
  await g.appendRows(SHEET.journal, [["t", "СИСТЕМА", "", "x", "", "", ""]]);
  assert.equal(book[SHEET.queue][1][2], "ОЧІКУЄ");
  assert.deepEqual((await g.read([SHEET.queue]))[SHEET.queue][0], ["Offer ID", "Рішення", "Перевірка", "Виявлено"], "читання проходить");
  // Заголовок, що з'явився після запису рядка 1, теж діє: нова колонка «Виявлено» не дозволена.
  await blockedAsync(g.updateRanges([{ title: SHEET.queue, row: 2, col: 4, values: [["x"]] }]), /Виявлено/);
  // Політика виправлення: заголовок «Основного каталогу» писати не можна; лише 4 поля.
  const c = WT.guardedSheets(new MemorySheets(smallBook()), { spreadsheetId: TEST, policy: WT.MODE_POLICIES.correction, headers: headersOf(smallBook()) });
  await blockedAsync(c.updateRanges([{ title: SHEET.main, row: 1, col: 1, values: [["Offer ID"]] }]), /заголовка/);
  await blockedAsync(c.updateRanges([{ title: SHEET.main, row: 2, col: 3, values: [["Назва"]] }]), /Назва UA/);
  await blockedAsync(c.updateRanges([{ title: SHEET.queue, row: 2, col: 3, values: [["x"]] }]), /не дозволено/);
  await c.updateRanges([{ title: SHEET.main, row: 2, col: 4, values: [["о1", "о2", "з1", "з2"]] }]);
  // Без прочитаного заголовка колонки не перевірити — BLOCK.
  const n = WT.guardedSheets(new MemorySheets(smallBook()), { spreadsheetId: TEST, policy: WT.MODE_POLICIES.correction });
  await blockedAsync(n.updateRanges([{ title: SHEET.main, row: 2, col: 4, values: [["о1"]] }]), /немає прочитаного заголовка/);
});

test("ENG-28a охорона: політика є для кожного режиму запису tools/sheet-sync; жодна не дозволяє видалення рядків; вузькі політики — лише свої колонки", () => {
  const src = fs.readFileSync(path.join(root, "tools", "sheet-sync.mjs"), "utf8");
  const modes = JSON.parse(src.match(/const WRITE_MODES = (\[[^\]]*\]);/)[1]);
  for (const m of modes) assert.ok(WT.MODE_POLICIES[m], "немає політики для режиму " + m);
  // ENG-29 (рішення власника 02.11, змінює B6): видалення рядків — лише «Перенести затверджені» і лише «Нові товари».
  for (const [m, pol] of Object.entries(WT.MODE_POLICIES)) for (const [title, p] of Object.entries(pol)) {
    const allowed = (m === "transfer" && title === SHEET.queue) || (m === "deferred" && title === SHEET.deferred); // ENG-29: рішення власника 02.11 / 03.11
    assert.equal((p.ops || []).includes("deleteRows") || p.deleteRows === true, allowed, `${m}/${title}: deleteRows`);
  }
  assert.deepEqual(Object.keys(WT.MODE_POLICIES.structure).sort(), [SHEET.journal, SHEET.queue, SHEET.passport].sort());
  assert.deepEqual(WT.MODE_POLICIES.structure[SHEET.queue].columns, ["Перевірка"]);
  assert.deepEqual(WT.MODE_POLICIES.correction[SHEET.main].columns, ["Опис UA", "Опис RU", "Запити UA", "Запити RU"]);
  assert.ok(!WT.MODE_POLICIES.correction[SHEET.main].header);
  // Токен запису в CLI — лише через writerAccessToken (mm-sheets-copy, generateAccessToken), не зі змінної оточення.
  assert.match(src, /WRITE_MODES\.includes\(mode\) \? await writerAccessToken\(\{ obtain: obtainToken, scopeOf: assertTokenScope, account: COPY_SA \}\)/);
  // Разові кроки структури й виправлення — лише з --maintenance і під орендою W2.
  assert.match(src, /const MAINTENANCE_MODES = \[[^\]]*"structure", "correction"[^\]]*\]/);
  assert.match(src, /underMaintenanceLease\(\(\) => migrateQueueForTransfer\(/);
  assert.match(src, /underMaintenanceLease\(\(\) => applyOwnerCorrection\(/);
  // Рішення власника 03.11: точкові правки власника — теж лише з --maintenance і під орендою W2; лише перелічені колонки.
  assert.match(src, /const MAINTENANCE_MODES = \[[^\]]*"owner-edits"[^\]]*\]/);
  assert.match(src, /underMaintenanceLease\(\(\) => applyOwnerEdits\(/);
  assert.deepEqual(WT.MODE_POLICIES["owner-edits"][SHEET.main].columns, ["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Характеристики JSON", "Фото JSON", "Виробник", "Попередження постачальника", "Запити UA", "Запити RU", "Група ID", "Група UA", "Група RU", "Категорія Prom ID", "Категорія Prom URL"]);
  // Кожен режим запису — записувач, обгорнутий охоронцем (до будь-якого кроку запису).
  assert.match(src, /if \(WRITE_MODES\.includes\(mode\)\) \{\s*try \{\s*const policy = MODE_POLICIES\[mode\];[\s\S]{0,400}sheets = guardedSheets\(sheets, \{ spreadsheetId:/);
});

test("ENG-28a CLI: режим запису з ціллю LIVE або чужим ID — відмова до будь-якого запиту (без токена й мережі)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-e28a-"));
  const runTool = (env, extra = ["--maintenance"]) => spawnSync(process.execPath, [path.join(root, "tools", "sheet-sync.mjs"), "--mode=structure", "--source=api", ...extra], {
    encoding: "utf8", timeout: 60_000,
    // PATH — лише каталог node: навіть якщо охорона не спрацює, gcloud (токен / мережа) недоступний.
    env: { PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot, MM_W2_MODE: "single-host", MM_SAFE_WRITE_DIR: dir, GOOGLE_OAUTH_ACCESS_TOKEN: "", ...env },
  });
  // Разовий крок структури без явного --maintenance — відмова ще до доступу до таблиці.
  const r0 = runTool({ MM_TEST_SHEET_ID: TEST, MM_SHEET_ID: LIVE }, []);
  assert.equal(r0.status, 2, r0.stderr);
  assert.match(r0.stderr, /ОБСЛУГОВУВАННЯ: режим structure/);
  const r1 = runTool({ MM_TEST_SHEET_ID: LIVE, MM_SHEET_ID: LIVE });
  assert.equal(r1.status, 2, r1.stderr);
  assert.match(r1.stderr, /BLOCK запису: ціль — ЖИВА таблиця/);
  const r2 = runTool({ MM_TEST_SHEET_ID: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" });
  assert.equal(r2.status, 2, r2.stderr);
  assert.match(r2.stderr, /не тестова копія/);
  const r3 = runTool({ MM_TEST_SHEET_ID: TEST, MM_SHEET_ID: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" });
  assert.equal(r3.status, 2, r3.stderr);
  assert.match(r3.stderr, /MM_SHEET_ID не збігається/);
  for (const r of [r0, r1, r2, r3]) assert.ok(!/ya29\.|generateAccessToken|tokeninfo/.test(r.stderr + r.stdout), "до токена не дійшло");
});

// ================================================================ 2. поріг HOLD
/** prev — підтверджений повний знімок із N товарів; зникає k (усі були в підтвердженому). */
function presenceCase(prevCount, goneCount, limits) {
  const ids = Array.from({ length: prevCount }, (_, i) => String(100000 + i));
  const prev = { id: "sn-prev", ids, count: prevCount, fp: {}, scope: "full" };
  const left = ids.slice(goneCount);
  const snap = { id: "sn-new", ids: left, count: left.length, fp: {}, feedDate: "d", source: "s", scope: "full" };
  const rows = ids.map((sid) => ({ offerId: "9" + sid, supplierId: sid }));
  return P.planPresence({ rows, previous: prev, snapshot: snap, proof: { complete: true }, stamp: "T", ...(limits ? { limits } : {}) });
}

test("ENG-28a поріг HOLD: менший із 50 і ⌈2 % попереднього підтвердженого⌉", () => {
  assert.deepEqual(P.PRESENCE_LIMITS, { maxGoneAbsolute: 50, maxGoneRatio: 0.02 });
  const L = (n, limits) => P.holdLimit(limits ?? P.PRESENCE_LIMITS, n);
  assert.equal(L(2600), 50, "2 % = 52 → менший 50");
  assert.equal(L(2500), 50, "2 % = 50 рівно");
  assert.equal(L(1000), 20, "2 % = 20 < 50");
  assert.equal(L(1001), 21, "округлення вгору: 20,02 → 21");
  assert.equal(L(5029), 50, "основний каталог TEST: 2 % = 100,58 → 50");
  assert.equal(L(5121), 50);
  assert.equal(L(49), 1, "0,98 → 1");
  assert.equal(L(1000, { maxGoneAbsolute: 50, maxGoneRatio: 0 }), 50, "частка 0 — лише абсолютний");
  assert.equal(L(1000, { maxGoneAbsolute: 0, maxGoneRatio: 0.02 }), 20, "абсолютний 0 — лише частка");
  assert.equal(L(0), 50, "немає попереднього — лише абсолютний");
  assert.equal(L(1000, {}), Infinity);
});

for (const [prev, limit] of [[2600, 50], [1000, 20], [1001, 21]]) {
  test(`ENG-28a HOLD на межі: попередній ${prev} → поріг ${limit}: ${limit - 1} — APPLY, ${limit} — HOLD, ${limit + 1} — HOLD; HOLD нічого не застосовує`, () => {
    const below = presenceCase(prev, limit - 1);
    assert.equal(below.decision, "APPLY");
    assert.equal(below.gone.length, limit - 1);
    assert.equal(below.updates.size, limit - 1);
    for (const k of [limit, limit + 1]) {
      const h = presenceCase(prev, k);
      assert.equal(h.decision, "HOLD", `${k} зниклих`);
      assert.equal(h.updates.size, 0, "HOLD — жодної позначки");
      assert.equal(h.disappearing, k);
      assert.equal(h.limit, limit);
      assert.match(h.reasons.join(), new RegExp(`аномальне зникнення: ${k} товарів \\(поріг ${limit}\\)`));
    }
  });
}

test("ENG-28a HOLD: 0 зниклих — ніколи не HOLD; частка 0 — межа лише абсолютна; базовий запуск рахує «відсутні в знімку»", () => {
  assert.equal(presenceCase(1000, 0).decision, "APPLY");
  assert.equal(presenceCase(10, 0).decision, "APPLY");
  assert.equal(presenceCase(1000, 49, { maxGoneAbsolute: 50, maxGoneRatio: 0 }).decision, "APPLY");
  assert.equal(presenceCase(1000, 50, { maxGoneAbsolute: 50, maxGoneRatio: 0 }).decision, "HOLD");
  // Базовий запуск (підтвердженого немає): поріг — від нового знімка; 2 % від 1000 = 20.
  const ids = Array.from({ length: 1000 }, (_, i) => String(200000 + i));
  const snap = { id: "sn-1", ids: ids.slice(0, 980), count: 980, fp: {}, scope: "full" };
  const rows = ids.map((sid) => ({ offerId: "8" + sid, supplierId: sid }));
  const base = P.planPresence({ rows, previous: null, snapshot: snap, proof: { complete: true }, stamp: "T" });
  assert.equal(base.limit, 20, "⌈2 % × 980⌉ = 20");
  assert.equal(base.decision, "HOLD", "20 відсутніх у першому знімку ≥ 20");
  const base2 = P.planPresence({ rows, previous: null, snapshot: { ...snap, ids: ids.slice(0, 981), count: 981 }, proof: { complete: true }, stamp: "T" });
  assert.equal(base2.decision, "APPLY", "19 < 20");
  assert.ok([...base2.updates.values()].every((u) => u.presence === P.PRESENCE.ABSENT_IN_SNAPSHOT), "без підтвердженого — не «видалений»");
});

// ---------------------------------------------------------------- HOLD у справжньому «Оновити товари»
const cfg = (presence) => { const c = structuredClone(baseConfig); c.ownerPriority = { enabled: true }; c.supplier.minimumOffers = 10; c.policy.anomaly = { ...c.policy.anomaly, maxNewlyMissingRatio: 1 }; if (presence) c.presence = presence; return c; };
const okCc = () => Object.freeze({ held: new Set(), removed: new Set(), tombstoned: new Map(), blocked: false, reasons: [], fingerprint: "fp-", gate: { check: () => ({ blocked: false, kind: "NONE" }) } });
const full = (xml) => xml.replace(/<\/offer>/g, "<description>Опис постачальника</description></offer>");
const dated = (xml, min) => xml.replace(/date="[^"]*"/, () => { const d = new Date(NOW + min * 60_000 + 3 * 3600_000); return `date="${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}"`; });
const FULL_URL = "https://market-tools.com.ua/feed.xml?key=SECRET";
const FILTERED_URL = "https://market-tools.com.ua/feed.xml?key=SECRET&group_ids=101,102";
async function world() {
  const s = generateSynthetic({ products: 40, queue: 4, deferred: 2, newOffers: 0, seed: 13, now: NOW });
  const book = { [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]] };
  const sheets = new MemorySheets(book);
  const w = { s, sheets, readBook: async () => sheets.read(), xml: full(s.supplierXml()), store: new MemoryStore() };
  await mergeNew92({ sheets, readBook: w.readBook, stamp: at(0) });
  return w;
}
const run = (w, xml, { min = 1, config = cfg(), source = FULL_URL } = {}) => UP.updateProducts({ sheets: w.sheets, readBook: w.readBook, xml, source, fetchedAt: at(min), stamp: at(min), now: NOW + min * 60_000, config, catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w.store });
const main = (w) => readSheet(w.sheets.book[SHEET.main], SHEET.main).rows;
const byId = (w, id) => main(w).find((r) => mtText(r["Offer ID"]) === id);
const exceptJournal = (w) => JSON.stringify(Object.fromEntries(Object.entries(w.sheets.book).filter(([k]) => k !== SHEET.journal)));

test("ENG-28a «Оновити товари»: межа HOLD на справжньому запуску — поріг−1 застосовано; поріг — HOLD до будь-якого запису (лише подія в «Журналі»), знімок не підтверджено", async () => {
  const limits = { maxGoneAbsolute: 50, maxGoneRatio: 0.05 };
  const config = cfg({ limits });
  const w1 = await world();
  const r0 = await run(w1, w1.xml, { config });
  assert.equal(r0.confirmed, true);
  const prevCount = (await w1.store.getJsonVersioned(P.CONFIRMED_SNAPSHOT_KEY)).value.count;
  const limit = P.holdLimit(limits, prevCount);
  assert.ok(limit < 50 && limit >= 2, "діє частка (менший поріг): " + limit);
  const ids = main(w1).slice(0, limit).map((r) => mtText(r["ID постачальника"]));
  // Нижче межі: limit − 1 зниклих → застосовано.
  const r1 = await run(w1, dated(perturb.drop(w1.xml, ids.slice(0, limit - 1)), 2), { min: 2, config });
  assert.equal(r1.state, "SYNCED", JSON.stringify(r1).slice(0, 400));
  assert.equal(r1.presence.gone, limit - 1);
  // На межі: limit зниклих (свіжий світ, той самий підтверджений знімок) → HOLD.
  const w2 = await world();
  await run(w2, w2.xml, { config });
  const snap1 = (await w2.store.getJsonVersioned(P.CONFIRMED_SNAPSHOT_KEY)).value.id;
  const before = exceptJournal(w2), mark = w2.sheets.log.length;
  const r2 = await run(w2, dated(perturb.drop(w2.xml, ids), 2), { min: 2, config });
  assert.equal(r2.state, "HOLD_SUPPLIER_DISAPPEARANCE", JSON.stringify(r2).slice(0, 400));
  assert.equal(r2.sync.block.affected, String(limit));
  assert.equal(r2.sync.block.limit, String(limit));
  assert.equal(r2.presence.disappearing, limit);
  assert.equal(exceptJournal(w2), before, "жоден товарний аркуш не змінено (ціни теж)");
  assert.ok(w2.sheets.log.slice(mark).every((x) => x.op === "appendRows"), "лише дописування події");
  assert.ok(w2.sheets.book[SHEET.journal].some((e) => e[3] === "ОНОВЛЕННЯ ЗАБЛОКОВАНО" && e[4] === "АНОМАЛЬНЕ ЗНИКНЕННЯ ТОВАРІВ"));
  assert.equal(r2.confirmed, false);
  assert.equal((await w2.store.getJsonVersioned(P.CONFIRMED_SNAPSHOT_KEY)).value.id, snap1);
});

test("ENG-28a «Оновити товари»: повний фід, більший за межу ОПЕРАЦІЙНОГО (config.supplier.maximumChars, 45 млн у Code.gs), розбирається; понад межу повного — ABORTED без запису й без винятку", async () => {
  const w = await world();
  const config = cfg();
  config.supplier.maximumChars = 1000; // синтетичний повний фід ≫ 1000 символів — як реальний 80 МБ ≫ 45 млн
  assert.ok(w.xml.length > 1000);
  const r = await run(w, w.xml, { config });
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 300));
  assert.equal(UP.FULL_FEED_MAX_CHARS, 300_000_000, "як maxBytes завантажувача повного фіду в tools/sheet-sync");
  const w2 = await world();
  const b = JSON.stringify(w2.sheets.book), mark = w2.sheets.log.length;
  const r2 = await UP.updateProducts({ sheets: w2.sheets, readBook: w2.readBook, xml: w2.xml, source: FULL_URL, fetchedAt: at(1), stamp: at(1), now: NOW + 60_000, config: cfg(), catalog: EMPTY_CATALOG, controls: okCc(), snapshotStore: w2.store, fullMaxChars: 1000 });
  assert.equal(r2.state, "ABORTED");
  assert.match(r2.reason, /безпечний розмір/);
  assert.equal(JSON.stringify(w2.sheets.book), b);
  assert.equal(w2.sheets.log.length, mark);
});

// ================================================================ 3. фід із фільтром охоплення
test("ENG-28a охоплення фіду: адреса з group_ids / nested_group_ids / product_ids / label_ids — «filtered»; без них — «full»; невідома адреса — безпечно «filtered»; значення фільтра не зберігаються", () => {
  assert.deepEqual(P.feedScopeOf(FULL_URL), { scope: "full", by: [] });
  assert.deepEqual(P.feedScopeOf(FILTERED_URL), { scope: "filtered", by: ["group_ids"] });
  assert.deepEqual(P.feedScopeOf("https://x.ua/f.xml?nested_group_ids=1&product_ids=2"), { scope: "filtered", by: ["nested_group_ids", "product_ids"] });
  assert.deepEqual(P.feedScopeOf("https://x.ua/f.xml?label_ids=7"), { scope: "filtered", by: ["label_ids"] });
  assert.deepEqual(P.feedScopeOf("https://x.ua/f.xml?group_ids="), { scope: "full", by: [] }, "порожній фільтр — не фільтр");
  assert.equal(P.feedScopeOf("не адреса").scope, "unknown");
  const s = generateSynthetic({ products: 12, queue: 1, deferred: 1, newOffers: 0, seed: 2, now: NOW });
  const x = full(s.supplierXml());
  assert.equal(P.snapshotFromXml(x).scope, "filtered", "джерело невідоме → не доказ повноти охоплення");
  const sn = P.snapshotFromXml(x, { source: FILTERED_URL });
  assert.equal(sn.scope, "filtered");
  assert.deepEqual(sn.scopeBy, ["group_ids"]);
  assert.ok(!JSON.stringify(sn).includes("101") && !JSON.stringify(sn).includes("SECRET"), "значення параметрів не зберігаються");
  assert.equal(P.snapshotFromXml(x, { source: FULL_URL }).scope, "full");
});

test("ENG-28a план присутності, фід із фільтром: відсутні — «поза охопленням» без позначок і без HOLD навіть масово; присутній після «видалений» — «повернувся»; «видалений» — лише для пари повних", () => {
  const ids = Array.from({ length: 100 }, (_, i) => String(300000 + i));
  const prevF = { id: "sn-f0", ids, count: 100, fp: {}, scope: "filtered" };
  const snapF = { id: "sn-f1", ids: ids.slice(60), count: 40, fp: {}, scope: "filtered" };
  const rows = ids.map((sid) => ({ offerId: "7" + sid, supplierId: sid }));
  rows[0].presence = P.PRESENCE.ABSENT_IN_SNAPSHOT; rows[0].meta = JSON.stringify({ since: "2026-10-22" });
  rows[1].presence = P.PRESENCE.GONE; rows[1].meta = JSON.stringify({ since: "t0" });
  rows[70].presence = P.PRESENCE.GONE;
  const pp = P.planPresence({ rows, previous: prevF, snapshot: snapF, proof: { complete: true }, stamp: "T" });
  assert.equal(pp.decision, "APPLY", "60 % відсутніх — не HOLD: фільтрований фід нічого не видаляє");
  assert.equal(pp.gone.length, 0);
  assert.equal(pp.absent.length, 0);
  assert.equal(pp.outOfScope.length, 59, "крім уже позначеного «видалений» (rows[1])");
  assert.ok(!pp.updates.has("7" + ids[0]), "історична позначка «відсутній у знімку» збережена");
  assert.ok(!pp.updates.has("7" + ids[1]));
  assert.equal(pp.updates.get("7" + ids[70]).presence, P.PRESENCE.RETURNED, "присутній у фіді — доказ присутності");
  // Повний новий проти фільтрованого попереднього — не пара повних: «видалений» не ставиться.
  const mixed = P.planPresence({ rows: rows.slice(2, 5), previous: prevF, snapshot: { ...snapF, scope: "full", ids: ids.slice(4) }, proof: { complete: true }, stamp: "T", limits: { maxGoneAbsolute: 50, maxGoneRatio: 0 } });
  assert.equal(mixed.gone.length, 0);
  assert.ok([...mixed.updates.values()].every((u) => u.presence === P.PRESENCE.ABSENT_IN_SNAPSHOT));
  // Охоплення нового знімка невідоме (немає поля scope) — як фільтрований: жодної позначки навіть проти повного підтвердженого.
  const noScope = P.planPresence({ rows: rows.slice(2, 5), previous: { ...prevF, scope: "full" }, snapshot: { ...snapF, scope: undefined }, proof: { complete: true }, stamp: "T", limits: { maxGoneAbsolute: 50, maxGoneRatio: 0 } });
  assert.equal(noScope.gone.length, 0, "охоплення невідоме — «видалений» не ставиться");
  assert.equal(noScope.updates.size, 0);
  assert.equal(noScope.outOfScope.length, 3);
});

test("ENG-28a «Оновити товари» з фідом group_ids: окремий підтверджений знімок; зниклі з фіду — наявність, ціни й стан не змінюються, «видалений» не ставиться; новинки — з поміткою про охоплення", async () => {
  const w = await world();
  const r0 = await run(w, w.xml, { source: FILTERED_URL });
  assert.equal(r0.state, "SYNCED", JSON.stringify(r0).slice(0, 400));
  assert.equal(r0.confirmed, true);
  assert.equal((await w.store.getJsonVersioned(P.CONFIRMED_SNAPSHOT_KEY)).value, null, "знімок повного фіду не підміняється фільтрованим");
  assert.equal((await w.store.getJsonVersioned(UP.CONFIRMED_FILTERED_SNAPSHOT_KEY)).value.scope, "filtered");
  // Зникає 8 товарів основного каталогу (≈17 %; різке падіння ≥ 20 % окремо зупиняє доказ повноти): у повному фіді це HOLD
  // (поріг ⌈2 % × 47⌉ = 1), тут — поза охопленням.
  const gone = main(w).slice(0, 8);
  const before = new Map(gone.map((r) => [mtText(r["Offer ID"]), { ...r }]));
  const r1 = await run(w, dated(perturb.drop(w.xml, gone.map((r) => mtText(r["ID постачальника"]))), 2), { min: 2, source: FILTERED_URL });
  assert.ok(["SYNCED", "NO_CHANGES"].includes(r1.state), JSON.stringify(r1).slice(0, 400));
  assert.equal(r1.presence.gone, 0);
  assert.equal(r1.presence.outOfScope, 8);
  assert.equal(r1.sync.stats.outOfFeedScope, 8);
  for (const [id, b] of before) {
    const row = byId(w, id);
    for (const k of ["Наявність", "Ціна постачальника", "Ціна кінцева", "Стан синхронізації"]) assert.equal(mtText(row[k]), mtText(b[k]), `${id}: ${k}`);
    // ENG-28c (рішення власника 01.11): нейтральний стан «поза охопленням фіду» — не «видалений» і не «відсутній у знімку».
    assert.equal(mtText(row[P.PRESENCE_COLUMN]), P.OUT_OF_SCOPE_PRESENCE, `${id}: нейтральний стан`);
  }
  assert.ok(!w.sheets.book[SHEET.journal].some((e) => e[3] === P.PRESENCE_COLUMN && e[5] === P.PRESENCE.GONE));
  assert.ok(!w.sheets.book[SHEET.journal].some((e) => e[3] === "ПОМИЛКА" && e[6] === "ПОЗА_ОХОПЛЕННЯМ_ФІДУ"), "ENG-28c: «поза охопленням» — не «ПОМИЛКА»");
  // ENG-28c: повтор (нова дата, той самий вміст) — нейтральна позначка не пишеться вдруге й «ПОМИЛКА» не з'являється.
  const marks = () => w.sheets.book[SHEET.journal].filter((e) => e[3] === P.PRESENCE_COLUMN && e[5] === P.OUT_OF_SCOPE_PRESENCE).length;
  assert.equal(marks(), 8, "нейтральний стан — один запис «Журналу» на товар");
  const r1b = await run(w, dated(perturb.drop(w.xml, gone.map((r) => mtText(r["ID постачальника"]))), 3), { min: 3, source: FILTERED_URL });
  assert.ok(["SYNCED", "NO_CHANGES"].includes(r1b.state), JSON.stringify(r1b).slice(0, 300));
  assert.equal(marks(), 8, "повтор не дублює нейтральну позначку");
  assert.ok(!w.sheets.book[SHEET.journal].some((e) => e[3] === "ПОМИЛКА" && e[6] === "ПОЗА_ОХОПЛЕННЯМ_ФІДУ"));
  // Новинка з фільтрованого фіду — лише підсумок з поміткою (для всього каталогу — лише повний фід).
  const extra = `<offer id="2990000001" available="true"><url>https://market-tools.com.ua/p2990000001-x.html</url><price>500</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>Новий</name><name_ua>Новий</name_ua><vendorCode>NEW-1</vendorCode><picture>https://images.prom.ua/1_n.jpg</picture><param name="Потужність" unit="Вт">10</param><description>Опис</description></offer>`;
  const r2 = await run(w, dated(w.xml, 4).replace("\n</offers>", "\n" + extra + "\n</offers>"), { min: 4, source: FILTERED_URL });
  assert.equal(r2.newItems.scope, "filtered");
  assert.match(r2.newItems.note, /лише за повним фідом/);
});
