/** Мінімальний читач .xlsx без залежностей (zip + SpreadsheetML), лише для локального аналізу експортів.
 *  Типи клітинок: s/str/inlineStr → рядок, b → boolean, n (без t) → число, e → рядок помилки.
 *  Дати не перетворюються (лишаються числом-серійником) — у незмінних колонках каталогу дат немає. */
import fs from "node:fs";
import zlib from "node:zlib";

export function readZip(file) {
  const buf = fs.readFileSync(file);
  // End of central directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Не zip-файл");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Пошкоджений central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lh = e.local;
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.subarray(start, start + e.csize);
      return (e.method === 0 ? data : zlib.inflateRawSync(data)).toString("utf8");
    },
  };
}

const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, k) => {
  if (k[0] === "#") return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : Number(k.slice(1)));
  return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k];
});
/** Текст із <t> (у т.ч. rich text <r><t>) з урахуванням xml:space. */
const texts = (xml) => {
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1] ? decode(m[1]) : "";
  return out;
};

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** { sheets: [{name, values: 2D}] } — values як getValues(): прямокутні, порожні клітинки = ''. */
export function readXlsx(file, { only } = {}) {
  const zip = readZip(file);
  const shared = [];
  const sst = zip.read("xl/sharedStrings.xml");
  if (sst) {
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(sst))) shared.push(texts(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")));
  }
  const wb = zip.read("xl/workbook.xml");
  const rels = zip.read("xl/_rels/workbook.xml.rels");
  const target = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])[1];
    const t = /Target="([^"]+)"/.exec(m[0])[1];
    target[id] = t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, "");
  }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(/name="([^"]*)"/.exec(m[0])[1]);
    const rid = /r:id="([^"]+)"/.exec(m[0])[1];
    if (only && !only.includes(name)) { sheets.push({ name, values: null }); continue; }
    const xml = zip.read(target[rid]);
    const rows = [];
    let width = 0;
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const attrs = rm[1] ?? rm[3];
      const r = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? rows.length + 1) - 1;
      const row = [];
      if (rm[2]) {
        for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ca = cm[1];
          const ref = /\br="([A-Z]+\d+)"/.exec(ca)?.[1];
          const ci = ref ? colIndex(ref) : row.length;
          const t = /\bt="([^"]+)"/.exec(ca)?.[1] || "n";
          const body = cm[2] || "";
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          let value = "";
          if (t === "s") value = v == null ? "" : shared[Number(v)];
          else if (t === "inlineStr") value = texts(body);
          else if (t === "str") value = v == null ? "" : decode(v);
          else if (t === "b") value = v === "1";
          else if (t === "e") value = v == null ? "" : decode(v);
          else value = v == null || v === "" ? "" : Number(v);
          row[ci] = value;
        }
      }
      rows[r] = row;
      width = Math.max(width, row.length);
    }
    // Як getDataRange(): обрізати хвіст порожніх рядків, вирівняти ширину.
    let last = rows.length - 1;
    while (last >= 0 && !(rows[last] || []).some((v) => v !== "" && v != null)) last--;
    const values = [];
    for (let i = 0; i <= last; i++) {
      const src = rows[i] || [];
      values.push(Array.from({ length: width }, (_, j) => (src[j] == null ? "" : src[j])));
    }
    // Обрізати порожні колонки праворуч (за заголовком та даними).
    let w = width;
    while (w > 0 && values.every((r) => r[w - 1] === "")) w--;
    sheets.push({ name, values: values.map((r) => r.slice(0, w)) });
  }
  return { sheets };
}
