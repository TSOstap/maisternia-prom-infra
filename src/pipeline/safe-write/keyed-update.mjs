/** E2 (ENG-01 K3 + K4) — запис клітинок за Offer ID, а не за старим номером рядка.
 *
 *  keyedUpdate: changes = [{ key, identity?: { колонка: значення }, expect: { колонка: поточне }, set: { колонка: нове } }]
 *   1. Аргументи копіюються в незмінну структуру ОДИН раз (getter / зміна об'єкта після перевірки не впливає — R3-F4).
 *   2. Право запису кожної колонки — за контрактом власності (до будь-якого запиту).
 *   3. Свіже читання аркуша; рядок — за ключем (дублікат ключа → відмова); ідентичність (identity) і очікувані значення (expect)
 *      мають збігтися з поточними — інакше CONFLICT / IDENTITY_MISMATCH, клітинки НЕ пишуться (паралельна правка людини зберігається).
 *   4. Запис лише цільових клітинок (суміжні колонки рядка — одним блоком); перед відправленням — assertCurrent() оренди.
 *   5. Перевірка після запису — свіжим читанням ЗА КЛЮЧЕМ: VERIFIED / NOT_APPLIED / CHANGED. Окремо — чи не потрапили наші значення
 *      в ЧУЖИЙ рядок (сортування / вставка між читанням і записом): MISPLACED → NEEDS_DECISION, із попередніми значеннями
 *      ураженого рядка для компенсації за ключем (compensateMisplaced). Видалень рядків немає.
 *
 *  ЧЕСНА МЕЖА (ENG-06): Google Sheets API не має умовного запису (CAS) і ізоляції від правок людей. Перевірка expect перед
 *  записом і перевірка після запису ВИЯВЛЯЮТЬ гонку, але не роблять запис атомарним щодо людини, яка править / сортує таблицю
 *  в мілісекундному вікні між читанням і записом. Виявлене — компенсується за ключем або зупиняє роботу до рішення. */
import { mtText } from "../../core/text.mjs";
import { OUTCOME, WriteOutcomeError, outcomeOf } from "../write-outcome.mjs";
import { assertWritable, gatedColumns, consumeColumns } from "./ownership.mjs";
import { readState, STATE_COLUMN, SRC } from "../../core/field-control.mjs";
import { opIdOf } from "./journal.mjs";

export const ITEM = Object.freeze({
  VERIFIED: "VERIFIED", ALREADY: "ALREADY", NOT_APPLIED: "NOT_APPLIED", CONFLICT: "CONFLICT", IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  MISSING: "MISSING", CHANGED: "CHANGED", VANISHED: "VANISHED", FIELD_CUSTOM: "FIELD_CUSTOM",
});
export const OP = Object.freeze({ VERIFIED: "VERIFIED", NOTHING: "NOTHING", NOT_APPLIED: "NOT_APPLIED", PARTIAL: "PARTIAL", NEEDS_DECISION: "NEEDS_DECISION", UNKNOWN: "UNKNOWN" });
/** Вікно, протягом якого запит із невідомим результатом ще може застосуватися: максимальний час обробки запиту Google (офіційно
 *  180 с: «When Sheets processes a request for more than 180 seconds, the request returns a timeout error») + запас. */
export const SETTLE_MS = 200_000;

const t = (v) => mtText(v);
const fail = (code, message) => new WriteOutcomeError(message, { outcome: OUTCOME.NOT_APPLIED, op: "keyedUpdate", code });

/** Незмінний знімок аргументів (лише власні дані, без посилань на об'єкти викликача). */
function snapshot(changes) {
  if (!Array.isArray(changes)) throw fail("BAD_ARGS", "changes має бути масивом");
  return Object.freeze(changes.map((c) => {
    const key = t(c?.key);
    if (!key) throw fail("BAD_ARGS", "зміна без ключа");
    const set = {}, expect = {}, identity = {};
    for (const [k, v] of Object.entries(c.set || {})) set[String(k)] = typeof v === "number" ? v : String(v ?? "");
    for (const [k, v] of Object.entries(c.expect || {})) expect[String(k)] = String(v ?? "");
    for (const [k, v] of Object.entries(c.identity || {})) identity[String(k)] = String(v ?? "");
    const cols = Object.keys(set);
    if (!cols.length) throw fail("BAD_ARGS", `зміна ${key} без колонок`);
    const noExpect = cols.filter((k) => !(k in expect));
    if (noExpect.length) throw fail("NO_EXPECT", `зміна ${key}: для ${noExpect.join(", ")} немає очікуваного поточного значення — без нього паралельну правку не виявити`);
    return Object.freeze({ key, set: Object.freeze(set), expect: Object.freeze(expect), identity: Object.freeze(identity), cols: Object.freeze(cols) });
  }));
}

function indexOf(values, keyCol) {
  const idx = new Map(), dup = new Set();
  for (let i = 1; i < values.length; i++) {
    const k = t(values[i]?.[keyCol]);
    if (!k) continue;
    if (idx.has(k)) dup.add(k); else idx.set(k, i + 1); // номер рядка аркуша (з 1)
  }
  return { idx, dup };
}
const cellsOf = (row, header, cols) => Object.fromEntries(cols.map((c) => [c, t(row?.[header.indexOf(c)])]));
const same = (a, b, cols) => cols.every((c) => t(a[c]) === t(b[c]));

/** Блоки запису: суміжні колонки одного рядка — один прямокутник. */
function blocksFor(title, header, items) {
  const out = [];
  for (const it of items) {
    const cols = [...it.cols].sort((a, b) => header.indexOf(a) - header.indexOf(b));
    let run = [];
    const flush = () => { if (run.length) out.push({ title, row: it.row, col: header.indexOf(run[0]) + 1, values: [run.map((c) => it.set[c])] }); run = []; };
    for (const c of cols) { if (run.length && header.indexOf(c) !== header.indexOf(run.at(-1)) + 1) flush(); run.push(c); }
    flush();
  }
  return out;
}

/**
 * @param {object} o
 * @param {object} o.sheets        транспорт (GoogleSheetsWriter | MemorySheets): updateRanges
 * @param {(names: string[]) => Promise<object>} o.read  свіже читання аркушів
 * @param {object} o.contract      контракт власності (loadOwnership)
 * @param {string} o.writer        записувач (sync, content-html, …)
 * @param {string} o.title         аркуш
 * @param {Array} o.changes
 * @param {() => Promise<void>} [o.assertCurrent]  перевірка оренди перед відправленням
 * @param {import("./journal.mjs").OpJournal} [o.journal]
 * @param {object} [o.lease]       оренда (для журналу)
 * @param {string} [o.generation]  покоління джерела (входить у opId)
 */
export async function keyedUpdate({ sheets, read, contract, writer, title, changes, assertCurrent = async () => {}, journal = null, lease = null, generation = "", now = Date.now, settleMs = SETTLE_MS }) {
  const T = String(title), W = String(writer);
  const ch = snapshot(changes);
  const allCols = [...new Set(ch.flatMap((c) => [...c.cols, ...Object.keys(c.identity)]))];
  const spec = assertWritable(contract, T, W, [...new Set(ch.flatMap((c) => c.cols))]);
  const keyColumn = spec.key;
  const gates = gatedColumns(contract, T);
  // ENG-22 (F05): рішення власника (cmd-consume) — лише очищення клітинки з непорожньою очікуваною командою.
  const consume = consumeColumns(contract, T);
  const badConsume = ch.flatMap((c) => c.cols.filter((k) => consume.has(k) && (t(c.set[k]) !== "" || !t(c.expect[k]))).map((k) => c.key + ": «" + k + "»"));
  if (badConsume.length) throw fail("CMD_CONSUME", "колонку рішення власника можна лише очистити після споживання команди (expect — сама команда): " + badConsume.slice(0, 5).join(", "));
  const opId = opIdOf({ kind: "update", writer: W, resource: journal?.resource || "", title: T, keyColumn, generation: String(generation), changes: ch });

  if (journal) {
    const st = (await journal.state())[opId];
    if (st?.phase === OP.VERIFIED || st?.phase === "RECONCILED" && st.detail?.result === OP.VERIFIED) return { opId, outcome: OP.VERIFIED, repeated: true, items: [], misplaced: [] };
    if (st && ["INTENT", "UNKNOWN", "PARTIAL"].includes(st.phase)) throw fail("UNRESOLVED", `операція ${opId} має невідомий результат — спершу з'ясування (reconcile)`);
  }

  // 1. Свіже читання й план.
  const before = (await read([T]))[T];
  if (!before?.length) throw fail("NO_SHEET", `аркуш «${T}» порожній або відсутній`);
  const header = before[0].map(t);
  const kc = header.indexOf(keyColumn);
  if (kc < 0) throw fail("NO_KEY_COLUMN", `немає ключової колонки «${keyColumn}»`);
  const missingCols = allCols.filter((c) => !header.includes(c));
  if (missingCols.length) throw fail("NO_COLUMN", `немає колонок ${missingCols.join(", ")}`);
  const { idx, dup } = indexOf(before, kc);
  const dupHit = ch.filter((c) => dup.has(c.key)).map((c) => c.key);
  if (dupHit.length) throw fail("KEY_DUPLICATE", `ключ ${dupHit.join(", ")} зустрічається в аркуші більше одного разу — адресація неоднозначна`);

  const items = [], todo = [];
  for (const c of ch) {
    const row = idx.get(c.key);
    if (!row) { items.push({ key: c.key, status: ITEM.MISSING }); continue; }
    const cur = before[row - 1];
    const idNow = cellsOf(cur, header, Object.keys(c.identity));
    if (!same(idNow, c.identity, Object.keys(c.identity))) { items.push({ key: c.key, status: ITEM.IDENTITY_MISMATCH, row, actual: idNow }); continue; }
    // Ворота стану (пріоритет власника): кероване поле пишеться лише якщо у СВІЖОПРОЧИТАНОМУ рядку воно SUPPLIER.
    // Немає колонки стану / запису поля / стан пошкоджено — захисно не пишемо (FIELD_CUSTOM).
    const gated = c.cols.filter((k) => gates.has(k));
    if (gated.length) {
      const stNow = header.includes(STATE_COLUMN) ? readState(cur[header.indexOf(STATE_COLUMN)]) : null;
      const blocked = gated.filter((k) => !stNow || stNow.bad || stNow.f[k]?.s !== SRC.SUPPLIER);
      if (blocked.length) { items.push({ key: c.key, status: ITEM.FIELD_CUSTOM, row, fields: blocked }); continue; }
    }
    const now = cellsOf(cur, header, c.cols);
    if (same(now, Object.fromEntries(c.cols.map((k) => [k, c.set[k]])), c.cols)) { items.push({ key: c.key, status: ITEM.ALREADY, row }); continue; }
    if (!same(now, c.expect, c.cols)) { items.push({ key: c.key, status: ITEM.CONFLICT, row, actual: now, expect: c.expect }); continue; }
    const it = { key: c.key, row, cols: c.cols, set: c.set, expect: c.expect };
    todo.push(it); items.push({ key: c.key, status: "PENDING", row });
  }
  if (!todo.length) return { opId, outcome: items.some((x) => [ITEM.CONFLICT, ITEM.IDENTITY_MISMATCH, ITEM.MISSING, ITEM.FIELD_CUSTOM].includes(x.status)) ? OP.NOT_APPLIED : OP.NOTHING, items, misplaced: [] };

  // 2. Намір у журнал → перевірка оренди → запис.
  if (journal) await journal.append(lease, { opId, phase: "INTENT", writer: W, kind: "update", detail: { title: T, keyColumn, items: todo.map(({ key, row, cols, set, expect }) => ({ key, row, cols, set, expect })) } });
  let dispatch = OUTCOME.APPLIED, dispatchError = null;
  try {
    await assertCurrent();
    await sheets.updateRanges(blocksFor(T, header, todo));
  } catch (e) { dispatch = outcomeOf(e); dispatchError = e; }
  // Відмова до відправлення (оренда, межа запитів, 4xx): нічого не застосовано — журнал і вихід.
  if (dispatch === OUTCOME.NOT_APPLIED && !(dispatchError?.appliedParts > 0)) {
    if (journal) await journal.append(lease, { opId, phase: "NOT_APPLIED", writer: W, kind: "update", detail: { error: String(dispatchError?.message || "").slice(0, 300) } }).catch(() => {});
    for (const x of items) if (x.status === "PENDING") x.status = ITEM.NOT_APPLIED;
    return { opId, outcome: OP.NOT_APPLIED, items, misplaced: [], error: dispatchError };
  }

  // 3. Перевірка після запису — за ключем; пошук наших значень у чужих рядках.
  const after = (await read([T]))[T];
  const ah = after[0].map(t), akc = ah.indexOf(keyColumn);
  const aidx = indexOf(after, akc).idx;
  const preByKey = new Map([...idx].map(([k, r]) => [k, before[r - 1]]));
  const misplaced = [];
  for (const it of todo) {
    const x = items.find((y) => y.key === it.key && y.status === "PENDING");
    const r = aidx.get(it.key);
    if (!r) x.status = ITEM.VANISHED;
    else {
      const now = cellsOf(after[r - 1], ah, it.cols);
      x.status = same(now, it.set, it.cols) ? ITEM.VERIFIED : same(now, it.expect, it.cols) ? ITEM.NOT_APPLIED : ITEM.CHANGED;
      if (x.status === ITEM.CHANGED) x.actual = now;
    }
    // Наш запис ішов у рядок it.row. Якщо там тепер інший ключ і в ньому наші значення, яких у того товару не було, — потрапили в чужий.
    const keyAt = t(after[it.row - 1]?.[akc]);
    if (keyAt && keyAt !== it.key) {
      const there = cellsOf(after[it.row - 1], ah, it.cols);
      const prev = preByKey.has(keyAt) ? cellsOf(preByKey.get(keyAt), header, it.cols) : null;
      if (same(there, it.set, it.cols) && !(prev && same(prev, it.set, it.cols))) misplaced.push({ row: it.row, intendedKey: it.key, key: keyAt, cols: it.cols, written: it.set, previous: prev });
    }
  }
  const st = items.filter((x) => todo.some((y) => y.key === x.key)).map((x) => x.status);
  let outcome = misplaced.length || st.some((s) => s === ITEM.CHANGED || s === ITEM.VANISHED) ? OP.NEEDS_DECISION
    : st.every((s) => s === ITEM.VERIFIED) ? OP.VERIFIED
      : st.every((s) => s === ITEM.NOT_APPLIED) ? OP.NOT_APPLIED : OP.PARTIAL;
  // Невідомий результат запиту + клітинки ще без наших значень: Google може застосувати запит пізніше (до 180 с обробки) —
  // операція лишається UNKNOWN до кінця вікна settle; з'ясування (reconcile) і нові записи — лише після нього.
  let settleUntil = "";
  if (dispatch === OUTCOME.UNKNOWN && outcome !== OP.NEEDS_DECISION && st.includes(ITEM.NOT_APPLIED)) { outcome = OP.UNKNOWN; settleUntil = new Date(now() + settleMs).toISOString(); }
  if (journal) await journal.append(lease, { opId, phase: outcome, writer: W, kind: "update", detail: { dispatch, misplaced, settleUntil, items: items.filter((x) => x.status !== ITEM.ALREADY).map(({ key, status }) => ({ key, status })) } }).catch(() => {});
  return { opId, outcome, dispatch, items, misplaced, settleUntil, error: dispatchError };
}

/** Компенсація записів, що потрапили в чужий рядок: повертає попередні значення ураженого товару ЗА КЛЮЧЕМ і лише якщо клітинки
 *  досі містять наш помилковий запис (expect = written). Без попередніх значень (рядок вставлено людиною) — лише рішення людини. */
export async function compensateMisplaced(o, misplaced) {
  const changes = misplaced.filter((m) => m.previous).map((m) => ({ key: m.key, expect: m.written, set: m.previous }));
  const manual = misplaced.filter((m) => !m.previous);
  if (!changes.length) return { outcome: OP.NOTHING, manual };
  const r = await keyedUpdate({ ...o, changes, generation: "compensate:" + misplaced.map((m) => m.key + "@" + m.row).join(",") });
  return { ...r, manual };
}

/** Дописування рядків, яких ще немає за ключем (неідемпотентний append — без автоповтору; результат з'ясовується за ключем). */
export async function appendMissingByKey({ sheets, read, contract, writer, title, rows, assertCurrent = async () => {}, journal = null, lease = null, generation = "", now = Date.now, settleMs = SETTLE_MS }) {
  const T = String(title), W = String(writer);
  const spec = contract.sheets.get(T);
  if (!spec || !spec.appendWriters.includes(W)) throw new WriteOutcomeError(`контракт власності: «${W}» не має права дописувати рядки в «${T}»`, { outcome: OUTCOME.NOT_APPLIED, op: "appendMissingByKey", code: "OWNERSHIP" });
  const copy = rows.map((r) => r.map((v) => (typeof v === "number" ? v : String(v ?? ""))));
  const before = (await read([T]))[T];
  const header = before[0].map(t), kc = header.indexOf(spec.key);
  if (kc < 0) throw fail("NO_KEY_COLUMN", `немає ключової колонки «${spec.key}»`);
  const have = indexOf(before, kc).idx;
  const missing = copy.filter((r) => t(r[kc]) && !have.has(t(r[kc])));
  const keys = missing.map((r) => t(r[kc]));
  if (new Set(keys).size !== keys.length) throw fail("KEY_DUPLICATE", "у рядках для дописування повторюється ключ");
  const opId = opIdOf({ kind: "append", writer: W, resource: journal?.resource || "", title: T, keys, generation: String(generation) });
  if (!missing.length) return { opId, outcome: OP.NOTHING, appended: [], duplicates: [] };
  if (journal) await journal.append(lease, { opId, phase: "INTENT", writer: W, kind: "append", detail: { title: T, keyColumn: spec.key, keys } });
  let dispatch = OUTCOME.APPLIED, err = null;
  try { await assertCurrent(); await sheets.appendRows(T, missing); } catch (e) { dispatch = outcomeOf(e); err = e; }
  const after = (await read([T]))[T];
  const counts = new Map();
  for (let i = 1; i < after.length; i++) { const k = t(after[i]?.[kc]); if (keys.includes(k)) counts.set(k, (counts.get(k) || 0) + 1); }
  const appended = keys.filter((k) => counts.get(k) === 1), absent = keys.filter((k) => !counts.get(k)), duplicates = keys.filter((k) => counts.get(k) > 1);
  let outcome = duplicates.length ? OP.NEEDS_DECISION : appended.length === keys.length ? OP.VERIFIED : absent.length === keys.length ? OP.NOT_APPLIED : OP.PARTIAL;
  let settleUntil = "";
  if (dispatch === OUTCOME.UNKNOWN && outcome !== OP.NEEDS_DECISION && absent.length) { outcome = OP.UNKNOWN; settleUntil = new Date(now() + settleMs).toISOString(); }
  if (journal) await journal.append(lease, { opId, phase: outcome, writer: W, kind: "append", detail: { dispatch, appended: appended.length, absent, duplicates, settleUntil } }).catch(() => {});
  return { opId, outcome, dispatch, appended, absent, duplicates, settleUntil, error: err };
}

/** Видалення рядків ЗА КЛЮЧЕМ (архів «Видалені товари» / відновлення; без сліпого повтору). Позиційне видалення — найризиковіша
 *  операція Sheets (немає умовного запису), тому:
 *   1. право — contract.deleteWriters аркуша; 2. свіже читання; рядок — за ключем; ПОВНИЙ знімок рядка (expect) має збігтися
 *      (зміна з моменту знімка → CONFLICT, рядок не видаляється; ключа вже немає → ALREADY);
 *   3. один запит видалення всіх цільових рядків (Google: атомарно в межах запиту);
 *   4. перевірка за ключами: цільових немає, кожен інший ключ — на місці, кількість = до − n. Зник ЧУЖИЙ рядок (сортування /
 *      вставка між читанням і видаленням) → він дописується назад зі свіжого знімка (дані не губляться), NEEDS_DECISION.
 *  Невідомий результат запиту → UNKNOWN до кінця вікна settle; з'ясування — reconcile (за ключами й кількістю з наміру). */
export async function deleteByKeys({ sheets, read, contract, writer, title, rows, assertCurrent = async () => {}, journal = null, lease = null, generation = "", now = Date.now, settleMs = SETTLE_MS }) {
  const T = String(title), W = String(writer);
  const spec = contract.sheets.get(T);
  if (!spec || !(spec.deleteWriters || []).includes(W)) throw new WriteOutcomeError(`контракт власності: «${W}» не має права видаляти рядки з «${T}»`, { outcome: OUTCOME.NOT_APPLIED, op: "deleteByKeys", code: "OWNERSHIP" });
  const want = rows.map((r) => ({ key: t(r?.key), expect: Object.fromEntries(Object.entries(r?.expect || {}).map(([k, v]) => [String(k), t(v)])) }));
  if (want.some((w) => !w.key || !Object.keys(w.expect).length)) throw fail("BAD_ARGS", "видалення без ключа або без знімка рядка");
  const before = (await read([T]))[T];
  const header = before[0].map(t), kc = header.indexOf(spec.key);
  if (kc < 0) throw fail("NO_KEY_COLUMN", `немає ключової колонки «${spec.key}»`);
  const { idx, dup } = indexOf(before, kc);
  if (want.some((w) => dup.has(w.key))) throw fail("KEY_DUPLICATE", "ключ рядка для видалення зустрічається більше одного разу");
  const opId = opIdOf({ kind: "delete", writer: W, resource: journal?.resource || "", title: T, keys: want.map((w) => w.key), generation: String(generation) });
  const items = [], todo = [];
  for (const w of want) {
    const row = idx.get(w.key);
    if (!row) { items.push({ key: w.key, status: ITEM.ALREADY }); continue; }
    const cols = Object.keys(w.expect);
    if (cols.some((c) => !header.includes(c))) { items.push({ key: w.key, status: ITEM.CONFLICT, row, reason: "немає колонки знімка" }); continue; }
    if (!same(cellsOf(before[row - 1], header, cols), w.expect, cols)) { items.push({ key: w.key, status: ITEM.CONFLICT, row }); continue; }
    todo.push({ key: w.key, row }); items.push({ key: w.key, status: "PENDING", row });
  }
  if (!todo.length) return { opId, outcome: items.some((x) => x.status === ITEM.CONFLICT) ? OP.NOT_APPLIED : OP.NOTHING, items, recovered: [] };
  const keysBefore = [...idx.keys()];
  if (journal) await journal.append(lease, { opId, phase: "INTENT", writer: W, kind: "delete", detail: { title: T, keyColumn: spec.key, targets: todo.map((x) => ({ key: x.key, row: x.row })), keysBefore, snapshots: Object.fromEntries(todo.map((x) => [x.key, before[x.row - 1]])) } });
  let dispatch = OUTCOME.APPLIED, err = null;
  try { await assertCurrent(); await sheets.deleteRows(T, todo.map((x) => x.row)); } catch (e) { dispatch = outcomeOf(e); err = e; }
  if (dispatch === OUTCOME.NOT_APPLIED && !(err?.appliedParts > 0)) {
    if (journal) await journal.append(lease, { opId, phase: "NOT_APPLIED", writer: W, kind: "delete", detail: { error: String(err?.message || "").slice(0, 300) } }).catch(() => {});
    for (const x of items) if (x.status === "PENDING") x.status = ITEM.NOT_APPLIED;
    return { opId, outcome: OP.NOT_APPLIED, items, recovered: [], error: err };
  }
  const after = (await read([T]))[T];
  const aidx = indexOf(after, after[0].map(t).indexOf(spec.key)).idx;
  const targets = new Set(todo.map((x) => x.key));
  for (const x of items) if (x.status === "PENDING") x.status = aidx.has(x.key) ? ITEM.NOT_APPLIED : ITEM.VERIFIED;
  // Чужі рядки, які зникли (видалення лягло не туди): повертаємо зі знімка — дані не губляться.
  const lost = keysBefore.filter((k) => !targets.has(k) && !aidx.has(k));
  let recovered = [];
  if (lost.length) {
    try { await sheets.appendRows(T, lost.map((k) => before[idx.get(k) - 1])); recovered = lost; } catch (e) { recovered = []; err = err || e; }
  }
  const st = items.filter((x) => targets.has(x.key)).map((x) => x.status);
  let outcome = lost.length ? OP.NEEDS_DECISION : st.every((s) => s === ITEM.VERIFIED) ? OP.VERIFIED : st.every((s) => s === ITEM.NOT_APPLIED) ? OP.NOT_APPLIED : OP.PARTIAL;
  let settleUntil = "";
  if (dispatch === OUTCOME.UNKNOWN && outcome !== OP.NEEDS_DECISION && st.includes(ITEM.NOT_APPLIED)) { outcome = OP.UNKNOWN; settleUntil = new Date(now() + settleMs).toISOString(); }
  if (journal) await journal.append(lease, { opId, phase: outcome, writer: W, kind: "delete", detail: { dispatch, lost, recovered, settleUntil, items: items.map(({ key, status }) => ({ key, status })) } }).catch(() => {});
  return { opId, outcome, dispatch, items, lost, recovered, settleUntil, error: err };
}