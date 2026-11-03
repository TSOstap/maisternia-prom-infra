/** «mm-ops» — вхідний Worker (Cloudflare Free): лише перевірка ключа за роллю шляху → один SQLite Durable Object «main».
 *  Прив'язки (wrangler.jsonc): DO OPS_DO; секрети BUTTON_KEY (кнопки Apps Script), RUNNER_KEY (запускач GitHub Actions),
 *  ADMIN_KEY (оператор: вхідні файли, перенесення стану W2), GITHUB_TOKEN (fine-grained, лише Actions: write цього репозиторію),
 *  SUPPLIER_FEED_URL (фід постачальника для автопошуку новинок — alarm цього DO);
 *  FEED_KEY (секрет у постійній адресі YML для Prom: /yml/<FEED_KEY>.xml — Prom не надсилає заголовків, тому ключ — в адресі);
 *  змінні GITHUB_REPO, GITHUB_WORKFLOW, GITHUB_REF. */
import { DurableObject } from "cloudflare:workers";
import { OpsCore, roleFor, json, sameKey } from "./ops-core.mjs";

export class OpsDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new OpsCore(ctx.storage, env);
  }
  fetch(req) { return this.core.fetch(req); }
  alarm() { return this.core.alarm(); }
}

export default {
  async fetch(req, env) {
    // YML для Prom: лише GET / HEAD і лише з правильним секретом в адресі; інакше — 404 (без підказки, що адреса існує).
    const feed = /^\/yml\/([A-Za-z0-9_-]{24,})\.xml$/.exec(new URL(req.url).pathname);
    if (feed) {
      if ((req.method !== "GET" && req.method !== "HEAD") || !sameKey(feed[1], env.FEED_KEY)) return new Response("Not found", { status: 404 });
      return env.OPS_DO.get(env.OPS_DO.idFromName("main")).fetch(new Request(new URL("/internal/feed", req.url), { method: req.method }));
    }
    if (!roleFor(req, env)) return json({ error: { code: "UNAUTHORIZED", message: "немає доступу" } }, 401);
    return env.OPS_DO.get(env.OPS_DO.idFromName("main")).fetch(req);
  },
};
