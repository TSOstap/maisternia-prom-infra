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
    // ENG-29 (метрики 02.11: «Журнал» ≈ 52 тис. рядків × 26 колонок — 84 запити на одне читання, бо порція рахується в клітинках):
    // targetBytes — порція великого аркуша за РОЗМІРОМ відповіді: після кожної порції наступна підбирається так, щоб відповідь була
    // ≈ targetBytes (виміряно на попередній), але зростала не більш ніж ×4 за крок і не перевищувала maxChunkRows рядків. Важкі
    // рядки (основний каталог ≈ 10 КБ) — як раніше; легкі («Журнал») — у рази менше запитів. Значення й позиції ті самі. Без
    // targetBytes — колишня поведінка.
    this.targetBytes = o.targetBytes || 0;
    this.maxChunkRows = o.maxChunkRows || 5000;
    this.maxRequestsPerMinute = o.maxRequestsPerMinute || 50;
    this.maxRequests = o.maxRequests || 60;
    this.maxAttempts = o.maxAttempts || 5;
    this.requestTimeoutMs = o.requestTimeoutMs || 170000; // сервер Sheets сам обриває запити понад 180 с
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
      // Відсутність токена — не мережева помилка: без повторів і з точним повідомленням.
      const token = await this.getAccessToken();
      let res, text;
      try {
        res = await this.fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" }, signal: AbortSignal.timeout(this.requestTimeoutMs) });
        text = await res.text();
      } catch (e) {
        if (attempt >= this.maxAttempts) throw new Error(e?.name === "TimeoutError" ? "Sheets API: перевищено час очікування" : "Sheets API недоступний (мережа)");
        this.metrics.retries++;
        await this.sleep(this.#backoff(attempt));
        continue;
      }
      this.metrics.ms += this.now() - started;
      this.metrics.bytes += Buffer.byteLength(text, "utf8");
      if (res.ok) {
        try { return JSON.parse(text); } catch { throw new Error("Sheets API: відповідь не є JSON"); }
      }
      if (RETRY_STATUS.has(res.status) && attempt < this.maxAttempts) {
        this.metrics.retries++;
        const ra = Number(res.headers?.get?.("retry-after"));
        // Retry-After обмежено 60 с: довше чекати в межах job немає сенсу.
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : this.#backoff(attempt));
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

  /** Назви й розміри аркушів (1 запит; кешується на час життя джерела). */
  async metadata() {
    if (this.metaCache) return this.metaCache;
    const meta = await this.#get("", [["fields", "sheets.properties(title,gridProperties(rowCount,columnCount))"]]);
    this.metaCache = (meta.sheets || []).map((s) => ({ title: s.properties.title, rows: s.properties.gridProperties?.rowCount || 0, columns: s.properties.gridProperties?.columnCount || 0 }));
    return this.metaCache;
  }

  /**
   * Лише ХВІСТ аркуша (напр. «Журнал», ~48 тис. рядків): вікна по windowRows рядків із кінця сітки назад,
   * доки не знайдуться рядки з даними. columns — скільки колонок читати (у «Журналі» 7).
   * Повертає рядки з даними в порядку аркуша (без заголовка) або null, якщо аркуша немає.
   */
  async loadTail(title, { windowRows = 2000, maxWindows = 10, columns = 7, until = null } = {}) {
    const s = (await this.metadata()).find((x) => x.title === title);
    if (!s) return null;
    const cols = Math.min(Math.max(1, s.columns), columns);
    const byTitle = { [title]: [] };
    const rows = () => byTitle[title].filter((r) => r && r.some((v) => v !== "" && v != null));
    let to = Math.max(1, s.rows);
    for (let w = 0; w < maxWindows && to >= 1; w++) {
      const from = Math.max(1, to - windowRows + 1);
      const [got] = await this.#fetch([{ title, from, to, cells: (to - from + 1) * cols, a1: a1Range(title, from, to, cols) }], byTitle);
      // until(rows) — умова зупинки (напр. знайдено останній успішний mtUpdate); без неї — перше вікно з даними.
      if (got > 0 && (!until || until(rows()))) break;
      to = from - 1;
    }
    this.metrics.tailWindows = (this.metrics.tailWindows || 0) + 1;
    return rows();
  }

  /** ENG-29: лише рядки заголовків аркушів (один запит) — { назва: [[заголовок]] }; відсутній аркуш пропускається. */
  async loadHeaders(titles) {
    const meta = await this.metadata();
    const found = meta.filter((s) => titles.includes(s.title));
    const byTitle = Object.fromEntries(found.map((s) => [s.title, []]));
    if (found.length) await this.#fetch(found.map((s) => this.#range(s, 1, 1)), byTitle);
    return Object.fromEntries(found.map((s) => [s.title, rectangular(byTitle[s.title])]));
  }

  /**
   * ENG-29: лише вибрані колонки аркуша (два запити: заголовок + колонки одним batchGet). Повертає повноширинний 2D-масив: заголовок
   * повністю, у рядках — значення лише цих колонок, решта клітинок порожні (позиції колонок і рядків — як у повному читанні).
   * Для запису за ключем, якому потрібні лише ключ, ідентичність і колонки зміни. Колонки, якої немає, — порожня (вирішує викликач).
   */
  async loadColumns(title, columns) {
    const s = (await this.metadata()).find((x) => x.title === title);
    if (!s) return null;
    const head = { [title]: [] };
    await this.#fetch([this.#range(s, 1, 1)], head);
    const header = (head[title][0] || []).map((v) => (v == null ? "" : String(v)));
    const idx = [...new Set(columns.map((c) => header.indexOf(c)).filter((i) => i >= 0))].sort((a, b) => a - b);
    const rows = Math.max(1, s.rows);
    const out = [header];
    if (idx.length && rows > 1) {
      // Суміжні колонки — одним діапазоном.
      const runs = [];
      for (const i of idx) { const last = runs.at(-1); if (last && last.to === i - 1) last.to = i; else runs.push({ from: i, to: i }); }
      const params = runs.map((r) => ["ranges", `${a1Range(title, 2, rows, r.to + 1).replace(/!A2:/, "!" + columnLetter(r.from + 1) + "2:")}`]);
      params.push(["valueRenderOption", "UNFORMATTED_VALUE"], ["dateTimeRenderOption", "FORMATTED_STRING"], ["majorDimension", "ROWS"]);
      const res = await this.#get("/values:batchGet", params);
      const vr = res.valueRanges || [];
      if (vr.length !== runs.length) throw new Error("Sheets API: кількість діапазонів у відповіді не збігається із запитом");
      const n = Math.max(0, ...vr.map((v) => (v.values || []).length));
      if (n > rows - 1) throw new Error("Sheets API: діапазон повернув більше рядків, ніж запитано");
      for (let k = 0; k < n; k++) out.push(Array.from({ length: header.length }, () => ""));
      runs.forEach((r, j) => (vr[j].values || []).forEach((row, k) => { for (let c = r.from; c <= r.to; c++) out[k + 1][c] = row[c - r.from] ?? ""; }));
      this.metrics.ranges += runs.length;
    }
    return out;
  }

  /** Один batchGet; значення кладуться на абсолютні позиції рядків. Повертає кількість отриманих рядків на діапазон. */
  async #fetch(batch, byTitle) {
    const params = batch.map((r) => ["ranges", r.a1]);
    params.push(["valueRenderOption", "UNFORMATTED_VALUE"], ["dateTimeRenderOption", "FORMATTED_STRING"], ["majorDimension", "ROWS"]);
    const res = await this.#get("/values:batchGet", params);
    const vr = res.valueRanges || [];
    if (vr.length !== batch.length) throw new Error("Sheets API: кількість діапазонів у відповіді не збігається із запитом");
    return batch.map((r, i) => {
      this.metrics.ranges++;
      const rows = vr[i].values || [];
      if (rows.length > r.to - r.from + 1) throw new Error("Sheets API: діапазон повернув більше рядків, ніж запитано");
      // Абсолютні позиції: API обрізає порожні рядки в КІНЦІ діапазону — без цього зсунулися б наступні порції.
      rows.forEach((row, k) => { byTitle[r.title][r.from - 1 + k] = row; });
      return rows.length;
    });
  }

  #range(s, from, to) {
    const cols = Math.max(1, s.columns);
    return { title: s.title, from, to, cells: (to - from + 1) * cols, a1: a1Range(s.title, from, to, cols) };
  }

  async load(sheetNames) {
    const started = this.now();
    const meta = await this.metadata();
    const wanted = new Set([...sheetNames, this.groupsSheet]);
    const found = meta.filter((s) => wanted.has(s.title));
    const byTitle = Object.fromEntries(found.map((s) => [s.title, []]));
    const rowsOf = (s) => Math.max(1, s.rows);
    const fits = (s) => rowsOf(s) * Math.max(1, s.columns) <= this.chunkCells;

    // Малі аркуші (цілком у бюджет клітинок) — разом, кількома діапазонами в одному запиті.
    let batch = [];
    let cells = 0;
    for (const s of found.filter(fits)) {
      const r = this.#range(s, 1, rowsOf(s));
      if (batch.length && cells + r.cells > this.chunkCells) { await this.#fetch(batch, byTitle); batch = []; cells = 0; }
      batch.push(r); cells += r.cells;
    }
    if (batch.length) await this.#fetch(batch, byTitle);

    // Великі аркуші — послідовними порціями. Сітка Google часто має тисячі порожніх рядків після даних:
    // щойно порція повернула менше рядків, ніж запитано, увесь залишок перевіряється ОДНИМ запитом
    // (порожня відповідь майже нічого не важить), а не десятками порцій.
    for (const s of found.filter((x) => !fits(x))) {
      let step = Math.max(1, Math.floor(this.chunkCells / Math.max(1, s.columns)));
      for (let from = 1; from <= rowsOf(s);) {
        const to = Math.min(rowsOf(s), from + step - 1);
        const bytes0 = this.metrics.bytes;
        const [got] = await this.#fetch([this.#range(s, from, to)], byTitle);
        if (got < to - from + 1 && to < rowsOf(s)) {
          this.metrics.tailProbes = (this.metrics.tailProbes || 0) + 1;
          const [tail] = await this.#fetch([this.#range(s, to + 1, rowsOf(s))], byTitle);
          // Дані після порожнього проміжку — аномалія (readSheet зупинить як «порожній рядок усередині»), але позиції збережено.
          if (tail > 0) this.metrics.dataAfterGap = (this.metrics.dataAfterGap || 0) + 1;
          break;
        }
        from = to + 1;
        if (this.targetBytes && got > 0) {
          const perRow = Math.max(1, (this.metrics.bytes - bytes0) / got);
          step = Math.max(1, Math.min(this.maxChunkRows, step * 4, Math.floor(this.targetBytes / perRow)));
          this.metrics.adaptiveMaxRows = Math.max(this.metrics.adaptiveMaxRows || 0, step);
        }
      }
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
