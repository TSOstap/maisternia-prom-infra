/** Catalog Controls — безпекові тести після BLOCK Hermes (independent-20261029T004607):
 *  F0 (видалення рядків), P1 (невідомий результат / відкат), P2 (запис за позицією), P3 (автоповтор writer), P4 (скасування при іншій
 *  картці — у controls-exclusions.test.mjs), повтори Operation ID, довиконання після збою, життєвий цикл аркушів, активація й
 *  контрольна точка, повтор без змін, сумісність із майбутнім спільним механізмом. */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { YML_HEADERS } from "../src/core/seal.mjs";
import { CONTENT_COLUMNS, SHEET } from "../src/core/sheet-sync.mjs";
import { ACTION, CC_INPUT_COLUMNS, CC_SHEET, HISTORY_HEADERS, SALE_DECISION, SEO_DECISION, historySeal } from "../src/core/controls-common.mjs";
import { controlsState } from "../src/core/controls-plan.mjs";
import * as runModule from "../src/pipeline/controls-run.mjs";
import { CHECKPOINT_KEY, CONTROLS_SHEETS } from "../src/pipeline/controls-run.mjs";
import { GoogleSheetsWriter, MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { ACTIVE_CONTRACT, FlakySheets, MemoryStore, STAMP, prepared, run, confirm, codeOf, viewOf, rowOf, mainRows, eventsOf, history, setCells, spy, touchedMain, later } from "./helpers/controls.mjs";

const ID = "1500000007", ID2 = "1500000014";
const HOLD = "ЗНЯТИ З ПРОДАЖУ", DEL = `ВИДАЛИТИ ТОВАР ${ID}`, BACK = `ПОВЕРНУТИ З АРХІВУ ${ID}`;
const stateOf = (w, extra = {}) => controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: w.store.data.get(CHECKPOINT_KEY) ?? null, ...extra });
const noMainWrites = (seen) => seen.filter((c) => c.op === "deleteRows" || ((c.op === "appendRows" || c.op === "updateRanges") && c.title === SHEET.main));

/** Знято з продажу; у клітинці — підтверджена команда виключення (ще не виконана). */
async function readyToTombstone() {
  const w = await prepared();
  await confirm(w, ID, SALE_DECISION, HOLD);
  setCells(w, ID, { [SALE_DECISION]: DEL });
  await run(w, { stamp: later(1) });
  setCells(w, ID, { [SALE_DECISION]: `${DEL} ${codeOf(w, ID, DEL)}` });
  return w;
}

test("F0: у жодному сценарії (зняття, виключення, скасування, SEO, збої) немає deleteRows і жодного запису в «Основний каталог»", async () => {
  const w = await readyToTombstone();
  const flaky = new FlakySheets(w.book).on("appendRows", 1, "lost").on("appendRows", 3, "retry");
  w.sheets = flaky;
  await run(w, { stamp: later(2) });
  setCells(w, ID, { [SALE_DECISION]: BACK });
  await run(w, { stamp: later(3) });
  setCells(w, ID, { [SALE_DECISION]: `${BACK} ${codeOf(w, ID, BACK)}` });
  await run(w, { stamp: later(4) });
  setCells(w, ID2, { "SEO заголовок UA": "Заголовок", [SEO_DECISION]: "ЗАТВЕРДИТИ" });
  await run(w, { stamp: later(5) });
  setCells(w, ID2, { [SEO_DECISION]: `ЗАТВЕРДИТИ ${codeOf(w, ID2, "ЗАТВЕРДИТИ")}` });
  await run(w, { stamp: later(6) });
  assert.deepEqual(noMainWrites(flaky.seen), []);
  assert.ok(!flaky.seen.some((c) => c.op === "deleteRows"));
  const ops = (id, a) => new Set(eventsOf(w, id, a).map((r) => r[1])).size; // дубль від автоповтору — та сама операція
  assert.equal(ops(ID, ACTION.TOMBSTONE), 1);
  assert.equal(ops(ID, ACTION.UNTOMBSTONE), 1);
  assert.equal(ops(ID2, ACTION.SEO_APPROVED), 1);
  assert.ok(!stateOf(w).tombstoned.has(ID));
});

test("P1: читання для перевірки після запису не вдалося → UNKNOWN (нічого не вважається підтвердженим); наступний запуск — COMMITTED без дублів; виключення чинне лише з подією журналу", async () => {
  const w = await readyToTombstone();
  let failed = false;
  const readBook = async (names) => {
    if (!failed && names.length === CONTROLS_SHEETS.length && w.sheets.calls.some((c) => c.op === "appendRows")) { failed = true; throw new Error("імітовано: читання не вдалося"); }
    return structuredClone(w.book);
  };
  w.sheets.calls.length = 0;
  const r = await run(w, { stamp: later(2), readBook });
  assert.equal(r.state, "UNKNOWN", JSON.stringify(r));
  assert.equal(w.store.data.get(CHECKPOINT_KEY).ops.length, 1, "контрольну точку не оновлено (лише раніше підтверджене зняття)");
  const r2 = await run(w, { stamp: later(3) });
  assert.equal(r2.state, "COMMITTED");
  assert.equal(eventsOf(w, ID, ACTION.TOMBSTONE).length, 1, "без дублів");
  assert.ok(r2.tombstoned.has(ID));
  assert.equal(w.store.data.get(CHECKPOINT_KEY).ops.length, 2);
  // Помилка першого читання — READ_FAILED, нічого не записано.
  const snap = structuredClone(w.book);
  assert.equal((await run(w, { readBook: async () => { throw new Error("x"); } })).state, "READ_FAILED");
  assert.deepEqual(w.book, snap);
});

test("P2: рядок вставлено / рядки пересортовано в «Основному каталозі» між читаннями — Catalog Controls у каталог не пише: чужий рядок і його команда незмінні; ціль оброблено за Offer ID", async () => {
  const w = await prepared();
  setCells(w, ID, { "SEO заголовок UA": "Ціль", [SEO_DECISION]: "ЗАТВЕРДИТИ" });
  await run(w);
  setCells(w, ID, { [SEO_DECISION]: `ЗАТВЕРДИТИ ${codeOf(w, ID, "ЗАТВЕРДИТИ")}` });
  const h = w.book[SHEET.main][0];
  const foreign = w.book[SHEET.main].find((x) => x[0] === ID).slice();
  foreign[0] = "1599999999"; foreign[h.indexOf("SEO заголовок UA")] = "Чернетка іншого власника"; foreign[h.indexOf(SEO_DECISION)] = "ЗАТВЕРДИТИ";
  const flaky = new FlakySheets(w.book).on("appendRows", 1, "shift", { title: SHEET.main, at: 1, row: foreign });
  w.sheets = flaky;
  // ще й пересортувати рядки перед записом
  w.book[SHEET.main] = [w.book[SHEET.main][0], ...w.book[SHEET.main].slice(1).reverse()];
  const r = await run(w, { stamp: later(1) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  const f = rowOf(w, "1599999999");
  assert.equal(f[SEO_DECISION], "ЗАТВЕРДИТИ", "команда чужого рядка не зачеплена");
  assert.equal(f["SEO заголовок UA"], "Чернетка іншого власника");
  assert.deepEqual(noMainWrites(flaky.seen), []);
  assert.equal(eventsOf(w, ID, ACTION.SEO_APPROVED).length, 1);
  assert.equal(eventsOf(w, "1599999999").length, 0);
});

/** Мінімальна імітація Sheets REST для справжнього GoogleSheetsWriter: append / values:batchUpdate / addSheet; deleteDimension — заборонено. */
function fakeApi(book, { loseFirstAppend = false } = {}) {
  const log = [], stats = { lostApplied: 0 };
  let lost = !loseFirstAppend;
  const col = (letters) => [...letters].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
  const parse = (range) => { const m = /^'((?:[^']|'')*)'!([A-Z]+)(\d+)/.exec(range); return { title: m[1].replace(/''/g, "'"), c: col(m[2]), r: Number(m[3]) }; };
  const ok = (x) => ({ ok: true, status: 200, text: async () => JSON.stringify(x) });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    log.push({ method: opts.method, path: decodeURIComponent(u.pathname), maxAttempts: writer.maxAttempts });
    if (opts.method === "GET") return ok({ sheets: Object.keys(book).map((t, i) => ({ properties: { title: t, sheetId: i, gridProperties: { rowCount: 1000, columnCount: 60 } } })) });
    const p = decodeURIComponent(u.pathname);
    if (p.endsWith(":append")) {
      const { title } = parse(p.split("/values/")[1]);
      const sheet = book[title]; let last = sheet.length;
      while (last > 1 && !(sheet[last - 1] || []).some((v) => v !== "" && v != null)) last--;
      sheet.splice(last, 0, ...body.values.map((r) => r.slice()));
      if (!lost) { lost = true; stats.lostApplied++; throw new Error("імітовано: мережа (запит застосовано, відповідь втрачено)"); }
      return ok({});
    }
    if (p.endsWith("/values:batchUpdate")) {
      for (const d of body.data) { const { title, c, r } = parse(d.range); d.values.forEach((row, i) => { const t = (book[title][r - 1 + i] ||= []); row.forEach((v, j) => { while (t.length < c - 1 + j) t.push(""); t[c - 1 + j] = v; }); }); }
      return ok({});
    }
    if (p.endsWith(":batchUpdate")) {
      for (const q of body.requests) { if (q.deleteDimension) throw new Error("deleteDimension заборонено"); if (q.addSheet) book[q.addSheet.properties.title] = []; }
      return ok({ replies: [] });
    }
    throw new Error("невідомий запит " + p);
  };
  const writer = new GoogleSheetsWriter({ spreadsheetId: "TEST_COPY_FAKE_0000000000000000", liveSpreadsheetId: "LIVE_FAKE_BLOCKED_000000000000000", getAccessToken: async () => "synthetic", fetchImpl, sleep: async () => {}, maxRequests: 200 });
  return { writer, log, stats };
}

test("P3: справжній GoogleSheetsWriter — дописування застосовано, відповідь втрачено: зі сліпим повтором (дубль у журналі) або без нього (E1, один рядок) — одна подія за Operation ID, без пошкодження, без повторного дописування; політика повторів writer не змінюється; once() прибрано", async () => {
  const w = await prepared();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  await run(w, { sheets: new MemorySheets(w.book) });
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
  const { writer, log, stats } = fakeApi(w.book, { loseFirstAppend: true });
  const m0 = writer.maxAttempts;
  const r = await run(w, { stamp: later(1), sheets: writer });
  // CC4-E1-TEST: передумова — сам збій «застосовано, відповідь втрачено», а не сліпий повтор writer (E1 його прибирає).
  assert.equal(stats.lostApplied, 1, "передумова: запит застосовано, відповідь втрачено");
  assert.ok(r.held.has(ID), "захисна дія діє одразу");
  const holds = () => history(w).filter((x) => x[3] === ACTION.HOLD);
  const n = holds().length;
  assert.ok(n === 1 || n === 2, `рядків HOLD: ${n} (1 — без сліпого повтору, 2 — writer повторив)`);
  assert.equal(new Set(holds().map((x) => x[1])).size, 1, "той самий Operation ID");
  if (n === 2) assert.equal(r.state, "COMMITTED", "дубль від повтору writer згорнуто в тому самому запуску: " + JSON.stringify(r));
  const r2 = await run(w, { stamp: later(2), sheets: writer });
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2));
  assert.equal(holds().length, n, "звірка не дописує рядок, що вже застосовано");
  assert.ok(r2.held.has(ID));
  assert.equal(stateOf(w).damaged.size, 0, "дубль — не пошкодження");
  assert.ok(log.every((x) => x.maxAttempts === m0), "політика повторів writer не змінювалась");
  assert.equal("once" in runModule, false);
  assert.ok(!log.some((x) => x.path.includes("deleteDimension")));
});

test("Operation ID: дубль рядка — один ефект; той самий ID з іншим вмістом — пошкодження; сортування журналу — той самий стан; видалений проміжний рядок (пропуск покоління) — пошкодження", async () => {
  const w = await prepared();
  await confirm(w, ID, SALE_DECISION, HOLD);
  await confirm(w, ID, SALE_DECISION, "ПОВЕРНУТИ В ПРОДАЖ", { stamp: later(1) });
  await confirm(w, ID, SALE_DECISION, HOLD, { stamp: later(2) });
  const base = { contract: { ...ACTIVE_CONTRACT, activated: false } };
  const clone = () => structuredClone(w.book);
  const a = clone(); a[CC_SHEET.history].push(a[CC_SHEET.history][1].slice());
  assert.ok(controlsState(a, base).held.has(ID) && !controlsState(a, base).damaged.size);
  const b = clone(); const forged = b[CC_SHEET.history][1].slice(); forged[7] = "інша причина"; forged[9] = historySeal(forged); b[CC_SHEET.history].push(forged);
  assert.ok(controlsState(b, base).damaged.has(ID), "той самий Operation ID, інший вміст");
  const c = clone(); c[CC_SHEET.history] = [c[CC_SHEET.history][0], ...c[CC_SHEET.history].slice(1).reverse()];
  assert.equal(controlsState(c, base).fingerprint, controlsState(clone(), base).fingerprint, "порядок рядків не важливий");
  const d = clone(); d[CC_SHEET.history] = d[CC_SHEET.history].filter((r) => r[3] !== ACTION.RELEASE);
  assert.ok(controlsState(d, base).damaged.has(ID), "пропуск покоління");
  assert.ok(controlsState(d, base).held.has(ID), "fail-closed");
});

/** Writer, у якому дописування в «Історію керування» не виконується (решта — як MemorySheets). */
const historyAppendFails = (w) => { const s = spy(new MemorySheets(w.book)); return { ...s, appendRows: async (t, rows) => { if (t === CC_SHEET.history) throw new Error("імітовано: append журналу не виконано"); return s.appendRows(t, rows); } }; };

test("Довиконання (roll-forward): намір видалення записано в точку, подію в журнал — ні → PENDING; товар поза продажем і в реєстрі (фільтр новинок); наступний запуск з тією самою командою — COMMITTED без дубля (R5: знімків немає)", async () => {
  const w = await readyToTombstone();
  w.sheets = historyAppendFails(w);
  const r = await run(w, { stamp: later(2) });
  assert.equal(r.state, "PENDING", JSON.stringify(r));
  assert.equal(r.tombstoned.get(ID)?.confirmed, false, "видалення ще не підтверджене");
  assert.ok(r.held.has(ID) && r.gate.knownIds.has(ID), "довірений намір діє одразу: поза продажем і повторне додавання заборонене");
  assert.match(viewOf(w, ID)["Виключення"], /ВИДАЛЕННЯ ЗАПИСАНО НАМІРОМ/);
  w.sheets = spy(new MemorySheets(w.book));
  const r2 = await run(w, { stamp: later(3) });
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2));
  assert.deepEqual([r2.tombstoned.get(ID)?.confirmed, r2.tombstoned.get(ID)?.stage], [true, "REGISTERED"]);
  assert.equal(eventsOf(w, ID, ACTION.TOMBSTONE).length, 1, "без дубля події");
});

test("Подію видалення не дописано (журнал падає щоразу) — видалення не підтверджене, результат PENDING; товар лишається знятим; доказу для перенесення в архів немає", async () => {
  const w = await readyToTombstone();
  w.sheets = historyAppendFails(w);
  const r = await run(w, { stamp: later(2) });
  assert.equal(r.state, "PENDING");
  assert.equal(eventsOf(w, ID, ACTION.TOMBSTONE).length, 0);
  assert.notEqual(r.tombstoned.get(ID)?.confirmed, true);
  assert.ok(r.held.has(ID));
  assert.deepEqual(r.moves.toArchive, [], "непідтверджене видалення не переноситься в архів");
  assert.deepEqual(stateOf(w, { publication: new Map([[ID, { feed: "unavailable", promConfirmed: false }]]) }).moves.toArchive, [], "навіть із доказом «немає в наявності»");
});

test("Підроблені події: виключення без попереднього зняття або повернення в продаж виключеного — пошкодження (fail-closed); команда «ПОВЕРНУТИ В ПРОДАЖ» для виключеного — відмова", async () => {
  const w = await readyToTombstone();
  await run(w, { stamp: later(2) });
  const { confirmationCode, identityOf, historyRow } = await import("../src/core/controls-common.mjs");
  const p = controlsState(structuredClone(w.book), { contract: { ...ACTIVE_CONTRACT, activated: false } });
  assert.ok(p.tombstoned.has(ID));
  // відмова: код повернення в продаж для виключеного (обчислено так само, як модуль)
  const rev = history(w).filter((r) => r[2] === ID && /^sale:/.test(r[8])).sort((a, b) => a[8].localeCompare(b[8])).at(-1)[1];
  const code = confirmationCode({ offerId: ID, identity: identityOf(rowOf(w, ID)), action: "RELEASE", revision: rev });
  setCells(w, ID, { [SALE_DECISION]: `ПОВЕРНУТИ В ПРОДАЖ ${code}` });
  await run(w, { stamp: later(3) });
  assert.match(viewOf(w, ID)["Попередження"], /товар видалено — спершу «ПОВЕРНУТИ З АРХІВУ/);
  assert.ok(stateOf(w).tombstoned.has(ID));
  // підроблена подія RELEASE поверх виключення (з правильною печаткою) — пошкодження
  const forged = historyRow({ stamp: later(4), opId: "op-forged000000000000000001", offerId: ID, action: ACTION.RELEASE, field: "Продаж", before: "ЗНЯТО", after: "У ПРОДАЖУ", reason: "підробка", generation: "sale:3" });
  const b = structuredClone(w.book); b[CC_SHEET.history].push(forged);
  const sb = controlsState(b, { contract: { ...ACTIVE_CONTRACT, activated: false } });
  assert.ok(sb.damaged.has(ID) && sb.held.has(ID));
  // R4 → R5: рядок видалення прибрано з журналу + підроблене повернення в продаж — реєстр у контрольній точці тримає видалення
  // (знімків «Виключені назавжди» немає; захист не залежить від рядків аркушів).
  const o = structuredClone(w.book);
  o[CC_SHEET.history] = o[CC_SHEET.history].filter((r) => r[3] !== ACTION.TOMBSTONE);
  o[CC_SHEET.history].push(historyRow({ stamp: later(4), opId: "op-forged000000000000000003", offerId: ID, action: ACTION.RELEASE, field: "Продаж", before: "ЗНЯТО", after: "У ПРОДАЖУ", reason: "підробка", generation: "sale:2" }));
  const so = controlsState(o, { contract: ACTIVE_CONTRACT, checkpoint: w.store.data.get(CHECKPOINT_KEY) });
  assert.equal(so.blocked, false);
  assert.equal(so.tombstoned.get(ID)?.confirmed, true, "видалення з довіреного реєстру");
  assert.ok(so.held.has(ID) && so.damaged.has(ID) && so.gate.knownIds.has(ID), "поза продажем, ізольовано, повторне додавання заборонене");
  // R5: підроблене «ПОВЕРНУТО З АРХІВУ» для товару, якого не видаляли, — пошкодження
  const u = structuredClone(w.book);
  u[CC_SHEET.history].push(historyRow({ stamp: later(4), opId: "op-forged000000000000000004", offerId: ID2, action: ACTION.UNTOMBSTONE, field: "Каталог", before: "op-none", after: "", reason: "підробка", generation: "sale:1" }));
  const su = controlsState(u, { contract: { ...ACTIVE_CONTRACT, activated: false } });
  assert.ok(su.damaged.has(ID2) && su.held.has(ID2), "повернення з архіву без видалення — неможливий перехід");
  // підроблене виключення без зняття
  const c = structuredClone(w.book);
  c[CC_SHEET.history].push(historyRow({ stamp: later(4), opId: "op-forged000000000000000002", offerId: ID2, action: ACTION.TOMBSTONE, field: "Публікація", after: JSON.stringify(identityOf(rowOf(w, ID2))), generation: "sale:1" }));
  assert.ok(controlsState(c, { contract: { ...ACTIVE_CONTRACT, activated: false } }).damaged.has(ID2));
});

test("Незавершене видалення, власник змінив команду — захисний намір довиконується (fail-closed), потім скасовується кодом «ПОВЕРНУТИ З АРХІВУ»; товар лишається знятим з продажу; нове видалення з новим кодом — нова операція (R5: замість знімків — події журналу)", async () => {
  const w = await readyToTombstone();
  w.sheets = historyAppendFails(w);
  await run(w, { stamp: later(2) });
  w.sheets = spy(new MemorySheets(w.book));
  setCells(w, ID, { [SALE_DECISION]: BACK });
  const r0 = await run(w, { stamp: later(3) });
  assert.equal(r0.tombstoned.get(ID)?.confirmed, true, "захисний намір не губиться через зміну клітинки");
  setCells(w, ID, { [SALE_DECISION]: `${BACK} ${codeOf(w, ID, BACK)}` });
  const r = await run(w, { stamp: later(4) });
  assert.ok(!r.tombstoned.has(ID), "видалення скасовано");
  assert.ok(r.held.has(ID), "повернення з архіву не повертає в продаж");
  setCells(w, ID, { [SALE_DECISION]: DEL });
  await run(w, { stamp: later(5) });
  setCells(w, ID, { [SALE_DECISION]: `${DEL} ${codeOf(w, ID, DEL)}` });
  const r2 = await run(w, { stamp: later(6) });
  assert.deepEqual([r2.tombstoned.get(ID)?.confirmed, r2.tombstoned.get(ID)?.stage], [true, "REGISTERED"]);
  const ops = new Set(eventsOf(w, ID, ACTION.TOMBSTONE).map((x) => x[1]));
  assert.equal(ops.size, 2, "старе видалення лишилося в історії, нове — окрема операція");
  assert.equal(eventsOf(w, ID, ACTION.UNTOMBSTONE).length, 1);
});

test("Життєвий цикл аркушів: аркуш створено, заголовок не записано (відповідь втрачено) → наступний запуск дописує заголовок і продовжує; часткове дописування порції — без дублів", async () => {
  const w = await prepared();
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  await run(w); // коди
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${codeOf(w, ID, HOLD)}` });
  // (а) журнал ще не існує: створено, заголовок не записано
  w.sheets = new FlakySheets(w.book).on("ensureSheet", 1, "headerless");
  const r = await run(w, { stamp: later(1) });
  assert.equal(r.state, "PENDING", JSON.stringify(r));
  assert.deepEqual(w.book[CC_SHEET.history], [[]], "аркуш журналу без заголовка");
  assert.equal(stateOf(w).blocked, false, "порожній аркуш без заголовка — ще без подій, а не пошкодження");
  w.sheets = new FlakySheets(w.book);
  const r2 = await run(w, { stamp: later(2) });
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2));
  assert.deepEqual(w.book[CC_SHEET.history][0], HISTORY_HEADERS.slice());
  assert.ok(r2.held.has(ID));
  // (б) часткова порція: дві події, застосовано лише першу
  setCells(w, ID2, { [SALE_DECISION]: HOLD });
  setCells(w, "1500000021", { [SALE_DECISION]: HOLD });
  await run(w, { stamp: later(3) });
  for (const id of [ID2, "1500000021"]) setCells(w, id, { [SALE_DECISION]: `${HOLD} ${codeOf(w, id, HOLD)}` });
  w.sheets = new FlakySheets(w.book).on("appendRows", 1, "partial");
  const r3 = await run(w, { stamp: later(4) });
  assert.equal(r3.state, "COMMITTED", JSON.stringify(r3));
  assert.equal(history(w).length, 3, "три події, без дублів");
  assert.ok(r3.held.has(ID2) && r3.held.has("1500000021"));
});

test("Активація й контрольна точка: без сховища — NOT_READY; сховище не читається — NOT_READY; точки немає, а журнал є — BLOCKED; журнал обрізано — товар ізольовано й рядок дописано з точки (R5-D); точка застарілого формату — BLOCKED і стан для конвеєра blocked", async () => {
  const w = await prepared();
  await confirm(w, ID, SALE_DECISION, HOLD);
  // R3: apply бере сховище лише з readiness (W2); сховище без CAS або недоступне — NOT_READY до будь-яких записів.
  assert.equal((await run(w, { readiness: { ...w.readiness, store: null } })).state, "NOT_READY");
  const bad = new MemoryStore(); bad.failGet = true;
  assert.equal((await run(w, { readiness: { ...w.readiness, store: bad } })).state, "NOT_READY");
  const fresh = new MemoryStore(); fresh.fence = w.store.fence; // R4: сховище W2 з fencing тієї самої служби оренд
  assert.match((await run(w, { readiness: { ...w.readiness, store: fresh } })).reason, /контрольної точки немає, а журнал має записи/);
  assert.equal(w.store.data.get(CHECKPOINT_KEY).ops.length, 1);
  const op = history(w)[0][1];
  w.book[CC_SHEET.history] = [w.book[CC_SHEET.history][0]];
  // R4 → R5 (рішення D): обрізаний журнал — дзеркало; довірений запис у точці. Товар ізольовано до дописування, без загальної зупинки.
  const cut = stateOf(w);
  assert.equal(cut.blocked, false);
  assert.ok(cut.held.has(ID) && cut.damaged.has(ID));
  const r = await run(w, { stamp: later(1) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.deepEqual(history(w).map((x) => x[1]), [op], "рядок дописано з точки");
  assert.ok(stateOf(w).held.has(ID) && !stateOf(w).damaged.has(ID));
  // Глобальна зупинка — лише коли стан інших товарів не визначити (точка недійсна / застарілого формату).
  const cp = w.store.data.get(CHECKPOINT_KEY);
  w.store.data.set(CHECKPOINT_KEY, { ...structuredClone(cp), v: 3 });
  const rb = await run(w, { stamp: later(2) });
  assert.equal(rb.state, "BLOCKED", JSON.stringify(rb));
  assert.match(rb.reason, /застарілого формату/);
  assert.equal(stateOf(w).blocked, true);
  w.store.data.set(CHECKPOINT_KEY, cp);
  assert.equal((await run(w, { stamp: later(3) })).state, "COMMITTED");
});

test("Повтор без змін — жодного запису в аркуші й у контрольну точку; «Стан керування» детермінований", async () => {
  const w = await prepared();
  await confirm(w, ID, SALE_DECISION, HOLD);
  // Службовий ключ перевірки готовності (W2 store) оновлюється кожним apply — це не стан керування.
  const PROBE_KEY = "state/catalog-controls/readiness-probe.json";
  const cpOnly = () => structuredClone([...w.store.data].filter(([k]) => k !== PROBE_KEY));
  const store0 = cpOnly();
  w.sheets.calls.length = 0;
  const r = await run(w, { stamp: later(5) });
  assert.equal(r.state, "COMMITTED");
  assert.deepEqual(w.sheets.calls.filter((c) => ["appendRows", "updateRanges", "ensureSheet", "deleteRows"].includes(c.op)), []);
  assert.equal(r.view, "UNCHANGED");
  assert.equal(r.checkpoint, "UNCHANGED");
  assert.deepEqual(cpOnly(), store0);
});

test("Сумісність із майбутнім спільним механізмом: колонки власника — поза печаткою й колонками контенту (S1 може їх виключити з fullRows); стан для споживачів має стабільні поля; shadow працює без службових аркушів", async () => {
  for (const k of CC_INPUT_COLUMNS) { assert.ok(!YML_HEADERS.includes(k)); assert.ok(!CONTENT_COLUMNS.includes(k)); }
  const w = await prepared();
  const st0 = stateOf(w);
  // R5: allowRemove прибрано (фізичного вилучення немає — лише перенесення moves); issues — проблеми без глобальної зупинки.
  assert.deepEqual(Object.keys(st0).sort(), ["active", "blocked", "confirmed", "damaged", "fingerprint", "gate", "held", "issues", "moves", "reasons", "seo", "seoReady", "tombstoned", "unconfirmed"]);
  assert.equal(st0.seoReady, false, "SEO не готове до S1");
  const sh = await run(w, { mode: "shadow" });
  assert.equal(sh.state, "SHADOW");
  await confirm(w, ID, SALE_DECISION, HOLD);
  assert.notEqual(stateOf(w).fingerprint, st0.fingerprint, "відбиток змінюється разом зі станом");
  assert.equal(touchedMain(w.sheets.calls).length, 0);
  assert.deepEqual(HISTORY_HEADERS.slice(0, 3), ["Дата", "Operation ID", "Offer ID"]);
  assert.ok(mainRows(w).length > 0 && mtText(rowOf(w, ID)["Offer ID"]) === ID);
});
