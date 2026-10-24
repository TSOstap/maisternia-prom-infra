/** Застарілі характеристики карток Prom (власник, 24.10.2026) — ЛИШЕ ПЛАНУВАННЯ: прев'ю, резервна копія, відновлення, звірка.
 *
 *  Реальний тест (GMIG-305P) підтвердив: імпорт XML НЕ прибирає старих характеристик картки, а після ручного видалення
 *  повторний імпорт відновлює ті, що є у файлі. Тому перед масовим оновленням потрібен перелік підтверджених застарілих
 *  дублів. Модуль нічого не змінює в Prom і не видаляє: спосіб видалення (вручну в редакторі або окремо погоджений
 *  механізм) — рішення власника.
 *
 *  Правила (кожна характеристика картки Prom — одна дія):
 *   ЛИШИТИ   — є в новому наборі (та сама назва й рівнозначне значення); поле категорії, яке оновить імпорт; ручна
 *              характеристика власника; унікальна (у новому наборі відповідника немає — не видаляємо).
 *   ВИДАЛИТИ — підтверджений застарілий дубль: назва за підтвердженою відповідністю (схеми Prom, погоджений словник, пословна
 *              відповідність, як у генераторі) збігається з характеристикою нового набору, значення рівнозначне, а ТОЧНИЙ запис
 *              нового набору вже є в картці; або поле з відомою вадою довідника Prom, замінене погодженою користувацькою.
 *   ПЕРЕВІРИТИ — та сама характеристика з іншим значенням; кілька можливих відповідників; точного запису нового набору в картці
 *              ще немає (Prom може показувати нашу характеристику іншою мовою: GRH 300 — «Номінальний струм» → «Номинальный ток»);
 *              у новому наборі — ПОТРЕБУЄ ПЕРЕВІРКИ.
 *  Сумнівне — ніколи не ВИДАЛИТИ. План складається за експортом Prom, зробленим ПІСЛЯ імпорту нового набору. */
import { sha256 } from "./text.mjs";
import { SRC, charKey, cleanValue, timeValue, mapParam, normName, normValue, resolveAttr, sameValue, sameValueIn, wordsMatch } from "./prom-attributes.mjs";

export const ACTION = Object.freeze({ KEEP: "ЛИШИТИ", REMOVE: "ВИДАЛИТИ", CHECK: "ПЕРЕВІРИТИ" });

/** Характеристики рядка експорту Prom (трійки колонок Назва_Характеристики / Одиниця_виміру_Характеристики / Значення_Характеристики). */
export function promExportChars(header, row) {
  const out = [];
  for (let i = 0; i < header.length; i++) {
    if (String(header[i]) !== "Назва_Характеристики") continue;
    const name = String(row[i] ?? "").trim();
    if (name) out.push({ name, unit: String(row[i + 1] ?? "").trim(), value: String(row[i + 2] ?? "").trim() });
  }
  return out;
}

// Латинська літера-двійник у кириличному слові («Мoдель» з латинською o) — те саме слово.
const HOMO = { a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", y: "у", i: "і", k: "к", m: "м", h: "н", t: "т", b: "в" };
const fixHomo = (s) => String(s).replace(/\S+/g, (w) => (/[а-яіїєґё]/i.test(w) && /[a-z]/i.test(w) ? w.replace(/[a-z]/gi, (ch) => { const c = HOMO[ch.toLowerCase()]; return c ? (ch === ch.toLowerCase() ? c : c.toUpperCase()) : ch; }) : w));
const fmt = (p) => `${p.name}: ${p.value}${p.unit ? " " + p.unit : ""}`;

/**
 * План для однієї картки.
 *  prom — характеристики картки в Prom (promExportChars); prepared — новий підготовлений набір (buildCharacteristics().params);
 *  items — його походження (provenance.items: s, a); review — назви з ПОТРЕБУЄ ПЕРЕВІРКИ нового набору;
 *  manual — додаткові ручні характеристики власника (якщо ведуться окремо).
 */
export function planStaleCleanup({ prom = [], prepared = [], items = [], review = [], manual = [], schema = null, mapping = null, names = null, units = null } = {}) {
  const opt = { mapping, names };
  const key = (n) => charKey(schema, fixHomo(n), opt);
  const v = (p) => ({ value: cleanValue(p.value), unit: cleanValue(p.unit) });
  const isUa = (s) => /[іїєґ]/i.test(s) && !/[ыэъё]/i.test(s);
  const same = (q, p) => {
    const a = v(q), b = v(p);
    if (sameValueIn([p.name, q.name], a, b, names)) return true;
    const h = timeValue(p.name, a, isUa(q.name)); // «до 4,1 год» = «до 4,1 години»
    if (h !== a && sameValue(h, b, names)) return true;
    if (schema) { const m = mapParam(schema, { name: p.name, value: a.value, unit: a.unit }, { mapping, units }); if (m.ok && normValue(m.out.value, names) === normValue(b.value, names) && normName(m.out.unit) === normName(b.unit)) return true; }
    return false;
  };
  const manualAll = [...manual, ...prepared.filter((p, i) => items[i]?.s === SRC.MANUAL)];
  const reviewKeys = new Set(review.map(key));
  const prepKeys = prepared.map((p) => key(p.name));
  const exactName = (q, p) => normName(fixHomo(q.name)) === normName(fixHomo(p.name)) && normName(q.name) === normName(p.name);
  const present = new Set(prepared.map((p, i) => (prom.some((q) => exactName(q, p)) ? i : -1)).filter((i) => i >= 0)); // точний запис уже в картці
  const rows = [];
  for (const q of prom) {
    const row = (action, reason, twin = null) => rows.push({ name: q.name, unit: q.unit, value: q.value, action, reason, twin: twin ? fmt(twin) : "" });
    // 1. Точно є в новому наборі (та сама назва й рівнозначне значення) — імпорт оновить.
    const exact = prepared.find((p) => exactName(q, p) && same(q, p));
    if (exact) { row(ACTION.KEEP, "є в новому наборі", exact); continue; }
    // 2. Ручна характеристика власника — ніколи не видаляється.
    const man = manualAll.find((p) => key(p.name) === key(q.name));
    if (man) { row(ACTION.KEEP, "ручна характеристика власника", man); continue; }
    const at = schema ? resolveAttr(schema, fixHomo(q.name), mapping).attr : null;
    const isField = Boolean(at && [at.nameUK, at.nameRU].some((n) => normName(n) === normName(fixHomo(q.name))));
    // 3. Поле з відомою вадою довідника Prom (погоджено: замінене користувацькою з customName).
    const bad = at && mapping?.blocked?.[at.id];
    if (isField && bad) {
      const repl = prepared.find((p) => normName(p.name) === normName(bad.customName));
      if (repl) row(ACTION.REMOVE, `поле з вадою довідника Prom (${bad.issue}) — замінене користувацькою`, repl);
      else row(ACTION.CHECK, `поле з вадою довідника Prom (${bad.issue}); у новому наборі заміни немає`);
      continue;
    }
    // 4. Поле категорії, яке є в новому наборі, — імпорт оновить значення; не видаляємо.
    if (isField && items.some((it) => it?.a === at.id)) { row(ACTION.KEEP, "поле категорії — значення оновить імпорт", prepared[items.findIndex((it) => it?.a === at.id)]); continue; }
    // 5. Відповідник у новому наборі: підтверджена назва (схеми, словник) або пословна відповідність (як у генераторі).
    const kq = key(q.name);
    const twins = prepared.map((p, i) => ({ p, i })).filter(({ p, i }) => prepKeys[i] === kq || wordsMatch(fixHomo(p.name), fixHomo(q.name), names) || wordsMatch(fixHomo(q.name), fixHomo(p.name), names));
    if (!twins.length) {
      if (reviewKeys.has(kq) || review.some((n) => wordsMatch(n, q.name, names) || wordsMatch(q.name, n, names))) row(ACTION.CHECK, "у новому наборі ця характеристика ПОТРЕБУЄ ПЕРЕВІРКИ — не видаляти до рішення");
      else row(ACTION.KEEP, isField ? "поле категорії (у новому наборі немає)" : "унікальна — відповідника в новому наборі немає");
      continue;
    }
    if (twins.length > 1) { row(ACTION.CHECK, `кілька можливих відповідників: ${twins.map(({ p }) => fmt(p)).join(" / ")}`); continue; }
    const t = twins[0].p, how = prepKeys[twins[0].i] === kq ? "підтверджена відповідність назв" : "пословна відповідність назв";
    if (!same(q, t)) { row(ACTION.CHECK, `${how}, але значення інше — ПОТРЕБУЄ ПЕРЕВІРКИ`, t); continue; }
    // Prom зберігає / показує в експорті назву користувацької іншою мовою (реальний тест GRH 300: надіслано «Номінальний
    // струм» — в експорті «Номинальный ток»). Дубль — лише коли точний запис нового набору вже є в картці; інакше це,
    // імовірно, та сама характеристика: не видаляти (план складати за експортом ПІСЛЯ імпорту нового набору).
    if (!present.has(twins[0].i)) {
      const rivals = prom.filter((o) => o !== q && !prepared.some((p) => exactName(o, p)) && (key(o.name) === prepKeys[twins[0].i] || wordsMatch(fixHomo(t.name), fixHomo(o.name), names) || wordsMatch(fixHomo(o.name), fixHomo(t.name), names)));
      row(ACTION.CHECK, rivals.length ? `${how}; точного запису «${t.name}» у картці немає, а кандидатів кілька — котрий з них Prom оновить, не визначити` : `${how}; точного запису «${t.name}» у картці немає — імовірно, та сама характеристика (Prom показує назву іншою мовою); план — за експортом після імпорту`, t);
      continue;
    }
    row(ACTION.REMOVE, `застарілий дубль: ${how}, значення рівнозначне; точний запис нового набору в картці є`, t);
  }
  const count = (a) => rows.filter((r) => r.action === a).length;
  return { rows, summary: { prom: prom.length, prepared: prepared.length, keep: count(ACTION.KEEP), remove: count(ACTION.REMOVE), check: count(ACTION.CHECK) } };
}

/** Рядки прев'ю (TSV): товар, дія, причина, характеристика Prom, відповідник у новому наборі. */
export function cleanupPreviewRows(productId, plan) {
  const head = ["ID товару", "Дія", "Причина", "Назва в Prom", "Значення в Prom", "Одиниця в Prom", "Відповідник у новому наборі"];
  return [head, ...plan.rows.map((r) => [productId, r.action, r.reason, r.name, r.value, r.unit, r.twin])];
}

/** Резервна копія характеристик картки до будь-якого очищення (повний перелік з експорту Prom + SHA-256). */
export function cleanupBackup({ productId, prom, source = "", takenAt = new Date().toISOString() }) {
  const body = JSON.stringify(prom);
  return { v: 1, productId: String(productId), source, takenAt, count: prom.length, sha256: sha256(body), prom: JSON.parse(body) };
}

/** Відновлення: перелік характеристик «як було» з резервної копії (для XML відновлення; імпорт додає характеристики — підтверджено). */
export function restoreFromBackup(backup) {
  if (!backup || backup.v !== 1 || !Array.isArray(backup.prom)) throw new Error("резервна копія пошкоджена або іншого формату");
  if (sha256(JSON.stringify(backup.prom)) !== backup.sha256) throw new Error("SHA-256 резервної копії не збігається — відновлення неможливе");
  return backup.prom.map((p) => ({ name: p.name, unit: p.unit, value: p.value }));
}

/** Звірка після очищення (новий експорт Prom): ЛИШИТИ / ПЕРЕВІРИТИ — на місці, ВИДАЛИТИ — відсутні, нового набору — повністю. */
export function verifyAfterCleanup(plan, promAfter, prepared = []) {
  const k = (p) => `${normName(p.name)}\u0001${normValue(p.value)}\u0001${normName(p.unit)}`;
  const after = new Set(promAfter.map(k));
  const problems = [];
  for (const r of plan.rows) {
    const present = after.has(k(r));
    if (r.action === ACTION.REMOVE && present) problems.push(`не видалено: ${fmt(r)}`);
    if (r.action !== ACTION.REMOVE && !present && !prepared.some((p) => normName(p.name) === normName(r.name))) problems.push(`зникло те, що мало лишитися: ${fmt(r)}`);
  }
  for (const p of prepared) if (!promAfter.some((q) => normName(q.name) === normName(p.name))) problems.push(`немає характеристики нового набору: ${fmt(p)}`);
  return { ok: problems.length === 0, problems };
}
