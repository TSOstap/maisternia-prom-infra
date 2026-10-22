/** Стан «Сторожа новинок» у SQLite Durable Object. Та сама форма стану, що й у ядрі (src/core/intake.mjs):
 *   meta(k, v)            — службові значення JSON: known (база відомих ID одним рядком), dispatch (ліміти GitHub),
 *                           backoffUntil, githubBackoffUntil, lastRun, lastDispatch, ackAppliedAt, schedule, lease, lastCycleAt…
 *   candidates(id, rec)   — кандидати: перше виявлення, остання суттєва зміна, відбиток, чого бракує, статус, історія;
 *   queue(id, rec)        — позиції черги «Нові товари» (відбиток сирих даних, очікувана зміна);
 *   events(seq, at, id, what) — журнал важливих змін (зберігається 30 днів).
 *  Запис — лише змінених рядків і лише в одній транзакції (transactionSync): після збою — або все, або нічого.
 *  Базу відомих ID зберігаємо одним рядком: інакше кожен цикл читав би ~5 тис. рядків (ліміт Free — 5 млн читань/добу). */
import { emptyState } from "../../../src/core/intake.mjs";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, rec TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, rec TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, id TEXT NOT NULL, what TEXT NOT NULL)",
];
const META_KEYS = ["dispatch", "backoffUntil", "githubBackoffUntil", "lastRun", "lastDispatch", "ackAppliedAt", "savedAt", "schedule", "lease", "lastCycleAt", "eventsPrunedAt"];
const EVENTS_DAYS = 30;

export class SqlStateStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    for (const q of SCHEMA) this.sql.exec(q);
  }
  rows(q, ...b) { return this.sql.exec(q, ...b).toArray(); }

  /** Увесь стан (кілька десятків рядків + один рядок бази відомих ID). */
  load() {
    const s = emptyState();
    for (const r of this.rows("SELECT k, v FROM meta")) {
      const v = JSON.parse(r.v);
      if (r.k === "known") s.known = v ? { at: v.at, ids: v.ids ? v.ids.split(",") : [] } : null;
      else s[r.k] = v;
    }
    for (const r of this.rows("SELECT id, rec FROM candidates")) s.candidates[r.id] = JSON.parse(r.rec);
    for (const r of this.rows("SELECT id, rec FROM queue")) s.queue[r.id] = JSON.parse(r.rec);
    return s;
  }

  /** Записати різницю prev → next атомарно. Повертає кількість змінених рядків. */
  save(prev, next, now = Date.now()) {
    let n = 0;
    this.storage.transactionSync(() => {
      const put = (k, v) => { this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v ?? null)); n++; };
      for (const k of META_KEYS) if (JSON.stringify(prev?.[k] ?? null) !== JSON.stringify(next[k] ?? null)) put(k, next[k]);
      const kp = prev?.known, kn = next.known;
      if ((kp?.at ?? null) !== (kn?.at ?? null) || (kp?.ids?.length ?? -1) !== (kn?.ids?.length ?? -1)) put("known", kn ? { at: kn.at, ids: kn.ids.join(",") } : null);
      for (const table of ["candidates", "queue"]) {
        const a = prev?.[table] || {}, b = next[table] || {};
        for (const [id, rec] of Object.entries(b)) {
          const s = JSON.stringify(rec);
          if (JSON.stringify(a[id]) !== s) { this.sql.exec(`INSERT INTO ${table} (id, rec) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET rec = excluded.rec`, id, s); n++; }
        }
        for (const id of Object.keys(a)) if (!(id in b)) { this.sql.exec(`DELETE FROM ${table} WHERE id = ?`, id); n++; }
      }
      // Журнал важливих змін: нові записи історії кандидатів.
      for (const [id, rec] of Object.entries(next.candidates || {})) {
        const seen = new Set((prev?.candidates?.[id]?.history || []).map((h) => h.at + "|" + h.what));
        const fresh = (rec.history || []).filter((h) => !seen.has(h.at + "|" + h.what));
        for (const h of fresh) { this.sql.exec("INSERT INTO events (at, id, what) VALUES (?, ?, ?)", h.at, id, String(h.what).slice(0, 300)); n++; }
      }
      if (!next.eventsPrunedAt || now - next.eventsPrunedAt > 24 * 3600_000) {
        this.sql.exec("DELETE FROM events WHERE at < ?", now - EVENTS_DAYS * 24 * 3600_000);
        this.sql.exec("INSERT INTO meta (k, v) VALUES ('eventsPrunedAt', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(now));
        next.eventsPrunedAt = now;
      }
    });
    return n;
  }

  /** Окремі службові значення (оренда запуску, розклад) — одним рядком. */
  getMeta(k) { const r = this.rows("SELECT v FROM meta WHERE k = ?", k)[0]; return r ? JSON.parse(r.v) : null; }
  setMeta(k, v) { this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v ?? null)); }
  events(limit = 50) { return this.rows("SELECT at, id, what FROM events ORDER BY seq DESC LIMIT ?", limit); }
}
