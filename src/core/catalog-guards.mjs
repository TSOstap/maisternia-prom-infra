/** Захист цілісності каталогу: погодження набору, заборона випадкового видалення, дублікати, нові товари. */
import { mtSku, mtText } from "./text.mjs";
import { approvalManifest } from "./seal.mjs";

/**
 * Новий паспорт погодженого набору фіду. Порівнюється з попереднім:
 * зникнення будь-якого ID (понад maxRemoved) дозволене лише з явним списком allowRemove.
 */
export function approveSet({ rows, groups, previous, allowRemove = [], maxRemoved = 0, approvedBy, note, now }) {
  const ids = rows.map((r) => mtText(r["Offer ID"])).sort();
  const current = new Set(ids);
  const before = new Set(previous?.ids || []);
  const removed = previous?.ids ? previous.ids.filter((id) => !current.has(id)) : [];
  const added = previous?.ids ? ids.filter((id) => !before.has(id)) : ids.slice();
  const allowed = new Set(allowRemove.map(String));
  const unapproved = removed.filter((id) => !allowed.has(id));
  if (unapproved.length > maxRemoved) {
    throw new Error(`Видалення ${unapproved.length} товарів без явного погодження заборонене (перші: ${unapproved.slice(0, 5).join(", ")})`);
  }
  const removedSet = new Set(removed);
  const extra = allowRemove.map(String).filter((id) => !removedSet.has(id));
  if (extra.length) throw new Error("Список дозволених видалень містить ID, яких не видаляють: " + extra.slice(0, 5).join(", "));
  return {
    ...approvalManifest(rows, groups),
    ids,
    approvedAt: new Date(now).toISOString(),
    approvedBy: approvedBy || "",
    note: note || "",
    diff: { added: added.length, removed: removed.length, removedIds: removed },
    previousIdsSha: previous?.idsSha || null,
  };
}

/** Звіт про дублікати (не блокує — чинна логіка блокує лише дубль Offer ID). */
export function duplicateReport(sheetRows) {
  const bySupplier = new Map();
  const bySku = new Map();
  for (const [sheet, rows] of Object.entries(sheetRows)) {
    for (const r of rows) {
      const sid = mtText(r["ID постачальника"]);
      const sku = mtSku(r["Артикул постачальника"]);
      const ref = { sheet, id: mtText(r["Offer ID"]) };
      if (sid) bySupplier.set(sid, [...(bySupplier.get(sid) || []), ref]);
      if (sku) bySku.set(sku, [...(bySku.get(sku) || []), ref]);
    }
  }
  const dup = (m) => [...m.entries()].filter(([, v]) => v.length > 1).map(([key, refs]) => ({ key, refs }));
  return { supplierIdDuplicates: dup(bySupplier), skuDuplicates: dup(bySku) };
}

/**
 * Нові товари постачальника: ID, яких немає в жодному відомому аркуші.
 * seen — стан попередніх запусків { id: {firstSeen, lastSeen, ...} } для дати першої появи.
 * Нічого не додає до каталогу/фіду: нові товари проходять окремий контентний процес і погодження.
 */
export function detectNewProducts({ offers, knownIds, seen = {}, now }) {
  const stamp = new Date(now).toISOString();
  const nextSeen = {};
  const candidates = [];
  for (const [id, o] of offers) {
    if (knownIds.has(id)) continue;
    const prev = seen[id];
    const entry = {
      id, sku: o.sku, nameUa: o.nameUa, nameRu: o.nameRu, url: o.url, price: o.price, available: o.available,
      firstSeen: prev?.firstSeen || stamp, lastSeen: stamp,
    };
    nextSeen[id] = entry;
    candidates.push(entry);
  }
  const gone = Object.keys(seen).filter((id) => !offers.has(id) && !knownIds.has(id));
  candidates.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen) || a.id.localeCompare(b.id));
  return {
    candidates,
    newSinceLastRun: candidates.filter((c) => !seen[c.id]).map((c) => c.id),
    disappearedCandidates: gone,
    seen: nextSeen,
  };
}
