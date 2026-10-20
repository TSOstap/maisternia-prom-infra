/** Публікація YML у сховище (R2 або локальне) — логіка mtPublishYml_ без Drive/Apps Script.
 *
 *  Ключі для фіду <name>:
 *    feeds/<name>/versions/<generatedAt>-<sha12>.xml[.gz]  — незмінні версії (ніколи не перезаписуються)
 *    feeds/<name>/manifest.json                            — { active, previous, history[] } — ЄДИНИЙ запис перемикання
 *
 *  Порядок: (повторне використання при незмінному sourceDigest) → PUT кандидата → readback (SHA/розмір/ID)
 *  → повторна перевірка джерела (колбек) → один PUT маніфесту → очищення старих версій понад retain.
 *  Будь-яка помилка до PUT маніфесту не змінює те, що бачить Prom. */
import fs from "node:fs";
import zlib from "node:zlib";
import { verifyYmlStream } from "../core/xml-verify.mjs";

export const manifestKey = (feed) => `feeds/${feed}/manifest.json`;

function versionKey(feed, built, gzip) {
  return `feeds/${feed}/versions/${built.generatedAt.replace(/[:.]/g, "-")}-${built.sha256.slice(0, 12)}.xml${gzip ? ".gz" : ""}`;
}

function entryFrom(key, built, object) {
  return {
    key, sha256: built.sha256, bytes: built.bytes, count: built.count, idsSha: built.idsSha, contentSha: built.contentSha,
    sourceDigest: built.sourceDigest, sourceSuccess: built.sourceSuccess, generatedAt: built.generatedAt,
    encoding: object.gzip ? "gzip" : "identity", storedBytes: object.size, publishedAt: new Date().toISOString(),
  };
}

/** Потік розпакованого вмісту версії для перевірки. */
async function contentStream(store, entry) {
  const raw = await store.getStream(entry.key);
  if (!raw) return null;
  return entry.encoding === "gzip" ? raw.pipe(zlib.createGunzip()) : raw;
}

/** Повна перевірка збереженої версії: SHA усього вмісту, байти, кількість і набір ID. */
export async function verifyStoredVersion(store, entry) {
  const head = await store.head(entry.key);
  if (!head || head.size !== entry.storedBytes || head.metadata?.sha256 !== entry.sha256) throw new Error("Збережена версія відсутня або метадані не збігаються");
  const stream = await contentStream(store, entry);
  if (!stream) throw new Error("Збережена версія відсутня");
  return verifyYmlStream(stream, { count: entry.count, idsSha: entry.idsSha, sha256: entry.sha256, bytes: entry.bytes });
}

async function gzipFile(src) {
  const dst = src + ".gz";
  await new Promise((resolve, reject) => {
    fs.createReadStream(src).pipe(zlib.createGzip({ level: 9 })).pipe(fs.createWriteStream(dst)).on("finish", resolve).on("error", reject);
  });
  return dst;
}

/**
 * @param store       сховище (LocalObjectStore / R2)
 * @param feed        назва фіду
 * @param file        шлях до сформованого XML
 * @param built       результат buildYml
 * @param options     { retain, readback: 'full'|'head', gzip, assertSourceUnchanged: async () => void }
 */
export async function publishFeed(store, feed, file, built, options = {}) {
  const retain = Math.max(2, options.retain ?? 7);
  const manifest = (await store.getJson(manifestKey(feed))) || { active: null, previous: null, history: [] };
  const active = manifest.active;

  let activeValid = false;
  if (active) {
    const h = await store.head(active.key).catch(() => null);
    activeValid = Boolean(h && h.size === active.storedBytes && h.metadata?.sha256 === active.sha256);
  }
  // Ті самі товари/ціни/групи → той самий відбиток: новий файл не створюємо (економія операцій класу A).
  if (activeValid && active.sourceDigest === built.sourceDigest) {
    return { feed, reused: true, active };
  }

  const gzip = Boolean(options.gzip);
  const upload = gzip ? await gzipFile(file) : file;
  const key = versionKey(feed, built, gzip);
  const object = await store.put(key, { file: upload }, {
    contentType: gzip ? "application/gzip" : "application/xml; charset=utf-8",
    metadata: { sha256: built.sha256, count: String(built.count), idsSha: built.idsSha },
  });
  if (gzip) await fs.promises.unlink(upload).catch(() => {});
  const next = entryFrom(key, built, { gzip, size: object.size });

  try {
    if (options.readback === "head") {
      const h = await store.head(key);
      if (!h || h.size !== next.storedBytes || h.metadata?.sha256 !== next.sha256) throw new Error("Readback: метадані кандидата не збігаються");
    } else {
      await verifyStoredVersion(store, next);
    }
    if (options.assertSourceUnchanged) await options.assertSourceUnchanged();
  } catch (error) {
    // Кандидат не став активним — прибираємо, щоб не займав місце.
    await store.delete(key).catch(() => {});
    throw error;
  }

  const history = [next, ...(manifest.history || []).filter((h) => h.key !== next.key)].slice(0, retain);
  const nextManifest = {
    kind: "FEED_MANIFEST_V1",
    feed,
    active: next,
    previous: activeValid ? stripHistory(active) : manifest.previous,
    history,
    updatedAt: new Date().toISOString(),
  };
  await store.putJson(manifestKey(feed), nextManifest); // ЄДИНЕ перемикання для читачів

  const removed = await prune(store, feed, nextManifest);
  return { feed, reused: false, active: next, previous: nextManifest.previous, removed };
}

function stripHistory(entry) {
  return entry ? { ...entry } : null;
}

/** Видаляє версії, на які не посилаються active/previous/history. Видалення в R2 безплатні. */
async function prune(store, feed, manifest) {
  const keep = new Set([manifest.active?.key, manifest.previous?.key, ...manifest.history.map((h) => h.key)].filter(Boolean));
  const keys = await store.list(`feeds/${feed}/versions/`);
  const removed = [];
  for (const k of keys) if (!keep.has(k)) { await store.delete(k); removed.push(k); }
  return removed;
}

/** Ручний відкат: попередня (або вказана з history) версія стає активною після повної перевірки. */
export async function rollbackFeed(store, feed, { toKey } = {}) {
  const manifest = await store.getJson(manifestKey(feed));
  if (!manifest?.active) throw new Error("Немає опублікованого фіду " + feed);
  const target = toKey ? manifest.history.find((h) => h.key === toKey) : manifest.previous;
  if (!target) throw new Error("Немає попередньої версії для відкату");
  await verifyStoredVersion(store, target);
  const next = { ...manifest, active: target, previous: manifest.active, updatedAt: new Date().toISOString(), rolledBackAt: new Date().toISOString() };
  await store.putJson(manifestKey(feed), next);
  return next;
}
