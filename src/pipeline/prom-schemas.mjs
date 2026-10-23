/** Сховище схем категорій Prom у репозиторії (погоджено власником 23.10.2026):
 *   schemas/prom/<categoryId>.xml — схема рівно в тому вигляді, як її надав власник (один <category>);
 *   schemas/prom/MANIFEST.json    — перелік: id, назви, файл, SHA256, кількість атрибутів, дата отримання;
 *   schemas/prom/units.json       — погоджені перерахунки одиниць;
 *   schemas/prom/mapping/<categoryId>.json — погоджені синоніми: { synonyms: { "назва постачальника": "<id атрибута>" },
 *                                            values: { "<id атрибута>": { "значення постачальника": "<id варіанта>" } } }.
 *  Файл, SHA якого не збігається з MANIFEST, або схема з помилками структури — не використовується (лише попередження). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../core/text.mjs";
import { parseCategory, parseSchemaText } from "../core/prom-schema.mjs";
import { normName } from "../core/prom-attributes.mjs";

export const SCHEMAS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schemas/prom");
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);

export function readManifest(dir = SCHEMAS_DIR) {
  return readJson(path.join(dir, "MANIFEST.json"), { version: 1, categories: [] });
}

/** Схеми, словники й одиниці для синхронізації. */
export function loadPromCatalog(dir = SCHEMAS_DIR) {
  const out = { schemas: new Map(), mappings: new Map(), units: readJson(path.join(dir, "units.json"), { conversions: [] }), problems: [] };
  for (const e of readManifest(dir).categories || []) {
    const file = path.join(dir, e.file);
    if (!fs.existsSync(file)) { out.problems.push(`${e.id}: немає файлу ${e.file}`); continue; }
    const text = fs.readFileSync(file, "utf8");
    if (textSha(text) !== e.sha256) { out.problems.push(`${e.id}: SHA файлу не збігається з MANIFEST — схему не використано`); continue; }
    const parsed = parseSchemaText(text);
    if (parsed.length !== 1 || parsed[0].schema.id !== String(e.id)) { out.problems.push(`${e.id}: у файлі має бути рівно одна категорія з цим id`); continue; }
    if (parsed[0].problems.length) { out.problems.push(`${e.id}: ${parsed[0].problems.join("; ")}`); continue; }
    out.schemas.set(String(e.id), parsed[0].schema);
    const m = readJson(path.join(dir, "mapping", `${e.id}.json`), null);
    if (m) out.mappings.set(String(e.id), {
      synonyms: Object.fromEntries(Object.entries(m.synonyms || {}).map(([k, v]) => [normName(k), String(v)])),
      values: Object.fromEntries(Object.entries(m.values || {}).map(([a, vals]) => [String(a), Object.fromEntries(Object.entries(vals || {}).map(([k, v]) => [normName(k), String(v)]))])),
    });
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
      byId.set(schema.id, { id: schema.id, nameUK: schema.nameUK, nameRU: schema.nameRU, file: name, sha256: sha, attributes: schema.attributes.length, received: prev?.sha256 === sha ? prev.received : received, source: path.basename(f) });
      report.push({ file: path.basename(f), id: schema.id, status: prev ? (prev.sha256 === sha ? "БЕЗ ЗМІН" : "ОНОВЛЕНО") : "ДОДАНО", attributes: schema.attributes.length, ...(schema.empty ? { note: "категорія без атрибутів" } : {}) });
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  manifest.version = 1;
  manifest.categories = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  fs.writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  return report;
}
