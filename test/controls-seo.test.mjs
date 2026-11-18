/** Catalog Controls — SEO-метадані (редакція після BLOCK Hermes): затвердження лише кодом, прив'язаним до тексту чернетки;
 *  жодного запису в «Основний каталог»; історія версій без автоповернення в картку; «Було → Стало» щодо даних постачальника;
 *  відокремлення від назв / описів / «Запитів»; безпечний експорт; fail-closed. */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { GROUP_HEADERS, approvalManifest } from "../src/core/seal.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { ACTION, CC_SHEET, PROM_SEARCH_FIELDS, SEO_DECISION, SEO_META_FIELDS } from "../src/core/controls-common.mjs";
import { seoExport, validateSeo } from "../src/core/controls-seo.mjs";
import { controlsState } from "../src/core/controls-plan.mjs";
import { buildYml, memorySink, objectsFromValues } from "../src/core/yml.mjs";
import { syncAndIntake } from "./helpers/intake.mjs";
import baseConfig from "../config/default.json" with { type: "json" };
import { ACTIVE_CONTRACT, STAMP, NOW, ccControls, prepared, run, confirm, codeOf, viewOf, rowOf, mainRows, eventsOf, evField, setCells, touchedMain, later } from "./helpers/controls.mjs";

const SEO = { "SEO заголовок UA": "Дриль ALPHA AL-1000 — купити в Майстерні", "SEO заголовок RU": "Дрель ALPHA AL-1000 — купить в Мастерской", "SEO опис UA": "Дриль ALPHA AL-1000: гарантія, доставка по Україні.", "SEO опис RU": "Дрель ALPHA AL-1000: гарантия, доставка по Украине." };
const ID = "1500000007";
const state = (w) => controlsState(structuredClone(w.book), { contract: ACTIVE_CONTRACT, checkpoint: w.store.data.get("state/catalog-controls/checkpoint.json") ?? null });

test("Активація: контракт репозиторію не активовано → apply заборонено; shadow — лише читання (книга без змін), план і «Стан керування» в пам'яті", async () => {
  const w = await prepared();
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" });
  const snap = structuredClone(w.book);
  const na = await run(w, { contract: "repo" });
  assert.equal(na.state, "NOT_ACTIVATED");
  const sh = await run(w, { contract: "repo", mode: "shadow" });
  assert.equal(sh.state, "SHADOW", JSON.stringify(sh));
  assert.ok(sh.view.some((r) => r[0] === ID && /ЗАТВЕРДИТИ [0-9A-F]{6}/.test(r[5])), "код показано в пам'яті");
  assert.deepEqual(w.book, snap, "shadow нічого не записав");
  assert.equal(w.sheets.calls.length, 0);
});

test("SEO: «ЗАТВЕРДИТИ» без коду — лише підказка й код; з кодом — подія з усіма значеннями й знімком постачальника; «Основний каталог» і паспорт байт-у-байт; команду не очищено; повтор — без подій", async () => {
  const w = await prepared();
  setCells(w, ID, SEO);
  const mainBefore = structuredClone(w.book[SHEET.main]), passport = structuredClone(w.book[SHEET.passport]);
  const { r1, r2, code } = await confirm(w, ID, SEO_DECISION, "ЗАТВЕРДИТИ");
  assert.equal(r1.stats.awaitingCode, 1);
  assert.equal(r2.state, "COMMITTED", JSON.stringify(r2));
  const ev = eventsOf(w, ID, ACTION.SEO_APPROVED);
  assert.equal(ev.length, 1);
  const after = JSON.parse(evField(ev[0], "Стало"));
  assert.deepEqual(after.values, SEO);
  assert.equal(after.supplier.text["Назва постачальника UA"], rowOf(w, ID)["Назва постачальника UA"]);
  assert.equal(evField(ev[0], "Покоління"), "seo:1");
  // Єдина зміна в «Основному каталозі» — команда, яку написав сам власник.
  const dec = w.book[SHEET.main][0].indexOf(SEO_DECISION);
  const strip = (v) => v.map((r) => r.map((x, j) => (j === dec ? "" : mtText(x))).filter((_, j) => j < Math.max(v[0].length, r.length)));
  assert.deepEqual(strip(w.book[SHEET.main]).map((r) => r.join("\u0001").replace(/\u0001+$/, "")), strip(mainBefore).map((r) => r.join("\u0001").replace(/\u0001+$/, "")), "каталог без змін, крім команди власника");
  assert.deepEqual(w.book[SHEET.passport], passport);
  assert.equal(touchedMain(w.sheets.calls).length, 0, "жодного запису в «Основний каталог»");
  assert.match(viewOf(w, ID).SEO, /^ЗАТВЕРДЖЕНО 2026-10-29 · версія 1 · [0-9a-f]{16}$/);
  assert.deepEqual(r2.seo.get(ID).values, SEO);
  assert.equal(rowOf(w, ID)[SEO_DECISION], `ЗАТВЕРДИТИ ${code}`, "клітинку команди не очищено");
  const again = await run(w, { stamp: later(1) });
  assert.equal(again.state, "COMMITTED");
  assert.equal(eventsOf(w, ID).length, 1, "виконана команда не повторюється");
});

test("SEO: код прив'язаний до тексту — правка після отримання коду або після затвердження з тією самою командою не затверджується; невалідні значення — відмова", async () => {
  const w = await prepared();
  setCells(w, ID, { ...SEO, [SEO_DECISION]: "ЗАТВЕРДИТИ" });
  await run(w);
  const code = codeOf(w, ID, "ЗАТВЕРДИТИ");
  setCells(w, ID, { "SEO заголовок UA": "Змінено після отримання коду", [SEO_DECISION]: `ЗАТВЕРДИТИ ${code}` });
  const r = await run(w, { stamp: later(1) });
  assert.equal(r.stats.seoApproved, 0);
  assert.match(viewOf(w, ID)["Попередження"], /код недійсний або застарів/);
  const code2 = codeOf(w, ID, "ЗАТВЕРДИТИ");
  assert.notEqual(code2, code);
  setCells(w, ID, { [SEO_DECISION]: `ЗАТВЕРДИТИ ${code2}` });
  await run(w, { stamp: later(2) });
  setCells(w, ID, { "SEO опис UA": "Ще одна правка, команда та сама" });
  const r3 = await run(w, { stamp: later(3) });
  assert.equal(r3.stats.seoApproved, 0, "стара команда не затверджує нову правку");
  assert.equal(eventsOf(w, ID, ACTION.SEO_APPROVED).length, 1);
  assert.match(viewOf(w, ID)["Попередження"], /у картці чернетка, відмінна від затвердженої — діє затверджене/);
  // невалідні значення
  const bad = { "SEO заголовок UA": "<b>Дриль</b>", "SEO заголовок RU": " Дрель", "SEO опис UA": "рядок 1\nрядок 2", "SEO опис RU": "x".repeat(251) };
  setCells(w, "1500000014", { ...bad, [SEO_DECISION]: "ЗАТВЕРДИТИ" });
  await run(w, { stamp: later(4) });
  setCells(w, "1500000014", { [SEO_DECISION]: `ЗАТВЕРДИТИ ${codeOf(w, "1500000014", "ЗАТВЕРДИТИ")}` });
  await run(w, { stamp: later(5) });
  const warn = viewOf(w, "1500000014")["Попередження"];
  for (const part of ["HTML-теги", "пробіли", "перенесення рядка", "ліміт імпорту Prom 250"]) assert.ok(warn.includes(part), part);
  assert.equal(eventsOf(w, "1500000014").length, 0);
  assert.deepEqual(validateSeo({ "SEO заголовок UA": "ж".repeat(270) }), []);
  assert.equal(validateSeo({ "SEO заголовок UA": "ж".repeat(271) }).length, 1);
});

test("SEO: усі версії зберігаються; очищені клітинки картки система НЕ заповнює (автоповернення немає) — діє затверджене, у «Стані керування» попередження", async () => {
  const w = await prepared();
  setCells(w, ID, SEO);
  await confirm(w, ID, SEO_DECISION, "ЗАТВЕРДИТИ");
  setCells(w, ID, { "SEO заголовок UA": "Версія 2" });
  await confirm(w, ID, SEO_DECISION, "ЗАТВЕРДИТИ", { stamp: later(1) });
  const versions = eventsOf(w, ID, ACTION.SEO_APPROVED).map((e) => JSON.parse(evField(e, "Стало")).values["SEO заголовок UA"]);
  assert.deepEqual(versions, [SEO["SEO заголовок UA"], "Версія 2"]);
  setCells(w, ID, Object.fromEntries(SEO_META_FIELDS.map((k) => [k, ""])));
  const r = await run(w, { stamp: later(2) });
  for (const k of SEO_META_FIELDS) assert.equal(rowOf(w, ID)[k], "", "картку не заповнено системою");
  assert.equal(r.seo.get(ID).values["SEO заголовок UA"], "Версія 2", "діє затверджене");
  assert.match(viewOf(w, ID)["Попередження"], /у картці порожньо — діє затверджене/);
  assert.equal(touchedMain(w.sheets.calls).length, 0);
});

test("SEO: «Було → Стало» — дані постачальника змінились після затвердження (назва, артикул, характеристики) — попередження в «Стані керування»", async () => {
  const w = await prepared();
  setCells(w, ID, SEO);
  await confirm(w, ID, SEO_DECISION, "ЗАТВЕРДИТИ");
  const oldName = rowOf(w, ID)["Назва постачальника UA"];
  setCells(w, ID, { "Назва постачальника UA": "Нова назва постачальника" }); // так змінює сирі дані синхронізація
  await run(w, { stamp: later(1) });
  const warn = viewOf(w, ID)["Попередження"];
  assert.match(warn, /дані постачальника змінились після затвердження SEO \(Було → Стало\)/);
  assert.ok(warn.includes(`Назва постачальника UA: «${oldName.slice(0, 40)}`));
  assert.ok(warn.includes("→ «Нова назва постачальника»"));
});

test("SEO окремо від назв, описів і «Запитів»: YML байт-у-байт той самий, SEO не потрапляє в YML; експорт — лише картки з каталогу, не виключені; blockedBy S1; confirmed=false", async () => {
  const w = await prepared();
  const config = structuredClone(baseConfig);
  assert.equal((await syncAndIntake({ ...w, sheets: w.mem }, w.xml, { stamp: STAMP, now: NOW, config, controls: await ccControls(w) })).state, "SYNCED");
  const yml = async () => {
    const rows = mainRows(w), groups = objectsFromValues(w.book[SHEET.groups], GROUP_HEADERS), sink = memorySink();
    await buildYml({ rows, groups, manifest: approvalManifest(rows, groups), meta: { syncState: "OK", lastSuccess: STAMP, now: NOW + 60000 }, config: config.yml, pricing: config.pricing, maximumBytes: 50_000_000, sink, missingPolicy: "unavailable", conflictPolicy: "isolate" });
    return sink.text();
  };
  const before = await yml();
  const row0 = rowOf(w, ID);
  setCells(w, ID, SEO);
  await confirm(w, ID, SEO_DECISION, "ЗАТВЕРДИТИ", { stamp: later(1) });
  for (const k of PROM_SEARCH_FIELDS) assert.equal(rowOf(w, ID)[k], row0[k]);
  setCells(w, ID, Object.fromEntries([...SEO_META_FIELDS, SEO_DECISION].map((k) => [k, ""]))); // клітинки власника в YML не беруть участі
  const after = await yml();
  assert.equal(after, before, "YML не змінився");
  for (const v of Object.values(SEO)) assert.ok(!after.includes(v));
  const st = state(w);
  const rowsById = new Map(mainRows(w).map((x) => [x["Offer ID"], x]));
  const exp = seoExport(st.seo, { rowsById, excluded: new Set(st.tombstoned.keys()) });
  assert.equal(exp.confirmed, false);
  assert.match(exp.blockedBy[0], /^S1/);
  assert.deepEqual(exp.items.map((x) => x.offerId), [ID]);
  assert.deepEqual(exp.items[0].columns, { "HTML_заголовок_укр": SEO["SEO заголовок UA"], "HTML_заголовок": SEO["SEO заголовок RU"], "HTML_опис_укр": SEO["SEO опис UA"], "HTML_опис": SEO["SEO опис RU"] });
  assert.equal(seoExport(st.seo, { rowsById: new Map(), excluded: new Set() }).items.length, 0, "без картки — не експортується");
  assert.equal(seoExport(st.seo, { rowsById, excluded: new Set([ID]) }).items.length, 0, "виключений — не експортується");
});

test("SEO fail-closed: ручна правка рядка журналу — SEO товару не діє, товар тимчасово поза продажем, команди не виконуються; після виправлення рядка — усе чинне", async () => {
  const w = await prepared();
  setCells(w, ID, SEO);
  await confirm(w, ID, SEO_DECISION, "ЗАТВЕРДИТИ");
  const h = w.book[CC_SHEET.history];
  const i = h.findIndex((r) => r[2] === ID);
  const original = h[i][6];
  h[i][6] = original.replace("купити", "КУПИТИ");
  const st = state(w);
  assert.ok(!st.seo.has(ID));
  assert.ok(st.held.has(ID), "fail-closed");
  const r = await run(w, { stamp: later(1) });
  assert.equal(r.state, "COMMITTED", JSON.stringify(r));
  assert.match(viewOf(w, ID)["Продаж"], /^ПОЗА ПРОДАЖЕМ \(ізольовано\)/);
  assert.ok(w.store.data.get("state/catalog-controls/checkpoint.json").ops.some((e) => e.op === h[i][1]), "контрольна точка тримає Operation ID пошкодженого рядка (його видалення буде помічено)");
  h[i][6] = original;
  const st2 = state(w);
  assert.ok(st2.seo.has(ID) && !st2.held.has(ID), "після виправлення — як було");
});

test("Пошкоджено структуру журналу (немає колонки) — запуск BLOCKED, нічого не записано; R5-D: стан для конвеєра — з контрольної точки (не blocked, не «все дозволено» і не масове зняття)", async () => {
  const w = await prepared();
  setCells(w, ID, SEO);
  await confirm(w, ID, SEO_DECISION, "ЗАТВЕРДИТИ");
  const before = state(w);
  w.book[CC_SHEET.history][0][3] = "Дія (перейменовано)";
  const snap = structuredClone(w.book);
  const r = await run(w, { stamp: later(1) });
  assert.equal(r.state, "BLOCKED");
  assert.match(r.reason, /немає колонок Дія/);
  assert.deepEqual(w.book, snap);
  const st = state(w);
  // R4 → R5: журнал — дзеркало; довірений стан повністю з точки, тому споживачі працюють далі.
  assert.equal(st.blocked, false);
  assert.equal(st.held.size, 0, "без масового зняття");
  assert.ok(st.seo.has(ID), "затверджене SEO з точки чинне");
  assert.notEqual(st.fingerprint, before.fingerprint, "зміна журналу видима для verifyControlsSnapshot");
});
