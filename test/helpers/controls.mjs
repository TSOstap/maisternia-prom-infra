/** Тести Catalog Controls: синтетичний каталог у пам'яті, активований ТЕСТОВИЙ контракт, сховище контрольної точки в пам'яті.
 *  Колонки власника додає фікстура (так, як це зробить процедура активації спільного механізму) — не Catalog Controls. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generateSynthetic } from "../../src/synth/generator.mjs";
import { parseSupplierText } from "../../src/core/supplier-feed.mjs";
import { readSheet } from "../../src/core/sync-plan.mjs";
import { mtText } from "../../src/core/text.mjs";
import { SHEET } from "../../src/core/sheet-sync.mjs";
import { CC_INPUT_COLUMNS, CC_SHEET, HISTORY_HEADERS, loadControlsContract } from "../../src/core/controls-common.mjs";
import { VIEW_HEADERS } from "../../src/core/controls-plan.mjs";
import { MemorySheets } from "../../src/pipeline/sheets-writer.mjs";
import { mergeNew92 } from "../../src/pipeline/sheet-sync-run.mjs";
import { runControls, CHECKPOINT_KEY } from "../../src/pipeline/controls-run.mjs";
import { buildYml, memorySink } from "../../src/core/yml.mjs";
import { approvalManifest } from "../../src/core/seal.mjs";
import { controlsRowsForYml } from "../../src/core/controls-sale.mjs";

export const NOW = Date.parse("2026-10-29T10:00:00Z");
export const STAMP = new Date(NOW).toISOString();
export const later = (hours) => new Date(NOW + hours * 3600000).toISOString();
/** Захист перевірено, захищених немає (тест сам задає FZ / перелік / OV). Лише для тестів. */
export const PROTECTION_OK = Object.freeze({ valid: true, fzIds: new Set(), protectedIds: new Set(), ovIds: new Set(), reasons: [] });
/** Контракт репозиторію з activated=true — ЛИШЕ для тестів (у репозиторії activated=false). */
export const ACTIVE_CONTRACT = Object.freeze({ ...loadControlsContract().contract, activated: true, activatedAt: "2026-10-29" });

/** Сховище контрольної точки з версіями, CAS і fencing (контракт W2 «cc-store-v1») — ЛИШЕ для тестів. fence — від testReadiness. */
export class MemoryStore {
  constructor() { this.data = new Map(); this.ver = new Map(); this.failGet = false; this.failPut = false; this.fence = null; }
  async getJson(k) { if (this.failGet) throw new Error("імітовано: сховище недоступне"); return this.data.has(k) ? structuredClone(this.data.get(k)) : null; }
  async putJson(k, v) { if (this.failPut) throw new Error("імітовано: запис у сховище не вдався"); this.data.set(k, structuredClone(v)); this.ver.set(k, (this.ver.get(k) || 0) + 1); }
  async getJsonVersioned(k) { return { value: await this.getJson(k), version: this.data.has(k) ? this.ver.get(k) : null }; }
  async putJsonIfVersion(k, v, version, opts = {}) {
    if (this.failPut) throw new Error("імітовано: запис у сховище не вдався");
    if (this.fence && opts?.lease && !this.fence(opts.lease)) throw Object.assign(new Error("STALE_LEASE: оренда не чинна"), { code: "STALE_LEASE" });
    const cur = this.data.has(k) ? this.ver.get(k) : null;
    if (cur !== version) throw Object.assign(new Error("CONFLICT: версію змінено"), { code: "CONFLICT" });
    this.data.set(k, structuredClone(v)); this.ver.set(k, (cur || 0) + 1);
    return { version: this.ver.get(k) };
  }
}

/** 32 hex — leaseId / nonce двійників (cc-committer-v2, cc-serving-v2). */
export const randomHex = () => crypto.randomBytes(16).toString("hex");
/**
 * Двійник протоколу A (cc-serving-v2) — ЛИШЕ для тестів CC. Справжню реалізацію (захист обслуговування фідів, квитки, head W2,
 * дзеркало реєстру рішень у сховищі фідів, виявлення відновлення) надає Engineering (E3–E8); тут — мінімум, щоб перевірити, що CC
 * викликає beforeCommit перед КОЖНИМ записом точки, передає квиток і поводиться за правилами відмови.
 *  state — "NORMAL" | "RECOVERY_PENDING" | "RECOVERY_AUTHORIZED"; strict — зміну точки поза запечатаним записом (відновлення, повтор)
 *  виявляє як RECOVERY_PENDING (як head Engineering); deny(req) → причина відмови beforeCommit; floorProven, type — для recovery();
 *  registry — дзеркало реєстру (останній завершений запис), prepared — незавершений; calls / afterCalls — журнал викликів.
 *  sealCheck — двійник перевірки квитка сховищем (лише за readinessDouble({ sealed: true })).
 *  R7.4: statusType — поле type у status (як у Engineering: "NORMAL", "BOOTSTRAP", "MIGRATION", …); за замовчуванням "NORMAL".
 */
export function servingDouble(store, { strict = false } = {}) {
  const tickets = new Map();
  const s = {
    contract: "cc-serving-v2", state: "NORMAL", strict, deny: null, floorProven: true, type: "CP_ONLY", reason: "", statusType: "NORMAL",
    registry: null, prepared: null, committedJson: null, calls: [], afterCalls: [], statusCalls: 0,
    async status() {
      s.statusCalls++;
      const cur = store.data.get(CHECKPOINT_KEY);
      if (s.strict && s.state === "NORMAL" && s.committedJson !== null && JSON.stringify(cur ?? null) !== s.committedJson) { s.state = "RECOVERY_PENDING"; s.type = "CP_ONLY"; s.reason = "контрольну точку змінено поза протоколом A (head)"; }
      return { state: s.state, reason: s.reason, generation: 0, type: s.statusType };
    },
    async beforeCommit(req) {
      s.calls.push({ phase: req.phase, expectedVersion: req.cp.expectedVersion, next: structuredClone(req.cp.next), lease: { ...req.lease }, held: [...(req.state?.held || [])], tombstoned: [...(req.state?.tombstoned?.keys?.() || [])], registry: structuredClone(req.registry) });
      const why = typeof s.deny === "function" ? s.deny(req) : s.deny ? "відмова двійника" : null;
      if (why) return { ok: false, code: "SERVING_NOT_SECURED", reason: String(why), serving: "UNKNOWN" };
      s.prepared = structuredClone(req.registry);
      const ticket = { v: 1, key: CHECKPOINT_KEY, nextHash: JSON.stringify(req.cp.next), expectedVersion: req.cp.expectedVersion, leaseToken: req.lease.token, leaseId: req.lease.leaseId, phase: req.phase, nonce: randomHex(), notAfter: Date.now() + 60_000 };
      tickets.set(ticket.nonce, ticket);
      return { ok: true, ticket };
    },
    async afterCommit({ ticket, version }) {
      s.afterCalls.push({ phase: ticket.phase, version });
      s.registry = s.prepared; s.prepared = null; s.committedJson = ticket.nextHash;
      return { ok: true };
    },
    async recovery() { return { state: s.state, type: s.type, floorProven: s.floorProven, registry: structuredClone(s.registry), prepared: structuredClone(s.prepared), registryGen: 0, fromHash: "", reason: s.floorProven ? "" : "межу не доведено" }; },
    /** Завершити погоджене власником відновлення (Engineering, крок 6) — у двійнику: NORMAL і поточна точка як head. */
    finishRecovery() { s.state = "NORMAL"; s.reason = ""; s.committedJson = JSON.stringify(store.data.get(CHECKPOINT_KEY) ?? null); },
  };
  s.sealCheck = Object.assign((value, version, opts) => {
    const t = opts?.ticket;
    if (!t) return { code: "CC_KEY_SEALED", reason: "запис контрольної точки без квитка заборонено" };
    const known = tickets.get(t.nonce);
    if (!known || known !== t && JSON.stringify(known) !== JSON.stringify(t)) return { code: "CC_TICKET_REJECTED", reason: "квиток невідомий або вже погашений" };
    if (t.expectedVersion !== version) return { code: "CC_TICKET_REJECTED", reason: "квиток для іншої версії точки" };
    if (t.nextHash !== JSON.stringify(value)) return { code: "CC_TICKET_REJECTED", reason: "квиток для іншого значення точки" };
    if (t.leaseToken !== opts?.lease?.token || t.leaseId !== opts?.lease?.leaseId) return { code: "CC_TICKET_REJECTED", reason: "квиток іншої оренди" };
    if (t.notAfter < Date.now()) return { code: "CC_TICKET_REJECTED", reason: "квиток прострочено" };
    return null;
  }, { consume: (t) => tickets.delete(t?.nonce) });
  return s;
}

/** Тестовий двійник готовності S6 + W2 (READINESS_CONTRACT). Інженерний сектор має надати справжню реалізацію; тут — лише тести. */
export function testReadiness(store) {
  let token = 0;
  const held = new Map();
  if (store) store.fence = ({ scope, token: t }) => held.get(scope) === t;
  return {
    store,
    serving: servingDouble(store || { data: new Map() }),
    committer: {
      contract: "cc-committer-v2",
      async acquire(scope) {
        if (held.has(scope)) throw Object.assign(new Error("BUSY: інший записувач тримає оренду"), { code: "BUSY" });
        const t = ++token; held.set(scope, t);
        let released = false;
        return { token: t, leaseId: randomHex(), generation: 0, async assertCurrent() { if (released || held.get(scope) !== t) throw new Error("STALE"); }, async release() { released = true; if (held.get(scope) === t) held.delete(scope); } };
      },
    },
    publisher: {
      contract: "cc-publisher-v2",
      async renderProbe({ rows, groups, manifest, meta, config, ccState }) {
        if (ccState.blocked) throw new Error("стан керування blocked — публікацію зупинено");
        const sink = memorySink();
        // R6: видалені — без рядка (жодного <offer>); паспорт чинного buildYml — для набору, що публікується (двійник).
        const proj = controlsRowsForYml(rows, ccState).rows;
        await buildYml({ rows: proj, groups, manifest: proj.length === rows.length ? manifest : approvalManifest(proj, groups), meta, config, maximumBytes: 1_000_000, sink, missingPolicy: "unavailable", conflictPolicy: "isolate" });
        return sink.text();
      },
    },
  };
}

/** Шпигун поверх writer: фіксує кожен виклик (op, аркуш) — для інваріанту «нічого в «Основний каталог», жодного deleteRows». */
export function spy(inner) {
  const calls = [];
  const wrap = (op) => async (...a) => { calls.push({ op, title: Array.isArray(a[0]) ? a[0].map((b) => b.title) : [a[0]] }); return inner[op](...a); };
  return { calls, meta: () => inner.meta(), updateRanges: wrap("updateRanges"), appendRows: wrap("appendRows"), deleteRows: wrap("deleteRows"), ensureSheet: wrap("ensureSheet"), ensureColumns: wrap("ensureColumns"), setPercentFormat: (...a) => inner.setPercentFormat(...a), get maxAttempts() { return inner.maxAttempts; } };
}
export const touchedMain = (calls) => calls.filter((c) => c.title.includes(SHEET.main));

/**
 * ENG-15 §7: синхронізація Engineering у режимі пріоритету власника вимагає стан CC (адаптер), інакше fail-closed. Якщо адаптер
 * Engineering є в дереві (композиція гілок) — той самий стан CC через ЧИННИЙ модуль Engineering; у дереві CC (база main) адаптера
 * немає (undefined), а синхронізація main параметр ігнорує. Адаптер тут не дублюється.
 */
export async function ccControls(w) {
  let mod;
  try { mod = await import("../../src/pipeline/controls-adapter.mjs"); } catch { return undefined; }
  const { controlsState, verifyControlsSnapshot } = await import("../../src/core/controls-plan.mjs");
  return mod.catalogControlsAdapter({ loadBook: async () => structuredClone(w.book), store: w.store, contract: ACTIVE_CONTRACT, api: { controlsState, verifyControlsSnapshot } });
}

/** Каталог після перенесення NEW92 (паспорт є) + колонки власника + сховище. */
export async function prepared({ products = 40, queue = 4, newOffers = 2, seed = 11, inputs = true } = {}) {
  const s = generateSynthetic({ products, queue, deferred: 2, newOffers, seed, now: NOW });
  const book = {
    [SHEET.main]: s.sheets["Основний каталог"], [SHEET.queue]: s.sheets["Нові товари"], [SHEET.deferred]: s.sheets["Відкладені товари"],
    [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
  };
  const mem = new MemorySheets(book);
  const store = new MemoryStore();
  const w = { s, book, mem, sheets: spy(mem), store, readiness: testReadiness(store), xml: s.supplierXml() };
  w.readBook = async () => structuredClone(w.book);
  assert.equal((await mergeNew92({ sheets: mem, readBook: w.readBook, stamp: STAMP })).state, "MERGED");
  if (inputs) w.book[SHEET.main][0].push(...CC_INPUT_COLUMNS);
  return w;
}

/** contract: "repo" — контракт із репозиторію (activated=false), інакше об'єкт (за замовчуванням — тестовий активований).
 *  integrity / publication — двійники входів Engineering (M3 і доказ публікації); за замовчуванням — із w (якщо тест їх задав). */
export const run = (w, { stamp = STAMP, config = {}, contract = ACTIVE_CONTRACT, protection = PROTECTION_OK, parsed = null, readBook = w.readBook, store = w.store, readiness = w.readiness, mode = "apply", sheets = w.sheets, integrity = w.integrity ?? null, publication = w.publication ?? null } = {}) =>
  runControls({ sheets, readBook, stamp, config, contract: contract === "repo" ? undefined : contract, protection, parsed, store, readiness, mode, integrity, publication });

export const parse = (xml) => parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
export const mainRows = (w) => readSheet(w.book[SHEET.main], SHEET.main).rows;
export const mainIds = (w) => mainRows(w).map((r) => mtText(r["Offer ID"]));
export const rowOf = (w, id) => mainRows(w).find((r) => mtText(r["Offer ID"]) === id);
const H = Object.fromEntries(HISTORY_HEADERS.map((k, i) => [k, i]));
export const history = (w) => (w.book[CC_SHEET.history] || []).slice(1);
export const eventsOf = (w, id, action) => history(w).filter((r) => r[H["Offer ID"]] === id && (!action || r[H["Дія"]] === action));
export const evField = (row, name) => row[H[name]];

/** Рядок «Стану керування» товару як об'єкт. */
export function viewOf(w, id) {
  const v = w.book[CC_SHEET.state] || [];
  const h = (v[0] || []).map(mtText);
  assert.deepEqual(h.slice(0, VIEW_HEADERS.length), VIEW_HEADERS.slice());
  const r = v.find((x, k) => k > 0 && mtText(x[0]) === id);
  return r ? Object.fromEntries(h.map((k, j) => [k, mtText(r[j])])) : null;
}
/** Код з колонки «Коди підтвердження» для команди (слова команди, для ВИДАЛИТИ / ПОВЕРНУТИ З АРХІВУ — разом з Offer ID). */
export function codeOf(w, id, words) {
  const cell = viewOf(w, id)?.["Коди підтвердження"] || "";
  const m = new RegExp(`${words}\\s+([0-9A-F]{6})`).exec(cell);
  assert.ok(m, `немає коду «${words}» для ${id}: «${cell}»`);
  return m[1];
}

/** Правка власника (за Offer ID і назвою колонки). */
export function setCells(w, id, cells, sheet = SHEET.main) {
  const v = w.book[sheet];
  const h = v[0].map(mtText);
  const i = v.findIndex((r, k) => k > 0 && mtText(r[h.indexOf("Offer ID")]) === id);
  assert.ok(i > 0, "немає рядка " + id);
  for (const [k, val] of Object.entries(cells)) {
    const j = h.indexOf(k);
    assert.ok(j >= 0, "немає колонки " + k);
    while (v[i].length <= j) v[i].push("");
    v[i][j] = val;
  }
}

/** Потік власника: команда без коду → запуск → код зі «Стану керування» → команда з кодом → запуск. */
export async function confirm(w, id, column, words, { reason = "", stamp = STAMP, ...opts } = {}) {
  setCells(w, id, { [column]: words });
  const r1 = await run(w, { stamp, ...opts });
  const code = codeOf(w, id, words);
  setCells(w, id, { [column]: `${words} ${code}${reason ? ": " + reason : ""}` });
  const r2 = await run(w, { stamp, ...opts });
  return { r1, r2, code };
}

/**
 * Збої реального Google Sheets поверх MemorySheets (у MemorySheets збій — завжди ДО застосування):
 *  "fail" — не виконано; "lost" — виконано, відповідь втрачено; "retry" — відповідь першої спроби втрачено й writer повторює
 *  (maxAttempts > 1 → застосовано двічі); "partial" — дописано лише перший рядок, далі помилка; "shift" — хтось вставив рядок
 *  (row) в аркуш title на позицію at перед запитом; "after" — запит виконано, одразу після нього — чужа правка fn(book).
 */
export class FlakySheets {
  constructor(book, { maxAttempts = 4 } = {}) { this.mem = new MemorySheets(book); this.book = book; this.maxAttempts = maxAttempts; this.rules = []; this.calls = {}; this.seen = []; }
  on(op, nth, mode, extra = {}) { this.rules.push({ op, nth, mode, ...extra }); return this; }
  async #do(op, args) {
    const n = (this.calls[op] = (this.calls[op] || 0) + 1);
    this.seen.push({ op, n, maxAttempts: this.maxAttempts, title: Array.isArray(args[0]) ? args[0][0]?.title : args[0] });
    const rule = this.rules.find((r) => r.op === op && r.nth === n);
    if (!rule) return this.mem[op](...args);
    if (rule.mode === "fail") throw new Error(`імітовано: ${op} не виконано`);
    if (rule.mode === "shift") this.book[rule.title].splice(rule.at ?? 1, 0, rule.row.slice());
    if (rule.mode === "partial") { await this.mem[op](args[0], args[1].slice(0, 1)); throw new Error(`імітовано: ${op} частково`); }
    const res = await this.mem[op](...args);
    if (rule.mode === "lost") throw new Error(`імітовано: ${op} виконано, відповідь втрачено`);
    if (rule.mode === "retry" && this.maxAttempts > 1) await this.mem[op](...args);
    if (rule.mode === "after") rule.fn(this.book);
    return res;
  }
  meta() { return this.mem.meta(); }
  updateRanges(list) { return this.#do("updateRanges", [list]); }
  appendRows(title, rows) { return this.#do("appendRows", [title, rows]); }
  deleteRows(title, rows) { return this.#do("deleteRows", [title, rows]); }
  async ensureSheet(title, header) {
    const n = (this.calls.ensureSheet = (this.calls.ensureSheet || 0) + 1);
    const rule = this.rules.find((r) => r.op === "ensureSheet" && r.nth === n);
    if (rule?.mode === "headerless") { this.book[title] = [[]]; throw new Error("імітовано: аркуш створено, заголовок не записано"); }
    return this.mem.ensureSheet(title, header);
  }
  async ensureColumns() {}
  setPercentFormat(...a) { return this.mem.setPercentFormat(...a); }
}

/** readBook, що падає на n-му виклику (помилка читання Sheets API). */
export const failingRead = (w, nth) => { let k = 0; return async () => { if (++k === nth) throw new Error("імітовано: читання не вдалося"); return structuredClone(w.book); }; };
