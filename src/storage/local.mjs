/** Локальне об'єктне сховище з тим самим контрактом, що й майбутній адаптер R2 (S3 API).
 *  Кожен PUT атомарний для читача (тимчасовий файл + rename). Лічильники операцій
 *  ведуться за класами R2 (A: put/list, B: get/head, delete — безплатний), щоб прогнозувати квоти. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";

export function newOpCounter() {
  return { classA: 0, classB: 0, deletes: 0, bytesUploaded: 0, bytesDownloaded: 0 };
}

export class LocalObjectStore {
  constructor(root, { counter = newOpCounter(), failOn = null } = {}) {
    this.root = path.resolve(root);
    this.ops = counter;
    // Для тестів відмов: failOn(op, key) → true кидає помилку перед операцією.
    this.failOn = failOn;
  }

  #file(key) {
    if (!/^[A-Za-z0-9._\-/]+$/.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Невалідний ключ сховища: " + key);
    return path.join(this.root, ...key.split("/"));
  }

  #check(op, key) {
    if (this.failOn && this.failOn(op, key)) throw new Error(`Імітована відмова сховища: ${op} ${key}`);
  }

  /** body: Buffer | string | { file: шлях } ; meta: { contentType, metadata } */
  async put(key, body, meta = {}) {
    this.#check("put", key);
    this.ops.classA++;
    const target = this.#file(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = target + ".tmp-" + crypto.randomBytes(6).toString("hex");
    if (body && typeof body === "object" && "file" in body) {
      await pipeline(fs.createReadStream(body.file), fs.createWriteStream(tmp));
    } else {
      await fsp.writeFile(tmp, body);
    }
    const size = (await fsp.stat(tmp)).size;
    await fsp.writeFile(tmp + ".meta", JSON.stringify({ contentType: meta.contentType || "application/octet-stream", metadata: meta.metadata || {}, size }));
    await fsp.rename(tmp + ".meta", target + ".meta");
    await fsp.rename(tmp, target);
    this.ops.bytesUploaded += size;
    return { key, size };
  }

  async head(key) {
    this.#check("head", key);
    this.ops.classB++;
    try {
      const meta = JSON.parse(await fsp.readFile(this.#file(key) + ".meta", "utf8"));
      const size = (await fsp.stat(this.#file(key))).size;
      return { key, size, contentType: meta.contentType, metadata: meta.metadata };
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  /** Повний вміст (малі службові об'єкти) або null. */
  async getBuffer(key) {
    this.#check("get", key);
    this.ops.classB++;
    try {
      const data = await fsp.readFile(this.#file(key));
      this.ops.bytesDownloaded += data.length;
      return data;
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  async getJson(key) {
    const data = await this.getBuffer(key);
    return data ? JSON.parse(data.toString("utf8")) : null;
  }

  async putJson(key, value) {
    return this.put(key, Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8"), { contentType: "application/json" });
  }

  /** Потік вмісту (великі YML) або null. */
  async getStream(key) {
    this.#check("get", key);
    this.ops.classB++;
    const file = this.#file(key);
    try { await fsp.access(file); } catch { return null; }
    const stream = fs.createReadStream(file);
    stream.on("data", (c) => { this.ops.bytesDownloaded += c.length; });
    return stream;
  }

  async list(prefix) {
    this.#check("list", prefix);
    this.ops.classA++;
    const dir = this.#file(prefix.replace(/\/$/, ""));
    const out = [];
    const walk = async (d, rel) => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return; throw e; }
      for (const e of entries) {
        if (e.name.endsWith(".meta") || e.name.includes(".tmp-")) continue;
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) await walk(path.join(d, e.name), r);
        else out.push(prefix.replace(/\/$/, "") + "/" + r);
      }
    };
    await walk(dir, "");
    return out.sort();
  }

  async delete(key) {
    this.#check("delete", key);
    this.ops.deletes++;
    for (const f of [this.#file(key), this.#file(key) + ".meta"]) {
      try { await fsp.unlink(f); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  }
}
