/** ENG-21 × CC R7.2 — епоха видачі кодів CC = токен оренди W2 (CC R7.2, C71-01). Перевірка зі СПРАВЖНІМ CC, протоколами A + B,
 *  повним productionConfig, FileStore W2. ENG-23 (узгоджений контракт F04 / F06 / F08):
 *  (а) відновлення лише точки через API неможливе (печатка); файлом поза API — виявляється (CP_ONLY → RECOVERY_PENDING);
 *  (б) відкат УСЬОГО каталогу W2, сховище фідів ціле — RECOVERY_PENDING за межею епох, без мовчазного підняття лічильника.
 *  Вихід — лише погоджена власником процедура recover (E8, ще не реалізовано). Модель — один хост. Без модуля CC — пропуск. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ccPresent = fs.existsSync(new URL("../src/core/controls-plan.mjs", import.meta.url)) && fs.existsSync(new URL("../src/pipeline/controls-run.mjs", import.meta.url)) && fs.existsSync(new URL("./helpers/controls.mjs", import.meta.url));
const skip = ccPresent ? false : "модуль Catalog Controls відсутній (до злиття гілок) — композиційна проба";
const ID = "1500000007";
const HOLD = "ЗНЯТИ З ПРОДАЖУ";
async function world() {
  const [prod, store, gw, h, common, run, local, committer, baseConfig] = await Promise.all([
    import("../src/pipeline/production.mjs"), import("../src/pipeline/safe-write/store.mjs"), import("../src/pipeline/safe-write/gateway.mjs"),
    import("./helpers/controls.mjs"), import("../src/core/controls-common.mjs"), import("../src/pipeline/controls-run.mjs"), import("../src/storage/local.mjs"),
    import("../src/pipeline/safe-write/committer.mjs"), import("../config/default.json", { with: { type: "json" } }),
  ]);
  const w = await h.prepared();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mm-e21c-"));
  const w2 = path.join(dir, "w2");
  const state = () => new store.FileStore(w2);
  const gateway = () => new gw.WriteGateway({ sheets: w.mem, read: (n) => w.mem.read(n), store: state() });
  const feeds = new local.LocalObjectStore(path.join(dir, "objects"));
  const config = prod.productionConfig(structuredClone(baseConfig.default));
  const contractFile = path.join(dir, "contract.json");
  await fsp.writeFile(contractFile, JSON.stringify(h.ACTIVE_CONTRACT));
  // Кожен запуск — новий шлюз над тим самим каталогом W2 (як окремий процес після перезапуску).
  const cc = (stamp) => prod.runCatalogControls({ sheets: w.mem, readBook: w.readBook, gateway: gateway(), config, stamp, mode: "apply", contractFile, protection: h.PROTECTION_OK, feedStore: feeds });
  const cp = async () => (await state().getJsonVersioned(run.CHECKPOINT_KEY));
  const issuedFor = async () => ((await cp()).value?.issued || []).filter((e) => String(e.offerId) === ID).map((e) => ({ code: e.code, epoch: e.epoch }));
  const leaseToken = async () => (await state().getJsonVersioned(committer.leaseKeyOf("sheets-main"))).value?.token ?? 0;
  const fenceEpoch = async () => (await feeds.getJson("feeds/main/manifest.json"))?.fence?.epoch ?? 0;
  return { h, w, dir, w2, state, gateway, feeds, cc, cp, issuedFor, leaseToken, fenceEpoch, SALE: common.SALE_DECISION, CHECKPOINT_KEY: run.CHECKPOINT_KEY };
}

test("C71-01 × W2 (а) / ENG-23 F08-2: відновлення ЛИШЕ контрольної точки через API неможливе (CC_KEY_SEALED); відновлення файлу поза API виявляється (RECOVERY_PENDING, CP_ONLY) — кодів немає, стара гілка не повертається", { skip }, async () => {
  const x = await world();
  assert.ok(["COMMITTED", "PENDING"].includes((await x.cc(x.h.later(0))).state));
  const old = await x.cp();
  const cpFile = path.join(x.w2, encodeURIComponent(x.CHECKPOINT_KEY) + ".json"), oldBytes = fs.readFileSync(cpFile);
  x.h.setCells(x.w, ID, { [x.SALE]: HOLD });
  await x.cc(x.h.later(1));
  const lost = await x.issuedFor();
  assert.equal(lost.length, 1, "передумова: код видано");
  // Через API (пара readiness, сире сховище W2) — запечатано.
  const g = x.gateway(), pair = g.ccReadiness();
  const l = await pair.committer.acquire("catalog-controls");
  await assert.rejects(pair.store.putJsonIfVersion(x.CHECKPOINT_KEY, old.value, (await x.cp()).version, { lease: { scope: "catalog-controls", token: l.token } }), (e) => e.code === "CC_KEY_SEALED");
  await assert.rejects(g.store.putJsonIfVersionFenced(x.CHECKPOINT_KEY, old.value, (await x.cp()).version, { leaseKey: l.leaseKey, token: l.token, leaseId: l.leaseId }), (e) => e.code === "CC_KEY_SEALED");
  await l.release();
  assert.equal((await x.issuedFor()).length, 1, "точку не змінено");
  // Поза API (прямий запис файлу — поза моделлю загроз, Q6): виявлення за head W2 і дзеркалом.
  fs.writeFileSync(cpFile, oldBytes);
  assert.equal((await x.issuedFor()).length, 0, "точку відновлено файлом");
  for (let i = 0; i < 2; i++) {
    const r = await x.cc(x.h.later(2 + i));
    // ENG-24: оренду протоколу A видано, CC R7.3 сам перевіряє serving.status (C2) → RECOVERY_PENDING без записів.
    assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
  }
  assert.equal((await x.feeds.getJson("state/cc-registry/head.json")).recovery.type, "CP_ONLY");
  assert.equal((await x.issuedFor()).length, 0, "кодів не видано до погодженого власником відновлення");
  assert.equal((await x.feeds.getJson("state/cc-registry/head.json")).recovery.state, "RECOVERY_PENDING");
});

test("C71-01 × W2 (б) / ENG-23 F04-1 / F08-3: відкат УСЬОГО каталогу W2 (оренда + точка + head) з копії, сховище фідів ціле — RECOVERY_PENDING (токен оренди нижчий за межу епох), без мовчазного підняття лічильника, кодів немає", { skip }, async () => {
  const x = await world();
  assert.ok(["COMMITTED", "PENDING"].includes((await x.cc(x.h.later(0))).state));
  const snap = path.join(x.dir, "w2-snap");
  fs.cpSync(x.w2, snap, { recursive: true }); // «резервна копія» каталогу W2
  x.h.setCells(x.w, ID, { [x.SALE]: HOLD });
  await x.cc(x.h.later(1));
  const lost = await x.issuedFor();
  assert.equal(lost.length, 1, "передумова: у втраченій гілці код видано");
  assert.equal(await x.fenceEpoch(), lost[0].epoch, "епоха fencing маніфестів = токен запуску CC, що видав код");
  fs.rmSync(x.w2, { recursive: true, force: true });
  fs.cpSync(snap, x.w2, { recursive: true }); // відкат: лічильник оренди, точка й head — як у копії
  const t0 = await x.leaseToken();
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await x.cc(x.h.later(2 + i)));
  for (const r of results) {
    // ENG-26 (CC R7.4, п. a; контракт розд. 5): токен оренди < межі епох → стан RECOVERY_PENDING, detector «epoch-floor» (не BUSY).
    assert.equal(r.state, "RECOVERY_PENDING", JSON.stringify(r).slice(0, 300));
    assert.equal(r.detector, "epoch-floor");
    assert.match(String(r.reason || ""), /RECOVERY_PENDING/);
  }
  assert.equal(await x.leaseToken(), t0, "лічильник оренди не піднято мовчки");
  assert.equal((await x.issuedFor()).length, 0, "кодів не видано — стара команда втраченої гілки нічого не авторизує");
});
