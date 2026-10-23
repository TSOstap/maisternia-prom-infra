/** «Сторож новинок»: 7 погоджених симуляцій (22.10.2026) + захисти від повторів і конфліктів. Наскрізно: Worker → GitHub intake → таблиця. */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { SHEET } from "../src/core/sheet-sync.mjs";
import { WatchSim, fullOffer, MIN, T0 } from "./helpers/watch-sim.mjs";

const ID = "2960000001";
const iso = (t) => new Date(t).toISOString();

test("1. нова порожня картка поступово заповнюється: кандидат → (назва, артикул, фото, характеристики) → лише після 10 хв стабільності й повних даних — у черзі", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer({ id: ID, nameRu: "Новый товар", price: 0 }); // лише російська назва, без ціни, артикулу, фото, характеристик
  let rep = await sim.tick(); // t+5
  const appeared = sim.now;
  assert.equal(rep.candidates, 1);
  assert.equal(rep.ready, 0);
  sim.setOffer({ nameUa: "Новий товар", sku: "NT-1", price: 1500 }); rep = await sim.tick();          // t+10
  sim.setOffer({ pictures: ["https://images.prom.ua/4800000001_nt.jpg"] }); rep = await sim.tick();   // t+15
  sim.setOffer({ params: [{ name: "Потужність", value: "800", unit: "Вт" }] }); rep = await sim.tick(); // t+20 — остання зміна
  const lastChange = sim.now;
  rep = await sim.tick(); // t+25: 5 хв стабільності — ще ні
  assert.equal(sim.calls.dispatch, 0, "до 10 хв стабільності GitHub не запускається");
  assert.ok(!sim.queueRow(ID));
  let st = (await sim.status()).candidates.find((c) => c.id === ID);
  assert.equal(st.status, "СПОСТЕРЕЖЕННЯ");
  assert.deepEqual(st.history.map((h) => h.what), ["ПОЯВА", "ЗМІНА: назва UA, артикул", "ЗМІНА: фото", "ЗМІНА: характеристики"]);
  rep = await sim.tick(); // t+30: 10 хв без змін
  assert.equal(sim.calls.dispatch, 1, "один запуск GitHub");
  assert.ok(!sim.calls.dispatchBodies[0].includes(ID), "у запуск GitHub не передаються ID товарів");
  const q = sim.queueRow(ID);
  assert.ok(q, "у черзі «Нові товари»");
  assert.equal(q["Виявлено"], iso(appeared), "час першого виявлення");
  assert.equal(q["Остання зміна постачальника"], iso(lastChange), "час останньої суттєвої зміни");
  assert.equal(q["Статус імпорту"], "НОВИЙ_ВІД_ПОСТАЧАЛЬНИКА");
  assert.equal(sim.rows(SHEET.main).length, 132, "в основний каталог — нічого");
  assert.ok(!(await sim.status()).candidates.some((c) => c.id === ID), "після підтвердження — не кандидат");
  // Відбиток черги з таблиці = відбиток Worker із фіду → немає «вічного» оновлення
  rep = await sim.tick(); rep = await sim.tick(); rep = await sim.tick();
  assert.equal(rep.queueChanged, 0);
  assert.equal(sim.calls.dispatch, 1, "зайвих запусків GitHub немає");
});

test("неповна, але стабільна картка (немає фото) — лишається кандидатом «НЕПОВНИЙ», GitHub не запускається", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer(ID, { pictures: [] }));
  for (let k = 0; k < 6; k++) await sim.tick();
  assert.equal(sim.calls.dispatch, 0);
  const st = (await sim.status()).candidates.find((c) => c.id === ID);
  assert.equal(st.status, "НЕПОВНИЙ");
  assert.deepEqual(st.missing, ["фото"]);
});

test("2. назва чи характеристики змінились через 7 хв — період стабільності починається заново", async () => {
  for (const change of [{ nameUa: "Шуруповерт акумуляторний Test 001 18 В Pro" }, { params: [{ name: "Напруга", value: "20", unit: "В" }] }]) {
    const sim = new WatchSim();
    await sim.start();
    sim.setOffer(fullOffer(ID));
    await sim.tick(); // t+5 — поява
    sim.now += 2 * MIN; sim.setOffer(change); sim.now -= 2 * MIN; // зміна о t+7 (Worker побачить її на t+10)
    await sim.tick(); // t+10 — бачить зміну
    const changedAt = sim.now;
    await sim.tick(); // t+15 — без змін 10 хв від появи, але лише 5 від зміни
    assert.equal(sim.calls.dispatch, 0, "без змін 10 хв від появи — недостатньо, бо була зміна");
    await sim.tick(); // t+20 — 10 хв від зміни
    assert.equal(sim.calls.dispatch, 1);
    assert.equal(sim.queueRow(ID)["Остання зміна постачальника"], iso(changedAt));
    assert.match(sim.journal(ID).find((e) => e[3] === "НОВИЙ")[6], /НОВИЙ_ВІД_ПОСТАЧАЛЬНИКА|МОЖЛИВИЙ ДУБЛЬ/);
  }
});

test("3. XML оновився, а дата yml_catalog — та сама: зміна картки виявляється за контрольною сумою полів", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.yearDate = "2026-10-22 13:00"; // дата фіду не змінюється взагалі
  sim.setOffer(fullOffer(ID));
  await sim.tick();
  sim.setOffer({ pictures: ["https://images.prom.ua/4899999999_inshe.jpg"] });
  const rep = await sim.tick();
  assert.equal(rep.feedDate, "2026-10-22 13:00");
  const st = (await sim.status()).candidates.find((c) => c.id === ID);
  assert.deepEqual(st.history.map((h) => h.what), ["ПОЯВА", "ЗМІНА: фото"]);
  // Той самий фід без змін (позиція вже в черзі): кандидати не переписуються — лише службові рядки циклу
  for (let k = 0; k < 3; k++) await sim.tick();
  const w0 = sim.dctx.counters.rowsWritten;
  await sim.tick();
  await sim.tick();
  assert.ok(sim.dctx.counters.rowsWritten - w0 <= 2 * 6, `рядків записано ${sim.dctx.counters.rowsWritten - w0} за 2 цикли (без змін даних)`);
});

test("4. SEO вже підготовлено, а постачальник змінив комплектацію: сирі дані оновлено, SEO не змінено, «ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ», затвердження заблоковано", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer(ID, { nameUa: "Шуруповерт Test 18 В 1 АКБ", nameRu: "Шуруповерт Test 18 В 1 АКБ", params: [{ name: "Кількість акумуляторів у комплекті", value: "1", unit: "шт" }] }));
  for (let k = 0; k < 3; k++) await sim.tick();
  assert.ok(sim.queueRow(ID));
  // Власник готує SEO
  sim.setCell(ID, "Назва UA", "SEO: Шуруповерт Test 18 В з одним АКБ");
  sim.setCell(ID, "Опис UA", "<p>Наш SEO-опис</p>");
  await sim.sync();
  assert.doesNotMatch(sim.queueRow(ID)["Перевірка"], /ПОТРЕБУЄ/);
  // Постачальник змінює комплектацію
  sim.setOffer({ nameUa: "Шуруповерт Test 18 В 2 АКБ", nameRu: "Шуруповерт Test 18 В 2 АКБ", params: [{ name: "Кількість акумуляторів у комплекті", value: "2", unit: "шт" }] });
  let rep = await sim.tick();
  assert.equal(rep.queueChanged, 1);
  assert.equal(sim.calls.dispatch, 1, "ще 10 хв стабільності — без запуску");
  await sim.tick(); await sim.tick();
  assert.equal(sim.calls.dispatch, 2, "запуск оновлення черги після 10 хв стабільності");
  const q = sim.queueRow(ID);
  assert.equal(q["Назва постачальника UA"], "Шуруповерт Test 18 В 2 АКБ", "сирі дані оновлено");
  assert.equal(q["Назва UA"], "SEO: Шуруповерт Test 18 В з одним АКБ", "SEO-назву не перезаписано");
  assert.equal(q["Опис UA"], "<p>Наш SEO-опис</p>", "SEO-опис не перезаписано");
  assert.match(q["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ: .*назва UA.*характеристики.*різниця комплектації: кількість АКБ/);
  assert.ok(sim.journal(ID).some((e) => e[3] === "Назва постачальника UA" && e[6] === "ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ"), "зміни — у «Журналі»");
  // Затвердження блокується
  sim.setCell(ID, "Група ID", sim.rows(SHEET.main)[0]["Група ID"]);
  sim.setCell(ID, "Категорія Prom ID", "501");
  sim.setDecision(ID, "ЗАТВЕРДЖЕНО (НЕ ДУБЛЬ)");
  const r = await sim.sync();
  assert.equal(r.stats.approved, 0);
  assert.match(sim.queueRow(ID)["Перевірка"], /НЕ ПЕРЕНЕСЕНО: ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ/);
  assert.equal(sim.rows(SHEET.main).length, 132);
});

test("5. власник підтвердив дані («ПЕРЕВІРЕНО» прив'язано до SHA), постачальник змінив їх знову — підтвердження недійсне; застаріла SHA не приймається", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer(ID));
  for (let k = 0; k < 3; k++) await sim.tick();
  sim.setCell(ID, "Назва UA", "SEO-назва");
  sim.setCell(ID, "Група ID", sim.rows(SHEET.main)[0]["Група ID"]);
  sim.setCell(ID, "Категорія Prom ID", "501");
  await sim.sync();
  sim.setOffer({ pictures: ["https://images.prom.ua/4811111111_a.jpg", "https://images.prom.ua/4811111112_b.jpg"] });
  for (let k = 0; k < 3; k++) await sim.tick();
  let q = sim.queueRow(ID);
  assert.match(q["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ.*фото/);
  const seenSha = q["SHA даних постачальника"];
  // Підтвердження з явною SHA, яку власник бачив
  sim.setDecision(ID, "ПЕРЕВІРЕНО " + seenSha);
  await sim.sync();
  q = sim.queueRow(ID);
  assert.equal(q["Погоджено для SHA"], seenSha);
  assert.equal(mtText(q["Рішення"]), "", "рішення «ПЕРЕВІРЕНО» прийнято й очищено");
  assert.doesNotMatch(q["Перевірка"], /ПОТРЕБУЄ/);
  assert.ok(sim.journal(ID).some((e) => e[3] === "ПЕРЕВІРЕНО" && e[5] === seenSha));
  // Постачальник знову змінює — підтвердження недійсне
  sim.setOffer({ params: [{ name: "Напруга", value: "21", unit: "В" }] });
  for (let k = 0; k < 3; k++) await sim.tick();
  q = sim.queueRow(ID);
  assert.match(q["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ.*характеристики/);
  assert.equal(q["Погоджено для SHA"], seenSha, "погоджена SHA лишилась попередньою");
  assert.notEqual(q["SHA даних постачальника"], seenSha);
  // Стара SHA більше не підходить
  sim.setDecision(ID, "ПЕРЕВІРЕНО " + seenSha);
  await sim.sync();
  q = sim.queueRow(ID);
  assert.match(q["Перевірка"], /«ПЕРЕВІРЕНО» не прийнято: указана SHA не відповідає поточній/);
  assert.match(q["Перевірка"], /ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ/);
  // «ПЕРЕВІРЕНО» без SHA = поточні дані в рядку; якщо постачальник змінив їх ДО цього запуску — знову потрібна перевірка
  sim.setDecision(ID, "ПЕРЕВІРЕНО");
  sim.setOffer({ nameUa: "Шуруповерт акумуляторний Test 001 18 В NEW" });
  await sim.sync();
  q = sim.queueRow(ID);
  assert.match(q["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ.*назва UA/, "підтверджено те, що бачив власник, а не свіжі дані");
});

test("6. Worker тимчасово недоступний: синхронізація НЕ додає новинок (лишаються кандидатами), ціни й наявність затверджених — оновлюються", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.workerUp = false;
  sim.setOffer(fullOffer(ID));
  const card = sim.rows(SHEET.main)[3];
  const re = new RegExp(`(<offer id="${card["ID постачальника"]}"[\\s\\S]*?<price>)([^<]+)(</price>)`);
  sim.baseXml = sim.baseXml.replace(re, (_, a, p, b) => a + String(Number(p) + 100) + b);
  sim.now += 4 * 60 * MIN;
  const r = await sim.sync();
  assert.equal(r.state, "SYNCED");
  assert.ok(!sim.queueRow(ID), "без підтвердженої стабільності — не в черзі");
  assert.equal(r.stats.queue.candidatesInFeed, 1, "кандидат лишається (у звіті — лише кількість)");
  assert.ok(!sim.book[SHEET.journal].some((e) => e[3] === "НОВИЙ"));
  const after = sim.rows(SHEET.main).find((x) => x["Offer ID"] === card["Offer ID"]);
  assert.equal(Number(after["Ціна постачальника"]), Number(card["Ціна постачальника"]) + 100, "ціни затверджених оновлюються як завжди");
  // Worker відновився — новинка проходить звичайний шлях
  sim.workerUp = true;
  for (let k = 0; k < 3; k++) await sim.tick();
  assert.ok(sim.queueRow(ID));
});

test("7. дві схожі модифікації інструмента з різною комплектацією — обидві в черзі окремо, з поясненням різниці; без автоматичного об'єднання", async () => {
  const sim = new WatchSim();
  await sim.start();
  const A = "2960000011", B = "2960000012";
  sim.setOffer(fullOffer(A, { nameUa: "Пила ланцюгова акумуляторна Edon ACS-20 BL 2 АКБ 4 Ah", nameRu: "Пила цепная аккумуляторная Edon ACS-20 BL 2 АКБ 4 Ah", sku: "ACS-20 BL", vendor: "Edon", model: "ACS-20 BL",
    params: [{ name: "Кількість акумуляторів у комплекті", value: "2", unit: "шт" }, { name: "Ємність акумулятора", value: "4", unit: "Ач" }] }));
  sim.setOffer(fullOffer(B, { nameUa: "Пила ланцюгова акумуляторна Edon ACS-20 BL без АКБ", nameRu: "Пила цепная аккумуляторная Edon ACS-20 BL без АКБ", sku: "ACS-20 BL SOLO", vendor: "Edon", model: "ACS-20 BL",
    pictures: ["https://images.prom.ua/4822222222_solo.jpg"], params: [{ name: "Кількість акумуляторів у комплекті", value: "0", unit: "шт" }] }));
  for (let k = 0; k < 3; k++) await sim.tick();
  const qa = sim.queueRow(A), qb = sim.queueRow(B);
  assert.ok(qa && qb, "обидві позиції в черзі");
  const note = [qa["Перевірка"], qb["Перевірка"]].join(" | ");
  assert.match(note, /СХОЖІ ПОЗИЦІЇ В ЧЕРЗІ/);
  assert.match(note, /КОМПЛЕКТАЦ/);
  assert.equal(mtText(qa["Рішення"]) + mtText(qb["Рішення"]), "", "рішень система не ставить");
  assert.equal(sim.rows(SHEET.main).length, 132);
});

test("захисти: повторний запуск intake без дублів («ВЖЕ Є»); підтвердження загубилось — повтор після тайм-ауту; ліміт запусків на добу", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer(ID));
  for (let k = 0; k < 3; k++) await sim.tick();
  assert.ok(sim.queueRow(ID));
  const before = sim.rows().length;
  const again = await sim.github(); // повторний запуск: DO доданого вже не віддає
  assert.equal(again.stats.ready, 0, "DO не передає доданого повторно");
  assert.equal(sim.rows().length, before, "без дубля");
  // Навіть якщо старий список потрапить в intake напряму — «ВЖЕ Є», без другої позиції
  const { intakeAll, readyFromXml } = await import("./helpers/intake.mjs");
  const direct = await intakeAll({ sheets: sim.sheets, readBook: sim.readBook }, sim.xml(), { stamp: sim.stamp(), now: sim.now, config: sim.config, ready: readyFromXml(sim.xml(), sim.now, { ids: [ID] }) });
  assert.equal(direct.stats.results["ВЖЕ Є"], 1);
  assert.equal(sim.rows().length, before, "без дубля");

  // Підтвердження не дійшло (GitHub упав після запису) — Worker повторить після тайм-ауту
  const ID2 = "2960000002";
  sim.setOffer(fullOffer(ID2));
  sim.github = async () => ({ lost: true }); // запуск «зник»
  for (let k = 0; k < 3; k++) await sim.tick();
  const d1 = sim.calls.dispatch;
  for (let k = 0; k < 6; k++) await sim.tick(); // 30 хв — ще в межах тайм-ауту 60 хв
  assert.equal(sim.calls.dispatch, d1, "до тайм-ауту — без повторів");
  for (let k = 0; k < 7; k++) await sim.tick();
  assert.equal(sim.calls.dispatch, d1 + 1, "після тайм-ауту — один повтор");
});

test("ліміти безкоштовних квот: не більше 12 запусків GitHub за добу UTC і не частіше ніж раз на 15 хв", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.github = async () => ({ lost: true }); // GitHub ніколи не підтверджує — Worker повторює лише за правилами
  let n = 0;
  for (let k = 0; k < 288; k++) { // доба кроками по 5 хв
    if (k % 6 === 0) sim.setOffer(fullOffer(String(2961000000 + n++))); // нова позиція щопівгодини
    await sim.tick();
  }
  const perDay = {};
  for (const at of sim.calls.dispatchAt || []) { const d = new Date(at).toISOString().slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; }
  assert.ok(Object.values(perDay).every((n) => n <= 12), `запусків GitHub за добу UTC: ${JSON.stringify(perDay)} (≤ 12)`);
  const gaps = (sim.calls.dispatchAt || []).slice(1).map((t, i) => t - sim.calls.dispatchAt[i]);
  assert.ok(gaps.every((g) => g >= 15 * MIN), "не частіше ніж раз на 15 хв");
  assert.ok(sim.calls.feed <= 288);
  // SQLite DO Free: 100 тис. записаних і 5 млн прочитаних рядків на добу; резерв ≥30%. +288 рядків за setAlarm (рахується Cloudflare).
  assert.ok(sim.dctx.counters.rowsWritten + 288 < 70_000, `рядків записано ${sim.dctx.counters.rowsWritten} (+288 setAlarm) < 70 тис.`);
  assert.ok(sim.dctx.counters.rowsRead < 3_500_000, `рядків прочитано ${sim.dctx.counters.rowsRead} < 3,5 млн`);
});

test("intake перевіряє Worker «не на слово»: дані змінилися після передачі або стабільність не підтверджена — відмова з причиною, кандидат знову під спостереженням", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer(ID));
  const realGithub = sim.github.bind(sim);
  let changeBeforeIntake = true;
  sim.github = async () => { if (changeBeforeIntake) { sim.setOffer({ sku: "T-CHANGED" }); changeBeforeIntake = false; } return realGithub(); };
  for (let k = 0; k < 3; k++) await sim.tick();
  const r = sim.intakes.at(-1);
  assert.equal(r.stats.results["ВІДМОВА"], 1);
  assert.ok(!sim.queueRow(ID), "не додано");
  await sim.tick();
  const st = (await sim.status()).candidates.find((c) => c.id === ID);
  assert.ok(["СПОСТЕРЕЖЕННЯ", "ВІДКЛАДЕНО"].includes(st.status));
  assert.ok(st.history.some((h) => /ВІДМОВА INTAKE: дані змінилися/.test(h.what) || /ЗМІНА: артикул/.test(h.what)));
  for (let k = 0; k < 8; k++) await sim.tick();
  assert.ok(sim.queueRow(ID), "після нових 10 хв стабільності — додано");
  assert.equal(sim.queueRow(ID)["Артикул постачальника"], "T-CHANGED");
});

test("чергу редагують під час intake — нічого не записано, Worker повторить", async () => {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer(ID));
  const realRead = sim.readBook;
  let calls = 0;
  sim.readBook = async (names) => { const b = await realRead(names); if (names?.length === 1 && names[0] === SHEET.queue && ++calls === 1) b[SHEET.queue] = [...b[SHEET.queue], b[SHEET.queue][0].map(() => "")].map((r, i, a) => (i === a.length - 1 ? r.map((v, j) => (j === 0 ? "9999" : v)) : r)); return b; };
  for (let k = 0; k < 3; k++) await sim.tick();
  assert.equal(sim.intakes.at(-1).state, "SKIPPED_CONCURRENT_EDIT");
  assert.ok(!sim.queueRow(ID));
  sim.readBook = realRead;
  for (let k = 0; k < 14; k++) await sim.tick();
  assert.ok(sim.queueRow(ID), "повтор після тайм-ауту підтвердження");
});

test("стартові умови: без бази відомих ID Worker нічого не вирішує; неповний фід — нічого не змінює", async () => {
  const sim = new WatchSim();
  sim.now = T0;
  let rep = await sim.run(); // ручний цикл до першого звіту GitHub
  assert.match(rep.blocked, /НЕМАЄ БАЗИ/);
  await sim.start();
  sim.setOffer(fullOffer(ID));
  await sim.tick();
  const xmlFull = sim.baseXml;
  sim.baseXml = sim.baseXml.replace(/<offer id="15[\s\S]*?<\/offer>\n/g, ""); // майже всі offer зникли
  rep = await sim.tick();
  assert.match(rep.blocked, /НЕПОВНИЙ ФІД/);
  assert.equal((await sim.status()).candidates.find((c) => c.id === ID).status, "СПОСТЕРЕЖЕННЯ", "кандидат не «зник»");
  sim.baseXml = xmlFull;
});

test("нова позиція щоп'ять хвилин — GitHub запускається не частіше ніж раз на 15 хв; позиції, що «назбирались», ідуть одним запуском", async () => {
  const sim = new WatchSim();
  await sim.start();
  for (let k = 0; k < 18; k++) { // 1,5 год
    sim.setOffer(fullOffer(String(2962000000 + k)));
    await sim.tick();
  }
  const at = sim.calls.dispatchAt || [];
  assert.ok(at.length >= 3, "запуски є");
  assert.ok(at.slice(1).every((t, i) => t - at[i] >= 15 * MIN), "пауза ≥ 15 хв між запусками");
  const added = sim.intakes.reduce((n, r) => n + (r.stats?.added || 0), 0);
  assert.ok(added > at.length, `додано ${added} позицій за ${at.length} запусків — пакетами`);
});

test("рядок черги до запуску контролю: intake оновив сирі дані — примітка «Перевірка» (схожість) перерахована за новими даними, не застаріла", async () => {
  const sim = new WatchSim();
  await sim.start();
  const A = "2963000001", B = "2963000002";
  const same = { nameUa: "Зварювальний апарат Test MIG-20 Master", nameRu: "Сварочный аппарат Test MIG-20 Master", sku: "MIG-20" };
  sim.setOffer(fullOffer(A, same));
  sim.setOffer(fullOffer(B, { ...same, pictures: ["https://images.prom.ua/4833333333_b.jpg"] }));
  for (let k = 0; k < 3; k++) await sim.tick();
  assert.match(sim.queueRow(B)["Перевірка"], /ЙМОВІРНО ТОЙ САМИЙ/);
  // Як черга до 22.10.2026: колонок стану немає
  const { QUEUE_STATE, SHEET } = await import("../src/core/sheet-sync.mjs");
  const v = sim.book[SHEET.queue];
  const keep = v[0].map((k, i) => (QUEUE_STATE.includes(k) ? -1 : i)).filter((i) => i >= 0);
  sim.book[SHEET.queue] = v.map((r) => keep.map((i) => r[i]));
  // Постачальник перетворив B на іншу модель
  sim.setOffer({ id: B, nameUa: "Інвертор Test ZZTEST-777 Pro", nameRu: "Инвертор Test ZZTEST-777 Pro", sku: "ZZTEST-777" });
  const { intakeAll } = await import("./helpers/intake.mjs");
  await intakeAll({ sheets: sim.sheets, readBook: sim.readBook }, sim.xml(), { stamp: sim.stamp(), now: sim.now, config: sim.config, ready: [] });
  const b = sim.queueRow(B);
  assert.equal(b["Артикул постачальника"], "ZZTEST-777", "сирі дані оновлено");
  assert.doesNotMatch(b["Перевірка"], /ЙМОВІРНО ТОЙ САМИЙ/, "застарілої примітки немає");
});
