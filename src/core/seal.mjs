/** Печатки цілісності — ті самі формули, що в mtBuildYml_ (Yml.LIVE-CURRENT.gs), щоб нова система
 *  могла звірятися з чинними MTY.idsSha / contentSha / groupsSha без перерахунку контенту.
 *
 *  seal(рядок)  = SHA256(JSON.stringify({незмінні колонки у порядку YML_HEADERS: mtText(значення)}))
 *  idsSha       = SHA256(відсортовані Offer ID, '\n')
 *  contentSha   = SHA256(відсортовані 'id\tseal', '\n')
 *  groupsSha    = SHA256(JSON.stringify(групи [id, ua, ru, parent] відсортовані за id через localeCompare)) */
import { mtText, sha256 } from "./text.mjs";
import { LIVE_COLUMNS } from "./sync-plan.mjs";

export const YML_HEADERS = Object.freeze([
  "Offer ID", "ID постачальника", "Артикул постачальника", "Назва UA", "Назва RU", "Ціна постачальника", "Ціна", "Ціна кінцева",
  "Знижка", "Наявність", "Кількість постачальника", "Стан синхронізації", "Оновлено", "Валюта", "Опис UA", "Опис RU", "Фото JSON",
  "Характеристики JSON", "Група ID", "Група UA", "Група RU", "Категорія Prom ID", "Категорія Prom URL", "GTIN", "Виробник", "Країна",
  "Запити UA", "Запити RU", "Назва постачальника UA", "Назва постачальника RU", "URL постачальника", "Модель", "Джерело контенту",
  "SHA256 контенту", "Унікальний ID Prom", "Код товару Prom", "Існує у Prom", "Статус імпорту", "Поля Prom JSON", "SHA256 незмінних полів",
]);

export const GROUP_HEADERS = Object.freeze(["Ідентифікатор_групи", "Назва_групи_укр", "Назва_групи", "Ідентифікатор_батьківської_групи"]);

export const SEAL_COLUMN = "SHA256 незмінних полів";
export const FROZEN_COLUMNS = Object.freeze(YML_HEADERS.filter((k) => !LIVE_COLUMNS.includes(k) && k !== SEAL_COLUMN));

export function rowSeal(row) {
  const frozen = Object.fromEntries(FROZEN_COLUMNS.map((k) => [k, mtText(row[k])]));
  return sha256(JSON.stringify(frozen));
}

export function idsSha(ids) {
  return sha256(ids.slice().sort().join("\n"));
}

export function contentSha(sealedLines) {
  return sha256(sealedLines.slice().sort().join("\n"));
}

export function canonicalGroups(groups) {
  return groups
    .map((g) => GROUP_HEADERS.map((k) => mtText(g[k])))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

export function groupsSha(groups) {
  return sha256(JSON.stringify(canonicalGroups(groups)));
}

/** Паспорт погодженого набору (замість жорстко вшитого MTY у Yml.gs). */
export function approvalManifest(rows, groups, extra = {}) {
  const ids = rows.map((r) => mtText(r["Offer ID"]));
  const lines = rows.map((r) => mtText(r["Offer ID"]) + "\t" + rowSeal(r));
  return {
    kind: "APPROVED_SET_V1",
    count: rows.length,
    idsSha: idsSha(ids),
    contentSha: contentSha(lines),
    groupsSha: groupsSha(groups),
    ...extra,
  };
}
