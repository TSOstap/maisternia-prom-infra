/** Автоімпорт у Prom (рішення власника 18.11.2026: «Так погоджую»).
 *
 *  Після кожної зміни нашого YML сервер сам запускає імпорт ЛИШЕ нашого посилання через Prom Public API
 *  (Swagger prom.ua/cloud-cgi/static/uaprom-static/docs/swagger, host my.prom.ua/api/v1):
 *   • POST /products/import_url — оновлюються лише ціна, наявність і знижка (updated_fields);
 *     товари, яких немає у файлі, — «Залишити без змін» (mark_missing_product_as: none), інакше Prom сховав би
 *     «Товари для дому» (друге посилання кабінету); «Оновити примусово» вимкнено — Prom бере лише змінені позиції;
 *   • GET /products/import/status/{id} — результат (SUCCESS / PARTIAL / FATAL і лічильники).
 *  Межі (довідка Prom «Імпорт позицій із файла»: ручний імпорт — до 10 разів на добу, далі кожен наступний через 2 год):
 *  не частіше ніж раз на 2 год і не більше 6 на добу (за київським часом) — із запасом на ручні імпорти власника.
 *  Секрети Worker: PROM_API_TOKEN (токен кабінету, права «Продукти та групи»), PROM_FEED_URL (точна адреса нашого YML, як у кабінеті).
 *  Тут лише рішення та запити — без сховища; стан тримає ops-core.mjs (meta «prom-import»). */
import { formatYmlDate } from "../../../src/core/time.mjs";

export const PROM_IMPORT_KEY = "prom-import";
export const PROM_IMPORT = Object.freeze({
  api: "https://my.prom.ua/api/v1",
  /** Мінімальний проміжок між автоімпортами. */
  minGapMinutes: 120,
  /** Не більше автоімпортів за добу (київський час). */
  maxPerDay: 6,
  /** Як часто перевіряти, чи змінився фід / чи завершився імпорт. */
  everyMinutes: 15,
  /** Статус імпорту — не раніше ніж через стільки хвилин після запуску. */
  statusAfterMinutes: 5,
  /** Статусу так і немає — вважати імпорт завершеним із невідомим результатом. */
  staleMinutes: 180,
  /** Пауза після помилки запуску (мережа, Prom зайнятий, інший імпорт ще йде). */
  retryMinutes: 30,
  /** Пауза, якщо Prom не приймає токен (401 / 403) — власник має перевірити токен і права. */
  authPauseMinutes: 360,
  fields: Object.freeze(["price", "presence", "discount"]),
});
const MIN = 60_000;
const FINAL = new Set(["SUCCESS", "PARTIAL", "FATAL"]);
/** Лише наш YML на сервері mm-ops: /yml/<FEED_KEY>.xml (захист від імпорту чужої адреси через помилку в секреті). */
export const OUR_FEED_RE = /^https:\/\/[a-z0-9.-]+\/yml\/[A-Za-z0-9_-]{24,}\.xml$/;

/** Київська дата «yyyy-MM-dd» і час «HH:mm» — той самий спільний помічник, що й дата в YML. */
export const kyivDay = (ms) => formatYmlDate(Number(ms), "Europe/Kyiv").slice(0, 10);
export const kyivTime = (ms) => formatYmlDate(Number(ms), "Europe/Kyiv").slice(11, 16);

/** Тіло запиту імпорту (параметри — точно за моделлю ImportProductURL зі Swagger Prom). */
export function importBody(feedUrl) {
  return { url: feedUrl, force_update: false, only_available: false, mark_missing_product_as: "none", updated_fields: [...PROM_IMPORT.fields] };
}

/** Чи налаштовано сервер (без мережі). */
export function promImportReady(env) {
  if (!env?.PROM_API_TOKEN) return { ok: false, reason: "на сервері немає токена Prom (PROM_API_TOKEN)" };
  if (!OUR_FEED_RE.test(String(env?.PROM_FEED_URL || ""))) return { ok: false, reason: "на сервері немає адреси нашого YML (PROM_FEED_URL)" };
  return { ok: true };
}

/** Рішення без мережі. st — стан автоімпорту; changedAt — остання зміна YML; busy — текст, якщо зараз іде операція / оновлення YML. */
export function decidePromImport({ st = {}, changedAt, now, busy = "" }) {
  if (!st.on) return { go: false, result: "OFF", message: "автоімпорт вимкнено" };
  if (!changedAt) return { go: false, result: "NO_FEED", message: "YML ще не зібрано" };
  if (st.current) return { go: false, result: "RUNNING", message: `імпорт від ${kyivTime(st.current.at)} ще виконується` };
  if (Number(changedAt) <= Number(st.importedChangedAt || 0)) return { go: false, result: "NO_CHANGES", message: "фід не змінився з попереднього імпорту" };
  if (busy) return { go: false, result: "BUSY", message: busy + " — імпорт після завершення" };
  if (now < Number(st.retryAt || 0)) return { go: false, result: "PAUSE", message: `пауза після помилки до ${kyivTime(st.retryAt)}` };
  const gapEnd = Number(st.lastAt || 0) + PROM_IMPORT.minGapMinutes * MIN;
  if (now < gapEnd) return { go: false, result: "GAP", message: `попередній імпорт о ${kyivTime(st.lastAt)} — наступний не раніше ${kyivTime(gapEnd)}` };
  const day = kyivDay(now), count = st.day === day ? Number(st.count) || 0 : 0;
  if (count >= PROM_IMPORT.maxPerDay) return { go: false, result: "LIMIT", message: `сьогодні вже ${count} автоімпортів (межа ${PROM_IMPORT.maxPerDay}) — наступний завтра; ціни підхопить і автоімпорт кабінету` };
  return { go: true, result: "START", day, count };
}

const readJson = async (r) => { const t = await r.text(); try { return { j: JSON.parse(t), t }; } catch { return { j: null, t }; } };
const headers = (token) => ({ authorization: "Bearer " + token, "content-type": "application/json", "x-language": "uk" });

/** Запуск імпорту. → { ok, id } | { ok:false, httpStatus, auth, reason } */
export async function startPromImport({ token, feedUrl, fetchImpl }) {
  let r;
  try { r = await fetchImpl(PROM_IMPORT.api + "/products/import_url", { method: "POST", headers: headers(token), body: JSON.stringify(importBody(feedUrl)) }); }
  catch (e) { return { ok: false, httpStatus: 0, reason: "Prom недоступний (" + String(e?.name || "мережа") + ")" }; }
  const { j, t } = await readJson(r);
  if (r.status === 200 && j?.id != null && j.status !== "error") return { ok: true, id: String(j.id) };
  const msg = j?.error?.message || j?.message || (j?.status === "error" ? "Prom відхилив запит" : t.slice(0, 160));
  return { ok: false, httpStatus: r.status, auth: r.status === 401 || r.status === 403, reason: `Prom HTTP ${r.status}: ${String(msg).slice(0, 200)}` };
}

/** Статус імпорту. → { ok, status, final, counts } | { ok:false, reason } */
export async function promImportStatus({ token, id, fetchImpl }) {
  let r;
  try { r = await fetchImpl(PROM_IMPORT.api + "/products/import/status/" + encodeURIComponent(id), { headers: headers(token) }); }
  catch (e) { return { ok: false, reason: "Prom недоступний (" + String(e?.name || "мережа") + ")" }; }
  const { j } = await readJson(r);
  if (r.status !== 200 || !j) return { ok: false, reason: `Prom HTTP ${r.status}` };
  const status = String(j.status || "");
  const n = (k) => (Number.isFinite(Number(j[k])) ? Number(j[k]) : null);
  const counts = { total: n("total"), imported: n("imported"), updated: n("updated"), notChanged: n("not_changed"), created: n("created"), withErrors: n("with_errors_count") };
  return { ok: true, status, final: isFinal(status, counts), counts };
}

/** 18.11 (перший живий запуск): Prom віддає PARTIAL ще під час обробки (лічильники 0 з 5472), а потім — PARTIAL з повними
 *  лічильниками (оновлено 4 + без змін 5468 = 5472). Тому PARTIAL — фінал лише коли оброблено всі позиції. */
export function isFinal(status, c = {}) {
  if (status === "SUCCESS" || status === "FATAL") return true;
  if (status !== "PARTIAL" || !(Number(c.total) > 0)) return false;
  return (Number(c.imported) || 0) + (Number(c.notChanged) || 0) + (Number(c.withErrors) || 0) >= Number(c.total);
}

/** Короткий підсумок для власника (меню «Стан останньої операції»). */
export function statusText(s) {
  const word = { SUCCESS: "готово", PARTIAL: "готово (статус Prom PARTIAL)", FATAL: "помилка" }[s.status] || s.status || "невідомо";
  const c = s.counts || {};
  const parts = [];
  if (c.updated != null) parts.push(`оновлено ${c.updated}`);
  if (c.notChanged != null) parts.push(`без змін ${c.notChanged}`);
  if (c.created) parts.push(`створено ${c.created}`);
  if (c.withErrors) parts.push(`з помилками ${c.withErrors}`);
  if (c.total != null) parts.push(`усього ${c.total}`);
  return word + (parts.length ? " — " + parts.join(", ") : "");
}
