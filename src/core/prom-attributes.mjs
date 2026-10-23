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
const ENT = { nbsp: " ", ndash: "–", mdash: "—", minus: "−", deg: "°", sup1: "¹", sup2: "²", sup3: "³", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", laquo: "«", raquo: "»", times: "×", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", hellip: "…", middot: "·", bull: "•", micro: "µ", prime: "′", Prime: "″", quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", Oslash: "Ø", oslash: "ø", asymp: "≈", le: "≤", ge: "≥", trade: "™", reg: "®", copy: "©" };
/** HTML-сутності → символи (текст так, як його бачить покупець в описі); невідомі лишаються як є. */
export const htmlText = (v) => mtText(v).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, k) => (k[0] === "#" ? String.fromCodePoint(k[1].toLowerCase() === "x" ? parseInt(k.slice(2), 16) : Number(k.slice(1))) : ENT[k] ?? ENT[k.toLowerCase()] ?? all));
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
/** Підтверджені відповідності UA/RU: назви атрибутів, варіантів значень і одиниць з усіх схем Prom (офіційні пари
 *  nameUK / nameRU) + погоджений власником словник назв { "назва": "українська назва" }. Назва, що в різних схемах
 *  має різні українські відповідники, — неоднозначна й не використовується. */
export function buildNames(schemas, approved = {}) {
  const name = new Map(), value = new Map(), unit = new Map();
  const bad = new Set();
  const put = (m, tag, k, v) => {
    if (!k || bad.has(tag + k)) return;
    if (m.has(k) && m.get(k) !== v) { m.delete(k); bad.add(tag + k); return; }
    m.set(k, v);
  };
  for (const s of schemas) for (const a of s.attributes || []) {
    const uk = mtText(a.nameUK || a.nameRU).trim();
    put(name, "n", normName(a.nameUK), uk); put(name, "n", normName(a.nameRU), uk);
    for (const o of a.values || []) { const c = normName(o.nameUK || o.nameRU); put(value, "v", normName(o.nameUK), c); put(value, "v", normName(o.nameRU), c); }
    const u = normUnit(a.unitUK || a.unitRU);
    if (u) { put(unit, "u", normUnit(a.unitUK), u); put(unit, "u", normUnit(a.unitRU), u); }
  }
  for (const [k, v] of Object.entries(approved || {})) { const uk = mtText(v).trim(); name.set(normName(k), uk); name.set(normName(uk), uk); }
  return { name, value, unit };
}
const canonName = (names, n) => names?.name.get(normName(n)) || mtText(n).trim();
function numUnit(p, names) {
  let v = htmlText(p.value).trim(), u = htmlText(p.unit).trim();
  if (!u) { const s = splitValueUnit(v); if (s) { v = s.num; u = s.unit; } }
  const n = parseNumber(v);
  if (n === null) return null;
  const nu = normUnit(u);
  return { n, u: names?.unit.get(nu) || nu };
}
/** Те саме значення (UA ↔ RU): однаковий текст, так/ні, те саме число з тією самою (або UA/RU-парною) одиницею,
 *  або UA/RU-варіанти того самого значення зі схем Prom. Переклад «на око» не вважається тим самим значенням. */
export function sameValue(a, b, names = null) {
  const t = (p) => normName(htmlText(`${mtText(p.value)}${mtText(p.unit) ? " " + mtText(p.unit) : ""}`));
  const ta = t(a), tb = t(b);
  if (ta === tb) return true;
  const yn = (x) => (YES.has(x) ? 1 : NO.has(x) ? 0 : null);
  if (yn(ta) !== null && yn(ta) === yn(tb)) return true;
  const na = numUnit(a, names), nb = numUnit(b, names);
  if (na && nb) return na.n === nb.n && na.u === nb.u;
  const ca = names?.value.get(ta);
  return Boolean(ca && ca === names?.value.get(tb));
}
const numEq = (a, b, names) => { const x = numUnit(a, names), y = numUnit(b, names); return Boolean(x && y && x.n === y.n); };
// Ознаки «те саме значення під іншою назвою» (для пар з опису проти інших джерел): число з сумісною одиницею
// (одна — початок іншої: «міс» / «місяців», «м/с» / «м/сек»), зокрема всередині тексту («0,55 кВт / 550 Вт»);
// помітне число без одиниці (≥ 10 або дробове); однаковий змістовний текст (від 4 символів, не так/ні).
const NU_RE = /([-+]?\d+(?:[.,]\d+)?)\s*([a-zа-яіїєґ°²³'/"]+(?:\.\s?[a-zа-яіїєґ]+)?)?/giu;
function numTokens(p, names) {
  const out = [];
  for (const m of `${htmlText(p.value)} ${htmlText(p.unit)}`.matchAll(NU_RE)) {
    const n = Number(m[1].replace(",", ".")), u = normUnit(m[2] || "");
    out.push({ n, u: names?.unit.get(u) || u });
  }
  return out;
}
// Лише для ВИЯВЛЕННЯ дублів (не для заповнення полів): різні написання тієї самої одиниці.
const DUP_UNIT = { "°c": "град", "°": "град", "градс": "град", "h*m": "нм", "н*м": "нм", "нм": "нм" };
const unitsCompatible = (a, b) => { a = DUP_UNIT[a] || a; b = DUP_UNIT[b] || b; return a === b || Boolean(a && b && (a.startsWith(b) || b.startsWith(a))); };
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
  const t = (v) => normName(htmlText(v.value));
  const ta = t(p), tb = t(q);
  if (ta.length < 4 || YES.has(ta) || NO.has(ta)) return false;
  return (names?.value.get(ta) || ta) === (names?.value.get(tb) || tb);
}
// Відмінність лише в мові? (числа й латинські слова однакові) — підказка для власника, не рішення.
const tokens = (s) => (htmlText(s).toLowerCase().match(/\d+(?:[.,]\d+)?|[a-z]+/g) || []).map((x) => x.replace(",", ".")).join(" ");

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
  const unchanged = { params: cur, provenance: prov, notes, ambiguous: [], conflicts: [], duplicates: [], merged: [], overflow: [], rawOnly: [], customAttrNames: [], needsReview: [], uaRuMerged: 0, ruDup: [], removed: [], descRanges: { ua: [], ru: [] }, changed: false, unmapped: [] };
  if (!schema && mode === "main") { notes.push(`немає схеми категорії ${categoryId || "?"} — підготовлені характеристики не змінено`); return unchanged; }
  const opt = { mapping, units };
  const fmt = (p) => `${p.name}: ${p.value}${p.unit ? " " + p.unit : ""}`;
  const nameOf = (n) => (schema ? canonName(names, n) : mtText(n).trim()); // без схеми — як є (сира копія)
  const attrByName = (n) => (schema ? resolveAttr(schema, n, mapping).attr || null : null);
  // Ключ характеристики: офіційна українська назва атрибута категорії або підтверджена українська відповідність назви.
  const keyOf = (n, attr = attrByName(n)) => normName(attr ? attr.nameUK || attr.nameRU : nameOf(n));

  // 1. Поля категорії: XML, потім опис. Користувацькі кандидати (extras): XML, потім опис.
  const cand = new Map(); // attrId → { out, src, frags: {ua:[], ru:[]}, from }
  const ambiguous = new Set(), conflicts = [], unmapped = [], needsReview = [];
  const review = (name, values, reason) => needsReview.push({ name, values, reason });
  let uaRuMerged = 0; // та сама характеристика в UA- і RU-описі з однаковим значенням → одна
  const ruDup = []; // RU-пари, не додані окремо: в UA-описі є пара з тим самим значенням
  const extras = new Map(); // ключ → { out, src, from, blocked, why }
  const extra = (key, out, src, from, more = {}) => {
    if (!key) return;
    const prev = extras.get(key);
    if (!prev) { extras.set(key, { out, src, from, ...more }); return; }
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
        const name = m.attr ? m.attr.nameUK || m.attr.nameRU : nameOf(p.name);
        extra(normName(name), { name, value: p.value, unit: p.unit }, SRC.RAW, itemKey(p));
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
    for (const [lang, html] of [["ua", descUa], ["ru", descRu]]) for (const pr of descriptionPairs(html)) pairs.push({ lang, ...pr, m: mapParam(schema, { name: pr.key, value: pr.value, unit: "" }, opt) });
    const label = (pr) => ({ src: `опис ${pr.lang.toUpperCase()}`, value: `${pr.key}: ${pr.value}` });
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
    // 1б. Користувацькі з опису: за ключем (офіційна назва атрибута / підтверджена UA-відповідність / та сама назва).
    const dx = { ua: new Map(), ru: new Map() };
    for (const pr of pairs) {
      if (pr.m.ok) continue;
      const attr = pr.m.attr || null;
      const name = attr ? attr.nameUK || attr.nameRU : nameOf(pr.key);
      const confirmed = pr.lang === "ua" || Boolean(attr) || Boolean(names?.name.has(normName(pr.key)));
      const key = normName(name);
      dx[pr.lang].set(key, [...(dx[pr.lang].get(key) || []), { pr, out: { name, value: htmlText(pr.value).trim(), unit: "" }, confirmed }]);
    }
    const uaHas = pairs.some((pr) => pr.lang === "ua");
    for (const key of new Set([...dx.ua.keys(), ...dx.ru.keys()])) {
      const ua = dx.ua.get(key) || [], ru = dx.ru.get(key) || [];
      const uniq = (l) => l.filter((x, i) => l.findIndex((y) => sameValue(y.out, x.out, names)) === i);
      const u = uniq(ua), r = uniq(ru);
      const orig = [...ua, ...ru].map((x) => label(x.pr));
      const name = (u[0] || r[0]).out.name;
      if (u.length > 1 || r.length > 1) { review(name, orig, "різні значення в одному описі"); continue; }
      if (u.length && r.length) {
        if (!sameValue(u[0].out, r[0].out, names)) {
          review(name, orig, "UA і RU значення відрізняються" + (tokens(u[0].out.value) === tokens(r[0].out.value) ? " (числа й латиниця однакові — можливо, лише переклад)" : ""));
          continue;
        }
        uaRuMerged++;
        extra(key, u[0].out, SRC.DESC, ""); // перевага українській назві й значенню
      } else if (u.length) extra(key, u[0].out, SRC.DESC, "", { uaOnly: true });
      else if (!uaHas) extra(key, r[0].out, SRC.DESC, ""); // UA-опису немає — RU-пара єдина (назва — підтверджена UA, якщо є)
      else {
        // Є UA-опис: RU-пару окремо не додаємо (UA-опис — переклад того самого; окремо — це дубль іншою мовою).
        const v = r[0].out.value, tk = tokens(v);
        const twin = pairs.find((pr) => pr.lang === "ua" && (sameValue({ value: pr.value, unit: "" }, r[0].out, names) || (tk && tokens(pr.value) === tk)));
        if (twin) ruDup.push(`«${r[0].pr.key}: ${v}» (опис RU) = «${twin.key}: ${htmlText(twin.value)}» (опис UA)`);
        else review(name, orig, "є лише в RU-описі, відповідності в UA-описі не знайдено — не додано, щоб не задублювати іншою мовою");
      }
    }
    for (const a of ambiguous) cand.delete(a);
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
  const result = [], items = [], used = new Set(), usedKeys = new Map(), removed = [], duplicates = [], merged = [], overflow = [];
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
  const push = (p, s, a) => {
    if (result.length >= MAX_PARAMS) { overflow.push({ p, reason: `ліміт Prom ${MAX_PARAMS} характеристик на товар` }); return false; }
    result.push(p); items.push({ k: itemKey(p), s, a }); if (a) used.add(a);
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
    if (e && !e.blocked && !e.taken) { e.taken = true; push(e.out, e.src, ""); continue; }
    if (now) { if (e) e.taken = true; push(now, SRC.RAW, ""); continue; }
    if (e?.blocked) { push(x.p, x.s, ""); continue; } // нове значення потребує перевірки — наявне не прибираємо
    removed.push(x.p.name);
  }
  for (const [a, c] of cand) if (!used.has(a) && !suppressed.has(a)) push(c.out, c.src, a);
  // 3а. Нові користувацькі: без дублікатів (та сама характеристика за ключем або те саме значення під іншою назвою).
  // Пари з опису перевіряються проти ІНШИХ джерел (XML, поля, наявні записи); пари одного опису між собою — ні
  // (постачальник сам перелічив різні характеристики, напр. матеріали різних деталей).
  const descIdx = new Set();
  const ruOnlyIdx = new Set(items.map((it, j) => { const c = it.a && cand.get(it.a); return c && c.src === SRC.DESC && !c.frags.ua.length && c.frags.ru.length ? j : -1; }).filter((j) => j >= 0));
  const ynOf = (p) => { const t = normName(htmlText(p.value)); return YES.has(t) ? 1 : NO.has(t) ? 0 : null; };
  for (const [key, e] of extras) {
    if (e.taken || e.blocked) continue;
    if (suppressed.has("n:" + key)) { e.why = "користувацьку характеристику прибрав власник"; continue; }
    const at = usedKeys.get(key);
    if (at !== undefined) {
      const q = result[at];
      if (sameValue(q, e.out, names) || numEq(q, e.out, names)) { e.taken = true; merged.push(`«${fmt(e.out)}» (${srcLabel(e.src)}) = «${fmt(q)}» — не дублюємо`); continue; }
      review(q.name, [{ src: srcLabel(items[at].s), value: fmt(q) }, { src: srcLabel(e.src), value: fmt(e.out) }], "значення постачальника відрізняється від наявного — збережено наявне");
      e.why = `ПОТРЕБУЄ ПЕРЕВІРКИ: відрізняється від наявного «${fmt(q)}»`;
      continue;
    }
    if (e.src === SRC.DESC) {
      const twin = result.findIndex((q, j) => !descIdx.has(j) && dupEvidence(e.out, q, names));
      // Так/ні з UA-опису, коли RU-опис дав поля категорії з таким самим так/ні, а UA-опис — ні (назви в UA-описі
      // не збіглися зі схемою): ймовірно, та сама характеристика іншими словами.
      if (twin < 0 && e.uaOnly && ynOf(e.out) !== null) {
        const same = [...ruOnlyIdx].filter((j) => ynOf(result[j]) === ynOf(e.out)).map((j) => result[j].name);
        if (same.length) {
          review(e.out.name, [{ src: "опис UA", value: fmt(e.out) }, { src: "опис RU → поля категорії", value: same.join(", ") }], "так/ні з UA-опису; у RU-описі ті самі так/ні вже стали полями категорії — ймовірно, та сама характеристика іншими словами, не додано");
          e.why = "ПОТРЕБУЄ ПЕРЕВІРКИ: можливий дубль поля з RU-опису";
          continue;
        }
      }
      if (twin >= 0) {
        review(e.out.name, [{ src: srcLabel(items[twin].s), value: fmt(result[twin]) }, { src: srcLabel(e.src), value: fmt(e.out) }], `те саме значення, що й у «${result[twin].name}» — можливий дубль під іншою назвою, не додано`);
        e.why = `ПОТРЕБУЄ ПЕРЕВІРКИ: можливий дубль «${fmt(result[twin])}»`;
        continue;
      }
    }
    if (items.filter((i) => !i.a).length >= MAX_CUSTOM) { overflow.push({ p: e.out, reason: `ліміт Prom ${MAX_CUSTOM} користувацьких характеристик` }); e.why = `ліміт Prom ${MAX_CUSTOM} користувацьких характеристик`; continue; }
    if (push(e.out, e.src, "")) { e.taken = true; if (e.src === SRC.DESC) descIdx.add(result.length - 1); } else e.why = `ліміт Prom ${MAX_PARAMS} характеристик на товар`;
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
      if (m.ok && ambiguous.has(m.attr.id)) reason = `ПОТРЕБУЄ ПЕРЕВІРКИ: кілька різних значень для поля «${m.out.name}»`;
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
    params: result, provenance: provenanceOut, notes, ambiguous: [...ambiguous], conflicts: conflictsU, duplicates, merged, overflow: overflow.map((o) => ({ ...o.p, reason: o.reason })), rawOnly, customAttrNames, needsReview, uaRuMerged, ruDup, removed, descRanges, unmapped,
    changed: JSON.stringify(result) !== JSON.stringify(cur),
  };
}
