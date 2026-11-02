/** E1 (ENG-01 K1): три стани результату запису в Google Sheets.
 *
 *  APPLIED      — запит підтверджено (2xx): зміни застосовано.
 *  NOT_APPLIED  — запит гарантовано не застосовано: відмова до відправлення (межа запитів, застаріла оренда, перевірка аргументів),
 *                 4xx-відповідь (запит не пройшов валідацію: «If any request is not valid then the entire update is unsuccessful»,
 *                 офіційна сторінка Usage limits) або 429 (квота: «additional requests exceed the quota and generates a 429»).
 *  UNKNOWN      — результат невідомий: тайм-аут, мережа, 5xx, втрачена відповідь. Запит МІГ застосуватися — сліпий повтор
 *                 неідемпотентної операції заборонено; результат з'ясовується читанням за стабільним ключем (reconcile).
 *
 *  Невідома помилка (не WriteOutcomeError) теж трактується як UNKNOWN — консервативно. */
export const OUTCOME = Object.freeze({ APPLIED: "APPLIED", NOT_APPLIED: "NOT_APPLIED", UNKNOWN: "UNKNOWN" });

export class WriteOutcomeError extends Error {
  /** @param {string} message
   *  @param {{ outcome: string, op?: string, status?: number|null, code?: string, appliedParts?: number, totalParts?: number, cause?: unknown }} o */
  constructor(message, { outcome, op = "", status = null, code = "", appliedParts = 0, totalParts = 1, cause } = {}) {
    super(message);
    this.name = "WriteOutcomeError";
    this.outcome = outcome;
    this.op = op;
    this.status = status;
    this.code = code;
    this.appliedParts = appliedParts; // скільки частин (запитів) багатозапитної операції вже підтверджено до збою
    this.totalParts = totalParts;
    if (cause) this.cause = cause;
  }
}

/** Результат помилки: явний стан або UNKNOWN (невідома помилка не доводить, що запит не застосовано). */
export const outcomeOf = (e) => (e && Object.values(OUTCOME).includes(e.outcome) ? e.outcome : OUTCOME.UNKNOWN);
/** Частково виконана багатозапитна операція: частина запитів підтверджена, решта — ні або невідомо. */
export const isPartial = (e) => Boolean(e && e.appliedParts > 0 && e.appliedParts < e.totalParts);
