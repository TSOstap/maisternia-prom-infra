/**
 * Мінімальний обробник подій ручного редагування (рішення власника 29.10: дозволено, але БЕЗ другої системи синхронізації).
 *
 * Що робить: записує в службовий аркуш «Події редагування» факт ручної правки — час, аркуш, Offer ID рядка, колонку.
 * Чого НЕ робить: не змінює товари, не синхронізує, не пише в Prom / YML, не звертається до інших таблиць.
 * Навіщо: значення, яке власник увів і яке збігається з поточним (повторне введення того самого), неможливо відрізнити від
 * «нічого не змінено» за розбіжністю. Подія onEdit дає це розрізнення. Записи API (нова система) тригерів не запускають:
 * «Script executions and API requests don't cause triggers to run» (developers.google.com/apps-script/guides/triggers).
 * Нова система читає «Події редагування» на початку синхронізації (field-control: edited) і лише позначає поля CUSTOM.
 *
 * Встановлення — ТІЛЬКИ в КОПІЇ для тестів, до окремого дозволу на робочу таблицю:
 *   Розширення → Apps Script → новий файл → вставити цей код → зберегти → Тригери → Додати тригер:
 *   функція onOwnerEdit, джерело «З таблиці», подія «Під час редагування» (installable onEdit).
 */
var LOG_SHEET = "Події редагування";
var WATCH = { "Основний каталог": true, "Нові товари": true };
var KEY = "Offer ID";

function onOwnerEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  var name = sheet.getName();
  if (!WATCH[name]) return;
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var keyCol = header.indexOf(KEY);
  if (keyCol < 0) return;
  var r0 = e.range.getRow(), c0 = e.range.getColumn();
  var rows = e.range.getNumRows(), cols = e.range.getNumColumns();
  if (r0 + rows - 1 < 2) return; // лише заголовок
  var start = Math.max(r0, 2), n = r0 + rows - start;
  var keys = sheet.getRange(start, keyCol + 1, n, 1).getValues();
  var user = (e.user && e.user.getEmail && e.user.getEmail()) || "";
  var at = new Date().toISOString();
  var out = [];
  for (var i = 0; i < n; i++) {
    var offerId = String(keys[i][0] || "").trim();
    if (!offerId) continue;
    for (var j = 0; j < cols; j++) out.push([at, name, offerId, String(header[c0 - 1 + j] || ""), user]);
  }
  if (!out.length) return;
  var log = e.source.getSheetByName(LOG_SHEET) || e.source.insertSheet(LOG_SHEET);
  if (log.getLastRow() === 0) log.appendRow(["Час", "Аркуш", "Offer ID", "Колонка", "Користувач"]);
  log.getRange(log.getLastRow() + 1, 1, out.length, 5).setValues(out);
}
