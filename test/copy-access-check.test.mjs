/** ENG-14: запобіжники перевірки підключення до тестової копії (двійник мережі; справжніх запитів немає). */
import test from "node:test";
import assert from "node:assert/strict";
import { checkCopy, obtainToken, TEST_SHEET_ID, COPY_SA, READONLY } from "../tools/copy-access-check.mjs";

/** Двійник Google: tokeninfo + Sheets GET; записує кожен запит (метод, адреса). */
function google({ scope = READONLY, title = "Інструменти — ТЕСТ нової системи" } = {}) {
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if (String(url).startsWith("https://oauth2.googleapis.com/tokeninfo")) return ok({ scope, exp: String(Math.round(Date.now() / 1000) + 3599) });
    if (String(url).includes("/values:batchGet")) return ok({ valueRanges: [{ values: [["Offer ID", "ID постачальника"]] }, { values: [["1"], ["2"]] }, { values: [["Offer ID"]] }, { values: [["3"]] }, { values: [["Offer ID"]] }, { values: [] }, { values: [["Offer ID"]] }, { values: [["1"], ["2"], ["3"]] }] });
    return ok({ properties: { title }, sheets: ["Основний каталог", "Нові товари", "Відкладені товари", "Заморожені ID", "Групи"].map((t) => ({ properties: { title: t } })) });
  };
  return { calls, fetchImpl };
}

test("Підключення: лише GET до тестової копії; токен — рівно readonly; вивід — агрегати без ID", async () => {
  const g = google();
  const r = await checkCopy({ token: "ya29.test", fetchImpl: g.fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(g.calls.every((c) => c.method === "GET"), "жодного запису");
  assert.ok(g.calls.filter((c) => c.url.startsWith("https://sheets.googleapis.com/")).every((c) => c.url.includes(TEST_SHEET_ID)), "лише тестова копія");
  assert.deepEqual(r.perSheet["Основний каталог"], { columns: 2, ids: 2, unique: 2 });
  assert.doesNotMatch(JSON.stringify(r), /ya29/);
});
test("Відмова: токен ширший за readonly (може писати) — до читання таблиці", async () => {
  for (const scope of ["https://www.googleapis.com/auth/spreadsheets", `${READONLY} https://www.googleapis.com/auth/cloud-platform`]) {
    const g = google({ scope });
    await assert.rejects(checkCopy({ token: "ya29.test", fetchImpl: g.fetchImpl }), /не лише readonly/);
    assert.ok(!g.calls.some((c) => c.url.startsWith("https://sheets.googleapis.com/")), "Sheets не викликано");
  }
});
test("Відмова: назва таблиці без «ТЕСТ» — значення не читаються", async () => {
  const g = google({ title: "Інструмент — Майстерня Маркет" });
  await assert.rejects(checkCopy({ token: "ya29.test", fetchImpl: g.fetchImpl }), /ТЕСТ/);
  assert.ok(!g.calls.some((c) => c.url.includes("values")));
});
test("Токен: вхід gcloud → generateAccessToken для mm-sheets-copy лише зі scope readonly; 403 — зрозуміла відмова без токенів у тексті", async () => {
  let seen = null, call = null;
  const run = (cmd, args) => { seen = [cmd, ...args]; return { status: 0, stdout: "ya29.USER\n", stderr: "" }; };
  const fetchImpl = async (url, init) => { call = { url: String(url), init }; return { ok: true, status: 200, text: async () => JSON.stringify({ accessToken: "ya29.SA", expireTime: "2026-10-30T12:00:00Z" }) }; };
  assert.equal(await obtainToken({ env: {}, run, fetchImpl }), "ya29.SA");
  assert.deepEqual(seen, ["gcloud", "auth", "print-access-token"]);
  assert.equal(call.url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${COPY_SA}:generateAccessToken`);
  assert.equal(call.init.method, "POST");
  assert.deepEqual(JSON.parse(call.init.body), { scope: [READONLY] });
  const denied = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Permission 'iam.serviceAccounts.getAccessToken' denied (ya29.LEAK)" } }) });
  await assert.rejects(obtainToken({ env: {}, run, fetchImpl: denied }), (e) => /Token Creator/.test(e.message) && !/ya29\.LEAK/.test(e.message));
  await assert.rejects(obtainToken({ env: {}, run: () => ({ status: 1, stdout: "", stderr: "You do not currently have an active account selected." }) }), /gcloud auth login/);
});
