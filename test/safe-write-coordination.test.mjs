/** E3 (ENG-01 K2): координація записувачів — одна оренда на таблицю, fencing-токен, журнал операцій, з'ясування після збою.
 *  Сценарії: два паралельні записувачі; втрата оренди; запізнілий запит старої оренди (Google застосовує пізніше); запізнілий CAS
 *  контрольної точки (Hermes H04); повтор після аварійного завершення; контракти Catalog Controls cc-committer-v1 / cc-store-v1. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySheets } from "../src/pipeline/sheets-writer.mjs";
import { OUTCOME, outcomeOf } from "../src/pipeline/write-outcome.mjs";
import crypto from "node:crypto";
import { MemoryStore, FileStore } from "../src/pipeline/safe-write/store.mjs";
import { jcsHash } from "../src/pipeline/safe-write/jcs.mjs";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import { OpJournal } from "../src/pipeline/safe-write/journal.mjs";
import { WriteGateway, CC_CHECKPOINT_KEY, SESSION } from "../src/pipeline/safe-write/gateway.mjs";
import { OP } from "../src/pipeline/safe-write/keyed-update.mjs";

const T = "Основний каталог";
const H = ["Offer ID", "ID постачальника", "Назва UA", "Ціна", "Фото JSON"];
const book = () => ({ [T]: [H.slice(), ["101", "s101", "SEO 101", "100", "[]"], ["102", "s102", "SEO 102", "200", "[]"], ["103", "s103", "SEO 103", "300", "[]"]] });
const cell = (sh, key, col) => sh.book[T].find((r) => r[0] === key)?.[H.indexOf(col)];
const clock = (t0 = 1_000_000) => { const c = { t: t0, now: () => c.t }; return c; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "safe-write-"));
/** ENG-23: квиток beforeCommit у тестах сховища видає сам тест — він ПЕРШИМ забирає стіл квитків (замість протоколу A). */
const deskOf = (store, now) => { const d = store.claimDesk({ now }); d.bind("test-feeds"); return d; };
const ticketFor = (desk, lease, value, expectedVersion, phase = "intents") => {
  const t = { v: 1, key: CC_CHECKPOINT_KEY, nextHash: jcsHash(value), expectedVersion, leaseToken: lease.token, leaseId: lease.leaseId, phase, nonce: crypto.randomBytes(16).toString("hex"), notAfter: lease.expiresAt };
  desk.registerTicket(t);
  return t;
};
const fenceOf = (lease, ticket) => ({ leaseKey: lease.leaseKey, token: lease.token, leaseId: lease.leaseId, scope: lease.scope, ...(ticket ? { ticket } : {}) });

test("E3: сховище cc-store-v1 — CAS, CONFLICT, копії значень (пам'ять і файл)", async () => {
  for (const st of [new MemoryStore(), new FileStore(tmp())]) {
    assert.deepEqual(await st.getJsonVersioned("a/b.json"), { value: null, version: null });
    const { version: v1 } = await st.putJsonIfVersion("a/b.json", { x: 1 }, null);
    await assert.rejects(st.putJsonIfVersion("a/b.json", { x: 2 }, null), (e) => e.code === "CONFLICT");
    const { version: v2 } = await st.putJsonIfVersion("a/b.json", { x: 2 }, v1);
    await assert.rejects(st.putJsonIfVersion("a/b.json", { x: 3 }, v1), (e) => e.code === "CONFLICT", "застаріла версія відхиляється");
    const g = await st.getJsonVersioned("a/b.json");
    assert.deepEqual(g, { value: { x: 2 }, version: v2 });
    g.value.x = 99;
    assert.equal((await st.getJsonVersioned("a/b.json")).value.x, 2, "зміна отриманого об'єкта не змінює збережене");
  }
});

test("E3: файлове сховище переживає «перезапуск процесу» (новий екземпляр на тому самому каталозі)", async () => {
  const d = tmp();
  const { version } = await new FileStore(d).putJsonIfVersion("state/x.json", { n: 1 }, null);
  assert.deepEqual(await new FileStore(d).getJsonVersioned("state/x.json"), { value: { n: 1 }, version });
});

test("E3: оренда — токен строго зростає; одна черга для ВСІХ областей; перевірка готовності — окремий ресурс", async () => {
  const c = clock(), committer = createCommitter({ store: new MemoryStore(), now: c.now });
  const a = await committer.acquire("sync");
  await assert.rejects(committer.acquire("catalog-controls"), (e) => e.code === "BUSY", "інша область тієї ж таблиці — та сама черга");
  await assert.rejects(committer.acquire("sync"), (e) => e.code === "BUSY");
  const probe = await committer.acquire("catalog-controls:readiness-probe");
  await probe.release();
  await a.release();
  const b = await committer.acquire("content-html");
  assert.ok(b.token > a.token, `${b.token} > ${a.token}`);
});

test("E3: застаріла оренда не може звільнити нову, подовжити чи пройти перевірку перед записом", async () => {
  const c = clock(), st = new MemoryStore(), committer = createCommitter({ store: st, now: c.now, ttlMs: 1000, settleMs: 500 });
  const a = await committer.acquire("sync");
  c.t += 1000; // A «завис» — оренда сплила
  await assert.rejects(committer.acquire("catalog-controls"), (e) => e.code === "SETTLING", "запити A ще можуть застосуватися");
  c.t += 500;
  const b = await committer.acquire("catalog-controls");
  assert.equal(b.tookOverCrashed, true);
  await assert.rejects(a.assertCurrent(), (e) => e.code === "STALE");
  await assert.rejects(a.release(), (e) => e.code === "STALE", "стара оренда не звільняє чинну");
  await assert.rejects(a.renew(), (e) => e.code === "STALE");
  await b.assertCurrent();
  await b.release();
  await assert.rejects(b.assertCurrent(), (e) => e.code === "STALE", "після власного release — теж застаріла");
});

test("E3 / H04 / Р7 / ENG-23: запізнілий запис контрольної точки старої оренди відхиляє сховище (квиток і оренда — в одній критичній секції з CAS); ccReadiness точку не пише; ключ CC оренда не змінює", async () => {
  const c = clock(), st = new MemoryStore(), desk = deskOf(st, c.now);
  const gw = new WriteGateway({ sheets: new MemorySheets(book()), read: async () => ({}), store: st, now: c.now, ttlMs: 1000, settleMs: 500 });
  const committer = createCommitter({ store: st, now: c.now, ttlMs: 1000, settleMs: 500 });
  const l0 = await committer.acquire("catalog-controls");
  const seed = { v: 2, held: ["1500000007"] };
  await st.putJsonIfVersionFenced(CC_CHECKPOINT_KEY, seed, null, fenceOf(l0, ticketFor(desk, l0, seed, null, "init"))); // CC записав раніше
  await l0.release();
  const seeded = await st.getJsonVersioned(CC_CHECKPOINT_KEY);
  const oldLease = await committer.acquire("catalog-controls");
  const seen = await st.getJsonVersioned(CC_CHECKPOINT_KEY); // стара оренда прочитала версію …
  assert.deepEqual(seen, seeded, "видача оренди не змінила ні значення, ні версії ключа CC");
  const release = { v: 2, held: [] };
  const oldTicket = ticketFor(desk, oldLease, release, seen.version); // … і отримала квиток
  c.t += 1500;                                                       // далі «зависла»: оренда сплила, вікно settle минуло
  const newLease = await committer.acquire("catalog-controls");
  assert.ok(newLease.token > oldLease.token);
  assert.deepEqual(await st.getJsonVersioned(CC_CHECKPOINT_KEY), seeded, "перехоплення оренди теж не змінило ключа CC");
  await assert.rejects(st.putJsonIfVersionFenced(CC_CHECKPOINT_KEY, release, seen.version, fenceOf(oldLease, oldTicket)), (e) => e.fencing === true || e.code === "CC_TICKET_REJECTED", "запізнілий RELEASE старої оренди відхилено");
  assert.deepEqual(await st.getJsonVersioned(CC_CHECKPOINT_KEY), seeded, "HOLD не втрачено, версія та сама");
  // Квиток старої оренди не підходить і новій: квиток прив'язано до оренди.
  await assert.rejects(st.putJsonIfVersionFenced(CC_CHECKPOINT_KEY, release, seen.version, { ...fenceOf(newLease), ticket: oldTicket }), (e) => e.code === "CC_TICKET_REJECTED");
  // Та сама версія від чинної оренди зі своїм квитком — проходить.
  const more = { v: 2, held: ["1500000007", "1500000014"] };
  const ok = await st.putJsonIfVersionFenced(CC_CHECKPOINT_KEY, more, seen.version, fenceOf(newLease, ticketFor(desk, newLease, more, seen.version)));
  assert.ok(ok.version && ok.version !== seen.version);
  await assert.rejects(st.putJsonIfVersionFenced(CC_CHECKPOINT_KEY, { v: 2 }, seen.version, fenceOf(newLease, ticketFor(desk, newLease, { v: 2 }, seen.version))), (e) => e.code === "CONFLICT", "застаріла версія — CONFLICT");
  // ccReadiness() (і engineeringReadiness) точку не пише за жодних умов (E4).
  const run = gw.ccReadiness();
  await assert.rejects(run.store.putJsonIfVersion(CC_CHECKPOINT_KEY, { v: 2 }, ok.version, { lease: { scope: "catalog-controls", token: newLease.token } }), (e) => e.code === "CC_KEY_SEALED");
  await newLease.release();
  await assert.rejects(st.putJsonIfVersionFenced(CC_CHECKPOINT_KEY, { v: 9 }, ok.version, fenceOf(newLease, ticketFor(desk, newLease, { v: 9 }, ok.version))), (e) => e.fencing === true || e.code === "CC_TICKET_REJECTED", "після власного release — теж відмова");
});

test("Р7: шлюз не змінює жодного ключа Catalog Controls — сесії, оренди CC, перехоплення після збою, reconcile", async () => {
  const c = clock(), sh = new MemorySheets(book()), st = new MemoryStore();
  const PROBE = "state/catalog-controls/readiness-probe.json";
  // ENG-23: точку можна записати лише з квитком — тест сам забирає стіл квитків і сіє точку ДО створення шлюзу.
  {
    const d = deskOf(st, c.now), cm = createCommitter({ store: st, now: c.now, ttlMs: 1000, settleMs: 100 });
    const l0 = await cm.acquire("catalog-controls"), seed = { v: 2, held: ["1"] };
    await st.putJsonIfVersionFenced(CC_CHECKPOINT_KEY, seed, null, fenceOf(l0, ticketFor(d, l0, seed, null, "init")));
    await l0.release();
  }
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: st, now: c.now, ttlMs: 1000, settleMs: 100 });
  await st.putJsonIfVersion(PROBE, { v: 1, probe: "x" }, null);
  const snap = async () => JSON.stringify([await st.getJsonVersioned(CC_CHECKPOINT_KEY), await st.getJsonVersioned(PROBE)]);
  const before = await snap();
  const s1 = await gw.open({ writer: "sync" });
  await s1.updateByKey({ title: T, changes: [{ key: "101", expect: { "Ціна": "100" }, set: { "Ціна": "110" } }] });
  await s1.close();
  const cc = gw.ccReadiness();
  const l = await cc.committer.acquire("catalog-controls");
  await l.release();
  const p = await cc.committer.acquire("catalog-controls:readiness-probe");
  await p.release();
  await gw.open({ writer: "content-html" }); // «падає» без звільнення
  c.t += 1200;
  const s2 = await gw.open({ writer: "sync" });
  await s2.reconcile();
  await s2.close();
  assert.equal(await snap(), before, "значення й версії ключів CC незмінні");
  assert.throws(() => createCommitter({ store: st, touchKeys: () => [CC_CHECKPOINT_KEY] }), /touchKeys заборонено/);
});

test("Р7: fencing у файловому сховищі — між різними екземплярами (процесами) на одному каталозі", async () => {
  const d = tmp(), c = clock();
  const A = new FileStore(d), B = new FileStore(d);
  const ca = createCommitter({ store: A, now: c.now, ttlMs: 1000, settleMs: 0 }), cb = createCommitter({ store: B, now: c.now, ttlMs: 1000, settleMs: 0 });
  const PROBE = "state/catalog-controls/readiness-probe.json"; // ENG-23: точка запечатана квитками — fencing між процесами на fenced-ключі
  const la = await ca.acquire("catalog-controls");
  const { version } = await A.putJsonIfVersionFenced(PROBE, { n: 1 }, null, fenceOf(la));
  c.t += 1000;
  const lb = await cb.acquire("catalog-controls"); // інший «процес» перехопив оренду
  await assert.rejects(A.putJsonIfVersionFenced(PROBE, { n: 2 }, version, fenceOf(la)), (e) => e.fencing === true);
  assert.deepEqual(await B.getJsonVersioned(PROBE), { value: { n: 1 }, version });
  const r = await B.putJsonIfVersionFenced(PROBE, { n: 3 }, version, fenceOf(lb));
  assert.ok(r.version);
  await assert.rejects(B.putJsonIfVersionFenced(lb.leaseKey, {}, null, fenceOf(lb)), /ключ оренди/, "ключ оренди fenced-записом не пишеться");
  // ENG-23 (F06-5): квиток іншого екземпляра сховища («іншого процесу») — невідомий → CC_TICKET_REJECTED.
  const deskB = deskOf(B, c.now), val = { n: 4 };
  const tB = ticketFor(deskB, lb, val, null, "init");
  await assert.rejects(A.putJsonIfVersionFenced(CC_CHECKPOINT_KEY, val, null, fenceOf(lb, tB)), (e) => e.code === "CC_TICKET_REJECTED");
  assert.ok((await B.putJsonIfVersionFenced(CC_CHECKPOINT_KEY, val, null, fenceOf(lb, tB))).version, "у власному екземплярі — проходить");
});

test("Р7 / ENG-23: FileStore — перехоплення оренди рівно між перевіркою (оренда + квиток) і CAS контрольної точки не проходить (замок ключа оренди лінеаризує)", async () => {
  const d = tmp(), c = clock(), order = [];
  const B = new FileStore(d, { probe: (ev, key) => { if (ev === "committed") order.push(key.split("/")[1]); } });
  const cb = createCommitter({ store: new FileStore(d), now: c.now, ttlMs: 1000, settleMs: 0 });
  const la = await cb.acquire("catalog-controls");
  const leaseNow = await B.getJsonVersioned(la.leaseKey);
  let takeover = null;
  const A = new FileStore(d, { probe: (ev, key) => {
    if (ev === "fence-checked") takeover = B.putJsonIfVersion(la.leaseKey, { ...leaseNow.value, token: la.token + 1, leaseId: "0".repeat(32) }, leaseNow.version); // «інший процес» саме зараз
    if (ev === "committed") order.push(key.split("/")[1]);
  } });
  const deskA = deskOf(A, c.now), val = { n: 1 };
  await A.putJsonIfVersionFenced(CC_CHECKPOINT_KEY, val, null, fenceOf(la, ticketFor(deskA, la, val, null, "init")));
  await takeover;
  assert.deepEqual(order, ["catalog-controls", "write-lease"], "запис точки зафіксовано ДО перехоплення, перехоплення — після звільнення замка");
});

test("E3: журнал — запис від старої оренди відхиляється навіть ДО того, як нова оренда допише ACQUIRE (fencing у сховищі)", async () => {
  const c = clock(), st = new MemoryStore(), committer = createCommitter({ store: st, now: c.now, ttlMs: 1000, settleMs: 0 });
  const j = new OpJournal({ store: st, resource: "sheets-main", now: c.now });
  const a = await committer.acquire("sync");
  await j.append(a, { opId: "", phase: "ACQUIRE" });
  c.t += 1000;
  const b = await committer.acquire("sync"); // нова оренда ще нічого не писала в журнал
  const fakeStillValid = { ...a, assertCurrent: async () => {} }; // навіть якщо стара оренда «вважає себе» чинною
  await assert.rejects(j.append(fakeStillValid, { opId: "op-x", phase: "VERIFIED" }), (e) => e.code === "STALE");
  await j.append(b, { opId: "", phase: "ACQUIRE" });
  await assert.rejects(j.append(fakeStillValid, { opId: "op-y", phase: "VERIFIED" }), (e) => e.code === "STALE");
  assert.ok(!(await j.entries()).some((e) => e.opId === "op-x" || e.opId === "op-y"));
});

test("E3: два паралельні записувачі — один отримує BUSY; таблиця змінюється лише власником оренди", async () => {
  const sh = new MemorySheets(book());
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: new MemoryStore(), now: () => 7 });
  const res = await Promise.allSettled([gw.open({ writer: "sync" }), gw.open({ writer: "catalog-controls" })]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(res.find((r) => r.status === "rejected").reason.code, "BUSY");
  const s = res.find((r) => r.status === "fulfilled").value;
  await s.close();
});

test("E3: втрата оренди — стара сесія не пише рядок, не змінює SEO, не звільняє оренду; нова працює", async () => {
  const c = clock(), sh = new MemorySheets(book());
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: new MemoryStore(), now: c.now, ttlMs: 1000, settleMs: 300 });
  const A = await gw.open({ writer: "sync" });
  c.t += 1300;
  const B = await gw.open({ writer: "sync" });
  const before = JSON.stringify(sh.book[T]);
  const e = await A.updateByKey({ title: T, changes: [{ key: "101", expect: { "Ціна": "100" }, set: { "Ціна": "1" } }] }).catch((x) => x);
  assert.equal(outcomeOf(e), OUTCOME.NOT_APPLIED);
  assert.equal(e.code, "STALE");
  const seo = await A.updateByKey({ title: T, changes: [{ key: "101", expect: { "Назва UA": "SEO 101" }, set: { "Назва UA": "зламано" } }] }).catch((x) => x);
  assert.equal(outcomeOf(seo), OUTCOME.NOT_APPLIED);
  await assert.rejects(A.close(), (x) => x.code === "STALE");
  assert.equal(JSON.stringify(sh.book[T]), before, "таблиця без змін від старої оренди");
  assert.equal((await B.updateByKey({ title: T, changes: [{ key: "101", expect: { "Ціна": "100" }, set: { "Ціна": "2" } }] })).outcome, OP.VERIFIED);
  await B.close();
});

test("E3: запізнілий API-запит старої оренди (Google застосовує пізніше) — нова оренда чекає вікно, потім з'ясовує за ключем", async () => {
  const c = clock(), sh = new MemorySheets(book());
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: new MemoryStore(), now: c.now, ttlMs: 1000, settleMs: 200_000 });
  const A = await gw.open({ writer: "sync" });
  sh.armFault({ op: "updateRanges", mode: "delay" });
  const r = await A.updateByKey({ title: T, changes: [{ key: "102", expect: { "Ціна": "200" }, set: { "Ціна": "222" } }], generation: "late" });
  assert.equal(r.outcome, OP.UNKNOWN, "відповіді немає, клітинка ще стара — результат невідомий");
  // A «падає» (не звільняє оренду). Нова оренда до кінця вікна неможлива.
  c.t += 1000;
  await assert.rejects(gw.open({ writer: "catalog-controls" }), (e) => e.code === "SETTLING");
  sh.flushDelayed(); // Google застосував запит у межах документованих 180 с
  c.t += 200_000;
  const B = await gw.open({ writer: "catalog-controls" });
  assert.equal(B.state, SESSION.RECONCILE_REQUIRED);
  await assert.rejects(B.updateByKey({ title: T, changes: [{ key: "101", expect: { "Ціна": "100" }, set: { "Ціна": "1" } }] }), /RECONCILE_REQUIRED/);
  const rec = await B.reconcile();
  assert.equal(rec[0].result, OP.VERIFIED, "запізнілий запит з'ясовано за ключем: застосований");
  assert.equal(B.state, SESSION.READY);
  assert.equal(cell(sh, "102", "Ціна"), "222");
  await B.close();
});

test("E3: запит застосувався ПІЗНІШЕ за вікно (поза документованими 180 с) — виявляється як CONFLICT наступного запису, а не мовчки", async () => {
  const c = clock(), sh = new MemorySheets(book());
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: new MemoryStore(), now: c.now, ttlMs: 1000, settleMs: 10 });
  const A = await gw.open({ writer: "sync" });
  sh.armFault({ op: "updateRanges", mode: "delay" });
  await A.updateByKey({ title: T, changes: [{ key: "103", expect: { "Ціна": "300" }, set: { "Ціна": "333" } }] });
  c.t += 2000;
  const B = await gw.open({ writer: "sync" });
  const rec = await B.reconcile();
  assert.equal(rec[0].result, OP.NOT_APPLIED, "за вікном клітинка ще стара");
  sh.flushDelayed(); // порушення документованої межі Google: запит ліг пізніше
  const r = await B.updateByKey({ title: T, changes: [{ key: "103", expect: { "Ціна": "300" }, set: { "Ціна": "301" } }] });
  assert.equal(r.items[0].status, "CONFLICT", "залишковий ризик виявлено перевіркою очікуваного значення");
  assert.equal(cell(sh, "103", "Ціна"), "333", "нічого не перезаписано наосліп");
  await B.close();
});

test("E3: повтор після аварійного завершення — намір у журналі без результату → з'ясування → той самий намір не пишеться вдруге", async () => {
  const c = clock(), sh = new MemorySheets(book()), st = new MemoryStore();
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: st, now: c.now, ttlMs: 1000, settleMs: 100 });
  const A = await gw.open({ writer: "sync" });
  sh.armFault({ op: "updateRanges", mode: "lost" }); // застосовано, але процес «упав» до запису результату:
  const realAppend = A.journal.append.bind(A.journal);
  A.journal.append = async (lease, rec) => { if (rec.phase !== "INTENT" && rec.phase !== "ACQUIRE") throw new Error("процес упав"); return realAppend(lease, rec); };
  const ch = [{ key: "101", expect: { "Ціна": "100" }, set: { "Ціна": "150" } }];
  await A.updateByKey({ title: T, changes: ch, generation: "crash" }).catch(() => {});
  c.t += 1200;
  const B = await gw.open({ writer: "sync" });
  assert.equal(B.state, SESSION.RECONCILE_REQUIRED);
  assert.equal((await B.reconcile())[0].result, OP.VERIFIED);
  const n = sh.log.length;
  const again = await B.updateByKey({ title: T, changes: ch, generation: "crash" });
  assert.equal(again.repeated, true);
  assert.equal(sh.log.length, n, "повтор не відправив другий запит");
  assert.equal(cell(sh, "101", "Ціна"), "150");
  await B.close();
});

test("E3: сирий запис через шлюз — fence і журнал; видалення рядків заборонено", async () => {
  const sh = new MemorySheets(book());
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: new MemoryStore(), now: () => 9 });
  const s = await gw.open({ writer: "sync" });
  await assert.rejects(s.sheets.deleteRows(T, [2]), (e) => e.code === "DELETE_FORBIDDEN");
  await s.sheets.updateRanges([{ title: T, row: 2, col: 4, values: [["1"]] }]);
  const ent = await s.journal.entries();
  assert.ok(ent.some((e) => e.kind === "raw" && e.phase === "VERIFIED"));
  await s.close();
  await assert.rejects(s.sheets.updateRanges([{ title: T, row: 2, col: 4, values: [["2"]] }]), /CLOSED/);
});

test("E3 / CC R4 / ENG-24: контракти cc-committer-v2 і cc-store-v1 — послідовність checkReadiness і runControls", async () => {
  const sh = new MemorySheets(book());
  const gw = new WriteGateway({ sheets: sh, read: (n) => sh.read(n), store: new MemoryStore(), now: () => 11 });
  const { committer: cm, store: st } = gw.ccReadiness();
  const PROBE = "state/catalog-controls/readiness-probe.json", PS = "catalog-controls:readiness-probe";
  assert.equal(cm.contract, "cc-committer-v2"); // ENG-24: CC R7.3 (C4) вимагає v2: leaseId 32 hex, новий на кожну видачу
  // «W2 committer»: виключність, assertCurrent після release, монотонний токен.
  const p1 = await cm.acquire(PS);
  assert.ok(Number.isInteger(p1.token) && p1.token >= 1);
  await assert.rejects(cm.acquire(PS), "друга оренда тієї самої області — виняток");
  await p1.release();
  await assert.rejects(p1.assertCurrent(), "assertCurrent після release — виняток");
  const p2 = await cm.acquire(PS);
  assert.ok(p2.token > p1.token);
  await p2.release();
  // «W2 store»: запис службового ключа під орендою; застаріла версія → виняток; читання назад; запис звільненою орендою → відмова.
  const lease = await cm.acquire(PS);
  const fence = { lease: { scope: PS, token: lease.token } };
  const g = await st.getJsonVersioned(PROBE);
  const put = await st.putJsonIfVersion(PROBE, { v: 1, probe: "a" }, g.version, fence);
  await assert.rejects(st.putJsonIfVersion(PROBE, { v: 1, probe: "stale" }, g.version, fence), (e) => e.code === "CONFLICT");
  assert.deepEqual(await st.getJsonVersioned(PROBE), { value: { v: 1, probe: "a" }, version: put.version });
  await lease.release();
  const g3 = await st.getJsonVersioned(PROBE);
  await assert.rejects(st.putJsonIfVersion(PROBE, { v: 1, probe: "stale-lease" }, g3.version, fence), (e) => e.code === "STALE_LEASE", "звільнена оренда за правильної версії — відмова (fencing)");
  await assert.rejects(st.putJsonIfVersion(PROBE, { v: 1 }, g3.version), (e) => e.code === "STALE_LEASE", "ключ CC без оренди — відмова");
  // ENG-23 (E4): контрольну точку ця пара не пише за жодної оренди — лише протокол A (cc-serving-v2) з квитком beforeCommit.
  const l = await cm.acquire("catalog-controls");
  const lp = await cm.acquire(PS);
  for (const lease of [{ scope: PS, token: lp.token }, { scope: "catalog-controls", token: lp.token }, { scope: "catalog-controls", token: l.token }, undefined]) {
    await assert.rejects(st.putJsonIfVersion(CC_CHECKPOINT_KEY, { v: 3 }, null, lease ? { lease } : {}), (e) => e.code === "CC_KEY_SEALED");
  }
  assert.equal((await st.getJsonVersioned(CC_CHECKPOINT_KEY)).value, null, "точку не записано");
  await lp.release();
  await l.release();
  // Інші ключі без оренди — звичайний CAS.
  assert.ok((await st.putJsonIfVersion("state/other/x.json", { a: 1 }, null)).version);
});
