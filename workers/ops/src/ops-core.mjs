/** «mm-ops» — серверний диспетчер кнопок таблиці TEST (ENG-29, рішення власника 02.11: повний варіант, безкоштовно).
 *
 *  Один SQLite Durable Object «main» (Cloudflare Free) зберігає:
 *   • w2 / w2_req — сховище W2 (оренди, журнал операцій, плани, контрольна точка CC) — ядро src/pipeline/safe-write/w2-engine.mjs;
 *   • runs        — запуски операцій кнопок (хто, що, коли, підсумок для власника);
 *   • inputs      — погоджені файли поза репозиторієм (FZ, OV, A3, контракт CC): відбиток SHA-256 перевіряє запускач.
 *  Кнопка (Apps Script) → POST /button {op} → якщо нічого не виконується — запуск GitHub workflow ops.yml (workflow_dispatch);
 *  повторне натискання під час виконання — «уже виконується», нового запуску немає. Сам запис у таблицю робить лише запускач
 *  у GitHub Actions — через шлюз W2 (оренда + журнал + fencing), сховищем якого є цей самий об'єкт.
 *  Увесь код роботи зі сховищем синхронний (SQL API Durable Object) і виконується в transactionSync — атомарно.
 *  Автопошук новинок (рішення власника 03.11) — alarm цього ж об'єкта (new-items.mjs): кожні 15 хв ID фіду проти знімка
 *  «Знайти нові товари»; є нові — запуск тієї самої операції, що й кнопка (op find-new). Вмикає / вимикає оператор (/admin/watch). */
import { w2Handle, w2Seed, REQ_KEEP_MS } from "../../../src/pipeline/safe-write/w2-engine.mjs";
import { WATCH, MIN, AUTO_BY, FIND_NEW_SEEN_KEY, fetchIds, watchPrecheck, decideWatch, markWatchDispatch, INCOMPLETE_CHECK_MINUTES, fetchContentFeed, completedNow, dispatchBlock } from "./new-items.mjs";
import { runPricesJob } from "./prices-job.mjs";
import { RemoteStore } from "../../../src/pipeline/safe-write/store.mjs";
import { ownerSummary } from "../../../src/pipeline/ops-summary.mjs";
import { FeedStore, runFeedJob, serveFeed } from "./yml-feed.mjs";

export const OPS = Object.freeze({
  transfer: "Перенести затверджені",
  "find-new": "Знайти нові товари",
  update: "Оновити товари",
  prices: "Оновити ціни й наявність",
  reconcile: "Звірити незавершені записи",
  "deferred-plan": "Відкладені товари: план",
  deferred: "Відкладені товари: розібрати",
  "drop-deferred": "Відкладені товари: прибрати вкладку",
});
/** Типова тривалість (виміряно на TEST 02.11: «Оновити» ≈ 18 хв, «Знайти нові» ≈ 3 хв, «Перенести» 3–13 хв залежно від кількості). */
const DURATION = Object.freeze({ transfer: "3–15 хвилин", "find-new": "3–5 хвилин", update: "15–20 хвилин", prices: "3–5 хвилин", reconcile: "2–4 хвилини" });
/** «Ціни й наявність» на самому сервері Cloudflare (PRICES_RUNNER="do") — без хвилин GitHub. */
const DO_DURATION = "1–2 хвилини";
export const PRICES_JOB_KEY = "prices-job";
/** Розклад «Ціни й наявність» на сервері (рішення власника: кожні 2 год — після підключення Prom; типово вимкнено). */
export const PRICES_SCHEDULE_KEY = "prices-schedule";
export const SCHEDULE_BY = "Розклад (сервер)";
/** YML для Prom на сервері (yml-feed.mjs): черга завдань «build» (повна збірка) / «sync» (ціни й наявність у готових offer). */
export const FEED_JOB_KEY = "feed-job";
/** Операції GitHub, що змінюють картки «Основного каталогу», — після них повна збірка YML. */
const CONTENT_OPS = new Set(["update", "transfer", "deferred"]);
/** Кнопки меню (ключ кнопок) — лише ці дії; разові операції (відкладені товари) — лише вручну з GitHub. */
const BUTTON_OPS = new Set(["transfer", "find-new", "update", "prices", "reconcile"]);
const ACTIVE = new Set(["DISPATCHING", "QUEUED", "RUNNING"]);
/** Після цього часу без звісток запуск вважається завислим (job ops.yml має timeout-minutes 60) — кнопка знову доступна.
 *  Захист таблиці від цього не залежить: оренда W2 і журнал операцій не дадуть двом записувачам писати одночасно. */
export const ACTIVE_MS = 90 * 60_000;
const INPUT_NAME = /^[a-z0-9-]{1,40}$/;
const MAX_INPUT_CHARS = 1_500_000;
const KEEP_RUNS = 200;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS w2 (k TEXT PRIMARY KEY, version TEXT NOT NULL, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS w2_chunk (k TEXT NOT NULL, i INTEGER NOT NULL, part TEXT NOT NULL, PRIMARY KEY (k, i))",
  "CREATE TABLE IF NOT EXISTS w2_req (id TEXT PRIMARY KEY, at INTEGER NOT NULL, res TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, op TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL, updated INTEGER NOT NULL, info TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS inputs (name TEXT PRIMARY KEY, sha TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
];

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
export const randomHex = (n = 16) => hex(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256Hex(text) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))); }

/** Порівняння ключа за сталий час. */
export function sameKey(a, b) {
  const x = new TextEncoder().encode(String(a ?? "")), y = new TextEncoder().encode(String(b ?? ""));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length >= 20;
}
/** Роль за ключем і шляхом: кнопка (BUTTON_KEY), запускач (RUNNER_KEY), адміністратор (ADMIN_KEY). */
export function roleFor(req, env) {
  const key = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const p = new URL(req.url).pathname;
  const need = p === "/button" || p === "/status" ? "BUTTON_KEY" : p.startsWith("/admin/") ? "ADMIN_KEY" : p === "/w2" || p.startsWith("/inputs/") || p.startsWith("/run/") ? "RUNNER_KEY" : null;
  return need && sameKey(key, env[need]) ? need : null;
}

/** Рядок SQLite у Durable Object — до 2 МБ. Більше значення (журнал операцій W2 росте до 5000 записів) зберігається частинами по
 *  CHUNK символів (UTF-16: ≤ 3 байти UTF-8 на одиницю → ≤ 1,5 МБ на частину) у w2_chunk; у w2.v тоді — позначка «#chunks:N», яка не може бути JSON. */
export const CHUNK = 500_000;
// JSON.stringify ніколи не починається з «#» (лише { [ " цифра - t f n), а NUL у тексті SQLite обрізає рядок — тому «#».
const CHUNKED = "#chunks:";
/** SQL-адаптер сховища W2 для w2-engine (ті самі методи, що memKv у тестах). Виклики — у transactionSync (атомарно разом із частинами). */
export function w2Kv(sql) {
  return {
    get(k) {
      const r = sql.exec("SELECT version, v FROM w2 WHERE k = ?", k).toArray()[0];
      if (!r) return null;
      if (!r.v.startsWith(CHUNKED)) return { version: r.version, value: JSON.parse(r.v) };
      const n = Number(r.v.slice(CHUNKED.length));
      const parts = sql.exec("SELECT i, part FROM w2_chunk WHERE k = ? ORDER BY i", k).toArray();
      if (parts.length !== n || parts.some((p, i) => Number(p.i) !== i)) throw new Error("W2: пошкоджене значення частинами: " + k);
      return { version: r.version, value: JSON.parse(parts.map((p) => p.part).join("")) };
    },
    set(k, value, version) {
      const s = JSON.stringify(value ?? null);
      sql.exec("DELETE FROM w2_chunk WHERE k = ?", k);
      let v = s;
      if (s.length > CHUNK) {
        const n = Math.ceil(s.length / CHUNK);
        for (let i = 0; i < n; i++) sql.exec("INSERT INTO w2_chunk (k, i, part) VALUES (?, ?, ?)", k, i, s.slice(i * CHUNK, (i + 1) * CHUNK));
        v = CHUNKED + n;
      }
      sql.exec("INSERT INTO w2 (k, version, v) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET version = excluded.version, v = excluded.v", k, version, v);
    },
    getReq(id) { const r = sql.exec("SELECT res FROM w2_req WHERE id = ?", id).toArray()[0]; return r ? JSON.parse(r.res) : null; },
    putReq(id, at, res) { sql.exec("INSERT INTO w2_req (id, at, res) VALUES (?, ?, ?)", id, at, JSON.stringify(res)); },
    count() { return Number(sql.exec("SELECT COUNT(*) AS n FROM w2").toArray()[0].n); },
  };
}

export class OpsCore {
  /** storage — ctx.storage SQLite Durable Object ({ sql.exec, transactionSync }); env — змінні й секрети Worker. */
  constructor(storage, env, { now = () => Date.now(), fetchImpl = (...a) => fetch(...a), pricesJobImpl = runPricesJob, feedJobImpl = runFeedJob } = {}) {
    this.storage = storage; this.env = env; this.now = now; this.fetchImpl = fetchImpl; this.pricesJobImpl = pricesJobImpl; this.feedJobImpl = feedJobImpl;
    this.sql = storage.sql;
    // 04.11: вичерпаний ліміт записів Workers Free (100 000 рядків / добу) не має «класти» DO цілком — схема вже створена раніше,
    // а читання (віддача фіду Prom, стан) працюють і без записів; операції із записом повернуть помилку самі.
    try { for (const q of SCHEMA) this.sql.exec(q); } catch (e) { this.schemaError = String(e?.message || e); }
    this.kv = w2Kv(this.sql);
    this.feed = new FeedStore(this.sql, (fn) => this.tx(fn));
  }
  rows(q, ...b) { return this.sql.exec(q, ...b).toArray(); }
  tx(fn) { return this.storage.transactionSync(fn); }

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    try {
      if (m === "POST" && p === "/button") return json(await this.button(await req.json().catch(() => ({}))));
      if (m === "GET" && p === "/status") return json(this.status());
      if (m === "POST" && p === "/w2") return this.w2(await req.json().catch(() => null));
      if (m === "GET" && p.startsWith("/inputs/")) return this.getInput(decodeURIComponent(p.slice(8)));
      if (m === "POST" && p === "/run/start") return json(this.runStart(await req.json().catch(() => ({}))));
      if (m === "POST" && p === "/run/finish") return json(await this.runFinish(await req.json().catch(() => ({}))));
      // YML для Prom: віддача — лише через вхідний Worker після перевірки секрету в адресі (index.mjs); адміністрування — ключ адміністратора.
      if ((m === "GET" || m === "HEAD") && p === "/internal/feed") return serveFeed(this.feed, { method: m });
      if (m === "POST" && p === "/admin/yml") return json(await this.ymlAdmin(await req.json().catch(() => ({}))));
      if (m === "PUT" && p.startsWith("/admin/inputs/")) return json(await this.putInput(decodeURIComponent(p.slice(14)), await req.text()));
      if (m === "GET" && p === "/admin/inputs") return json({ inputs: this.rows("SELECT name, sha, size, at FROM inputs ORDER BY name") });
      if (m === "POST" && p === "/admin/w2-seed") { const b = await req.json().catch(() => null); const r = this.tx(() => w2Seed(this.kv, b?.entries)); return json(r, r.error ? 409 : 200); }
      if (m === "GET" && p === "/admin/w2-dump") return json({ entries: this.rows("SELECT k FROM w2 ORDER BY k").map((r) => { const e = this.kv.get(r.k); return { key: r.k, version: e.version, value: e.value }; }) });
      if (m === "GET" && p === "/admin/runs") return json({ runs: this.recentRuns(50) });
      // Ремонт журналу операцій W2 оператором (ENG-29: стиснення журналу, що перевищив межі): лише ключі state/write-journal/*, лише CAS
      // за версією і лише коли немає чинної оренди sheets-main (ніхто не пише).
      if (m === "POST" && p === "/admin/w2-replace-journal") {
        const b = await req.json().catch(() => null);
        if (!b || !/^state\/write-journal\/[a-z0-9:_-]+\.json$/.test(String(b.key)) || typeof b.version !== "string") return json({ error: { code: "BAD_REQUEST", message: "потрібні key (state/write-journal/*) і version" } }, 400);
        const r = this.tx(() => {
          const lease = this.kv.get("state/write-lease/sheets-main.json")?.value;
          if (lease && !lease.released && this.now() < Number(lease.expiresAt) + 200_000) return { error: { code: "BUSY", message: "є чинна оренда — ремонт журналу заборонено" } };
          // Лише версія — без розбору старого значення (саме воно може перевищувати межі пам'яті Worker).
          const cur = this.rows("SELECT version FROM w2 WHERE k = ?", b.key)[0];
          if (!cur || cur.version !== b.version) return { error: { code: "CONFLICT", message: `версія ${cur?.version ?? "відсутня"} ≠ ${b.version}` } };
          const next = String(Number(cur.version) + 1);
          this.kv.set(b.key, b.value, next);
          return { result: { version: next } };
        });
        return json(r, r.error ? 409 : 200);
      }
      // Розміри ключів W2 без розбору значень (діагностика великих значень).
      if (m === "GET" && p === "/admin/w2-stats") return json({ keys: this.rows("SELECT w2.k AS k, w2.version AS version, length(w2.v) AS v, (SELECT COUNT(*) FROM w2_chunk c WHERE c.k = w2.k) AS parts, (SELECT COALESCE(SUM(length(c.part)), 0) FROM w2_chunk c WHERE c.k = w2.k) AS chunked FROM w2 ORDER BY w2.k") });
      // Сире значення ключа (текст JSON частинами, без розбору) — для локального аналізу оператором.
      if (m === "GET" && p === "/admin/w2-raw") return this.rawValue(url.searchParams.get("key") || "");
      // Автопошук новинок: стан, увімкнути / вимкнути, разова перевірка (dry — без запуску операції).
      if (m === "GET" && p === "/admin/watch") return json(await this.watchInfo());
      if (m === "POST" && p === "/admin/watch") { const b = await req.json().catch(() => ({})); return json(await this.watchSwitch(b?.on === true)); }
      if (m === "POST" && p === "/admin/prices-job") return json(await this.pricesJob({ dry: true }));
      if (m === "POST" && p === "/admin/prices-schedule") { const b = await req.json().catch(() => ({})); return json(await this.pricesSchedule(b)); }
      if (m === "POST" && p === "/admin/watch-check") { const b = await req.json().catch(() => ({})); return json(await this.watchCheck(this.now(), { dry: b?.dry !== false })); }
      return json({ error: { code: "NOT_FOUND", message: "не знайдено" } }, 404);
    } catch (e) {
      console.error("mm-ops", p, String(e?.stack || e).slice(0, 800));
      return json({ error: { code: "INTERNAL", message: String(e?.message || e).slice(0, 300) } }, 500);
    }
  }

  // ---------- сховище W2 ----------
  w2(body) {
    if (!body || typeof body !== "object") return json({ error: { code: "BAD_REQUEST", message: "тіло запиту — JSON" } }, 400);
    const now = this.now();
    const res = this.tx(() => {
      const r = w2Handle(this.kv, body, now);
      if (body.op !== "get" && Math.random() < 0.02) this.sql.exec("DELETE FROM w2_req WHERE at < ?", now - REQ_KEEP_MS);
      return r;
    });
    return json(res, res.error?.code === "BAD_REQUEST" ? 400 : 200);
  }

  /** Значення ключа потоком: частини читаються по одній (пам'ять — одна частина), без JSON.parse. */
  rawValue(key) {
    const r = this.rows("SELECT version, v FROM w2 WHERE k = ?", key)[0];
    if (!r) return json({ error: { code: "NOT_FOUND", message: "ключа немає" } }, 404);
    const n = r.v.startsWith("#chunks:") ? Number(r.v.slice(8)) : 0;
    const sql = this.sql, enc = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (!n) { c.enqueue(enc.encode(r.v)); c.close(); return; }
        if (i >= n) { c.close(); return; }
        const part = sql.exec("SELECT part FROM w2_chunk WHERE k = ? AND i = ?", key, i).toArray()[0]?.part ?? "";
        i++;
        c.enqueue(enc.encode(part));
      },
    });
    return new Response(stream, { headers: { "content-type": "application/json; charset=utf-8", "x-w2-version": r.version, "cache-control": "no-store" } });
  }

  // ---------- вхідні файли (погоджені власником, поза репозиторієм) ----------
  async putInput(name, body) {
    if (!INPUT_NAME.test(name)) return { error: { code: "BAD_REQUEST", message: "назва файлу: [a-z0-9-]" } };
    if (!body || body.length > MAX_INPUT_CHARS) return { error: { code: "BAD_REQUEST", message: `файл порожній або більший за ${MAX_INPUT_CHARS} символів` } };
    const sha = await sha256Hex(body);
    this.sql.exec("INSERT INTO inputs (name, sha, size, at, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET sha = excluded.sha, size = excluded.size, at = excluded.at, body = excluded.body", name, sha, body.length, this.now(), body);
    return { result: { name, sha256: sha, size: body.length } };
  }
  getInput(name) {
    const r = INPUT_NAME.test(name) ? this.rows("SELECT sha, body FROM inputs WHERE name = ?", name)[0] : null;
    if (!r) return json({ error: { code: "NOT_FOUND", message: "файлу немає: " + name.slice(0, 40) } }, 404);
    return new Response(r.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-sha256": r.sha } });
  }

  // ---------- запуски кнопок ----------
  recentRuns(limit = 5) {
    return this.rows("SELECT id, op, status, at, updated, info FROM runs ORDER BY at DESC LIMIT ?", limit).map((r) => {
      const info = JSON.parse(r.info);
      return { id: r.id, op: r.op, label: (OPS[r.op] || r.op) + (info.by === AUTO_BY ? " (автоматично)" : ""), status: r.status, at: r.at, updated: r.updated, ...info };
    });
  }
  activeRun(now = this.now()) {
    return this.recentRuns(10).find((r) => ACTIVE.has(r.status) && now - r.updated < ACTIVE_MS) || null;
  }
  setRun(id, status, patch = {}) {
    const cur = this.rows("SELECT info FROM runs WHERE id = ?", id)[0];
    if (!cur) return false;
    const info = { ...JSON.parse(cur.info), ...patch };
    this.sql.exec("UPDATE runs SET status = ?, updated = ?, info = ? WHERE id = ?", status, this.now(), JSON.stringify(info), id);
    return true;
  }
  status() {
    const runs = this.recentRuns(5), active = this.activeRun();
    const last = runs.map((r) => ({ op: r.op, label: r.label, status: r.status, at: r.at, updated: r.updated, summary: r.summary || r.reason || "" }));
    // Остання автоперевірка новинок — окремим рядком у тому самому списку (меню «Стан останньої операції» показує його без змін скрипта).
    const w = this.watchGet();
    const ym = this.feed.meta(), fl = this.metaGet("feed-last");
    if (ym?.ver) last.push({ op: "yml", label: "YML для Prom", status: fl?.state === "ERROR" ? "помилка" : "готово", at: ym.changedAt, updated: ym.changedAt, summary: `товарів у файлі: ${ym.count}; остання зміна цін — ${new Date(ym.changedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` + (fl?.state === "ERROR" ? "; помилка: " + fl.reason : "") });
    if (w.on && w.last) last.push({ op: "watch", label: "Автоперевірка новинок (кожні " + WATCH.everyMinutes + " хв)", status: "увімкнено", at: w.last.at, updated: w.last.at, summary: w.last.message || w.last.result || "" });
    return { active: active ? { op: active.op, label: active.label, status: active.status, at: active.at } : null, last };
  }
  async button(body) {
    if (body?.op === "status") return this.status();
    const op = String(body?.op || "");
    if (!BUTTON_OPS.has(op)) return { state: "ERROR", message: "Невідома дія: " + op.slice(0, 40) };
    const now = this.now(), active = this.activeRun(now);
    if (active) return { state: "BUSY", message: `Уже виконується «${active.label}» (з ${new Date(active.at).toISOString().slice(11, 16)} UTC). Дочекайтеся завершення й натисніть ще раз.` };
    const id = randomHex(8);
    this.sql.exec("INSERT INTO runs (id, op, status, at, updated, info) VALUES (?, ?, 'DISPATCHING', ?, ?, ?)", id, op, now, now, JSON.stringify({ by: String(body?.by || "").slice(0, 80) }));
    this.sql.exec("DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY at DESC LIMIT ?)", KEEP_RUNS);
    if (op === "prices" && this.env.PRICES_RUNNER === "do") {
      this.metaPut(PRICES_JOB_KEY, { runId: id, at: now });
      this.setRun(id, "QUEUED", { runner: "cloudflare" });
      await this.scheduleAlarm();
      return { state: "STARTED", runId: id, message: `Запущено «${OPS[op]}» (на сервері). Зазвичай це ${DO_DURATION}; результат — у меню «Стан останньої операції» і в аркуші «Журнал».` };
    }
    const d = await this.dispatch(op, id);
    if (!d.ok) {
      this.setRun(id, "DISPATCH_FAILED", { reason: d.reason });
      return { state: "ERROR", message: "Не вдалося запустити операцію на сервері: " + d.reason };
    }
    this.setRun(id, "QUEUED");
    return { state: "STARTED", runId: id, message: `Запущено «${OPS[op]}». Зазвичай це ${DURATION[op] || "кілька хвилин"}; результат — у меню «Стан останньої операції» і в аркуші «Журнал».` };
  }
  async dispatch(op, runId) {
    const e = this.env;
    if (!e.GITHUB_TOKEN || !e.GITHUB_REPO || !e.GITHUB_WORKFLOW) return { ok: false, reason: "сервер не налаштовано (немає токена GitHub)" };
    let res;
    try {
      res = await this.fetchImpl(`https://api.github.com/repos/${e.GITHUB_REPO}/actions/workflows/${e.GITHUB_WORKFLOW}/dispatches`, {
        method: "POST",
        headers: { authorization: `Bearer ${e.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mm-ops", "content-type": "application/json" },
        body: JSON.stringify({ ref: e.GITHUB_REF || "main", inputs: { op, run_id: runId } }),
      });
    } catch (err) { return { ok: false, reason: "GitHub недоступний (" + String(err?.name || "мережа") + ")" }; }
    if (res.status === 204 || res.status === 200) return { ok: true };
    return { ok: false, reason: "GitHub HTTP " + res.status };
  }
  runStart(b) {
    const op = String(b?.op || ""), id = String(b?.runId || "");
    const gh = { ghRunId: String(b?.ghRunId || "").slice(0, 30) };
    if (id && this.setRun(id, "RUNNING", gh)) return { result: { runId: id } };
    if (!OPS[op]) return { error: { code: "BAD_REQUEST", message: "невідома операція" } };
    // Запуск вручну з GitHub (без кнопки) — теж видно в стані.
    const nid = "gh-" + (gh.ghRunId || randomHex(6)), now = this.now();
    this.sql.exec("INSERT INTO runs (id, op, status, at, updated, info) VALUES (?, ?, 'RUNNING', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'RUNNING', updated = excluded.updated", nid, op, now, now, JSON.stringify({ ...gh, by: "GitHub вручну" }));
    return { result: { runId: nid } };
  }
  async runFinish(b) {
    const id = String(b?.runId || "");
    const ok = b?.ok === true;
    const patch = { state: String(b?.state || "").slice(0, 40), summary: String(b?.summary || "").slice(0, 6000) };
    if (!this.setRun(id, ok ? "DONE" : "FAILED", patch)) return { error: { code: "NOT_FOUND", message: "запуску немає" } };
    // YML для Prom: картки змінились (GitHub) — повна збірка; ціни через GitHub (запасний шлях) — оновлення цін у фіді.
    const op = this.rows("SELECT op FROM runs WHERE id = ?", id)[0]?.op;
    if (ok && CONTENT_OPS.has(op)) await this.enqueueFeed("build", "після «" + (OPS[op] || op) + "»");
    else if (ok && op === "prices") await this.enqueueFeed("sync", "після «Ціни й наявність» (GitHub)");
    return { result: { runId: id } };
  }

  // ---------- автопошук новинок (alarm) ----------
  watchGet() {
    const r = this.rows("SELECT v FROM meta WHERE k = 'watch'")[0];
    return r ? JSON.parse(r.v) : { on: false };
  }
  watchPut(w) { this.sql.exec("INSERT INTO meta (k, v) VALUES ('watch', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(w)); }
  async watchInfo() {
    const w = this.watchGet();
    return { ...w, everyMinutes: WATCH.everyMinutes, maxPerDay: WATCH.maxPerDay, alarmAt: await this.storage.getAlarm() };
  }
  /** Увімкнути: перша перевірка за хвилину, далі кожні WATCH.everyMinutes хв. Вимкнути: alarm видаляється. */
  async watchSwitch(on) {
    this.watchPut({ ...this.watchGet(), on, nextAt: on ? this.now() + MIN : null });
    await this.scheduleAlarm();
    return this.watchInfo();
  }
  metaGet(k) { const r = this.rows("SELECT v FROM meta WHERE k = ?", k)[0]; return r ? JSON.parse(r.v) : null; }
  metaPut(k, v) { this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v)); }
  metaDel(k) { this.sql.exec("DELETE FROM meta WHERE k = ?", k); }
  /** Один alarm на об'єкт: найближчий із (черга «Цін» — одразу; автопошук — його nextAt). Нічого — alarm видаляється. */
  /** Будильника немає (Cloudflare припинив повтори після збою) або розклад «Цін» прострочено > 30 хв — поставити заново. */
  async heal() {
    const now = this.now(), a = await this.storage.getAlarm();
    const ps = this.metaGet(PRICES_SCHEDULE_KEY), w = this.watchGet();
    const overdue = (ps?.on && now > (Number(ps.nextAt) || 0) + 30 * MIN) || (w.on && now > (Number(w.nextAt) || 0) + 30 * MIN);
    if (a && !overdue) return { healed: false, alarmAt: a };
    await this.scheduleAlarm();
    return { healed: true, alarmAt: await this.storage.getAlarm(), reason: a ? "розклад прострочено" : "будильника не було" };
  }
  async scheduleAlarm() {
    const now = this.now(), times = [];
    const w = this.watchGet();
    if (w.on) times.push(Math.max(now + 1000, Number(w.nextAt) || now + MIN));
    if (this.metaGet(PRICES_JOB_KEY) || this.metaGet(FEED_JOB_KEY)) times.push(now + 1000);
    const ps = this.metaGet(PRICES_SCHEDULE_KEY);
    if (ps?.on) times.push(Math.max(now + 1000, Number(ps.nextAt) || now + MIN));
    if (times.length) await this.storage.setAlarm(Math.min(...times)); else await this.storage.deleteAlarm();
  }
  /** Alarm: страховий наступний alarm (збій не зупиняє розклад) → черга «Цін» → автопошук, якщо настав його час → точний наступний
   *  alarm. Помилки не кидаються (без повторів alarm). */
  async alarm() {
    const now = this.now();
    await this.storage.setAlarm(now + WATCH.everyMinutes * MIN);
    // Розклад «Цін»: настав час і нічого не виконується — запуск того самого шляху, що й кнопка (черга → одразу тут).
    const ps = this.metaGet(PRICES_SCHEDULE_KEY);
    if (ps?.on && now >= (Number(ps.nextAt) || 0) - 5000) {
      this.metaPut(PRICES_SCHEDULE_KEY, { ...ps, nextAt: now + ps.everyMinutes * MIN });
      const b = this.metaGet(PRICES_JOB_KEY) ? null : await this.button({ op: "prices", by: SCHEDULE_BY });
      this.metaPut(PRICES_SCHEDULE_KEY, { ...this.metaGet(PRICES_SCHEDULE_KEY), last: { at: now, state: b?.state ?? "QUEUED", message: String(b?.message || "").slice(0, 200) } });
      // 04.11: зайнято іншою операцією («Уже виконується») — не чекати весь інтервал, повторити через 10 хв.
      if (b?.state === "BUSY") this.metaPut(PRICES_SCHEDULE_KEY, { ...this.metaGet(PRICES_SCHEDULE_KEY), nextAt: now + 10 * MIN });
    }
    const job = this.metaGet(PRICES_JOB_KEY);
    if (job) { this.metaDel(PRICES_JOB_KEY); await this.runPricesQueued(job); }
    // Одне важке завдання на виклик (межа Free — 50 запитів): YML — у наступному виклику, якщо щойно виконувались «Ціни».
    const fj = job ? null : this.metaGet(FEED_JOB_KEY);
    if (fj) { this.metaDel(FEED_JOB_KEY); await this.runFeedQueued(fj); }
    const w = this.watchGet();
    if (w.on && now >= (Number(w.nextAt) || 0) - 5000) {
      this.watchPut({ ...w, nextAt: now + WATCH.everyMinutes * MIN });
      let r;
      try { r = await this.watchCheck(this.now(), { dry: false }); }
      catch (e) { r = { result: "ERROR", message: "помилка перевірки: " + String(e?.message || e).slice(0, 200) }; }
      this.watchPut({ ...this.watchGet(), last: { at: now, ...r } });
    }
    await this.scheduleAlarm();
  }

  // ---------- «Оновити ціни й наявність» на сервері ----------
  /** Розклад: { on, everyMinutes ≥ 60 }. Вимкнення — on:false. Перший запуск — за хвилину після ввімкнення. */
  async pricesSchedule(b) {
    const cur = this.metaGet(PRICES_SCHEDULE_KEY) || { on: false, everyMinutes: 120 };
    const every = Number.isFinite(Number(b?.everyMinutes)) ? Math.max(60, Math.round(Number(b.everyMinutes))) : cur.everyMinutes;
    const on = b?.on === true;
    this.metaPut(PRICES_SCHEDULE_KEY, { ...cur, on, everyMinutes: every, nextAt: on ? this.now() + MIN : null });
    await this.scheduleAlarm();
    return { ...this.metaGet(PRICES_SCHEDULE_KEY), runner: this.env.PRICES_RUNNER === "do" ? "cloudflare" : "github", alarmAt: await this.storage.getAlarm() };
  }
  /** Сховище W2 цього ж об'єкта через той самий протокол, що й у запускача GitHub (RemoteStore → w2-engine), без мережі. */
  localStore() {
    return new RemoteStore({ url: "https://mm-ops.internal", key: "do-local-" + "x".repeat(24), retries: 1, fetchImpl: async (_url, init) => this.w2(JSON.parse(init.body)) });
  }
  async pricesJob({ dry = false } = {}) {
    const cc = this.rows("SELECT body FROM inputs WHERE name = 'cc-contract-test'")[0]?.body || "";
    try { return await this.pricesJobImpl({ env: this.env, store: this.localStore(), ccContractText: cc, sha256Hex, fetchImpl: this.fetchImpl, now: this.now(), dry }); }
    catch (e) { return { result: { state: "ERROR", reason: "сервер: " + String(e?.message || e).slice(0, 300) }, metrics: null }; }
  }
  /** Запуск із черги кнопки: результат — у стан запуску (підсумок для власника); передано на GitHub — той самий запуск чекає звіту GitHub. */
  async runPricesQueued(job) {
    const id = job.runId;
    this.setRun(id, "RUNNING", { runner: "cloudflare" });
    const out = await this.pricesJob();
    if (out.fallback) {
      const d = await this.dispatch("prices", id);
      if (!d.ok) { this.setRun(id, "DISPATCH_FAILED", { reason: `сервер: ${out.reason}; GitHub: ${d.reason}` }); return; }
      this.setRun(id, "QUEUED", { runner: "github", fallback: out.reason });
      return;
    }
    const state = out.result?.state || "ERROR";
    const ok = ["PRICES_UPDATED", "NO_CHANGES"].includes(state);
    const summary = ownerSummary("prices", { result: out.result }) + (out.metrics ? `
(сервер Cloudflare, ${Math.round(out.metrics.ms / 1000)} с)` : "");
    this.setRun(id, ok ? "DONE" : "FAILED", { state, summary: summary.slice(0, 6000), metrics: out.metrics || null });
    if (state === "PRICES_UPDATED" || state === "PARTIAL") await this.enqueueFeed("sync", "після «Ціни й наявність»");
  }

  // ---------- YML для Prom ----------
  /** Черга: повна збірка поглинає оновлення цін (вона й так бере свіжі ціни). */
  async enqueueFeed(kind, reason) {
    const cur = this.metaGet(FEED_JOB_KEY);
    this.metaPut(FEED_JOB_KEY, { kind: cur?.kind === "build" ? "build" : kind, reason, at: this.now() });
    await this.scheduleAlarm();
  }
  async feedJob(kind) {
    const cc = this.rows("SELECT body FROM inputs WHERE name = 'cc-contract-test'")[0]?.body || "";
    try { return await this.feedJobImpl({ kind, env: this.env, store: this.localStore(), feed: this.feed, ccContractText: cc, sha256Hex, fetchImpl: this.fetchImpl, now: this.now() }); }
    catch (e) { return { state: "ERROR", reason: String(e?.message || e).slice(0, 300) }; }
  }
  async runFeedQueued(fj) {
    const out = await this.feedJob(fj.kind);
    this.metaPut("feed-last", { at: this.now(), kind: fj.kind, why: fj.reason || "", state: out.state, reason: out.reason || "", count: out.count ?? null, patched: out.patched ?? null, metrics: out.metrics || null });
    return out;
  }
  /** Оператор: status | build | sync (одразу, з результатом) | hold {ids} (тимчасово не публікувати — рішення власника) → збірка. */
  async ymlAdmin(b) {
    const action = String(b?.action || "status");
    if (action === "build" || action === "sync") { const out = await this.feedJob(action); this.metaPut("feed-last", { at: this.now(), kind: action, why: "оператор", state: out.state, reason: out.reason || "", count: out.count ?? null, patched: out.patched ?? null, metrics: out.metrics || null }); return out; }
    if (action === "hold") {
      if (!Array.isArray(b?.ids) || b.ids.some((x) => !/^\d+$/.test(String(x)))) return { error: { code: "BAD_REQUEST", message: "ids — масив Offer ID" } };
      this.feed.setHold(b.ids); await this.enqueueFeed("build", "зміна списку тимчасово не публікованих");
    }
    const m = this.feed.meta();
    return { meta: m ? { ...m, header: undefined } : null, offers: m?.ver ? this.feed.count(m.ver) : 0, hold: [...this.feed.hold()], queued: this.metaGet(FEED_JOB_KEY), last: this.metaGet("feed-last") };
  }
  /** Один цикл автоперевірки. dry — лише рішення, без запуску операції (перевірка оператором). */
  async watchCheck(now, { dry = true } = {}) {
    const w = this.watchGet();
    if (w.backoffUntil > now) return { result: "PAUSE", message: "постачальник обмежив частоту запитів — пауза до " + new Date(w.backoffUntil).toISOString().slice(11, 16) + " UTC" };
    const active = this.activeRun(now);
    if (active) return { result: "BUSY", message: `виконується «${active.label}» — перевірка наступного разу` };
    const seen = this.kv.get(FIND_NEW_SEEN_KEY)?.value || null;
    const pre = watchPrecheck({ seen, feedUrl: this.env.SUPPLIER_FEED_URL });
    if (pre) return pre;
    const feed = await fetchIds(this.env.SUPPLIER_FEED_URL, this.fetchImpl);
    if (feed.backoff) {
      if (!dry) this.watchPut({ ...this.watchGet(), backoffUntil: now + WATCH.backoffMinutes * MIN });
      return { result: "PAUSE", message: `постачальник відповів HTTP ${feed.httpStatus} — пауза ${WATCH.backoffMinutes} хв` };
    }
    if (feed.error) return { result: "FEED_ERROR", message: feed.error };
    const lastAuto = this.recentRuns(30).find((r) => r.by === AUTO_BY) || null;
    let d = decideWatch({ seen, ids: feed.ids, now, w, lastAuto });
    // Неповні новинки (рішення власника 03.11): нових ID немає — раз на годину перевірити, чи постачальник доповнив картки.
    const incomplete = (Array.isArray(seen.incomplete) ? seen.incomplete : []).filter((id) => feed.ids.has(String(id)));
    if (d.result === "NOTHING_NEW" && incomplete.length && now - (Number(w.incompleteAt) || 0) >= INCOMPLETE_CHECK_MINUTES * MIN) {
      if (!dry) this.watchPut({ ...this.watchGet(), incompleteAt: now });
      const cf = await fetchContentFeed(this.env.SUPPLIER_FEED_URL, this.fetchImpl);
      if (cf.error || cf.backoff) return { ...d, message: d.message + "; неповні новинки не перевірено (" + (cf.error || "постачальник обмежив частоту") + ")" };
      const done = completedNow(cf.text, incomplete);
      if (!done.length) return { ...d, message: `нових товарів немає; неповних новинок: ${incomplete.length} — постачальник ще не доповнив` };
      const block = dispatchBlock({ now, w, lastAuto });
      d = block ? { ...d, ...block } : { ...d, result: "DISPATCH", message: `постачальник доповнив новинки (${done.length}) — запуск «Знайти нові товари»`, completed: done.length };
    }
    if (d.result !== "DISPATCH" || dry) return d;
    const b = await this.button({ op: "find-new", by: AUTO_BY });
    if (b.state !== "STARTED") return { ...d, result: b.state === "BUSY" ? "BUSY" : "DISPATCH_FAILED", message: b.message };
    this.watchPut(markWatchDispatch(this.watchGet(), now));
    return { ...d, result: "DISPATCHED", runId: b.runId };
  }
}
