/**
 * Майстерня Маркет — кнопки нової системи в таблиці TEST (ENG-29).
 * Скрипт НІЧОГО не рахує й не пише в таблицю: лише надсилає сигнал серверу mm-ops (Cloudflare), а всю роботу виконує сервер
 * (GitHub Actions через шлюз запису W2). Повторне натискання під час виконання — сервер відповідає «уже виконується».
 * Ключ кнопок — НЕ в коді, а у «Властивостях скрипта» (Налаштування проєкту → Властивості скрипта → MM_OPS_KEY): у редакторі
 * й на знімках екрана його не видно. Ключ дає доступ лише до запуску кнопок і їхнього стану.
 */
var MM_OPS_URL = "__MM_OPS_URL__";

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Майстерня")
    .addItem("Знайти нові товари", "mmFindNew")
    .addItem("Перенести затверджені", "mmTransfer")
    .addItem("Оновити товари", "mmUpdate")
    .addItem("Оновити ціни й наявність", "mmPrices")
    .addSeparator()
    .addItem("Стан останньої операції", "mmStatus")
    .addToUi();
}

function mmFindNew() { mmRun_("find-new"); }
function mmTransfer() { mmRun_("transfer"); }
function mmUpdate() { mmRun_("update"); }
function mmPrices() { mmRun_("prices"); }

function mmRun_(op) {
  var r = mmCall_({ op: op });
  SpreadsheetApp.getUi().alert(r.message || "Сервер не дав відповіді");
}

function mmStatus() {
  var r = mmCall_({ op: "status" });
  if (r.message) { SpreadsheetApp.getUi().alert(r.message); return; }
  var lines = [];
  if (r.active) lines.push("Зараз виконується: «" + r.active.label + "»");
  (r.last || []).forEach(function (x) {
    lines.push(Utilities.formatDate(new Date(x.at), "Europe/Kyiv", "dd.MM HH:mm") + " — " + x.label + ": " + mmStatusUa_(x.status) + (x.summary ? "\n" + x.summary : ""));
  });
  SpreadsheetApp.getUi().alert(lines.length ? lines.join("\n\n") : "Операцій ще не було");
}

function mmStatusUa_(s) {
  return { DISPATCHING: "запускається", QUEUED: "у черзі", RUNNING: "виконується", DONE: "завершено", FAILED: "не виконано", DISPATCH_FAILED: "не запущено" }[s] || s;
}

function mmCall_(body) {
  var key = PropertiesService.getScriptProperties().getProperty("MM_OPS_KEY");
  if (!key) return { message: "Ключ кнопок не налаштовано: Apps Script → Налаштування проєкту → Властивості скрипта → MM_OPS_KEY." };
  try {
    var res = UrlFetchApp.fetch(MM_OPS_URL + "/button", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 401) return { message: "Сервер не прийняв ключ кнопок (ключ замінено?) — оновіть MM_OPS_KEY у Властивостях скрипта." };
    if (res.getResponseCode() !== 200) return { message: "Сервер не відповів (HTTP " + res.getResponseCode() + "). Спробуйте пізніше." };
    return JSON.parse(res.getContentText());
  } catch (e) {
    return { message: "Немає зв'язку із сервером: " + e };
  }
}
