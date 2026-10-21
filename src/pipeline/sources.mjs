/** Джерела даних конвеєра. Справжні Google/постачальник підключаються лише в окремому погодженому етапі.
 *
 *  Каталог (знімок аркушів) — каталог файлів:
 *    <dir>/groups.json            — 2D-масив аркуша «Групи» (перший рядок — заголовки)
 *    <dir>/sheets/<назва>.ndjson  — 1-й рядок: масив заголовків; далі по рядку-масиву на товар
 *  Це той самий вигляд, що повертає getValues()/Sheets API values.get, але потоковий (30 тис.+ рядків). */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";

export class NdjsonCatalogSource {
  constructor(dir) { this.dir = path.resolve(dir); }

  async #readSheet(file) {
    const values = [];
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) values.push(JSON.parse(line));
    return values;
  }

  /** { sheets: { назва: values2D }, groups: values2D } — лише наявні аркуші. */
  async load(sheetNames) {
    const sheets = {};
    for (const name of sheetNames) {
      const file = path.join(this.dir, "sheets", name + ".ndjson");
      try { await fsp.access(file); } catch { continue; }
      sheets[name] = await this.#readSheet(file);
    }
    const groups = JSON.parse(await fsp.readFile(path.join(this.dir, "groups.json"), "utf8"));
    return { sheets, groups };
  }

  /** Відбиток джерела для контролю «джерело змінилося під час формування». */
  async fingerprint() {
    const hash = crypto.createHash("sha256");
    const files = [path.join(this.dir, "groups.json")];
    try { for (const f of (await fsp.readdir(path.join(this.dir, "sheets"))).sort()) files.push(path.join(this.dir, "sheets", f)); } catch { /* немає аркушів */ }
    for (const f of files) {
      const st = await fsp.stat(f);
      hash.update(`${path.basename(f)}|${st.size}|${st.mtimeMs}\n`);
    }
    return hash.digest("hex");
  }
}

/** Запис знімка каталогу (синтетика, тести, майбутній експорт із Sheets). */
export async function writeCatalogSnapshot(dir, { sheets, groups }) {
  await fsp.mkdir(path.join(dir, "sheets"), { recursive: true });
  for (const [name, values] of Object.entries(sheets)) {
    const out = fs.createWriteStream(path.join(dir, "sheets", name + ".ndjson"), { encoding: "utf8" });
    for (const row of values) if (!out.write(JSON.stringify(row) + "\n")) await new Promise((r) => out.once("drain", r));
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  }
  await fsp.writeFile(path.join(dir, "groups.json"), JSON.stringify(groups));
}

export class FileSupplierSource {
  constructor(file) { this.file = file; }
  chunks() { return fs.createReadStream(this.file, { highWaterMark: 1 << 20 }); }
}

/** Реальний постачальник (HTTP). Адреса — лише із секрету середовища; у звіти не потрапляє.
 *  Як у Code.gs: без редиректів, потрібен рівно HTTP 200. */
export class HttpSupplierSource {
  /** timeoutMs — межа на весь запит разом із тілом; maxBytes — зупинка ще під час завантаження (не після). */
  constructor(url, { timeoutMs = 120000, maxBytes = 90_000_000, fetchImpl = globalThis.fetch } = {}) {
    this.url = url; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes; this.fetch = fetchImpl;
    this.bytes = 0;
  }
  async *chunks() {
    let response;
    try {
      response = await this.fetch(this.url, { redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      // Повідомлення Node/undici не містить адреси в .message, але не покладаємося: лише тип помилки.
      throw new Error(e?.name === "TimeoutError" || e?.name === "AbortError" ? "Фід постачальника: перевищено час очікування" : "Фід постачальника недоступний (мережа)");
    }
    if (response.status !== 200) throw new Error("HTTP " + response.status);
    try {
      for await (const chunk of response.body) {
        this.bytes += chunk.byteLength;
        if (this.bytes > this.maxBytes) throw new Error("Фід перевищує безпечний розмір");
        yield Buffer.from(chunk);
      }
    } catch (e) {
      if (/безпечний розмір/.test(e.message)) throw e;
      throw new Error(e?.name === "TimeoutError" || e?.name === "AbortError" ? "Фід постачальника: перевищено час очікування" : "Фід постачальника: обрив передачі");
    }
  }
}
