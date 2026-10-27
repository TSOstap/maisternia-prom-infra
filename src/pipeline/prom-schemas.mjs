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
import { buildNames, charKey, cleanValue, normName, normUnit, unitAliasMap } from "../core/prom-attributes.mjs";

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

/** Технічні нормалізації, увімкнені в генераторі (пакети після 83206c4). Діють лише з валідним переліком захищених товарів
 *  і лише для основного каталогу (refreshMainRow): нові кандидати й черга «Нові товари» — як у 83206c4. */
export const TECH_RULES = Object.freeze(["A1", "A2"]); // A2 — картки без <param> у XML: характеристики з опису (лише refreshMainRow)
/** Правила пакетів N — лише для стабільної когорти N0 (loadCohort) в області дії, крім захищених. N1 — таблиця «Параметр |
 *  Значення | Примітка» (conditionTablePairs). */
export const N1_RULES = Object.freeze(["N1"]);

/** Відбиток набору Offer ID (не залежить від порядку): у репозиторії зберігається лише він, самі ID — поза репозиторієм. */
export const freezeFingerprint = (ids) => "sha256:" + sha256([...new Set([...ids].map(String))].sort().join("\n"));
const idList = (x) => { const ids = Array.isArray(x) ? x.map(String) : null; return ids && ids.length && ids.every((v) => /^\d+$/.test(v)) && new Set(ids).size === ids.length ? ids : null; };
const FP = /^sha256:[0-9a-f]{64}$/;

/** Перелік захищених товарів (з незавершеними рішеннями власника) і область дії — файл ПОЗА репозиторієм (змінна MM_FREEZE_IDS):
 *  { "v": 1, "rev": R, "date": "YYYY-MM-DD", "source": "…", "count": N, "ids": ["<Offer ID>", …], "fingerprint"?: "sha256:…",
 *    "scope": { "count": M, "ids": [...], "fingerprint"?: "sha256:…" } }
 *  ids — захищені (непорожній, унікальні, count = кількість); scope — знімок основного каталогу, якому погоджено зміни (захищені
 *  входять у нього). Контракт актуального знімка — у репозиторії, без ID (schemas/prom/freeze-contract.json:
 *  { v: 1, rev, date, source, count, fingerprint, scope: { count, fingerprint }, parts?: { initial, added } }): файл має точно йому
 *  відповідати (та сама ревізія, дата,
 *  кількості й відбитки наборів), щоб випадковий порожній / неповний / інший перелік не знімав захист і не розширював область.
 *  Fail-closed: без файлу, без контракту або з будь-якою невідповідністю нові технічні нормалізації не діють ДЛЯ ЖОДНОГО товару;
 *  товари поза scope (нові, черга, поза YML) їх не отримують навіть з валідним файлом. */
export function loadFreeze(file, contract = null) {
  const res = { valid: false, ids: new Set(), scope: new Set(), rev: 0, date: "", source: "", parts: null, problems: [] };
  if (!file) return res;
  const name = `файл переліку захищених товарів «${path.basename(file)}»`, off = " — технічні нормалізації вимкнено";
  const fail = (why) => { res.problems.push(why + off); return res; };
  if (!fs.existsSync(file)) return fail(`${name} не знайдено`);
  let j = null;
  try { j = readJson(file, null); } catch { return fail(`${name}: некоректний JSON`); }
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const ids = idList(j?.ids), scope = idList(j?.scope?.ids);
  if (!j || j.v !== 1 || !date.test(String(j.date || "")) || !ids || j.count !== ids.length) return fail(`${name}: немає v=1 / date / ids / count, перелік порожній або ids неунікальні`);
  if (!scope || j.scope.count !== scope.length) return fail(`${name}: немає області дії (scope: count / ids), вона порожня або ids неунікальні`);
  const fp = freezeFingerprint(ids), sfp = freezeFingerprint(scope);
  if ((j.fingerprint !== undefined && j.fingerprint !== fp) || (j.scope.fingerprint !== undefined && j.scope.fingerprint !== sfp)) return fail(`${name}: відбиток у файлі не збігається з ids`);
  const inScope = new Set(scope);
  if (ids.some((x) => !inScope.has(x))) return fail(`${name}: захищені товари поза областю дії`);
  const k = contract;
  if (!k || k.v !== 1 || !date.test(String(k.date || "")) || !Number.isInteger(k.count) || k.count < 1 || !FP.test(String(k.fingerprint || "")) || !Number.isInteger(k.scope?.count) || k.scope.count < 1 || !FP.test(String(k.scope?.fingerprint || "")) || !Number.isInteger(k.rev) || k.rev < 1) {
    return fail("контракт переліку захищених товарів у репозиторії відсутній або некоректний");
  }
  if (j.rev !== k.rev) return fail(`${name}: ревізія ${j.rev ?? "—"} не відповідає контракту (ревізія ${k.rev})`);
  if (k.date !== j.date || k.count !== ids.length || k.fingerprint !== fp || k.scope.count !== scope.length || k.scope.fingerprint !== sfp) {
    return fail(`${name} не відповідає контракту актуального знімка (дата ${j.date} / ${k.date}, захищених ${ids.length} / ${k.count}, відбиток ${k.fingerprint === fp ? "збігається" : "інший"}; область ${scope.length} / ${k.scope.count}, відбиток ${k.scope.fingerprint === sfp ? "збігається" : "інший"})`);
  }
  // parts — довідково (склад переліку: початкові + нові питання), сума має дорівнювати count
  const parts = k.parts && Number.isInteger(k.parts.initial) && Number.isInteger(k.parts.added) && k.parts.initial + k.parts.added === k.count ? { initial: k.parts.initial, added: k.parts.added } : null;
  return { valid: true, ids: new Set(ids), scope: inScope, rev: k.rev, date: String(j.date), source: String(j.source || k.source || ""), parts, problems: [] };
}

/** Відбиток переліку точних пар А3 (не залежить від порядку): у репозиторії — лише він, самі пари — поза репозиторієм. */
export const a3Fingerprint = (pairs) => "sha256:" + sha256(JSON.stringify([...pairs].map((p) => [String(p.id), normName(p.key), cleanValue(p.ua), cleanValue(p.ru), p.pass === undefined ? "" : String(p.pass)]).sort((x, y) => x.join("\u0001").localeCompare(y.join("\u0001")))));

/** Точні контекстні пари UA / RU (пакет А3, перевірені Hermes) — файл ПОЗА репозиторієм (змінна MM_A3_PAIRS):
 *  { "v": 1, "rev": R, "date", "source", "count": N, "fingerprint"?: "sha256:…", "pairs": [{ "id": "<Offer ID>", "key", "ua", "ru", "pass"? }] }.
 *  Доказ — ПОВНА пара в контексті (товар + ключ + повне UA + повне RU), не словник слів; pass — підтверджене технічне ядро без
 *  рекламного хвоста. Контракт у репозиторії (schemas/prom/a3-pairs-contract.json: { v, rev, date, count, fingerprint }) — без пар.
 *  Fail-closed: без файлу, без контракту, з будь-якою невідповідністю — пари не діють для жодного товару. */
export function loadA3Pairs(file, contract = null) {
  const res = { valid: false, map: new Map(), count: 0, rev: 0, problems: [] };
  if (!file) return res;
  const name = `файл точних пар А3 «${path.basename(file)}»`, off = " — точні пари А3 вимкнено";
  const fail = (why) => { res.problems.push(why + off); return res; };
  if (!fs.existsSync(file)) return fail(`${name} не знайдено`);
  let j = null;
  try { j = readJson(file, null); } catch { return fail(`${name}: некоректний JSON`); }
  const pairs = Array.isArray(j?.pairs) ? j.pairs : null;
  const okPair = (p) => Boolean(p) && /^\d+$/.test(String(p.id)) && Boolean(normName(p.key)) && Boolean(cleanValue(p.ua)) && Boolean(cleanValue(p.ru)) && (p.pass === undefined || Boolean(cleanValue(p.pass)));
  if (!j || j.v !== 1 || !Number.isInteger(j.rev) || !/^\d{4}-\d{2}-\d{2}$/.test(String(j.date || "")) || !pairs || !pairs.length || !pairs.every(okPair) || j.count !== pairs.length) return fail(`${name}: немає v=1 / rev / date / pairs / count, перелік порожній або пара неповна`);
  const ids = pairs.map((p) => String(p.id) + "|" + normName(p.key));
  if (new Set(ids).size !== ids.length) return fail(`${name}: повторена пара (товар + ключ)`);
  const fp = a3Fingerprint(pairs);
  if (j.fingerprint !== undefined && j.fingerprint !== fp) return fail(`${name}: відбиток у файлі не збігається з парами`);
  const k = contract;
  if (!k || k.v !== 1 || !Number.isInteger(k.rev) || !Number.isInteger(k.count) || k.count < 1 || !FP.test(String(k.fingerprint || ""))) return fail("контракт точних пар А3 у репозиторії відсутній або некоректний");
  if (k.rev !== j.rev || k.count !== pairs.length || k.fingerprint !== fp) return fail(`${name} не відповідає контракту (ревізія ${j.rev} / ${k.rev}, пар ${pairs.length} / ${k.count}, відбиток ${k.fingerprint === fp ? "збігається" : "інший"})`);
  for (const p of pairs) { const id = String(p.id); res.map.set(id, [...(res.map.get(id) || []), { key: normName(p.key), ua: cleanValue(p.ua), ru: cleanValue(p.ru), ...(p.pass === undefined ? {} : { pass: cleanValue(p.pass) }) }]); }
  return { ...res, valid: true, count: pairs.length, rev: j.rev, problems: [] };
}

/** Відбиток когорти N0 (не залежить від порядку): у репозиторії — лише він, самі Offer ID — поза репозиторієм. */
export const cohortFingerprint = (ids) => freezeFingerprint(ids);

/** Когорта пакетів N (Hermes, 27.10.2026, msg_47d547bfb269): стабільний перелік карток аудиту N0 — 678 «лише технічних» +
 *  212 порожніх (890) — файл ПОЗА репозиторієм (змінна MM_N0_COHORT):
 *  { "v": 1, "rev": R, "date", "source", "count": N, "fingerprint"?: "sha256:…", "ids": ["<Offer ID>", …] }.
 *  Контракт у репозиторії (schemas/prom/n0-cohort-contract.json: { v, rev, date, count, fingerprint }) — без ID. Умова не
 *  залежить від поточного стану картки (порожня / поточні характеристики), тож повторний прогін стабільний. Fail-closed: без
 *  файлу, без контракту, з будь-якою невідповідністю — правила N1 не діють для жодного товару (A1 / A2 / А3 — як раніше). */
export function loadCohort(file, contract = null) {
  const res = { valid: false, ids: new Set(), count: 0, rev: 0, date: "", problems: [] };
  if (!file) return res;
  const name = `файл когорти N0 «${path.basename(file)}»`, off = " — правила N1 вимкнено";
  const fail = (why) => { res.problems.push(why + off); return res; };
  if (!fs.existsSync(file)) return fail(`${name} не знайдено`);
  let j = null;
  try { j = readJson(file, null); } catch { return fail(`${name}: некоректний JSON`); }
  const ids = idList(j?.ids);
  if (!j || j.v !== 1 || !Number.isInteger(j.rev) || j.rev < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(String(j.date || "")) || !ids || j.count !== ids.length) return fail(`${name}: немає v=1 / rev / date / ids / count, перелік порожній або ids неунікальні`);
  const fp = cohortFingerprint(ids);
  if (j.fingerprint !== undefined && j.fingerprint !== fp) return fail(`${name}: відбиток у файлі не збігається з ids`);
  const k = contract;
  if (!k || k.v !== 1 || !Number.isInteger(k.rev) || k.rev < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(String(k.date || "")) || !Number.isInteger(k.count) || k.count < 1 || !FP.test(String(k.fingerprint || ""))) return fail("контракт когорти N0 у репозиторії відсутній або некоректний");
  if (k.rev !== j.rev || k.date !== j.date || k.count !== ids.length || k.fingerprint !== fp) return fail(`${name} не відповідає контракту (ревізія ${j.rev} / ${k.rev}, дата ${j.date} / ${k.date}, карток ${ids.length} / ${k.count}, відбиток ${k.fingerprint === fp ? "збігається" : "інший"})`);
  return { valid: true, ids: new Set(ids), count: ids.length, rev: j.rev, date: String(j.date), problems: [] };
}

/** Схеми, словники й одиниці для синхронізації. */
export function loadPromCatalog(dir = SCHEMAS_DIR, { promCategoriesFile = process.env.MM_PROM_CATEGORIES || "", ownerValuesFile = process.env.MM_OWNER_VALUES || "", freezeFile = process.env.MM_FREEZE_IDS || "", freezeContractFile = path.join(dir, "freeze-contract.json"), a3PairsFile = process.env.MM_A3_PAIRS || "", a3ContractFile = path.join(dir, "a3-pairs-contract.json"), n0CohortFile = process.env.MM_N0_COHORT || "", n0CohortContractFile = path.join(dir, "n0-cohort-contract.json") } = {}) {
  const out = { schemas: new Map(), mappings: new Map(), units: readJson(path.join(dir, "units.json"), { conversions: [] }), problems: [] };
  // Технічні нормалізації (TECH_RULES) — лише з валідним переліком захищених товарів, що точно відповідає контракту; для захищених — не діють.
  let contract = null;
  if (freezeFile) { try { contract = readJson(freezeContractFile, null); } catch { contract = null; } }
  const fz = loadFreeze(freezeFile, contract);
  out.freezeInfo = { valid: fz.valid, file: freezeFile ? path.basename(freezeFile) : "", rev: fz.rev, date: fz.date, count: fz.ids.size, scope: fz.scope.size, source: fz.source, parts: fz.parts };
  // Когорта N0 (правила N1) — лише з валідним переліком захищених; уся когорта має бути в області дії.
  let n0c = null;
  if (n0CohortFile) { try { n0c = readJson(n0CohortContractFile, null); } catch { n0c = null; } }
  const co = loadCohort(n0CohortFile, n0c);
  // Захищені в когорті (нове питання власника з 678 → новий перелік захищених) — очікувано: N1 вимикається лише їм (!fz.ids у
  // techRulesFor), решта когорти — як була. Товар когорти поза областю дії — когорта не з того знімка: N1 вимкнено для всіх.
  if (co.valid && fz.valid) {
    const outScope = [...co.ids].filter((x) => !fz.scope.has(x)).length;
    if (outScope) { co.valid = false; co.problems.push(`когорта N0: ${outScope} товарів поза областю дії переліку захищених — правила N1 вимкнено`); }
  }
  out.cohortInfo = { valid: fz.valid && co.valid, file: n0CohortFile ? path.basename(n0CohortFile) : "", rev: co.rev, date: co.date, count: co.count };
  // Лише товари погодженої області (знімок основного каталогу), крім захищених; поза областю — як у 83206c4. N1 — лише когорта N0.
  out.techRulesFor = (id) => (fz.valid && fz.scope.has(String(id)) && !fz.ids.has(String(id)) ? [...TECH_RULES, ...(out.cohortInfo.valid && co.ids.has(String(id)) ? N1_RULES : [])] : []);
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
  out.problems.push(...fz.problems); // проблеми переліку — після проблем схем (порядок попереджень як до А1)
  out.problems.push(...co.problems);
  // Точні пари А3 — лише разом із валідним переліком захищених і лише для товарів, яким діють технічні нормалізації.
  let a3c = null;
  if (a3PairsFile) { try { a3c = readJson(a3ContractFile, null); } catch { a3c = null; } }
  const a3 = loadA3Pairs(a3PairsFile, a3c);
  out.problems.push(...a3.problems);
  out.a3Info = { valid: fz.valid && a3.valid, pairsValid: a3.valid, file: a3PairsFile ? path.basename(a3PairsFile) : "", rev: a3.rev, count: a3.count };
  out.a3PairsFor = (id) => (out.a3Info.valid && out.techRulesFor(id).length ? a3.map.get(String(id)) || [] : []);
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
