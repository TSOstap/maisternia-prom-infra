/** Тест запису в ТЕСТОВУ КОПІЮ Google Sheets (етап 1 дозволу власника 30.10): ОДИН тимчасовий аркуш, синтетичні рядки, видалення
 *  лише цього аркуша за sheetId. Вихідні 8 аркушів не пишуться.
 *
 *  Порядок:
 *   1. токен читання (readonly) і ОКРЕМИЙ короткоживучий токен запису (scope spreadsheets) — mm-sheets-copy, без JSON-ключа;
 *      scope кожного перевірено tokeninfo;
 *   2. перевірки до запису: точний ID, точна назва, рівно 8 вихідних аркушів (назви); відбиток кожного аркуша (усі значення,
 *      sheetId, розміри сітки);
 *   3. запис 1 — addSheet (унікальна назва, якої ще немає); запис 2 — values.update лише в діапазон цього аркуша;
 *   4. читання назад і точна звірка;
 *   5. запис 3 — deleteSheet лише за створеним sheetId (перед цим — перевірка, що sheetId має саме нашу назву);
 *   6. після: рівно ті самі 8 аркушів (назви, sheetId, сітка) і ті самі відбитки значень.
 *  Будь-яка помилка або розбіжність → ЗУПИНКА без подальших записів (і без прибирання): звіт з назвою / sheetId тимчасового аркуша.
 *  Вивід — агрегати й відбитки, без токенів і Offer ID.
 *
 *  node tools/copy-write-probe.mjs [--out=<звіт.json>]   Коди: 0 — PASS; 1 — розбіжність / зупинка; 2 — відмова до запису. */
import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { TEST_SHEET_ID, READONLY, READWRITE, obtainToken, assertTokenScope } from "./copy-access-check.mjs";
import { GoogleSheetsCatalogSource } from "../src/pipeline/google-sheets.mjs";

export const EXPECTED_TITLE = "Інструменти — ТЕСТ нової системи";
export const ORIGINAL_SHEETS = Object.freeze(["Основний каталог", "Нові товари", "Аудит", "Відкладені товари", "Групи", "Налаштування", "Заморожені ID", "Журнал"]);
const API = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(TEST_SHEET_ID);
const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const q = (title) => `'${String(title).replace(/'/g, "''")}'`;

export function syntheticRows(tag) {
  const header = ["Тест", "Рядок", "Текст", "Число", "Дата", "Позначка"];
  const rows = Array.from({ length: 8 }, (_, i) => [tag, i + 1, `Синтетичний рядок ${i + 1} — не товар`, Math.round((i + 1) * 12.5 * 100) / 100, "2026-10-30", i % 2 ? "так" : "ні"]);
  return [header, ...rows];
}

/** Обгортка запитів: лише тестова копія; запис — лише дозволені операції над створеним аркушем. */
function client({ readToken, writeToken, fetchImpl }) {
  const state = { created: null, writes: [], reads: 0 };
  const call = async (token, method, url, body) => {
    if (!url.startsWith(API)) throw new Error("запит не до тестової копії — відмова");
    const res = await fetchImpl(url, { method, headers: { Authorization: "Bearer " + token, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    if (!res.ok) { let s = ""; try { s = JSON.parse(text)?.error?.status || ""; } catch { /* */ } throw new Error(`Sheets API ${method} HTTP ${res.status} ${s}`.trim()); }
    return text ? JSON.parse(text) : {};
  };
  return {
    state,
    async meta() { state.reads++; return call(readToken, "GET", API + "?fields=" + encodeURIComponent("spreadsheetId,properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))")); },
    async readRange(range) { state.reads++; return call(readToken, "GET", API + "/values/" + encodeURIComponent(range) + "?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS"); },
    async addSheet(title) {
      if (state.created) throw new Error("тимчасовий аркуш уже створено — другий заборонено");
      const r = await call(writeToken, "POST", API + ":batchUpdate", { requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 20, columnCount: 6 } } } }] });
      const p = r?.replies?.[0]?.addSheet?.properties;
      if (!p || p.title !== title || !Number.isInteger(p.sheetId)) throw new Error("addSheet: відповідь без sheetId / з іншою назвою");
      state.created = { sheetId: p.sheetId, title };
      state.writes.push({ op: "addSheet", sheetId: p.sheetId });
      return state.created;
    },
    async writeValues(values) {
      if (!state.created) throw new Error("запис значень без створеного тимчасового аркуша — відмова");
      const range = `${q(state.created.title)}!A1:F${values.length}`;
      const r = await call(writeToken, "PUT", API + "/values/" + encodeURIComponent(range) + "?valueInputOption=RAW", { range, majorDimension: "ROWS", values });
      state.writes.push({ op: "values.update", sheetId: state.created.sheetId, cells: r?.updatedCells ?? null });
      return range;
    },
    async deleteCreated() {
      if (!state.created) throw new Error("немає створеного аркуша — видаляти нічого");
      const m = await this.meta();
      const s = (m.sheets || []).find((x) => x.properties.sheetId === state.created.sheetId);
      if (!s || s.properties.title !== state.created.title) throw new Error("sheetId не відповідає створеному аркушу — видалення заборонено");
      if (ORIGINAL_SHEETS.includes(s.properties.title)) throw new Error("спроба видалити вихідний аркуш — відмова");
      await call(writeToken, "POST", API + ":batchUpdate", { requests: [{ deleteSheet: { sheetId: state.created.sheetId } }] });
      state.writes.push({ op: "deleteSheet", sheetId: state.created.sheetId });
    },
  };
}

const layout = (m) => (m.sheets || []).map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title, index: s.properties.index, rows: s.properties.gridProperties?.rowCount, cols: s.properties.gridProperties?.columnCount }));
/** Відбиток значень кожного вихідного аркуша (повне читання лише токеном readonly). */
async function fingerprints(readToken, fetchImpl) {
  const src = new GoogleSheetsCatalogSource({ spreadsheetId: TEST_SHEET_ID, getAccessToken: async () => readToken, fetchImpl, maxRequests: 150 });
  const loaded = await src.load([...ORIGINAL_SHEETS]);
  const out = {};
  for (const s of ORIGINAL_SHEETS) { const v = s === "Групи" ? loaded.groups : loaded.sheets[s]; out[s] = { sha: sha(v), rows: v?.length ?? 0 }; }
  return { sheets: out, requests: src.metrics.requests };
}

export async function runProbe({ fetchImpl = fetch, tokens = null, now = () => new Date() } = {}) {
  const report = { at: now().toISOString(), stage: "init", ok: false, writes: [], reads: 0 };
  const readToken = tokens?.read ?? await obtainToken({ fetchImpl });
  const writeToken = tokens?.write ?? await obtainToken({ fetchImpl, scope: READWRITE });
  report.tokens = { read: (await assertTokenScope(readToken, READONLY, fetchImpl)).scopes, write: (await assertTokenScope(writeToken, READWRITE, fetchImpl)).scopes };
  const c = client({ readToken, writeToken, fetchImpl });
  const stop = (stage, reason) => { Object.assign(report, { stage, ok: false, stopped: reason, writes: c.state.writes, reads: c.state.reads, leftover: c.state.created && !c.state.writes.some((w) => w.op === "deleteSheet") ? c.state.created : null }); return report; };

  // 2. Перевірки до запису.
  report.stage = "precheck";
  const m0 = await c.meta();
  if (m0.spreadsheetId !== TEST_SHEET_ID) return stop("precheck", "ID таблиці не збігається");
  if (m0.properties?.title !== EXPECTED_TITLE) return stop("precheck", "назва таблиці не збігається");
  const l0 = layout(m0);
  if (l0.length !== ORIGINAL_SHEETS.length || ORIGINAL_SHEETS.some((t) => !l0.some((s) => s.title === t))) return stop("precheck", `очікувано рівно ${ORIGINAL_SHEETS.length} вихідних аркушів`);
  report.title = m0.properties.title;
  report.sheetsBefore = l0.length;
  const f0 = await fingerprints(readToken, fetchImpl);
  report.fingerprintRequests = f0.requests;

  // 3. Тимчасовий аркуш з унікальною назвою.
  const tag = "ENG-ТЕСТ-ЗАПИСУ-" + now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + crypto.randomBytes(3).toString("hex");
  if (l0.some((s) => s.title === tag)) return stop("precheck", "назва тимчасового аркуша вже існує");
  report.stage = "write";
  try { await c.addSheet(tag); } catch (e) { return stop("addSheet", e.message); }
  report.temp = { title: tag, sheetId: c.state.created.sheetId };
  const values = syntheticRows(tag);
  let range;
  try { range = await c.writeValues(values); } catch (e) { return stop("values.update", e.message); }

  // 4. Читання назад і звірка.
  report.stage = "readback";
  let back;
  try { back = (await c.readRange(range)).values || []; } catch (e) { return stop("readback", e.message); }
  const same = JSON.stringify(back) === JSON.stringify(values);
  report.readback = { rows: back.length, expectedRows: values.length, equal: same };
  if (!same) return stop("readback", "прочитане не збігається із записаним");

  // 5. Видалення лише створеного аркуша.
  report.stage = "delete";
  try { await c.deleteCreated(); } catch (e) { return stop("deleteSheet", e.message); }

  // 6. Після: ті самі 8 аркушів і ті самі значення.
  report.stage = "postcheck";
  const m1 = await c.meta();
  const l1 = layout(m1);
  const layoutSame = JSON.stringify(l1) === JSON.stringify(l0);
  const f1 = await fingerprints(readToken, fetchImpl);
  const changed = ORIGINAL_SHEETS.filter((s) => f1.sheets[s].sha !== f0.sheets[s].sha);
  report.after = { sheets: l1.length, layoutSame, valuesChanged: changed, rows: Object.fromEntries(ORIGINAL_SHEETS.map((s) => [s, f1.sheets[s].rows])) };
  report.writes = c.state.writes;
  report.reads = c.state.reads;
  if (!layoutSame || changed.length) return stop("postcheck", !layoutSame ? "склад / порядок / сітка аркушів змінились" : "значення вихідних аркушів змінились: " + changed.join(", "));
  Object.assign(report, { stage: "done", ok: true });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  let report;
  try { report = await runProbe(); }
  catch (e) { process.stderr.write("ПОМИЛКА (до запису або під час читання): " + String(e?.message || e).replace(/ya29\.[A-Za-z0-9._-]+/g, "***") + "\n"); process.exit(2); }
  const text = JSON.stringify(report, null, 2);
  if (/ya29\./.test(text)) { process.stderr.write("ЗАХИСТ ВІД ВИТОКУ: вивід заблоковано\n"); process.exit(2); }
  if (arg("out")) fs.writeFileSync(arg("out"), text);
  process.stdout.write(text + "\n");
  process.exit(report.ok ? 0 : 1);
}
