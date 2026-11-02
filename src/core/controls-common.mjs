/** Catalog Controls — спільна частина (R5, 29.10.2026: архітектура «Видалені товари», ідентичність за M1 / ENG-10).
 *
 *  Інваріанти:
 *   • Catalog Controls НЕ пише в «Основний каталог», «Нові товари», «Видалені товари» (жодних клітинок, рядків, заголовка) і ніде не
 *     викликає deleteRows. Переносить рядки між «Основним каталогом» і «Видаленими товарами» Engineering — за `moves` зі стану CC;
 *   • записи CC — лише дописування в «Історію керування» з Operation ID, перебудова похідного «Стану керування» і контрольна точка
 *     (довірене джерело, розд. controls-plan.mjs);
 *   • стан — згортка подій за поколіннями (порядок рядків не важливий); пропуск покоління або дві різні події одного покоління —
 *     пошкодження товару (fail-closed для товару, не для каталогу);
 *   • команди власника — з одноразовими кодами (Offer ID + фізична ідентичність + дія + ревізія); клітинки команд система не очищує;
 *   • застосування — лише за активованим контрактом і перевіреною контрольною точкою поза таблицею. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mtKey, mtSku, mtText, sha256 } from "./text.mjs";

/** Службові аркуші CC (пише лише CC, через guardWriter). */
export const CC_SHEET = Object.freeze({ history: "Історія керування", state: "Стан керування" });
/** Архів видалених товарів — веде Engineering (повний рядок картки, без синхронізації). CC лише читає. */
export const ARCHIVE_SHEET = "Видалені товари";

/** SEO-метадані (HTML-заголовок і meta-опис) — окремо від назв, описів і пошукових запитів Prom. */
export const SEO_META_FIELDS = Object.freeze(["SEO заголовок UA", "SEO заголовок RU", "SEO опис UA", "SEO опис RU"]);
export const SEO_DECISION = "SEO рішення";
export const SALE_DECISION = "Продаж рішення";
/** Колонки ВЛАСНИКА в «Основному каталозі» (і в «Видалених товарах», бо рядок переноситься повністю). CC їх лише читає. */
export const CC_INPUT_COLUMNS = Object.freeze([...SEO_META_FIELDS, SEO_DECISION, SALE_DECISION]);
/** Пошукові запити Prom — інший канал (YML keywords / keywords_ua); Catalog Controls їх не змінює. */
export const PROM_SEARCH_FIELDS = Object.freeze(["Запити UA", "Запити RU"]);

/** Канал SEO в Prom (довідка Prom, support.prom.ua/hc/uk/articles/360004960817 і 360004963538, перевірено 28.10.2026):
 *  у YML тегів SEO-заголовка й опису НЕМАЄ — лише колонки Excel/CSV-імпорту з додатком «SEO-настройки»; порожнє поле не оновлює. */
export const PROM_SEO_IMPORT = Object.freeze({
  "SEO заголовок RU": Object.freeze({ column: "HTML_заголовок", max: 250 }),
  "SEO заголовок UA": Object.freeze({ column: "HTML_заголовок_укр", max: 270 }),
  "SEO опис RU": Object.freeze({ column: "HTML_опис", max: 250 }),
  "SEO опис UA": Object.freeze({ column: "HTML_опис_укр", max: 270 }),
});
/** Рекомендація Prom для заголовка (support.prom.ua/hc/uk/articles/360005256417) — лише інформаційна позначка. */
export const PROM_TITLE_ADVICE = 70;

// ---------- контракт активації ----------
export const CONTRACT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schemas/catalog-controls-contract.json");
/** Погоджені власником максимуми (28.10.2026): конфігурація може лише зменшити їх. */
export const APPROVED_LIMITS = Object.freeze({ maxSaleChangesPerRun: 50, maxPermanentPerRun: 10 });
/** R6 (рішення власника 29.10.2026): видалений товар — без жодного <offer> у новому YML; перенесення в архів одразу після
 *  підтвердженого рішення; завершення — за опублікованим YML без цього Offer ID (без підтвердження Prom). */
export const DELETION_POLICY = "OMIT_FROM_YML";
/** R6: «Видалити товар» — одна дія власника (без попереднього «Тимчасово зняти з продажу»); внутрішнє зняття записує система. */
export const REQUIRE_TEMPORARY_FIRST = false;

export function validateContract(c) {
  const p = [];
  if (!c || typeof c !== "object") return ["контракт відсутній або не об'єкт"];
  if (c.v !== 3 || c.module !== "catalog-controls") p.push("контракт: потрібні v=3 і module=catalog-controls");
  if (typeof c.activated !== "boolean") p.push("контракт: activated має бути true / false");
  if (c.activated && !/^\d{4}-\d{2}-\d{2}/.test(String(c.activatedAt || ""))) p.push("контракт: activated=true без activatedAt");
  const s = c.sheets || {};
  for (const [k, v] of Object.entries(CC_SHEET)) if (s[k] !== v) p.push(`контракт: аркуш ${k} має бути «${v}»`);
  if (s.archive !== ARCHIVE_SHEET) p.push(`контракт: аркуш archive має бути «${ARCHIVE_SHEET}»`);
  if (JSON.stringify(c.inputColumns) !== JSON.stringify(CC_INPUT_COLUMNS)) p.push("контракт: inputColumns не відповідають модулю");
  for (const [k, max] of Object.entries(APPROVED_LIMITS)) {
    const v = c.limits?.[k];
    if (!Number.isInteger(v) || v < 1 || v > max) p.push(`контракт: limits.${k} — ціле 1…${max}`);
  }
  if (c.requireTemporaryFirst !== REQUIRE_TEMPORARY_FIRST) p.push(`контракт: requireTemporaryFirst має бути ${REQUIRE_TEMPORARY_FIRST} (рішення власника 29.10.2026: видалення — одна дія)`);
  if (c.deletion !== DELETION_POLICY) p.push(`контракт: deletion має бути «${DELETION_POLICY}»`);
  return p;
}

export function loadControlsContract(file = CONTRACT_FILE) {
  let contract = null;
  try { contract = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { contract: null, problems: [`контракт «${path.basename(file)}» не читається`] }; }
  return { contract, problems: validateContract(contract) };
}

/** Ліміти запуску: з контракту; config.controls може лише зменшити. Некоректне значення — помилка, а не мовчазне значення за замовчуванням. */
export function controlsConfig(config, contract) {
  const problems = [];
  const limits = { ...APPROVED_LIMITS, ...(contract?.limits || {}) };
  for (const [k, v] of Object.entries(config?.controls || {})) {
    if (!(k in APPROVED_LIMITS)) { problems.push(`config.controls.${k}: невідомий параметр`); continue; }
    if (!Number.isInteger(v) || v < 1 || v > limits[k]) { problems.push(`config.controls.${k}=${JSON.stringify(v)}: потрібне ціле 1…${limits[k]}`); continue; }
    limits[k] = v;
  }
  return { limits, requireTemporaryFirst: REQUIRE_TEMPORARY_FIRST, problems };
}

// ---------- ідентичність, коди підтвердження, Operation ID ----------
export const normCmd = (v) => mtText(v).normalize("NFKC").replace(/[’ʼ`]/g, "'").replace(/\s+/g, " ").trim().toUpperCase();
const hx = (...parts) => sha256(JSON.stringify(parts.map(mtText)));

const IDENTITY = Object.freeze([
  ["offerId", "Offer ID"], ["supplierId", "ID постачальника"], ["sku", "Артикул постачальника"], ["nameUa", "Назва постачальника UA"],
  ["nameRu", "Назва постачальника RU"], ["url", "URL постачальника"], ["vendor", "Виробник"], ["model", "Модель"], ["gtin", "GTIN"], ["promCode", "Код товару Prom"],
]);
export const identityOf = (row) => Object.fromEntries(IDENTITY.map(([k, col]) => [k, mtText(row?.[col])]));
export const identityRow = (idn) => Object.fromEntries(IDENTITY.map(([k, col]) => [col, mtText(idn?.[k])]));
/**
 * Фізична ідентичність товару (CC4-N1; контракт M1 IDENTITY і ENG-10 §5): «ID постачальника» + «Артикул постачальника»; для товару
 * без артикула — також «Назва постачальника UA / RU» і «URL постачальника». Усі ці колонки пише лише sync. НЕ ідентичність:
 * «Код товару Prom», GTIN, «Виробник» (дозволені власнику, M1), «Модель» (службова), назви / описи / характеристики власника.
 */
export const PHYSICAL_IDENTITY = Object.freeze({ always: ["ID постачальника", "Артикул постачальника"], withoutSku: ["Назва постачальника UA", "Назва постачальника RU", "URL постачальника"] });
export function physicalIdentity(idn) {
  const sku = mtSku(idn?.sku);
  return sku
    ? { supplierId: mtText(idn?.supplierId), sku }
    : { supplierId: mtText(idn?.supplierId), sku: "", nameUa: mtKey(idn?.nameUa), nameRu: mtKey(idn?.nameRu), url: mtText(idn?.url) };
}
/** Відбиток фізичної ідентичності — для кодів і перевірки авторизації послаблень. Перейменування за наявності артикула його не змінює. */
export const identityKey = (idn) => hx("id2", JSON.stringify(physicalIdentity(idn))).slice(0, 16);
/** Відмінності фізичної ідентичності (порожньо — той самий фізичний товар). */
export function physicalDifferences(a, b) {
  const x = physicalIdentity(a), y = physicalIdentity(b);
  const d = [];
  if (x.supplierId !== y.supplierId) d.push(`ID постачальника: «${mtText(a?.supplierId)}» → «${mtText(b?.supplierId)}»`);
  if (x.sku !== y.sku) d.push(`Артикул постачальника: «${mtText(a?.sku)}» → «${mtText(b?.sku)}»`);
  if (!x.sku && !y.sku) {
    if (x.nameUa !== y.nameUa) d.push(`Назва постачальника UA: «${mtText(a?.nameUa)}» → «${mtText(b?.nameUa)}»`);
    if (x.nameRu !== y.nameRu) d.push(`Назва постачальника RU: «${mtText(a?.nameRu)}» → «${mtText(b?.nameRu)}»`);
    if (x.url !== y.url) d.push(`URL постачальника: «${mtText(a?.url)}» → «${mtText(b?.url)}»`);
  }
  return d;
}

/**
 * Розрахунковий код: Offer ID + фізична ідентичність + дія + ревізія (остання подія домену) + вміст (напр. хеш чернетки SEO).
 * Оцінка до активації і код ПЕРШОЇ видачі (№0). Сам збіг шести символів НЕ авторизує: після активації чинний лише код, ВИДАНИЙ
 * системою й збережений у контрольній точці разом із ключем фізичної ідентичності, ревізією й вмістом (`issued`, controls-plan.mjs).
 */
export const confirmationCode = ({ offerId, identity, action, revision, payload = "", nonce = 0 }) =>
  hx("cc1", offerId, identityKey(identity), action, revision, payload, ...(nonce ? [nonce] : [])).slice(0, 6).toUpperCase();
/**
 * R7.1 (Hermes R7-P1): код повторної видачі №n (n ≥ 1) дії товару — n-й елемент 24-бітної перестановки (мережа Фейстеля,
 * 8 раундів), ключ якої — лише Offer ID і дія. Перестановка — бієкція: різні номери видачі тієї самої дії товару ЗАВЖДИ дають різні
 * коди, за будь-якої довжини історії й без зберігання попередніх кодів (код №0 — розрахунковий, перестановка його пропускає —
 * controls-plan.mjs). Ідентичність, ревізію й вміст прив'язує збережена видача, а не сам код.
 */
export const ISSUE_SPACE = 1 << 24;
export function issuedCode({ offerId, action, n }) {
  if (!Number.isInteger(n) || n < 0 || n >= ISSUE_SPACE) throw new RangeError(`номер видачі коду поза межами: ${n}`);
  let l = n >>> 12, r = n & 0xfff;
  for (let i = 0; i < 8; i++) [l, r] = [r, l ^ parseInt(hx("cc3", offerId, action, i, r).slice(0, 3), 16)];
  return ((l << 12) | r).toString(16).toUpperCase().padStart(6, "0");
}
/** Operation ID не залежить від часу запуску: той самий намір (код + вміст) → той самий ID. */
export const operationId = ({ offerId, action, code, payload = "" }) => "op-" + hx("op1", offerId, action, code, payload).slice(0, 24);
export const CODE_RE = /^[0-9A-F]{6}$/;

// ---------- «Історія керування» ----------
export const HISTORY_HEADERS = Object.freeze(["Дата", "Operation ID", "Offer ID", "Дія", "Поле", "Було", "Стало", "Підстава", "Покоління", "Печатка"]);
export const ACTION = Object.freeze({
  SEO_APPROVED: "SEO ЗАТВЕРДЖЕНО",
  HOLD: "ЗНЯТО З ПРОДАЖУ",
  RELEASE: "ПОВЕРНУТО В ПРОДАЖ",
  TOMBSTONE: "ТОВАР ВИДАЛЕНО",
  UNTOMBSTONE: "ПОВЕРНУТО З АРХІВУ",
  CONFLICT: "КОНФЛІКТ ІДЕНТИЧНОСТІ",
});
const DOMAIN = Object.freeze({ [ACTION.SEO_APPROVED]: "seo", [ACTION.HOLD]: "sale", [ACTION.RELEASE]: "sale", [ACTION.TOMBSTONE]: "sale", [ACTION.UNTOMBSTONE]: "sale" });
export const domainOf = (action) => DOMAIN[action] || "";
/** Послаблювальні дії: діють лише після підтвердження контрольною точкою й лише за чинної авторизації власника.
 *  Решта (зняти, видалити, конфлікт) — захисні: діють одразу з довіреного наміру. */
export const WEAKENING = Object.freeze(new Set([ACTION.RELEASE, ACTION.UNTOMBSTONE, ACTION.SEO_APPROVED]));
const DATA_COLUMNS = HISTORY_HEADERS.length - 1;
export const historySeal = (cells) => "cc2." + sha256(JSON.stringify(cells.slice(0, DATA_COLUMNS).map(mtText))).slice(0, 24);
export function historyRow({ stamp, opId, offerId, action, field = "", before = "", after = "", reason = "", generation = "" }) {
  const cells = [stamp, opId, offerId, action, field, before, after, reason, generation].map(mtText);
  return [...cells, historySeal(cells)];
}
export const HISTORY_OP_COL = HISTORY_HEADERS.indexOf("Operation ID");
/** Рядок журналу (10 клітинок у порядку HISTORY_HEADERS) → подія; sealOk — печатка відповідає вмісту. */
export function historyEvent(cells, rowNumber = 0) {
  const c = HISTORY_HEADERS.map((_, i) => mtText(cells?.[i]));
  return { rowNumber, at: c[0], opId: c[1], offerId: c[2], action: c[3], field: c[4], before: c[5], after: c[6], reason: c[7], generation: c[8], seal: c[9], sealOk: Boolean(c[1]) && historySeal(c) === c[9] };
}

/** Журнал → події. Аркуша немає → exists:false. Немає колонок → structural (журнал не читається; для споживачів — не глобальна зупинка). */
export function readHistory(values) {
  // damagedRows — рядки зі зламаною печаткою / без Operation ID: їхньому Offer ID НЕ довіряємо (C1).
  const out = { exists: Boolean(values?.length), headerOk: false, events: [], damaged: new Set(), damagedRows: [], seenOps: new Set(), structural: [], problems: [] };
  if (!values?.length) return out;
  const h = values[0].map(mtText);
  const col = Object.fromEntries(HISTORY_HEADERS.map((k) => [k, h.indexOf(k)]));
  const lost = HISTORY_HEADERS.filter((k) => col[k] < 0);
  const dataRows = values.slice(1).filter((r) => (r || []).some((v) => v !== "" && v != null));
  if (lost.length) {
    // Порожній аркуш без заголовка (створено, заголовок не записано) — стан «без подій», а не пошкодження.
    if (!h.some(Boolean) && !dataRows.length) return out;
    out.structural.push(`«${CC_SHEET.history}»: немає колонок ${lost.join(", ")}`);
    return out;
  }
  out.headerOk = true;
  values.slice(1).forEach((r, k) => {
    const cells = HISTORY_HEADERS.map((name) => mtText(r?.[col[name]]));
    if (!cells.some(Boolean)) return;
    const ev = historyEvent(cells, k + 2);
    if (ev.opId) out.seenOps.add(ev.opId);
    if (!ev.sealOk) {
      if (ev.offerId) out.damaged.add(ev.offerId);
      out.damagedRows.push({ rowNumber: ev.rowNumber, opId: ev.opId, offerId: ev.offerId, action: ev.action });
      out.problems.push(`«${CC_SHEET.history}», рядок ${ev.rowNumber}: печатка не відповідає вмісту`);
      return;
    }
    out.events.push(ev);
  });
  return out;
}

const jsonOr = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const parseGen = (g, domain) => { const m = /^(seo|sale):(\d+)$/.exec(mtText(g)); return m && m[1] === domain ? Number(m[2]) : 0; };

/** Стан товару за замовчуванням. */
export const emptyProduct = () => ({
  sale: { held: false, since: "", reason: "", rev: "0", n: 0, last: null },
  tomb: { active: false, opId: "", at: "", identity: null, reason: "" },
  restored: null,
  seo: { current: null, versions: [], rev: "0", n: 0 },
  conflicts: new Map(),
  events: [],
});

/**
 * Згортка подій: дублі за Operation ID відкидаються; події домену впорядковуються за поколінням (n = 1, 2, …). Дві різні події з
 * одним Operation ID, пропуск або повтор покоління — пошкодження товару (fail-closed). Повертає { products, opIds, damaged, structural }.
 * only — підмножина Operation ID (підтверджені): згортка без перевірки суцільності поколінь.
 */
export function foldHistory(hist, { only = null, trustRowOfferIds = true } = {}) {
  const damaged = new Set(trustRowOfferIds ? hist.damaged || [] : []);
  const byOp = new Map();
  for (const ev of only ? hist.events.filter((e) => only.has(e.opId)) : hist.events) {
    const prev = byOp.get(ev.opId);
    if (!prev) { byOp.set(ev.opId, ev); continue; }
    // Повтор має бути байт-ідентичним (і дата теж): інакше це інший запуск того самого наміру — пошкодження, а не вибір першого.
    const same = ["at", "offerId", "action", "field", "before", "after", "reason", "generation"].every((k) => prev[k] === ev[k]);
    if (!same) damaged.add(ev.offerId).add(prev.offerId);
  }
  const products = new Map();
  const get = (id) => { if (!products.has(id)) products.set(id, emptyProduct()); return products.get(id); };
  const grouped = new Map();
  for (const ev of byOp.values()) {
    if (!ev.offerId) continue;
    const p = get(ev.offerId);
    p.events.push(ev);
    const d = domainOf(ev.action);
    if (!d) { if (ev.action === ACTION.CONFLICT) p.conflicts.set(ev.opId, ev); continue; }
    const key = ev.offerId + "\u0000" + d;
    grouped.set(key, [...(grouped.get(key) || []), ev]);
  }
  for (const [key, list] of grouped) {
    const [id, d] = key.split("\u0000");
    const p = get(id);
    const sorted = list.map((ev) => ({ ev, n: parseGen(ev.generation, d) })).sort((a, b) => a.n - b.n);
    if (only ? sorted.some((x, i) => !x.n || (i && x.n === sorted[i - 1].n)) : sorted.some((x, i) => x.n !== i + 1)) { damaged.add(id); continue; } // пропуск / повтор / некоректне покоління
    for (const { ev, n } of sorted) {
      if (d === "seo") {
        const v = jsonOr(ev.after, null);
        if (!v || typeof v !== "object" || !v.values) { damaged.add(id); break; }
        p.seo.current = { values: v.values, supplier: v.supplier || null, at: ev.at, opId: ev.opId, n };
        p.seo.versions.push(p.seo.current);
        p.seo.rev = ev.opId; p.seo.n = n;
        continue;
      }
      const s = p.sale;
      if (ev.action === ACTION.HOLD) { s.held = true; s.since = ev.at; s.reason = ev.reason; }
      else if (ev.action === ACTION.RELEASE) { if (p.tomb.active) { damaged.add(id); break; } s.held = false; s.since = ""; s.reason = ""; }
      else if (ev.action === ACTION.TOMBSTONE) {
        const idn = jsonOr(ev.after, null);
        if (!idn || typeof idn !== "object" || !s.held || p.tomb.active) { damaged.add(id); break; }
        p.tomb = { active: true, opId: ev.opId, at: ev.at, identity: idn, reason: ev.reason };
        p.restored = null;
      } else if (ev.action === ACTION.UNTOMBSTONE) {
        if (!p.tomb.active) { damaged.add(id); break; }
        p.restored = { opId: ev.opId, at: ev.at, tombOp: p.tomb.opId, identity: p.tomb.identity };
        p.tomb = { active: false, opId: "", at: "", identity: null, reason: "" };
      }
      s.rev = ev.opId; s.n = n; s.last = ev;
    }
  }
  return { products, opIds: new Set(byOp.keys()), seenOps: hist.seenOps || new Set(), damaged, structural: [...(hist.structural || [])] };
}

export const dayOf = (stamp) => mtText(stamp).slice(0, 10);
export const short = (s, n = 80) => { const t = mtText(s).replace(/\s+/g, " "); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
