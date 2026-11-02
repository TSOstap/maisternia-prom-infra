/** «mm-ops» — серверний диспетчер кнопок таблиці TEST (ENG-29, рішення власника 02.11: повний варіант, безкоштовно).
 *
 *  Один SQLite Durable Object «main» (Cloudflare Free) зберігає:
 *   • w2 / w2_req — сховище W2 (оренди, журнал операцій, плани, контрольна точка CC) — ядро src/pipeline/safe-write/w2-engine.mjs;
 *   • runs        — запуски операцій кнопок (хто, що, коли, підсумок для власника);
 *   • inputs      — погоджені файли поза репозиторієм (FZ, OV, A3, контракт CC): відбиток SHA-256 перевіряє запускач.
 *  Кнопка (Apps Script) → POST /button {op} → якщо нічого не виконується — запуск GitHub workflow ops.yml (workflow_dispatch);
 *  повторне натискання під час виконання — «уже виконується», нового запуску немає. Сам запис у таблицю робить лише запускач
 *  у GitHub Actions — через шлюз W2 (оренда + журнал + fencing), сховищем якого є цей самий об'єкт.
 *  Увесь код роботи зі сховищем синхронний (SQL API Durable Object) і виконується в transactionSync — атомарно. */
import { w2Handle, w2Seed, REQ_KEEP_MS } from "../../../src/pipeline/safe-write/w2-engine.mjs";

export const OPS = Object.freeze({
  transfer: "Перенести затверджені",
  "find-new": "Знайти нові товари",
  update: "Оновити товари",
  reconcile: "Звірити незавершені записи",
  "deferred-plan": "Відкладені товари: план",
  deferred: "Відкладені товари: розібрати",
});
/** Типова тривалість (виміряно на TEST 02.11: «Оновити» ≈ 18 хв, «Знайти нові» ≈ 3 хв, «Перенести» 3–13 хв залежно від кількості). */
const DURATION = Object.freeze({ transfer: "3–15 хвилин", "find-new": "3–5 хвилин", update: "15–20 хвилин", reconcile: "2–4 хвилини" });
/** Кнопки меню (ключ кнопок) — лише ці дії; разові операції (відкладені товари) — лише вручну з GitHub. */
const BUTTON_OPS = new Set(["transfer", "find-new", "update", "reconcile"]);
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
  constructor(storage, env, { now = () => Date.now(), fetchImpl = (...a) => fetch(...a) } = {}) {
    this.storage = storage; this.env = env; this.now = now; this.fetchImpl = fetchImpl;
    this.sql = storage.sql;
    for (const q of SCHEMA) this.sql.exec(q);
    this.kv = w2Kv(this.sql);
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
      if (m === "POST" && p === "/run/finish") return json(this.runFinish(await req.json().catch(() => ({}))));
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
      return json({ error: { code: "NOT_FOUND", message: "не знайдено" } }, 404);
    } catch (e) {
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
    return this.rows("SELECT id, op, status, at, updated, info FROM runs ORDER BY at DESC LIMIT ?", limit).map((r) => ({ id: r.id, op: r.op, label: OPS[r.op] || r.op, status: r.status, at: r.at, updated: r.updated, ...JSON.parse(r.info) }));
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
    return { active: active ? { op: active.op, label: active.label, status: active.status, at: active.at } : null, last: runs.map((r) => ({ op: r.op, label: r.label, status: r.status, at: r.at, updated: r.updated, summary: r.summary || r.reason || "" })) };
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
  runFinish(b) {
    const id = String(b?.runId || "");
    const ok = b?.ok === true;
    const patch = { state: String(b?.state || "").slice(0, 40), summary: String(b?.summary || "").slice(0, 6000) };
    if (!this.setRun(id, ok ? "DONE" : "FAILED", patch)) return { error: { code: "NOT_FOUND", message: "запуску немає" } };
    return { result: { runId: id } };
  }
}
