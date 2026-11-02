/**
 * Майстерня Маркет — кнопки нової системи в таблиці TEST (ENG-29).
 * Скрипт НІЧОГО не рахує й не пише в таблицю: лише надсилає сигнал серверу mm-ops (Cloudflare), а всю роботу виконує сервер
 * (GitHub Actions через шлюз запису W2). Повторне натискання під час виконання — сервер відповідає «уже виконується».
 * Адреса й ключ підставляються в локальну копію файла (у репозиторії — заглушки; ключ кнопки дає доступ лише до /button і /status).
 */
var MM_OPS_URL = "__MM_OPS_URL__";
var MM_OPS_KEY = "__BUTTON_KEY__";

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Майстерня")
    .addItem("Знайти нові товари", "mmFindNew")
    .addItem("Перенести затверджені", "mmTransfer")
    .addItem("Оновити товари", "mmUpdate")
    .addSeparator()
    .addItem("Стан останньої операції", "mmStatus")
    .addToUi();
}

function mmFindNew() { mmRun_("find-new"); }
function mmTransfer() { mmRun_("transfer"); }
function mmUpdate() { mmRun_("update"); }

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
  try {
    var res = UrlFetchApp.fetch(MM_OPS_URL + "/button", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + MM_OPS_KEY },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) return { message: "Сервер не відповів (HTTP " + res.getResponseCode() + "). Спробуйте пізніше." };
    return JSON.parse(res.getContentText());
  } catch (e) {
    return { message: "Немає зв'язку із сервером: " + e };
  }
}
