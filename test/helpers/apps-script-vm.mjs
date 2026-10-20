/** Запуск справжнього живого Apps Script (reference/apps-script-live) у node:vm з офлайн-заглушками Google.
 *  Заглушки дат реалізовані НЕЗАЛЕЖНО від src/core/time.mjs (інший шлях через toLocaleString), щоб паритет був чесним. */
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const refDir = path.join(here, "..", "..", "reference", "apps-script-live");

export const LIVE_FILES = ["Code.LIVE-CURRENT.gs", "Management.LIVE-CURRENT.gs", "Yml.LIVE-CURRENT.gs"];

function kyivWall(date, tz) {
  // 'sv-SE' дає 'YYYY-MM-DD HH:mm:ss'
  return new Date(date).toLocaleString("sv-SE", { timeZone: tz, hourCycle: "h23" });
}

const Utilities = {
  DigestAlgorithm: { SHA_256: "SHA_256" },
  Charset: { UTF_8: "UTF_8" },
  computeDigest(alg, text) {
    if (alg !== "SHA_256") throw new Error("stub: alg");
    return Array.from(crypto.createHash("sha256").update(text, "utf8").digest()).map((b) => (b > 127 ? b - 256 : b));
  },
  formatDate(date, tz, pattern) {
    if (pattern !== "yyyy-MM-dd HH:mm" && pattern !== "dd.MM.yyyy HH:mm:ss") throw new Error("stub: pattern " + pattern);
    const s = kyivWall(date, tz);
    if (pattern === "yyyy-MM-dd HH:mm") return s.slice(0, 16);
    return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} ${s.slice(11, 19)}`;
  },
  parseDate(text, tz, pattern) {
    if (pattern !== "yyyy-MM-dd HH:mm") throw new Error("stub: pattern");
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(text));
    if (!m) throw new Error("Unparseable date");
    const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    // Перебір можливих зсувів поясу: перший, що дає ту саму «настінну» дату.
    for (let h = -14; h <= 14; h++) {
      const t = naive - h * 3600000;
      if (kyivWall(t, tz).slice(0, 16) === `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`) return new Date(t);
    }
    throw new Error("Unparseable date");
  },
  getUuid: () => crypto.randomUUID(),
};

export function loadLiveAppsScript() {
  const context = {
    console: { log() {}, warn() {} },
    Utilities,
    PropertiesService: { getScriptProperties: () => { throw new Error("stub: PropertiesService не використовується в паритеті"); } },
  };
  vm.createContext(context);
  for (const f of LIVE_FILES) vm.runInContext(fs.readFileSync(path.join(refDir, f), "utf8"), context, { filename: f });
  return context;
}

export const plain = (v) => JSON.parse(JSON.stringify(v));
