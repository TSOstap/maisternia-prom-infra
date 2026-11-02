/** Catalog Controls — стан, план одного запуску і похідний «Стан керування» (чисті функції, без мережі й запису).
 *
 *  План містить ЛИШЕ події журналу з довіреними намірами для контрольної точки. Жодної зміни «Основного каталогу», «Видалених
 *  товарів», паспорта чи інших аркушів: переноси рядків виконує Engineering за `moves` (controlsState).
 *
 *  R5 (29.10.2026; ревю Hermes R4, рішення власника A–D, архітектура «Видалені товари», ENG-10):
 *   • контрольна точка v4 — самодостатнє ДОВІРЕНЕ джерело: підтверджені події зберігаються з повним рядком; довірений стан —
 *     згортка рядків точки, а не аркуша. Аркуш «Історія керування» — видиме дзеркало: розбіжність ізолює лише зачеплений товар
 *     (поза продажем + попередження), решта каталогу працює (D). Відсутні рядки дописуються з точки. Глобальна зупинка для
 *     споживачів — лише коли точки немає / вона недійсна (безпечний стан інших товарів визначити неможливо);
 *   • рядок без прив'язки (напр. після відновлення старої точки): захисний — діє (зняти / видалити), послаблювальний — не діє;
 *   • довірений намір ДО зовнішнього запису (F1); послаблення — лише за чинної авторизації власника; скасоване — новий код;
 *   • видалення: реєстр — у точці; стадії REGISTERED → ARCHIVED → DONE; перенесення в архів — лише після публікації
 *     «немає в наявності» (доказ Engineering); повернення з архіву — окремою командою з кодом, перевірки лише цієї картки (B, N3);
 *   • фізична ідентичність — «ID постачальника» + «Артикул» (без артикула — назви / URL постачальника); правки полів власника
 *     (назви, описи, характеристики, GTIN, «Код товару Prom») не перевидають коди й не скасовують повернення (N1, ENG-10);
 *   • вердикт картки M3 (Engineering): OK / OWNER_EDIT — команди виконуються, CORRUPT / UNVERIFIED — відмова лише цій картці (C).
 *
 *  R6 (рішення власника 29.10.2026, «видалені товари»): видалений товар (tombstoned, будь-яка стадія) — без жодного <offer> у новому
 *  YML; «ВИДАЛИТИ ТОВАР» — одна дія (товар у продажу знімається внутрішнім захисним переходом у тому самому запуску); перенесення в
 *  архів — одразу після підтвердженого рішення; DONE — рішення + архів + активний опублікований YML без цього Offer ID (без Prom);
 *  будь-який YML-кандидат (новий, відкат, патч, резерв) — через feedViolations. */
import { mtText, sha256 } from "./text.mjs";
import { readSheet } from "./sync-plan.mjs";
import { SEAL_COLUMN, rowSeal } from "./seal.mjs";
import { SHEET } from "./sheet-sync.mjs";
import {
  ACTION, ARCHIVE_SHEET, CC_INPUT_COLUMNS, CC_SHEET, HISTORY_HEADERS, ISSUE_SPACE, SALE_DECISION, SEO_DECISION, WEAKENING, confirmationCode, controlsConfig,
  dayOf, domainOf, emptyProduct, foldHistory, historyEvent, historyRow, identityKey, identityOf, issuedCode, operationId, physicalDifferences,
  readHistory, short,
} from "./controls-common.mjs";
import { SEO_WORD, emptySeo, parseSeoCommand, sameSeo, seoAdvice, seoSha, seoValues, supplierChanges, supplierSnapshot, validateSeo } from "./controls-seo.mjs";
import { MAIN_ONLY, SALE_KIND, SALE_WORDS, heldText, parseSaleCommand } from "./controls-sale.mjs";
import { ALLOWED_VERDICTS, exclusionGate, restoreProblems, witnessFields, witnessKnown, witnessOf } from "./controls-exclusions.mjs";

export const VIEW_HEADERS = Object.freeze(["Offer ID", "Назва UA", "Продаж", "SEO", "Виключення", "Коди підтвердження", "Попередження", "Остання операція", "Актуальність"]);
/** Рядки аркуша: [] — аркуша немає; null — аркуш є, але не читається (CC4-N3: не доказ порожнечі). */
const rowsOf = (book, name) => { try { return book[name]?.length ? readSheet(book[name], name).rows : []; } catch { return null; } };
const digest = (x) => sha256(JSON.stringify(x)).slice(0, 32);
/** Канонічний вміст аркуша для відбитка: заголовок + відсортовані непорожні рядки (порядок не важливий, вміст — важливий). */
const canon = (v) => {
  const rows = (v || []).map((r) => { const x = (r || []).map(mtText); while (x.length && x.at(-1) === "") x.pop(); return x; });
  const [header = [], ...data] = rows;
  return [header, ...data.filter((r) => r.length).map((r) => JSON.stringify(r)).sort()];
};
const identityDigest = (i) => digest(Object.keys(i || {}).sort().map((k) => [k, mtText(i[k])]));
const jsonOr = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ---------- контрольна точка v4 ----------
// R7: необов'язкові поля, сумісні з v4: ops[].auth — ключ фізичної ідентичності, для якої авторизовано послаблення (повернення в
// продаж діє лише для неї — F1 / N2); issued[] — видачі кодів підтвердження (F2): чинний лише код, виданий системою на запит і
// збережений тут разом із ідентичністю, ревізією та вмістом; prev — коди попередніх видач (нова видача ніколи їх не повторює).
// R7.1 (Hermes R7-P1): нова видача ніколи не дорівнює коду, що стоїть у клітинці команди на момент видачі; prev — слід.
// R7.2 (Hermes C71-01): epoch — токен оренди (fencing, cc-committer-v1) запуску, що видав код; код = issuedCode(Offer ID, дія,
// epoch). Токени строго зростають ПОЗА контрольною точкою, а на дію товару за запуск — не більше однієї видачі, тож коди всіх видач
// у будь-якій гілці історії точки попарно різні: відновлена старіша точка не повертає коду, виданого в іншій гілці. first (R7.1) —
// лише для сумісності читання.
export const EPOCH_LIMIT = ISSUE_SPACE;
const epochOf = (e) => (Number.isInteger(e?.epoch) && e.epoch >= 0 ? e.epoch : 0);
// R7.3 (C3, C5; cc-epoch-v1 / cc-recovery-v1): необов'язкові поля точки v4 — epochHigh (токен оренди ОСТАННЬОГО запису точки,
// будь-якого — не лише видачі коду), leaseId (32 hex, cc-committer-v2) і recovery (покоління відновлення: epoch — токен оренди
// відновлення; ack — Operation ID рядків журналу без прив'язки, визнаних відновленням недійсними послабленнями; conflicts — Offer ID
// з різним вмістом тієї самої операції — ізольовано). У відбиток для споживачів не входять (як issued і at).
const LEASE_ID_RE = /^[0-9a-f]{32}$/;
const isRecoveryMeta = (r) => Boolean(r) && typeof r === "object" && Number.isInteger(r.generation) && r.generation >= 0 && Number.isInteger(r.epoch) && r.epoch >= 1
  && r.epoch < EPOCH_LIMIT && ["type", "at", "fromHash"].every((k) => typeof r[k] === "string") && ["ack", "conflicts"].every((k) => Array.isArray(r[k]) && r[k].every((x) => typeof x === "string"));
const metaOk = (c) => (c.epochHigh === undefined || (Number.isInteger(c.epochHigh) && c.epochHigh >= 1 && c.epochHigh < EPOCH_LIMIT))
  && (c.leaseId === undefined || (typeof c.leaseId === "string" && LEASE_ID_RE.test(c.leaseId))) && (c.recovery === undefined || isRecoveryMeta(c.recovery));
const metaOf = (c) => Object.fromEntries(["epochHigh", "leaseId", "recovery"].filter((k) => c?.[k] !== undefined).map((k) => [k, structuredClone(c[k])]));
export const CHECKPOINT_VERSION = 4;
export const emptyCheckpoint = (at) => ({ v: CHECKPOINT_VERSION, at: mtText(at), ops: [], pending: [], aborted: [] });
const isRef = (e) => Boolean(e) && typeof e === "object" && typeof e.op === "string" && e.op !== "" && typeof e.offerId === "string" && e.offerId !== "" && typeof e.seal === "string" && e.seal !== "";
/** Рядок операції в точці самоузгоджений: 10 рядкових клітинок, печатка, Operation ID і Offer ID збігаються з записом. */
const rowOk = (e) => {
  if (!Array.isArray(e.row) || e.row.length !== HISTORY_HEADERS.length || !e.row.every((v) => typeof v === "string")) return false;
  const ev = historyEvent(e.row);
  return ev.sealOk && ev.opId === e.op && ev.offerId === e.offerId && ev.seal === e.seal;
};
const isOp = (e) => isRef(e) && rowOk(e) && (e.auth === undefined || typeof e.auth === "string");
const isIntent = (e) => isOp(e) && typeof e.action === "string" && e.action === historyEvent(e.row).action && typeof e.weakening === "boolean"
  && e.weakening === WEAKENING.has(e.action) && typeof e.auth === "string" && typeof e.cmd === "string";
const isAborted = (e) => isRef(e) && typeof e.action === "string";
export const ISSUE_HISTORY = 16;
export const issueKey = (offerId, action) => `${offerId}|${action}`;
const isIssued = (e) => Boolean(e) && typeof e === "object" && ["offerId", "action", "code", "auth", "revision", "payload", "at"].every((k) => typeof e[k] === "string")
  && e.offerId !== "" && e.key === issueKey(e.offerId, e.action) && Number.isInteger(e.n) && e.n >= 0
  && Array.isArray(e.prev) && e.prev.length <= ISSUE_HISTORY && e.prev.every((x) => typeof x === "string") && (e.first === undefined || typeof e.first === "string")
  && (e.epoch === undefined || (Number.isInteger(e.epoch) && e.epoch >= 1 && e.epoch < EPOCH_LIMIT));
function validCheckpoint(c) {
  if (c?.v !== CHECKPOINT_VERSION || !["ops", "pending", "aborted"].every((k) => Array.isArray(c[k]))) return false;
  if (!c.ops.every(isOp) || !c.pending.every(isIntent) || !c.aborted.every(isAborted)) return false;
  if (c.issued !== undefined && (!Array.isArray(c.issued) || !c.issued.every(isIssued) || new Set(c.issued.map((e) => e.key)).size !== c.issued.length)) return false;
  if (!metaOk(c)) return false;
  const keys = [...c.ops, ...c.pending, ...c.aborted].map((e) => e.op);
  return new Set(keys).size === keys.length;
}
const byOp = (a, b) => (a.op < b.op ? -1 : a.op > b.op ? 1 : 0);
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
/** Видачі кодів: попередні + змінені цим запуском (Map key → запис). Порожній список у точку не пишеться (сумісність). */
function mergeIssued(prevIssued, changes) {
  const m = new Map((prevIssued || []).map((e) => [e.key, structuredClone(e)]));
  for (const [k, e] of changes || []) m.set(k, structuredClone(e));
  const list = [...m.values()].sort(byKey);
  return list.length ? { issued: list } : {};
}
/** Нова точка з додатковими намірами (і видачами кодів) — пишеться ДО будь-якого зовнішнього запису. */
export function withIntents(prev, intents, at, issued = null) {
  const base = validCheckpoint(prev) ? prev : emptyCheckpoint(at);
  const has = new Set([...base.ops, ...base.pending, ...base.aborted].map((e) => e.op));
  const pending = [...base.pending];
  for (const it of intents) if (!has.has(it.op)) { has.add(it.op); pending.push(structuredClone(it)); }
  const { issued: _old, ...rest } = structuredClone(base);
  return { ...rest, at: mtText(at), pending: pending.sort(byOp), ...mergeIssued(base.issued, issued) };
}
/** Лише видачі кодів (запуск без нових операцій). */
export const withIssued = (prev, issued, at) => withIntents(prev, [], at, issued);
/** Коміт: наміри з confirm → підтверджені (з повним рядком і ключем ідентичності); з abort → скасовані; решта лишається. Видачу
 *  коду, використану підтвердженим / скасованим наміром, вичерпано: код більше не чинний і не повториться в наступних видачах. */
export function settleCheckpoint(prev, { confirm = new Set(), abort = new Map() } = {}, at) {
  const ops = [...prev.ops], aborted = [...prev.aborted], pending = [];
  const issued = new Map((prev.issued || []).map((e) => [e.key, structuredClone(e)]));
  const consume = (it) => {
    const x = it.iss ? issued.get(it.iss) : null;
    if (x && x.code && x.code === it.code) issued.set(it.iss, { ...x, code: "", prev: [...x.prev, x.code].slice(-ISSUE_HISTORY) });
  };
  for (const it of prev.pending) {
    if (confirm.has(it.op)) { ops.push({ op: it.op, offerId: it.offerId, seal: it.seal, row: it.row.slice(), ...(it.auth ? { auth: it.auth } : {}) }); consume(it); }
    else if (abort.has(it.op)) {
      const gen = /^(seo|sale):(\d+)$/.exec(mtText(it.row[8]));
      aborted.push({ op: it.op, offerId: it.offerId, seal: it.seal, action: it.action, gen: gen ? Number(gen[2]) : 0, reason: mtText(abort.get(it.op)).slice(0, 300) });
      consume(it);
    } else pending.push(it);
  }
  const list = [...issued.values()].sort(byKey);
  return { v: CHECKPOINT_VERSION, at: mtText(at), ops: ops.sort(byOp), pending: pending.sort(byOp), aborted: aborted.sort(byOp), ...(list.length ? { issued: list } : {}), ...metaOf(prev) };
}
export const sameCheckpoint = (a, b) => JSON.stringify([a?.ops, a?.pending, a?.aborted, a?.issued || []]) === JSON.stringify([b?.ops, b?.pending, b?.aborted, b?.issued || []]);

/**
 * Звірка дзеркала (аркуш «Історія керування») з довіреною точкою. Повертає structural (лише недійсна / відсутня точка — глобальна
 * зупинка), isolated (Map Offer ID → причини: товар поза продажем, решта працює), present (Operation ID зі збіжним рядком), missing
 * (довірені операції без рядка — дописуються з точки), unboundProtective / unboundTombs (захисні рядки без прив'язки — діють),
 * journalBroken (журнал не читається — CC не дописує нових записів; споживачі працюють із точки), issues (без товару).
 */
export function compareMirror({ activated, checkpoint, hist }) {
  // R7.3 (Q2): unbound — усі рядки без прив'язки (детектор відкату точки для apply; дозволу не дають ніколи).
  const s = { structural: [], isolated: new Map(), present: new Set(), missing: [], unboundProtective: [], unboundTombs: new Map(), unbound: [], journalBroken: hist.structural.length > 0, issues: [...hist.structural] };
  const isolate = (id, why) => { if (!id) { s.issues.push(why); return; } s.isolated.set(id, [...new Set([...(s.isolated.get(id) || []), why])]); };
  const row = (n) => `«${CC_SHEET.history}», рядок ${n}`;
  if (!activated) {
    for (const ev of hist.events) s.present.add(ev.opId);
    for (const d of hist.damagedRows) isolate(d.offerId, `${row(d.rowNumber)}: печатка не відповідає вмісту — запис змінено вручну`);
    return s;
  }
  if (checkpoint === undefined) { s.structural.push("контрольну точку не надано (обов'язкова після активації)"); return s; }
  if (checkpoint === null) {
    if (hist.seenOps.size || hist.damagedRows.length) s.structural.push("контрольної точки немає, а журнал має записи — потрібна перевірка (стан інших товарів не визначити)");
    return s;
  }
  if (!validCheckpoint(checkpoint)) { s.structural.push("контрольна точка пошкоджена або застарілого формату (потрібна v4) — стан товарів не визначити"); return s; }
  // Журнал структурно не читається — рядки не звірити; довірений стан повністю з точки (без масової ізоляції), CC не пише.
  if (s.journalBroken) return s;
  const T = new Map();
  for (const e of checkpoint.ops) T.set(e.op, { ...e, status: "confirmed", action: historyEvent(e.row).action });
  for (const e of checkpoint.pending) T.set(e.op, { ...e, status: "pending" });
  for (const e of checkpoint.aborted) T.set(e.op, { ...e, status: "aborted" });
  const ack = new Set(checkpoint.recovery?.ack || []);
  const seen = new Set();
  for (const ev of hist.events) {
    seen.add(ev.opId);
    const e = T.get(ev.opId);
    if (!e && ack.has(ev.opId)) continue; // R7.3: визнано відновленням (недійсне послаблення) — не діє й не ізолює
    if (!e) {
      s.unbound.push(ev);
      if (WEAKENING.has(ev.action)) isolate(ev.offerId, `${row(ev.rowNumber)}: «${ev.action}» без прив'язки до контрольної точки — НЕ діє; видаліть рядок або зверніться до інженера`);
      else {
        isolate(ev.offerId, `${row(ev.rowNumber)}: «${ev.action}» без прив'язки до контрольної точки — діє як захисна дія (fail-closed); потрібна перевірка`);
        s.unboundProtective.push(ev);
        if (ev.action === ACTION.TOMBSTONE) s.unboundTombs.set(ev.offerId, { opId: ev.opId, at: ev.at, identity: jsonOr(ev.after, {}) || {} });
      }
      continue;
    }
    if (ev.offerId !== e.offerId || ev.seal !== e.seal) {
      // Прив'язаний рядок: товар — із точки; Offer ID із зміненого рядка не довірений (лише попередження, без ізоляції чужого товару).
      const why = `${row(ev.rowNumber)}: запис не відповідає контрольній точці (змінено вручну) — довірений запис у точці; поверніть значення або видаліть рядок`;
      isolate(e.offerId, why);
      if (ev.offerId !== e.offerId) s.issues.push(`${why} (у рядку вказано Offer ID ${ev.offerId || "—"})`);
      continue;
    }
    s.present.add(ev.opId);
  }
  for (const d of hist.damagedRows) {
    if (d.opId) seen.add(d.opId);
    const e = d.opId ? T.get(d.opId) : null;
    const why = `${row(d.rowNumber)}: печатка не відповідає вмісту — запис змінено вручну; довірений стан — з контрольної точки`;
    if (e) {
      isolate(e.offerId, why);
      if (d.offerId && d.offerId !== e.offerId) s.issues.push(`${why} (у рядку вказано Offer ID ${d.offerId})`);
    } else if (d.offerId) isolate(d.offerId, why);
    else s.issues.push(why);
  }
  for (const e of T.values()) {
    if (e.status === "aborted" || s.present.has(e.op)) continue;
    if (!seen.has(e.op)) s.missing.push(e);
    if (e.status === "confirmed" && !seen.has(e.op)) isolate(e.offerId, `рядка операції ${e.op.slice(3, 11)} у «${CC_SHEET.history}» немає — довірений запис у точці; наступний apply допише його`);
  }
  return s;
}

/** Вердикт цілісності картки (M3, Engineering). Без адаптера — лише печатка: збігається → OK, інакше UNVERIFIED (не відрізнити правку). */
export function cardVerdictOf(row, integrity = null) {
  if (typeof integrity?.cardVerdict === "function") {
    try { const v = integrity.cardVerdict(row); if (v && typeof v.verdict === "string") return { verdict: v.verdict, reasons: Array.isArray(v.reasons) ? v.reasons : [] }; } catch (e) { return { verdict: "UNVERIFIED", reasons: ["вердикт картки не обчислено: " + mtText(e?.message || e).slice(0, 120)] }; }
    return { verdict: "UNVERIFIED", reasons: ["вердикт картки некоректний"] };
  }
  return rowSeal(row) === mtText(row?.[SEAL_COLUMN]) ? { verdict: "OK", reasons: [] } : { verdict: "UNVERIFIED", reasons: ["печатка картки не відповідає вмісту, а стану полів (M3) немає — дозволену правку не відрізнити від пошкодження"] };
}

const countBy = (rows) => { const m = new Map(); for (const r of rows || []) m.set(mtText(r["Offer ID"]), (m.get(mtText(r["Offer ID"])) || 0) + 1); return m; };
const byOfferId = (rows) => new Map((rows || []).map((r) => [mtText(r["Offer ID"]), r]));
/**
 * Перенесення перервано між «копія» і «прибрати джерело» (в будь-який бік): рядок архіву збігається з рядком каталогу за всіма
 * колонками «Основного каталогу», крім клітинок КОМАНД власника («Продаж рішення», «SEO рішення» — у копіях очікувано різні).
 * R7 (F3): SEO-чернетка власника порівнюється — різна чернетка = локальний конфлікт (ANOMALY), а не дозвіл прибрати копію.
 * Службові колонки архіву Engineering («Видалено», «Операція видалення», «Статус видалення» тощо) не порівнюються.
 */
const COMMAND_COLUMNS = Object.freeze([SALE_DECISION, SEO_DECISION]);
const sameCopy = (mainRow, archiveRow) => Boolean(mainRow && archiveRow) && Object.keys(mainRow).filter((k) => !COMMAND_COLUMNS.includes(k)).every((k) => k in archiveRow && mtText(mainRow[k]) === mtText(archiveRow[k]));
/**
 * F4: «Видалені товари» не пройшли перевірку структури — нечитабельний архів не доказ, що видалених немає. Консервативно: рядки з
 * колонкою «Offer ID» (якщо вона одна) — як видалені. [] — даних немає; null — колонки немає, а дані є (ID не визначити).
 */
function salvageArchive(values) {
  const data = (values || []).slice(1).filter((r) => (r || []).some((v) => v !== "" && v != null));
  if (!data.length) return [];
  const h = (values[0] || []).map(mtText), k = h.indexOf("Offer ID");
  if (k < 0 || k !== h.lastIndexOf("Offer ID")) return null;
  return data.map((r) => Object.fromEntries(h.map((c, j) => [c, r?.[j] ?? ""]))).filter((r) => mtText(r["Offer ID"]).trim() !== "");
}
/**
 * R7.1 (Hermes R7-P2): непорожні рядки «Видалених товарів» без Offer ID — не порожнеча: [{ ref, identity }] (ref — номер рядка).
 * Без колонки «Offer ID» — [] (цей випадок — явна зупинка в salvageArchive). of(row) — посилання на такий рядок, якщо фільтр
 * повторного створення відмовив би карточці row як новинці. R7.2 (C71-02): ОДНЕ правило для картки каталогу, повернення з архіву
 * й фільтра новинок — ID постачальника, сильний збіг або збіг усіх відомих ознак рядка (exclusionGate, UNIDENTIFIED_ARCHIVE).
 */
const rowOffer = (r) => ({ id: r["ID постачальника"], sku: r["Артикул постачальника"], vendor: r["Виробник"], model: r["Модель"], gtin: r["GTIN"], nameUa: r["Назва постачальника UA"], nameRu: r["Назва постачальника RU"], url: r["URL постачальника"] });
const identityKnown = (idn) => witnessKnown(witnessOf(idn));
const unnamedRestoreText = (ref) => `${ref}: рядок без Offer ID із тими самими ознаками товару — повернення з архіву ризиковане; спершу перевірте / виправте цей рядок`;
function unnamedArchive(values) {
  const h = (values?.[0] || []).map(mtText), k = h.indexOf("Offer ID");
  const unnamed = [];
  if (k >= 0 && k === h.lastIndexOf("Offer ID")) {
    (values || []).slice(1).forEach((r, i) => {
      if (!(r || []).some((v) => mtText(v).trim() !== "") || mtText(r?.[k]).trim() !== "") return;
      unnamed.push({ ref: `«${ARCHIVE_SHEET}», рядок ${i + 2}`, identity: identityOf(Object.fromEntries(h.map((c, j) => [c, r?.[j] ?? ""]))) });
    });
  }
  const gate = exclusionGate(new Map(), unnamed);
  const of = (row) => { const g = gate.check(rowOffer(row)); return g.blocked ? g.recordId : null; };
  return { unnamed, of };
}
/** R6: доказ Engineering про АКТИВНУ опубліковану версію YML: «absent» — offer'а з цим Offer ID у ній немає. Інше — не доказ. */
const feedAbsent = (p) => p?.feed === "absent";
const feedHasOffer = (p) => ["present", "available", "unavailable"].includes(p?.feed);

/**
 * Повний стан керування (спільний для плану, звірки, споживачів і «Стану керування»).
 * integrity — { cardVerdict(row) } (M3); publication — Map(Offer ID → { feed: "absent" | "present" | "unknown" }) — стан АКТИВНОЇ
 * опублікованої версії YML (Engineering). Підтвердження Prom не використовується (рішення власника 29.10.2026).
 */
export function loadState(book, { contract = null, checkpoint = undefined, integrity = null, publication = null } = {}) {
  const hist = readHistory(book[CC_SHEET.history]);
  const activated = contract?.activated === true;
  const mirror = compareMirror({ activated, checkpoint, hist });
  const cp = activated && validCheckpoint(checkpoint) ? checkpoint : null;
  // Довірені події: до активації — рядки аркуша (оцінка); після — рядки контрольної точки (підтверджені + наміри).
  const events = !activated ? hist.events : cp ? [...cp.ops, ...cp.pending].map((e) => historyEvent(e.row)) : [];
  const confirmedOps = !activated ? new Set(events.map((e) => e.opId)) : new Set(cp ? cp.ops.map((e) => e.op) : []);
  const trusted = { events, damaged: new Set(), structural: [], seenOps: new Set(events.map((e) => e.opId)) };
  const fold = foldHistory(trusted, { trustRowOfferIds: false });
  const confirmedFold = activated && cp ? foldHistory(trusted, { only: confirmedOps, trustRowOfferIds: false }) : fold;
  const structural = [...mirror.structural];
  // R7.3 (C5): товари з різним вмістом тієї самої операції у відновленні — ізольовано (власнику на перевірку).
  const damaged = new Set([...fold.damaged, ...confirmedFold.damaged, ...mirror.isolated.keys(), ...(cp?.recovery?.conflicts || [])]);

  const main = rowsOf(book, SHEET.main), archive = book[ARCHIVE_SHEET] === undefined ? [] : rowsOf(book, ARCHIVE_SHEET);
  const inMain = countBy(main), inArchive = countBy(archive);
  const pub = (id) => (publication instanceof Map ? publication.get(id) : null) || null;
  const archiveSalvage = archive === null ? salvageArchive(book[ARCHIVE_SHEET]) : [];
  if (archiveSalvage === null) structural.push(`«${ARCHIVE_SHEET}» не читається й не має колонки «Offer ID» — набір видалених товарів не визначити (безпечний стан інших товарів невідомий)`);

  // Реєстр видалень: повна АБО підтверджена згортка (непідтверджене повернення не знімає видалення), захисні рядки без прив'язки,
  // рядки архіву без рішення CC (fail-closed). Ідентичність — довірена (подія «ТОВАР ВИДАЛЕНО»), не з рядка аркуша.
  const exclusions = new Map();
  const confirmedTomb = (id, op) => { const c = confirmedFold.products.get(id); return Boolean(c?.tomb.active && c.tomb.opId === op); };
  for (const [id, p] of fold.products) if (p.tomb.active) exclusions.set(id, { opId: p.tomb.opId, at: p.tomb.at, identity: { ...identityOf({}), ...p.tomb.identity }, confirmed: confirmedTomb(id, p.tomb.opId), source: "registry" });
  for (const [id, p] of confirmedFold.products) if (p.tomb.active && !exclusions.has(id)) exclusions.set(id, { opId: p.tomb.opId, at: p.tomb.at, identity: { ...identityOf({}), ...p.tomb.identity }, confirmed: true, source: "registry" });
  for (const [id, u] of mirror.unboundTombs) if (!exclusions.has(id)) exclusions.set(id, { opId: u.opId, at: u.at, identity: { ...identityOf({}), ...u.identity }, confirmed: false, source: "unbound" });
  const restoring = new Map();
  for (const [id, p] of confirmedFold.products) if (p.restored && !p.tomb.active) restoring.set(id, p.restored);
  for (const r of [...(archive || []), ...(archiveSalvage || [])]) {
    const id = mtText(r["Offer ID"]);
    if (id && !exclusions.has(id) && !restoring.has(id)) exclusions.set(id, { opId: "", at: "", identity: identityOf(r), confirmed: false, source: "archive" });
  }
  // Стадії (на дозвіл публікації не впливають: видалений — у будь-якій стадії поза новим YML і в held).
  const issues = [...mirror.issues];
  if (main === null) issues.push(`«${SHEET.main}» не читається — стадії видалення не визначено`);
  if (archive === null && archiveSalvage) issues.push(`«${ARCHIVE_SHEET}» не читається — стадії видалення не визначено; видалені (зокрема ${archiveSalvage.length} рядків архіву за колонкою «Offer ID») лишаються поза YML`);
  // R7.1 (Hermes R7-P2): непорожній рядок архіву без Offer ID не зникає мовчки. Картки «Основного каталогу», що відповідають його
  // фізичній ідентичності, — поза YML (UNREGISTERED; товар, що повертається з архіву, — ізольовано); фільтр новинок блокує цей товар;
  // повернення з архіву товару з цією ідентичністю відхиляється. Ідентичність рядка не визначити — явна глобальна зупинка (як F4).
  // Решта товарів і ручні правки працюють.
  const anon = book[ARCHIVE_SHEET] === undefined ? unnamedArchive(null) : unnamedArchive(book[ARCHIVE_SHEET]);
  const anonUnknown = anon.unnamed.filter((u) => !identityKnown(u.identity));
  if (anonUnknown.length) structural.push(`${anonUnknown.map((u) => u.ref).join(", ")}: непорожній рядок без Offer ID і без ID / артикула / назв / URL постачальника — набір видалених товарів не визначити (безпечний стан інших товарів невідомий)`);
  const anonIds = new Map();
  for (const r of anon.unnamed.length ? main || [] : []) {
    const id = mtText(r["Offer ID"]), ref = id ? anon.of(r) : null;
    if (!ref) continue;
    anonIds.set(ref, [...(anonIds.get(ref) || []), id]);
    if (restoring.has(id)) damaged.add(id);
    else if (!exclusions.has(id)) exclusions.set(id, { opId: "", at: "", identity: identityOf(r), confirmed: false, source: "archive" });
  }
  for (const u of anon.unnamed.filter((x) => identityKnown(x.identity))) {
    const ids = anonIds.get(u.ref) || [], w = witnessOf(u.identity);
    const partial = w.supplierId === "" || (w.sku === "" && (w.nameUa === "" || w.nameRu === "" || w.url === ""));
    issues.push(`${u.ref}: рядок без Offer ID — товар не визначено (${partial ? "неповна ідентичність, " : ""}ознаки: ${witnessFields(w).join(", ")}); ${ids.length ? `картки з цими ознаками (${ids.join(", ")}) поза YML` : "картки з цими ознаками в «Основному каталозі» немає"}; новинки з цими ознаками не додаються, повернення з архіву товару з ними відхиляється; потрібна перевірка рядка`);
  }
  // moves — доручення Engineering (ідемпотентне: «копія в цільовий аркуш → перевірка → прибрати джерело»). R6: у архів — одразу після
  // ПІДТВЕРДЖЕНОГО рішення (з YML товар виключається за реєстром, незалежно від аркуша). MOVING — перенесення перервано після копії:
  // те саме доручення завершує його; різні копії / нуль / кілька рядків — ANOMALY (товар ізольовано, без moves).
  // DONE — підтверджене рішення + безпечне архівування + доказ, що АКТИВНИЙ опублікований YML не містить цього Offer ID.
  const moves = { toArchive: [], toCatalog: [] };
  const mainById = byOfferId(main), archiveById = byOfferId(archive);
  for (const [id, x] of exclusions) {
    const m = inMain.get(id) || 0, a = inArchive.get(id) || 0;
    x.stage = main === null || archive === null ? "UNKNOWN" : x.source === "archive" ? "UNREGISTERED" : x.source === "unbound" ? "UNBOUND"
      : m === 1 && a === 0 ? "REGISTERED" : m === 0 && a === 1 ? (x.confirmed && feedAbsent(pub(id)) ? "DONE" : "ARCHIVED")
        : m === 1 && a === 1 && sameCopy(mainById.get(id), archiveById.get(id)) ? "MOVING" : "ANOMALY";
    x.feed = pub(id)?.feed || "unknown";
    if (x.stage === "ANOMALY") damaged.add(id);
    if ((x.stage === "REGISTERED" || x.stage === "MOVING") && x.confirmed) moves.toArchive.push(id);
  }
  for (const [id, r] of restoring) {
    const m = inMain.get(id) || 0, a = inArchive.get(id) || 0;
    r.stage = main === null || archive === null ? "UNKNOWN" : m === 0 && a === 1 ? "RESTORE_REQUESTED" : m === 1 && a === 0 ? "RESTORED"
      : m === 1 && a === 1 && sameCopy(mainById.get(id), archiveById.get(id)) ? "MOVING" : "ANOMALY";
    if (r.stage === "ANOMALY") damaged.add(id);
    if (r.stage === "RESTORE_REQUESTED" || r.stage === "MOVING") moves.toCatalog.push(id);
  }
  moves.toArchive.sort(); moves.toCatalog.sort();

  const pendingIntents = cp ? cp.pending : [];
  const unconfirmedByProduct = new Map();
  for (const it of pendingIntents) unconfirmedByProduct.set(it.offerId, [...(unconfirmedByProduct.get(it.offerId) || []), it]);
  // Захисні дії діють одразу — з довіреного наміру або (fail-closed) з рядка без прив'язки.
  const pendingHeld = new Set([...pendingIntents.filter((it) => it.action === ACTION.HOLD || it.action === ACTION.TOMBSTONE).map((it) => it.offerId), ...mirror.unboundProtective.filter((e) => e.action === ACTION.HOLD || e.action === ACTION.TOMBSTONE).map((e) => e.offerId)]);
  const abortedByProduct = new Map();
  for (const e of cp ? cp.aborted : []) {
    const d = domainOf(e.action) || "other";
    const a = abortedByProduct.get(e.offerId) || { sale: [], seo: [], other: [], list: [] };
    a[d].push(e.op); a.list.push(e);
    abortedByProduct.set(e.offerId, a);
  }
  // R7 (F1 / N2): підтверджене повернення в продаж діє лише для фізичної ідентичності, для якої його авторизовано (ops[].auth у
  // довіреній точці). Інша ідентичність картки, кілька / жодного рядка, нечитабельний каталог або немає прив'язки — товар поза
  // продажем у стані для споживачів, без жодного додаткового запуску; наступний apply записує автоматичне зняття (борг захисту).
  const releaseMismatch = new Map();
  if (activated && cp) {
    const opAuth = new Map(cp.ops.map((e) => [e.op, e.auth || ""]));
    for (const [id, p] of confirmedFold.products) {
      const last = p.sale.last;
      if (!last || last.action !== ACTION.RELEASE || p.sale.held || p.tomb.active) continue;
      const rows = (main || []).filter((r) => mtText(r["Offer ID"]) === id);
      const auth = opAuth.get(last.opId) || "", now = rows.length === 1 ? identityKey(identityOf(rows[0])) : "";
      if (main === null || !auth || now !== auth) releaseMismatch.set(id, { op: last.opId, auth, now, rows: rows.length, unreadable: main === null });
    }
  }
  const issued = new Map((cp?.issued || []).map((e) => [e.key, e]));
  const maxEpoch = Math.max(0, ...(cp?.issued || []).map(epochOf));
  return {
    hist, fold, confirmedFold, activated, checkpoint: cp, mirror, structural, blocked: structural.length > 0, damaged, isolated: mirror.isolated, issues,
    exclusions, restoring, moves, main, archive, inMain, inArchive, confirmed: confirmedOps, unconfirmed: new Set(pendingIntents.map((it) => it.op)),
    unconfirmedByProduct, pendingIntents, pendingHeld, abortedByProduct, releaseMismatch, issued, integrity, publication, problems: [...hist.problems],
    unnamed: anon.unnamed, unnamedOf: anon.of, maxEpoch, recovery: cp?.recovery || null,
  };
}

/** Ревізія домену для кодів: остання подія + скасовані наміри — після скасування старий код недійсний, потрібен новий. */
export function revisionOf(st, id, domain, p) {
  const base = domain === "seo" ? p.seo.rev : p.sale.rev;
  const ab = st.abortedByProduct.get(id)?.[domain];
  return ab?.length ? `${base}~${sha256(JSON.stringify([...ab].sort())).slice(0, 8)}` : base;
}

/** Ефективний захист товару: знято (повний / підтверджений стан, захисний намір), видалено, ізольовано. */
function effective(st, inMain) {
  const held = new Set(), tombstoned = new Map(), seo = new Map();
  for (const fold of [st.fold, st.confirmedFold]) for (const [id, p] of fold.products) if (p.sale.held) held.add(id);
  for (const id of st.pendingHeld) held.add(id);
  for (const [id, x] of st.exclusions) { held.add(id); tombstoned.set(id, { stage: x.stage, opId: x.opId, at: x.at, confirmed: x.confirmed }); }
  for (const id of st.damaged) held.add(id);
  for (const id of st.releaseMismatch.keys()) held.add(id);
  for (const [id, p] of st.confirmedFold.products) if (p.seo.current && !st.damaged.has(id) && inMain.has(id) && !st.exclusions.has(id)) seo.set(id, p.seo.current);
  return { held, tombstoned, seo };
}

/**
 * Стан для спільного конвеєра (лише читання). blocked=true — стан невідомий (точки немає / недійсна): не публікувати нового й не
 * приймати новинки. Інакше проблеми окремих товарів — у damaged / issues (товар поза продажем, решта працює). held — авторитетне
 * зняття для publisher (S7: найвищий пріоритет). moves — що Engineering має перенести між «Основним каталогом» і «Видаленими
 * товарами». fingerprint (ccfp5) — відбиток усього, від чого залежить дозвіл на публікацію; перед публікацією — verifyControlsSnapshot.
 */
export function controlsState(book, opts = {}) {
  const st = loadState(book, opts);
  const mainIds = new Set((st.main || []).map((r) => mtText(r["Offer ID"])));
  const { held, tombstoned, seo } = effective(st, mainIds);
  const gate = exclusionGate(st.exclusions, st.unnamed);
  const unconfirmed = [...st.unconfirmed].sort();
  const reasons = [...st.structural];
  const fingerprint = digest({
    v: "ccfp5", active: st.activated, blocked: st.blocked, reasons: [...reasons].sort(), held: [...held].sort(),
    tombstoned: [...st.exclusions].map(([id, x]) => `${id}:${x.opId}:${x.confirmed}:${x.source}:${identityDigest(x.identity)}`).sort(),
    // R7.1: рядки архіву без Offer ID входять у відбиток фільтра лише тоді, коли вони є (відбиток звичайного стану — як у R7).
    gate: digest([[...gate.knownIds].sort(), [...st.exclusions.values()].map((x) => identityDigest(x.identity)).sort(), ...(st.unnamed.length ? [st.unnamed.map((u) => `${u.ref}:${identityDigest(u.identity)}`).sort()] : [])]),
    damaged: [...st.damaged].sort(), unconfirmed, pending: st.pendingIntents.map((it) => `${it.op}:${it.offerId}:${it.seal}`).sort(),
    aborted: [...st.abortedByProduct.values()].flatMap((a) => a.list.map((e) => `${e.op}:${e.offerId}`)).sort(),
    seo: [...seo].map(([id, s]) => `${id}:${s.opId}`).sort(), confirmedOps: digest([...st.confirmed].sort()),
    // Видачі кодів (issued) на дозвіл публікації не впливають — у відбиток не входять (запит коду не міняє стану для споживачів).
    inputs: digest([canon(book[CC_SHEET.history]), opts.checkpoint === undefined ? "none" : withoutIssued(opts.checkpoint), (st.archive || []).map((r) => `${mtText(r["Offer ID"])}:${identityKey(identityOf(r))}`).sort()]),
  });
  const confirmed = !st.blocked && unconfirmed.length === 0;
  const rebound = [...st.releaseMismatch.keys()].map((id) => `${id}: ${REBOUND_TEXT}`);
  return { active: st.activated, blocked: st.blocked, reasons, issues: [...st.issues, ...[...st.isolated].map(([id, w]) => `${id}: ${w.join("; ")}`), ...rebound], held, tombstoned, gate, moves: st.moves, seo, seoReady: false, damaged: st.damaged, unconfirmed, confirmed, fingerprint };
}
/** Змістовна частина точки для відбитка: операції, наміри, скасовані (без часу запису й без видач кодів). Недійсна точка — як є. */
const withoutIssued = (c) => (validCheckpoint(c) ? { v: c.v, ops: c.ops, pending: c.pending, aborted: c.aborted } : c);
const REBOUND_TEXT = "повернення в продаж авторизовано для іншої фізичної ідентичності (або її не перевірити) — поза продажем; наступний apply запише автоматичне зняття, потрібне нове рішення власника";
const RECOVERED_TEXT = "код недійсний: видано до відновлення контрольної точки — впишіть команду без коду, система видасть новий";

/**
 * R7.3 (C5, cc-recovery-v1): нова контрольна точка після погодженого власником відновлення (чиста функція).
 *  base — відновлена (поточна) точка, якщо дійсна, інакше порожня; registry — дзеркало реєстру рішень Engineering (останній
 *  зафіксований стан без кодів; авторитетна надмножина ухвалених рішень); prepared — незавершений запис (міг не зафіксуватись);
 *  journal — події «Історії керування» (лише детектор: захисні рядки без прив'язки діють як захисні наміри, послаблення — визнано
 *  недійсними, ack; дозволу журнал не дає ніколи).
 *  Правила: ухвалені рішення (ops) = base ∪ registry (рішення власника не скасовуються відкатом); захисні наміри лишаються;
 *  послаблення, що чекали, й послаблення з prepared — скасовано (aborted); issued — порожньо (усі невикористані коди недійсні);
 *  та сама операція з різним вмістом — conflicts (товар ізольовано). Повертає точку v4 або null, якщо вона не валідна.
 */
export function recoverCheckpoint({ base, registry = null, prepared = null, journal = [], at, epoch, leaseId, generation = 0, type = "", fromHash = "" }) {
  const b = validCheckpoint(base) ? structuredClone(base) : emptyCheckpoint(at);
  const conflicts = new Set(), ack = new Set();
  const ops = new Map(b.ops.map((e) => [e.op, e]));
  for (const e of Array.isArray(registry?.ops) ? registry.ops : []) {
    if (!isOp(e)) { if (typeof e?.offerId === "string" && e.offerId) conflicts.add(e.offerId); continue; }
    const cur = ops.get(e.op);
    if (cur && (cur.seal !== e.seal || cur.offerId !== e.offerId)) conflicts.add(e.offerId);
    ops.set(e.op, structuredClone(e)); // реєстр — авторитетний
  }
  const aborted = new Map(b.aborted.map((e) => [e.op, e]));
  for (const e of Array.isArray(registry?.aborted) ? registry.aborted : []) if (isAborted(e) && !ops.has(e.op) && !aborted.has(e.op)) aborted.set(e.op, structuredClone(e));
  for (const k of ops.keys()) aborted.delete(k); // ухвалене в іншій гілці (реєстр) — ухвалене
  const pending = new Map();
  const abortedOf = (it, reason) => {
    const gen = /^(seo|sale):(\d+)$/.exec(mtText(it.row[8]));
    return { op: it.op, offerId: it.offerId, seal: it.seal, action: it.action, gen: gen ? Number(gen[2]) : 0, reason };
  };
  const asIntent = (e) => {
    if (isIntent(e)) return structuredClone(e);
    if (!isOp(e)) return null;
    const action = historyEvent(e.row).action;
    return { op: e.op, offerId: e.offerId, seal: e.seal, row: e.row.slice(), action, weakening: WEAKENING.has(action), cmd: "RECOVERY", auth: typeof e.auth === "string" ? e.auth : "", at: mtText(at) };
  };
  const consider = (e, why) => {
    if (!e || ops.has(e.op) || aborted.has(e.op) || pending.has(e.op)) return;
    const it = asIntent(e);
    if (!it) { if (typeof e?.offerId === "string" && e.offerId) conflicts.add(e.offerId); return; }
    if (it.weakening) aborted.set(it.op, abortedOf(it, why));
    else pending.set(it.op, it);
  };
  const WEAK = "відновлення: незавершене послаблення недійсне — потрібне нове підтвердження власника";
  for (const it of [...b.pending, ...(Array.isArray(registry?.pending) ? registry.pending : []), ...(Array.isArray(prepared?.pending) ? prepared.pending : [])]) consider(it, WEAK);
  for (const e of Array.isArray(prepared?.ops) ? prepared.ops : []) consider(e, WEAK); // могли не зафіксуватись
  for (const ev of journal || []) {
    if (!ev?.sealOk || ops.has(ev.opId) || pending.has(ev.opId) || aborted.has(ev.opId)) continue;
    if (WEAKENING.has(ev.action)) { ack.add(ev.opId); continue; }
    consider({ op: ev.opId, offerId: ev.offerId, seal: ev.seal, row: [ev.at, ev.opId, ev.offerId, ev.action, ev.field, ev.before, ev.after, ev.reason, ev.generation, ev.seal] }, WEAK);
  }
  const next = {
    v: CHECKPOINT_VERSION, at: mtText(at), ops: [...ops.values()].sort(byOp), pending: [...pending.values()].sort(byOp), aborted: [...aborted.values()].sort(byOp),
    epochHigh: epoch, leaseId, recovery: { generation, epoch, type: mtText(type), at: mtText(at), fromHash: mtText(fromHash), ack: [...ack].sort(), conflicts: [...conflicts].sort() },
  };
  return validCheckpoint(next) ? next : null;
}

/**
 * F2: чи чинна ВИДАЧА коду для дії товару — код збігається з виданим системою і збереженим у точці, а фізична ідентичність
 * (checkAuth), ревізія й вміст — ті самі, що при видачі. Збіг шести символів сам по собі не авторизує. null — чинна.
 */
function issuanceProblem(st, { offerId, action, code, identity, revision, payload = "", checkAuth = true }) {
  // До активації — лише оцінка (нічого не застосовується): розрахунковий код без видачі, як до R7.
  if (!st.activated) return code === confirmationCode({ offerId, identity, action, revision, payload }) ? null : "код недійсний або застарів — візьміть актуальний";
  const x = st.issued.get(issueKey(offerId, action));
  // R7.3 (C5, рішення власника 1): після відновлення всі невикористані коди недійсні — і ті, що могли б лишитись у точці.
  if (st.recovery && (!x || !(epochOf(x) > st.recovery.epoch))) return RECOVERED_TEXT;
  if (!x) return "код не видано — впишіть команду без коду, система видасть код";
  if (!x.code) return "код недійсний або застарів: його вже використано або скасовано — видано новий";
  if (x.code !== code) return "код недійсний або застарів — візьміть актуальний";
  if (checkAuth && x.auth !== identityKey(identity)) return "код недійсний або застарів: фізична ідентичність товару змінилась після видачі — видано новий";
  if (x.revision !== revision || x.payload !== payload) return "код недійсний або застарів: стан товару змінився після видачі — видано новий";
  return null;
}
/**
 * Нова видача (на запит або замість недійсної). R7.2 (Hermes C71-01): код = issuedCode(Offer ID, дія, epoch), epoch — токен оренди
 * запуску (cc-committer-v1: ціле ≥ 1, строго зростає з кожною видачею оренди; лічильник — у координаторі W2, не в контрольній
 * точці). На дію товару за запуск — не більше однієї видачі, тож коди всіх видач у будь-якій гілці історії точки попарно різні:
 * відновлена старіша точка (прямо чи через CAS з чинною орендою) не повертає коду, який власник отримав в іншій гілці.
 * cell — код у клітинці команди зараз (R7.1): видача, що збіглася б із ним, не робиться. Видачі немає й тоді, коли епоха не дійсна
 * (планування без оренди) — команда лишається без чинного коду (відмова). n — порядковий номер видачі (слід).
 */
function issueCode(st, { offerId, action, identity, revision, payload = "", at, cell = "", epoch = null }) {
  const key = issueKey(offerId, action), x = st.issued.get(key);
  const auth = identityKey(identity);
  const stale = st.recovery && !(epochOf(x) > st.recovery.epoch); // R7.3: видача до відновлення — недійсна, потрібна нова
  if (x && x.code && !stale && x.auth === auth && x.revision === revision && x.payload === payload) return null; // чинна — без змін
  if (!(Number.isInteger(epoch) && epoch >= 1 && epoch < EPOCH_LIMIT)) return null;
  const code = issuedCode({ offerId, action, n: epoch });
  const used = new Set([...(x?.prev || []), ...(x?.code ? [x.code] : []), ...(cell ? [cell] : [])]);
  if (used.has(code)) return null;
  return { key, offerId, action, code, epoch, auth, revision, payload, n: x ? x.n + 1 : 0, prev: [...(x?.prev || []), ...(x?.code ? [x.code] : [])].slice(-ISSUE_HISTORY), at: mtText(at) };
}

/**
 * Перевірка перед публікацією (для S6, у момент коміту): свіжий стан не blocked і відбиток той самий, що перевірено раніше.
 * Інакше — не публікувати (стан змінився між перевіркою й застосуванням або став невідомим).
 */
export function verifyControlsSnapshot(book, ctx, expectedFingerprint) {
  const st = controlsState(book, ctx);
  const reasons = [];
  if (st.blocked) reasons.push("стан керування blocked: " + st.reasons.join("; "));
  if (st.fingerprint !== expectedFingerprint) reasons.push("стан керування змінився після перевірки");
  return { ok: reasons.length === 0, reasons, fingerprint: st.fingerprint };
}

/**
 * R6 (правило власника 8): перевірка БУДЬ-ЯКОГО YML-кандидата перед публікацією — нового, перевикористаного, відкату до старої
 * версії, аварійного патча, резервної копії. feedOfferIds — Offer ID усіх <offer> кандидата; state — controlsState(...).
 * Видалений товар (будь-яка стадія, зокрема непідтверджене чи незавершене видалення) у кандидаті або стан blocked → не публікувати.
 */
export function feedViolations(feedOfferIds, state) {
  const ids = new Set([...(feedOfferIds || [])].map((x) => mtText(x)));
  const removedPresent = state?.tombstoned instanceof Map ? [...state.tombstoned.keys()].filter((id) => ids.has(id)).sort() : [];
  const reasons = [];
  if (!state || state.blocked !== false || !(state.tombstoned instanceof Map)) reasons.push("стан керування blocked або невідомий — публікацію заборонено");
  if (removedPresent.length) reasons.push(`YML містить видалені товари (Offer ID): ${removedPresent.join(", ")}`);
  return { ok: reasons.length === 0, removedPresent, reasons };
}

/** Рядки товару в «Основному каталозі» й «Видалених товарах» (для команд, авторизації й перевірок повернення). */
function cardsOf(st, id) {
  const m = (st.main || []).filter((r) => mtText(r["Offer ID"]) === id).map((row) => ({ row, where: "main" }));
  const a = (st.archive || []).filter((r) => mtText(r["Offer ID"]) === id).map((row) => ({ row, where: "archive" }));
  return [...m, ...a];
}

/**
 * Чи досі чинна авторизація власника для послаблювального наміру (F1, CC4-N1): рядок товару один, фізична ідентичність та сама, у
 * клітинці та сама команда з тим самим кодом (Operation ID збігається), код чинний щодо ПІДТВЕРДЖЕНОГО стану; для повернення з
 * архіву — усі перевірки цієї картки. Повертає причину відмови або null.
 */
export function authorizationProblem(it, st, book) {
  const s2 = book === st.book ? st : { ...st, main: rowsOf(book, SHEET.main), archive: book[ARCHIVE_SHEET] === undefined ? [] : rowsOf(book, ARCHIVE_SHEET) };
  const id = it.offerId;
  if (s2.main === null) return `«${SHEET.main}» не читається`;
  if (s2.archive === null) return `«${ARCHIVE_SHEET}» не читається`;
  const cards = cardsOf(s2, id);
  if (cards.length !== 1) return `рядків із цим Offer ID: ${cards.length}`;
  const { row, where } = cards[0];
  const identity = identityOf(row);
  if (identityKey(identity) !== it.auth) return "фізична ідентичність товару (ID / артикул постачальника) змінилась після коду";
  const p = st.confirmedFold.products.get(id) || emptyProduct();
  if (it.action === ACTION.SEO_APPROVED) {
    if (where !== "main") return "картки немає в «Основному каталозі»";
    const cmd = row[SEO_DECISION] !== undefined ? parseSeoCommand(row[SEO_DECISION]) : null;
    if (!cmd?.code) return "команду власника знято";
    const draft = seoValues(row);
    if (operationId({ offerId: id, action: ACTION.SEO_APPROVED, code: cmd.code, payload: seoSha(draft) }) !== it.op) return "команду або чернетку SEO змінено";
    // Ідентичність перевірено явно вище (M39); видача — код, ревізія й вміст ті самі, що при видачі.
    const why = issuanceProblem(st, { offerId: id, action: "SEO_APPROVE", code: cmd.code, identity, revision: revisionOf(st, id, "seo", p), payload: seoSha(draft), checkAuth: false });
    if (why) return "SEO: " + why;
    return null;
  }
  const cmd = row[SALE_DECISION] !== undefined ? parseSaleCommand(row[SALE_DECISION]) : null;
  if (!cmd?.code || cmd.kind !== it.cmd) return "команду власника знято або змінено";
  if (operationId({ offerId: id, action: cmd.kind, code: cmd.code, payload: cmd.reason }) !== it.op) return "команду власника змінено";
  // Ідентичність перевірено явно вище (M39); видача — код і ревізія ті самі, що при видачі (щодо ПІДТВЕРДЖЕНОГО стану).
  const why0 = issuanceProblem(st, { offerId: id, action: cmd.kind, code: cmd.code, identity, revision: revisionOf(st, id, "sale", p), checkAuth: false });
  if (why0) return why0;
  if (it.action === ACTION.RELEASE && where !== "main") return "картки немає в «Основному каталозі»";
  if (it.action === ACTION.RELEASE && cardVerdictOf(row, st.integrity).verdict === "CORRUPT") return "картка пошкоджена (вердикт M3 CORRUPT)";
  if (it.action === ACTION.UNTOMBSTONE) {
    const x = st.exclusions.get(id);
    if (!x) return "видалення не знайдено";
    const why = restoreProblems({ id, row, rowsWithId: cards.length, verdict: cardVerdictOf(row, st.integrity), registryIdentity: x.identity, mainRows: s2.main, queueRows: rowsOf(book, SHEET.queue), deferredRows: rowsOf(book, SHEET.deferred), tombstoned: new Set([...st.exclusions.keys()].filter((t) => t !== id)) });
    const anonRef = book[ARCHIVE_SHEET] === undefined ? null : unnamedArchive(book[ARCHIVE_SHEET]).of(row);
    if (anonRef) why.push(unnamedRestoreText(anonRef));
    if (why.length) return why.join("; ");
  }
  return null;
}

/**
 * Рішення для наміру після перевірочного читання (звірка й коміт): "confirm" | "keep" | { abort }. Захисний — підтверджується, щойно
 * його рядок є в журналі (довірений вміст — сам намір); інакше лишається наміром (діє, наступний запуск допише). Послаблювальний —
 * лише за збіжного рядка, непошкодженого товару й чинної авторизації; інакше скасовується.
 */
export function decideIntent(it, st, book) {
  const present = st.mirror.present.has(it.op);
  if (!it.weakening) return present ? "confirm" : "keep";
  if (!present) return { abort: "запис не підтверджено (рядка в журналі немає або він не збігається з довіреним наміром)" };
  if (st.damaged.has(it.offerId)) return { abort: "записи товару пошкоджено або не відповідають контрольній точці" };
  const why = authorizationProblem(it, st, book);
  return why ? { abort: why } : "confirm";
}

/**
 * План: події журналу з довіреними намірами. protection — { valid, fzIds, protectedIds, ovIds, reasons }; без валідного захисту
 * видалення не виконується. integrity — M3; publication — докази публікації; checkpoint — після активації обов'язковий.
 */
export function planControls({ book, stamp, config = {}, contract = null, protection = null, parsed = null, checkpoint = undefined, integrity = null, publication = null, epoch = null }) {
  const out = {
    abort: null, blocked: [], warnings: [], events: [], intents: [], notes: new Map(), inputColumns: { missing: [] }, issued: new Map(),
    stats: { seoApproved: 0, held: 0, released: 0, tombstoned: 0, untombstoned: 0, conflicts: 0, refused: 0, awaitingCode: 0 },
  };
  let main;
  try { main = readSheet(book[SHEET.main], SHEET.main); } catch (e) { out.abort = `«${SHEET.main}»: ${e.message}`; return out; }
  const cfg = controlsConfig(config, contract);
  if (cfg.problems.length) { out.abort = "некоректна конфігурація лімітів: " + cfg.problems.join("; "); return out; }
  const st = loadState(book, { contract, checkpoint, integrity, publication });
  out.warnings.push(...st.problems, ...st.issues);
  if (st.blocked) { out.blocked = st.structural; out.abort = st.structural.join("; ") + " — Catalog Controls не виконується"; return out; }
  if (st.mirror.journalBroken) { out.abort = `«${CC_SHEET.history}» не читається — нових операцій немає, доки заголовок не відновлено (стан товарів — з контрольної точки)`; return out; }
  out.inputColumns.missing = CC_INPUT_COLUMNS.filter((k) => !main.header.includes(k));
  if (out.inputColumns.missing.length) out.warnings.push(`колонки власника не додано (${out.inputColumns.missing.join(", ")}) — їхні команди не читаються; додаються процедурою активації спільного механізму`);
  const queueRows = rowsOf(book, SHEET.queue), deferredRows = rowsOf(book, SHEET.deferred);
  const note = (id, text) => out.notes.set(id, [...(out.notes.get(id) || []), text]);
  const refuse = (id, text) => { out.stats.refused++; note(id, text); };
  // Кожна подія — разом із довіреним наміром для контрольної точки (F1): точний рядок, печатка, авторизація (фізична ідентичність);
  // для команди власника — ключ видачі коду й сам код (R7: видачу вичерпано, щойно намір підтверджено або скасовано).
  const event = (args, { cmd = "", auth = "", iss = "", code = "" } = {}) => {
    const row = historyRow({ stamp, ...args });
    out.events.push(row);
    out.intents.push({ op: args.opId, offerId: args.offerId, seal: row.at(-1), row, action: args.action, weakening: WEAKENING.has(args.action), cmd, auth, ...(iss ? { iss, code } : {}), at: mtText(stamp) });
  };
  // R7 (F2): видача коду — лише після активації з контрольною точкою (зберігається в ній); у SHADOW / оцінці кодів не видано.
  // R7.2 (C71-01): і лише під орендою з дійсною епохою (токен), більшою за епохи вже збережених видач. Інакше лічильник оренди не
  // зростає відносно точки (скинуто координатор W2?) — неповторюваність кодів не доведена: кодів не видаємо, решта працює.
  const epochOk = Number.isInteger(epoch) && epoch >= 1 && epoch < EPOCH_LIMIT && epoch > st.maxEpoch;
  if (st.activated && st.checkpoint && epoch !== null && !epochOk) out.warnings.push(`коди підтвердження не видаються: токен оренди (${mtText(epoch)}) не більший за епоху вже виданих кодів (${st.maxEpoch}) або недійсний — лічильник оренди W2 (cc-committer-v1) має лише зростати; команди без чинного коду не виконуються`);
  const canIssue = st.activated && Boolean(st.checkpoint) && epochOk;
  const issue = (offerId, action, identity, revision, payload = "", cell = "") => {
    if (!canIssue) return;
    const e = issueCode(st, { offerId, action, identity, revision, payload, at: stamp, cell, epoch });
    if (e) out.issued.set(e.key, e);
  };
  const prot = protection?.valid ? protection : null;
  const intents = [];
  const sources = [...main.rows.map((row) => ({ row, where: "main" })), ...(st.archive || []).map((row) => ({ row, where: "archive" }))];
  const WHERE = { main: `«${SHEET.main}»`, archive: `«${ARCHIVE_SHEET}»` };

  for (const { row, where } of sources) {
    const id = mtText(row["Offer ID"]);
    const p = st.fold.products.get(id) || emptyProduct();
    const damaged = st.damaged.has(id);
    const identity = identityOf(row);
    const x = st.exclusions.get(id) || null;
    // У товару є операції, ще не підтверджені точкою, — нових команд не виконуємо до звірки.
    const waiting = st.activated && st.unconfirmedByProduct.has(id);
    const WAIT = "попередня операція ще не підтверджена контрольною точкою — команда виконається після звірки (наступний apply)";

    // ---------- SEO (лише «Основний каталог», не видалений товар) ----------
    const seoCmd = where === "main" && row[SEO_DECISION] !== undefined ? parseSeoCommand(row[SEO_DECISION]) : null;
    if (seoCmd && !x) {
      const draft = seoValues(row), approved = p.seo.current;
      const pending = approved ? !sameSeo(approved.values, draft) : !emptySeo(draft);
      const rev = revisionOf(st, id, "seo", p), payload = seoSha(draft);
      const opId = seoCmd.code ? operationId({ offerId: id, action: ACTION.SEO_APPROVED, code: seoCmd.code, payload }) : "";
      const why = seoCmd.code ? issuanceProblem(st, { offerId: id, action: "SEO_APPROVE", code: seoCmd.code, identity, revision: rev, payload }) : null;
      if (seoCmd.unknown) refuse(id, `«${SEO_DECISION}»: невідома команда «${short(seoCmd.unknown, 40)}» (можна: ${SEO_WORD} <код>)`);
      else if (opId && (st.fold.opIds.has(opId) || st.unconfirmed.has(opId))) { /* виконано / записано раніше — нічого */ }
      else if (!pending) note(id, "SEO: нової чернетки для затвердження немає");
      else if (!seoCmd.code) {
        out.stats.awaitingCode++;
        if (!damaged) issue(id, "SEO_APPROVE", identity, rev, payload);
        note(id, `SEO: щоб затвердити, допишіть код із колонки «Коди підтвердження»`);
      } else if (damaged) refuse(id, "SEO: записи товару пошкоджено / не відповідають контрольній точці — команда не виконується");
      else if (waiting) refuse(id, "SEO: " + WAIT);
      else if (why) { refuse(id, `SEO: ${why} (змінилися чернетка, товар чи затверджена версія)`); issue(id, "SEO_APPROVE", identity, rev, payload, seoCmd.code); }
      else {
        const problems = validateSeo(draft);
        if (problems.length) refuse(id, "SEO не затверджено: " + problems.join("; "));
        else {
          event({ opId, offerId: id, action: ACTION.SEO_APPROVED, field: "SEO", before: approved ? JSON.stringify(approved.values) : "", after: JSON.stringify({ values: draft, supplier: supplierSnapshot(row) }), reason: `рішення власника («${SEO_WORD} ${seoCmd.code}»)`, generation: `seo:${p.seo.n + 1}` }, { cmd: "SEO_APPROVE", auth: identityKey(identity), iss: issueKey(id, "SEO_APPROVE"), code: seoCmd.code });
          out.stats.seoApproved++;
        }
      }
    }

    // ---------- продаж / видалення / повернення з архіву ----------
    const cmd = row[SALE_DECISION] !== undefined ? parseSaleCommand(row[SALE_DECISION]) : null;
    if (!cmd) continue;
    if (cmd.kind === "UNKNOWN") {
      refuse(id, cmd.needsId ? `«${SALE_DECISION}»: потрібен Offer ID цього товару — «${short(cmd.raw, 30)} ${id} <код>»` : `«${SALE_DECISION}»: невідома команда «${short(cmd.raw, 40)}» (можна: ${Object.values(SALE_WORDS).join(", ")})`);
      continue;
    }
    if (cmd.id && cmd.id !== id) { refuse(id, `«${SALE_DECISION}»: Offer ID у команді (${cmd.id}) — не цього товару`); continue; }
    const opId = cmd.code ? operationId({ offerId: id, action: cmd.kind, code: cmd.code, payload: cmd.reason }) : "";
    if (opId && (st.fold.opIds.has(opId) || st.unconfirmed.has(opId))) continue; // виконано / записано раніше
    if (MAIN_ONLY.has(cmd.kind) && where !== "main") { if (opId) note(id, `«${SALE_WORDS[cmd.kind]}» діє лише в ${WHERE.main} — у ${WHERE[where]} команду не виконано`); continue; }
    if (cmd.kind === SALE_KIND.UNTOMBSTONE && !x) { refuse(id, `«${SALE_WORDS.UNTOMBSTONE}»: товар не видалено`); continue; }
    // Видалений товар: команди продажу не діють — відмова з причиною одразу (коду для них не видається).
    if (x && cmd.kind !== SALE_KIND.UNTOMBSTONE) {
      refuse(id, `«${SALE_WORDS[cmd.kind]}» не виконано: ${cmd.kind === SALE_KIND.TOMBSTONE ? "товар уже видалено" : cmd.kind === SALE_KIND.RELEASE ? `товар видалено — спершу «${SALE_WORDS.UNTOMBSTONE} ${id} <код>»` : "товар видалено"}`);
      continue;
    }
    const rev = revisionOf(st, id, "sale", p);
    if (!cmd.code) {
      out.stats.awaitingCode++;
      if (!damaged) issue(id, cmd.kind, identity, rev);
      note(id, `«${SALE_WORDS[cmd.kind]}»: допишіть код із колонки «Коди підтвердження»`);
      continue;
    }
    if (damaged) { refuse(id, "записи товару пошкоджено / не відповідають контрольній точці — команда не виконується"); continue; }
    if (waiting) { refuse(id, WAIT); continue; }
    const why = issuanceProblem(st, { offerId: id, action: cmd.kind, code: cmd.code, identity, revision: rev });
    if (why) { refuse(id, `«${SALE_WORDS[cmd.kind]}»: ${why}`); issue(id, cmd.kind, identity, rev, "", cmd.code); continue; }
    intents.push({ id, row, where, p, x, identity, cmd, opId, iss: issueKey(id, cmd.kind), code: cmd.code });
  }

  // ---------- передумови й ліміти ----------
  const ready = [];
  for (const it of intents) {
    const { id, row, p, x, cmd } = it;
    const why = [];
    const cards = cardsOf(st, id);
    if (cmd.kind === SALE_KIND.HOLD) { if (x) why.push("товар видалено"); else if (p.sale.held) why.push("товар уже знято з продажу"); }
    else if (cmd.kind === SALE_KIND.RELEASE) {
      if (x) why.push(`товар видалено — спершу «${SALE_WORDS.UNTOMBSTONE} ${id} <код>»`);
      else if (!p.sale.held) why.push("товар уже в продажу");
      // C: дозволені правки (OK / OWNER_EDIT) і невідомий без M3 стан (UNVERIFIED) не блокують; явне пошкодження — так.
      const v = cardVerdictOf(row, integrity);
      if (v.verdict === "CORRUPT") why.push(`картка пошкоджена (CORRUPT${v.reasons.length ? ": " + v.reasons.join("; ") : ""}) — повернення в продаж не виконується`);
    } else if (cmd.kind === SALE_KIND.TOMBSTONE) {
      if (x) why.push("товар уже видалено");
      // R6: одна дія власника — товар у продажу знімається внутрішнім захисним переходом у тому самому запуску (нижче).
      if (!prot) why.push("захист FZ / перелік захищених / OV не перевірено" + (protection?.reasons?.length ? ` (${protection.reasons.join("; ")})` : ""));
      else if (prot.fzIds?.has(id) || prot.protectedIds?.has(id) || prot.ovIds?.has(id)) why.push("захищений товар (FZ / перелік захищених / рішення власника OV) — без окремо погодженої політики не видаляється");
      const v = cardVerdictOf(row, integrity);
      if (!ALLOWED_VERDICTS.has(v.verdict)) why.push(`картка не пройшла перевірку цілісності (${v.verdict}${v.reasons.length ? ": " + v.reasons.join("; ") : ""})`);
      if (cards.length !== 1) why.push(`рядків із цим Offer ID у «Основному каталозі» й «Видалених товарах»: ${cards.length}`);
    } else if (cmd.kind === SALE_KIND.UNTOMBSTONE) {
      if (!x.confirmed) why.push("видалення ще не підтверджене контрольною точкою");
      else why.push(...restoreProblems({ id, row, rowsWithId: cards.length, verdict: cardVerdictOf(row, integrity), registryIdentity: x.identity, offer: parsed?.offers?.get(mtText(x.identity.supplierId)) || null, mainRows: st.main || [], queueRows, deferredRows, tombstoned: new Set([...st.exclusions.keys()].filter((t) => t !== id)) }));
      const anonRef = st.unnamedOf(row);
      if (anonRef) why.push(unnamedRestoreText(anonRef));
    }
    if (why.length) refuse(id, `«${SALE_WORDS[cmd.kind]}» не виконано: ${why.join("; ")}`);
    else ready.push(it);
  }
  const bucket = (k) => (k === SALE_KIND.HOLD || k === SALE_KIND.RELEASE ? "sale" : "permanent");
  const limitOf = { sale: cfg.limits.maxSaleChangesPerRun, permanent: cfg.limits.maxPermanentPerRun };
  const sizes = { sale: ready.filter((x) => bucket(x.cmd.kind) === "sale").length, permanent: ready.filter((x) => bucket(x.cmd.kind) === "permanent").length };
  for (const b of ["sale", "permanent"]) if (sizes[b] > limitOf[b]) out.warnings.push(`${b === "sale" ? "змін продажу" : "видалень / повернень з архіву"} ${sizes[b]} > ліміт ${limitOf[b]} — жодну не виконано`);

  for (const it of ready) {
    const { id, row, p, cmd, opId } = it;
    const b = bucket(cmd.kind);
    if (sizes[b] > limitOf[b]) { refuse(id, `«${SALE_WORDS[cmd.kind]}» не виконано: забагато за один запуск (${sizes[b]} > ${limitOf[b]})`); continue; }
    const gen = `sale:${p.sale.n + 1}`;
    const meta = { cmd: cmd.kind, auth: identityKey(it.identity), iss: it.iss, code: it.code };
    if (cmd.kind === SALE_KIND.HOLD) { event({ opId, offerId: id, action: ACTION.HOLD, field: "Продаж", before: "У ПРОДАЖУ", after: "ЗНЯТО", reason: cmd.reason || "рішення власника", generation: gen }, meta); out.stats.held++; }
    else if (cmd.kind === SALE_KIND.RELEASE) { event({ opId, offerId: id, action: ACTION.RELEASE, field: "Продаж", before: "ЗНЯТО", after: "У ПРОДАЖУ", reason: "рішення власника", generation: gen }, meta); out.stats.released++; }
    else if (cmd.kind === SALE_KIND.TOMBSTONE) {
      // R6: товар у продажу — спершу внутрішній захисний перехід «ЗНЯТО З ПРОДАЖУ» (той самий запуск, ті самі наміри в точці);
      // згортка лишає інваріант «видалення — лише зі знятого». Operation ID похідний від операції видалення (детермінований).
      let n = p.sale.n;
      if (!p.sale.held) {
        const holdOp = operationId({ offerId: id, action: "TOMBSTONE_HOLD", code: opId });
        event({ opId: holdOp, offerId: id, action: ACTION.HOLD, field: "Продаж", before: "У ПРОДАЖУ", after: "ЗНЯТО", reason: `внутрішній захисний перехід перед видаленням («${SALE_WORDS.TOMBSTONE} ${id}»)`, generation: `sale:${++n}` }, { cmd: meta.cmd, auth: meta.auth });
      }
      // «Стало» — мінімальна фізична ідентичність для реєстру видалень і фільтра повторного створення (довірена).
      event({ opId, offerId: id, action: ACTION.TOMBSTONE, field: "Каталог", before: "", after: JSON.stringify(identityOf(row)), reason: `рішення власника («${SALE_WORDS.TOMBSTONE} ${id}»); товар виключено з нового YML; перенесення в «${ARCHIVE_SHEET}» — Engineering`, generation: `sale:${n + 1}` }, meta);
      out.stats.tombstoned++;
    } else {
      event({ opId, offerId: id, action: ACTION.UNTOMBSTONE, field: "Каталог", before: it.x.opId, after: "", reason: `рішення власника («${SALE_WORDS.UNTOMBSTONE} ${id}»); перенесення в «${SHEET.main}» — Engineering; товар лишається знятим з продажу`, generation: gen }, meta);
      out.stats.untombstoned++;
    }
  }

  // ---------- конфлікт фізичної ідентичності видалених (постачальник повторно використав ID) — лише позначка ----------
  for (const [id, x] of st.exclusions) {
    if (!x.confirmed) continue;
    const card = cardsOf(st, id)[0]?.row || null;
    const diffs = card ? physicalDifferences(x.identity, identityOf(card)) : [];
    const offer = parsed?.offers?.get(mtText(x.identity.supplierId));
    if (offer) for (const d of physicalDifferences(x.identity, { supplierId: mtText(offer.id), sku: offer.sku, nameUa: offer.nameUa, nameRu: offer.nameRu, url: offer.url })) if (!diffs.includes(d)) diffs.push("у фіді: " + d);
    if (!diffs.length) continue;
    out.stats.conflicts++;
    const text = diffs.join("; ");
    const opId = operationId({ offerId: id, action: ACTION.CONFLICT, code: x.opId, payload: text });
    if (!st.fold.opIds.has(opId) && !st.unconfirmed.has(opId)) event({ opId, offerId: id, action: ACTION.CONFLICT, field: "Ідентичність", before: JSON.stringify(x.identity), after: text, reason: "фізична ідентичність відрізняється від реєстру видалення — ручна перевірка; нічого не видалено й не додано" });
  }
  return out;
}

const LABEL = Object.freeze({
  [ACTION.HOLD]: "зняття з продажу", [ACTION.RELEASE]: "повернення в продаж", [ACTION.TOMBSTONE]: "видалення товару",
  [ACTION.UNTOMBSTONE]: "повернення з архіву", [ACTION.SEO_APPROVED]: "затвердження SEO", [ACTION.CONFLICT]: "позначка конфлікту ідентичності",
});
/** Товари, яких торкаються наміри запуску: Map(Offer ID → { sale: [дії], seo: [дії] }) — для позначки НЕВИЗНАЧЕНО до коміту. */
export function affectedBy(intents) {
  const m = new Map();
  for (const it of intents) {
    const a = m.get(it.offerId) || { sale: [], seo: [] };
    const label = LABEL[it.action] || it.action;
    const list = it.action === ACTION.SEO_APPROVED ? a.seo : a.sale;
    if (!list.includes(label)) list.push(label);
    m.set(it.offerId, a);
  }
  return m;
}

const STAGE_TEXT = Object.freeze({
  REGISTERED: "ВИДАЛЕННЯ ЗАРЕЄСТРОВАНО — у новий YML товар не передається; очікує перенесення в «Видалені товари» (не завершено)",
  MOVING: "ПЕРЕНЕСЕННЯ В АРХІВ НЕ ЗАВЕРШЕНО — однакова копія в обох аркушах; Engineering завершить перенесення (не завершено)",
  ARCHIVED: "В АРХІВІ «Видалені товари» — очікує підтвердження, що опублікований YML уже не містить цього товару (не завершено)",
  DONE: "ВИДАЛЕНО — рішення зафіксовано, товар в архіві, опублікований YML його не містить",
  ANOMALY: "АНОМАЛІЯ: рядок товару в обох аркушах (різні копії), ніде або двічі — переносу немає, товар ізольовано (поза YML); потрібна перевірка",
  UNREGISTERED: "У «Видалених товарах» без рішення Catalog Controls — поза YML, повторне додавання заборонене; потрібна перевірка",
  UNBOUND: "Видалення з рядка журналу без прив'язки до контрольної точки — діє (fail-closed, поза YML); потрібна перевірка",
  UNKNOWN: "Аркуш «Основний каталог» / «Видалені товари» не читається — стадію не визначено; товар поза YML",
});

/**
 * «Стан керування» з поточних аркушів і контрольної точки (детерміновано: без часу запуску — повтор без змін не дає запису).
 * uncertain — товари, яких торкається запуск, поки коміт не підтверджено (affectedBy): НЕВИЗНАЧЕНО з часу since і без кодів (F3).
 * Стан опублікованого YML вигляд стверджує лише з доказом publication (Engineering); підтвердження Prom не потрібне.
 */
export function buildView(book, { contract = null, checkpoint = undefined, notes = new Map(), shadow = false, uncertain = null, since = "", integrity = null, publication = null } = {}) {
  const st = loadState(book, { contract, checkpoint, integrity, publication });
  const mainRows = st.main || [];
  const mainIds = new Set(mainRows.map((r) => mtText(r["Offer ID"])));
  const eff = effective(st, mainIds);
  const ids = new Set([...st.fold.products.keys(), ...st.exclusions.keys(), ...st.restoring.keys(), ...st.damaged, ...notes.keys(), ...st.unconfirmedByProduct.keys(), ...(uncertain?.keys() || [])]);
  for (const r of [...mainRows, ...(st.archive || [])]) if (CC_INPUT_COLUMNS.some((k) => mtText(r[k]).trim())) ids.add(mtText(r["Offer ID"]));
  const out = [VIEW_HEADERS.slice()];
  for (const id of [...ids].filter(Boolean).sort()) {
    const card = cardsOf(st, id);
    const { row = null, where = "" } = card.length === 1 ? card[0] : {};
    const p = st.fold.products.get(id) || emptyProduct();
    const x = st.exclusions.get(id);
    const restoring = st.restoring.get(id);
    const damaged = st.damaged.has(id);
    const identity = row ? identityOf(row) : null;
    const unc = uncertain?.get(id) || null;
    const pend = st.activated ? st.unconfirmedByProduct.get(id) || [] : [];
    const warn = [...(notes.get(id) || [])];
    if (!card.length && !x) warn.push("картки немає ні в «Основному каталозі», ні у «Видалених товарах»");
    if (card.length > 1) warn.push(`рядків із цим Offer ID: ${card.length}`);
    if (damaged) warn.push(...(st.isolated.get(id) || [`записи товару в «${CC_SHEET.history}» пошкоджено — fail-closed, потрібна перевірка`]));
    if (x && identity) { const d = physicalDifferences(x.identity, identity); if (d.length) warn.push(`${ACTION.CONFLICT} — фізична ідентичність картки відрізняється від реєстру видалення (Було → Стало): ${d.join("; ")}; нічого не видалено й не додано, ручна перевірка`); }
    if (x && feedHasOffer(st.publication instanceof Map ? st.publication.get(id) : null)) warn.push("опублікований YML ще містить цей Offer ID — очікує публікації нової версії без нього (внутрішній стан; дій власника не потрібно)");
    if (st.releaseMismatch.has(id)) warn.push(REBOUND_TEXT);
    if (pend.length) warn.push("є наміри, ще не підтверджені контрольною точкою: діють лише захисні (зняти / видалити); звірка — наступний apply");
    for (const e of st.abortedByProduct.get(id)?.list || []) {
      if (e.gen > (domainOf(e.action) === "seo" ? p.seo.n : p.sale.n)) warn.push(`«${LABEL[e.action] || e.action}» скасовано під час звірки: ${e.reason} — товар лишається поза продажем (для SEO діє попередня версія); потрібне нове рішення з новим кодом`);
    }
    let sale0 = damaged ? "ПОЗА ПРОДАЖЕМ (ізольовано): записи товару потребують перевірки" : x ? "ПОЗА ПРОДАЖЕМ: товар видалено — у новий YML не передається"
      : restoring && restoring.stage !== "RESTORED" ? "ПОЗА ПРОДАЖЕМ: повернення з архіву зареєстровано — очікує перенесення в каталог; повернення в продаж — окремою командою"
        : p.sale.held ? heldText(p.sale.since, p.sale.reason)
          : st.releaseMismatch.has(id) ? "ПОЗА ПРОДАЖЕМ: повернення в продаж авторизовано для іншої фізичної ідентичності — потрібне нове рішення власника"
          : !eff.held.has(id) ? "У ПРОДАЖУ"
            : pend.some((it) => it.action === ACTION.RELEASE) ? "ПОЗА ПРОДАЖЕМ: повернення в продаж не підтверджене — НЕВИЗНАЧЕНО до звірки"
              : "ПОЗА ПРОДАЖЕМ: захисна операція діє з довіреного наміру; запис у журнал ще не підтверджено";
    if (unc?.sale.length) sale0 = `НЕВИЗНАЧЕНО з ${since}: ${unc.sale.join(", ")} — результат ще не підтверджено; не вважати товар ні знятим, ні поверненим у продаж`;
    if (unc) warn.unshift("НЕВИЗНАЧЕНО: запуск ще не підтвердив результат (або перервався) — команди товару до звірки не виконуються; звірка: наступний apply перечитає контрольну точку й журнал");
    const sale = shadow ? `SHADOW · не застосовано · ${sale0}` : sale0;
    if (shadow) warn.unshift("SHADOW: нічого не застосовано — стан не записано й не діє на YML / Prom");
    let seo = "—";
    const codes = [];
    const draft = row && where === "main" ? seoValues(row) : null;
    const a = eff.seo.get(id) || st.confirmedFold.products.get(id)?.seo.current || null;
    if (p.seo.current && p.seo.current.opId !== a?.opId) warn.push("SEO: нове затвердження ще не підтверджене контрольною точкою — діє попередня версія");
    if (a) {
      seo = `ЗАТВЕРДЖЕНО ${dayOf(a.at)} · версія ${a.n} · ${seoSha(a.values)}`;
      warn.push(...seoAdvice(a.values).map((t) => "SEO: " + t));
      if (draft && !sameSeo(a.values, draft)) warn.push(emptySeo(draft) ? "SEO: у картці порожньо — діє затверджене" : "SEO: у картці чернетка, відмінна від затвердженої — діє затверджене");
      if (row) { const ch = supplierChanges(a.supplier, row); if (ch.length) warn.push("дані постачальника змінились після затвердження SEO (Було → Стало): " + ch.join("; ")); }
    } else if (draft && !emptySeo(draft)) seo = "ЧЕРНЕТКА (не затверджено)";
    if (unc?.seo.length) seo = `НЕВИЗНАЧЕНО з ${since}: ${unc.seo.join(", ")} — результат ще не підтверджено`;
    const inputs = row && CC_INPUT_COLUMNS.every((k) => k in row);
    if (row && inputs && !damaged && !unc) {
      // R7 (F2): лише ЧИННІ видачі зі збереженої точки — для тієї самої фізичної ідентичності, ревізії й вмісту. Код видається на запит
      // (команда без коду); проактивно розрахованих кодів немає — вони нічого не авторизували б.
      const valid = (kind, revision, payload = "") => {
        if (!st.activated) return confirmationCode({ offerId: id, identity, action: kind, revision, payload }); // лише оцінка до активації
        const e = st.issued.get(issueKey(id, kind));
        if (st.recovery && !(epochOf(e) > st.recovery.epoch)) return ""; // R7.3: видача до відновлення — не показується
        return e && e.code && e.auth === identityKey(identity) && e.revision === revision && e.payload === payload ? e.code : "";
      };
      const saleRev = revisionOf(st, id, "sale", p);
      const push = (label, code) => { if (code) codes.push(`${label} ${code}`); };
      if (x) { if (x.confirmed && x.source === "registry") push(`${SALE_WORDS.UNTOMBSTONE} ${id}`, valid(SALE_KIND.UNTOMBSTONE, saleRev)); }
      else if (where === "main" && !(restoring && restoring.stage !== "RESTORED")) {
        if (a ? !sameSeo(a.values, draft) : !emptySeo(draft)) push(SEO_WORD, valid("SEO_APPROVE", revisionOf(st, id, "seo", p), seoSha(draft)));
        if (p.sale.held) { push(SALE_WORDS.RELEASE, valid(SALE_KIND.RELEASE, saleRev)); push(`${SALE_WORDS.TOMBSTONE} ${id}`, valid(SALE_KIND.TOMBSTONE, saleRev)); }
        else { push(SALE_WORDS.HOLD, valid(SALE_KIND.HOLD, saleRev)); push(`${SALE_WORDS.TOMBSTONE} ${id}`, valid(SALE_KIND.TOMBSTONE, saleRev)); }
      }
    }
    let excl = "—";
    if (x) {
      excl = `${x.at ? dayOf(x.at) + " · " : ""}${!x.confirmed && x.source === "registry" ? "ВИДАЛЕННЯ ЗАПИСАНО НАМІРОМ — очікує підтвердження контрольною точкою" : STAGE_TEXT[x.stage] || x.stage}`;
      const offerNote = st.moves.toArchive.includes(id) ? " · до перенесення в архів готово" : "";
      excl += offerNote;
    } else if (restoring && restoring.stage === "RESTORE_REQUESTED") excl = "ПОВЕРНЕННЯ З АРХІВУ ЗАРЕЄСТРОВАНО — очікує перенесення в «Основний каталог»";
    else if (restoring && restoring.stage === "MOVING") excl = "ПОВЕРНЕННЯ З АРХІВУ: перенесення не завершено — однакова копія в обох аркушах; Engineering завершить перенесення";
    else if (restoring && restoring.stage === "ANOMALY") excl = STAGE_TEXT.ANOMALY;
    const actuality = !st.activated ? (shadow ? "SHADOW · оцінка без активації" : "НЕ АКТИВОВАНО — лише оцінка")
      : unc ? `НЕВИЗНАЧЕНО з ${since}` : pend.length ? `ОЧІКУЄ ЗВІРКИ: ${[...new Set(pend.map((it) => LABEL[it.action] || it.action))].join(", ")}`
        : shadow ? "SHADOW · за збереженою контрольною точкою" : "ПІДТВЕРДЖЕНО контрольною точкою";
    const last = [...p.events].filter((e) => e.action !== ACTION.CONFLICT).sort((u, v) => (u.at < v.at ? -1 : u.at > v.at ? 1 : 0)).at(-1);
    out.push([id, short(row?.["Назва UA"], 80), sale, seo, excl, codes.join(" · "), [...new Set(warn)].join(" | "), last ? `${dayOf(last.at)} ${last.action} · ${last.opId.slice(3, 11)}` : "", actuality]);
  }
  return out;
}
