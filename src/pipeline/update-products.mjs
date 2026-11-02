/** ENG-28 — рушій кнопки «Оновити товари» (контрольована синхронізація з актуальним ПОВНИМ сирим YML постачальника).
 *
 *  Порядок (доручення власника 01.11.2026, розд. 1):
 *   1. Знімок повного фіду (обірваний / пошкоджений → ABORTED) і доказ повноти проти ОСТАННЬОГО ПІДТВЕРДЖЕНОГО знімка
 *      (не повний, неповний, старий, той самий → ABORTED, жодних записів і жодних масових позначок).
 *   2. syncSheet (наявна синхронізація): ціни за чинними правилами, наявність, зміни сирих полів (пріоритет власника, SEO не
 *      переписується), рішення черги, захисні правила Catalog Controls, + присутність у фіді постачальника (presence):
 *      «ВИДАЛЕНИЙ_У_ПОСТАЧАЛЬНИКА» / повернення / «ВІДСУТНІЙ_У_ЗНІМКУ»; аномальне зникнення → HOLD до будь-якого запису.
 *   3. Нові товари — підсумок ID, яких немає в таблиці (повні / неповні картки); черга формується НАЯВНИМ intake (окрема сесія).
 *   4. Знімок стає підтвердженим лише після успішного запису без HOLD, коли всі позначки присутності записано (умовний запис
 *      за версією: паралельне підтвердження → CONFLICT, повтор наступного запуску).
 *  Нічого не публікує (YML / Prom / R2). Правило наявності для майбутнього експорту — exportAvailability (supplier-presence.mjs).
 *
 *  ENG-28b (рішення власника 01.11): характеристики основного каталогу лише зберігаються (productionConfig → «preserve»); зміни сирих
 *  <param> постачальника виявляються й потрапляють у звіт. Новинки: стабільні (у попередньому підтвердженому знімку з тим самим
 *  відбитком) передаються НАЯВНОМУ intake окремою сесією (updateProductsRun). Підсумковий звіт — report (п. 1–10 доручення). */
import { parseSupplierText } from "../core/supplier-feed.mjs";
import { extractFullOffers } from "../core/sheet-sync.mjs";
import { scanFeed, completeness, watchFingerprint } from "../core/intake.mjs";
import { snapshotFromXml, proveComplete, CONFIRMED_SNAPSHOT_KEY, feedScopeOf } from "../core/supplier-presence.mjs";
/** ENG-28a: знімок фіду з фільтром охоплення підтверджується окремо — він не може бути базою для «видалений у постачальника». */
export const CONFIRMED_FILTERED_SNAPSHOT_KEY = "state/supplier-snapshot/confirmed-filtered.json";
/** ENG-28a: межа розміру ПОВНОГО сирого фіду (з фото й описами, ~80 МБ) — як у завантажувача повного фіду (tools/sheet-sync:
 *  maxBytes 300 000 000), а не config.supplier.maximumChars (45 000 000 — межа ОПЕРАЦІЙНОГО фіду, як у Code.gs). */
export const FULL_FEED_MAX_CHARS = 300_000_000;
import { syncSheet } from "./sheet-sync-run.mjs";
import { mtText } from "../core/text.mjs";

const brief = (s) => (s ? { id: s.id, feedDate: s.feedDate, kind: s.kind, count: s.count, source: s.source } : null);

/** snapshotStore — сховище стану W2 (FileStore / MemoryStore): getJsonVersioned / putJsonIfVersion. */
export async function updateProducts({ sheets, readBook, xml, source = "", fetchedAt = "", stamp, now, config, profile = "medium", catalog = null, session = null, contract = null, controls = null, snapshotStore, fullMaxChars = FULL_FEED_MAX_CHARS, writeBudget = null }) {
  if (!snapshotStore?.getJsonVersioned || !snapshotStore?.putJsonIfVersion) return { state: "BLOCKED", reason: "немає сховища знімків з умовним записом (W2)" };
  let snapshot;
  const scope = feedScopeOf(source);
  const KEY = scope.scope === "full" ? CONFIRMED_SNAPSHOT_KEY : CONFIRMED_FILTERED_SNAPSHOT_KEY;
  try { snapshot = snapshotFromXml(xml, { source, fetchedAt, scope }); }
  catch (e) { return { state: "ABORTED", reason: "фід постачальника пошкоджений або обірваний: " + mtText(e?.message || e) }; }
  const prev = await snapshotStore.getJsonVersioned(KEY);
  const previous = prev?.value || null;
  if (previous && previous.id === snapshot.id) return { state: "NO_CHANGES", reason: "фід не змінився з останнього підтвердженого знімка — нічого не записано", snapshot: brief(snapshot), previous: brief(previous) };
  const proof = proveComplete(snapshot, { previous, now, supplierConfig: config.supplier });
  if (!proof.complete) return { state: "ABORTED", reason: "повноту повного фіду не доведено: " + proof.reasons.join("; "), snapshot: brief(snapshot), previous: brief(previous), proof };
  let parsed;
  try { parsed = await parseSupplierText(xml, { maximumChars: fullMaxChars, identityFields: true }); }
  catch (e) { return { state: "ABORTED", reason: "повний фід постачальника не розібрано: " + mtText(e?.message || e) + "; нічого не записано", snapshot: brief(snapshot), previous: brief(previous), proof }; }
  // ENG-28c (рішення власника: три незалежні операції): «Оновити товари» не чіпає «Нові товари» — ні новинок, ні рішень черги
  // (перенесення / затвердження / відхилення / прив'язки), ні сирих даних черги (queueMode "off").
  const sync = await syncSheet({ sheets, readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp, config, now, profile, catalog, session, contract, controls, presence: { snapshot, previous, proof, limits: config.presence?.limits }, queueMode: "off", writeBudget });
  // Нові товари: ID у повному фіді, яких немає в таблиці (основний, черга, відкладені, заморожені) — лише підсумок для наявного intake.
  let newItems = null;
  try {
    const book = await readBook(["Основний каталог", "Нові товари", "Відкладені товари", "Заморожені ID"]);
    const known = new Set();
    for (const v of Object.values(book)) {
      const h = (v?.[0] || []).map(mtText), ko = h.indexOf("Offer ID"), ks = h.indexOf("ID постачальника");
      for (const r of (v || []).slice(1)) { if (ko >= 0 && mtText(r[ko])) known.add(mtText(r[ko])); if (ks >= 0 && mtText(r[ks])) known.add(mtText(r[ks])); }
    }
    const fresh = snapshot.ids.filter((id) => !known.has(id));
    const scan = fresh.length ? scanFeed(xml, (id) => fresh.includes(id)) : { offers: new Map() };
    const ready = [], incomplete = [];
    for (const id of fresh) { const miss = completeness(scan.offers.get(id) || {}); (miss.length ? incomplete : ready).push(id); }
    // ENG-28b: стабільність — новинка була в ПОПЕРЕДНЬОМУ підтвердженому знімку з тим самим відбитком (не змінювалась між запусками);
    // кандидати для наявного intake (verifyReady перевіряє ще раз: час, відбиток, повноту). Решта — чекає наступного запуску.
    const since = previous ? previous.fetchedAt || previous.confirmedAt || "" : "";
    const stable = ready.filter((id) => previous?.fp?.[id] && previous.fp[id] === snapshot.fp?.[id]);
    const candidates = stable.map((id) => ({ id, fp: watchFingerprint(scan.offers.get(id), profile), firstSeen: since, lastChange: since }));
    newItems = { total: fresh.length, ready, incomplete: incomplete.length, candidates, waiting: ready.length - stable.length, scope: snapshot.scope, note: snapshot.scope === "full" ? "" : "фід із фільтром охоплення: новинки — лише в межах охоплених груп; для всього каталогу — лише за повним фідом" };
  } catch (e) { newItems = { error: mtText(e?.message || e).slice(0, 200) }; }
  let confirmed = false, confirmError = null;
  if (["SYNCED", "CONFLICT_OWNER_EDIT"].includes(sync.state) && sync.presence?.decision === "APPLY" && sync.presence.applied) {
    try { await snapshotStore.putJsonIfVersion(KEY, { ...snapshot, confirmedAt: stamp, previousSnapshotId: previous?.id ?? null }, prev?.version ?? null); confirmed = true; }
    catch (e) { confirmError = e?.code === "CONFLICT" ? "знімок підтверджено паралельно іншим запуском — повтор наступного запуску" : mtText(e?.message || e).slice(0, 200); }
  }
  const result = { state: sync.state, reason: sync.reason, sync, presence: sync.presence ?? null, snapshot: brief(snapshot), previous: brief(previous), proof, newItems, confirmed, confirmError };
  result.report = updateReport(result);
  Object.defineProperty(result, "parsed", { value: parsed, enumerable: false }); // для intake того самого фіду (без повторного розбору)
  return result;
}

/** ENG-28b: підсумковий звіт «Оновити товари» (п. 10 доручення): ціни, наявність, поза обсягом, новинки, зміни постачальника,
 *  відсутні, конфлікти, HOLD. Лише агрегати й Offer ID змін (без значень і без адреси фіду). */
export function updateReport(r, intake = null) {
  const s = r.sync || {}, st = s.stats || {}, m = st.main || {}, raw = st.mainRaw || {}, p = r.presence || {};
  return {
    state: r.state, reason: r.reason ?? "", feed: r.snapshot ? { id: r.snapshot.id, date: r.snapshot.feedDate, offers: r.snapshot.count } : null, scope: r.newItems?.scope ?? null,
    // ENG-29: підсумок для власника — скільки товарів змінено і скільки з попередженнями постачальника (деталі — аркуш «Попередження постачальника»).
    products: { changed: m.changedProducts ?? null, withWarnings: s.ownerPriority?.productsWithWarnings ?? 0, warnings: s.ownerPriority?.warnings ?? 0, warningsRecorded: s.ownerPriority?.warningsRecorded ?? null },
    prices: { supplierPriceChanged: m.supplierPriceChanged ?? 0, salePriceChanged: m.salePriceChanged ?? 0 },
    availability: { changed: m.availabilityChanged ?? 0, becameAvailable: m.becameAvailable ?? 0, becameUnavailable: m.becameUnavailable ?? 0 },
    outOfFeedScope: st.outOfFeedScope ?? 0,
    newItems: r.newItems ? { total: r.newItems.total ?? 0, complete: (r.newItems.ready || []).length, incomplete: r.newItems.incomplete ?? 0, candidates: (r.newItems.candidates || []).length, waiting: r.newItems.waiting ?? 0, addedToQueue: intake?.stats?.added ?? 0, intake: intake?.state ?? null } : null,
    supplierChanges: { rows: raw.changed ?? 0, identity: raw.identity ?? 0, photos: raw.photos ?? 0, params: raw.supplierParams ?? 0, paramsOfferIds: (s.supplierParamChanges || []).map((x) => x.offerId), characteristics: raw.characteristics ?? null, characteristicsChanged: raw.params ?? 0, frozenPending: s.frozenPending || [] },
    presence: { decision: p.decision ?? null, gone: p.gone ?? 0, returned: p.returned ?? 0, absentInSnapshot: p.absent ?? 0, outOfScope: p.outOfScope ?? 0 },
    conflicts: { isolated: (s.ownerPriority?.isolated || []).length, decisionsRefused: (s.decisionRefused || []).length, ownerEditConflict: r.state === "CONFLICT_OWNER_EDIT" },
    hold: r.state === "HOLD_SUPPLIER_DISAPPEARANCE" ? { reason: r.reason, affected: s.block?.affected ?? null, limit: s.block?.limit ?? null } : null,
    // ENG-28c: черга не змінюється; рішення власника в черзі чекають окремої команди. Службові рядки (М2 / М3) і бюджет запису (М1).
    queue: { touched: false, pendingDecisions: s.queueUpdate?.pendingDecisions ?? 0 },
    serviceRows: s.ownerPriority ? { classification: s.ownerPriority.classifyRecorded, warnings: s.ownerPriority.warningsRecorded, warningsPlanned: s.ownerPriority.warnings } : null,
    budget: s.preflight ? { estimate: s.preflight.estimate, available: s.preflight.available, ok: s.preflight.ok } : (s.block?.type === "БЮДЖЕТ ЗАПИСУ" ? { estimate: Number(s.block.affected), available: Number(s.block.limit), ok: false } : null),
    // ENG-28d: відновлення журналу незавершеного попереднього запуску на початку цього запуску; повнота «Журналу» цього запуску.
    recovery: s.recovery ? { state: s.recovery.state, reason: s.recovery.reason ?? "", appended: s.recovery.appended ?? 0, partial: s.recovery.partial ?? false } : null,
    journal: s.journal ? { ok: s.journal.ok, planned: s.journal.planned ?? null, outcome: s.journal.outcome ?? null } : null,
  };
}

/** «Оновити товари» (кнопка): синхронізація основного каталогу (сесія «sync») → підсумковий звіт. openSession(writer) — сесія шлюзу
 *  W2 (CLI); без неї — як у тестах (у пам'яті).
 *  ENG-28c (рішення власника: три незалежні операції): новинки в чергу НЕ додаються — лише окремою командою «Знайти нові товари»
 *  (find-new.mjs); тут нові ID — лише в аналітичному підсумку (report.newItems). Параметр intake прийнято лише для сумісності й
 *  проігноровано (true → попередження у звіті). */
export async function updateProductsRun({ openSession = null, intake = false, ...o }) {
  const s1 = openSession ? await openSession("sync") : null;
  let r;
  try { r = await updateProducts({ ...o, session: s1 ?? o.session ?? null }); }
  finally { await s1?.close?.().catch(() => {}); }
  const out = { ...r, intake: null, ...(intake === true ? { intakeIgnored: "новинки в чергу додає лише окрема команда «Знайти нові товари» (--mode=find-new)" } : {}) };
  out.report = updateReport(r, null);
  return out;
}
