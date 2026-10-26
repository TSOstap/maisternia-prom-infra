/** Сховище схем категорій Prom у репозиторії (погоджено власником 23.10.2026):
 *   schemas/prom/<categoryId>.xml — схема рівно в тому вигляді, як її надав власник (один <category>);
 *   schemas/prom/MANIFEST.json    — перелік: id, назви, файл, SHA256, кількість атрибутів, дата отримання;
 *   schemas/prom/units.json       — погоджені перерахунки одиниць;
 *   schemas/prom/synonyms.json    — погоджені синоніми назв для всіх категорій: { toAttribute: { "назва": "nameUK атрибута" } };
 *   schemas/prom/names-ua-ru.json — погоджений власником словник UA/RU назв користувацьких характеристик: { names: { "назва": "українська назва" } };
 *   schemas/prom/mapping/<categoryId>.json — погоджені синоніми: { synonyms: { "назва постачальника": "<id атрибута>" },
 *                                            values: { "<id атрибута>": { "значення постачальника": "<id варіанта>" } } }.
 *  Файл, SHA якого не збігається з MANIFEST, або схема з помилками структури — не використовується (лише попередження). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../core/text.mjs";
import { parseCategory, parseSchemaText } from "../core/prom-schema.mjs";
import { buildNames, charKey, normName, normUnit, unitAliasMap } from "../core/prom-attributes.mjs";

export const SCHEMAS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schemas/prom");
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);

export function readManifest(dir = SCHEMAS_DIR) {
  return readJson(path.join(dir, "MANIFEST.json"), { version: 1, categories: [] });
}

/** Підтверджені рішення власника щодо окремих характеристик (власник, 26.10.2026) — файл ПОЗА репозиторієм (товарні дані в
 *  репозиторій не пишемо), до запуску аркуша «Ручні характеристики» в таблиці:
 *  { "v": 1, "date": "YYYY-MM-DD", "products": { "<Offer ID>": { "model": "…", "title": "…", "items": [ { "name", "field"?, "value",
 *    "unit"?, "action": "set" | "drop", "replaces"?: [назви], "supplier"?: [значення], "source", "date", "priority": 1–3,
 *    "autoUpdate": false } ] } } }.
 *  Запис без назви, значення (для set), джерела чи дати, з невідомою дією або пріоритетом — не застосовується (лише попередження).
 *  Повертає { map: Map(Offer ID → { model, title, items }), date, items, problems }. */
export function loadOwnerValues(file) {
  const res = { map: new Map(), date: "", items: 0, problems: [] };
  if (!fs.existsSync(file)) { res.problems.push(`файл рішень власника «${path.basename(file)}» не знайдено`); return res; }
  let j = null;
  try { j = readJson(file, null); } catch { res.problems.push(`файл рішень власника «${path.basename(file)}»: некоректний JSON`); return res; }
  if (!j || j.v !== 1 || typeof j.products !== "object" || !j.products || !/^\d{4}-\d{2}-\d{2}$/.test(String(j.date || ""))) { res.problems.push(`файл рішень власника «${path.basename(file)}»: немає v=1 / date / products`); return res; }
  res.date = String(j.date);
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  for (const [id, p] of Object.entries(j.products)) {
    if (!/^\d+$/.test(id) || !p || !Array.isArray(p.items)) { res.problems.push(`рішення власника ${id}: немає items`); continue; }
    const items = [];
    p.items.forEach((o, i) => {
      const bad = [];
      if (!o || typeof o !== "object") bad.push("не об'єкт");
      else {
        if (!str(o.name)) bad.push("name");
        if (!["set", "drop"].includes(o.action ?? "set")) bad.push("action");
        if ((o.action ?? "set") === "set" && !str(String(o.value ?? ""))) bad.push("value");
        if (!str(o.source)) bad.push("source");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str(o.date))) bad.push("date");
        if (o.priority !== undefined && ![1, 2, 3].includes(o.priority)) bad.push("priority");
        if (o.autoUpdate !== undefined && typeof o.autoUpdate !== "boolean") bad.push("autoUpdate");
        if (o.field !== undefined && !/^\d+$/.test(String(o.field))) bad.push("field");
        for (const k of ["replaces", "supplier"]) if (o[k] !== undefined && !(Array.isArray(o[k]) && o[k].every((x) => typeof x === "string"))) bad.push(k);
      }
      if (bad.length) { res.problems.push(`рішення власника ${id} №${i + 1}: неправильне ${bad.join(", ")} — не застосовано`); return; }
      items.push({ ...o, action: o.action ?? "set", value: String(o.value ?? ""), unit: str(o.unit), priority: o.priority ?? 1, autoUpdate: o.autoUpdate === true, ...(o.field !== undefined ? { field: String(o.field) } : {}) });
    });
    res.items += items.length;
    if (items.length) res.map.set(String(id), { model: str(p.model), title: str(p.title), items });
  }
  return res;
}

/** Схеми, словники й одиниці для синхронізації. */
export function loadPromCatalog(dir = SCHEMAS_DIR, { promCategoriesFile = process.env.MM_PROM_CATEGORIES || "", ownerValuesFile = process.env.MM_OWNER_VALUES || "" } = {}) {
  const out = { schemas: new Map(), mappings: new Map(), units: readJson(path.join(dir, "units.json"), { conversions: [] }), problems: [] };
  // Рішення власника щодо окремих характеристик (Offer ID → { model, items }); немає файлу — не застосовуються.
  out.ownerValues = null;
  if (ownerValuesFile) {
    const ov = loadOwnerValues(ownerValuesFile);
    out.problems.push(...ov.problems);
    out.ownerValues = ov.map;
    out.ownerValuesInfo = { file: path.basename(ownerValuesFile), date: ov.date, products: ov.map.size, items: ov.items };
  }
  // Фактичні категорії товарів у Prom (власник, 25.10.2026) — файл ПОЗА репозиторієм (дані товарів у репозиторій не пишемо):
  // { "date": "YYYY-MM-DD", "source": "…", "categories": { "<Offer ID>": "<ID категорії>" } }. Немає файлу — категорія таблиці.
  out.promCategories = null;
  if (promCategoriesFile) {
    const pc = readJson(promCategoriesFile, null);
    if (!pc || typeof pc.categories !== "object" || !pc.date) out.problems.push(`файл категорій Prom «${path.basename(promCategoriesFile)}»: немає date / categories`);
    else out.promCategories = { date: String(pc.date), source: String(pc.source || ""), map: new Map(Object.entries(pc.categories).filter(([id, c]) => /^\d+$/.test(String(c))).map(([id, c]) => [String(id), String(c)])) };
  }
  const synFile = readJson(path.join(dir, "synonyms.json"), {});
  const globalSyn = synFile.toAttribute || {};
  const pending = [];
  for (const e of readManifest(dir).categories || []) {
    const file = path.join(dir, e.file);
    if (!fs.existsSync(file)) { out.problems.push(`${e.id}: немає файлу ${e.file}`); continue; }
    const text = fs.readFileSync(file, "utf8");
    if (textSha(text) !== e.sha256) { out.problems.push(`${e.id}: SHA файлу не збігається з MANIFEST — схему не використано`); continue; }
    const parsed = parseSchemaText(text);
    if (parsed.length !== 1 || parsed[0].schema.id !== String(e.id)) { out.problems.push(`${e.id}: у файлі має бути рівно одна категорія з цим id`); continue; }
    if (parsed[0].problems.length) { out.problems.push(`${e.id}: ${parsed[0].problems.join("; ")}`); continue; }
    out.schemas.set(String(e.id), parsed[0].schema);
    pending.push(e);
  }
  // Підтверджені UA/RU відповідності: офіційні пари назв зі схем Prom + погоджений власником словник.
  // Синоніми одиниць — однозначна технічна нормалізація (units.json → aliases); погоджений словник — names / values /
  // valuesInContext (лише для названої характеристики).
  out.units.aliasMap = unitAliasMap(out.units.aliases);
  // Масштаб одиниць однієї величини (units.json → scales) — лише для виявлення помилки одиниці, не для перерахунку.
  out.units.scale = new Map();
  for (const [dim, list] of Object.entries(out.units.scales || {})) for (const [u, f] of list) for (const k of [normUnit(u), out.units.aliasMap.get(normUnit(u))]) if (k && !out.units.scale.has(k)) out.units.scale.set(k, { dim, f });
  out.knownIssues = readJson(path.join(dir, "known-issues.json"), {}).attributes || []; // відомі вади довідника Prom (importRisks)
  const dict = readJson(path.join(dir, "names-ua-ru.json"), {});
  // Варіанти, які НЕ є перекладом (known-issues.json, action «noLexicon»: напр. 13070703 «Тип сходів» — UA у множині для RU в
  // однині), не беруть участі у словнику UA/RU інших категорій; поле самої категорії заповнюється як звичайно.
  const noLex = out.knownIssues.filter((k) => k.action === "noLexicon");
  const lexSchemas = [...out.schemas.values()].map((s) => (noLex.some((k) => (k.categories || []).map(String).includes(String(s.id))) ? { ...s, attributes: s.attributes.map((a) => (noLex.some((k) => (k.categories || []).map(String).includes(String(s.id)) && String(k.id) === a.id) ? { ...a, values: [] } : a)) } : s));
  out.names = buildNames(lexSchemas, dict.names || {}, out.units.aliasMap, dict.values || {}, dict.valuesInContext || {}, out.units.conversions || [], dict.wordsInContext || {}, dict.restrictedContexts || null, dict.inCategory || {});
  out.names.brandPairs = Array.isArray(dict.brandPairs) ? dict.brandPairs : []; // погоджені пари написань бренду (лише за офіційним брендом)
  // Комплектація, підтверджена власником для конкретних товарів (Offer ID → { battery, charger })
  // Кілька значень однієї характеристики, підтверджені власником для конкретних товарів (Offer ID → назви характеристик)
  out.multiConfirmed = new Map(Object.entries(readJson(path.join(dir, "multi-value-confirmed.json"), {}).products || {}).map(([id, v]) => [String(id), new Map(Object.entries(v || {}).map(([n, spec]) => [normName(n), typeof spec === "object" && spec ? spec : {}]))]));
  out.kitConfirmed = new Map(Object.entries(readJson(path.join(dir, "kit-confirmed.json"), {}).products || {}).map(([id, v]) => [String(id), { battery: v.battery, charger: v.charger, ...(v.batteryCount !== undefined ? { batteryCount: v.batteryCount } : {}) }]));
  // Перелік рішень власника (репозиторій, БЕЗ значень; значення — у файлі поза репозиторієм): без файлу рішень ці характеристики
  // утримуються (значення постачальника не передається), а не повертаються до даних постачальника непомітно.
  out.ownerIndex = new Map(Object.entries(readJson(path.join(dir, "owner-values-index.json"), {}).products || {}).map(([id, p]) => [String(id), {
    model: String(p?.model || ""),
    items: (Array.isArray(p?.items) ? p.items : []).filter((x) => x && typeof x.name === "string" && x.name.trim()).map((x) => ({ name: x.name.trim(), ...(x.field !== undefined ? { field: String(x.field) } : {}), ...(Array.isArray(x.replaces) ? { replaces: x.replaces.map(String) } : {}) })),
  }]));
  if (out.ownerValues && out.ownerIndex.size) {
    const same = (a, b) => normName(a.name) === normName(b.name) && String(a.field || "") === String(b.field || "");
    for (const [id, p] of out.ownerIndex) {
      const f = out.ownerValues.get(id);
      if (f && normName(f.model) !== normName(p.model)) out.problems.push(`рішення власника ${id}: модель у файлі «${f.model}» ≠ у переліку «${p.model}»`);
      for (const it of p.items) if (!(f?.items || []).some((o) => same(o, it))) out.problems.push(`рішення власника ${id} «${it.name}»: є в переліку репозиторію, але немає у файлі рішень — характеристику утримано`);
    }
    for (const [id, p] of out.ownerValues) for (const o of p.items) if (!(out.ownerIndex.get(id)?.items || []).some((it) => same(o, it))) out.problems.push(`рішення власника ${id} «${o.name}»: є у файлі рішень, але немає в переліку репозиторію — застосовано; оновіть перелік (node tools/owner-values.mjs index)`);
  }
  for (const e of pending) {
    const schema = out.schemas.get(String(e.id));
    const m = readJson(path.join(dir, "mapping", `${e.id}.json`), null);
    const mapping = {
      synonyms: Object.fromEntries(Object.entries(m?.synonyms || {}).map(([k, v]) => [normName(k), String(v)])),
      values: Object.fromEntries(Object.entries(m?.values || {}).map(([a, vals]) => [String(a), Object.fromEntries(Object.entries(vals || {}).map(([k, v]) => [normName(k), String(v)]))])),
    };
    // Загальні погоджені синоніми: лише однозначний атрибут цієї категорії; синонім категорії має перевагу.
    for (const [alias, target] of Object.entries(globalSyn)) {
      const n = normName(alias);
      const hits = schema.attributes.filter((a) => normName(a.nameUK) === normName(target));
      const clash = schema.attributes.some((a) => normName(a.nameUK) === n || normName(a.nameRU) === n);
      if (hits.length === 1 && !clash && mapping.synonyms[n] === undefined) mapping.synonyms[n] = hits[0].id;
    }
    // Назви, що за підтвердженим словником ведуть до погодженого синоніма («Источник питания» → «Джерело живлення»),
    // — до того самого атрибута (без назв, що самі є атрибутами цієї категорії).
    for (const [k, uk] of out.names.name) {
      let fin = uk;
      for (let i = 0; i < 5; i++) { const nx = out.names.name.get(normName(fin)); if (!nx || normName(nx) === normName(fin)) break; fin = nx; }
      const target = mapping.synonyms[normName(fin)];
      if (target === undefined || mapping.synonyms[k] !== undefined) continue;
      if (schema.attributes.some((a) => normName(a.nameUK) === k || normName(a.nameRU) === k)) continue;
      mapping.synonyms[k] = target;
    }
    // Поля з відомою вадою довідника Prom (known-issues.json, action «custom») — не заповнюються в цій категорії.
    const blocked = Object.fromEntries(out.knownIssues.filter((k) => k.action === "custom" && (k.categories || []).map(String).includes(String(e.id)) && schema.attributes.some((a) => a.id === String(k.id))).map((k) => [String(k.id), k]));
    if (Object.keys(blocked).length) mapping.blocked = blocked;
    if (m || Object.keys(mapping.synonyms).length || mapping.blocked) out.mappings.set(String(e.id), mapping);
    // Заборонені власником пари (№47–50): у жодній категорії не можуть отримати один ключ.
    for (const [x, y] of synFile.forbidden || []) {
      const opt = { mapping, names: out.names };
      if (charKey(schema, x, opt) === charKey(schema, y, opt)) out.problems.push(`${e.id}: заборонена відповідність «${x}» = «${y}» виникла через словники — перевірте names-ua-ru.json / synonyms.json`);
    }
  }
  return out;
}

// Кінці рядків — LF (вихідні файли власника бувають CRLF); SHA не залежить від перетворень git на Windows.
const lf = (s) => s.replace(/\r\n?/g, "\n");
const textSha = (s) => sha256(lf(s));
const fileText = (block) => `<?xml version="1.0" encoding="utf-8"?>\n<categories>\n${lf(block)}\n</categories>\n`;

/** Імпорт файлів від власника: кожна коректна категорія → окремий файл + запис у MANIFEST. */
export function importSchemaFiles(files, { dir = SCHEMAS_DIR, received = new Date().toISOString().slice(0, 10) } = {}) {
  const manifest = readManifest(dir);
  const byId = new Map((manifest.categories || []).map((c) => [String(c.id), c]));
  const report = [];
  // Один id у кількох місцях з РІЗНИМ вмістом — не вибираємо версію самі: категорія не імпортується.
  const all = files.flatMap((f) => parseSchemaText(fs.readFileSync(f, "utf8")).map((it) => ({ ...it, f })));
  const shaById = new Map();
  for (const it of all) { const s = textSha(fileText(it.block)); const set = shaById.get(it.schema.id) || new Set(); set.add(s); shaById.set(it.schema.id, set); }
  const written = new Set();
  for (const f of files) if (!all.some((it) => it.f === f)) report.push({ file: path.basename(f), status: "НЕМАЄ КАТЕГОРІЙ" });
  for (const f of files) {
    for (const it of all.filter((x) => x.f === f)) {
      const { schema, problems } = it;
      if (shaById.get(schema.id).size > 1) { report.push({ file: path.basename(f), id: schema.id, status: "КОНФЛІКТ", problems: ["категорія трапляється кілька разів з різним вмістом — потрібна одна версія"] }); continue; }
      if (written.has(schema.id)) { report.push({ file: path.basename(f), id: schema.id, status: "ПОВТОР (той самий вміст)" }); continue; }
      written.add(schema.id);
      if (problems.length) { report.push({ file: path.basename(f), id: schema.id, status: "ПОМИЛКИ", problems }); continue; }
      const text = fileText(it.block);
      if (parseCategory(it.block).schema.id !== schema.id) throw new Error("внутрішня помилка розбору");
      const name = `${schema.id}.xml`;
      const prev = byId.get(schema.id);
      const sha = textSha(text);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
      byId.set(schema.id, { id: schema.id, nameUK: schema.nameUK, nameRU: schema.nameRU, file: name, sha256: sha, attributes: schema.attributes.length, excluded: schema.excluded.length, received: prev?.sha256 === sha ? prev.received : received, source: path.basename(f) });
      report.push({ file: path.basename(f), id: schema.id, status: prev ? (prev.sha256 === sha ? "БЕЗ ЗМІН" : "ОНОВЛЕНО") : "ДОДАНО", nameUK: schema.nameUK, attributes: schema.attributes.length, excluded: schema.excluded.length, warnings: it.warnings || [], ...(schema.empty ? { note: "категорія без атрибутів" } : {}) });
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  manifest.version = 1;
  manifest.categories = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  fs.writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  return report;
}
