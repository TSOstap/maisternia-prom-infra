/** Catalog Controls R7.1 — регресії попереднього ревю Hermes R7 (preliminary-20261030T012451):
 *  P1 — після витіснення першого коду з обмеженої історії prev (17 перевидач) видача №18 для іншої фізичної ідентичності повторювала
 *       старий код, і незмінна стара команда власника ставала чинною; так само — стара команда, вписана повторно після такої видачі;
 *       після відновлення старішої контрольної точки номер видачі повторюється — нова видача не має дорівнювати коду в клітинці;
 *  P2 — непорожній рядок «Видалених товарів» без Offer ID мовчки зникав із захисту (UNREGISTERED), зокрема в нечитабельному архіві.
 *  Тести контрприкладів викликають лише API R7 — запускаються й на замороженому R7 (змістовний RED, не помилка імпорту). */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { SEAL_COLUMN, rowSeal } from "../src/core/seal.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { ACTION, ARCHIVE_SHEET, SALE_DECISION, SEO_DECISION, confirmationCode, identityOf } from "../src/core/controls-common.mjs";
import { seoSha, seoValues } from "../src/core/controls-seo.mjs";
import { controlsState } from "../src/core/controls-plan.mjs";
import { CHECKPOINT_KEY } from "../src/pipeline/controls-run.mjs";
import { ACTIVE_CONTRACT, prepared, setCells, codeOf, rowOf, later, viewOf, mainIds, history } from "./helpers/controls.mjs";
import { HOLD, ID, ID2, RELEASE, apply, col, confirmR, cpOf, readinessDouble, stateOf } from "./helpers/controls-r3.mjs";

const SEO = { "SEO заголовок UA": "Незалежний тест українською", "SEO заголовок RU": "Независимый тест заголовка", "SEO опис UA": "Незалежний опис для тесту підтвердження", "SEO опис RU": "Независимое описание для теста подтверждения" };
const DEL = `ВИДАЛИТИ ТОВАР ${ID}`, BACK = `ПОВЕРНУТИ З АРХІВУ ${ID}`;
function reseal(w, id = ID, sheet = SHEET.main) {
  const v = w.book[sheet], h = v[0].map(mtText), i = v.findIndex((r, k) => k > 0 && mtText(r[0]) === id);
  v[i][h.indexOf(SEAL_COLUMN)] = rowSeal(Object.fromEntries(h.map((k, j) => [k, v[i][j] ?? ""])));
}
const issueOf = (R, action = "SEO_APPROVE") => (cpOf(R)?.issued || []).find((x) => x.action === action && x.offerId === ID);
const copyRow = (book, id, from, to) => { if (!book[to]?.length) book[to] = [book[from][0].slice()]; book[to].push(book[from].find((r, k) => k > 0 && r[0] === id).slice()); };
const dropRow = (book, id, sheet) => { book[sheet] = book[sheet].filter((r, k) => !k || r[0] !== id); };
const offerOf = (row) => ({ id: row["ID постачальника"], sku: row["Артикул постачальника"], nameUa: row["Назва постачальника UA"], nameRu: row["Назва постачальника RU"], url: row["URL постачальника"] });
const rowRef = (n) => new RegExp(`«${ARCHIVE_SHEET}», рядок ${n}`);

// ---------------------------------------------------------------- P1 — повторне використання коду після витіснення з prev
/** Фікстура Hermes R7-P1: артикул A (видача №0) і артикул B (видача №18), для яких формула кодів R7 дає той самий 24-бітний код. */
function recycledPair(w) {
  const original = identityOf(rowOf(w, ID)), payload = seoSha(seoValues(rowOf(w, ID))), first = new Map();
  for (let i = 0; i < 20000; i++) {
    const a = { ...original, sku: "H7-PREV-A-" + i };
    first.set(confirmationCode({ offerId: ID, identity: a, action: "SEO_APPROVE", revision: "0", payload }), a);
  }
  for (let i = 0; i < 200000; i++) {
    const b = { ...original, sku: "H7-PREV-B-" + i };
    const code = confirmationCode({ offerId: ID, identity: b, action: "SEO_APPROVE", revision: "0", payload, nonce: 18 });
    if (first.has(code)) return { a: first.get(code), b, code };
  }
  throw new Error("фікстуру колізії не знайдено");
}
/** Видача №0 для A; власник вписав «ЗАТВЕРДИТИ <код №0>» і більше не підтверджував; 17 законних перевидач (правки чернетки). */
async function seventeenReissues() {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, SEO);
  const pair = recycledPair(w);
  setCells(w, ID, { "Артикул постачальника": pair.a.sku, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); reseal(w);
  await apply(w, R);
  const c0 = codeOf(w, ID, "ЗАТВЕРДИТИ");
  assert.ok(c0 && issueOf(R).n === 0, "передумова: видача №0 для A");
  const old = "ЗАТВЕРДИТИ " + c0;
  setCells(w, ID, { [SEO_DECISION]: old });
  for (let i = 1; i <= 17; i++) {
    setCells(w, ID, { "SEO опис UA": SEO["SEO опис UA"] + " чернетка " + i });
    await apply(w, R, { stamp: later(i) });
    assert.equal(stateOf(w, R).seo.has(ID), false, "стара команда не затверджує нову чернетку");
    assert.equal(issueOf(R).n, i, "передумова: номер видачі передбачуваний");
    assert.equal(rowOf(w, ID)[SEO_DECISION], old, "власник більше не підтверджував");
  }
  return { w, R, pair, c0, old };
}

test("R7.1-P1 (Hermes R7-P1): перший код витіснено з prev 17 перевидачами — незмінна стара команда не затверджує SEO іншої фізичної ідентичності; видача №18 не повторює коду №0", async () => {
  const { w, R, pair, c0, old } = await seventeenReissues();
  setCells(w, ID, { ...SEO, "Артикул постачальника": pair.b.sku }); reseal(w);
  await apply(w, R, { stamp: later(18) });
  const reissued = issueOf(R);
  assert.equal(reissued.n, 18);
  await apply(w, R, { stamp: later(19) });
  assert.equal(rowOf(w, ID)[SEO_DECISION], old, "команду власника не змінювали");
  assert.equal(stateOf(w, R).seo.has(ID), false, "стара команда стала чинною для іншої фізичної ідентичності: " + JSON.stringify({ c0, reissued: reissued.code, fixture: pair.code }));
  assert.notEqual(reissued.code, c0, "код видачі №18 повторює код видачі №0");
});

test("R7.1-P1: стара команда, вписана повторно ПІСЛЯ видачі №18 (власник спершу запросив новий код), не затверджує SEO іншої фізичної ідентичності", async () => {
  const { w, R, pair, c0, old } = await seventeenReissues();
  setCells(w, ID, { ...SEO, "Артикул постачальника": pair.b.sku, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); reseal(w);
  await apply(w, R, { stamp: later(18) }); // запит без коду — видача №18 для B
  assert.equal(issueOf(R).n, 18);
  setCells(w, ID, { [SEO_DECISION]: old }); // повернуто стару команду (скасування правки / стара версія аркуша)
  await apply(w, R, { stamp: later(19) });
  assert.equal(stateOf(w, R).seo.has(ID), false, "повторно вписана стара команда A затвердила SEO B: " + JSON.stringify({ c0, issued: issueOf(R).code }));
  assert.notEqual(issueOf(R).code, c0);
});

test("R7.1-P1: після відновлення старішої контрольної точки номер видачі повторюється — нова видача не дорівнює коду, що вже стоїть у клітинці; команда, вписана для A, не затверджує B", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" });
  await apply(w, R);
  const cp0 = structuredClone(cpOf(R));
  setCells(w, ID, { "SEO опис UA": SEO["SEO опис UA"] + " нова чернетка" });
  await apply(w, R, { stamp: later(1) }); // видача №0 не відповідає новій чернетці — видача №1
  assert.equal(issueOf(R).n, 1, "передумова: видача №1");
  const c1 = codeOf(w, ID, "ЗАТВЕРДИТИ");
  setCells(w, ID, { [SEO_DECISION]: "ЗАТВЕРДИТИ " + c1 }); // команда власника для A (ще не виконана)
  R.store.data.set(CHECKPOINT_KEY, cp0); // відновлено старішу точку: видачі №1 у ній немає
  setCells(w, ID, { "Артикул постачальника": "CC71-ROLLBACK-B" }); reseal(w);
  await apply(w, R, { stamp: later(2) });
  await apply(w, R, { stamp: later(3) });
  assert.equal(stateOf(w, R).seo.has(ID), false, "команда, вписана для A до видачі, затвердила SEO B");
  assert.notEqual(issueOf(R).code, c1, "нова видача дорівнює коду, що стояв у клітинці");
});

// R7.2: механізм first (R7.1) замінено епохою оренди; фікстура «код №0 = перестановка №38» більше не застосовна — сценарій той самий.
test("R7.1-P1: повторна видача не дорівнює коду видачі №0, а prev уже витіснив код №0 (38 перевидач); повторно вписана команда з кодом №0 не затверджує іншої чернетки", async () => {
  const m = await import("../src/core/controls-common.mjs");
  assert.equal(typeof m.issuedCode, "function", "функції кодів видачі (перестановки) немає");
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { ...SEO, "Артикул постачальника": "CC71-FIRST-396324", [SEO_DECISION]: "ЗАТВЕРДИТИ" }); reseal(w);
  await apply(w, R);
  const c0 = codeOf(w, ID, "ЗАТВЕРДИТИ");
  assert.ok(c0, "передумова: видача №0");
  for (let i = 1; i <= 38; i++) {
    setCells(w, ID, { "SEO опис UA": SEO["SEO опис UA"] + " чернетка " + i });
    await apply(w, R, { stamp: later(i) }); // запит без коду — нова видача для нової чернетки
  }
  assert.ok(!issueOf(R).prev.includes(c0), "передумова: код №0 витіснено з prev");
  assert.equal(issueOf(R).n, 38, "38 перевидач");
  assert.notEqual(issueOf(R).code, c0);
  setCells(w, ID, { [SEO_DECISION]: "ЗАТВЕРДИТИ " + c0 });
  await apply(w, R, { stamp: later(14) });
  assert.equal(stateOf(w, R).seo.has(ID), false, "команда з кодом №0 затвердила іншу чернетку");
});

test("R7.1-P1: коди повторних видач — перестановка: перші 65 536 номерів видачі дають попарно різні коди; номер поза межами — відмова", async () => {
  const m = await import("../src/core/controls-common.mjs");
  assert.equal(typeof m.issuedCode, "function", "функції кодів видачі (перестановки) немає");
  const seen = new Set();
  for (let n = 0; n < 1 << 16; n++) seen.add(m.issuedCode({ offerId: ID, action: "SEO_APPROVE", n }));
  assert.equal(seen.size, 1 << 16);
  assert.ok([...seen].every((c) => /^[0-9A-F]{6}$/.test(c)));
  assert.throws(() => m.issuedCode({ offerId: ID, action: "SEO_APPROVE", n: m.ISSUE_SPACE }), RangeError);
  assert.throws(() => m.issuedCode({ offerId: ID, action: "SEO_APPROVE", n: -1 }), RangeError);
});

// ---------------------------------------------------------------- P2 — непорожній рядок архіву без Offer ID
test("R7.1-P2 (Hermes R7-P2): в архівній копії очищено Offer ID — картка з тією самою фізичною ідентичністю лишається поза YML (UNREGISTERED), діагностика з номером рядка, без глобальної зупинки; сусідній товар не зачеплено", async () => {
  const w = await prepared(), m = w.book[SHEET.main];
  w.book[ARCHIVE_SHEET] = [m[0].slice(), m.find((r) => r[0] === ID).slice()];
  const opts = { contract: ACTIVE_CONTRACT, checkpoint: null };
  const before = controlsState(structuredClone(w.book), opts);
  assert.ok(before.tombstoned.has(ID), "передумова: UNREGISTERED");
  const a = w.book[ARCHIVE_SHEET]; a[1][a[0].indexOf("Offer ID")] = "";
  const after = controlsState(structuredClone(w.book), opts);
  assert.ok(after.tombstoned.has(ID) && after.held.has(ID), "рядок архіву без Offer ID став «безпечною порожнечею»: " + JSON.stringify({ issues: after.issues }));
  assert.equal(after.tombstoned.get(ID).stage, "UNREGISTERED");
  assert.equal(after.blocked, false, "без глобальної зупинки");
  assert.match(after.issues.join(" | "), rowRef(2));
  assert.ok(after.gate.check(offerOf(rowOf(w, ID))).blocked, "фільтр новинок блокує цей товар");
  assert.ok(!after.held.has(ID2) && !after.tombstoned.has(ID2), "сусідній товар не зачеплено");
});

test("R7.1-P2: у рядку без Offer ID немає й ID постачальника та артикула, лише назви / URL постачальника — картка з тими самими назвами / URL поза YML, без глобальної зупинки", async () => {
  const w = await prepared(), m = w.book[SHEET.main], h = m[0];
  const r = m.find((x) => x[0] === ID).slice();
  for (const c of ["Offer ID", "ID постачальника", "Артикул постачальника"]) r[h.indexOf(c)] = "";
  w.book[ARCHIVE_SHEET] = [h.slice(), r];
  const s = controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: null });
  assert.equal(s.blocked, false);
  assert.ok(s.tombstoned.has(ID) && s.held.has(ID), "картка з тими самими назвами / URL постачальника лишилась у YML");
  assert.ok(!s.tombstoned.has(ID2));
});

test("R7.1-P2: товар перенесено в архів без рішення CC, Offer ID архівного рядка очищено — фільтр новинок блокує той самий товар (ID постачальника і новий ID), без глобальної зупинки", async () => {
  const w = await prepared(); const R = readinessDouble();
  await apply(w, R);
  const h = w.book[SHEET.main][0], row = rowOf(w, ID);
  copyRow(w.book, ID, SHEET.main, ARCHIVE_SHEET); dropRow(w.book, ID, SHEET.main);
  w.book[ARCHIVE_SHEET][1][h.indexOf("Offer ID")] = "";
  const s = stateOf(w, R);
  assert.equal(s.blocked, false);
  assert.equal(s.gate.check(offerOf(row)).blocked, true, "той самий товар постачальника не повертається як новинка");
  assert.equal(s.gate.check({ ...offerOf(row), id: "CC71-NEW-ID" }).blocked, true, "той самий товар під новим ID");
  assert.match(s.issues.join(" | "), rowRef(2));
});

test("R7.1-P2: нечитабельний архів (пошкоджений заголовок) — рядок без Offer ID теж не губиться: фільтр блокує товар за ID постачальника, без глобальної зупинки", async () => {
  const w = await prepared(); const R = readinessDouble();
  await apply(w, R);
  const h = w.book[SHEET.main][0], row = rowOf(w, ID);
  copyRow(w.book, ID, SHEET.main, ARCHIVE_SHEET); dropRow(w.book, ID, SHEET.main);
  w.book[ARCHIVE_SHEET][1][h.indexOf("Offer ID")] = "";
  w.book[ARCHIVE_SHEET][0][h.indexOf("Артикул постачальника")] = "ЗЛАМАНИЙ ЗАГОЛОВОК";
  const s = stateOf(w, R);
  assert.equal(s.blocked, false);
  assert.equal(s.gate.check(offerOf(row)).blocked, true, "нечитабельний архів: рядок без Offer ID зник із фільтра");
  assert.match(s.issues.join(" | "), rowRef(2));
});

test("R7.1-P2: рядок без Offer ID і без ID / артикула / назв / URL постачальника — явна глобальна зупинка з номером рядка; рядок лише з пробілами — не зупинка", async () => {
  const w = await prepared(); const R = readinessDouble();
  await apply(w, R);
  const h = w.book[SHEET.main][0];
  w.book[ARCHIVE_SHEET] = [h.slice(), h.map(() => " ")];
  assert.equal(stateOf(w, R).blocked, false, "рядок лише з пробілами — порожній");
  const r = w.book[SHEET.main].find((x) => x[0] === ID).slice();
  for (const c of ["Offer ID", "ID постачальника", "Артикул постачальника", "Назва постачальника UA", "Назва постачальника RU", "URL постачальника"]) if (h.indexOf(c) >= 0) r[h.indexOf(c)] = "";
  w.book[ARCHIVE_SHEET].push(r);
  const s = stateOf(w, R);
  assert.equal(s.blocked, true, "товар не визначити — це не «видалених немає»");
  assert.match(s.reasons.join(" "), rowRef(3));
});

async function deleted() {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await confirmR(w, R, ID, DEL, 1);
  return { w, R };
}
test("R7.1-P2: ризикова операція — повернення з архіву товару, ідентичність якого збігається з рядком без Offer ID, відхиляється з причиною; у тому самому запуску команда іншого товару виконується, а ручна правка третього не знімає його з продажу", async () => {
  const { w, R } = await deleted();
  copyRow(w.book, ID, SHEET.main, ARCHIVE_SHEET); dropRow(w.book, ID, SHEET.main); // Engineering переніс
  setCells(w, ID, { [SALE_DECISION]: BACK }, ARCHIVE_SHEET);
  setCells(w, ID2, { [SALE_DECISION]: HOLD });
  await apply(w, R, { stamp: later(3) });
  const back = codeOf(w, ID, BACK), hold = codeOf(w, ID2, HOLD);
  assert.ok(back && hold, "передумова: коди видано");
  // У «Видалених товарах» з'явився рядок без Offer ID з тією самою фізичною ідентичністю (копія картки з очищеним ID).
  const a = w.book[ARCHIVE_SHEET], copy = a.find((r, k) => k > 0 && r[0] === ID).slice();
  copy[a[0].indexOf("Offer ID")] = ""; copy[a[0].indexOf(SALE_DECISION)] = ""; a.push(copy);
  const third = mainIds(w).find((x) => x !== ID && x !== ID2);
  setCells(w, third, { "Назва UA": "Ручна правка власника R7.1" });
  setCells(w, ID, { [SALE_DECISION]: `${BACK} ${back}` }, ARCHIVE_SHEET);
  setCells(w, ID2, { [SALE_DECISION]: `${HOLD} ${hold}` });
  await apply(w, R, { stamp: later(4) });
  const s = stateOf(w, R);
  assert.ok(!s.moves.toCatalog.includes(ID), "повернення з архіву зареєстровано попри рядок без Offer ID з тією самою ідентичністю");
  assert.ok(s.tombstoned.has(ID) && s.held.has(ID), "товар лишається видаленим");
  assert.match(viewOf(w, ID)["Попередження"], /рядок без Offer ID/);
  assert.ok(!history(w).some((r) => r[col("Offer ID")] === ID && r[col("Дія")] === ACTION.UNTOMBSTONE), "відмова до запису наміру: події повернення в журналі немає");
  assert.ok(s.held.has(ID2), "команда іншого товару виконана в тому самому запуску");
  assert.ok(!s.held.has(third) && !s.tombstoned.has(third) && !s.damaged.has(third), "ручна правка не знімає товар із продажу");
  assert.equal(s.blocked, false);
});

test("R7.1-P2: товар повернуто з архіву й у продаж, потім в архіві з'явився рядок без Offer ID з тією самою ідентичністю — товар ізольовано (поза продажем), без глобальної зупинки; сусідній у продажу", async () => {
  const { w, R } = await deleted();
  copyRow(w.book, ID, SHEET.main, ARCHIVE_SHEET); dropRow(w.book, ID, SHEET.main);
  setCells(w, ID, { [SALE_DECISION]: BACK }, ARCHIVE_SHEET);
  await apply(w, R, { stamp: later(3) });
  setCells(w, ID, { [SALE_DECISION]: `${BACK} ${codeOf(w, ID, BACK)}` }, ARCHIVE_SHEET);
  await apply(w, R, { stamp: later(4) });
  assert.deepEqual(stateOf(w, R).moves.toCatalog, [ID], "передумова: повернення зареєстровано");
  copyRow(w.book, ID, ARCHIVE_SHEET, SHEET.main); dropRow(w.book, ID, ARCHIVE_SHEET); // Engineering переніс назад
  setCells(w, ID, { [SALE_DECISION]: "" });
  await confirmR(w, R, ID, RELEASE, 5);
  assert.ok(!stateOf(w, R).held.has(ID), "передумова: у продажу");
  const m = w.book[SHEET.main], copy = m.find((r, k) => k > 0 && r[0] === ID).slice();
  copy[m[0].indexOf("Offer ID")] = ""; copy[m[0].indexOf(SALE_DECISION)] = "";
  w.book[ARCHIVE_SHEET].push(copy);
  const s = stateOf(w, R);
  assert.ok(s.held.has(ID), "повернений товар лишився в продажу попри рядок архіву без Offer ID з тією самою ідентичністю");
  assert.equal(s.blocked, false);
  assert.ok(!s.held.has(ID2));
  assert.match(s.issues.join(" | "), rowRef(2));
});

test("R7.1-P2: рядок без Offer ID з тією самою ідентичністю з'явився між записом наміру «ПОВЕРНУТИ З АРХІВУ» і підтвердженням — при звірці намір скасовано, товар лишається видаленим", async () => {
  const { w, R } = await deleted();
  copyRow(w.book, ID, SHEET.main, ARCHIVE_SHEET); dropRow(w.book, ID, SHEET.main);
  setCells(w, ID, { [SALE_DECISION]: BACK }, ARCHIVE_SHEET);
  await apply(w, R, { stamp: later(3) });
  setCells(w, ID, { [SALE_DECISION]: `${BACK} ${codeOf(w, ID, BACK)}` }, ARCHIVE_SHEET);
  R.store.failCommit = true;
  const first = await apply(w, R, { stamp: later(4) });
  R.store.failCommit = false;
  assert.equal(first.state, "UNCONFIRMED", "передумова: намір записано, коміт не вдався");
  const a = w.book[ARCHIVE_SHEET], copy = a.find((r, k) => k > 0 && r[0] === ID).slice();
  copy[a[0].indexOf("Offer ID")] = ""; copy[a[0].indexOf(SALE_DECISION)] = ""; a.push(copy);
  await apply(w, R, { stamp: later(5) });
  const s = stateOf(w, R);
  assert.ok(!s.moves.toCatalog.includes(ID), "повернення підтверджено попри рядок без Offer ID з тією самою ідентичністю");
  assert.ok(s.tombstoned.has(ID) && s.held.has(ID));
  assert.ok(cpOf(R).aborted.some((e) => e.offerId === ID), "намір скасовано");
});
