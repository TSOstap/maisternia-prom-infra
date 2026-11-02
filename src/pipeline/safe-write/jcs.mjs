/** ENG-23 (узгоджений контракт F04 / F06 / F08, розд. 2): канонічний JSON (RFC 8785 / JCS) і хеш sha256 у hex, UTF-8.
 *  Хеші скрізь обчислює лише Engineering (квиток, head W2, дзеркало реєстру).
 *  JCS для значень JSON: ключі об'єктів — за кодовими одиницями UTF-16 (стандартне сортування рядків JS), без пробілів; рядки й
 *  числа — як JSON.stringify (ES2015+, який і бере за основу RFC 8785); undefined у об'єктах пропускається (як у JSON). */
import crypto from "node:crypto";

export function jcs(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("JCS: нескінченне число або NaN не є JSON");
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("JCS: значення не є JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined || typeof v === "function" ? "null" : jcs(v))).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined && typeof value[k] !== "function").sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcs(value[k])).join(",") + "}";
}
export const sha256Hex = (text) => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
/** sha256(JCS(value)) у hex. */
export const jcsHash = (value) => sha256Hex(jcs(value));
