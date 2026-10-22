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
 *  RAW: значення пишуться як є (без розбору формул/дат) — рядок ISO лишається рядком, «20%» — рядком. */
import { columnLetter } from "./google-sheets.mjs";

const API = "https://sheets.googleapis.com/v4/spreadsheets/";
const RETRY = new Set([429, 500, 502, 503, 504]);
export const rangeA1 = (title, row, col, rows, cols) =>
  `'${title.replace(/'/g, "''")}'!${columnLetter(col)}${row}:${columnLetter(col + Math.max(1, cols) - 1)}${row + Math.max(1, rows) - 1}`;

export class GoogleSheetsWriter {
  constructor({ spreadsheetId, liveSpreadsheetId, getAccessToken, fetchImpl, sleep, now, maxRequests = 40, maxAttempts = 4, maxRequestsPerMinute = 50, maxChunkChars = 2_000_000 }) {
    if (!spreadsheetId || !/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) throw new Error("Невалідний ID тестової таблиці");
    if (!liveSpreadsheetId) throw new Error("Для захисту потрібен ID живої таблиці (запис у неї заборонено)");
    if (spreadsheetId === liveSpreadsheetId) throw new Error("ЗАБОРОНЕНО: цільова таблиця — ЖИВА. Запис дозволено лише в тестову копію");
    this.id = spreadsheetId;
    this.getAccessToken = getAccessToken;
    this.fetch = fetchImpl || globalThis.fetch;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRequests = maxRequests;
    this.maxAttempts = maxAttempts;
    this.metrics = { requests: 0, retries: 0, writes: 0 };
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

  /** Ділить рядки на порції за розміром JSON. */
  #chunks(rows) {
    const out = [];
    let cur = [], size = 0;
    for (const r of rows) {
      const s = JSON.stringify(r).length;
      if (cur.length && size + s > this.maxChunkChars) { out.push(cur); cur = []; size = 0; }
      cur.push(r); size += s;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  async #call(method, path, body, params = []) {
    const qs = new URLSearchParams(params).toString();
    const url = API + encodeURIComponent(this.id) + path + (qs ? "?" + qs : "");
    for (let attempt = 1; ; attempt++) {
      if (this.metrics.requests >= this.maxRequests) throw new Error(`Перевищено межу ${this.maxRequests} запитів запису на запуск (захист квоти)`);
      this.metrics.requests++;
      await this.#pace();
      const token = await this.getAccessToken();
      let res, text;
      try {
        res = await this.fetch(url, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(170000) });
        text = await res.text();
      } catch {
        if (attempt >= this.maxAttempts) throw new Error("Sheets API недоступний (мережа)");
        this.metrics.retries++;
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.ok) return text ? JSON.parse(text) : {};
      if (RETRY.has(res.status) && attempt < this.maxAttempts) { this.metrics.retries++; await this.sleep(1000 * 2 ** attempt); continue; }
      let reason = "";
      try { reason = JSON.parse(text)?.error?.status || ""; } catch { /* */ }
      const hint = res.status === 403 ? "немає права запису: таблиця має бути поділена зі службовим акаунтом як «Редактор» (лише тестова копія)" : "помилка Sheets API";
      throw new Error(`Sheets API HTTP ${res.status}${reason ? " " + reason : ""}: ${hint}`);
    }
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

  async updateRanges(list) {
    if (!list.length) return;
    // Кожен блок — порціями рядків; кілька дрібних порцій можуть іти одним запитом.
    const parts = [];
    for (const b of list) {
      let row = b.row;
      for (const values of this.#chunks(b.values)) { parts.push({ title: b.title, row, col: b.col, values }); row += values.length; }
    }
    let batch = [], size = 0;
    const flush = async () => {
      if (!batch.length) return;
      this.metrics.writes++;
      await this.#call("POST", "/values:batchUpdate", {
        valueInputOption: "RAW",
        data: batch.map((b) => ({ range: rangeA1(b.title, b.row, b.col, b.values.length, Math.max(...b.values.map((r) => r.length))), majorDimension: "ROWS", values: b.values })),
      });
      batch = []; size = 0;
    };
    for (const p of parts) {
      const s = JSON.stringify(p.values).length;
      if (batch.length && size + s > this.maxChunkChars) await flush();
      batch.push(p); size += s;
    }
    await flush();
  }

  async appendRows(title, rows) {
    if (!rows.length) return;
    this.metrics.writes++;
    const width = Math.max(...rows.map((r) => r.length));
    for (const part of this.#chunks(rows)) {
      await this.#call("POST", "/values/" + encodeURIComponent(rangeA1(title, 1, 1, 1, width)) + ":append", { majorDimension: "ROWS", values: part },
        [["valueInputOption", "RAW"], ["insertDataOption", "INSERT_ROWS"]]);
    }
    this.metaCache = null;
  }

  async deleteRows(title, rowNumbers) {
    if (!rowNumbers.length) return;
    const s = await this.#sheet(title);
    const sorted = [...new Set(rowNumbers)].sort((a, b) => b - a);
    if (sorted.at(-1) < 2) throw new Error("Заборонено видаляти рядок заголовка");
    this.metrics.writes++;
    await this.#call("POST", ":batchUpdate", { requests: sorted.map((n) => ({ deleteDimension: { range: { sheetId: s.sheetId, dimension: "ROWS", startIndex: n - 1, endIndex: n } } })) });
    this.metaCache = null;
  }

  async ensureSheet(title, header) {
    if ((await this.meta()).some((x) => x.title === title)) return false;
    this.metrics.writes++;
    await this.#call("POST", ":batchUpdate", { requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 50, columnCount: Math.max(2, header.length) } } } }] });
    this.metaCache = null;
    await this.updateRanges([{ title, row: 1, col: 1, values: [header] }]);
    return true;
  }

  async ensureColumns(title, n) {
    const s = await this.#sheet(title);
    if (s.columns >= n) return;
    this.metrics.writes++;
    await this.#call("POST", ":batchUpdate", { requests: [{ appendDimension: { sheetId: s.sheetId, dimension: "COLUMNS", length: n - s.columns } }] });
    this.metaCache = null;
  }
}

/** Та сама поведінка в пам'яті (тести, локальні сухі прогони). book — { назва: values2D }. */
export class MemorySheets {
  constructor(book) {
    this.book = book;
    this.metrics = { requests: 0, writes: 0 };
    this.failOn = null; // назва методу, що має впасти (для тестів відкату)
  }
  #check(op) { if (this.failOn === op) { this.failOn = null; throw new Error("імітований збій " + op); } }
  async meta() {
    return Object.entries(this.book).map(([title, v], i) => ({ title, sheetId: i, rows: v.length, columns: Math.max(0, ...v.map((r) => r.length)) }));
  }
  async updateRanges(list) {
    this.#check("updateRanges");
    this.metrics.writes++;
    for (const b of list) {
      const sheet = this.book[b.title];
      if (!sheet) throw new Error("Немає аркуша " + b.title);
      b.values.forEach((r, i) => {
        const row = (sheet[b.row - 1 + i] ||= []);
        r.forEach((v, j) => { while (row.length < b.col - 1 + j) row.push(""); row[b.col - 1 + j] = v; });
      });
    }
  }
  async appendRows(title, rows) {
    this.#check("appendRows");
    this.metrics.writes++;
    const sheet = this.book[title];
    let last = sheet.length;
    while (last > 1 && !(sheet[last - 1] || []).some((v) => v !== "" && v != null)) last--;
    sheet.splice(last, 0, ...rows.map((r) => r.slice()));
  }
  async deleteRows(title, rowNumbers) {
    this.#check("deleteRows");
    this.metrics.writes++;
    const sorted = [...new Set(rowNumbers)].sort((a, b) => b - a);
    if (sorted.at(-1) < 2) throw new Error("Заборонено видаляти рядок заголовка");
    for (const n of sorted) this.book[title].splice(n - 1, 1);
  }
  async ensureSheet(title, header) {
    if (this.book[title]) return false;
    this.book[title] = [header.slice()];
    return true;
  }
  async ensureColumns() {}
}
