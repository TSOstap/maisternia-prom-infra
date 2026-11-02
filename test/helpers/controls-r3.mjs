/** Тести Catalog Controls R3 / R4: двійники готовності S6 / W2 (контракт — src/pipeline/controls-run.mjs, READINESS_CONTRACT),
 *  сховища з CAS і fencing, фейковий транспорт Sheets API для справжнього GoogleSheetsWriter. ЛИШЕ для тестів: справжню
 *  реалізацію S6 / W2 надає інженерний сектор. Виклик runControls напряму — тести однаково запускаються на R3 і R4. */
import { buildYml, memorySink } from "../../src/core/yml.mjs";
import { HISTORY_HEADERS, SALE_DECISION } from "../../src/core/controls-common.mjs";
import { approvalManifest } from "../../src/core/seal.mjs";
import { controlsRowsForYml, holdRowsForYml } from "../../src/core/controls-sale.mjs";
import { controlsState } from "../../src/core/controls-plan.mjs";
import { runControls, CHECKPOINT_KEY } from "../../src/pipeline/controls-run.mjs";
import { GoogleSheetsWriter, MemorySheets } from "../../src/pipeline/sheets-writer.mjs";
import { ACTIVE_CONTRACT, setCells, codeOf, later, servingDouble, randomHex } from "./controls.mjs";
export { servingDouble, randomHex };

export const ID = "1500000007", ID2 = "1500000014", HOLD = "ЗНЯТИ З ПРОДАЖУ", RELEASE = "ПОВЕРНУТИ В ПРОДАЖ";
export const col = (name) => HISTORY_HEADERS.indexOf(name);
export const PROTECTION = { valid: true, fzIds: new Set(), protectedIds: new Set(), ovIds: new Set(), reasons: [] };

/** Скільки операцій точка вже вважає вирішеними (підтверджені журнал / архів + скасовані). Запис, що збільшує це число, — коміт. */
const settled = (v) => ["ops", "history", "excluded", "aborted"].reduce((n, k) => n + (Array.isArray(v?.[k]) ? v[k].length : 0), 0);

/**
 * Сховище з версіями й CAS (контракт W2 «cc-store-v1»); getJson / putJson — для сумісності з R2.
 *  failCommit — збій запису контрольної точки, що ПІДТВЕРДЖУЄ операції (коміт); запис намірів і ініціалізація проходять.
 *    На R3 (без намірів) це той самий збій, що й раніше: R3 пише точку лише комітом.
 *  failAllPuts — збій будь-якого запису контрольної точки (зокрема ініціалізації й намірів).
 *  Збій — завжди ДО застосування. hookPut(k, v) — перед записом; afterPut(k, v) — після запису.
 *  strict=false — версія ігнорується (сховище без справжнього CAS); conflictByReturn — конфлікт значенням, а не винятком.
 *  fence({ scope, token }) — fencing (W2): запис із переданою орендою, що вже не чинна, відхиляється. Без opts.lease — без перевірки.
 */
export class CasStore {
  constructor({ strict = true, conflictByReturn = false } = {}) {
    this.data = new Map(); this.ver = new Map(); this.strict = strict; this.conflictByReturn = conflictByReturn;
    this.failCommit = false; this.failAllPuts = false; this.fence = null; this.hookPut = null; this.afterPut = null; this.writes = 0;
    this.sealCheck = null; // R7.3: двійник печатки ключа точки (cc-serving-v2) — ставить readinessDouble({ sealed: true })
  }
  /** Сумісність із пробами Hermes R3 (independent-20261029T144034): failPut там означав збій запису точки, що підтверджує операції. */
  get failPut() { return this.failCommit; }
  set failPut(v) { this.failCommit = v; }
  #mustFail(k, v) { return k === CHECKPOINT_KEY && (this.failAllPuts || (this.failCommit && settled(v) > settled(this.data.get(k)))); }
  async getJson(k) { return this.data.has(k) ? structuredClone(this.data.get(k)) : null; }
  #sealed(k, v, version, opts) {
    if (!this.sealCheck || k !== CHECKPOINT_KEY) return;
    const why = this.sealCheck(v, version, opts);
    if (why) throw Object.assign(new Error(`${why.code}: ${why.reason}`), { code: why.code });
  }
  async putJson(k, v) {
    if (this.sealCheck && k === CHECKPOINT_KEY) throw Object.assign(new Error("CC_KEY_SEALED: запис контрольної точки без квитка заборонено"), { code: "CC_KEY_SEALED" });
    if (this.hookPut) await this.hookPut(k, v);
    if (this.#mustFail(k, v)) throw new Error("імітовано: запис у сховище не вдався");
    this.writes++; this.data.set(k, structuredClone(v)); this.ver.set(k, (this.ver.get(k) || 0) + 1);
    if (this.afterPut) await this.afterPut(k, v);
  }
  async getJsonVersioned(k) { return { value: await this.getJson(k), version: this.data.has(k) ? this.ver.get(k) : null }; }
  async putJsonIfVersion(k, v, version, opts = {}) {
    if (this.hookPut) await this.hookPut(k, v);
    if (this.#mustFail(k, v)) throw new Error("імітовано: запис у сховище не вдався");
    if (this.fence && opts?.lease && !this.fence(opts.lease)) throw Object.assign(new Error("STALE_LEASE: оренда не чинна — запис відхилено"), { code: "STALE_LEASE" });
    this.#sealed(k, v, version, opts);
    const cur = this.data.has(k) ? this.ver.get(k) : null;
    if (this.strict && cur !== version && this.conflictByReturn) return { conflict: true, version: cur };
    if (this.strict && cur !== version) throw Object.assign(new Error("CONFLICT: версію змінено"), { code: "CONFLICT" });
    if (this.sealCheck && k === CHECKPOINT_KEY) this.sealCheck.consume(opts.ticket);
    this.writes++; this.data.set(k, structuredClone(v)); this.ver.set(k, (cur || 0) + 1);
    if (this.afterPut) await this.afterPut(k, v);
    return { version: this.ver.get(k) };
  }
}

/**
 * Двійник готовності. Негативні варіанти: publisherOk=false — publisher не застосовує зняття; publisherAllHeld — знімає все;
 * refusesBlocked=false — не зупиняється за blocked; exclusive=false — друга оренда видається (решта поведінки коректна);
 * staleDetect=false — застаріла оренда не виявляється; casStrict=false — сховище без перевірки версії; conflictByReturn — конфлікт
 * без винятку; fencing=false — сховище приймає запис застарілої оренди.
 */
export function readinessDouble({ store = null, publisherOk = true, publisherAllHeld = false, refusesBlocked = true, omitsRemoved = true, overRemoves = false, exclusive = true, staleDetect = true, casStrict = true, conflictByReturn = false, fencing = true, sealed = false, strict = false } = {}) {
  let token = 0;
  const held = new Map();
  const committer = {
    contract: "cc-committer-v2",
    generation: 0,
    async acquire(scope) {
      if (exclusive && held.has(scope)) throw Object.assign(new Error("BUSY: інший записувач тримає оренду"), { code: "BUSY" });
      const t = ++token; held.set(scope, t);
      let released = false;
      return {
        token: t, leaseId: randomHex(), generation: committer.generation,
        async assertCurrent() { if (staleDetect && (released || (exclusive && held.get(scope) !== t))) throw new Error("STALE: оренду втрачено"); },
        async release() { released = true; if (held.get(scope) === t) held.delete(scope); },
      };
    },
  };
  const publisher = {
    contract: "cc-publisher-v2",
    async renderProbe({ rows, groups, manifest, meta, config, ccState }) {
      if (refusesBlocked && ccState.blocked) throw new Error("стан керування blocked — публікацію зупинено");
      // omitsRemoved=false — publisher лише робить видалений «немає в наявності» (поведінка до R6), а не вилучає offer.
      const base = omitsRemoved ? controlsRowsForYml(rows, { held: new Set(), tombstoned: ccState.tombstoned || new Map() }).rows : rows;
      // overRemoves — видалення одного товару зачіпає інші (за наявності видалених знімає все).
      const allHeld = publisherAllHeld || (overRemoves && ccState.tombstoned?.size > 0);
      const projected = allHeld ? holdRowsForYml(base, new Set(base.map((r) => r["Offer ID"]))).rows : publisherOk ? holdRowsForYml(base, ccState.held).rows : base;
      const sink = memorySink();
      await buildYml({ rows: projected, groups, manifest: projected.length === rows.length ? manifest : approvalManifest(projected, groups), meta, config, maximumBytes: 1_000_000, sink, missingPolicy: "unavailable", conflictPolicy: "isolate" });
      return sink.text();
    },
  };
  const st = store || new CasStore({ strict: casStrict, conflictByReturn });
  if (fencing) st.fence = ({ scope, token: t }) => held.get(scope) === t;
  const serving = servingDouble(st, { strict });
  if (sealed) st.sealCheck = serving.sealCheck;
  return { committer, publisher, store: st, serving };
}


export const apply = (w, R, extra = {}) => runControls({ sheets: w.sheets, readBook: w.readBook, stamp: extra.stamp || later(0), contract: extra.contract || ACTIVE_CONTRACT, protection: PROTECTION, store: R?.store, readiness: R, mode: "apply", ...extra });
export const shadow = (w, extra = {}) => runControls({ sheets: w.sheets, readBook: w.readBook, stamp: later(0), contract: ACTIVE_CONTRACT, protection: PROTECTION, mode: "shadow", ...extra });
export const cpOf = (R) => R.store.data.get(CHECKPOINT_KEY) ?? null;
export const stateOf = (w, R) => controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: cpOf(R) });
export const writes = (w) => w.sheets.calls.filter((c) => ["appendRows", "updateRanges", "ensureSheet", "deleteRows", "ensureColumns"].includes(c.op));

/** Нормальний потік власника: запит → код → підтвердження (усе через apply з готовністю). */
export async function confirmR(w, R, id, words, hours = 0) {
  setCells(w, id, { [SALE_DECISION]: words });
  await apply(w, R, { stamp: later(hours) });
  setCells(w, id, { [SALE_DECISION]: `${words} ${codeOf(w, id, words)}` });
  return apply(w, R, { stamp: later(hours + 0.5) });
}
/** Запит і код без підтвердження: у клітинці лишається команда з кодом (виконає наступний apply). */
export async function prompt(w, R, id, words, hours = 0) {
  setCells(w, id, { [SALE_DECISION]: words });
  await apply(w, R, { stamp: later(hours) });
  setCells(w, id, { [SALE_DECISION]: `${words} ${codeOf(w, id, words)}` });
}

/**
 * Фейковий транспорт Google Sheets API поверх книги в пам'яті — для СПРАВЖНЬОГО GoogleSheetsWriter (межа запису на рівні HTTP).
 * Кожен запит записується з аркушами-адресатами (за діапазоном, addSheet або sheetId). onAppend(title, values, mem) може
 * повернути "lost" — запит застосовано або відкладено, а відповідь втрачено (writer повторить).
 */
export function fakeSheetsApi(book, { onAppend = null } = {}) {
  const mem = new MemorySheets(book);
  const requests = [];
  const ok = (x) => ({ ok: true, status: 200, text: async () => JSON.stringify(x) });
  const titles = () => Object.keys(book);
  const parseRange = (range) => {
    const m = /^'((?:[^']|'')*)'!([A-Z]+)(\d+)/.exec(range);
    return { title: m[1].replace(/''/g, "'"), col: [...m[2]].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0), row: Number(m[3]) };
  };
  async function fetchImpl(url, opts) {
    const p = decodeURIComponent(new URL(url).pathname);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const rec = { method: opts.method, path: p, titles: [], ops: [] };
    requests.push(rec);
    if (opts.method === "GET") return ok({ sheets: titles().map((title, i) => ({ properties: { title, sheetId: i, gridProperties: { rowCount: 1000, columnCount: 300 } } })) });
    if (p.endsWith("/values:batchUpdate")) {
      for (const d of body.data) { const r = parseRange(d.range); rec.titles.push(r.title); await mem.updateRanges([{ ...r, values: d.values }]); }
      return ok({});
    }
    const app = /\/values\/(.+):append$/.exec(p);
    if (app) {
      const r = parseRange(app[1]);
      rec.titles.push(r.title);
      const res = onAppend ? await onAppend(r.title, body.values, mem) : (await mem.appendRows(r.title, body.values), "ok");
      if (res === "lost") throw new Error("імітовано: відповідь на append втрачено");
      return ok({});
    }
    if (p.endsWith(":batchUpdate")) {
      for (const q of body.requests) {
        const [kind] = Object.keys(q);
        rec.ops.push(kind);
        if (kind === "addSheet") { const t = q.addSheet.properties.title; rec.titles.push(t); if (!book[t]) book[t] = [[]]; }
        else { const sid = q[kind]?.sheetId ?? q[kind]?.range?.sheetId; if (sid != null) rec.titles.push(titles()[sid]); }
      }
      return ok({ replies: [] });
    }
    throw new Error("фейковий API: неочікуваний запит " + p);
  }
  let t = 0;
  const writer = (opts = {}) => new GoogleSheetsWriter({ spreadsheetId: "SYNTHETIC_TEST_COPY_0000000000000000", liveSpreadsheetId: "SYNTHETIC_LIVE_BLOCKED_000000000000", getAccessToken: async () => "synthetic", fetchImpl, sleep: async () => {}, now: () => (t += 2000), maxRequests: 1000, maxRequestsPerMinute: 100000, ...opts });
  return { fetchImpl, requests, mem, writer, touched: () => [...new Set(requests.flatMap((r) => r.titles))] };
}
