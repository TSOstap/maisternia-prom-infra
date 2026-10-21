/** Текстові примітиви — точні порти з Code.LIVE-CURRENT.gs (mtText, mtKey, mtSku, mtDecode, mtTag, mtAttr, mtSafeCell). */
import crypto from "node:crypto";

export function mtText(v) {
  return String(v == null ? "" : v);
}

/** Порівняння опорних назв: NFKC, нижній регістр, стиснуті пробіли. */
export function mtKey(v) {
  return mtText(v).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Артикул: частини через кому, обрізані, без порожніх, відсортовані. */
export function mtSku(v) {
  return mtText(v).split(",").map((x) => x.trim()).filter(Boolean).sort().join(",");
}

export function mtDecode(v) {
  return mtText(v)
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (all, key) => {
      if (key[0] === "#") {
        return String.fromCodePoint(key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1)));
      }
      return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[key.toLowerCase()] || all;
    });
}

export function mtTag(body, name) {
  const m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">").exec(body);
  return m ? mtDecode(m[1]).trim() : "";
}

export function mtAttr(attrs, name) {
  const m = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1").exec(attrs);
  return m ? mtDecode(m[2]) : "";
}

/** Захист від формул при записі в таблицю/журнал. */
export function mtSafeCell(v) {
  return typeof v === "string" && /^[=+@-]/.test(v) ? "'" + v : v;
}

/** SHA-256 hex від UTF-8 — еквівалент mtSha_ (Utilities.computeDigest). */
export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Секретні адреси ніколи не потрапляють у журнали/звіти. */
export function sanitize(error) {
  return mtText((error && error.message) || error).replace(/https?:\/\/\S+/gi, "[адресу приховано]").slice(0, 1500);
}
