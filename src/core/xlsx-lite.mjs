/** Мінімальний читач xlsx без залежностей (лише Node: zlib) — для «Excel (розширений)» Хорошопу постачальника (гібрид, рішення
 *  власника 16.11.2026). Читає один аркуш і лише потрібні колонки: zip (центральний каталог) → xl/sharedStrings.xml + аркуш.
 *  Спільні рядки розбираються ПІСЛЯ аркуша і лише ті, на які посилаються потрібні клітинки (описи товарів у пам'яті не тримаються). */
import zlib from "node:zlib";

const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

/** → Map<ім'я, Buffer> для запитаних файлів архіву. */
export function readZipEntries(buf, wanted) {
  const want = new Set(wanted);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error("xlsx: не zip (немає кінця центрального каталогу)");
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== SIG_CEN) throw new Error("xlsx: зіпсований центральний каталог");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (want.has(name)) {
      if (buf.readUInt32LE(local) !== SIG_LOC) throw new Error("xlsx: зіпсований локальний заголовок " + name);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      out.set(name, method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : (() => { throw new Error("xlsx: невідомий метод стиснення " + method); })());
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k === "amp") return "&"; if (k === "lt") return "<"; if (k === "gt") return ">"; if (k === "quot") return '"'; if (k === "apos") return "'";
  return String.fromCodePoint(k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});
const textOf = (xml) => { let s = ""; for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1]; return decode(s); };
const colIndex = (ref) => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; };

/**
 * Перший аркуш книги, лише колонки з назвами `columns` (заголовок — перший рядок).
 * → { header: [усі назви колонок], columns: { назва: індекс }, rows: [[значення лише потрібних колонок у порядку columns]] , missing: [назви] }
 */
export function readXlsxColumns(buf, columns) {
  const files = readZipEntries(buf, ["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"]);
  const sheet = files.get("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("xlsx: немає першого аркуша");
  const xml = sheet.toString("utf8");
  const cells = []; // [rowIndex, wantedPos, kind, raw]
  let header = null, pos = null, rowNo = -1;
  const needStr = new Set();
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    rowNo++;
    const rowCells = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] || "";
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "n";
      const v = t === "inlineStr" ? textOf(body) : decode((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || "");
      rowCells.push([ref ? colIndex(ref) : rowCells.length, t, v]);
    }
    if (!header) {
      const width = Math.max(0, ...rowCells.map((x) => x[0] + 1));
      header = Array(width).fill("");
      for (const [i, t, v] of rowCells) header[i] = t; // тимчасово тип; значення — нижче (спільні рядки ще не прочитано)
      header = { raw: rowCells };
      continue;
    }
    for (const [i, t, v] of rowCells) { cells.push([rowNo, i, t, v]); if (t === "s") needStr.add(Number(v)); }
  }
  // Заголовок: його спільні рядки — теж потрібні.
  for (const [, t, v] of header.raw) if (t === "s") needStr.add(Number(v));
  const shared = new Map();
  const ss = files.get("xl/sharedStrings.xml");
  if (ss && needStr.size) {
    let idx = -1;
    const sx = ss.toString("utf8");
    for (const m of sx.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) { idx++; if (needStr.has(idx)) shared.set(idx, m[1] ? textOf(m[1]) : ""); }
  }
  const val = (t, v) => (t === "s" ? shared.get(Number(v)) ?? "" : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : v);
  const width = Math.max(0, ...header.raw.map((x) => x[0] + 1));
  const names = Array(width).fill("");
  for (const [i, t, v] of header.raw) names[i] = String(val(t, v)).trim();
  pos = Object.fromEntries(columns.map((c) => [c, names.indexOf(c)]));
  const missing = columns.filter((c) => pos[c] < 0);
  const wantedIdx = new Map(columns.map((c, k) => [pos[c], k]).filter(([i]) => i >= 0));
  const rows = new Map();
  for (const [rn, i, t, v] of cells) {
    const k = wantedIdx.get(i);
    if (k == null) continue;
    if (!rows.has(rn)) rows.set(rn, Array(columns.length).fill(""));
    rows.get(rn)[k] = val(t, v);
  }
  return { header: names, columns: pos, rows: [...rows.keys()].sort((a, b) => a - b).map((k) => rows.get(k)), missing };
}
