/** ENG-22 (Hermes ENG-21 F02): атомарний умовний запис LocalObjectStore — умова перевіряється в точці ФАКТИЧНОГО запису.
 *  Причина F02 (ENG-21): умовний putJson тримав замок ключа, а «покинутий» замок (старший за 30 с) витіснявся — затриманий записувач,
 *  що вже перевірив If-Match, після витіснення записував поверх нової епохи. Тепер замків немає: запис = ексклюзивне створення наступної
 *  версії, тож будь-який запис між перевіркою й записом робить наш запис неможливим (412) — за будь-якої затримки.
 *  Тестове вікно casWindow — саме проміжок «умову перевірено → запис». Модель для одного хоста — НЕ доказ поведінки R2. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalObjectStore, etagOf } from "../src/storage/local.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (p) => fsp.mkdtemp(path.join(os.tmpdir(), p));
const K = "state/x.json";
const failed412 = (e) => e?.code === "PRECONDITION_FAILED" && e?.status === 412;
/** Сховище з одноразовою дією у вікні «умову перевірено → запис» для ключа K. */
function windowed(dir, opts = {}) {
  const box = { action: null, fired: 0 };
  const s = new LocalObjectStore(dir, { ...opts, casWindow: async (key) => { if (key === K && box.action) { const f = box.action; box.action = null; box.fired++; await f(); } } });
  return { s, box };
}

test("F02 / вікно TOCTOU: між перевіркою If-Match і записом інший записувач змінив ключ → наш запис 412, лишається значення іншого", async () => {
  const dir = await tmp("mm-e22-cas-");
  const { s, box } = windowed(dir);
  const other = new LocalObjectStore(dir); // інший записувач (окрема інстанція, той самий диск)
  const a0 = await s.putJson(K, { v: 0 });
  box.action = () => other.putJson(K, { v: "B" }, { ifMatch: a0.etag });
  await assert.rejects(s.putJson(K, { v: "A" }, { ifMatch: a0.etag }), failed412);
  assert.equal(box.fired, 1, "передумова: умову A перевірено ДО запису B");
  assert.deepEqual(await other.getJson(K), { v: "B" });
  // Те саме з безумовним записом іншого й реальною затримкою у вікні (без жодної залежності від часу).
  const b1 = await s.getJsonEtag(K);
  box.action = async () => { await new Promise((r) => setTimeout(r, 1200)); await other.putJson(K, { v: "C" }); };
  await assert.rejects(s.putJson(K, { v: "A2" }, { ifMatch: b1.etag }), failed412);
  assert.deepEqual(await other.getJson(K), { v: "C" });
});

test("F02 / put(onlyIf): невиконана умова → null (як R2 Workers), нічого не записано; If-None-Match (null) — лише для відсутнього ключа", async () => {
  const dir = await tmp("mm-e22-put-");
  const s = new LocalObjectStore(dir);
  const body = Buffer.from(JSON.stringify({ a: 1 }));
  assert.ok(await s.put(K, body, { contentType: "application/json", ifMatch: null }));
  assert.equal(await s.put(K, Buffer.from("{}"), { contentType: "application/json", ifMatch: null }), null, "ключ уже є");
  assert.equal(await s.put(K, Buffer.from("{}"), { contentType: "application/json", ifMatch: '"x"' }), null, "чужий ETag");
  const r = await s.put(K, Buffer.from('{"a":2}'), { contentType: "application/json", ifMatch: etagOf(body) });
  assert.equal(r.etag, etagOf(Buffer.from('{"a":2}')));
  assert.deepEqual(await s.getJson(K), { a: 2 });
  await assert.rejects(s.put("feeds/main/versions/a.xml", "<x/>", { ifMatch: null }), (e) => e.code === "CAS_UNSUPPORTED");
  // Створення «якщо відсутній» у вікні іншого створення → 412.
  const { s: w, box } = windowed(await tmp("mm-e22-new-"));
  box.action = () => new LocalObjectStore(w.root).putJson(K, { who: "B" }, { ifMatch: null });
  await assert.rejects(w.putJson(K, { who: "A" }, { ifMatch: null }), failed412);
  assert.deepEqual(await w.getJson(K), { who: "B" });
});

test("F02 / конкуренти з тим самим ETag: рівно один переможець; решта 412", async () => {
  const dir = await tmp("mm-e22-race-");
  const s = new LocalObjectStore(dir);
  const { etag } = await s.putJson(K, { n: 0 });
  const res = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => new LocalObjectStore(dir).putJson(K, { n: i + 1 }, { ifMatch: etag })));
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(res.map((r) => r.status)));
  assert.ok(res.filter((r) => r.status === "rejected").every((r) => failed412(r.reason)));
});

test("F02 / GC: затриманий записувач, чий номер версії вже звільнено прибиранням, не «воскрешає» запис — 412, видно лише нові версії", async () => {
  const dir = await tmp("mm-e22-gc-");
  const { s, box } = windowed(dir, { casKeep: 2 });
  const other = new LocalObjectStore(dir, { casKeep: 2 });
  const a0 = await s.putJson(K, { v: 0 });
  box.action = async () => { for (let i = 1; i <= 6; i++) await other.putJson(K, { v: "B" + i }); };
  await assert.rejects(s.putJson(K, { v: "A" }, { ifMatch: a0.etag }), failed412);
  assert.deepEqual(await other.getJson(K), { v: "B6" });
  const vers = fs.readdirSync(path.join(dir, "state", "x.json.cas")).filter((f) => /^v\d+$/.test(f));
  assert.ok(vers.length <= 3, "прибирання тримає лише останні версії: " + vers.join(","));
  for (const f of vers) assert.doesNotMatch(fs.readFileSync(path.join(dir, "state", "x.json.cas", f), "utf8"), /"v": "A"/, "запис A не лишився в жодній версії");
});

test("F02 / файл, записаний до ENG-22 (без версій), читається як версія 0; умовний запис з його ETag проходить, з чужим — 412; видалення — позначка, повторне створення — If-None-Match", async () => {
  const dir = await tmp("mm-e22-legacy-");
  const file = path.join(dir, "state", "x.json"), text = JSON.stringify({ legacy: true }, null, 2) + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.writeFileSync(file + ".meta", JSON.stringify({ contentType: "application/json", metadata: {}, size: Buffer.byteLength(text) }));
  const s = new LocalObjectStore(dir);
  const g = await s.getJsonEtag(K);
  assert.deepEqual(g.value, { legacy: true });
  assert.equal((await s.head(K)).size, Buffer.byteLength(text));
  await assert.rejects(s.putJson(K, { v: 1 }, { ifMatch: '"чужий"' }), failed412);
  await s.putJson(K, { v: 1 }, { ifMatch: g.etag });
  assert.deepEqual(await s.getJson(K), { v: 1 });
  assert.deepEqual(await s.list("state/"), [K]);
  await s.delete(K);
  assert.equal(await s.getJson(K), null);
  assert.equal(await s.head(K), null);
  assert.deepEqual(await s.list("state/"), []);
  await s.putJson(K, { again: true }, { ifMatch: null });
  assert.deepEqual(await s.getJson(K), { again: true });
});

test("F02 / два окремі процеси Node: 2 × 40 інкрементів через If-Match з повтором — жодного втраченого оновлення (лінеаризація на одному диску)", async () => {
  const dir = await tmp("mm-e22-procs-");
  const mod = pathToFileURL(path.join(ROOT, "src", "storage", "local.mjs")).href;
  const child = (n) => new Promise((resolve, reject) => {
    const code = `import { LocalObjectStore } from ${JSON.stringify(mod)};
const s = new LocalObjectStore(${JSON.stringify(dir)}, { casKeep: 4 });
let ok = 0, conflicts = 0;
while (ok < ${n}) {
  const { value, etag } = await s.getJsonEtag("state/counter.json");
  try { await s.putJson("state/counter.json", { n: (value?.n || 0) + 1 }, { ifMatch: etag }); ok++; }
  catch (e) { if (e.code !== "PRECONDITION_FAILED") throw e; conflicts++; }
}
console.log(JSON.stringify({ ok, conflicts }));`;
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (c) => (c === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1))) : reject(new Error(err.slice(-500)))));
  });
  const [a, b] = await Promise.all([child(40), child(40)]);
  assert.equal(a.ok + b.ok, 80);
  assert.equal((await new LocalObjectStore(dir).getJson("state/counter.json")).n, 80, JSON.stringify({ a, b }));
});
