/** Моніторинг запасу до ліміту чинної системи: Apps Script не публікує YML понад MTY.maximumYmlBytes = 50 000 000 Б
 *  (Yml.LIVE-CURRENT.gs). Нова система лише ПОПЕРЕДЖАЄ — сам ліміт і чинну публікацію не змінює (погоджено 22.10.2026). */
export const LIVE_LIMIT_BYTES = 50_000_000;
export const WARN_SHARE = 0.95;     // попередження: ≥95% ліміту
export const CRITICAL_SHARE = 0.99; // критично: ≥99% — одне-два оновлення контенту можуть зупинити чинну публікацію

export function liveLimitStatus(bytes, { limit = LIVE_LIMIT_BYTES, warn = WARN_SHARE, critical = CRITICAL_SHARE } = {}) {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error("невалідний розмір YML");
  const share = bytes / limit;
  const headroomBytes = limit - bytes;
  const level = bytes > limit ? "OVER" : share >= critical ? "CRITICAL" : share >= warn ? "WARNING" : "OK";
  const pct = (share * 100).toFixed(1);
  const message = {
    OK: `YML ${pct}% ліміту чинної системи (50 МБ), запас ${headroomBytes} Б`,
    WARNING: `УВАГА: YML ${pct}% ліміту чинної системи (50 МБ), запас лише ${headroomBytes} Б — потрібне рішення щодо транспорту до досягнення ліміту`,
    CRITICAL: `КРИТИЧНО: YML ${pct}% ліміту чинної системи (50 МБ), запас ${headroomBytes} Б — Apps Script незабаром зупинить публікацію`,
    OVER: `ПЕРЕВИЩЕНО: YML ${pct}% ліміту чинної системи (50 МБ) — Apps Script не опублікує цей YML`,
  }[level];
  return { bytes, limit, share: +share.toFixed(4), headroomBytes, level, message };
}
