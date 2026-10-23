/** Симуляція «Сторожа новинок» наскрізно: вхідний Worker → SQLite Durable Object (справжній SQLite, node:sqlite) →
 *  alarm кожні 5 хв → workflow_dispatch → GitHub intake → POST /ack. Годинник змодельований (без справжнього очікування).
 *  Мережа — заглушки: фід постачальника (поточний XML симуляції) і API GitHub. */
import { generateSynthetic } from "../../src/synth/generator.mjs";
import { parseSupplierText } from "../../src/core/supplier-feed.mjs";
import { readSheet } from "../../src/core/sync-plan.mjs";
import { mtText } from "../../src/core/text.mjs";
import { SHEET, extractFullOffers } from "../../src/core/sheet-sync.mjs";
import { mergeNew92, syncSheet } from "../../src/pipeline/sheet-sync-run.mjs";
import { MemorySheets } from "../../src/pipeline/sheets-writer.mjs";
import { route } from "../../workers/new-items-watch/src/router.mjs";
import { WatchCore } from "../../workers/new-items-watch/src/watch-core.mjs";
import { doContext, doNamespace } from "./do-sqlite.mjs";
import { EMPTY_CATALOG, intakeAll } from "./intake.mjs";
import baseConfig from "../../config/default.json" with { type: "json" };

export const T0 = Date.parse("2026-10-22T10:00:00Z");
export const MIN = 60_000;
const KEY = "test-watch-key-0123456789";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");


/** Offer у XML постачальника. Порожні поля — справді відсутні теги (як у недозаповненій картці Prom). */
export function offerXml(o) {
  const pics = (o.pictures || []).map((u) => `<picture>${esc(u)}</picture>`).join("");
  const params = (o.params || []).map((p) => `<param name="${esc(p.name)}"${p.unit ? ` unit="${esc(p.unit)}"` : ""}>${esc(p.value)}</param>`).join("");
  return `<offer id="${o.id}" available="${o.available ?? true}"><url>${esc(o.url || `https://market-tools.com.ua/p${o.id}-tovar.html`)}</url><price>${o.price ?? 1000}</price><currencyId>UAH</currencyId><categoryId>1</categoryId>`
    + `${o.nameRu ? `<name>${esc(o.nameRu)}</name>` : ""}${o.nameUa ? `<name_ua>${esc(o.nameUa)}</name_ua>` : ""}${o.sku ? `<vendorCode>${esc(o.sku)}</vendorCode>` : ""}${o.vendor ? `<vendor>${esc(o.vendor)}</vendor>` : ""}${o.model ? `<model>${esc(o.model)}</model>` : ""}`
    + `<description><![CDATA[<p>${esc(o.descRu || "опис")}</p>]]></description><description_ua><![CDATA[<p>${esc(o.descUa || "опис")}</p>]]></description_ua>${pics}${params}<quantity_in_stock></quantity_in_stock></offer>`;
}

export class WatchSim {
  constructor({ seed = 11, catalog = EMPTY_CATALOG } = {}) {
    this.catalog = catalog; // схеми категорій Prom (за замовчуванням — жодної)
    this.config = structuredClone(baseConfig);
    this.s = generateSynthetic({ products: 120, queue: 12, deferred: 4, newOffers: 0, seed, now: T0 });
    this.book = {
      [SHEET.main]: this.s.sheets["Основний каталог"], [SHEET.queue]: this.s.sheets["Нові товари"], [SHEET.deferred]: this.s.sheets["Відкладені товари"],
      [SHEET.frozen]: [["Offer ID"]], [SHEET.groups]: this.s.groups, [SHEET.journal]: [["Дата / час", "Аркуш", "Offer ID", "Поле", "Було", "Стало", "Статус"]],
    };
    this.sheets = new MemorySheets(this.book);
    this.readBook = async () => structuredClone(this.book);
    this.baseXml = this.s.supplierXml();
    this.extra = new Map(); // id → offer (додані/змінені симуляцією)
    this.yearDate = null;   // фіксована дата yml_catalog (сценарій «дата не змінилась»)
    this.now = T0;
    this.dctx = doContext();
    this.env = { WATCH_DO: doNamespace(() => this.core), ALARMS_ALLOWED: "yes", WATCH_KEY: KEY, SUPPLIER_FEED_URL: "https://market-tools.com.ua/products_feed.xml?hash_tag=test", GITHUB_TOKEN: "gh-test-token", GITHUB_REPO: "owner/repo", minOffers: "50" };
    this.workerUp = true;
    this.calls = { feed: 0, dispatch: 0, dispatchBodies: [] };
    this.intakes = [];
    this.handled = 0;
    this.core = this.makeCore();
    this.fetchImpl = async (url, init = {}) => {
      if (String(url).startsWith("https://api.github.com/")) { this.calls.dispatch++; this.calls.dispatchBodies.push(init.body); (this.calls.dispatchAt ||= []).push(this.now); return new Response(null, { status: 204 }); }
      this.calls.feed++;
      return new Response(this.xml(), { status: 200 });
    };
  }
  /** Екземпляр Durable Object на тому самому сховищі (новий — як після перезапуску / виселення DO). */
  makeCore() { return new WatchCore(this.dctx.ctx, this.env, { now: () => this.now, fetch: (u, i) => this.fetchImpl(u, i), log: () => {} }); }
  restart() { this.core = this.makeCore(); }
  stamp() { return new Date(this.now).toISOString(); }
  xml() {
    let xml = this.baseXml;
    if (this.yearDate) xml = xml.replace(/date="[^"]*"/, `date="${this.yearDate}"`);
    else xml = xml.replace(/date="[^"]*"/, `date="${new Date(this.now + 3 * 3600000).toISOString().slice(0, 16).replace("T", " ")}"`);
    for (const o of this.extra.values()) {
      const line = offerXml(o);
      const re = new RegExp(`<offer id="${o.id}"[\\s\\S]*?</offer>`);
      xml = re.test(xml) ? xml.replace(re, line) : xml.replace("\n</offers>", "\n" + line + "\n</offers>");
    }
    return xml;
  }
  /** Додати / змінити offer; без id — змінюється останній. */
  setOffer(o) { const id = o.id ?? this.lastId; this.lastId = id; this.extra.set(id, { ...(this.extra.get(id) || {}), ...o, id }); }
  req(path, method = "GET", body) {
    return new Request("https://watch.example" + path, { method, headers: { authorization: "Bearer " + KEY, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  }
  async parsed() { return parseSupplierText(this.xml(), { maximumChars: 45_000_000, identityFields: true }); }
  /** Підготовка: перенесення NEW92 і перша синхронізація (дає Worker базу відомих ID). */
  async start() {
    await mergeNew92({ sheets: this.sheets, readBook: this.readBook, stamp: this.stamp() });
    const r = await this.sync();
    // Розклад DO (у тестах дозволено змінною ALARMS_ALLOWED; у робочій конфігурації її немає)
    await route(this.req("/schedule", "POST", { on: true }), this.env);
    return r;
  }
  /** Синхронізація кожні 4 год (ціни, рішення, сирі дані черги) + звіт у Worker. */
  async sync() {
    const xml = this.xml();
    const r = await syncSheet({ sheets: this.sheets, readBook: this.readBook, parsed: await this.parsed(), fetchFull: async (ids) => extractFullOffers(xml, ids), stamp: this.stamp(), config: this.config, now: this.now, catalog: this.catalog });
    if (r.ack && this.workerUp) await route(this.req("/ack", "POST", r.ack), this.env);
    return r;
  }
  /** GitHub intake: список — з Worker (GET /intake), звіт — назад (POST /ack). */
  async github() {
    const list = await (await route(this.req("/intake"), this.env)).json();
    const r = await intakeAll({ sheets: this.sheets, readBook: this.readBook }, this.xml(), { stamp: this.stamp(), now: this.now, config: this.config, ready: list.ready, catalog: this.catalog });
    this.intakes.push(r);
    if (r.ack) await route(this.req("/ack", "POST", r.ack), this.env);
    return r;
  }
  /** Крок часу (+5 хв): якщо настав час alarm Durable Object — він спрацьовує; якщо DO запустив GitHub — intake. */
  async tick(minutes = 5) {
    this.now += minutes * MIN;
    if (!this.workerUp) return null; // Cloudflare недоступний — alarm не доставляється (буде доставлено пізніше)
    const at = this.dctx.alarm;
    if (at == null || at > this.now) return { skipped: "alarm ще не настав" };
    const rep = await this.core.alarm();
    if (this.calls.dispatch > this.handled) { this.handled = this.calls.dispatch; rep.intake = await this.github(); }
    return rep;
  }
  async status() { return (await route(this.req("/status"), this.env)).json(); }
  async run() { return (await route(this.req("/run", "POST"), this.env)).json(); }
  rows(name = SHEET.queue) { return readSheet(this.book[name], name).rows; }
  queueRow(id) { return this.rows().find((r) => mtText(r["Offer ID"]) === id); }
  setDecision(id, value) {
    const v = this.book[SHEET.queue];
    const h = v[0].map(mtText);
    v.find((x, i) => i > 0 && mtText(x[h.indexOf("Offer ID")]) === id)[h.indexOf("Рішення")] = value;
  }
  setCell(id, col, value) {
    const v = this.book[SHEET.queue];
    const h = v[0].map(mtText);
    v.find((x, i) => i > 0 && mtText(x[h.indexOf("Offer ID")]) === id)[h.indexOf(col)] = value;
  }
  journal(id) { return this.book[SHEET.journal].filter((e) => e[2] === id); }
}

/** Повна картка нового товару (усе, що вимагає перевірка повноти). */
export const fullOffer = (id, over = {}) => ({
  id, nameUa: `Шуруповерт акумуляторний Test ${id.slice(-3)} 18 В`, nameRu: `Шуруповерт аккумуляторный Test ${id.slice(-3)} 18 В`, sku: "T-" + id.slice(-4), vendor: "TestBrand",
  pictures: [`https://images.prom.ua/48${id.slice(-8)}_shurupovert.jpg`], params: [{ name: "Напруга", value: "18", unit: "В" }], price: 2500, ...over,
});
