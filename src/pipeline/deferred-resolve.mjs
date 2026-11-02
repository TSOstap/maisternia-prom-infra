/** ENG-29 — розбір «Відкладених товарів» (рішення власника 03.11) через шлюз W2: план src/core/deferred-resolve.mjs.
 *  Порядок (кожен крок — за ключем, ідемпотентний; після збою той самий режим продовжує за планом у W2):
 *   0. контрольний план у W2 ДО першого запису;
 *   1. «Основний каталог» — дописати повернені картки (appendMissingByKey);
 *   2. «Паспорт каталогу»;
 *   3. «Видалені товари» — створити аркуш (якщо немає) і дописати відсутні у фіді (appendMissingByKey);
 *   4. «Відкладені товари» — прибрати перенесені рядки (deleteByKeys зі знімком; змінений після плану — не прибирається);
 *   5. «Журнал»; 6. звірка свіжим читанням → DONE.
 *  planOnly — лише план (нічого не пише). */
import { mtText } from "../core/text.mjs";
import { readSheet } from "../core/sync-plan.mjs";
import { SHEET, PASSPORT_HEADER, passportValues, readPassport, samePassport } from "../core/sheet-sync.mjs";
import { parseSupplierText } from "../core/supplier-feed.mjs";
import { extractFullOffers } from "../core/sheet-sync.mjs";
import { planDeferred, deferredControlPlan, DEFERRED_PLAN_KEY, rowHash } from "../core/deferred-resolve.mjs";
import { ARCHIVE_SHEET } from "../core/archive.mjs";
import { loadPlan, savePlan, isOpen, withEventIds, appendEvents, journalIds, openPlansGate, JOURNAL_SHEET } from "./run-plan.mjs";
import { OP, ITEM } from "./safe-write/keyed-update.mjs";

export const DEFERRED_SHEETS = Object.freeze([SHEET.main, SHEET.deferred, ARCHIVE_SHEET, SHEET.groups]);
const t = (v) => mtText(v).trim();

export async function resolveDeferred({ readBook, xml, stamp, session = null, config, planOnly = false }) {
  const store = session?.gw?.store;
  if (!planOnly) {
    if (!store?.getJsonVersioned) return { state: "BLOCKED", reason: "немає сесії шлюзу W2 — нічого не записано" };
    if (session.state !== "READY") return { state: "BLOCKED", reason: `шлюз запису: ${session.state}; нічого не записано` };
    const open = await loadPlan(store, DEFERRED_PLAN_KEY);
    if (isOpen(open.plan)) return execute({ cp: open.plan, ver: open.version, store, session, readBook, stamp, resumed: true });
    const gate = await openPlansGate({ store, session, readBook, stamp, recover: false });
    if (gate) return { ...gate };
  }
  let parsed;
  try { parsed = await parseSupplierText(xml, { maximumChars: 300_000_000, identityFields: true }); }
  catch (e) { return { state: "ABORTED", reason: "фід постачальника не розібрано: " + mtText(e?.message || e).slice(0, 200) + "; нічого не записано" }; }
  if (parsed.count < (config?.supplier?.minimumOffers ?? 0)) return { state: "ABORTED", reason: `у фіді ${parsed.count} товарів — менше мінімуму ${config.supplier.minimumOffers}; повноту не доведено, нічого не записано` };
  const book = await readBook([...DEFERRED_SHEETS]);
  const sids = (readSheet(book[SHEET.deferred] || [[]], SHEET.deferred).rows || []).map((r) => t(r["ID постачальника"])).filter((x) => parsed.offers.has(x));
  const plan = planDeferred({ book, parsed, fullById: extractFullOffers(xml, sids), stamp, pricing: config.pricing });
  const brief = { counts: plan.counts, keep: plan.keep, toMain: (plan.moveRows || []).map((r) => t(r["Offer ID"])), toArchive: (plan.archiveRows || []).map((r) => t(r["Offer ID"])) };
  if (plan.state === "PRECONDITION_FAILED") return { state: "PRECONDITION_FAILED", reason: plan.checks.filter((c) => !c.ok).map((c) => c.name).join("; ") };
  if (plan.state === "NOTHING") return { state: "NOTHING", reason: plan.reason || "нічого переносити", ...brief };
  if (planOnly) return { state: "PLANNED", ...brief };
  const opId = "deferred-resolve:" + stamp;
  const events = [
    [stamp, "СИСТЕМА", "", "ВІДКЛАДЕНІ ТОВАРИ РОЗІБРАНО", "", plan.counts.toMain, JSON.stringify({ toMain: plan.counts.toMain, toArchive: plan.counts.toArchive, keep: plan.counts.keep })],
    ...plan.moveRows.map((r) => [stamp, SHEET.main, t(r["Offer ID"]), "ПОВЕРНУТО З ВІДКЛАДЕНИХ", SHEET.deferred, SHEET.main, "ДОЗВОЛЕНО; дані постачальника, ціни й наявність — з фіду"]),
    ...plan.archiveRows.map((r) => [stamp, ARCHIVE_SHEET, t(r["Offer ID"]), "ВИДАЛЕНО", SHEET.deferred, ARCHIVE_SHEET, "немає у фіді постачальника (ID, артикул, назва)"]),
  ];
  let cp = deferredControlPlan(plan, { stamp, opId, events: withEventIds(opId, events) });
  let ver;
  try { ver = await savePlan(store, DEFERRED_PLAN_KEY, cp, (await loadPlan(store, DEFERRED_PLAN_KEY)).version); }
  catch (e) { return { state: "BLOCKED", reason: "контрольний план не записано (W2): " + mtText(e?.message || e).slice(0, 200) + " — нічого не записано" }; }
  return execute({ cp, ver, store, session, readBook, stamp, resumed: false });
}

async function execute({ cp, ver, store, session, readBook, stamp, resumed }) {
  const W = session.sheets;
  const progress = async (status) => { ver = await savePlan(store, DEFERRED_PLAN_KEY, { ...cp, status, progressAt: stamp, ...(resumed ? { resumedAt: stamp } : {}) }, ver); cp = { ...cp, status }; };
  const done = [], conflicts = [];
  const base = { opId: cp.opId, resumed, keep: cp.keep, counts: cp.counts };
  try {
    if (cp.moveIds.length) {
      const ar = await session.appendMissingByKey({ title: SHEET.main, rows: cp.moveValues, generation: "deferred-main:" + cp.opId });
      if (ar.outcome !== OP.VERIFIED && ar.outcome !== OP.NOTHING) throw new Error("«Основний каталог»: " + ar.outcome);
      done.push("main");
    }
    await progress("MAIN_DONE");
    const pb = await readBook([SHEET.passport]);
    if (!samePassport(readPassport(pb[SHEET.passport]), cp.passportAfter)) {
      await W.ensureSheet(SHEET.passport, PASSPORT_HEADER.slice());
      await W.updateRanges([{ title: SHEET.passport, row: 1, col: 1, values: passportValues(cp.passportAfter, `повернуто з «Відкладених товарів» ${cp.moveIds.length}`, cp.stamp) }]);
      done.push("passport");
    }
    await progress("PASSPORT_DONE");
    if (cp.archiveIds.length) {
      await W.ensureSheet(ARCHIVE_SHEET, cp.archHeader.slice());
      const ar = await session.appendMissingByKey({ title: ARCHIVE_SHEET, rows: cp.archiveValues, generation: "deferred-archive:" + cp.opId });
      if (ar.outcome !== OP.VERIFIED && ar.outcome !== OP.NOTHING) throw new Error("«Видалені товари»: " + ar.outcome);
      done.push("archive");
    }
    await progress("ARCHIVE_DONE");
    let removed = [];
    if (cp.remove.length) {
      const dNow = readSheet((await readBook([SHEET.deferred]))[SHEET.deferred] || [[]], SHEET.deferred).rows;
      const byId = new Map(dNow.map((r) => [t(r["Offer ID"]), r]));
      const todo = [];
      for (const x of cp.remove) {
        const r = byId.get(x.offerId);
        if (!r) removed.push(x.offerId);
        else if (rowHash(r, cp.defHeader) !== x.hash) conflicts.push({ offerId: x.offerId, why: "рядок «Відкладених товарів» змінено після планування — не прибрано (товар уже перенесено)" });
        else todo.push({ key: x.offerId, expect: Object.fromEntries(cp.defHeader.filter(Boolean).map((k) => [k, mtText(r[k] ?? "")])) });
      }
      if (todo.length) {
        const dr = await session.deleteByKeys({ title: SHEET.deferred, rows: todo, generation: "deferred-remove:" + cp.opId });
        const failed = (dr.items || []).filter((x) => x.status === ITEM.NOT_APPLIED || x.status === "PENDING");
        if (![OP.VERIFIED, OP.NOTHING, OP.NOT_APPLIED].includes(dr.outcome) || failed.length) throw new Error("«Відкладені товари» (прибрати перенесені): " + dr.outcome);
        for (const x of dr.items || []) if (x.status === ITEM.CONFLICT) conflicts.push({ offerId: x.key, why: "рядок змінено під час операції — не прибрано" });
        removed = [...removed, ...(dr.items || []).filter((x) => x.status === ITEM.VERIFIED || x.status === ITEM.ALREADY).map((x) => x.key)];
      }
      done.push("deferredRemove");
    }
    await progress("DEFERRED_DONE");
    const jr = await appendEvents({ session, journalValues: (await readBook([JOURNAL_SHEET]))[JOURNAL_SHEET], rows: cp.events, generation: "journal:" + cp.opId });
    if (!jr.ok) throw new Error("«Журнал»: " + jr.outcome);
    done.push("journal");
    const after = await readBook([SHEET.main, SHEET.deferred, ARCHIVE_SHEET, SHEET.passport, JOURNAL_SHEET]);
    const main = readSheet(after[SHEET.main], SHEET.main).rows, ids = main.map((r) => t(r["Offer ID"]));
    const archIds = new Set(after[ARCHIVE_SHEET]?.length ? readSheet(after[ARCHIVE_SHEET], ARCHIVE_SHEET).rows.map((r) => t(r["Offer ID"])) : []);
    const defIds = new Set(after[SHEET.deferred]?.length ? readSheet(after[SHEET.deferred], SHEET.deferred).rows.map((r) => t(r["Offer ID"])) : []);
    const conflictIds = new Set(conflicts.map((c) => c.offerId));
    const journal = journalIds(after[JOURNAL_SHEET]);
    const verify = {
      uniqueIds: new Set(ids).size === ids.length,
      movedPresent: cp.moveIds.every((id) => ids.includes(id)),
      archivedPresent: cp.archiveIds.every((id) => archIds.has(id)),
      deferredRemoved: cp.remove.every((x) => conflictIds.has(x.offerId) || !defIds.has(x.offerId)),
      passportOk: samePassport(readPassport(after[SHEET.passport]), cp.passportAfter),
      journalOk: cp.events.every((r) => journal.has(t(r[7]))),
    };
    const ok = verify.uniqueIds && verify.movedPresent && verify.archivedPresent && verify.deferredRemoved && verify.journalOk && (verify.passportOk || resumed);
    if (!ok) throw Object.assign(new Error("звірка після запису не пройдена"), { verify });
    await progress("DONE");
    return { state: "DEFERRED_RESOLVED", toMain: cp.moveIds, toArchive: cp.archiveIds, removedFromDeferred: removed.length, deferredLeft: defIds.size, conflicts, verify, ...base };
  } catch (e) {
    return { state: "INCOMPLETE", error: mtText(e?.message || e).slice(0, 300), done, verify: e?.verify, conflicts, next: "запустіть ту саму операцію ще раз — продовження за планом", ...base };
  }
}
