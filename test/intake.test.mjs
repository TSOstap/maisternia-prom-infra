/** «Сторож новинок»: ядро (відбитки, повнота, стан), Worker (доступ, пауза, лише спостереження), варіант А в черзі, міграція колонок. */
import test from "node:test";
import assert from "node:assert/strict";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { readSheet } from "../src/core/sync-plan.mjs";
import { mtText } from "../src/core/text.mjs";
import { SHEET, QUEUE_HEADERS, QUEUE_STATE, SEO_FIELDS, candidateRow, extractFullOffers, refreshQueueRow, seoHash } from "../src/core/sheet-sync.mjs";
import {
  INTAKE_RULES, applyAck, changedParts, completeness, emptyState, markDispatched, parseFingerprint, planWatch, rawFromOffer, rawFromQueueRow,
  scanFeed, sheetFingerprint, verifyReady, watchFeedUrl, watchFingerprint,
} from "../src/core/intake.mjs";
import worker, { ACK_KEY, STATE_KEY, runWatch } from "../workers/new-items-watch/src/index.mjs";
import { WatchSim, fullOffer, memoryKv, offerXml, MIN, T0 } from "./helpers/watch-sim.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const raw = (over = {}) => ({ id: "1", nameUa: "Дриль UA", nameRu: "Дрель RU", sku: "D-1", url: "https://market-tools.com.ua/p1-d.html", price: 100, currency: "UAH", available: true,
  pictures: ["https://images.prom.ua/111_a.jpg", "https://images.prom.ua/222_b.jpg"], params: [{ name: "Потужність", value: "500", unit: "Вт" }, { name: "Вага", value: "2", unit: "кг" }],
  descriptionUa: "<p>опис</p>", descriptionRu: "<p>описание</p>", hasDescription: true, ...over });
const feed = (offers) => `<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="2026-10-22 13:00"><shop><offers>\n${offers.map(offerXml).join("\n")}\n</offers></shop></yml_catalog>\n`;

test("відбиток: порядок фото й характеристик — не зміна; набір — зміна; назви/артикул/URL — по частинах; опис лише в «s1»", () => {
  const a = watchFingerprint(raw());
  assert.match(a, /^w1\.medium(\.[0-9a-f]{8}){6}$/);
  assert.equal(watchFingerprint(raw({ pictures: raw().pictures.slice().reverse(), params: raw().params.slice().reverse() })), a);
  assert.equal(watchFingerprint(raw({ nameUa: "  дриль   ua " })), a, "регістр і пробіли — не суттєво");
  assert.deepEqual(changedParts(a, watchFingerprint(raw({ pictures: ["https://images.prom.ua/333_c.jpg"] }))), ["фото"]);
  assert.deepEqual(changedParts(a, watchFingerprint(raw({ nameUa: "Дриль 2", sku: "D-2" }))), ["назва UA", "артикул"]);
  assert.equal(watchFingerprint(raw({ descriptionUa: "інший" })), a, "опис Worker не бачить");
  const s = sheetFingerprint(raw());
  assert.deepEqual(changedParts(s, sheetFingerprint(raw({ descriptionUa: "<p>новий опис</p>" }))), ["опис"]);
  assert.equal(sheetFingerprint({ ...raw({ descriptionUa: "x" }), hasDescription: false }, s), s, "без повного XML опис береться з попереднього відбитка");
  assert.equal(parseFingerprint("зламане"), null);
  assert.deepEqual(changedParts("x", "y"), ["дані постачальника"]);
  assert.equal(watchFingerprint(raw({ price: 999, available: false })), a, "ціна й наявність — не суттєві для стабільності");
});

test("відбиток однаковий у Worker (scanFeed) і в GitHub (розбір + повний XML) — інакше intake відмовляв би чи черга «оновлювалась» щоразу", async () => {
  const offers = [fullOffer("2970000001"), fullOffer("2970000002", { pictures: Array.from({ length: 12 }, (_, i) => `https://images.prom.ua/49${i}0000000_x.jpg`), nameUa: "Назва &amp; «лапки»" }),
    fullOffer("2970000003", { params: [{ name: "Комплектація", value: "2 АКБ, ЗП", unit: "" }, { name: "Ємність", value: "4", unit: "Ач" }] })];
  const xml = feed(offers);
  const scan = scanFeed(xml, () => true);
  const parsed = await parseSupplierText(xml, { maximumChars: 1e7, identityFields: true });
  const full = extractFullOffers(xml, offers.map((o) => o.id));
  for (const o of offers) {
    const viaWorker = watchFingerprint(scan.offers.get(o.id));
    const viaGithub = watchFingerprint(rawFromOffer(parsed.offers.get(o.id), full.get(o.id)));
    assert.equal(viaWorker, viaGithub, o.id);
    // і з рядка черги, створеного intake (фото обрізано до 10 — так само в обох)
    const row = candidateRow(parsed.offers.get(o.id), full.get(o.id), "2026-10-22T10:00:00.000Z", baseConfig.pricing);
    assert.equal(watchFingerprint(rawFromQueueRow(row)), viaWorker, "черга ↔ Worker");
  }
});

test("повнота: назви UA/RU, артикул, ціна > 0, валюта UAH, наявність, фото, характеристики (у фолбек-профілі — без фото/характеристик)", () => {
  assert.deepEqual(completeness(raw()), []);
  assert.deepEqual(completeness(raw({ nameUa: "", sku: " ", price: 0, pictures: [], params: [] })), ["назва UA", "артикул", "ціна", "фото", "характеристики"]);
  assert.deepEqual(completeness(raw({ currency: "USD", available: null })), ["валюта UAH", "наявність"]);
  assert.deepEqual(completeness(raw({ pictures: [], params: [] }), { profile: "operational" }), []);
  assert.deepEqual(completeness(raw({ params: [] }), { requireParams: false }), []);
});

test("scanFeed: обірваний фід, повтор ID, невалідний ID — помилка (нічого не вирішуємо); дату лише читаємо", () => {
  const xml = feed([fullOffer("2970000001"), fullOffer("2970000002")]);
  const s = scanFeed(xml, () => false);
  assert.equal(s.date, "2026-10-22 13:00");
  assert.equal(s.ids.size, 2);
  assert.equal(s.offers.size, 0, "розбираються лише потрібні ID");
  assert.throws(() => scanFeed(xml.slice(0, xml.length - 40), () => true), /неповний/);
  assert.throws(() => scanFeed(feed([fullOffer("2970000001"), fullOffer("2970000001")]), () => true), /повторені/);
  assert.throws(() => scanFeed(feed([{ ...fullOffer("2970000001"), id: "abc" }]), () => true), /невалідний ID/);
});

test("стан Worker: кандидат, що зник, — «ЗНИК», через 24 год забуто; повернувся — відлік стабільності заново", () => {
  let state = applyAck(emptyState(), { known: ["1"], queue: {} }, T0);
  const rules = { ...INTAKE_RULES, minOffers: 1, dropRatio: 0 }; // крихітний фід: поріг «неповного фіду» вимкнено лише тут
  const scanWith = (offers) => ({ date: "", ids: new Set(["1", ...offers.keys()]), offers });
  const o = new Map([["2", raw({ id: "2" })]]);
  let p = planWatch({ state, scan: scanWith(o), now: T0, rules });
  p = planWatch({ state: p.state, scan: scanWith(new Map()), now: T0 + 5 * MIN, rules });
  assert.equal(p.state.candidates["2"].status, "ЗНИК");
  const back = planWatch({ state: p.state, scan: scanWith(o), now: T0 + 60 * MIN, rules });
  assert.equal(back.state.candidates["2"].lastChange, T0 + 60 * MIN, "повернення — нова точка відліку");
  assert.ok(back.state.candidates["2"].history.some((h) => h.what === "ПОВЕРНУВСЯ У ФІД"));
  const gone = planWatch({ state: p.state, scan: scanWith(new Map()), now: T0 + 25 * 60 * MIN, rules });
  assert.ok(!gone.state.candidates["2"], "забуто через добу");
  state = gone.state;
});

test("фолбек-профіль (operational, якщо medium не вкладеться в CPU): друга фаза — фото й характеристики мають бути стабільні ≥10 хв", () => {
  const now = T0 + 30 * MIN;
  const r = raw({ id: "5" });
  const entry = { id: "5", fp: watchFingerprint(r, "operational"), lastChange: new Date(T0).toISOString() };
  const first = verifyReady(entry, r, now, { profile: "operational" });
  assert.equal(first.ok, false);
  assert.ok(first.fullFp, "перша фаза повертає відбиток повних даних");
  assert.equal(verifyReady({ ...entry, fullFp: first.fullFp }, r, now, { profile: "operational" }).ok, true);
  assert.equal(verifyReady({ ...entry, fullFp: first.fullFp }, raw({ id: "5", pictures: ["https://images.prom.ua/9_x.jpg"] }), now, { profile: "operational" }).ok, false, "фото змінились між фазами");
  // Worker: відмова з fullFp → пауза 10 хв і повтор з fullFp
  let st = applyAck(emptyState(), { known: ["1"], queue: {} }, T0);
  st.candidates["5"] = { firstSeen: T0, lastChange: T0, fp: entry.fp, missing: [], status: "ПЕРЕДАНО", dispatchedAt: T0, dispatchedFp: entry.fp, history: [] };
  st = applyAck(st, { known: ["1"], queue: {}, results: { 5: { status: "ВІДМОВА", reason: "друга фаза", fullFp: first.fullFp } } }, T0 + MIN);
  assert.equal(st.candidates["5"].fullFp, first.fullFp);
  assert.equal(st.candidates["5"].holdUntil, T0 + MIN + 10 * MIN);
  assert.equal(watchFeedUrl("https://market-tools.com.ua/products_feed.xml?hash_tag=x&exclude_fields=param", "operational"), "https://market-tools.com.ua/products_feed.xml?hash_tag=x&exclude_fields=description%2Cpicture%2Cparam%2Ckeywords&html_description=0&extra_fields=0");
  assert.match(watchFeedUrl("https://market-tools.com.ua/products_feed.xml?hash_tag=x"), /exclude_fields=description%2Ckeywords/);
});

test("звіт GitHub: без бази відомих ID — відмова; додані — не кандидати; відмова — пауза 30 хв; нова зміна черги не губиться", () => {
  assert.throws(() => applyAck(emptyState(), { known: [] }, T0), /бази/);
  let st = applyAck(emptyState(), { known: ["1"], queue: { 7: "w1.medium.a" } }, T0);
  st.queue["7"].pendingFp = "w1.medium.b"; st.queue["7"].pendingSince = T0;
  st.candidates["8"] = { firstSeen: T0, lastChange: T0, fp: "f", status: "ПЕРЕДАНО", history: [] };
  st.candidates["9"] = { firstSeen: T0, lastChange: T0, fp: "g", status: "ПЕРЕДАНО", history: [] };
  st = applyAck(st, { known: ["1", "8"], queue: { 7: "w1.medium.a" }, results: { 8: { status: "ДОДАНО" }, 9: { status: "ВІДМОВА", reason: "неповні дані: бракує фото" } } }, T0 + MIN);
  assert.ok(!st.candidates["8"]);
  assert.equal(st.candidates["9"].status, "ВІДКЛАДЕНО");
  assert.equal(st.candidates["9"].holdUntil, T0 + 31 * MIN);
  assert.equal(st.queue["7"].pendingFp, "w1.medium.b", "зміна, якої таблиця ще не отримала, — збережена");
  const d = markDispatched(st, { ready: [{ id: "9", fp: "g" }], refresh: [] }, T0 + 2 * MIN);
  assert.equal(d.dispatch.count, 1);
});

test("Worker: доступ лише за ключем; /ack перевіряє формат і профіль; невідомі шляхи — 404", async () => {
  const kv = memoryKv();
  const env = { WATCH_KV: kv, WATCH_KEY: "k".repeat(24) };
  const call = (path, { key = env.WATCH_KEY, method = "GET", body } = {}) => worker.fetch(new Request("https://w.example" + path, { method, headers: key ? { authorization: "Bearer " + key } : {}, body }), env);
  assert.equal((await call("/status", { key: "" })).status, 401);
  assert.equal((await call("/status", { key: "k".repeat(23) + "x" })).status, 401);
  assert.equal((await worker.fetch(new Request("https://w.example/status"), { WATCH_KV: kv })).status, 401, "без налаштованого ключа — доступу немає");
  assert.equal((await call("/status")).status, 200);
  assert.equal((await call("/ack", { method: "POST", body: "{" })).status, 400);
  assert.equal((await call("/ack", { method: "POST", body: JSON.stringify({ known: [] }) })).status, 400);
  assert.equal((await call("/ack", { method: "POST", body: JSON.stringify({ known: ["1"], profile: "operational" }) })).status, 409);
  assert.equal((await call("/ack", { method: "POST", body: JSON.stringify({ known: ["1"], profile: "medium", queue: {} }) })).status, 200);
  assert.ok(kv.m.has(ACK_KEY) && !kv.m.has(STATE_KEY), "звіт — в окремий ключ (стан пише лише cron)");
  assert.equal((await call("/nope")).status, 404);
  const intake = await (await call("/intake")).json();
  assert.deepEqual(intake.ready, []);
});

test("Worker: без GitHub-ключа — лише спостереження (жодного запуску); 429 від постачальника — пауза 30 хв без завантажень; пошкоджений фід — стан не змінюється", async () => {
  const sim = new WatchSim();
  delete sim.env.GITHUB_TOKEN;
  await sim.start();
  sim.setOffer(fullOffer("2970000009"));
  let rep;
  for (let k = 0; k < 4; k++) rep = await sim.tick();
  assert.equal(sim.calls.dispatch, 0);
  assert.match(rep.blocked, /лише спостереження/);
  assert.equal((await sim.status()).candidates[0].status, "ГОТОВИЙ");
  // 429
  const realFetch = sim.fetchImpl;
  sim.fetchImpl = async (url, init) => (String(url).includes("market-tools") ? new Response("", { status: 429 }) : realFetch(url, init));
  rep = await runWatch(sim.env, sim.now + 5 * MIN, sim.fetchImpl);
  assert.match(rep.skipped, /HTTP 429/);
  const feedBefore = sim.calls.feed;
  sim.fetchImpl = realFetch;
  rep = await runWatch(sim.env, sim.now + 10 * MIN, sim.fetchImpl);
  assert.match(rep.skipped, /ПАУЗА/);
  assert.equal(sim.calls.feed, feedBefore, "під час паузи фід не завантажується");
  rep = await runWatch(sim.env, sim.now + 40 * MIN, sim.fetchImpl);
  assert.ok(!rep.skipped);
  // пошкоджений фід
  const stateBefore = sim.kv.m.get(STATE_KEY);
  sim.fetchImpl = async (url, init) => (String(url).includes("market-tools") ? new Response(sim.xml().slice(0, 5000), { status: 200 }) : realFetch(url, init));
  rep = await runWatch(sim.env, sim.now + 45 * MIN, sim.fetchImpl);
  assert.match(rep.error, /пошкоджений/);
  assert.equal(sim.kv.m.get(STATE_KEY), stateBefore);
});

test("варіант А: сирі дані оновлюються, SEO-поля (назви, описи, запити) — ніколи; «ПЕРЕВІРЕНО <SHA>» за префіксом; рядок до запуску контролю з відредагованою назвою — SEO вважається початим", async () => {
  const xml = feed([fullOffer("2970000001")]);
  const parsed = await parseSupplierText(xml, { maximumChars: 1e7, identityFields: true });
  const full = extractFullOffers(xml, ["2970000001"]).get("2970000001");
  const row0 = candidateRow(parsed.offers.get("2970000001"), full, "2026-10-22T10:00:00.000Z", baseConfig.pricing);
  const first = refreshQueueRow(row0, parsed.offers.get("2970000001"), full, { stamp: "s1" }).row;
  const seo = Object.fromEntries(SEO_FIELDS.map((k) => [k, "SEO " + k]));
  const edited = { ...first, ...seo };
  const changedOffer = { ...parsed.offers.get("2970000001"), nameUa: "Нова назва", sku: "NEW", url: "https://market-tools.com.ua/p2970000001-new.html" };
  const changedFull = { ...full, pictures: ["https://images.prom.ua/1_z.jpg"], params: [{ name: "Ємність", value: "5", unit: "Ач" }], descriptionUa: "інший опис" };
  const r = refreshQueueRow(edited, changedOffer, changedFull, { stamp: "s2" });
  for (const k of SEO_FIELDS) assert.equal(r.row[k], "SEO " + k, k);
  assert.equal(r.row["Назва постачальника UA"], "Нова назва");
  assert.equal(r.row["Артикул постачальника"], "NEW");
  assert.equal(r.row["Фото JSON"], JSON.stringify(["https://images.prom.ua/1_z.jpg"]));
  assert.deepEqual(r.recheck, ["назва UA", "артикул", "URL", "фото", "характеристики", "опис"]);
  assert.ok(r.entries.some((e) => e[3] === "Опис постачальника"));
  // «ПЕРЕВІРЕНО» з префіксом SHA (8+ символів) — прийнято
  const token = r.row["SHA даних постачальника"].replace(/^s1\./, "").replace(/\./g, "").slice(0, 10);
  const v = refreshQueueRow({ ...r.row, "Рішення": "перевірено " + token }, changedOffer, changedFull, { stamp: "s3" });
  assert.equal(v.row["Рішення"], "");
  assert.equal(v.recheck.length, 0);
  // Рядок до запуску контролю: SHA немає, назва вже відрізняється від назви постачальника → SEO почато, базова SHA
  const legacy = { ...row0, "Назва UA": "Відредагована власником", "SHA даних постачальника": "", "Погоджено для SHA": "", "SHA SEO при додаванні": "" };
  const l = refreshQueueRow(legacy, parsed.offers.get("2970000001"), full, { stamp: "s4" });
  assert.match(l.row["SHA SEO при додаванні"], /^УСПАДКОВАНО/);
  assert.equal(l.recheck.length, 0, "перший запуск — лише базова SHA, без хибної тривоги");
  assert.equal(l.row["Погоджено для SHA"], l.row["SHA даних постачальника"]);
  const l2 = refreshQueueRow(l.row, changedOffer, changedFull, { stamp: "s5" });
  assert.ok(l2.recheck.length > 0, "наступна зміна — уже повторна перевірка");
  assert.notEqual(seoHash(edited), seoHash(first));
});

test("черга до 22.10.2026 (без колонок стану): синхронізація додає 4 колонки, дані рядків збережено", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer("2970000001"));
  for (let k = 0; k < 3; k++) await sim.tick();
  // Імітуємо стару чергу: прибрати колонки стану
  const v = sim.book[SHEET.queue];
  const keep = v[0].map((k, i) => (QUEUE_STATE.includes(k) ? -1 : i)).filter((i) => i >= 0);
  sim.book[SHEET.queue] = v.map((r) => keep.map((i) => r[i]));
  const before = readSheet(sim.book[SHEET.queue], SHEET.queue).rows[0];
  const r = await sim.sync();
  assert.equal(r.state, "SYNCED", JSON.stringify(r));
  assert.deepEqual(sim.book[SHEET.queue][0].map(mtText), QUEUE_HEADERS.slice());
  const after = readSheet(sim.book[SHEET.queue], SHEET.queue).rows[0];
  for (const k of ["Offer ID", "Назва UA", "Опис UA", "Фото JSON", "Виявлено"]) assert.equal(mtText(after[k]), mtText(before[k]), k);
  assert.match(after["SHA даних постачальника"], /^s1\./);
  assert.equal(r.stats.queueRaw.migratedColumns, 4);
});

test("intake не довіряє Worker на слово: < 10 хв від останньої зміни, некоректний час, неповні дані або інший відбиток — відмова", () => {
  const r = raw({ id: "6" });
  const fp = watchFingerprint(r);
  const at = (m) => new Date(T0 - m * MIN).toISOString();
  assert.match(verifyReady({ id: "6", fp, lastChange: at(5) }, r, T0).reason, /стабільність не підтверджена/);
  assert.match(verifyReady({ id: "6", fp, lastChange: "вчора" }, r, T0).reason, /стабільність не підтверджена/);
  assert.equal(verifyReady({ id: "6", fp, lastChange: at(10) }, r, T0).ok, true, "рівно 10 хв — досить");
  assert.match(verifyReady({ id: "6", fp: watchFingerprint(raw({ id: "6", sku: "OLD" })), lastChange: at(30) }, r, T0).reason, /змінилися.*артикул/);
  assert.match(verifyReady({ id: "6", fp: watchFingerprint(raw({ id: "6", pictures: [] })), lastChange: at(30) }, raw({ id: "6", pictures: [] }), T0).reason, /бракує фото/);
  assert.match(verifyReady({ id: "6", fp, lastChange: at(30) }, null, T0).reason, /немає у фіді/);
});

test("Worker: fetch фіду сумісний із Cloudflare (redirect «manual», не «error»); переадресація — помилка без розбору", async () => {
  const sim = new WatchSim();
  await sim.start();
  const seen = [];
  const rep = await runWatch(sim.env, sim.now + 5 * MIN, async (url, init) => { seen.push(init?.redirect); return new Response("", { status: 302, headers: { location: "https://example.invalid/" } }); });
  assert.deepEqual(seen, ["manual"]);
  assert.match(rep.error, /переадресація заборонена, HTTP 302/);
});

test("перенаправлення: 301/302/307/308 від фіду — помилка, за Location НЕ переходимо (один запит); сторонній хост фіду — запит не надсилається; GitHub API — redirect «manual», 3xx = невдача", async () => {
  for (const status of [301, 302, 307, 308]) {
    const sim = new WatchSim();
    await sim.start();
    const calls = [];
    const rep = await runWatch(sim.env, sim.now + 5 * MIN, async (url, init) => { calls.push({ url: String(url), redirect: init?.redirect }); return new Response("", { status, headers: { location: "https://attacker.example/steal" } }); });
    assert.equal(calls.length, 1, "лише один запит — без переходу за Location");
    assert.equal(calls[0].redirect, "manual");
    assert.match(rep.error, new RegExp("переадресація заборонена, HTTP " + status));
  }
  const sim = new WatchSim();
  await sim.start();
  let calls = 0;
  for (const bad of ["http://market-tools.com.ua/products_feed.xml?x=1", "https://market-tools.com.ua.evil.example/x", "https://evil.example/?u=https://market-tools.com.ua/"]) {
    const rep = await runWatch({ ...sim.env, SUPPLIER_FEED_URL: bad }, sim.now + 5 * MIN, async () => { calls++; return new Response(""); });
    assert.match(rep.error, /не Market Tools/);
  }
  assert.equal(calls, 0, "на сторонні адреси нічого не надсилається");
  // GitHub: 3xx — запуск не зараховано, повтор пізніше; redirect «manual»
  const g = new WatchSim();
  await g.start();
  g.setOffer(fullOffer("2970000099"));
  const seen = [];
  const real = g.fetchImpl;
  g.fetchImpl = async (url, init) => { if (String(url).startsWith("https://api.github.com/")) { seen.push(init.redirect); return new Response("", { status: 302, headers: { location: "https://attacker.example/" } }); } return real(url, init); };
  let rep;
  for (let k = 0; k < 3; k++) rep = await g.tick();
  assert.deepEqual([...new Set(seen)], ["manual"]);
  assert.match(rep.blocked, /GitHub HTTP 302/);
  assert.equal((await g.status()).dispatch.count, 0, "невдалий запуск не зараховано");
});

test("вимірювальний Worker: лише за ключем, лише адреса Market Tools", async () => {
  const { default: m } = await import("../workers/new-items-watch/src/measure.mjs");
  const crypto = await import("node:crypto");
  const key = "k".repeat(30);
  const env = { KEY_SHA256: crypto.createHash("sha256").update(key).digest("hex") };
  const post = (body, k = key) => m.fetch(new Request("https://x/measure", { method: "POST", headers: { authorization: "Bearer " + k }, body: JSON.stringify(body) }), env);
  assert.equal((await post({ feedUrl: "https://market-tools.com.ua/x", known: ["1"] }, "wrong")).status, 401);
  assert.equal((await post({ feedUrl: "https://evil.example/x", known: ["1"] })).status, 400);
  assert.equal((await m.fetch(new Request("https://x/other"), env)).status, 404);
});
