/** Зіставлення характеристик постачальника з полями категорії Prom (погоджено власником 23.10.2026). Чисті функції.
 *
 *  Пріоритет: 1) структуровані <param> XML постачальника; 2) пари «назва — значення» з опису постачальника;
 *  3) наші ручні виправлення — мають перевагу над будь-яким автоматичним значенням.
 *  Поле Prom заповнюється лише при підтвердженій відповідності: назва (точна назва атрибута ЦІЄЇ категорії або
 *  погоджений синонім), тип, одиниця (точна або погоджений перерахунок), діапазон min/max, допустимий варіант значення.
 *  Схожості назв недостатньо. Неоднозначність / конфлікт / непідтримуване значення — поле не заповнюється.
 *  Уточнення власника 23.10.2026 (друге):
 *   - характеристика без атрибута категорії передається як користувацька (дослівно); назва, що збігається з атрибутом
 *     категорії, але значення не пройшло перевірку, користувацькою не передається (не видаємо за стандартну) — лишається
 *     в сирих даних і звіті (rawOnly) з причиною;
 *   - поле категорії — завжди українські назва / одиниця / значення зі схеми (Prom показує nameRU сам; окремих YML-тегів
 *     для мов характеристик документація не описує);
 *   - кілька значень (multiselect) — допустимі варіанти через « | » (документація Prom: «GSM | CDMA»);
 *   - смислові дублі (той самий атрибут, сумісні одиниці, еквівалентні значення) об'єднуються; ручні не видаляються;
 *   - понад MAX_PARAMS — не додається, перелік в overflow.
 *
 *  Походження кожної характеристики — у «Походження характеристик JSON»:
 *   { v, cat, items: [{ k, s, a }], x: [приховані власником], notes }  (k — ключ запису, s — джерело, a — id атрибута Prom). */
import { mtDecode, mtText } from "./text.mjs";

export const SRC = Object.freeze({ XML: "XML", DESC: "ОПИС", RAW: "XML БЕЗ ЗІСТАВЛЕННЯ", MANUAL: "ВРУЧНУ", UNKNOWN: "НЕВІДОМО" });
const AUTO = new Set([SRC.XML, SRC.DESC, SRC.RAW]);
export const MAX_PARAMS = 100;
const FREE_MAX = 255; // власний запобіжник для типу free (ліміт Prom не підтверджено)

export const normName = (s) => mtText(s).toLowerCase().replace(/ё/g, "е").replace(/[’ʼ`´]/g, "'").replace(/\s+/g, " ").trim().replace(/[\s:.]+$/, "");
export const normUnit = (s) => mtText(s).toLowerCase().replace(/[\s.·]/g, "");
export const itemKey = (p) => [mtText(p?.name).trim(), mtText(p?.value).trim(), mtText(p?.unit).trim()].join("\u0001");

const NUM_RE = /^([-+]?\d{1,3}(?:[  ]\d{3})+|[-+]?\d+)(?:[.,](\d+))?$/;
/** Одне число («1 200», «2,5», «2.5»); діапазони, кілька чисел, текст — null. */
export function parseNumber(s) {
  const m = NUM_RE.exec(mtText(s).trim());
  return m ? Number(m[1].replace(/[  ]/g, "") + (m[2] ? "." + m[2] : "")) : null;
}
/** «36 мес.» → { num: "36", unit: "мес." }; без одиниці або не число — null. */
function splitValueUnit(v) {
  const m = /^([-+]?[\d  ]*\d(?:[.,]\d+)?)\s*([^\d\s][^\d]*)$/.exec(mtText(v).trim());
  return m ? { num: m[1].trim(), unit: m[2].trim() } : null;
}
const YES = new Set(["так", "є", "да", "есть", "yes", "true", "+"]);
const NO = new Set(["ні", "немає", "нема", "нет", "no", "false", "-"]);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** Атрибут без одиниці в схемі, але з одиницею в назві («Потужність двигуна, Вт») → «Вт»; інакше "". */
export function nameUnit(at) {
  if (at.unitUK || at.unitRU) return "";
  const m = /,\s*([^,\d]{1,12})$/.exec(mtText(at.nameUK || at.nameRU));
  return m ? m[1].trim() : "";
}
/** Одиниця значення → множник до одиниці атрибута (точна UK/RU зі схеми, одиниця з назви атрибута або погоджений
 *  перерахунок); null — не підходить. */
export function unitFactor(at, unit, units) {
  const u = normUnit(unit);
  const fromName = nameUnit(at);
  const targets = [at.unitUK, at.unitRU, fromName].filter(Boolean).map(normUnit);
  if (!targets.length) return u ? null : 1;
  if (!u && fromName) return 1; // одиниця вже в назві атрибута
  if (!u) return null; // без одиниці не вгадуємо (2.5 — кг чи г?)
  if (targets.includes(u)) return 1;
  for (const c of units?.conversions || []) if (normUnit(c.from) === u && targets.includes(normUnit(c.to)) && Number.isFinite(c.factor)) return c.factor;
  return null;
}

/** Назва характеристики → атрибут категорії: погоджений синонім або точна назва UK/RU (єдина). */
export function resolveAttr(schema, name, mapping) {
  const n = normName(name);
  if (!n) return { reason: "порожня назва" };
  const syn = mapping?.synonyms?.[n];
  if (syn !== undefined) {
    const a = schema.attributes.find((x) => x.id === String(syn));
    return a ? { attr: a, via: "синонім" } : { reason: `синонім указує на атрибут ${syn}, якого немає в категорії` };
  }
  const hits = schema.attributes.filter((a) => normName(a.nameUK) === n || normName(a.nameRU) === n);
  if (hits.length === 1) return { attr: hits[0], via: "назва" };
  if (hits.length > 1) return { reason: "кілька атрибутів категорії з такою назвою" };
  return { reason: "у категорії немає такого атрибута" };
}

/** Варіант зі списку атрибута: погоджений синонім або точна назва UK/RU (єдина). */
function findOption(at, value, valueSynonyms) {
  const v = normName(value);
  const syn = valueSynonyms?.[v];
  return syn !== undefined ? at.values.filter((x) => x.id === String(syn)) : at.values.filter((x) => normName(x.nameUK) === v || normName(x.nameRU) === v);
}
const optionName = (o) => o.nameUK || o.nameRU;
export const MULTI_SEPARATOR = " | ";
// Число з одиницею вимірювання — не текстова назва (напр. «Марка двигуна: 19.0 HP»).
const MEASURE_RE = /^[-+]?\d+(?:[.,]\d+)?\s*(?:hp|к\.?\s?с\.?|л\.?\s?с\.?|квт|kw|вт|w|в|v|а|a|а·?ч|а\.?\s?г|мм|см|м|mm|cm|кг|kg|г|гр|л|мл|об\/хв|об\/мин|гц|hz|бар|bar|дб|db|°\s?c|°|%|cc|см3|см³|куб\.?\s?см)\.?$/iu;

/** Значення під тип атрибута. { value, unit } або { reason }.
 *  valueSynonyms — погоджені власником відповідності значень для ЦЬОГО атрибута: { "новый": "<id варіанта>" }. */
export function validateValue(at, rawValue, rawUnit, units, valueSynonyms = null) {
  let value = mtText(rawValue).trim(), unit = mtText(rawUnit).trim();
  if (!value) return { reason: "порожнє значення" };
  switch (at.type) {
    case "real": case "integer": {
      if (!unit) { const s = splitValueUnit(value); if (s) { value = s.num; unit = s.unit; } }
      const n = parseNumber(value);
      if (n === null) return { reason: `«${value}» — не одне число` };
      const f = unitFactor(at, unit, units);
      if (f === null) return { reason: unit ? `одиниця «${unit}» не відповідає «${at.unitUK || at.unitRU}»` : `немає одиниці (потрібно «${at.unitUK || at.unitRU}»)` };
      const x = round6(n * f);
      if (at.type === "integer" && !Number.isInteger(x)) return { reason: `${x} — не ціле число` };
      if (at.min !== null && x < at.min) return { reason: `${x} менше за мінімум ${at.min}` };
      if (at.max !== null && x > at.max) return { reason: `${x} більше за максимум ${at.max}` };
      return { value: String(x), unit: at.unitUK || at.unitRU || "" };
    }
    case "bool": {
      if (unit) return { reason: "одиниця для так/ні" };
      const v = normName(value);
      if (YES.has(v)) return { value: "Так", unit: "" };
      if (NO.has(v)) return { value: "Ні", unit: "" };
      return { reason: `«${value}» — не так/ні` };
    }
    case "singleselect": {
      if (unit) return { reason: "одиниця для варіанта зі списку" };
      const hits = findOption(at, value, valueSynonyms);
      if (hits.length !== 1) return { reason: hits.length ? "кілька варіантів з такою назвою" : `«${value}» немає серед допустимих значень` };
      return { value: optionName(hits[0]), unit: "" };
    }
    case "multiselect": {
      // Одне значення — варіант цілком; кілька — кожна частина (роздільники | ; , /) має бути допустимим варіантом.
      if (unit) return { reason: "одиниця для варіантів зі списку" };
      const one = findOption(at, value, valueSynonyms);
      if (one.length === 1) return { value: optionName(one[0]), unit: "" };
      if (one.length > 1) return { reason: "кілька варіантів з такою назвою" };
      const parts = value.split(/\s*[|;,/]\s*/).filter(Boolean);
      if (parts.length < 2) return { reason: `«${value}» немає серед допустимих значень` };
      const picked = [];
      for (const p of parts) {
        const h = findOption(at, p, valueSynonyms);
        if (h.length !== 1) return { reason: h.length ? `«${p}»: кілька варіантів з такою назвою` : `«${p}» немає серед допустимих значень` };
        if (!picked.includes(h[0])) picked.push(h[0]);
      }
      return { value: picked.map(optionName).join(MULTI_SEPARATOR), unit: "" };
    }
    case "free": {
      if (unit) return { reason: "одиниця для текстового поля" };
      if (value.length > FREE_MAX) return { reason: `довше за ${FREE_MAX} символів` };
      if (MEASURE_RE.test(value)) return { reason: `«${value}» — число з одиницею в текстовому полі (ймовірна помилка постачальника) — не заповнюється` };
      return { value, unit: "" };
    }
    default: return { reason: `тип «${at.type}» не підтримується` };
  }
}

/** Характеристика → поле Prom: { ok, attr, out } або { ok: false, reason }. */
export function mapParam(schema, param, { mapping, units } = {}) {
  const r = resolveAttr(schema, param?.name, mapping);
  const v = r.attr && validateValue(r.attr, param.value, param.unit, units, mapping?.values?.[r.attr.id]);
  if (v && !v.reason) return { ok: true, attr: r.attr, out: { name: r.attr.nameUK || r.attr.nameRU, value: v.value, unit: v.unit } };
  // «Мощность двигателя: 680 Вт» → атрибут «Потужність двигуна, Вт» (та сама назва + одиниця значення в назві атрибута).
  const su = mtText(param?.unit).trim() ? { num: mtText(param.value).trim(), unit: mtText(param.unit).trim() } : splitValueUnit(param?.value);
  if (su && normName(param?.name)) {
    const alt = schema.attributes.filter((a) => nameUnit(a) && [a.nameUK, a.nameRU].some((n) => normName(mtText(n).replace(/,[^,]*$/, "")) === normName(param.name)) && unitFactor(a, su.unit, units) !== null);
    if (alt.length === 1) {
      const w = validateValue(alt[0], su.num, su.unit, units, mapping?.values?.[alt[0].id]);
      if (!w.reason) return { ok: true, attr: alt[0], via: "назва з одиницею", out: { name: alt[0].nameUK || alt[0].nameRU, value: w.value, unit: w.unit } };
    }
  }
  if (!r.attr) return { ok: false, reason: r.reason };
  return { ok: false, attr: r.attr, reason: v.reason };
}

// ---------- опис постачальника ----------
const textOf = (html) => mtDecode(mtText(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ")).replace(/\s+/g, " ").trim();
const KV_RE = /^([A-ZА-ЯІЇЄҐ][^:]{0,60}?)\s*:\s*(\S.{0,200})$/u;
/** Пари «назва — значення» з опису: рядки таблиць із двома клітинками; абзаци, пункти списку й рядки (між <br>
 *  або переносами) виду «Назва: значення». Кожна пара — з точними межами фрагмента (start, end) для очищення. */
export function descriptionPairs(html) {
  const s = mtText(html);
  const out = [];
  const tables = [...s.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((m) => [m.index, m.index + m[0].length]);
  const inTable = (i) => tables.some(([a, b]) => i >= a && i < b);
  for (const m of s.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((c) => textOf(c[2]));
    if (cells.length === 2 && cells[0] && cells[1]) out.push({ key: cells[0].replace(/[:\s]+$/, ""), value: cells[1], start: m.index, end: m.index + m[0].length });
  }
  const segments = (from, inner) => {
    // Рядки між <br> / переносами всередині елемента.
    const parts = [];
    const re = /<br\s*\/?>|\r?\n/gi;
    let last = 0, mm;
    while ((mm = re.exec(inner))) { parts.push([last, mm.index, mm.index + mm[0].length]); last = mm.index + mm[0].length; }
    parts.push([last, inner.length, inner.length]);
    for (const [a, b, sepEnd] of parts) {
      const kv = KV_RE.exec(textOf(inner.slice(a, b)));
      if (kv) out.push({ key: kv[1].trim(), value: kv[2].trim(), start: from + a, end: from + (sepEnd > b ? sepEnd : b) });
    }
  };
  const blocks = [...s.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)].filter((m) => !inTable(m.index));
  for (const m of blocks) {
    const inner = m[2];
    if (/<br\s*\/?>|\n/i.test(inner)) segments(m.index + m[0].indexOf(inner, m[0].indexOf(">") + 1), inner);
    else { const kv = KV_RE.exec(textOf(inner)); if (kv) out.push({ key: kv[1].trim(), value: kv[2].trim(), start: m.index, end: m.index + m[0].length }); }
  }
  if (!/<[a-z][^>]*>/i.test(s)) segments(0, s); // опис без розмітки — рядки тексту
  return out.sort((a, b) => a.start - b.start);
}

/** Прибрати фрагменти (лише перенесені пари) з сирої копії опису; порожні таблиці теж прибираються. */
export function cleanDescription(html, ranges) {
  let s = mtText(html);
  let bound = Infinity;
  for (const [a, b] of [...ranges].sort((x, y) => y[0] - x[0])) {
    if (b > bound) continue; // перекриття — фрагмент уже прибрано
    s = s.slice(0, a) + s.slice(b);
    bound = a;
  }
  s = s.replace(/<(p|li)\b[^>]*>(?:\s|<br\s*\/?>|&nbsp;)*<\/\1>/gi, "").replace(/<(ul|ol)\b[^>]*>\s*<\/\1>/gi, "");
  s = s.replace(/<table\b[^>]*>(?:\s|<\/?(?:tbody|thead)\b[^>]*>)*<\/table>/gi, "");
  return s.replace(/(?:<br\s*\/?>\s*){3,}/gi, "<br><br>").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- підсумкові характеристики ----------
const jsonOr = (v, d) => { try { const x = JSON.parse(mtText(v) || "null"); return x ?? d; } catch { return d; } };
const asParams = (a) => (Array.isArray(a) ? a : []).filter((p) => p && typeof p === "object" && mtText(p.name).trim()).map((p) => ({ name: mtText(p.name).trim(), value: mtText(p.value).trim(), unit: mtText(p.unit).trim() }));
export const readProvenance = (v) => { const p = jsonOr(v, null); return p && p.v === 1 && Array.isArray(p.items) ? p : null; };

/**
 * Підготовлені характеристики для Prom.
 *  schema — схема категорії (або null); categoryId — поточна категорія товару;
 *  rawParams — актуальні характеристики XML постачальника; descUa / descRu — оригінальний опис постачальника;
 *  current — поточні «Характеристики JSON»; provenance — поточне «Походження характеристик JSON» (рядок або об'єкт);
 *  mode — "main": без схеми нічого не змінюється (підготовлені дані не втрачаються через відсутність схеми);
 *         "queue": без схеми сирі характеристики копіюються як раніше (якщо їх не редагували вручну).
 */
export function buildCharacteristics({ schema = null, categoryId = "", rawParams = [], descUa = "", descRu = "", current = [], provenance = null, mapping = null, units = null, mode = "queue" }) {
  const cur = asParams(typeof current === "string" ? jsonOr(current, []) : current);
  const raw = asParams(rawParams);
  const prov = typeof provenance === "string" ? readProvenance(provenance) : provenance;
  const notes = [];
  const unchanged = { params: cur, provenance: prov, notes, ambiguous: [], conflicts: [], duplicates: [], merged: [], overflow: [], rawOnly: [], removed: [], descRanges: { ua: [], ru: [] }, changed: false, unmapped: [] };
  if (!schema && mode === "main") { notes.push(`немає схеми категорії ${categoryId || "?"} — підготовлені характеристики не змінено`); return unchanged; }

  // 1. Кандидати: XML, потім опис.
  const cand = new Map(); // attrId → { out, src, frags: {ua:[], ru:[]} }
  const ambiguous = new Set(), conflicts = [], unmapped = [];
  if (schema) {
    for (const p of raw) {
      const m = mapParam(schema, p, { mapping, units });
      if (!m.ok) { unmapped.push({ name: p.name, reason: m.reason }); continue; }
      const prev = cand.get(m.attr.id);
      if (prev && itemKey(prev.out) !== itemKey(m.out)) { ambiguous.add(m.attr.id); conflicts.push(`XML: кілька різних значень для «${m.out.name}»`); continue; }
      cand.set(m.attr.id, { out: m.out, src: SRC.XML, frags: { ua: [], ru: [] }, from: itemKey(p) });
    }
    const descCand = new Map();
    for (const [lang, html] of [["ua", descUa], ["ru", descRu]]) {
      for (const pair of descriptionPairs(html)) {
        const m = mapParam(schema, { name: pair.key, value: pair.value, unit: "" }, { mapping, units });
        if (!m.ok) continue; // невизначене лишається в описі
        const x = cand.get(m.attr.id);
        if (x && x.src === SRC.XML) {
          if (itemKey(x.out) === itemKey(m.out)) x.frags[lang].push([pair.start, pair.end]); // те саме значення вже є з XML
          else conflicts.push(`опис суперечить XML для «${m.out.name}» — взято XML`);
          continue;
        }
        const d = descCand.get(m.attr.id);
        if (d && itemKey(d.out) !== itemKey(m.out)) { ambiguous.add(m.attr.id); conflicts.push(`опис: різні значення для «${m.out.name}»`); continue; }
        if (d) d.frags[lang].push([pair.start, pair.end]);
        else descCand.set(m.attr.id, { out: m.out, src: SRC.DESC, frags: { ua: lang === "ua" ? [[pair.start, pair.end]] : [], ru: lang === "ru" ? [[pair.start, pair.end]] : [] } });
      }
    }
    for (const [a, d] of descCand) if (!cand.has(a)) cand.set(a, d);
    for (const a of ambiguous) cand.delete(a);
  }
  const candByKey = new Map([...cand].map(([a, c]) => [itemKey(c.out), { a, c }]));
  const rawByName = new Map(raw.map((p) => [normName(p.name), p]));
  const rawKeys = new Set(raw.map(itemKey));
  const attrOf = (name) => (schema ? resolveAttr(schema, name, mapping).attr?.id || "" : "");
  const attrOfItem = (p) => { if (!schema) return ""; const m = mapParam(schema, p, { mapping, units }); return m.ok ? m.attr.id : attrOf(p.name); };

  // 2. Походження наявних записів.
  const prevItems = new Map((prov?.items || []).map((i) => [i.k, i]));
  const suppressed = new Set(prov?.x || []);
  const curKeys = new Set(cur.map(itemKey));
  if (prov) for (const i of prov.items) if (AUTO.has(i.s) && !curKeys.has(i.k)) suppressed.add(i.a || "n:" + normName(i.k.split("\u0001")[0])); // власник прибрав
  const classified = cur.map((p) => {
    const k = itemKey(p);
    const pi = prevItems.get(k);
    if (pi) return { p, k, s: pi.s, a: pi.a || attrOfItem(p) };
    if (prov) return { p, k, s: SRC.MANUAL, a: attrOfItem(p) }; // система цього не писала — правка власника
    const c = candByKey.get(k);
    if (c) return { p, k, s: c.c.src, a: c.a };
    if (rawKeys.has(k)) return { p, k, s: SRC.RAW, a: "" };
    return { p, k, s: SRC.UNKNOWN, a: attrOfItem(p) };
  });

  // 3. Підсумок: ручні й невідомі — без змін; автоматичні — за актуальними даними; нові підтверджені — додаються.
  const result = [], items = [], used = new Set(), usedNames = new Set(), removed = [], duplicates = [], merged = [], overflow = [];
  const fmt = (p) => `${p.name}: ${p.value}${p.unit ? " " + p.unit : ""}`;
  // Еквівалентний запис того самого атрибута (погоджено власником): після перевірки схемою дає те саме значення поля
  // (зокрема RU-назва / RU-варіант / погоджений перерахунок одиниці), або те саме число без одиниці.
  const equivalent = (p, out) => {
    if (itemKey(p) === itemKey(out)) return true;
    const m = schema && mapParam(schema, p, { mapping, units });
    if (m?.ok) return itemKey(m.out) === itemKey(out);
    const n = !mtText(p.unit).trim() && !splitValueUnit(p.value) ? parseNumber(p.value) : null;
    return n !== null && n === parseNumber(out.value);
  };
  const push = (p, s, a) => {
    if (result.length >= MAX_PARAMS) { overflow.push(fmt(p)); return; }
    result.push(p); items.push({ k: itemKey(p), s, a }); if (a) used.add(a); usedNames.add(normName(p.name));
  };
  // Дубль об'єднано: лишається поле Prom (додається тут, якщо ще не додане).
  const merge = (x, a) => { const c = cand.get(a); merged.push(`«${fmt(x.p)}» → поле Prom «${fmt(c.out)}»`); if (!used.has(a)) push(c.out, c.src, a); };
  const catChanged = Boolean(prov?.cat && categoryId && prov.cat !== String(categoryId));
  for (const x of classified) {
    if (x.s === SRC.MANUAL || x.s === SRC.UNKNOWN) {
      if (x.a && cand.has(x.a) && itemKey(cand.get(x.a).out) !== x.k) {
        const c = cand.get(x.a).out;
        if (equivalent(x.p, c)) {
          // Невизначене походження + еквівалентне поле Prom → об'єднання; ручне — ніколи не прибирається.
          if (x.s === SRC.UNKNOWN && !suppressed.has(x.a)) { merge(x, x.a); continue; }
          duplicates.push(`«${fmt(x.p)}» (ручне) дублює поле Prom «${fmt(c)}» — ручне збережено`);
        } else conflicts.push(`«${x.p.name}»: ${x.s === SRC.MANUAL ? "ручне" : "наявне"} значення «${x.p.value}» ≠ постачальник «${c.value}» — збережено наше`);
      }
      if (catChanged && schema && !x.a) notes.push(`«${x.p.name}» не перевірено для нової категорії ${categoryId}`);
      push(x.p, x.s, x.a);
      continue;
    }
    if (x.s === SRC.XML || x.s === SRC.DESC) {
      const c = x.a && cand.get(x.a);
      if (c && !used.has(x.a)) push(c.out, c.src, x.a);
      else if (c && equivalent(x.p, c.out)) merge(x, x.a);
      else if (c) { conflicts.push(`«${fmt(x.p)}» ≠ поле Prom «${fmt(c.out)}» — обидва збережено`); push(x.p, x.s, ""); }
      else removed.push(x.p.name);
      continue;
    }
    // RAW: якщо тепер зіставляється — підтверджене поле; інакше — актуальне сире значення з тією ж назвою.
    const a = attrOfItem(x.p);
    if (a && cand.has(a)) {
      // Замінюємо полем Prom лише тоді, коли поле виведене саме з цього запису; інакше (поле з іншого параметра
      // постачальника) наявне значення може містити більше даних (напр. «Біметал HSS») — лишаємо його, поле не дублюємо.
      // Підготовлений запис ніколи не зникає: якщо поле вже зайняте — запис лишається як був (дубль позначається).
      const c = cand.get(a);
      if (c.from === x.k && !used.has(a)) { push(c.out, c.src, a); continue; }
      if (!suppressed.has(a) && equivalent(x.p, c.out)) { merge(x, a); continue; }
      if (used.has(a)) conflicts.push(`«${fmt(x.p)}» ≠ поле Prom «${fmt(c.out)}» — обидва збережено`);
      else { conflicts.push(`«${x.p.name}»: наявне значення «${x.p.value}» залишено; поле Prom «${c.out.value}» не застосовано (інший параметр постачальника)`); used.add(a); }
      push(x.p, SRC.RAW, "");
      continue;
    }
    const now = rawByName.get(normName(x.p.name));
    if (now && !usedNames.has(normName(now.name))) push(now, SRC.RAW, "");
    else if (!now) removed.push(x.p.name);
  }
  for (const [a, c] of cand) if (!used.has(a) && !suppressed.has(a)) push(c.out, c.src, a);
  const hasUnknown = classified.some((x) => x.s === SRC.UNKNOWN);
  // Незіставлені характеристики XML — користувацькими (дослівно), але лише коли: назва не є атрибутом категорії (інакше
  // видавали б за стандартну) і походження всіх записів відоме (інакше можна задублювати підготовлене іншою мовою,
  // напр. «Стан» і «Состояние»). Решта — у rawOnly з причиною.
  const rawWhy = new Map(); // ключ сирого запису → чому лише в сирих даних
  for (const p of raw) {
    const n = normName(p.name);
    if (usedNames.has(n) || suppressed.has("n:" + n)) continue;
    const m = schema && mapParam(schema, p, { mapping, units });
    if (m?.ok) continue;
    if (m?.attr) { rawWhy.set(itemKey(p), `${m.reason}; назва збігається з атрибутом категорії «${m.attr.nameUK || m.attr.nameRU}» — користувацькою не передається`); continue; }
    if (hasUnknown) { rawWhy.set(itemKey(p), "у картці є записи невизначеного походження — можливий дубль іншою мовою, не додано"); continue; }
    push(p, SRC.RAW, "");
  }
  if (hasUnknown) notes.push(`походження ${classified.filter((x) => x.s === SRC.UNKNOWN).length} характеристик не визначено — збережено без змін`);
  if (removed.length) notes.push("прибрано (постачальник більше не передає / не відповідає категорії): " + removed.join(", "));
  // Кожна характеристика постачальника, якої немає в підсумку (ні дослівно, ні полем Prom), — з причиною.
  const outKeys = new Set(items.map((i) => i.k));
  const flat = (p) => normName(`${mtText(p.value)} ${mtText(p.unit)}`);
  const rawOnly = [];
  for (const p of raw) {
    const k = itemKey(p);
    if (outKeys.has(k)) continue;
    const c = [...cand.values()].find((x) => x.from === k);
    if (c && outKeys.has(itemKey(c.out))) continue;
    // Та сама характеристика вже є в підсумку: дослівно з іншим записом одиниці («35 м» ↔ «35» + «м») або
    // еквівалентним полем Prom того самого атрибута (повтор параметра постачальника, зокрема без одиниці).
    if (result.some((q) => normName(q.name) === normName(p.name) && flat(q) === flat(p))) continue;
    const pa = schema && attrOfItem(p);
    const twin = pa ? items.findIndex((i, j) => i.a === pa && equivalent(p, result[j])) : -1;
    if (twin >= 0) { merged.push(`«${fmt(p)}» (XML, повтор) → поле Prom «${fmt(result[twin])}»`); continue; }
    let reason = rawWhy.get(k);
    if (!reason) {
      const m = schema ? mapParam(schema, p, { mapping, units }) : { ok: false, reason: "немає схеми категорії" };
      if (!m.ok) reason = m.attr ? `${m.reason}; назва збігається з атрибутом категорії «${m.attr.nameUK || m.attr.nameRU}»` : m.reason;
      else if (ambiguous.has(m.attr.id)) reason = `кілька різних значень для поля «${m.out.name}» — не заповнено`;
      else if (suppressed.has(m.attr.id)) reason = "поле прибрав власник";
      else if (used.has(m.attr.id)) reason = `поле «${m.out.name}» уже заповнене нашим значенням (збережено)`;
      else if (overflow.length) reason = `ліміт ${MAX_PARAMS} характеристик`;
      else reason = "дубль назви іншого запису";
    }
    rawOnly.push({ name: p.name, value: p.value, unit: p.unit, reason });
  }
  // 4. Фрагменти опису, перенесені в поля (для очищення СИРОЇ копії опису).
  const descRanges = { ua: [], ru: [] };
  items.forEach((it) => { const c = it.a && cand.get(it.a); if (c && itemKey(c.out) === it.k) { descRanges.ua.push(...c.frags.ua); descRanges.ru.push(...c.frags.ru); } });
  // Збережені дослівні записи, назва яких збігається з атрибутом категорії (значення не з довідника): за документацією
  // Prom такий запис імпортується як користувацький — позначаємо для перевірки, запис не прибираємо.
  const customAttrNames = schema ? result.filter((p, i) => !items[i].a && attrOf(p.name)).map(fmt) : [];
  const conflictsU = [...new Set(conflicts)]; // те саме з UA- і RU-опису — один раз
  if (overflow.length) notes.push(`понад ${MAX_PARAMS} характеристик — не додано: ${overflow.length}`);
  const provenanceOut = { v: 1, cat: String(categoryId || ""), items, x: [...suppressed], notes: [...conflictsU, ...notes].slice(0, 20) };
  return {
    params: result, provenance: provenanceOut, notes, ambiguous: [...ambiguous], conflicts: conflictsU, duplicates, merged, overflow, rawOnly, customAttrNames, removed, descRanges, unmapped,
    changed: JSON.stringify(result) !== JSON.stringify(cur),
  };
}
