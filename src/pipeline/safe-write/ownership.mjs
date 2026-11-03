/** E2 (ENG-01 K4) — контракт власності колонок (`schemas/sheets/ownership-contract.json`): хто має право писати кожну колонку.
 *  Колонка поза контрактом або аркуш поза контрактом — запис нікому (fail-closed). Перевірка — ДО будь-якого запиту до API. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OUTCOME, WriteOutcomeError } from "../write-outcome.mjs";

// ENG-29: у Cloudflare Workers import.meta.url немає — там контракт передається об'єктом (ownershipFrom), шлях до файлу — лише в Node.
export const OWNERSHIP_FILE = import.meta.url ? path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../schemas/sheets/ownership-contract.json") : "";

export function loadOwnership(file = OWNERSHIP_FILE) {
  return ownershipFrom(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Контракт з уже розібраного JSON (той самий формат файлу). */
export function ownershipFrom(c) {
  if (c.v !== 1 || !c.sheets) throw new Error("контракт власності колонок: невідомий формат");
  const sheets = new Map();
  for (const [title, s] of Object.entries(c.sheets)) {
    const cols = new Map();
    // inheritColumnsOf: група з усіма колонками іншого (уже описаного) аркуша — напр. архів «Видалені товари» = колонки каталогу.
    for (const g of s.groups) for (const col of g.inheritColumnsOf ? [...(sheets.get(g.inheritColumnsOf)?.columns.keys() || [])] : g.columns) {
      if (cols.has(col)) throw new Error(`контракт власності: колонка «${col}» у двох групах`);
      cols.set(col, { group: g.name, writers: Object.freeze([...g.writers]), gate: g.gate || "" });
    }
    sheets.set(title, Object.freeze({ key: s.key, identity: Object.freeze([...(s.identity || [])]), appendWriters: Object.freeze([...(s.appendWriters || [])]), deleteWriters: Object.freeze([...(s.deleteWriters || [])]), columns: cols }));
  }
  return Object.freeze({ v: c.v, writers: Object.freeze(Object.keys(c.writers || {})), sheets });
}

/** Перевірка права запису: кидає WriteOutcomeError NOT_APPLIED (код OWNERSHIP) із переліком заборонених колонок. */
export function assertWritable(contract, title, writer, columns) {
  const s = contract.sheets.get(title);
  if (!s) throw new WriteOutcomeError(`контракт власності: аркуш «${title}» не описаний — запис заборонено`, { outcome: OUTCOME.NOT_APPLIED, op: "ownership", code: "OWNERSHIP" });
  const bad = columns.filter((c) => !s.columns.get(c)?.writers.includes(writer));
  if (bad.length) throw new WriteOutcomeError(`контракт власності: записувач «${writer}» не має права писати ${bad.map((c) => `«${c}» (${s.columns.get(c)?.group || "поза контрактом"})`).join(", ")}`, { outcome: OUTCOME.NOT_APPLIED, op: "ownership", code: "OWNERSHIP" });
  return s;
}

/** Колонки з «воротами стану» (gate: field-state): записати можна лише поле, яке в рядку має стан SUPPLIER (пріоритет власника). */
export const gatedColumns = (contract, title) => new Set([...(contract.sheets.get(title)?.columns || new Map())].filter(([, v]) => v.gate === "field-state").map(([k]) => k));

/** ENG-22 (F05): колонки з воротами "cmd-consume" (рішення власника): записувач лише СПОЖИВАЄ команду — очищує клітинку, у якій
 *  досі саме очікуване значення (непорожнє). Будь-яке інше значення в set — відмова до запиту. */
export const consumeColumns = (contract, title) => new Set([...(contract.sheets.get(title)?.columns || new Map())].filter(([, v]) => v.gate === "cmd-consume").map(([k]) => k));

/** Колонки аркуша, які дозволено писати записувачу. */
export const writableColumns = (contract, title, writer) => [...(contract.sheets.get(title)?.columns || new Map())].filter(([, v]) => v.writers.includes(writer)).map(([k]) => k);
