/** Catalog Controls — SEO-метадані товару (HTML-заголовок і опис UA/RU), прив'язані до Offer ID.
 *
 *  Власник редагує 4 колонки картки й пише «ЗАТВЕРДИТИ <код>» у «SEO рішення» (код — з «Стану керування», прив'язаний до тексту
 *  чернетки, ідентичності товару й останньої затвердженої версії). Затверджене — подія журналу; діє лише воно; усі версії
 *  зберігаються (майбутнє відновлення). Система НЕ пише в картку: ні автоповернення, ні «ВІДНОВИТИ».
 *  СТАН ГОТОВНОСТІ: колонки SEO не захищені від повнорядкового запису syncSheet (fullRows) — редагування SEO не вважається готовим до
 *  використання до спільної зміни S1 (інженерний сектор). */
import { mtText, sha256 } from "./text.mjs";
import { CODE_RE, PROM_SEO_IMPORT, PROM_TITLE_ADVICE, SEO_META_FIELDS, normCmd, short } from "./controls-common.mjs";

export const SEO_WORD = "ЗАТВЕРДИТИ";
export const seoValues = (row) => Object.fromEntries(SEO_META_FIELDS.map((k) => [k, mtText(row?.[k])]));
export const seoSha = (values) => sha256(JSON.stringify(SEO_META_FIELDS.map((k) => mtText(values?.[k])))).slice(0, 16);
export const sameSeo = (a, b) => SEO_META_FIELDS.every((k) => mtText(a?.[k]) === mtText(b?.[k]));
export const emptySeo = (v) => SEO_META_FIELDS.every((k) => !mtText(v?.[k]));

/** «SEO рішення» → { code } | { unknown: raw } | null. */
export function parseSeoCommand(raw) {
  const text = mtText(raw).trim();
  if (!text) return null;
  const cmd = normCmd(text);
  if (cmd === SEO_WORD) return { code: "" };
  if (cmd.startsWith(SEO_WORD + " ") && CODE_RE.test(cmd.slice(SEO_WORD.length + 1))) return { code: cmd.slice(SEO_WORD.length + 1) };
  return { unknown: text };
}

const SECRET_RE = /hash_tag|products_feed|Bearer\s+\S{12,}|[?&](?:token|key|api_key|access_token)=/i;
const HTML_TAG_RE = /<\s*\/?\s*[a-zа-яіїєґ!][^>]*>/i;
const CONTROL_RE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u2060\\ufeff]");

/** Перевірка перед затвердженням. Текст власника не змінюється — лише відмова з причиною. */
export function validateSeo(values) {
  const problems = [];
  for (const k of SEO_META_FIELDS) {
    const v = mtText(values?.[k]);
    if (!v) continue;
    if (v !== v.trim()) problems.push(`«${k}»: пробіли на початку або в кінці`);
    if (CONTROL_RE.test(v)) problems.push(`«${k}»: перенесення рядка або службові символи`);
    if (HTML_TAG_RE.test(v)) problems.push(`«${k}»: HTML-теги не допускаються`);
    if (SECRET_RE.test(v)) problems.push(`«${k}»: службова адреса або ключ доступу`);
    const max = PROM_SEO_IMPORT[k].max;
    if ([...v].length > max) problems.push(`«${k}»: ${[...v].length} символів (ліміт імпорту Prom ${max})`);
  }
  return problems;
}

export function seoAdvice(values) {
  const notes = [];
  for (const k of ["SEO заголовок UA", "SEO заголовок RU"]) if ([...mtText(values?.[k])].length > PROM_TITLE_ADVICE) notes.push(`«${k}» довший за ${PROM_TITLE_ADVICE} символів (рекомендація Prom)`);
  for (const [ua, ru] of [["SEO заголовок UA", "SEO заголовок RU"], ["SEO опис UA", "SEO опис RU"]]) {
    if (Boolean(mtText(values?.[ua])) !== Boolean(mtText(values?.[ru]))) notes.push(`заповнено лише одну мову: «${mtText(values?.[ua]) ? ua : ru}»`);
  }
  return notes;
}

/** Знімок даних постачальника на момент затвердження — для попередження «Було → Стало» (вимога власника, п. 12). */
const SUPPLIER_TEXT = Object.freeze(["Назва постачальника UA", "Назва постачальника RU", "Артикул постачальника", "Модель", "URL постачальника"]);
const SUPPLIER_SHA = Object.freeze(["Характеристики постачальника JSON", "Опис постачальника UA", "Опис постачальника RU"]);
export function supplierSnapshot(row) {
  return {
    text: Object.fromEntries(SUPPLIER_TEXT.map((k) => [k, mtText(row?.[k])])),
    sha: Object.fromEntries(SUPPLIER_SHA.map((k) => [k, sha256(mtText(row?.[k])).slice(0, 16)])),
  };
}
export function supplierChanges(snap, row) {
  if (!snap?.text) return [];
  const now = supplierSnapshot(row);
  const out = SUPPLIER_TEXT.filter((k) => mtText(snap.text[k]) !== now.text[k]).map((k) => `${k}: «${short(snap.text[k], 60)}» → «${short(now.text[k], 60)}»`);
  for (const k of SUPPLIER_SHA) if (snap.sha?.[k] && snap.sha[k] !== now.sha[k]) out.push(`${k}: змінено`);
  return out;
}

/**
 * Затверджені SEO для передавання в Prom. Канал — лише Excel/CSV-імпорт з додатком «SEO-настройки»; у YML не передається; імпорт не
 * запускається. Лише картки, що є в каталозі, не виключені, без пошкодження. Порожні значення пропускаються (імпорт їх не очищує).
 */
export function seoExport(seo, { rowsById, excluded = new Set() }) {
  const items = [];
  for (const [offerId, a] of [...seo.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const r = rowsById.get(offerId);
    if (!r || excluded.has(offerId)) continue;
    const columns = {};
    for (const k of SEO_META_FIELDS) if (mtText(a.values[k])) columns[PROM_SEO_IMPORT[k].column] = mtText(a.values[k]);
    if (!Object.keys(columns).length) continue;
    items.push({ offerId, promCode: mtText(r?.["Код товару Prom"]), approvedAt: a.at, version: a.n, sha: seoSha(a.values), columns });
  }
  return {
    channel: "PROM_EXCEL_IMPORT",
    confirmed: false,
    blockedBy: ["S1: syncSheet (fullRows) може перезаписати колонки SEO — редагування SEO не готове до використання"],
    requires: ["додаток «SEO-настройки» в кабінеті Prom (лише платні / тестовий пакет)", "підтверджений ідентифікатор зіставлення товару в Excel-імпорті", "окреме погодження імпорту власником"],
    items,
  };
}
