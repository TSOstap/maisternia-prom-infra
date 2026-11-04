/** Точкові правки власника (рішення власника 03.11.2026 перед підключенням Prom: «до того як підключу — виправити ці товари»).
 *
 *  План — масив { sheet, key, column, expect, set, source }: точне поточне значення клітинки (expect) і нове (set), без вигадування —
 *  тексти погоджує власник. Порядок як у разовому виправленні 1561514532 (ENG-28a): свіже читання → звірка ВСІХ очікуваних значень
 *  (хоч одна розбіжність — нічого не пишемо) → запис за ключем (keyedUpdate, окремий записувач лише для дозволених колонок) →
 *  події «Журналу» «РІШЕННЯ ВЛАСНИКА» → повторне читання. Це рівноцінно ручній правці власника в таблиці: «Оновити товари» далі
 *  фіксує її як правку власника («Стан полів JSON») і не перезаписує; «Характеристики JSON» update не пише ніколи (preserve).
 *  Аркуш «Попередження постачальника» — лише «Дія власника» (дія «Залишити наше» / «Прийняти значення постачальника» виконує
 *  наступне «Оновити товари»). */
import { keyedUpdate, OP, ITEM } from "./safe-write/keyed-update.mjs";
import { mtText } from "../core/text.mjs";

export const OWNER_EDITS_WRITER = "owner-edits";
/** Дозволені аркуші / ключі / колонки. */
export const OWNER_EDIT_TARGETS = Object.freeze({
  // «Попередження постачальника» в каталозі — позначка: система її сама не знімає (markCell); знімає власник, коли розглянув попередження.
  "Основний каталог": Object.freeze({ key: "Offer ID", columns: Object.freeze(["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Характеристики JSON", "Фото JSON", "Виробник", "Попередження постачальника", "Запити UA", "Запити RU", "Група ID", "Група UA", "Група RU", "Категорія Prom ID", "Категорія Prom URL"]) }),
  // «Залишити наше» система не виконує (дія лише «Прийняти значення постачальника») — тому «Стан дії» позначає розгляд власником.
  "Попередження постачальника": Object.freeze({ key: "Ключ", columns: Object.freeze(["Дія власника", "Стан дії"]) }),
  // 04.11: наші пошукові запити для новинок до затвердження (у черзі запис робить SEO власним — синхронізація його не перезаписує).
  "Нові товари": Object.freeze({ key: "Offer ID", columns: Object.freeze(["Запити UA", "Запити RU"]) }),
});
const JOURNAL = "Журнал";
const JOURNAL_CHUNK = 500;
const clip = (v, n = 300) => { const s = mtText(v); return s.length > n ? s.slice(0, n) + " …" : s; };

export function ownerEditsContract() {
  const sheets = new Map(Object.entries(OWNER_EDIT_TARGETS).map(([title, t]) => [title, Object.freeze({
    key: t.key, identity: Object.freeze([]), appendWriters: Object.freeze([]), deleteWriters: Object.freeze([]),
    columns: new Map(t.columns.map((c) => [c, Object.freeze({ group: "точкові правки власника", writers: Object.freeze([OWNER_EDITS_WRITER]), gate: "" })])),
  })]));
  return Object.freeze({ sheets });
}

/** Перевірка плану (без читання таблиці). → [проблеми] */
export function planProblems(edits) {
  if (!Array.isArray(edits) || !edits.length) return ["план порожній"];
  const p = [], seen = new Set();
  for (const [i, e] of edits.entries()) {
    const t = OWNER_EDIT_TARGETS[e?.sheet];
    if (!t) { p.push(`#${i}: аркуш «${e?.sheet}» не дозволено`); continue; }
    if (!t.columns.includes(e.column)) p.push(`#${i}: колонку «${e.column}» в «${e.sheet}» не дозволено`);
    if (!mtText(e.key)) p.push(`#${i}: немає ключа`);
    if (typeof e.expect !== "string" || typeof e.set !== "string") p.push(`#${i}: expect / set — рядки`);
    if (e.expect === e.set) p.push(`#${i}: нове значення = поточному`);
    if (!mtText(e.source)) p.push(`#${i}: немає джерела рішення`);
    if (e.column === "Характеристики JSON" || e.column === "Фото JSON") { try { if (!Array.isArray(JSON.parse(e.set))) throw 0; } catch { p.push(`#${i}: «${e.column}» — не JSON-масив`); } }
    const k = `${e.sheet}|${e.key}|${e.column}`;
    if (seen.has(k)) p.push(`#${i}: повтор ${k}`);
    seen.add(k);
  }
  return p;
}

/** → { state: "OWNER_EDITS_APPLIED" | "BLOCKED" | "INCOMPLETE", ... } */
export async function applyOwnerEdits({ sheets, readBook, stamp, edits }) {
  const problems = planProblems(edits);
  if (problems.length) return { state: "BLOCKED", reason: "план правок некоректний", problems };
  const titles = [...new Set(edits.map((e) => e.sheet))];
  const book = await readBook(titles);
  // 1. Звірка всіх очікуваних значень до першого запису.
  const mismatch = [];
  for (const title of titles) {
    const v = book[title];
    if (!v?.length) { mismatch.push(`немає аркуша «${title}»`); continue; }
    const h = v[0].map((x) => mtText(x)), kc = h.indexOf(OWNER_EDIT_TARGETS[title].key);
    const rows = new Map();
    for (const r of v.slice(1)) { const k = mtText(r[kc]); rows.set(k, rows.has(k) ? null : r); }
    for (const e of edits.filter((x) => x.sheet === title)) {
      const r = rows.get(mtText(e.key)), c = h.indexOf(e.column);
      if (r === undefined) mismatch.push(`${title}: ключа немає (рядок плану)`);
      else if (r === null) mismatch.push(`${title}: ключ повторюється (рядок плану)`);
      else if (c < 0) mismatch.push(`${title}: немає колонки «${e.column}»`);
      else if (mtText(r[c]) !== e.expect) mismatch.push(`${title}: #${mismatch.length + 1} «${e.column}» змінено після підготовки плану`);
    }
  }
  if (mismatch.length) return { state: "BLOCKED", reason: "поточні значення відрізняються від плану — нічого не записано", problems: mismatch.slice(0, 30) };
  // 2. Запис за ключем (усі колонки товару — одна зміна).
  const contract = ownerEditsContract();
  const results = [];
  for (const title of titles) {
    const byKey = new Map();
    for (const e of edits.filter((x) => x.sheet === title)) {
      const c = byKey.get(e.key) || { key: mtText(e.key), identity: {}, expect: {}, set: {} };
      c.expect[e.column] = e.expect; c.set[e.column] = e.set; byKey.set(e.key, c);
    }
    const r = await keyedUpdate({ sheets, read: readBook, contract, writer: OWNER_EDITS_WRITER, title, changes: [...byKey.values()], generation: "owner-edits:" + stamp });
    // Лише агрегати (ID товарів — у плані поза репозиторієм; вивід CLI блокує довгі числа).
    results.push({ title, outcome: r.outcome, items: r.items.length, statuses: r.items.reduce((m, x) => ({ ...m, [x.status]: (m[x.status] || 0) + 1 }), {}) });
    if (r.outcome !== OP.VERIFIED || r.items.some((x) => ![ITEM.VERIFIED, ITEM.ALREADY].includes(x.status))) {
      return { state: "INCOMPLETE", reason: `«${title}»: ${r.outcome} — потрібне з'ясування`, results };
    }
  }
  // 3. Події «Журналу» (скорочено; повні значення — у плані поза репозиторієм).
  const rows = edits.map((e) => [stamp, e.sheet, e.key, e.column, clip(e.expect), clip(e.set), "РІШЕННЯ ВЛАСНИКА 03.11: " + clip(e.source, 200)]);
  for (let i = 0; i < rows.length; i += JOURNAL_CHUNK) await sheets.appendRows(JOURNAL, rows.slice(i, i + JOURNAL_CHUNK));
  // 4. Повторне читання.
  const after = await readBook(titles);
  const notApplied = [];
  for (const title of titles) {
    const v = after[title], h = v[0].map((x) => mtText(x)), kc = h.indexOf(OWNER_EDIT_TARGETS[title].key);
    const rows2 = new Map(v.slice(1).map((r) => [mtText(r[kc]), r]));
    for (const e of edits.filter((x) => x.sheet === title)) if (mtText(rows2.get(mtText(e.key))?.[h.indexOf(e.column)]) !== e.set) notApplied.push(`${title}: «${e.column}»`);
  }
  if (notApplied.length) return { state: "INCOMPLETE", reason: "після запису значення не збігаються", notApplied: notApplied.slice(0, 30), results };
  return { state: "OWNER_EDITS_APPLIED", applied: edits.length, products: new Set(edits.filter((e) => e.sheet === "Основний каталог").map((e) => e.key)).size, results };
}
