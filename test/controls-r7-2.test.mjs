/** Catalog Controls R7.2 — регресії незалежного попереднього ревю Hermes R7.1 (ENG-17, components-20261030T124058):
 *  C71-01 — відновлена старіша контрольна точка (прямо або через CAS з чинною орендою й зростаючою версією сховища) повертала
 *           видачу з тим самим номером і кодом, що власник отримав в іншій гілці: незмінна команда для A авторизувала B;
 *  C71-02 — рядок «Видалених товарів» без Offer ID з НЕПОВНОЮ ідентичністю (лише артикул / назва / URL) без картки в каталозі не
 *           блокував повторного додавання (gate.blocked=false), хоча діагностика стверджувала протилежне.
 *  Тести контрприкладів викликають лише API R7.1 — запускаються й на замороженому R7.1 (змістовний RED, не помилка імпорту). */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { SEAL_COLUMN, rowSeal } from "../src/core/seal.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { ARCHIVE_SHEET, SALE_DECISION, SEO_DECISION, confirmationCode, identityOf } from "../src/core/controls-common.mjs";
import { seoSha, seoValues } from "../src/core/controls-seo.mjs";
import { CHECKPOINT_KEY, LEASE_SCOPE } from "../src/pipeline/controls-run.mjs";
import { prepared, setCells, codeOf, rowOf, later, mainIds, viewOf } from "./helpers/controls.mjs";
import { HOLD, ID, ID2, apply, confirmR, cpOf, readinessDouble, stateOf } from "./helpers/controls-r3.mjs";

const SEO = { "SEO заголовок UA": "Перевірка відновлення", "SEO заголовок RU": "Проверка восстановления", "SEO опис UA": "Незалежний опис для перевірки", "SEO опис RU": "Независимое описание для проверки" };
const DEL = `ВИДАЛИТИ ТОВАР ${ID}`, BACK = `ПОВЕРНУТИ З АРХІВУ ${ID}`;
function sku(w, value) {
  setCells(w, ID, { "Артикул постачальника": value });
  const v = w.book[SHEET.main], h = v[0].map(mtText), i = v.findIndex((r, k) => k > 0 && mtText(r[0]) === ID);
  v[i][h.indexOf(SEAL_COLUMN)] = rowSeal(Object.fromEntries(h.map((k, j) => [k, v[i][j] ?? ""])));
}
const issuance = (R) => (cpOf(R)?.issued || []).find((x) => x.offerId === ID && x.action === "SEO_APPROVE");
const snapshot = (R) => structuredClone(cpOf(R));
/** Відновлення старішої точки через CAS з чинною орендою (як у пробі Hermes): версія сховища лише зростає. */
async function casRestore(R, point) {
  const lease = await R.committer.acquire(LEASE_SCOPE);
  try {
    const cur = await R.store.getJsonVersioned(CHECKPOINT_KEY);
    await R.store.putJsonIfVersion(CHECKPOINT_KEY, structuredClone(point), cur.version, { lease: { scope: LEASE_SCOPE, token: lease.token } });
  } finally { await lease.release(); }
}
/** Токени оренди LEASE_SCOPE — із заданого списку (імітація скинутого лічильника W2); fencing цієї області тут не перевіряється. */
function forceTokens(R, tokens) {
  const acquire = R.committer.acquire.bind(R.committer), fence = R.store.fence;
  R.store.fence = (l) => (l.scope === LEASE_SCOPE ? true : fence(l));
  R.committer.acquire = async (scope) => { const l = await acquire(scope); return scope === LEASE_SCOPE && tokens.length ? { ...l, token: tokens.shift() } : l; };
}
const offerOf = (row) => ({ id: row["ID постачальника"], sku: row["Артикул постачальника"], nameUa: row["Назва постачальника UA"], nameRu: row["Назва постачальника RU"], url: row["URL постачальника"] });
const copyRow = (book, id, from, to) => { if (!book[to]?.length) book[to] = [book[from][0].slice()]; book[to].push(book[from].find((r, k) => k > 0 && r[0] === id).slice()); };
const dropRow = (book, id, sheet) => { book[sheet] = book[sheet].filter((r, k) => !k || r[0] !== id); };
/** Рядок архіву без Offer ID, у якому з картки лишено тільки ознаки fields (решта клітинок порожня). */
const witnessRow = (header, row, fields) => header.map((k) => (fields.includes(mtText(k)) ? row[k] ?? "" : ""));

// ---------------------------------------------------------------- C71-01 — відновлення старішої контрольної точки
test("R7.2-C71-01 (Hermes, гілка точки): незмінна команда, підтверджена для A, не авторизує B після відновлення старішої точки гілки B", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); sku(w, "C72-BASE");
  await apply(w, R);
  const base = snapshot(R);
  sku(w, "C72-B"); await apply(w, R, { stamp: later(1 / 60) });
  const branchB = snapshot(R), codeB = issuance(R).code;
  R.store.data.set(CHECKPOINT_KEY, structuredClone(base));
  sku(w, "C72-A"); await apply(w, R, { stamp: later(2 / 60) });
  const codeA = issuance(R).code;
  const command = "ЗАТВЕРДИТИ " + codeA;
  setCells(w, ID, { [SEO_DECISION]: command }); // єдине підтвердження власника — для A, ще не виконане
  sku(w, "C72-B"); R.store.data.set(CHECKPOINT_KEY, branchB); // відновлено старішу точку гілки B; клітинку не змінюємо
  const r = await apply(w, R, { stamp: later(3 / 60) });
  assert.equal(rowOf(w, ID)[SEO_DECISION], command, "команду власника не змінювали");
  assert.equal(stateOf(w, R).seo.has(ID), false, "відновлена видача B прийняла незмінну команду, підтверджену для A: " + JSON.stringify({ codeA, codeB, result: r.state }));
  assert.notEqual(codeA, codeB, "коди видач у різних гілках однакові");
});

test("R7.2-C71-01 (Hermes, CAS): відновлення через putJsonIfVersion з чинною орендою й зростаючою версією сховища не повертає права підтвердження", async () => {
  const w = await prepared(); const R = readinessDouble(), versions = [];
  const save = async () => { const x = await R.store.getJsonVersioned(CHECKPOINT_KEY); versions.push(x.version); return structuredClone(x.value); };
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); sku(w, "CAS-BASE");
  await apply(w, R);
  const base = await save();
  sku(w, "CAS-B"); await apply(w, R, { stamp: later(1 / 60) });
  const branchB = await save();
  await casRestore(R, base); await save();
  sku(w, "CAS-A"); await apply(w, R, { stamp: later(2 / 60) }); await save();
  const command = "ЗАТВЕРДИТИ " + issuance(R).code;
  setCells(w, ID, { [SEO_DECISION]: command });
  await casRestore(R, branchB); await save();
  sku(w, "CAS-B");
  const r = await apply(w, R, { stamp: later(3 / 60) }); await save();
  // Передумова: кожне відновлення й кожна видача — новий запис із більшою версією; фінальний запуск після відмови може нічого не писати.
  const writes = versions.slice(0, -1);
  assert.ok(writes.every((v, i) => !i || v > writes[i - 1]) && versions.at(-1) >= versions.at(-2), "передумова: версія сховища лише зростає " + JSON.stringify(versions));
  assert.equal(rowOf(w, ID)[SEO_DECISION], command);
  assert.equal(stateOf(w, R).seo.has(ID), false, "CAS / fencing не завадили відновленню старої гілки й авторизації іншої ідентичності: " + JSON.stringify({ versions, result: r.state }));
});

/** Два артикули з однаковим розрахунковим кодом першої видачі (ревізія «0») — фікстура колізії коду №0. */
function firstCodeCollision(w) {
  const identity = identityOf(rowOf(w, ID)), payload = seoSha(seoValues(rowOf(w, ID))), seen = new Map();
  for (let i = 0; i < 300000; i++) {
    const s = "C72-FIRST-" + i, code = confirmationCode({ offerId: ID, identity: { ...identity, sku: s }, action: "SEO_APPROVE", revision: "0", payload });
    if (seen.has(code)) return { a: seen.get(code), b: s, code };
    seen.set(code, s);
  }
  throw new Error("колізію не знайдено");
}
test("R7.2-C71-01: гілка без запису видачі (перша видача) і колізія розрахункового коду A / B — відновлена гілка B не приймає команди, підтвердженої для A", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID, SEO);
  const pair = firstCodeCollision(w);
  await apply(w, R); // ініціалізація точки; видач SEO ще немає
  const empty = snapshot(R);
  assert.equal(issuance(R), undefined, "передумова: запису видачі немає");
  sku(w, pair.b); setCells(w, ID, { [SEO_DECISION]: "ЗАТВЕРДИТИ" });
  await apply(w, R, { stamp: later(1 / 60) });
  const branchB = snapshot(R);
  R.store.data.set(CHECKPOINT_KEY, structuredClone(empty));
  sku(w, pair.a); await apply(w, R, { stamp: later(2 / 60) });
  const command = "ЗАТВЕРДИТИ " + issuance(R).code;
  setCells(w, ID, { [SEO_DECISION]: command });
  sku(w, pair.b); R.store.data.set(CHECKPOINT_KEY, branchB);
  await apply(w, R, { stamp: later(3 / 60) });
  assert.equal(stateOf(w, R).seo.has(ID), false, "команда, підтверджена для A, затвердила SEO B після відновлення гілки без запису видачі");
});

// R7.3 (C7, рішення власника 1 від 30.10.2026): після будь-якого відновлення точки всі невикористані підтвердження недійсні — і для
// ТІЄЇ САМОЇ видачі. Очікування цього контролю R7.2 змінено свідомо (у frozen-r7-2 — попереднє очікування «діє»).
test("R7.2-C71-01 (контроль; R7.3 — C7): після відновлення точки підтвердження ТІЄЇ САМОЇ видачі недійсне — відновлення виявлено (RECOVERY_PENDING), після погодженого власником recover команда з кодом гілки B не діє", async () => {
  const w = await prepared(); const R = readinessDouble({ strict: true });
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); sku(w, "C72-BASE");
  await apply(w, R);
  const base = snapshot(R);
  sku(w, "C72-B"); await apply(w, R, { stamp: later(1 / 60) });
  const branchB = snapshot(R);
  setCells(w, ID, { [SEO_DECISION]: "ЗАТВЕРДИТИ " + issuance(R).code }); // власник підтвердив саме видачу для B
  R.store.data.set(CHECKPOINT_KEY, structuredClone(base)); // відновлення поза протоколом A
  assert.equal((await apply(w, R, { stamp: later(2 / 60) })).state, "RECOVERY_PENDING");
  R.store.data.set(CHECKPOINT_KEY, branchB); // повернення гілки B — теж поза протоколом A
  assert.equal((await apply(w, R, { stamp: later(3 / 60) })).state, "RECOVERY_PENDING");
  assert.equal(stateOf(w, R).seo.has(ID), false);
  R.serving.state = "RECOVERY_AUTHORIZED"; // окремий дозвіл власника (Engineering, cc-recovery-v1 крок 3)
  assert.equal((await apply(w, R, { stamp: later(4 / 60), mode: "recover" })).state, "RECOVERED");
  R.serving.finishRecovery();
  await apply(w, R, { stamp: later(5 / 60) });
  assert.equal(stateOf(w, R).seo.has(ID), false, "підтвердження, дане до відновлення, не діє");
  assert.match(viewOf(w, ID)["Попередження"], /видано до відновлення/);
});

test("R7.2-C71-01: епоха видачі — токен оренди запуску; код = перестановка епохи; без оренди (SHADOW) кодів не видано", async () => {
  const m = await import("../src/core/controls-common.mjs");
  const w = await prepared(); const R = readinessDouble(), tokens = [];
  const acquire = R.committer.acquire.bind(R.committer);
  R.committer.acquire = async (scope) => { const l = await acquire(scope); if (scope === LEASE_SCOPE) tokens.push(l.token); return l; };
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" });
  await apply(w, R);
  const x = issuance(R);
  assert.equal(x?.epoch, tokens.at(-1), "видачу прив'язано до токена оренди запуску");
  assert.equal(x.code, m.issuedCode({ offerId: ID, action: "SEO_APPROVE", n: x.epoch }));
  setCells(w, ID, { "SEO опис UA": SEO["SEO опис UA"] + " друга" });
  await apply(w, R, { stamp: later(1) });
  assert.ok(issuance(R).epoch > x.epoch && issuance(R).code !== x.code, "нова видача — нова епоха й новий код");
});

test("R7.2-C71-01: лічильник оренди скинуто (токен не більший за епохи видач у точці) — коди не видаються, є попередження, команди без коду не виконуються; щойно токен перевищив епохи — видача відновлюється", async () => {
  const w = await prepared(); const R = readinessDouble();
  for (let i = 0; i < 4; i++) { setCells(w, ID2, { [SALE_DECISION]: i % 2 ? "" : HOLD }); await apply(w, R, { stamp: later(i) }); }
  const maxEpoch = Math.max(...(cpOf(R).issued || []).map((e) => e.epoch || 0));
  assert.ok(maxEpoch > 0, "передумова: є видачі з епохою");
  const R2 = readinessDouble({ store: R.store }); // новий координатор над тим самим сховищем — лічильник з 1
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" });
  const r = await apply(w, R2, { stamp: later(10) });
  assert.equal(issuance(R2), undefined, "код видано попри токен оренди, не більший за епохи наявних видач");
  assert.match(r.warnings.join(" "), /токен оренди/);
  assert.equal(stateOf(w, R2).seo.has(ID), false);
  let issued = null;
  for (let i = 0; i < 20 && !issued; i++) { await apply(w, R2, { stamp: later(11 + i) }); issued = issuance(R2); }
  assert.ok(issued && issued.epoch > maxEpoch, "видача відновилася, щойно токен перевищив епохи");
});

test("R7.2-C71-01: скинутий лічильник + відновлена старіша точка — епоха повторюється, але код, що вже стоїть у клітинці, повторно не видається", async () => {
  const w = await prepared(); const R = readinessDouble();
  forceTokens(R, [3, 5, 5, 6]);
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" }); sku(w, "C72-BASE");
  await apply(w, R); // епоха 3
  const base = snapshot(R);
  sku(w, "C72-A"); await apply(w, R, { stamp: later(1 / 60) }); // епоха 5 — код для A
  const codeA = issuance(R).code;
  setCells(w, ID, { [SEO_DECISION]: "ЗАТВЕРДИТИ " + codeA });
  R.store.data.set(CHECKPOINT_KEY, structuredClone(base));
  sku(w, "C72-B");
  await apply(w, R, { stamp: later(2 / 60) }); // епоха 5 знову (лічильник скинуто): код дорівнював би коду в клітинці
  await apply(w, R, { stamp: later(3 / 60) }); // епоха 6
  assert.notEqual(issuance(R).code, codeA, "повторено код, що стояв у клітинці");
  assert.equal(stateOf(w, R).seo.has(ID), false, "команда для A затвердила SEO B");
});

// ---------------------------------------------------------------- C71-02 — неповна ідентичність рядка архіву без Offer ID
test("R7.2-C71-02 (Hermes): рядок архіву без Offer ID лише з артикулом / назвою UA / URL, картки в каталозі немає — новинка з тими самими ознаками блокується", async () => {
  const out = [];
  for (const field of ["Артикул постачальника", "Назва постачальника UA", "URL постачальника"]) {
    const w = await prepared(); const R = readinessDouble();
    await apply(w, R);
    const h = w.book[SHEET.main][0], original = rowOf(w, ID);
    w.book[ARCHIVE_SHEET] = [h.slice(), witnessRow(h, original, [field])];
    dropRow(w.book, ID, SHEET.main);
    const st = stateOf(w, R), g = st.gate.check({ ...offerOf(original), id: "C72-REISSUED-ID" });
    out.push({ field, blocked: st.blocked, gateBlocked: g.blocked, kind: g.kind });
  }
  assert.ok(out.every((x) => x.blocked || x.gateBlocked), "неповна ідентичність архіву не блокує той самий товар у фільтрі новинок: " + JSON.stringify(out));
  assert.ok(out.every((x) => x.blocked === false), "без глобальної зупинки");
});

const WITNESS_SETS = [["Артикул постачальника"], ["Назва постачальника UA"], ["Назва постачальника RU"], ["URL постачальника"], ["Артикул постачальника", "URL постачальника"], ["ID постачальника"]];
for (const fields of WITNESS_SETS) {
  test(`R7.2-C71-02: одне правило для каталогу, фільтра новинок і повернення з архіву — ознаки ${fields.join(" + ")}`, async () => {
    // (а) картка в каталозі з цими ознаками — поза YML
    const a = await prepared(), h = a.book[SHEET.main][0];
    a.book[ARCHIVE_SHEET] = [h.slice(), witnessRow(h, rowOf(a, ID), fields)];
    const Ra = readinessDouble();
    await apply(a, Ra);
    const sa = stateOf(a, Ra);
    assert.ok(sa.tombstoned.has(ID) && sa.held.has(ID) && !sa.blocked, "каталог: картка з ознаками рядка лишилась у YML");
    // (б) картки немає — фільтр новинок блокує той самий товар (зокрема під новим ID)
    const b = await prepared(), Rb = readinessDouble(), original = rowOf(b, ID);
    await apply(b, Rb);
    b.book[ARCHIVE_SHEET] = [h.slice(), witnessRow(h, original, fields)];
    dropRow(b.book, ID, SHEET.main);
    const sb = stateOf(b, Rb);
    assert.equal(sb.gate.check(offerOf(original)).blocked, true, "фільтр: той самий товар не заблоковано");
    if (!fields.includes("ID постачальника")) assert.equal(sb.gate.check({ ...offerOf(original), id: "C72-NEW-ID" }).blocked, true, "фільтр: той самий товар під новим ID не заблоковано");
    // (в) повернення з архіву товару з цими ознаками — відмова
    const c = await prepared(), Rc = readinessDouble();
    await confirmR(c, Rc, ID, HOLD);
    await confirmR(c, Rc, ID, DEL, 1);
    copyRow(c.book, ID, SHEET.main, ARCHIVE_SHEET); dropRow(c.book, ID, SHEET.main);
    setCells(c, ID, { [SALE_DECISION]: BACK }, ARCHIVE_SHEET);
    await apply(c, Rc, { stamp: later(3) });
    const back = codeOf(c, ID, BACK);
    const arch = c.book[ARCHIVE_SHEET], card = Object.fromEntries(arch[0].map((k, j) => [mtText(k), arch.find((r, i) => i && r[0] === ID)[j]]));
    arch.push(witnessRow(arch[0], card, fields));
    setCells(c, ID, { [SALE_DECISION]: `${BACK} ${back}` }, ARCHIVE_SHEET);
    await apply(c, Rc, { stamp: later(4) });
    const sc = stateOf(c, Rc);
    assert.ok(!sc.moves.toCatalog.includes(ID) && sc.tombstoned.has(ID), "повернення з архіву прийнято попри рядок з тими самими ознаками");
  });
}

test("R7.2-C71-02 (контроль): неповні ознаки не зачіпають незалежних товарів — інші новинки не блокуються, сусідня команда виконується, ручна правка третього не знімає його з продажу", async () => {
  const w = await prepared(); const R = readinessDouble();
  setCells(w, ID2, { [SALE_DECISION]: HOLD });
  await apply(w, R);
  const hold = codeOf(w, ID2, HOLD), h = w.book[SHEET.main][0], original = rowOf(w, ID);
  w.book[ARCHIVE_SHEET] = [h.slice(), witnessRow(h, original, ["Артикул постачальника"])];
  dropRow(w.book, ID, SHEET.main);
  const third = mainIds(w).find((x) => x !== ID && x !== ID2);
  setCells(w, third, { "Назва UA": "Незалежна ручна правка R7.2" });
  setCells(w, ID2, { [SALE_DECISION]: `${HOLD} ${hold}` });
  await apply(w, R, { stamp: later(1) });
  const s = stateOf(w, R);
  assert.equal(s.blocked, false);
  assert.ok(s.held.has(ID2), "сусідня команда виконана");
  assert.ok(!s.held.has(third) && !s.tombstoned.has(third) && !s.damaged.has(third), "ручна правка не знімає товар");
  assert.equal(rowOf(w, third)["Назва UA"], "Незалежна ручна правка R7.2");
  assert.equal(s.gate.check(offerOf(rowOf(w, ID2))).blocked, false, "інший товар постачальника не блокується");
  assert.equal(s.gate.check({ ...offerOf(original), id: "C72-OTHER", sku: "C72-INSHYI-ARTYKUL" }).blocked, false, "ті самі назви, інший артикул — ознака рядка не збігається");
});

test("R7.2-C71-02: діагностика рядка без Offer ID — «товар не визначено», неповна ідентичність і перелік ознак; відмова фільтра посилається на рядок", async () => {
  const w = await prepared(); const R = readinessDouble();
  await apply(w, R);
  const h = w.book[SHEET.main][0], original = rowOf(w, ID);
  w.book[ARCHIVE_SHEET] = [h.slice(), witnessRow(h, original, ["Артикул постачальника", "URL постачальника"])];
  dropRow(w.book, ID, SHEET.main);
  const s = stateOf(w, R), text = s.issues.join(" | ");
  assert.match(text, new RegExp(`«${ARCHIVE_SHEET}», рядок 2: рядок без Offer ID — товар не визначено \\(неповна ідентичність, ознаки: Артикул постачальника, URL постачальника\\)`));
  const g = s.gate.check({ ...offerOf(original), id: "C72-NEW-ID" });
  assert.equal(g.kind, "UNIDENTIFIED_ARCHIVE");
  assert.match(g.reason, new RegExp(`«${ARCHIVE_SHEET}», рядок 2`));
});
