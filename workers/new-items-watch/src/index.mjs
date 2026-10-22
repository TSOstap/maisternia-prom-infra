/** «Сторож новинок» — вхідний Worker (Cloudflare Free). НЕ РОЗГОРНУТО.
 *  Лише маршрутизація (router.mjs) → один SQLite Durable Object «main» (watch-do.mjs → watch-core.mjs), де вся робота й стан.
 *  Cron Triggers немає: автоматичні перевірки (після окремого погодження) — через alarm самого Durable Object.
 *  Прив'язки (wrangler.jsonc): DO WATCH_DO (SQLite); секрети SUPPLIER_FEED_URL, WATCH_KEY, GITHUB_TOKEN (необов'язковий —
 *  без нього лише спостереження); змінні GITHUB_REPO, GITHUB_WORKFLOW, GITHUB_REF, GITHUB_MODE, FEED_PROFILE. */
import { route } from "./router.mjs";

export { WatchDO } from "./watch-do.mjs";

export default { fetch: route };
