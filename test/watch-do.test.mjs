/** «Сторож новинок» у SQLite Durable Object: стан у SQLite, alarm, перезапуск, конкурентність, збої, великий фід, паритет відбитків.
 *  Сховище — справжній SQLite (node:sqlite) у двійнику ctx.storage; час — змодельований. Реальний XML — лише локально (MM_REAL_FEED). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { parseSupplierText } from "../src/core/supplier-feed.mjs";
import { extractFullOffers } from "../src/core/sheet-sync.mjs";
import { applyAck, emptyState, rawFromOffer, scanFeed, watchFingerprint } from "../src/core/intake.mjs";
import { WatchCore } from "../workers/new-items-watch/src/watch-core.mjs";
import { SqlStateStore } from "../workers/new-items-watch/src/store.mjs";
import { doContext } from "./helpers/do-sqlite.mjs";
import { WatchSim, fullOffer, MIN, T0 } from "./helpers/watch-sim.mjs";

const FEED = "https://market-tools.com.ua/products_feed.xml?hash_tag=test";

/** DO на фіді xml: база відомих — усі ID, крім кожного n-го (вони стануть кандидатами). */
async function doOnFeed(xml, { every = 400, now = T0 } = {}) {
  const d = doContext();
  const env = { WATCH_KEY: "k".repeat(24), SUPPLIER_FEED_URL: FEED };
  const core = new WatchCore(d.ctx, env, { now: () => now, fetch: async () => new Response(xml, { status: 200 }), log: () => {} });
  const ids = [...xml.matchAll(/<offer id="(\d+)"/g)].map((m) => m[1]);
  const known = ids.filter((_, i) => i % every !== 0);
  const s = core.store.load();
  core.store.save(s, applyAck(s, { known, queue: {} }, now), now);
  const rep = await core.cycle("manual");
  return { d, core, rep, ids, unknown: ids.filter((_, i) => i % every === 0) };
}
/** Відбиток «шляхом GitHub»: операційний розбір + повний offer (як intake). */
async function githubFps(xml, ids) {
  const parsed = await parseSupplierText(xml, { maximumChars: 400_000_000, identityFields: true });
  const full = extractFullOffers(xml, ids);
  return new Map(ids.map((id) => [id, watchFingerprint(rawFromOffer(parsed.offers.get(id), full.get(id)))]));
}

test("великий фід (5300 товарів, з фото й характеристиками): DO знаходить усі нові ID; відбитки DO = старий Worker (scanFeed) = GitHub intake", async () => {
  const s = generateSynthetic({ products: 5300, queue: 0, deferred: 0, newOffers: 0, seed: 21, now: T0 });
  const xml = s.supplierXml();
  const { core, rep, ids, unknown } = await doOnFeed(xml, { every: 250 });
  assert.ok(ids.length >= 5235, `товарів у фіді ${ids.length}`);
  assert.equal(rep.offers, ids.length);
  assert.equal(rep.candidates, unknown.length);
  const cands = core.store.load().candidates;
  assert.deepEqual(Object.keys(cands).sort(), unknown.slice().sort());
  const scan = scanFeed(xml, () => true);
  const gh = await githubFps(xml, unknown);
  for (const id of unknown) {
    assert.equal(cands[id].fp, watchFingerprint(scan.offers.get(id)), "DO = старий Worker");
    assert.equal(cands[id].fp, gh.get(id), "DO = GitHub intake");
  }
});

test("реальний XML (локальна копія; лише якщо задано MM_REAL_FEED): ті самі відбитки, що в старого Worker і GitHub intake", { skip: !process.env.MM_REAL_FEED }, async () => {
  const xml = fs.readFileSync(process.env.MM_REAL_FEED, "utf8");
  const { core, rep, ids, unknown } = await doOnFeed(xml, { every: 100 });
  assert.ok(ids.length > 5000, `товарів ${ids.length} — справжній повний фід`);
  assert.equal(rep.candidates, unknown.length);
  const cands = core.store.load().candidates;
  const scan = scanFeed(xml, () => true);
  const gh = await githubFps(xml, unknown);
  let same = 0;
  for (const id of unknown) if (cands[id].fp === watchFingerprint(scan.offers.get(id)) && cands[id].fp === gh.get(id)) same++;
  assert.equal(same, unknown.length, `збіглося ${same} з ${unknown.length}`);
});

test("перезапуск Durable Object посеред 10-хвилинного вікна: стан не втрачено, перше виявлення збережено, готовий — рівно через 10 хв", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer("2980000001"));
  await sim.tick();
  const firstSeen = sim.now;
  sim.restart(); // DO виселено з пам'яті / перезапущено
  await sim.tick();
  assert.equal(sim.calls.dispatch, 0);
  sim.restart();
  await sim.tick(); // 10 хв від появи
  assert.equal(sim.calls.dispatch, 1);
  assert.equal(sim.queueRow("2980000001")["Виявлено"], new Date(firstSeen).toISOString());
});

test("повторний alarm (at-least-once): другий виклик того самого часу — пропуск, без другого запуску GitHub і без дубля", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer("2980000002"));
  await sim.tick(); await sim.tick();
  sim.now += 5 * MIN;
  const a = await sim.core.alarm();
  const b = await sim.core.alarm(); // дубль alarm
  assert.ok(a.ready >= 1 || a.dispatched !== undefined);
  assert.match(b.skipped, /ПОВТОРНИЙ ALARM/);
  assert.equal(sim.calls.dispatch, 1);
  assert.equal(sim.dctx.alarm, sim.now + 5 * MIN, "наступний alarm поставлено");
});

test("одночасні запуски: поки цикл чекає на фід — другий цикл відхилено; звіт GitHub, що прийшов під час завантаження, не втрачено", async () => {
  const sim = new WatchSim();
  await sim.start();
  let release;
  const gate = new Promise((r) => { release = r; });
  const real = sim.fetchImpl;
  sim.fetchImpl = async (url, init) => { if (String(url).includes("market-tools")) await gate; return real(url, init); };
  sim.now += 5 * MIN;
  const first = sim.core.alarm();
  await new Promise((r) => setTimeout(r, 5));
  // Без захисту другий цикл чекав би на той самий фід — обмежуємо 2 с, щоб тест падав, а не зависав.
  const second = await Promise.race([sim.run(), new Promise((r) => setTimeout(() => r({ skipped: "ТАЙМ-АУТ: другий цикл не відхилено" }), 2000))]);
  assert.match(second.skipped, /ВЖЕ ВИКОНУЄТЬСЯ/);
  const knownBefore = (await sim.status()).knownIds;
  const ack = { known: [...sim.core.store.load().known.ids, "2989999999"], queue: {}, profile: "medium" };
  assert.equal((await sim.core.fetch(sim.req("/ack", "POST", ack))).status, 200);
  release();
  await first;
  assert.equal((await sim.status()).knownIds, knownBefore + 1, "звіт, що прийшов під час циклу, збережено");
});

test("збій сховища посеред запису — транзакцію відкочено (стан як до циклу), оренду знято; наступний цикл успішний; «застрягла» оренда після збою DO спливає за 5 хв", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer("2980000003"));
  await sim.tick();
  const snap = () => JSON.stringify(sim.dctx.db.prepare("SELECT * FROM candidates ORDER BY id").all());
  const before = snap();
  const metaSnap = () => JSON.stringify(sim.dctx.db.prepare("SELECT k, v FROM meta WHERE k IN ('lastRun', 'lastCycleAt', 'savedAt', 'dispatch') ORDER BY k").all());
  const metaBefore = metaSnap();
  sim.setOffer({ sku: "CHANGED" });
  sim.dctx.failOnce("INSERT INTO candidates");
  const rep = await sim.tick();
  assert.match(rep.error, /збій циклу: імітований збій сховища/);
  assert.equal(snap(), before, "часткового запису немає");
  assert.equal(metaSnap(), metaBefore, "службові рядки теж не записано (одна транзакція)");
  assert.equal(sim.core.store.getMeta("lease"), null, "оренду знято");
  const ok = await sim.tick();
  assert.ok(!ok.error);
  assert.match(JSON.stringify(sim.core.store.load().candidates["2980000003"].history), /ЗМІНА: артикул/);
  // DO «впав» посеред циклу: оренда лишилась у сховищі
  sim.core.store.setMeta("lease", { until: sim.now + 5 * MIN + 1, reason: "alarm" });
  sim.restart();
  assert.match((await sim.tick()).skipped, /ВЖЕ ВИКОНУЄТЬСЯ/);
  const after = await sim.tick(); // оренда спливла
  assert.ok(!after.skipped, JSON.stringify(after));
});

test("GitHub недоступний (мережа) — пауза, повтор без дублів; Cloudflare недоступний — alarm доставлено пізніше, один цикл, далі за розкладом", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer("2980000004"));
  const real = sim.fetchImpl;
  let down = true;
  sim.fetchImpl = async (url, init) => { if (String(url).startsWith("https://api.github.com/") && down) throw new Error("connect ETIMEDOUT"); return real(url, init); };
  let rep;
  for (let k = 0; k < 3; k++) rep = await sim.tick();
  assert.match(rep.blocked, /GitHub недоступний/);
  down = false;
  for (let k = 0; k < 4; k++) await sim.tick();
  assert.ok(sim.queueRow("2980000004"));
  assert.equal(sim.rows().filter((r) => r["Offer ID"] === "2980000004").length, 1, "без дублів");
  // Cloudflare «лежав» 40 хв
  sim.workerUp = false;
  for (let k = 0; k < 8; k++) await sim.tick();
  sim.workerUp = true;
  const feeds = sim.calls.feed;
  rep = await sim.tick();
  assert.equal(sim.calls.feed, feeds + 1, "один цикл після відновлення");
  assert.equal(sim.dctx.alarm, sim.now + 5 * MIN);
});

test("DO ніколи не затверджує й не пише в таблицю: лише GitHub intake додає в «Нові товари»; основний каталог і паспорт без змін", async () => {
  const sim = new WatchSim();
  await sim.start();
  const mainBefore = JSON.stringify(sim.book["Основний каталог"]);
  const passBefore = JSON.stringify(sim.book["Паспорт каталогу"]);
  for (let k = 0; k < 4; k++) { sim.setOffer(fullOffer(String(2980000100 + k))); await sim.tick(); }
  for (let k = 0; k < 4; k++) await sim.tick();
  assert.equal(JSON.stringify(sim.book["Основний каталог"]), mainBefore);
  assert.equal(JSON.stringify(sim.book["Паспорт каталогу"]), passBefore);
  assert.ok(sim.rows().every((r) => !r["Рішення"]), "рішень немає");
});

test("сховище: схема SQLite, журнал подій із терміном 30 днів, база відомих ID — одним рядком", () => {
  const d = doContext();
  const store = new SqlStateStore(d.ctx.storage);
  const s0 = store.load();
  const s1 = applyAck(s0, { known: Array.from({ length: 5300 }, (_, i) => String(1500000000 + i)), queue: {} }, T0);
  s1.candidates["9"] = { firstSeen: T0, lastChange: T0, fp: "w", status: "СПОСТЕРЕЖЕННЯ", history: [{ at: T0, what: "ПОЯВА" }] };
  store.save(s0, s1, T0);
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE k = 'known'").get().n, 1);
  assert.equal(store.load().known.ids.length, 5300);
  assert.deepEqual(store.events(5).map((e) => e.what), ["ПОЯВА"]);
  const s2 = store.load();
  store.save(s2, { ...s2, eventsPrunedAt: 0 }, T0 + 31 * 24 * 3600_000); // через 31 день
  assert.equal(store.events(5).length, 0, "старі події видалено");
  const len = d.db.prepare("SELECT length(v) AS n FROM meta WHERE k = 'known'").get().n;
  assert.ok(len < 2_000_000, `рядок бази ID ${len} символів < 2 МБ (ліміт рядка DO)`);
});

test("звіт GitHub під час завантаження фіду оновив відбиток позиції черги — цикл не перезаписує його старим станом (без зайвого оновлення)", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer("2980000005"));
  for (let k = 0; k < 3; k++) await sim.tick();
  assert.ok(sim.queueRow("2980000005"));
  // Постачальник змінив фото; відбиток нових даних — такий, як порахує Worker
  sim.setOffer({ pictures: ["https://images.prom.ua/4877777777_new.jpg"] });
  const { scanFeed, watchFingerprint } = await import("../src/core/intake.mjs");
  const fpNew = watchFingerprint(scanFeed(sim.xml(), (id) => id === "2980000005").offers.get("2980000005"));
  // Під час завантаження фіду приходить звіт GitHub, у якому таблиця вже має нові дані
  let release;
  const gate = new Promise((r) => { release = r; });
  const real = sim.fetchImpl;
  sim.fetchImpl = async (url, init) => { if (String(url).includes("market-tools")) await gate; return real(url, init); };
  sim.now += 5 * MIN;
  const cycle = sim.core.alarm();
  await new Promise((r) => setTimeout(r, 5));
  const s = sim.core.store.load();
  const ack = { known: s.known.ids, queue: { ...Object.fromEntries(Object.entries(s.queue).map(([id, q]) => [id, q.fp])), 2980000005: fpNew }, profile: "medium" };
  await sim.core.fetch(sim.req("/ack", "POST", ack));
  release();
  await cycle;
  sim.fetchImpl = real;
  const q = sim.core.store.load().queue["2980000005"];
  assert.equal(q.fp, fpNew, "відбиток зі звіту збережено");
  assert.equal(q.pendingFp, undefined, "немає «очікуваної зміни» — таблиця вже оновлена");
  const d = sim.calls.dispatch;
  for (let k = 0; k < 3; k++) await sim.tick();
  assert.equal(sim.calls.dispatch, d, "зайвого запуску оновлення немає");
});

test("тестовий режим: вхід за SHA-256 ключа (без секрету); адреса фіду в тілі /run — лише з прапорцем, лише Market Tools, не зберігається; звіт містить фактичні рядки SQLite", async () => {
  const crypto = await import("node:crypto");
  const { route } = await import("../workers/new-items-watch/src/router.mjs");
  const { doNamespace } = await import("./helpers/do-sqlite.mjs");
  const key = "test-key-" + "x".repeat(30);
  const xml = generateSynthetic({ products: 300, queue: 0, deferred: 0, newOffers: 0, seed: 3, now: T0 }).supplierXml();
  const d = doContext();
  const env = { KEY_SHA256: crypto.createHash("sha256").update(key).digest("hex"), TEST_FEED_URL_IN_REQUEST: "yes", minOffers: "50" };
  const seen = [];
  const core = new WatchCore(d.ctx, env, { now: () => T0, fetch: async (u) => { seen.push(String(u)); return new Response(xml, { status: 200 }); }, log: () => {} });
  env.WATCH_DO = doNamespace(() => core);
  const call = (path, body, k = key) => route(new Request("https://w.example" + path, { method: path === "/status" ? "GET" : "POST", headers: { authorization: "Bearer " + k }, body: body ? JSON.stringify(body) : undefined }), env);
  assert.equal((await call("/status", null, "wrong-key-xxxxxxxxxxxxxxxxxx")).status, 401);
  const ids = [...xml.matchAll(/<offer id="(\d+)"/g)].map((m) => m[1]);
  assert.equal((await call("/ack", { known: ids.slice(10), queue: {} })).status, 200);
  let rep = await (await call("/run", { feedUrl: "https://evil.example/x" })).json();
  assert.match(rep.error, /не Market Tools/);
  assert.equal(seen.length, 0);
  rep = await (await call("/run", { feedUrl: FEED })).json();
  assert.equal(rep.offers, ids.length);
  assert.equal(rep.candidates, 10);
  assert.ok(rep.sql.rowsRead > 0 && rep.sql.rowsWritten > 0, JSON.stringify(rep.sql));
  assert.ok(!JSON.stringify(d.db.prepare("SELECT * FROM meta").all()).includes("hash_tag"), "адреса фіду не збережена");
  // Без прапорця адреса з тіла ігнорується
  delete env.TEST_FEED_URL_IN_REQUEST;
  rep = await (await call("/run", { feedUrl: FEED })).json();
  assert.match(rep.skipped, /немає адреси фіду/);
});
