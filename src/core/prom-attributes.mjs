/** Зіставлення характеристик постачальника з полями категорії Prom (погоджено власником 23.10.2026). Чисті функції.
 *
 *  Пріоритет: 1) структуровані <param> XML постачальника; 2) пари «назва — значення» з опису постачальника;
 *  3) наші ручні виправлення — мають перевагу над будь-яким автоматичним значенням.
 *  Поле Prom заповнюється лише при підтвердженій відповідності: назва (точна назва атрибута ЦІЄЇ категорії або
 *  погоджений синонім), тип, одиниця (точна або погоджений перерахунок), діапазон min/max, допустимий варіант значення.
 *  Схожості назв недостатньо. Неоднозначність / конфлікт / непідтримуване значення — поле не заповнюється.
 *  Уточнення власника 23.10.2026 (друге й третє):
 *   - максимально всі характеристики постачальника (XML і описи) — у Prom: поле категорії, якщо значення проходить
 *     технічну перевірку схеми; інакше — користувацька з оригінальним значенням; достовірність значень не оцінюється;
 *     не передане (ліміти, ПОТРЕБУЄ ПЕРЕВІРКИ) — у сирих даних і звіті (rawOnly / needsReview) з причиною;
 *   - UA/RU: та сама характеристика (за підтвердженою відповідністю назв) — одна, з українською назвою; різні значення —
 *     «ПОТРЕБУЄ ПЕРЕВІРКИ» з обома оригіналами;
 *   - поле категорії — завжди українські назва / одиниця / значення зі схеми (Prom показує nameRU сам; окремих YML-тегів
 *     для мов характеристик документація не описує);
 *   - кілька значень (multiselect) — допустимі варіанти через « | » (документація Prom: «GSM | CDMA»);
 *   - смислові дублі (той самий атрибут, сумісні одиниці, еквівалентні значення) об'єднуються; ручні не видаляються;
 *   - понад MAX_PARAMS (100) або MAX_CUSTOM (70 користувацьких) — не додається, перелік в overflow.
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
  const cu = (x) => canonUnitOf(x, units); // синоніми одиниць (units.json → aliases): «місяців» = «міс»
  const u = cu(unit);
  const fromName = nameUnit(at);
  const targets = [at.unitUK, at.unitRU, fromName].filter(Boolean).map(cu);
  if (!targets.length) return u ? null : 1;
  if (!u && fromName) return 1; // одиниця вже в назві атрибута
  if (!u) return null; // без одиниці не вгадуємо (2.5 — кг чи г?)
  if (targets.includes(u)) return 1;
  for (const c of units?.conversions || []) if (cu(c.from) === u && targets.includes(cu(c.to)) && Number.isFinite(c.factor)) return c.factor;
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
      return { value, unit: "" };
    }
    default: return { reason: `тип «${at.type}» не підтримується` };
  }
}

/** Характеристика → поле Prom: { ok, attr, out } або { ok: false, reason }. */
export function mapParam(schema, param, { mapping, units } = {}) {
  const r = resolveAttr(schema, param?.name, mapping);
  // Поле з відомою вадою довідника Prom (known-issues.json, action «custom»: напр. «Частота» в GHz для частоти мережі) —
  // не заповнюється; характеристика передається користувацькою з погодженою назвою (customName).
  const bad = r.attr && mapping?.blocked?.[r.attr.id];
  if (bad) return { ok: false, blocked: bad, reason: `вада довідника Prom: ${bad.issue}` };
  const v = r.attr && validateValue(r.attr, param.value, param.unit, units, mapping?.values?.[r.attr.id]);
  if (v && !v.reason) return { ok: true, attr: r.attr, out: { name: r.attr.nameUK || r.attr.nameRU, value: v.value, unit: v.unit } };
  // «Мощность двигателя: 680 Вт» → атрибут «Потужність двигуна, Вт» (та сама назва + одиниця значення в назві атрибута).
  const su = mtText(param?.unit).trim() ? { num: mtText(param.value).trim(), unit: mtText(param.unit).trim() } : splitValueUnit(param?.value);
  if (su && normName(param?.name)) {
    const alt = schema.attributes.filter((a) => nameUnit(a) && !mapping?.blocked?.[a.id] && [a.nameUK, a.nameRU].some((n) => normName(mtText(n).replace(/,[^,]*$/, "")) === normName(param.name)) && unitFactor(a, su.unit, units) !== null);
    if (alt.length === 1) {
      const w = validateValue(alt[0], su.num, su.unit, units, mapping?.values?.[alt[0].id]);
      if (!w.reason) return { ok: true, attr: alt[0], via: "назва з одиницею", out: { name: alt[0].nameUK || alt[0].nameRU, value: w.value, unit: w.unit } };
    }
  }
  // «Вес, кг: 1.15», «Гарантія (міс): 36» — одиниця в назві характеристики постачальника (однозначна технічна
  // нормалізація одиниць): назва без одиниці + одиниця до числового значення, далі — звичайна перевірка схемою.
  const nu = /^(.+?)\s*(?:,\s*|\(\s*)([^,()\d]{1,12}?)\s*\)?\s*$/.exec(mtText(param?.name));
  if (nu && units?.aliasMap?.has(normUnit(nu[2])) && !mtText(param.unit).trim() && parseNumber(param.value) !== null) {
    const res = mapParam(schema, { name: nu[1], value: param.value, unit: nu[2] }, { mapping, units });
    if (res.ok) return { ...res, via: "одиниця в назві" };
  }
  if (!r.attr) return { ok: false, reason: r.reason };
  return { ok: false, attr: r.attr, reason: v.reason };
}

// ---------- опис постачальника ----------
const ENT = { ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", shy: "", nbsp: " ", ndash: "–", mdash: "—", minus: "−", deg: "°", sup1: "¹", sup2: "²", sup3: "³", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", laquo: "«", raquo: "»", times: "×", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", hellip: "…", middot: "·", bull: "•", micro: "µ", prime: "′", Prime: "″", quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", Oslash: "Ø", oslash: "ø", asymp: "≈", le: "≤", ge: "≥", trade: "™", reg: "®", copy: "©" };
// Латиниця-1 (&ouml;, &eacute;, … — коди 160–255 по порядку) і типові типографські сутності HTML: «Gr&ouml;sser» → «Grösser».
"nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml"
  .split(" ").forEach((n, i) => { if (!(n in ENT)) ENT[n] = String.fromCharCode(160 + i); });
Object.assign(ENT, { euro: "€", sbquo: "‚", bdquo: "„", permil: "‰", ne: "≠", infin: "∞", larr: "←", rarr: "→", harr: "↔", uarr: "↑", darr: "↓", dagger: "†", lowast: "∗", empty: "∅", radic: "√", sim: "∼", cong: "≅", frasl: "⁄", lrm: "‎", rlm: "‏" });
/** HTML-сутності → символи (текст так, як його бачить покупець в описі); невідомі лишаються як є. */
export const htmlText = (v) => mtText(v).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, k) => (k[0] === "#" ? String.fromCodePoint(k[1].toLowerCase() === "x" ? parseInt(k.slice(2), 16) : Number(k.slice(1))) : ENT[k] ?? ENT[k.toLowerCase()] ?? all));
/** Значення для Prom (власник, 24.10.2026): HTML-сутності → символи, зайві пробіли, без КІНЦЕВОЇ «;» (роздільник рядка
 *  опису / таблиці: «IP21;» → «IP21»). Числа, моделі, одиниці, «;» усередині значення не змінюються. Вихідний текст
 *  постачальника зберігається окремо — у сирих даних («Характеристики постачальника JSON», оригінальний опис). */
export const cleanValue = (v) => htmlText(v).replace(/[​-‏⁠﻿]/g, "").replace(/&(lrm|rlm)$/i, "").replace(/[  ]/g, " ").replace(/\s+/g, " ").trim().replace(/(\s*;)+$/, "").trim();
const textOf = (html) => htmlText(mtDecode(mtText(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " "))).replace(/\s+/g, " ").trim();
const HEADER_KEYS = new Set(["характеристика", "характеристики", "параметр", "параметри", "параметры", "назва", "название"]);
const HEADER_VALUES = new Set(["значення", "значение", "опис", "описание"]);
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
    if (cells.length === 2 && HEADER_KEYS.has(normName(cells[0])) && HEADER_VALUES.has(normName(cells[1]))) continue; // заголовок таблиці
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
      if (kv && !(HEADER_KEYS.has(normName(kv[1])) && HEADER_VALUES.has(normName(kv[2])))) out.push({ key: kv[1].trim(), value: kv[2].trim(), start: from + a, end: from + (sepEnd > b ? sepEnd : b) });
    }
  };
  const blocks = [...s.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)].filter((m) => !inTable(m.index));
  for (const m of blocks) {
    const inner = m[2];
    if (/<br\s*\/?>|\n/i.test(inner)) segments(m.index + m[0].indexOf(inner, m[0].indexOf(">") + 1), inner);
    else { const kv = KV_RE.exec(textOf(inner)); if (kv && !(HEADER_KEYS.has(normName(kv[1])) && HEADER_VALUES.has(normName(kv[2])))) out.push({ key: kv[1].trim(), value: kv[2].trim(), start: m.index, end: m.index + m[0].length }); }
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
/** Ліміт користувацьких характеристик у картці Prom (документація: «до 70»; у файл експорту — перші 70). */
export const MAX_CUSTOM = 70;

// ---------- UA/RU відповідності ----------
/** Синоніми одиниць (units.json → aliases): кожне написання → канонічне (перше в групі, як у схемі Prom).
 *  Написання, що потрапило в дві різні групи, — неоднозначне й не використовується. */
export function unitAliasMap(groups) {
  const m = new Map(), bad = new Set();
  for (const g of groups || []) {
    const c = normUnit(g[0]);
    for (const u of g) {
      const k = normUnit(u);
      if (!k || bad.has(k)) continue;
      if (m.has(k) && m.get(k) !== c) { m.delete(k); bad.add(k); continue; }
      m.set(k, c);
    }
  }
  return m;
}
const canonUnitOf = (u, units) => { const k = normUnit(u); return units?.aliasMap?.get(k) || k; };

// Латинські літери, що виглядають як кириличні («M14» ↔ «М14»), — лише для порівняння значень.
const HOMO = { a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", y: "у", i: "і", k: "к", m: "м", h: "н", t: "т", b: "в" };
/** Однозначна технічна нормалізація значення для порівняння UA ↔ RU (власник, 23.10.2026): HTML-сутності, регістр,
 *  декоративні символи на початку («✔»), лапки, десятковий роздільник, пробіли в числах і діапазонах, одиниці
 *  (синоніми одиниць), латиниця-двійник кирилиці, кінцева пунктуація. Значення для Prom не змінюється. */
export function normValue(v, names = null) {
  // Невидимі символи й типографські пробіли; «²» / «³» = «2» / «3» (м/с² = м/с2) — однозначна технічна нормалізація.
  let s = htmlText(v).replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "").replace(/[\u00a0\u2000-\u200a\u202f]/g, " ").replace(/²/g, "2").replace(/³/g, "3").toLowerCase().replace(/ё/g, "е").replace(/[’ʼ`´]/g, "'");
  s = s.replace(/^[\s✔✓✅☑•·*–—-]+/u, "").replace(/[«»"“”„]/g, "");
  s = s.replace(/(\d)\s*[–—-]\s*(\d)/g, "$1-$2").replace(/(\d)[\s  ](?=\d{3}(?!\d))/g, "$1").replace(/(\d),(\d)/g, "$1.$2");
  s = s.replace(/(\d)\s+%/g, "$1%"); // «75 %» = «75%»
  // «0;8 кг» = «0,8 кг»: «;» як десятковий роздільник — лише ізольована пара цифр; ланцюжок «17;19;21;23» — перелік, не змінюється.
  s = s.replace(/(?<![\d;])(\d+);(\d+)(?![\d;])/g, "$1.$2");
  s = s.replace(/(\d)\s*([a-zа-яіїєґ°℃²³*·]+(?:\.?\/?[a-zа-яіїєґ°²³]+)*)\.?/giu, (all, d, u) => `${d} ${names?.unitKnown?.(u) ? names.unitCanon(u) : u}`);
  // «5.0» = «5», «1.50» = «1.5» (технічно однакові числа).
  s = s.replace(/(\d+)\.(\d*?)0+(?!\d)/g, (m, a, b) => (b ? a + "." + b : a));
  s = s.replace(/[a-z]/g, (ch) => HOMO[ch] || ch);
  return s.replace(/\s+/g, " ").replace(/\s*\/\s*/g, "/").replace(/\s*([,;])\s*/g, "$1 ").replace(/[\s.,;:!]+$/, "").trim();
}

/** Підтверджені відповідності UA/RU (у порядку пріоритету власника): 1) офіційні nameUK / nameRU атрибутів і
 *  варіантів значень з усіх схем Prom; 2) погоджений словник (names-ua-ru.json: names, values); 3) технічна
 *  нормалізація (normValue, синоніми одиниць). Назва / значення з різними відповідниками в різних схемах —
 *  неоднозначні й не використовуються. */
export function buildNames(schemas, approved = {}, aliasMap = new Map(), approvedValues = {}, approvedInContext = {}, conversions = [], wordsInContext = {}) {
  const name = new Map(), value = new Map(), unit = new Map();
  const bad = new Set();
  const put = (m, tag, k, v) => {
    if (!k || bad.has(tag + k)) return;
    if (m.has(k) && m.get(k) !== v) { m.delete(k); bad.add(tag + k); return; }
    m.set(k, v);
  };
  for (const s of schemas) for (const a of s.attributes || []) {
    const u = normUnit(a.unitUK || a.unitRU);
    if (u) { put(unit, "u", normUnit(a.unitUK), u); put(unit, "u", normUnit(a.unitRU), u); }
  }
  const unitCanon = (x) => { const k = normUnit(x); return aliasMap.get(k) || unit.get(k) || k; };
  const unitKnown = (x) => { const k = normUnit(x); return aliasMap.has(k) || unit.has(k); };
  const names = { name, value, unit, unitCanon, unitKnown, aliasMap };
  // Погоджені перерахунки одиниць (units.json → conversions) — і для порівняння значень: «4,6 кВт» = «4600 Вт».
  names.conv = new Map((conversions || []).filter((c) => Number.isFinite(c.factor)).map((c) => [`${unitCanon(c.from)}>${unitCanon(c.to)}`, c.factor]));
  for (const s of schemas) for (const a of s.attributes || []) {
    const uk = mtText(a.nameUK || a.nameRU).trim();
    put(name, "n", normName(a.nameUK), uk); put(name, "n", normName(a.nameRU), uk);
    for (const o of a.values || []) { const c = normValue(o.nameUK || o.nameRU, names); put(value, "v", normValue(o.nameUK, names), c); put(value, "v", normValue(o.nameRU, names), c); }
  }
  // Погоджене не перезаписує наявну відповідність своєї української назви (інакше «Вес» → «Вага» зі схеми зникло б).
  for (const [k, v] of Object.entries(approved || {})) { const uk = mtText(v).trim(); name.set(normName(k), uk); if (!name.has(normName(uk))) name.set(normName(uk), uk); }
  for (const [k, v] of Object.entries(approvedValues || {})) { const c = normValue(v, names); value.set(normValue(k, names), c); value.set(c, c); }
  // Значення, погоджені лише для конкретної характеристики (ключ — її назва; поза нею не діють).
  names.lex = buildLexicon(schemas);
  // Значення, які власник погодив ЛИШЕ в контексті (№36, 39, 40), загальне пословне правило не зрівнює.
  names.restricted = new Set(Object.values(approvedInContext || {}).flatMap((vals) => Object.entries(vals || {}).flatMap(([k, v]) => [normValue(k, names), normValue(v, names)])));
  // Відповідності СЛІВ значення, погоджені лише для конкретної характеристики (власник, 25.10.2026: «полуавтомат» =
  // «напівавтомат» для типу зварювального апарата): { "характеристика": { "слово RU": "слово UA" } }.
  names.wordsIn = new Map(Object.entries(wordsInContext || {}).map(([ch, w]) => [normName(ch), new Map(Object.entries(w || {}).map(([ru, ua]) => [normName(ru), normName(ua)]))]));
  names.valueIn = new Map(Object.entries(approvedInContext || {}).map(([ch, vals]) => [normName(ch), new Map(Object.entries(vals || {}).flatMap(([k, v]) => { const c = normValue(v, names); return [[normValue(k, names), c], [c, c]]; }))]));
  return names;
}
// Відповідність назв — до кінцевої форми (ланцюжок «Источник питания» → «Джерело живлення» → «Живлення»), інакше ключі
// тієї самої характеристики розходяться й виникають дублі. Зациклення неможливе (обмеження кроків).
const canonName = (names, n) => {
  let cur = mtText(n).trim();
  for (let i = 0; i < 5; i++) { const next = names?.name.get(normName(cur)); if (!next || normName(next) === normName(cur)) break; cur = next; }
  return cur;
};
const unitC = (u, names) => (names?.unitCanon ? names.unitCanon(u) : normUnit(u));
function numUnit(p, names) {
  let v = htmlText(p.value).trim(), u = htmlText(p.unit).trim();
  if (!u) { const s = splitValueUnit(v); if (s) { v = s.num; u = s.unit; } }
  const n = parseNumber(v);
  if (n === null) return null;
  return { n, u: unitC(u.replace(/[.\s]+$/, ""), names) };
}
// Те саме число після погодженого перерахунку одиниці (кВт ↔ Вт, кг ↔ г, см ↔ мм).
const convOk = (x, y, names) => { const f = names?.conv?.get(`${x.u}>${y.u}`); return f !== undefined && Math.abs(round6(x.n * f) - y.n) < 1e-9; };
const qtyEq = (x, y, names) => (x.n === y.n && x.u === y.u) || convOk(x, y, names);
/** Величина значення: одне число з одиницею («4,6 кВт») або кілька записів ТІЄЇ САМОЇ величини через « / »
 *  («3000 Вт / 3 кВт» — усі частини рівні після погодженого перерахунку) → перша частина; інакше null.
 *  «50/60 Гц», «220 / 380 В», «62 дБ на 7 м» — не одна величина. */
function quantity(p, names) {
  const one = numUnit(p, names);
  if (one) return one;
  if (mtText(p.unit).trim()) return null;
  const parts = htmlText(p.value).split(/\s+\/\s+/);
  if (parts.length < 2) return null;
  const qs = parts.map((v) => numUnit({ value: v, unit: "" }, names));
  if (qs.some((q) => !q || !q.u)) return null;
  return qs.every((q) => qtyEq(q, qs[0], names) || qtyEq(qs[0], q, names)) ? qs[0] : null;
}
// ---------- пословна відповідність UA/RU (власник, 24.10.2026: дублі через мову не передавати) ----------
// Слова — з офіційних пар Prom (nameUK / nameRU атрибутів і варіантів значень усіх схем; однакова кількість слів →
// відповідність за позицією в парі). Використовується лише однозначний переклад слова (одне UA-слово або ≥ 90 % і ≥ 2).
const WORD_RE = /[a-zа-яіїєґ']+|\d+(?:\.\d+)?/g;
const wordsOf = (s) => normName(htmlText(s)).replace(/ё/g, "е").replace(/(\d),(\d)/g, "$1.$2").match(WORD_RE) || [];
function buildLexicon(schemas) {
  const all = new Map();
  const add = (ua, ru) => { const a = wordsOf(ua), b = wordsOf(ru); if (!a.length || a.length !== b.length) return; a.forEach((w, i) => { if (w === b[i]) return; const m = all.get(b[i]) || new Map(); m.set(w, (m.get(w) || 0) + 1); all.set(b[i], m); }); };
  for (const s of schemas) for (const at of s.attributes || []) { if (at.nameUK && at.nameRU) add(at.nameUK, at.nameRU); for (const o of at.values || []) if (o.nameUK && o.nameRU) add(o.nameUK, o.nameRU); }
  const lex = new Map();
  for (const [ru, m] of all) { const tot = [...m.values()].reduce((s, n) => s + n, 0); const [ua, n] = [...m].sort((x, y) => y[1] - x[1])[0]; if (m.size === 1 || (n / tot >= 0.9 && n >= 2)) lex.set(ru, ua); }
  return lex;
}
// Те саме слово в українському й російському написанні («аппарата» / «апарата», «стол» / «стіл», «цифровой» / «цифровий»):
// однаковий кістяк приголосних; лише слова від 4 літер. Різні слова («загрузки» / «завантаження») так не збігаються.
// Подвоєні літери стискаються ДО вилучення голосних («аппарата» = «апарата»), інакше «переразряду» (п-р-р-з-р-д) збіглося б
// з «перезаряду» (п-р-з-р-д) — це різні слова (перевірка каталогу 24.10.2026).
// Форма слова — кістяк з місцями голосних (без закінчення): «вхідного» / «вихідного» мають однаковий кістяк, але різну
// форму; подвоєна літера («мініімальна» / «мінімальна») форми не змінює.
const collapse = (w) => w.replace(/(.)\1+/g, "$1");
// Лише початок слова (до третього приголосного): закінчення й випадні голосні («присосок» / «присоска») не важать,
// а різні префікси («вх-» / «вих-») — так.
const shape = (w) => { const s = collapse(w).replace(/[йьъ']/g, "").replace(/ґ/g, "г").replace(/[аеёиіїоуыэюяє]+/g, "·"); let n = 0, i = 0; for (; i < s.length && n < 3; i++) if (s[i] !== "·") n++; return s.slice(0, i); };
const skeleton = (w) => w.replace(/(.)\1+/g, "$1").replace(/[аеёиіїоуыэюяєьъй']/g, "").replace(/ґ/g, "г");
// Та сама основа: слово без типового закінчення (від 4 літер) — початок іншого: «перегріву» → «перегрів» ⊂ «перегрівання»,
// «обертання» → «оберт» ⊂ «обертів», «інверторний» → «інвертор» ⊂ «інверторне»; «перегріву» / «перегрузки» — ні
// (спільне лише «перегр», корені різні).
const ENDING_RE = /(ування|ювання|ання|яння|ення|іння|ового|ьного|ного|ому|ого|ими|ами|ями|ний|ній|ная|ное|ный|ій|ий|ая|ое|ый|ів|ов|ей|ою|ею|ам|ям|ах|ях|а|я|у|ю|і|и|е|о|ь|й|ы)$/;
const stemOf = (w) => w.replace(ENDING_RE, "");
const sameStem = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i >= 4 && a.length - i <= 3 && b.length - i <= 3) return true; // «споживана» / «споживча», «задніх» / «задний»
  const sa = stemOf(a), sb = stemOf(b);
  return (sa.length >= 4 && b.startsWith(sa)) || (sb.length >= 4 && a.startsWith(sb));
};
function wordEq(ua, ru, lex) {
  if (ua === ru) return true;
  if (/^\d/.test(ua) || /^\d/.test(ru)) return false; // числа — лише точний збіг
  const t = lex?.get(ru);
  if (t && (t === ua || sameStem(t, ua))) return true; // офіційний переклад слова (рід / відмінок — та сама основа)
  if (collapse(ua) === collapse(ru)) return true; // подвоєна літера, зокрема в коротких словах: «Ват» / «Ватт»
  // І ті самі місця голосних між приголосними: «вхідного» (вх·дн·г) ≠ «вихідного» / «выходного» (в·х·дн·г) — різні слова.
  if (ua.length >= 4 && ru.length >= 4) { const s = skeleton(ua); if (s.length >= 2 && s === skeleton(ru) && shape(ua) === shape(ru)) return true; }
  return false;
}
/** Назви (або значення) UA та RU — те саме, слово в слово: однакова кількість слів і кожне — те саме, офіційний переклад
 *  Prom або те саме слово в іншому написанні. Числа — лише точний збіг. Самого збігу чисел / позиції недостатньо. */
export function wordsMatch(ua, ru, names = null) {
  const a = wordsOf(ua), b = wordsOf(ru);
  if (!a.length || a.length !== b.length || !a.some((w) => !/^\d/.test(w))) return false;
  return a.every((w, i) => wordEq(w, b[i], names?.lex));
}
/** Значення UA та RU — ті самі слова в іншому порядку («інверторний зварювальний напівавтомат» / «сварочный инверторный
 *  полуавтомат»): повний зміст — кожне слово має свою пару (wordEq), без повторного використання; числа — точно.
 *  Лише для значень (власник, 24.10.2026: перевіряти еквівалентність повного змісту, а не лише порядок слів). */
export function wordsMatchAnyOrder(ua, ru, names = null) {
  const a = wordsOf(ua), b = wordsOf(ru);
  if (!a.length || a.length !== b.length || a.length > 8 || !a.some((w) => !/^\d/.test(w))) return false;
  const used = new Array(b.length).fill(false);
  const go = (i) => {
    if (i === a.length) return true;
    for (let j = 0; j < b.length; j++) {
      if (used[j] || !(wordEq(a[i], b[j], names?.lex) || wordEq(b[j], a[i], names?.lex))) continue;
      used[j] = true;
      if (go(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return go(0);
}
/** Те саме значення (UA ↔ RU): однакове після технічної нормалізації, так/ні, те саме число з тією самою одиницею
 *  (з урахуванням синонімів одиниць), або підтверджені UA/RU-варіанти того самого значення (схеми Prom, погоджений
 *  словник). Непідтверджений переклад не вважається тим самим значенням. */
export function sameValue(a, b, names = null) {
  const t = (p) => normValue(`${mtText(p.value)}${mtText(p.unit) ? " " + mtText(p.unit) : ""}`, names);
  const ta = t(a), tb = t(b);
  if (ta === tb) return true;
  const yn = (x) => (YES.has(x) ? 1 : NO.has(x) ? 0 : null);
  if (yn(ta) !== null && yn(ta) === yn(tb)) return true;
  const na = quantity(a, names), nb = quantity(b, names);
  if (na && nb) return qtyEq(na, nb, names) || qtyEq(nb, na, names);
  const ca = names?.value.get(ta);
  if (ca && ca === names?.value.get(tb)) return true;
  // Те саме значення слово в слово (офіційні переклади слів Prom / те саме слово в UA- і RU-написанні; числа — точно).
  if (names?.restricted?.has(ta) || names?.restricted?.has(tb)) return false;
  return wordsMatch(ta, tb, names) || wordsMatch(tb, ta, names) || wordsMatchAnyOrder(ta, tb, names);
}
/** sameValue + значення, погоджені лише для цієї характеристики (keys — можливі назви характеристики: ключ, назви UA / RU). */
export function sameValueIn(keys, a, b, names = null) {
  if (sameValue(a, b, names)) return true;
  const t = (p) => normValue(`${mtText(p.value)}${mtText(p.unit) ? " " + mtText(p.unit) : ""}`, names);
  for (const k of keys) {
    // Погоджені слова в контексті характеристики: повний зміст, кожне слово має пару (жодне не суперечить).
    const w = names?.wordsIn?.get(normName(k));
    if (w && wordsMatchAnyOrder(t(a), t(b), { ...names, lex: new Map([...(names.lex || []), ...w]) })) return true;
    const m = names?.valueIn?.get(normName(k));
    if (!m) continue;
    const ca = m.get(t(a)) ?? t(a), cb = m.get(t(b)) ?? t(b);
    if (ca === cb) return true;
    // У цьому контексті погоджене значення «так» (напр. «Есть» = «Має») — так само «так» («Має» = «Так»).
    const yesIn = (c) => YES.has(c) || [...m].some(([src, dst]) => dst === c && YES.has(src));
    if (yesIn(ca) && yesIn(cb)) return true;
  }
  return false;
}
// Те саме число з сумісною одиницею (або одиниця лише з одного боку): «50 Гц» ≠ «50 GHz», «36 міс» = «36 місяців».
const numEq = (a, b, names) => { const x = quantity(a, names), y = quantity(b, names); return Boolean(x && y && ((x.n === y.n && (!x.u || !y.u || unitsCompatible(x.u, y.u))) || convOk(x, y, names) || convOk(y, x, names))); };
// Ознаки «те саме значення під іншою назвою» (для пар з опису проти інших джерел): число з сумісною одиницею
// (одна — початок іншої: «міс» / «місяців», «м/с» / «м/сек»), зокрема всередині тексту («0,55 кВт / 550 Вт»);
// помітне число без одиниці (≥ 10 або дробове); однаковий змістовний текст (від 4 символів, не так/ні).
const NU_RE = /([-+]?\d+(?:[.,]\d+)?)\s*([a-zа-яіїєґ°²³'/"]+(?:\.\s?[a-zа-яіїєґ]+)?)?/giu;
function numTokens(p, names) {
  const out = [];
  for (const m of `${htmlText(p.value)} ${htmlText(p.unit)}`.matchAll(NU_RE)) out.push({ n: Number(m[1].replace(",", ".")), u: m[2] ? unitC(m[2], names) : "" });
  return out;
}
const unitsCompatible = (a, b) => a === b || Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
const SHORT = 60; // число всередині довгого тексту (примітка, опис) — не ознака дубля
function dupEvidence(p, q, names) {
  if (htmlText(p.value).length > SHORT || htmlText(q.value).length > SHORT) return false;
  const a = numTokens(p, names), b = numTokens(q, names);
  for (const x of a) for (const y of b) {
    if (x.n !== y.n) continue;
    if (x.u && y.u && unitsCompatible(x.u, y.u)) return true;
    if ((!x.u || !y.u) && (Math.abs(x.n) >= 10 || !Number.isInteger(x.n)) && a.length === 1 && b.length === 1) return true;
  }
  if (a.length || b.length) return false;
  const ta = normValue(p.value, names), tb = normValue(q.value, names);
  if (ta.length < 4 || YES.has(ta) || NO.has(ta)) return false;
  return (names?.value.get(ta) || ta) === (names?.value.get(tb) || tb);
}
// Відмінність лише в мові? (числа й латинські слова однакові) — підказка для власника, не рішення.
const tokens = (s) => (htmlText(s).toLowerCase().match(/\d+(?:[.,]\d+)?|[a-z]+/g) || []).map((x) => x.replace(",", ".")).join(" ");

/** Назва гарантійного терміну (без уточнень на кшталт «на акумулятор»; одиниця в назві допускається: «Гарантія, міс»). */
const WARRANTY_RE = /^(гарантія|гарантия|гарантійний термін|гарантийный срок|гарантійний строк|термін гарантії|срок гарантии)(\s*[,(]\s*[^,()\d]{1,12}\)?)?$/;
export const isWarrantyName = (n) => WARRANTY_RE.test(normName(n));

// ---------- тривалість у годинах (власник, 24.10.2026: реальний тест Optimat IE3500) ----------
// Prom машинно переклав «до 4,1 ч» як «до 4,1 рік». Для характеристик ТРИВАЛОСТІ (за назвою) скорочення годин після числа
// («ч», «час»; «год» — лише в українському тексті, бо рос. «год» — рік) → повне українське слово з узгодженням
// («до 4,1 години», «до 5 годин»). Число не змінюється; інші одиниці («хв», «рік», «років», «л/год») — без змін.
const DURATION_RE = /(^|[\s(])(час|часу|время|времени|триваліст[а-яіїєґ]*|продолжительност[а-яё]*|автономн[а-яіїєґё]*|ресурс|напрацювання|наработка)(?![а-яіїєґё'])/;
// Роки (гарантія, термін служби, вік, рік випуску) — не тривалість у годинах.
const YEAR_NAME_RE = /гаранті|гаранти|служб|(^|[\s(])(вік|возраст)(?![а-яіїєґё])|(рік|год) (випуску|выпуска|виробництва|производства)/;
const NOT_DURATION_RE = new RegExp(`${YEAR_NAME_RE.source}|годинник|часы`);
export const isYearName = (n) => YEAR_NAME_RE.test(normName(n));
export const isDurationName = (n) => { const s = normName(n); return DURATION_RE.test(s) && !NOT_DURATION_RE.test(s); };
// Український текст: без рос. літер (ы э ъ ё) і з укр. літерою або укр. словом («Час заряджання», «Час роботи» — без і/ї/є/ґ).
const isUaText = (s) => !/[ыэъё]/i.test(s) && (/[іїєґ]/i.test(s) || /(^|[\s(])(час|роботи|заряджання|заряду|тривалість)(?![а-яіїєґё])/i.test(s));
/** Узгодження з числом: 1 / 21 година, 2–4 / 4,1 години, 5–20 / 11–14 годин. */
export const hoursWord = (num) => {
  if (/[.,]/.test(num)) return "години";
  const n = Number(num) % 100, d = n % 10;
  return n >= 11 && n <= 14 ? "годин" : d === 1 ? "година" : d >= 2 && d <= 4 ? "години" : "годин";
};
const HOURS_RE = /(\d+(?:[.,]\d+)?)(\s*)(ч|час|год)\.?(?![a-zа-яіїєґё])/gi;
/** Значення тривалості в годинах — з однозначним записом одиниці (p — { value, unit }; ua — текст українською). */
// Власник, 25.10.2026: у показнику тривалості «год» — години й у російській назві («Максимальное время работы: 5 год»);
// рік — лише для років (гарантія, термін служби, вік, рік випуску — YEAR_NAME_RE). Параметр ua лишено для сумісності.
export function hoursValue(name, p, ua) {
  if (!isDurationName(name)) return p;
  const value = mtText(p.value).replace(HOURS_RE, (all, num) => `${num} ${hoursWord(num)}`);
  let unit = mtText(p.unit);
  const u = unit.trim().replace(/\.$/, "").toLowerCase();
  if ((u === "ч" || u === "час" || u === "год") && /\d/.test(value)) { const nums = value.match(/\d+(?:[.,]\d+)?/g); unit = hoursWord(nums[nums.length - 1]); }
  return value === mtText(p.value) && unit === mtText(p.unit) ? p : { ...p, value, unit };
}
/** Узгодження з числом для років: 1 / 21 рік, 2–4 роки, 5–20 років, дробові — року; календарний рік («2023») — рік. */
export const yearsWord = (num, calendar = false) => {
  if (calendar) return "рік";
  if (/[.,]/.test(num)) return "року";
  const n = Number(num) % 100, d = n % 10;
  return n >= 11 && n <= 14 ? "років" : d === 1 ? "рік" : d >= 2 && d <= 4 ? "роки" : "років";
};
const YEARS_RE = /(\d+(?:[.,]\d+)?)\s*(год|г)\.?(?![a-zа-яіїєґё])/gi;
/** Роки (гарантія, термін служби, вік, рік випуску): неоднозначне «год» / «г.» після числа → «рік / роки / років».
 *  «лет», «года», «років» (однозначні) — без змін. */
export function yearsValue(name, p) {
  if (!isYearName(name)) return p;
  const cal = /випуску|выпуска|виробництва|производства/.test(normName(name));
  const value = mtText(p.value).replace(YEARS_RE, (all, num) => `${num} ${yearsWord(num, cal && Number(num) >= 1000)}`);
  return value === mtText(p.value) ? p : { ...p, value };
}
/** Однозначний запис одиниць часу (години — для тривалості, роки — для років). */
export const timeValue = (name, p, ua) => yearsValue(name, hoursValue(name, p, ua));
// Скорочення годин у короткому значенні характеристики, що не є ні тривалістю, ні роками, — неоднозначно (ПОТРЕБУЄ ПЕРЕВІРКИ).
const HOUR_TOKEN_RE = /\d\s*(ч|час|год)\.?(?![a-zа-яіїєґё])/i;
export const timeAmbiguous = (name, p) => !isDurationName(name) && !isYearName(name) && htmlText(p.value).length <= 60 && HOUR_TOKEN_RE.test(`${htmlText(p.value)} ${htmlText(p.unit)}`);

/** Вирівнювання пар UA- і RU-опису (описи — переклади одне одного, порядок пар однаковий). Найкраще впорядковане
 *  зіставлення: 2 — та сама підтверджена назва, 1 — те саме значення (після нормалізації); між сусідніми
 *  зіставленими парами рівні за довжиною проміжки зіставляються по порядку (0 — «за позицією», значення різні).
 *  Повертає [{ u, r, s }]. */
export function alignPairs(U, R, score) {
  const n = U.length, m = R.length;
  if (!n || !m) return [];
  const S = U.map((u) => R.map((r) => score(u, r)));
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], S[i][j] ? S[i][j] + dp[i + 1][j + 1] : 0);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (S[i][j] && dp[i][j] === S[i][j] + dp[i + 1][j + 1]) { out.push({ i, j, s: S[i][j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const res = out.map(({ i, j, s }) => ({ u: U[i], r: R[j], s }));
  const bounds = [{ i: -1, j: -1 }, ...out, { i: n, j: m }];
  for (let k = 1; k < bounds.length; k++) {
    const a = bounds[k - 1], b = bounds[k], du = b.i - a.i - 1, dr = b.j - a.j - 1;
    if (du > 0 && du === dr) for (let t = 1; t <= du; t++) res.push({ u: U[a.i + t], r: R[a.j + t], s: 0 });
  }
  return res;
}

/**
 * Підготовлені характеристики для Prom.
 *  schema — схема категорії (або null); categoryId — поточна категорія товару;
 *  rawParams — актуальні характеристики XML постачальника; descUa / descRu — оригінальний опис постачальника;
 *  current — поточні «Характеристики JSON»; provenance — поточне «Походження характеристик JSON» (рядок або об'єкт);
 *  names — підтверджені UA/RU відповідності (buildNames; loadPromCatalog().names);
 *  mode — "main": без схеми нічого не змінюється (підготовлені дані не втрачаються через відсутність схеми);
 *         "queue": без схеми сирі характеристики копіюються як раніше (якщо їх не редагували вручну).
 *
 *  Правила власника (23.10.2026, третє уточнення): максимально всі характеристики постачальника — у Prom. Поле категорії,
 *  якщо значення проходить технічну перевірку схеми; інакше — користувацька з ОРИГІНАЛЬНИМ значенням (назва — офіційна
 *  назва атрибута або підтверджена українська відповідність). Достовірність значень не оцінюється. Та сама характеристика
 *  в UA- і RU-описі (за підтвердженою відповідністю назв): однакові значення — одна характеристика з українською назвою;
 *  різні — «ПОТРЕБУЄ ПЕРЕВІРКИ» (needsReview, обидва оригінали), нічого не вибирається. Дублікати не створюються.
 */
export function buildCharacteristics({ schema = null, categoryId = "", rawParams = [], descUa = "", descRu = "", current = [], provenance = null, mapping = null, units = null, names = null, mode = "queue" }) {
  const cur = asParams(typeof current === "string" ? jsonOr(current, []) : current);
  const raw = asParams(rawParams);
  const prov = typeof provenance === "string" ? readProvenance(provenance) : provenance;
  const notes = [];
  const unchanged = { params: cur, provenance: prov, notes, ambiguous: [], conflicts: [], duplicates: [], merged: [], overflow: [], rawOnly: [], customAttrNames: [], needsReview: [], warranty: null, uaRuMerged: 0, proposals: { names: [], values: [], synonyms: [], lexDiff: [] }, lexMerged: [], aligned: 0, positionalCandidates: 0, ruOnly: 0, ruDup: [], removed: [], descRanges: { ua: [], ru: [] }, changed: false, unmapped: [], emptyDesc: [], timeFixed: [] };
  if (!schema && mode === "main") { notes.push(`немає схеми категорії ${categoryId || "?"} — підготовлені характеристики не змінено`); return unchanged; }
  const opt = { mapping, units };
  const fmt = (p) => `${p.name}: ${p.value}${p.unit ? " " + p.unit : ""}`;
  const timeFixed = new Map(); // виправлені записи тривалості в годинах (для звіту)
  const hv = (name, p, ua) => { const r = timeValue(name, p, ua); if (r !== p) timeFixed.set(`${name}${p.value}${p.unit}`, { name, from: `${p.value}${p.unit ? " " + p.unit : ""}`, to: `${r.value}${r.unit ? " " + r.unit : ""}` }); return r; };
  // Поле з відомою вадою довідника Prom → погоджена назва користувацької (known-issues.json → customName).
  const blockedOf = (n) => { const a = schema && resolveAttr(schema, n, mapping).attr; return (a && mapping?.blocked?.[a.id]) || null; };
  const nameOf = (n) => (schema ? blockedOf(n)?.customName || canonName(names, n) : mtText(n).trim()); // без схеми — як є (сира копія)
  const attrByName = (n) => { if (!schema) return null; const a = resolveAttr(schema, n, mapping).attr; return a && !mapping?.blocked?.[a.id] ? a : null; };
  // Ключ характеристики: офіційна українська назва атрибута категорії або підтверджена українська відповідність назви.
  const keyOf = (n, attr = attrByName(n)) => normName(attr ? attr.nameUK || attr.nameRU : nameOf(n));

  // 1. Поля категорії: XML, потім опис. Користувацькі кандидати (extras): XML, потім опис.
  const cand = new Map(); // attrId → { out, src, frags: {ua:[], ru:[]}, from }
  const ambiguous = new Set(), conflicts = [], unmapped = [], needsReview = [], unitScale = new Set();
  // kind (для звіту власнику, не для рішення): «конфлікт» — різні числа / латиниця або два значення в одному джерелі;
  // «переклад?» — числа й латиниця однакові, різняться слова; «слова різні» — чисел і латиниці немає, тож переклад
  // це чи інший зміст — не визначити. Переклад не підтверджено — нічого не вибирається.
  const review = (name, values, reason) => needsReview.push({ name, values, reason, kind: /можливо, лише переклад/.test(reason) ? "переклад?" : /не визначити/.test(reason) ? "слова різні" : "конфлікт" });
  const hint = (a, b) => { const ta = tokens(a), tb = tokens(b); return ta !== tb ? "" : ta ? " (числа й латиниця однакові — можливо, лише переклад)" : " (без чисел і латиниці — переклад чи інший зміст, не визначити)"; };
  let uaRuMerged = 0; // та сама характеристика в UA- і RU-описі з однаковим значенням → одна
  const aligned = [], gapProps = [], valueProps = [], ruOnly = [], warrantyDesc = [], lexMerged = [], lexDiff = [], emptyDesc = []; // вирівняні пари UA/RU; пропозиції словника; лише RU
  const extras = new Map(); // ключ → { out, src, from, blocked, why }
  const extra = (key, out, src, from, more = {}) => {
    if (!key) return;
    const prev = extras.get(key);
    if (!prev) { extras.set(key, { out, src, from, ...more }); return; }
    if (prev.unitDefect) {
      // XML з одиницею з вадою довідника («50 GHz») — те саме число з правильною одиницею в описі («50 Гц») замінює його.
      const d = prev.unitDefect, q = quantity(out, names);
      if (src === SRC.DESC && q && q.n === quantity(prev.out, names)?.n && q.u === unitC(d.realUnit, names)) {
        extras.set(key, { out, src, from: prev.from, ...more });
        notes.push(`«${prev.out.name}»: одиниця XML «${prev.out.unit}» — вада довідника Prom; значення з опису «${fmt(out)}»`);
      }
      return;
    }
    if (sameValue(prev.out, out, names)) return; // та сама характеристика ще раз
    if (prev.src === SRC.RAW && src === SRC.DESC) { conflicts.push(`опис суперечить XML для «${prev.out.name}» — взято XML`); return; }
    review(prev.out.name, [{ src: "XML", value: fmt(prev.out) }, { src: "XML", value: fmt(out) }], "постачальник передав різні значення");
    prev.blocked = true; prev.why = "ПОТРЕБУЄ ПЕРЕВІРКИ: постачальник передав різні значення";
  };
  if (schema) {
    for (const p of raw) {
      const m = mapParam(schema, p, opt);
      if (!m.ok) {
        unmapped.push({ name: p.name, reason: m.reason });
        // Не проходить поле категорії → користувацька з оригінальним значенням.
        const name = m.blocked ? m.blocked.customName : m.attr ? m.attr.nameUK || m.attr.nameRU : nameOf(p.name);
        const out = hv(name, { name, value: cleanValue(p.value), unit: p.unit }, isUaText(p.name));
        // Одиниця постачальника = одиниця з вадою довідника («GHz») — значення не передаємо без підтвердження з опису.
        const defect = m.blocked && (m.blocked.wrongUnits || []).some((u) => normUnit(u) === normUnit(p.unit) || normUnit(splitValueUnit(p.value)?.unit) === normUnit(u));
        extra(normName(name), out, SRC.RAW, itemKey(p), { lang: "xml", ...(defect ? { unitDefect: m.blocked } : {}) });
        continue;
      }
      const prev = cand.get(m.attr.id);
      if (prev && itemKey(prev.out) !== itemKey(m.out)) {
        ambiguous.add(m.attr.id); conflicts.push(`XML: кілька різних значень для «${m.out.name}»`);
        review(m.out.name, [{ src: "XML", value: fmt(prev.out) }, { src: "XML", value: fmt(m.out) }], "постачальник передав різні значення");
        continue;
      }
      if (!prev) cand.set(m.attr.id, { out: m.out, src: SRC.XML, frags: { ua: [], ru: [] }, from: itemKey(p) });
    }
    const pairs = [];
    for (const [lang, html] of [["ua", descUa], ["ru", descRu]]) for (const pr of descriptionPairs(html)) {
      // Значення без змісту (лише невидимі символи напрямку тексту: «&lrm;&lrm») — на вітрину не передається; оригінал — у сирому описі.
      if (!cleanValue(pr.value)) { notes.push(`опис ${lang.toUpperCase()}: «${pr.key}» — значення без змісту (лише невидимі символи), не передається`); emptyDesc.push({ lang, key: pr.key, value: pr.value }); continue; }
      const one = { lang, ...pr, m: mapParam(schema, { name: pr.key, value: cleanValue(pr.value), unit: "" }, opt) };
      // Гарантійний термін — лише зі структурованих характеристик (XML, підготовлені, ручні), НЕ з тексту опису
      // (власник, 24.10.2026). Пара з опису не заповнює й не створює гарантію; розбіжність — лише інформаційно.
      if (isWarrantyName(one.m.attr ? one.m.attr.nameUK || one.m.attr.nameRU : nameOf(pr.key)) || isWarrantyName(pr.key)) { warrantyDesc.push(one); continue; }
      pairs.push(one);
    }
    const label = (pr) => ({ src: `опис ${pr.lang.toUpperCase()}`, value: `${pr.key}: ${pr.value}` });
    // 1а-0. Фізична сумісність одиниць (власник, 24.10.2026, «50 GHz» у GTM ZJ5132): поле з XML і пара опису того самого
    // атрибута з ТИМ САМИМ числом, але одиницями однієї величини різного масштабу («50 GHz» ↔ «50 Гц», «50 мм» ↔ «50 см»), —
    // одне з джерел помилилося з одиницею. Поле не заповнюємо й число без перерахунку не передаємо; обидва оригінали —
    // у ПОТРЕБУЄ ПЕРЕВІРКИ. Сумісні одиниці (той самий масштаб або погоджений перерахунок з іншим числом) — без змін.
    const scaleOf = (u) => units?.scale?.get(normUnit(u)) || units?.scale?.get(canonUnitOf(u, units)) || null;
    for (const pr of pairs) {
      const at = pr.m.attr, c = at && cand.get(at.id);
      if (!c || c.src !== SRC.XML) continue;
      const x = splitValueUnit(cleanValue(pr.value)), xn = x ? parseNumber(x.num) : null, yn = parseNumber(c.out.value);
      const sx = x && scaleOf(x.unit), sy = scaleOf(c.out.unit);
      if (xn === null || xn !== yn || !sx || !sy || sx.dim !== sy.dim || sx.f === sy.f) continue;
      if (!unitScale.has(at.id)) review(c.out.name, [{ src: "XML", value: fmt(c.out) }, label(pr)], `одиниці різного масштабу («${c.out.unit}» ≠ «${x.unit}») — помилка одиниці в одному з джерел`);
      ambiguous.add(at.id); unitScale.add(at.id);
      conflicts.push(`«${c.out.name}»: одиниці різного масштабу — XML «${fmt(c.out)}», опис «${pr.value}»`);
    }
    // 1а. Поля категорії з опису (UA і RU того самого атрибута — одне поле; різні значення — ПОТРЕБУЄ ПЕРЕВІРКИ).
    const byAttr = new Map();
    for (const pr of pairs) if (pr.m.ok) byAttr.set(pr.m.attr.id, [...(byAttr.get(pr.m.attr.id) || []), pr]);
    for (const [a, list] of byAttr) {
      const x = cand.get(a);
      if (x && x.src === SRC.XML) {
        for (const pr of list) if (itemKey(x.out) === itemKey(pr.m.out)) x.frags[pr.lang].push([pr.start, pr.end]);
        else conflicts.push(`опис суперечить XML для «${pr.m.out.name}» — взято XML`);
        continue;
      }
      if (ambiguous.has(a)) continue;
      if (new Set(list.map((pr) => itemKey(pr.m.out))).size > 1) {
        ambiguous.add(a); conflicts.push(`опис: різні значення для «${list[0].m.out.name}»`);
        const langs = new Set(list.map((pr) => pr.lang));
        review(list[0].m.out.name, list.map(label), langs.size > 1 ? "UA і RU значення відрізняються" : "різні значення в описі");
        continue;
      }
      if (new Set(list.map((pr) => pr.lang)).size > 1) uaRuMerged++;
      cand.set(a, { out: list[0].m.out, src: SRC.DESC, frags: { ua: list.filter((pr) => pr.lang === "ua").map((pr) => [pr.start, pr.end]), ru: list.filter((pr) => pr.lang === "ru").map((pr) => [pr.start, pr.end]) } });
    }
    for (const a of ambiguous) cand.delete(a);
    // 1б. Користувацькі з опису. UA- і RU-опис — переклади одне одного: пари однієї характеристики — за підтвердженою
    // назвою (схеми Prom / погоджений словник / та сама назва); якщо назву не підтверджено — за позицією в описі
    // (вирівнювання) з тим самим значенням. Лише RU (без UA-відповідника) — передається з оригінальною назвою.
    const scaleOk = (pr) => !(pr.m.attr && unitScale.has(pr.m.attr.id)); // одиниці різного масштабу — лише в ПОТРЕБУЄ ПЕРЕВІРКИ
    const U = pairs.filter((pr) => pr.lang === "ua" && scaleOk(pr)), R = pairs.filter((pr) => pr.lang === "ru" && scaleOk(pr));
    const pk = (pr) => normName(nameOfPair(pr));
    const nameOfPair = (pr) => (pr.m.blocked ? pr.m.blocked.customName : pr.m.attr ? pr.m.attr.nameUK || pr.m.attr.nameRU : nameOf(pr.key));
    const pv = (pr) => hv(nameOfPair(pr), { value: cleanValue(pr.value), unit: "" }, pr.lang === "ua");
    const al = alignPairs(U, R, (u, r) => (pk(u) === pk(r) ? 2 : sameValue(pv(u), pv(r), names) ? 1 : 0));
    const uaKeys = new Set(U.map(pk));
    const dx = { ua: new Map(), ru: new Map() };
    const add = (lang, key, pr, name) => dx[lang].set(key, [...(dx[lang].get(key) || []), { pr, out: { name, value: pv(pr).value, unit: "" } }]);
    // Позиція в описі, однакові числа, латиниця чи «Так/Да» НЕ підтверджують, що це та сама характеристика (власник,
    // 24.10.2026: «Реверс — Так» ≠ «Подсветка — Да»). Вирівнювання — лише джерело ПРОПОЗИЦІЙ для словника; на
    // результат не впливає: непідтверджена RU-пара не об'єднується й не відкидається — передається окремо.
    for (const x of al) if (x.s === 1) aligned.push({ ua: x.u, ru: x.r, how: "та сама позиція й значення" }); else if (x.s === 0) gapProps.push({ ua: x.u, ru: x.r });
    // Пословна відповідність назв (офіційні переклади слів Prom / те саме слово в UA- і RU-написанні): якщо в описі
    // рівно одна така пара й значення еквівалентні — це та сама характеристика (одна, з українською назвою). Якщо значення
    // різні — НЕ зливаємо (відповідність назв не погоджена власником): обидві окремо + пропозиція.
    const lexTwin = (p, list) => { const hits = list.filter((q) => q !== p && wordsMatch(q.lang === "ua" ? q.key : p.key, q.lang === "ua" ? p.key : q.key, names)); return hits.length === 1 ? hits[0] : null; };
    const R2 = new Set(R.map(pk));
    for (const u of U) {
      if (u.m.ok) continue;
      const key = pk(u);
      const f = !R2.has(key) ? lexTwin(u, R.filter((r) => r.m.ok && cand.has(r.m.attr.id))) : null; // UA-назва поза схемою ↔ поле категорії з RU-опису
      if (f && sameValue(pv(u), { value: f.m.out.value, unit: f.m.out.unit }, names)) { lexMerged.push({ ua: u.key, ru: f.key, value: pv(u).value }); add("ua", pk(f), u, nameOfPair(f)); continue; }
      if (f) lexDiff.push({ ua: u.key, ru: f.key, ua_value: pv(u).value, ru_value: pv(f).value });
      add("ua", key, u, nameOfPair(u));
    }
    for (const r of R) {
      if (r.m.ok) continue;
      const key = pk(r);
      if (!uaKeys.has(key)) {
        const t = lexTwin(r, U);
        if (t && sameValue(pv(t), pv(r), names)) { lexMerged.push({ ua: t.key, ru: r.key, value: pv(t).value }); add("ru", pk(t), r, nameOfPair(t)); continue; }
        if (t) lexDiff.push({ ua: t.key, ru: r.key, ua_value: pv(t).value, ru_value: pv(r).value });
        ruOnly.push(r); // підтвердженої UA-відповідності немає — оригінальна назва (або підтверджена українська)
      }
      add("ru", key, r, nameOfPair(r));
    }
    // Значення опису з одиницею з вадою довідника («Частота: 50 GHz» у самому описі) — без підтвердження не передається.
    const dm = (x) => { const b = x.pr.m.blocked, su = splitValueUnit(x.out.value); return b && su && (b.wrongUnits || []).some((w) => normUnit(w) === normUnit(su.unit)) ? { unitDefect: b } : {}; };
    for (const key of new Set([...dx.ua.keys(), ...dx.ru.keys()])) {
      const ua = dx.ua.get(key) || [], ru = dx.ru.get(key) || [];
      const uniq = (l) => l.filter((x, i) => l.findIndex((y) => sameValue(y.out, x.out, names)) === i);
      const u = uniq(ua), r = uniq(ru);
      const orig = [...ua, ...ru].map((x) => label(x.pr));
      const name = (u[0] || r[0]).out.name;
      // Конфлікт значень (власник, 25.10.2026): нічого не вибираємо, але й наявне підготовлене значення картки не прибираємо —
      // ключ «утримується» (наявний запис лишається в підсумку; нового значення до рішення немає). Синхронізацію не блокує.
      const hold = (why) => { if (!extras.has(key)) extras.set(key, { out: (u[0] || r[0]).out, src: SRC.DESC, from: "", blocked: true, held: true, why }); };
      if (u.length > 1 || r.length > 1) { review(name, orig, "різні значення в одному описі"); hold("ПОТРЕБУЄ ПЕРЕВІРКИ: різні значення в одному описі"); continue; }
      if (u.length && r.length) {
        if (!sameValueIn([key, u[0].pr.key, r[0].pr.key, nameOf(r[0].pr.key)], u[0].out, r[0].out, names)) {
          review(name, orig, "UA і RU значення відрізняються" + hint(u[0].out.value, r[0].out.value));
          valueProps.push({ name, ua: u[0].out.value, ru: r[0].out.value });
          hold("ПОТРЕБУЄ ПЕРЕВІРКИ: UA і RU значення відрізняються");
          continue;
        }
        uaRuMerged++;
        extra(key, u[0].out, SRC.DESC, "", { lang: "ua", ...dm(u[0]) }); // перевага українській назві й значенню
      } else if (u.length) extra(key, u[0].out, SRC.DESC, "", { lang: "ua", ...dm(u[0]) });
      else extra(key, r[0].out, SRC.DESC, "", { lang: "ru", ...dm(r[0]) });
    }
    for (const e of extras.values()) {
      // Скорочення годин у характеристиці, що не є ні тривалістю, ні роками (власник, 25.10.2026), — ПОТРЕБУЄ ПЕРЕВІРКИ.
      if (!e.blocked && timeAmbiguous(e.out.name, e.out)) {
        e.blocked = true; e.timeAmb = true;
        e.why = "ПОТРЕБУЄ ПЕРЕВІРКИ: одиниця часу неоднозначна (не тривалість і не роки)";
        review(e.out.name, [{ src: e.src === SRC.DESC ? "опис" : "XML", value: fmt(e.out) }], "одиниця часу «год / ч» у характеристиці, що не є тривалістю чи роками, — неоднозначно");
        continue;
      }
      if (!e.unitDefect) continue;
      e.blocked = true;
      e.why = `ПОТРЕБУЄ ПЕРЕВІРКИ: одиниця «${e.out.unit}» — вада довідника Prom; значення в «${e.unitDefect.realUnit}» в описі немає`;
      review(e.out.name, [{ src: e.src === SRC.DESC ? "опис" : "XML", value: fmt(e.out) }], `одиниця з вадою довідника Prom — без підтвердження в «${e.unitDefect.realUnit}» не передається`);
    }
  } else {
    for (const p of raw) extra(normName(p.name), p, SRC.RAW, itemKey(p)); // без схеми — сира копія як є
  }
  const candByKey = new Map([...cand].map(([a, c]) => [itemKey(c.out), { a, c }]));
  const rawByName = new Map(raw.map((p) => [normName(p.name), p]));
  const rawKeys = new Set(raw.map(itemKey));
  const attrOf = (name) => attrByName(name)?.id || "";
  const attrOfItem = (p) => { if (!schema) return ""; const m = mapParam(schema, p, opt); return m.ok ? m.attr.id : attrOf(p.name); };

  // 2. Походження наявних записів.
  const prevItems = new Map((prov?.items || []).map((i) => [i.k, i]));
  const suppressed = new Set(prov?.x || []);
  const curKeys = new Set(cur.map(itemKey));
  if (prov) for (const i of prov.items) if (AUTO.has(i.s) && !curKeys.has(i.k)) suppressed.add(i.a || "n:" + keyOf(i.k.split("\u0001")[0])); // власник прибрав
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
  const result = [], items = [], langAt = [], used = new Set(), usedKeys = new Map(), removed = [], duplicates = [], merged = [], overflow = [];
  const attrById = (a) => (schema && a ? schema.attributes.find((x) => x.id === a) : null);
  // Еквівалентний запис того самого атрибута (погоджено власником): після перевірки схемою дає те саме значення поля
  // (зокрема RU-назва / RU-варіант / погоджений перерахунок одиниці), або те саме число без одиниці.
  const equivalent = (p, out) => {
    if (itemKey(p) === itemKey(out)) return true;
    const m = schema && mapParam(schema, p, opt);
    if (m?.ok) return itemKey(m.out) === itemKey(out);
    const n = !mtText(p.unit).trim() && !splitValueUnit(p.value) ? parseNumber(p.value) : null;
    return n !== null && n === parseNumber(out.value);
  };
  const push = (p, s, a, lang = "") => {
    if (result.length >= MAX_PARAMS) { overflow.push({ p, reason: `ліміт Prom ${MAX_PARAMS} характеристик на товар` }); return false; }
    result.push(p); items.push({ k: itemKey(p), s, a }); langAt.push(lang); if (a) used.add(a);
    const key = keyOf(p.name, attrById(a) || undefined);
    if (!usedKeys.has(key)) usedKeys.set(key, result.length - 1);
    return true;
  };
  // Дубль об'єднано: лишається поле Prom (додається тут, якщо ще не додане).
  const merge = (x, a) => { const c = cand.get(a); merged.push(`«${fmt(x.p)}» → поле Prom «${fmt(c.out)}»`); if (!used.has(a)) push(c.out, c.src, a); };
  const catChanged = Boolean(prov?.cat && categoryId && prov.cat !== String(categoryId));
  const srcLabel = (s) => (s === SRC.DESC ? "опис" : s === SRC.RAW ? "XML" : s);
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
    if ((x.s === SRC.XML || x.s === SRC.DESC) && x.a) {
      const c = cand.get(x.a);
      if (c && !used.has(x.a)) push(c.out, c.src, x.a);
      else if (c && equivalent(x.p, c.out)) merge(x, x.a);
      else if (c) { conflicts.push(`«${fmt(x.p)}» ≠ поле Prom «${fmt(c.out)}» — обидва збережено`); push(x.p, x.s, ""); }
      else if (ambiguous.has(x.a) && !suppressed.has(x.a)) push(x.p, x.s, x.a); // конфлікт нових значень поля — наявне лишається
      else removed.push(x.p.name);
      continue;
    }
    // RAW / користувацька: якщо тепер зіставляється — підтверджене поле; інакше — актуальна користувацька за ключем.
    const a = x.s === SRC.RAW ? attrOfItem(x.p) : "";
    if (a && cand.has(a)) {
      // Замінюємо полем Prom лише тоді, коли поле виведене саме з цього запису; інакше (поле з іншого параметра
      // постачальника) наявне значення може містити більше даних (напр. «Біметал HSS») — лишаємо його, поле не дублюємо.
      const c = cand.get(a);
      if (c.from === x.k && !used.has(a)) { push(c.out, c.src, a); continue; }
      if (!suppressed.has(a) && equivalent(x.p, c.out)) { merge(x, a); continue; }
      if (used.has(a)) conflicts.push(`«${fmt(x.p)}» ≠ поле Prom «${fmt(c.out)}» — обидва збережено`);
      else { conflicts.push(`«${x.p.name}»: наявне значення «${x.p.value}» залишено; поле Prom «${c.out.value}» не застосовано (інший параметр постачальника)`); used.add(a); }
      const e = extras.get(keyOf(x.p.name)); if (e) e.taken = true;
      push(x.p, SRC.RAW, "");
      continue;
    }
    const key = keyOf(x.p.name), e = extras.get(key);
    const now = x.s === SRC.RAW ? rawByName.get(normName(x.p.name)) : null;
    if (usedKeys.has(key)) {
      const q = result[usedKeys.get(key)];
      if (e) e.taken = true;
      if (sameValue(q, x.p, names) || numEq(q, x.p, names)) { merged.push(`«${fmt(x.p)}» = «${fmt(q)}» — не дублюємо`); continue; }
      review(q.name, [{ src: srcLabel(items[usedKeys.get(key)].s), value: fmt(q) }, { src: srcLabel(x.s), value: fmt(x.p) }], "та сама характеристика з різними значеннями — збережено обидва наявні записи");
      push(x.p, x.s, ""); continue;
    }
    if (e && !e.blocked && !e.taken) { e.taken = true; push(e.out, e.src, "", e.lang); continue; }
    if (e?.unitDefect) { removed.push(x.p.name); continue; } // одиниця з вадою довідника («50 GHz») — не передаємо (погоджено)
    if (now) { if (e) e.taken = true; push(now, SRC.RAW, "", "xml"); continue; }
    if (e?.blocked) { push(x.p, x.s, ""); continue; } // нове значення потребує перевірки — наявне не прибираємо
    removed.push(x.p.name);
  }
  for (const [a, c] of cand) if (!used.has(a) && !suppressed.has(a)) push(c.out, c.src, a);
  // 3а. Нові користувацькі: без дублікатів (та сама характеристика за ключем або те саме значення під іншою назвою).
  // Пари з опису перевіряються проти ІНШИХ джерел (XML, поля, наявні записи); пари одного опису між собою — ні
  // (постачальник сам перелічив різні характеристики, напр. матеріали різних деталей).
  const descIdx = new Set(), synProps = [];
  for (const [key, e] of extras) {
    if (e.taken || e.blocked) continue;
    if (suppressed.has("n:" + key)) { e.why = "користувацьку характеристику прибрав власник"; continue; }
    const at = usedKeys.get(key);
    if (at !== undefined) {
      const q = result[at];
      if (sameValueIn([key, q.name, e.out.name], q, e.out, names) || numEq(q, e.out, names)) { e.taken = true; merged.push(`«${fmt(e.out)}» (${srcLabel(e.src)}) = «${fmt(q)}» — не дублюємо`); continue; }
      review(q.name, [{ src: srcLabel(items[at].s), value: fmt(q) }, { src: srcLabel(e.src), value: fmt(e.out) }], "значення постачальника відрізняється від наявного — збережено наявне" + hint(q.value, e.out.value));
      e.why = `ПОТРЕБУЄ ПЕРЕВІРКИ: відрізняється від наявного «${fmt(q)}»`;
      continue;
    }
    if (e.src === SRC.DESC) {
      const twin = result.findIndex((q, j) => !descIdx.has(j) && dupEvidence(e.out, q, names));
      // Те саме значення під іншою назвою — НЕ підстава вважати характеристики однаковими (власник: збігу чисел
      // недостатньо; «Потужність двигуна» ≠ «Споживана потужність»). Характеристика передається; пара назв — у
      // пропозиції синонімів на підтвердження власником.
      if (twin >= 0) synProps.push({ name: e.out.name, other: result[twin].name, value: fmt(e.out), otherValue: fmt(result[twin]) });
    }
    // Мовний дубль з ІНШОГО джерела чи мови (XML «Функция» ↔ опис «Функція»; опис RU ↔ XML з українською назвою) з
    // рівнозначним значенням: пословна відповідність назв (як для пар опису) — одна характеристика з українською назвою.
    // Пари однієї мови одного джерела між собою не порівнюються; ручні й невизначені записи не замінюються.
    const lx = result.findIndex((q, j) => !items[j].a && langAt[j] && langAt[j] !== e.lang && (wordsMatch(q.name, e.out.name, names) || wordsMatch(e.out.name, q.name, names)) && sameValueIn([q.name, e.out.name], q, e.out, names));
    if (lx >= 0) {
      const q = result[lx], uaNew = e.lang === "ua" || (langAt[lx] !== "ua" && isUaText(e.out.name) && !isUaText(q.name));
      e.taken = true;
      if (uaNew && langAt[lx] !== "ua" && AUTO.has(items[lx].s)) { result[lx] = e.out; items[lx] = { k: itemKey(e.out), s: e.src, a: "" }; langAt[lx] = e.lang; usedKeys.set(key, lx); }
      lexMerged.push({ ua: uaNew ? e.out.name : q.name, ru: uaNew ? q.name : e.out.name, value: fmt(e.out), cross: true });
      merged.push(`«${fmt(e.out)}» = «${fmt(q)}» — мовний дубль з іншого джерела, не дублюємо`);
      continue;
    }
    if (items.filter((i) => !i.a).length >= MAX_CUSTOM) { overflow.push({ p: e.out, reason: `ліміт Prom ${MAX_CUSTOM} користувацьких характеристик` }); e.why = `ліміт Prom ${MAX_CUSTOM} користувацьких характеристик`; continue; }
    if (push(e.out, e.src, "", e.lang)) { e.taken = true; if (e.src === SRC.DESC) descIdx.add(result.length - 1); } else e.why = `ліміт Prom ${MAX_PARAMS} характеристик на товар`;
  }
  // Гарантія: значення — зі структурованих характеристик; опис — лише інформаційно (не ПОТРЕБУЄ ПЕРЕВІРКИ, не блокує).
  const wIdx = result.findIndex((q, j) => isWarrantyName(q.name) || (items[j].a && isWarrantyName(attrById(items[j].a)?.nameUK || "")));
  const warranty = wIdx >= 0 ? { value: fmt(result[wIdx]), source: items[wIdx].s } : null;
  for (const pr of warrantyDesc) {
    const v = { value: htmlText(pr.value).trim(), unit: "" };
    const same = warranty && (sameValue(result[wIdx], v, names) || numEq(result[wIdx], v, names));
    if (!same) notes.push(`гарантія з опису не використовується (правило: лише з характеристик): опис ${pr.lang.toUpperCase()} «${pr.key}: ${htmlText(pr.value).trim()}»${warranty ? ` ≠ характеристика «${warranty.value}»` : "; у характеристиках гарантії немає"}`);
  }
  const unknownN = classified.filter((x) => x.s === SRC.UNKNOWN).length;
  if (unknownN) notes.push(`походження ${unknownN} характеристик не визначено — збережено без змін`);
  if (removed.length) notes.push("прибрано (постачальник більше не передає / не відповідає категорії): " + removed.join(", "));

  // 4. Кожна характеристика XML постачальника, якої немає в підсумку (ні дослівно, ні полем, ні користувацькою), — з причиною.
  const outKeys = new Set(items.map((i) => i.k));
  const rawOnly = [];
  for (const p of raw) {
    const k = itemKey(p);
    if (outKeys.has(k)) continue;
    const c = [...cand.values()].find((x) => x.from === k);
    if (c && outKeys.has(itemKey(c.out))) continue;
    const e = [...extras.values()].find((x) => x.from === k);
    if (e?.taken) continue;
    const at = usedKeys.get(keyOf(p.name));
    if (at !== undefined && (sameValue(result[at], p, names) || numEq(result[at], p, names) || equivalent(p, result[at]))) continue;
    const pa = schema && attrOfItem(p);
    if (pa && items.some((i, j) => i.a === pa && equivalent(p, result[j]))) continue;
    let reason = e?.why;
    if (!reason) {
      const m = schema ? mapParam(schema, p, opt) : { ok: false };
      if (m.ok && unitScale.has(m.attr.id)) reason = `ПОТРЕБУЄ ПЕРЕВІРКИ: одиниці різного масштабу в XML і описі для поля «${m.out.name}»`;
      else if (m.ok && ambiguous.has(m.attr.id)) reason = `ПОТРЕБУЄ ПЕРЕВІРКИ: кілька різних значень для поля «${m.out.name}»`;
      else if (m.ok && suppressed.has(m.attr.id)) reason = "поле прибрав власник";
      else if (m.ok && used.has(m.attr.id)) reason = `поле «${m.out.name}» уже заповнене нашим значенням (збережено)`;
      else if (at !== undefined) reason = `характеристика вже є зі значенням «${fmt(result[at])}» (збережено наше)`;
      else reason = overflow.length ? "ліміт характеристик Prom" : "не визначено";
    }
    rawOnly.push({ name: p.name, value: p.value, unit: p.unit, reason });
  }
  // 5. Фрагменти опису, перенесені в поля категорії (для очищення СИРОЇ копії опису; користувацькі не прибираються).
  const descRanges = { ua: [], ru: [] };
  items.forEach((it) => { const c = it.a && cand.get(it.a); if (c && itemKey(c.out) === it.k) { descRanges.ua.push(...c.frags.ua); descRanges.ru.push(...c.frags.ru); } });
  // Користувацькі з офіційною назвою атрибута категорії (значення не пройшло схему): за документацією Prom імпортуються
  // як користувацькі — позначаємо для контрольованого імпорту.
  const customAttrNames = schema ? result.filter((p, i) => !items[i].a && attrOf(p.name)).map(fmt) : [];
  const conflictsU = [...new Set(conflicts)]; // те саме з UA- і RU-опису — один раз
  if (overflow.length) notes.push(`не додано через ліміти Prom: ${overflow.length}`);
  const reviewNotes = needsReview.map((r) => `ПОТРЕБУЄ ПЕРЕВІРКИ «${r.name}»: ${r.values.map((v) => `${v.src} «${v.value}»`).join(" / ")} — ${r.reason}`);
  const provenanceOut = { v: 1, cat: String(categoryId || ""), items, x: [...suppressed], notes: [...reviewNotes, ...conflictsU, ...notes].slice(0, 30) };
  return {
    params: result, provenance: provenanceOut, notes, ambiguous: [...ambiguous], conflicts: conflictsU, duplicates, merged, overflow: overflow.map((o) => ({ ...o.p, reason: o.reason })), rawOnly, customAttrNames, needsReview, warranty, uaRuMerged, proposals: { names: [...aligned.map((x) => ({ ua: x.ua.key, ru: x.ru.key, how: x.how, ua_value: htmlText(x.ua.value), ru_value: htmlText(x.ru.value) })), ...gapProps.map((x) => ({ ua: x.ua.key, ru: x.ru.key, how: "за позицією, значення різні", ua_value: htmlText(x.ua.value), ru_value: htmlText(x.ru.value) }))], values: valueProps, synonyms: synProps, lexDiff }, lexMerged, aligned: 0, positionalCandidates: aligned.length + gapProps.length, ruOnly: ruOnly.length, ruDup: [], removed, descRanges, unmapped, emptyDesc, timeFixed: [...timeFixed.values()],
    changed: JSON.stringify(result) !== JSON.stringify(cur),
  };
}

/** Ключ характеристики (для звітів і перевірки повноти): офіційна українська назва атрибута категорії або
 *  підтверджена українська відповідність назви (як у buildCharacteristics). */
export function charKey(schema, name, { mapping = null, names = null } = {}) {
  const attr = schema ? resolveAttr(schema, name, mapping).attr : null;
  return normName(attr ? attr.nameUK || attr.nameRU : schema ? canonName(names, name) : name);
}

/** Ризики перед реальним імпортом у Prom (не змінює характеристик; для підготовки файлу й звіту власнику).
 *  1) Поле категорії з відомою вадою довідника Prom (knownIssues: напр. одиниця «GHz» для частоти мережі).
 *  2) Користувацька з російською назвою, значення якої містить «ч» / «час» / «год» після числа: Prom автоматично
 *     перекладає російські користувацькі на українську й плутає скорочення (у тесті: «до 5 ч» → «до 5 років»). */
export function importRisks({ params = [], provenance = null, categoryId = "", knownIssues = [] } = {}) {
  const out = [];
  const items = provenance?.items || [];
  params.forEach((p, i) => {
    const a = items[i]?.a || "";
    for (const k of knownIssues) if (a && String(k.id) === String(a) && (k.categories || []).map(String).includes(String(categoryId))) out.push({ kind: "вада довідника Prom", param: `${p.name}: ${p.value}${p.unit ? " " + p.unit : ""}`, issue: k.issue });
    const ru = /[ыэъё]/i.test(p.name) || (!/[іїєґ]/i.test(p.name) && /(^|[\s(])(время|работы|нагрузк|питани|мощност|количеств|длина|вес)/i.test(p.name));
    if (!a && ru && /\d\s*(ч|час|часа|часов|год)(?![a-zа-яіїєґё])/i.test(htmlText(p.value))) out.push({ kind: "ризик автоперекладу Prom", param: `${p.name}: ${p.value}`, issue: "російська користувацька з «ч/год» — Prom може перекласти як «рік/років»" });
  });
  return out;
}
