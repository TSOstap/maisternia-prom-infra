/**
 * PoC C3: Cloudflare Workers Free + Static Assets (без R2). ЛИШЕ СИНТЕТИЧНІ ДАНІ.
 *
 *   GET|HEAD /feeds/<name>.xml?key=<ключ>      — фід, зібраний із частин ≤24 MiB однієї версії Worker
 *   GET      /feeds/<name>/status?key=<ключ>   — службові дані версії (sha256, байти, частини) без вмісту
 *
 * Частини й маніфест лежать у static assets під /_feed/… і напряму недоступні: run_worker_first = true,
 * усі запити йдуть через цей код, а він віддає лише маршрути вище.
 *
 * Принципи:
 *  - без ключа або з хибним — 404 до будь-якого читання assets (не розкриваємо, що фід існує);
 *  - перед відповіддю перевіряємо, що КОЖНА частина є (і її розмір, якщо відомий); інакше 503, а не обрізаний файл;
 *  - тіло передається потоком (FixedLengthStream): без буферизації, Content-Length = сума частин;
 *  - SHA-256 тут не рахуємо (CPU-ліміт Free — 10 мс): його рахує публікатор до деплою і під час readback.
 *
 * Змінні (vars): FEED_KEY_SHA256 — hex SHA-256 ключа доступу (сам ключ у конфігу не зберігається), FEEDS — «main,…».
 */

const encoder = new TextEncoder();
const NAME = /^[a-z0-9-]{1,40}$/;

async function sha256hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Порівняння фіксованої довжини без раннього виходу. */
function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function plain(status, text) {
  return new Response(text + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function readManifest(env, base, feed) {
  const r = await env.ASSETS.fetch(new URL(`/_feed/${feed}/manifest.json`, base));
  if (!r.ok) return null;
  try {
    const m = await r.json();
    const ok = m && m.feed === feed && /^[0-9a-f]{64}$/.test(m.sha256) && Number.isSafeInteger(m.bytes) && Array.isArray(m.parts) && m.parts.length > 0
      && m.parts.every((p) => p && /^[A-Za-z0-9._-]{1,80}$/.test(p.file) && Number.isSafeInteger(p.bytes) && p.bytes > 0)
      && m.parts.reduce((s, p) => s + p.bytes, 0) === m.bytes;
    return ok ? m : null;
  } catch {
    return null;
  }
}

/** Відкриває всі частини й перевіряє наявність (і розмір, якщо assets віддають Content-Length) ДО відповіді.
 *  Локальний runtime (wrangler dev) Content-Length для assets не віддає — тоді повну довжину контролює FixedLengthStream:
 *  коротший або довший потік обривається з помилкою, клієнт не отримує «валідний» обрізаний файл. Повертає Response[] або null. */
async function openParts(env, base, feed, manifest) {
  const parts = await Promise.all(manifest.parts.map((p) => env.ASSETS.fetch(new URL(`/_feed/${feed}/${p.file}`, base))));
  const bad = parts.findIndex((r, i) => !r.ok || !r.body || (r.headers.has("content-length") && Number(r.headers.get("content-length")) !== manifest.parts[i].bytes));
  if (bad === -1) return parts;
  for (const r of parts) r.body?.cancel().catch(() => {});
  const r = parts[bad];
  console.error(JSON.stringify({ feed, version: manifest.version, state: "part-invalid", part: bad, status: r.status, length: r.headers.get("content-length"), expected: manifest.parts[bad].bytes }));
  return null;
}

function feedHeaders(m) {
  return {
    "content-type": "application/xml; charset=utf-8",
    "content-length": String(m.bytes),
    "cache-control": "no-store",
    etag: `"${m.sha256}"`,
    "last-modified": new Date(m.builtAt).toUTCString(),
    "x-feed-version": m.version,
    "x-feed-sha256": m.sha256,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Метод не підтримується");
    // workers.dev відповідає і по HTTP: ключ не повинен іти відкритим каналом (localhost — лише для wrangler dev).
    if (url.protocol !== "https:" && !/^(127\.0\.0\.1|localhost)$/.test(url.hostname)) return plain(403, "Лише HTTPS");

    const feedMatch = /^\/feeds\/([^/]+)\.xml$/.exec(url.pathname);
    const statusMatch = /^\/feeds\/([^/]+)\/status$/.exec(url.pathname);
    const feed = (feedMatch || statusMatch)?.[1];
    if (!feed || !NAME.test(feed)) return plain(404, "Не знайдено");

    const key = url.searchParams.get("key") || "";
    if (!key || key.length > 200 || !sameHex(await sha256hex(key), String(env.FEED_KEY_SHA256 || ""))) return plain(404, "Не знайдено");
    if (!String(env.FEEDS || "").split(",").map((s) => s.trim()).includes(feed)) return plain(404, "Не знайдено");

    const manifest = await readManifest(env, url, feed);
    if (!manifest) return plain(503, "Перевірений YML тимчасово недоступний");

    if (statusMatch) {
      const { version, sha256, bytes, builtAt, parts, offers = null } = manifest;
      return new Response(JSON.stringify({ feed, version, sha256, bytes, builtAt, parts: parts.length, offers }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const parts = await openParts(env, url, feed, manifest);
    if (!parts) return plain(503, "Перевірений YML тимчасово недоступний");
    if (request.method === "HEAD") {
      for (const r of parts) r.body.cancel().catch(() => {});
      return new Response(null, { headers: feedHeaders(manifest) });
    }

    // FixedLengthStream — у середовищі Workers (Content-Length без chunked); у Node-тестах — звичайний TransformStream.
    const { readable, writable } = typeof FixedLengthStream === "function" ? new FixedLengthStream(manifest.bytes) : new TransformStream();
    const pump = (async () => {
      for (const r of parts) await r.body.pipeTo(writable, { preventClose: true });
      await writable.close();
    })().catch(async (e) => {
      console.error(JSON.stringify({ feed, version: manifest.version, state: "stream-error", error: String(e).slice(0, 200) }));
      await writable.abort(e).catch(() => {});
    });
    if (ctx?.waitUntil) ctx.waitUntil(pump);
    return new Response(readable, { headers: feedHeaders(manifest) });
  },
};
