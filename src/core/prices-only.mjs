/** «Оновити ціни й наявність» (рішення власника 03.11.2026: спершу ручна кнопка, розклад кожні 2 год — після підключення Prom).
 *  Чиста функція плану — без мережі й запису.
 *
 *  Лише 8 операційних колонок «Основного каталогу» (LIVE_COLUMNS) за чинними правилами цін і наявності (planRows — точний порт mtPlan
 *  LIVE) з ОПЕРАЦІЙНОГО фіду постачальника. Усе інше — назви, фото, характеристики, присутність у фіді, попередження постачальника —
 *  лише «Оновити товари». Тому рядок НЕ змінюється, якщо:
 *   • товар видалено (Catalog Controls) або «ВИДАЛЕНИЙ_У_ПОСТАЧАЛЬНИКА» (повернення оформлює «Оновити товари»);
 *   • товару немає у фіді (присутність і пороги зникнення — лише «Оновити товари»);
 *   • дані постачальника не збігаються з карткою (змінились назва / артикул тощо — їх приймає «Оновити товари», потім ціни).
 *  «Оновлено» змінюється лише в рядках, де змінилась ціна, наявність, кількість або стан синхронізації. Масова зміна наявності понад
 *  поріг (як у синхронізації: більший із 50 товарів і 2 % каталогу) — нічого не пишемо. */
import { mtText } from "./text.mjs";
import { LIVE_COLUMNS, MATCH, planRows, readSheet, changeEntries } from "./sync-plan.mjs";
import { PRESENCE, PRESENCE_COLUMN } from "./supplier-presence.mjs";
import { OWNER_AVAILABILITY_COLUMN, effectiveAvailability } from "./owner-availability.mjs";
import { MANUAL_PRICE_COLUMN, MANUAL_ANCHOR_COLUMN, ownerCost } from "./pricing.mjs";

export const MAIN_TITLE = "Основний каталог";
/** Рішення власника 16.11 («так давай»): «Дроп-ціна» перед «Ціна постачальника» — дроп з Excel Хорошопу для зіставлених товарів, для решти
 *  порожньо. Пише лише «Оновити ціни й наявність» (не LIVE-колонка, у фід не йде, у «Журнал» не пишеться — довідкова). Немає колонки в
 *  таблиці — не пишеться (порядок «деплой → вставка колонки» безпечний). */
export const DROP_COLUMN = "Дроп-ціна";
const STAMP_COL = LIVE_COLUMNS.indexOf("Оновлено");
const COST = LIVE_COLUMNS.indexOf("Ціна постачальника");
export const PRICES_SKIP = Object.freeze({ REMOVED: "REMOVED", GONE: "GONE", MISSING: "MISSING", MISMATCH: "MISMATCH" });

/**
 * values — «Основний каталог» (2D, перший рядок — заголовок); offers — Map ID постачальника → offer (parseSupplierText);
 * removed — Set Offer ID, видалених через Catalog Controls. → { abort?, rows, plan, changed: [індекси], journal, stats }.
 */
export function planPrices({ values, offers, stamp, pricing, removed = new Set(), anomaly = { maxNewlyMissing: 50, maxNewlyMissingRatio: 0.02 } }) {
  const main = readSheet(values, MAIN_TITLE);
  const hasDrop = main.header.map((h) => mtText(h).trim()).includes(DROP_COLUMN);
  const offerOf = offers instanceof Map ? (sid) => offers.get(sid) : (sid) => offers[sid];
  const skipped = { removed: 0, gone: 0, missing: 0, mismatch: {} };
  // Рішення власника 16.11 (№ 63): «Ціна власника» — постійна (не очищується); «Ціна вручну» — поки РРЦ та сама (якір пишуть «Ціни»).
  const plan = planRows(main.rows, offers, stamp, pricing).map((p, i) => {
    const keep = (why) => ({ ...p, next: p.before.slice(), skip: why });
    if (removed.has(p.id)) { skipped.removed++; return keep(PRICES_SKIP.REMOVED); }
    if (mtText(main.rows[i][PRESENCE_COLUMN]).trim() === PRESENCE.GONE) { skipped.gone++; return keep(PRICES_SKIP.GONE); }
    if (p.match === MATCH.MISSING) { skipped.missing++; return keep(PRICES_SKIP.MISSING); }
    if (p.match !== MATCH.OK) { skipped.mismatch[p.match] = (skipped.mismatch[p.match] || 0) + 1; return keep(PRICES_SKIP.MISMATCH); }
    // Рішення власника 14.11: «Наявність власника» (ту саму ефективну наявність уже порахував planRows); постачальник оновив наявність
    // (стала як у клітинці власника) — клітинку власника очистити.
    const row = main.rows[i], offer = offerOf(mtText(row["ID постачальника"]));
    const owner = effectiveAvailability(row, offer.available);
    const clearOwner = owner.clear ? { before: mtText(row[OWNER_AVAILABILITY_COLUMN]) } : null;
    // № 63: «Ціна вручну» — нова (якоря немає): записати якір = поточна РРЦ; РРЦ змінилась відносно якоря — очистити ціну й якір.
    const manual = p.rule?.anchor === "set" ? { set: offer.price, before: { [MANUAL_ANCHOR_COLUMN]: mtText(row[MANUAL_ANCHOR_COLUMN]) } }
      : p.rule?.anchor === "stale" ? { clear: true, before: { [MANUAL_PRICE_COLUMN]: mtText(row[MANUAL_PRICE_COLUMN]), [MANUAL_ANCHOR_COLUMN]: mtText(row[MANUAL_ANCHOR_COLUMN]) } } : null;
    // № 63: «Ціна власника» заповнена, а постачальник змінив РРЦ — попередження власнику (ціна власника лишається).
    // «Дроп-ціна»: дроп Excel (лише пара з Хорошопу), інакше порожньо; пишеться, коли відрізняється від таблиці.
    const dropNext = offer.source === "horoshop" && Number.isFinite(offer.drop) ? offer.drop : "";
    const dropBefore = mtText(row[DROP_COLUMN]).trim(), dropSame = dropNext === "" ? dropBefore === "" : Math.abs(Number(dropBefore.replace(",", ".")) - dropNext) < 0.005 && dropBefore !== "";
    const drop = hasDrop && !dropSame ? { before: mtText(row[DROP_COLUMN]), next: dropNext } : null;
    const own = ownerCost(row), from = Number(mtText(p.before[COST]).replace(",", ".")), to = Number(mtText(p.next[COST]).replace(",", "."));
    const ownerRrp = own != null && from > 0 && to > 0 && Math.abs(from - to) > 0.005 ? { from, to, own, applied: p.rule?.kind === "owner" } : null;
    // «Оновлено» — лише разом зі справжньою зміною.
    const real = p.before.some((v, j) => j !== STAMP_COL && mtText(v) !== mtText(p.next[j]));
    return { ...(real ? p : { ...p, next: p.before.slice() }), ownerRule: owner.rule, clearOwner, manual, ownerRrp, drop, ruleKind: p.rule?.kind ?? null };
  });
  const changed = plan.map((p, i) => (p.clearOwner || p.manual || p.drop || p.before.some((v, j) => mtText(v) !== mtText(p.next[j])) ? i : -1)).filter((i) => i >= 0);
  const diff = (k) => { const j = LIVE_COLUMNS.indexOf(k); return plan.filter((p) => mtText(p.before[j]) !== mtText(p.next[j])).length; };
  const becameAvailable = plan.filter((p) => p.before[4] !== "+" && p.next[4] === "+").length;
  const becameUnavailable = plan.filter((p) => p.before[4] === "+" && p.next[4] !== "+").length;
  // Рішення власника 16.11: велика зміна ціни постачальника (більш ніж удвічі) не блокує запис — лише список у підсумку («перевірте»).
  const big = plan.filter((p) => !p.skip).map((p) => ({ id: p.id, from: Number(mtText(p.before[COST]).replace(",", ".")), to: Number(mtText(p.next[COST]).replace(",", ".")) }))
    .filter((x) => x.from > 0 && x.to > 0 && (x.to / x.from < 0.5 || x.to / x.from > 2));
  const stats = {
    rows: main.rows.length, changedProducts: changed.length,
    supplierPriceChanged: diff("Ціна постачальника"), salePriceChanged: diff("Ціна кінцева"), availabilityChanged: diff("Наявність"),
    becameAvailable, becameUnavailable, quantityChanged: diff("Кількість постачальника"), skipped,
    bigPriceChanges: big.length, bigPriceList: big.slice(0, 20), dropChanged: plan.filter((p) => p.drop).length,
    // «Наявність власника»: діє (наявність власника замість постачальника) / очищується (постачальник оновив наявність).
    ownerAvailability: { active: plan.filter((p) => p.ownerRule === "owner").length, cleared: plan.filter((p) => p.clearOwner).length },
    // № 63: «Ціна власника» — діє (постійна) / постачальник змінив РРЦ (попередження); «Ціна вручну» — діє / нова (записано якір) / знято.
    ownerPrice: { active: plan.filter((p) => !p.skip && p.ruleKind === "owner").length, rrpChanged: plan.filter((p) => p.ownerRrp).length, rrpList: plan.filter((p) => p.ownerRrp).slice(0, 20).map((p) => ({ id: p.id, ...p.ownerRrp })) },
    manualPrice: { active: plan.filter((p) => !p.skip && p.ruleKind === "manual").length, anchored: plan.filter((p) => p.manual?.set != null).length, cleared: plan.filter((p) => p.manual?.clear).length },
  };
  const limit = Math.max(anomaly.maxNewlyMissing, Math.ceil(main.rows.length * anomaly.maxNewlyMissingRatio));
  const mass = becameUnavailable > limit ? `«немає в наявності» стало б ${becameUnavailable} товарів (поріг ${limit})` : becameAvailable > limit ? `«в наявності» стало б ${becameAvailable} товарів (поріг ${limit})` : "";
  if (mass) return { abort: { type: "МАСОВА ЗМІНА НАЯВНОСТІ", reason: mass + " — схоже на помилку у фіді постачальника; нічого не записано", affected: String(Math.max(becameAvailable, becameUnavailable)), limit: String(limit) }, stats };
  // Події «Журналу» — як у mtUpdate: лише змінені колонки F:K (без «ПОМИЛКА»: незіставлені рядки ця операція не чіпає).
  const journal = changeEntries(stamp, MAIN_TITLE, changed.map((i) => plan[i]));
  for (const i of changed) if (plan[i].clearOwner) journal.push([stamp, MAIN_TITLE, plan[i].id, OWNER_AVAILABILITY_COLUMN, plan[i].clearOwner.before, "", plan[i].match]);
  for (const i of changed) {
    const m = plan[i].manual;
    if (m?.set != null) journal.push([stamp, MAIN_TITLE, plan[i].id, MANUAL_ANCHOR_COLUMN, m.before[MANUAL_ANCHOR_COLUMN], String(m.set), plan[i].match]);
    if (m?.clear) for (const k of [MANUAL_PRICE_COLUMN, MANUAL_ANCHOR_COLUMN]) journal.push([stamp, MAIN_TITLE, plan[i].id, k, m.before[k], "", plan[i].match]);
  }
  return { header: main.header, rows: main.rows, plan, changed, journal, stats };
}
