/** «Сторож новинок» — Cloudflare Worker (Workers Free, Cron Trigger кожні 5 хв). Погоджено власником 22.10.2026.
 *
 *  Що робить: завантажує фід постачальника (профіль medium — без описів і ключових слів), знаходить нові ID,
 *  стежить за їхньою стабільністю (10 хв без суттєвих змін) і повнотою, лише тоді запускає GitHub intake.
 *  У Google-таблицю Worker НЕ пише нічого. В основний каталог / YML нічого не потрапляє без затвердження власника.
 *
 *  Прив'язки (wrangler.jsonc): KV WATCH_KV; секрети SUPPLIER_FEED_URL, WATCH_KEY, GITHUB_TOKEN (необов'язковий:
 *  без нього — лише спостереження, без запусків GitHub); змінні GITHUB_REPO, GITHUB_WORKFLOW, GITHUB_REF, FEED_PROFILE.
 *
 *  Стан — у KV «watch:v1» (пише ЛИШЕ cron). Звіти GitHub — у «ack:latest» (пише лише POST /ack); cron застосовує їх
 *  на початку запуску. Так немає гонки двох записувачів одного ключа (KV не має транзакцій).
 *  Записи в KV — лише при змінах або раз на годину (ліміт Free: 1000 записів/добу). */
import { INTAKE_RULES, applyAck, emptyState, markDispatched, planWatch, publicStatus, scanFeed, wantedIds, watchFeedUrl } from "../../../src/core/intake.mjs";

export const STATE_KEY = "watch:v1";
export const ACK_KEY = "ack:latest";
const MAX_FEED_BYTES = 40_000_000;
const MAX_ACK_BYTES = 2_000_000;
const MIN = 60_000;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** Порівняння ключа за сталий час (без раннього виходу на першій розбіжності). */
function sameKey(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length > 0;
}
const authorized = (req, env) => Boolean(env.WATCH_KEY) && sameKey((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""), env.WATCH_KEY);
const profileOf = (env) => (env.FEED_PROFILE === "operational" ? "operational" : "medium");
function rulesOf(env) {
  const r = { ...INTAKE_RULES };
  for (const k of ["maxDispatchPerDay", "minDispatchGapMinutes", "stableMinutes", "minOffers"]) if (env[k] && Number.isFinite(Number(env[k]))) r[k] = Number(env[k]);
  return r;
}

async function loadState(kv) { return (await kv.get(STATE_KEY, "json")) || emptyState(); }

/** Запуск GitHub intake: workflow_dispatch без жодних ID (список кандидатів GitHub бере з GET /intake за ключем). */
async function dispatchGithub(env, fetchImpl) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return { ok: false, reason: "лише спостереження (немає GITHUB_TOKEN)" };
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW || "sheets-verify.yml"}/dispatches`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mm-new-items-watch", "content-type": "application/json" },
    body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { mode: env.GITHUB_MODE || "copy-intake" } }),
  });
  return res.ok ? { ok: true } : { ok: false, reason: "GitHub HTTP " + res.status };
}

/** Один запуск спостереження. Повертає короткий звіт (без адрес і ключів). */
export async function runWatch(env, now = Date.now(), fetchImpl = fetch) {
  const rules = rulesOf(env), profile = profileOf(env);
  let state = await loadState(env.WATCH_KV);
  let dirty = false;
  // Звіт GitHub, що надійшов після попереднього запуску.
  const ack = await env.WATCH_KV.get(ACK_KEY, "json");
  if (ack && ack.receivedAt > (state.ackAppliedAt || 0)) {
    try { state = applyAck(state, ack, now, rules); } catch { /* пошкоджений звіт — ігноруємо */ }
    state.ackAppliedAt = ack.receivedAt; dirty = true;
  }
  const save = async (s) => { s.savedAt = now; await env.WATCH_KV.put(STATE_KEY, JSON.stringify(s)); };
  const finish = async (report) => { if (dirty) await save(state); return report; };
  if (state.backoffUntil > now) return finish({ skipped: "ПАУЗА: постачальник обмежив частоту", until: new Date(state.backoffUntil).toISOString() });
  if (!env.SUPPLIER_FEED_URL) return finish({ skipped: "немає адреси фіду (секрет SUPPLIER_FEED_URL)" });

  let text, httpStatus = 0;
  try {
    const res = await fetchImpl(watchFeedUrl(env.SUPPLIER_FEED_URL, profile), { redirect: "manual", headers: { "accept-encoding": "gzip" } });
    httpStatus = res.status;
    if (res.status === 429 || res.status === 503) {
      state.backoffUntil = now + rules.backoffMinutes * MIN; dirty = true;
      return finish({ skipped: "ПАУЗА: HTTP " + res.status + " від постачальника" });
    }
    // Workers не підтримують redirect: "error" (перевірено в Cloudflare 22.10.2026): «manual» + будь-яка переадресація — помилка.
    if (res.status !== 200) return finish({ error: (res.status >= 300 && res.status < 400 ? "фід: переадресація заборонена, HTTP " : "фід: HTTP ") + res.status });
    if (Number(res.headers.get("content-length") || 0) > MAX_FEED_BYTES) return finish({ error: "фід завеликий" });
    text = await res.text();
  } catch (e) { return finish({ error: "фід недоступний: " + String(e?.message || e).slice(0, 100) }); }
  if (text.length > MAX_FEED_BYTES) return finish({ error: "фід завеликий" });

  let scan;
  try { scan = scanFeed(text, wantedIds(state)); }
  catch (e) { return finish({ error: "фід пошкоджений: " + String(e?.message || e).slice(0, 100) }); }
  const feedChars = text.length;
  text = null;
  const plan = planWatch({ state, scan, now, rules, profile });
  Object.assign(plan.report, { feedChars, httpStatus, profile });
  let next = plan.state;
  if (plan.dispatch) {
    next.lastDispatch = { ...plan.dispatch, issuedAt: now };
    const d = await dispatchGithub(env, fetchImpl);
    if (d.ok) next = markDispatched(next, plan.dispatch, now);
    else plan.report.blocked = d.reason;
    plan.report.dispatched = d.ok;
  }
  if (plan.persist || plan.dispatch || dirty) await save(next);
  return plan.report;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWatch(env, event.scheduledTime || Date.now()).then((r) => console.log(JSON.stringify(r))).catch((e) => console.log("ПОМИЛКА: " + String(e?.message || e).slice(0, 200))));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!authorized(req, env)) return json({ error: "немає доступу" }, 401);
    if (req.method === "GET" && url.pathname === "/status") {
      // Для перегляду — з урахуванням звіту GitHub, який cron ще не застосував (без запису: пише лише cron).
      let s = await loadState(env.WATCH_KV);
      const ack = await env.WATCH_KV.get(ACK_KEY, "json");
      if (ack && ack.receivedAt > (s.ackAppliedAt || 0)) { try { s = applyAck(s, ack, Date.now(), rulesOf(env)); } catch { /* */ } }
      return json(publicStatus(s));
    }
    if (req.method === "GET" && url.pathname === "/intake") {
      const s = await loadState(env.WATCH_KV);
      return json(s.lastDispatch || { profile: profileOf(env), ready: [], refresh: [] });
    }
    if (req.method === "POST" && url.pathname === "/ack") {
      const body = await req.text();
      if (body.length > MAX_ACK_BYTES) return json({ error: "звіт завеликий" }, 413);
      let ack;
      try { ack = JSON.parse(body); } catch { return json({ error: "не JSON" }, 400); }
      if (!Array.isArray(ack.known) || !ack.known.length) return json({ error: "звіт без бази відомих ID" }, 400);
      if (ack.profile && ack.profile !== profileOf(env)) return json({ error: "інший профіль фіду" }, 409);
      await env.WATCH_KV.put(ACK_KEY, JSON.stringify({ ...ack, receivedAt: Date.now() }));
      return json({ ok: true });
    }
    return json({ error: "не знайдено" }, 404);
  },
};
