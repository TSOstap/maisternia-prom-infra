/** Зіставлення характеристик постачальника з полями категорії Prom (погоджено власником 23.10.2026). Чисті функції.
 *
 *  Пріоритет: 1) структуровані <param> XML постачальника; 2) пари «назва — значення» з опису постачальника;
 *  3) наші ручні виправлення — мають перевагу над будь-яким автоматичним значенням.
 *  Поле Prom заповнюється лише при підтвердженій відповідності: назва (точна назва атрибута ЦІЄЇ категорії або
 *  погоджений синонім), тип, одиниця (точна або погоджений перерахунок), діапазон min/max, допустимий варіант значення.
 *  Схожості назв недостатньо. Неоднозначність / конфлікт / непідтримуване значення — поле не заповнюється.
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

/** Одиниця значення → множник до одиниці атрибута (точна UK/RU зі схеми або погоджений перерахунок); null — не підходить. */
export function unitFactor(at, unit, units) {
  const u = normUnit(unit);
  const targets = [at.unitUK, at.unitRU].filter(Boolean).map(normUnit);
  if (!targets.length) return u ? null : 1;
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
      const v = normName(value);
      const syn = valueSynonyms?.[v];
      const hits = syn !== undefined ? at.values.filter((x) => x.id === String(syn)) : at.values.filter((x) => normName(x.nameUK) === v || normName(x.nameRU) === v);
      if (hits.length !== 1) return { reason: hits.length ? "кілька варіантів з такою назвою" : `«${value}» немає серед допустимих значень` };
      return { value: hits[0].nameUK || hits[0].nameRU, unit: "" };
    }
    case "multiselect": return { reason: "кілька значень: формат передачі в YML не підтверджено — автоматично не заповнюється" };
    case "free": {
      if (unit) return { reason: "одиниця для текстового поля" };
      if (value.length > FREE_MAX) return { reason: `довше за ${FREE_MAX} символів` };
      return { value, unit: "" };
    }
    default: return { reason: `тип «${at.type}» не підтримується` };
  }
}

/** Характеристика → поле Prom: { ok, attr, out } або { ok: false, reason }. */
export function mapParam(schema, param, { mapping, units } = {}) {
  const r = resolveAttr(schema, param?.name, mapping);
  if (!r.attr) return { ok: false, reason: r.reason };
  const v = validateValue(r.attr, param.value, param.unit, units, mapping?.values?.[r.attr.id]);
  if (v.reason) return { ok: false, attr: r.attr, reason: v.reason };
  return { ok: true, attr: r.attr, out: { name: r.attr.nameUK || r.attr.nameRU, value: v.value, unit: v.unit } };
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
  const unchanged = { params: cur, provenance: prov, notes, ambiguous: [], conflicts: [], removed: [], descRanges: { ua: [], ru: [] }, changed: false, unmapped: [] };
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
      cand.set(m.attr.id, { out: m.out, src: SRC.XML, frags: { ua: [], ru: [] } });
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

  // 2. Походження наявних записів.
  const prevItems = new Map((prov?.items || []).map((i) => [i.k, i]));
  const suppressed = new Set(prov?.x || []);
  const curKeys = new Set(cur.map(itemKey));
  if (prov) for (const i of prov.items) if (AUTO.has(i.s) && !curKeys.has(i.k)) suppressed.add(i.a || "n:" + normName(i.k.split("\u0001")[0])); // власник прибрав
  const classified = cur.map((p) => {
    const k = itemKey(p);
    const pi = prevItems.get(k);
    if (pi) return { p, k, s: pi.s, a: pi.a || attrOf(p.name) };
    if (prov) return { p, k, s: SRC.MANUAL, a: attrOf(p.name) }; // система цього не писала — правка власника
    const c = candByKey.get(k);
    if (c) return { p, k, s: c.c.src, a: c.a };
    if (rawKeys.has(k)) return { p, k, s: SRC.RAW, a: "" };
    return { p, k, s: SRC.UNKNOWN, a: attrOf(p.name) };
  });

  // 3. Підсумок: ручні й невідомі — без змін; автоматичні — за актуальними даними; нові підтверджені — додаються.
  const result = [], items = [], used = new Set(), usedNames = new Set(), removed = [];
  const push = (p, s, a) => { if (result.length >= MAX_PARAMS) return; result.push(p); items.push({ k: itemKey(p), s, a }); if (a) used.add(a); usedNames.add(normName(p.name)); };
  const catChanged = Boolean(prov?.cat && categoryId && prov.cat !== String(categoryId));
  for (const x of classified) {
    if (x.s === SRC.MANUAL || x.s === SRC.UNKNOWN) {
      if (x.a && cand.has(x.a) && itemKey(cand.get(x.a).out) !== x.k) conflicts.push(`«${x.p.name}»: ${x.s === SRC.MANUAL ? "ручне" : "наявне"} значення «${x.p.value}» ≠ постачальник «${cand.get(x.a).out.value}» — збережено наше`);
      if (catChanged && schema && !x.a) notes.push(`«${x.p.name}» не перевірено для нової категорії ${categoryId}`);
      push(x.p, x.s, x.a);
      continue;
    }
    if (x.s === SRC.XML || x.s === SRC.DESC) {
      const c = x.a && cand.get(x.a);
      if (c && !used.has(x.a)) push(c.out, c.src, x.a);
      else if (!c) removed.push(x.p.name);
      continue;
    }
    // RAW: якщо тепер зіставляється — підтверджене поле; інакше — актуальне сире значення з тією ж назвою.
    const a = attrOf(x.p.name);
    if (a && cand.has(a)) { if (!used.has(a)) push(cand.get(a).out, cand.get(a).src, a); continue; }
    const now = rawByName.get(normName(x.p.name));
    if (now && !usedNames.has(normName(now.name))) push(now, SRC.RAW, "");
    else if (!now) removed.push(x.p.name);
  }
  for (const [a, c] of cand) if (!used.has(a) && !suppressed.has(a)) push(c.out, c.src, a);
  const hasUnknown = classified.some((x) => x.s === SRC.UNKNOWN);
  // Незіставлені характеристики XML — як і раніше, окремими (не полями Prom), але лише коли походження всіх записів відоме
  // (інакше можна задублювати вже підготовлене вручну, напр. «Стан» і «Состояние»).
  if (!hasUnknown) {
    for (const p of raw) {
      const n = normName(p.name);
      if (usedNames.has(n) || suppressed.has("n:" + n) || (schema && mapParam(schema, p, { mapping, units }).ok)) continue;
      if (schema && attrOf(p.name) && used.has(attrOf(p.name))) continue;
      push(p, SRC.RAW, "");
    }
  }
  if (hasUnknown) notes.push(`походження ${classified.filter((x) => x.s === SRC.UNKNOWN).length} характеристик не визначено — збережено без змін`);
  if (removed.length) notes.push("прибрано (постачальник більше не передає / не відповідає категорії): " + removed.join(", "));
  // 4. Фрагменти опису, перенесені в поля (для очищення СИРОЇ копії опису).
  const descRanges = { ua: [], ru: [] };
  items.forEach((it) => { const c = it.a && cand.get(it.a); if (c && itemKey(c.out) === it.k) { descRanges.ua.push(...c.frags.ua); descRanges.ru.push(...c.frags.ru); } });
  const provenanceOut = { v: 1, cat: String(categoryId || ""), items, x: [...suppressed], notes: [...conflicts, ...notes].slice(0, 20) };
  return {
    params: result, provenance: provenanceOut, notes, ambiguous: [...ambiguous], conflicts, removed, descRanges, unmapped,
    changed: JSON.stringify(result) !== JSON.stringify(cur),
  };
}
