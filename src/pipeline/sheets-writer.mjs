/** Етап S1: ЗАПИС у Google-таблицю — лише в ТЕСТОВУ КОПІЮ (поки власник не погодить інше).
 *
 *  Спільний інтерфейс двох реалізацій (ідентична поведінка, тести працюють на MemorySheets):
 *    meta()                                   → [{ title, sheetId, rows, columns }]
 *    updateRanges([{ title, row, col, values }])  — прямокутні блоки, row/col з 1; valueInputOption=RAW
 *    appendRows(title, rows)                  — у кінець даних аркуша
 *    deleteRows(title, rowNumbers)            — номери рядків аркуша (з 1), видалення знизу вгору
 *    ensureSheet(title, header)               — створити аркуш із заголовком, якщо його немає
 *    ensureColumns(title, n)                  — сітка аркуша має щонайменше n колонок
 *
 *  Захист живої таблиці: GoogleSheetsWriter вимагає ID живої таблиці й відмовляється працювати, якщо цільовий ID
 *  збігається з ним. Друга лінія — права Google: на живій таблиці службовий акаунт лише «Читач».
 *  RAW: значення пишуться як є (без розбору формул/дат) — рядок ISO лишається рядком, «20%» — рядком.
 *
 *  E1 (ENG-01 K1) — політика повтору на КОЖЕН виклик, незмінна (Object.freeze), а не спільна змінна екземпляра:
 *    читання (GET)  — повтор з експоненційною паузою і випадковим розкидом при мережі / тайм-ауті / 429 / 5xx (рекомендація Google);
 *    запис (POST)   — БЕЗ автоповтору. Будь-яка неоднозначна відповідь (мережа, тайм-аут, 429, 5xx) → WriteOutcomeError UNKNOWN:
 *                     запит міг застосуватися (офіційно: «not guaranteed that the spreadsheet will reflect exactly your changes»,
 *                     поведінку після тайм-ауту / 429 документація не описує). З'ясування — читанням за ключем (keyed-write / gateway).
 *                     4xx (крім 429) → NOT_APPLIED: «If any request is not valid then the entire request will fail and nothing will be applied».
 *  Запис повертає { outcome: "APPLIED", calls }; збій — WriteOutcomeError з outcome і appliedParts (для багатозапитних операцій).
 *  fence (необов'язково) — { assertCurrent() }: перевірка чинності оренди безпосередньо ПЕРЕД кожним відправленням запису (E3).
 *  Відмова fence → NOT_APPLIED (запит не відправлено). */
import { columnLetter } from "./google-sheets.mjs";
import { OUTCOME, WriteOutcomeError } from "./write-outcome.mjs";

const API = "https://sheets.googleapis.com/v4/spreadsheets/";
const RETRY = new Set([429, 500, 502, 503, 504]);
/** Політики викликів: незмінні об'єкти, створюються один раз на екземпляр; запит не може змінити політику іншого запиту (сценарій P3). */
const policyOf = (kind, maxAttempts) => Object.freeze({ kind, maxAttempts: kind === "read" ? maxAttempts : 1 });
export const rangeA1 = (title, row, col, rows, cols) =>
  `'${title.replace(/'/g, "''")}'!${columnLetter(col)}${row}:${columnLetter(col + Math.max(1, cols) - 1)}${row + Math.max(1, rows) - 1}`;

/** Режим запису значень: лише RAW — Google не розбирає формули й дати, «=…», «+», «-» зберігаються як текст. */
export const VALUE_INPUT_OPTION = "RAW";

/** ENG-28c (М1): ділення рядків на порції за розміром JSON — та сама функція для запису (GoogleSheetsWriter) і для попередньої оцінки. */
export function chunkRows(rows, maxChunkChars) {
  const out = [];
  let cur = [], size = 0;
  for (const r of rows) {
    const s = JSON.stringify(r).length;
    if (cur.length && size + s > maxChunkChars) { out.push(cur); cur = []; size = 0; }
    cur.push(r); size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}
/** ENG-28c (М1): прямокутні блоки updateRanges → запити values:batchUpdate (дрібні порції — одним запитом, великі — кількома). */
export function rangeBatches(list, maxChunkChars) {
  const parts = [];
  for (const b of list) {
    let row = Number(b.row);
    for (const values of chunkRows(b.values, maxChunkChars)) { parts.push({ title: String(b.title), row, col: Number(b.col), values }); row += values.length; }
  }
  const batches = [];
  let batch = [], size = 0;
  for (const p of parts) {
    const s = JSON.stringify(p.values).length;
    if (batch.length && size + s > maxChunkChars) { batches.push(batch); batch = []; size = 0; }
    batch.push(p); size += s;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
/** Типова межа запитів на запуск і розмір порції (як у GoogleSheetsWriter). */
export const DEFAULT_MAX_REQUESTS = 40;
export const DEFAULT_MAX_CHUNK_CHARS = 2_000_000;
/**
 * ENG-28c (М1): оцінка кількості HTTP-запитів GoogleSheetsWriter для запланованої послідовності операцій — ДО першого запису.
 * Модель — та сама, що в записувачі: порції / пакети (chunkRows, rangeBatches), кеш meta() (GET) скидається після appendRows,
 * addSheet, appendDimension. ops: [{ op: "updateRanges", blocks } | { op: "appendRows", rows } | { op: "ensureSheet", exists }
 * | { op: "ensureColumns", needed } | { op: "setPercentFormat" }]. Повертає { requests, byOp }.
 */
export function estimateRequests(ops, { maxChunkChars = DEFAULT_MAX_CHUNK_CHARS } = {}) {
  let requests = 0, cached = false;
  const byOp = {};
  const add = (k, n = 1) => { requests += n; byOp[k] = (byOp[k] || 0) + n; };
  const meta = () => { if (!cached) { add("meta"); cached = true; } };
  for (const o of ops) {
    if (o.op === "updateRanges") { const n = o.blocks?.length ? rangeBatches(o.blocks, maxChunkChars).length : 0; if (n) add("updateRanges", n); }
    else if (o.op === "appendRows") { if (o.rows?.length) { add("appendRows", chunkRows(o.rows, maxChunkChars).length); cached = false; } }
    else if (o.op === "ensureSheet") { meta(); if (!o.exists) { add("addSheet"); cached = false; add("updateRanges"); } }
    else if (o.op === "ensureColumns") { meta(); if (o.needed) { add("ensureColumns"); cached = false; } }
    else if (o.op === "setPercentFormat") { meta(); add("setPercentFormat"); }
  }
  return { requests, byOp };
}

export class GoogleSheetsWriter {
  constructor({ spreadsheetId, liveSpreadsheetId, getAccessToken, fetchImpl, sleep, now, random, fence = null, maxRequests = DEFAULT_MAX_REQUESTS, maxAttempts = 4, maxRequestsPerMinute = 50, maxChunkChars = DEFAULT_MAX_CHUNK_CHARS }) {
    if (!spreadsheetId || !/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) throw new Error("Невалідний ID тестової таблиці");
    if (!liveSpreadsheetId) throw new Error("Для захисту потрібен ID живої таблиці (запис у неї заборонено)");
    if (spreadsheetId === liveSpreadsheetId) throw new Error("ЗАБОРОНЕНО: цільова таблиця — ЖИВА. Запис дозволено лише в тестову копію");
    this.id = spreadsheetId;
    this.getAccessToken = getAccessToken;
    this.fetch = fetchImpl || globalThis.fetch;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = random || Math.random;
    this.fence = fence;
    this.maxRequests = maxRequests;
    this.policies = Object.freeze({ read: policyOf("read", maxAttempts), write: policyOf("write", maxAttempts) });
    this.metrics = { requests: 0, retries: 0, writes: 0, unknown: 0 };
    this.metaCache = null;
    this.now = now || (() => Date.now());
    this.maxRequestsPerMinute = maxRequestsPerMinute; // квота Sheets API: 60 запитів запису/хв на користувача
    this.maxChunkChars = maxChunkChars;               // великі блоки (напр. 5121 рядок із описами) — порціями ~2 МБ
    this.window = [];
  }

  async #pace() {
    const t = this.now();
    this.window = this.window.filter((x) => t - x < 60000);
    if (this.window.length >= this.maxRequestsPerMinute) { await this.sleep(60000 - (t - this.window[0]) + 50); return this.#pace(); }
    this.window.push(this.now());
  }

  /** Ділить рядки на порції за розміром JSON (спільна функція з оцінкою М1). */
  #chunks(rows) {
    return chunkRows(rows, this.maxChunkChars);
  }

  /** Один логічний виклик API з незмінною політикою (`policy`): читання — з повторами, запис — одна спроба й тристановий результат. */
  async #call(method, path, body, params = [], policy = method === "GET" ? this.policies.read : this.policies.write, op = path) {
    const qs = new URLSearchParams(params).toString();
    const url = API + encodeURIComponent(this.id) + path + (qs ? "?" + qs : "");
    const write = policy.kind !== "read";
    for (let attempt = 1; ; attempt++) {
      // Межа запитів і fence — до відправлення: запит гарантовано не пішов.
      if (this.metrics.requests >= this.maxRequests) throw new WriteOutcomeError(`Перевищено межу ${this.maxRequests} запитів на запуск (захист квоти)`, { outcome: OUTCOME.NOT_APPLIED, op, code: "REQUEST_BUDGET" });
      if (write && this.fence) {
        try { await this.fence.assertCurrent(); } catch (e) { throw new WriteOutcomeError("оренда запису недійсна — запит не відправлено: " + (e?.message || e), { outcome: OUTCOME.NOT_APPLIED, op, code: e?.code || "STALE_LEASE", cause: e }); }
      }
      this.metrics.requests++;
      await this.#pace();
      const token = await this.getAccessToken();
      let res, text;
      try {
        res = await this.fetch(url, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(170000) });
        text = await res.text();
      } catch (e) {
        if (write) { this.metrics.unknown++; throw new WriteOutcomeError("Sheets API: відповідь втрачено (мережа / тайм-аут) — запис міг застосуватися", { outcome: OUTCOME.UNKNOWN, op, code: e?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK", cause: e }); }
        if (attempt >= policy.maxAttempts) throw new Error(e?.name === "TimeoutError" ? "Sheets API: перевищено час очікування" : "Sheets API недоступний (мережа)");
        this.metrics.retries++;
        await this.sleep(this.#backoff(attempt));
        continue;
      }
      if (res.ok) {
        try { return text ? JSON.parse(text) : {}; } catch (e) {
          if (write) { this.metrics.unknown++; throw new WriteOutcomeError("Sheets API: пошкоджена відповідь на запис", { outcome: OUTCOME.UNKNOWN, op, status: res.status, code: "BAD_RESPONSE", cause: e }); }
          throw e;
        }
      }
      if (!write && RETRY.has(res.status) && attempt < policy.maxAttempts) { this.metrics.retries++; await this.sleep(this.#backoff(attempt)); continue; }
      let reason = "";
      try { reason = JSON.parse(text)?.error?.status || ""; } catch { /* */ }
      const hint = res.status === 403 ? "немає права запису: таблиця має бути поділена зі службовим акаунтом як «Редактор» (лише тестова копія)" : "помилка Sheets API";
      const message = `Sheets API HTTP ${res.status}${reason ? " " + reason : ""}: ${hint}`;
      if (!write) throw new Error(message);
      // 429 і 5xx — результат запису невідомий (документація не гарантує незастосування); інші 4xx — запит відхилено цілком.
      const unknown = RETRY.has(res.status);
      if (unknown) this.metrics.unknown++;
      throw new WriteOutcomeError(message, { outcome: unknown ? OUTCOME.UNKNOWN : OUTCOME.NOT_APPLIED, op, status: res.status, code: unknown ? "AMBIGUOUS_HTTP" : "REJECTED" });
    }
  }

  /** Експоненційна пауза з випадковим розкидом ≤ 1 с і стелею 64 с (рекомендація Google, Usage limits). */
  #backoff(attempt) { return Math.min(1000 * 2 ** attempt + Math.floor(this.random() * 1000), 64000); }

  /** Багатозапитна операція: кожен запит — окремо; збій позначає, скільки частин уже підтверджено (часткове виконання). */
  async #parts(op, list, send) {
    let applied = 0;
    for (const item of list) {
      try { await send(item); applied++; } catch (e) {
        if (e instanceof WriteOutcomeError) { e.appliedParts = applied; e.totalParts = list.length; e.op ||= op; throw e; }
        throw new WriteOutcomeError(String(e?.message || e), { outcome: OUTCOME.UNKNOWN, op, appliedParts: applied, totalParts: list.length, cause: e });
      }
    }
    return { outcome: OUTCOME.APPLIED, calls: applied };
  }

  async meta(refresh = false) {
    if (this.metaCache && !refresh) return this.metaCache;
    const m = await this.#call("GET", "", null, [["fields", "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))"]]);
    this.metaCache = (m.sheets || []).map((s) => ({ title: s.properties.title, sheetId: s.properties.sheetId, rows: s.properties.gridProperties?.rowCount || 0, columns: s.properties.gridProperties?.columnCount || 0 }));
    return this.metaCache;
  }
  async #sheet(title) {
    const s = (await this.meta()).find((x) => x.title === title);
    if (!s) throw new Error("Немає аркуша " + title);
    return s;
  }

  /** Прямокутні блоки значень. Кілька дрібних порцій ідуть одним запитом; великі — кількома (часткове виконання позначається). */
  async updateRanges(list) {
    if (!list.length) return { outcome: OUTCOME.APPLIED, calls: 0 };
    // Аргументи копіюються одразу: подальші зміни об'єктів викликача (або getter) не впливають на запит (R3-F4).
    const batches = rangeBatches(list.map((x) => ({ title: String(x.title), row: Number(x.row), col: Number(x.col), values: x.values.map((r) => r.slice()) })), this.maxChunkChars);
    return this.#parts("updateRanges", batches, async (bt) => {
      this.metrics.writes++;
      await this.#call("POST", "/values:batchUpdate", {
        valueInputOption: VALUE_INPUT_OPTION,
        data: bt.map((b) => ({ range: rangeA1(b.title, b.row, b.col, b.values.length, Math.max(...b.values.map((r) => r.length))), majorDimension: "ROWS", values: b.values })),
      }, [], this.policies.write, "updateRanges");
    });
  }

  /** Дописування — неідемпотентне: без автоповтору; невідомий результат з'ясовується читанням за ключем рядка. */
  async appendRows(title, rows) {
    if (!rows.length) return { outcome: OUTCOME.APPLIED, calls: 0 };
    const t = String(title), copy = rows.map((r) => r.slice());
    const width = Math.max(...copy.map((r) => r.length));
    try {
      return await this.#parts("appendRows", this.#chunks(copy), async (part) => {
        this.metrics.writes++;
        await this.#call("POST", "/values/" + encodeURIComponent(rangeA1(t, 1, 1, 1, width)) + ":append", { majorDimension: "ROWS", values: part },
          [["valueInputOption", VALUE_INPUT_OPTION], ["insertDataOption", "INSERT_ROWS"]], this.policies.write, "appendRows");
      });
    } finally { this.metaCache = null; }
  }

  /** Видалення рядків за НОМЕРОМ — позиційне й неідемпотентне. Робочі шляхи СШЗ його не використовують (лише старі
   *  інструменти тестової копії); автоповтору немає: повтор після втраченої відповіді видалив би сусідній рядок. */
  async deleteRows(title, rowNumbers) {
    if (!rowNumbers.length) return { outcome: OUTCOME.APPLIED, calls: 0 };
    const s = await this.#sheet(String(title));
    const sorted = [...new Set(rowNumbers.map(Number))].sort((a, b) => b - a);
    if (sorted.at(-1) < 2) throw new WriteOutcomeError("Заборонено видаляти рядок заголовка", { outcome: OUTCOME.NOT_APPLIED, op: "deleteRows", code: "HEADER" });
    this.metrics.writes++;
    try {
      await this.#call("POST", ":batchUpdate", { requests: sorted.map((n) => ({ deleteDimension: { range: { sheetId: s.sheetId, dimension: "ROWS", startIndex: n - 1, endIndex: n } } })) }, [], this.policies.write, "deleteRows");
      return { outcome: OUTCOME.APPLIED, calls: 1 };
    } finally { this.metaCache = null; }
  }

  async ensureSheet(title, header) {
    if ((await this.meta()).some((x) => x.title === title)) return false;
    this.metrics.writes++;
    try {
      await this.#call("POST", ":batchUpdate", { requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 50, columnCount: Math.max(2, header.length) } } } }] }, [], this.policies.write, "ensureSheet");
    } finally { this.metaCache = null; }
    await this.updateRanges([{ title, row: 1, col: 1, values: [header] }]);
    return true;
  }

  /** Числовий формат «0%» для колонки (рядки fromRow..toRow, з 1) — як у колонці «Знижка» чинної таблиці. */
  async setPercentFormat(title, col, fromRow, toRow) {
    if (col < 1 || toRow < fromRow) return;
    const s = await this.#sheet(title);
    this.metrics.writes++;
    await this.#call("POST", ":batchUpdate", { requests: [{ repeatCell: {
      range: { sheetId: s.sheetId, startRowIndex: fromRow - 1, endRowIndex: toRow, startColumnIndex: col - 1, endColumnIndex: col },
      cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0%" } } }, fields: "userEnteredFormat.numberFormat",
    } }] }, [], this.policies.write, "setPercentFormat");
  }

  async ensureColumns(title, n) {
    const s = await this.#sheet(title);
    if (s.columns >= n) return;
    this.metrics.writes++;
    try {
      await this.#call("POST", ":batchUpdate", { requests: [{ appendDimension: { sheetId: s.sheetId, dimension: "COLUMNS", length: n - s.columns } }] }, [], this.policies.write, "ensureColumns");
    } finally { this.metaCache = null; }
  }
}

/** Та сама поведінка в пам'яті (тести, локальні сухі прогони). book — { назва: values2D }.
 *
 *  Моделі збоїв (E1, fake transport) — `armFault({ op, nth = 1, mode, times = 1 })`, op — назва методу або «*»:
 *    reject   — запит відхилено ДО застосування (4xx)                              → NOT_APPLIED, таблиця без змін;
 *    lost     — запит ЗАСТОСОВАНО, відповідь втрачено                                → UNKNOWN, зміни є;
 *    timeout  — запит не дійшов / не застосовано, клієнт бачить тайм-аут            → UNKNOWN, змін немає;
 *    delay    — запит прийнято, але застосується ПІЗНІШЕ (`flushDelayed()`)         → UNKNOWN; модель запізнілого запиту старої оренди.
 *  `armFailure("метод#N")` — сумісність зі старими тестами: збій до застосування (NOT_APPLIED).
 *  `beforeWrite(op, args)` — гачок між рішенням відправити запит і його застосуванням: модель людини, яка правила / сортувала /
 *  вставляла рядок у цей момент. `maxBlocksPerCall` — updateRanges ділиться на кілька запитів (часткове виконання).
 *  `fence` — як у GoogleSheetsWriter: перевірка оренди перед кожним записом; відмова → NOT_APPLIED без застосування. */
export class MemorySheets {
  constructor(book, { fence = null, maxBlocksPerCall = Infinity } = {}) {
    this.book = book;
    this.metrics = { requests: 0, writes: 0, unknown: 0 };
    this.failOn = null; // «метод» або «метод#N» — N-й виклик методу має впасти (для тестів відкату)
    this.calls = {};
    this.faults = [];
    this.delayed = [];
    this.fence = fence;
    this.maxBlocksPerCall = maxBlocksPerCall;
    this.beforeWrite = null;
    this.log = []; // [{ op, outcome }] — аудит викликів запису (для тестів)
  }
  armFailure(spec) { this.failOn = spec; this.calls = {}; }
  armFault(f) { this.faults.push({ nth: 1, times: 1, seen: 0, ...f }); }
  /** Застосувати запізнілі запити (модель: Google застосував їх пізніше, ніж клієнт отримав тайм-аут). */
  flushDelayed() { const d = this.delayed; this.delayed = []; for (const f of d) f(); return d.length; }

  /** Один запит запису: fence → збій → гачок людини → застосування → (можливо) втрачена відповідь. */
  async #write(op, apply, args) {
    this.calls[op] = (this.calls[op] || 0) + 1;
    if (this.fence) {
      try { await this.fence.assertCurrent(); } catch (e) { this.log.push({ op, outcome: OUTCOME.NOT_APPLIED }); throw new WriteOutcomeError("оренда запису недійсна — запит не відправлено: " + (e?.message || e), { outcome: OUTCOME.NOT_APPLIED, op, code: e?.code || "STALE_LEASE", cause: e }); }
    }
    this.metrics.requests++;
    if (this.failOn) {
      const [name, nth] = this.failOn.split("#");
      if (name === op && (!nth || Number(nth) === this.calls[op])) { this.failOn = null; this.log.push({ op, outcome: OUTCOME.NOT_APPLIED }); throw new WriteOutcomeError("імітований збій " + op, { outcome: OUTCOME.NOT_APPLIED, op, code: "SIMULATED" }); }
    }
    const f = this.faults.find((x) => (x.op === op || x.op === "*") && x.times > 0 && ++x.seen >= x.nth);
    if (f) f.times--;
    if (this.beforeWrite) await this.beforeWrite(op, args, this);
    const mode = f?.mode;
    if (mode === "reject") { this.log.push({ op, outcome: OUTCOME.NOT_APPLIED }); throw new WriteOutcomeError("імітовано HTTP 400 " + op, { outcome: OUTCOME.NOT_APPLIED, op, status: 400, code: "REJECTED" }); }
    if (mode === "timeout") { this.metrics.unknown++; this.log.push({ op, outcome: OUTCOME.UNKNOWN }); throw new WriteOutcomeError("імітований тайм-аут " + op, { outcome: OUTCOME.UNKNOWN, op, code: "TIMEOUT" }); }
    if (mode === "delay") { this.delayed.push(apply); this.metrics.unknown++; this.log.push({ op, outcome: OUTCOME.UNKNOWN, delayed: true }); throw new WriteOutcomeError("імітовано: відповіді немає, запит застосується пізніше " + op, { outcome: OUTCOME.UNKNOWN, op, code: "TIMEOUT" }); }
    this.metrics.writes++;
    apply();
    if (mode === "lost") { this.metrics.unknown++; this.log.push({ op, outcome: OUTCOME.UNKNOWN, applied: true }); throw new WriteOutcomeError("імітовано: відповідь втрачено після застосування " + op, { outcome: OUTCOME.UNKNOWN, op, code: "NETWORK" }); }
    this.log.push({ op, outcome: OUTCOME.APPLIED });
  }

  /** Свіже читання (як GoogleSheetsSource.readBook): глибока копія без спільних посилань; порожні рядки в КІНЦІ аркуша не
   *  повертаються — як у Sheets API («empty trailing rows and columns will not be included»). */
  async read(names = Object.keys(this.book)) {
    const trim = (v) => { let n = v.length; while (n > 1 && !(v[n - 1] || []).some((x) => x !== "" && x != null)) n--; return v.slice(0, n).map((r) => r.slice()); };
    return Object.fromEntries(names.filter((n) => this.book[n]).map((n) => [n, trim(this.book[n])]));
  }
  async meta() {
    return Object.entries(this.book).map(([title, v], i) => ({ title, sheetId: i, rows: v.length, columns: Math.max(0, ...v.map((r) => r.length)) }));
  }
  async updateRanges(list) {
    if (!list.length) return { outcome: OUTCOME.APPLIED, calls: 0 };
    const blocks = list.map((x) => ({ title: String(x.title), row: Number(x.row), col: Number(x.col), values: x.values.map((r) => r.slice()) }));
    for (const b of blocks) if (!this.book[b.title]) throw new WriteOutcomeError("Немає аркуша " + b.title, { outcome: OUTCOME.NOT_APPLIED, op: "updateRanges", code: "NO_SHEET" });
    const calls = [];
    for (let i = 0; i < blocks.length; i += this.maxBlocksPerCall) calls.push(blocks.slice(i, i + this.maxBlocksPerCall));
    let applied = 0;
    for (const c of calls) {
      try {
        await this.#write("updateRanges", () => {
          for (const b of c) {
            const sheet = this.book[b.title];
            b.values.forEach((r, i) => {
              const row = (sheet[b.row - 1 + i] ||= []);
              r.forEach((v, j) => { while (row.length < b.col - 1 + j) row.push(""); row[b.col - 1 + j] = v; });
            });
          }
        }, c);
        applied++;
      } catch (e) { e.appliedParts = applied; e.totalParts = calls.length; throw e; }
    }
    return { outcome: OUTCOME.APPLIED, calls: applied };
  }
  async appendRows(title, rows) {
    if (!rows.length) return { outcome: OUTCOME.APPLIED, calls: 0 };
    const t = String(title), copy = rows.map((r) => r.slice());
    await this.#write("appendRows", () => {
      const sheet = this.book[t];
      let last = sheet.length;
      while (last > 1 && !(sheet[last - 1] || []).some((v) => v !== "" && v != null)) last--;
      sheet.splice(last, 0, ...copy.map((r) => r.slice()));
    }, { title: t, rows: copy });
    return { outcome: OUTCOME.APPLIED, calls: 1 };
  }
  async deleteRows(title, rowNumbers) {
    const t = String(title);
    const sorted = [...new Set(rowNumbers.map(Number))].sort((a, b) => b - a);
    if (sorted.at(-1) < 2) throw new WriteOutcomeError("Заборонено видаляти рядок заголовка", { outcome: OUTCOME.NOT_APPLIED, op: "deleteRows", code: "HEADER" });
    await this.#write("deleteRows", () => { for (const n of sorted) this.book[t].splice(n - 1, 1); }, { title: t, rows: sorted });
    return { outcome: OUTCOME.APPLIED, calls: 1 };
  }
  async ensureSheet(title, header) {
    if (this.book[title]) return false;
    this.book[title] = [header.slice()];
    return true;
  }
  async ensureColumns() {}
  async setPercentFormat(title, col, fromRow, toRow) {
    await this.#write("setPercentFormat", () => { (this.formats ||= {})[title + "!" + col] = { type: "PERCENT", pattern: "0%", fromRow, toRow }; }, { title, col });
  }

  // ---------- дії «людини» для тестів (не через API, без fence) ----------
  /** Правка клітинки людиною: рядок аркуша (з 1), назва колонки. */
  humanSet(title, row, column, value) { const h = this.book[title][0]; const j = h.indexOf(column); if (j < 0) throw new Error("немає колонки " + column); (this.book[title][row - 1] ||= [])[j] = value; }
  /** Сортування даних людиною за колонкою (рядок заголовка лишається). */
  humanSort(title, column, desc = false) {
    const sheet = this.book[title], j = sheet[0].indexOf(column);
    const rows = sheet.slice(1).sort((a, b) => String(a[j] ?? "").localeCompare(String(b[j] ?? ""), "uk") * (desc ? -1 : 1));
    sheet.splice(1, rows.length, ...rows); // той самий масив: посилання викликачів лишаються чинними
  }
  /** Вставка рядка людиною перед рядком аркуша `at` (з 1; 2 — одразу під заголовком). */
  humanInsertRow(title, at, values) { this.book[title].splice(at - 1, 0, values.slice()); }
}
