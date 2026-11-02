/** ENG-22 (Hermes ENG-21 F05) — ТИМЧАСОВИЙ розділ власності колонок аркуша «Нові товари» (черга) для записів intake за ключем.
 *
 *  Статус: ПРОПОЗИЦІЯ (матриця B6, ENG-20-B6-матриця-власності-Нові-товари.uk.md), НЕ затверджений контракт:
 *   - `schemas/sheets/ownership-contract.json` не змінено; щойно в ньому з'явиться затверджений розділ «Нові товари», діє ВІН
 *     (withProvisionalQueue повертає контракт без змін);
 *   - справжню таблицю не змінено, міграцію не запускав.
 *  Правило fail-closed: колонка без записувача — у наявних рядках її не змінює ніхто. Так закрито:
 *   - ручні колонки власника (запити, група, категорія, виробник);
 *   - 6 колонок без визначеного записувача (B6 «?») — безпечна відмова до затвердження контракту;
 *   - колонки sync (код Prom, статус імпорту, печатка рядка) і «лише при додаванні» (ідентичність, валюта, GTIN, країна, «Виявлено»).
 *  «Рішення» — gate "cmd-consume": записувач лише СПОЖИВАЄ команду власника (очищує клітинку, у якій досі саме вона: expect).
 *  Нові рядки — appendWriters (intake), повні початкові значення. Видалення рядків черги — лише sync за ключем зі знімком рядка
 *  (ENG-29, рішення власника 02.11: перенесені в «Основний каталог» рядки прибираються; охоронець цілі дозволяє це лише режиму transfer).
 *  ENG-27 (Hermes INT N3): sync — теж записувач СИСТЕМНИХ колонок (сирі дані, ціни / наявність, умовне SEO, характеристики, стан
 *  черги) — лише за Offer ID з очікуваними значеннями (updateByKey), без позиційного перезапису. «Рішення», ручні колонки власника,
 *  6 колонок B6 «?», колонки «лише при додаванні» й видалення рядків sync НЕ дозволено. Записувач sync поряд з intake — тимчасово,
 *  до затвердження B6 (якщо B6 лишить лише intake — прибрати "sync" з writers: keyedUpdate тоді відмовить, sync звітує BLOCKED). */
import { SHEET } from "../../core/sheet-sync.mjs";

export const QUEUE_TITLE = SHEET.queue;
export const UNDEFINED_B6_COLUMNS = Object.freeze(["Категорія Prom: підтверджено", "Джерело контенту", "SHA256 контенту", "Унікальний ID Prom", "Існує у Prom", "Поля Prom JSON"]);

const GROUPS = Object.freeze([
  { name: "ключ", writers: [], columns: ["Offer ID"] },
  { name: "ідентичність (лише при додаванні)", writers: [], columns: ["ID постачальника"] },
  { name: "сирі дані постачальника (intake)", writers: ["intake", "sync"], columns: ["Артикул постачальника", "Назва постачальника UA", "Назва постачальника RU", "URL постачальника", "Модель", "Фото JSON", "Характеристики постачальника JSON", "Опис постачальника UA", "Опис постачальника RU"] },
  { name: "незмінні після додавання (intake лише при додаванні)", writers: [], columns: ["Валюта", "GTIN", "Країна"] },
  { name: "ціни й наявність (LIVE, intake)", writers: ["intake", "sync"], columns: ["Ціна постачальника", "Ціна", "Ціна кінцева", "Знижка", "Наявність", "Кількість постачальника", "Стан синхронізації", "Оновлено"] },
  { name: "SEO (умовна власність: сире SEO — intake, після правки — власник; паралельну правку ловить expect)", writers: ["intake", "sync"], columns: ["Назва UA", "Назва RU", "Опис UA", "Опис RU"] },
  { name: "ручні колонки власника", writers: [], columns: ["Запити UA", "Запити RU", "Група ID", "Група UA", "Група RU", "Категорія Prom ID", "Категорія Prom URL", "Виробник"] },
  { name: "характеристики (поштучне походження, intake)", writers: ["intake", "sync"], columns: ["Характеристики JSON", "Походження характеристик JSON"] },
  { name: "записувач не визначений (B6 «?») — до затвердження контракту запис заборонено", writers: [], columns: [...UNDEFINED_B6_COLUMNS] },
  { name: "sync (затвердження / прив'язка)", writers: [], columns: ["Код товару Prom", "Статус імпорту", "SHA256 незмінних полів"] },
  { name: "рішення власника (intake лише споживає команду)", writers: ["intake"], gate: "cmd-consume", columns: ["Рішення"] },
  { name: "стан черги (intake)", writers: ["intake", "sync"], columns: ["Перевірка", "Остання зміна постачальника", "SHA даних постачальника", "Погоджено для SHA", "SHA SEO при додаванні", "Погоджені дані постачальника"] },
  { name: "стан черги (лише при додаванні)", writers: [], columns: ["Виявлено"] },
]);

function buildSpec() {
  const columns = new Map();
  for (const g of GROUPS) for (const col of g.columns) {
    if (columns.has(col)) throw new Error(`тимчасовий контракт черги: колонка «${col}» у двох групах`);
    columns.set(col, { group: g.name, writers: Object.freeze([...g.writers]), gate: g.gate || "" });
  }
  // ENG-29 (рішення власника 02.11, змінює B6): перенесені рядки прибираються з черги — видаляти може лише sync (за ключем зі знімком
  // рядка, deleteByKeys); охоронець цілі дозволяє саме видалення лише режиму «Перенести затверджені» (MODE_POLICIES.transfer).
  return Object.freeze({ key: "Offer ID", identity: Object.freeze(["ID постачальника"]), appendWriters: Object.freeze(["intake"]), deleteWriters: Object.freeze(["sync"]), columns, provisional: true });
}
export const PROVISIONAL_QUEUE_SPEC = buildSpec();

/** ENG-29 (рішення власника 03.11): «Відкладені товари» розбираються — перенесені рядки прибирає лише sync за ключем зі знімком рядка
 *  (deleteByKeys); жодна колонка не пишеться й рядки не дописуються. Охоронець дозволяє видалення лише режиму deferred. */
export const DEFERRED_TITLE = SHEET.deferred;
export const PROVISIONAL_DEFERRED_SPEC = Object.freeze({ key: "Offer ID", identity: Object.freeze(["ID постачальника"]), appendWriters: Object.freeze([]), deleteWriters: Object.freeze(["sync"]), columns: new Map(), provisional: true });

/** Контракт для записів через шлюз: затверджені розділи «Нові товари» / «Відкладені товари» мають пріоритет; немає — додаються
 *  тимчасові (позначка provisional). */
export function withProvisionalQueue(contract) {
  if (!contract?.sheets) return contract;
  const add = [];
  if (!contract.sheets.has(QUEUE_TITLE)) add.push([QUEUE_TITLE, PROVISIONAL_QUEUE_SPEC]);
  if (!contract.sheets.has(DEFERRED_TITLE)) add.push([DEFERRED_TITLE, PROVISIONAL_DEFERRED_SPEC]);
  if (!add.length) return contract;
  return Object.freeze({ ...contract, sheets: new Map([...contract.sheets, ...add]), provisional: Object.freeze(add.map(([k]) => k)) });
}
