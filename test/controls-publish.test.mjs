/** S6 / S7 (ENG-10, Hermes CC4-S6): стан Catalog Controls у справжньому runUpdate → buildYml → publishFeed.
 *  Знятий / виключений товар — лише available="false" (пріоритет над будь-яким залишком); blocked — ні нового фіду, ні REUSE;
 *  зміна стану між проєкцією й перемиканням — не перемикати; REUSE лише за того самого відбитка; збій нового фіду — аварійний
 *  патч активної версії; відкат на версію з доступним знятим товаром — заборонено; вада одного рядка — ізоляція лише його;
 *  видалений (архів) до підтвердження Prom — останній offer, недоступний. Адаптер CC — двійник форми controlsState. */
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { FileSupplierSource, NdjsonCatalogSource, writeCatalogSnapshot } from "../src/pipeline/sources.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { runUpdate } from "../src/pipeline/update.mjs";
import { manifestKey, readActiveXml, rollbackFeed } from "../src/publish/publisher.mjs";
import { offersById, controlsViolations } from "../src/core/yml.mjs";
import { perturb } from "../src/verify/supplier-shadow.mjs";
// Старий режим (явно): регресія прийнятої механіки — див. helpers/legacy-config.mjs (рішення власника 29–30.10).
import baseConfig from "./helpers/legacy-config.mjs";

const T0 = Date.parse("2026-10-21T06:00:00.000Z");
const MAIN = "Основний каталог";

async function setup({ ownerPriority = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-cc-pub-"));
  const s = generateSynthetic({ products: 60, queue: 4, deferred: 2, newOffers: 0, seed: 7, now: T0 });
  await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets: s.sheets, groups: s.groups });
  const supplierFile = path.join(dir, "supplier.xml");
  await fsp.writeFile(supplierFile, s.supplierXml());
  const store = new LocalObjectStore(path.join(dir, "store"));
  await store.putJson("approved/main.json", s.manifestMain);
  const config = structuredClone(baseConfig);
  config.supplier.minimumOffers = 10;
  if (ownerPriority) config.ownerPriority = { enabled: true };
  // Режим пріоритету власника вимагає CC (R5): без явного стану — двійник «CC достовірний, нічого не знято».
  const ctx = (controls, now = T0) => { const c = controls ?? (ownerPriority ? cc() : null); return { store, config, catalog: new NdjsonCatalogSource(path.join(dir, "catalog")), supplier: new FileSupplierSource(supplierFile), now: () => now, tmpDir: dir, ...(c ? { controls: c } : {}) }; };
  const rewrite = async (fn) => { const sheets = structuredClone(s.sheets); fn(sheets); await writeCatalogSnapshot(path.join(dir, "catalog"), { sheets, groups: s.groups }); };
  return { dir, s, store, config, ctx, rewrite };
}
/** Двійник адаптера CC: форма controlsState (held ⊇ tombstoned; removed = tombstoned.keys()).
 *  verifyOk: true / false або число — скільки перших verify успішні (ENG-18: перший verify — операційний комміт, далі — публікація). */
const cc = ({ held = [], removed = [], confirmed = [], blocked = false, verifyOk = true } = {}) => {
  const fingerprint = "fp:" + JSON.stringify([held, removed, confirmed, blocked]);
  let verifies = 0;
  const okNow = () => (typeof verifyOk === "number" ? verifies++ < verifyOk : verifyOk);
  return { state: async () => ({ held: new Set([...held, ...removed]), removed: new Set(removed), confirmedRemoved: confirmed, blocked, reasons: blocked ? ["журнал «Історія керування» пошкоджено"] : [], fingerprint }),
    verify: async (fp) => (okNow() && fp === fingerprint ? { ok: true, reasons: [] } : { ok: false, reasons: ["відбиток змінився"] }) };
};
const avail = (xml, id) => /available="(true|false)"/.exec((offersById(xml).get(id) || "").slice(0, 200))?.[1] ?? null;
const activeXml = async (store) => (await readActiveXml(store, "main")).xml;
const firstAvailable = (xml, n = 1) => [...offersById(xml)].filter(([, o]) => /available="true"/.test(o.slice(0, 200))).slice(0, n).map(([id]) => id);

test("S6 / H11: видалений (tombstone) — жодного offer; знятий — available=\"false\"; решта — без змін", async () => {
  const { store, ctx } = await setup();
  assert.equal((await runUpdate(ctx())).feeds[0].state, "PUBLISHED");
  const base = await activeXml(store);
  const [ex, hold, other] = firstAvailable(base, 3);
  const r = await runUpdate(ctx(cc({ held: [hold], removed: [ex] })));
  assert.equal(r.feeds[0].state, "PUBLISHED", JSON.stringify(r.feeds[0]));
  const xml = await activeXml(store);
  assert.equal(offersById(xml).has(ex), false, "видалений — жодного <offer> (рішення власника 29.10)");
  assert.equal(avail(xml, hold), "false");
  assert.ok(!/<oldprice>|<quantity_in_stock>/.test(offersById(xml).get(hold)), "без знижки й кількості");
  assert.equal(offersById(xml).get(other), offersById(base).get(other), "інший товар байт-у-байт");
  assert.equal(r.feeds[0].held, 1);
  assert.equal(r.feeds[0].removedExcluded, 1);
  assert.ok(r.feeds[0].ccFingerprint);
});

test("S7: знятий товар із СПРАВЖНІМ власним залишком (зник у постачальника, own-stock) і знятий із «+» постачальника — available=\"false\"", async () => {
  const { store, ctx, s, dir } = await setup();
  await runUpdate(ctx());
  const [own, sup] = firstAvailable(await activeXml(store), 2);
  // Справжній власний залишок: товар зник із фіду, у сховищі — підтверджений залишок (d1.mjs: applyAvailabilityPolicy → «+», ВЛАСНИЙ_ЗАЛИШОК).
  await fsp.writeFile(path.join(dir, "supplier.xml"), perturb.drop(s.supplierXml(), [own]));
  await store.putJson("state/own-stock.json", { items: { [own]: { qty: 3, confirmedAt: new Date(T0).toISOString() } } });
  const before = await runUpdate(ctx(null, T0 + 60_000));
  assert.equal(avail(await activeXml(store), own), "true", "без зняття власний залишок публікується доступним (передумова)");
  assert.equal(before.feeds[0].ownStock, 1);
  const r = await runUpdate(ctx(cc({ held: [own, sup] }), T0 + 120_000));
  assert.equal(r.feeds[0].state, "PUBLISHED", JSON.stringify(r.feeds[0]));
  const xml = await activeXml(store);
  assert.equal(avail(xml, own), "false", "зняття сильніше за власний залишок");
  assert.equal(avail(xml, sup), "false", "зняття сильніше за «+» постачальника");
  assert.ok(!/<quantity_in_stock>/.test(offersById(xml).get(own)));
});

test("CC blocked → BLOCKED_CC: нового фіду немає, REUSED як успіху немає, маніфест не змінено", async () => {
  const { store, ctx } = await setup();
  await runUpdate(ctx());
  const m0 = await store.getJson(manifestKey("main"));
  const r = await runUpdate(ctx(cc({ blocked: true })));
  assert.equal(r.feeds[0].state, "BLOCKED_CC");
  // ENG-17 (Hermes ENG15-P1a / I17): чинна версія та сама, але безпечність неможливо довести → знято з обслуговування (Worker 503).
  const m1 = await store.getJson(manifestKey("main"));
  assert.equal(m1.active.key, m0.active.key);
  assert.ok(m1.withdrawn);
  assert.equal(r.controls.blocked, true);
  // Адаптер не підключено, а config.controls.required — теж blocked (fail-closed).
  const { ctx: ctx2, config } = await setup();
  config.controls = { required: true };
  assert.equal((await runUpdate(ctx2())).feeds[0].state, "BLOCKED_CC");
});

test("Зміна стану CC між проєкцією й перемиканням маніфесту — перемикання не відбувається", async () => {
  const { store, ctx } = await setup();
  await runUpdate(ctx());
  const m0 = await store.getJson(manifestKey("main"));
  const [id] = firstAvailable(await activeXml(store));
  // ENG-18 (Hermes ENG17-P4 late delete): стан змінився вже до комміту синхронізації — операційний стан не записано (перший рубіж).
  const w0 = await setup();
  await runUpdate(w0.ctx());
  const op0 = await w0.store.getJson("state/operational.json"), k0 = (await w0.store.getJson(manifestKey("main"))).active.key;
  const r0 = await runUpdate(w0.ctx(cc({ held: [id], verifyOk: false })));
  assert.equal(r0.sync.state, "ERROR");
  assert.match(r0.sync.error, /змінився під час синхронізації/);
  assert.deepEqual(await w0.store.getJson("state/operational.json"), op0);
  assert.equal(r0.feeds[0].state, "WITHDRAWN");
  assert.equal(r0.feeds[0].activeSafety, "UNSAFE");
  assert.equal((await w0.store.getJson(manifestKey("main"))).active.key, k0, "не перемкнуто");
  // Стан змінився ПІСЛЯ комміту синхронізації, між проєкцією й перемиканням маніфесту (другий рубіж — як в ENG-17).
  const r = await runUpdate(ctx(cc({ held: [id], verifyOk: 1 })));
  // Hermes E7: новий фід не перемкнуто; аварійний патч теж неможливий (стан CC нестабільний) → активна версія, де знятий товар
  // доступний, знімається з обслуговування (WITHDRAWN → Worker 503), а не лишається «успішною».
  assert.equal(r.sync.state, "OK");
  assert.equal(r.feeds[0].state, "WITHDRAWN");
  assert.match(r.feeds[0].error, /змінився між проєкцією й публікацією/);
  assert.equal(r.feeds[0].activeSafety, "UNSAFE");
  const m1 = await store.getJson(manifestKey("main"));
  assert.equal(m1.active.key, m0.active.key, "активна версія та сама (не перемкнуто)");
  assert.ok(m1.withdrawn, "знято з обслуговування");
});

test("REUSE лише за того самого відбитка стану CC", async () => {
  const { store, ctx } = await setup();
  await runUpdate(ctx(cc()));
  assert.equal((await runUpdate(ctx(cc()))).feeds[0].state, "REUSED");
  const [id] = firstAvailable(await activeXml(store));
  assert.equal((await runUpdate(ctx(cc({ held: [id] })))).feeds[0].state, "PUBLISHED", "новий відбиток — нова версія");
  assert.equal((await store.getJson(manifestKey("main"))).active.ccFingerprint.startsWith("fp:"), true);
});

test("Збій нового фіду — аварійний патч активної версії: знятий товар недоступний, решта байт-у-байт", async () => {
  const { store, ctx, config } = await setup();
  await runUpdate(ctx());
  const base = await activeXml(store);
  const [id] = firstAvailable(base);
  config.feeds = config.feeds.map((f) => ({ ...f, maximumBytes: 1000 })); // новий фід не формується (ліміт байтів)
  const r = await runUpdate(ctx(cc({ held: [id] })));
  assert.equal(r.feeds[0].state, "ERROR");
  assert.deepEqual(r.feeds[0].holdPatch, { needed: true, published: true, patched: [id], removed: [], held: [id] });
  const xml = await activeXml(store);
  assert.equal(avail(xml, id), "false");
  const b = offersById(base), a = offersById(xml);
  assert.equal(a.size, b.size);
  for (const [k, v] of b) if (k !== id) assert.equal(a.get(k), v);
});

test("Відкат на версію, де знятий товар доступний або видалений товар присутній, — заборонено", async () => {
  const { store, ctx } = await setup();
  await runUpdate(ctx());
  const [id, del] = firstAvailable(await activeXml(store), 2);
  await runUpdate(ctx(cc({ held: [id], removed: [del] })));
  await assert.rejects(rollbackFeed(store, "main", { violations: (xml) => controlsViolations(xml, { held: new Set([id]) }) }), /Відкат заборонено/);
  await assert.rejects(rollbackFeed(store, "main", { violations: (xml) => controlsViolations(xml, { removed: new Set([del]) }) }), /видалений товар у фіді/);
  const ok = await rollbackFeed(store, "main", { violations: (xml) => controlsViolations(xml, { held: new Set(["0000000000"]) }) });
  assert.ok(ok.active);
});

test("Збій нового фіду — аварійний патч прибирає offer видаленого товару зі старої активної версії (fallback не повертає)", async () => {
  const { store, ctx, config } = await setup();
  await runUpdate(ctx());
  const base = await activeXml(store);
  const [del] = firstAvailable(base);
  config.feeds = config.feeds.map((f) => ({ ...f, maximumBytes: 1000 }));
  const r = await runUpdate(ctx(cc({ removed: [del] })));
  assert.equal(r.feeds[0].state, "ERROR");
  assert.deepEqual(r.feeds[0].holdPatch.removed, [del]);
  const xml = await activeXml(store);
  assert.equal(offersById(xml).has(del), false);
  assert.equal(offersById(xml).size, offersById(base).size - 1);
});

test("Видалений (архів, рядка вже немає) — у новому фіді жодного offer; останній опублікований offer не повертається", async () => {
  const { store, ctx, rewrite } = await setup({ ownerPriority: true });
  await runUpdate(ctx());
  const [id] = firstAvailable(await activeXml(store));
  await rewrite((sh) => { sh[MAIN] = sh[MAIN].filter((r) => String(r[0]) !== id); }); // перенесено в «Видалені товари»
  const r1 = await runUpdate(ctx(cc({ removed: [id] }), T0 + 1000));
  assert.equal(r1.feeds[0].state, "PUBLISHED", JSON.stringify(r1.feeds[0]));
  assert.equal(offersById(await activeXml(store)).has(id), false);
});

test("Пріоритет власника: вада одного рядка ізолює лише його; ручна правка контенту (печатка) не зупиняє фід", async () => {
  const { store, ctx, rewrite } = await setup({ ownerPriority: true });
  await runUpdate(ctx());
  const base = await activeXml(store);
  const [bad, edited, other] = firstAvailable(base, 3);
  await rewrite((sh) => { const v = sh[MAIN], h = v[0];
    v.find((x) => String(x[0]) === bad)[h.indexOf("Назва UA")] = "";                    // вада
    v.find((x) => String(x[0]) === edited)[h.indexOf("Опис UA")] = "<p>опис власника</p>"; }); // ручна правка (печатка ≠)
  const r = await runUpdate(ctx(cc(), T0 + 1000));
  assert.equal(r.feeds[0].state, "PUBLISHED", JSON.stringify(r.feeds[0]));
  assert.equal(r.feeds[0].rowIssues, 1);
  assert.ok(r.feeds[0].audit.sealMismatch >= 2);
  const xml = await activeXml(store);
  assert.equal(avail(xml, bad), "false", "вадний — останній опублікований, недоступний");
  assert.match(offersById(xml).get(edited), /опис власника/, "правка власника опублікована");
  assert.equal(offersById(xml).get(other), offersById(base).get(other));
  const rep = await store.getJson("reports/rows/main-latest.json");
  assert.equal(rep.issues[0].offerId, bad);
});
