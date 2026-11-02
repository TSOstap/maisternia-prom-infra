/** ENG-28 — стан «Видалений у постачальника» і порівняння з останнім ПІДТВЕРДЖЕНИМ знімком повного сирого фіду постачальника.
 *  Чисті функції (без мережі й записів).
 *
 *  Правила (доручення власника 01.11.2026, розд. 1–2):
 *   - «видалений у постачальника» — лише якщо товар був в ОСТАННЬОМУ ПІДТВЕРДЖЕНОМУ знімку повного фіду, а в новому — повному й
 *     успішно перевіреному (доказ повноти: proveComplete) — його немає;
 *   - фід недоступний, неповний, пошкоджений, не повний (операційний / medium) або повноту не доведено → жодних масових позначок (SKIP);
 *   - аномально велике зникнення → HOLD зі звітом, нічого не застосовано;
 *   - повернення товару — окрема позначка; ціна, наявність і захисні рішення (CC: HOLD / видалення) діють як завжди;
 *   - видалення власником (Catalog Controls) ≠ видалення постачальником: товари, видалені власником, тут не позначаються;
 *   - картка з основного каталогу не видаляється, SEO / характеристики / історія / рішення власника не змінюються — лише дві системні
 *     колонки (PRESENCE_COLUMNS). Порожня «Стан у постачальника» = присутній (масового запису 5 000+ клітинок немає);
 *   - статус у таблиці НЕ дозвіл видаляти товар у Prom: exportAvailability — лише правило «немає в наявності» для майбутнього експорту. */
import crypto from "node:crypto";
import { scanFeed, sheetFingerprint, changedParts } from "./intake.mjs";
import { validateFeed } from "./supplier-feed.mjs";
import { parseZonedDate } from "./time.mjs";
import { mtText } from "./text.mjs";

export const PRESENCE = Object.freeze({
  PRESENT: "",
  GONE: "ВИДАЛЕНИЙ_У_ПОСТАЧАЛЬНИКА",
  RETURNED: "ПОВЕРНУВСЯ_У_ПОСТАЧАЛЬНИКА",
  ABSENT_IN_SNAPSHOT: "ВІДСУТНІЙ_У_ЗНІМКУ",
});
export const PRESENCE_COLUMN = "Стан у постачальника";
export const PRESENCE_META_COLUMN = "Знімок постачальника JSON";
export const PRESENCE_COLUMNS = Object.freeze([PRESENCE_COLUMN, PRESENCE_META_COLUMN]);
/** Поріг HOLD (погоджено власником 01.11): 50 товарів або 2 % попереднього підтвердженого знімка — див. holdLimit. */
export const PRESENCE_LIMITS = Object.freeze({ maxGoneAbsolute: 50, maxGoneRatio: 0.02 });
/** ENG-28a (рішення власника 01.11): поріг HOLD — МЕНШИЙ із двох (50 товарів або 2 % попереднього ПІДТВЕРДЖЕНОГО знімка, з округленням
 *  угору); спрацьовує при ДОСЯГНЕННІ (≥). Частка 0 / не задана — поріг лише абсолютний. 0 зниклих — ніколи не HOLD. */
export function holdLimit(limits = PRESENCE_LIMITS, previousCount = 0) {
  const abs = Number.isFinite(limits?.maxGoneAbsolute) && limits.maxGoneAbsolute > 0 ? limits.maxGoneAbsolute : Infinity;
  const rel = Number.isFinite(limits?.maxGoneRatio) && limits.maxGoneRatio > 0 && previousCount > 0 ? Math.ceil(limits.maxGoneRatio * previousCount) : Infinity;
  return Math.min(abs, rel);
}
/** ENG-28a: параметри адреси фіду, що звужують охоплення (фільтр груп / товарів / міток). Значення не повертаються — лише назви. */
export const FEED_FILTER_PARAMS = Object.freeze(["group_ids", "nested_group_ids", "product_ids", "label_ids"]);
export function feedScopeOf(rawUrl) {
  let u = null;
  try { u = new URL(mtText(rawUrl)); } catch { return { scope: "unknown", by: [] }; }
  const by = FEED_FILTER_PARAMS.filter((k) => mtText(u.searchParams.get(k)).trim() !== "");
  return { scope: by.length ? "filtered" : "full", by };
}
export const CONFIRMED_SNAPSHOT_KEY = "state/supplier-snapshot/confirmed.json";
/** Повний фід: фото — у ≥ 90 % offer і опис — у ≥ 50 % (операційний / medium фід описів і / або фото не має). */
export const FULL_COVERAGE = Object.freeze({ pictures: 0.9, descriptions: 0.5 });

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
/** Джерело без параметрів запиту (ключ / секрет у адресі не зберігається й не друкується). */
export function maskSource(raw) {
  const s = mtText(raw).trim();
  if (!s) return "";
  try { const u = new URL(s); return u.host + u.pathname; } catch { return s.replace(/[?#].*$/, ""); }
}

/** Знімок фіду: id, дата фіду, джерело, кількість, набір ID постачальника, відбитки суттєвих полів (s1: назви, артикул, URL, фото,
 *  характеристики, опис). Обірваний документ / повторені ID → виняток (scanFeed): фід пошкоджений. */
export function snapshotFromXml(xml, { source = "", fetchedAt = "", scope = null } = {}) {
  const scan = scanFeed(xml, () => true);
  const ids = [...scan.ids].sort();
  const fp = {};
  let pictures = 0, descriptions = 0;
  for (const id of ids) {
    const raw = scan.offers.get(id);
    fp[id] = sheetFingerprint(raw);
    if ((raw.pictures || []).length) pictures++;
    if (raw.hasDescription) descriptions++;
  }
  const n = ids.length || 1;
  const kind = pictures / n >= FULL_COVERAGE.pictures && descriptions / n >= FULL_COVERAGE.descriptions ? "full" : pictures === 0 ? "operational" : "partial";
  const idsSha = sha256(ids.join("\n"));
  const id = "sn-" + sha256(`${scan.date}|${ids.length}|${idsSha}|${sha256(JSON.stringify(fp))}`).slice(0, 16);
  // ENG-28a: охоплення — з адреси фіду (фільтр груп / товарів → «filtered»: відсутність поза охопленням НЕ доказ видалення).
  const sc = scope || feedScopeOf(source);
  return { v: 1, id, feedDate: scan.date, fetchedAt: mtText(fetchedAt), source: maskSource(source), scope: sc.scope === "unknown" ? "filtered" : sc.scope, scopeBy: sc.by, kind, count: ids.length, idsSha, ids, fp, coverage: { pictures, descriptions } };
}

/** Доказ повноти: повний фід + validateFeed (мінімум, падіння проти ПІДТВЕРДЖЕНОГО знімка, свіжість) + не старіший за підтверджений. */
export function proveComplete(snapshot, { previous = null, now, supplierConfig }) {
  const reasons = [];
  if (!snapshot || !Array.isArray(snapshot.ids)) return { complete: false, reasons: ["немає знімка фіду"] };
  if (snapshot.kind !== "full") reasons.push(`фід не повний сирий (${snapshot.kind}): потрібен повний YML постачальника`);
  try { validateFeed({ count: snapshot.count, date: snapshot.feedDate }, previous?.count ?? null, now, supplierConfig); }
  catch (e) { reasons.push(mtText(e?.message || e)); }
  if (previous?.feedDate && snapshot.feedDate) {
    const a = parseZonedDate(snapshot.feedDate, supplierConfig.timeZone), b = parseZonedDate(previous.feedDate, supplierConfig.timeZone);
    if (Number.isFinite(a) && Number.isFinite(b) && a < b) reasons.push("знімок старіший за останній підтверджений");
  }
  if (previous && previous.id === snapshot.id) reasons.push("той самий знімок, що й підтверджений (нових даних немає)");
  return { complete: reasons.length === 0, reasons };
}

const parseMeta = (v) => { try { const o = JSON.parse(mtText(v) || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
const metaCell = (o) => JSON.stringify(o);

/**
 * План присутності для активних карток основного каталогу.
 * rows: [{ offerId, supplierId, presence, meta }] — поточні значення системних колонок.
 * removed: Set Offer ID, видалених власником (CC) — не позначаються (інший стан).
 * → { decision: "APPLY" | "HOLD" | "SKIP", reasons, gone, returned, absent, changed, updates: Map(offerId → { presence, meta, reason }) }
 */
export function planPresence({ rows, previous = null, snapshot, proof, stamp, limits = PRESENCE_LIMITS, removed = new Set() }) {
  const out = { decision: "SKIP", reasons: [], gone: [], returned: [], absent: [], changed: [], outOfScope: [], updates: new Map(), baseline: !previous };
  // ENG-28a: фід із фільтром охоплення — відсутній товар може бути поза охопленням: ні «видалений», ні «відсутній у знімку».
  // «Видалений у постачальника» — лише коли і підтверджений, і новий знімок ПОВНІ (без фільтра).
  const filtered = snapshot?.scope !== "full";
  const fullPair = !filtered && previous?.scope === "full";
  if (!proof?.complete) { out.reasons = ["повноту фіду не доведено — масові позначки заборонено", ...(proof?.reasons || [])]; return out; }
  const now = new Set(snapshot.ids);
  const before = previous ? new Set(previous.ids) : null;
  const base = { checkedAt: stamp, snapshotId: snapshot.id, feedDate: snapshot.feedDate, source: snapshot.source, previousSnapshotId: previous?.id ?? null };
  for (const r of rows) {
    const offerId = mtText(r.offerId), sid = mtText(r.supplierId);
    if (!offerId || !sid || removed.has(offerId)) continue;
    const cur = mtText(r.presence).trim();
    const meta = parseMeta(r.meta);
    if (now.has(sid)) {
      if (cur === PRESENCE.GONE || cur === PRESENCE.ABSENT_IN_SNAPSHOT) {
        out.returned.push(offerId);
        out.updates.set(offerId, { presence: PRESENCE.RETURNED, meta: metaCell({ ...base, state: PRESENCE.RETURNED, returnedAt: stamp, previousState: cur, since: meta.since ?? null }), reason: "повернувся у фід постачальника" });
      } else if (cur === PRESENCE.RETURNED) {
        out.updates.set(offerId, { presence: PRESENCE.PRESENT, meta: metaCell({ ...base, state: "ПРИСУТНІЙ", returnedAt: meta.returnedAt ?? null }), reason: "присутній (після повернення)" });
      }
      // Зміни суттєвих полів проти ПІДТВЕРДЖЕНОГО знімка (лише інформація; поля картки тут не змінюються).
      const was = previous?.fp?.[sid], is = snapshot.fp?.[sid];
      if (was && is && was !== is) {
        const parts = changedParts(was, is);
        if (parts.length) {
          out.changed.push({ offerId, parts });
          const u = out.updates.get(offerId);
          const m = { ...(u ? parseMeta(u.meta) : { ...base, state: cur && cur !== PRESENCE.RETURNED ? cur : "ПРИСУТНІЙ" }), lastChange: { at: stamp, parts, snapshotId: snapshot.id, previousSnapshotId: previous.id } };
          out.updates.set(offerId, { presence: u ? u.presence : cur, meta: metaCell(m), reason: u ? u.reason : "змінено у фіді постачальника: " + parts.join(", ") });
        }
      }
      continue;
    }
    // Немає в новому повному фіді.
    if (cur === PRESENCE.GONE) continue; // уже позначено — дата «since» не змінюється
    if (filtered) { out.outOfScope.push(offerId); continue; } // поза охопленням фіду — жодних позначок
    if (fullPair && before && before.has(sid)) {
      out.gone.push(offerId);
      out.updates.set(offerId, { presence: PRESENCE.GONE, meta: metaCell({ ...base, state: PRESENCE.GONE, since: stamp, previousState: cur || "ПРИСУТНІЙ" }), reason: "був у підтвердженому знімку " + previous.id + ", немає в новому повному" });
    } else if (!cur) {
      // Не доведено, що був у підтвердженому знімку (перший знімок або був відсутній і раніше) — лише «відсутній у знімку».
      out.absent.push(offerId);
      out.updates.set(offerId, { presence: PRESENCE.ABSENT_IN_SNAPSHOT, meta: metaCell({ ...base, state: PRESENCE.ABSENT_IN_SNAPSHOT, since: stamp }), reason: "немає в знімку " + snapshot.id + (before ? " (не було й у підтвердженому)" : " (підтвердженого знімка ще немає)") });
    }
  }
  const limit = holdLimit(limits, previous?.count || snapshot.count);
  const disappearing = out.gone.length + (before ? 0 : out.absent.length);
  out.disappearing = disappearing; out.limit = Number.isFinite(limit) ? limit : null;
  if (disappearing > 0 && disappearing >= limit) {
    out.decision = "HOLD";
    out.reasons = [`аномальне зникнення: ${disappearing} товарів (поріг ${limit}) — позначки не застосовано, потрібне рішення власника`];
    out.updates = new Map();
    return out;
  }
  out.decision = "APPLY";
  return out;
}

/** ENG-28c (рішення власника 01.11): нейтральний стан «поза охопленням фіду». Фід із фільтром (group_ids тощо) не доводить відсутності:
 *  наявність не змінюється, «видалений» / «відсутній у знімку» не ставляться, щозапускової «ПОМИЛКА» немає. Стан записується ОДИН раз
 *  (лише зміна стану) і знімається, коли товар знову у фіді. Окремо від planPresence: той для фільтрованого знімка позначок не ставить
 *  (контракт Catalog R7.4.2) — тут лише ENG-позначка поверх його результату. Історична позначка «відсутній у знімку» (NEW92,
 *  `3236816949`) і «видалений» не змінюються. */
export const OUT_OF_SCOPE_PRESENCE = "ПОЗА_ОХОПЛЕННЯМ_ФІДУ";
/** Для повного знімка нейтральна позначка = «присутній» (звичайні правила presence діють). rows — як у planPresence. */
export const presenceInputRows = (rows, snapshot) => (snapshot?.scope === "full" ? rows.map((r) => (mtText(r.presence).trim() === OUT_OF_SCOPE_PRESENCE ? { ...r, presence: "" } : r)) : rows);
export function planScopeMarks({ rows, snapshot, presencePlan, stamp, removed = new Set() }) {
  const updates = new Map();
  if (!snapshot || !Array.isArray(snapshot.ids)) return updates;
  const inFeed = new Set(snapshot.ids), outOfScope = new Set(presencePlan?.outOfScope || []), touched = presencePlan?.updates || new Map();
  for (const r of rows) {
    const offerId = mtText(r.offerId), sid = mtText(r.supplierId);
    if (!offerId || !sid || removed.has(offerId) || touched.has(offerId)) continue;
    const cur = mtText(r.presence).trim();
    if (inFeed.has(sid)) {
      if (cur === OUT_OF_SCOPE_PRESENCE) updates.set(offerId, { presence: PRESENCE.PRESENT, meta: metaCell({ state: "ПРИСУТНІЙ", checkedAt: stamp, snapshotId: snapshot.id, feedDate: snapshot.feedDate, previousState: OUT_OF_SCOPE_PRESENCE }), reason: "знову в межах охоплення фіду" });
      continue;
    }
    if (snapshot.scope !== "full" && outOfScope.has(offerId) && (cur === PRESENCE.PRESENT || cur === PRESENCE.RETURNED)) {
      updates.set(offerId, { presence: OUT_OF_SCOPE_PRESENCE, meta: metaCell({ state: OUT_OF_SCOPE_PRESENCE, since: stamp, snapshotId: snapshot.id, feedDate: snapshot.feedDate, scopeBy: snapshot.scopeBy || [], note: "фід із фільтром охоплення: наявність не змінюється; не «видалений у постачальника»" }), reason: "поза охопленням фіду (фільтр) — наявність не змінюється, не «видалений»" });
    }
  }
  return updates;
}

/** Позначка для товару, якого немає у старому знімку (перенесення NEW92, `3236816949`): не «видалений» — лише «відсутній у знімку». */
export function absentInSnapshotCell({ snapshotDate, source = "LIVE (останнє оновлення таблиці)", stamp }) {
  return { presence: PRESENCE.ABSENT_IN_SNAPSHOT, meta: metaCell({ state: PRESENCE.ABSENT_IN_SNAPSHOT, since: snapshotDate, checkedAt: stamp, source, snapshotId: null, note: `Відсутній у знімку YML постачальника від ${snapshotDate}; перевірити з актуальним повним фідом; без рішення власника не виключати` }) };
}

/** Правило наявності для МАЙБУТНЬОГО експорту (не публікується): підтверджене зникнення → «немає в наявності». Видалення в Prom — ні. */
export function exportAvailability(row) {
  const st = mtText(row?.[PRESENCE_COLUMN]).trim();
  if (st === PRESENCE.GONE) return { available: false, reason: "видалений у постачальника (підтверджено повним знімком)", removeFromProm: false };
  return null;
}
