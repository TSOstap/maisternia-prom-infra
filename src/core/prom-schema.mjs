/** Схеми характеристик категорій Prom (XML, який власник завантажує з кабінету Prom; погоджено 23.10.2026).
 *  Формат: <category id nameUK nameRU><attribute id nameUK nameRU type measureUnitUK measureUnitRU min max>
 *          <attribute_value id nameUK nameRU/>…</attribute></category>.
 *  Належність атрибутів — лише за <category id> блоку, у межах якого вони записані (не за порядком файлів).
 *  Чисті функції: розбір і перевірка структури. Читання файлів і MANIFEST — src/pipeline/prom-schemas.mjs.
 *
 *  problems — блокують усю категорію (неможливо однозначно визначити схему): немає id, обірваний фрагмент, повторений id атрибута.
 *  warnings — атрибут виключено (ніколи не заповнюється) або значення розібрано з виправленням лапок; решта схеми придатна. */
import { mtDecode } from "./text.mjs";

export const ATTRIBUTE_TYPES = Object.freeze(["real", "integer", "bool", "singleselect", "multiselect", "free"]);

/** Значення атрибута XML. Неекрановані лапки всередині (копія з вигляду браузера: `"Квадрат 1""`) — значення триває
 *  до лапки, за якою йде наступний атрибут або кінець тегу; такі випадки повертаються з quoted=true. */
function attrOf(s, n) {
  const m = new RegExp(`\\b${n}\\s*=\\s*"([\\s\\S]*?)"(?=\\s+[A-Za-z_][\\w-]*\\s*=|\\s*\\/?\\s*$)`).exec(s);
  if (!m) return { v: "", quoted: false };
  return { v: mtDecode(m[1]).trim(), quoted: m[1].includes('"') };
}
const num = (s) => (s === "" ? null : Number(s));

/** Елементи <category>…</category> або порожні <category …/> з тексту (у файлі можуть бути зайві рядки, напр. текст браузера).
 *  Порожній самозакритий тег — окрема категорія без атрибутів (не «поглинає» наступну категорію). */
export function categoryBlocks(text) {
  return [...String(text).matchAll(/<category\b(?:[^>]*?\/>|[^>]*>[\s\S]*?<\/category>)/g)].map((m) => m[0]);
}

/** Один <category> → схема (лише придатні атрибути) + problems / warnings. */
export function parseCategory(block) {
  const head = /^<category\b([^>]*?)\/?>/.exec(block);
  const problems = [], warnings = [];
  const h = (n) => (head ? attrOf(head[1], n).v : "");
  const schema = { id: h("id"), nameUK: h("nameUK"), nameRU: h("nameRU"), attributes: [], excluded: [] };
  if (!/^\d+$/.test(schema.id)) problems.push("немає числового id категорії");
  const seen = new Map();
  for (const a of block.matchAll(/<attribute\b([^>]*?)(?:\/>|>([\s\S]*?)<\/attribute>)/g)) {
    const g = (n) => attrOf(a[1], n);
    const at = {
      id: g("id").v, nameUK: g("nameUK").v, nameRU: g("nameRU").v, type: g("type").v,
      unitUK: g("measureUnitUK").v, unitRU: g("measureUnitRU").v, min: num(g("min").v), max: num(g("max").v),
      values: [],
    };
    const where = `атрибут ${at.id || "?"} «${at.nameUK || at.nameRU}»`;
    const bad = [];
    if (g("nameUK").quoted || g("nameRU").quoted) warnings.push(`${where}: неекрановані лапки в назві — розібрано до межі атрибута`);
    for (const v of (a[2] || "").matchAll(/<attribute_value\b([^>]*?)\/?>/g)) {
      const vu = attrOf(v[1], "nameUK"), vr = attrOf(v[1], "nameRU");
      if (vu.quoted || vr.quoted) warnings.push(`${where}: неекрановані лапки у значенні «${vr.v || vu.v}» — розібрано до межі атрибута`);
      at.values.push({ id: attrOf(v[1], "id").v, nameUK: vu.v, nameRU: vr.v });
    }
    if (!/^\d+$/.test(at.id)) bad.push("немає числового id");
    else if (seen.has(at.id)) { problems.push(`${where}: повторений id атрибута в категорії`); continue; }
    if (!at.nameUK && !at.nameRU) bad.push("немає назви");
    if (!ATTRIBUTE_TYPES.includes(at.type)) bad.push(`невідомий тип «${at.type}»`);
    if ((at.min !== null && !Number.isFinite(at.min)) || (at.max !== null && !Number.isFinite(at.max))) bad.push("некоректні min/max");
    else if (at.min !== null && at.max !== null && at.min > at.max) bad.push(`min ${at.min} > max ${at.max}`);
    if (/select$/.test(at.type)) {
      if (!at.values.length) bad.push("немає варіантів значень");
      const vids = new Set();
      for (const v of at.values) {
        if (!/^\d+$/.test(v.id) || vids.has(v.id)) bad.push(`некоректний або повторений id значення ${v.id}`);
        vids.add(v.id);
        if (!v.nameUK && !v.nameRU) bad.push(`значення ${v.id} без назви`);
      }
    }
    if (/^\d+$/.test(at.id)) seen.set(at.id, true);
    if (bad.length) { schema.excluded.push({ id: at.id, name: at.nameUK || at.nameRU, reasons: bad }); warnings.push(`${where}: виключено (${bad.join("; ")}) — не заповнюється`); continue; }
    schema.attributes.push(at);
  }
  // Категорія без атрибутів (напр. «…, загальне») — коректна: полів Prom для неї немає, нічого не зіставляється.
  schema.empty = !schema.attributes.length && !schema.excluded.length;
  if (!schema.attributes.length && /<attribute\b/.test(block) && !schema.excluded.length) problems.push("атрибути не розібрано");
  return { schema, problems, warnings };
}

/** Текст файлу → [{ schema, problems, warnings, block }]. Обірвана категорія (немає </category>) — окремий запис із problems. */
export function parseSchemaText(text) {
  const t = String(text);
  const spans = [...t.matchAll(/<category\b(?:[^>]*?\/>|[^>]*>[\s\S]*?<\/category>)/g)].map((m) => [m.index, m.index + m[0].length, m[0]]);
  const out = spans.map(([, , block]) => ({ ...parseCategory(block), block }));
  for (const m of t.matchAll(/<category\b([^>]*)>/g)) {
    if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const id = attrOf(m[1].replace(/\/$/, ""), "id").v;
    out.push({ schema: { id, nameUK: attrOf(m[1], "nameUK").v, nameRU: attrOf(m[1], "nameRU").v, attributes: [], excluded: [] }, problems: ["неповна категорія: немає закриваючого </category> (фрагмент обірвано)"], warnings: [], block: "" });
  }
  return out;
}
