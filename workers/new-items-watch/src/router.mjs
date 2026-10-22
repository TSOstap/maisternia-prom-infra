/** Вхідний Worker «Сторожа новинок»: лише маршрутизація — перевірка ключа доступу → один Durable Object «main». */
import { authorized, json } from "./cycle.mjs";

const ROUTES = new Set(["GET /status", "GET /intake", "POST /ack", "POST /run", "POST /schedule"]);

export async function route(req, env) {
  if (!authorized(req, env)) return json({ error: "немає доступу" }, 401);
  const url = new URL(req.url);
  if (!ROUTES.has(req.method + " " + url.pathname)) return json({ error: "не знайдено" }, 404);
  return env.WATCH_DO.get(env.WATCH_DO.idFromName("main")).fetch(req);
}
