/** Автопошук новинок (рішення власника 03.11.2026: «Так мені подобається щодо нових товарів робим»).
 *
 *  Сервер mm-ops (alarm Durable Object) кожні WATCH.everyMinutes хв завантажує фід постачальника лише з ID (без описів, фото,
 *  характеристик — ≈ 4 МБ) і порівнює з базою — знімком останнього запуску «Знайти нові товари» (W2: FIND_NEW_SEEN_KEY, той самий
 *  об'єкт). Запуск тієї самої операції, що й кнопка «Знайти нові товари», лише коли:
 *   • у фіді є ID, яких у знімку немає (новинки постачальника), або
 *   • новинки зі знімка ще чекають стабільності (find-new зберігає їх у waiting) і від знімка минуло ≥ WATCH.stableMinutes хв.
 *  Звідси в таблицю нічого не пишеться: стабільність, повноту, дублі, «Нові товари» й «Журнал» робить сама операція.
 *  Ліміти — щоб не витрачати безкоштовні хвилини GitHub Actions (приватний репозиторій: 2000 хв/міс). Чисті функції — тестуються в Node. */

import { scanFeed, completeness, INTAKE_RULES } from "../../../src/core/intake.mjs";

export const MIN = 60_000;
export const WATCH = Object.freeze({
  everyMinutes: 15,       // як часто сервер дивиться у фід (рішення 03.11: 15–30 хв)
  stableMinutes: 12,      // find-new додає новинку після ≥ 10 хв без змін від першого виявлення — повтор не раніше 12 хв
  maxPerDay: 8,           // автозапусків «Знайти нові товари» на добу (UTC): ≈ 4–5 хв кожен
  failHoldMinutes: 60,    // останній автозапуск не вдався — пауза
  backoffMinutes: 30,     // постачальник обмежив частоту (429 / 503) — пауза
  dropRatio: 0.8,         // фід із меншою кількістю ID, ніж 80 % знімка, — неповний
  maxFeedChars: 40_000_000,
});
/** = FIND_NEW_SEEN_KEY у src/pipeline/find-new.mjs (тест звіряє). */
export const FIND_NEW_SEEN_KEY = "state/supplier-snapshot/find-new-seen.json";
/** = config.supplier.allowedUrlPattern: секретна адреса не піде на інший хост. */
export const FEED_URL_RE = /^https:\/\/market-tools\.com\.ua\//i;
/** = FEED_FILTER_PARAMS (src/core/supplier-presence.mjs): «Знайти нові товари» бере ПОВНИЙ фід — фільтр груп / товарів / міток знімаємо. */
export const FILTER_PARAMS = Object.freeze(["group_ids", "nested_group_ids", "product_ids", "label_ids"]);
/** = config.supplier.operationalParams: лише ID і короткі поля. */
export const ID_PARAMS = Object.freeze({ exclude_fields: "description,picture,param,keywords", html_description: "0", extra_fields: "0" });
/** Неповні новинки (немає фото / характеристик тощо — completeness, як у find-new): перевірка не частіше разу на годину;
 *  фід — без описів і ключових слів (фото й характеристики є; = FEED_PROFILES.medium у src/core/intake.mjs). */
export const INCOMPLETE_CHECK_MINUTES = 60;
export const CONTENT_PARAMS = Object.freeze({ exclude_fields: "description,keywords", html_description: "0", extra_fields: "0" });

/** Стани find-new, після яких знімок збережено (наступна перевірка порівнює з новим знімком). Інший стан — пауза failHoldMinutes. */
export const OK_STATES = new Set(["INTAKE_DONE", "NOTHING_TO_WRITE", "NOTHING_NEW", "WAITING_STABILITY", "NOTHING_COMPLETE"]);
export const AUTO_BY = "Автоперевірка новинок (сервер)";

const DAY = (t) => new Date(t).toISOString().slice(0, 10);
const hhmm = (t) => new Date(t).toISOString().slice(11, 16) + " UTC";

/** Адреса фіду лише з ID: без фільтра охоплення (як повний фід «Знайти нові товари»), без описів / фото / характеристик. */
export function idsFeedUrl(base, params = ID_PARAMS) {
  const u = new URL(base);
  for (const p of FILTER_PARAMS) if (u.searchParams.has(p)) u.searchParams.set(p, "");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** Текст фіду з фото й характеристиками (без описів) — { text } | { backoff } | { error }. */
export async function fetchContentFeed(base, fetchImpl) {
  if (!base || !FEED_URL_RE.test(base)) return { error: "немає адреси фіду Market Tools" };
  let res;
  try { res = await fetchImpl(idsFeedUrl(base, CONTENT_PARAMS), { redirect: "manual", headers: { "accept-encoding": "gzip" } }); }
  catch (e) { return { error: "фід недоступний: " + String(e?.message || e).slice(0, 100) }; }
  if (res.status === 429 || res.status === 503) return { backoff: true, httpStatus: res.status };
  if (res.status !== 200) return { error: "фід: HTTP " + res.status };
  const text = await res.text();
  if (text.length > WATCH.maxFeedChars) return { error: "фід завеликий" };
  if (!text.slice(-512).includes("</yml_catalog>")) return { error: "фід неповний" };
  return { text };
}

/** Які з неповних новинок тепер повні (ті самі правила completeness, що й у «Знайти нові товари»). */
export function completedNow(text, ids) {
  const want = new Set(ids.map(String));
  const scan = scanFeed(text, (id) => want.has(id));
  return [...want].filter((id) => scan.offers.has(id) && completeness(scan.offers.get(id), { requireParams: INTAKE_RULES.requireParams }).length === 0);
}

/** Межі автозапусків (доба, інтервал, пауза після невдачі) → null (можна) | { result, message }. */
export function dispatchBlock({ now, w = {}, lastAuto = null }) {
  const count = w.day === DAY(now) ? Number(w.count) || 0 : 0;
  if (count >= WATCH.maxPerDay) return { result: "LIMIT", message: `ліміт автозапусків на добу (${WATCH.maxPerDay}) вичерпано — новинки знайде кнопка або завтрашня перевірка` };
  if (w.lastDispatchAt && now - w.lastDispatchAt < WATCH.stableMinutes * MIN) return { result: "GAP", message: `попередній автозапуск о ${hhmm(w.lastDispatchAt)} — наступний не раніше ніж через ${WATCH.stableMinutes} хв` };
  if (lastAuto && (lastAuto.status !== "DONE" || !OK_STATES.has(lastAuto.state)) && now - Number(lastAuto.updated) < WATCH.failHoldMinutes * MIN)
    return { result: "HOLD", message: `останній автозапуск не вдався (${lastAuto.state || lastAuto.status}) — пауза ${WATCH.failHoldMinutes} хв` };
  return null;
}
/** Те, з чим порівнюється знімок find-new: хост + шлях (без параметрів, як maskSource). */
export const hostPath = (base) => { const u = new URL(base); return u.host + u.pathname; };

/** ID усіх offer. Обірваний документ, повтори ID або невідомий формат offer — помилка (рішення не приймається). */
export function scanIds(xml) {
  if (!xml.slice(-512).includes("</yml_catalog>")) throw new Error("немає кінця документа — фід неповний");
  const ids = new Set();
  let i = 0, offers = 0, dup = 0;
  for (;;) {
    i = xml.indexOf("<offer ", i);
    if (i < 0) break;
    offers++;
    const gt = xml.indexOf(">", i);
    if (gt < 0) throw new Error("обірваний запис offer — фід неповний");
    const id = /\bid\s*=\s*"(\d+)"/.exec(xml.slice(i + 6, gt))?.[1];
    if (!id) throw new Error("offer без числового ID");
    if (ids.has(id)) dup++;
    ids.add(id);
    i = gt + 1;
  }
  if (dup) throw new Error("повторені ID offer у фіді");
  if (!offers) throw new Error("у фіді немає offer");
  return ids;
}

/** Завантажити ID фіду. { ids } | { backoff: true } | { error }. Переадресації не виконуються (Workers: redirect "manual" + 3xx = помилка). */
export async function fetchIds(base, fetchImpl) {
  if (!base) return { error: "на сервері немає адреси фіду (секрет SUPPLIER_FEED_URL)" };
  if (!FEED_URL_RE.test(base)) return { error: "адреса фіду не Market Tools (HTTPS) — запит не надіслано" };
  let res;
  try { res = await fetchImpl(idsFeedUrl(base), { redirect: "manual", headers: { "accept-encoding": "gzip" } }); }
  catch (e) { return { error: "фід недоступний: " + String(e?.message || e).slice(0, 100) }; }
  if (res.status === 429 || res.status === 503) return { backoff: true, httpStatus: res.status };
  if (res.status !== 200) return { error: (res.status >= 300 && res.status < 400 ? "фід: переадресація заборонена, HTTP " : "фід: HTTP ") + res.status };
  let text;
  try { text = await res.text(); } catch (e) { return { error: "фід обірвано: " + String(e?.message || e).slice(0, 100) }; }
  if (text.length > WATCH.maxFeedChars) return { error: "фід завеликий" };
  try { return { ids: scanIds(text), chars: text.length }; } catch (e) { return { error: "фід пошкоджений: " + String(e?.message || e).slice(0, 100) }; }
}

/** Чи можна взагалі порівнювати: є знімок find-new, і він зроблений з того самого (повного) фіду, що й адреса сервера. */
export function watchPrecheck({ seen, feedUrl }) {
  if (!feedUrl || !FEED_URL_RE.test(feedUrl)) return { result: "NO_URL", message: "на сервері немає адреси фіду Market Tools — автоперевірка не працює" };
  if (!seen || !Array.isArray(seen.ids) || !seen.ids.length) return { result: "NO_BASE", message: "ще немає знімка «Знайти нові товари» — натисніть кнопку один раз вручну" };
  if (seen.scope !== "full" || seen.source !== hostPath(feedUrl)) return { result: "SOURCE_MISMATCH", message: "останній пошук новинок зроблено з іншого фіду, ніж бачить сервер — автозапуск зупинено (потрібна перевірка)" };
  return null;
}

/**
 * Рішення одного циклу (без мережі). w — стан автоперевірки { day, count, lastDispatchAt }; lastAuto — останній автозапуск
 * ({ status, state, updated }) або null. Повертає { result, message, offers, fresh, waiting }; result "DISPATCH" — запускати.
 */
export function decideWatch({ seen, ids, now, w = {}, lastAuto = null }) {
  const minimum = Math.round(Number(seen.count || seen.ids.length) * WATCH.dropRatio);
  if (ids.size < minimum) return { result: "FEED_INCOMPLETE", message: `фід неповний (${ids.size} ID < ${minimum}) — перевірка наступного разу`, offers: ids.size };
  const known = new Set(seen.ids);
  const fresh = [...ids].filter((id) => !known.has(id)).length;
  const waiting = (Array.isArray(seen.waiting) ? seen.waiting : []).filter((id) => ids.has(String(id))).length;
  const counts = { offers: ids.size, fresh, waiting };
  if (!fresh && !waiting) return { result: "NOTHING_NEW", message: "нових товарів у фіді немає", ...counts };
  const seenAt = Date.parse(seen.seenAt || seen.fetchedAt || "") || 0;
  if (!fresh && now - seenAt < WATCH.stableMinutes * MIN) return { result: "WAITING", message: `новинки (${waiting}) чекають ${WATCH.stableMinutes} хв стабільності`, ...counts };
  const block = dispatchBlock({ now, w, lastAuto });
  if (block) return { ...block, ...counts };
  return { result: "DISPATCH", message: fresh ? `у фіді нових ID: ${fresh} — запуск «Знайти нові товари»` : `новинки (${waiting}) пройшли ${WATCH.stableMinutes} хв стабільності — повторний запуск`, ...counts };
}

/** Після прийнятого запуску: лічильник доби й час. */
export function markWatchDispatch(w, now) {
  const day = DAY(now);
  return { ...w, day, count: (w.day === day ? Number(w.count) || 0 : 0) + 1, lastDispatchAt: now };
}
