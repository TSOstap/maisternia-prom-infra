/** Аудит одиниць схем категорій Prom (власник, 24.10.2026, після «50 GHz» у GTM ZJ5132): чи відповідає одиниця атрибута
 *  фізичній величині, яку означає його назва. Лише звіт — генератор нічого не блокує за цим аудитом: поле не заповнюється
 *  тільки за погодженим записом known-issues.json або за суперечністю одиниць різного масштабу в даних товару.
 *
 *  Знахідки:
 *   «інша величина»     — одиниця іншої величини, ніж у назві («Потужність» у «кг»);
 *   «масштаб частоти»   — «Частота» / «Частота струму» / «Частота мережі» (електромережа, Гц) в кГц / МГц / ГГц;
 *   «відома вада»       — уже в known-issues.json (з рішенням). */
import { mtText } from "./text.mjs";
import { nameUnit, normName, normUnit } from "./prom-attributes.mjs";

// Величина за назвою атрибута (перше збігле правило; «частота обертання / ударів / руху» — не частота мережі).
const BY_NAME = [
  [/частот[аи] (обертан|оберт|удар|руху|ход|коливан|пил|хід)|кількість (оберт|удар|ход)/, null],
  [/^частота( струму| мережі| живлення)?$|^частота,/, "частота"],
  [/ємність (акумулятор|батаре)/, "ємність акумулятора"],
  [/потужніст/, "потужність"],
  [/напруг/, "напруга"],
  [/(^|\s)струм|сила струму/, "струм"],
  [/(^|\s)(вага|маса)(\s|,|$)/, "маса"],
  [/довжин|ширин|висот|глибин|діаметр|товщин|відстан|радіус|розмір|хід штока|висота підйому/, "довжина"],
  [/об'єм|місткість|ємність (бак|резервуар|баку|контейнер)/, "об'єм"],
  [/тиск/, "тиск"],
];
export const expectedDim = (name) => { const n = normName(mtText(name)).replace(/[’ʼ`´]/g, "'"); for (const [re, d] of BY_NAME) if (re.test(n)) return d; return null; };

/** Знахідки для всіх схем: [{ category, categoryName, id, name, unit, dim, expected, finding, known }]. */
export function auditSchemaUnits(schemas, units, knownIssues = []) {
  const out = [];
  const scale = (u) => units?.scale?.get(normUnit(u)) || units?.scale?.get(units?.aliasMap?.get(normUnit(u))) || null;
  for (const s of schemas) for (const a of s.attributes || []) {
    const unit = a.unitUK || a.unitRU || nameUnit(a);
    if (!unit) continue;
    const sc = scale(unit), exp = expectedDim(a.nameUK || a.nameRU);
    const known = knownIssues.some((k) => String(k.id) === String(a.id) && (k.categories || []).map(String).includes(String(s.id)));
    let finding = "";
    if (exp && sc && sc.dim !== exp) finding = "інша величина";
    else if (exp === "частота" && sc && sc.f >= 1e3) finding = "масштаб частоти";
    if (!finding) continue;
    out.push({ category: String(s.id), categoryName: s.nameUK || "", id: String(a.id), name: a.nameUK || a.nameRU, unit, dim: sc?.dim || "", expected: exp, finding, known });
  }
  return out;
}
