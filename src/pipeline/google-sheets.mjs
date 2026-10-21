/** Джерело каталогу: Google Sheets API v4, ЛИШЕ ЧИТАННЯ (етап C2-B).
 *
 *  Той самий контракт, що й NdjsonCatalogSource: load(sheetNames) → { sheets: {назва: values2D}, groups: values2D }.
 *  values2D повторює getDataRange().getValues() чинного Apps Script:
 *   - прямокутна таблиця, порожні клітинки = '';
 *   - хвіст порожніх рядків і колонок обрізано; порожні рядки ВСЕРЕДИНІ зберігаються на своїх місцях
 *     (їх виявить readSheet — «Порожній рядок усередині каталогу», як у LIVE).
 *  Читання: valueRenderOption=UNFORMATTED_VALUE (числа — числами, як getValues),
 *           dateTimeRenderOption=FORMATTED_STRING (у незмінних колонках дат немає; «Оновлено» — рядок ISO).
 *
 *  Квоти Sheets API (COSTS.md): 300 read/хв на проєкт, 60 read/хв на користувача.
 *  Захист: темп ≤ maxRequestsPerMinute, жорстка межа maxRequests на запуск, повтор 429/5xx з backoff.
 *  Токен ніколи не логуються; адреси в помилках маскуються. */
import { sanitize } from "../core/text.mjs";

const API = "https://sheets.googleapis.com/v4/spreadsheets/";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export function columnLetter(n) {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** A1-нотація з назвою аркуша: 'Назва'!A1:AN400 (апостроф у назві подвоюється). */
export function a1Range(title, fromRow, toRow, columns) {
  return `'${title.replace(/'/g, "''")}'!A${fromRow}:${columnLetter(columns)}${toRow}`;
}

function rectangular(rowsByIndex) {
  let last = rowsByIndex.length - 1;
  while (last >= 0 && !(rowsByIndex[last] || []).some((v) => v !== "" && v != null)) last--;
  let width = 0;
  for (let i = 0; i <= last; i++) {
    const r = rowsByIndex[i] || [];
    for (let j = r.length - 1; j >= 0; j--) if (r[j] !== "" && r[j] != null) { width = Math.max(width, j + 1); break; }
  }
  const out = [];
  for (let i = 0; i <= last; i++) {
    const r = rowsByIndex[i] || [];
    out.push(Array.from({ length: width }, (_, j) => (r[j] == null ? "" : r[j])));
  }
  return out;
}

export class GoogleSheetsCatalogSource {
  /**
   * @param o.spreadsheetId       ID таблиці (з секрету середовища; не логувати)
   * @param o.getAccessToken      async () => рядок токена OAuth зі scope spreadsheets.readonly
   * @param o.groupsSheet         назва аркуша груп (за замовчуванням «Групи»)
   * @param o.chunkRows           рядків 40-колонкового аркуша на один запит (≈10 КБ/рядок основного каталогу → ~4 МБ відповіді);
   *                              бюджет рахується в КЛІТИНКАХ (chunkRows × 40), тож вузькі аркуші («Заморожені ID») читаються одним запитом
   * @param o.maxRequestsPerMinute, o.maxRequests, o.maxAttempts, o.fetchImpl, o.sleep, o.now — для тестів і квот
   */
  constructor(o) {
    if (!o?.spreadsheetId || !/^[A-Za-z0-9_-]{20,}$/.test(o.spreadsheetId)) throw new Error("Невалідний ID таблиці");
    if (typeof o.getAccessToken !== "function") throw new Error("Немає джерела токена доступу");
    this.id = o.spreadsheetId;
    this.getAccessToken = o.getAccessToken;
    this.groupsSheet = o.groupsSheet || "Групи";
    this.chunkCells = (o.chunkRows || 400) * 40;
    this.maxRequestsPerMinute = o.maxRequestsPerMinute || 50;
    this.maxRequests = o.maxRequests || 60;
    this.maxAttempts = o.maxAttempts || 5;
    this.fetch = o.fetchImpl || globalThis.fetch;
    this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now || (() => Date.now());
    this.metrics = { requests: 0, retries: 0, bytes: 0, ms: 0, ranges: 0 };
    this.window = [];
  }

  async #pace() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < 60000);
    if (this.window.length >= this.maxRequestsPerMinute) {
      await this.sleep(60000 - (now - this.window[0]) + 50);
      return this.#pace();
    }
    this.window.push(this.now());
  }

  async #get(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of params) qs.append(k, v);
    const url = API + encodeURIComponent(this.id) + path + "?" + qs.toString();
    for (let attempt = 1; ; attempt++) {
      if (this.metrics.requests >= this.maxRequests) throw new Error(`Перевищено межу ${this.maxRequests} запитів Sheets API на запуск — читання зупинено (захист квоти)`);
      await this.#pace();
      this.metrics.requests++;
      const started = this.now();
      let res;
      try {
        res = await this.fetch(url, { headers: { Authorization: "Bearer " + (await this.getAccessToken()), Accept: "application/json" } });
      } catch (e) {
        if (attempt >= this.maxAttempts) throw new Error("Sheets API недоступний (мережа): " + sanitize(e));
        this.metrics.retries++;
        await this.sleep(this.#backoff(attempt));
        continue;
      }
      const text = await res.text();
      this.metrics.ms += this.now() - started;
      this.metrics.bytes += Buffer.byteLength(text, "utf8");
      if (res.ok) return JSON.parse(text);
      if (RETRY_STATUS.has(res.status) && attempt < this.maxAttempts) {
        this.metrics.retries++;
        const ra = Number(res.headers?.get?.("retry-after"));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : this.#backoff(attempt));
        continue;
      }
      let reason = "";
      try { reason = JSON.parse(text)?.error?.status || ""; } catch { /* тіло не JSON */ }
      const hint = res.status === 403 || res.status === 404
        ? "перевірте, що таблиця поділена з service account як «Читач», а в проєкті увімкнено Google Sheets API"
        : res.status === 401 ? "токен недійсний або прострочений" : res.status === 429 ? "вичерпано квоту запитів — повторіть пізніше" : "помилка сервісу";
      throw new Error(`Sheets API HTTP ${res.status}${reason ? " " + reason : ""}: ${hint}`);
    }
  }

  #backoff(attempt) {
    return Math.min(32000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
  }

  /** Назви й розміри аркушів (1 запит). */
  async metadata() {
    const meta = await this.#get("", [["fields", "sheets.properties(title,gridProperties(rowCount,columnCount))"]]);
    return (meta.sheets || []).map((s) => ({ title: s.properties.title, rows: s.properties.gridProperties?.rowCount || 0, columns: s.properties.gridProperties?.columnCount || 0 }));
  }

  /** Плани діапазонів → пакети batchGet (кілька малих аркушів в одному запиті). */
  #plan(found) {
    const ranges = [];
    for (const s of found) {
      const cols = Math.max(1, s.columns);
      const step = Math.max(1, Math.floor(this.chunkCells / cols));
      for (let from = 1; from <= Math.max(1, s.rows); from += step) {
        const to = Math.min(Math.max(1, s.rows), from + step - 1);
        ranges.push({ title: s.title, from, to, cells: (to - from + 1) * cols, a1: a1Range(s.title, from, to, cols) });
      }
    }
    const batches = [];
    let current = [];
    let cells = 0;
    for (const r of ranges) {
      if (current.length && cells + r.cells > this.chunkCells) { batches.push(current); current = []; cells = 0; }
      current.push(r); cells += r.cells;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  async load(sheetNames) {
    const started = this.now();
    const meta = await this.metadata();
    const wanted = new Set([...sheetNames, this.groupsSheet]);
    const found = meta.filter((s) => wanted.has(s.title));
    const byTitle = Object.fromEntries(found.map((s) => [s.title, []]));
    for (const batch of this.#plan(found)) {
      const params = batch.map((r) => ["ranges", r.a1]);
      params.push(["valueRenderOption", "UNFORMATTED_VALUE"], ["dateTimeRenderOption", "FORMATTED_STRING"], ["majorDimension", "ROWS"]);
      const res = await this.#get("/values:batchGet", params);
      const vr = res.valueRanges || [];
      if (vr.length !== batch.length) throw new Error("Sheets API: кількість діапазонів у відповіді не збігається із запитом");
      batch.forEach((r, i) => {
        this.metrics.ranges++;
        const rows = vr[i].values || [];
        if (rows.length > r.to - r.from + 1) throw new Error("Sheets API: діапазон повернув більше рядків, ніж запитано");
        // Абсолютні позиції: API обрізає порожні рядки в КІНЦІ діапазону — без цього зсунулися б наступні порції.
        rows.forEach((row, k) => { byTitle[r.title][r.from - 1 + k] = row; });
      });
    }
    const sheets = {};
    for (const s of found) if (s.title !== this.groupsSheet || sheetNames.includes(s.title)) sheets[s.title] = rectangular(byTitle[s.title]);
    const groups = byTitle[this.groupsSheet] ? rectangular(byTitle[this.groupsSheet]) : null;
    if (!groups) throw new Error("Немає аркуша " + this.groupsSheet);
    this.metrics.loadMs = this.now() - started;
    return { sheets, groups };
  }
}

/** Токен з оточення (у GitHub Actions його видає google-github-actions/auth; у логи не потрапляє). */
export function envAccessToken(name = "GOOGLE_OAUTH_ACCESS_TOKEN") {
  return async () => {
    const t = process.env[name];
    if (!t) throw new Error(`Немає токена доступу в змінній ${name}`);
    return t;
  };
}
