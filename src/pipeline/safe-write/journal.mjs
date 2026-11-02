/** E3 (ENG-01 K2) — журнал операцій записувачів: лише дописування, у версійному сховищі (CAS), один на ресурс.
 *
 *  Запис: { seq, opId, token, writer, scope, phase, kind, at, detail }.
 *   phase: ACQUIRE | INTENT | APPLIED | NOT_APPLIED | UNKNOWN | PARTIAL | VERIFIED | NEEDS_DECISION | RECONCILED | DECIDED | RELEASE
 *  Fencing журналу (два шари):
 *   1. дописування — store.putJsonIfVersionFenced з ключем оренди: сховище атомарно відхиляє запис оренди, яка вже не чинна,
 *      навіть до того, як нова оренда запише ACQUIRE (Р7: без зміни чужих ключів);
 *   2. запис із token, меншим за найбільший token у журналі, відхиляється (STALE).
 *  opId — детермінований хеш наміру (записувач, ресурс, аркуш, ключі, payload, покоління): повтор того самого наміру з новим часом
 *  дає той самий opId і не створює нової логічної операції. */
import crypto from "node:crypto";
import { LeaseError } from "./committer.mjs";

const journalKey = (resource) => `state/write-journal/${resource}.json`;
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export const opIdOf = (intent) => "op-" + crypto.createHash("sha256").update(JSON.stringify(canon(intent))).digest("hex").slice(0, 24);

const OPEN = new Set(["INTENT", "UNKNOWN", "PARTIAL"]);
const BLOCKING = new Set(["NEEDS_DECISION"]);

export class OpJournal {
  constructor({ store, resource, now = Date.now, maxEntries = 5000 }) { this.store = store; this.resource = resource; this.now = now; this.maxEntries = maxEntries; }
  async entries() { return (await this.store.getJsonVersioned(journalKey(this.resource))).value?.entries || []; }
  /** Дописати запис від імені оренди (token). Перевірки: оренда чинна; token не менший за найбільший у журналі; CAS. */
  async append(lease, rec) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await lease.assertCurrent();
      const key = journalKey(this.resource);
      const { value, version } = await this.store.getJsonVersioned(key);
      const entries = value?.entries || [];
      const maxToken = entries.reduce((m, e) => Math.max(m, e.token || 0), 0);
      if (lease.token < maxToken) throw new LeaseError("STALE", `журнал: запис token ${lease.token} після token ${maxToken} відхилено`);
      const e = { seq: (entries.at(-1)?.seq || 0) + 1, token: lease.token, scope: lease.scope, at: new Date(this.now()).toISOString(), ...rec };
      // Обмеження розміру: найстаріші ЗАКРИТІ записи можна стиснути; відкриті й ті, що потребують рішення, — ніколи.
      let next = [...entries, e];
      if (next.length > this.maxEntries) {
        const keep = new Set(Object.entries(this.#lastByOp(next)).filter(([, x]) => OPEN.has(x.phase) || BLOCKING.has(x.phase)).map(([op]) => op));
        next = next.filter((x, i) => i >= next.length - this.maxEntries || keep.has(x.opId));
      }
      const doc = { v: 1, resource: this.resource, entries: next };
      try {
        if (this.store.putJsonIfVersionFenced && lease.leaseKey) await this.store.putJsonIfVersionFenced(key, doc, version, { leaseKey: lease.leaseKey, token: lease.token, ...(lease.leaseId ? { leaseId: lease.leaseId } : {}) });
        else await this.store.putJsonIfVersion(key, doc, version);
        return e;
      } catch (err) {
        if (err?.fencing) throw new LeaseError("STALE", `журнал: ${err.message}`);
        if (err?.code !== "CONFLICT") throw err;
      }
    }
    throw new LeaseError("BUSY", "журнал: не вдалося дописати запис (конкуренція CAS)");
  }
  #lastByOp(entries) {
    const m = {};
    for (const e of entries) if (e.opId) m[e.opId] = e;
    return m;
  }
  /** Останній стан кожної операції. */
  async state() { return this.#lastByOp(await this.entries()); }
  /** Невирішені операції: остання фаза INTENT / UNKNOWN / PARTIAL — результат на таблиці невідомий. */
  async unresolved() { return Object.values(await this.state()).filter((e) => OPEN.has(e.phase)); }
  /** Операції, що чекають рішення людини (наприклад, запис потрапив у чужий рядок). Поки вони є — запис заборонено. */
  async blocking() { return Object.values(await this.state()).filter((e) => BLOCKING.has(e.phase)); }
  /** Повний запис INTENT для opId (із даними, потрібними для з'ясування). */
  async intentOf(opId) { return (await this.entries()).filter((e) => e.opId === opId && e.phase === "INTENT").at(-1) || null; }
}
