/** Пріоритет власника в синхронізації «Основного каталогу» (фінальні вимоги 29.10, ENG-09 розд. 4.2; Hermes CC4-REQ-MANUAL).
 *  Вмикається config.ownerPriority.enabled. Замість глобальної зупинки за паспортом / печаткою — покрокова класифікація рядків:
 *   • змінились лише керовані поля → правки власника (field-control: стан C, постачальник не перезаписує, попередження);
 *   • «ID постачальника» змінено поза системою (≠ sid стану) → ІЗОЛЯЦІЯ лише цього товару (жодного запису в рядок, разом із цінами);
 *   • рядок без стану в аркуші, де колонка стану вже була, → ізоляція (рядок додано вручну / стан стерто) + звіт;
 *   • перший запуск (колонку стану щойно додано) → міграція: усі наявні керовані поля — C («migration»), нічого не перезаписується.
 *  Печатка рядка лишається аудитом: після кожного запису система перераховує її для рядка. Модуль чистий (без I/O). */
import { mtText, sha256 } from "./text.mjs";
import { MANAGED_FIELDS, STATE_COLUMN, WARNING_MARK_COLUMN, SRC, PARAMS_FIELD, readState, writeState, emptyState, detectEdits, applySupplier, customFields, hv } from "./field-control.mjs";
import { FROZEN_COLUMNS, SEAL_COLUMN, rowSeal } from "./seal.mjs";

export const OWNER_PRICE = "Ціна власника";
export const OWNER_AVAILABILITY = "Наявність власника";
/** Колонки «Основного каталогу», які додаються в кінець аркуша в режимі пріоритету власника. */
export const OP_MAIN_COLUMNS = Object.freeze([STATE_COLUMN, WARNING_MARK_COLUMN, OWNER_PRICE, OWNER_AVAILABILITY]);
/** Керовані текстові поля синхронізації. Характеристики — генератор із поштучним походженням (ВРУЧНУ / ВЛАСНИК зберігаються). */
export const SYNC_FIELDS = Object.freeze(MANAGED_FIELDS.filter((f) => f.kind !== "params"));
/** Рішення власника 29–30.10: пріоритет власника — типова й обов'язкова поведінка. Старий режим глобального паспорта — лише за ЯВНОГО
 *  ownerPriority.enabled === false (регресійні тести прийнятої старої поведінки); робочі точки запуску його відхиляють (productionConfig). */
export const enabled = (config) => config?.ownerPriority?.enabled !== false;

/** Запропоновані значення керованих полів, якби їх вів постачальник: назви — сирі назви; описи — сирі описи (якщо є);
 *  поля без сирого джерела — поточне значення (постачальник їх не веде). */
export function proposedManaged(row) {
  const raw = (k) => mtText(row[k]).trim();
  return {
    "Назва UA": raw("Назва постачальника UA") ? row["Назва постачальника UA"] : row["Назва UA"],
    "Назва RU": raw("Назва постачальника RU") ? row["Назва постачальника RU"] : row["Назва RU"],
    "Опис UA": raw("Опис постачальника UA") ? row["Опис постачальника UA"] : row["Опис UA"],
    "Опис RU": raw("Опис постачальника RU") ? row["Опис постачальника RU"] : row["Опис RU"],
    "Запити UA": row["Запити UA"], "Запити RU": row["Запити RU"], "Виробник": row["Виробник"],
  };
}

/** Класи міграції (рішення власника 29.10: не заморожувати все як CUSTOM):
 *   SUPPLIER   — значення дорівнює сирому значенню постачальника → S (далі веде постачальник; на ПЕРШОМУ запуску не змінюється);
 *   CUSTOM     — є доказ нашого рішення (evidence) або в постачальника джерела немає → C;
 *   UNCERTAIN  — відрізняється від постачальника, доказу немає → C (не перезаписується) + аркуш «Класифікація полів» для рішення власника. */
export const MIGRATION_CLASS = Object.freeze({ SUPPLIER: "ПОСТАЧАЛЬНИКА", CUSTOM: "НАШЕ", UNCERTAIN: "НЕВИЗНАЧЕНЕ" });
export function migrateState(row, at, { evidence = {} } = {}) {
  // Рішення власника 29.10 (остаточне): збіг значення з фідом НЕ доводить, що поле постачальника. Без достовірного доказу —
  // «НЕВИЗНАЧЕНЕ» (C, не перезаписується, «Класифікація полів»). Підтверджене наше рішення — пріоритет незалежно від збігу.
  // evidence.custom(row, field) / evidence.supplier(row, field) — підключувані джерела доказів (реєстри рішень, черга тощо).
  const isCustom = evidence.custom || (() => false), isSupplier = evidence.supplier || (() => false);
  const st = emptyState(), report = [];
  for (const s of SYNC_FIELDS) {
    if (!(s.field in row)) continue;
    const v = mtText(row[s.field]).trim(), r = s.raw ? mtText(row[s.raw]).trim() : null;
    const cls = isCustom(row, s.field) || r === null ? MIGRATION_CLASS.CUSTOM
      : isSupplier(row, s.field) ? MIGRATION_CLASS.SUPPLIER : MIGRATION_CLASS.UNCERTAIN;
    st.f[s.field] = { s: cls === MIGRATION_CLASS.SUPPLIER ? SRC.SUPPLIER : SRC.CUSTOM, sys: hv(row[s.field]), raw: s.raw ? hv(row[s.raw]) : "", at, by: "migration:" + cls };
    report.push({ field: s.field, class: cls, value: v.slice(0, 300), supplier: (r ?? "").slice(0, 300) });
  }
  st.sid = mtText(row["ID постачальника"]);
  return { state: st, report };
}

/** Початковий стан полів затвердженого товару (черга → «Основний каталог»): поле, що дорівнює сирому значенню постачальника, —
 *  S (його й далі веде постачальник); відмінне (власник уже відредагував) або без сирого джерела — C. */
export function approvalState(row, at) {
  const st = emptyState();
  for (const s of SYNC_FIELDS) {
    if (!(s.field in row)) continue;
    const v = mtText(row[s.field]).trim(), r = s.raw ? mtText(row[s.raw]).trim() : null;
    const supplier = r !== null && r !== "" && v === r;
    st.f[s.field] = { s: supplier ? SRC.SUPPLIER : SRC.CUSTOM, sys: hv(row[s.field]), raw: s.raw ? hv(row[s.raw]) : "", at, by: "approval" };
  }
  st.sid = mtText(row["ID постачальника"]);
  return st;
}

/**
 * Підготовка рядка до оновлення (до refresh).
 * @returns {{ state, isolate: string|null, changes, migrated: object[]|null }}
 */
export function prepareRow(row, { at, migrating, edited = new Set() }) {
  const cell = mtText(row[STATE_COLUMN]).trim();
  if (!cell) {
    if (!migrating) return { state: null, isolate: "РЯДОК БЕЗ СТАНУ ПОЛІВ (додано вручну або стан стерто) — потрібне рішення", changes: [], migrated: null };
    const m = migrateState(row, at);
    return { state: m.state, isolate: null, changes: [], migrated: m.report };
  }
  const st = readState(cell);
  if (st.bad) return { state: st, isolate: null, changes: [], migrated: null }; // захисно: усі поля C (field-control), без перезапису
  const sidNow = mtText(row["ID постачальника"]);
  const sid = mtText(JSON.parse(cell).sid ?? "");
  if (sid && sid !== sidNow) return { state: st, isolate: `«ID постачальника» змінено поза системою (${sid} → ${sidNow}) — критична зміна ідентичності; товар ізольовано`, changes: [], migrated: null };
  const d = detectEdits({ row, state: st, edited, at, fields: SYNC_FIELDS });
  return { state: { ...d.state, sid: sid || sidNow }, isolate: null, changes: d.changes, migrated: null };
}

/**
 * Завершення рядка (після refresh системних полів): керовані поля S → від постачальника, C → наші; попередження.
 * original — рядок до оновлення (поточні значення власника й попередні сирі); refreshed — після refresh системних полів.
 */
export function finishRow({ original, refreshed, state, ctx, at, hold = false }) {
  // hold (перший запуск / міграція): керовані поля не змінюються в цьому запуску навіть зі станом S — лише фіксується стан.
  const proposed = { ...refreshed, ...(hold ? Object.fromEntries(SYNC_FIELDS.filter((s) => s.field in original).map((s) => [s.field, original[s.field]])) : proposedManaged(refreshed)) };
  const a = applySupplier({ row: original, proposed, state, ctx, at, fields: SYNC_FIELDS });
  const st = { ...a.state, sid: mtText(a.row["ID постачальника"]) };
  const row = { ...a.row, [STATE_COLUMN]: stateCell(st, a.row) };
  return { row, warnings: a.warnings, rawChanged: a.rawChanged, anomalies: a.anomalies };
}
/** Серіалізація стану з sid (field-control зберігає f / p; sid — ідентичність на момент останнього запису системи) і sysh — відбиток
 *  колонок ідентичності й службових (M3) у рядку row, який система записує разом із цим станом. Без row — попередній sysh. */
export function stateCell(st, row = null) {
  const base = JSON.parse(writeState(st));
  const sysh = row ? systemHash(row) : (st.sysh ?? "");
  return JSON.stringify({ ...base, sid: st.sid ?? "", ...(sysh ? { sysh } : {}) });
}

/** M1 (ENG-10 §3): опечатані колонки, які власник може редагувати вручну. Решта опечатаних — ідентичність і службові (пише лише sync). */
export const OWNER_EDITABLE_COLUMNS = Object.freeze([
  ...MANAGED_FIELDS.map((f) => f.field), PARAMS_FIELD, "Код товару Prom", "Група ID", "Група UA", "Група RU",
  "Категорія Prom ID", "Категорія Prom URL", "Країна", "GTIN",
].filter((k, i, a) => a.indexOf(k) === i));
export const SYSTEM_HASH_COLUMNS = Object.freeze(FROZEN_COLUMNS.filter((k) => !OWNER_EDITABLE_COLUMNS.includes(k)));
/** Відбиток колонок ідентичності й службових (sysh): змінюється лише записом системи; правка власника дозволених полів його не змінює. */
export function systemHash(row) {
  return sha256(JSON.stringify(SYSTEM_HASH_COLUMNS.map((k) => mtText(row?.[k])))).slice(0, 32);
}

/**
 * M3 (ENG-10 §3, CC R6 §3.2): вердикт цілісності однієї картки — для видалення / повернення з архіву лише цієї картки.
 *   OK          — печатка = вмісту (після останнього запису системи нічого не змінено);
 *   OWNER_EDIT  — печатка інша, але стан валідний, sid і sysh збігаються: змінено лише дозволені власнику поля;
 *   CORRUPT     — порожній Offer ID; стан пошкоджено; sid ≠ «ID постачальника»; sysh ≠ (ідентичність / службові змінено поза sync);
 *   UNVERIFIED  — печатка інша, а стану немає (до міграції) або стан без sysh (правку не відрізнити від пошкодження).
 * Дубль Offer ID перевіряє CC (rowsWithId). Чиста функція.
 */
export function cardVerdict(row) {
  const v = (verdict, reasons = [], custom = []) => ({ verdict, reasons, customFields: custom });
  if (!mtText(row?.["Offer ID"]).trim()) return v("CORRUPT", ["порожній Offer ID"]);
  const cell = mtText(row[STATE_COLUMN]).trim();
  let raw = null;
  if (cell) { try { raw = JSON.parse(cell); } catch { raw = null; } }
  const st = cell ? readState(cell) : null;
  const custom = st && !st.bad ? customFields(st) : [];
  if (rowSeal(row) === mtText(row[SEAL_COLUMN])) return v("OK", [], custom);
  if (!cell) return v("UNVERIFIED", ["печатка не збігається, а стану полів ще немає (до міграції) — правку не відрізнити від пошкодження"]);
  if (!raw || typeof raw !== "object" || st.bad) return v("CORRUPT", ["«Стан полів JSON» пошкоджено"]);
  const sid = mtText(raw.sid ?? "");
  if (sid && sid !== mtText(row["ID постачальника"])) return v("CORRUPT", [`«ID постачальника» змінено поза системою (${sid} → ${mtText(row["ID постачальника"])})`]);
  if (!raw.sysh) return v("UNVERIFIED", ["стан без відбитка системних колонок (sysh) — правку не відрізнити від пошкодження"]);
  if (raw.sysh !== systemHash(row)) return v("CORRUPT", ["змінено ідентичність або службові колонки поза синхронізацією"]);
  return v("OWNER_EDIT", ["змінено лише дозволені власнику поля"], custom);
}
/** Інтерфейс integrity для Catalog Controls (controlsState(book, { integrity })). */
export const cardIntegrity = Object.freeze({ cardVerdict });
/** Позначка рядка: нові попередження цього запуску додаються до відкритих (з аркуша попереджень, якщо передано). */
export function markCell(prevMark, warnings) {
  if (!warnings.length) return mtText(prevMark);
  const fields = [...new Set(warnings.map((w) => w.field))];
  return `⚠ ${warnings[0].at.slice(0, 10)}: ${fields.join(", ")}`;
}
