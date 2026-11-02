/** ENG-28c — QA погоджених товарів окремою контрольованою операцією (рішення власника 01.11.2026: QA не запускає повне оновлення).
 *
 *  Той самий штатний планувальник, що й «Оновити товари» (planSheetSync у режимі пріоритету власника): Catalog Controls (fail-closed),
 *  FZ / OV, ізоляція, захисні пороги, «preserve» характеристик — план рахується на ВСЬОМУ каталозі (будь-яка зупинка плану зупиняє й
 *  QA). Записуються ЛИШЕ рядки погоджених Offer ID і лише вже наявні колонки з QA_COLUMNS (ціни / наявність, сирі назви постачальника,
 *  фото, URL, модель, артикул, печатка):
 *   - без масового перезапису і без службових аркушів («Класифікація полів», «Попередження постачальника») і нових колонок — стан полів
 *     усього каталогу мігрує перше повне «Оновити товари» (інакше 5 024 рядки без стану ізолювались би як «рядок без стану полів»);
 *   - SEO / описи / запити / характеристики / рішення власника не змінюються: зміна будь-якої іншої колонки в плані → BLOCKED;
 *   - порушена печатка QA-товару приймається ЛИШЕ коли розбіжність повністю пояснює погоджене рішення власника (explainSeal; Hermes
 *     F-28B-3: печатка не «загоюється» мовчки перепечатуванням) — інакше QA цього товару не проходить, нічого не записано;
 *   - знімок фіду НЕ підтверджується (це робить лише «Оновити товари»), присутність не позначається;
 *   - «Журнал»: події QA-товарів (як у синхронізації) + пояснення печатки + підсумок; «Паспорт каталогу» — перерахунок (аудит);
 *   - expected — план, погоджений власником (dry-run): інший → BLOCKED без запису. Повтор після виконання → NOTHING. */
import { mtText } from "../core/text.mjs";
import { LIVE_COLUMNS, readSheet } from "../core/sync-plan.mjs";
import { SEAL_COLUMN, rowSeal, approvalManifest } from "../core/seal.mjs";
import { SHEET, planSheetSync, passportValues, readPassport, samePassport, extractFullOffers } from "../core/sheet-sync.mjs";
import { parseSupplierText } from "../core/supplier-feed.mjs";
import { snapshotFromXml, proveComplete, CONFIRMED_SNAPSHOT_KEY, feedScopeOf } from "../core/supplier-presence.mjs";
import { OP, ITEM } from "./safe-write/keyed-update.mjs";
import { CORRECTION_1561514532, correctText } from "./eng28a-steps.mjs";
import { CONFIRMED_FILTERED_SNAPSHOT_KEY, FULL_FEED_MAX_CHARS } from "./update-products.mjs";
import { SYNC_SHEETS, syncControlsState, catalogFor, groupsOf, appendJournal, recordBlocked, fullForQueue, journalRow } from "./sheet-sync-run.mjs";
import { RUN_PLAN_KEY, PLAN, JOURNAL_SHEET, RECOVERY_DONE, openPlansGate, loadPlan, savePlan, withEventIds, evidenceCell, appendEvents } from "./run-plan.mjs";

/** Погоджені власником QA-товари (доручення 01.11.2026). */
export const QA_IDS_0111 = Object.freeze(["1561514532", "2560360931", "2689669665", "2894494274", "3166947187"]);
/** Колонки, які QA може змінити (системні / сирі постачальника / печатка). Будь-яка інша зміна в плані — зупинка. */
export const QA_COLUMNS = Object.freeze([...LIVE_COLUMNS, "Назва постачальника UA", "Назва постачальника RU", "URL постачальника", "Фото JSON", "Модель", "Артикул постачальника", SEAL_COLUMN]);
const t = (v) => mtText(v).trim();

/** Порушена печатка пояснюється погодженим рішенням власника? Відкат замін рішення (5,5 Дж → 6 Дж, 1500 Вт → 1700 Вт) у полях
 *  рішення має дати рівно запечатаний стан. → { ok, kind: "OK" | "EXPLAINED" | "UNEXPLAINED", reason }. */
export function explainSeal(row, specs = [CORRECTION_1561514532]) {
  const stored = t(row[SEAL_COLUMN]);
  if (rowSeal(row) === stored) return { ok: true, kind: "OK" };
  for (const spec of specs) {
    if (t(row["Offer ID"]) !== spec.offerId) continue;
    const back = { ...spec, replacements: spec.replacements.map(([from, to, unit]) => [to, from, unit]) };
    const reverted = { ...row };
    for (const f of spec.fields) reverted[f] = correctText(row[f], back);
    if (rowSeal(reverted) === stored) return { ok: true, kind: "EXPLAINED", reason: `розбіжність печатки повністю пояснює рішення власника ${spec.decision.date} (${spec.replacements.map(([a, b, u]) => `${a} ${u} → ${b} ${u}`).join(", ")}) у полях ${spec.fields.join(", ")}; інших змін запечатаних полів немає` };
  }
  return { ok: false, kind: "UNEXPLAINED", reason: "печатка не збігається, і розбіжність не пояснюється погодженим рішенням власника — потрібне окреме рішення" };
}

/** Погоджений план ↔ поточний: «Оновлено» — час конкретного запуску (у dry-run і в записі різний), тому не порівнюється; решта — побайтово. */
const planKey = (changes) => JSON.stringify((changes || []).filter((c) => c.column !== "Оновлено"));
const sameChanges = (a, b) => planKey(a) === planKey(b);

export async function qaProducts(o) {
  // ENG-28d: незавершене перенесення → BLOCKED; незавершений попередній запуск → спершу відновлення його журналу (BLOCKED / INCOMPLETE —
  // зупинка); після JOURNAL_RECOVERED / RUN_PLAN_ABANDONED той самий запуск продовжує QA (свіже читання), результат — з полем recovery.
  const session = o.session ?? null;
  if (!o.planOnly && session?.gw?.store?.getJsonVersioned && session.state === "READY") {
    const gate = await openPlansGate({ store: session.gw.store, session, readBook: o.readBook, stamp: o.stamp });
    if (gate && !RECOVERY_DONE.has(gate.state)) return gate;
    if (gate) return { ...(await qaProductsRun(o)), recovery: gate };
  }
  return qaProductsRun(o);
}
async function qaProductsRun({ sheets, readBook, xml, source = "", fetchedAt = "", stamp, now, config, catalog = null, controls = null, snapshotStore, session = null, ids = QA_IDS_0111, expected = null, explain = [CORRECTION_1561514532], planOnly = false }) {
  const want = [...new Set(ids.map(t).filter(Boolean))];
  if (!want.length) return { state: "BLOCKED", reason: "немає Offer ID для QA" };
  if (!planOnly && !session) return { state: "BLOCKED", reason: "QA пише лише через сесію шлюзу запису W2 (оренда, журнал, fencing)" };
  if (session && session.state !== "READY") return { state: "BLOCKED", reason: `шлюз запису: ${session.state} — спершу з'ясування попередніх операцій або рішення людини` };
  // Фід: та сама перевірка повноти, що й в «Оновити товари» (без підтвердження знімка).
  let snapshot;
  try { snapshot = snapshotFromXml(xml, { source, fetchedAt, scope: feedScopeOf(source) }); }
  catch (e) { return { state: "ABORTED", reason: "фід постачальника пошкоджений або обірваний: " + mtText(e?.message || e) }; }
  const previous = snapshotStore?.getJsonVersioned ? (await snapshotStore.getJsonVersioned(snapshot.scope === "full" ? CONFIRMED_SNAPSHOT_KEY : CONFIRMED_FILTERED_SNAPSHOT_KEY))?.value || null : null;
  const proof = proveComplete(snapshot, { previous, now, supplierConfig: config.supplier });
  const problemsFeed = proof.reasons.filter((r) => !/той самий знімок/.test(r));
  if (problemsFeed.length) return { state: "ABORTED", reason: "повноту фіду не доведено: " + problemsFeed.join("; ") };
  let parsed;
  try { parsed = await parseSupplierText(xml, { maximumChars: FULL_FEED_MAX_CHARS, identityFields: true }); }
  catch (e) { return { state: "ABORTED", reason: "повний фід не розібрано: " + mtText(e?.message || e) }; }

  const ccState = await syncControlsState(controls, config);
  const book = await readBook(SYNC_SHEETS);
  const header = (book[SHEET.main]?.[0] || []).map(t);
  const rows = readSheet(book[SHEET.main], SHEET.main).rows;
  const problems = [], seals = [];
  for (const id of want) {
    const found = rows.filter((r) => t(r["Offer ID"]) === id);
    if (found.length !== 1) { problems.push(`${id}: рядків в «Основному каталозі» ${found.length} (потрібен рівно 1)`); continue; }
    if (!parsed.offers.has(t(found[0]["ID постачальника"]))) problems.push(`${id}: немає в актуальному фіді (поза охопленням або зник) — нові дані постачальника невідомі`);
    const s = explainSeal(found[0], explain);
    seals.push({ offerId: id, ...s });
    if (!s.ok) problems.push(`${id}: ${s.reason}`);
  }
  if (problems.length) return { state: "BLOCKED", reason: "QA не виконано (нічого не записано): " + problems.join("; "), problems, seals };

  // Повний штатний план (усі перевірки на всьому каталозі), черга — без змін.
  const warnings = [];
  const fullById = await fullForQueue(book, async (list) => extractFullOffers(xml, list), warnings, [], { parsed, withMain: true });
  const plan = planSheetSync({ book, parsed, stamp, config, now, groupsRows: groupsOf(book), fullById, catalog: catalogFor(catalog, warnings), controls: ccState, queueCommands: false, presenceColumns: false, feedScope: snapshot.scope === "full" ? "full" : "filtered", queueMode: "off" });
  if (plan.abort) {
    if (planOnly) return { state: "ABORTED", reason: plan.abort, block: plan.block };
    const rec = await recordBlocked(session.sheets, stamp, plan.block || { type: "ЗАБЛОКОВАНО", reason: plan.abort, affected: "", limit: "" });
    return { state: "ABORTED", reason: plan.abort, block: plan.block, ...rec };
  }
  const isolated = plan.ownerPriority?.isolatedIndexes || new Set();
  const changes = [], items = [];
  for (const id of want) {
    const i = plan.main.rows.findIndex((r) => t(r["Offer ID"]) === id);
    const cur = rows.find((r) => t(r["Offer ID"]) === id);
    if (isolated.has(i)) { problems.push(`${id}: ізольовано планом (${plan.ownerPriority.isolated.find((x) => x.offerId === id)?.reason || "—"})`); continue; }
    const planned = { ...plan.main.rows[i] };
    LIVE_COLUMNS.forEach((k, j) => { planned[k] = plan.main.plan[i].next[j]; });
    // Лише «Оновлено» (час перевірки) — не зміна: QA вже виконано, повтор нічого не пише.
    const diff = header.filter((k) => mtText(planned[k] ?? "") !== mtText(cur[k] ?? ""));
    const cols = diff.some((k) => k !== "Оновлено") ? diff : [];
    const extra = cols.filter((k) => !QA_COLUMNS.includes(k));
    if (extra.length) problems.push(`${id}: план змінює колонки поза QA (${extra.join(", ")}) — потрібне окреме рішення`);
    const state = t(planned["Стан синхронізації"]);
    if (state !== "ЗІСТАВЛЕНО") problems.push(`${id}: після QA стан «${state}», а не «ЗІСТАВЛЕНО»`);
    if (rowSeal(planned) !== t(planned[SEAL_COLUMN])) problems.push(`${id}: печатка запланованого рядка не збігається з його вмістом`);
    items.push({ offerId: id, supplierId: t(cur["ID постачальника"]), stateBefore: t(cur["Стан синхронізації"]), stateAfter: state, columns: cols });
    for (const k of cols) changes.push({ offerId: id, column: k, expect: mtText(cur[k] ?? ""), set: mtText(planned[k] ?? "") });
  }
  const qaPlan = { ids: want, changes, seals: seals.map((s) => ({ offerId: s.offerId, kind: s.kind })) };
  if (problems.length) return { state: "BLOCKED", reason: "QA не виконано (нічого не записано): " + problems.join("; "), problems, items, qaPlan };
  if (planOnly) return { state: "PLANNED", qaPlan, items, seals };
  // Повтор після виконаного QA: змін немає — NOTHING (і з погодженим планом, і без нього); нічого не пишемо.
  if (!changes.length) return { state: "NOTHING", reason: "QA вже виконано — змін немає", items };
  if (expected && !sameChanges(expected.changes || [], changes)) return { state: "BLOCKED", reason: "поточний план QA відрізняється від погодженого dry-run — запис не виконано", qaPlan };

  // Події «Журналу» QA — до запису (контрольний план ENG-28d).
  const qaSet = new Set(want);
  const journal = [
    ...plan.journal.filter((e) => qaSet.has(t(e[2]))),
    ...seals.filter((s) => s.kind === "EXPLAINED").map((s) => [stamp, SHEET.main, s.offerId, SEAL_COLUMN, "", "", "ПЕЧАТКУ ВИЗНАНО: " + s.reason]),
    [stamp, "СИСТЕМА", "", "QA (ENG-28c)", "", want.length, JSON.stringify({ mode: "QA ПОГОДЖЕНИХ ТОВАРІВ", ids: want.length, cells: changes.length, feedDate: snapshot.feedDate, feedScope: snapshot.scope })],
  ];
  // ENG-28d (F-28B-1): контрольний план ДО запису — докази (усі клітинки QA: було → стало) і події з ID; без плану нічого не пишемо.
  const planStore = session.gw?.store?.getJsonVersioned ? session.gw.store : null;
  const runId = "qa:" + stamp;
  let runPlan = null, runPlanVersion = null;
  if (planStore) {
    runPlan = { v: 1, kind: "qa", runId, stamp, status: PLAN.PLANNED, createdAt: stamp, evidence: changes.map((c) => evidenceCell(c.offerId, c.column, c.expect, c.set)), events: withEventIds(runId, journal.map(journalRow)) };
    try { runPlanVersion = await savePlan(planStore, RUN_PLAN_KEY, runPlan, (await loadPlan(planStore)).version); }
    catch (e) { return { state: "BLOCKED", reason: "контрольний план QA не записано (сховище W2): " + mtText(e?.message || e).slice(0, 200) + " — нічого не записано" }; }
  }
  // Запис — лише за ключем (Offer ID), лише змінені клітинки, з очікуваними значеннями (правка людини між читанням і записом → CONFLICT).
  const perOffer = want.map((id) => {
    const ch = changes.filter((c) => c.offerId === id);
    const it = items.find((x) => x.offerId === id);
    return ch.length ? { key: id, identity: { "ID постачальника": it.supplierId }, expect: Object.fromEntries(ch.map((c) => [c.column, c.expect])), set: Object.fromEntries(ch.map((c) => [c.column, c.set])) } : null;
  }).filter(Boolean);
  let r;
  try { r = await session.updateByKey({ title: SHEET.main, changes: perOffer, generation: "qa:" + stamp }); }
  catch (e) { return { state: "INCOMPLETE", needsDecision: !planStore, error: mtText(e?.message || e).slice(0, 300), next: planStore ? "--mode=reconcile → повтор QA (відновлення журналу за планом)" : "" }; }
  const notDone = (r.items || []).filter((x) => x.status !== ITEM.VERIFIED && x.status !== ITEM.ALREADY);
  if (r.outcome !== OP.VERIFIED || notDone.length) {
    await appendJournal(session.sheets, [[stamp, "СИСТЕМА", "", "ПОМИЛКА", "", "", `QA (ENG-28c): запис за ключем ${r.outcome}; ${notDone.map((x) => `${x.key}: ${x.status}`).slice(0, 5).join("; ")} — повтор лише після з'ясування`]]).catch(() => {});
    return { state: notDone.some((x) => x.status === ITEM.CONFLICT) ? "CONFLICT_OWNER_EDIT" : "INCOMPLETE", needsDecision: true, outcome: r.outcome, items: r.items };
  }
  // «Паспорт каталогу» — аудит: перерахунок за фактичним станом після QA.
  const after0 = (await readBook([SHEET.main, SHEET.passport]));
  const mainAfter = readSheet(after0[SHEET.main], SHEET.main).rows;
  const manifest = approvalManifest(mainAfter, groupsOf(book));
  let passportWritten = false;
  if (after0[SHEET.passport] && !samePassport(readPassport(after0[SHEET.passport]), manifest)) {
    await session.sheets.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: passportValues(manifest, `QA погоджених товарів (${want.length}) — ENG-28c`, stamp) }]);
    passportWritten = true;
  }
  // Перевірка після запису: QA-рядки — заплановані значення й ціла печатка; усі інші рядки — побайтово як до QA.
  const after = readSheet((await readBook([SHEET.main]))[SHEET.main], SHEET.main).rows;
  const byId = new Map(after.map((x) => [t(x["Offer ID"]), x]));
  const beforeOthers = rows.filter((x) => !qaSet.has(t(x["Offer ID"])));
  const verify = {
    rows: after.length === rows.length,
    qaApplied: changes.every((c) => mtText(byId.get(c.offerId)?.[c.column] ?? "") === c.set),
    qaSeals: want.every((id) => { const x = byId.get(id); return x && rowSeal(x) === t(x[SEAL_COLUMN]); }),
    othersUnchanged: beforeOthers.every((x) => { const y = byId.get(t(x["Offer ID"])); return y && header.every((k) => mtText(y[k] ?? "") === mtText(x[k] ?? "")); }),
  };
  const ok = verify.rows && verify.qaApplied && verify.qaSeals && verify.othersUnchanged;
  if (!ok) return { state: "INCOMPLETE", needsDecision: true, verify, items, seals, cells: changes.length, passportWritten, qaPlan };
  // ENG-28d: дані QA перевірено → PRODUCT_DONE; «Журнал» — за «ID події»; збій журналу — JOURNAL_INCOMPLETE (не QA_DONE), дані не відкочуються.
  let journalOutcome = null;
  if (planStore) {
    journalOutcome = { runId, planned: runPlan.events.length, ok: false, outcome: null };
    try {
      runPlanVersion = await savePlan(planStore, RUN_PLAN_KEY, { ...runPlan, status: PLAN.PRODUCT_DONE, productDoneAt: stamp }, runPlanVersion);
      const jr = await appendEvents({ session, journalValues: (await readBook([JOURNAL_SHEET]))[JOURNAL_SHEET], rows: runPlan.events, generation: "journal:" + runId });
      journalOutcome = { ...journalOutcome, ok: jr.ok, outcome: jr.outcome, appended: jr.appended };
      if (jr.ok) runPlanVersion = await savePlan(planStore, RUN_PLAN_KEY, { ...runPlan, status: PLAN.DONE, productDoneAt: stamp, closedAt: stamp }, runPlanVersion);
    } catch (je) { journalOutcome = { ...journalOutcome, ok: false, outcome: String(je?.outcome || "ERROR"), error: mtText(je?.message || je).slice(0, 200) }; }
  } else await appendJournal(session.sheets, journal);
  const journalLost = Boolean(journalOutcome && !journalOutcome.ok);
  return { state: journalLost ? "JOURNAL_INCOMPLETE" : "QA_DONE", ...(journalLost ? { reason: `дані QA записано й перевірено, але «Журнал» ${runId} неповний (${journalOutcome.outcome}) — наступний запуск після reconcile допише відсутні події` } : {}), journal: journalOutcome, verify, items, seals, cells: changes.length, passportWritten, journalEntries: journal.length, qaPlan, feed: { id: snapshot.id, date: snapshot.feedDate, scope: snapshot.scope } };
}
