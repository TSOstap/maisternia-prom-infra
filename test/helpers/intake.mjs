/** Тести: синхронізація + GitHub intake кандидатів, стабільність яких «підтвердив» Worker (імітація: ≥11 хв без змін).
 *  Відбитки рахує справжнє ядро (scanFeed/watchFingerprint) — як у Worker; intake повторно перевіряє їх за повним XML. */
import { parseSupplierText } from "../../src/core/supplier-feed.mjs";
import { extractFullOffers } from "../../src/core/sheet-sync.mjs";
import { scanFeed, watchFingerprint } from "../../src/core/intake.mjs";
import { intakeSheet, syncSheet } from "../../src/pipeline/sheet-sync-run.mjs";

/** Тести не залежать від схем у schemas/prom: за замовчуванням — порожній каталог (схеми передає сам тест). */
export const EMPTY_CATALOG = Object.freeze({ schemas: new Map(), mappings: new Map(), units: { conversions: [] }, problems: [] });

/** Усі offer фіду як «готові» кандидати (відомі intake відсіє як «ВЖЕ Є»). */
export function readyFromXml(xml, now, { stableFor = 11, ids = null } = {}) {
  const scan = scanFeed(xml, (id) => !ids || ids.includes(id));
  const at = new Date(now - stableFor * 60_000).toISOString();
  return [...scan.offers].map(([id, raw]) => ({ id, fp: watchFingerprint(raw), firstSeen: at, lastChange: at }));
}

export async function intakeAll(w, xml, { stamp, now, config, ready, readBook, catalog = w.catalog ?? EMPTY_CATALOG } = {}) {
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  return intakeSheet({ sheets: w.sheets, readBook: readBook || w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp, config, now, ready: ready || readyFromXml(xml, now), catalog });
}

/** Як раніше «синхронізація додає нові» — тепер: синхронізація (ціни, рішення) + intake стабільних кандидатів. */
export async function syncAndIntake(w, xml, { stamp, now, config, readBook, catalog = w.catalog ?? EMPTY_CATALOG } = {}) {
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  const r = await syncSheet({ sheets: w.sheets, readBook: readBook || w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp, config, now, catalog });
  if (r.state !== "SYNCED") return r;
  const i = await intakeAll(w, xml, { stamp, now, config, catalog });
  return { ...r, intake: i, stats: { ...r.stats, added: i.stats?.added ?? 0, possibleDuplicates: i.stats?.possibleDuplicates ?? 0 } };
}
