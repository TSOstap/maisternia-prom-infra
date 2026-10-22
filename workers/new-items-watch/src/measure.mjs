/** ТЕСТОВИЙ вимір CPU «Сторожа новинок» у Cloudflare (погоджено 22.10.2026: один ручний запуск).
 *  Окремий Worker без розкладу, без KV, без секретів, без GitHub і без Google Sheets — лише спостереження за XML.
 *  POST /measure (ключ: його SHA-256 — у змінній KEY_SHA256; сам ключ лише в запиті) з тілом
 *    { feedUrl, profile, known: [ID], queue: { ID: відбиток } } →
 *  той самий runWatch, що й у робочому Worker, зі станом у пам'яті одного виклику. Адреса фіду ніде не зберігається. */
import { FEED_URL_RE, runWatch, STATE_KEY } from "./index.mjs";
import { applyAck, emptyState } from "../../../src/core/intake.mjs";

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a, b) { let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/measure") return json({ error: "не знайдено" }, 404);
    const key = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.KEY_SHA256 || !key || !same(await sha256hex(key), env.KEY_SHA256)) return json({ error: "немає доступу" }, 401);
    const body = await req.json().catch(() => null);
    if (!body?.feedUrl || !Array.isArray(body.known)) return json({ error: "потрібні feedUrl і known" }, 400);
    if (!FEED_URL_RE.test(body.feedUrl)) return json({ error: "адреса фіду не Market Tools (HTTPS)" }, 400); // не проксі на сторонні адреси
    const now = Date.now();
    const m = new Map([[STATE_KEY, JSON.stringify(applyAck(emptyState(), { known: body.known, queue: body.queue || {} }, now))]]);
    const kv = { async get(k, t) { const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, String(v)); } };
    const calls = [];
    const fetchImpl = async (u, init) => { calls.push(String(u).startsWith("https://api.github.com/") ? "github" : "feed"); return fetch(u, init); };
    const t0 = Date.now();
    // Тест А (skipFeed): та сама робота зі станом, але без завантаження XML — базові накладні витрати.
    const report = await runWatch({ WATCH_KV: kv, SUPPLIER_FEED_URL: body.skipFeed ? "" : body.feedUrl, FEED_PROFILE: body.profile || "medium", minOffers: env.minOffers }, now, fetchImpl);
    const state = JSON.parse(m.get(STATE_KEY));
    return json({
      report, wallMs: Date.now() - t0, subrequests: calls,
      candidates: Object.entries(state.candidates).map(([id, r]) => ({ id, fp: r.fp, status: r.status, missing: r.missing })),
      queueMismatch: Object.entries(state.queue).filter(([, q]) => q.pendingFp).map(([id, q]) => ({ id, fp: q.pendingFp })),
    });
  },
};
