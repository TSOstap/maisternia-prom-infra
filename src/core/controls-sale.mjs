/** Catalog Controls — продаж: тимчасове зняття, повернення, видалення товару (tombstone) і повернення з архіву.
 *
 *  Команди власника в «Продаж рішення» — з одноразовим кодом підтвердження з «Стану керування»:
 *    «Основний каталог»: ЗНЯТИ З ПРОДАЖУ <код>[: причина] (= ТИМЧАСОВО ЗНЯТИ З ПРОДАЖУ) · ПОВЕРНУТИ В ПРОДАЖ <код> ·
 *                        ВИДАЛИТИ ТОВАР <Offer ID> <код> (= ВИДАЛИТИ НАЗАВЖДИ)
 *    «Видалені товари»:  ПОВЕРНУТИ З АРХІВУ <Offer ID> <код> (= ПОВЕРНУТИ В КАТАЛОГ)
 *  Без коду — запит: «Стан керування» показує код. Клітинку система не очищує; виконана команда далі нічого не робить
 *  (той самий Operation ID), а стара — не спрацює після зміни стану (код прив'язаний до ревізії).
 *  Знятий товар у Prom — «немає в наявності» (YML available="false"; publisher S6 за held). Видалений (R6) — без жодного <offer>
 *  у новому YML (publisher S6 за tombstoned; перевірка кандидата — feedViolations). */
import { mtText } from "./text.mjs";
import { STATUS_OWN_STOCK } from "./yml.mjs";
import { CODE_RE, normCmd } from "./controls-common.mjs";

export const SALE_KIND = Object.freeze({ HOLD: "HOLD", RELEASE: "RELEASE", TOMBSTONE: "TOMBSTONE", UNTOMBSTONE: "UNTOMBSTONE" });
/** Канонічні слова команд (показуються в «Кодах підтвердження»). */
export const SALE_WORDS = Object.freeze({ HOLD: "ЗНЯТИ З ПРОДАЖУ", RELEASE: "ПОВЕРНУТИ В ПРОДАЖ", TOMBSTONE: "ВИДАЛИТИ ТОВАР", UNTOMBSTONE: "ПОВЕРНУТИ З АРХІВУ" });
/** Синоніми, які власник може писати (довші — першими). */
const ALIASES = Object.freeze({
  HOLD: ["ТИМЧАСОВО ЗНЯТИ З ПРОДАЖУ", "ЗНЯТИ З ПРОДАЖУ"],
  RELEASE: ["ПОВЕРНУТИ В ПРОДАЖ"],
  TOMBSTONE: ["ВИДАЛИТИ ТОВАР", "ВИДАЛИТИ НАЗАВЖДИ"],
  UNTOMBSTONE: ["ПОВЕРНУТИ З АРХІВУ", "ПОВЕРНУТИ В КАТАЛОГ"],
});
/** Де діє команда: HOLD / RELEASE / TOMBSTONE — лише «Основний каталог»; UNTOMBSTONE — аркуш, де зараз рядок товару. */
export const MAIN_ONLY = Object.freeze(new Set([SALE_KIND.HOLD, SALE_KIND.RELEASE, SALE_KIND.TOMBSTONE]));

/** «Продаж рішення» → { kind, id, code, reason } | { kind: "UNKNOWN", raw } | null. */
export function parseSaleCommand(raw) {
  const text = mtText(raw).trim();
  if (!text) return null;
  const colon = text.search(/[:—]/);
  const head = normCmd(colon >= 0 ? text.slice(0, colon) : text);
  const reason = colon >= 0 ? text.slice(colon + 1).trim() : "";
  const matchWord = (kind) => ALIASES[kind].find((w) => head === w || head.startsWith(w + " "));
  const withCode = (rest) => { const parts = rest ? rest.split(" ") : []; return parts.length <= 1 && (!parts[0] || CODE_RE.test(parts[0])) ? parts[0] || "" : null; };
  for (const kind of [SALE_KIND.HOLD, SALE_KIND.RELEASE]) {
    const w = matchWord(kind);
    if (w) {
      const code = withCode(head.slice(w.length).trim());
      if (code === null || (kind === SALE_KIND.RELEASE && reason)) return { kind: "UNKNOWN", raw: text };
      return { kind, code, reason: kind === SALE_KIND.HOLD ? reason : "" };
    }
  }
  for (const kind of [SALE_KIND.TOMBSTONE, SALE_KIND.UNTOMBSTONE]) {
    const w = matchWord(kind);
    if (w) {
      const m = /^(\d+)(?: ([0-9A-F]{6}))?$/.exec(head.slice(w.length).trim());
      if (!m || reason) return { kind: "UNKNOWN", raw: text, needsId: !m };
      return { kind, id: m[1], code: m[2] || "", reason: "" };
    }
  }
  return { kind: "UNKNOWN", raw: text };
}

export const heldText = (since, reason) => `ЗНЯТО З ПРОДАЖУ з ${mtText(since).slice(0, 10)}${reason ? ": " + reason : ""}`;

/**
 * Інтеграція в синхронізацію таблиці (для інженерного сектору): для знятих / видалених — «-», без знижки й кількості; ціна
 * постачальника, Base, Final, стан зіставлення й час — як є. Лише відображення в таблиці; авторитетне зняття в YML — publisher.
 */
export function holdPlan(plan, heldIds) {
  return plan.map((p) => {
    if (!heldIds.has(p.id)) return p;
    const next = p.next.slice();
    next[3] = ""; next[4] = "-"; next[5] = "";
    return { ...p, next, held: true };
  });
}

/**
 * Проєкція рядків для «Стану керування» / таблиці (НЕ авторитетна для YML): знятий / видалений — «-», без знижки й кількості.
 * Рядок «ВЛАСНИЙ_ЗАЛИШОК» не змінюється (чинний offerXml вимагає для нього «+»): він лише позначається в ownStockHeld. Зняття має
 * найвищий пріоритет, і в YML його застосовує publisher за held (ENG-10 §1.2) — власний залишок НЕ зупиняє фід (рішення власника A).
 * problems лишається для сумісності інтерфейсу й завжди порожній.
 */
export function holdRowsForYml(rows, heldIds) {
  const ownStockHeld = [];
  const out = rows.map((r) => {
    const id = mtText(r["Offer ID"]);
    if (!heldIds.has(id)) return r;
    if (r["Стан синхронізації"] === STATUS_OWN_STOCK) { ownStockHeld.push(id); return r; }
    return { ...r, "Наявність": "-", "Знижка": "", "Кількість постачальника": "" };
  });
  return { rows: out, problems: [], ownStockHeld };
}

/**
 * R6: еталонна проєкція рядків для YML за станом CC (двійники й перевірка паритету; авторитетно формує YML publisher Engineering):
 * видалений товар (tombstoned, будь-яка стадія) — без рядка взагалі, тобто без жодного <offer>; знятий — як holdRowsForYml.
 */
export function controlsRowsForYml(rows, { held = new Set(), tombstoned = new Map() } = {}) {
  const omitted = [];
  const kept = rows.filter((r) => {
    const id = mtText(r["Offer ID"]);
    if (!tombstoned.has(id)) return true;
    omitted.push(id);
    return false;
  });
  const h = holdRowsForYml(kept, held);
  return { rows: h.rows, omitted, ownStockHeld: h.ownStockHeld };
}
