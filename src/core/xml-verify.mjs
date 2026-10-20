/** Незалежна потокова перевірка готового YML (замість XmlService.parse у mtAssertOwnXml_).
 *  Не використовує код генератора: окремий токенізатор XML перевіряє коректність документа,
 *  рахує offer у yml_catalog/shop/offers, звіряє набір ID і рахує SHA-256 фактичних байтів. */
import crypto from "node:crypto";
import { idsSha } from "./seal.mjs";

const NAME = /^[A-Za-z_][A-Za-z0-9._:-]*$/;
const BAD_CHAR = /[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/u;
const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

function decodeAttr(v) {
  return v.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, k) => {
    if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : Number(k.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k];
  });
}

function parseAttrs(src) {
  const attrs = Object.create(null);
  const re = /\s+([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error("XML: невалідні атрибути");
    const name = m[1];
    const raw = m[3] ?? m[4];
    if (!NAME.test(name) || name in attrs) throw new Error("XML: невалідний або повторений атрибут " + name);
    if (raw.includes("<") || ENTITY.test(raw)) throw new Error("XML: невалідне значення атрибута " + name);
    attrs[name] = decodeAttr(raw);
    pos = re.lastIndex;
  }
  return attrs;
}

/** Кінець тегу з урахуванням лапок (у значеннях атрибутів дозволений '>'). -1 — потрібні ще дані. */
function tagEnd(buf, from) {
  let quote = null;
  for (let i = from; i < buf.length; i++) {
    const c = buf[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/**
 * chunks — async iterable рядків (UTF-8 вже декодовано) або Buffer.
 * expected — { count, idsSha } (необов'язково). Повертає { count, idsSha, bytes, sha256 }.
 */
export async function verifyYmlStream(chunks, expected = {}) {
  const hash = crypto.createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let buf = "";
  const stack = [];
  let rootSeen = false;
  let rootClosed = false;
  let atStart = true;
  const ids = [];
  const seen = new Set();

  const text = (t) => {
    if (!t) return;
    if (BAD_CHAR.test(t)) throw new Error("XML: заборонений символ");
    if (!stack.length) {
      if (t.trim()) throw new Error("XML: текст поза кореневим елементом");
      return;
    }
    if (t.includes("]]>") || ENTITY.test(t)) throw new Error("XML: невалідний текст або сутність");
  };

  const step = (final) => {
    for (;;) {
      const lt = buf.indexOf("<");
      if (lt < 0) {
        if (final) { text(buf); buf = ""; return; }
        // текст без '<' — перевіряємо, лишаючи хвіст на випадок розірваної сутності
        const keep = buf.lastIndexOf("&");
        const cut = keep >= 0 && buf.length - keep < 12 ? keep : buf.length;
        text(buf.slice(0, cut)); buf = buf.slice(cut);
        return;
      }
      if (lt > 0) { text(buf.slice(0, lt)); buf = buf.slice(lt); atStart = false; }
      // buf починається з '<'
      if (buf.startsWith("<!--")) {
        const end = buf.indexOf("-->", 4);
        if (end < 0) { if (final) throw new Error("XML: незакритий коментар"); return; }
        buf = buf.slice(end + 3); atStart = false; continue;
      }
      if (buf.startsWith("<![CDATA[")) {
        const end = buf.indexOf("]]>", 9);
        if (end < 0) { if (final) throw new Error("XML: незакритий CDATA"); return; }
        if (!stack.length) throw new Error("XML: CDATA поза кореневим елементом");
        if (BAD_CHAR.test(buf.slice(9, end))) throw new Error("XML: заборонений символ у CDATA");
        buf = buf.slice(end + 3); continue;
      }
      if (buf.startsWith("<?")) {
        const end = buf.indexOf("?>", 2);
        if (end < 0) { if (final) throw new Error("XML: незакрита інструкція"); return; }
        const pi = buf.slice(2, end);
        if (/^xml\b/i.test(pi) && !atStart) throw new Error("XML: декларація не на початку");
        buf = buf.slice(end + 2); atStart = false; continue;
      }
      if (buf.startsWith("<!")) {
        if (buf.length < 9 && !final) return;
        throw new Error("XML: DOCTYPE/сутності не дозволені у власному YML");
      }
      const end = tagEnd(buf, 1);
      if (end < 0) { if (final) throw new Error("XML: незакритий тег"); return; }
      const tag = buf.slice(1, end);
      buf = buf.slice(end + 1);
      atStart = false;
      if (BAD_CHAR.test(tag)) throw new Error("XML: заборонений символ у тегу");
      if (tag.startsWith("/")) {
        const name = tag.slice(1).trim();
        if (stack.pop() !== name) throw new Error("XML: невідповідний закриваючий тег " + name);
        if (!stack.length) rootClosed = true;
        continue;
      }
      const selfClose = tag.endsWith("/");
      const inner = selfClose ? tag.slice(0, -1) : tag;
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(inner);
      if (!m || !NAME.test(m[1])) throw new Error("XML: невалідна назва тегу");
      const name = m[1];
      const attrs = parseAttrs(m[2]);
      if (!stack.length) {
        if (rootSeen) throw new Error("XML: більше одного кореневого елемента");
        rootSeen = true;
        if (name !== "yml_catalog") throw new Error("XML: корінь не yml_catalog");
      }
      if (name === "offer" && stack.length === 3 && stack[0] === "yml_catalog" && stack[1] === "shop" && stack[2] === "offers") {
        const id = attrs.id ?? "";
        if (!/^\d+$/.test(id) || seen.has(id)) throw new Error("XML: невалідний або повторений ID offer");
        seen.add(id); ids.push(id);
      }
      if (!selfClose) stack.push(name);
      else if (!stack.length) rootClosed = true;
    }
  };

  for await (const chunk of chunks) {
    const t = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (typeof chunk === "string") { bytes += Buffer.byteLength(chunk, "utf8"); hash.update(chunk, "utf8"); }
    else { bytes += chunk.length; hash.update(chunk); }
    buf += t;
    step(false);
  }
  buf += decoder.decode();
  step(true);
  if (!rootSeen || !rootClosed || stack.length) throw new Error("XML: документ неповний");
  const result = { count: ids.length, idsSha: idsSha(ids), bytes, sha256: hash.digest("hex") };
  if (expected.count != null && result.count !== expected.count) throw new Error("XML readback: неправильна кількість offer");
  if (expected.idsSha && result.idsSha !== expected.idsSha) throw new Error("XML readback: неправильне покриття ID");
  if (expected.sha256 && result.sha256 !== expected.sha256) throw new Error("XML readback: SHA-256 не збігається");
  if (expected.bytes != null && result.bytes !== expected.bytes) throw new Error("XML readback: розмір не збігається");
  return result;
}
