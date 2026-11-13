/** ENG-28a — охорона цілі запису в Google Sheets (вимога власника 01.11.2026, розд. 1): перевірка ПЕРЕД кожною операцією запису.
 *
 *  - запис дозволено ЛИШЕ в TEST_SHEET_ID; LIVE_SHEET_ID — завжди BLOCK (незалежно від змінних середовища й назви таблиці);
 *  - лише облікові записи з allowlist (mm-sheets-copy) і лише короткочасний токен зі scope рівно spreadsheets (assertWriterToken);
 *  - кожна операція: аркуш дозволено політикою операції, операція дозволена, колонки блоку — з дозволеного переліку (заголовок —
 *    з прочитаного аркуша); видалення рядків — завжди BLOCK; будь-яка невідповідність — BLOCK БЕЗ запиту до API.
 *  Залишкове обмеження: що обліковий запис НЕ може редагувати LIVE, код незалежно не доводить (Drive API у проєкті вимкнено;
 *  підтверджено власником через інтерфейс 01.11: прямого доступу немає, загальний доступ LIVE — лише читання). Код забороняє LIVE сам. */
import { mtText } from "../../core/text.mjs";

export const TEST_SHEET_ID = "1th8VXOUeN08Lk9QNrjdt4GK3Z0nTnU8Awkb5pLvWOxs";
export const LIVE_SHEET_ID = "1AhQUz1bUB2LiQX4OKBbvTCSmTMWoKPcdQUtr3-TK2L8";
export const WRITER_ACCOUNTS = Object.freeze(["mm-sheets-copy@maisternia-prom-infra.iam.gserviceaccount.com"]);
export const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const WRITE_OPS = Object.freeze(["updateRanges", "appendRows", "deleteRows", "ensureColumns", "ensureSheet", "setPercentFormat", "deleteSheet", "addRowHighlight", "formatColumns"]);
/** Методи записувача без запису (читання). Будь-який інший метод — BLOCK (заборонено за замовчуванням). */
const READ_OPS = Object.freeze(["meta", "read"]);
/** Короткоживучий токен: не довше за типовий строк IAM generateAccessToken (3600 с). */
export const MAX_TOKEN_SECONDS = 3600;

export class WriteTargetBlocked extends Error {
  constructor(reason, detail = {}) { super("BLOCK запису: " + reason); this.code = "WRITE_TARGET_BLOCK"; this.outcome = "NOT_APPLIED"; this.detail = detail; }
}
const block = (reason, detail) => { throw new WriteTargetBlocked(reason, detail); };

/** Ціль запису: лише тестова таблиця. */
export function assertWriteTarget(spreadsheetId) {
  const id = mtText(spreadsheetId).trim();
  if (!id) block("немає ID таблиці");
  if (id === LIVE_SHEET_ID) block("ціль — ЖИВА таблиця «Інструменти»: запис заборонено завжди");
  if (id !== TEST_SHEET_ID) block("ціль — не тестова копія «Інструменти — ТЕСТ нової системи»: запис дозволено лише в неї");
  return id;
}
/** Токен записувача: обліковий запис з allowlist, scope рівно spreadsheets (tokeninfo); info — { scopes, account }. */
export function assertWriterToken(info) {
  const scopes = info?.scopes || [];
  if (scopes.length !== 1 || scopes[0] !== WRITE_SCOPE) block("токен запису має бути рівно зі scope spreadsheets", { scopes });
  if (!WRITER_ACCOUNTS.includes(mtText(info?.account))) block("обліковий запис записувача не з дозволеного переліку", { account: info?.account ?? null });
  return true;
}
/** Токен запису — лише короткоживучий токен mm-sheets-copy з одним scope spreadsheets; змінна оточення не використовується.
 *  obtain({ scope }) — IAM generateAccessToken для ФІКСОВАНОГО облікового запису (tools/copy-access-check.mjs: obtainToken);
 *  scopeOf(token, scope) — tokeninfo (assertTokenScope) → { scopes, expiresIn }; account — обліковий запис, для якого видано токен.
 *  Залишкове обмеження: обліковий запис гарантує шлях видачі (URL generateAccessToken), tokeninfo його окремо не підтверджує. */
export async function writerAccessToken({ obtain, scopeOf, account }) {
  const token = await obtain({ scope: WRITE_SCOPE });
  const info = await scopeOf(token, WRITE_SCOPE);
  assertWriterToken({ scopes: info?.scopes, account });
  const ttl = info?.expiresIn;
  if (!(Number.isFinite(ttl) && ttl > 0 && ttl <= MAX_TOKEN_SECONDS)) block("токен запису має бути короткоживучим (≤ 1 год)", { expiresIn: ttl ?? null });
  return async () => token;
}

const colOf = (header, n) => header[n - 1] ?? `#${n}`;
/**
 * Обгортка над записувачем (MemorySheets / GoogleSheetsWriter): перевірка кожної операції ДО виклику.
 * policy: { [аркуш]: { ops: [...], columns?: [...] | "*", header?: bool } } — header: дозволено писати рядок 1 (міграція заголовка).
 * headers: { [аркуш]: string[] } — заголовки, прочитані перед операцією (для назв колонок блоку); оновлюються після запису рядка 1.
 */
export function guardedSheets(sheets, { spreadsheetId, policy, headers = {} }) {
  assertWriteTarget(spreadsheetId);
  const hdr = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, (v || []).map(mtText)]));
  const check = (op, title) => {
    assertWriteTarget(spreadsheetId);
    // ENG-29 (рішення власника 02.11, змінює B6): видалення рядків — лише де політика режиму явно це дозволяє для САМЕ цього аркуша
    // (deleteRows: true; зараз — лише «Перенести затверджені» → «Нові товари», за ключем зі знімком рядка через шлюз W2). Інакше — BLOCK.
    if (op === "deleteRows" && !(policy[title]?.deleteRows === true && (policy[title].ops || []).includes("deleteRows"))) block("видалення рядків заборонено", { title });
    if (op === "deleteSheet" && !(policy[title]?.deleteSheet === true && (policy[title].ops || []).includes("deleteSheet"))) block("видалення аркуша заборонено", { title });
    const p = policy[title] || policy["*"];
    if (!p) block(`аркуш «${title}» не дозволено цією операцією`, { op });
    if (!(p.ops || []).includes(op)) block(`операція ${op} для «${title}» не дозволена`, { op });
    return p;
  };
  // ENG-29 (Hermes F-28C-3): clearOnly — колонки, які режим може лише ОЧИЩУВАТИ (спожити команду власника), але не записувати значення.
  const clearOnlyCheck = (p, title, header, col0, rows, row0) => {
    if (!p.clearOnly?.length) return;
    if (!header) block(`немає прочитаного заголовка «${title}» — колонки блоку не перевірити`);
    for (const [i, r] of (rows || []).entries()) (r || []).forEach((v, j) => {
      const c = colOf(header, col0 + j);
      if (p.clearOnly.includes(c) && mtText(v) !== "") block(`колонку «${c}» аркуша «${title}» цей режим може лише очищувати`, { row: row0 + i });
    });
  };
  const checkBlock = (b) => {
    const p = check("updateRanges", b.title);
    const width = Math.max(0, ...(b.values || []).map((r) => r.length));
    if (b.row === 1) {
      if (!p.header) block(`запис заголовка «${b.title}» не дозволено`);
      // Частина заголовка (напр. одна нова колонка в кінці) — на своєму місці; решта прочитаного заголовка лишається.
      const h = (hdr[b.title] || []).slice(); (b.values[0] || []).forEach((v, j) => { h[b.col - 1 + j] = mtText(v); }); hdr[b.title] = h;
      return;
    }
    clearOnlyCheck(p, b.title, hdr[b.title], b.col, b.values, b.row);
    // ENG-29: deny — колонки, які режим не пише ніколи (навіть за columns "*").
    if (p.deny?.length) {
      const header = hdr[b.title];
      if (!header) block(`немає прочитаного заголовка «${b.title}» — колонки блоку не перевірити`);
      for (let j = 0; j < width; j++) { const c = colOf(header, b.col + j); if (p.deny.includes(c)) block(`колонку «${c}» аркуша «${b.title}» цей режим не змінює`, { row: b.row }); }
    }
    if (p.columns === "*") return;
    const header = hdr[b.title];
    if (!header) block(`немає прочитаного заголовка «${b.title}» — колонки блоку не перевірити`);
    for (let j = 0; j < width; j++) { const c = colOf(header, b.col + j); if (!(p.columns || []).includes(c)) block(`колонка «${c}» аркуша «${b.title}» не дозволена`, { row: b.row }); }
  };
  return new Proxy(sheets, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      if (READ_OPS.includes(prop)) return v.bind(target);
      if (!WRITE_OPS.includes(prop)) return () => block(`невідома операція записувача «${String(prop)}» — заборонено за замовчуванням`);
      return async (...args) => {
        if (prop === "updateRanges") for (const b of args[0] || []) checkBlock(b);
        else if (prop === "appendRows") { const p = check(prop, String(args[0])); clearOnlyCheck(p, String(args[0]), hdr[String(args[0])], 1, args[1], 0); }
        else if (prop === "ensureColumns" || prop === "ensureSheet" || prop === "deleteRows" || prop === "setPercentFormat" || prop === "deleteSheet" || prop === "addRowHighlight" || prop === "formatColumns") check(prop, String(args[0]));
        return v.apply(target, args);
      };
    },
  });
}

/** ENG-28a: політики запису для режимів tools/sheet-sync (аркуші / операції / колонки). «*» як аркуш — будь-який, крім видалень рядків
 *  (режими CC / архіву створюють власні аркуші); колонки «*» — стовпці стережуть контракт власності й keyedUpdate. */
const SYNC_TITLES = ["Основний каталог", "Нові товари", "Відкладені товари", "Заморожені ID", "Паспорт каталогу", "Історія прив'язок", "Аудит", "Попередження постачальника", "Архів", "Класифікація полів", "Журнал"];
const BROAD = Object.freeze({ ops: ["updateRanges", "appendRows", "ensureColumns", "ensureSheet", "setPercentFormat"], columns: "*", header: true });
/** ENG-28d: «Журнал» з ключем «ID події» — дописування подій і разове додавання колонки ID (лише заголовок; рядки подій не змінюються). */
const JOURNAL_KEYED = Object.freeze({ ops: ["appendRows", "ensureColumns", "updateRanges"], columns: ["ID події"], header: true });
const broad = (titles) => Object.fromEntries(titles.map((t) => [t, BROAD]));
/** Рішення власника 04.11: опрацьовані попередження — в архів (дописування за ключем; з аркуша — deleteByKeys зі знімком; appendRows —
 *  лише повернення чужого рядка зі знімка), заголовок і значення «Що змінилось». */
const WARN_ARCHIVE = Object.freeze({
  "Попередження постачальника": { ops: ["updateRanges", "deleteRows", "appendRows", "ensureColumns"], columns: ["Що змінилось"], header: true, deleteRows: true },
  "Попередження — архів": { ops: ["ensureSheet", "appendRows"], header: true },
});
export const MODE_POLICIES = Object.freeze({
  structure: { "Нові товари": { ops: ["ensureColumns", "updateRanges"], columns: ["Перевірка"], header: true }, "Паспорт каталогу": { ops: ["ensureSheet", "updateRanges"], columns: "*", header: true }, "Журнал": { ops: ["appendRows"] } },
  correction: { "Основний каталог": { ops: ["updateRanges"], columns: ["Опис UA", "Опис RU", "Запити UA", "Запити RU"] }, "Журнал": { ops: ["appendRows"] } },
  merge: { "Основний каталог": { ops: ["ensureColumns", "updateRanges", "appendRows"], columns: ["Стан у постачальника", "Знімок постачальника JSON"], header: true },
    "Нові товари": { ops: ["ensureColumns", "updateRanges"], columns: ["Перевірка"], header: true }, "Паспорт каталогу": { ops: ["ensureSheet", "updateRanges"], columns: "*", header: true }, "Журнал": JOURNAL_KEYED },
  sync: broad(SYNC_TITLES), intake: broad(SYNC_TITLES), scenario: broad(SYNC_TITLES), "scenario-mass": broad(SYNC_TITLES),
  // ENG-29 (Hermes F-28C-2): «Оновити товари» — без черги й «Заморожених ID» (ENG-28c: update їх не змінює) і без дописування рядків
  // в «Основний каталог» (нові картки — лише «Перенести затверджені»). Логіка власника 02.11 (ENG-28b preserve): «Оновити товари» не
  // перегенеровує й не перезаписує підготовлені характеристики — «Характеристики JSON» і їхнє походження цей режим не пише ніколи
  // (зміни характеристик постачальника — лише попередження на товарі).
  update: { ...broad(SYNC_TITLES.filter((x) => x !== "Нові товари" && x !== "Заморожені ID")), ...WARN_ARCHIVE, "Попередження постачальника": { ...BROAD, ops: [...BROAD.ops, "deleteRows"], deleteRows: true }, "Основний каталог": { ...BROAD, ops: BROAD.ops.filter((o) => o !== "appendRows"), deny: ["Характеристики JSON", "Походження характеристик JSON"] } },
  // ENG-29 (рішення власника 03.11): «Оновити ціни й наявність» — лише 8 операційних колонок «Основного каталогу» (за ключем) і «Журнал»;
  // жодних назв, фото, характеристик, присутності, черги, нових рядків чи колонок.
  prices: { "Основний каталог": { ops: ["updateRanges"], columns: ["Ціна постачальника", "Ціна", "Ціна кінцева", "Знижка", "Наявність", "Кількість постачальника", "Стан синхронізації", "Оновлено"] }, "Журнал": JOURNAL_KEYED, ...WARN_ARCHIVE },
  controls: { "*": BROAD }, recover: { "*": BROAD }, archive: { "*": BROAD }, refresh: { "*": BROAD },
  // Рішення власника 03.11 (перед підключенням Prom): точкові правки власника за планом; 04.11 — також запити й група товару (наведення ладу в групах) — лише перелічені колонки контенту «Основного
  // каталогу» (за ключем), «Дія власника» / «Стан дії» в «Попередженнях постачальника» і «Журнал» (src/pipeline/owner-edits.mjs).
  "owner-edits": { "Основний каталог": { ops: ["updateRanges"], columns: ["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Характеристики JSON", "Фото JSON", "Виробник", "Попередження постачальника", "Запити UA", "Запити RU", "Група ID", "Група UA", "Група RU", "Категорія Prom ID", "Категорія Prom URL",
    // Рішення власника 14.11: ціни за конкурентами (src/core/pricing.mjs PRICE_RULE_COLUMNS).
    "Ціна вручну", "Ціна вручну: при ціні постачальника", "Надбавка"] },
    "Попередження постачальника": { ops: ["updateRanges"], columns: ["Дія власника", "Стан дії"] }, "Нові товари": { ops: ["updateRanges"], columns: ["Запити UA", "Запити RU", "Група ID", "Група UA", "Група RU", "Категорія Prom ID", "Категорія Prom URL", "Рішення"] }, "Журнал": { ops: ["appendRows"] } },
  // Рішення власника 04.11 (ProSale): разово — колонка «Тариф ProSale» у кінці «Основного каталогу», новий аркуш «Тарифи ProSale» і подія в «Журналі».
  // Рішення власника 14.11: разово — три колонки правила ціни в кінці «Основного каталогу» (порожні) і подія в «Журналі».
  "price-rule-columns": { "Основний каталог": { ops: ["ensureColumns", "updateRanges"], columns: ["Ціна вручну", "Ціна вручну: при ціні постачальника", "Надбавка"], header: true }, "Журнал": { ops: ["appendRows"] } },
  "prosale-columns": { "Основний каталог": { ops: ["ensureColumns", "updateRanges"], columns: ["Тариф ProSale"], header: true }, "Тарифи ProSale": { ops: ["ensureSheet", "appendRows", "updateRanges"], columns: "*", header: true }, "Журнал": { ops: ["appendRows"] } },
  // Рішення власника 04.11 (пізніше): «Тарифи ProSale» — лише категорії «за замовлення», «Тариф» за планом; основного каталогу — жодної операції.
  // Рішення власника 04.11: жовті рядки «Основного каталогу» з відкритим попередженням постачальника — лише правило умовного форматування.
  // Рішення власника 04.11: лише оформлення аркушів попереджень (без даних).
  "sheet-style": { "Попередження постачальника": { ops: ["formatColumns"] }, "Попередження — архів": { ops: ["formatColumns"] }, "Журнал": { ops: ["appendRows"] } },
  // 04.11 (виправлення): очищення зсунутих копій в архіві попереджень (лише значення, без видалення рядків).
  "warnings-archive-fix": { "Попередження — архів": { ops: ["updateRanges"], columns: "*" }, "Журнал": { ops: ["appendRows"] } },
  // Рішення власника 04.11: нова підгрупа — лише дописування рядка в «Групи».
  "group-add": { "Групи": { ops: ["appendRows"] }, "Журнал": { ops: ["appendRows"] } },
  "warnings-archive": { ...WARN_ARCHIVE, "Журнал": { ops: ["appendRows"] } },
  "row-highlight": { "Основний каталог": { ops: ["addRowHighlight"] }, "Журнал": { ops: ["appendRows"] } },
  // Рішення власника 11.11: «Нові товари» — сірі рядки «ВІДХИЛЕНО», жовті з позначкою в «Перевірці» (лише умовне форматування).
  "queue-highlight": { "Нові товари": { ops: ["addRowHighlight"] }, "Журнал": { ops: ["appendRows"] } },
  "prosale-tariffs": { "Тарифи ProSale": { ops: ["updateRanges"], columns: "*" }, "Журнал": { ops: ["appendRows"] } },
  // ENG-28c: QA погоджених товарів — лише системні / сирі колонки постачальника й печатка «Основного каталогу» (за ключем), паспорт,
  // «Журнал»; жодних SEO / описів / характеристик / рішень, нових колонок чи аркушів.
  qa: { "Основний каталог": { ops: ["updateRanges"], columns: ["Ціна постачальника", "Ціна", "Ціна кінцева", "Знижка", "Наявність", "Кількість постачальника", "Стан синхронізації", "Оновлено", "Назва постачальника UA", "Назва постачальника RU", "URL постачальника", "Фото JSON", "Модель", "Артикул постачальника", "SHA256 незмінних полів"] },
    "Паспорт каталогу": { ops: ["updateRanges"], columns: "*", header: true }, "Журнал": JOURNAL_KEYED },
  // ENG-28d: з'ясування невідомих результатів W2 (reconcile / рішення людини) — лише читання таблиці; жодної операції запису.
  reconcile: {},
  // ENG-28c: «Знайти нові товари» — лише черга «Нові товари» (колонки стереже контракт власності intake) і «Журнал»; основного каталогу —
  // жодної операції.
  // ENG-29 (Hermes F-28C-3): «Рішення» — лише очищення (споживання команди власника), жодного запису значення (автозатвердження неможливе).
  "find-new": { "Нові товари": { ops: ["ensureColumns", "updateRanges", "appendRows", "setPercentFormat"], columns: "*", header: true, clearOnly: ["Рішення"] }, "Журнал": { ops: ["appendRows"] } },
  // ENG-29: «Перенести затверджені» — «Основний каталог»: лише дописування нових карток (за ключем, без зміни наявних рядків і колонок);
  // «Нові товари»: лише «Перевірка» (причини «НЕ ПЕРЕНЕСЕНО») і прибирання перенесених рядків (deleteByKeys зі знімком; appendRows — лише
  // повернення чужого рядка зі знімка, якщо видалення лягло не туди); паспорт; «Журнал».
  // 11.11 (рішення власника): «ВІДХИЛЕНО» — лише дописування Offer ID у «Заморожені ID».
  transfer: { "Основний каталог": { ops: ["appendRows"] },
    "Нові товари": { ops: ["updateRanges", "deleteRows", "appendRows"], columns: ["Перевірка"], deleteRows: true },
    "Заморожені ID": { ops: ["appendRows"] },
    "Паспорт каталогу": { ops: ["ensureSheet", "updateRanges"], columns: "*", header: true }, "Журнал": JOURNAL_KEYED },
  // ENG-29 (рішення власника 03.11): розбір «Відкладених товарів» — повернення в «Основний каталог» (лише дописування нових карток),
  // відсутні у фіді — у «Видалені товари» (створення аркуша й дописування), прибирання перенесених із «Відкладених» (за ключем зі знімком;
  // appendRows — лише повернення чужого рядка зі знімка), паспорт, «Журнал».
  // ENG-29 (рішення власника 03.11): прибрати порожню вкладку «Відкладені товари» — лише видалення саме цього аркуша й «Журнал».
  "drop-deferred": { "Відкладені товари": { ops: ["deleteSheet"], deleteSheet: true }, "Журнал": { ops: ["appendRows"] } },
  deferred: { "Основний каталог": { ops: ["appendRows"] }, "Видалені товари": { ops: ["ensureSheet", "appendRows"] },
    "Відкладені товари": { ops: ["deleteRows", "appendRows"], deleteRows: true },
    "Паспорт каталогу": { ops: ["ensureSheet", "updateRanges"], columns: "*", header: true }, "Журнал": JOURNAL_KEYED },
});
