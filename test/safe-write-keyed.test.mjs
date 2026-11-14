/** E2 (ENG-01 K3 + K4): запис за Offer ID — без опори на старий номер рядка; лише дозволені колонки; паралельні правки людини
 *  (SEO, сортування, вставка рядка) між читанням і записом; втрачена відповідь, дубль запиту, часткове виконання; без видалень. */
import test from "node:test";
import assert from "node:assert/strict";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { OUTCOME, outcomeOf } from "../src/pipeline/write-outcome.mjs";
import { keyedUpdate, appendMissingByKey, compensateMisplaced, ITEM, OP } from "../src/pipeline/safe-write/keyed-update.mjs";
import { loadOwnership, assertWritable, writableColumns } from "../src/pipeline/safe-write/ownership.mjs";
import { MAIN_HEADERS, SEO_FIELDS } from "../src/core/sheet-sync.mjs";
import { WriteGateway } from "../src/pipeline/safe-write/gateway.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";

const contract = loadOwnership();
const T = "Основний каталог";
const H = ["Offer ID", "ID постачальника", "Назва UA", "Опис UA", "Ціна", "Наявність", "Фото JSON", "SEO рішення"];
const book = () => ({ [T]: [H.slice(), ...["101", "102", "103", "104", "105"].map((id, i) => [id, "s" + id, "Назва " + id, "Опис " + id, String(100 + i), "+", `["f${id}"]`, ""])] });
const cell = (sh, key, col) => { const v = sh.book[T]; const r = v.find((x) => x[0] === key); return r?.[v[0].indexOf(col)]; };
const ctx = (sh, o = {}) => ({ sheets: sh, read: (n) => sh.read(n), contract, writer: "sync", title: T, ...o });
const snap = (sh) => JSON.stringify(sh.book[T]);

test("контракт власності: усі колонки описані; SEO / описи — лише sync і лише через ворота стану; колонки власника CC і override — нікому", () => {
  // Зміна за фінальними вимогами власника 29.10 (розд. 1): незмінене власником поле веде постачальник → sync може писати SEO / описи,
  // але тільки коли поле в рядку має стан SUPPLIER (gate field-state). Раніше ці колонки не писав ніхто.
  const s = contract.sheets.get(T);
  for (const k of MAIN_HEADERS) assert.ok(s.columns.has(k), "немає в контракті: " + k);
  for (const k of SEO_FIELDS) { assert.deepEqual(s.columns.get(k).writers, ["sync"], k); assert.equal(s.columns.get(k).gate, "field-state", k); }
  for (const k of ["SEO заголовок UA", "SEO опис RU", "SEO рішення", "Продаж рішення", "Ціна власника"]) assert.deepEqual(s.columns.get(k).writers, [], k);
  // Рішення власника 14.11: «Наявність власника» — система (sync) лише СПОЖИВАЄ значення: очищує клітинку, коли постачальник оновив наявність.
  assert.deepEqual(s.columns.get("Наявність власника").writers, ["sync"]); assert.equal(s.columns.get("Наявність власника").gate, "cmd-consume");
  assert.ok(!writableColumns(contract, T, "sync").includes("Offer ID"));
  assert.throws(() => assertWritable(contract, "Невідомий аркуш", "sync", ["X"]), /не описаний/);
});

test("ворота стану: sync пише кероване поле лише коли у свіжому рядку воно SUPPLIER; CUSTOM / без стану — FIELD_CUSTOM, без запиту", async () => {
  const HS = [...H, "Стан полів JSON"];
  const st = (s) => JSON.stringify({ v: 1, f: { "Назва UA": { s, sys: "x", raw: "y" } }, p: {} });
  const mk = (state) => new MemorySheets({ [T]: [HS.slice(), ["101", "s101", "Назва 101", "Опис 101", "100", "+", "[]", "", state]] });
  const ch = [{ key: "101", expect: { "Назва UA": "Назва 101" }, set: { "Назва UA": "Нова від постачальника" } }];
  for (const [state, ok] of [[st("S"), true], [st("C"), false], ["", false], ["{зламано", false]]) {
    const sh = mk(state);
    const r = await keyedUpdate(ctx(sh, { changes: ch }));
    assert.equal(r.outcome, ok ? OP.VERIFIED : OP.NOT_APPLIED, state);
    if (!ok) { assert.equal(r.items[0].status, ITEM.FIELD_CUSTOM, state); assert.equal(sh.log.length, 0, "жодного запиту"); }
    assert.equal(cell(sh, "101", "Назва UA"), ok ? "Нова від постачальника" : "Назва 101");
  }
  // Без колонки стану в аркуші — теж захисно.
  const sh = new MemorySheets(book());
  assert.equal((await keyedUpdate(ctx(sh, { changes: ch }))).items[0].status, ITEM.FIELD_CUSTOM);
  // Власник змінив стан на CUSTOM між нашим плануванням і записом — свіже читання бачить C → не пишемо.
  const sh2 = mk(st("S"));
  sh2.book[T][1][HS.indexOf("Стан полів JSON")] = st("C");
  assert.equal((await keyedUpdate(ctx(sh2, { changes: ch }))).items[0].status, ITEM.FIELD_CUSTOM);
});

test("E2: запис за ключем — лише цільові клітинки; решта таблиці байт-у-байт", async () => {
  const sh = new MemorySheets(book());
  const before = structuredClone(sh.book[T]);
  const r = await keyedUpdate(ctx(sh, { changes: [{ key: "103", identity: { "ID постачальника": "s103" }, expect: { "Фото JSON": '["f103"]', "Ціна": "102" }, set: { "Фото JSON": '["new"]', "Ціна": "999" } }] }));
  assert.equal(r.outcome, OP.VERIFIED);
  assert.equal(cell(sh, "103", "Фото JSON"), '["new"]');
  const after = sh.book[T];
  for (let i = 0; i < before.length; i++) for (let j = 0; j < H.length; j++) if (!(after[i][0] === "103" && ["Фото JSON", "Ціна"].includes(H[j]))) assert.equal(after[i][j], before[i][j], `${i}/${H[j]}`);
});

test("E2: заборонені колонки (SEO / описи для інших записувачів, команди власника, ключ) — відмова ДО будь-якого запиту, таблиця без змін", async () => {
  for (const [col, writer] of [["Назва UA", "catalog-controls"], ["Опис UA", "content-html"], ["Назва RU", "seo"], ["SEO рішення", "sync"], ["Offer ID", "sync"], ["Ціна власника", "sync"]]) {
    const sh = new MemorySheets(book());
    const s0 = snap(sh);
    const e = await keyedUpdate(ctx(sh, { writer, changes: [{ key: "101", expect: { [col]: "x" }, set: { [col]: "y" } }] })).catch((x) => x);
    assert.equal(outcomeOf(e), OUTCOME.NOT_APPLIED, col);
    assert.equal(e.code, "OWNERSHIP", col);
    assert.equal(sh.log.length, 0, col + ": жодного запиту");
    assert.equal(snap(sh), s0);
  }
});

test("E2: одночасна зміна SEO власником між читанням і записом — правка власника зберігається", async () => {
  const sh = new MemorySheets(book());
  sh.beforeWrite = (op) => { if (op === "updateRanges") sh.humanSet(T, 3, "Назва UA", "SEO ВЛАСНИКА НОВЕ"); }; // рядок 3 = товар 102
  const r = await keyedUpdate(ctx(sh, { changes: [{ key: "102", expect: { "Фото JSON": '["f102"]' }, set: { "Фото JSON": '["нове фото"]' } }] }));
  assert.equal(r.outcome, OP.VERIFIED);
  assert.equal(cell(sh, "102", "Назва UA"), "SEO ВЛАСНИКА НОВЕ");
  assert.equal(cell(sh, "102", "Фото JSON"), '["нове фото"]');
});

test("E2: значення змінено людиною до нашого читання (expect ≠ поточне) — CONFLICT, клітинка не перезаписується", async () => {
  const sh = new MemorySheets(book());
  sh.humanSet(T, 2, "Фото JSON", '["людина"]');
  const r = await keyedUpdate(ctx(sh, { changes: [{ key: "101", expect: { "Фото JSON": '["f101"]' }, set: { "Фото JSON": '["синхронізація"]' } }] }));
  assert.equal(r.outcome, OP.NOT_APPLIED);
  assert.equal(r.items[0].status, ITEM.CONFLICT);
  assert.equal(cell(sh, "101", "Фото JSON"), '["людина"]');
  assert.equal(sh.log.length, 0);
});

test("E2: сортування між читанням і записом — запис у чужий рядок ВИЯВЛЕНО (NEEDS_DECISION); компенсація за ключем; повтор — у свій рядок; видалень немає", async () => {
  const sh = new MemorySheets(book());
  let sorted = false;
  sh.beforeWrite = (op) => { if (op === "updateRanges" && !sorted) { sorted = true; sh.humanSort(T, "Offer ID", true); } }; // 105,104,103,102,101
  const o = ctx(sh);
  const r = await keyedUpdate({ ...o, changes: [{ key: "102", expect: { "Фото JSON": '["f102"]' }, set: { "Фото JSON": '["для 102"]' } }] });
  assert.equal(r.outcome, OP.NEEDS_DECISION);
  assert.equal(r.misplaced.length, 1);
  assert.equal(r.misplaced[0].key, "104", "наш запис ліг у рядок, де тепер товар 104");
  assert.equal(cell(sh, "104", "Фото JSON"), '["для 102"]', "пошкодження відтворено");
  sh.beforeWrite = null;
  const c = await compensateMisplaced(o, r.misplaced);
  assert.equal(c.outcome, OP.VERIFIED);
  assert.equal(cell(sh, "104", "Фото JSON"), '["f104"]', "товар 104 відновлено за ключем");
  const again = await keyedUpdate({ ...o, changes: [{ key: "102", expect: { "Фото JSON": '["f102"]' }, set: { "Фото JSON": '["для 102"]' } }], generation: "retry" });
  assert.equal(again.outcome, OP.VERIFIED);
  assert.equal(cell(sh, "102", "Фото JSON"), '["для 102"]');
  assert.equal(sh.book[T].length, 6, "рядків стільки ж — нічого не видалено");
});

test("E2: вставка рядка людиною між читанням і записом — виявлено й компенсовано", async () => {
  const sh = new MemorySheets(book());
  let done = false;
  sh.beforeWrite = (op) => { if (op === "updateRanges" && !done) { done = true; sh.humanInsertRow(T, 2, ["999", "s999", "Новий", "", "1", "+", "[]", ""]); } };
  const o = ctx(sh);
  const r = await keyedUpdate({ ...o, changes: [{ key: "103", expect: { "Ціна": "102" }, set: { "Ціна": "555" } }] });
  assert.equal(r.outcome, OP.NEEDS_DECISION);
  assert.equal(r.misplaced[0].key, "102", "запис ліг на товар 102, який зсунувся вниз");
  sh.beforeWrite = null;
  assert.equal((await compensateMisplaced(o, r.misplaced)).outcome, OP.VERIFIED);
  assert.equal(cell(sh, "102", "Ціна"), "101");
  assert.equal((await keyedUpdate({ ...o, changes: [{ key: "103", expect: { "Ціна": "102" }, set: { "Ціна": "555" } }], generation: "retry" })).outcome, OP.VERIFIED);
  assert.equal(cell(sh, "103", "Ціна"), "555");
  assert.equal(cell(sh, "999", "Ціна"), "1", "вставлений людиною рядок не зачеплено");
});

test("E2: дубль ключа в аркуші — відмова; ідентичність не збіглась — без запису", async () => {
  const sh = new MemorySheets(book());
  sh.book[T].push(["101", "sX", "", "", "1", "+", "[]", ""]);
  assert.equal((await keyedUpdate(ctx(sh, { changes: [{ key: "101", expect: { "Ціна": "100" }, set: { "Ціна": "1" } }] })).catch((e) => e)).code, "KEY_DUPLICATE");
  const sh2 = new MemorySheets(book());
  const r = await keyedUpdate(ctx(sh2, { changes: [{ key: "101", identity: { "ID постачальника": "інший" }, expect: { "Ціна": "100" }, set: { "Ціна": "1" } }] }));
  assert.equal(r.items[0].status, ITEM.IDENTITY_MISMATCH);
  assert.equal(sh2.log.length, 0);
});

test("E2 + E3: втрачена відповідь (застосовано) → перевірка за ключем VERIFIED; дубль того самого наміру — без запиту", async () => {
  const sh = new MemorySheets(book());
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: new MemoryStore(), now: () => 1_000 });
  const s = await gw.open({ writer: "sync" });
  sh.armFault({ op: "updateRanges", mode: "lost" });
  const ch = [{ key: "101", expect: { "Ціна": "100" }, set: { "Ціна": "123" } }];
  const r = await s.updateByKey({ title: T, changes: ch, generation: "g1" });
  assert.equal(r.dispatch, OUTCOME.UNKNOWN);
  assert.equal(r.outcome, OP.VERIFIED, "з'ясовано читанням: застосовано рівно раз");
  const n = sh.log.length;
  const again = await s.updateByKey({ title: T, changes: ch, generation: "g1" });
  assert.equal(again.repeated, true);
  assert.equal(sh.log.length, n, "повтор того самого наміру не відправив запит");
  await s.close();
});

test("E2 + E3: частково підтверджена операція (2 запити, другий — тайм-аут) → UNKNOWN до кінця вікна → з'ясування → довиконання", async () => {
  let t = 1_000;
  const sh = new MemorySheets(book(), { maxBlocksPerCall: 1 });
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: new MemoryStore(), now: () => t, settleMs: 200_000 });
  const s = await gw.open({ writer: "sync" });
  sh.armFault({ op: "updateRanges", nth: 2, mode: "timeout" });
  const ch = [{ key: "101", expect: { "Ціна": "100" }, set: { "Ціна": "1" } }, { key: "104", expect: { "Ціна": "103" }, set: { "Ціна": "4" } }];
  const r = await s.updateByKey({ title: T, changes: ch, generation: "p" });
  assert.equal(r.outcome, OP.UNKNOWN, "частина застосована, друга — невідомо: запит ще може застосуватися");
  assert.equal(s.state, "RECONCILE_REQUIRED");
  await assert.rejects(s.updateByKey({ title: T, changes: [{ key: "105", expect: { "Ціна": "104" }, set: { "Ціна": "5" } }] }), /RECONCILE_REQUIRED/);
  assert.equal((await s.reconcile())[0].result, "PENDING_SETTLE", "до кінця вікна — не з'ясовується");
  t += 200_001;
  const rec = await s.reconcile();
  assert.equal(rec[0].result, OP.PARTIAL);
  assert.equal(s.state, "READY");
  const fin = await s.updateByKey({ title: T, changes: ch, generation: "p" });
  assert.equal(fin.outcome, OP.VERIFIED, "довиконання: застосована частина — ALREADY, решта дописана");
  assert.equal(cell(sh, "101", "Ціна"), "1");
  assert.equal(cell(sh, "104", "Ціна"), "4");
  await s.close();
});

test("E2: дописування за ключем — втрачена відповідь без дубля; повтор нічого не дописує", async () => {
  const sh = new MemorySheets(book());
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: new MemoryStore(), now: () => 5 });
  const s = await gw.open({ writer: "sync" });
  sh.armFault({ op: "appendRows", mode: "lost" });
  const rows = [["201", "s201", "", "", "1", "+", "[]", ""]];
  const r = await s.appendMissingByKey({ title: T, rows });
  assert.equal(r.outcome, OP.VERIFIED);
  assert.equal((await s.appendMissingByKey({ title: T, rows })).outcome, OP.NOTHING);
  assert.equal(sh.book[T].filter((x) => x[0] === "201").length, 1);
  await assert.rejects(appendMissingByKey({ sheets: sh, read: (n) => sh.read(n), contract, writer: "content-html", title: T, rows }), /не має права дописувати/);
  await s.close();
});

test("E2: знімок аргументів — getter ключа читається один раз (R3-F4)", async () => {
  const sh = new MemorySheets(book());
  let n = 0;
  const change = { get key() { n++; return n === 1 ? "101" : "105"; }, expect: { "Ціна": "100" }, set: { "Ціна": "7" } };
  assert.equal((await keyedUpdate(ctx(sh, { changes: [change] }))).outcome, OP.VERIFIED);
  assert.equal(n, 1);
  assert.equal(cell(sh, "101", "Ціна"), "7");
  assert.equal(cell(sh, "105", "Ціна"), "104");
});
