/** Тестовий двійник сховища SQLite Durable Object на справжньому SQLite (node:sqlite).
 *  ctx.storage.sql.exec(q, ...b).toArray(), ctx.storage.transactionSync(fn), get/set/deleteAlarm.
 *  Лічильники рядків — для оцінки квот Free (5 млн читань і 100 тис. записів на добу). */
import { DatabaseSync } from "node:sqlite";

export function doContext() {
  const db = new DatabaseSync(":memory:");
  const counters = { rowsRead: 0, rowsWritten: 0, statements: 0 };
  let alarm = null;
  let failNext = null; // імітація збою сховища: назва таблиці або "*"
  const cursor = (rows, read = 0, written = 0) => ({ toArray: () => rows, one: () => rows[0], rowsRead: read, rowsWritten: written, [Symbol.iterator]: () => rows[Symbol.iterator]() });
  const sql = {
    exec(q, ...b) {
      counters.statements++;
      if (failNext && (failNext === "*" || q.includes(failNext)) && !/^\s*SELECT/i.test(q)) { const f = failNext; failNext = null; throw new Error("імітований збій сховища: " + f); }
      const st = db.prepare(q);
      if (/^\s*(SELECT|WITH)/i.test(q)) { const rows = st.all(...b); const n = Math.max(rows.length, 1); counters.rowsRead += n; return cursor(rows, n, 0); }
      if (/^\s*CREATE/i.test(q)) { st.run(...b); return cursor([]); }
      const r = st.run(...b);
      counters.rowsWritten += Number(r.changes || 0);
      return cursor([], 0, Number(r.changes || 0));
    },
  };
  const storage = {
    sql,
    transactionSync(fn) {
      db.exec("BEGIN");
      try { const v = fn(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = typeof t === "number" ? t : new Date(t).getTime(); },
    async deleteAlarm() { alarm = null; },
  };
  return { ctx: { storage }, db, counters, get alarm() { return alarm; }, failOnce(what) { failNext = what; } };
}

/** Простір імен DO для вхідного Worker: усі запити — в один екземпляр «main». */
export function doNamespace(getInstance) {
  return { idFromName: (n) => n, get: () => ({ fetch: (req) => getInstance().fetch(req) }) };
}
