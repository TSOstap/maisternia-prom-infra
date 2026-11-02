/** ENG-28a — кроки контрольованої міграції тестової копії (порядок погоджено власником 01.11.2026):
 *   1. migrateQueueForTransfer — структура: заголовок черги «Нових товарів» (53) + «ОЧІКУЄ ПЕРЕНЕСЕННЯ» (рядки не змінюються, не
 *      видаляються); «Паспорт каталогу» поточного основного каталогу, якщо його немає (без нього штатна синхронізація не працює);
 *   2. ініціалізація Catalog Controls — штатним runCatalogControls (тут не реалізується; окремий крок із перевіркою);
 *   3. applyOwnerCorrection — разова процедура виправлення 1561514532 (рішення власника 29.10 / 01.11): лише цей Offer ID, лише 4 поля,
 *      лише погоджені заміни «1700 Вт» → «1500 Вт», «6 Дж» → «5,5 Дж»; очікувані старі значення; «Журнал»; повторна QA-перевірка;
 *   4. QA п'яти товарів — штатна синхронізація в режимі пріоритету власника (syncSheet / updateProducts);
 *   5. transferNew92 (sheet-sync-run.mjs); 6. перевірка результату.
 *  Записи — лише через охоронця цілі (write-target.mjs: TEST, дозволені аркуші / колонки / операції) і за ключем із перевіркою очікуваного. */
import { mtText } from "../core/text.mjs";
import { readSheet } from "../core/sync-plan.mjs";
import { SHEET, PASSPORT_HEADER, passportValues, readPassport, samePassport } from "../core/sheet-sync.mjs";
import { approvalManifest, GROUP_HEADERS } from "../core/seal.mjs";
import { objectsFromValues } from "../core/yml.mjs";
import { planQueueMigration } from "../core/transfer-new92.mjs";
import { forbiddenPatterns } from "../core/qa-plan.mjs";
import { keyedUpdate, OP, ITEM } from "./safe-write/keyed-update.mjs";
import { loadOwnership } from "./safe-write/ownership.mjs";
import { withProvisionalQueue } from "./safe-write/queue-ownership.mjs";

const JOURNAL = "Журнал";
const t = (v) => mtText(v).trim();
/** Елементи keyedUpdate, не записані й не наявні раніше (CONFLICT, MISSING, IDENTITY_MISMATCH, …). */
const notDone = (r) => (r.items || []).filter((x) => x.status !== ITEM.VERIFIED && x.status !== ITEM.ALREADY);

// ---------------------------------------------------------------- 1. структура черги
export async function migrateQueueForTransfer({ sheets, readBook, stamp, contract = null }) {
  const book = await readBook([SHEET.queue, SHEET.main, SHEET.groups, SHEET.passport]);
  const plan = planQueueMigration({ book, stamp });
  const needPassport = !readPassport(book[SHEET.passport]);
  if (plan.state === "ALREADY" && !needPassport) return { state: "NOTHING", reason: "черга вже підготовлена / перенесена, паспорт є", checks: plan.checks };
  if (plan.state !== "READY" && plan.state !== "ALREADY") return { state: "PRECONDITION_FAILED", checks: plan.checks };
  const queue = plan.state === "READY";
  if (queue) {
    const ownQ = withProvisionalQueue(contract || loadOwnership());
    await sheets.ensureColumns(SHEET.queue, plan.header.length);
    await sheets.updateRanges([{ title: SHEET.queue, row: 1, col: 1, values: [plan.header] }]);
    const r = await keyedUpdate({ sheets, read: readBook, contract: ownQ, writer: "sync", title: SHEET.queue, changes: plan.marks.map((m) => ({ key: m.offerId, expect: { "Перевірка": m.expect }, set: { "Перевірка": m.check } })), generation: "queue-migration:" + stamp });
    // Зупинка без «сліпого» повтору: заголовок уже записано, частину позначок — ні; повторний запуск дасть PRECONDITION_FAILED.
    // keyedUpdate рахує outcome лише за спробами запису: CONFLICT одного рядка при VERIFIED інших дає VERIFIED — тому й items.
    if (r.outcome !== OP.VERIFIED || notDone(r).length) return { state: "INCOMPLETE", step: "позначки «ОЧІКУЄ ПЕРЕНЕСЕННЯ»", outcome: r.outcome, items: r.items.filter((x) => x.status !== ITEM.VERIFIED).slice(0, 5), needsDecision: true };
  }
  // Паспорт — з поточного основного каталогу (затверджений стан до QA й перенесення); перенесення NEW92 його оновлює.
  const manifest = needPassport ? approvalManifest(readSheet(book[SHEET.main], SHEET.main).rows, objectsFromValues(book[SHEET.groups], GROUP_HEADERS)) : null;
  if (manifest) {
    await sheets.ensureSheet(SHEET.passport, PASSPORT_HEADER.slice());
    await sheets.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: passportValues(manifest, "структура ENG-28a: паспорт поточного «Основного каталогу» (до QA і перенесення NEW92)", stamp) }]);
  }
  await sheets.appendRows(JOURNAL, [[stamp, "СИСТЕМА", "", "СТРУКТУРА (ENG-28a)", queue ? "«Нові товари»: 40 колонок (NEW92)" : "", queue ? plan.header.length : "",
    [queue ? `заголовок черги; ${plan.marks.length} рядків — «ОЧІКУЄ ПЕРЕНЕСЕННЯ» (рядки не видаляються)` : "", manifest ? `«Паспорт каталогу»: ${manifest.count} рядків` : ""].filter(Boolean).join("; ")]]);
  const after = await readBook([SHEET.queue, SHEET.passport]);
  const rows = readSheet(after[SHEET.queue], SHEET.queue).rows;
  const verify = {
    header: !queue || (after[SHEET.queue][0] || []).map(t).join("|") === plan.header.join("|"),
    rows: !queue || rows.length === plan.marks.length,
    marked: !queue || plan.marks.every((m) => t(rows.find((x) => t(x["Offer ID"]) === m.offerId)?.["Перевірка"]) === m.check),
    passport: !manifest || samePassport(readPassport(after[SHEET.passport]), manifest),
  };
  const ok = verify.header && verify.rows && verify.marked && verify.passport;
  return { state: ok ? "MIGRATED" : "INCOMPLETE", ...(ok ? {} : { needsDecision: true }), verify, columnsAdded: queue ? plan.columnsAdded : [], marked: queue ? plan.marks.length : 0, passport: manifest ? { count: manifest.count } : null };
}

// ---------------------------------------------------------------- 3. виправлення 1561514532
/** Разова процедура: жодних інших товарів, полів і замін. Рішення: «Рішення власника — наступний пакет» (29.10) + погодження 01.11. */
export const CORRECTION_1561514532 = Object.freeze({
  offerId: "1561514532",
  fields: Object.freeze(["Опис UA", "Опис RU", "Запити UA", "Запити RU"]),
  replacements: Object.freeze([["1700", "1500", "Вт"], ["6", "5,5", "Дж"]]),
  decision: { date: "29.10.2026", wrong: [{ subject: "потужність", value: "1700", unit: "Вт" }, { subject: "енергія удару", value: "6", unit: "Дж" }], confirmedBy: "власник (29.10, 01.11.2026)" },
});
// Межа одиниці: не літера, не цифра й не знак складеної одиниці («Вт·год» — інша одиниця, не замінюється).
const numRe = (num, unit) => new RegExp(`(^|[^\\d,.])${num.replace(/[,.]/g, "[,.]")}(\\s*)(${unit})(?![\\p{L}\\d·⋅/])`, "gu");
const numbers = (s) => s.match(/\d+(?:[,.]\d+)?/g) || [];
export function correctText(s, spec = CORRECTION_1561514532) {
  let out = mtText(s);
  for (const [from, to, unit] of spec.replacements) out = out.replace(numRe(from, unit), (_, a, sp, u) => a + to + sp + u);
  return out;
}
/** План: лише поля спеки; кожна різниця чисел — лише погоджена пара; після — жодного забороненого значення. */
export function planOwnerCorrection(mainValues, spec = CORRECTION_1561514532) {
  const rows = readSheet(mainValues, SHEET.main).rows.filter((r) => t(r["Offer ID"]) === spec.offerId);
  const problems = [];
  if (rows.length !== 1) return { ok: false, problems: [`Offer ID ${spec.offerId}: рядків ${rows.length} (потрібен рівно 1)`], changes: [] };
  const r = rows[0];
  const allowed = new Set(spec.replacements.map(([a, b]) => a + "→" + b));
  const changes = [];
  for (const f of spec.fields) {
    const before = mtText(r[f]), after = correctText(before, spec);
    if (before === after) continue;
    const nb = numbers(before), na = numbers(after);
    if (nb.length !== na.length) problems.push(`«${f}»: змінилась кількість чисел`);
    const pairs = nb.map((x, i) => [x, na[i]]).filter(([a, b]) => a !== b);
    for (const [a, b] of pairs) if (!allowed.has(a + "→" + b)) problems.push(`«${f}»: непогоджена заміна ${a} → ${b}`);
    changes.push({ column: f, expect: before, set: after, pairs });
  }
  const residual = [];
  for (const p of forbiddenPatterns(spec.decision)) for (const f of spec.fields) { const v = changes.find((c) => c.column === f)?.set ?? mtText(r[f]); if (p.re.test(v)) residual.push(`${p.label} у «${f}»`); }
  if (residual.length) problems.push("після виправлення лишаються заборонені значення: " + residual.join("; "));
  if (!changes.length) problems.push("змін немає (уже виправлено?)");
  return { ok: problems.length === 0, offerId: spec.offerId, supplierId: t(r["ID постачальника"]), changes, problems, replaced: changes.reduce((a, c) => a + c.pairs.length, 0) };
}
/** Контракт лише цієї процедури: записувач «owner-correction», лише 4 колонки «Основного каталогу» (без воріт стану — рішення власника). */
function correctionContract(spec) {
  const columns = new Map(spec.fields.map((c) => [c, Object.freeze({ group: `разове виправлення ${spec.offerId} за рішенням власника`, writers: Object.freeze(["owner-correction"]), gate: "" })]));
  return Object.freeze({ sheets: new Map([[SHEET.main, Object.freeze({ key: "Offer ID", identity: Object.freeze(["ID постачальника"]), appendWriters: Object.freeze([]), deleteWriters: Object.freeze([]), columns })]]) });
}
/** expected — план, затверджений власником (dry-run); перед записом свіже читання й звірка очікуваних значень; інакше BLOCK без запису. */
export async function applyOwnerCorrection({ sheets, readBook, stamp, expected = null, spec = CORRECTION_1561514532 }) {
  const book = await readBook([SHEET.main]);
  const plan = planOwnerCorrection(book[SHEET.main], spec);
  if (!plan.ok) return { state: "BLOCKED", problems: plan.problems };
  if (expected) {
    const same = expected.changes?.length === plan.changes.length && plan.changes.every((c) => { const e = expected.changes.find((x) => x.column === c.column); return e && e.expect === c.expect && e.set === c.set; });
    if (!same) return { state: "BLOCKED", problems: ["поточні значення відрізняються від погодженого dry-run — запис не виконано"] };
  }
  const r = await keyedUpdate({ sheets, read: readBook, contract: correctionContract(spec), writer: "owner-correction", title: SHEET.main,
    changes: [{ key: spec.offerId, identity: { "ID постачальника": plan.supplierId }, expect: Object.fromEntries(plan.changes.map((c) => [c.column, c.expect])), set: Object.fromEntries(plan.changes.map((c) => [c.column, c.set])) }], generation: "owner-correction:" + spec.offerId + ":" + stamp });
  if (r.outcome !== OP.VERIFIED || notDone(r).length) return { state: r.items.some((x) => x.status === ITEM.CONFLICT) ? "CONFLICT_OWNER_EDIT" : "INCOMPLETE", needsDecision: true, outcome: r.outcome, items: r.items };
  await sheets.appendRows(JOURNAL, plan.changes.map((c) => [stamp, SHEET.main, spec.offerId, c.column, c.pairs.map(([a]) => a).join(", "), c.pairs.map(([, b]) => b).join(", "), `РІШЕННЯ ВЛАСНИКА ${spec.decision.date}: 1700 Вт → 1500 Вт, 6 Дж → 5,5 Дж (разова процедура ENG-28a)`]));
  // Повторна QA-перевірка після запису: свіже читання, заборонених значень немає, інші поля рядка не змінено.
  const after = await readBook([SHEET.main]);
  const row = readSheet(after[SHEET.main], SHEET.main).rows.find((x) => t(x["Offer ID"]) === spec.offerId);
  const before = readSheet(book[SHEET.main], SHEET.main).rows.find((x) => t(x["Offer ID"]) === spec.offerId);
  const residual = forbiddenPatterns(spec.decision).flatMap((p) => spec.fields.filter((f) => p.re.test(mtText(row?.[f]))).map((f) => `${p.label} у «${f}»`));
  const otherChanged = Object.keys(before || {}).filter((k) => !spec.fields.includes(k) && mtText(before[k]) !== mtText(row?.[k]));
  const qa = { residual, otherChanged, applied: plan.changes.every((c) => mtText(row?.[c.column]) === c.set) };
  const ok = qa.applied && !residual.length && !otherChanged.length;
  return { state: ok ? "CORRECTED" : "INCOMPLETE", ...(ok ? {} : { needsDecision: true }), replaced: plan.replaced, columns: plan.changes.map((c) => c.column), qa };
}
