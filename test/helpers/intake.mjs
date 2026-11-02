/** Тести: синхронізація + GitHub intake кандидатів, стабільність яких «підтвердив» Worker (імітація: ≥11 хв без змін).
 *  Відбитки рахує справжнє ядро (scanFeed/watchFingerprint) — як у Worker; intake повторно перевіряє їх за повним XML. */
import { parseSupplierText } from "../../src/core/supplier-feed.mjs";
import { extractFullOffers } from "../../src/core/sheet-sync.mjs";
import { scanFeed, watchFingerprint } from "../../src/core/intake.mjs";
import { intakeSheet, syncSheet } from "../../src/pipeline/sheet-sync-run.mjs";
import { WriteGateway } from "../../src/pipeline/safe-write/gateway.mjs";
import { MemoryStore } from "../../src/pipeline/safe-write/store.mjs";
import { enabled as ownerPriorityEnabled } from "../../src/core/owner-priority.mjs";

/** Тести не залежать від схем у schemas/prom: за замовчуванням — порожній каталог (схеми передає сам тест). */
export const EMPTY_CATALOG = Object.freeze({ schemas: new Map(), mappings: new Map(), units: { conversions: [] }, problems: [] });

/** Усі offer фіду як «готові» кандидати (відомі intake відсіє як «ВЖЕ Є»). */
export function readyFromXml(xml, now, { stableFor = 11, ids = null } = {}) {
  const scan = scanFeed(xml, (id) => !ids || ids.includes(id));
  const at = new Date(now - stableFor * 60_000).toISOString();
  return [...scan.offers].map(([id, raw]) => ({ id, fp: watchFingerprint(raw), firstSeen: at, lastChange: at }));
}

/** Як робоча функція intakeSheet: БЕЗ сесії шлюзу W2 у робочому режимі — відмова (ENG-18, I06). session: "auto" — як робоча точка
 *  запуску (tools/sheet-sync): сесія відкривається над однохостовим сховищем (w.w2Store або MemoryStore); або готова сесія. */
export async function intakeAll(w, xml, { stamp, now, config, ready, readBook, catalog = w.catalog ?? EMPTY_CATALOG, controls = null, session = null } = {}) {
  if (session === "auto") {
    if (!ownerPriorityEnabled(config)) return intakeAll(w, xml, { stamp, now, config, ready, readBook, catalog, controls, session: null });
    const s = await new WriteGateway({ sheets: w.sheets, read: readBook || w.readBook, store: w.w2Store ?? new MemoryStore() }).open({ writer: "intake" });
    try { return await intakeAll(w, xml, { stamp, now, config, ready, readBook, catalog, controls, session: s }); } finally { await s.close?.().catch(() => {}); }
  }
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  return intakeSheet({ sheets: w.sheets, readBook: readBook || w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp, config, now, ready: ready || readyFromXml(xml, now), catalog, controls, session: session ?? null });
}

/** Як раніше «синхронізація додає нові» — тепер: синхронізація (ціни, рішення) + intake стабільних кандидатів. */
export async function syncAndIntake(w, xml, { stamp, now, config, readBook, catalog = w.catalog ?? EMPTY_CATALOG, controls = null } = {}) {
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  const r = await syncSheet({ sheets: w.sheets, readBook: readBook || w.readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp, config, now, catalog, controls });
  if (r.state !== "SYNCED") return r;
  const i = await intakeAll(w, xml, { stamp, now, config, catalog, controls, session: "auto" }); // як tools/sheet-sync: intake — через сесію шлюзу
  return { ...r, intake: i, stats: { ...r.stats, added: i.stats?.added ?? 0, possibleDuplicates: i.stats?.possibleDuplicates ?? 0 } };
}
