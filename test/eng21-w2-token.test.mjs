/** ENG-21 (інтеграція з CC R7.2): токен оренди W2 — епоха видачі кодів CC. Він має строго зростати після перезапуску, збою власника,
 *  відновлення контрольної точки CC; після ВІДКАТУ каталогу W2 (запис оренди відновлено з копії) — межа знизу з епохи fencing маніфестів
 *  (B): токен, що не перевищує вже використану епоху, не проходить. Без модуля CC. Композиція з CC — eng21-w2-token-compose. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCommitter } from "../src/pipeline/safe-write/committer.mjs";
import { FileStore } from "../src/pipeline/safe-write/store.mjs";
import { LocalObjectStore } from "../src/storage/local.mjs";
import { fenceFeeds } from "../src/publish/feed-fence.mjs";
import { manifestKey } from "../src/publish/publisher.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (p) => fsp.mkdtemp(path.join(os.tmpdir(), p));

test("W2 токен: перезапуск процесу (новий комітер над тим самим каталогом) і збій власника з перехопленням після TTL + settle — токен строго зростає", async () => {
  const dir = path.join(await tmp("mm-e21-tok-"), "w2");
  let clock = 1_000_000;
  const make = () => createCommitter({ store: new FileStore(dir), now: () => clock, ttlMs: 60_000, settleMs: 20_000 });
  const tokens = [];
  const a = make();
  for (let i = 0; i < 3; i++) { const l = await a.acquire("sync"); tokens.push(l.token); await l.release(); }
  const b = make(); // «перезапуск»: нова інстанція, той самий постійний каталог
  const l4 = await b.acquire("catalog-controls"); tokens.push(l4.token); // збій: не звільнено
  clock += 30_000;
  await assert.rejects(make().acquire("publisher"), /BUSY/);
  clock += 40_000; // сплила, але ще settle
  await assert.rejects(make().acquire("publisher"), /SETTLING/);
  clock += 10_000;
  const l5 = await make().acquire("publisher"); tokens.push(l5.token);
  assert.ok(l5.tookOverCrashed);
  await assert.rejects(l4.assertCurrent(), /STALE/);
  for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i] > tokens[i - 1], JSON.stringify(tokens));
  assert.deepEqual(tokens, [1, 2, 3, 4, 5]);
});

test("Епоха fencing: рівна епоха з ІНШИМ записом → STALE_EPOCH (токен не зріс); більша — проходить; повтор власного запису (той самий штамп) — проходить", async () => {
  const s = new LocalObjectStore(await tmp("mm-e21-eq-"));
  // ENG-23 (F04): кожна видача оренди — новий leaseId; «рівна епоха з ІНШИМ записом» = інша видача з тим самим токеном.
  const lease = (token) => ({ token, leaseId: crypto.randomBytes(16).toString("hex"), scope: "publisher", assertCurrent: async () => {} });
  await fenceFeeds({ store: s, feeds: ["main"], lease: lease(9) });
  await assert.rejects(fenceFeeds({ store: s, feeds: ["main"], lease: lease(9) }), (e) => e.code === "STALE_EPOCH");
  await assert.rejects(fenceFeeds({ store: s, feeds: ["main"], lease: lease(8) }), (e) => e.code === "STALE_EPOCH");
  await fenceFeeds({ store: s, feeds: ["main"], lease: lease(10) });
  assert.equal((await s.getJson(manifestKey("main"))).fence.epoch, 10);
  // Відповідь на власний запис епохи втрачено (запис застосовано, клієнт отримав 412) → повтор бачить ВЛАСНИЙ штамп — не відмова.
  const raw = s.putJson.bind(s);
  let lost = false;
  s.putJson = async (k, v, o) => { const r = await raw(k, v, o); if (!lost && k === manifestKey("main") && o?.ifMatch !== undefined) { lost = true; throw Object.assign(new Error("412 (втрачена відповідь)"), { code: "PRECONDITION_FAILED" }); } return r; };
  const f11 = await fenceFeeds({ store: s, feeds: ["main"], lease: lease(11) });
  s.putJson = raw;
  assert.ok(lost);
  assert.equal((await s.getJson(manifestKey("main"))).fence.epoch, 11);
  await f11.putJson(manifestKey("main"), { kind: "FEED_MANIFEST_V1", feed: "main", active: null }); // очікуваний ETag — після повтору
});

test("Відкат каталогу W2 (запис оренди відновлено з копії), сховище фідів ціле → записувач маніфестів не проходить, доки токен не перевищить уже використану епоху; потім — проходить з новою епохою", async () => {
  const root = await tmp("mm-e21-rb-");
  const w2 = path.join(root, "w2"), snap = path.join(root, "w2-snap");
  const feeds = new LocalObjectStore(path.join(root, "feeds"));
  const committer = () => createCommitter({ store: new FileStore(w2) });
  const fenceOnce = async () => {
    const l = await committer().acquire("publisher");
    try { await fenceFeeds({ store: feeds, feeds: ["main"], lease: l, scope: "publisher" }); return { token: l.token, ok: true }; }
    catch (e) { return { token: l.token, ok: false, code: e.code }; }
    finally { await l.release().catch(() => {}); }
  };
  assert.deepEqual(await fenceOnce(), { token: 1, ok: true });
  fs.cpSync(w2, snap, { recursive: true }); // «резервна копія» каталогу W2 (токен 1)
  assert.deepEqual(await fenceOnce(), { token: 2, ok: true });
  assert.deepEqual(await fenceOnce(), { token: 3, ok: true });
  const used = (await feeds.getJson(manifestKey("main"))).fence.epoch;
  assert.equal(used, 3);
  // Відновлення каталогу W2 з копії: лічильник оренди відкотився до 1.
  fs.rmSync(w2, { recursive: true, force: true });
  fs.cpSync(snap, w2, { recursive: true });
  const after = [await fenceOnce(), await fenceOnce(), await fenceOnce()];
  assert.deepEqual(after.map((x) => [x.token, x.ok]), [[2, false], [3, false], [4, true]], JSON.stringify(after));
  assert.ok(after.filter((x) => !x.ok).every((x) => x.code === "STALE_EPOCH"));
  assert.equal((await feeds.getJson(manifestKey("main"))).fence.epoch, 4, "нова епоха строго більша за всі використані");
});

test("Протокол A: у робочому режимі запуск CC отримує сховище W2 лише через обгортку readiness (сире сховище не передається)", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "pipeline", "production.mjs"), "utf8");
  assert.match(src, /store: protocolA \? null : gateway\?\.store \?\? null/);
});
