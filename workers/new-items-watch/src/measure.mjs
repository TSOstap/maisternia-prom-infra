/** ТЕСТОВИЙ вимір CPU «Сторожа новинок» у Cloudflare (22.10.2026). Окремий Worker mm-new-items-watch-test:
 *  без розкладу, без сховища, без секретів, без GitHub і без Google Sheets — лише спостереження за XML.
 *  POST /measure (ключ: його SHA-256 — у змінній KEY_SHA256; сам ключ лише в запиті) з тілом
 *    { feedUrl, profile, known: [ID], queue: { ID: відбиток }, skipFeed? } →
 *  той самий цикл (src/cycle.mjs), що й у Durable Object, зі станом у пам'яті одного виклику. Адреса фіду не зберігається.
 *  Примітка: у Cloudflare розгорнуто версію від 22.10 (через runWatch); цей файл — та сама логіка на спільному циклі. */
import { FEED_URL_RE, fetchFeed, json, planFromText, rulesOf } from "./cycle.mjs";
import { applyAck, emptyState } from "../../../src/core/intake.mjs";

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
    const state = applyAck(emptyState(), { known: body.known, queue: body.queue || {} }, now);
    const calls = [];
    const fetchImpl = async (u, init) => { calls.push("feed"); return fetch(u, init); };
    const profile = body.profile === "operational" ? "operational" : "medium";
    const e2 = { SUPPLIER_FEED_URL: body.skipFeed ? "" : body.feedUrl, minOffers: env.minOffers };
    const feed = await fetchFeed(e2, profile, fetchImpl);
    if (!feed.text) return json({ report: feed, subrequests: calls, candidates: [], queueMismatch: [] });
    const plan = planFromText({ state, text: feed.text, now, rules: rulesOf(e2), profile });
    if (plan.error) return json({ report: { error: plan.error }, subrequests: calls, candidates: [], queueMismatch: [] });
    return json({
      report: plan.report, subrequests: calls,
      candidates: Object.entries(plan.state.candidates).map(([id, r]) => ({ id, fp: r.fp, status: r.status, missing: r.missing })),
      queueMismatch: Object.entries(plan.state.queue).filter(([, q]) => q.pendingFp).map(([id, q]) => ({ id, fp: q.pendingFp })),
    });
  },
};
