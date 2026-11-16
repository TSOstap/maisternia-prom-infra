/** «Оновити ціни й наявність» (рішення власника 03.11.2026) — вузька операція поверх шлюзу запису W2.
 *
 *  1. Брама: незавершене перенесення / розбір → BLOCKED; незавершений план товарного запуску → спершу відновлення його «Журналу»
 *     (як «Оновити товари»).
 *  2. Операційний фід (ціни / наявність, без описів і фото) → розбір, повнота й свіжість (validateFeed проти останнього
 *     підтвердженого знімка «Оновити товари»). Catalog Controls — обов'язково (інакше видалені товари не відрізнити).
 *  3. План (src/core/prices-only.mjs): лише 8 колонок LIVE; масова зміна наявності → нічого не пишемо.
 *  4. Контрольний план W2 (події «Журналу» з ID + докази клітинок) → запис ЛИШЕ змінених рядків за Offer ID з очікуваними значеннями
 *     (keyedUpdate: правка людини між читанням і записом — рядок не пишеться) → перевірка читанням → «Журнал» за «ID події».
 *  Назви, фото, характеристики, присутність, попередження — не змінюються (це «Оновити товари»). */
import { parseSupplierText, validateFeed } from "../core/supplier-feed.mjs";
import { CONFIRMED_SNAPSHOT_KEY, PRESENCE_COLUMN } from "../core/supplier-presence.mjs";
import { syncControls } from "../core/sheet-sync.mjs";
import { LIVE_COLUMNS } from "../core/sync-plan.mjs";
import { mtText } from "../core/text.mjs";
import { planPrices, MAIN_TITLE } from "../core/prices-only.mjs";
import { OP, ITEM } from "./safe-write/keyed-update.mjs";
import { RUN_PLAN_KEY, PLAN, RECOVERY_DONE, EVENT_ID_COLUMN, openPlansGate, loadPlan, savePlan, withEventIds, evidenceCell, appendEvents, JOURNAL_SHEET } from "./run-plan.mjs";
import { sheetDiscount, journalRow, syncControlsState, ccUnchanged } from "./sync-helpers.mjs";
import { PROSALE_SHEET, withProsale } from "../core/prosale.mjs";
import { PRICE_RULE_COLUMNS, MANUAL_PRICE_COLUMN, MANUAL_ANCHOR_COLUMN } from "../core/pricing.mjs";
import { recordWarnings } from "./supplier-warnings.mjs";
import { OWNER_AVAILABILITY_COLUMN } from "../core/owner-availability.mjs";
import { hybridOffers, horoshopFresh } from "../core/horoshop.mjs";

const DISCOUNT = "Знижка";
/** Колонки «Основного каталогу», потрібні плану й запису за ключем (зіставлення з offer — як mtMatch, 8 колонок LIVE, присутність). */
export const PRICE_READ_COLUMNS = Object.freeze(["Offer ID", "Категорія Prom ID", "Тариф ProSale", "ID постачальника", "Артикул постачальника", "Назва постачальника UA", "Назва постачальника RU", "URL постачальника", "Ціна власника", ...PRICE_RULE_COLUMNS, ...LIVE_COLUMNS, PRESENCE_COLUMN, OWNER_AVAILABILITY_COLUMN]);
const cellFor = (k, v) => (k === DISCOUNT ? sheetDiscount(v) : v);

/**
 * session — сесія шлюзу W2 (writer «sync», READY); readBook — свіже читання аркушів; xml — операційний фід; snapshotStore — W2;
 * readColumns(title, columns) — необов'язкове вузьке читання (Sheets API: лише потрібні колонки — у рази менше запитів), інакше readBook.
 * → { state, reason, report }
 */
export async function updatePrices({ readBook, xml, stamp, now, config, controls, session, snapshotStore, readColumns = null, horoshop = null }) {
  if (!session || session.state !== "READY") return { state: "BLOCKED", reason: `шлюз запису: ${session?.state ?? "немає сесії"} — спершу з'ясування попередніх операцій` };
  const store = session.gw?.store;
  if (!store?.getJsonVersioned) return { state: "BLOCKED", reason: "немає сховища W2 для контрольного плану" };
  let recovery = null;
  const gate = await openPlansGate({ store, session, readBook, stamp });
  if (gate && !RECOVERY_DONE.has(gate.state)) return gate;
  if (gate) recovery = gate;

  let parsed;
  try { parsed = await parseSupplierText(xml, { maximumChars: config.supplier.maximumChars, identityFields: true }); }
  catch (e) { return { state: "ABORTED", reason: "фід постачальника не розібрано: " + mtText(e?.message || e).slice(0, 200) + "; нічого не записано", recovery }; }
  const confirmed = (await snapshotStore?.getJsonVersioned?.(CONFIRMED_SNAPSHOT_KEY))?.value || null;
  try { validateFeed(parsed, confirmed?.count ?? null, now, config.supplier); }
  catch (e) { return { state: "ABORTED", reason: "фід не пройшов перевірку: " + mtText(e?.message || e) + "; нічого не записано", feed: { offers: parsed.count }, recovery }; }

  const ccState = await syncControlsState(controls, config);
  const cc = syncControls(ccState);
  if (!cc || cc.blocked) return { state: "BLOCKED", reason: "стан Catalog Controls " + (cc ? "недостовірний: " + (cc.reasons.join("; ") || "blocked") : "не підключено") + " — видалені товари неможливо відрізнити; нічого не записано", recovery };

  // Вузьке читання: «Основний каталог» — лише PRICE_READ_COLUMNS (план і запис за ключем); «Журнал» — заголовок і «ID події».
  const readMain = readColumns ? async () => ({ [MAIN_TITLE]: await readColumns(MAIN_TITLE, PRICE_READ_COLUMNS) }) : null;
  const readJournal = readColumns ? async () => ({ [JOURNAL_SHEET]: await readColumns(JOURNAL_SHEET, [EVENT_ID_COLUMN]) }) : null;
  const book = readMain ? await readMain() : await readBook([MAIN_TITLE]);
  // Рішення власника 04.11 (ProSale): тарифи категорій — з аркуша «Тарифи ProSale» (немає аркуша — без націнок; збій читання — виняток, нічого не пишеться).
  const pricing = withProsale(config.pricing, (await readBook([PROSALE_SHEET]))?.[PROSALE_SHEET]);
  // Гібрид (рішення власника 16.11, варіант Б): для зіставлених товарів ціна й наявність — з Хорошопу; без пари — Prom-фід (запасне джерело).
  let offers = parsed.offers, hybrid = null;
  // Свіжість: Excel старший за HOROSHOP_MAX_AGE_HOURS — не застосовується (ціни й наявність із Prom-фіду; підсумок просить оновити Excel).
  const hsStale = Boolean(horoshop?.rows?.length) && !horoshopFresh(horoshop, now);
  if (horoshop?.rows?.length && !hsStale) { const h = hybridOffers({ parsedOffers: parsed.offers, compact: horoshop, overrides: horoshop.overrides || {} }); offers = h.offers; hybrid = h.stats; }
  const p = planPrices({ values: book[MAIN_TITLE], offers, stamp, pricing, removed: cc.removed, anomaly: config.policy?.anomaly });
  const base = { feed: { offers: parsed.count, date: parsed.date }, stats: p.stats, recovery, ...(hybrid ? { horoshop: hybrid } : hsStale ? { horoshop: { error: `Excel застарів (файл від ${horoshop.lastModified || horoshop.at}) — ціни й наявність із Prom-фіду; оновіть «Excel (розширений)» у Хорошопі` } } : {}) };
  if (p.abort) return { state: "ABORTED", reason: p.abort.reason, block: p.abort, ...base };
  if (!p.changed.length) return { state: "NO_CHANGES", reason: "ціни й наявність без змін — нічого не записано", ...base };

  // Правило 5 (CC R6): рішення про видалення під час запуску — нічого не пишемо.
  const ccNow = await ccUnchanged(controls, ccState);
  if (!ccNow.ok) return { state: "SKIPPED_CONCURRENT_EDIT", reason: "стан Catalog Controls змінився під час запуску (" + ccNow.reason + ") — нічого не записано", ...base };

  const changes = p.changed.map((i) => {
    const row = p.rows[i], pl = p.plan[i];
    const cols = LIVE_COLUMNS.filter((k, j) => mtText(pl.before[j]) !== mtText(pl.next[j]));
    const expect = Object.fromEntries(cols.map((k) => [k, mtText(pl.before[LIVE_COLUMNS.indexOf(k)])]));
    const set = Object.fromEntries(cols.map((k) => [k, cellFor(k, pl.next[LIVE_COLUMNS.indexOf(k)])]));
    // Рішення власника 14.11: постачальник оновив наявність — «Наявність власника» очищується (з очікуваним значенням: правка власника
    // між читанням і записом — рядок не пишеться).
    if (pl.clearOwner) { expect[OWNER_AVAILABILITY_COLUMN] = pl.clearOwner.before; set[OWNER_AVAILABILITY_COLUMN] = ""; }
    // Рішення власника 16.11 (№ 63): «Ціна вручну» — нова: записати якір (поточна РРЦ); РРЦ змінилась — очистити ціну й якір
    // (з очікуваними значеннями: правка власника між читанням і записом — рядок не пишеться). «Ціна власника» не очищується.
    if (pl.manual?.set != null) { expect[MANUAL_ANCHOR_COLUMN] = pl.manual.before[MANUAL_ANCHOR_COLUMN]; set[MANUAL_ANCHOR_COLUMN] = pl.manual.set; }
    if (pl.manual?.clear) for (const k of [MANUAL_PRICE_COLUMN, MANUAL_ANCHOR_COLUMN]) { expect[k] = pl.manual.before[k]; set[k] = ""; }
    return { key: pl.id, identity: { "ID постачальника": mtText(row["ID постачальника"]) }, expect, set };
  });
  // Контрольний план ДО першого запису: події з ID і докази (відбитки «було» / «стало» змінених клітинок).
  const runId = "prices:" + stamp;
  const evidence = changes.flatMap((c) => Object.keys(c.set).filter((k) => k !== "Оновлено").map((k) => evidenceCell(c.key, k, c.expect[k], c.set[k])));
  const events = withEventIds(runId, p.journal.map(journalRow));
  const runPlan = { v: 1, kind: "prices", runId, stamp, status: PLAN.PLANNED, createdAt: stamp, evidence, events };
  let version;
  try { version = await savePlan(store, RUN_PLAN_KEY, runPlan, (await loadPlan(store)).version); }
  catch (e) { return { state: "BLOCKED", reason: "контрольний план не записано (W2): " + mtText(e?.message || e).slice(0, 200) + " — нічого не записано", ...base }; }

  let res;
  try { res = await session.updateByKey({ title: MAIN_TITLE, changes, generation: runId, read: readMain }); }
  catch (e) { return { state: "INCOMPLETE", reason: "запис цін: " + mtText(e?.message || e).slice(0, 200) + " — план лишається відкритим; наступний запуск після reconcile з'ясує стан", ...base }; }
  const written = new Set(res.items.filter((x) => x.status === ITEM.VERIFIED || x.status === ITEM.ALREADY).map((x) => x.key));
  const notWritten = res.items.filter((x) => !written.has(x.key)).map((x) => ({ offerId: x.key, status: x.status }));
  // Невідомий результат або запис не туди — план відкритий: наступний запуск після reconcile відновить «Журнал» за доказами.
  if ([OP.UNKNOWN, OP.NEEDS_DECISION].includes(res.outcome)) return { state: "INCOMPLETE", reason: `запис цін: ${res.outcome} — потрібне з'ясування (reconcile); план лишається відкритим`, notWritten, ...base };
  if (!written.size) {
    await savePlan(store, RUN_PLAN_KEY, { ...runPlan, status: PLAN.ABANDONED, closedAt: stamp, closedBy: "жодну зміну не записано (правки людини / ідентичність)" }, version).catch(() => {});
    return { state: "NOT_APPLIED", reason: "жоден рядок не записано (таблицю змінено під час запуску) — повтор наступного запуску", notWritten, ...base };
  }
  // Події — лише записаних рядків.
  const doneEvents = events.filter((e) => written.has(mtText(e[2])));
  version = await savePlan(store, RUN_PLAN_KEY, { ...runPlan, status: PLAN.PRODUCT_DONE, events: doneEvents, productDoneAt: stamp }, version);
  let journal = { planned: doneEvents.length, ok: false, outcome: null };
  try {
    const jv = (readJournal ? await readJournal() : await readBook([JOURNAL_SHEET]))[JOURNAL_SHEET];
    const jr = await appendEvents({ session, journalValues: jv, rows: doneEvents, generation: "journal:" + runId, read: readJournal });
    journal = { ...journal, ok: jr.ok, outcome: jr.outcome, appended: jr.appended };
    if (jr.ok) await savePlan(store, RUN_PLAN_KEY, { ...runPlan, status: PLAN.DONE, events: doneEvents, productDoneAt: stamp, closedAt: stamp }, version);
  } catch (e) { journal = { ...journal, error: mtText(e?.message || e).slice(0, 200) }; }
  // № 63: «Ціна власника» діє, а постачальник змінив РРЦ — рядок в «Попередження постачальника» (лише записаних рядків; ключ — товар + нова
  // РРЦ, тож повторний запуск не дублює). «Стан дії» заповнено — система цей рядок не «виконує»; «Залишити наше» — рядок піде в архів.
  let ownerWarnings = null;
  const rrpWarn = p.changed.filter((i) => p.plan[i].ownerRrp && written.has(p.plan[i].id)).map((i) => {
    const pl = p.plan[i], row = p.rows[i], w = pl.ownerRrp;
    return { key: `rrp-owner:${pl.id}:${w.to}`, at: stamp, offerId: pl.id, sku: mtText(row["Артикул постачальника"]), name: mtText(row["Назва UA"]) || mtText(row["Назва постачальника UA"]),
      field: "РРЦ (діє «Ціна власника»)", before: String(w.from), after: String(w.to), custom: `Ціна власника: ${w.own}${w.applied ? "" : " (не діє — нижча за дроп)"}`, source: "Оновити ціни й наявність" };
  });
  if (rrpWarn.length) {
    try { const wr = await recordWarnings({ session, warnings: rrpWarn, generation: runId }); ownerWarnings = { planned: rrpWarn.length, appended: Array.isArray(wr.appended) ? wr.appended.length : Number(wr.appended) || 0, outcome: wr.outcome }; }
    catch (e) { ownerWarnings = { planned: rrpWarn.length, error: mtText(e?.message || e).slice(0, 200) }; }
  }
  const stats = { ...p.stats, written: written.size, notWritten: notWritten.length, ...(ownerWarnings ? { ownerWarnings } : {}) };
  if (!journal.ok) return { state: "JOURNAL_INCOMPLETE", reason: `ціни записано й перевірено, але «Журнал» запуску неповний (${journal.outcome || journal.error}) — наступний запуск допише відсутні події`, notWritten, journal, ...base, stats };
  return { state: notWritten.length ? "PARTIAL" : "PRICES_UPDATED", reason: notWritten.length ? `не записано ${notWritten.length} рядків (таблицю змінено під час запуску) — наступний запуск` : "", notWritten, journal, ...base, stats };
}
