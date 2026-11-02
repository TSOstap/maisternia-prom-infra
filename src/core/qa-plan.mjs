/** ENG-28 — QA-затвердження товарів, погоджених власником (01.11.2026): ЛИШЕ план (факти → причини → потрібні дії → чи можна застосувати).
 *  Нічого не записує й не перераховує печатки. Застосування — наявним механізмом нової системи після окремого дозволу:
 *   - зміна ідентичності / комплекту під тим самим ID (ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ): сирі дані постачальника приймаються
 *     автоматично (рішення власника 23.10.2026, refreshMainRow), SEO не змінюється, власник бачить «було → стало» в «Журналі» /
 *     «Попередженнях постачальника». Потрібен АКТУАЛЬНИЙ повний фід — без нього нові назви невідомі;
 *   - печатка не збігається (вміст / ідентичність змінено після QA): у режимі пріоритету власника печатка — аудит; першу синхронізацію
 *     нової системи супроводжує класифікація полів (міграція: «Класифікація полів», рішення власника «Наше» / «Постачальника»).
 *     Печатку вручну не перераховувати (заборонено підробляти контрольні суми);
 *   - рішення власника із забороненими значеннями (наприклад, 1700 Вт / 6 Дж для 1561514532): якщо такі значення є в полях, що
 *     публікуються, — затвердження ЗАБЛОКОВАНО до виправлення контенту / характеристик. QA глобально не вимикається. */
import { mtText } from "./text.mjs";
import { rowSeal, SEAL_COLUMN } from "./seal.mjs";

export const QA_PUBLISHED_FIELDS = Object.freeze(["Назва UA", "Назва RU", "Опис UA", "Опис RU", "Запити UA", "Запити RU", "Характеристики JSON"]);
const t = (v) => mtText(v).trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Заборонені значення з рішення власника: число (кома / крапка) + одиниця, як окреме число (не «5,6 Дж» для «6 Дж»). */
export function forbiddenPatterns(decision) {
  return (decision?.wrong || []).filter((w) => t(w.value)).map((w) => {
    const num = esc(t(w.value)).replace(/[,.]/g, "[,.]");
    const unit = t(w.unit) ? "\\s*" + esc(t(w.unit)) : "";
    return { label: `${t(w.value)}${t(w.unit) ? " " + t(w.unit) : ""} (${t(w.subject)})`, re: new RegExp(`(^|[^\\d,.])${num}${unit}(?![\\p{L}\\d])`, "iu") };
  });
}

/**
 * rows — рядки основного каталогу (об'єкти); ids — погоджені Offer ID; decisions — зареєстровані рішення власника
 * [{ offerId, date, wrong: [{ subject, value, unit }] }]; feed — { available: bool, date } актуального повного фіду.
 */
export function planQa({ rows, ids, decisions = [], feed = { available: false, date: "" } }) {
  const byId = new Map(rows.map((r) => [t(r["Offer ID"]), r]));
  const byDecision = new Map(decisions.map((d) => [t(d.offerId), d]));
  const items = ids.map((raw) => {
    const id = t(raw);
    const r = byId.get(id);
    if (!r) return { offerId: id, found: false, applicable: false, reasons: [], actions: [], blockers: ["немає в «Основному каталозі»"] };
    const status = t(r["Стан синхронізації"]);
    const seal = rowSeal(r) === t(r[SEAL_COLUMN]) ? "OK" : "MISMATCH";
    const reasons = [], actions = [], blockers = [];
    if (status === "ЗМІНА_ІДЕНТИЧНОСТІ_АБО_КОМПЛЕКТУ") {
      reasons.push("постачальник під тим самим ID змінив назву / комплект (опорні назви постачальника в рядку ≠ фіду)");
      actions.push("«Оновити товари» з АКТУАЛЬНИМ повним фідом: сирі назви приймаються автоматично (рішення 23.10), наше SEO не змінюється; власник перевіряє «було → стало»");
      if (!feed.available) blockers.push("немає актуального повного фіду постачальника — нові назви невідомі (старим знімком не підміняти)");
    } else if (status && status !== "ЗІСТАВЛЕНО") {
      reasons.push(`стан синхронізації «${status}»`);
      actions.push("перевірити з актуальним повним фідом");
      if (!feed.available) blockers.push("немає актуального повного фіду постачальника");
    }
    if (seal === "MISMATCH") {
      reasons.push("печатка не збігається: вміст / ідентичність змінено після QA");
      actions.push("перша синхронізація нової системи (пріоритет власника): зміни полів — у «Класифікацію полів» на рішення власника; печатку перераховує sync, вручну — заборонено");
    }
    const d = byDecision.get(id);
    if (d) {
      const found = [];
      for (const p of forbiddenPatterns(d)) for (const f of QA_PUBLISHED_FIELDS) if (p.re.test(mtText(r[f]))) found.push(`${p.label} у «${f}»`);
      if (found.length) {
        reasons.push(`суперечить рішенню власника ${d.date || ""}: ${found.join("; ")}`.trim());
        actions.push("виправити контент (контентний агент: назви, описи, запити) і характеристики (рішення власника, OV) до затвердження");
        blockers.push("у полях, що публікуються, є значення, які власник визнав неправильними");
      }
    }
    if (r["Статус імпорту"] !== "ДОЗВОЛЕНО") blockers.push(`«Статус імпорту» = «${t(r["Статус імпорту"])}»`);
    return { offerId: id, found: true, status, availability: t(r["Наявність"]), seal, reasons, actions, blockers, applicable: blockers.length === 0 };
  });
  return { items, applicable: items.filter((x) => x.applicable).map((x) => x.offerId), blocked: items.filter((x) => !x.applicable).map((x) => x.offerId) };
}
