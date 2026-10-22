/** Durable Object для Cloudflare: тонка обгортка над WatchCore (уся логіка — у watch-core.mjs, тестується в Node).
 *  Документація Cloudflare показує DO лише як `extends DurableObject` — тому наслідуємо базовий клас. */
import { DurableObject } from "cloudflare:workers";
import { WatchCore } from "./watch-core.mjs";

export class WatchDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new WatchCore(ctx, env);
  }
  fetch(req) { return this.core.fetch(req); }
  alarm(alarmInfo) { return this.core.alarm(alarmInfo); }
}
