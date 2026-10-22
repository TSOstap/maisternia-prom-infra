/** C3: цикл публікації (upload → deploy → readback → відкат) на імітації Cloudflare + справжньому коді Worker. Без мережі. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import worker from "../poc/c3-assets/src/worker.js";
import { buildVersion, checkYml, publishVersion, MAX_PARTS } from "../src/publish/cf-assets.mjs";
import { corruptBuild, WORKER_MAIN } from "../poc/c3-assets/build.mjs";

const KEY = "test-key-NOT-REAL-zzzzzzzzzzzzzzzzzzzzzz";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const BASE = "https://poc.example";
const WAIT = { limitMs: 2000, intervalMs: 1, streak: 2 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mm-cfpub-"));

function yml(dir, n, tag) {
  const offers = Array.from({ length: n }, (_, i) => `<offer id="${1500000000 + i}"><name>Ї ${tag} ${i}</name></offer>`).join("");
  const f = path.join(dir, `${tag}.xml`);
  fs.writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="2026-10-22"><shop><offers>${offers}</offers></shop></yml_catalog>\n`);
  return f;
}
function version(dir, label, n = 40) {
  const out = path.join(dir, "b-" + label);
  buildVersion({ src: yml(dir, n, label), out, version: label, partBytes: 700, keySha256: sha(KEY), workerMain: WORKER_MAIN, workerName: "mm-feed-poc", offers: n });
  return out;
}

/** Імітація Cloudflare: версії = каталоги збірок; деплой/відкат перемикають активну. Worker — справжній. */
function fakeCloud({ failUpload = false, failDeploy = false } = {}) {
  const versions = new Map();
  let active = null, n = 0;
  const calls = [];
  const env = () => {
    const dir = versions.get(active);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "wrangler.json"), "utf8"));
    return { ...cfg.vars, ASSETS: { async fetch(u) {
      const p = path.join(dir, "public", decodeURIComponent(new URL(u).pathname));
      return fs.existsSync(p) ? new Response(fs.readFileSync(p)) : new Response("nf", { status: 404 }); // як у Cloudflare: без Content-Length
    } } };
  };
  const cloud = {
    calls, versions,
    get active() { return active; },
    seed(dir) { const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; versions.set(id, dir); active = id; return id; },
    async wrangler(args) {
      calls.push(args[0] + (args[1] && !args[1].startsWith("-") ? " " + args[1] : ""));
      const ok = (out = "") => ({ code: 0, out, ms: 1 });
      if (args[0] === "deployments") return ok(JSON.stringify({ versions: active ? [{ version_id: active, percentage: 100 }] : [] }));
      if (args[0] === "versions" && args[1] === "upload") {
        if (failUpload) return { code: 1, out: "X [ERROR] upload failed", ms: 1 };
        const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        versions.set(id, path.dirname(args[args.indexOf("-c") + 1]));
        return ok(`Worker Version ID: ${id}`);
      }
      if (args[0] === "versions" && args[1] === "deploy") {
        if (failDeploy) return { code: 1, out: "X [ERROR] deploy failed", ms: 1 };
        active = args[2].split("@")[0];
        return ok();
      }
      if (args[0] === "rollback") { active = args[1]; return ok(); }
      throw new Error("неочікувана команда " + args.join(" "));
    },
    fetch: (u, init) => worker.fetch(new Request(u, init), env(), { waitUntil() {} }),
  };
  return cloud;
}
const run = (cloud, buildDir, label, extra = {}) =>
  publishVersion({ wrangler: (a) => cloud.wrangler(a), fetch: cloud.fetch }, { buildDir, label, base: BASE, key: KEY, workerName: "mm-feed-poc", parallel: 3, waitOpts: WAIT, ...extra });

test("checkYml: структура і ліміти перевіряються до публікації", async () => {
  const d = tmp();
  const ok = await checkYml(yml(d, 5, "ok"));
  assert.equal(ok.count, 5);
  const bad = path.join(d, "bad.xml");
  fs.writeFileSync(bad, '<?xml version="1.0"?>\n<yml_catalog><shop><offers><offer id="1"></offers></shop></yml_catalog>');
  await assert.rejects(checkYml(bad), /XML/);
  const dup = path.join(d, "dup.xml");
  fs.writeFileSync(dup, '<?xml version="1.0"?>\n<yml_catalog><shop><offers><offer id="1"/><offer id="1"/></offers></shop></yml_catalog>');
  await assert.rejects(checkYml(dup), /повторений ID/);
  await assert.rejects(checkYml(yml(d, 2, "few2"), { minOffers: 3 }), /мінімуму/);
  await assert.rejects(checkYml(yml(d, 2, "big"), { maxBytes: 10 }), /ліміту/);
});

test("buildVersion: частини ≤ розміру, не більше MAX_PARTS (ліміт subrequests), у конфігу лише SHA ключа", () => {
  const d = tmp();
  const out = version(d, "a1");
  const cfg = fs.readFileSync(path.join(out, "wrangler.json"), "utf8");
  assert.ok(!cfg.includes(KEY));
  assert.match(cfg, /"run_worker_first": true/);
  assert.throws(() => buildVersion({ src: yml(d, 400, "many"), out: path.join(d, "many"), version: "many", partBytes: 100, keySha256: "x", workerMain: WORKER_MAIN, workerName: "w" }), new RegExp(`> ${MAX_PARTS}`));
});

test("успішна публікація: атомарно нова версія, 3 одночасні readback з правильним SHA, адреса та сама", async () => {
  const d = tmp();
  const cloud = fakeCloud();
  const prev = cloud.seed(version(d, "a1"));
  const r = await run(cloud, version(d, "b2"), "b2");
  assert.equal(r.state, "PUBLISHED");
  assert.equal(r.previous.version, "a1");
  assert.equal(r.steps.readback.length, 3);
  assert.ok(r.steps.readback.every((x) => x.match && x.version === "b2"));
  assert.notEqual(cloud.active, prev);
  assert.deepEqual(cloud.calls, ["deployments status", "versions upload", "versions deploy"]);
});

test("пошкоджена збірка без обходу — зупинка ДО завантаження, активна версія не змінюється", async () => {
  const d = tmp();
  const cloud = fakeCloud();
  const prev = cloud.seed(version(d, "a1"));
  const bad = version(d, "b2");
  corruptBuild(bad, "byte");
  const r = await run(cloud, bad, "b2");
  assert.equal(r.state, "GATE_FAILED");
  assert.equal(cloud.active, prev);
  assert.deepEqual(cloud.calls, []);
});

test("пошкоджений вміст пройшов у хмару (обхід перевірки, лише тест) → readback бачить інший SHA → авто-відкат", async () => {
  for (const kind of ["byte", "missing", "size"]) {
    const d = tmp();
    const cloud = fakeCloud();
    const prev = cloud.seed(version(d, "a1"));
    const bad = version(d, "b2");
    corruptBuild(bad, kind);
    const r = await run(cloud, bad, "b2", { bypassGate: true });
    assert.equal(r.state, "ROLLED_BACK", kind);
    assert.equal(r.failure, "READBACK_FAILED", kind);
    assert.equal(cloud.active, prev, kind);
    assert.equal(r.steps.rollback.readback.match, true, kind);
  }
});

test("помилка завантаження — живу версію не зачеплено, деплою немає", async () => {
  const d = tmp();
  const cloud = fakeCloud({ failUpload: true });
  const prev = cloud.seed(version(d, "a1"));
  const r = await run(cloud, version(d, "b2"), "b2");
  assert.equal(r.state, "UPLOAD_FAILED");
  assert.equal(r.liveUnchanged, true);
  assert.equal(cloud.active, prev);
  assert.ok(!cloud.calls.includes("versions deploy"));
});

test("помилка деплою — відкат на попередню і перевірка її SHA", async () => {
  const d = tmp();
  const cloud = fakeCloud({ failDeploy: true });
  const prev = cloud.seed(version(d, "a1"));
  const r = await run(cloud, version(d, "b2"), "b2");
  assert.equal(r.state, "ROLLED_BACK");
  assert.equal(r.failure, "DEPLOY_FAILED");
  assert.equal(cloud.active, prev);
});
