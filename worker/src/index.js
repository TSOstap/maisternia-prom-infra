/**
 * Cloudflare Worker: постійне посилання на YML для Prom.
 *
 *   GET|HEAD /feeds/<name>.xml[.gz]?key=<ключ>   — останній повністю перевірений знімок фіду
 *   GET      /feeds/<name>/status?key=<ключ>     — службовий стан (дата, кількість, вік) без даних товарів
 *
 * Принципи (як у doGet чинного Apps Script):
 *  - без ключа або з хибним — 403 ДО будь-якого звернення до R2;
 *  - Worker нічого не формує й не записує: лише читає manifest.json і віддає вказаний об'єкт потоком;
 *  - якщо активна версія відсутня/не збігається з маніфестом — віддається перевірена попередня;
 *  - якщо немає жодної — 503, ніколи не порожній <offers> і не чужий фід.
 *
 * Прив'язки (wrangler): FEEDS_BUCKET (R2), секрет FEED_ACCESS_KEY, змінна FEEDS="main,…".
 */

const encoder = new TextEncoder();

async function sameSecret(a, b) {
  // Порівняння SHA-256 відбитків фіксованої довжини без раннього виходу.
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(a)), crypto.subtle.digest("SHA-256", encoder.encode(b))]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

function plain(status, text) {
  return new Response(text + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function readManifest(env, feed) {
  const obj = await env.FEEDS_BUCKET.get(`feeds/${feed}/manifest.json`);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}

/** Перевірка відповідності об'єкта запису маніфесту без читання всього тіла (CPU-ліміт Free — 10 мс). */
function matches(obj, entry) {
  return Boolean(obj && entry && obj.size === entry.storedBytes && obj.customMetadata && obj.customMetadata.sha256 === entry.sha256);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Метод не підтримується");

    const feedMatch = /^\/feeds\/([a-z0-9-]{1,40})\.xml(\.gz)?$/.exec(url.pathname);
    const statusMatch = /^\/feeds\/([a-z0-9-]{1,40})\/status$/.exec(url.pathname);
    if (!feedMatch && !statusMatch) return plain(404, "Не знайдено");

    const key = url.searchParams.get("key") || "";
    if (!env.FEED_ACCESS_KEY || !key || !(await sameSecret(key, env.FEED_ACCESS_KEY))) return plain(403, "Доступ заборонено");

    const feed = (feedMatch || statusMatch)[1];
    const allowed = String(env.FEEDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(feed)) return plain(404, "Невідомий фід");

    const manifest = await readManifest(env, feed);
    if (!manifest || !manifest.active) return plain(503, "Перевірений YML тимчасово недоступний");

    if (statusMatch) {
      const a = manifest.active;
      const body = {
        feed, count: a.count, generatedAt: a.generatedAt, sourceSuccess: a.sourceSuccess, publishedAt: a.publishedAt,
        ageMinutes: Math.round((Date.now() - new Date(a.sourceSuccess).getTime()) / 60000), encoding: a.encoding,
        hasPrevious: Boolean(manifest.previous), sha256: a.sha256,
      };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }

    const wantGzip = Boolean(feedMatch[2]);
    const candidates = [["active", manifest.active], ["previous", manifest.previous]]
      .filter(([, e]) => e && (e.encoding === "gzip") === wantGzip);
    for (const [version, entry] of candidates) {
      const obj = request.method === "HEAD" ? await env.FEEDS_BUCKET.head(entry.key) : await env.FEEDS_BUCKET.get(entry.key);
      if (!matches(obj, entry)) {
        console.warn(JSON.stringify({ feed, version, state: "unavailable" }));
        continue;
      }
      const headers = new Headers({
        "content-type": wantGzip ? "application/gzip" : "application/xml; charset=utf-8",
        "content-length": String(obj.size),
        etag: `"${entry.sha256}"`,
        "cache-control": "no-store",
        "x-feed-version": version,
        "x-feed-count": String(entry.count),
        "x-feed-generated-at": entry.generatedAt,
      });
      if (version !== "active") console.warn(JSON.stringify({ feed, version, state: "served-previous" }));
      return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
    }
    return plain(503, "Перевірений YML тимчасово недоступний");
  },
};
