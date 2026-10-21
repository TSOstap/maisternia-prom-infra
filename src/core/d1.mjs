/** Рішення D1 власника (21.10.2026): зникнення товарів із повного коректного фіду постачальника.
 *  Чисті функції без мережі/сховища — їх викликає конвеєр (src/pipeline/update.mjs).
 *
 *  1. Відсутній товар не видаляється з каталогу/фіду.
 *  2. Без підтвердженого власного залишку — «Немає в наявності» (план F:M: «-», знижка '').
 *  3. Повернувся з тим самим або колишнім ID — та сама картка знову ЗІСТАВЛЕНО.
 *  4–7. Новий ID постачальника для наявної картки — через identity.mjs; історія ID у реєстрі links.
 *  8. 60/90 днів відсутності — лише пропозиція приховати/архівувати.
 *  9. Аномально багато «нових» зникнень за один запуск — це не масове видалення, а збій фіду: запуск зупиняється.
 *  10. Окреме зникнення не блокує публікацію (див. missingPolicy у yml.mjs). */
import { mtText } from "./text.mjs";
import { MATCH } from "./sync-plan.mjs";
import { applyRelink, cardKeys, effectiveSupplierId, resolveUnknownOffers } from "./identity.mjs";
import { STATUS_OWN_STOCK } from "./yml.mjs";

/**
 * Зіставлення ідентичності до плану F:M.
 * @param syncRows   рядки аркушів синхронізації (картки, які можна перев'язати)
 * @param knownRows  усі відомі рядки (включно з «Відкладеними») — щоб не вважати їх новими
 * @param offers     Map<id, offer> повного коректного фіду
 * @param links      реєстр прив'язок (SUPPLIER_LINKS_V1) або null
 * @returns { links, relinked[], manual[], newOfferIds[], decisions[] }
 */
export function resolveIdentity({ syncRows, knownRows, offers, links, autoRelink, now }) {
  const at = new Date(now).toISOString();
  let next = links ? structuredClone(links) : { kind: "SUPPLIER_LINKS_V1", cards: {}, retired: {} };
  next.cards ||= {};
  next.retired ||= {};
  const syncIds = new Set(syncRows.map((r) => mtText(r["Offer ID"])));
  const effective = new Map(knownRows.map((r) => [mtText(r["Offer ID"]), effectiveSupplierId(next, r)]));
  const linked = new Set(effective.values());
  const columnIds = new Set(knownRows.map((r) => mtText(r["ID постачальника"])));
  const relinked = [];
  const manual = [];

  // 3/7. Колишній ID постачальника повернувся у фід.
  for (const [oldId, offerId] of Object.entries(next.retired)) {
    if (!offers.has(oldId) || linked.has(oldId) || !syncIds.has(offerId)) continue;
    const current = effective.get(offerId);
    if (current && offers.has(current)) {
      manual.push({ offerId: oldId, decision: "MANUAL_REVIEW", target: offerId, reason: "колишній ID повернувся, але поточний ID картки теж живий" });
      continue;
    }
    if (autoRelink) {
      next = applyRelink(next, { offerId, fromSupplierId: current, toSupplierId: oldId, at, reason: "повернення колишнього ID постачальника" });
      delete next.retired[oldId];
      effective.set(offerId, oldId); linked.add(oldId);
      relinked.push({ offerId, from: current, to: oldId, reason: "повернення колишнього ID" });
    } else manual.push({ offerId: oldId, decision: "RELINK_PROPOSED", target: offerId, reason: "повернення колишнього ID (autoRelink вимкнено)" });
  }

  // 4–6. Невідомі offers проти карток-сиріт.
  const knownCardIds = new Set([...linked, ...columnIds, ...Object.keys(next.retired)]);
  const unknown = [...offers.values()].filter((o) => !knownCardIds.has(o.id));
  const orphanIds = new Set([...syncIds].filter((id) => !offers.has(effective.get(id))));
  const cards = knownRows.map((r) => ({ ...cardKeys(r), supplierId: effective.get(mtText(r["Offer ID"])) }));
  const decisions = unknown.length ? resolveUnknownOffers({ offers: unknown, cards, orphanIds }) : [];
  for (const d of decisions) {
    if (d.decision === "RELINK" && autoRelink) {
      const from = effective.get(d.target);
      next = applyRelink(next, { offerId: d.target, fromSupplierId: from, toSupplierId: d.offerId, at, reason: "STRONG: " + d.candidates[0].evidence.join("+") });
      effective.set(d.target, d.offerId);
      relinked.push({ offerId: d.target, from, to: d.offerId, reason: d.reason, evidence: d.candidates[0].evidence });
    } else if (d.decision === "RELINK") {
      manual.push({ ...d, decision: "RELINK_PROPOSED" });
    } else if (d.decision === "MANUAL_REVIEW") manual.push(d);
  }
  return { links: next, relinked, manual, newOfferIds: decisions.filter((d) => d.decision === "NEW").map((d) => d.offerId), effective };
}

/** Рядок для плану: ID постачальника береться з реєстру прив'язок, незмінні колонки не чіпаються. */
export function planView(row, effective) {
  const sid = effective.get(mtText(row["Offer ID"]));
  return sid && sid !== mtText(row["ID постачальника"]) ? { ...row, "ID постачальника": sid } : row;
}

/** Підтверджений власний залишок, не старший за maxAgeDays. */
export function ownStockFor(ownStock, offerId, now, maxAgeDays) {
  const item = ownStock?.items?.[offerId];
  if (!item) return null;
  const qty = Number(item.qty);
  const age = now - new Date(item.confirmedAt).getTime();
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(age) || age < 0 || age > maxAgeDays * 86400000) return null;
  return { qty };
}

/**
 * Пост-обробка плану (п. 2, 3, 8): власний залишок, облік днів відсутності, пропозиції приховати/архівувати.
 * Мутує next у плані лише для рядків ВІДСУТНІЙ_У_YML із підтвердженим власним залишком.
 */
export function applyAvailabilityPolicy({ plans, previousMissing = {}, ownStock, now, policy, pricing }) {
  const stamp = new Date(now).toISOString();
  const missing = {};
  const returned = [];
  const newlyMissing = [];
  const proposals = [];
  let total = 0;
  for (const plan of plans) {
    for (const p of plan) {
      total++;
      if (p.match === MATCH.MISSING) {
        const own = ownStockFor(ownStock, p.id, now, policy.ownStockMaxAgeDays);
        const prices = p.before.slice(0, 3);
        if (own && prices.every((v) => mtText(v).trim() !== "")) {
          p.next[3] = pricing.discount + "%"; p.next[4] = "+"; p.next[5] = own.qty; p.next[6] = STATUS_OWN_STOCK;
          p.match = STATUS_OWN_STOCK;
        }
        const since = previousMissing[p.id]?.since || stamp;
        if (!previousMissing[p.id]) newlyMissing.push(p.id);
        missing[p.id] = { since };
        const days = Math.floor((now - new Date(since).getTime()) / 86400000);
        if (days >= policy.proposeArchiveAfterDays) proposals.push({ id: p.id, days, proposal: "PROPOSE_ARCHIVE" });
        else if (days >= policy.proposeHideAfterDays) proposals.push({ id: p.id, days, proposal: "PROPOSE_HIDE" });
      } else if (previousMissing[p.id] && p.match === MATCH.OK) {
        returned.push({ id: p.id, since: previousMissing[p.id].since });
      }
    }
  }
  const limit = Math.max(policy.anomaly.maxNewlyMissing, Math.ceil(total * policy.anomaly.maxNewlyMissingRatio));
  return { missing, returned, newlyMissing, proposals, anomaly: newlyMissing.length > limit ? { newlyMissing: newlyMissing.length, limit } : null };
}
