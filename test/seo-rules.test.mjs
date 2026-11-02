/** Правила SEO в черзі «Нові товари» (погоджено власником 23.10.2026): 12 сценаріїв + реальний випадок MIG-20HB → MIG-22FD.
 *  Сире SEO — оновлюється разом із постачальником; власне — захищене, суттєві зміни → «ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ» з «було → стало».
 *  Ціна й наявність — автоматично, не блокуються й не скидають «ПЕРЕВІРЕНО». */
import test from "node:test";
import assert from "node:assert/strict";
import { mtText } from "../src/core/text.mjs";
import { mtPrices } from "../src/core/pricing.mjs";
import { SHEET, QUEUE_STATE, seoHash } from "../src/core/sheet-sync.mjs";
import { WatchSim, fullOffer } from "./helpers/watch-sim.mjs";

const ID = "2990000001";
const MIG20 = { nameUa: "Зварювальний напівавтомат PROFI-TEC MIG-20HB Master 5,3 кВт, 20–180 А (008395)", nameRu: "Сварочный полуавтомат PROFI-TEC MIG-20HB Master 5,3 кВт, 20–180 А (008395)", sku: "008395", model: "MIG-20HB Master", vendor: "PROFI-TEC",
  params: [{ name: "Максимальний зварювальний струм", value: "180", unit: "А" }], descUa: "Опис MIG-20HB", descRu: "Описание MIG-20HB" };
const MIG22 = { nameUa: "Зварювальний напівавтомат PROFI-TEC MIG-22FD Professional 6,3 кВт (008388)", nameRu: "Сварочный полуавтомат PROFI-TEC MIG-22FD Professional 6.3 кВт (008388)", sku: "008388", model: "MIG-22FD Professional",
  params: [{ name: "Максимальний зварювальний струм", value: "200", unit: "А" }], descUa: "Опис MIG-22FD", descRu: "Описание MIG-22FD" };

/** Товар у черзі (через «Сторож новинок» → intake), далі — синхронізації кожні 4 год. */
async function queued(over = {}) {
  const sim = new WatchSim();
  await sim.start();
  sim.setOffer(fullOffer(ID, { ...MIG20, ...over }));
  for (let k = 0; k < 3; k++) await sim.tick();
  assert.ok(sim.queueRow(ID), "у черзі");
  return sim;
}
const q = (sim) => sim.queueRow(ID);
const writeOwnSeo = (sim) => { sim.setCell(ID, "Назва UA", "Наш SEO: зварювальний інвертор MIG-20HB"); sim.setCell(ID, "Опис UA", "<p>Наш SEO-опис</p>"); sim.setCell(ID, "Запити UA", "зварювальний апарат, MIG"); };
const journalOf = (sim, since) => sim.book[SHEET.journal].slice(since).filter((e) => e[2] === ID);
const priceOk = (row) => { const p = mtPrices(Number(row["Ціна постачальника"]), row["Наявність"] === "+"); return Number(row["Ціна кінцева"]) === p.final && Number(row["Ціна"]) === p.base; };

test("1. сире SEO → постачальник змінив назву → SEO-копія назви оновилась автоматично, без попереджень", async () => {
  const sim = await queued();
  assert.equal(q(sim)["Назва UA"], MIG20.nameUa);
  sim.setOffer({ id: ID, nameUa: MIG20.nameUa + " NEW", nameRu: MIG20.nameRu + " NEW" });
  await sim.sync();
  const r = q(sim);
  assert.equal(r["Назва UA"], MIG20.nameUa + " NEW");
  assert.equal(r["Назва RU"], MIG20.nameRu + " NEW");
  assert.doesNotMatch(r["Перевірка"], /ПОТРЕБУЄ/);
  assert.equal(r["SHA SEO при додаванні"], seoHash(r), "знімок системи рухається разом із копією");
});

test("2. сире SEO → постачальник змінив опис → SEO-копія опису оновилась автоматично", async () => {
  const sim = await queued();
  sim.setOffer({ id: ID, descUa: "Новий опис постачальника", descRu: "Новое описание поставщика" });
  await sim.sync();
  assert.match(q(sim)["Опис UA"], /Новий опис постачальника/);
  assert.match(q(sim)["Опис RU"], /Новое описание поставщика/);
  assert.doesNotMatch(q(sim)["Перевірка"], /ПОТРЕБУЄ/);
});

test("3. власне SEO → постачальник змінив модель (MIG-20HB → MIG-22FD / 008388) → наше SEO збережено, попередження «було → стало» (інформаційне); затвердження не блокується", async () => {
  const sim = await queued();
  writeOwnSeo(sim);
  await sim.sync();
  sim.setOffer({ id: ID, ...MIG22 });
  await sim.sync();
  const r = q(sim);
  assert.equal(r["Назва UA"], "Наш SEO: зварювальний інвертор MIG-20HB", "SEO-назва захищена");
  assert.equal(r["Опис UA"], "<p>Наш SEO-опис</p>", "SEO-опис захищений");
  assert.equal(r["Запити UA"], "зварювальний апарат, MIG", "запити захищені");
  assert.equal(r["Назва постачальника UA"], MIG22.nameUa, "сирі дані — нові");
  assert.match(r["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ: Постачальник змінив назву \/ артикул \/ модель товару\./);
  assert.match(r["Перевірка"], /назва UA: було «[^»]*MIG-20HB[^»]*» → стало «[^»]*MIG-22FD[^»]*»/);
  assert.match(r["Перевірка"], /артикул: було «008395» → стало «008388»/);
  assert.match(r["Перевірка"], /модель: було «MIG-20HB Master» → стало «MIG-22FD Professional»/);
  assert.match(r["Перевірка"], /Наше SEO не змінено/);
  sim.setCell(ID, "Група ID", sim.rows(SHEET.main)[0]["Група ID"]);
  sim.setCell(ID, "Категорія Prom ID", "501");
  sim.setDecision(ID, "ЗАТВЕРДЖЕНО (НЕ ДУБЛЬ)");
  const res = await sim.sync();
  assert.equal(res.stats.approved, 1, "попередження не блокує ручне затвердження");
  const m = sim.rows(SHEET.main).find((x) => x["Offer ID"] === ID);
  assert.equal(m["Назва UA"], "Наш SEO: зварювальний інвертор MIG-20HB", "наше SEO перенесено");
  assert.equal(m["Артикул постачальника"], "008388", "сирі дані — нові");
  assert.ok(sim.book[SHEET.journal].some((e) => e[2] === ID && e[6] === "ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ"), "попередження — у «Журналі»");
});

test("4. власне SEO → постачальник змінив характеристики → SEO збережено, попередження з конкретною характеристикою", async () => {
  const sim = await queued();
  writeOwnSeo(sim);
  await sim.sync();
  sim.setOffer({ id: ID, params: [{ name: "Максимальний зварювальний струм", value: "250", unit: "А" }] });
  await sim.sync();
  const r = q(sim);
  assert.equal(r["Назва UA"], "Наш SEO: зварювальний інвертор MIG-20HB");
  assert.match(r["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ: характеристики: «Максимальний зварювальний струм» 180 А → 250 А/);
});

test("5–6. власне SEO → змінилась лише ціна / лише наявність → оновлено автоматично, без попереджень", async () => {
  const sim = await queued({ price: 1000 });
  writeOwnSeo(sim);
  await sim.sync();
  sim.setOffer({ id: ID, price: 1234 });
  await sim.sync();
  let r = q(sim);
  assert.equal(Number(r["Ціна постачальника"]), 1234);
  assert.ok(priceOk(r), "формула ціни");
  assert.doesNotMatch(r["Перевірка"], /ПОТРЕБУЄ/);
  sim.setOffer({ id: ID, available: false });
  await sim.sync();
  r = q(sim);
  assert.equal(r["Наявність"], "-");
  assert.equal(r["Знижка"], "", "без наявності — без знижки (погоджена логіка)");
  assert.doesNotMatch(r["Перевірка"], /ПОТРЕБУЄ/);
});

test("7. є попередження про SEO → ціна й наявність усе одно оновлюються", async () => {
  const sim = await queued({ price: 1000 });
  writeOwnSeo(sim);
  await sim.sync();
  sim.setOffer({ id: ID, ...MIG22 });
  await sim.sync();
  assert.match(q(sim)["Перевірка"], /ПОТРЕБУЄ/);
  sim.setOffer({ id: ID, price: 1500, available: false });
  await sim.sync();
  const r = q(sim);
  assert.equal(Number(r["Ціна постачальника"]), 1500);
  assert.equal(r["Наявність"], "-");
  assert.equal(r["Стан синхронізації"], "ЗІСТАВЛЕНО");
  assert.ok(priceOk(r));
  assert.match(r["Перевірка"], /ПОТРЕБУЄ/, "попередження лишається до «ПЕРЕВІРЕНО»");
});

test("8–9. «ПЕРЕВІРЕНО» → зміна ціни не скидає підтвердження; постачальник знову змінив модель → знову потрібна перевірка", async () => {
  const sim = await queued({ price: 1000 });
  writeOwnSeo(sim);
  await sim.sync();
  sim.setOffer({ id: ID, ...MIG22 });
  await sim.sync();
  sim.setDecision(ID, "ПЕРЕВІРЕНО");
  // ENG-27 (Hermes INT N3): sync службової команди не виконує й не стирає; рядок не оновлюється — виконує intake.
  { const rs = await sim.sync(); assert.equal(rs.state, "SYNCED", JSON.stringify(rs).slice(0, 300));
    assert.equal(mtText(sim.queueRow(ID)["Рішення"]), "ПЕРЕВІРЕНО", "sync рішення власника не стирає");
    assert.ok(rs.queueUpdate.skipped.some((x) => x.key === ID && /службова команда/.test(x.reason)), "рядок із командою sync не оновлював"); }
  await sim.github();
  let r = q(sim);
  assert.doesNotMatch(r["Перевірка"], /ПОТРЕБУЄ/);
  assert.equal(r["Погоджено для SHA"], r["SHA даних постачальника"]);
  const agreed = r["Погоджено для SHA"];
  sim.setOffer({ id: ID, price: 1999, available: true });
  await sim.sync();
  r = q(sim);
  assert.equal(Number(r["Ціна постачальника"]), 1999);
  assert.equal(r["Погоджено для SHA"], agreed, "підтвердження збережено");
  assert.doesNotMatch(r["Перевірка"], /ПОТРЕБУЄ/);
  sim.setOffer({ id: ID, nameUa: "Зварювальний напівавтомат PROFI-TEC MIG-25 Pro", sku: "008399", model: "MIG-25 Pro" });
  await sim.sync();
  r = q(sim);
  assert.match(r["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ: .*MIG-22FD.* → стало «[^»]*MIG-25/);
  assert.match(r["Перевірка"], /артикул: було «008388» → стало «008399»/, "«було» — дані, які власник підтвердив");
});

test("10. старий рядок без знімка SEO: власні тексти не перезаписуються; невідоме походження — попередження й блок затвердження; «SEO ПОСТАЧАЛЬНИКА» вмикає автооновлення", async () => {
  // (а) назва вже відрізняється від назви постачальника → власне SEO
  let sim = await queued();
  const strip = (s) => { const v = s.book[SHEET.queue]; const keep = v[0].map((k, i) => (QUEUE_STATE.includes(k) ? -1 : i)).filter((i) => i >= 0); s.book[SHEET.queue] = v.map((r) => keep.map((i) => r[i])); };
  sim.setCell(ID, "Назва UA", "Наша назва до запуску контролю");
  strip(sim);
  sim.setOffer({ id: ID, ...MIG22 });
  await sim.sync();
  assert.equal(q(sim)["Назва UA"], "Наша назва до запуску контролю", "власне SEO не перезаписано");
  assert.match(q(sim)["SHA SEO при додаванні"], /^УСПАДКОВАНО/);
  // (б) назви = постачальника, але опис постачальника відтоді змінився → походження невідоме
  sim = await queued();
  strip(sim);
  sim.setOffer({ id: ID, descUa: "Опис уже інший", descRu: "Описание уже другое" });
  await sim.sync();
  let r = q(sim);
  assert.equal(r["Опис UA"], "<p>Опис MIG-20HB</p>", "не перезаписано");
  assert.match(r["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ: походження SEO невідоме/);
  sim.setCell(ID, "Група ID", sim.rows(SHEET.main)[0]["Група ID"]);
  sim.setCell(ID, "Категорія Prom ID", "501");
  sim.setDecision(ID, "SEO ПОСТАЧАЛЬНИКА");
  // ENG-27 (Hermes INT N3): sync службової команди не виконує й не стирає; рядок не оновлюється — виконує intake.
  { const rs = await sim.sync(); assert.equal(rs.state, "SYNCED", JSON.stringify(rs).slice(0, 300));
    assert.equal(mtText(sim.queueRow(ID)["Рішення"]), "SEO ПОСТАЧАЛЬНИКА", "sync рішення власника не стирає");
    assert.ok(rs.queueUpdate.skipped.some((x) => x.key === ID && /службова команда/.test(x.reason)), "рядок із командою sync не оновлював"); }
  await sim.github();
  r = q(sim);
  assert.equal(r["Опис UA"], "<p>Опис уже інший</p>", "підтверджено як копію постачальника — оновлено");
  assert.doesNotMatch(r["Перевірка"], /ПОТРЕБУЄ/);
  assert.equal(mtText(r["Рішення"]), "");
  // (б2) походження невідоме — попередження інформаційне: «ЗАТВЕРДЖЕНО» не блокується, SEO переноситься без змін
  sim = await queued();
  strip(sim);
  sim.setOffer({ id: ID, descUa: "Опис уже інший", descRu: "Описание уже другое" });
  await sim.sync();
  assert.match(q(sim)["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ: походження SEO невідоме/);
  sim.setCell(ID, "Група ID", sim.rows(SHEET.main)[0]["Група ID"]);
  sim.setCell(ID, "Категорія Prom ID", "501");
  sim.setDecision(ID, "ЗАТВЕРДЖЕНО");
  assert.equal((await sim.sync()).stats.approved, 1, "затвердження не блокується");
  assert.equal(sim.rows(SHEET.main).find((x) => x["Offer ID"] === ID)["Опис UA"], "<p>Опис MIG-20HB</p>", "SEO не перезаписано");
  // (в) усе збігається з постачальником → сире: автооновлення
  sim = await queued();
  strip(sim);
  sim.setOffer({ id: ID, nameUa: MIG20.nameUa + " v2" });
  await sim.sync();
  assert.equal(q(sim)["Назва UA"], MIG20.nameUa + " v2");
  assert.doesNotMatch(q(sim)["Перевірка"], /ПОТРЕБУЄ/);
});

test("11. пошкоджений / помилковий XML (усе «немає в наявності») → масове оновлення наявності заблоковано, черга й каталог без змін", async () => {
  const sim = await queued();
  const before = JSON.stringify([sim.book[SHEET.main], sim.book[SHEET.queue]]);
  const base = sim.baseXml;
  sim.baseXml = base.replace(/available="true"/g, 'available="false"');
  const r = await sim.sync();
  assert.equal(r.state, "ABORTED");
  assert.equal(r.block.type, "МАСОВА ЗМІНА НАЯВНОСТІ");
  assert.equal(JSON.stringify([sim.book[SHEET.main], sim.book[SHEET.queue]]), before);
  sim.baseXml = base;
});

test("12. повторна синхронізація без змін → без дублів, без зайвих попереджень і записів у «Журналі»", async () => {
  const sim = await queued();
  writeOwnSeo(sim);
  await sim.sync();
  const rowsBefore = sim.rows().length;
  const j = sim.book[SHEET.journal].length;
  await sim.sync();
  await sim.sync();
  assert.equal(sim.rows().length, rowsBefore);
  assert.equal(journalOf(sim, j).length, 0, "по товару — жодного запису");
  assert.doesNotMatch(q(sim)["Перевірка"], /ПОТРЕБУЄ/);
});

test("реальний випадок (як у тестовій копії 23.10): сирі дані вже MIG-22FD / 008388, SEO-копія ще MIG-20HB → копію оновлено автоматично, без хибного попередження", async () => {
  const sim = await queued();
  // Стан копії після intake 23.10: сирі поля оновлено, SEO-копію — ні; знімок SEO = SEO-копії (не редагувалась); колонки «Погоджені дані» ще немає
  sim.setOffer({ id: ID, ...MIG22 });
  const v = sim.book[SHEET.queue];
  const h = v[0];
  const row = v.find((x, i) => i > 0 && x[h.indexOf("Offer ID")] === ID);
  row[h.indexOf("Назва постачальника UA")] = MIG22.nameUa; row[h.indexOf("Назва постачальника RU")] = MIG22.nameRu; row[h.indexOf("Артикул постачальника")] = MIG22.sku;
  const snapCol = h.indexOf("Погоджені дані постачальника");
  sim.book[SHEET.queue] = v.map((x) => x.filter((_, i) => i !== snapCol));
  await sim.sync();
  const r = q(sim);
  assert.equal(r["Назва UA"], MIG22.nameUa, "SEO-копію назви оновлено (MIG-22FD)");
  assert.equal(r["Назва RU"], MIG22.nameRu);
  assert.equal(r["Артикул постачальника"], "008388");
  assert.doesNotMatch(r["Перевірка"], /ПОТРЕБУЄ/);
  assert.equal(r["SHA SEO при додаванні"], seoHash(r));
});

test("режим intake застосовує ті самі правила: сире SEO оновлено, власне — захищене з попередженням", async () => {
  const sim = await queued();
  sim.setOffer({ id: ID, nameUa: MIG20.nameUa + " (intake)" });
  const { intakeAll } = await import("./helpers/intake.mjs");
  await intakeAll({ sheets: sim.sheets, readBook: sim.readBook }, sim.xml(), { session: "auto", stamp: sim.stamp(), now: sim.now, config: sim.config, ready: [] });
  assert.equal(q(sim)["Назва UA"], MIG20.nameUa + " (intake)");
  writeOwnSeo(sim);
  await sim.sync();
  sim.setOffer({ id: ID, ...MIG22 });
  await intakeAll({ sheets: sim.sheets, readBook: sim.readBook }, sim.xml(), { session: "auto", stamp: sim.stamp(), now: sim.now, config: sim.config, ready: [] });
  assert.equal(q(sim)["Назва UA"], "Наш SEO: зварювальний інвертор MIG-20HB");
  assert.match(q(sim)["Перевірка"], /^ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ: Постачальник змінив назву/);
});

test("власник поставив «ЗАТВЕРДЖЕНО» за сирим SEO, а постачальник у той самий момент змінив модель → копію не підмінено мовчки; затверджено те, що бачив власник, попередження в «Журналі»", async () => {
  const sim = await queued();
  sim.setCell(ID, "Група ID", sim.rows(SHEET.main)[0]["Група ID"]);
  sim.setCell(ID, "Категорія Prom ID", "501");
  sim.setDecision(ID, "ЗАТВЕРДЖЕНО");
  sim.setOffer({ id: ID, ...MIG22 });
  const res = await sim.sync();
  assert.equal(res.stats.approved, 1, "попередження не блокує затвердження");
  const m = sim.rows(SHEET.main).find((x) => x["Offer ID"] === ID);
  assert.equal(m["Назва UA"], MIG20.nameUa, "перенесено те, що затверджував власник (без мовчазної підміни)");
  assert.equal(m["Назва постачальника UA"], MIG22.nameUa, "сирі дані — нові");
  assert.ok(sim.book[SHEET.journal].some((e) => e[2] === ID && e[6] === "ПОТРЕБУЄ ПОВТОРНОЇ ПЕРЕВІРКИ"), "попередження — у «Журналі»");
});
