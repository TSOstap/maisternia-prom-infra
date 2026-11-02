/** Catalog Controls — видалені товари (R5, архітектура «Видалені товари»).
 *
 *  Повна картка видаленого товару зберігається в аркуші «Видалені товари» (переносить Engineering). Захисне рішення від цього аркуша
 *  НЕ залежить: реєстр видалень — у довіреній контрольній точці (подія «ТОВАР ВИДАЛЕНО» з мінімальною фізичною ідентичністю).
 *  Фільтр повторного створення (gate) будується з реєстру; рядок в архіві без рішення CC лише додає захисту (fail-closed). */
import { mtText } from "./text.mjs";
import { buildIndex, cardKeys, compare, offerKeys } from "./identity.mjs";
import { identityOf, identityRow, physicalDifferences, physicalIdentity } from "./controls-common.mjs";

/** Вердикти цілісності картки (M3, ENG-10): з якими дозволені видалення й повернення з архіву. */
export const ALLOWED_VERDICTS = Object.freeze(new Set(["OK", "OWNER_EDIT"]));
const offerIdentity = (offer) => ({ supplierId: mtText(offer?.id), sku: offer?.sku, nameUa: offer?.nameUa, nameRu: offer?.nameRu, url: offer?.url });

/**
 * R7.2 (Hermes C71-02): ознаки рядка «Видалених товарів» без Offer ID — нормалізовані складники фізичної ідентичності (ID
 * постачальника, артикул, назви постачальника UA / RU, URL). Порожня ознака — не відома. Одне правило для всіх споживачів (картка
 * каталогу, повернення з архіву, фільтр новинок): кандидат «збігається», якщо КОЖНА відома ознака рядка дорівнює його ознаці.
 * Це не доказ тотожності, а невизначеність: fail-closed (поза YML, відмова в поверненні, новинку не додано) до перевірки рядка.
 */
export const WITNESS_FIELDS = Object.freeze({ supplierId: "ID постачальника", sku: "Артикул постачальника", nameUa: "Назва постачальника UA", nameRu: "Назва постачальника RU", url: "URL постачальника" });
export const witnessOf = (identity) => ({ ...physicalIdentity({ ...identity, sku: "" }), sku: physicalIdentity(identity).sku });
export const witnessKnown = (w) => Object.values(w).some((v) => v !== "");
export const witnessFields = (w) => Object.keys(WITNESS_FIELDS).filter((k) => w[k] !== "").map((k) => WITNESS_FIELDS[k]);
export const witnessMatches = (w, identity) => { const b = witnessOf(identity); return witnessKnown(w) && Object.entries(w).every(([k, v]) => v === "" || v === b[k]); };

/**
 * Фільтр offer постачальника проти видалених (для intake, затвердження, «Сторожа», звіту новинок). Звільнення ID немає.
 * exclusions — Map(Offer ID → { identity }) з довіреного реєстру (і, fail-closed, з рядків архіву без рішення CC).
 * unnamed — R7.1 (Hermes R7-P2): [{ ref, identity }] — непорожні рядки «Видалених товарів» без Offer ID; блокують за ID постачальника
 * й фізичною ідентичністю так само (recordId — посилання на рядок, а не Offer ID). R7.2 (C71-02): і за НЕПОВНИМИ ознаками —
 * UNIDENTIFIED_ARCHIVE (blocked; товар не визначено, а не «доведено той самий»).
 * check(offer) → { blocked, kind: EXCLUDED | ID_REUSE_CONFLICT | EXCLUDED_NEW_ID | UNIDENTIFIED_ARCHIVE | SIMILAR_TO_EXCLUDED | NONE, recordId, reason }.
 */
export function exclusionGate(exclusions, unnamed = []) {
  const byId = new Map(), identities = new Map();
  const cards = [];
  for (const [id, x] of exclusions) {
    identities.set(id, x.identity);
    for (const k of [x.identity?.supplierId, id]) if (k && !byId.has(k)) byId.set(k, id);
    cards.push({ ...cardKeys(identityRow(x.identity)), offerId: id });
  }
  for (const u of unnamed) {
    identities.set(u.ref, u.identity);
    const k = mtText(u.identity?.supplierId);
    if (k && !byId.has(k)) byId.set(k, u.ref);
    cards.push({ ...cardKeys(identityRow(u.identity)), offerId: u.ref });
  }
  const index = buildIndex(cards);
  const named = (rid) => exclusions.has(rid);
  const witnesses = unnamed.map((u) => ({ ref: u.ref, w: witnessOf(u.identity) })).filter((x) => witnessKnown(x.w));
  function check(offer) {
    const oid = mtText(offer?.id);
    const rid = byId.get(oid);
    if (rid) {
      const differences = physicalDifferences(identities.get(rid), offerIdentity(offer));
      if (differences.length) return { blocked: true, kind: "ID_REUSE_CONFLICT", recordId: rid, offerId: oid, differences, reason: `ID ${oid} належить видаленому товару ${named(rid) ? rid : `(${rid})`}, але фізично це інший товар — конфлікт на ручну перевірку` };
      return { blocked: true, kind: "EXCLUDED", recordId: rid, offerId: oid, reason: `товар видалено (${named(rid) ? `Offer ID ${rid}` : rid}) — повторне додавання заборонене` };
    }
    const ok = offerKeys(offer || {});
    const pool = new Map();
    for (const list of [index.sku.get(ok.sku), index.skuLoose.get(ok.skuLoose), index.gtin.get(ok.gtin), index.brandModel.get(ok.brand + "|" + ok.model), index.slug.get(ok.slug)]) {
      for (const c of list || []) pool.set(c.offerId, c);
    }
    let similar = null;
    for (const c of pool.values()) {
      const cmp = compare(c, ok);
      if (cmp.level === "STRONG") return { blocked: true, kind: "EXCLUDED_NEW_ID", recordId: c.offerId, offerId: oid, evidence: cmp.evidence, reason: `схоже, це видалений товар ${c.offerId} під новим ID ${oid}` };
      if (cmp.level !== "NONE" && !similar) similar = { blocked: false, kind: "SIMILAR_TO_EXCLUDED", recordId: c.offerId, offerId: oid, evidence: cmp.evidence, reason: `схожий на видалений товар ${c.offerId} — лише позначка` };
    }
    const u = witnesses.find((x) => witnessMatches(x.w, offerIdentity(offer)));
    if (u) return { blocked: true, kind: "UNIDENTIFIED_ARCHIVE", recordId: u.ref, offerId: oid, evidence: witnessFields(u.w), reason: `збігається за ознаками (${witnessFields(u.w).join(", ")}) з рядком без Offer ID (${u.ref}) — товар не визначено; додавання заборонене до перевірки цього рядка` };
    return similar || { blocked: false, kind: "NONE", offerId: oid };
  }
  return { check, knownIds: new Set(byId.keys()), size: exclusions.size };
}

/**
 * Що не дає повернути товар з архіву — перевірки ЛИШЕ цієї картки (рішення власника B; CC4-N3):
 *  row — єдиний рядок товару («Видалені товари» або, до перенесення, «Основний каталог»); rowsWithId — скільки рядків із цим Offer ID
 *  в обох аркушах; verdict — вердикт цілісності картки (M3); registryIdentity — довірена ідентичність із реєстру видалення; offer —
 *  offer постачальника з тим самим ID (якщо є у фіді); mainRows — активні картки; queueRows / deferredRows — null, якщо аркуш не
 *  вдалося прочитати (тоді перевірку НЕ вважаємо пройденою); tombstoned — Offer ID інших видалених.
 */
export function restoreProblems({ id, row, rowsWithId, verdict, registryIdentity, offer = null, mainRows, queueRows, deferredRows, tombstoned }) {
  const p = [];
  if (rowsWithId !== 1) p.push(`рядків із цим Offer ID в «Основному каталозі» й «Видалених товарах»: ${rowsWithId} (має бути 1)`);
  if (row) {
    if (!ALLOWED_VERDICTS.has(verdict?.verdict)) p.push(`картка не пройшла перевірку цілісності (${verdict?.verdict || "UNVERIFIED"}${verdict?.reasons?.length ? ": " + verdict.reasons.join("; ") : ""})`);
    const d = physicalDifferences(registryIdentity, identityOf(row));
    if (d.length) p.push(`фізична ідентичність картки відрізняється від реєстру видалення (${d.join("; ")}) — ручна перевірка`);
    const sid = mtText(row["ID постачальника"]), code = mtText(row["Код товару Prom"]).trim();
    const others = mainRows.filter((r) => mtText(r["Offer ID"]) !== id && !tombstoned.has(mtText(r["Offer ID"])));
    const sOwner = sid && others.find((r) => mtText(r["ID постачальника"]) === sid);
    if (sOwner) p.push(`ID постачальника вже використовує товар ${mtText(sOwner["Offer ID"])}`);
    const cOwner = code && others.find((r) => mtText(r["Код товару Prom"]).trim() === code);
    if (cOwner) p.push(`«Код товару Prom» уже використовує товар ${mtText(cOwner["Offer ID"])}`);
  }
  if (offer) {
    const d = physicalDifferences(registryIdentity, offerIdentity(offer));
    if (d.length) p.push(`постачальник повторно використав ID для іншого товару (${d.join("; ")}) — ручна перевірка`);
  }
  // CC4-N3: нечитабельна обов'язкова залежність — не доказ відсутності конфлікту.
  if (queueRows === null) p.push("«Нові товари» не вдалося прочитати — перевірку конфліктів не виконано");
  if (deferredRows === null) p.push("«Відкладені товари» не вдалося прочитати — перевірку конфліктів не виконано");
  const sid = mtText(row?.["ID постачальника"] ?? registryIdentity?.supplierId);
  if ([...(queueRows || []), ...(deferredRows || [])].some((r) => mtText(r["Offer ID"]) === id || (sid && mtText(r["ID постачальника"]) === sid))) p.push("цей товар уже є в «Нових товарах» або «Відкладених»");
  return p;
}
