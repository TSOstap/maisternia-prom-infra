/** ENG-29: дрібні спільні функції синхронізації без важких залежностей — для «Оновити ціни й наявність» на сервері Cloudflare
 *  (Durable Object). sheet-sync-run.mjs реекспортує їх без змін. */
import { enabled as ownerPriorityEnabled } from "../core/owner-priority.mjs";

const DISCOUNT = "Знижка";
/** Знижка в таблиці — як у mtUpdate: ЧИСЛО (0.2) з форматом «0%» (Google показує «20%»).
 *  План (порт mtPlan) повертає «20%» — це рядок, який Apps Script при setValues сам перетворює на число 0.2;
 *  запис RAW цього не робить, тож перетворюємо тут. Формули цін і план не змінюються. */
export function sheetDiscount(v) {
  if (typeof v !== "string") return v;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*%\s*$/.exec(v);
  return m ? Math.round(Number(m[1].replace(",", ".")) * 10000) / 1000000 : v;
}
/** Запис «Журналу»: для поля «Знижка» «було/стало» — числа, як у mtUpdate. */
export const journalRow = (e) => (e[3] === DISCOUNT ? [e[0], e[1], e[2], e[3], sheetDiscount(e[4]), sheetDiscount(e[5]), e[6]] : e);

/** CC R6: стан Catalog Controls для синхронізації / intake. controls — адаптер { state(), verify(fp) } (controls-adapter.mjs) або
 *  готовий стан. Будь-яка помилка читання → blocked (fail-closed). Без режиму пріоритету власника — не потрібен (null). */
export async function syncControlsState(controls, config) {
  if (!ownerPriorityEnabled(config)) return null;
  if (!controls) return null;
  try {
    const s = typeof controls.state === "function" ? await controls.state() : controls;
    return s && typeof s === "object" ? s : { blocked: true, reasons: ["стан Catalog Controls порожній"] };
  } catch (e) { return { blocked: true, reasons: ["стан Catalog Controls не прочитано: " + (e?.message || e)] }; }
}
/** Перед записом: стан CC той самий, що під час планування (новий tombstone між плануванням і записом → нічого не пишемо). */
export async function ccUnchanged(controls, st) {
  if (!st || typeof controls?.verify !== "function") return { ok: true };
  try { const v = await controls.verify(st.fingerprint); return v?.ok ? { ok: true } : { ok: false, reason: (v?.reasons || []).join("; ") || "відбиток змінився" }; }
  catch (e) { return { ok: false, reason: "перевірку не виконано: " + (e?.message || e) }; }
}
