/** Рішення власника 04.11.2026: нова підгрупа в «Групах» (напр. «Ножиці по металу» у «Верстатах») — лише дописування одного рядка.
 *  Перевірки: ID ще немає, батьківська група є, назви UA / RU непорожні й не повторюють сусідню групу того самого батька.
 *  Наявні групи й товари не змінюються (товари переносить окремий план owner-edits). */
import { mtText } from "../core/text.mjs";
import { GROUP_HEADERS } from "../core/seal.mjs";

const SHEET = "Групи";

export function groupRow(header, g) {
  const h = header.map((x) => mtText(x).trim());
  if (GROUP_HEADERS.some((k) => !h.includes(k))) throw new Error("аркуш «Групи» без потрібних колонок");
  const val = { "Ідентифікатор_групи": g.id, "Назва_групи_укр": g.ua, "Назва_групи": g.ru, "Ідентифікатор_батьківської_групи": g.parent };
  return h.map((k) => val[k] ?? "");
}

export async function addGroup({ sheets, readBook, stamp, group }) {
  const g = { id: mtText(group?.id).trim(), ua: mtText(group?.ua).trim(), ru: mtText(group?.ru).trim(), parent: mtText(group?.parent).trim() };
  if (!/^\d+$/.test(g.id) || !g.ua || !g.ru || !/^\d+$/.test(g.parent)) return { state: "BLOCKED", reason: "група: потрібні числові id і parent та назви UA / RU" };
  const v = (await readBook([SHEET]))[SHEET];
  if (!v?.length) return { state: "BLOCKED", reason: "немає аркуша «Групи»" };
  const h = v[0].map((x) => mtText(x).trim()), c = (k) => h.indexOf(k);
  const rows = v.slice(1).map((r) => ({ id: mtText(r[c("Ідентифікатор_групи")]).trim(), ua: mtText(r[c("Назва_групи_укр")]).trim(), parent: mtText(r[c("Ідентифікатор_батьківської_групи")]).trim() }));
  if (rows.some((r) => r.id === g.id)) return { state: "NOTHING", reason: "група " + g.id + " уже є" };
  if (!rows.some((r) => r.id === g.parent)) return { state: "BLOCKED", reason: "немає батьківської групи " + g.parent };
  if (rows.some((r) => r.parent === g.parent && r.ua.toLowerCase() === g.ua.toLowerCase())) return { state: "BLOCKED", reason: "у цьому розділі вже є група «" + g.ua + "»" };
  await sheets.appendRows(SHEET, [groupRow(v[0], g)]);
  const after = (await readBook([SHEET]))[SHEET];
  const n = after.slice(1).filter((r) => mtText(r[c("Ідентифікатор_групи")]).trim() === g.id).length;
  if (n !== 1) return { state: "INCOMPLETE", reason: `після запису група ${g.id} зустрічається ${n} раз(и)` };
  await sheets.appendRows("Журнал", [[stamp, "СИСТЕМА", "", "СТРУКТУРА", "", `нова група ${g.id} «${g.ua}» / «${g.ru}» у ${g.parent}`, "рішення власника 04.11"]]);
  return { state: "GROUP_ADDED", group: g };
}
