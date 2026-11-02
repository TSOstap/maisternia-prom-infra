/** «mm-ops» — вхідний Worker (Cloudflare Free): лише перевірка ключа за роллю шляху → один SQLite Durable Object «main».
 *  Прив'язки (wrangler.jsonc): DO OPS_DO; секрети BUTTON_KEY (кнопки Apps Script), RUNNER_KEY (запускач GitHub Actions),
 *  ADMIN_KEY (оператор: вхідні файли, перенесення стану W2), GITHUB_TOKEN (fine-grained, лише Actions: write цього репозиторію);
 *  змінні GITHUB_REPO, GITHUB_WORKFLOW, GITHUB_REF. */
import { DurableObject } from "cloudflare:workers";
import { OpsCore, roleFor, json } from "./ops-core.mjs";

export class OpsDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new OpsCore(ctx.storage, env);
  }
  fetch(req) { return this.core.fetch(req); }
}

export default {
  async fetch(req, env) {
    if (!roleFor(req, env)) return json({ error: { code: "UNAUTHORIZED", message: "немає доступу" } }, 401);
    return env.OPS_DO.get(env.OPS_DO.idFromName("main")).fetch(req);
  },
};
