/** Catalog Controls R7 — регресії блокерів незалежного ревю Hermes R6 (independent-20261029T230851):
 *  F1 — N2: збій читання після CAS або запису AUTOHOLD не лишає змінену фізичну ідентичність у продажу; наступний запуск
 *       довершує захист (повернення в продаж прив'язане до ідентичності, для якої його авторизовано, — і в стані для споживачів);
 *  F2 — код підтвердження прив'язаний до збереженої видачі (товар, дія, фізична ідентичність, ревізія): колізія 24-бітного коду не
 *       авторизує інший фізичний товар; застаріла команда не стає чинною після перевидачі;
 *  M39 — явна перевірка ідентичності при підтвердженні наміру (колізія в звірці);
 *  F3 — повернення з архіву / перенесення не губить новішої SEO-чернетки власника: різні копії — локальний конфлікт без доручення;
 *  F4 — нечитабельний архів не знімає захисту видалених (консервативний набір або явна зупинка);
 *  M33 — прийнятна точка з pending HOLD + pending RELEASE одного товару лишає його поза продажем.
 *  Тести викликають лише API, наявне в R6, тому запускаються й на замороженому R6 (змістовний RED, не помилка імпорту). */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { SEAL_COLUMN, rowSeal } from "../src/core/seal.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { ACTION, ARCHIVE_SHEET, CC_SHEET, HISTORY_HEADERS, SALE_DECISION, SEO_DECISION, confirmationCode, historyRow, identityKey, identityOf, operationId } from "../src/core/controls-common.mjs";
import { seoSha, seoValues } from "../src/core/controls-seo.mjs";
import { controlsState, emptyCheckpoint, withIntents } from "../src/core/controls-plan.mjs";
import { CHECKPOINT_KEY } from "../src/pipeline/controls-run.mjs";
import { ACTIVE_CONTRACT, prepared, setCells, codeOf, rowOf, history, later, viewOf } from "./helpers/controls.mjs";
import { HOLD, ID, ID2, RELEASE, apply, col, confirmR, cpOf, prompt, readinessDouble, shadow, stateOf } from "./helpers/controls-r3.mjs";

const DEL = `ВИДАЛИТИ ТОВАР ${ID}`, BACK = `ПОВЕРНУТИ З АРХІВУ ${ID}`;
const SEO = { "SEO заголовок UA": "Незалежний тест українською", "SEO заголовок RU": "Независимый тест заголовка", "SEO опис UA": "Незалежний опис для тесту підтвердження", "SEO опис RU": "Независимое описание для теста подтверждения" };
const SEO_FIELDS = Object.keys(SEO);
function reseal(w, id = ID, sheet = SHEET.main) {
  const v = w.book[sheet], h = v[0].map(mtText), i = v.findIndex((r, k) => k > 0 && mtText(r[0]) === id);
  v[i][h.indexOf(SEAL_COLUMN)] = rowSeal(Object.fromEntries(h.map((k, j) => [k, v[i][j] ?? ""])));
}
/** Детермінований пошук двох артикулів з однаковим 24-бітним кодом первинного затвердження SEO (ревізія «0»). */
function seoCollision(w) {
  const identity = identityOf(rowOf(w, ID)), payload = seoSha(seoValues(rowOf(w, ID))), seen = new Map();
  for (let i = 0; i < 200000; i++) {
    const x = { ...identity, sku: "CC7-COLLISION-" + i };
    const code = confirmationCode({ offerId: ID, identity: x, action: "SEO_APPROVE", revision: "0", payload });
    if (seen.has(code)) return { a: seen.get(code), b: x, code };
    seen.set(code, x);
  }
  throw new Error("колізію не знайдено");
}

// ---------------------------------------------------------------- F1 — N2 durable
/** HOLD підтверджено, RELEASE з кодом у клітинці; у момент коміту RELEASE (CAS) змінюється фізична ідентичність. */
async function releaseWithIdentityChangeAtCommit({ fault }) {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  let fired = false, committed = false;
  R.store.hookPut = async (k, v) => {
    if (k !== CHECKPOINT_KEY) return;
    if (fault === "autohold" && v.pending?.some((x) => x.cmd === "AUTOHOLD")) throw new Error("імітовано: запис AUTOHOLD у точку не вдався");
    if (!fired && v.ops?.some((x) => x.row[col("Дія")] === ACTION.RELEASE)) { fired = true; setCells(w, ID, { [SALE_DECISION]: "", "Артикул постачальника": "CC7-PHYSICAL-B" }); reseal(w); }
  };
  R.store.afterPut = async (k, v) => { if (k === CHECKPOINT_KEY && v.ops?.some((x) => x.row[col("Дія")] === ACTION.RELEASE)) committed = true; };
  const readBook = async (names) => { if (fault === "post-read" && committed && names.length > 2) throw new Error("імітовано: читання після CAS не вдалося"); return w.readBook(names); };
  const first = await apply(w, R, { stamp: later(2), readBook });
  R.store.hookPut = null; R.store.afterPut = null;
  return { w, R, first, fired };
}

for (const fault of ["post-read", "autohold"]) {
  test(`R7-F1 (${fault}): збій ${fault === "post-read" ? "читання після CAS" : "запису AUTOHOLD"} — змінена фізична ідентичність не лишається в продажу ні одразу, ні після повторного запуску; повтор довершує захисне зняття`, async () => {
    const { w, R, first, fired } = await releaseWithIdentityChangeAtCommit({ fault });
    assert.ok(fired, "передумова: ідентичність змінено у вікні CAS");
    const s = stateOf(w, R);
    assert.ok(s.held.has(ID), "одразу після збою — поза продажем: " + JSON.stringify({ state: first.state }));
    assert.equal(s.blocked, false, "без глобальної зупинки");
    assert.notEqual(first.state, "COMMITTED", "запуск не звітує про чистий успіх, коли захисну перевірку не довершено");
    const retry = await apply(w, R, { stamp: later(3) });
    assert.ok(stateOf(w, R).held.has(ID), "після повтору — поза продажем: " + retry.state);
    assert.ok(history(w).some((x) => x[col("Дія")] === ACTION.HOLD && x[col("Offer ID")] === ID && /автоматично/.test(x[col("Підстава")])), "повтор записав автоматичне зняття");
  });
}

test("R7-F1: підтверджене повернення в продаж діє лише для фізичної ідентичності, для якої його авторизовано — зміна артикула після коміту (без жодного запуску) одразу знімає товар у стані для споживачів; повернення ідентичності — знову в продажу", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await confirmR(w, R, ID, RELEASE, 1);
  assert.ok(!stateOf(w, R).held.has(ID), "передумова: у продажу");
  const sku = rowOf(w, ID)["Артикул постачальника"];
  setCells(w, ID, { "Артикул постачальника": "CC7-OTHER-PHYSICAL" }); reseal(w);
  const s = stateOf(w, R);
  assert.ok(s.held.has(ID) && !s.blocked, "споживач (publisher) не публікує інший фізичний товар як доступний");
  setCells(w, ID, { "Артикул постачальника": sku }); reseal(w);
  assert.ok(!stateOf(w, R).held.has(ID), "та сама ідентичність, що авторизована, — рішення чинне");
});

// ---------------------------------------------------------------- F2 / M39 — колізія кодів
test("R7-F2: код, виданий для фізичної ідентичності A, не авторизує B навіть за збігу 24-бітного коду; застаріла команда не стає чинною і після перевидачі коду", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, SEO);
  const pair = seoCollision(w);
  assert.notEqual(identityKey(pair.a), identityKey(pair.b));
  setCells(w, ID, { "Артикул постачальника": pair.a.sku, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); reseal(w);
  await apply(w, R);
  // R7.2: код видачі прив'язано до епохи оренди, тож розрахункова колізія (pair.code) — не передумова; старий код — виданий для A.
  const codeA = codeOf(w, ID, "ЗАТВЕРДИТИ");
  assert.ok(codeA, "передумова: видано код для A");
  setCells(w, ID, { [SEO_DECISION]: `ЗАТВЕРДИТИ ${codeA}`, "Артикул постачальника": pair.b.sku }); reseal(w);
  await apply(w, R, { stamp: later(1) });
  assert.equal(stateOf(w, R).seo.has(ID), false, "старий код не затверджує SEO іншого фізичного товару");
  await apply(w, R, { stamp: later(2) });
  assert.equal(stateOf(w, R).seo.has(ID), false, "та сама застаріла команда не стає чинною й у наступному запуску");
  assert.match(viewOf(w, ID)["Попередження"], /код|ідентичн/);
});

test("R7-F2: перевидача ніколи не повторює попереднього коду — навіть коли наступний номер видачі для нової ідентичності дав би той самий 24-бітний код; застаріла команда не стає чинною", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, SEO);
  const identity = identityOf(rowOf(w, ID)), payload = seoSha(seoValues(rowOf(w, ID)));
  // Детермінована колізія між видачею №0 для A і видачею №1 для B (обидві — первинне затвердження, ревізія «0»).
  const first = new Map(); let pair = null;
  for (let i = 0; i < 20000 && !pair; i++) first.set(confirmationCode({ offerId: ID, identity: { ...identity, sku: "CC7-A-" + i }, action: "SEO_APPROVE", revision: "0", payload }), "CC7-A-" + i);
  for (let j = 0; j < 200000 && !pair; j++) {
    const c = confirmationCode({ offerId: ID, identity: { ...identity, sku: "CC7-B-" + j }, action: "SEO_APPROVE", revision: "0", payload, nonce: 1 });
    if (first.has(c)) pair = { a: first.get(c), b: "CC7-B-" + j, code: c };
  }
  assert.ok(pair, "колізію знайдено");
  setCells(w, ID, { "Артикул постачальника": pair.a, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); reseal(w);
  await apply(w, R);
  // R7.2: код видачі прив'язано до епохи оренди, тож розрахункова колізія (pair.code) — не передумова; старий код — видача №0 для A.
  const c0 = codeOf(w, ID, "ЗАТВЕРДИТИ");
  assert.ok(c0, "передумова: видача №0 для A");
  setCells(w, ID, { [SEO_DECISION]: `ЗАТВЕРДИТИ ${c0}`, "Артикул постачальника": pair.b }); reseal(w);
  await apply(w, R, { stamp: later(1) });
  assert.notEqual(codeOf(w, ID, "ЗАТВЕРДИТИ"), c0, "нова видача для B не повторює старого коду");
  await apply(w, R, { stamp: later(2) });
  assert.equal(stateOf(w, R).seo.has(ID), false, "застаріла команда зі старим кодом не затверджує");
});

test("R7-F2: код одноразовий — після скасування наміру видачу вичерпано (повторно вписаний старий код — відмова «вже використано або скасовано» і новий код)", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await prompt(w, R, ID, RELEASE, 1);
  const old = rowOf(w, ID)[SALE_DECISION];
  R.store.failCommit = true;
  await apply(w, R, { stamp: later(2) });
  R.store.failCommit = false;
  setCells(w, ID, { [SALE_DECISION]: "" });
  await apply(w, R, { stamp: later(3) }); // звірка скасовує повернення
  assert.equal(cpOf(R).aborted.length, 1, "передумова: намір скасовано");
  setCells(w, ID, { [SALE_DECISION]: old });
  await apply(w, R, { stamp: later(4) });
  assert.match(viewOf(w, ID)["Попередження"], /вже використано або скасовано/);
  assert.ok(stateOf(w, R).held.has(ID));
  assert.notEqual(`${RELEASE} ${codeOf(w, ID, RELEASE)}`, old, "новий код");
});

test("R7-M39: колізія коду при підтвердженні наміру (звірка) — намір для A не підтверджується для B; явна перевірка фізичної ідентичності скасовує його", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, SEO);
  const pair = seoCollision(w);
  setCells(w, ID, { "Артикул постачальника": pair.a.sku, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); reseal(w);
  await apply(w, R);
  setCells(w, ID, { [SEO_DECISION]: `ЗАТВЕРДИТИ ${codeOf(w, ID, "ЗАТВЕРДИТИ")}` });
  R.store.failCommit = true;
  const first = await apply(w, R, { stamp: later(1) });
  R.store.failCommit = false;
  assert.equal(first.state, "UNCONFIRMED", JSON.stringify(first));
  assert.equal(cpOf(R).pending.length, 1);
  setCells(w, ID, { "Артикул постачальника": pair.b.sku }); reseal(w);
  await apply(w, R, { stamp: later(2) });
  assert.equal(stateOf(w, R).seo.has(ID), false);
  assert.equal(cpOf(R).aborted.length, 1, "намір скасовано, а не підтверджено");
});

test("R7-F2: дійсний код — лише виданий системою на запит і збережений у контрольній точці; код, показаний у SHADOW, не видано й не приймається", async () => {
  const w = await prepared(); const R = readinessDouble();
  await apply(w, R); // ініціалізація точки, запитів ще немає
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  const sh = await shadow(w, { store: R.store, stamp: later(1) });
  const shownInShadow = new RegExp(`${HOLD} ([0-9A-F]{6})`).exec(sh.view.find((r) => r[0] === ID)?.[5] || "")?.[1] || null;
  assert.equal(shownInShadow, null, "SHADOW нічого не видає — і не показує коду як дійсного");
  await apply(w, R, { stamp: later(1.5) });
  const issued = codeOf(w, ID, HOLD);
  assert.ok(issued);
  // Підроблений / вгаданий код (обчислений так само, як модуль, але не виданий) — відмова.
  const forged = confirmationCode({ offerId: ID, identity: identityOf(rowOf(w, ID)), action: "HOLD", revision: "0", payload: "", nonce: 7 });
  if (forged !== issued) {
    setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${forged}` });
    await apply(w, R, { stamp: later(2) });
    assert.ok(!stateOf(w, R).held.has(ID), "невиданий код не діє");
  }
  setCells(w, ID, { [SALE_DECISION]: `${HOLD} ${issued}` });
  await apply(w, R, { stamp: later(3) });
  assert.ok(stateOf(w, R).held.has(ID), "виданий код діє");
});

test("R7-F2: видача коду зберігається в точці, але не змінює відбитка стану для споживачів (запит коду не створює нової версії YML)", async () => {
  const w = await prepared(); const R = readinessDouble();
  await apply(w, R);
  const fp0 = stateOf(w, R).fingerprint;
  setCells(w, ID, { [SALE_DECISION]: HOLD });
  await apply(w, R, { stamp: later(1) });
  assert.ok(codeOf(w, ID, HOLD), "передумова: код видано");
  assert.equal(stateOf(w, R).fingerprint, fp0);
});

test("R7 (M46): скасування наміру робить недійсними ВСІ видані коди продажу товару (ревізія враховує скасовані), а не лише код скасованої дії", async () => {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  setCells(w, ID, { [SALE_DECISION]: DEL });
  await apply(w, R, { stamp: later(1) });
  const del = `${DEL} ${codeOf(w, ID, DEL)}`; // видача коду видалення лишається в точці
  await prompt(w, R, ID, RELEASE, 1.5);
  R.store.failCommit = true;
  await apply(w, R, { stamp: later(2) });
  R.store.failCommit = false;
  setCells(w, ID, { [SALE_DECISION]: "" });
  await apply(w, R, { stamp: later(3) }); // звірка скасовує повернення
  assert.equal(cpOf(R).aborted.length, 1, "передумова: намір скасовано");
  setCells(w, ID, { [SALE_DECISION]: del });
  await apply(w, R, { stamp: later(4) });
  assert.ok(!stateOf(w, R).tombstoned.has(ID), "код видалення, виданий до скасування, — недійсний");
  assert.match(viewOf(w, ID)["Попередження"], /код недійсний або застарів/);
});

// ---------------------------------------------------------------- F3 — SEO-чернетка власника в копіях
async function deleted() {
  const w = await prepared(); const R = readinessDouble();
  await confirmR(w, R, ID, HOLD);
  await confirmR(w, R, ID, DEL, 1);
  return { w, R };
}
const copyRow = (book, id, from, to) => { if (!book[to]?.length) book[to] = [book[from][0].slice()]; book[to].push(book[from].find((r, k) => k > 0 && r[0] === id).slice()); };
const dropRow = (book, id, sheet) => { book[sheet] = book[sheet].filter((r, k) => !k || r[0] !== id); };

for (const field of SEO_FIELDS) {
  test(`R7-F3 (${field}): дві копії з різною SEO-чернеткою власника — не «перерване перенесення»: ні в архів, ні в каталог доручення немає, обидві копії лишаються, товар ізольовано без зупинки каталогу`, async () => {
    // (а) повернення з архіву: власник оновив чернетку в архівній копії
    const { w, R } = await deleted();
    setCells(w, ID, { [field]: "OWNER_OLD" }); reseal(w);
    copyRow(w.book, ID, SHEET.main, ARCHIVE_SHEET); dropRow(w.book, ID, SHEET.main);
    setCells(w, ID, { [SALE_DECISION]: BACK }, ARCHIVE_SHEET);
    await apply(w, R, { stamp: later(3) });
    setCells(w, ID, { [SALE_DECISION]: `${BACK} ${codeOf(w, ID, BACK)}` }, ARCHIVE_SHEET);
    assert.equal((await apply(w, R, { stamp: later(4) })).state, "COMMITTED");
    copyRow(w.book, ID, ARCHIVE_SHEET, SHEET.main); // Engineering: копія в каталог (крок 1)
    setCells(w, ID, { [field]: "OWNER_NEW_IN_ARCHIVE" }, ARCHIVE_SHEET);
    let s = stateOf(w, R);
    assert.ok(!s.moves.toCatalog.includes(ID), "новіша чернетка в архіві — без доручення прибрати архівну копію");
    assert.ok(s.held.has(ID) && !s.blocked);
    // (б) видалення: власник оновив чернетку в каталозі після копіювання в архів
    const t = await deleted();
    copyRow(t.w.book, ID, SHEET.main, ARCHIVE_SHEET);
    setCells(t.w, ID, { [field]: "OWNER_NEW_IN_MAIN" });
    s = stateOf(t.w, t.R);
    assert.ok(!s.moves.toArchive.includes(ID), "новіша чернетка в каталозі — без доручення прибрати рядок каталогу");
    assert.ok(s.tombstoned.has(ID) && s.held.has(ID) && !s.blocked);
  });
}

test("R7-F3 (контроль): копії різняться лише клітинками команд власника — перерване перенесення (MOVING) з тим самим дорученням", async () => {
  const { w, R } = await deleted();
  copyRow(w.book, ID, SHEET.main, ARCHIVE_SHEET);
  setCells(w, ID, { [SALE_DECISION]: "інша команда в архівній копії" }, ARCHIVE_SHEET);
  const s = stateOf(w, R);
  assert.deepEqual(s.moves.toArchive, [ID]);
  assert.equal(s.tombstoned.get(ID).stage, "MOVING");
});

// ---------------------------------------------------------------- F4 — нечитабельний архів
test("R7-F4: «Видалені товари» з пошкодженим обов'язковим заголовком — ID з архіву лишаються видаленими (поза YML, фільтр), без глобальної зупинки; без колонки Offer ID — явна глобальна зупинка (набір видалених не визначити)", async () => {
  const w = await prepared(); const R = readinessDouble();
  await apply(w, R);
  const h = w.book[SHEET.main][0];
  w.book[ARCHIVE_SHEET] = [h.slice(), w.book[SHEET.main].find((r) => r[0] === ID).slice()];
  dropRow(w.book, ID, SHEET.main);
  const before = stateOf(w, R);
  assert.ok(before.tombstoned.has(ID), "передумова: UNREGISTERED");
  w.book[ARCHIVE_SHEET][0][h.indexOf("Артикул постачальника")] = "ЗЛАМАНИЙ ЗАГОЛОВОК";
  const after = stateOf(w, R);
  assert.ok(after.tombstoned.has(ID) && after.held.has(ID) && after.gate.knownIds.has(ID), "нечитабельний архів — не доказ, що видалених немає");
  assert.equal(after.blocked, false, "ID визначено — решта каталогу працює");
  w.book[ARCHIVE_SHEET][0][h.indexOf("Offer ID")] = "ЗЛАМАНО";
  const lost = stateOf(w, R);
  assert.equal(lost.blocked, true, "набір видалених не визначити — явна зупинка, а не «видалених немає»");
  assert.match(lost.reasons.join(" "), /Видалені товари/);
});

// ---------------------------------------------------------------- M33 — межа прийнятних точок
test("R7-M33: прийнята валідатором точка з pending HOLD і pending RELEASE одного товару (звичайним запуском не досягається) — товар поза продажем (захисний намір діє)", async () => {
  const w = await prepared();
  const auth = identityKey(identityOf(rowOf(w, ID)));
  const intents = [ACTION.HOLD, ACTION.RELEASE].map((action, i) => {
    const op = operationId({ offerId: ID, action: i ? "RELEASE" : "HOLD", code: "A0000" + (i + 1) });
    const row = historyRow({ stamp: later(i), opId: op, offerId: ID, action, generation: "sale:" + (i + 1), after: i ? "У ПРОДАЖУ" : "ЗНЯТО" });
    return { op, offerId: ID, seal: row.at(-1), row, action, weakening: Boolean(i), cmd: i ? "RELEASE" : "HOLD", auth, at: later(i) };
  });
  const checkpoint = withIntents(emptyCheckpoint(later(0)), intents, later(1));
  w.book[CC_SHEET.history] = [HISTORY_HEADERS.slice(), ...intents.map((x) => x.row.slice())];
  const s = controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint });
  assert.ok(s.blocked || s.held.has(ID), "pending HOLD діє, pending RELEASE — ні");
  assert.ok(!s.held.has(ID2) || s.blocked);
});
