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
import { applyRelink, cardKeys, effectiveSupplierId, modelKey, resolveUnknownOffers } from "./identity.mjs";
import { STATUS_OWN_STOCK, STATUS_MODEL_CONFLICT, isConflictStatus } from "./yml.mjs";

/**
 * Зіставлення ідентичності до плану F:M.
 * @param syncRows   рядки аркушів синхронізації (картки, які можна перев'язати)
 * @param knownRows  усі відомі рядки (включно з «Відкладеними») — щоб не вважати їх новими
 * @param offers     Map<id, offer> повного коректного фіду
 * @param links      реєстр прив'язок (SUPPLIER_LINKS_V1) або null
 * @param frozenIds  ID з аркушів лише-ID (`catalog.knownIdSheets`, «Заморожені ID»): зафіксований набір каталогу,
 *                   зокрема свідомо виключені товари. Вони не є «невідомими» і не йдуть у загальну ручну чергу.
 *                   Але якщо є картки-сироти (їхній ID зник із фіду), заморожені offers перевіряються ПРОТИ НИХ:
 *                   схожий — у ручну чергу з окремою причиною; автоматична прив'язка до замороженого offer — ніколи.
 * @returns { links, relinked[], manual[], newOfferIds[], effective, frozen: { inFeed, ignored, flagged } }
 */
export function resolveIdentity({ syncRows, knownRows, offers, links, autoRelink, now, frozenIds = new Set() }) {
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
  const notCard = [...offers.values()].filter((o) => !knownCardIds.has(o.id));
  const unknown = notCard.filter((o) => !frozenIds.has(o.id));
  const frozenOffers = notCard.filter((o) => frozenIds.has(o.id));
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

  // Заморожені offers: лише перевірка проти карток-сиріт (можливий новий ID для зниклої картки).
  const frozen = { inFeed: frozenOffers.length, ignored: 0, flagged: 0 };
  if (frozenOffers.length && orphanIds.size) {
    for (const d of resolveUnknownOffers({ offers: frozenOffers, cards, orphanIds })) {
      if (d.candidates.some((c) => c.orphan && c.level !== "NONE")) {
        frozen.flagged++;
        manual.push({ ...d, decision: "MANUAL_REVIEW", target: d.target || null, frozen: true, reason: "заморожений (свідомо виключений) offer схожий на картку, чий ID зник із фіду — можливий новий ID; автоматично не прив'язується" });
      } else frozen.ignored++;
    }
  } else frozen.ignored = frozenOffers.length;
  return { links: next, relinked, manual, newOfferIds: decisions.filter((d) => d.decision === "NEW").map((d) => d.offerId), effective, frozen };
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

const DAY = 86400000;
const hasVerifiedPrice = (p) => p.before.slice(0, 3).every((v) => mtText(v).trim() !== "");

/** Останні перевірені значення картки та нові значення постачальника — для журналу конфліктів (D1b п. 6). */
function conflictValues(row, p, offer, verifiedAt) {
  return {
    old: {
      supplierId: mtText(row["ID постачальника"]), sku: mtText(row["Артикул постачальника"]), nameUa: mtText(row["Назва постачальника UA"]),
      nameRu: mtText(row["Назва постачальника RU"]), model: mtText(row["Модель"]), price: p.before[0], base: p.before[1], final: p.before[2],
      availability: p.before[4], verifiedAt: verifiedAt || null,
    },
    new: offer ? {
      supplierId: offer.id, sku: offer.sku, nameUa: offer.nameUa, nameRu: offer.nameRu, model: offer.model ?? null,
      price: offer.price, currency: offer.currency, available: offer.available, quantity: offer.quantity,
    } : null,
  };
}

/**
 * Пост-обробка плану: рішення D1 (зникнення) і D1b (конфлікти) — ізоляція окремої картки замість блокування фіду.
 *
 * sheets   [{ rows (рядки, за якими будувався план), plan }] — next/match у плані мутуються
 * offers   Map<id, offer> фіду (для журналу й перевірки моделі)
 * previous { missing, conflicts, verifiedAt } з попереднього стану
 *
 * D1:  ВІДСУТНІЙ_У_YML → «-» (або підтверджений власний залишок), облік днів, пропозиції 60/90.
 * D1b: будь-який конфлікт (ID, артикул, ідентичність/комплект, опорна назва, модель, валюта, ціна, наявність, кількість):
 *      - картка лишається, контент і остання ПЕРЕВІРЕНА ціна не змінюються (plan вже зберіг F:H);
 *      - policy.conflict='isolate': «-», знижка '', кількість ''. Продаж зберігається ЛИШЕ якщо є підтверджений
 *        власний залишок І ціна перевірена не давніше ownStockConflictPriceMaxAgeDays;
 *      - журнал подій OPENED / CHANGED / RESOLVED зі старими й новими значеннями;
 *      - після виправлення звичайний mtMatch знову дає ЗІСТАВЛЕНО → RESOLVED, та сама картка.
 * Аномалія: нових ізоляцій (зникнення + конфлікти) за запуск понад max(N, частка каталогу) → фід несправний.
 */
export function applyAvailabilityPolicy({ sheets, offers = new Map(), previous = {}, ownStock, now, policy, pricing }) {
  const stamp = new Date(now).toISOString();
  const prevMissing = previous.missing || {};
  const prevConflicts = previous.conflicts || {};
  const prevVerified = previous.verifiedAt || {};
  const isolate = (policy.conflict || "block") === "isolate";
  const missing = {};
  const conflicts = {};
  const verifiedAt = {};
  const returned = [];
  const newlyMissing = [];
  const newlyConflicted = [];
  const proposals = [];
  const events = [];
  let total = 0;

  for (const { rows, plan } of sheets) {
    plan.forEach((p, i) => {
      total++;
      const row = rows[i];
      const offer = offers.get(mtText(row["ID постачальника"]));
      // Конфлікт моделі (D1b п. 1): лише якщо постачальник передає <model> і в картці є «Модель».
      if (p.match === MATCH.OK && offer?.model && mtText(row["Модель"]).trim() && modelKey(offer.model) !== modelKey(row["Модель"])) {
        p.next = p.before.slice(); p.next[6] = STATUS_MODEL_CONFLICT; p.next[7] = stamp; p.match = STATUS_MODEL_CONFLICT;
      }
      // Час останньої успішної перевірки ціни: зі стану, інакше зі знімка (стан ЗІСТАВЛЕНО + «Оновлено»).
      verifiedAt[p.id] = p.match === MATCH.OK ? stamp : prevVerified[p.id] || (p.before[6] === MATCH.OK && mtText(p.before[7]) ? mtText(p.before[7]) : null);

      if (p.match === MATCH.MISSING) {
        const own = ownStockFor(ownStock, p.id, now, policy.ownStockMaxAgeDays);
        if (own && hasVerifiedPrice(p)) {
          p.next[3] = pricing.discount + "%"; p.next[4] = "+"; p.next[5] = own.qty; p.next[6] = STATUS_OWN_STOCK;
          p.match = STATUS_OWN_STOCK;
        }
        const since = prevMissing[p.id]?.since || stamp;
        if (!prevMissing[p.id]) newlyMissing.push(p.id);
        missing[p.id] = { since };
        const days = Math.floor((now - new Date(since).getTime()) / DAY);
        if (days >= policy.proposeArchiveAfterDays) proposals.push({ id: p.id, days, proposal: "PROPOSE_ARCHIVE" });
        else if (days >= policy.proposeHideAfterDays) proposals.push({ id: p.id, days, proposal: "PROPOSE_HIDE" });
      } else if (isConflictStatus(p.match)) {
        const reason = p.match;
        let sale = "UNAVAILABLE";
        if (isolate) {
          const own = ownStockFor(ownStock, p.id, now, policy.ownStockMaxAgeDays);
          const fresh = verifiedAt[p.id] && now - Date.parse(verifiedAt[p.id]) <= policy.ownStockConflictPriceMaxAgeDays * DAY;
          if (own && fresh && hasVerifiedPrice(p)) {
            p.next[3] = pricing.discount + "%"; p.next[4] = "+"; p.next[5] = own.qty; p.next[6] = STATUS_OWN_STOCK;
            p.match = STATUS_OWN_STOCK; sale = "OWN_STOCK";
          } else {
            p.next[3] = ""; p.next[4] = "-"; p.next[5] = "";
          }
        } else sale = "BLOCKS_FEED";
        const prev = prevConflicts[p.id];
        conflicts[p.id] = { since: prev?.since || stamp, reason, sale, lastSeen: stamp };
        if (!prev || prev.reason !== reason) {
          if (!prev) newlyConflicted.push(p.id);
          events.push({ at: stamp, event: prev ? "CHANGED" : "OPENED", offerId: p.id, reason, previousReason: prev?.reason || null, sale, ...conflictValues(row, p, offer, verifiedAt[p.id]) });
        }
      }
      if (prevMissing[p.id] && p.match === MATCH.OK) returned.push({ id: p.id, since: prevMissing[p.id].since });
      if (prevConflicts[p.id] && !conflicts[p.id]) {
        events.push({ at: stamp, event: "RESOLVED", offerId: p.id, reason: prevConflicts[p.id].reason, since: prevConflicts[p.id].since, now: p.match });
      }
    });
  }
  const limit = Math.max(policy.anomaly.maxNewlyMissing, Math.ceil(total * policy.anomaly.maxNewlyMissingRatio));
  const newlyIsolated = newlyMissing.length + newlyConflicted.length;
  return {
    missing, conflicts, verifiedAt, returned, newlyMissing, newlyConflicted, proposals, events,
    anomaly: newlyIsolated > limit ? { newlyMissing: newlyMissing.length, newlyConflicted: newlyConflicted.length, limit } : null,
  };
}
