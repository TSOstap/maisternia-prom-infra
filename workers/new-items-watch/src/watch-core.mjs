/** «Сторож новинок» — логіка SQLite Durable Object (Cloudflare Free; погоджено власником 23.10.2026, лише локально).
 *  Звичайний клас (тестується в Node); для Cloudflare його обгортає WatchDO (watch-do.mjs, extends DurableObject).
 *
 *  Чому DO: у Workers Free 10 мс CPU на виклик, а повний цикл на реальному фіді — 66 мс (виміряно 22.10).
 *  За документацією Cloudflare DO має 30 с CPU на виклик, зокрема на alarm.
 *
 *  Цикл: завантажити фід → (синхронно, без await) прочитати стан із SQLite → розібрати → план → записати різницю.
 *  Між читанням і записом немає await, тож звіт GitHub (POST /ack), що прийшов під час завантаження фіду, не губиться.
 *  Автоматичні перевірки — alarm кожні 5 хв. Вмикається лише явно: змінна ALARMS_ALLOWED="yes" при розгортанні
 *  + POST /schedule {"on": true}. Зараз НЕ ввімкнено.
 *
 *  Захисти: одна «оренда» запуску (паралельні цикли неможливі; після збою оренда спливає за 5 хв);
 *  повторний alarm < 4 хв після циклу — пропуск; помилка циклу не кидається назовні (Cloudflare не повторює
 *  alarm без кінця), а наступний alarm ставиться ДО циклу; 429/503 від постачальника — пауза 30 хв;
 *  GitHub недоступний — пауза 15 хв, запуск не зараховується; пошкоджений / неповний фід — стан не змінюється.
 *  У Google-таблицю DO не пише нічого; в основний каталог / YML нічого не потрапляє без затвердження власника. */
import { applyAck, markDispatched, publicStatus } from "../../../src/core/intake.mjs";
import { FEED_URL_RE, MIN, dispatchGithub, fetchFeed, json, planFromText, profileOf, rulesOf } from "./cycle.mjs";

/** Межа серії для обмеженого (тестового) розгортання; 0 — без межі (робочий розклад, лише з окремого погодження). */
export const maxCycles = (env) => (Number.isInteger(Number(env.ALARMS_MAX_CYCLES)) && Number(env.ALARMS_MAX_CYCLES) > 0 ? Number(env.ALARMS_MAX_CYCLES) : 0);
/** Причина автозупинки серії (будь-яка помилка, обмеження частоти, надмірні записи). */
function criticalReason(r) {
  if (r.error) return "помилка циклу — " + String(r.error).slice(0, 120);
  if (/^ПАУЗА/.test(r.skipped || "")) return "постачальник обмежив частоту (" + r.skipped + ")";
  if ((r.sql?.rowsWritten || 0) > 5000) return "забагато записів SQLite за цикл (" + r.sql.rowsWritten + ")";
  return "";
}
/** Підсумок циклу для журналу серії — лише числа й стани (без ID, адрес і товарних даних). */
const cycleSummary = (n, at, r) => ({
  n, at: new Date(at).toISOString(), offers: r.offers ?? null, candidates: r.candidates ?? null, ready: r.ready ?? null, waiting: r.waiting ?? null, incomplete: r.incomplete ?? null,
  appeared: r.appeared ?? null, changes: r.changes ?? null, queueChanged: r.queueChanged ?? null, feedChars: r.feedChars ?? null, httpStatus: r.httpStatus ?? null,
  rowsRead: r.sql?.rowsRead ?? null, rowsWritten: r.sql?.rowsWritten ?? null, dispatched: r.dispatched ?? null, blocked: r.blocked || "", skipped: r.skipped || "", error: r.error ? String(r.error).slice(0, 120) : "",
});
import { SqlStateStore } from "./store.mjs";

const MAX_ACK_CHARS = 2_000_000;

export class WatchCore {
  /** ctx, env — від Cloudflare; deps — лише для тестів (годинник і мережа). */
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.now = deps.now || (() => Date.now());
    this.fetchImpl = deps.fetch || ((u, i) => fetch(u, i));
    this.log = deps.log || ((s) => console.log(s));
    this.store = new SqlStateStore(ctx.storage);
    this.running = false;
  }

  /** Один цикл спостереження. reason — «alarm» | «manual». */
  async cycle(reason = "manual", opts = {}) {
    const sql0 = { ...this.store.stats };
    const withSql = (r) => ({ ...r, sql: { rowsRead: this.store.stats.rowsRead - sql0.rowsRead, rowsWritten: this.store.stats.rowsWritten - sql0.rowsWritten } });
    return withSql(await this.cycleInner(reason, opts));
  }

  async cycleInner(reason, opts) {
    const env = this.env, rules = rulesOf(env), profile = profileOf(env);
    const now = this.now();
    // Оренда: не більше одного циклу одночасно (і після перезапуску DO — до спливання оренди).
    const lease = this.store.getMeta("lease");
    if (this.running || (lease && lease.until > now)) return { skipped: "ВЖЕ ВИКОНУЄТЬСЯ ІНШИЙ ЦИКЛ" };
    this.running = true;
    this.store.setMeta("lease", { until: now + rules.leaseMinutes * MIN, reason });
    try {
      const pre = this.store.load();
      if (pre.backoffUntil > now) return { skipped: "ПАУЗА: постачальник обмежив частоту", until: new Date(pre.backoffUntil).toISOString() };
      if (!pre.known) return { blocked: "НЕМАЄ БАЗИ ВІДОМИХ ID (чекаємо перший звіт GitHub)" };

      // Тестовий запуск: адреса фіду з тіла запиту (лише з прапорцем розгортання; ніде не зберігається).
      const feed = await fetchFeed(opts.feedUrl ? { ...env, SUPPLIER_FEED_URL: opts.feedUrl } : env, profile, this.fetchImpl);
      const t = this.now();
      // --- від цього місця до запису — синхронно ---
      let state = this.store.load();
      if (feed.backoff) {
        const next = { ...state, backoffUntil: t + rules.backoffMinutes * MIN };
        this.store.save(state, next, t);
        return { skipped: "ПАУЗА: HTTP " + feed.httpStatus + " від постачальника" };
      }
      if (!feed.text) return feed.skipped ? { skipped: feed.skipped } : { error: feed.error };
      const plan = planFromText({ state, text: feed.text, now: t, rules, profile });
      feed.text = null;
      if (plan.error) return { error: plan.error };
      const next = plan.state;
      next.lastCycleAt = t;
      const hist = Object.values(next.candidates).flatMap((c) => (c.history || []).filter((h) => h.at === t));
      plan.report.appeared = hist.filter((h) => h.what === "ПОЯВА").length;
      plan.report.changes = hist.filter((h) => h.what.startsWith("ЗМІНА")).length;
      if (plan.dispatch) next.lastDispatch = { ...plan.dispatch, issuedAt: t };
      this.store.save(state, next, t);
      // --- кінець синхронної частини ---
      if (!plan.dispatch) return plan.report;
      if (next.githubBackoffUntil > t) { plan.report.blocked = "ПАУЗА GITHUB до " + new Date(next.githubBackoffUntil).toISOString(); return plan.report; }
      const d = await dispatchGithub(env, this.fetchImpl);
      const t2 = this.now();
      state = this.store.load(); // свіжий стан (міг надійти звіт GitHub)
      if (d.ok) this.store.save(state, markDispatched(state, plan.dispatch, t2), t2);
      else if (!d.observeOnly) this.store.save(state, { ...state, githubBackoffUntil: t2 + rules.githubBackoffMinutes * MIN }, t2);
      plan.report.dispatched = d.ok;
      if (!d.ok) plan.report.blocked = d.reason;
      return plan.report;
    } catch (e) {
      return { error: "збій циклу: " + String(e?.message || e).slice(0, 150) };
    } finally {
      this.store.setMeta("lease", null);
      this.running = false;
    }
  }

  /** Alarm: наступний ставиться ДО циклу (безперервність), повтор < 4 хв після циклу — пропуск. Помилки не кидаємо. */
  /**
   * Alarm. Обмежене розгортання (ALARMS_MAX_CYCLES) — лише серія з лічильником у SQLite:
   *  лічильник збільшується ДО циклу (помилки й повтори теж рахуються); після останнього циклу alarm видаляється й більше
   *  не ставиться; помилка, 429/503 або надмірні записи — серія зупиняється. Повторний alarm (< 4 хв) — без циклу.
   *  Виняток назовні не кидаємо: Cloudflare повторює alarm із винятком до 6 разів.
   */
  async alarm() {
    try {
      const rules = rulesOf(this.env);
      if (this.store.getMeta("schedule") !== "on") { await this.ctx.storage.deleteAlarm(); return { skipped: "розклад вимкнено" }; }
      const now = this.now();
      const max = maxCycles(this.env);
      const series = this.store.getMeta("series");
      if (max && !series) { await this.stopSchedule("обмежене розгортання без серії"); return { skipped: "НЕМАЄ СЕРІЇ" }; }
      if (series && (series.done >= series.limit || series.stopped)) { await this.stopSchedule(series.stopped || "серію завершено"); return { skipped: "СЕРІЮ ЗАВЕРШЕНО" }; }
      const last = this.store.getMeta("lastCycleAt");
      if (last && now - last < rules.alarmDedupeMinutes * MIN) {
        if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(last + rules.alarmMinutes * MIN);
        return { skipped: "ПОВТОРНИЙ ALARM (цикл щойно виконано)" };
      }
      let n = 0, isLast = false;
      if (series) { n = series.done + 1; isLast = n >= series.limit; this.store.setMeta("series", { ...series, done: n }); }
      if (isLast) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(now + rules.alarmMinutes * MIN);
      const report = await this.cycle("alarm", { feedUrl: series ? this.store.getMeta("seriesFeedUrl") || undefined : undefined });
      this.log(JSON.stringify(report));
      if (series) {
        const s = this.store.getMeta("series");
        const stop = criticalReason(report);
        s.log = [...(s.log || []), cycleSummary(n, now, report)].slice(-50);
        this.store.setMeta("series", s);
        if (stop) await this.stopSchedule("АВТОЗУПИНКА: " + stop);
        else if (isLast) await this.stopSchedule("виконано " + n + " з " + s.limit);
      }
      return report; // Cloudflare значення не використовує; для тестів
    } catch (e) {
      try { await this.stopSchedule("АВТОЗУПИНКА: критична помилка — " + String(e?.message || e).slice(0, 100)); } catch { /* */ }
      return { error: "збій alarm: " + String(e?.message || e).slice(0, 150) };
    }
  }

  /** Вимкнути розклад: alarm видалено, тимчасову адресу фіду стерто, причину записано в серію. */
  async stopSchedule(reason) {
    this.store.setMeta("schedule", "off");
    this.store.setMeta("seriesFeedUrl", null);
    const s = this.store.getMeta("series");
    if (s && !s.stopped) this.store.setMeta("series", { ...s, stopped: reason, stoppedAt: this.now() });
    await this.ctx.storage.deleteAlarm();
  }

  async fetch(req) {
    const url = new URL(req.url);
    const rules = rulesOf(this.env);
    if (req.method === "GET" && url.pathname === "/status") {
      const s = this.store.load();
      return json({ ...publicStatus(s), schedule: this.store.getMeta("schedule") || "off", alarmAt: await this.ctx.storage.getAlarm(), githubBackoffUntil: s.githubBackoffUntil || 0, series: this.store.getMeta("series"), maxCycles: maxCycles(this.env), events: this.store.events(30) });
    }
    if (req.method === "GET" && url.pathname === "/intake") {
      const s = this.store.load();
      return json(s.lastDispatch || { profile: profileOf(this.env), ready: [], refresh: [] });
    }
    if (req.method === "POST" && url.pathname === "/ack") {
      const body = await req.text();
      if (body.length > MAX_ACK_CHARS) return json({ error: "звіт завеликий" }, 413);
      let ack;
      try { ack = JSON.parse(body); } catch { return json({ error: "не JSON" }, 400); }
      if (!Array.isArray(ack.known) || !ack.known.length) return json({ error: "звіт без бази відомих ID" }, 400);
      if (ack.profile && ack.profile !== profileOf(this.env)) return json({ error: "інший профіль фіду" }, 409);
      const now = this.now();
      const s = this.store.load(); // синхронно: читання → застосування → запис
      this.store.save(s, { ...applyAck(s, ack, now, rules), ackAppliedAt: now }, now);
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/run") { // ручний цикл (тест)
      const body = await req.json().catch(() => ({}));
      const feedUrl = this.env.TEST_FEED_URL_IN_REQUEST === "yes" && !this.env.SUPPLIER_FEED_URL && typeof body?.feedUrl === "string" ? body.feedUrl : undefined;
      return json(await this.cycle("manual", { feedUrl }));
    }
    if (req.method === "POST" && url.pathname === "/schedule") {
      const body = await req.json().catch(() => ({}));
      if (body.on === true) {
        if (this.env.ALARMS_ALLOWED !== "yes") return json({ error: "автоматичні перевірки не дозволено цим розгортанням (ALARMS_ALLOWED)" }, 403);
        const max = maxCycles(this.env);
        const now = this.now();
        let firstAt = now + rules.alarmMinutes * MIN;
        if (max) {
          const cycles = Number(body.cycles);
          if (!Number.isInteger(cycles) || cycles < 1 || cycles > max) return json({ error: `потрібна серія 1–${max} циклів (ALARMS_MAX_CYCLES)` }, 400);
          if (this.store.getMeta("series")) return json({ error: "серію вже запускали — повторний запуск не дозволено цим розгортанням" }, 409);
          if (!this.env.SUPPLIER_FEED_URL) {
            if (this.env.TEST_FEED_URL_IN_REQUEST !== "yes" || typeof body.feedUrl !== "string" || !FEED_URL_RE.test(body.feedUrl)) return json({ error: "немає адреси фіду Market Tools" }, 400);
            this.store.setMeta("seriesFeedUrl", body.feedUrl); // тимчасово, лише на час серії; стирається при зупинці
          }
          this.store.setMeta("series", { limit: cycles, done: 0, startedAt: now, log: [] });
          firstAt = now + Math.min(Math.max(Number(body.firstDelaySec) || 60, 10), 600) * 1000;
        }
        this.store.setMeta("schedule", "on");
        await this.ctx.storage.setAlarm(firstAt);
        return json({ schedule: "on", firstAt, series: this.store.getMeta("series") });
      }
      await this.stopSchedule("вимкнено вручну");
      return json({ schedule: "off" });
    }
    return json({ error: "не знайдено" }, 404);
  }
}
