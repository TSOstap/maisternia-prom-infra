/** Catalog Controls — запуск (R4: після третього ревю Hermes, independent-20261029T144034; R5 — CC4-N2 / D; R6 — видалення без
 *  <offer> у YML, без підтвердження Prom, одною дією власника).
 *
 *  Режими:
 *   • shadow (за замовчуванням) — лише читання: план, стан, «Стан керування» в пам'яті з позначкою SHADOW; жодних записів;
 *   • apply — лише якщо (1) контракт activated=true (окремий дозвіл власника) і (2) інженерний сектор передав `readiness`, і
 *     ФУНКЦІОНАЛЬНІ перевірки готовності S6 / W2 пройдено ДО будь-якого запису (READINESS_CONTRACT, checkReadiness):
 *       publisher (S6) — шлях формування YML застосовує стан керування (знятий → available="false"; R6: видалений → жодного
 *         <offer>, сусідній товар лишається) і відмовляє за blocked;
 *       committer (W2) — виключна оренда з монотонним токеном і виявленням застарілої оренди;
 *       store (W2) — контрольна точка з версіями, CAS і fencing (запис зі застарілою орендою відхиляється).
 *     Без цього — NOT_READY, 0 записів (і в аркуші, і в сховище). Запису activated=true недостатньо. Це НЕ доказ, що робочий
 *     update.mjs використовує той самий шлях: наскрізне приймання S6 / W2 — окремо, інженерним сектором і Hermes.
 *  Записи apply — ЛИШЕ службові аркуші Catalog Controls (guardWriter: незмінна копія аргументів, інші аркуші й deleteRows
 *  заборонені) і контрольна точка (CAS + оренда). Цикл кожної групи змін (R4):
 *   0) оренда записувача; assertCurrent перед кожною фазою і ПІСЛЯ запису точки (втрата оренди → UNKNOWN);
 *   1) ініціалізація контрольної точки (C2), якщо її немає й аркуші порожні — підтверджена читанням ДО першої події;
 *   2) звірка намірів попередніх запусків — ДО нових команд (захисні дописуються й підтверджуються; послаблювальні — лише за
 *      чинної авторизації власника, інакше скасовуються);
 *   3) «Стан керування»: зачеплені товари — НЕВИЗНАЧЕНО (до будь-якого ефекту);
 *   4) довірені наміри в контрольну точку (F1) → 5) знімки → 6) події (дописування відсутнього за Operation ID);
 *   7) перевірочне читання → 8) коміт точки (CAS + оренда + читання назад) → 9) «Стан керування» з підтвердженої точки.
 *  Результат: COMMITTED / PENDING (частину не дописано — захисні діють, допише наступний запуск; або послаблення скасовано) /
 *  UNCONFIRMED (коміт не вдався — результат невідомий, у вигляді НЕВИЗНАЧЕНО) / UNKNOWN (невідомо: читання, CAS-конфлікт,
 *  втрата оренди, звірка) / NOT_APPLIED (не вдалося позначити невизначеність — нічого не застосовано) / NOT_READY /
 *  NOT_ACTIVATED / BUSY / BLOCKED / READ_FAILED / ABORTED.
 *
 *  R7.3 (узгоджений контракт F04 / F06 / F08; рішення власника 30.10.2026): apply — лише в протоколі A (`cc-serving-v2`):
 *   • на початку — serving.status (лише NORMAL; інакше RECOVERY_PENDING без записів) і epoch > epochHigh точки (C2, C3);
 *   • «Історія керування» — додатковий детектор відкату: рядки без прив'язки до точки → RECOVERY_PENDING без записів (Q2);
 *   • КОЖЕН запис точки — запечатаний: свіже читання → стан після запису → beforeCommit (квиток) → CAS-запис із квитком →
 *     afterCommit; відмова до запису — NOT_APPLIED / PENDING / BLOCKED за фазою (C1, C6). Квитків CC не створює й не перевіряє;
 *   • mode "recover" — лише в RECOVERY_AUTHORIZED і за доведеної межі епох: ухвалені рішення не скасовуються (дзеркало реєстру),
 *     невикористані коди й незавершені послаблення недійсні (C5).
 *
 *  R7.4 (ENG-24 розд. 11 пп. 1, 4; ревю ENG-24-review/CC-ENG24-SECTION11-REVIEW.uk.md, пп. a, d — погоджено власником 31.10.2026):
 *   • відмова видачі оренди → стан за кодом відмови (leaseRefusal): звичайна зайнятість — BUSY, відкат W2 за межею епох —
 *     RECOVERY_PENDING (detector "epoch-floor"), невідоме — BLOCKED; записів немає в жодному разі;
 *   • serving.status → NORMAL з type "MIGRATION" — окремий запуск MIGRATED без жодного запису; міграція недостовірна (точка має
 *     поля протоколу A, точки немає, журнал не узгоджений) → RECOVERY_PENDING / BLOCKED, команди не застосовуються (migrationRun). */
import fs from "node:fs";
import path from "node:path";
import { mtText } from "../core/text.mjs";
import { DEFAULT_PRICING, mtPrices } from "../core/pricing.mjs";
import { SEAL_COLUMN, YML_HEADERS, approvalManifest, rowSeal } from "../core/seal.mjs";
import { SHEET } from "../core/sheet-sync.mjs";
import { ACTION, ARCHIVE_SHEET, CC_SHEET, HISTORY_HEADERS, historyRow, identityKey, identityOf, loadControlsContract, operationId, readHistory, validateContract } from "../core/controls-common.mjs";
import {
  affectedBy, buildView, controlsState, decideIntent, emptyCheckpoint, loadState, planControls, recoverCheckpoint, sameCheckpoint, settleCheckpoint, withIntents, withIssued,
} from "../core/controls-plan.mjs";
import { SCHEMAS_DIR, loadFreeze, loadPromCatalog } from "./prom-schemas.mjs";

/** Аркуші, які CC читає (пише лише CC_SHEET через guardWriter). «Видалені товари» веде Engineering. */
export const CONTROLS_SHEETS = [SHEET.main, SHEET.queue, SHEET.deferred, SHEET.groups, SHEET.passport, ARCHIVE_SHEET, CC_SHEET.history, CC_SHEET.state];
export const CHECKPOINT_KEY = "state/catalog-controls/checkpoint.json";
const PROBE_KEY = "state/catalog-controls/readiness-probe.json";
export const LEASE_SCOPE = "catalog-controls";
/** Контракт готовності, який має реалізувати інженерний сектор (S6, W2). Опис — CC-R4-READINESS-CONTRACT-for-Claude2.uk.md;
 *  R6: publisher v2 — додатково видалений товар (tombstoned) відсутній у фіді (r6/CC-R6-CONTRACT-for-Engineering.uk.md). */
// R7.3 (узгоджений контракт F04 / F06 / F08, ENG-21-review/CC-ENG-AGREED-CONTRACT-F04-F06-F08.uk.md): committer v2 — оренда з
// leaseId (32 hex, новий на кожну видачу) і generation; serving v2 — status / beforeCommit (квиток) / afterCommit / recovery.
// Жодного apply поза протоколом A (рішення власника Q4): без serving v2 — NOT_READY.
export const READINESS_CONTRACT = Object.freeze({ publisher: "cc-publisher-v2", committer: "cc-committer-v2", store: "cc-store-v1", serving: "cc-serving-v2" });
const SERVING_FUNCTIONS = Object.freeze(["status", "beforeCommit", "afterCommit", "recovery"]);
const LEASE_ID_RE = /^[0-9a-f]{32}$/;
const SHADOW_NOTICE = "SHADOW: нічого не застосовано — стан не записано, контрольну точку не змінено; на YML / Prom це не діє";

const trim2d = (v) => { const rows = (v || []).map((r) => { const x = (r || []).map(mtText); while (x.length && x.at(-1) === "") x.pop(); return x; }); while (rows.length && !rows.at(-1).length) rows.pop(); return rows; };
const same2d = (a, b) => JSON.stringify(trim2d(a)) === JSON.stringify(trim2d(b));
const colOf = (values, name) => (values?.[0] || []).map(mtText).indexOf(name);
const keysOf = (values, name) => { const c = colOf(values, name); return c < 0 ? [] : (values || []).slice(1).map((r) => mtText(r?.[c])); };
const msg = (e) => String(e?.message || e).slice(0, 200);
const keyOf = (it) => it.kind + ":" + it.op;
class ReadFailed extends Error {}
class LeaseLost extends Error {}
async function read(readBook, names) { try { return await readBook(names); } catch (e) { throw new ReadFailed(msg(e)); } }

// ---------- захист запису (C5 / R4-F4) ----------
const OWN_SHEETS = new Set(Object.values(CC_SHEET));
const deny = (what) => { throw new Error(`заборонено: ${what}`); };
const ownTitle = (t) => {
  if (typeof t !== "string") deny("назва аркуша має бути рядком, а не об'єктом");
  if (!OWN_SHEETS.has(t)) deny(`Catalog Controls не пише в «${t}»`);
  return t;
};
const posInt = (n, what) => { if (typeof n !== "number" || !Number.isInteger(n) || n < 1) deny(`${what} має бути цілим ≥ 1`); return n; };
const cellOf = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return deny("значення клітинки має бути рядком, числом або логічним");
};
const rowOf = (r) => { if (!Array.isArray(r)) deny("рядок значень має бути масивом"); return Object.freeze(Array.from(r, cellOf)); };
const gridOf = (g) => { if (!Array.isArray(g)) deny("значення мають бути масивом рядків"); return Object.freeze(Array.from(g, rowOf)); };
/**
 * Обгортка writer (межа запису): дозволені лише три службові аркуші Catalog Controls; deleteRows і зміна форматів заборонені
 * завжди. Кожен аргумент читається РІВНО ОДИН раз у власну незмінну копію примітивів — і writer отримує саме цю копію, а не
 * початковий об'єкт (getter, Proxy, toString, ітератор не можуть підмінити адресата після перевірки). Методи writer беруться один
 * раз при створенні обгортки. Порушення — помилка ДО виклику writer. Публічних хелперів запису модуль не експортує.
 */
export function guardWriter(sheets) {
  const bind = (name) => (typeof sheets?.[name] === "function" ? sheets[name].bind(sheets) : async () => deny(`writer не має ${name}`));
  const raw = { meta: bind("meta"), updateRanges: bind("updateRanges"), appendRows: bind("appendRows"), ensureSheet: bind("ensureSheet"), ensureColumns: bind("ensureColumns") };
  return Object.freeze({
    meta: () => raw.meta(),
    async updateRanges(list) {
      if (!Array.isArray(list)) deny("updateRanges очікує масив блоків");
      const blocks = Object.freeze(Array.from(list, (b) => {
        if (!b || typeof b !== "object") deny("блок запису має бути об'єктом");
        const { title, row, col, values } = b;
        return Object.freeze({ title: ownTitle(title), row: posInt(row, "row"), col: posInt(col, "col"), values: gridOf(values) });
      }));
      return raw.updateRanges(blocks);
    },
    async appendRows(title, rows) { const t = ownTitle(title); return raw.appendRows(t, gridOf(rows)); },
    async ensureSheet(title, header) { const t = ownTitle(title); return raw.ensureSheet(t, rowOf(header)); },
    async ensureColumns(title, n) { const t = ownTitle(title); return raw.ensureColumns(t, posInt(n, "кількість колонок")); },
    async deleteRows() { deny("Catalog Controls не видаляє рядків"); },
    async setPercentFormat() { deny("Catalog Controls не змінює форматів"); },
  });
}

/**
 * Захист для постійного виключення (лише читання): FZ, перелік захищених (MM_FREEZE_IDS, за кореневим контрактом) і OV.
 * Будь-яка невідповідність → valid: false → виключення не виконується.
 */
export function loadProtection({ catalog = null, freezeFile = process.env.MM_FREEZE_IDS || "", contractFile = path.join(SCHEMAS_DIR, "freeze-contract.json") } = {}) {
  const reasons = [];
  const c = catalog ?? loadPromCatalog();
  if (c.guard?.blocked) reasons.push(...c.guard.reasons);
  if (c.frozenInfo?.active && !c.frozenInfo.valid) reasons.push("FZ обов'язковий, але недійсний");
  let contract = null;
  try { contract = JSON.parse(fs.readFileSync(contractFile, "utf8")); } catch { reasons.push("кореневий контракт захисту не читається"); }
  const fz = loadFreeze(freezeFile, contract);
  if (!fz.valid) reasons.push(freezeFile ? fz.problems.join("; ") || "перелік захищених товарів недійсний" : "перелік захищених товарів (MM_FREEZE_IDS) не задано");
  const ovIds = new Set([...(c.ownerValueIds || []), ...(c.ownerValues?.keys?.() || []), ...(c.ownerIndex?.keys?.() || [])].map(String));
  return { valid: !reasons.length, fzIds: new Set(c.frozenIds || []), protectedIds: fz.ids, ovIds, reasons };
}

// ---------- готовність S6 / W2 (п. 9) ----------
const PROBE_ID = "9999999990", PROBE_ID2 = "9999999991";
/** Синтетичні вхідні дані для перевірки publisher: дві валідні для buildYml картки, група, паспорт, час. Нічого з робочих даних. */
function probeInputs() {
  const t = "2026-01-01T00:00:00.000Z";
  const p = mtPrices(100, true, DEFAULT_PRICING);
  const card = (id, n) => {
    const row = Object.fromEntries(YML_HEADERS.map((k) => [k, ""]));
    Object.assign(row, {
      "Offer ID": id, "ID постачальника": id, "Артикул постачальника": `CC-PROBE-${n}`, "Назва UA": `Перевірка ${n}`, "Назва RU": `Проверка ${n}`,
      "Ціна постачальника": 100, "Ціна": p.base, "Ціна кінцева": p.final, "Знижка": p.discount, "Наявність": "+", "Стан синхронізації": "ЗІСТАВЛЕНО",
      "Оновлено": t, "Валюта": "UAH", "Опис UA": "<p>Перевірка</p>", "Опис RU": "<p>Проверка</p>", "Фото JSON": JSON.stringify([`https://images.prom.ua/${n}_cc-probe.jpg`]),
      "Характеристики JSON": "[]", "Група ID": "990001", "Група UA": "Перевірка", "Група RU": "Проверка", "Категорія Prom ID": "1",
      "Назва постачальника UA": `Перевірка ${n}`, "Назва постачальника RU": `Проверка ${n}`, "URL постачальника": `https://market-tools.com.ua/p${id}-cc-probe.html`,
      "Статус імпорту": "ДОЗВОЛЕНО", "Поля Prom JSON": "{}",
    });
    row[SEAL_COLUMN] = rowSeal(row);
    return row;
  };
  const rows = [card(PROBE_ID, 1), card(PROBE_ID2, 2)];
  const groups = [{ "Ідентифікатор_групи": "990001", "Назва_групи_укр": "Перевірка", "Назва_групи": "Проверка", "Ідентифікатор_батьківської_групи": "" }];
  return { rows, groups, manifest: approvalManifest(rows, groups), meta: { syncState: "OK", lastSuccess: t, now: "2026-01-01T00:01:00.000Z" }, config: { maximumSyncAgeHours: 12, shopName: "Перевірка", company: "Перевірка", timeZone: "Europe/Kyiv" } };
}
const probeState = (held, blocked, removed = []) => ({
  held: new Set([...held, ...removed]), tombstoned: new Map(removed.map((id) => [id, { stage: "REGISTERED", opId: "op-readiness-probe", at: "", confirmed: true }])),
  blocked, reasons: blocked ? ["перевірка готовності"] : [], fingerprint: "cc-readiness-probe",
});
const availableOf = (xml, id = PROBE_ID) => new RegExp(`<offer id="${id}"[^>]*available="(true|false)"`).exec(mtText(xml))?.[1] || "";
const hasOffer = (xml, id) => new RegExp(`<offer id="${id}"[\\s>]`).test(mtText(xml));

/**
 * Функціональна перевірка готовності (без робочих даних; у сховищі — лише службовий ключ перевірки). Повертає { ok, reasons }.
 * Порядок: publisher → committer → store; сховище перевіряється (і пишеться службовий ключ) ЛИШЕ після успішних попередніх кроків.
 * Інженерний сектор може викликати її для самоперевірки своєї реалізації. Проходження НЕ доводить, що робочий update.mjs
 * використовує той самий шлях (це — наскрізне приймання S6).
 */
export async function checkReadiness(readiness) {
  const reasons = [];
  const r = readiness || {};
  const step = async (name, fn) => { try { await fn(); } catch (e) { reasons.push(`${name}: ${msg(e)}`); } };
  if (r.publisher?.contract !== READINESS_CONTRACT.publisher || typeof r.publisher?.renderProbe !== "function") reasons.push(`S6: немає publisher «${READINESS_CONTRACT.publisher}» (renderProbe)`);
  else {
    await step("S6 publisher", async () => {
      const inp = probeInputs();
      if (availableOf(await r.publisher.renderProbe({ ...structuredClone(inp), ccState: probeState([PROBE_ID], false) })) !== "false") throw new Error("знятий товар не опубліковано як available=\"false\"");
      if (availableOf(await r.publisher.renderProbe({ ...structuredClone(inp), ccState: probeState([], false) })) !== "true") throw new Error("без зняття товар має бути available=\"true\" (перевірка справжнього формування)");
      // R6: видалений товар — без жодного <offer> (не available="false"); сусідній товар публікується як звичайно.
      const removedXml = await r.publisher.renderProbe({ ...structuredClone(inp), ccState: probeState([], false, [PROBE_ID]) });
      if (hasOffer(removedXml, PROBE_ID)) throw new Error("видалений товар є у фіді (має бути відсутній, а не available=\"false\")");
      if (availableOf(removedXml, PROBE_ID2) !== "true") throw new Error("видалення одного товару зачепило інший (перевірка справжнього формування)");
      let refused = false;
      try { await r.publisher.renderProbe({ ...structuredClone(inp), ccState: probeState([], true) }); } catch { refused = true; }
      if (!refused) throw new Error("стан blocked не зупинив публікацію");
    });
  }
  if (r.serving?.contract !== READINESS_CONTRACT.serving || SERVING_FUNCTIONS.some((f) => typeof r.serving?.[f] !== "function")) reasons.push(`протокол A: немає serving «${READINESS_CONTRACT.serving}» (${SERVING_FUNCTIONS.join(" / ")}) — apply поза протоколом A заборонено`);
  if (r.committer?.contract !== READINESS_CONTRACT.committer || typeof r.committer?.acquire !== "function") reasons.push(`W2: немає committer «${READINESS_CONTRACT.committer}» (acquire)`);
  else {
    await step("W2 committer", async () => {
      const scope = LEASE_SCOPE + ":readiness-probe";
      const a = await r.committer.acquire(scope);
      try {
        if (!Number.isInteger(a?.token) || a.token < 1) throw new Error("оренда без монотонного токена");
        if (typeof a?.leaseId !== "string" || !LEASE_ID_RE.test(a.leaseId)) throw new Error("оренда без leaseId (32 hex на кожну видачу, cc-committer-v2)");
        let second = null;
        try { second = await r.committer.acquire(scope); } catch { /* очікувано */ }
        if (second) { await second.release?.(); throw new Error("друга оренда тієї самої області видана — немає виключності"); }
        await a.assertCurrent();
      } finally { await a?.release?.(); }
      let stale = false;
      try { await a.assertCurrent(); } catch { stale = true; }
      if (!stale) throw new Error("застаріла оренда не виявляється (assertCurrent після release)");
      const b = await r.committer.acquire(scope);
      try {
        if (!(b.token > a.token)) throw new Error("токен оренди не зростає");
        if (b.leaseId === a.leaseId) throw new Error("leaseId повторюється між видачами оренди");
      } finally { await b.release?.(); }
    });
  }
  const s = r.store;
  if (typeof s?.getJsonVersioned !== "function" || typeof s?.putJsonIfVersion !== "function") reasons.push(`W2: сховище без CAS «${READINESS_CONTRACT.store}» (getJsonVersioned / putJsonIfVersion)`);
  else if (reasons.length) reasons.push("W2 store: не перевірено — спершу мають пройти перевірки publisher і committer (у сховище нічого не записано)");
  else {
    await step("W2 store", async () => {
      const scope = LEASE_SCOPE + ":readiness-probe";
      const lease = await r.committer.acquire(scope);
      const fence = { lease: { scope, token: lease.token } };
      try {
        const g = await s.getJsonVersioned(PROBE_KEY);
        const value = { v: 1, probe: Math.random().toString(36).slice(2) };
        const put = await s.putJsonIfVersion(PROBE_KEY, value, g.version, fence);
        let stale = false;
        try { await s.putJsonIfVersion(PROBE_KEY, { v: 1, probe: "stale" }, g.version, fence); } catch { stale = true; }
        if (!stale) throw new Error("запис із застарілою версією прийнято — немає CAS");
        const g2 = await s.getJsonVersioned(PROBE_KEY);
        if (JSON.stringify(g2.value) !== JSON.stringify(value) || g2.version !== put?.version) throw new Error("читання назад не збігається із записаним");
      } finally { await lease.release?.(); }
      // Fencing: запис зі звільненою (застарілою) орендою за ПРАВИЛЬНОЇ версії має бути відхилений сховищем (H04).
      const g3 = await s.getJsonVersioned(PROBE_KEY);
      let fenced = false;
      try { await s.putJsonIfVersion(PROBE_KEY, { v: 1, probe: "stale-lease" }, g3.version, fence); } catch { fenced = true; }
      if (!fenced) throw new Error("запис зі звільненою орендою прийнято за правильної версії — немає fencing");
    });
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------- внутрішні операції запису (не експортуються) ----------
/** Службовий аркуш із заголовком: створено без заголовка й порожній — дописати заголовок; нові колонки — в кінець. */
async function ensureOwnSheet({ sheets, readBook, title, header }) {
  const cur = (await read(readBook, [title]))[title];
  if (!cur) { await sheets.ensureSheet(title, header.slice()); return; }
  const h = (cur[0] || []).map(mtText);
  const dataRows = cur.slice(1).some((r) => (r || []).some((v) => v !== "" && v != null));
  if (!h.some(Boolean) && !dataRows) { await sheets.updateRanges([{ title, row: 1, col: 1, values: [header.slice()] }]); return; }
  const add = header.filter((k) => !h.includes(k));
  if (add.length) {
    await sheets.ensureColumns(title, h.length + add.length);
    await sheets.updateRanges([{ title, row: 1, col: h.length + 1, values: [add] }]);
  }
}
/** Дописати рядки, ключа яких ще немає; до 3 спроб; результат кожної — читанням. Аркуш — лише службовий (guardWriter). */
async function appendMissing({ sheets, readBook, title, keyName, header, rows }) {
  const k = header.map(mtText).indexOf(keyName);
  for (let attempt = 0; ; attempt++) {
    const have = new Set(keysOf((await read(readBook, [title]))[title], keyName));
    const missing = rows.filter((r) => !have.has(mtText(r[k])));
    if (!missing.length || attempt === 3) return missing;
    try { await sheets.appendRows(title, missing.map((r) => r.slice())); } catch { /* результат — наступним читанням */ }
  }
}
async function writeView({ sheets, readBook, values }) {
  const cur = (await read(readBook, [CC_SHEET.state]))[CC_SHEET.state];
  if (cur && same2d(cur, values)) return "UNCHANGED";
  if (!cur) await sheets.ensureSheet(CC_SHEET.state, values[0].slice());
  const height = Math.max(values.length, cur?.length || 0);
  const width = Math.max(...values.map((r) => r.length), ...(cur || []).map((r) => r.length), 1);
  await sheets.ensureColumns(CC_SHEET.state, width);
  const block = Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => (values[i]?.[j] == null ? "" : values[i][j])));
  await sheets.updateRanges([{ title: CC_SHEET.state, row: 1, col: 1, values: block }]);
  return "UPDATED";
}
/** Оренда для протоколу A (cc-serving-v2): токен (епоха), leaseId, область, покоління відновлення. */
const leaseView = (l) => ({ token: l.token, leaseId: l.leaseId, scope: LEASE_SCOPE, generation: Number.isInteger(l.generation) ? l.generation : 0 });
/** R7.3 (C3): кожен запис точки — з епохою й leaseId оренди, що його робить. */
const withEpoch = (value, lease) => ({ ...value, epochHigh: lease.token, leaseId: lease.leaseId });
/** Реєстр рішень для дзеркала Engineering: точка без видач кодів і часу запису. */
const registryOf = (c) => structuredClone({ v: c.v, ops: c.ops, pending: c.pending, aborted: c.aborted, epochHigh: c.epochHigh, leaseId: c.leaseId, ...(c.recovery ? { recovery: c.recovery } : {}) });
const SEALED_CODES = new Set(["CC_TICKET_REJECTED", "CC_KEY_SEALED", "SERVING_NOT_SECURED"]);
/**
 * R7.3 (C1, cc-serving-v2): ЗАПЕЧАТАНИЙ запис контрольної точки під орендою.
 *  1) assertCurrent; 2) свіже читання аркушів і стан, що ДІЯТИМЕ після запису (controlsState з новою точкою); 3) beforeCommit —
 *  Engineering робить обслуговування фідів безпечним щодо цього стану й видає квиток; 4) assertCurrent; 5) CAS-запис із квитком
 *  (сховище Engineering атомарно перевіряє оренду, версію, хеш значення й квиток); 6) assertCurrent, читання назад; 7) afterCommit
 *  (завершення head / дзеркала реєстру — збій не скасовує запису, лише попередження). CC квитків не створює й не перевіряє.
 * { ok, version, value, warning } | { ok: false, notApplied | lost | conflict | unknown | failed, code, reason }. notApplied — точку
 * точно не записано (відмова захисту обслуговування / сховища до запису).
 */
async function writeCheckpoint({ store, serving, lease, value, version, phase, readBook, ctx }) {
  const next = withEpoch(value, lease);
  try { await lease.assertCurrent(); } catch (e) { return { ok: false, lost: true, reason: "оренду втрачено: " + msg(e) }; }
  let fresh;
  try { fresh = await read(readBook, CONTROLS_SHEETS); } catch (e) { return { ok: false, notApplied: true, code: "SERVING_NOT_SECURED", reason: "свіже читання перед записом точки не вдалося — обслуговування не перевірено: " + msg(e) }; }
  let gate;
  try {
    const state = controlsState(fresh, { ...ctx, checkpoint: next });
    gate = await serving.beforeCommit({ phase, lease: leaseView(lease), cp: { expectedVersion: version, next: structuredClone(next) }, state, registry: registryOf(next) });
  } catch (e) { gate = { ok: false, code: "SERVING_NOT_SECURED", reason: msg(e) }; }
  if (!gate?.ok || !gate.ticket) return { ok: false, notApplied: true, code: mtText(gate?.code || "SERVING_NOT_SECURED"), reason: "serving not secured: " + mtText(gate?.reason || "квиток не видано").slice(0, 300) };
  try { await lease.assertCurrent(); } catch (e) { return { ok: false, lost: true, reason: "оренду втрачено під час захисту обслуговування: " + msg(e) }; }
  try { await store.putJsonIfVersion(CHECKPOINT_KEY, next, version, { lease: { scope: LEASE_SCOPE, token: lease.token, leaseId: lease.leaseId }, ticket: gate.ticket }); }
  catch (e) {
    const code = e?.code || "", text = msg(e);
    if (SEALED_CODES.has(code)) return { ok: false, notApplied: true, code, reason: text };
    return { ok: false, conflict: code === "CONFLICT" || /CONFLICT/.test(text), lost: code === "STALE_LEASE" || /STALE/.test(text), failed: true, reason: text };
  }
  // Після ефекту: якщо оренда вже не чинна, наступник міг діяти — результат невідомий, а не COMMITTED (H04).
  try { await lease.assertCurrent(); } catch (e) { return { ok: false, lost: true, reason: "оренду втрачено під час запису точки: " + msg(e) }; }
  let back;
  try {
    back = await store.getJsonVersioned(CHECKPOINT_KEY);
    if (JSON.stringify(back.value) !== JSON.stringify(next)) return { ok: false, conflict: true, reason: "контрольна точка після запису інша" };
  } catch (e) { return { ok: false, unknown: true, reason: "читання контрольної точки назад не вдалося: " + msg(e) }; }
  let warning = "";
  try { const a = await serving.afterCommit({ ticket: gate.ticket, version: back.version }); if (!a?.ok) warning = "завершення head / дзеркала реєстру не підтверджено: " + mtText(a?.reason || "—").slice(0, 200); }
  catch (e) { warning = "завершення head / дзеркала реєстру не вдалося: " + msg(e); }
  return { ok: true, version: back.version, value: next, warning };
}

async function shadowRun({ readBook, stamp, config, contract, protection, parsed, store, integrity, publication }) {
  let checkpoint;
  let checkpointVerified = false;
  if (contract.activated) {
    const reader = store && (store.getJsonVersioned ? async () => (await store.getJsonVersioned(CHECKPOINT_KEY)).value : store.getJson ? () => store.getJson(CHECKPOINT_KEY) : null);
    if (reader) { try { checkpoint = (await reader()) ?? null; checkpointVerified = true; } catch { checkpoint = undefined; } }
  }
  // Без сховища — оцінка як до активації, з явною позначкою, що точку не перевірено.
  const ctx = { contract: checkpointVerified || !contract.activated ? contract : { ...contract, activated: false }, checkpoint, integrity, publication };
  let book;
  try { book = await read(readBook, CONTROLS_SHEETS); } catch (e) { return { state: "READ_FAILED", reason: e.message, notice: SHADOW_NOTICE }; }
  const plan = planControls({ book, stamp, config, protection, parsed, ...ctx });
  const base = { stats: plan.stats, warnings: plan.warnings, inputColumns: plan.inputColumns, notice: SHADOW_NOTICE, checkpointVerified };
  if (plan.abort) return { state: plan.blocked.length ? "BLOCKED" : "ABORTED", reason: plan.abort, ...base };
  return { state: "SHADOW", planned: { events: plan.events.length }, view: buildView(book, { ...ctx, notes: plan.notes, shadow: true }), ...base, ...controlsState(book, ctx) };
}

/**
 * Один прохід. contract — об'єкт контракту (за замовчуванням — з репозиторію); readiness — реалізація S6 / W2 від інженерного
 * сектору (обов'язкова для apply); protection — loadProtection(); parsed — розбір фіду (конфлікти ID); store — лише для читання
 * контрольної точки в shadow (apply використовує readiness.store); integrity — { cardVerdict(row) } (M3, Engineering);
 * publication — Map(Offer ID → { feed: "absent" | "present" | "unknown" }) — стан АКТИВНОЇ опублікованої версії YML від Engineering
 * (лише для стадії DONE; R6: перенесення й виключення з YML від нього не залежать, підтвердження Prom не потрібне).
 */
export async function runControls({ sheets, readBook, stamp, config = {}, contract = undefined, protection = null, parsed = null, store = null, readiness = null, mode = "shadow", integrity = null, publication = null }) {
  const ct = contract === undefined ? loadControlsContract() : { contract, problems: validateContract(contract) };
  if (ct.problems.length) return { state: "BLOCKED", reason: "контракт Catalog Controls: " + ct.problems.join("; ") };
  if (mode !== "apply" && mode !== "recover") return shadowRun({ readBook, stamp, config, contract: ct.contract, protection, parsed, store: store || readiness?.store, integrity, publication });
  if (ct.contract.activated !== true) return { state: "NOT_ACTIVATED", reason: "контракт не активовано — застосування заборонене (потрібен окремий дозвіл власника)" };
  const ready = await checkReadiness(readiness);
  if (!ready.ok) return { state: "NOT_READY", reason: "готовність S6 / W2 / протоколу A не підтверджено — застосування заборонене до будь-яких записів", reasons: ready.reasons };
  let lease;
  try { lease = await readiness.committer.acquire(LEASE_SCOPE); } catch (e) { return leaseRefusal(e); }
  try {
    const args = { sheets: guardWriter(sheets), readBook, stamp, config, contract: ct.contract, protection, parsed, store: readiness.store, serving: readiness.serving, lease, integrity, publication };
    return await (mode === "recover" ? recoverLocked(args) : applyLocked(args));
  } finally { try { await lease.release(); } catch { /* оренда сама спливе за правилами W2 */ } }
}

/**
 * R7.4 (ENG-24 розд. 11 п. 1; контракт F04 / F06 / F08, розд. 5): відмова видачі оренди → стан CC за кодом відмови (e.code — як у
 * LeaseError / FenceError Engineering). Звичайна зайнятість — BUSY (повторити пізніше). Відкат W2 (токен оренди нижчий за межу
 * епох) — RECOVERY_PENDING: вихід лише окремим дозволом власника (cc-recovery-v1). Решта — BLOCKED (стан невідомий). Оренди немає,
 * тож записів немає в жодному разі. detector "epoch-floor" — не "journal": детектор журналу — окремий (Q2).
 */
const LEASE_BUSY = new Set(["BUSY", "SETTLING", "STALE_EPOCH"]);
function leaseRefusal(e) {
  const code = typeof e?.code === "string" ? e.code : "", text = msg(e);
  if (LEASE_BUSY.has(code)) return { state: "BUSY", code, reason: "інший записувач тримає оренду — повторіть пізніше: " + text };
  if (code === "RECOVERY_PENDING") {
    return { state: "RECOVERY_PENDING", code, detector: "epoch-floor", reason: "оренду не видано за межею епох (можливий відкат сховища W2) — Catalog Controls нічого не записує; потрібен окремий дозвіл власника на відновлення (cc-recovery-v1): " + text };
  }
  return { state: "BLOCKED", code: code || "LEASE_REFUSED", reason: "оренду не видано, причина не визначена — Catalog Controls нічого не записує: " + text };
}

/** R7.3 (C2): стан протоколу A від Engineering на початку запуску; виняток — невідомо (BLOCKED, без записів). R7.4: також type. */
async function servingStatus(serving, lease) {
  try { const s = await serving.status({ lease: leaseView(lease) }); return { state: mtText(s?.state), reason: mtText(s?.reason), type: mtText(s?.type) }; }
  catch (e) { return { state: "UNKNOWN", reason: "стан протоколу A не прочитано: " + msg(e), type: "" }; }
}
/** R7.3 (Q2): причина для рядків «Історії керування» без прив'язки до контрольної точки (детектор відкату точки). */
const unboundReason = (st) => {
  const sample = st.mirror.unbound.slice(0, 5).map((e) => `${e.offerId || "—"} ${e.action}`).join("; ");
  return `«${CC_SHEET.history}»: рядків без прив'язки до контрольної точки — ${st.mirror.unbound.length} (${sample}) — можливе відновлення точки; Catalog Controls нічого не записує; потрібен окремий дозвіл власника на відновлення (cc-recovery-v1)`;
};
/** Поля, які має кожна точка, записана R7.3+ під протоколом A (C3, C5). */
const PROTOCOL_A_FIELDS = Object.freeze(["epochHigh", "leaseId", "recovery"]);
/**
 * R7.4 (ENG-24 розд. 11 п. 4): serving.status → NORMAL з type "MIGRATION" — протокол A щойно створив head W2 і дзеркало реєстру з
 * чинної точки (їх не було). Цей запуск — окремий стан MIGRATED без жодного запису: ні рішень, ні кодів, ні аркушів, ні точки, і
 * не COMMITTED. Команди власника виконає наступний звичайний запуск. Міграцію підтверджено, лише якщо:
 *  • точка є й має формат до R7.3 — без epochHigh / leaseId / recovery. Кожен запис R7.3+ іде через протокол A, тобто з head і
 *    дзеркалом; точка з цими полями без них можлива лише після їх втрати чи відкату — це не міграція;
 *  • стан не blocked, «Історія керування» читається й не має рядків без прив'язки до точки.
 * Інакше міграція недостовірна: RECOVERY_PENDING (detector "migration" або "journal") чи BLOCKED; нічого не застосовано.
 */
async function migrationRun({ cp, readBook, ctx, reason, phases }) {
  const unverified = (why) => ({
    state: "RECOVERY_PENDING", detector: "migration", code: "MIGRATION_UNVERIFIED", checkpoint: "UNCHANGED", phases,
    reason: `протокол A повідомив про міграцію, але її не підтверджено: ${why} — Catalog Controls нічого не записує; потрібна перевірка Engineering і окремий дозвіл власника (cc-recovery-v1)`,
  });
  if (cp.value === null) return unverified("контрольної точки немає — приймати нічого");
  const fields = PROTOCOL_A_FIELDS.filter((k) => Object.hasOwn(cp.value, k));
  if (fields.length) return unverified(`точка має поля протоколу A (${fields.join(", ")}) — head W2 і дзеркало реєстру мали існувати; можливий відкат або втрата коренів`);
  let book;
  try { book = await read(readBook, CONTROLS_SHEETS); } catch (e) { return { state: "READ_FAILED", reason: e.message, phases }; }
  const st = loadState(book, ctx);
  if (st.blocked) return { state: "BLOCKED", reason: st.structural.join("; ") + " — міграцію не підтверджено; Catalog Controls нічого не записує", phases };
  if (st.mirror.journalBroken) return { state: "BLOCKED", reason: `«${CC_SHEET.history}» не читається (${st.hist.structural.join("; ")}) — міграцію не підтверджено; Catalog Controls нічого не записує`, phases };
  if (st.mirror.unbound.length) return { state: "RECOVERY_PENDING", detector: "journal", reason: unboundReason(st), phases, ...controlsState(book, ctx) };
  return {
    state: "MIGRATED", migration: { type: "MIGRATION", reason }, checkpoint: "UNCHANGED", view: "UNCHANGED",
    reason: "протокол A прийняв чинну контрольну точку (head W2 і дзеркало реєстру створено вперше); цей запуск нічого не записує — команди власника виконає наступний запуск",
    phases: [...phases, "міграція: точку формату до R7.3 прийнято без змін, кодів не видано"], ...controlsState(book, ctx),
  };
}
/** R7.3 (C3): епоха цього запуску має бути більшою за епоху останнього запису точки — інакше лічильник оренди не зростає. */
const epochProblem = (cp, lease) => (cp && Number.isInteger(cp.epochHigh) && !(lease.token > cp.epochHigh)
  ? `токен оренди (${lease.token}) не більший за епоху останнього запису контрольної точки (${cp.epochHigh}) — лічильник оренди W2 має лише зростати; Catalog Controls нічого не записує`
  : "");

async function applyLocked({ sheets, readBook, stamp, config, contract, protection, parsed, store, serving, lease, integrity, publication }) {
  const phases = [];
  const assertLease = async () => { try { await lease.assertCurrent(); } catch (e) { throw new LeaseLost(msg(e)); } };
  const unknown = (reason, extra = {}) => ({ state: "UNKNOWN", reason, phases, ...extra });
  // R7.3 (C2): лише NORMAL; RECOVERY_PENDING / RECOVERY_AUTHORIZED — нічого не пишемо (вихід — окремим дозволом власника, cc-recovery-v1).
  const sv = await servingStatus(serving, lease);
  if (sv.state !== "NORMAL") return { state: sv.state === "UNKNOWN" ? "BLOCKED" : "RECOVERY_PENDING", reason: sv.reason || `протокол A: стан ${sv.state} — Catalog Controls нічого не записує до погодженого власником відновлення`, phases };
  let cp;
  try { cp = await store.getJsonVersioned(CHECKPOINT_KEY); } catch (e) { return { state: "BLOCKED", reason: "контрольна точка не читається: " + msg(e) }; }
  // R7.4 (d): запуск міграції протоколу A — окремий, без жодного запису; недостовірна міграція команд не застосовує.
  if (sv.type === "MIGRATION") return migrationRun({ cp, readBook, ctx: { contract, checkpoint: cp.value, integrity, publication }, reason: sv.reason, phases });
  const ep = epochProblem(cp.value, lease);
  if (ep) return { state: "BLOCKED", reason: ep, warnings: [ep], phases };
  let book;
  try { book = await read(readBook, CONTROLS_SHEETS); } catch (e) { return { state: "READ_FAILED", reason: e.message }; }
  const ctxOf = () => ({ contract, checkpoint: cp.value, integrity, publication });
  const write = (value, phase) => writeCheckpoint({ store, serving, lease, value, version: cp.version, phase, readBook, ctx: ctxOf() });
  const warn = (w) => { if (w.warning) phases.push(w.warning); };

  // C2: ініціалізація — лише якщо точки немає і журнал порожній; підтверджується ДО першої події.
  if (cp.value === null) {
    const h0 = readHistory(book[CC_SHEET.history]);
    if (h0.seenOps.size || h0.damagedRows.length) return { state: "BLOCKED", reason: "контрольної точки немає, а журнал має записи — потрібна перевірка (автоматично не ініціалізується)" };
    const init = await write(emptyCheckpoint(stamp), "init");
    if (!init.ok) return init.lost ? unknown("оренду втрачено до ініціалізації") : { state: init.conflict ? "UNKNOWN" : "BLOCKED", reason: "ініціалізацію контрольної точки не підтверджено: " + init.reason, phases };
    cp = { value: init.value, version: init.version };
    warn(init);
    phases.push("контрольну точку ініціалізовано");
  }
  let st = loadState(book, ctxOf());
  // R7.3 (Q2): «Історія керування» — додатковий детектор відкату точки (дозволу не дає ніколи): рядки без прив'язки до точки →
  // CC нічого не записує; стан для споживачів — як раніше (захисні діють, послаблення — ні, товар ізольовано).
  if (!st.blocked && !st.mirror.journalBroken && st.mirror.unbound.length) {
    return { state: "RECOVERY_PENDING", detector: "journal", reason: unboundReason(st), phases, ...controlsState(book, ctxOf()) };
  }
  if (st.blocked) return { state: "BLOCKED", reason: st.structural.join("; ") + " — Catalog Controls не виконується (стан товарів не визначити)" };
  if (st.mirror.journalBroken) return { state: "BLOCKED", reason: `«${CC_SHEET.history}» не читається (${st.hist.structural.join("; ")}) — CC не дописує нових записів, доки заголовок не відновлено; споживачі працюють із контрольної точки` };

  /**
   * Цикл однієї групи змін. newIntents — наміри цього запуску (у точку — ДО запису в журнал); appendIntents — наміри попередніх
   * запусків без рядка (лише захисні); repair — підтверджені операції, рядків яких немає в журналі (дзеркало дописується з точки);
   * issued — видачі кодів підтвердження цього запуску (R7, F2): пишуться в ту саму точку разом із намірами.
   */
  async function cycle({ newIntents, appendIntents, repair = [], notes, recovery, issued = null, debt = false }) {
    const affected = affectedBy([...newIntents, ...(recovery ? cp.value.pending : appendIntents)]);
    // НЕВИЗНАЧЕНО — до будь-якого ефекту (F3).
    try {
      await assertLease();
      await writeView({ sheets, readBook, values: buildView(book, { ...ctxOf(), notes, uncertain: affected, since: stamp }) });
    } catch (e) {
      return { done: false, result: e instanceof LeaseLost ? unknown("оренду втрачено до позначення невизначеності — нічого не застосовано: " + e.message) : { state: "NOT_APPLIED", reason: "не вдалося позначити невизначеність у «Стані керування» — нічого не застосовано: " + msg(e), phases } };
    }
    // Довірені наміри — ДО зовнішнього запису (F1).
    if (newIntents.length) {
      const next = withIntents(cp.value, newIntents, stamp, issued);
      const w = await write(next, debt ? "debt" : "intents");
      // R7.3 (C6): точку точно не записано (протокол A відмовив до запису) — NOT_APPLIED; інакше — невідомо.
      if (!w.ok && w.notApplied && !w.lost) return { done: false, result: { state: "NOT_APPLIED", reason: "наміри не записано — " + w.reason, code: w.code, checkpoint: "NOT_WRITTEN", phases } };
      if (!w.ok) return { done: false, result: unknown("наміри не підтверджено контрольною точкою — нічого не дописано: " + w.reason, { checkpoint: "FAILED: " + w.reason }) };
      cp = { value: w.value, version: w.version };
      warn(w);
      phases.push(`наміри: ${newIntents.length}`);
    }
    const rows = [...repair.map((e) => e.row), ...[...appendIntents, ...newIntents].map((it) => it.row)];
    try {
      if (rows.length) {
        await assertLease();
        await ensureOwnSheet({ sheets, readBook, title: CC_SHEET.history, header: HISTORY_HEADERS });
        await assertLease();
        const missing = await appendMissing({ sheets, readBook, title: CC_SHEET.history, keyName: "Operation ID", header: HISTORY_HEADERS, rows });
        phases.push(missing.length ? `рядків не підтверджено: ${missing.length}` : `рядки журналу: ${rows.length}${repair.length ? ` (з них відновлено з точки: ${repair.length})` : ""}`);
      }
    } catch (e) {
      if (e instanceof LeaseLost) return { done: false, result: unknown("оренду втрачено — подальших записів немає; наступний запуск звірить за Operation ID: " + e.message) };
      if (e instanceof ReadFailed) return { done: false, result: unknown("читання не вдалося — нічого не вважається підтвердженим: " + e.message) };
      phases.push("помилка запису: " + msg(e));
    }
    let after;
    try { after = await read(readBook, CONTROLS_SHEETS); } catch { return { done: false, result: unknown("читання для перевірки не вдалося — нічого не вважається підтвердженим; контрольну точку не змінено") }; }
    const verified = loadState(after, ctxOf());
    if (verified.blocked) return { done: false, result: { state: "BLOCKED", reason: verified.structural.join("; "), phases, ...controlsState(after, ctxOf()) } };
    const confirm = new Set(), abort = new Map();
    for (const it of cp.value.pending) {
      const d = decideIntent(it, verified, after);
      if (d === "confirm") confirm.add(it.op);
      else if (d?.abort) abort.set(it.op, d.abort);
    }
    // CC4-N2: безпосередньо перед CAS — свіже читання й повторна перевірка авторизації кожного послаблення.
    const weak = cp.value.pending.filter((it) => it.weakening && confirm.has(it.op));
    if (weak.length) {
      let fresh;
      try { fresh = await read(readBook, CONTROLS_SHEETS); } catch { return { done: false, result: unknown("свіже читання перед комітом не вдалося — послаблення не підтверджено") }; }
      const fst = loadState(fresh, ctxOf());
      for (const it of weak) {
        const d = decideIntent(it, fst, fresh);
        if (d !== "confirm") { confirm.delete(it.op); abort.set(it.op, d?.abort || "авторизацію відкликано перед комітом"); }
      }
    }
    const next = settleCheckpoint(cp.value, { confirm, abort }, stamp);
    let checkpointState = "UNCHANGED";
    if (!sameCheckpoint(next, cp.value)) {
      const w = await write(next, recovery ? "recovery" : debt ? "debt" : "settle");
      if (!w.ok) {
        // Збій коміту — результат невідомий (запис міг відбутися). Вигляд лишається НЕВИЗНАЧЕНО; звірка — наступний запуск.
        const state = recovery || w.conflict || w.unknown || w.lost ? "UNKNOWN" : "UNCONFIRMED";
        return { done: false, result: { state, reason: (recovery ? "звірку не підтверджено контрольною точкою: " : "коміт контрольної точки не підтверджено: ") + w.reason, ...(w.code ? { code: w.code } : {}), checkpoint: "FAILED: " + w.reason, view: "НЕВИЗНАЧЕНО", phases, ...controlsState(after, ctxOf()) } };
      }
      cp = { value: w.value, version: w.version };
      warn(w);
      checkpointState = "WRITTEN";
    }
    // Після CAS — читання. R7 (F1): захист від нього НЕ залежить — підтверджене повернення в продаж діє лише для авторизованої
    // фізичної ідентичності (стан для споживачів), а автоматичне зняття — борг захисту, який довершує будь-який наступний запуск.
    let post = after, postRead = true;
    try { post = await read(readBook, CONTROLS_SHEETS); } catch { postRead = false; }
    let view;
    try { await assertLease(); view = await writeView({ sheets, readBook, values: buildView(post, { ...ctxOf(), notes }) }); } catch (e) { view = "FAILED: " + msg(e); }
    book = post;
    const released = weak.filter((it) => confirm.has(it.op) && it.action === ACTION.RELEASE).length;
    if (!postRead && released) phases.push("перевірку ідентичності після коміту не виконано (читання не вдалося) — товар захищено прив'язкою до авторизованої ідентичності; наступний apply довершить");
    return { done: true, confirm, abort, kept: cp.value.pending.length, checkpointState, view, postCheckFailed: !postRead && released > 0 };
  }

  /**
   * R7 (F1 / N2): борг захисту — підтверджені повернення в продаж, для яких фізична ідентичність картки не та, що авторизована
   * (releaseMismatch у стані). Для них — автоматичне «ЗНЯТО З ПРОДАЖУ». Обчислюється з довіреного стану (не з пам'яті запуску),
   * тому збій читання після CAS чи запису цього наміру не губить захисту: наступний запуск знайде той самий борг.
   */
  function protectionDebt() {
    const s = loadState(book, ctxOf());
    const out = [];
    for (const [id, m] of s.releaseMismatch) {
      if (s.unconfirmedByProduct.has(id) || s.exclusions.has(id)) continue;
      const p = s.fold.products.get(id);
      if (!p || p.sale.held) continue;
      const key = m.now || "—";
      const opId = operationId({ offerId: id, action: "AUTOHOLD", code: m.op, payload: key });
      const r = historyRow({ stamp, opId, offerId: id, action: ACTION.HOLD, field: "Продаж", before: "У ПРОДАЖУ", after: "ЗНЯТО", reason: "автоматично: фізична ідентичність товару не та, для якої авторизовано повернення в продаж — потрібне нове рішення власника", generation: `sale:${p.sale.n + 1}` });
      out.push({ op: opId, offerId: id, seal: r.at(-1), row: r, action: ACTION.HOLD, weakening: false, cmd: "AUTOHOLD", auth: key, at: mtText(stamp) });
    }
    return out;
  }
  async function settleDebt(notes) {
    const intents = protectionDebt();
    if (!intents.length) return { done: true, n: 0 };
    const hold = await cycle({ newIntents: intents, appendIntents: [], notes, recovery: false, debt: true });
    if (!hold.done) return { done: false, result: { ...hold.result, reason: "захисне зняття (ідентичність не та, для якої авторизовано повернення) не підтверджено: " + hold.result.reason } };
    phases.push(`захисне зняття (ідентичність не та, для якої авторизовано повернення): ${intents.length}`);
    return { done: true, n: intents.length, checkpointState: hold.checkpointState, postCheckFailed: hold.postCheckFailed };
  }

  // Звірка: наміри попередніх запусків і відсутні в журналі підтверджені рядки — ДО нових команд.
  let recovered = null, autoHeld = 0, postCheckFailed = false, debtState = "";
  if (st.pendingIntents.length || st.mirror.missing.length) {
    const missingOps = new Set(st.mirror.missing.map((e) => e.op));
    const appendIntents = st.pendingIntents.filter((it) => !it.weakening && missingOps.has(it.op));
    const repair = st.mirror.missing.filter((e) => e.status === "confirmed");
    const c = await cycle({ newIntents: [], appendIntents, repair, notes: new Map(), recovery: true });
    if (!c.done) return c.result;
    phases.push(`звірка: підтверджено ${c.confirm.size}, скасовано ${c.abort.size}, лишилось ${c.kept}`);
    recovered = c;
    postCheckFailed ||= c.postCheckFailed;
    st = loadState(book, ctxOf());
    if (st.blocked) return { state: "BLOCKED", reason: st.structural.join("; ") + " — Catalog Controls не виконується", phases };
  }
  // R7 (F1): борг захисту — після звірки й ДО нових команд (зокрема довершення невдалого раніше автоматичного зняття).
  const d0 = await settleDebt(new Map());
  if (!d0.done) return d0.result;
  if (d0.n) { autoHeld += d0.n; debtState = d0.checkpointState; postCheckFailed ||= d0.postCheckFailed; st = loadState(book, ctxOf()); }

  // R7.2 (C71-01): епоха видачі кодів — токен оренди цього запуску (поза контрольною точкою).
  const plan = planControls({ book, stamp, config, protection, parsed, ...ctxOf(), epoch: lease.token });
  const base = { stats: plan.stats, warnings: plan.warnings, inputColumns: plan.inputColumns };
  if (plan.abort) return { state: plan.blocked.length ? "BLOCKED" : "ABORTED", reason: plan.abort, phases, ...base };
  let c = null, issuedFailed = "";
  if (plan.intents.length) {
    c = await cycle({ newIntents: plan.intents, appendIntents: [], notes: plan.notes, recovery: false, issued: plan.issued });
    if (!c.done) return { ...c.result, ...base };
    postCheckFailed ||= c.postCheckFailed;
    const d1 = await settleDebt(plan.notes);
    if (!d1.done) return { ...d1.result, ...base };
    if (d1.n) { autoHeld += d1.n; postCheckFailed ||= d1.postCheckFailed; }
  } else {
    let checkpointState = recovered?.checkpointState || debtState || "UNCHANGED";
    // R7 (F2): лише видачі кодів — у точку (CAS + оренда) ДО показу: показаний код завжди збережений, інакше його не видно.
    if (plan.issued.size) {
      const next = withIssued(cp.value, plan.issued, stamp);
      if (!sameCheckpoint(next, cp.value)) {
        const w = await write(next, "issued");
        if (w.ok) { cp = { value: w.value, version: w.version }; warn(w); checkpointState = "WRITTEN"; phases.push(`видано кодів: ${plan.issued.size}`); }
        else if (w.lost) return { ...unknown("оренду втрачено під час видачі кодів: " + w.reason), ...base };
        else { issuedFailed = w.reason; phases.push("коди не видано (контрольну точку не записано): " + w.reason); }
      }
    }
    let view;
    try { await assertLease(); view = await writeView({ sheets, readBook, values: buildView(book, { ...ctxOf(), notes: plan.notes }) }); } catch (e) { view = "FAILED: " + msg(e); }
    c = { confirm: new Set(), abort: new Map(), checkpointState, view };
  }
  const mine = plan.intents.map((it) => it.op);
  const aborted = mine.filter((op) => c.abort.has(op)).length + (recovered?.abort.size || 0) + autoHeld;
  return {
    state: cp.value.pending.length || aborted || postCheckFailed || issuedFailed ? "PENDING" : "COMMITTED", phases,
    verified: { events: plan.intents.filter((it) => c.confirm.has(it.op)).length, of: plan.events.length },
    checkpoint: c.checkpointState, view: c.view, ...base, ...controlsState(book, ctxOf()),
  };
}

/**
 * R7.3 (C5, cc-recovery-v1): відновлення контрольної точки — лише в стані RECOVERY_AUTHORIZED (окремий дозвіл власника, Q1) і за
 * доведеної Engineering межі епох (floorProven; повний відкат W2 + фідів + точки без DO — не доведено, лишається RECOVERY_PENDING).
 * Нова точка (recoverCheckpoint): ухвалені рішення = відновлена точка ∪ дзеркало реєстру рішень; захисні наміри діють; незавершені
 * послаблення скасовано; усі невикористані коди недійсні; журнал — лише детектор. Запис — запечатаний (beforeCommit, фаза «recover»).
 */
async function recoverLocked({ sheets, readBook, stamp, contract, store, serving, lease, integrity, publication }) {
  const phases = [];
  const sv = await servingStatus(serving, lease);
  if (sv.state !== "RECOVERY_AUTHORIZED") return { state: sv.state === "NORMAL" ? "NOT_RECOVERING" : sv.state === "UNKNOWN" ? "BLOCKED" : "RECOVERY_PENDING", reason: sv.reason || `відновлення можливе лише за окремого дозволу власника (стан ${sv.state || "—"})`, phases };
  let rec;
  try { rec = await serving.recovery({ lease: leaseView(lease) }); } catch (e) { return { state: "RECOVERY_PENDING", reason: "дані відновлення не прочитано: " + msg(e), phases }; }
  if (rec?.floorProven !== true) return { state: "RECOVERY_PENDING", reason: "межу епох не доведено незалежним джерелом — відновлення неможливе (повний відкат W2 + фідів + точки без незалежного джерела — BLOCK): " + mtText(rec?.reason || ""), phases };
  let cp;
  try { cp = await store.getJsonVersioned(CHECKPOINT_KEY); } catch (e) { return { state: "BLOCKED", reason: "контрольна точка не читається: " + msg(e), phases }; }
  const ep = epochProblem(cp.value, lease);
  if (ep) return { state: "BLOCKED", reason: ep, warnings: [ep], phases };
  let book;
  try { book = await read(readBook, CONTROLS_SHEETS); } catch (e) { return { state: "READ_FAILED", reason: e.message, phases }; }
  const hist = readHistory(book[CC_SHEET.history]);
  if (hist.structural.length) phases.push(`«${CC_SHEET.history}» не читається — журнал як детектор не використано`);
  const next = recoverCheckpoint({
    base: cp.value, registry: rec.registry ?? null, prepared: rec.prepared ?? null, journal: hist.structural.length ? [] : hist.events,
    at: stamp, epoch: lease.token, leaseId: lease.leaseId, generation: Number.isInteger(lease.generation) ? lease.generation : 0, type: mtText(rec.type), fromHash: mtText(rec.fromHash),
  });
  if (!next) return { state: "BLOCKED", reason: "нова контрольна точка відновлення недійсна (реєстр рішень не узгоджується) — потрібна перевірка", phases };
  const ctx = { contract, checkpoint: cp.value, integrity, publication };
  const w = await writeCheckpoint({ store, serving, lease, value: next, version: cp.version, phase: "recover", readBook, ctx });
  if (!w.ok) return { state: w.lost || w.conflict || w.unknown ? "UNKNOWN" : "RECOVERY_PENDING", reason: "відновлену точку не записано: " + w.reason, ...(w.code ? { code: w.code } : {}), phases };
  if (w.warning) phases.push(w.warning);
  phases.push(`відновлено: покоління ${next.recovery.generation}, рішень ${next.ops.length}, захисних намірів ${next.pending.length}, скасовано послаблень ${next.aborted.length}, визнано рядків журналу ${next.recovery.ack.length}, конфліктів ${next.recovery.conflicts.length}; усі невикористані коди недійсні`);
  const after = { ...ctx, checkpoint: w.value };
  let view;
  try { await lease.assertCurrent(); view = await writeView({ sheets, readBook, values: buildView(book, { ...after, notes: new Map() }) }); } catch (e) { view = "FAILED: " + msg(e); }
  return { state: "RECOVERED", recovery: w.value.recovery, phases, view, ...controlsState(book, after) };
}
