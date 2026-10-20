/** Знімок YML — похідний результат основного аркуша, не друга база каталогу. */
var MTY = {
  count:5029,
  idsSha:'2720329d45d4d9457781dc06352e131d5116f049d00c3587f070259be2912a32',
  contentSha:'e2871d9e97b9b2f761d0d718da2e669cafaea35de0b311f49d6d1d605d7e56c2',
  groupsSha:'1b578d5fc44a412692e201722c13b26cc1edaf76438a611612da09e664941b38',
  maximumSyncAgeHours:12, maximumYmlBytes:50000000,
  publicCheckVersion:'mt-public-20261016-r2', publicCheckBudgetMs:240000,
  headers:['Offer ID','ID постачальника','Артикул постачальника','Назва UA','Назва RU','Ціна постачальника','Ціна','Ціна кінцева','Знижка','Наявність','Кількість постачальника','Стан синхронізації','Оновлено','Валюта','Опис UA','Опис RU','Фото JSON','Характеристики JSON','Група ID','Група UA','Група RU','Категорія Prom ID','Категорія Prom URL','GTIN','Виробник','Країна','Запити UA','Запити RU','Назва постачальника UA','Назва постачальника RU','URL постачальника','Модель','Джерело контенту','SHA256 контенту','Унікальний ID Prom','Код товару Prom','Існує у Prom','Статус імпорту','Поля Prom JSON','SHA256 незмінних полів'],
  groupHeaders:['Ідентифікатор_групи','Назва_групи_укр','Назва_групи','Ідентифікатор_батьківської_групи']
};
function mtSha_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(function(b) { return ('0'+((b+256)%256).toString(16)).slice(-2); }).join('');
}
function mtUtf8Length_(text) {var size=0;for(var ch of text){var cp=ch.codePointAt(0);size+=cp<128?1:cp<2048?2:cp<65536?3:4;}return size;}
/** У діагностиці тільки фіксовані назви етапів, час і стан — жодних URL/даних. */
function mtYmlTrace_(action,budget) {
  var trace={action:action,started:Date.now(),budget:budget || 0,steps:[]};
  console.log(JSON.stringify({версія:MTY.publicCheckVersion,дія:action,етап:'ЗАПУСК',стан:'початок'}));
  return trace;
}
function mtYmlStep_(trace,name,fn,commitStep) {
  if (!trace) return fn();
  var started=Date.now();
  console.log(JSON.stringify({версія:MTY.publicCheckVersion,дія:trace.action,етап:name,стан:'початок',відПочаткуМс:started-trace.started}));
  try {
    if (trace.budget && started-trace.started>=trace.budget) throw new Error('Вичерпано безпечний бюджет перевірки; успіх не зафіксовано');
    var result=fn(), elapsed=Date.now()-started;
    if (!commitStep && trace.budget && Date.now()-trace.started>=trace.budget) throw new Error('Перевірка перевищила безпечний бюджет; успіх не зафіксовано');
    trace.steps.push({stage:name,ms:elapsed});
    console.log(JSON.stringify({версія:MTY.publicCheckVersion,дія:trace.action,етап:name,стан:'готово',тривалістьМс:elapsed,відПочаткуМс:Date.now()-trace.started}));
    return result;
  } catch(error) {
    console.log(JSON.stringify({версія:MTY.publicCheckVersion,дія:trace.action,етап:name,стан:'помилка',тривалістьМс:Date.now()-started}));
    throw error;
  }
}
/** Приватний маніфест публікатора — довірений еталон, не дані HTTP-відповіді. */
function mtPublicManifest_(manifest) {
  if (!manifest || manifest.count!==MTY.count || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceDigest) || !/^[\w-]+$/.test(mtText(manifest.fileId)) ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes<=0 || manifest.bytes>MTY.maximumYmlBytes ||
      typeof manifest.sourceSuccess!=='string' || typeof manifest.generatedAt!=='string' ||
      !Number.isFinite(new Date(manifest.sourceSuccess).getTime()) || !Number.isFinite(new Date(manifest.generatedAt).getTime())) {
    throw new Error('Неповний або невідомий приватний маніфест YML; наявний файл не змінено');
  }
  return manifest;
}
/** Легкий повторний контроль всіх ID, без DOM описів/фото/характеристик. */
function mtAssertPublicIds_(xml) {
  var re=/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<offer\b([^>]*)>/g, ids=[], seen={}, match;
  while ((match=re.exec(xml))) {
    if (match[1]===undefined) continue;
    var id=mtAttr(match[1],'id');
    if (!/^\d+$/.test(id) || seen[id]) throw new Error('HTTP XML: невалідний або повторений ID');
    seen[id]=true;ids.push(id);
  }
  if (ids.length!==MTY.count || mtSha_(ids.sort().join('\n'))!==MTY.idsSha) throw new Error('HTTP XML: набір 5029 погоджених ID не підтверджений');
  return ids.length;
}
function mtXmlText_(v) {
  var s = mtText(v);
  // Не видаляємо заборонені символи мовчки: контент не переписується.
  for (var ch of s) { var cp=ch.codePointAt(0); if (!(cp===9 || cp===10 || cp===13 || cp>=32 && cp<=0xD7FF || cp>=0xE000 && cp<=0xFFFD || cp>=0x10000 && cp<=0x10FFFF)) throw new Error('Заборонений символ XML у перевіреному полі'); }
  return s;
}
function mtXml_(v) { return mtXmlText_(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;').replace(/\r/g,'&#13;'); }
function mtXmlAttr_(v) { return mtXml_(v).replace(/\n/g,'&#10;').replace(/\t/g,'&#9;'); }
function mtCdata_(v) { return '<![CDATA['+mtXmlText_(v).replace(/\]\]>/g,']]]]><![CDATA[>').replace(/\r/g,']]>&#13;<![CDATA[')+']]>'; }
function mtElement_(name,value) { return '<'+name+'>'+mtXml_(value)+'</'+name+'>'; }
function mtYmlSelfTest_() {
  if (MTY.count!==5029 || mtXml_('&<>')!=='&amp;&lt;&gt;' || mtCdata_('a]]>b')!=='<![CDATA[a]]]]><![CDATA[>b]]>') throw new Error('Самоперевірка YML не пройдена');
  return true;
}
function mtArray_(value,field,id) {
  var result; try { result=JSON.parse(mtText(value)); } catch(e) { throw new Error('Пошкоджений '+field+'; ID '+id); }
  if (!Array.isArray(result)) throw new Error('Не масив '+field+'; ID '+id);
  return result;
}
function mtHttpUrl_(value) {
  var url=mtText(value);
  if (!/^https?:\/\/[^\s<>"']+$/.test(url) || /products_feed|hash_tag|[?&](?:token|key|api_key|access_token)=/i.test(url)) throw new Error('Небезпечна або невалідна адреса у публічному полі');
  return url;
}
function mtObjects_(values,required) {
  if (!values.length) throw new Error('Порожній аркуш');
  var h=values[0].map(mtText);
  required.forEach(function(k) { if (h.indexOf(k)<0 || h.indexOf(k)!==h.lastIndexOf(k)) throw new Error('Немає унікальної колонки '+k); });
  return values.slice(1).map(function(row) {
    if (!row.some(function(v) {return v!=='' && v!=null;})) throw new Error('Порожній рядок усередині аркуша');
    return Object.fromEntries(h.map(function(k,i) { return [k,row[i]==null?'':row[i]]; }));
  });
}
/** Відбиток вмісту YML без атрибута date: ті самі товари, ціни, наявність, групи → той самий відбиток.
 *  «Оновлено» у YML не виводиться, тому mtUpdate без змін не створює новий файл. */
function mtYmlDigest_(xml) {
  var head=/^(<\?xml version="1\.0" encoding="UTF-8"\?>\n<yml_catalog date=")[^"]*"/;
  if (!head.test(xml)) throw new Error('Невідомий заголовок YML');
  return mtSha_(xml.replace(head,'$1"'));
}
/** Чиста функція: жодного запису, мережі, Drive чи зміни рядків. */
function mtBuildYml_(values,groupValues,meta) {
  if (meta.syncState!=='OK') throw new Error('Немає успішного завершеного mtUpdate');
  var success=new Date(meta.lastSuccess).getTime(), now=new Date(meta.now).getTime();
  if (!Number.isFinite(success) || !Number.isFinite(now) || now-success>MTY.maximumSyncAgeHours*3600000 || success>now+60000) throw new Error('Оновлення цін застаріле або дата невалідна');
  var rows=mtObjects_(values,MTY.headers), groups=mtObjects_(groupValues,MTY.groupHeaders);
  if (rows.length!==MTY.count) throw new Error('Потрібні рівно '+MTY.count+' товарів; отримано '+rows.length);
  var ids=rows.map(function(r) {return mtText(r['Offer ID']);}), seen={};
  ids.forEach(function(id) { if (!/^\d+$/.test(id) || seen[id]) throw new Error('Невалідний або повторений Offer ID'); seen[id]=true; });
  if (mtSha_(ids.slice().sort().join('\n'))!==MTY.idsSha) throw new Error('Набір дозволених ID змінився: публікацію зупинено');
  var sealed=[];
  rows.forEach(function(r) {
    var frozen=Object.fromEntries(MTY.headers.filter(function(k) {return MT.liveColumns.indexOf(k)<0 && k!=='SHA256 незмінних полів';}).map(function(k) {return [k,mtText(r[k])];}));
    var seal=mtSha_(JSON.stringify(frozen));
    if (seal!==mtText(r['SHA256 незмінних полів'])) throw new Error('Контент/identity змінено після QA; ID '+r['Offer ID']);
    sealed.push(r['Offer ID']+'\t'+seal);
  });
  if (mtSha_(sealed.sort().join('\n'))!==MTY.contentSha) throw new Error('Контрольні хеші погодженого контенту не збігаються');
  var canonicalGroups=groups.map(function(g) { return MTY.groupHeaders.map(function(k) {return mtText(g[k]);}); }).sort(function(a,b) {return a[0].localeCompare(b[0]);});
  if (mtSha_(JSON.stringify(canonicalGroups))!==MTY.groupsSha) throw new Error('Групи змінилися після QA');
  var groupMap={}, categories=canonicalGroups.map(function(g) {
    if (!/^\d+$/.test(g[0]) || groupMap[g[0]]) throw new Error('Невалідний або повторений ID групи');
    groupMap[g[0]]=g;
    // Prom документує одну текстову назву групи. UA додатково збережено в атрибуті,
    // його підтримку імпортером не припускаємо; обидві назви лишаються в таблиці.
    return '<category id="'+mtXml_(g[0])+'"'+(g[3]?' parentId="'+mtXml_(g[3])+'"':'')+' name_ua="'+mtXmlAttr_(g[1])+'">'+mtXml_(g[2])+'</category>';
  });
  canonicalGroups.forEach(function(g) { if (g[3] && !groupMap[g[3]]) throw new Error('Немає батьківської групи'); var chain={},id=g[0]; while(id) {if(chain[id]) throw new Error('Цикл груп');chain[id]=true;id=groupMap[id][3];} });
  var chunks=['<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="'+Utilities.formatDate(new Date(meta.now),'Europe/Kyiv','yyyy-MM-dd HH:mm')+'"><shop><name>Майстерня Маркет</name><company>Майстерня Маркет</company><currencies><currency id="UAH" rate="1"/></currencies><categories>'+categories.join('')+'</categories><offers>'];
  rows.forEach(function(r) {
    var id=mtText(r['Offer ID']);
    if (r['Статус імпорту']!=='ДОЗВОЛЕНО' || r['Стан синхронізації']!=='ЗІСТАВЛЕНО') throw new Error('Непідтверджений статус; ID '+id);
    if (new Date(r['Оновлено']).getTime()!==success) throw new Error('Рядок не належить останньому успішному оновленню; ID '+id);
    if (r['Валюта']!=='UAH' || ['+','-'].indexOf(r['Наявність'])<0) throw new Error('Невизначена валюта/наявність; ID '+id);
    var available=r['Наявність']==='+', price=Number(r['Ціна постачальника']), expected=mtPrices(price,available);
    if (mtText(r['Ціна']).trim()==='' || mtText(r['Ціна кінцева']).trim()==='' || Number(r['Ціна'])!==expected.base || Number(r['Ціна кінцева'])!==expected.final || !(mtText(r['Знижка'])===expected.discount || (expected.discount===MT.discount+'%' && typeof r['Знижка']==='number' && Math.abs(r['Знижка']-MT.discount/100)<1e-9)) || expected.base>9999999999) throw new Error('Ціни/знижка не відповідають погодженій формулі; ID '+id);
    ['Назва UA','Назва RU','Опис UA','Опис RU'].forEach(function(k) {if (!mtText(r[k]).trim()) throw new Error('Порожнє '+k+'; ID '+id);});
    if (!groupMap[mtText(r['Група ID'])] || !/^\d+$/.test(mtText(r['Категорія Prom ID']))) throw new Error('Не визначена група/категорія; ID '+id);
    var photos=mtArray_(r['Фото JSON'],'Фото JSON',id), params=mtArray_(r['Характеристики JSON'],'Характеристики JSON',id);
    if (!photos.length || photos.length>10 || params.length>100) throw new Error('Кількість фото/характеристик не підтримується Prom; ID '+id);
    var body=['<offer id="'+id+'" available="'+available+'" selling_type="r">',mtElement_('name',r['Назва RU']),mtElement_('name_ua',r['Назва UA']),
      mtElement_('price',(available?expected.final:expected.base).toFixed(2))];
    if (available) body.push(mtElement_('oldprice',expected.base.toFixed(2)));
    body.push('<currencyId>UAH</currencyId>',mtElement_('categoryId',r['Група ID']),mtElement_('portal_category_id',r['Категорія Prom ID']));
    if (r['Категорія Prom URL']) body.push(mtElement_('portal_category_url',mtHttpUrl_(r['Категорія Prom URL'])));
    photos.forEach(function(url) { if (typeof url!=='string') throw new Error('Невалідне фото; ID '+id); body.push(mtElement_('picture',mtHttpUrl_(url))); });
    // Збережений Код товару Prom — не артикул постачальника й не внутрішній ID Prom.
    [['vendorCode','Код товару Prom'],['vendor','Виробник'],['country','Країна'],['gtin','GTIN'],['keywords','Запити RU'],['keywords_ua','Запити UA']].forEach(function(pair) {if (r[pair[1]]) body.push(mtElement_(pair[0],r[pair[1]]));});
    if (mtText(r['Запити UA']).length>1024 || mtText(r['Запити RU']).length>1024) throw new Error('Запити довші за ліміт Prom; ID '+id);
    // Модель збережена в таблиці; type=vendor.model НЕ задаємо, щоб Prom не склеював іншу назву.
    if (r['Модель']) body.push(mtElement_('model',r['Модель']));
    var qty=r['Кількість постачальника'];
    if (qty!=='') {if (!/^\d+(?:\.\d+)?$/.test(mtText(qty)) || !Number.isFinite(Number(qty))) throw new Error('Невалідна кількість; ID '+id);body.push(mtElement_('quantity_in_stock',qty));}
    body.push('<description>'+mtCdata_(r['Опис RU'])+'</description>','<description_ua>'+mtCdata_(r['Опис UA'])+'</description_ua>');
    params.forEach(function(param) {
      if (!param || typeof param.name!=='string' || !param.name.trim() || typeof param.value!=='string' || typeof param.unit!=='string') throw new Error('Невалідна характеристика; ID '+id);
      body.push('<param name="'+mtXmlAttr_(param.name)+'"'+(param.unit?' unit="'+mtXmlAttr_(param.unit)+'"':'')+'>'+mtXml_(param.value)+'</param>');
    });
    body.push('</offer>'); chunks.push(body.join(''));
  });
  chunks.push('</offers></shop></yml_catalog>');
  var xml=chunks.join('\n');
  var bytes=mtUtf8Length_(xml);
  if (bytes>MTY.maximumYmlBytes) throw new Error('YML перевищує безпечні 49 МБ для HTTP-перевірки Apps Script; потрібен погоджений інший транспорт');
  // Навіть випадкова поява секрету в текстовому полі зупиняє всю публікацію.
  if (/hash_tag\s*(?:=|&(?:amp|#38);)|products_feed\.xml|Bearer\s+[A-Za-z0-9_-]{12,}/i.test(xml)) throw new Error('Секрет або службова адреса у вихідному YML');
  return {xml:xml,count:rows.length,bytes:bytes,sha256:mtSha_(xml),sourceSuccess:meta.lastSuccess,
    sourceDigest:mtYmlDigest_(xml),generatedAt:new Date(meta.now).toISOString()};
}
function mtReadYmlSource_() {
  var ss=mtBook_(), p=PropertiesService.getScriptProperties(), main=ss.getSheetByName('Основний каталог'), groups=ss.getSheetByName('Групи');
  if (!main || !groups) throw new Error('Немає основного каталогу або груп');
  return {main:main,groups:groups,values:main.getDataRange().getValues(),groupValues:groups.getDataRange().getValues(),
    meta:{syncState:p.getProperty('TOOLS_SYNC_STATE'),lastSuccess:p.getProperty('TOOLS_LAST_SUCCESS'),now:new Date().toISOString()}};
}
function mtAssertOwnXml_(xml) {
  var root=XmlService.parse(xml).getRootElement(), shop=root.getChild('shop'), offers=shop && shop.getChild('offers');
  if (root.getName()!=='yml_catalog' || !offers) throw new Error('Невалідна структура сформованого XML');
  var list=offers.getChildren('offer');
  if (list.length!==MTY.count || mtSha_(list.map(function(o) {return o.getAttribute('id').getValue();}).sort().join('\n'))!==MTY.idsSha) throw new Error('XML readback: неправильне покриття ID');
}
function mtPreviewYml() {
  var lock=LockService.getScriptLock(); if (!lock.tryLock(1000)) throw new Error('Інша операція вже виконується');
  try {
    var source=mtReadYmlSource_(), built=mtBuildYml_(source.values,source.groupValues,source.meta); mtAssertOwnXml_(built.xml);
    var result={count:built.count,sha256:built.sha256,characters:built.xml.length,utf8Bytes:built.bytes,mode:'ПЕРЕВІРКА_БЕЗ_ЗАПИСУ'};
    console.log(JSON.stringify(result)); return result;
  } finally { lock.releaseLock(); }
}
function mtDriveMarker_() { return 'MT_TOOLS_YML_V1|'+PropertiesService.getScriptProperties().getProperty('TOOLS_SPREADSHEET_ID'); }
function mtYmlFolder_() {
  var p=PropertiesService.getScriptProperties(), id=p.getProperty('TOOLS_YML_FOLDER_ID'), folder;
  if (id) {folder=DriveApp.getFolderById(id);if (folder.getDescription()!==mtDriveMarker_()) throw new Error('Папка YML не належить цьому генератору');}
  else {folder=DriveApp.createFolder('Майстерня Маркет — YML');folder.setDescription(mtDriveMarker_());p.setProperty('TOOLS_YML_FOLDER_ID',folder.getId());}
  return folder;
}
function mtOwnedFile_(id) {
  var file=DriveApp.getFileById(id);
  if (file.getDescription()!==mtDriveMarker_()) throw new Error('Файл не належить цьому генератору');
  return file;
}
function mtReadSnapshot_(manifest,trace) {
  if (!manifest || manifest.count!==MTY.count || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Немає перевіреної версії YML');
  var file=mtYmlStep_(trace,'Drive: файл і власність',function() {return mtOwnedFile_(manifest.fileId);});
  var blob=mtYmlStep_(trace,'Drive: отримання Blob',function() {return file.getBlob();});
  var xml=mtYmlStep_(trace,'Drive: декодування UTF-8',function() {return blob.getDataAsString('UTF-8');});
  var digest=mtYmlStep_(trace,'Drive: SHA-256',function() {return mtSha_(xml);});
  if (digest!==manifest.sha256 || !xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') || !xml.endsWith('</yml_catalog>')) throw new Error('Пошкоджений збережений YML');
  return xml;
}
function mtWriteLinkFile_(folder,active) {
  var p=PropertiesService.getScriptProperties(), url=mtFeedUrl_(), id=p.getProperty('TOOLS_YML_LINK_FILE_ID');
  var text='Майстерня Маркет — постійне YML-посилання для Prom\n\n'+(url || 'Ще не опубліковано: задайте TOOLS_YML_WEB_APP_URL після власного deployment.')+
    '\n\nТоварів у повному каталозі: '+active.count+'\nАдреса завжди читає останній повністю перевірений знімок. Дати формування та помилки дивіться на аркуші Налаштування.'+
    '\n\nУ Prom використовуйте лише постійне /exec-посилання вище, не Drive preview.\nЦе не підтвердження імпорту в Prom. Посилання з ключем не публікуйте.\n';
  var file;
  if (id) {file=mtOwnedFile_(id);file.setContent(text);}
  else {file=folder.createFile(Utilities.newBlob(text,'text/plain','YML-посилання-для-Prom.txt'));file.setDescription(mtDriveMarker_());p.setProperty('TOOLS_YML_LINK_FILE_ID',file.getId());}
  return file.getUrl();
}
/** Спільний lock із mtUpdate. До завершення readback активна версія не змінюється. */
function mtPublishYml_() {
  var lock=LockService.getScriptLock(); if (!lock.tryLock(1000)) throw new Error('Інша операція вже виконується');
  var p=PropertiesService.getScriptProperties(), candidate=null, committed=false, timer=mtTimer_('YML');
  try {
    var source=mtReadYmlSource_(); mtLap_(timer,'читання таблиці');
    var built=mtBuildYml_(source.values,source.groupValues,source.meta); mtLap_(timer,'формування');
    var active=mtActiveManifest_(), folder=mtYmlFolder_();
    if (!p.getProperty('TOOLS_YML_ACCESS_KEY')) p.setProperty('TOOLS_YML_ACCESS_KEY',Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,''));
    var stale=p.getProperty('TOOLS_YML_CANDIDATE_ID');
    if (stale && (!active || stale!==active.fileId)) {mtOwnedFile_(stale).setTrashed(true);p.deleteProperty('TOOLS_YML_CANDIDATE_ID');}
    var activeValid=false;
    if (active) {try {mtReadSnapshot_(active);activeValid=true;} catch(ignored) {console.warn('Збережений знімок потрібно відновити з перевіреної таблиці');}}
    mtLap_(timer,'чинний знімок');
    if (activeValid && active.sourceDigest===built.sourceDigest) {
      var link=mtWriteLinkFile_(folder,active);p.setProperty('TOOLS_YML_LAST_ERROR','');
      mtLap_(timer,'посилання');
      try {mtYmlLog_('БЕЗ ЗМІН','Дані для YML не змінились; чинний знімок '+active.sha256.slice(0,12)+' залишено; етапи мс '+JSON.stringify(timer.ms));} catch(e) {console.warn('Не оновлено журнал YML');}
      return {count:active.count,fileUrl:mtOwnedFile_(active.fileId).getUrl(),linkFileUrl:link,reused:true};
    }
    mtAssertOwnXml_(built.xml); mtLap_(timer,'перевірка XML');
    // createFile(blob) не має 10-МБ обмеження setContent(text); старий XML не перезаписуємо.
    candidate=folder.createFile(Utilities.newBlob(built.xml,'application/xml','Майстерня-Маркет-'+built.generatedAt.replace(/[:.]/g,'-')+'.yml'));
    candidate.setDescription(mtDriveMarker_());p.setProperty('TOOLS_YML_CANDIDATE_ID',candidate.getId());
    mtLap_(timer,'запис у Drive');
    var next={fileId:candidate.getId(),sha256:built.sha256,count:built.count,bytes:built.bytes,sourceDigest:built.sourceDigest,sourceSuccess:built.sourceSuccess,generatedAt:built.generatedAt,publishedAt:new Date().toISOString()};
    mtReadSnapshot_(next); // Drive readback до перемикання посилання.
    mtLap_(timer,'readback Drive');
    if (JSON.stringify(source.main.getDataRange().getValues())!==JSON.stringify(source.values) || JSON.stringify(source.groups.getDataRange().getValues())!==JSON.stringify(source.groupValues) || p.getProperty('TOOLS_LAST_SUCCESS')!==source.meta.lastSuccess || p.getProperty('TOOLS_SYNC_STATE')!=='OK') throw new Error('Джерело змінилося під час формування YML');
    mtLap_(timer,'контроль джерела');
    var older=active && active.previous, linkUrl=mtWriteLinkFile_(folder,next);
    if (activeValid) next.previous=Object.fromEntries(Object.keys(active).filter(function(k) {return k!=='previous';}).map(function(k) {return [k,active[k]];}));
    else if (older) {try {mtReadSnapshot_(older);next.previous=older;} catch(ignored) {console.warn('Попередній знімок також недоступний');}}
    // Активний та попередній маніфести перемикаються ОДНИМ записом.
    p.setProperty('TOOLS_YML_ACTIVE',JSON.stringify(next));committed=true;
    p.deleteProperty('TOOLS_YML_CANDIDATE_ID');p.setProperty('TOOLS_YML_LAST_ERROR','');
    [active,older].filter(Boolean).forEach(function(old) {
      if (old.fileId===next.fileId || next.previous && old.fileId===next.previous.fileId) return;
      try {mtOwnedFile_(old.fileId).setTrashed(true);} catch(e) {console.warn('Зайву власну версію не перенесено в кошик');}
    });
    mtLap_(timer,'перемикання знімка');
    try {mtYmlLog_('СФОРМОВАНО',String(next.count)+' товарів; SHA256 '+next.sha256+'; етапи мс '+JSON.stringify(timer.ms));} catch(e) {console.warn('Не оновлено журнал YML');}
    return {count:next.count,fileUrl:candidate.getUrl(),linkFileUrl:linkUrl,reused:false};
  } catch(error) {
    if (candidate && !committed) {try {candidate.setTrashed(true);p.deleteProperty('TOOLS_YML_CANDIDATE_ID');} catch(ignored) {}}
    p.setProperty('TOOLS_YML_LAST_ERROR',mtSanitize_(error));throw new Error(mtSanitize_(error));
  } finally {lock.releaseLock();}
}
function mtSaveYmlToDrive() {
  var result;
  try {result=mtPublishYml_();}
  finally {mtRefreshSettingsSafely_();}
  SpreadsheetApp.getUi().alert('YML збережено',
    (result.reused?'Використано вже збережену актуальну версію.':'Збережено нову перевірену версію.')+'\nТоварів: '+result.count+'\n\nФайл YML:\n'+result.fileUrl+'\n\nФайл із постійним посиланням:\n'+result.linkFileUrl+'\n\nІмпорт у Prom не запускався.',SpreadsheetApp.getUi().ButtonSet.OK);
  return result;
}
/** Публічний GET лише читає готовий знімок; не запускає sync і не записує в таблицю. */
function doGet(e) {
  var p=PropertiesService.getScriptProperties(), key=p.getProperty('TOOLS_YML_ACCESS_KEY');
  if (!key || !e || !e.parameter || e.parameter.key!==key) throw new Error('Доступ заборонено');
  var trace=mtYmlTrace_('doGet',0), active=mtActiveManifest_(), xml;
  try {xml=mtReadSnapshot_(active,trace);}
  catch(error) {
    console.warn('Поточний YML недоступний: використовується попередній перевірений знімок');
    try {p.setProperty('TOOLS_YML_LAST_ERROR','Поточний знімок пошкоджений/недоступний; адреса видає попередню версію. Потрібне повторне формування.');} catch(ignored) {}
    var previous=active && active.previous;
    if (!previous) throw new Error('Перевірений YML тимчасово недоступний');
    // Повна попередня версія, а не порожній каталог чи XML із повідомленням помилки.
    xml=mtReadSnapshot_(previous,trace);
  }
  return mtYmlStep_(trace,'ContentService: XML-відповідь',function() {return ContentService.createTextOutput(xml).setMimeType(ContentService.MimeType.XML);});
}
/** Без Authorization: фактичне повне завантаження; жодної генерації/запису в Drive. */
function mtCheckPublicYml() {return mtCheckPublicYml_(true);}
/** Лише читання і console: не змінює навіть Script Properties, не показує alert. */
function mtDiagnosePublicYml() {return mtCheckPublicYml_(false);}
function mtCheckPublicYml_(recordSuccess) {
  var trace=mtYmlTrace_(recordSuccess?'mtCheckPublicYml':'mtDiagnosePublicYml',MTY.publicCheckBudgetMs);
  try {
    var p=PropertiesService.getScriptProperties();
    var url=mtYmlStep_(trace,'Налаштування адреси',function() {return mtFeedUrl_();});
    if (!url) throw new Error('Спочатку задайте TOOLS_YML_WEB_APP_URL; deployment не змінено');
    var active=mtYmlStep_(trace,'Приватний маніфест',function() {return mtPublicManifest_(mtActiveManifest_());});
    // HTTP-етап включає роботу віддаленого doGet, редиректи Google і передачу 47,8 МБ.
    var response=mtYmlStep_(trace,'HTTP: повне завантаження',function() {return UrlFetchApp.fetch(url,{followRedirects:true,muteHttpExceptions:true});});
    var type=mtYmlStep_(trace,'HTTP: статус і MIME',function() {
      var headers=response.getHeaders();
      var raw=Object.keys(headers).filter(function(k) {return k.toLowerCase()==='content-type';}).map(function(k) {return mtText(headers[k]);}).join(';');
      var mime=raw.split(';')[0].trim().toLowerCase();
      if (response.getResponseCode()!==200 || ['application/xml','text/xml','text/plain'].indexOf(mime)<0) throw new Error('Потрібні HTTP 200 і XML/text/plain; відповідь не підтверджена');
      return mime;
    });
    var xml=mtYmlStep_(trace,'HTTP: декодування UTF-8',function() {return response.getContentText('UTF-8');});
    mtYmlStep_(trace,'XML: межі документа',function() {
      if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') || !xml.endsWith('</yml_catalog>') || xml.length>MTY.maximumYmlBytes) throw new Error('HTTP-відповідь не є повним знімком XML');
    });
    var bytes=mtYmlStep_(trace,'XML: розмір UTF-8',function() {
      var actual=mtUtf8Length_(xml);
      if (actual>MTY.maximumYmlBytes || actual!==active.bytes) throw new Error('Розмір HTTP XML не збігається з перевіреним знімком');
      return actual;
    });
    mtYmlStep_(trace,'XML: SHA-256 усього вмісту',function() {
      if (mtSha_(xml)!==active.sha256) throw new Error('HTTP XML не збігається з поточним перевіреним знімком');
    });
    // Саме ці байти вже пройшли mtBuildYml_ + XmlService.parse ПЕРЕД публікацією.
    // Повний SHA зв'язує всі ціни, фото, групи, описи й параметри з тим еталоном.
    // Другий DOM на десятки МБ нічого не додає; всі 5029 ID звіряємо окремо.
    mtYmlStep_(trace,'XML: усі погоджені ID',function() {mtAssertPublicIds_(xml);});
    mtYmlStep_(trace,'Повторна перевірка актуальності маніфесту',function() {
      var current=mtPublicManifest_(mtActiveManifest_());
      if (current.fileId!==active.fileId || current.sha256!==active.sha256 || current.sourceDigest!==active.sourceDigest || current.bytes!==active.bytes) throw new Error('Активний знімок змінився під час HTTP-перевірки; повторіть її');
    });
    var checkedAt=new Date().toISOString();
    if (recordSuccess) mtYmlStep_(trace,'Script Properties: час успішної перевірки',function() {p.setProperty('TOOLS_YML_HTTP_CHECK_AT',checkedAt);},true);
    var result={version:MTY.publicCheckVersion,count:active.count,sha256:active.sha256,utf8Bytes:bytes,contentType:type,checkedAt:checkedAt,elapsedMs:Date.now()-trace.started,timings:trace.steps.slice(),mode:recordSuccess?'ПЕРЕВІРКА':'ДІАГНОСТИКА_БЕЗ_ЗАПИСУ'};
    console.log(JSON.stringify({версія:MTY.publicCheckVersion,дія:trace.action,етап:'ЗАВЕРШЕНО',стан:'PASS',товарів:result.count,байтів:bytes,тривалістьМс:result.elapsedMs}));
    // alert() призупиняє сервер до закриття діалогу. Toast не блокує завершення.
    if (recordSuccess) {
      try {var book=typeof SpreadsheetApp.getActiveSpreadsheet==='function' && SpreadsheetApp.getActiveSpreadsheet();if (book) book.toast('HTTP 200; SHA-256 і всі 5029 ID підтверджено. Не є підтвердженням імпорту в Prom.','YML перевірено',10);}
      catch(ignored) {console.log('Перевірку завершено; сповіщення недоступне. Результат у журналі виконання.');}
    }
    return result;
  } catch(error) {
    console.log(JSON.stringify({версія:MTY.publicCheckVersion,дія:trace.action,етап:'ЗАВЕРШЕНО',стан:'ПОМИЛКА',тривалістьМс:Date.now()-trace.started}));
    throw new Error(mtSanitize_(error));
  }
}
/** Окреме явне оновлення тільки посилання/службових полів, без читання XML. */
function mtRefreshYmlPublicationInfo() {
  var trace=mtYmlTrace_('mtRefreshYmlPublicationInfo',MTY.publicCheckBudgetMs);
  var active=mtPublicManifest_(mtActiveManifest_());
  mtYmlStep_(trace,'Drive: файл постійного посилання',function() {mtWriteLinkFile_(mtYmlFolder_(),active);});
  mtYmlStep_(trace,'Google Sheets: службові поля',function() {mtRefreshSettings_();});
  console.log('Посилання і службові поля оновлено. Сам YML і товарні аркуші не змінювалися.');
  return {version:MTY.publicCheckVersion,timings:trace.steps};
}
