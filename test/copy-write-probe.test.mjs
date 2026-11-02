/** Етап 1 (тест запису в копію): запобіжники copy-write-probe на двійнику Google Sheets (без мережі). */
import test from "node:test";
import assert from "node:assert/strict";
import { runProbe, ORIGINAL_SHEETS, EXPECTED_TITLE } from "../tools/copy-write-probe.mjs";
import { TEST_SHEET_ID, READONLY, READWRITE } from "../tools/copy-access-check.mjs";

const colIdx = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
/** Двійник: аркуші з даними, sheetId, batchUpdate (addSheet / deleteSheet), values GET / PUT, batchGet, tokeninfo. */
function fakeGoogle({ title = EXPECTED_TITLE, extraSheet = false, corruptWrite = false, mutateOriginal = false, writeScope = READWRITE } = {}) {
  const sheets = ORIGINAL_SHEETS.map((t, i) => ({ sheetId: 100 + i, title: t, index: i, values: [["Offer ID", "Поле"], [`${i}1`, "a"], [`${i}2`, "b"]] }));
  if (extraSheet) sheets.push({ sheetId: 999, title: "Зайвий", index: 8, values: [] });
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const parseRange = (r) => { const m = /^'((?:[^']|'')+)'!(?:A(\d+):([A-Z]+)(\d+)|(\d+):(\d+))$/.exec(r); return m ? { title: m[1].replace(/''/g, "'"), from: Number(m[2] ?? m[5]), to: Number(m[4] ?? m[6]), cols: m[3] ? colIdx(m[3]) : 99 } : null; };
  const slice = (r) => { const p = parseRange(r); const s = sheets.find((x) => x.title === p.title); return (s?.values || []).slice(p.from - 1, p.to).map((row) => row.slice(0, p.cols)); };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)), method = init.method || "GET";
    calls.push({ method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    if (u.host === "oauth2.googleapis.com") return ok({ scope: u.searchParams.get("access_token") === "W" ? writeScope : READONLY, exp: String(Math.round(Date.now() / 1000) + 3000) });
    if (!u.pathname.includes(TEST_SHEET_ID)) return { ok: false, status: 404, text: async () => "{}" };
    if (method === "POST" && u.pathname.endsWith(":batchUpdate")) {
      const rq = JSON.parse(init.body).requests[0];
      if (rq.addSheet) { const p = { sheetId: 555, title: rq.addSheet.properties.title, index: sheets.length, gridProperties: { rowCount: 20, columnCount: 6 } }; sheets.push({ ...p, values: [] }); if (mutateOriginal) sheets[0].values[1][1] = "ЗМІНЕНО"; return ok({ replies: [{ addSheet: { properties: p } }] }); }
      if (rq.deleteSheet) { const i = sheets.findIndex((s) => s.sheetId === rq.deleteSheet.sheetId); sheets.splice(i, 1); return ok({ replies: [{}] }); }
    }
    if (method === "PUT") { const b = JSON.parse(init.body); const p = parseRange(b.range); const s = sheets.find((x) => x.title === p.title); s.values = structuredClone(b.values); if (corruptWrite) s.values[2][2] = "інше"; return ok({ updatedCells: b.values.flat().length }); }
    if (u.pathname.endsWith("/values:batchGet")) return ok({ valueRanges: u.searchParams.getAll("ranges").map((r) => ({ values: slice(r) })) });
    if (u.pathname.includes("/values/")) return ok({ values: slice(decodeURIComponent(u.pathname.split("/values/")[1])) });
    const fields = u.searchParams.get("fields") || "";
    return ok({ spreadsheetId: TEST_SHEET_ID, properties: { title }, sheets: sheets.map((s) => ({ properties: { sheetId: s.sheetId, title: s.title, index: s.index, gridProperties: { rowCount: fields.includes("sheetId") ? 1000 : Math.max(1, s.values.length), columnCount: fields.includes("sheetId") ? 26 : 2 } } })) });
  };
  return { fetchImpl, calls, sheets };
}
const writes = (calls) => calls.filter((c) => c.method !== "GET");
const tokens = { read: "R", write: "W" };

test("PASS: один тимчасовий аркуш, синтетичні рядки збігаються, видалено лише його sheetId; 8 аркушів і значення ті самі", async () => {
  const g = fakeGoogle();
  const r = await runProbe({ fetchImpl: g.fetchImpl, tokens });
  assert.equal(r.ok, true, JSON.stringify(r));
  const w = writes(g.calls);
  assert.deepEqual(w.map((c) => c.body?.requests?.[0] ? Object.keys(c.body.requests[0])[0] : "values.update"), ["addSheet", "values.update", "deleteSheet"]);
  assert.equal(w[2].body.requests[0].deleteSheet.sheetId, r.temp.sheetId);
  assert.ok(w[1].body.range.startsWith(`'${r.temp.title}'!`), "значення — лише в тимчасовий аркуш");
  assert.deepEqual(r.after.valuesChanged, []);
  assert.equal(r.after.sheets, 8);
});
test("Зупинка до запису: зайвий аркуш / інша назва таблиці / токен запису з іншим scope", async () => {
  for (const opt of [{ extraSheet: true }, { title: "Інструмент — Майстерня Маркет" }]) {
    const g = fakeGoogle(opt);
    const r = await runProbe({ fetchImpl: g.fetchImpl, tokens });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "precheck");
    assert.equal(writes(g.calls).length, 0, "жодного запису");
  }
  const g = fakeGoogle({ writeScope: `${READWRITE} https://www.googleapis.com/auth/drive` });
  await assert.rejects(runProbe({ fetchImpl: g.fetchImpl, tokens }), /scope/);
  assert.equal(writes(g.calls).length, 0);
});
test("Розбіжність читання назад — зупинка БЕЗ подальших записів (без видалення); звіт називає тимчасовий аркуш", async () => {
  const g = fakeGoogle({ corruptWrite: true });
  const r = await runProbe({ fetchImpl: g.fetchImpl, tokens });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "readback");
  assert.equal(writes(g.calls).length, 2, "addSheet + values.update, deleteSheet — ні");
  assert.deepEqual(r.leftover, r.temp);
});
test("Після видалення вихідні значення змінились (чужа правка) — FAIL з назвою аркуша, без нових записів", async () => {
  const g = fakeGoogle({ mutateOriginal: true });
  const r = await runProbe({ fetchImpl: g.fetchImpl, tokens });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "postcheck");
  assert.deepEqual(r.after.valuesChanged, ["Основний каталог"]);
  assert.equal(writes(g.calls).length, 3);
});
