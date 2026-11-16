/** Гібрид, варіант Б (рішення власника 16.11.2026): ціни (РРЦ), наявність і дроп — із «Excel (розширений)» Хорошопу постачальника
 *  (сайт tools-store; «Цена» = РРЦ, перевірено на DCB546: 9699, дроп 8729,10), контент (назви, описи, фото, характеристики) і нові
 *  товари — як раніше, зі старого Prom-фіду постачальника + наші картки. Без пари в Excel — ціна й наявність із Prom-фіду (запасне).
 *
 *  Тут лише чисті функції (працюють і на GitHub, і на Cloudflare):
 *    - компактний список із рядків Excel (артикул, артикул на сайті, РРЦ, дроп, стара ціна, наявність);
 *    - зіставлення офферів Prom-фіду: виняток власника → «Артикул» = Offer ID (у постачальника так позначено товари, перенесені з Prom)
 *      → «Артикул» = артикул оффера → «Артикул для відображення на сайті» = артикул оффера; кілька кандидатів — без пари;
 *    - підстановка ціни / наявності / дропу в оффери Prom-фіду.
 *  Правила власника («Ціна власника», «Ціна вручну», «Наявність власника»), РРЦ + 5 і ProSale — далі, у prices-only (без змін). */

/** Колонки «Excel (розширений)» (назви — як у вивантаженні Хорошопу). */
export const EXCEL_COLUMNS = Object.freeze({ art: "Артикул", disp: "Артикул для отображения на сайте", price: "Цена", drop: "Дроп ціна", old: "Старая цена", avail: "Наличие", qty: "Количество" });
export const EXCEL_COLUMN_LIST = Object.freeze(Object.values(EXCEL_COLUMNS));
/** Ключі сховища W2 (Durable Object): дані й коротка мітка (дата зміни файлу — для щогодинної перевірки без читання даних). */
export const HOROSHOP_DATA_KEY = "state/horoshop/excel-compact.json";
export const HOROSHOP_META_KEY = "state/horoshop/excel-meta.json";
/** Захист від неповного вивантаження (16.11: 5335 рядків). */
export const HOROSHOP_MIN_ROWS = 4000;

/** Нормалізація артикула ЛИШЕ для порівняння (самі артикули ніде не змінюються — RULES 0.7). */
export const normArticle = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();
const num = (v) => { const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
const availOf = (v) => { const s = String(v ?? "").trim().toLowerCase(); if (s === "в наявності" || s === "в наличии") return true; if (s === "немає в наявності" || s === "нет в наличии") return false; return null; };

/** Рядки readXlsxColumns(…, EXCEL_COLUMN_LIST) → { rows: [{ a, d, p, dr, o, av }], count } (короткі ключі — менший запис у сховищі). */
export function compactFromExcel({ rows, missing = [] }) {
  if (missing.length) throw new Error("Excel Хорошопу: немає колонок " + missing.join(", "));
  const out = [];
  for (const r of rows) {
    const a = String(r[0] ?? "").trim();
    if (!a) continue;
    out.push({ a, d: String(r[1] ?? "").trim(), p: num(r[2]), dr: num(r[3]), o: num(r[4]), av: availOf(r[5]) });
  }
  return { rows: out, count: out.length };
}

/**
 * Зіставлення: prom — Map<offerId, { sku }>; rows — compact.rows; overrides — { offerId: «Артикул» Excel | null } (null — «без пари»).
 * → { map: Map<offerId, індекс рядка>, stats: { override, byId, byArticle, byDisplay, ambiguous: [offerId], none } }
 */
export function matchHoroshop(prom, rows, overrides = {}) {
  const byArt = new Map(), byDisp = new Map();
  rows.forEach((r, i) => {
    const a = normArticle(r.a), d = normArticle(r.d);
    if (a) byArt.set(a, [...(byArt.get(a) || []), i]);
    if (d) byDisp.set(d, [...(byDisp.get(d) || []), i]);
  });
  const map = new Map(), how = new Map(), stats = { override: 0, byId: 0, byArticle: 0, byDisplay: 0, ambiguous: [], none: 0 };
  const hit = (oid, i, kind) => { map.set(oid, i); how.set(oid, kind); stats[kind]++; };
  for (const [oid, p] of prom) {
    if (Object.prototype.hasOwnProperty.call(overrides, oid)) {
      const v = overrides[oid], c = v == null ? [] : byArt.get(normArticle(v)) || [];
      if (c.length === 1) hit(oid, c[0], "override"); else stats.none++;
      continue;
    }
    const byOid = byArt.get(normArticle(oid)) || [];
    if (byOid.length === 1) { hit(oid, byOid[0], "byId"); continue; }
    const sku = normArticle(p?.sku);
    if (!sku) { stats.none++; continue; }
    const a = byArt.get(sku) || [];
    if (a.length === 1) { hit(oid, a[0], "byArticle"); continue; }
    const d = byDisp.get(sku) || [];
    if (a.length === 0 && d.length === 1) { hit(oid, d[0], "byDisplay"); continue; }
    if (a.length > 1 || d.length > 1) stats.ambiguous.push(oid); else stats.none++;
  }
  // Один рядок Excel для кількох офферів: винятки власника лишаються; з автоматичних — лише єдиний найсильніший збіг
  // (Offer ID > «Артикул» > артикул на сайті); рівні за силою — усі без пари.
  const RANK = { byId: 3, byArticle: 2, byDisplay: 1 };
  const used = new Map();
  for (const [oid, i] of map) used.set(i, [...(used.get(i) || []), oid]);
  for (const oids of used.values()) {
    if (oids.length < 2) continue;
    const auto = oids.filter((o) => how.get(o) !== "override");
    const top = Math.max(...auto.map((o) => RANK[how.get(o)] || 0));
    const best = auto.filter((o) => (RANK[how.get(o)] || 0) === top);
    const keep = auto.length === oids.length && best.length === 1 ? best[0] : null;
    for (const o of auto) if (o !== keep) { map.delete(o); stats[how.get(o)]--; stats.ambiguous.push(o); }
  }
  return { map, stats };
}

/** Ціна (РРЦ), наявність і дроп Excel в оффери Prom-фіду (новий Map; вхідний не змінюється). → { offers, stats } */
export function applyHoroshop(offers, rows, map) {
  const out = new Map(offers);
  const stats = { matched: 0, price: 0, available: 0, drop: 0, priceChanged: 0, availableChanged: 0 };
  for (const [oid, i] of map) {
    const o = offers.get(oid), r = rows[i];
    if (!o || !r) continue;
    stats.matched++;
    const next = { ...o, source: "horoshop" };
    if (r.p != null) { stats.price++; if (o.price !== r.p) stats.priceChanged++; next.price = r.p; }
    if (r.av != null) { stats.available++; if (o.available !== r.av) stats.availableChanged++; next.available = r.av; }
    if (r.dr != null) { stats.drop++; next.drop = r.dr; }
    out.set(oid, next);
  }
  return { offers: out, stats };
}

/** Усе разом для «Цін»: розібраний Prom-фід + компактний список Excel. */
export function hybridOffers({ parsedOffers, compact, overrides = {} }) {
  const prom = new Map([...parsedOffers].map(([id, o]) => [id, { sku: o.sku }]));
  const m = matchHoroshop(prom, compact.rows, overrides);
  const ap = applyHoroshop(parsedOffers, compact.rows, m.map);
  return {
    offers: ap.offers,
    stats: { date: compact.lastModified || compact.at || "", excelRows: compact.count ?? compact.rows.length, promOffers: parsedOffers.size, ...ap.stats,
      byId: m.stats.byId, byArticle: m.stats.byArticle, byDisplay: m.stats.byDisplay, byOverride: m.stats.override,
      ambiguous: m.stats.ambiguous.length, ambiguousIds: m.stats.ambiguous.slice(0, 50), withoutPair: parsedOffers.size - ap.stats.matched },
  };
}

/** Чи новіший файл на сайті за збережений список (Last-Modified). Невідомо — «так» лише коли списку ще немає. */
export function excelIsNewer(lastModifiedHeader, meta) {
  const site = Date.parse(String(lastModifiedHeader || ""));
  if (!meta?.lastModified) return true;
  const have = Date.parse(String(meta.lastModified));
  if (!Number.isFinite(site) || !Number.isFinite(have)) return false;
  return site > have;
}
