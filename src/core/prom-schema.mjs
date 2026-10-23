/** Схеми характеристик категорій Prom (XML, який власник завантажує з кабінету Prom; погоджено 23.10.2026).
 *  Формат: <category id nameUK nameRU><attribute id nameUK nameRU type measureUnitUK measureUnitRU min max>
 *          <attribute_value id nameUK nameRU/>…</attribute></category>.
 *  Чисті функції: розбір і перевірка структури. Читання файлів і MANIFEST — src/pipeline/prom-schemas.mjs. */
import { mtDecode } from "./text.mjs";

export const ATTRIBUTE_TYPES = Object.freeze(["real", "integer", "bool", "singleselect", "multiselect", "free"]);

const attr = (s, n) => { const m = new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`).exec(s); return m ? mtDecode(m[1]).trim() : ""; };
const num = (s) => (s === "" ? null : Number(s));

/** Елементи <category>…</category> або порожні <category …/> з тексту (у файлі можуть бути зайві рядки, напр. текст браузера).
 *  Порожній самозакритий тег — окрема категорія без атрибутів (не «поглинає» наступну категорію). */
export function categoryBlocks(text) {
  return [...String(text).matchAll(/<category\b(?:[^>]*?\/>|[^>]*>[\s\S]*?<\/category>)/g)].map((m) => m[0]);
}

/** Один <category> → схема. Помилки структури — у problems (схема з помилками не використовується). */
export function parseCategory(block) {
  const head = /^<category\b([^>]*)>/.exec(block);
  const problems = [];
  const schema = { id: head ? attr(head[1], "id") : "", nameUK: head ? attr(head[1], "nameUK") : "", nameRU: head ? attr(head[1], "nameRU") : "", attributes: [] };
  if (!/^\d+$/.test(schema.id)) problems.push("немає числового id категорії");
  const seen = new Set();
  for (const a of block.matchAll(/<attribute\b([^>]*?)(?:\/>|>([\s\S]*?)<\/attribute>)/g)) {
    const at = {
      id: attr(a[1], "id"), nameUK: attr(a[1], "nameUK"), nameRU: attr(a[1], "nameRU"), type: attr(a[1], "type"),
      unitUK: attr(a[1], "measureUnitUK"), unitRU: attr(a[1], "measureUnitRU"), min: num(attr(a[1], "min")), max: num(attr(a[1], "max")),
      values: [...(a[2] || "").matchAll(/<attribute_value\b([^>]*?)\/?>/g)].map((v) => ({ id: attr(v[1], "id"), nameUK: attr(v[1], "nameUK"), nameRU: attr(v[1], "nameRU") })),
    };
    const where = `атрибут ${at.id || "?"} «${at.nameUK || at.nameRU}»`;
    if (!/^\d+$/.test(at.id)) problems.push(`${where}: немає числового id`);
    else if (seen.has(at.id)) problems.push(`${where}: повторений id`);
    seen.add(at.id);
    if (!at.nameUK && !at.nameRU) problems.push(`${where}: немає назви`);
    if (!ATTRIBUTE_TYPES.includes(at.type)) problems.push(`${where}: невідомий тип «${at.type}»`);
    if ((at.min !== null && !Number.isFinite(at.min)) || (at.max !== null && !Number.isFinite(at.max))) problems.push(`${where}: некоректні min/max`);
    else if (at.min !== null && at.max !== null && at.min > at.max) problems.push(`${where}: min > max`);
    if (/select$/.test(at.type)) {
      if (!at.values.length) problems.push(`${where}: немає варіантів значень`);
      const vids = new Set();
      for (const v of at.values) {
        if (!/^\d+$/.test(v.id) || vids.has(v.id)) problems.push(`${where}: некоректний або повторений id значення ${v.id}`);
        vids.add(v.id);
        if (!v.nameUK && !v.nameRU) problems.push(`${where}: значення ${v.id} без назви`);
      }
    }
    schema.attributes.push(at);
  }
  // Категорія без атрибутів (напр. «…, загальне») — коректна: полів Prom для неї немає, нічого не зіставляється.
  schema.empty = !schema.attributes.length;
  if (schema.empty && /<attribute\b/.test(block)) problems.push("атрибути не розібрано");
  return { schema, problems };
}

/** Текст файлу → [{ schema, problems, block }]. */
export function parseSchemaText(text) {
  return categoryBlocks(text).map((block) => ({ ...parseCategory(block), block }));
}
