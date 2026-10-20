/** Керування лише службовими полями A:C аркуша «Налаштування». */
function mtBook_() {
  var id = PropertiesService.getScriptProperties().getProperty('TOOLS_SPREADSHEET_ID');
  if (!id) throw new Error('Задайте TOOLS_SPREADSHEET_ID');
  return SpreadsheetApp.openById(id);
}
function mtKyiv_(stamp) {
  if (!stamp) return 'Ще не виконувалося';
  var date = new Date(stamp);
  return Number.isFinite(date.getTime()) ? Utilities.formatDate(date,'Europe/Kyiv','dd.MM.yyyy HH:mm:ss') : 'Дата не підтверджена';
}
function mtSanitize_(error) {
  return mtText(error && error.message || error).replace(/https?:\/\/\S+/g,'[адресу приховано]').slice(0,1500);
}
function mtAutoStatus_() {
  var p = PropertiesService.getScriptProperties();
  var triggers = ScriptApp.getProjectTriggers().filter(function(t) {
    return t.getHandlerFunction()==='mtUpdate' && t.getEventType()===ScriptApp.EventType.CLOCK;
  });
  var known = triggers.length===1 && triggers[0].getUniqueId()===p.getProperty('TOOLS_FOUR_HOUR_TRIGGER_ID');
  var state=p.getProperty('TOOLS_SYNC_STATE');
  return {enabled:triggers.length>0, count:triggers.length, fourHoursConfirmed:known, syncState:state,
    lastSuccess:p.getProperty('TOOLS_LAST_SUCCESS'), lastAttempt:p.getProperty('TOOLS_LAST_ATTEMPT'),
    lastError:p.getProperty('TOOLS_LAST_ERROR') || (state==='UPDATING'?'Запуск ще не завершений; якщо минуло понад 6 хвилин — перевірте Executions (можливе переривання Google).':'')};
}
function mtFeedUrl_() {
  var p = PropertiesService.getScriptProperties(), base = p.getProperty('TOOLS_YML_WEB_APP_URL'), key = p.getProperty('TOOLS_YML_ACCESS_KEY');
  if (!base) return '';
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(base)) throw new Error('TOOLS_YML_WEB_APP_URL: потрібна постійна адреса вебзастосунку /exec без параметрів');
  return key ? base+'?key='+encodeURIComponent(key) : '';
}
function mtActiveManifest_() {
  var raw = PropertiesService.getScriptProperties().getProperty('TOOLS_YML_ACTIVE');
  return raw ? JSON.parse(raw) : null;
}
function mtRefreshSettings_() {
  var p = PropertiesService.getScriptProperties(), status = mtAutoStatus_(), active = mtActiveManifest_();
  var sheet = mtBook_().getSheetByName('Налаштування'); if (!sheet) throw new Error('Немає аркуша Налаштування');
  var url = mtFeedUrl_(), lastError = p.getProperty('TOOLS_YML_LAST_ERROR') || '';
  var fields = [
    ['Автооновлення Google Sheets',status.enabled?'Увімкнене':'Вимкнене','Фактичні часові тригери mtUpdate поточного акаунта: '+status.count+'. Інші власники не видимі.'],
    ['Періодичність автооновлення',status.fourHoursConfirmed?'Кожні 4 години':'Кожні 4 години — заплановано; період не підтверджено','Google не повертає розклад тригера. Для підтвердження чинного ID один раз виконайте mtEnableFourHours.'],
    ['Останнє оновлення цін і наявності',mtKyiv_(status.lastSuccess),'Лише успішна транзакція mtUpdate. Час Києва (Europe/Kyiv).'],
    ['Остання спроба оновлення',mtKyiv_(status.lastAttempt),'Не є підтвердженням успіху. Час Києва.'],
    ['Помилка останнього оновлення',status.lastError || 'Немає','Помилка синхронізації; після успіху очищується.'],
    ['Останнє формування YML',mtKyiv_(active && active.generatedAt),'Лише сформований, перевірений і збережений YML; preview не враховується. Час Києва.'],
    ['Останній успішний імпорт у Prom','Не підтверджено','Немає підключеного достовірного звіту завершення імпорту Prom. mtUpdate, формування та HTTP-запит не доводять імпорт.'],
    ['YML-посилання для Prom',url || 'Ще не опубліковано','Постійна адреса /exec; не URL попереднього перегляду Drive. Посилання з ключем не публікувати.'],
    ['Останнє успішне оновлення YML-посилання',mtKyiv_(active && active.publishedAt),'Перемикання останньої перевіреної версії; не час імпорту в Prom. Час Києва.'],
    ['Остання перевірка доступності YML',mtKyiv_(p.getProperty('TOOLS_YML_HTTP_CHECK_AT')),'Перевірка HTTP/XML без звернення до Prom.'],
    ['Автоматичне формування YML',p.getProperty('TOOLS_YML_AUTO')==='yes'?'Увімкнене':'Вимкнене','Після успішного mtUpdate; окремого тригера немає.'],
    ['Стан YML',lastError ? 'ПОМИЛКА: '+lastError : active ? 'Збережена перевірена версія: '+active.count+' товарів' : 'Ще не сформовано','При помилці нової версії попередня залишається доступною; перевіряйте її вік.']
  ];
  var existing = sheet.getRange(1,1,Math.max(1,sheet.getLastRow()),3).getValues(), positions = {};
  fields.forEach(function(f) {
    var matches = []; existing.forEach(function(r,i) { if (r[0]===f[0]) matches.push(i+1); });
    if (matches.length>1) throw new Error('Повтор службового поля: '+f[0]);
    positions[f[0]] = matches[0] || 0;
  });
  var next = Math.max(1,sheet.getLastRow())+1;
  var needed=next-1+fields.filter(function(f) {return !positions[f[0]];}).length;
  if (needed>sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),needed-sheet.getMaxRows());
  fields.forEach(function(f) { sheet.getRange(positions[f[0]] || next++,1,1,3).setValues([f.map(mtSafeCell)]); });
  return status;
}
function mtRefreshSettingsSafely_() {
  try { return mtRefreshSettings_(); }
  catch (e) { console.warn('Не оновлено службові поля: '+mtSanitize_(e)); return null; }
}
function mtCheckAutoUpdate() {
  var s = mtRefreshSettings_();
  var text = 'Автооновлення: '+(s.enabled?'УВІМКНЕНЕ':'ВИМКНЕНЕ')+'\n'+
    'Періодичність: кожні 4 години'+(s.fourHoursConfirmed?' (ID створеного тригера підтверджено)':' — розклад існуючого тригера API не розкриває')+'\n'+
    'Активний часовий тригер mtUpdate: '+(s.enabled?'так ('+s.count+')':'ні')+'\n'+
    'Останнє успішне оновлення: '+mtKyiv_(s.lastSuccess)+' (Київ)\n'+
    'Помилка останнього запуску: '+(s.lastError || 'немає')+'\n\n'+
    'Перевірено фактичні тригери поточного акаунта. Тригери інших власників не видимі.'+
    (s.count>1?'\nУвага: дубль тригерів. Виконайте «Увімкнути кожні 4 години» один раз.':'');
  SpreadsheetApp.getUi().alert('Стан автооновлення',text,SpreadsheetApp.getUi().ButtonSet.OK);
  return s;
}
function mtYmlLog_(field, message) {
  var sheet = mtBook_().getSheetByName('Журнал');
  if (!sheet) throw new Error('Немає аркуша Журнал');
  sheet.appendRow([new Date().toISOString(),'YML','',field,'','',mtSafeCell(message)]);
}
function mtAfterUpdate_() {
  var p = PropertiesService.getScriptProperties(), result = {automatic:false};
  if (p.getProperty('TOOLS_YML_AUTO')==='yes') {
    try { var saved = mtPublishYml_(); result = {automatic:true,count:saved.count,reused:saved.reused}; }
    catch (error) {
      result = {automatic:true,error:mtSanitize_(error)};
      p.setProperty('TOOLS_YML_LAST_ERROR',result.error);
      try { mtYmlLog_('ПОМИЛКА',result.error); } catch (ignored) { console.warn('Не записано помилку YML у журнал'); }
    }
  }
  mtRefreshSettingsSafely_(); return result;
}
function mtEnableYmlAutomation() {
  mtCheckPublicYml(); // Реальна перевірка анонімної адреси до увімкнення.
  PropertiesService.getScriptProperties().setProperty('TOOLS_YML_AUTO','yes');
  mtRefreshSettings_();
}
function mtDisableYmlAutomation() {
  PropertiesService.getScriptProperties().setProperty('TOOLS_YML_AUTO','no');
  mtRefreshSettings_();
}
