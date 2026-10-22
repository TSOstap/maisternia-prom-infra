/** «Сторож новинок»: спільний цикл (без сховища) — для Durable Object і тестового виміру.
 *  Завантаження фіду (лише HTTPS Market Tools; переадресації не виконуються; 429/503 → пауза), розбір наявним ядром,
 *  запуск GitHub intake. Бізнес-логіка — у src/core/intake.mjs (та сама, що й у GitHub intake). */
import { INTAKE_RULES, planWatch, scanFeed, wantedIds, watchFeedUrl } from "../../../src/core/intake.mjs";

export const MIN = 60_000;
export const MAX_FEED_CHARS = 40_000_000;
/** Адреса фіду — лише HTTPS Market Tools (як config.supplier.allowedUrlPattern): секретне посилання не піде на сторонній хост. */
export const FEED_URL_RE = /^https:\/\/market-tools\.com\.ua\//i;

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** Порівняння ключа за сталий час (без раннього виходу на першій розбіжності). */
export function sameKey(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length > 0;
}
export const authorized = (req, env) => Boolean(env.WATCH_KEY) && sameKey((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""), env.WATCH_KEY);
export const profileOf = (env) => (env.FEED_PROFILE === "operational" ? "operational" : "medium");
export function rulesOf(env) {
  const r = { ...INTAKE_RULES, githubBackoffMinutes: 15, leaseMinutes: 5, alarmMinutes: 5, alarmDedupeMinutes: 4 };
  for (const k of ["maxDispatchPerDay", "minDispatchGapMinutes", "stableMinutes", "minOffers"]) if (env[k] && Number.isFinite(Number(env[k]))) r[k] = Number(env[k]);
  return r;
}

/**
 * Завантажити фід. Повертає { text, httpStatus } | { backoff: true, httpStatus } | { error }.
 * Workers не підтримують redirect: "error" (перевірено в Cloudflare 22.10.2026) — «manual» + будь-який 3xx — помилка.
 */
export async function fetchFeed(env, profile, fetchImpl) {
  if (!env.SUPPLIER_FEED_URL) return { skipped: "немає адреси фіду (секрет SUPPLIER_FEED_URL)" };
  if (!FEED_URL_RE.test(env.SUPPLIER_FEED_URL)) return { error: "адреса фіду не Market Tools (HTTPS) — запит не надіслано" };
  let res;
  try { res = await fetchImpl(watchFeedUrl(env.SUPPLIER_FEED_URL, profile), { redirect: "manual", headers: { "accept-encoding": "gzip" } }); }
  catch (e) { return { error: "фід недоступний: " + String(e?.message || e).slice(0, 100) }; }
  if (res.status === 429 || res.status === 503) return { backoff: true, httpStatus: res.status };
  if (res.status !== 200) return { error: (res.status >= 300 && res.status < 400 ? "фід: переадресація заборонена, HTTP " : "фід: HTTP ") + res.status, httpStatus: res.status };
  let text;
  try { text = await res.text(); } catch (e) { return { error: "фід обірвано під час завантаження: " + String(e?.message || e).slice(0, 100) }; }
  if (text.length > MAX_FEED_CHARS) return { error: "фід завеликий" };
  return { text, httpStatus: 200 };
}

/** Синхронна частина циклу: розбір і план на ВЖЕ завантаженому тексті. Помилка фіду — стан не змінюється. */
export function planFromText({ state, text, now, rules, profile }) {
  let scan;
  try { scan = scanFeed(text, wantedIds(state)); }
  catch (e) { return { error: "фід пошкоджений: " + String(e?.message || e).slice(0, 100) }; }
  const plan = planWatch({ state, scan, now, rules, profile });
  Object.assign(plan.report, { feedChars: text.length, httpStatus: 200, profile });
  return plan;
}

/** Запуск GitHub intake: workflow_dispatch без жодних ID (список кандидатів GitHub бере з GET /intake за ключем). */
export async function dispatchGithub(env, fetchImpl) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return { ok: false, observeOnly: true, reason: "лише спостереження (немає GITHUB_TOKEN)" };
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW || "sheets-verify.yml"}/dispatches`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mm-new-items-watch", "content-type": "application/json" },
      body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { mode: env.GITHUB_MODE || "copy-intake" } }),
      redirect: "manual", // переадресація — невдача: токен GitHub не піде на іншу адресу
    });
    return res.ok ? { ok: true } : { ok: false, reason: "GitHub HTTP " + res.status };
  } catch (e) { return { ok: false, reason: "GitHub недоступний: " + String(e?.message || e).slice(0, 80) }; }
}
