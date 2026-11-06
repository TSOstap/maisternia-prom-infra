/** Рішення власника 06.11.2026 (вимоги Google Merchant Center для фіду Prom, довідка Prom 360017871658):
 *  • текст опису (без HTML) — не більше 5 000 символів у кожній мові;
 *  • без слів ВЕЛИКИМИ ЛІТЕРАМИ «для привернення уваги».
 *  Великі літери лишаються в скороченнях, брендах і кодах моделей: слова до 3 літер, з дефісом / цифрами / латиницею
 *  (ЕШМ-125, ТАOE-S) і перелік CAPS_KEEP. */
import { mtText } from "./text.mjs";

export const GMC_MAX_DESC = 5000;
// Скорочення й бренди, які пишуться великими літерами (не «крик»). Доповнюється за потреби.
export const CAPS_KEEP = Object.freeze(new Set([
  "ГОСТ", "ДСТУ", "АГЗС", "УОНИ", "УОНІ", "ХСНД", "АГШК", "ОЕСР", "ОЭСР", "НМДК", "ПЛШМ", "УКТЗЕД", "ОЛОГ", "ЄВРО", "ЕВРО",
  "СЛОН", "ПАТОН", "СИЛА", "СТАЛЬ", "ТИТАН", "ЗУБР", "БЕЛАВТО", "СВІТЯЗЬ", "СВИТЯЗЬ", "СВАК", "ЭЛИТЕ",
]));
const ENT = { nbsp: " ", ndash: "–", mdash: "—", laquo: "«", raquo: "»", quot: '"', amp: "&", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", deg: "°", times: "×", plusmn: "±" };
/** Текст опису без HTML і сутностей (як його бачить покупець / Google). */
export function plainText(html) {
  return mtText(html).replace(/<[^>]*>/g, " ").replace(/&(#\d+|[a-z]+);/gi, (m, k) => (k[0] === "#" ? String.fromCharCode(Number(k.slice(1))) : ENT[k.toLowerCase()] ?? " ")).replace(/\s+/g, " ").trim();
}
export const descLength = (html) => plainText(html).length;

const CYR_CAPS = /^[А-ЯІЇЄҐЁЫЭЪ'’ʼ]+$/;
// Кандидат: ≥ 4 великі літери, не частина слова / коду (без літери, цифри чи дефіса поруч).
const TOKEN = /(?<![\p{L}\d-])\p{Lu}[\p{Lu}'’ʼ]{3,}(?![\p{L}\d-])/gu;
const shouting = (w) => CYR_CAPS.test(w) && !CAPS_KEEP.has(w.replace(/[’ʼ]/g, "'"));
/** Слова «криком» у тексті (для перевірки). */
export function capsWords(text) {
  return [...new Set((mtText(text).match(TOKEN) || []).filter(shouting))];
}
/** Виправлення регістру в HTML: лише текст між тегами; слово «криком» → малими, першу літеру — великою на початку тексту блоку
 *  або речення. Теги, атрибути, скорочення й коди не змінюються. */
export function fixCaps(html) {
  return mtText(html).replace(/(^|>)([^<]*)/g, (all, gt, seg) => gt + seg.replace(TOKEN, (w, off) => {
    if (!shouting(w)) return w;
    // Напис у лапках («ТЕСТ» на кнопці) — не «крик».
    if (/[«"“„]$/.test(seg.slice(0, off)) && /^[»"”]/.test(seg.slice(off + w.length))) return w;
    const before = seg.slice(0, off).replace(/&nbsp;/g, " ");
    const start = !before.trim() || /[.!?…]\s*$/.test(before);
    const low = w.toLocaleLowerCase("uk");
    return start ? low.charAt(0).toLocaleUpperCase("uk") + low.slice(1) : low;
  }));
}
