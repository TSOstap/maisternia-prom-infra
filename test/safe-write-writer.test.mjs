/** E1 (ENG-01 K1): безпечні повтори запитів Google Sheets API — справжній GoogleSheetsWriter із підробленим транспортом (fake fetch).
 *  Сервер-імітація застосовує запити до власної таблиці й уміє: втратити відповідь ПІСЛЯ застосування, тайм-аут ДО застосування,
 *  відповісти 429 / 5xx / 400. Перевіряється: запис не повторюється наосліп, дублів і видалення сусідів немає, стани
 *  APPLIED / NOT_APPLIED / UNKNOWN, часткове виконання, fence, незмінність політики. */
import test from "node:test";
import assert from "node:assert/strict";
import { GoogleSheetsWriter } from "../src/pipeline/sheets-writer.mjs";
import { OUTCOME, WriteOutcomeError, outcomeOf } from "../src/pipeline/write-outcome.mjs";

const COPY = "COPY_SHEET_ID_0123456789abcdefXYZ", LIVE = "LIVE_SHEET_ID_0123456789abcdefXYZ";

/** Сервер: аркуш «A» (рядки), черга режимів відповіді на кожен запит. */
function server(rows = [["Offer ID", "Ціна"], ["1", "10"], ["2", "20"], ["3", "30"]]) {
  const st = { rows: rows.map((r) => r.slice()), modes: [], calls: [] };
  const apply = (url, init) => {
    const u = new URL(url), body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname.endsWith(":append")) for (const r of body.values) st.rows.push(r.slice());
    else if (u.pathname.endsWith("/values:batchUpdate")) for (const d of body.data) {
      const m = /!([A-Z]+)(\d+):/.exec(d.range); const row = Number(m[2]);
      d.values.forEach((r, i) => { st.rows[row - 1 + i] = r.slice(); });
    } else if (u.pathname.endsWith(":batchUpdate")) for (const q of body.requests) if (q.deleteDimension) st.rows.splice(q.deleteDimension.range.startIndex, 1);
  };
  const fetchImpl = async (url, init) => {
    st.calls.push({ method: init.method, path: new URL(url).pathname });
    const mode = st.modes.shift() || "ok";
    if (init.method === "GET") {
      if (mode === "503") return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({ sheets: [{ properties: { title: "A", sheetId: 7, gridProperties: { rowCount: 100, columnCount: 5 } } }] }), { status: 200 });
    }
    if (mode === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    if (mode === "lost") { apply(url, init); throw new TypeError("fetch failed"); }
    if (mode === "503") return new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), { status: 503 });
    if (mode === "503-applied") { apply(url, init); return new Response("{}", { status: 503 }); }
    if (mode === "429") return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
    if (mode === "400") return new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }), { status: 400 });
    apply(url, init);
    return new Response("{}", { status: 200 });
  };
  return { st, fetchImpl };
}
const writer = (fetchImpl, o = {}) => new GoogleSheetsWriter({ spreadsheetId: COPY, liveSpreadsheetId: LIVE, getAccessToken: async () => "t", fetchImpl, sleep: async () => {}, random: () => 0, ...o });
const writes = (st) => st.calls.filter((c) => c.method === "POST").length;

test("E1: 503 на запис — без повтору, UNKNOWN; 400 — NOT_APPLIED; 429 — UNKNOWN (не гарантовано незастосований)", async () => {
  for (const [mode, outcome] of [["503", OUTCOME.UNKNOWN], ["400", OUTCOME.NOT_APPLIED], ["429", OUTCOME.UNKNOWN], ["timeout", OUTCOME.UNKNOWN]]) {
    const { st, fetchImpl } = server();
    st.modes = [mode];
    const w = writer(fetchImpl);
    await assert.rejects(w.updateRanges([{ title: "A", row: 2, col: 2, values: [["11"]] }]), (e) => e instanceof WriteOutcomeError && e.outcome === outcome, mode);
    assert.equal(writes(st), 1, `${mode}: рівно один запит запису — без автоповтору`);
    assert.equal(w.metrics.retries, 0, mode);
  }
});

test("E1: втрачена відповідь на append — UNKNOWN, рядок дописано РІВНО раз (без дубля від повтору)", async () => {
  const { st, fetchImpl } = server();
  st.modes = ["lost"];
  const w = writer(fetchImpl);
  const e = await w.appendRows("A", [["4", "40"]]).catch((x) => x);
  assert.equal(outcomeOf(e), OUTCOME.UNKNOWN);
  assert.equal(st.rows.filter((r) => r[0] === "4").length, 1, "рядок застосовано один раз");
  assert.equal(writes(st), 1);
});

test("E1: 5xx ПІСЛЯ застосування append — UNKNOWN, дубля немає (старий код повторив би й дописав двічі)", async () => {
  const { st, fetchImpl } = server();
  st.modes = ["503-applied", "ok", "ok", "ok"];
  const w = writer(fetchImpl);
  const e = await w.appendRows("A", [["4", "40"]]).catch((x) => x);
  assert.equal(outcomeOf(e), OUTCOME.UNKNOWN);
  assert.equal(st.rows.filter((r) => r[0] === "4").length, 1);
});

test("E1: втрачена відповідь на deleteRows — без повтору; сусідній рядок не видалено", async () => {
  const { st, fetchImpl } = server();
  st.modes = ["ok", "lost"]; // GET meta, потім POST
  const w = writer(fetchImpl);
  const e = await w.deleteRows("A", [2]).catch((x) => x);
  assert.equal(outcomeOf(e), OUTCOME.UNKNOWN);
  assert.deepEqual(st.rows.map((r) => r[0]), ["Offer ID", "2", "3"], "видалено лише рядок 2; повтор видалив би й «2»");
  assert.equal(writes(st), 1);
});

test("E1: читання повторюється з паузою (503, 503 → 200); запис — ні; політики незмінні (сценарій P3)", async () => {
  const { st, fetchImpl } = server();
  st.modes = ["503", "503", "ok"];
  const w = writer(fetchImpl);
  const m = await w.meta();
  assert.equal(m[0].title, "A");
  assert.equal(w.metrics.retries, 2);
  assert.ok(Object.isFrozen(w.policies) && Object.isFrozen(w.policies.write) && Object.isFrozen(w.policies.read));
  assert.equal(w.policies.write.maxAttempts, 1);
  assert.throws(() => { w.policies.write.maxAttempts = 4; }, TypeError, "політику не можна змінити ззовні");
  // Паралельно: читання з повторами і запис з 503 — запис усе одно без повтору.
  const s2 = server();
  s2.st.modes = ["503", "503", "ok"]; // перші два — читання (meta) і запис отримають у порядку виклику
  const w2 = writer(s2.fetchImpl);
  const [rd, wr] = await Promise.allSettled([w2.meta(), w2.updateRanges([{ title: "A", row: 2, col: 2, values: [["99"]] }])]);
  assert.equal(rd.status, "fulfilled");
  assert.equal(wr.status, "rejected");
  assert.equal(s2.st.calls.filter((c) => c.method === "POST").length, 1, "запис — одна спроба");
});

test("E1: межі порцій — 3 запити; збій 2-го (503) → UNKNOWN, appliedParts 1 / 3, 3-й не відправлено", async () => {
  const { st, fetchImpl } = server([["Offer ID", "Ціна"], ...Array.from({ length: 30 }, (_, i) => [String(i + 1), "x"])]);
  st.modes = ["ok", "503"];
  const w = writer(fetchImpl, { maxChunkChars: 120 });
  const values = Array.from({ length: 30 }, (_, i) => [String(i + 1), "новий-текст-" + i]);
  const e = await w.updateRanges([{ title: "A", row: 2, col: 1, values }]).catch((x) => x);
  assert.equal(outcomeOf(e), OUTCOME.UNKNOWN);
  assert.equal(e.appliedParts, 1);
  assert.ok(e.totalParts >= 3, String(e.totalParts));
  assert.equal(writes(st), 2, "після невідомого результату решта порцій не відправляється");
});

test("E1: fence — застаріла оренда: запит НЕ відправлено (NOT_APPLIED); межа запитів — NOT_APPLIED", async () => {
  const { st, fetchImpl } = server();
  const w = writer(fetchImpl, { fence: { assertCurrent: async () => { throw Object.assign(new Error("STALE"), { code: "STALE" }); } } });
  const e = await w.updateRanges([{ title: "A", row: 2, col: 2, values: [["1"]] }]).catch((x) => x);
  assert.equal(outcomeOf(e), OUTCOME.NOT_APPLIED);
  assert.equal(e.code, "STALE");
  assert.equal(writes(st), 0);
  const w2 = writer(fetchImpl, { maxRequests: 0 });
  assert.equal(outcomeOf(await w2.appendRows("A", [["9", "9"]]).catch((x) => x)), OUTCOME.NOT_APPLIED);
});

test("E1: успіх — APPLIED з кількістю запитів; аргументи скопійовано до відправлення (getter не змінить призначення, R3-F4)", async () => {
  const { st, fetchImpl } = server();
  const w = writer(fetchImpl);
  let n = 0;
  const block = { get title() { n++; return n === 1 ? "A" : "Основний каталог"; }, row: 2, col: 2, values: [["77"]] };
  const r = await w.updateRanges([block]);
  assert.equal(r.outcome, OUTCOME.APPLIED);
  assert.equal(n, 1, "призначення прочитано один раз");
  assert.equal(st.rows[1][0], "77");
});
