/** Рішення власника 15.11.2026: «у нас мають бути всі товари постачальника… тільки без дублів» — розморозити свідомо виключені
 *  товари: прибрати їхні Offer ID з аркуша «Заморожені ID», щоб «Знайти нові» поставила їх у «Нові товари».
 *  Захист: ID, який уже є в «Основному каталозі», не прибирається (це відомий товар, а не виключений); ID зі списку keep
 *  (рішення власника «дубль») — теж. Рядки не видаляються: вміст переписується на тих самих місцях зверху, хвіст очищується. */
import { mtText } from "../core/text.mjs";
import { OP } from "./safe-write/keyed-update.mjs";

export const FROZEN_SHEET = "Заморожені ID";
export const ARCHIVE_SHEET_REFREEZE = "Видалені товари";
const MAIN = "Основний каталог";

/** → { values (новий вміст без заголовка), removed: [ID], refused: [{id, reason}], missing: [ID] } */
export function unfreezePlan(frozenValues, { ids = [], keep = [], mainIds = new Set() } = {}) {
  const h = (frozenValues?.[0] || []).map((x) => mtText(x).trim());
  const ci = h.indexOf("Offer ID");
  if (ci < 0) throw new Error("аркуш «" + FROZEN_SHEET + "»: немає колонки «Offer ID»");
  const want = new Set(ids.map((x) => mtText(x).trim()).filter(Boolean)), hold = new Set(keep.map((x) => mtText(x).trim()));
  const refused = [];
  for (const id of want) {
    if (hold.has(id)) refused.push({ id, reason: "рішення власника: дубль — лишається замороженим" });
    else if (mainIds.has(id)) refused.push({ id, reason: "уже в «Основному каталозі» — не виключений товар" });
  }
  const bad = new Set(refused.map((r) => r.id));
  const values = [], removed = [], seen = new Set();
  for (const r of frozenValues.slice(1)) {
    const id = mtText(r[ci]).trim();
    if (!id && r.every((x) => mtText(x).trim() === "")) continue;
    if (want.has(id) && !bad.has(id)) { removed.push(id); seen.add(id); continue; }
    values.push(h.map((_, i) => r[i] ?? ""));
  }
  const missing = [...want].filter((id) => !seen.has(id) && !bad.has(id));
  return { values, removed, refused, missing };
}

export async function unfreezeIds({ sheets, readBook, stamp, ids = [], keep = [], reason = "" }) {
  const book = await readBook([FROZEN_SHEET, MAIN]);
  const before = book[FROZEN_SHEET];
  if (!before?.length) return { state: "BLOCKED", reason: "немає аркуша «" + FROZEN_SHEET + "»" };
  const mh = (book[MAIN]?.[0] || []).map((x) => mtText(x).trim()), mi = mh.indexOf("Offer ID");
  if (mi < 0) return { state: "BLOCKED", reason: "немає заголовка «Основного каталогу»" };
  const mainIds = new Set((book[MAIN] || []).slice(1).map((r) => mtText(r[mi]).trim()).filter(Boolean));
  const plan = unfreezePlan(before, { ids, keep, mainIds });
  if (!plan.removed.length) return { state: "NOTHING", reason: "немає чого розморожувати", refused: plan.refused, missing: plan.missing };
  const width = before[0].length, oldRows = before.length - 1;
  const body = plan.values.concat(Array.from({ length: Math.max(0, oldRows - plan.values.length) }, () => Array(width).fill("")));
  await sheets.updateRanges([{ title: FROZEN_SHEET, row: 2, col: 1, values: body }]);
  const after = (await readBook([FROZEN_SHEET]))[FROZEN_SHEET];
  const left = new Set(after.slice(1).map((r) => mtText(r[0]).trim()));
  const ok = plan.removed.every((id) => !left.has(id)) && after.slice(1).filter((r) => mtText(r[0]).trim()).length === plan.values.length;
  const note = `розморожено ${plan.removed.length} Offer ID${plan.refused.length ? `; не розморожено ${plan.refused.length} (дублі / уже в каталозі)` : ""}`;
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", "", "СТРУКТУРА", "", note.slice(0, 1000), reason || "рішення власника 15.11: усі товари постачальника, без дублів"]]);
  return { state: ok ? "UNFROZEN" : "INCOMPLETE", removed: plan.removed.length, kept: plan.values.length, refused: plan.refused, missing: plan.missing };
}

/** Рішення власника 16.11.2026: «порошок для відбілювання зубів не додавай, залиш його замороженим»; «колонка… щоб видалити товар з
 *  основного каталогу і він пропав і перенісся в видалені товари які більше не попадуть в фід». Колонки-команди (Catalog Controls)
 *  у TEST немає, тому — лише явний список ID від власника: повна копія рядка → «Видалені товари» (за заголовком САМОГО архіву:
 *  він створений раніше, ніж у каталозі з'явились нові колонки), видалення з каталогу за ключем зі знімком, Offer ID → «Заморожені ID».
 *  Захист: непорожня колонка каталогу, якої немає в архіві, — відмова (дані не губляться); ID у каталозі не рівно один раз — відмова. */
const ARCHIVE_SERVICE = Object.freeze({ deleted: "Видалено", op: "Операція видалення", status: "Статус видалення", feed: "YML без товару" });

/** → { moves: [{ id, archiveRow, expect }], refused: [{id, reason}], missing: [ID] } */
export function refreezePlan(mainValues, archiveValues, { ids = [], stamp = "", reason = "" } = {}) {
  const mh = (mainValues?.[0] || []).map((x) => mtText(x).trim()), ah = (archiveValues?.[0] || []).map((x) => mtText(x).trim());
  const mi = mh.indexOf("Offer ID"), ai = ah.indexOf("Offer ID");
  if (mi < 0) throw new Error("«" + MAIN + "»: немає колонки «Offer ID»");
  if (ai < 0) throw new Error("«" + ARCHIVE_SHEET_REFREEZE + "»: немає колонки «Offer ID»");
  const want = [...new Set(ids.map((x) => mtText(x).trim()).filter(Boolean))];
  const rowsOf = new Map();
  for (const r of mainValues.slice(1)) { const id = mtText(r[mi]).trim(); if (want.includes(id)) rowsOf.set(id, [...(rowsOf.get(id) || []), r]); }
  const moves = [], refused = [], missing = [];
  for (const id of want) {
    if (!/^\d+$/.test(id)) { refused.push({ id, reason: "Offer ID — лише цифри" }); continue; }
    const found = rowsOf.get(id) || [];
    if (!found.length) { missing.push(id); continue; }
    if (found.length > 1) { refused.push({ id, reason: `у «${MAIN}» ${found.length} рядки з цим Offer ID` }); continue; }
    const row = found[0];
    const value = (col) => mtText(row[mh.indexOf(col)] ?? "");
    const lost = mh.filter((c, i) => c && !ah.includes(c) && mtText(row[i] ?? "").trim() !== "");
    if (lost.length) { refused.push({ id, reason: "в архіві немає колонок із даними: " + lost.join(", ") }); continue; }
    const service = { [ARCHIVE_SERVICE.deleted]: stamp, [ARCHIVE_SERVICE.op]: "refreeze:" + stamp, [ARCHIVE_SERVICE.status]: reason || "рішення власника: не продаємо (заморожено)", [ARCHIVE_SERVICE.feed]: "" };
    const archiveRow = ah.map((c) => (c in service ? service[c] : mh.includes(c) ? value(c) : ""));
    const expect = Object.fromEntries(mh.filter(Boolean).map((c) => [c, value(c)]));
    moves.push({ id, archiveRow, expect });
  }
  return { moves, refused, missing };
}

/** Виконання через сесію шлюзу «sync» (оренда, журнал, fencing). → { state: "REFROZEN"|"NOTHING"|"BLOCKED"|"INCOMPLETE", … } */
export async function refreezeIds({ session, sheets, readBook, stamp, ids = [], reason = "" }) {
  if (!session || session.state !== "READY") return { state: "BLOCKED", reason: `шлюз запису: ${session?.state || "немає сесії"} — нічого не записано` };
  const book = await readBook([MAIN, ARCHIVE_SHEET_REFREEZE, FROZEN_SHEET]);
  if (!book[ARCHIVE_SHEET_REFREEZE]?.length) return { state: "BLOCKED", reason: "немає аркуша «" + ARCHIVE_SHEET_REFREEZE + "»" };
  if (!book[FROZEN_SHEET]?.length) return { state: "BLOCKED", reason: "немає аркуша «" + FROZEN_SHEET + "»" };
  const plan = refreezePlan(book[MAIN], book[ARCHIVE_SHEET_REFREEZE], { ids, stamp, reason });
  const frozenHave = () => readBook([FROZEN_SHEET]).then((b) => new Set((b[FROZEN_SHEET] || []).slice(1).map((r) => mtText(r?.[0]).trim()).filter(Boolean)));
  if (!plan.moves.length) return { state: "NOTHING", reason: "немає рядків для перенесення", refused: plan.refused, missing: plan.missing };
  // 1) копія в архів (без дублів за ключем) — до будь-якого видалення
  const a = await session.appendMissingByKey({ title: ARCHIVE_SHEET_REFREEZE, rows: plan.moves.map((m) => m.archiveRow), generation: "refreeze:" + stamp });
  if (![OP.VERIFIED, OP.NOTHING].includes(a.outcome)) return { state: "INCOMPLETE", step: "archive", outcome: a.outcome, refused: plan.refused, missing: plan.missing };
  const archived = new Set((await readBook([ARCHIVE_SHEET_REFREEZE]))[ARCHIVE_SHEET_REFREEZE].slice(1).map((r) => mtText(r[(book[ARCHIVE_SHEET_REFREEZE][0] || []).map((x) => mtText(x).trim()).indexOf("Offer ID")]).trim()));
  const ready = plan.moves.filter((m) => archived.has(m.id));
  if (ready.length !== plan.moves.length) return { state: "INCOMPLETE", step: "archive-check", notArchived: plan.moves.filter((m) => !archived.has(m.id)).map((m) => m.id) };
  // 2) видалення з каталогу за ключем зі знімком усього рядка
  const d = await session.deleteByKeys({ title: MAIN, rows: ready.map((m) => ({ key: m.id, expect: m.expect })), generation: "refreeze-main:" + stamp });
  const deleted = (d.items || []).filter((x) => x.status === "VERIFIED" || x.status === "ALREADY").map((x) => x.key);
  // 3) Offer ID → «Заморожені ID» (лише відсутні; повтор не дублює)
  const have = await frozenHave();
  const add = deleted.filter((id) => !have.has(id));
  if (add.length) await sheets.appendRows(FROZEN_SHEET, add.map((id) => [id]));
  const frozenNow = await frozenHave();
  const frozen = deleted.filter((id) => frozenNow.has(id));
  const note = `у «${ARCHIVE_SHEET_REFREEZE}» і «${FROZEN_SHEET}»: ${deleted.join(", ") || "—"}`;
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", deleted.join(", ").slice(0, 1000), "СТРУКТУРА", "", note.slice(0, 1000), reason || "рішення власника: не продаємо (заморожено)"]]);
  const ok = deleted.length === plan.moves.length && frozen.length === deleted.length;
  return { state: ok ? "REFROZEN" : "INCOMPLETE", archived: ready.map((m) => m.id), deleted, frozen, refused: plan.refused, missing: plan.missing, archiveOutcome: a.outcome, deleteOutcome: d.outcome };
}
