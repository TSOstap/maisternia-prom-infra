/** PoC C3 (Workers + Static Assets): логіка Worker і збірки на синтетиці, без мережі й без Cloudflare. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import worker from "../poc/c3-assets/src/worker.js";
import { build, verifyBuild } from "../poc/c3-assets/build.mjs";

const KEY = "test-key-NOT-REAL-zzzzzzzzzzzzzzzzzzzzzz";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** Імітація env.ASSETS: віддає файли з public/ збірки (як static assets, з Content-Length). */
function assetsFrom(outDir) {
  return {
    async fetch(u) {
      const p = path.join(outDir, "public", decodeURIComponent(new URL(u).pathname));
      if (!fs.existsSync(p)) return new Response("not found", { status: 404 });
      const b = fs.readFileSync(p);
      return new Response(b, { headers: { "content-length": String(b.length) } });
    },
  };
}

function setup({ corrupt = "", partBytes = 1000, size = 4500 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-c3-"));
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog>' + "Ї".repeat(size) + "</yml_catalog>\n"; // багатобайтові символи на межах частин
  const src = path.join(dir, "src.xml");
  fs.writeFileSync(src, body);
  const out = path.join(dir, "build");
  const r = build({ src, version: "T1", out, corrupt, partBytes, keySha256: sha(KEY) });
  const cfg = JSON.parse(fs.readFileSync(path.join(out, "wrangler.json"), "utf8"));
  const env = { ...cfg.vars, ASSETS: assetsFrom(out) };
  return { body: Buffer.from(body), out, env, manifest: r.manifest, cfg };
}
const get = (env, p, method = "GET") => worker.fetch(new Request("https://poc.example" + p, { method }), env, { waitUntil() {} });

test("збірка: частини ≤ ліміту, сума і SHA-256 = джерелу; конфіг run_worker_first і лише SHA ключа", () => {
  const { body, manifest, out, cfg } = setup();
  assert.equal(manifest.parts.length, 10);
  assert.ok(manifest.parts.every((p) => p.bytes <= 1000));
  assert.equal(manifest.bytes, body.length);
  assert.equal(manifest.sha256, sha(body));
  assert.equal(verifyBuild(out).ok, true);
  assert.equal(cfg.assets.run_worker_first, true);
  assert.equal(cfg.vars.FEED_KEY_SHA256, sha(KEY));
  assert.ok(!JSON.stringify(cfg).includes(KEY), "сам ключ у конфіг не потрапляє");
});

test("Worker склеює частини потоком: байт-у-байт = джерелу, правильні заголовки", async () => {
  const { body, env, manifest } = setup();
  const r = await get(env, `/feeds/main.xml?key=${KEY}`);
  assert.equal(r.status, 200);
  const got = Buffer.from(await r.arrayBuffer());
  assert.equal(got.length, body.length);
  assert.equal(sha(got), manifest.sha256);
  assert.equal(r.headers.get("content-length"), String(body.length));
  assert.equal(r.headers.get("x-feed-sha256"), manifest.sha256);
  assert.match(r.headers.get("content-type"), /application\/xml/);
  const h = await get(env, `/feeds/main.xml?key=${KEY}`, "HEAD");
  assert.equal(h.status, 200);
  assert.equal(h.headers.get("content-length"), String(body.length));
  const s = await (await get(env, `/feeds/main/status?key=${KEY}`)).json();
  assert.deepEqual([s.version, s.sha256, s.bytes, s.parts], ["T1", manifest.sha256, body.length, 10]);
});

test("доступ: без ключа, з хибним ключем, до частин і маніфесту напряму — 404; інші методи — 405", async () => {
  const { env, manifest } = setup();
  for (const p of ["/feeds/main.xml", "/feeds/main.xml?key=wrong", `/feeds/main.xml?key=${KEY}x`, `/_feed/main/${manifest.parts[0].file}`, "/_feed/main/manifest.json", `/feeds/other.xml?key=${KEY}`, "/"]) {
    assert.equal((await get(env, p)).status, 404, p);
  }
  assert.equal((await get(env, `/feeds/main.xml?key=${KEY}`, "POST")).status, 405);
  assert.equal((await get({ ...env, FEED_KEY_SHA256: "" }, `/feeds/main.xml?key=${KEY}`)).status, 404, "без налаштованого ключа фід закритий");
});

test("відсутня частина або частина іншого розміру — 503 до відповіді, а не обрізаний файл", async () => {
  for (const corrupt of ["missing", "size"]) {
    const { env, out } = setup({ corrupt });
    assert.equal(verifyBuild(out).ok, false, `перевірка перед деплоєм ловить «${corrupt}»`);
    const r = await get(env, `/feeds/main.xml?key=${KEY}`);
    assert.equal(r.status, 503, corrupt);
  }
});

test("пошкоджений байт того самого розміру: Worker не помічає (CPU), ловить перевірка перед деплоєм і readback SHA", async () => {
  const { env, out, manifest } = setup({ corrupt: "byte" });
  assert.equal(verifyBuild(out).ok, false);
  const r = await get(env, `/feeds/main.xml?key=${KEY}`);
  assert.equal(r.status, 200);
  assert.notEqual(sha(Buffer.from(await r.arrayBuffer())), manifest.sha256, "readback має виявити розбіжність і відкотити версію");
});

test("пошкоджений маніфест — 503", async () => {
  const { env, out } = setup();
  fs.writeFileSync(path.join(out, "public", "_feed", "main", "manifest.json"), "{ not json");
  assert.equal((await get(env, `/feeds/main.xml?key=${KEY}`)).status, 503);
});
