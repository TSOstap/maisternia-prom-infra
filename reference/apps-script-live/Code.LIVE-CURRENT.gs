/** «Майстерня Маркет»: ціни/наявність; YML і керування — у Management.gs та Yml.gs. */
var MT = {
  sheets: ['Основний каталог', 'Нові товари'],
  liveColumns: ['Ціна постачальника', 'Ціна', 'Ціна кінцева', 'Знижка', 'Наявність', 'Кількість постачальника', 'Стан синхронізації', 'Оновлено'],
  extra: 5, markup: 0.25, discount: 20, rounding: 0.01,
  minimumOffers: 4157, maximumAgeHours: 48
};
function mtText(v) { return String(v == null ? '' : v); }
function mtKey(v) { return mtText(v).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(); }
function mtSku(v) { return mtText(v).split(',').map(function(x) { return x.trim(); }).filter(Boolean).sort().join(','); }
function mtMoney(v) { return Math.round(v * 100) / 100; }
function mtPrices(price, available) {
  if (!Number.isFinite(price) || price <= 0 || typeof available !== 'boolean') throw new Error('Невалідні ціна або наявність');
  var final = mtMoney(price + MT.extra);
  return { final: final, base: mtMoney(Math.round(final * (1 + MT.markup) / MT.rounding) * MT.rounding), discount: available ? '20%' : '', availability: available ? '+' : '-' };
}
function mtDecode(v) {
  return mtText(v).replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, function(all, key) {
    if (key[0] === '#') return String.fromCodePoint(key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1)));
    return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[key.toLowerCase()] || all;
  });
}
function mtTag(body, name) {
  var m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(body);
  return m ? mtDecode(m[1]).trim() : '';
}
function mtAttr(attrs, name) {
  var m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(["\u0027])([\\s\\S]*?)\\1').exec(attrs);
  return m ? mtDecode(m[2]) : '';
}
/** Парсер спільний для локальних тестів і Google. Дубль ID зупиняє весь запуск. */
function mtParse(xml) {
  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE yml_catalog SYSTEM [^>]*>\s*)?<yml_catalog\b/.test(xml) || !/<\/yml_catalog>\s*$/.test(xml)) throw new Error('Неповний YML');
  if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(xml)) throw new Error('Непідтримувані XML-сутності');
  if (!/<shop\b/.test(xml) || !/<offers>/.test(xml) || !/<\/offers>/.test(xml)) throw new Error('Неповна структура YML');
  var offers = Object.create(null), count = 0, re = /<offer\b([^>]*)>([\s\S]*?)<\/offer>/g, m;
  while ((m = re.exec(xml))) {
    var id = mtAttr(m[1], 'id');
    if (!/^\d+$/.test(id) || offers[id]) throw new Error('Невалідний або повторений ID у YML');
    var p = mtTag(m[2], 'price'), a = mtAttr(m[1], 'available');
    offers[id] = { id:id, sku:mtTag(m[2], 'vendorCode'), nameUa:mtTag(m[2], 'name_ua'), nameRu:mtTag(m[2], 'name'),
      price:p.trim() ? Number(p) : null, available:a === 'true' ? true : a === 'false' ? false : null,
      currency:mtTag(m[2], 'currencyId'), quantity:mtTag(m[2], 'quantity_in_stock'), url:mtTag(m[2], 'url'), gtin:mtTag(m[2], 'barcode') || mtTag(m[2], 'gtin') };
    count++;
  }
  if (count !== (xml.match(/<offer\b/g) || []).length) throw new Error('Пошкоджений запис offer');
  var date = /<yml_catalog\b([^>]*)>/.exec(xml);
  return { offers:offers, count:count, date:date ? mtAttr(date[1], 'date') : '' };
}
function mtMatch(row, offer) {
  if (!offer) return 'ВІДСУТНІЙ_У_YML';
  if (mtText(row['ID постачальника']) !== offer.id) return 'КОНФЛІКТ_ID';
  var expectedSku = mtSku(row['Артикул постачальника']), actualSku = mtSku(offer.sku);
  if (expectedSku !== actualSku) return 'КОНФЛІКТ_АРТИКУЛА';
  if (!expectedSku && (!row['URL постачальника'] || row['URL постачальника'] !== offer.url || !row['Назва постачальника UA'] || !row['Назва постачальника RU'])) return 'КОНФЛІКТ_АРТИКУЛА';
  var checked = 0;
  for (var pair of [['Назва постачальника UA','nameUa'],['Назва постачальника RU','nameRu']]) {
    if (row[pair[0]]) { checked++; if (!offer[pair[1]] || mtKey(row[pair[0]]) !== mtKey(offer[pair[1]])) return 'ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ'; }
  }
  if (!checked) return 'НЕМАЄ_ОПОРНОЇ_НАЗВИ';
  if (offer.currency !== 'UAH') return 'НЕВІДОМА_ВАЛЮТА';
  if (!Number.isFinite(offer.price) || offer.price <= 0) return 'НЕВАЛІДНА_ЦІНА';
  if (typeof offer.available !== 'boolean') return 'НЕВІДОМА_НАЯВНІСТЬ';
  if (offer.quantity !== '' && (!/^\d+(?:\.\d+)?$/.test(offer.quantity) || !Number.isFinite(Number(offer.quantity)))) return 'НЕВАЛІДНА_КІЛЬКІСТЬ';
  return 'ЗІСТАВЛЕНО';
}
/** Еквівалентність знижки — та сама, що приймає генератор YML: «20%» ≡ число 0.2 (допуск 1e-9); '' — без знижки.
 *  Інші подання (« 20%», «0,2», 20) еквівалентними не вважаються — їх нормалізує звичайний запис. */
function mtSameDiscount_(a, b) {
  var value = function(v) {
    if (v === '' || v == null) return '';
    if (typeof v === 'number') return v;
    var m = /^(\d+(?:\.\d+)?)%$/.exec(mtText(v));
    return m ? Number(m[1]) / 100 : NaN;
  };
  var x = value(a), y = value(b);
  if (x === '' || y === '') return x === y;
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-9;
}
/** Компактні заміри етапів: один рядок console на етап; підсумок — у журнал запуску. */
function mtTimer_(action) { var now = Date.now(); return { action: action, start: now, last: now, ms: {} }; }
function mtLap_(t, stage, ms) {
  var now = Date.now(); t.ms[stage] = ms == null ? now - t.last : ms; t.last = now;
  console.log(JSON.stringify({ дія: t.action, етап: stage, мс: t.ms[stage], відПочаткуМс: now - t.start }));
}
/** Чистий план: помилки не замінюють перевірені операційні значення порожнечею. */
function mtPlan(rows, parsed, stamp) {
  var seen = Object.create(null);
  return rows.map(function(row) {
    var id = mtText(row['Offer ID']);
    if (!id || seen[id]) throw new Error('Повторений або порожній Offer ID у таблиці');
    seen[id] = true;
    var before = MT.liveColumns.map(function(k) { return row[k] == null ? '' : row[k]; });
    var match = mtMatch(row, parsed.offers[mtText(row['ID постачальника'])]);
    var next = before.slice();
    if (match === 'ЗІСТАВЛЕНО') {
      var offer = parsed.offers[mtText(row['ID постачальника'])], p = mtPrices(offer.price, offer.available);
      next = [offer.price, p.base, p.final, p.discount, p.availability, offer.quantity === '' ? before[5] : Number(offer.quantity), match, stamp];
      // Та сама знижка в іншому поданні (0.2 у %-клітинці = «20%») — не зміна: лишаємо записане значення.
      if (mtSameDiscount_(before[3], next[3])) next[3] = before[3];
    } else if (match === 'ВІДСУТНІЙ_У_YML') {
      // Повний здоровий фід доводить відсутність; стару ціну зберігаємо, продаж вимикаємо.
      next[3] = ''; next[4] = '-'; next[5] = ''; next[6] = match; next[7] = stamp;
    } else { next[6] = match; next[7] = stamp; }
    return { id:id, before:before, next:next, match:match };
  });
}
function mtHeaders(values) {
  var header = values[0], required = ['Offer ID','ID постачальника','Артикул постачальника','Назва постачальника UA','Назва постачальника RU'].concat(MT.liveColumns);
  required.forEach(function(k) { if (header.indexOf(k) < 0 || header.indexOf(k) !== header.lastIndexOf(k)) throw new Error('Немає унікальної колонки: ' + k); });
  var start = header.indexOf(MT.liveColumns[0]);
  MT.liveColumns.forEach(function(k, i) { if (header[start+i] !== k) throw new Error('Змінено порядок операційних колонок'); });
  return { header:header, start:start, rows:values.slice(1).filter(function(r) { return r.some(function(v) { return v !== ''; }); }).map(function(r) {
    return Object.fromEntries(header.map(function(k,i) { return [k,r[i]]; }));
  }) };
}
function mtOperationalUrl(full) {
  if (!/^https:\/\/market-tools\.com\.ua\//i.test(full)) throw new Error('Потрібна HTTPS-адреса YML Market Tools');
  function set(key, value) {
    var re = new RegExp('([?&])'+key+'=[^&]*');
    full = re.test(full) ? full.replace(re, '$1'+key+'='+encodeURIComponent(value)) : full+(full.indexOf('?')<0?'?':'&')+key+'='+encodeURIComponent(value);
  }
  set('exclude_fields','description,picture,param,keywords'); set('html_description','0'); set('extra_fields','0');
  return full;
}
function mtValidateFeed(parsed, previousCount, now) {
  if (parsed.count < Math.max(MT.minimumOffers, Number(previousCount || 0)*0.8)) throw new Error('Неповний фід: різке зменшення кількості ID');
  var date = typeof Utilities !== 'undefined' ? Utilities.parseDate(parsed.date, 'Europe/Kyiv', 'yyyy-MM-dd HH:mm').getTime() : new Date(parsed.date.replace(' ', 'T') + '+03:00').getTime();
  if (!Number.isFinite(date)) throw new Error('Немає дати YML');
  var age = now - date;
  if (age > MT.maximumAgeHours*3600000 || age < -2*3600000) throw new Error('Застарілий або майбутній YML');
}
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Інструменти — синхронізація')
    .addItem('Самоперевірка без запису','mtSelfTest').addItem('Перевірити живий YML без запису','mtPreview')
    .addItem('Оновити ціни та наявність','mtUpdate').addSeparator()
    .addItem('Перевірити автооновлення','mtCheckAutoUpdate')
    .addItem('Увімкнути кожні 4 години','mtEnableFourHours').addItem('Вимкнути автооновлення','mtDisableFourHours').addSeparator()
    .addItem('Перевірити формування YML без запису','mtPreviewYml')
    .addItem('Зберегти YML у Drive','mtSaveYmlToDrive')
    .addItem('Перевірити постійне YML-посилання','mtCheckPublicYml')
    .addItem('Увімкнути автоматичне формування YML','mtEnableYmlAutomation')
    .addItem('Вимкнути автоматичне формування YML','mtDisableYmlAutomation').addToUi();
}
function mtRun(write) {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) throw new Error('Синхронізація вже виконується');
  var props = PropertiesService.getScriptProperties(), ss, applied = [], oldSuccess = props.getProperty('TOOLS_LAST_SUCCESS'), successChanged = false;
  var timer = mtTimer_(write ? 'mtUpdate' : 'mtPreview');
  try {
    var sheetId = props.getProperty('TOOLS_SPREADSHEET_ID');
    if (!sheetId) throw new Error('Задайте TOOLS_SPREADSHEET_ID у властивостях скрипта');
    ss = SpreadsheetApp.openById(sheetId);
    if (write) {props.setProperty('TOOLS_LAST_ATTEMPT',new Date().toISOString());props.setProperty('TOOLS_SYNC_STATE','UPDATING');}
    mtLap_(timer, 'книга');
    if (!props.getProperty('TOOLS_FEED_URL')) throw new Error('Задайте TOOLS_FEED_URL у властивостях скрипта');
    var response = UrlFetchApp.fetch(mtOperationalUrl(props.getProperty('TOOLS_FEED_URL')), {muteHttpExceptions:true, followRedirects:false});
    if (response.getResponseCode() !== 200) throw new Error('HTTP ' + response.getResponseCode());
    var xml = response.getContentText('UTF-8'); if (xml.length > 45000000) throw new Error('Фід перевищує безпечний розмір');
    mtLap_(timer, 'постачальник: отримання');
    var parsed = mtParse(xml); mtValidateFeed(parsed, props.getProperty('TOOLS_LAST_FEED_COUNT'), Date.now());
    mtLap_(timer, 'постачальник: розбір');
    var stamp = new Date().toISOString(), allIds = Object.create(null), readMs = 0, planMs = 0;
    // Обидва аркуші повністю перевіряються до першого запису.
    var plans = MT.sheets.map(function(name) {
      var t0 = Date.now();
      var sheet = ss.getSheetByName(name); if (!sheet) throw new Error('Немає аркуша ' + name);
      var values = sheet.getDataRange().getValues(), view = mtHeaders(values);
      readMs += Date.now() - t0;
      if (name === 'Основний каталог' && !view.rows.length) throw new Error('Основний каталог порожній');
      if (view.rows.length !== values.length-1) throw new Error('Порожній рядок усередині каталогу: ' + name);
      view.rows.forEach(function(r) { if (allIds[r['Offer ID']]) throw new Error('ID є в обох аркушах'); allIds[r['Offer ID']] = true; });
      var t1 = Date.now(), plan = mtPlan(view.rows,parsed,stamp); planMs += Date.now() - t1;
      return {name:name, sheet:sheet, start:view.start, rows:view.rows, plan:plan, original:values};
    });
    mtLap_(timer, 'читання аркушів', readMs); mtLap_(timer, 'зіставлення', planMs);
    var summary = {mode:write?'ОНОВЛЕННЯ':'ПЕРЕВІРКА_БЕЗ_ЗАПИСУ', feedDate:parsed.date, offers:parsed.count,
      sheets:plans.map(function(p) { return {name:p.name, rows:p.rows.length, matched:p.plan.filter(function(x) {return x.match==='ЗІСТАВЛЕНО';}).length, held:p.plan.filter(function(x) {return x.match!=='ЗІСТАВЛЕНО';}).length}; })};
    if (!write) { summary.timingsMs = timer.ms; console.log(JSON.stringify(summary)); return summary; }
    if (props.getProperty('TOOLS_PREVIEW_OK') !== 'yes') throw new Error('Спочатку виконайте mtPreview та задайте TOOLS_PREVIEW_OK=yes');
    var log = ss.getSheetByName('Журнал'); if (!log) throw new Error('Немає аркуша Журнал');
    var entries = [];
    // Optimistic check: ручні зміни між читанням і записом зупиняють запуск.
    plans.forEach(function(p) { if (JSON.stringify(p.sheet.getDataRange().getValues()) !== JSON.stringify(p.original)) throw new Error('Таблиця змінилася під час запуску'); });
    mtLap_(timer, 'контроль змін таблиці');
    props.setProperty('TOOLS_SYNC_STATE','UPDATING');
    plans.forEach(function(p) {
      p.plan.forEach(function(r) {
        MT.liveColumns.forEach(function(k,i) { if (i < 6 && mtText(r.before[i]) !== mtText(r.next[i])) entries.push([stamp,p.name,r.id,k,r.before[i],r.next[i],r.match]); });
        if (r.match !== 'ЗІСТАВЛЕНО') entries.push([stamp,p.name,r.id,'ПОМИЛКА','','',r.match]);
      });
    });
    mtLap_(timer, 'перевірка змін');
    plans.forEach(function(p) {
      if (!p.plan.length) return;
      applied.push(p);
      p.sheet.getRange(2,p.start+1,p.plan.length,MT.liveColumns.length).setValues(p.plan.map(function(r) { return r.next; }));
    });
    mtLap_(timer, 'запис F:M');
    summary.changes = entries.length; summary.timingsMs = timer.ms;
    entries.push([stamp,'СИСТЕМА','','ЗАВЕРШЕНО','',parsed.count,JSON.stringify(summary)]);
    log.getRange(log.getLastRow()+1,1,entries.length,7).setValues(entries.map(function(r) {return r.map(mtSafeCell);}));
    mtLap_(timer, 'журнал');
    props.setProperty('TOOLS_LAST_FEED_COUNT',String(parsed.count)); props.setProperty('TOOLS_LAST_SUCCESS',stamp); successChanged=true;
    props.setProperty('TOOLS_LAST_ATTEMPT',stamp); props.setProperty('TOOLS_LAST_ERROR','');
    props.setProperty('TOOLS_SYNC_STATE','OK');
    console.log(JSON.stringify(summary));return summary;
  } catch(error) {
    var rollbackErrors = [];
    if (write) {
      applied.slice().reverse().forEach(function(p) { try { p.sheet.getRange(2,p.start+1,p.plan.length,MT.liveColumns.length).setValues(p.plan.map(function(r) {return r.before;})); } catch(e) { rollbackErrors.push(p.name); } });
      props.setProperty('TOOLS_SYNC_STATE',rollbackErrors.length?'PARTIAL_ERROR':'ERROR');
      if (successChanged) {props.setProperty('TOOLS_LAST_SUCCESS',oldSuccess || '');}
    }
    // Секретна URL ніколи не потрапляє у журнал чи повідомлення.
    var message = mtText(error.message).replace(/https?:\/\/\S+/g,'[адресу приховано]') + (rollbackErrors.length ? '; неповне відновлення: '+rollbackErrors.join(', ') : '');
    if (write) { props.setProperty('TOOLS_LAST_ATTEMPT',new Date().toISOString()); props.setProperty('TOOLS_LAST_ERROR',message.slice(0,1500)); }
    if (write && ss && ss.getSheetByName('Журнал')) ss.getSheetByName('Журнал').appendRow([new Date().toISOString(),'СИСТЕМА','','ПОМИЛКА','','',mtSafeCell(message)]);
    throw new Error(message);
  } finally { lock.releaseLock(); }
}
function mtSafeCell(v) { return typeof v === 'string' && /^[=+@-]/.test(v) ? "'"+v : v; }
function mtPreview() { return mtRun(false); }
function mtUpdate() {
  var summary;
  try { summary = mtRun(true); }
  catch (error) {
    if (mtText(error.message)==='Синхронізація вже виконується') {
      var props=PropertiesService.getScriptProperties();props.setProperty('TOOLS_LAST_ATTEMPT',new Date().toISOString());props.setProperty('TOOLS_LAST_ERROR',error.message);
    }
    if (typeof mtRefreshSettingsSafely_ === 'function') mtRefreshSettingsSafely_(); throw error;
  }
  // Публікація — окрема транзакція: її збій не відкочує успішну синхронізацію.
  if (typeof mtAfterUpdate_ === 'function') summary.yml = mtAfterUpdate_();
  return summary;
}
function mtEnableFourHours() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('TOOLS_PREVIEW_OK') !== 'yes' || !p.getProperty('TOOLS_LAST_SUCCESS')) throw new Error('Спочатку успішні перевірка та ручне оновлення');
  var lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) throw new Error('Інша операція вже виконується');
  try {
    var old = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction()==='mtUpdate'; });
    // Спершу створюємо заміну: відмова авторизації не видалить чинний тригер.
    var trigger = ScriptApp.newTrigger('mtUpdate').timeBased().everyHours(4).create();
    p.setProperty('TOOLS_FOUR_HOUR_TRIGGER_ID',trigger.getUniqueId());
    old.forEach(function(t) { ScriptApp.deleteTrigger(t); });
  } finally { lock.releaseLock(); }
  if (typeof mtRefreshSettingsSafely_ === 'function') mtRefreshSettingsSafely_();
}
function mtDisableFourHours() {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) throw new Error('Інша операція вже виконується');
  try { ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction()==='mtUpdate') ScriptApp.deleteTrigger(t); }); }
  finally { lock.releaseLock(); }
  if (typeof mtRefreshSettingsSafely_ === 'function') mtRefreshSettingsSafely_();
}
function mtSelfTest() {
  var row = {'Offer ID':'1','ID постачальника':'1','Артикул постачальника':'A','Назва постачальника RU':'Модель A','Ціна':100,'Наявність':'+'};
  var parsed=mtParse('<yml_catalog date="2026-10-16 10:00"><shop><offers><offer id="1" available="true"><name>Модель A</name><vendorCode>A</vendorCode><price>100</price><currencyId>UAH</currencyId></offer></offers></shop></yml_catalog>');
  var plan=mtPlan([row],parsed,'test'); if(plan[0].next[1]!==131.25 || plan[0].next[2]!==105 || row['Ціна']!==100) throw new Error('Самоперевірка не пройдена');
  if (typeof mtYmlSelfTest_ === 'function') mtYmlSelfTest_();
  console.log('Самоперевірка PASS; записів у таблицю немає'); return true;
}
