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
import { MIN, dispatchGithub, fetchFeed, json, planFromText, profileOf, rulesOf } from "./cycle.mjs";
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
  async cycle(reason = "manual") {
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

      const feed = await fetchFeed(env, profile, this.fetchImpl);
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
  async alarm() {
    const rules = rulesOf(this.env);
    if (this.store.getMeta("schedule") !== "on") return { skipped: "розклад вимкнено" };
    const now = this.now();
    await this.ctx.storage.setAlarm(now + rules.alarmMinutes * MIN);
    const last = this.store.getMeta("lastCycleAt");
    if (last && now - last < rules.alarmDedupeMinutes * MIN) return { skipped: "ПОВТОРНИЙ ALARM (цикл щойно виконано)" };
    const report = await this.cycle("alarm");
    this.log(JSON.stringify(report));
    return report; // Cloudflare значення не використовує; для тестів
  }

  async fetch(req) {
    const url = new URL(req.url);
    const rules = rulesOf(this.env);
    if (req.method === "GET" && url.pathname === "/status") {
      const s = this.store.load();
      return json({ ...publicStatus(s), schedule: this.store.getMeta("schedule") || "off", alarmAt: await this.ctx.storage.getAlarm(), githubBackoffUntil: s.githubBackoffUntil || 0, events: this.store.events(30) });
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
    if (req.method === "POST" && url.pathname === "/run") return json(await this.cycle("manual")); // ручний цикл (тест)
    if (req.method === "POST" && url.pathname === "/schedule") {
      const body = await req.json().catch(() => ({}));
      if (body.on === true) {
        if (this.env.ALARMS_ALLOWED !== "yes") return json({ error: "автоматичні перевірки не дозволено цим розгортанням (ALARMS_ALLOWED)" }, 403);
        this.store.setMeta("schedule", "on");
        await this.ctx.storage.setAlarm(this.now() + rules.alarmMinutes * MIN);
        return json({ schedule: "on" });
      }
      this.store.setMeta("schedule", "off");
      await this.ctx.storage.deleteAlarm();
      return json({ schedule: "off" });
    }
    return json({ error: "не знайдено" }, 404);
  }
}
