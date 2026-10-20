/** Час у Europe/Kyiv без зовнішніх бібліотек (Intl). Замінює Utilities.formatDate/parseDate. */

function parts(epochMs, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const out = {};
  for (const p of fmt.formatToParts(new Date(epochMs))) if (p.type !== "literal") out[p.type] = p.value;
  return out;
}

/** 'yyyy-MM-dd HH:mm' у вказаному поясі — формат атрибута date у YML. */
export function formatYmlDate(epochMs, timeZone) {
  const p = parts(epochMs, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function offsetMs(epochMs, timeZone) {
  const p = parts(epochMs, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Розбір 'yyyy-MM-dd HH:mm' як місцевого часу поясу → epoch ms; NaN, якщо формат інший.
 * Примітка: Code.gs у Node-гілці використовує фіксований +03:00 (взимку Київ +02:00);
 * у Google — Utilities.parseDate з правильним поясом. Тут — правильний пояс, як у Google.
 */
export function parseZonedDate(text, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text || "").trim());
  if (!m) return NaN;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  let guess = naive - offsetMs(naive, timeZone);
  guess = naive - offsetMs(guess, timeZone);
  return guess;
}
