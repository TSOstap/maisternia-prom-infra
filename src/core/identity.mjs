/** Стабільна ідентичність картки незалежно від Offer ID постачальника (рішення D1, п. 4–7).
 *
 *  Наша картка має стабільний «Offer ID». Прив'язка до постачальника — окремий реєстр links:
 *    cards[offerId] = { supplierId, since, history: [{ supplierId, from, until, reason }] }
 *    retired[supplierId] = offerId   — усі колишні ID постачальника → наша картка (п. 7)
 *  Незмінні колонки рядка (у т.ч. «ID постачальника») НЕ переписуються: печатки й погоджений контент лишаються.
 *
 *  Класи збігу:
 *   STRONG  — новий offer проходить ту саму перевірку ідентичності, що й mtMatch:
 *             точний артикул (mtSku) + усі збережені опорні назви UA/RU (mtKey); бренд не суперечить.
 *             Або валідний GTIN + той самий бренд + без конфлікту комплектації.
 *   MEDIUM  — артикул збігається лише після послабленої нормалізації, або бренд+модель, або slug URL,
 *             або однаковий артикул із різними назвами. Ніколи не застосовується автоматично.
 *   CONFLICT — ознаки різних комплектацій/модифікацій (кількість/ємність АКБ, «без АКБ», напруга, потужність, к-сть шт.).
 *  Рішення: RELINK (рівно один STRONG кандидат-сирота, жодного іншого кандидата, offer не претендує на іншу картку)
 *           MANUAL_REVIEW (будь-яка неоднозначність) · NEW (кандидатів немає). */
import { mtKey, mtSku, mtText } from "./text.mjs";

export const looseSku = (v) => mtSku(v).toUpperCase().replace(/[\s\-./_\\]/g, "");
/** Синоніми написання одного бренду (погоджено власником 22.10.2026; аудит 60 розбіжностей «Виробник» ↔ vendor).
 *  Лише для ПОРІВНЯННЯ брендів (ідентичність, звірки) — картки, таблиця та фід не змінюються.
 *  Ключ — нормалізоване написання-варіант, значення — канонічний ключ. Додавати лише підтверджені варіанти:
 *  Titan/Титан і SEVER/Север свідомо не додано (лише маркетплейси, без офіційного джерела). */
export const BRAND_SYNONYMS = Object.freeze({
  "felső": "felso",               // основне написання — Felso (сайт бренду)
  "kärcher": "karcher",           // Kärcher = Karcher (kaercher.com)
  "kentavr": "кентавр",           // Кентавр = Kentavr (kentavr.ua)
  "фиолент": "phiolent",          // Phiolent = Фиолент
  "makitacorporation": "makita",  // юрособа-виробник, бренд — Makita
});
const brandBase = (v) => mtText(v).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export const brandKey = (v) => { const k = brandBase(v); return BRAND_SYNONYMS[k] ?? k; };
export const modelKey = (v) => mtText(v).normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Slug сторінки постачальника без ID: https://…/p1500000001-tovar-test.html → tovar-test */
export function urlSlug(url) {
  const m = /\/p\d+-([^/?#]+?)(?:\.html)?(?:[?#].*)?$/.exec(mtText(url));
  return m ? m[1].toLowerCase() : "";
}

/** GTIN-8/12/13/14 з контрольною цифрою. */
export function validGtin(v) {
  const s = mtText(v).replace(/\s/g, "");
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(s) || /^0+$/.test(s)) return "";
  const digits = s.split("").map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check ? s : "";
}

/** Ознаки комплектації/модифікації з назви. Порівнюються лише якщо є в ОБОХ назвах. */
export function kitSignature(name) {
  const s = mtText(name).normalize("NFKC").toLowerCase().replace(/,/g, ".");
  const pick = (re) => [...new Set([...s.matchAll(re)].map((m) => m[1].replace(/\s+/g, "")))].sort().join("|");
  // Межа слова з урахуванням кирилиці (JS \b — лише ASCII).
  const E = "(?![\\p{L}\\p{N}])";
  const S = "(?<![\\p{L}\\p{N}])";
  const re = (src) => new RegExp(src, "gu");
  return {
    ah: pick(re(`(\\d+(?:\\.\\d+)?)\\s*(?:а·?г|ач|ah|аh)${E}`)),
    batteries: pick(re(`${S}(\\d+)\\s*(?:x|х|×)?\\s*(?:акб|акумулятор\\p{L}*|аккумулятор\\p{L}*|батаре\\p{L}*)`)),
    solo: new RegExp(`без\\s+(?:акб|акумулятор|аккумулятор|з/п|зарядн)|${S}(?:solo|body)${E}|каркас`, "u").test(s) ? "solo" : "",
    volts: pick(re(`${S}(\\d+(?:\\.\\d+)?)\\s*(?:в|v)${E}`)),
    watts: pick(re(`${S}(\\d+(?:\\.\\d+)?)\\s*(?:вт|квт|w|kw)${E}`)),
    pieces: pick(re(`${S}(\\d+)\\s*(?:шт|pcs|предмет\\p{L}*|од\\.)`)),
  };
}
export function kitConflict(a, b) {
  const x = kitSignature(a);
  const y = kitSignature(b);
  const diff = [];
  for (const k of Object.keys(x)) if (x[k] && y[k] && x[k] !== y[k]) diff.push(k);
  if (Boolean(x.solo) !== Boolean(y.solo) && (x.ah || y.ah || x.batteries || y.batteries)) diff.push("solo");
  return diff;
}

/** Картка каталогу → ключі зіставлення. */
export function cardKeys(row) {
  return {
    offerId: mtText(row["Offer ID"]),
    supplierId: mtText(row["ID постачальника"]),
    sku: mtSku(row["Артикул постачальника"]),
    skuLoose: looseSku(row["Артикул постачальника"]),
    brand: brandKey(row["Виробник"]),
    model: modelKey(row["Модель"]),
    gtin: validGtin(row["GTIN"]),
    nameUa: mtText(row["Назва постачальника UA"]),
    nameRu: mtText(row["Назва постачальника RU"]),
    slug: urlSlug(row["URL постачальника"]),
  };
}

/** Offer постачальника → ключі (vendor/model/gtin можуть бути відсутні в операційному фіді). */
export function offerKeys(o) {
  return {
    id: mtText(o.id), sku: mtSku(o.sku), skuLoose: looseSku(o.sku), brand: brandKey(o.vendor), model: modelKey(o.model),
    gtin: validGtin(o.gtin), nameUa: mtText(o.nameUa), nameRu: mtText(o.nameRu), slug: urlSlug(o.url),
  };
}

export function buildIndex(cards) {
  const by = { sku: new Map(), skuLoose: new Map(), gtin: new Map(), brandModel: new Map(), slug: new Map() };
  const add = (map, key, card) => { if (key) map.set(key, [...(map.get(key) || []), card]); };
  for (const c of cards) {
    add(by.sku, c.sku, c);
    add(by.skuLoose, c.skuLoose, c);
    add(by.gtin, c.gtin, c);
    if (c.brand && c.model) add(by.brandModel, c.brand + "|" + c.model, c);
    add(by.slug, c.slug, c);
  }
  return by;
}

/** Порівняння одного offer з однією карткою. */
export function compare(card, offer) {
  const evidence = [];
  const brandConflict = Boolean(card.brand && offer.brand && card.brand !== offer.brand);
  const conflicts = [...kitConflict(card.nameUa, offer.nameUa), ...kitConflict(card.nameRu, offer.nameRu)];
  if (brandConflict) conflicts.push("brand");
  const refNames = [[card.nameUa, offer.nameUa], [card.nameRu, offer.nameRu]].filter(([c]) => c);
  const namesEqual = refNames.length > 0 && refNames.every(([c, o]) => o && mtKey(c) === mtKey(o));
  if (card.sku && card.sku === offer.sku) evidence.push("sku");
  else if (card.skuLoose && card.skuLoose === offer.skuLoose) evidence.push("sku-loose");
  if (card.gtin && card.gtin === offer.gtin) evidence.push("gtin");
  if (card.brand && card.model && card.brand === offer.brand && card.model === offer.model) evidence.push("brand+model");
  if (card.slug && card.slug === offer.slug) evidence.push("slug");
  if (namesEqual) evidence.push("names");
  let level = "NONE";
  const unique = conflicts.length === 0;
  if (unique && evidence.includes("sku") && namesEqual) level = "STRONG";
  else if (unique && evidence.includes("gtin") && card.brand && card.brand === offer.brand) level = "STRONG";
  else if (evidence.length) level = conflicts.length ? "CONFLICT" : "MEDIUM";
  return { offerId: card.offerId, level, evidence, conflicts: [...new Set(conflicts)] };
}

/**
 * Пакетне розв'язання: невідомі offers (ID не прив'язаний до жодної картки) проти карток.
 * orphanIds — картки, чий поточний ID постачальника відсутній у повному фіді (кандидати на перев'язку).
 * Повертає рішення для кожного offer; RELINK лише якщо картка-сирота й претендент взаємно однозначні.
 */
export function resolveUnknownOffers({ offers, cards, orphanIds }) {
  const index = buildIndex(cards);
  const byId = new Map(cards.map((c) => [c.offerId, c]));
  const decisions = offers.map((raw) => {
    const offer = offerKeys(raw);
    const pool = new Map();
    for (const list of [index.sku.get(offer.sku), index.skuLoose.get(offer.skuLoose), index.gtin.get(offer.gtin), index.brandModel.get(offer.brand + "|" + offer.model), index.slug.get(offer.slug)]) {
      for (const c of list || []) pool.set(c.offerId, c);
    }
    const candidates = [...pool.values()].map((c) => ({ ...compare(c, offer), orphan: orphanIds.has(c.offerId) })).filter((c) => c.level !== "NONE");
    return { offer, candidates };
  });
  // Скільки STRONG-претендентів має кожна картка-сирота (два нових offer на одну картку — неоднозначно).
  const claims = new Map();
  for (const d of decisions) for (const c of d.candidates) if (c.level === "STRONG" && c.orphan) claims.set(c.offerId, (claims.get(c.offerId) || 0) + 1);
  return decisions.map(({ offer, candidates }) => {
    const strong = candidates.filter((c) => c.level === "STRONG");
    // Блокують перев'язку лише суперники, яких не відрізнити: ті самі опорні назви або той самий GTIN.
    // Той самий артикул з ІНШИМИ назвами — інший товар (реальний приклад: в постачальника один артикул має і бур, і бензопила).
    // Спільний slug чи бренд+модель — масові ознаки (сотні груп у реальному каталозі), лише інформація.
    const IDENTIFYING = ["gtin", "names"];
    const others = candidates.filter((c) => c.level !== "STRONG" && c.evidence.some((e) => IDENTIFYING.includes(e)));
    let decision = "NEW";
    let target = null;
    let reason = "кандидатів немає";
    if (candidates.length) {
      decision = "MANUAL_REVIEW";
      if (strong.length === 1 && others.length === 0 && strong[0].orphan && claims.get(strong[0].offerId) === 1) {
        decision = "RELINK"; target = strong[0].offerId; reason = "єдиний STRONG-збіг з карткою, чий ID зник із повного фіду";
      } else if (strong.length === 1 && !strong[0].orphan) reason = "збіг із карткою, що досі жива у фіді (можливий дубль у постачальника)";
      else if (strong.length > 1) reason = "кілька STRONG-кандидатів";
      else if (strong.length === 1) reason = claims.get(strong[0].offerId) > 1 ? "кілька нових offer претендують на одну картку" : "є додаткові слабші кандидати";
      else reason = candidates.some((c) => c.level === "CONFLICT") ? "збіг ключів із конфліктом комплектації/бренду" : "лише слабкі ознаки (послаблений артикул, модель, slug)";
    }
    return { offerId: offer.id, decision, target, reason, candidates: candidates.map((c) => ({ ...c, card: byId.get(c.offerId)?.supplierId })) };
  });
}

/** Реєстр прив'язок: поточний ID постачальника для картки (за замовчуванням — з незмінної колонки). */
export function effectiveSupplierId(links, row) {
  return links?.cards?.[mtText(row["Offer ID"])]?.supplierId || mtText(row["ID постачальника"]);
}

/** Застосувати перев'язку з історією (п. 5, 7). Чиста функція: повертає новий реєстр. */
export function applyRelink(links, { offerId, fromSupplierId, toSupplierId, at, reason }) {
  const next = { kind: "SUPPLIER_LINKS_V1", cards: { ...(links?.cards || {}) }, retired: { ...(links?.retired || {}) } };
  const prev = next.cards[offerId] || { supplierId: fromSupplierId, since: null, history: [] };
  if (Object.entries(next.cards).some(([id, c]) => id !== offerId && c.supplierId === toSupplierId)) throw new Error("ID постачальника вже прив'язаний до іншої картки: " + toSupplierId);
  next.cards[offerId] = {
    supplierId: toSupplierId, since: at,
    history: [...(prev.history || []), { supplierId: prev.supplierId || fromSupplierId, from: prev.since, until: at, reason }],
  };
  next.retired[prev.supplierId || fromSupplierId] = offerId;
  return next;
}
