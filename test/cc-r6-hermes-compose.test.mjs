/** Hermes R6 (independent-20261029T230851): проби E3 / E6 / H13 у композиції зі СПРАВЖНІМ Catalog Controls R6.
 *  Ті самі сценарії й постумови, що в reviewer-scripts/eng-r6; єдина зміна — синхронізація отримує адаптер CC (`controls`):
 *  у режимі пріоритету власника (тепер типовому) синхронізація без стану CC — fail-closed (видалений товар не відрізнити, правило 5).
 *  Без модуля CC (до злиття гілок) — пропуск. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ccPresent = fs.existsSync(new URL("../src/core/controls-plan.mjs", import.meta.url)) && fs.existsSync(new URL("./helpers/controls.mjs", import.meta.url));
const skip = ccPresent ? false : "модуль Catalog Controls відсутній (до злиття гілок) — проба композиції";
const load = async () => {
  const [plan, common, adapterMod, helpers, intake, legacy] = await Promise.all([
    import("../src/core/controls-plan.mjs"), import("../src/core/controls-common.mjs"), import("../src/pipeline/controls-adapter.mjs"),
    import("./helpers/controls.mjs"), import("./helpers/intake.mjs"), import("./helpers/legacy-config.mjs"),
  ]);
  const { controlsState, verifyControlsSnapshot } = plan;
  const adapter = (w) => adapterMod.catalogControlsAdapter({ loadBook: async () => structuredClone(w.book), store: w.store, contract: helpers.ACTIVE_CONTRACT, api: { controlsState, verifyControlsSnapshot } });
  const cfg = () => { const c = structuredClone(legacy.default); delete c.ownerPriority; return c; }; // типовий режим = пріоритет власника
  return { ...helpers, ...intake, SALE_DECISION: common.SALE_DECISION, adapter, cfg, controlsState };
};
const ID = "1500000007";

test("E6: видалений REGISTERED (рядок ще в каталозі) — синхронізація не оновлює його; запуск SYNCED, решта оновлюється", { skip }, async () => {
  const h = await load();
  const w = await h.prepared(), cfg = h.cfg();
  assert.equal((await h.syncAndIntake(w, w.xml, { stamp: h.STAMP, now: h.NOW, config: cfg, controls: h.adapter(w) })).state, "SYNCED");
  const x = await h.confirm(w, ID, h.SALE_DECISION, `ВИДАЛИТИ ТОВАР ${ID}`, { stamp: h.later(1) });
  assert.equal(x.r2.state, "COMMITTED");
  const other = h.mainRows(w).find((r) => String(r["Offer ID"]) !== ID && String(r["Наявність"]) === "+");
  const bump = (xml, id) => xml.replace(new RegExp(`(<offer id="${id}"[\\s\\S]*?<price>)([^<]+)(</price>)`), (_, a, p, b) => a + String(Number(p) + 17) + b);
  const xml = bump(bump(w.xml, ID), String(other["ID постачальника"]));
  const before = String(h.rowOf(w, ID)["Ціна постачальника"]), otherBefore = String(h.rowOf(w, String(other["Offer ID"]))["Ціна постачальника"]);
  const r = await h.syncAndIntake(w, xml, { stamp: h.later(3), now: h.NOW, config: cfg, controls: h.adapter(w) });
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 300));
  assert.equal(String(h.rowOf(w, ID)["Ціна постачальника"]), before, "видалений REGISTERED не оновлено");
  assert.notEqual(String(h.rowOf(w, String(other["Offer ID"]))["Ціна постачальника"]), otherBefore, "інший товар оновлено");
  assert.equal(h.controlsState(w.book, { contract: h.ACTIVE_CONTRACT, checkpoint: w.store.data.get("state/catalog-controls/checkpoint.json") ?? null }).tombstoned.get(ID)?.stage, "REGISTERED");
});

test("E3: ручні правки назви / опису / характеристик / запитів / SEO (типовий режим) — SYNCED, значення збережено, каталог не зупинено", { skip }, async () => {
  const h = await load();
  const out = [];
  for (const field of ["Назва UA", "Опис UA", "Характеристики JSON", "Запити UA", "SEO заголовок UA"]) {
    const w = await h.prepared(), cfg = h.cfg();
    assert.equal((await h.syncAndIntake(w, w.xml, { stamp: h.STAMP, now: h.NOW, config: cfg, controls: h.adapter(w) })).state, "SYNCED");
    const value = field === "Характеристики JSON" ? '[{"name":"Власник","value":"Ручне значення"}]' : "Ручна правка власника";
    h.setCells(w, ID, { [field]: value });
    const r = await h.syncAndIntake(w, w.xml, { stamp: h.later(1), now: h.NOW, config: cfg, controls: h.adapter(w) });
    out.push({ field, result: r.state, kept: h.rowOf(w, ID)[field] === value });
  }
  assert.ok(out.every((x) => x.result === "SYNCED" && x.kept), JSON.stringify(out));
});

test("H13: паралельна правка SEO власника й команда CC на межі запису — збережено, запуск SYNCED", { skip }, async () => {
  const h = await load();
  const w = await h.prepared(), cfg = h.cfg();
  assert.equal((await h.syncAndIntake(w, w.xml, { stamp: h.STAMP, now: h.NOW, config: cfg, controls: h.adapter(w) })).state, "SYNCED");
  h.setCells(w, ID, { "SEO заголовок UA": "OWNER_OLD" });
  const photo = JSON.parse(h.rowOf(w, ID)["Фото JSON"])[0];
  const xml = w.xml.replace(`<picture>${photo}</picture>`, `<picture>${photo.replace(".jpg", "-new.jpg")}</picture>`);
  assert.notEqual(xml, w.xml);
  let fired = false;
  const raw = w.sheets;
  w.sheets = { ...raw, updateRanges: async (list) => { if (!fired && list.some((b) => b.title === "Основний каталог" && b.row > 1)) { fired = true; h.setCells(w, ID, { "SEO заголовок UA": "OWNER_NEW_DURING_SYNC", [h.SALE_DECISION]: "ЗНЯТИ З ПРОДАЖУ" }); } return raw.updateRanges(list); } };
  const r = await h.syncAndIntake(w, xml, { stamp: h.later(1), now: h.NOW, config: cfg, controls: h.adapter(w) });
  const row = h.rowOf(w, ID);
  assert.ok(fired);
  assert.equal(r.state, "SYNCED", JSON.stringify(r).slice(0, 300));
  assert.equal(row["SEO заголовок UA"], "OWNER_NEW_DURING_SYNC");
  assert.equal(row[h.SALE_DECISION], "ЗНЯТИ З ПРОДАЖУ");
});

test("E1: S5 у типовому режимі — справжній фільтр CC: той самий товар під новим ID не додається; ліміт не витрачено", { skip }, async () => {
  const h = await load();
  const { parseSupplierText } = await import("../src/core/supplier-feed.mjs");
  const w = await h.prepared(), NEW = "9990000007";
  await h.confirm(w, ID, h.SALE_DECISION, `ВИДАЛИТИ ТОВАР ${ID}`, { stamp: h.later(1) });
  const a = w.book["Основний каталог"], i = a.findIndex((r) => r[0] === ID);
  w.book["Видалені товари"] = [a[0].slice(), a[i].slice()]; a.splice(i, 1);
  const xml = w.xml.replace(`<offer id="${ID}"`, `<offer id="${NEW}"`);
  const parsed = await parseSupplierText(xml, { maximumChars: 45_000_000, identityFields: true });
  assert.equal((await h.adapter(w).state()).gate.check(parsed.offers.get(NEW)).blocked, true);
  const r = await h.intakeAll(w, xml, { session: "auto", stamp: h.later(3), now: h.NOW, config: h.cfg(), ready: h.readyFromXml(xml, h.NOW, { ids: [NEW] }), controls: h.adapter(w) });
  const q = w.book["Нові товари"], added = q.slice(1).some((x) => String(x[q[0].indexOf("Offer ID")]) === NEW);
  assert.equal(added, false);
  assert.equal(r.ack?.results?.[NEW]?.status, "ВИДАЛЕНИЙ ТОВАР", JSON.stringify(r).slice(0, 300));
  assert.equal(r.stats?.added ?? 0, 0, "ліміт новинок не витрачено");
});
