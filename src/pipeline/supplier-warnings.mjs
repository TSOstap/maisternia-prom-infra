/** Інформаційні попередження постачальника (фінальні вимоги власника 29.10.2026, розд. 3): аркуш «Попередження постачальника».
 *
 *  Рядок = одна зміна сирого поля, для якого діє наше (кастомне) значення. Ключ — Offer ID + поле + хеш нового сирого значення:
 *  повторна синхронізація з тим самим сирим значенням рядок не дублює (дописування за ключем через шлюз E2 / E3).
 *  Колонки власника: «Позначка власника» (наприклад «Опрацьовано») і «Дія власника» («Прийняти значення постачальника» /
 *  «Залишити наше»). Система їх НЕ пише (контракт власності) — лише читає. Колонку «Стан дії» веде система.
 *  Попередження НІКОЛИ не блокує синхронізацію, YML чи імпорт: модуль лише дописує й читає. Позначка «Опрацьовано» не змінює
 *  кастомності поля; повернення поля постачальнику — лише дією «Прийняти значення постачальника». */
import { mtText } from "../core/text.mjs";

export const WARN_SHEET = "Попередження постачальника";
// «Що змінилось» (рішення власника 04.11) — у КІНЦІ, щоб наявні рядки аркуша не зсувались.
export const SUMMARY_COLUMN = "Що змінилось";
export const WARN_HEADER = Object.freeze(["Ключ", "Виявлено", "Offer ID", "Артикул", "Назва", "Поле", "Було (постачальник)", "Стало (постачальник)", "Наше значення", "Джерело", "Позначка власника", "Дія власника", "Стан дії", SUMMARY_COLUMN]);
export const ACTION = Object.freeze({ ACCEPT: "Прийняти значення постачальника", KEEP: "Залишити наше" });
const CLIP = 2000; // довгі описи — скорочено в аркуші (повні значення — у сирих колонках рядка товару)
const clip = (v) => { const s = mtText(v); return s.length > CLIP ? s.slice(0, CLIP) + " …" : s; };

export function warningRow(w) {
  return [w.key, w.at, w.offerId, w.sku, w.name, w.field, clip(w.before), clip(w.after), clip(w.custom), w.source, "", "", "", changeSummary(w.field, w.before, w.after)];
}

const ENTITIES = { "&nbsp;": " ", "&ndash;": "–", "&mdash;": "—", "&laquo;": "«", "&raquo;": "»", "&quot;": '"', "&amp;": "&", "&#39;": "'" };
const plainText = (v) => mtText(v).replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? " ").replace(/\s+/g, " ").trim();
/** «Назва: значення; Назва: значення» (так пишуться зміни характеристик) → Map; не той формат — null. */
function pairs(s) {
  const t = mtText(s).trim();
  if (!t) return new Map();
  const out = new Map();
  for (const part of t.split(/;\s+/)) { const m = /^([^:]{1,120}):\s*(.*)$/s.exec(part.trim()); if (!m) return null; out.set(m[1].trim(), m[2].trim()); }
  return out;
}
/** Різниця слів (LCS) → до 4 фрагментів «…контекст: було → стало». */
function wordDiff(a, b) {
  const A = a.split(" "), B = b.split(" "), n = A.length, m = B.length;
  if (n * m > 400000) return "";
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks = []; let i = 0, j = 0, cur = null;
  const close = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { close(); i++; j++; continue; }
    cur ||= { ctx: A.slice(Math.max(0, i - 4), i).join(" "), del: [], add: [] };
    if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) cur.add.push(B[j++]); else cur.del.push(A[i++]);
  }
  close();
  const shown = hunks.slice(0, 4).map((h) => `${h.ctx ? "…" + h.ctx + " " : ""}«${h.del.join(" ") || "—"}» → «${h.add.join(" ") || "—"}»`);
  return shown.join("; ") + (hunks.length > 4 ? `; ще змін: ${hunks.length - 4}` : "");
}
/** Короткий підсумок зміни для власника: що саме змінив постачальник (без читання довгих описів). */
export function changeSummary(field, before, after) {
  const b0 = mtText(before).trim(), a0 = mtText(after).trim();
  if (/Характеристики JSON/.test(mtText(field))) {
    const p = pairs(b0), q = pairs(a0);
    if (p && q) {
      const names = [...new Set([...p.keys(), ...q.keys()])].filter((k) => p.get(k) !== q.get(k));
      if (names.length) return names.map((k) => `${k}: ${p.get(k) ?? "(не було)"} → ${q.get(k) ?? "(прибрано)"}`).join("; ").slice(0, 1000);
    }
  }
  const b = plainText(b0), a = plainText(a0);
  if (b === a) return b0 === a0 ? "без змін" : "лише розмітка (HTML) — текст той самий";
  if (!b) return `додано: «${a.slice(0, 200)}${a.length > 200 ? "…" : ""}»`;
  if (!a) return "постачальник прибрав значення";
  const d = wordDiff(b, a);
  return (d || `текст змінено (${b.length} → ${a.length} симв.)`).slice(0, 1000);
}

/** Опрацьоване попередження (рішення власника 04.11 — переноситься в архів): «Залишити наше»; «Прийняти значення постачальника» —
 *  лише ПІСЛЯ виконання системою («Стан дії» = ВИКОНАНО…); або заповнена «Позначка власника». Невідома дія — НЕ опрацьоване. */
export function isResolved(row) {
  const act = mtText(row["Дія власника"]).trim(), note = mtText(row["Позначка власника"]).trim(), st = mtText(row["Стан дії"]).trim();
  if (act === ACTION.ACCEPT) return /^ВИКОНАНО/.test(st);
  if (act === ACTION.KEEP) return true;
  if (act) return false;
  return Boolean(note);
}

/** Дописати нові попередження (лише відсутні ключі). session — сесія шлюзу (оренда + журнал); без сесії — заборонено. */
export async function recordWarnings({ session, warnings, generation = "" }) {
  if (!warnings.length) return { outcome: "NOTHING", appended: 0 };
  const uniq = [...new Map(warnings.map((w) => [w.key, w])).values()];
  const r = await session.appendMissingByKey({ title: WARN_SHEET, rows: uniq.map(warningRow), generation: "warnings:" + generation });
  return { outcome: r.outcome, appended: r.appended ?? r.items?.filter((x) => x.status === "VERIFIED").length ?? 0, result: r };
}

/** Дії власника, які ще не виконано: «Прийняти значення постачальника» без позначки системи в «Стан дії». */
export function pendingActions(values) {
  if (!values?.length) return [];
  const h = values[0].map(mtText), c = (k) => h.indexOf(k);
  const [ck, co, cf, ca, cs] = ["Ключ", "Offer ID", "Поле", "Дія власника", "Стан дії"].map(c);
  if ([ck, co, cf, ca, cs].some((i) => i < 0)) return [];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    if (mtText(r[ca]).trim() !== ACTION.ACCEPT || mtText(r[cs]).trim()) continue;
    const field = mtText(r[cf]);
    const m = /^(.*?): (.+)$/.exec(field); // «Характеристики JSON: матеріал» → поле + характеристика
    out.push({ key: mtText(r[ck]), offerId: mtText(r[co]), field: m && m[1] === "Характеристики JSON" ? m[1] : field, param: m && m[1] === "Характеристики JSON" ? m[2] : "" });
  }
  return out;
}

/** «Класифікація полів»: невизначені після міграції поля — рішення власника «Наше» / «Постачальника» (одноразово). */
export const CLASSIFY_SHEET = "Класифікація полів";
export const CLASSIFY_HEADER = Object.freeze(["Ключ", "Offer ID", "Поле", "Наше значення", "Значення постачальника", "Клас", "Рішення власника", "Стан дії"]);
export const CLASSIFY = Object.freeze({ OURS: "Наше", SUPPLIER: "Постачальника" });
export const classifyRow = (offerId, x) => [offerId + "|" + x.field, offerId, x.field, x.value, x.supplier, x.class, "", ""];
/** Рішення власника з аркуша класифікації, ще не виконані. */
export function pendingClassifications(values) {
  if (!values?.length) return [];
  const h = values[0].map(mtText), c = (k) => h.indexOf(k);
  const [ck, co, cf, cd, cs] = ["Ключ", "Offer ID", "Поле", "Рішення власника", "Стан дії"].map(c);
  if ([ck, co, cf, cd, cs].some((i) => i < 0)) return [];
  return values.slice(1).filter((r) => [CLASSIFY.OURS, CLASSIFY.SUPPLIER].includes(mtText(r[cd]).trim()) && !mtText(r[cs]).trim())
    .map((r) => ({ key: mtText(r[ck]), offerId: mtText(r[co]), field: mtText(r[cf]), param: "", decision: mtText(r[cd]).trim(), sheet: CLASSIFY_SHEET }));
}

/** Позначка в рядку товару: кількість відкритих попереджень і поля (без перезапису готових значень). */
export function markFor(openWarnings) {
  if (!openWarnings.length) return "";
  const fields = [...new Set(openWarnings.map((w) => w.field))];
  return `⚠ ${openWarnings.length}: ${fields.join(", ")}`;
}
