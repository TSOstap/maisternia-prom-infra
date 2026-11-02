/** Пріоритет власника (вимоги власника 29.10.2026, «фінальні вимоги» розд. 1–3): попольове керування джерелом значення.
 *
 *  Кожне кероване поле товару (а для характеристик — кожна характеристика окремо) має стан:
 *    S (SUPPLIER) — значення веде постачальник: кожна синхронізація записує запропоноване конвеєром значення;
 *    C (CUSTOM)   — наше значення (ручна зміна власника або погоджене рішення): постачальник його НЕ перезаписує.
 *  Кастомність НЕ визначається нерівністю значень: стан зберігається й змінюється лише подією —
 *    • ручне редагування: подія редагування (onEdit — записи API тригерів не запускають) або розбіжність поточного значення з тим,
 *      що система записала востаннє (хеш `sys`) — відновлення після пропущених подій;
 *    • явна команда власника: «прийняти значення постачальника» (→ S) / «зробити кастомним» (→ C);
 *    • міграція наявного каталогу (окремий звіт невизначеності).
 *  Значення, що збігається з постачальником, лишається C, доки власник явно не поверне S.
 *
 *  Сирі значення постачальника зберігаються завжди (окремі сирі колонки). Якщо сире джерело C-поля змінилось — інформаційне
 *  попередження «було → стало» (без блокування синхронізації, YML чи імпорту); повтор з тим самим сирим значенням нового
 *  попередження не дає (у стані — хеш останнього баченого сирого значення `raw`; ключ попередження — Offer ID + поле + хеш).
 *
 *  Стан зберігається в колонці STATE_COLUMN того самого рядка: рухається разом із рядком (сортування, перенесення з черги в
 *  каталог) і пишеться тим самим записом, що й значення, — без розриву між значенням і його станом.
 *  Модуль чистий: без I/O, без часу (now передається), детермінований. */
import crypto from "node:crypto";
import { mtText } from "./text.mjs";

export const SRC = Object.freeze({ SUPPLIER: "S", CUSTOM: "C" });
export const STATE_COLUMN = "Стан полів JSON";
export const WARNING_MARK_COLUMN = "Попередження постачальника";
export const PARAMS_FIELD = "Характеристики JSON";

/** Керовані поля → сире джерело постачальника (колонка сирих даних у тому самому рядку). raw: null — у постачальника джерела
 *  немає (поле веде лише власник / система; попереджень немає). kind: "text" | "params". */
export const MANAGED_FIELDS = Object.freeze([
  { field: "Назва UA", raw: "Назва постачальника UA", kind: "text" },
  { field: "Назва RU", raw: "Назва постачальника RU", kind: "text" },
  { field: "Опис UA", raw: "Опис постачальника UA", kind: "text" },
  { field: "Опис RU", raw: "Опис постачальника RU", kind: "text" },
  { field: PARAMS_FIELD, raw: "Характеристики постачальника JSON", kind: "params" },
  { field: "Виробник", raw: null, kind: "text" },
  { field: "Запити UA", raw: null, kind: "text" },
  { field: "Запити RU", raw: null, kind: "text" },
]);

const norm = (v) => mtText(v).replace(/\r\n?/g, "\n");
/** Хеш нормалізованого значення (16 hex). Порожнє значення — теж значення (хеш порожнього рядка). */
export const hv = (v) => crypto.createHash("sha256").update(norm(v)).digest("hex").slice(0, 16);

// ---------- стан ----------
export function emptyState() { return { v: 1, f: {}, p: {} }; }
/** Читання стану з клітинки. Пошкоджений стан — не «все постачальника»: позначка bad, і всі поля трактуються як C
 *  (захисно: нічого не перезаписується) до відновлення — це видно у звіті. */
export function readState(cell) {
  const s = mtText(cell).trim();
  if (!s) return emptyState();
  try {
    const o = JSON.parse(s);
    if (o && o.v === 1 && o.f && typeof o.f === "object" && o.p && typeof o.p === "object") return { v: 1, f: { ...o.f }, p: { ...o.p } };
  } catch { /* нижче */ }
  return { ...emptyState(), bad: true };
}
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? sortKeys(o[k]) : o[k]]));
export function writeState(st) { return JSON.stringify(sortKeys({ v: 1, f: st.f || {}, p: st.p || {} })); }
const srcOf = (st, rec) => (st.bad ? SRC.CUSTOM : rec?.s === SRC.CUSTOM ? SRC.CUSTOM : SRC.SUPPLIER);
/** ENG-28c (М2): попереднє сире значення постачальника в рядку порожнє — нове значення є першим заповненням, а не зміною. */
export const firstFill = (rawBefore) => mtText(rawBefore).trim() === "";

// ---------- характеристики ----------
/** Ключ характеристики — нормалізована назва. Дублі назв → null (однозначно ідентифікувати неможливо → рівень поля). */
export const paramKey = (name) => mtText(name).trim().toLowerCase().replace(/\s+/g, " ");
export function parseParams(cell) {
  const s = mtText(cell).trim();
  if (!s) return { ok: true, list: [], map: new Map(), dup: false };
  let list;
  try { list = JSON.parse(s); } catch { return { ok: false, list: [], map: new Map(), dup: false }; }
  if (!Array.isArray(list) || list.some((p) => !p || typeof p !== "object" || !mtText(p.name).trim())) return { ok: false, list: [], map: new Map(), dup: false };
  const map = new Map(); let dup = false;
  for (const p of list) { const k = paramKey(p.name); if (map.has(k)) dup = true; else map.set(k, p); }
  return { ok: true, list, map, dup };
}
const pv = (p) => (p ? hv(JSON.stringify([mtText(p.name).trim(), mtText(p.value).trim(), mtText(p.unit ?? "").trim()])) : "∅");

// ---------- 1. виявлення ручних змін ----------
/**
 * @param {object} o
 * @param {object} o.row       поточний рядок (з таблиці) — { колонка: значення }
 * @param {object} o.state     стан (readState)
 * @param {Set<string>} [o.edited]  колонки цього рядка з подіями ручного редагування (onEdit) після останньої синхронізації
 * @param {string} o.at        час (ISO) для позначки
 * @returns {{ state, changes: Array<{ field, param?, by }> }}
 */
export function detectEdits({ row, state, edited = new Set(), at, fields = MANAGED_FIELDS }) {
  const st = { ...state, f: { ...state.f }, p: { ...state.p } }, changes = [];
  for (const spec of fields) {
    if (!(spec.field in row)) continue;
    if (spec.kind === "params") { detectParams({ row, st, spec, edited, at, changes }); continue; }
    const rec = st.f[spec.field];
    if (!rec) continue; // поле ще не відоме системі (немає запису) — початковий стан задає applySupplier / міграція
    if (srcOf(st, rec) === SRC.CUSTOM) continue;
    if (rec.by === "accept" && !rec.sys) continue; // команда «прийняти постачальника» ще не застосована — не плутати з правкою
    const by = edited.has(spec.field) ? "edit" : hv(row[spec.field]) !== rec.sys ? "diff" : null;
    if (by) { st.f[spec.field] = { ...rec, s: SRC.CUSTOM, at, by }; changes.push({ field: spec.field, by }); }
  }
  return { state: st, changes };
}
function detectParams({ row, st, spec, edited, at, changes }) {
  const rec = st.f[spec.field];
  const cur = parseParams(row[spec.field]);
  if (!cur.ok || cur.dup) {
    // Невалідний JSON або дублі назв: характеристики не можна розібрати поштучно → рівень поля, C (захисно), окрема позначка.
    if (rec?.s !== SRC.CUSTOM && (edited.has(spec.field) || hv(row[spec.field]) !== rec?.sys)) {
      st.f[spec.field] = { ...(rec || {}), s: SRC.CUSTOM, at, by: cur.ok ? "dup-names" : "invalid-json" };
      changes.push({ field: spec.field, by: st.f[spec.field].by });
    }
    return;
  }
  if (rec?.s === SRC.CUSTOM && rec.by !== "invalid-json" && rec.by !== "dup-names") return; // усе поле C — поштучно не дивимось
  const keys = new Set([...cur.map.keys(), ...Object.keys(st.p)]);
  for (const k of keys) {
    const prec = st.p[k];
    if (!prec) { // характеристика, якої система не писала: додана людиною
      if (cur.map.has(k) && rec) { st.p[k] = { s: SRC.CUSTOM, sys: "", raw: null, at, by: "added" }; changes.push({ field: spec.field, param: k, by: "added" }); }
      continue;
    }
    if (srcOf(st, prec) === SRC.CUSTOM) continue;
    if (prec.by === "accept" && !prec.sys) continue;
    if (pv(cur.map.get(k)) !== prec.sys) { st.p[k] = { ...prec, s: SRC.CUSTOM, at, by: cur.map.has(k) ? "diff" : "removed" }; changes.push({ field: spec.field, param: k, by: st.p[k].by }); }
  }
}

// ---------- 2. застосування даних постачальника ----------
/**
 * Об'єднує поточний рядок (після detectEdits) із запропонованим конвеєром рядком (як якби всі поля були S).
 * Сирі колонки, LIVE і службові — завжди із запропонованого (їх веде система). Керовані поля: S → запропоноване; C → поточне.
 * @param {object} o
 * @param {object} o.row       поточний рядок
 * @param {object} o.proposed  запропонований рядок (refresh конвеєра)
 * @param {object} o.state     стан після detectEdits
 * @param {{ offerId, sku, name, source }} o.ctx  для попереджень
 * @param {string} o.at
 * @returns {{ row, state, warnings, rawChanged: string[], anomalies: string[] }}
 *   rawChanged — сирі колонки, значення яких змінилось (для звіту: «змінено сирих полів постачальника»);
 *   anomalies  — запропоноване значення не вдалося застосувати (наприклад, невалідні характеристики від конвеєра) — поле лишено як є.
 */
export function applySupplier({ row, proposed, state, ctx, at, fields = MANAGED_FIELDS }) {
  const st = { ...state, f: { ...state.f }, p: { ...state.p } };
  const out = { ...proposed }, warnings = [], anomalies = [];
  const rawChanged = fields.filter((s) => s.raw && s.raw in proposed && hv(row[s.raw]) !== hv(proposed[s.raw])).map((s) => s.raw);
  const warn = (field, param, before, after, custom) => warnings.push({
    key: `${ctx.offerId}|${field}${param ? "|" + param : ""}|${hv(after)}`, at, offerId: ctx.offerId, sku: ctx.sku ?? "", name: ctx.name ?? "",
    field: param ? `${field}: ${param}` : field, before: mtText(before), after: mtText(after), custom: mtText(custom), source: ctx.source ?? "постачальник",
  });
  for (const spec of fields) {
    if (!(spec.field in proposed) && !(spec.field in row)) continue;
    if (spec.kind === "params") { mergeParams({ row, proposed, out, st, spec, at, warn, anomalies }); continue; }
    const rec = st.f[spec.field];
    const rawAfter = spec.raw ? proposed[spec.raw] : undefined;
    if (srcOf(st, rec) === SRC.SUPPLIER) {
      out[spec.field] = proposed[spec.field];
      st.f[spec.field] = { s: SRC.SUPPLIER, sys: hv(proposed[spec.field]), raw: spec.raw ? hv(rawAfter) : "", at: rec?.s === SRC.SUPPLIER ? rec.at : at, by: rec?.by ?? "init" };
      continue;
    }
    out[spec.field] = row[spec.field]; // наше значення лишається
    // ENG-28c (М2, рішення власника 01.11): перше заповнення відсутнього значення постачальника (сира колонка в рядку порожня) — не
    // зміна: стан запам'ятовує нове сире значення без попередження; розбіжність непорожнього значення — як і раніше, попередження.
    if (spec.raw && rec?.raw && hv(rawAfter) !== rec.raw && !firstFill(row[spec.raw])) warn(spec.field, "", row[spec.raw], rawAfter, row[spec.field]);
    st.f[spec.field] = { ...(rec || { s: SRC.CUSTOM, sys: "", at, by: "bad-state" }), raw: spec.raw ? hv(rawAfter) : "" };
  }
  return { row: out, state: st, warnings, rawChanged, anomalies };
}
function mergeParams({ row, proposed, out, st, spec, at, warn, anomalies }) {
  const rec = st.f[spec.field];
  const cur = parseParams(row[spec.field]), prop = parseParams(proposed[spec.field]);
  const rawB = parseParams(row[spec.raw]), rawA = parseParams(proposed[spec.raw]);
  const fieldCustom = st.bad || rec?.s === SRC.CUSTOM || (spec.field in row && (!cur.ok || cur.dup));
  if (!fieldCustom && (!prop.ok || prop.dup)) {
    // Запропоновані характеристики не розбираються поштучно — нічого не міняємо (ні значення, ні стану), позначаємо аномалію.
    out[spec.field] = row[spec.field] ?? "";
    anomalies.push(`${spec.field}: запропоновані характеристики ${prop.ok ? "мають дублі назв" : "не розбираються"} — лишено поточні`);
    return;
  }
  if (fieldCustom) {
    // Рівень поля: наше значення цілком; попередження — якщо змінились сирі характеристики.
    out[spec.field] = row[spec.field] ?? proposed[spec.field];
    if (rec?.raw && hv(proposed[spec.raw]) !== rec.raw && !firstFill(row[spec.raw])) warn(spec.field, "", row[spec.raw], proposed[spec.raw], row[spec.field]);
    st.f[spec.field] = { ...(rec || { s: SRC.CUSTOM, sys: "", at, by: "bad-state" }), raw: hv(proposed[spec.raw]) };
    return;
  }
  // Поштучно: порядок — як у запропонованому; кастомні, яких немає в запропонованому, — у кінці у своєму порядку.
  const result = [], seen = new Set();
  const take = (k) => {
    if (seen.has(k)) return; seen.add(k);
    const prec = st.p[k];
    if (prec?.s === SRC.CUSTOM) {
      const mine = cur.map.get(k);
      if (mine) result.push(mine); // видалена власником характеристика (by: removed) не повертається
      const ra = rawA.map.get(k), rb = rawB.map.get(k);
      if (prec.raw != null && prec.raw !== "" && pv(ra) !== prec.raw && rawA.ok) warn(spec.field, k, rb ? JSON.stringify(rb) : "", ra ? JSON.stringify(ra) : "", mine ? JSON.stringify(mine) : "(видалено власником)");
      st.p[k] = { ...prec, raw: pv(ra) };
      return;
    }
    const p = prop.map.get(k);
    if (p) { result.push(p); st.p[k] = { s: SRC.SUPPLIER, sys: pv(p), raw: pv(rawA.map.get(k)), at: prec?.at ?? at, by: prec?.by ?? "init" }; }
    else delete st.p[k]; // постачальник прибрав характеристику, яку вів сам, — прибираємо й ми
  };
  for (const k of prop.map.keys()) take(k);
  for (const k of cur.map.keys()) take(k);
  for (const k of Object.keys(st.p)) if (!seen.has(k)) take(k); // кастомно видалені — лише оновити raw / попередити
  const json = result.length || prop.list.length || cur.list.length ? JSON.stringify(result) : mtText(proposed[spec.field]);
  out[spec.field] = json;
  st.f[spec.field] = { s: SRC.SUPPLIER, sys: hv(json), raw: hv(proposed[spec.raw]), at: rec?.at ?? at, by: rec?.by ?? "init" };
}

// ---------- 3. команди власника ----------
/** «Прийняти значення постачальника» для поля (або однієї характеристики): стан → S; наступне applySupplier запише
 *  запропоноване значення. Нічого іншого не змінює. */
export function acceptSupplier(state, field, param = "", at = "") {
  const st = { ...state, f: { ...state.f }, p: { ...state.p } };
  if (param) { const k = paramKey(param); st.p[k] = { ...(st.p[k] || {}), s: SRC.SUPPLIER, sys: "", at, by: "accept" }; }
  else {
    st.f[field] = { ...(st.f[field] || {}), s: SRC.SUPPLIER, sys: "", at, by: "accept" };
    if (field === PARAMS_FIELD) for (const k of Object.keys(st.p)) st.p[k] = { ...st.p[k], s: SRC.SUPPLIER, sys: "", at, by: "accept" };
  }
  delete st.bad;
  return st;
}
/** «Зробити кастомним» (явна команда, у тому числі для значення, що збігається з постачальником). */
export function markCustom(state, field, param = "", at = "", by = "command") {
  const st = { ...state, f: { ...state.f }, p: { ...state.p } };
  if (param) { const k = paramKey(param); st.p[k] = { ...(st.p[k] || { sys: "", raw: "" }), s: SRC.CUSTOM, at, by }; }
  else st.f[field] = { ...(st.f[field] || { sys: "", raw: "" }), s: SRC.CUSTOM, at, by };
  return st;
}

/** Підсумок стану рядка для звіту / позначки. */
export function customFields(state) {
  return [...Object.entries(state.f).filter(([, r]) => r.s === SRC.CUSTOM).map(([k]) => k), ...Object.entries(state.p).filter(([, r]) => r.s === SRC.CUSTOM).map(([k]) => `${PARAMS_FIELD}: ${k}`)];
}
