/** S1: перевірка «можливий дубль» для нової позиції постачальника (погоджено власником 22.10.2026).
 *
 *  Лише ІНФОРМАЦІЯ для рішення власника — жодних автоматичних прив'язок чи відхилень.
 *  Ознаки: артикул, назви постачальника, бренд+модель, slug сторінки, ФОТО (номери зображень images.prom.ua),
 *  КОМПЛЕКТАЦІЯ (з назв і з характеристик: к-сть і ємність АКБ, «без АКБ», зарядний, кейс, напруга, потужність).
 *  На реальних даних 5027 із 5029 карток мають усі фото спільні зі «своєю» позицією постачальника — сильна ознака,
 *  але не остаточна: постачальник може замінити фото. */
import { mtKey, mtSku, mtText } from "./text.mjs";
import { kitConflict, kitSignature, looseSku, brandKey, modelKey, urlSlug } from "./identity.mjs";

const KIT_LABEL = { ah: "ємність АКБ", batteries: "кількість АКБ", solo: "з АКБ / без АКБ", volts: "напруга", watts: "потужність", pieces: "кількість у наборі", charger: "зарядний пристрій", case: "кейс" };

/** Номер зображення Prom (https://images.prom.ua/123456789_назва.jpg → 123456789); інакше — весь URL. */
export const photoKey = (u) => (/images\.prom\.ua\/(\d+)_/.exec(mtText(u)) || [])[1] || mtText(u).trim();
export function photoKeys(list) {
  let a = list;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = []; } }
  return new Set((Array.isArray(a) ? a : []).filter((u) => typeof u === "string" && u.trim()).map(photoKey));
}
const shortPhoto = (k) => (k.length > 4 ? "…" + k.slice(-4) : k);

/** Комплектація з характеристик (якщо є в обох — порівнюється). */
export function kitFromParams(params) {
  let p = params;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = []; } }
  const out = {};
  for (const x of Array.isArray(p) ? p : []) {
    const n = mtText(x?.name).toLowerCase(), v = mtText(x?.value).toLowerCase().replace(/,/g, ".").trim();
    if (!n || !v) continue;
    if (/(акб|акумулятор|аккумулятор|батаре)/.test(n) && /(кількість|количество|к-сть|кол-во|в комплекті|в комплекте)/.test(n)) out.batteries = (v.match(/\d+/) || [v])[0];
    else if (/(ємність|емкость)/.test(n) && /(акб|акумулятор|аккумулятор|батаре)/.test(n)) out.ah = (v.match(/\d+(?:\.\d+)?/) || [v])[0];
    else if (/(зарядн)/.test(n)) out.charger = /^(так|да|є|есть|в комплекті|в комплекте|yes|\+)/.test(v) ? "є" : /^(ні|нет|немає|отсутствует|no|-)/.test(v) ? "немає" : v;
    else if (/(кейс|валіз|чемодан)/.test(n)) out.case = /^(так|да|є|есть|в комплекті|в комплекте|yes|\+)/.test(v) ? "є" : /^(ні|нет|немає|no|-)/.test(v) ? "немає" : v;
    else if (/(комплектац|комплект поставки)/.test(n)) out.set = v.replace(/\s+/g, " ");
  }
  return out;
}
/** Відмінності комплектації: з назв (kitConflict) + з характеристик. */
export function kitDifferences(a, b) {
  const diff = new Set([...kitConflict(a.nameUa, b.nameUa), ...kitConflict(a.nameRu, b.nameRu)]);
  const pa = kitFromParams(a.params), pb = kitFromParams(b.params);
  for (const k of ["batteries", "ah", "charger", "case", "set"]) if (pa[k] && pb[k] && pa[k] !== pb[k]) diff.add(k === "set" ? "pieces" : k);
  return [...diff].map((k) => KIT_LABEL[k] || k);
}

/** Картка/рядок каталогу або нова позиція → ознаки для порівняння. */
export function entryKeys(e) {
  return {
    id: mtText(e.id), sheet: e.sheet || "", sku: mtSku(e.sku), skuLoose: looseSku(e.sku), brand: brandKey(e.vendor), model: modelKey(e.model),
    nameUa: mtText(e.nameUa), nameRu: mtText(e.nameRu), nameKeyUa: mtKey(e.nameUa), nameKeyRu: mtKey(e.nameRu), slug: urlSlug(e.url),
    photos: photoKeys(e.photos), params: e.params || [], orphan: Boolean(e.orphan), frozen: Boolean(e.frozen),
  };
}
export function rowEntry(row, sheet, { orphan = false } = {}) {
  return entryKeys({
    id: row["Offer ID"], sheet, sku: row["Артикул постачальника"], vendor: row["Виробник"], model: row["Модель"],
    nameUa: row["Назва постачальника UA"], nameRu: row["Назва постачальника RU"], url: row["URL постачальника"],
    photos: row["Фото JSON"], params: row["Характеристики JSON"], orphan,
  });
}

/** Індекс карток за всіма ознаками, що можуть вказати на той самий товар. */
export function buildDupIndex(entries) {
  const idx = new Map();
  const add = (k, e) => { if (!k) return; const l = idx.get(k); if (l) l.push(e); else idx.set(k, [e]); };
  for (const e of entries) {
    add("sku:" + e.sku, e); add("skul:" + e.skuLoose, e);
    if (e.brand && e.model) add("bm:" + e.brand + "|" + e.model, e);
    add("slug:" + e.slug, e); add("nu:" + e.nameKeyUa, e); add("nr:" + e.nameKeyRu, e);
    for (const p of e.photos) add("ph:" + p, e);
  }
  return idx;
}

/** Порівняння нової позиції з однією карткою: ознаки, фото, комплектація, оцінка. */
export function compareEntries(card, offer) {
  const evidence = [];
  if (card.sku && card.sku === offer.sku) evidence.push("артикул");
  else if (card.skuLoose && card.skuLoose === offer.skuLoose) evidence.push("артикул (без розділювачів)");
  if (card.nameKeyUa && card.nameKeyUa === offer.nameKeyUa) evidence.push("назва UA");
  if (card.nameKeyRu && card.nameKeyRu === offer.nameKeyRu) evidence.push("назва RU");
  if (card.brand && card.model && card.brand === offer.brand && card.model === offer.model) evidence.push("бренд+модель");
  if (card.slug && card.slug === offer.slug) evidence.push("сторінка постачальника");
  const shared = [...card.photos].filter((p) => offer.photos.has(p));
  const photo = { shared: shared.length, card: card.photos.size, offer: offer.photos.size, cardSample: shortPhoto([...card.photos][0] || ""), offerSample: shortPhoto([...offer.photos][0] || "") };
  if (shared.length) evidence.push("фото");
  const kit = kitDifferences(card, offer);
  const brandConflict = Boolean(card.brand && offer.brand && card.brand !== offer.brand);
  const namesBoth = evidence.includes("назва UA") && evidence.includes("назва RU");
  const allPhotos = photo.shared > 0 && photo.shared === Math.min(photo.card, photo.offer);
  // «Ймовірно той самий»: (артикул + обидві назви) або (усі фото спільні + назва/артикул), без різниці комплектації й бренду.
  let level = "СХОЖИЙ";
  if (kit.length || brandConflict) level = "ІНША КОМПЛЕКТАЦІЯ / МОДИФІКАЦІЯ?";
  else if ((evidence.includes("артикул") && namesBoth) || (allPhotos && (evidence.includes("артикул") || evidence.some((e) => e.startsWith("назва"))))) level = "ЙМОВІРНО ТОЙ САМИЙ";
  const score = (level === "ЙМОВІРНО ТОЙ САМИЙ" ? 100 : 0) + evidence.length * 10 + photo.shared + (card.sheet === "Основний каталог" ? 5 : 0) + (card.orphan ? 3 : 0);
  return { id: card.id, sheet: card.sheet, orphan: card.orphan, evidence, photo, kit, brandConflict, level, score };
}

/** Кандидати для нової позиції (до max), найсхожіші першими. */
export function findDuplicates(index, offer, { max = 3 } = {}) {
  const pool = new Map();
  const keys = ["sku:" + offer.sku, "skul:" + offer.skuLoose, offer.brand && offer.model ? "bm:" + offer.brand + "|" + offer.model : "", "slug:" + offer.slug, "nu:" + offer.nameKeyUa, "nr:" + offer.nameKeyRu, ...[...offer.photos].map((p) => "ph:" + p)];
  for (const k of keys) for (const c of (k && !/:$/.test(k) ? index.get(k) : null) || []) if (c.id !== offer.id) pool.set(c.id + "|" + c.sheet, c);
  // Збіг лише за сторінкою постачальника — занадто слабкий (на реальних даних це спільні slug різних моделей лінійки).
  return [...pool.values()].map((c) => compareEntries(c, offer)).filter((r) => r.evidence.some((e) => e !== "сторінка постачальника")).sort((a, b) => b.score - a.score).slice(0, max);
}

/** Текст для колонки «Перевірка». */
export function dupNote(cands, { frozen = false } = {}) {
  if (!cands.length) return "";
  const parts = cands.map((c) => {
    const ph = c.photo.card && c.photo.offer
      ? (c.photo.shared ? `фото: спільних ${c.photo.shared} з ${Math.min(c.photo.card, c.photo.offer)}` : `фото РІЗНІ (у картки ${c.photo.cardSample}, у нової ${c.photo.offerSample}) — можливо інший товар або постачальник замінив фото`)
      : "фото: немає для порівняння";
    return `${c.id} («${c.sheet}»${c.orphan ? ", зник із фіду" : ""}) — ${c.level}; збіг: ${c.evidence.join(", ") || "—"}; ${ph}${c.kit.length ? `; різниця комплектації: ${c.kit.join(", ")}` : ""}${c.brandConflict ? "; різний бренд" : ""}`;
  });
  const best = cands[0];
  const hint = best.sheet === "Основний каталог" && best.level === "ЙМОВІРНО ТОЙ САМИЙ" ? ` Якщо це той самий товар — «ПРИВ'ЯЗАТИ ДО ${best.id}».` : "";
  // Лише інші позиції черги — м'якша позначка: дубля в Prom ще немає.
  const label = cands.some((c) => c.sheet !== "Нові товари") ? "МОЖЛИВИЙ ДУБЛЬ" : "СХОЖІ ПОЗИЦІЇ В ЧЕРЗІ";
  return `${label}${frozen ? " (ID у «Заморожених ID»)" : ""}: ${parts.join(" | ")}.${hint}`;
}
export { shortPhoto };
