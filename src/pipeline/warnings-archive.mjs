/** Рішення власника 04.11.2026: на аркуші «Попередження постачальника» — лише відкриті попередження. Опрацьовані (isResolved)
 *  ПЕРЕНОСЯТЬСЯ в «Попередження — архів» (нічого не губиться): спершу дописування в архів за ключем, потім видалення з аркуша
 *  за ключем зі ЗНІМКОМ рядка (власник змінив рядок після читання → рядок лишається до наступного запуску). Нова зміна
 *  постачальника — новий ключ і новий рядок (попередження створюються лише на зміну сирого значення).
 *  Заодно: заголовок «Що змінилось» (якщо аркуш старий) і короткий підсумок для відкритих рядків, де його ще немає.
 *  Порціями (limit) — журнал W2 зберігає знімки видалених рядків. */
import { mtText } from "../core/text.mjs";
import { WARN_SHEET, SUMMARY_COLUMN, changeSummary, isResolved } from "./supplier-warnings.mjs";

export const WARN_ARCHIVE_SHEET = "Попередження — архів";
export const ARCHIVED_COLUMN = "Архівовано";
const OK = new Set(["VERIFIED", "NOTHING"]);
const objects = (v) => { const h = v[0].map((x) => mtText(x).trim()); return v.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""]))); };

export async function archiveWarnings({ session, readBook, stamp, limit = 40, summarizeLimit = 100 }) {
  let v = (await readBook([WARN_SHEET]))[WARN_SHEET];
  if (!v?.length) return { state: "NOTHING", reason: "немає аркуша попереджень", archived: 0 };
  let header = v[0].map((x) => mtText(x).trim());
  if (!header.includes("Ключ") || !header.includes("Offer ID")) return { state: "BLOCKED", reason: "аркуш попереджень без «Ключ» / «Offer ID»", archived: 0 };
  const out = { archived: 0, summarized: 0, conflicts: 0 };
  if (!header.includes(SUMMARY_COLUMN)) {
    let last = header.length; while (last > 0 && !header[last - 1]) last--;
    await session.sheets.ensureColumns(WARN_SHEET, last + 1);
    await session.sheets.updateRanges([{ title: WARN_SHEET, row: 1, col: last + 1, values: [[SUMMARY_COLUMN]] }]);
    v = (await readBook([WARN_SHEET]))[WARN_SHEET]; header = v[0].map((x) => mtText(x).trim());
    out.headerAdded = true;
  }
  const rows = objects(v).filter((r) => mtText(r["Ключ"]).trim());
  const done = rows.filter(isResolved).slice(0, limit);
  if (done.length) {
    const archHeader = [...header.filter(Boolean), ARCHIVED_COLUMN];
    await session.sheets.ensureSheet(WARN_ARCHIVE_SHEET, archHeader);
    const app = await session.appendMissingByKey({ title: WARN_ARCHIVE_SHEET, rows: done.map((r) => archHeader.map((k) => (k === ARCHIVED_COLUMN ? stamp : r[k] ?? ""))), generation: "warn-archive:" + stamp });
    if (!OK.has(app.outcome)) return { state: "INCOMPLETE", reason: "архів: " + app.outcome + " — з аркуша нічого не прибрано", ...out };
    // Прибирається лише те, що справді є в архіві (свіже читання).
    const inArch = new Set(objects((await readBook([WARN_ARCHIVE_SHEET]))[WARN_ARCHIVE_SHEET]).map((r) => mtText(r["Ключ"]).trim()));
    const del = done.filter((r) => inArch.has(mtText(r["Ключ"]).trim()));
    const expectOf = (r) => Object.fromEntries(header.filter(Boolean).map((k) => [k, r[k] ?? ""]));
    const d = await session.deleteByKeys({ title: WARN_SHEET, rows: del.map((r) => ({ key: mtText(r["Ключ"]).trim(), expect: expectOf(r) })), generation: "warn-archive:" + stamp });
    out.archived = (d.items || []).filter((x) => x.status === "VERIFIED").length;
    out.conflicts = (d.items || []).filter((x) => x.status === "CONFLICT").length;
    out.deleteOutcome = d.outcome;
    if (!["VERIFIED", "NOTHING", "NOT_APPLIED"].includes(d.outcome)) return { state: "INCOMPLETE", reason: "прибирання з аркуша: " + d.outcome, ...out };
  }
  // Підсумок «Що змінилось» для відкритих рядків без нього (нові рядки отримують його одразу при дописуванні).
  const open = objects((await readBook([WARN_SHEET]))[WARN_SHEET]).filter((r) => mtText(r["Ключ"]).trim() && !isResolved(r) && !mtText(r[SUMMARY_COLUMN]).trim()).slice(0, summarizeLimit);
  if (open.length) {
    const changes = open.map((r) => ({ key: mtText(r["Ключ"]).trim(), expect: { [SUMMARY_COLUMN]: "" }, set: { [SUMMARY_COLUMN]: changeSummary(r["Поле"], r["Було (постачальник)"], r["Стало (постачальник)"]) } }));
    const u = await session.updateByKey({ title: WARN_SHEET, changes, generation: "warn-summary:" + stamp });
    out.summarized = (u.items || []).filter((x) => x.status === "VERIFIED").length;
  }
  const left = objects((await readBook([WARN_SHEET]))[WARN_SHEET]).filter((r) => mtText(r["Ключ"]).trim());
  return { state: out.archived || out.summarized || out.headerAdded ? "WARNINGS_ARCHIVED" : "NOTHING", ...out, open: left.filter((r) => !isResolved(r)).length, resolvedLeft: left.filter(isResolved).length };
}
