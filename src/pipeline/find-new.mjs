/** ENG-28c — «Знайти нові товари» (окрема кнопка; рішення власника 01.11.2026: три незалежні операції, жодна не запускає іншу).
 *
 *  1. Актуальний повний YML постачальника (завантажує викликач) → знімок: цілісність (обірваний документ / дублі ID → ABORTED),
 *     повнота й свіжість (proveComplete проти попереднього знімка цієї операції або підтвердженого «Оновити товари»; повтор тим самим
 *     фідом — допустимий: нових просто немає), охоплення (group_ids тощо → лише охоплені групи; «усі новинки постачальника» — лише
 *     за повним фідом без фільтра).
 *  2. Нові ID = ID фіду, яких немає в «Основному каталозі», «Нових товарах», «Відкладених», «Видалених товарах», «Заморожених ID»
 *     (відхилені власником) і серед видалених власником (Catalog Controls). Відхилені / видалені власником не відновлюються.
 *  3. Стабільність: новинка була в попередньому знімку (цієї операції або підтвердженому) з тим самим відбитком; решта — «чекає».
 *  4. Стабільні повні — наявним intake (сесія «intake»): лише «Нові товари» + «Журнал»; повторна перевірка за повним XML
 *     (verifyReady), без дублів (appendMissingByKey); статус «НОВИЙ_ВІД_ПОСТАЧАЛЬНИКА» — не перевірено й не погоджено;
 *     перенесення в «Основний каталог» — лише наступним рішенням власника.
 *  5. Знімок цієї операції зберігається (умовний запис) — база стабільності наступного запуску.
 *  Основний каталог, ціни, наявність і характеристики наявних товарів не змінюються (політика запису режиму find-new цього й не
 *  дозволяє: лише «Нові товари» й «Журнал»). */
import { parseSupplierText } from "../core/supplier-feed.mjs";
import { extractFullOffers, SHEET } from "../core/sheet-sync.mjs";
import { scanFeed, completeness, watchFingerprint } from "../core/intake.mjs";
import { snapshotFromXml, proveComplete, CONFIRMED_SNAPSHOT_KEY, feedScopeOf } from "../core/supplier-presence.mjs";
import { ARCHIVE_SHEET } from "../core/archive.mjs";
import { mtText } from "../core/text.mjs";
import { CONFIRMED_FILTERED_SNAPSHOT_KEY, FULL_FEED_MAX_CHARS } from "./update-products.mjs";
import { intakeSheet, syncControlsState } from "./sheet-sync-run.mjs";
import { openPlansGate } from "./run-plan.mjs";

/** Знімок останнього запуску «Знайти нові товари» (база стабільності); окремо від підтвердженого знімка «Оновити товари». */
export const FIND_NEW_SEEN_KEY = "state/supplier-snapshot/find-new-seen.json";
const brief = (s) => (s ? { id: s.id, feedDate: s.feedDate, scope: s.scope, count: s.count } : null);
const time = (s) => Date.parse(s?.fetchedAt || s?.confirmedAt || "") || 0;

export async function findNewProducts({ sheets, readBook, xml, source = "", fetchedAt = "", stamp, now, config, profile = "medium", catalog = null, controls = null, snapshotStore, session = null }) {
  if (!snapshotStore?.getJsonVersioned || !snapshotStore?.putJsonIfVersion) return { state: "BLOCKED", reason: "немає сховища знімків з умовним записом (W2)" };
  // ENG-28d: незавершене перенесення або незавершений товарний запуск — спершу їхнє відновлення; пошук новинок нічого не пише.
  if (session?.gw?.store?.getJsonVersioned) { const gate = await openPlansGate({ store: session.gw.store, session, readBook, stamp, recover: false }); if (gate) return { ...gate, report: null }; }
  let snapshot;
  try { snapshot = snapshotFromXml(xml, { source, fetchedAt, scope: feedScopeOf(source) }); }
  catch (e) { return { state: "ABORTED", reason: "фід постачальника пошкоджений або обірваний: " + mtText(e?.message || e) + "; нічого не записано" }; }
  const seenRec = await snapshotStore.getJsonVersioned(FIND_NEW_SEEN_KEY);
  const seen = seenRec?.value || null;
  const confirmed = (await snapshotStore.getJsonVersioned(snapshot.scope === "full" ? CONFIRMED_SNAPSHOT_KEY : CONFIRMED_FILTERED_SNAPSHOT_KEY))?.value || null;
  const base = time(seen) >= time(confirmed) ? seen || confirmed : confirmed;
  // Повнота / свіжість / падіння кількості — як у «Оновити товари»; «той самий знімок» тут не помилка (нових просто немає).
  const proof = proveComplete(snapshot, { previous: base, now, supplierConfig: config.supplier });
  const problems = proof.reasons.filter((r) => !/той самий знімок/.test(r));
  if (problems.length) return { state: "ABORTED", reason: "фід не пройшов перевірку (нічого не записано): " + problems.join("; "), snapshot: brief(snapshot), previous: brief(base) };
  let parsed;
  try { parsed = await parseSupplierText(xml, { maximumChars: FULL_FEED_MAX_CHARS, identityFields: true }); }
  catch (e) { return { state: "ABORTED", reason: "повний фід постачальника не розібрано: " + mtText(e?.message || e) + "; нічого не записано", snapshot: brief(snapshot) }; }

  // Звірка з таблицею: чому ID фіду не новий (для звіту) — основний каталог, черга, відкладені, видалені, відхилені, видалені власником.
  const ccState = await syncControlsState(controls, config);
  const book = await readBook([SHEET.main, SHEET.queue, SHEET.deferred, SHEET.frozen, ARCHIVE_SHEET]);
  // ID — за заголовком (Offer ID / ID постачальника): аркуші різного формату (архів, відкладені) читаються однаково.
  const idsOf = (name) => {
    const v = book[name];
    if (!v?.length) return new Set();
    const h = (v[0] || []).map(mtText), ko = h.indexOf("Offer ID"), ks = h.indexOf("ID постачальника");
    return new Set(v.slice(1).flatMap((r) => [ko >= 0 ? mtText(r?.[ko]) : "", ks >= 0 ? mtText(r?.[ks]) : ""]).filter(Boolean));
  };
  const known = { main: idsOf(SHEET.main), queue: idsOf(SHEET.queue), deferred: idsOf(SHEET.deferred), archived: idsOf(ARCHIVE_SHEET),
    rejected: new Set((book[SHEET.frozen] || []).slice(1).map((r) => mtText(r?.[0])).filter(Boolean)), removedByOwner: new Set(ccState?.removed || []) };
  const excluded = { queue: 0, deferred: 0, archived: 0, rejected: 0, removedByOwner: 0 };
  const fresh = [];
  for (const id of snapshot.ids) {
    if (known.main.has(id)) continue;
    const why = ["queue", "deferred", "archived", "rejected", "removedByOwner"].find((k) => known[k].has(id));
    if (why) { excluded[why]++; continue; }
    fresh.push(id);
  }
  const scan = fresh.length ? scanFeed(xml, (id) => fresh.includes(id)) : { offers: new Map() };
  const ready = [], incomplete = [];
  for (const id of fresh) (completeness(scan.offers.get(id) || {}).length ? incomplete : ready).push(id);
  const stableIn = (s, id) => Boolean(s?.fp?.[id]) && s.fp[id] === snapshot.fp?.[id];
  // ENG-29 (рішення власника 02.11): стабільність — від ПЕРШОГО виявлення без змін. Попередній знімок зберігає since[id] (коли товар
  // уперше побачено з цим самим відбитком); повторні натискання його не скидають. Береться найраніший із підтверджених моментів:
  // since попереднього знімка, сам попередній знімок, підтверджений знімок «Оновити товари». Змінився відбиток — відлік з нуля.
  const sinceOf = (id) => {
    const at = [];
    if (stableIn(seen, id)) { at.push(seen.since?.[id], seen.fetchedAt); }
    if (stableIn(confirmed, id)) at.push(confirmed?.fetchedAt || confirmed?.confirmedAt);
    const ok = at.filter((t) => Number.isFinite(Date.parse(t || "")));
    return ok.length ? ok.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : stamp;
  };
  const stable = ready.filter((id) => stableIn(seen, id) || stableIn(confirmed, id));
  const candidates = stable.map((id) => ({ id, fp: watchFingerprint(scan.offers.get(id), profile), firstSeen: sinceOf(id), lastChange: sinceOf(id) }));

  let intake = null;
  if (candidates.length) {
    intake = await intakeSheet({ sheets, readBook, parsed, fetchFull: async (ids) => extractFullOffers(xml, ids), stamp, config, now, ready: candidates, profile, catalog, controls, session, feedScope: snapshot.scope });
  }
  // Знімок цієї операції — база стабільності наступного запуску; лише якщо intake завершився штатно (інакше — повтор із тією самою базою).
  let seenSaved = false, seenError = null;
  if (!intake || ["INTAKE_DONE", "NOTHING_TO_WRITE"].includes(intake.state)) {
    // since — момент першого виявлення (з тим самим відбитком) для нових ID цього знімка; лише для нових (не для всього каталогу).
    const since = Object.fromEntries(fresh.map((id) => [id, sinceOf(id)]));
    try { await snapshotStore.putJsonIfVersion(FIND_NEW_SEEN_KEY, { ...snapshot, seenAt: stamp, since }, seenRec?.version ?? null); seenSaved = true; }
    catch (e) { seenError = e?.code === "CONFLICT" ? "знімок записано паралельно іншим запуском — повтор наступного запуску" : mtText(e?.message || e).slice(0, 200); }
  }
  const results = intake?.stats?.results || {};
  const state = intake ? intake.state : fresh.length ? (ready.length ? "WAITING_STABILITY" : "NOTHING_COMPLETE") : "NOTHING_NEW";
  const report = {
    state, feed: brief(snapshot), base: brief(base),
    scope: { scope: snapshot.scope, by: snapshot.scopeBy || [], note: snapshot.scope === "full" ? "" : "фід із фільтром охоплення: знайдено лише новинки охоплених груп; «усі новинки постачальника» — лише за підтвердженим повним фідом (allcats)" },
    found: { total: fresh.length, complete: ready.length, incomplete: incomplete.length, stable: stable.length, waiting: ready.length - stable.length },
    excluded,
    intake: intake ? { state: intake.state, reason: intake.reason ?? "", added: intake.stats?.added ?? 0, results, possibleDuplicates: intake.stats?.possibleDuplicates ?? 0 } : null,
    seenSaved, seenError,
  };
  return { state, reason: intake?.reason ?? (state === "WAITING_STABILITY" ? `нові ID чекають стабільності (${ready.length}): додаються, коли пробудуть у фіді без змін ≥ 10 хв від першого виявлення — наступне натискання пізніше` : ""), report, intake, newIds: { stable, waiting: ready.filter((id) => !stable.includes(id)), incomplete } };
}
