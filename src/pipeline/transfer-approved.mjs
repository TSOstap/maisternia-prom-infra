/** ENG-29 — «Перенести затверджені» (кнопка таблиці TEST): запис за планом src/core/transfer-approved.mjs через шлюз W2.
 *
 *  Порядок (кожен крок — за ключем Offer ID / «ID події», ідемпотентний; після збою наступний запуск продовжує за тим самим планом):
 *   0. контрольний план у сховищі W2 ДО першого запису (без нього — нічого не пишемо);
 *   1. «Основний каталог» — дописати відсутні за Offer ID (appendMissingByKey, перевірка після запису);
 *   2. «Паспорт каталогу» — як після затвердження;
 *   3. «Нові товари» — прибрати перенесені рядки: deleteByKeys зі знімком усього рядка (рядок змінено після плану → не видаляється,
 *      у підсумку; чужий рядок, що зник, — повертається зі знімка);
 *   4. «Перевірка» рядків, що не пройшли перевірку: «НЕ ПЕРЕНЕСЕНО: … колонка E «Назва UA» …» (за ключем з очікуваним значенням);
 *   5. «Журнал» — події з «ID події»;
 *   6. звірка свіжим читанням → план DONE.
 *  Незавершений план блокує інші товарні операції (openPlansGate), доки цей режим його не завершить. */
import { mtText } from "../core/text.mjs";
import { readSheet } from "../core/sync-plan.mjs";
import { SHEET, PASSPORT_HEADER, passportValues, readPassport, samePassport } from "../core/sheet-sync.mjs";
import { planTransferApproved, controlPlanOf, TRANSFER_APPROVED_KEY, rowHash } from "../core/transfer-approved.mjs";
import { enabled as ownerPriorityEnabled } from "../core/owner-priority.mjs";
import { loadPlan, savePlan, isOpen, withEventIds, appendEvents, journalIds, openPlansGate, JOURNAL_SHEET } from "./run-plan.mjs";
import { OP, ITEM } from "./safe-write/keyed-update.mjs";
import { syncControlsState } from "./sheet-sync-run.mjs";

export const TRANSFER_SHEETS = Object.freeze([SHEET.main, SHEET.queue, SHEET.deferred, SHEET.frozen, SHEET.groups]);
const t = (v) => mtText(v).trim();
const NEXT = "натисніть «Перенести затверджені» ще раз — продовження за тим самим планом (якщо шлюз просить — спершу «Звірити незавершені записи»)";

export async function transferApproved({ readBook, stamp, session, controls = null, config = null }) {
  const store = session?.gw?.store;
  if (!store?.getJsonVersioned) return { state: "BLOCKED", reason: "немає сесії шлюзу W2 — нічого не записано" };
  if (session.state !== "READY") return { state: "BLOCKED", reason: `шлюз запису: ${session.state} — спершу «Звірити незавершені записи»; нічого не записано` };
  const open = await loadPlan(store, TRANSFER_APPROVED_KEY);
  if (isOpen(open.plan)) return execute({ cp: open.plan, ver: open.version, store, session, readBook, stamp, resumed: true });
  const gate = await openPlansGate({ store, session, readBook, stamp, recover: false });
  if (gate) return { ...gate };
  const cc = await syncControlsState(controls, config);
  if (ownerPriorityEnabled(config) && (!cc || cc.blocked)) return { state: "ABORTED", reason: `стан Catalog Controls ${cc ? "недостовірний: " + ((cc.reasons || []).join("; ") || "blocked") : "не підключено"} — видалені товари неможливо відрізнити; нічого не записано` };
  const book = await readBook([...TRANSFER_SHEETS]);
  const plan = planTransferApproved({ book, stamp, cc });
  if (plan.state === "PRECONDITION_FAILED") return { state: "PRECONDITION_FAILED", reason: plan.checks.filter((c) => !c.ok).map((c) => c.name).join("; "), checks: plan.checks };
  if (plan.state === "NOTHING") return { state: "NOTHING", reason: plan.notTransferred.length ? "затверджені товари не пройшли перевірку — причини в колонці «Перевірка» (і нижче)" : "немає затверджених товарів для перенесення", moved: 0, removedFromQueue: 0, notTransferred: plan.notTransferred };
  const opId = "transfer-approved:" + stamp;
  const events = [
    [stamp, "СИСТЕМА", "", "ПЕРЕНЕСЕННЯ ЗАТВЕРДЖЕНИХ", "", plan.counts.moved, JSON.stringify({ mode: "ПЕРЕНЕСТИ ЗАТВЕРДЖЕНІ", moved: plan.counts.moved, removeFromQueue: plan.counts.removeFromQueue, notTransferred: plan.counts.notTransferred })],
    ...plan.moveRows.map((r) => [stamp, SHEET.main, t(r["Offer ID"]), "ЗАТВЕРДЖЕНО", SHEET.queue, SHEET.main, "ДОЗВОЛЕНО"]),
    ...plan.removeRows.map((x) => [stamp, SHEET.queue, x.offerId, "ПРИБРАНО З ЧЕРГИ", "", "", "ПЕРЕНЕСЕНО В «ОСНОВНИЙ КАТАЛОГ»" + (x.earlier ? " (раніше)" : "")]),
    ...plan.notTransferred.map((x) => [stamp, SHEET.queue, x.offerId, "НЕ ПЕРЕНЕСЕНО", "", "", x.problems.join("; ").slice(0, 900)]),
  ];
  let cp = controlPlanOf(plan, { stamp, opId, events: withEventIds(opId, events) });
  let ver;
  try { ver = await savePlan(store, TRANSFER_APPROVED_KEY, cp, open.version); }
  catch (e) { return { state: "BLOCKED", reason: "контрольний план не записано (сховище W2): " + mtText(e?.message || e).slice(0, 200) + " — нічого не записано" }; }
  return execute({ cp, ver, store, session, readBook, stamp, resumed: false });
}

async function execute({ cp, ver, store, session, readBook, stamp, resumed }) {
  const W = session.sheets;
  const progress = async (status) => { ver = await savePlan(store, TRANSFER_APPROVED_KEY, { ...cp, status, progressAt: stamp, ...(resumed ? { resumedAt: stamp } : {}) }, ver); cp = { ...cp, status }; };
  const done = [], conflicts = [];
  const base = { opId: cp.opId, resumed, notTransferred: cp.notTransferred };
  try {
    if (cp.moveIds.length) {
      const ar = await session.appendMissingByKey({ title: SHEET.main, rows: cp.moveValues, generation: "transfer-approved:" + cp.opId });
      if (ar.outcome !== OP.VERIFIED && ar.outcome !== OP.NOTHING) throw new Error("«Основний каталог»: " + ar.outcome);
      done.push("main");
    }
    await progress("MAIN_DONE");
    const pb = await readBook([SHEET.passport]);
    if (!samePassport(readPassport(pb[SHEET.passport]), cp.passportAfter)) {
      await W.ensureSheet(SHEET.passport, PASSPORT_HEADER.slice());
      await W.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: passportValues(cp.passportAfter, `затверджено й перенесено ${cp.counts.moved}`, cp.stamp) }]);
      done.push("passport");
    }
    await progress("PASSPORT_DONE");
    let removed = [];
    if (cp.remove.length) {
      // Свіже читання черги: рядок прибирається, лише якщо він побайтово той, що в плані (відбиток); знімок для deleteByKeys — з нього ж
      // (deleteByKeys ще раз звіряє знімок своїм читанням безпосередньо перед видаленням).
      const qNow = readSheet((await readBook([SHEET.queue]))[SHEET.queue], SHEET.queue).rows;
      const byId = new Map(qNow.map((r) => [t(r["Offer ID"]), r]));
      const gone = [], todo = [];
      for (const x of cp.remove) {
        const r = byId.get(x.offerId);
        if (!r) gone.push(x.offerId);
        else if (rowHash(r, cp.queueHeader) !== x.hash) conflicts.push({ offerId: x.offerId, why: "рядок «Нових товарів» змінено після планування — не прибрано (товар уже в «Основному каталозі»)" });
        else todo.push({ key: x.offerId, expect: Object.fromEntries(cp.queueHeader.filter(Boolean).map((k) => [k, mtText(r[k] ?? "")])) });
      }
      removed = gone;
      if (todo.length) {
        const dr = await session.deleteByKeys({ title: SHEET.queue, rows: todo, generation: "transfer-approved-remove:" + cp.opId });
        const failed = (dr.items || []).filter((x) => x.status === ITEM.NOT_APPLIED || x.status === "PENDING");
        if (![OP.VERIFIED, OP.NOTHING, OP.NOT_APPLIED].includes(dr.outcome) || failed.length) throw new Error("«Нові товари» (прибрати перенесені): " + dr.outcome + (failed.length ? `; не видалено ${failed.length}` : ""));
        for (const x of dr.items || []) if (x.status === ITEM.CONFLICT) conflicts.push({ offerId: x.key, why: "рядок «Нових товарів» змінено під час операції — не прибрано (товар уже в «Основному каталозі»)" });
        removed = [...removed, ...(dr.items || []).filter((x) => x.status === ITEM.VERIFIED || x.status === ITEM.ALREADY).map((x) => x.key)];
      }
      done.push("queueRemove");
    }
    await progress("QUEUE_DONE");
    if (cp.marks.length) {
      const qr = await session.updateByKey({ title: SHEET.queue, changes: cp.marks.map((m) => ({ key: m.offerId, expect: { "Перевірка": m.expect }, set: { "Перевірка": m.set } })), generation: "transfer-approved-marks:" + cp.opId });
      if (![OP.VERIFIED, OP.NOTHING, OP.NOT_APPLIED].includes(qr.outcome)) throw new Error("«Перевірка» неперенесених: " + qr.outcome);
      done.push("marks");
    }
    await progress("MARKS_DONE");
    const jr = await appendEvents({ session, journalValues: (await readBook([JOURNAL_SHEET]))[JOURNAL_SHEET], rows: cp.events, generation: "journal:" + cp.opId });
    if (!jr.ok) throw new Error("«Журнал»: " + jr.outcome);
    done.push("journal");
    // Звірка свіжим читанням.
    const after = await readBook([SHEET.main, SHEET.queue, SHEET.passport, JOURNAL_SHEET]);
    const main = readSheet(after[SHEET.main], SHEET.main).rows, q = readSheet(after[SHEET.queue], SHEET.queue).rows;
    const ids = main.map((r) => t(r["Offer ID"])), byId = new Map(main.map((r) => [t(r["Offer ID"]), r]));
    const target = new Map(cp.moveIds.map((id, i) => [id, rowHash(Object.fromEntries(cp.mainHeader.map((k, j) => [k, cp.moveValues[i][j]])), cp.mainHeader)]));
    const changedAfter = cp.moveIds.filter((id) => byId.has(id) && rowHash(byId.get(id), cp.mainHeader) !== target.get(id));
    const conflictIds = new Set(conflicts.map((c) => c.offerId)), qIds = new Set(q.map((r) => t(r["Offer ID"])));
    const journal = journalIds(after[JOURNAL_SHEET]);
    const verify = {
      uniqueIds: new Set(ids).size === ids.length,
      allMovedPresent: cp.moveIds.every((id) => byId.has(id)),
      movedIdentical: changedAfter.length === 0,
      queueRemoved: cp.remove.every((x) => conflictIds.has(x.offerId) || !qIds.has(x.offerId)),
      passportOk: samePassport(readPassport(after[SHEET.passport]), cp.passportAfter),
      journalOk: cp.events.every((r) => journal.has(t(r[7]))),
    };
    // Після продовження рядок каталогу міг змінити власник (між збоєм і продовженням) — це не помилка запису, лише попередження.
    const ok = verify.uniqueIds && verify.allMovedPresent && verify.queueRemoved && verify.journalOk && (verify.movedIdentical || resumed) && (verify.passportOk || resumed);
    if (!ok) throw Object.assign(new Error("звірка після запису не пройдена"), { verify });
    await progress("DONE");
    return { state: "TRANSFERRED", moved: cp.counts.moved, count: main.length, removedFromQueue: removed.length, conflicts, verify, warnings: resumed && changedAfter.length ? [`після продовження ${changedAfter.length} перенесених карток уже змінено в «Основному каталозі»`] : [], ...base };
  } catch (e) {
    return { state: "INCOMPLETE", error: mtText(e?.message || e).slice(0, 300), done, verify: e?.verify, conflicts, next: NEXT, ...base };
  }
}
