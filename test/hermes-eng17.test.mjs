/** ENG-17: регресії до попереднього ревю Hermes (preliminary-20261030T012451) — ENG15-P1 (обслуговувана версія), ENG15-P2 (відкат
 *  під орендою W2), ENG15-P3 (доказ публікації лише з перевіреної обслуговуваної версії), ENG15-P4 (E6 в операційному runUpdate).
 *  Перевіряється ФАКТИЧНА відповідь Worker (GET / HEAD, .xml / .xml.gz), а не лише звіт. Двійник стану CC — форма controlsFromState. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate, guardedRollback, secureServed } from "../src/pipeline/update.mjs";
import { manifestKey, readActiveXml, readServedVersions, servedChain } from "../src/publish/publisher.mjs";
import { offersById } from "../src/core/yml.mjs";
import { productionConfig, activeXmlsOf } from "../src/pipeline/production.mjs";
import { publicationFrom } from "../src/pipeline/controls-adapter.mjs";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import { MemoryStore } from "../src/pipeline/safe-write/store.mjs";
import worker from "../worker/src/index.js";
import { r2BindingFrom } from "./helpers/r2-fake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };

const T0 = Date.parse("2026-10-21T06:00:00.000Z");
const KEY = "k".repeat(32);
const NONE = { blocked: false, kind: "NONE" };
/** Двійник адаптера CC; state можна підмінити (outage / зміна стану під час операції). */
function cc({ removed = [], held = [], blocked = false, tag = "" } = {}) {
  const st = () => ({ held: new Set([...held, ...removed]), removed: new Set(removed), tombstoned: new Map(removed.map((id) => [id, { stage: "REGISTERED" }])), blocked, reasons: blocked ? ["точка недійсна"] : [], fingerprint: "fp:" + JSON.stringify([removed, held, blocked, tag]), gate: { check: () => NONE } });
  const a = { outage: false, state: async () => { if (a.outage) throw new Error("test read outage"); return st(); }, verify: async (fp) => ({ ok: !a.outage && fp === st().fingerprint, reasons: [] }) };
  return a;
}
async function world({ gzip = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-e17-"));
  const s = generateSynthetic({ products: 40, queue: 2, deferred: 2, newOffers: 0, seed: 7, now: T0 });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  const supplierFile = path.join(dir, "supplier.xml");
  await fsp.writeFile(supplierFile, s.supplierXml());
  const root = path.join(dir, "store");
  const store = new LocalObjectStore(root);
  await store.putJson("approved/main.json", s.manifestMain);
  const config = productionConfig(structuredClone(baseConfig));
  config.supplier.minimumOffers = 10;
  if (gzip) for (const f of config.feeds) f.gzip = true;
  const w2 = new MemoryStore();
  const coordinator = createCommitter({ store: w2 });
  const ctx = (controls, now = T0) => ({ store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(supplierFile), now: () => now, tmpDir: dir, coordinator, ...(controls ? { controls } : {}) });
  const env = { FEEDS_BUCKET: r2BindingFrom(store), FEED_ACCESS_KEY: KEY, FEEDS: "main" };
  const get = (p, method = "GET") => worker.fetch(new Request("https://feeds.test" + p + "?key=" + KEY, { method }), env);
  const served = async (ext = ".xml") => { const r = await get("/feeds/main" + ext); if (r.status !== 200) return { status: r.status, xml: null }; const buf = Buffer.from(await r.arrayBuffer()); const zlib = await import("node:zlib"); return { status: 200, version: r.headers.get("x-feed-version"), xml: (ext.endsWith(".gz") ? zlib.gunzipSync(buf) : buf).toString("utf8") }; };
  return { dir, root, s, store, config, ctx, supplierFile, get, served, coordinator, w2 };
}
const bump = (xml) => xml.replace(/(<price>)([\d.]+)(<\/price>)/, (_, a, p, b) => a + String(Number(p) + 1) + b);

// ---------- ENG15-P1 ----------
test("P1a: видалення підтверджено, потім CC не читається + збій постачальника — Worker НЕ віддає 200 з видаленим (GET / HEAD)", async () => {
  const x = await world();
  const ok = cc();
  assert.equal((await runUpdate(x.ctx(ok))).feeds[0].state, "PUBLISHED");
  const del = [...offersById((await readActiveXml(x.store, "main")).xml).keys()][2];
  const after = cc({ removed: [del] }); after.outage = true; // видалення в CC є, але читання стану недоступне
  await fsp.writeFile(x.supplierFile, "<broken>");
  const r = await runUpdate(x.ctx(after, T0 + 3600_000));
  assert.equal(r.feeds[0].state, "BLOCKED_CC");
  assert.equal(r.feeds[0].activeSafety, "UNVERIFIED");
  assert.equal((await x.get("/feeds/main.xml")).status, 503);
  assert.equal((await x.get("/feeds/main.xml", "HEAD")).status, 503);
  // Відновлення: CC знову читається, постачальник справний — нова безпечна версія, обслуговування відновлено.
  await fsp.writeFile(x.supplierFile, x.s.supplierXml());
  const r2 = await runUpdate(x.ctx(cc({ removed: [del] }), T0 + 7200_000));
  assert.equal(r2.feeds[0].state, "PUBLISHED");
  const s2 = await x.served();
  assert.equal(s2.status, 200);
  assert.equal(offersById(s2.xml).has(del), false);
});
test("P1a: CC blocked у звичайному запуску (постачальник справний) — нового фіду немає, чинна версія не обслуговується", async () => {
  const x = await world();
  assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
  const r = await runUpdate(x.ctx(cc({ blocked: true }), T0 + 3600_000));
  assert.equal(r.sync.state, "BLOCKED_CC", "операційний стан не оновлюється без достовірного CC");
  assert.equal(r.feeds[0].state, "BLOCKED_CC");
  assert.equal((await x.get("/feeds/main.xml")).status, 503);
  // CC знову достовірний, той самий стан і ті самі дані → REUSE чинної версії після перевірки: позначку зняття прибрано, Worker — 200.
  const r2 = await runUpdate(x.ctx(cc(), T0 + 7200_000));
  assert.equal(r2.feeds[0].state, "REUSED");
  assert.equal((await x.store.getJson(manifestKey("main"))).withdrawn, undefined);
  assert.equal((await x.get("/feeds/main.xml")).status, 200);
});
for (const gzip of [false, true]) {
  test(`P1b${gzip ? " (.xml.gz)" : ""}: дві безпечні версії → видалення → активний об'єкт втрачено → збій постачальника — запасна з видаленим НЕ обслуговується; звіт не VERIFIED`, async () => {
    const x = await world({ gzip });
    assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
    const del = [...offersById((await readActiveXml(x.store, "main")).xml).keys()][2];
    await fsp.writeFile(x.supplierFile, bump(x.s.supplierXml()));
    assert.equal((await runUpdate(x.ctx(cc({ tag: "b" }), T0 + 60_000))).feeds[0].state, "PUBLISHED");
    const m = await x.store.getJson(manifestKey("main"));
    assert.equal(m.previousFallbackSafe, true);
    await x.store.delete(m.active.key);
    await fsp.writeFile(x.supplierFile, "<broken>");
    const r = await runUpdate(x.ctx(cc({ removed: [del] }), T0 + 120_000));
    assert.notEqual(r.feeds[0].activeSafety, "VERIFIED");
    assert.equal(r.feeds[0].activeSafety, "NOT_SERVED");
    assert.equal((await x.store.getJson(manifestKey("main"))).previousFallbackSafe, false, "запасна знецінена");
    for (const ext of gzip ? [".xml.gz"] : [".xml"]) {
      const s = await x.served(ext);
      assert.ok(s.status !== 200 || !offersById(s.xml).has(del), `${ext}: Worker не віддає видалений товар`);
      assert.equal(s.status, 503);
    }
  });
}
test("P1c: вміст активної версії пошкоджено (метадані ті самі — Worker її віддав би) — знято з обслуговування", async () => {
  const x = await world();
  assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
  const m = await x.store.getJson(manifestKey("main"));
  const file = path.join(x.root, ...m.active.key.split("/"));
  const buf = await fsp.readFile(file);
  const i = buf.indexOf(Buffer.from("<price>")) + 7; buf[i] = buf[i] === 0x31 ? 0x32 : 0x31; // та сама довжина, інший вміст
  await fsp.writeFile(file, buf);
  // ENG-27 (Hermes INT N2): Worker звіряє SHA-256 самих байтів із маніфестом — пошкоджену версію не віддає вже до наступного запуску
  // (раніше тут була передумова «Worker перевіряє лише метадані» → 200).
  assert.equal((await x.get("/feeds/main.xml")).status, 503, "Worker не віддає байти, що не збігаються з відбитком маніфесту");
  assert.equal((await x.get("/feeds/main.xml", "HEAD")).status, 503, "і HEAD");
  await fsp.writeFile(x.supplierFile, "<broken>");
  const r = await runUpdate(x.ctx(cc(), T0 + 3600_000));
  assert.equal(r.feeds[0].activeSafety, "UNSAFE");
  assert.equal((await x.get("/feeds/main.xml")).status, 503);
});

// ---------- ENG15-P2 ----------
test("P2: відкат — без координатора W2 / оренда зайнята — відмова, маніфест не змінено", async () => {
  const x = await world();
  await runUpdate(x.ctx(cc()));
  await fsp.writeFile(x.supplierFile, bump(x.s.supplierXml()));
  await runUpdate(x.ctx(cc({ tag: "b" }), T0 + 60_000));
  const m0 = await x.store.getJson(manifestKey("main"));
  await assert.rejects(guardedRollback({ store: x.store, feed: "main", controls: cc() }), /без координатора W2/);
  const held = await x.coordinator.acquire("catalog-controls"); // інший записувач (запуск CC) тримає оренду
  await assert.rejects(guardedRollback({ store: x.store, feed: "main", controls: cc(), coordinator: x.coordinator }), /оренду W2 не отримано/);
  await held.release();
  assert.deepEqual(await x.store.getJson(manifestKey("main")), m0);
});
test("P2: оренду втрачено під час перемикання, а CC тим часом зафіксував видалення — обслуговувана версія захищена (Worker не віддає видалений)", async () => {
  const x = await world();
  await runUpdate(x.ctx(cc()));
  const del = [...offersById((await readActiveXml(x.store, "main")).xml).keys()][2];
  await fsp.writeFile(x.supplierFile, bump(x.s.supplierXml()));
  await runUpdate(x.ctx(cc({ tag: "b" }), T0 + 60_000));
  // Координатор, чия оренда «спливає» саме в момент перемикання маніфесту; тоді ж CC фіксує видалення.
  const live = cc();
  let lost = false;
  // ENG-20 (B): оренда має token — епоха fencing; більший за епохи попередніх публікацій цього світу (двійник перевіряє шлях компенсації).
  const coordinator = { acquire: async () => ({ token: 1_000_000, leaseId: "f".repeat(32), scope: "publisher", assertCurrent: async () => { if (lost) throw new Error("оренду перехоплено"); }, release: async () => {} }) };
  const raw = x.store.putJson.bind(x.store);
  x.store.putJson = async (k, v, o) => { const r = await raw(k, v, o); if (k === manifestKey("main") && v?.rolledBackAt && !lost) { lost = true; Object.assign(live, cc({ removed: [del] }), { outage: false }); } return r; };
  await assert.rejects(guardedRollback({ store: x.store, feed: "main", controls: live, coordinator }), /оренду W2 втрачено/);
  x.store.putJson = raw;
  const s = await x.served();
  assert.ok(s.status !== 200 || !offersById(s.xml).has(del), "Worker не віддає видалений товар після втрати оренди");
});

// ---------- ENG15-P3 ----------
test("P3: пошкоджений / знятий / відсутній активний об'єкт — publication unknown (не DONE); валідний — present / absent; запасна — за фактом обслуговування", async () => {
  const x = await world();
  await runUpdate(x.ctx(cc()));
  const ids = [...offersById((await readActiveXml(x.store, "main")).xml).keys()];
  const pub = async () => Object.fromEntries([...publicationFrom(await activeXmlsOf(x.store, x.config)(), [ids[0], "999"])].map(([k, v]) => [k, v.feed]));
  assert.deepEqual(await pub(), { [ids[0]]: "present", 999: "absent" });
  const m = await x.store.getJson(manifestKey("main"));
  // ENG-27 (Hermes INT N2): версії — write-once; перезапис через API (як у пробі Hermes ENG-15) тепер відхиляється, вміст не змінено.
  await assert.rejects(x.store.put(m.active.key, "<broken>", { contentType: "application/xml" }), { code: "OBJECT_IMMUTABLE" });
  assert.deepEqual(await pub(), { [ids[0]]: "present", 999: "absent" }, "відхилений перезапис нічого не змінив");
  // Підміна в обхід write-once (видалити й записати під тим самим ключем) — байти не збігаються з маніфестом.
  await x.store.delete(m.active.key);
  await x.store.put(m.active.key, "<broken>", { contentType: "application/xml" });
  assert.deepEqual(await pub(), { [ids[0]]: "unknown", 999: "unknown" });
  assert.equal((await x.get("/feeds/main.xml")).status, 503, "Worker підмінені байти не віддає");
  assert.equal(await readServedVersions(x.store, "main"), null);
  // Знятий з обслуговування — теж не доказ.
  const y = await world();
  await runUpdate(y.ctx(cc()));
  await y.store.putJson(manifestKey("main"), { ...(await y.store.getJson(manifestKey("main"))), withdrawn: { at: "t", reason: "тест" } });
  assert.equal(await readServedVersions(y.store, "main"), null);
});

// ---------- ENG15-P4 ----------
test("P4: видалений REGISTERED (рядок ще в каталозі) — операційний runUpdate не оновлює його ціну; інші оновлюються; YML без offer", async () => {
  const x = await world();
  assert.equal((await runUpdate(x.ctx(cc()))).sync.state, "OK");
  const op0 = (await x.store.getJson("state/operational.json")).rows;
  const [del, other] = Object.keys(op0).slice(3, 5);
  const supplierIdOf = (id) => String(x.s.sheets["Основний каталог"].find((r) => String(r[0]) === id)[1]);
  let xml = x.s.supplierXml();
  for (const id of [del, other]) xml = xml.replace(new RegExp(`(<offer id="${supplierIdOf(id)}"[\\s\\S]*?<price>)([^<]+)(</price>)`), (_, a, p, b) => a + String(Number(p) + 17) + b);
  await fsp.writeFile(x.supplierFile, xml);
  const r = await runUpdate(x.ctx(cc({ removed: [del] }), T0 + 3600_000));
  assert.equal(r.sync.state, "OK");
  assert.equal(r.sync.removedFrozen, 1);
  const op1 = (await x.store.getJson("state/operational.json")).rows;
  assert.deepEqual(op1[del], op0[del], "видалений — операційні значення без змін");
  assert.notDeepEqual(op1[other], op0[other], "інший товар оновлено");
  assert.equal(offersById((await readActiveXml(x.store, "main")).xml).has(del), false);
});
test("P4: стан CC недостовірний у робочому режимі — операційний стан не записується (fail-closed)", async () => {
  const x = await world();
  await runUpdate(x.ctx(cc()));
  const op0 = await x.store.getJson("state/operational.json");
  await fsp.writeFile(x.supplierFile, bump(x.s.supplierXml()));
  const r = await runUpdate(x.ctx(cc({ blocked: true }), T0 + 3600_000));
  assert.equal(r.sync.state, "BLOCKED_CC");
  const noFence = ({ fence: _f, ...rest } = {}) => rest; // ENG-22 (F03): штамп fencing змінює кожне отримання оренди — не дані
  assert.deepEqual(noFence(await x.store.getJson("state/operational.json")), noFence(op0));
});
test("Публікація під орендою W2: без координатора в робочому режимі — BLOCKED_W2 (жодного перемикання); оренда зайнята — теж", async () => {
  const x = await world();
  const r = await runUpdate({ ...x.ctx(cc()), coordinator: undefined });
  assert.equal(r.feeds[0].state, "BLOCKED_W2");
  assert.equal(await x.store.getJson(manifestKey("main")), null);
  const busy = await x.coordinator.acquire("catalog-controls");
  assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "BLOCKED_W2");
  await busy.release();
  assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
  assert.ok(fs && servedChain && secureServed);
});

test("P1a (захист у глибину): обов'язковий CC недостовірний у циклі фідів (явний старий режим синхронізації) — чинна версія теж знімається з обслуговування", async () => {
  const x = await world();
  assert.equal((await runUpdate(x.ctx(cc()))).feeds[0].state, "PUBLISHED");
  x.config.ownerPriority = { enabled: false }; // лише бібліотечний регресійний режим; CC лишається обов'язковим (controls.required)
  const r = await runUpdate(x.ctx(cc({ blocked: true }), T0 + 3600_000));
  assert.equal(r.sync.state, "OK", "старий режим: операційна синхронізація пройшла, блокування — на етапі фідів");
  assert.equal(r.feeds[0].state, "BLOCKED_CC");
  assert.equal(r.feeds[0].activeSafety, "UNVERIFIED");
  assert.equal((await x.get("/feeds/main.xml")).status, 503);
});
