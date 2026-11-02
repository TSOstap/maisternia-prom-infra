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
export const WARN_HEADER = Object.freeze(["Ключ", "Виявлено", "Offer ID", "Артикул", "Назва", "Поле", "Було (постачальник)", "Стало (постачальник)", "Наше значення", "Джерело", "Позначка власника", "Дія власника", "Стан дії"]);
export const ACTION = Object.freeze({ ACCEPT: "Прийняти значення постачальника", KEEP: "Залишити наше" });
const CLIP = 2000; // довгі описи — скорочено в аркуші (повні значення — у сирих колонках рядка товару)
const clip = (v) => { const s = mtText(v); return s.length > CLIP ? s.slice(0, CLIP) + " …" : s; };

export function warningRow(w) {
  return [w.key, w.at, w.offerId, w.sku, w.name, w.field, clip(w.before), clip(w.after), clip(w.custom), w.source, "", "", ""];
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
