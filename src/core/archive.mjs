/** Три аркуші (рішення власника 29.10): «Нові товари» → «Основний каталог» → «Видалені товари». Архів — чиста логіка переходів.
 *
 *  Рішення «Видалити товар» / «Повернути в каталог» приймає Catalog Controls (tombstone, авторизація); Engineering лише виконує
 *  перенесення за станом CC. Переходи ідемпотентні — повтор після збою продовжує з того кроку, де зупинився:
 *    видалення:   в каталозі, не в архіві → дописати в архів, потім видалити з каталогу;
 *                 в каталозі й в архіві   → (збій після дописування) лише видалити з каталогу;
 *                 лише в архіві           → перенесено; «ЗАВЕРШЕНО» — після публікації YML без цього ID.
 *    відновлення: лише за явним дозволом CC (restore): в архіві, не в каталозі → дописати в каталог, потім прибрати з архіву;
 *                 в обох → лише прибрати з архіву.
 *  Видалений — жодного <offer> у фіді: removed = tombstone CC ∪ ID архіву (архів лише додає виключення; blocked CC архів не обходить). */
import { mtText } from "./text.mjs";

export const ARCHIVE_SHEET = "Видалені товари";
export const ARCHIVE_EXTRA = Object.freeze(["Видалено", "Операція видалення", "Статус видалення", "YML без товару"]);
/** Стан видалення в архіві: до публікації YML без товару — не «завершено» (зовнішнього підтвердження Prom немає й не потрібно). */
export const REMOVAL = Object.freeze({ PENDING: "ОЧІКУЄ ПУБЛІКАЦІЇ YML", DONE: "ЗАВЕРШЕНО" });
const t = (v) => mtText(v);

export const archiveHeader = (mainHeader) => [...mainHeader.map(t).filter((k) => !ARCHIVE_EXTRA.includes(k)), ...ARCHIVE_EXTRA];
const rowsOf = (values) => {
  if (!values?.length) return { header: [], rows: new Map() };
  const header = values[0].map(t), kc = header.indexOf("Offer ID"), rows = new Map();
  for (let i = 1; i < values.length; i++) { const k = t(values[i]?.[kc]); if (k && !rows.has(k)) rows.set(k, Object.fromEntries(header.map((h, j) => [h, values[i][j] ?? ""]))); }
  return { header, rows };
};

/** ID архіву (для анти-повторного створення й виключення з фіду). */
export function archiveIds(values) {
  const { rows } = rowsOf(values);
  return { all: new Set(rows.keys()) };
}

/**
 * План переходів. removed — tombstone CC (Set Offer ID); restore — явно дозволені CC повернення (Set). blocked CC → нічого.
 * @returns {{ archive: Array<{key,row}>, deleteFromMain: Array<{key,row}>, restore: Array<{key,row}>, deleteFromArchive: Array<{key,row}>, done, conflicts }}
 */
export function planArchive({ mainValues, archiveValues, removed = new Set(), restore = new Set(), at, opOf = () => "" }) {
  const main = rowsOf(mainValues), arch = rowsOf(archiveValues);
  const out = { archive: [], deleteFromMain: [], restore: [], deleteFromArchive: [], done: [], conflicts: [] };
  for (const id of removed) {
    if (restore.has(id)) { out.conflicts.push({ id, reason: "одночасно tombstone і дозвіл повернення — рішення CC неоднозначне" }); continue; }
    const m = main.rows.get(id), a = arch.rows.get(id);
    if (m && !a) { out.archive.push({ key: id, row: { ...m, "Видалено": at, "Операція видалення": opOf(id), "Статус видалення": REMOVAL.PENDING, "YML без товару": "" } }); out.deleteFromMain.push({ key: id, row: m }); }
    else if (m && a) {
      // Збій після дописування: архівна копія має збігатися з рядком каталогу (інакше картку змінили — рішення людини).
      const differs = main.header.filter((h) => !ARCHIVE_EXTRA.includes(h) && t(m[h]) !== t(a[h]));
      if (differs.length) out.conflicts.push({ id, reason: "картку змінено після архівування: " + differs.slice(0, 5).join(", ") });
      else out.deleteFromMain.push({ key: id, row: m });
    } else if (a) out.done.push({ id, status: t(a["Статус видалення"]) || REMOVAL.PENDING });
  }
  for (const id of restore) {
    if (removed.has(id)) continue;
    const m = main.rows.get(id), a = arch.rows.get(id);
    if (a && !m) {
      const row = Object.fromEntries(Object.entries(a).filter(([k]) => !ARCHIVE_EXTRA.includes(k)));
      out.restore.push({ key: id, row }); out.deleteFromArchive.push({ key: id, row: a });
    } else if (a && m) {
      // Hermes F3: новіша правка власника (напр. SEO-чернетка) в архівній копії не губиться — різні копії → рішення людини.
      const differs = main.header.filter((h) => !ARCHIVE_EXTRA.includes(h) && t(m[h]) !== t(a[h]));
      if (differs.length) out.conflicts.push({ id, reason: "копії в каталозі й архіві різні (повернення): " + differs.slice(0, 5).join(", ") });
      else out.deleteFromArchive.push({ key: id, row: a });
    }
  }
  return out;
}

/** Завершення видалення (рішення власника 29.10, без підтвердження Prom): «ЗАВЕРШЕНО» — лише коли в ОПУБЛІКОВАНІЙ версії фіду
 *  немає жодного <offer> з цим ID. publishedIds — ID offer активної версії. Повертає зміни для keyedUpdate архіву. */
export function publishedCompletions(archiveValues, publishedIds, at) {
  const { rows } = rowsOf(archiveValues);
  const changes = [];
  for (const [id, r] of rows) {
    if (t(r["Статус видалення"]).startsWith(REMOVAL.DONE)) continue;
    if (publishedIds.has(id)) continue; // ще є в опублікованому фіді — не завершено
    changes.push({ key: id, expect: { "Статус видалення": t(r["Статус видалення"]), "YML без товару": t(r["YML без товару"]) }, set: { "Статус видалення": REMOVAL.DONE, "YML без товару": at } });
  }
  return changes;
}