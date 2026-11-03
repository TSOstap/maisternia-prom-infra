/** «Оновити ціни й наявність» на сервері Cloudflare (Durable Object mm-ops) — без хвилин GitHub (рішення власника 03.11: «Давай
 *  пробувати клаудфлер»). Та сама операція, що й op prices у GitHub (src/pipeline/prices-run.mjs, шлюз W2, охоронець MODE_POLICIES.prices),
 *  але з обмеженнями пам'яті Worker (128 МБ; «Основний каталог» TEST ≈ 135 МБ JSON):
 *   • «Основний каталог» читається ЛИШЕ потрібними колонками: для цін (PRICE_READ_COLUMNS) і для Catalog Controls (CC_MAIN_COLUMNS —
 *     ідентичність і колонки рішень). Перевірено на копії TEST 03.11: стан CC із вузького каталогу = із повного (відбиток однаковий);
 *   • повне читання «Основного каталогу» / «Журналу» тут заборонене (readBook кидає) — тому все, що його потребує, передається на GitHub
 *     (fallback): незавершені плани (відновлення «Журналу»), невідомі результати записів W2 (reconcile), незавершені команди CC
 *     (наміри в контрольній точці або рішення в колонках «SEO рішення» / «Продаж рішення» — їхня перевірка читає тексти SEO).
 *  Запис — лише в TEST (охоронець + записувач з ID живої таблиці), токен — ключ сервісного акаунта mm-sheets-copy (google-auth.mjs). */
import defaultConfig from "../../../config/default.json" with { type: "json" };
import ownershipJson from "../../../schemas/sheets/ownership-contract.json" with { type: "json" };
import inputsManifest from "../../../config/ops-inputs.json" with { type: "json" };
import { productionConfig } from "../../../src/pipeline/production.mjs";
import { ownershipFrom } from "../../../src/pipeline/safe-write/ownership.mjs";
import { WriteGateway, CC_CHECKPOINT_KEY } from "../../../src/pipeline/safe-write/gateway.mjs";
import { guardedSheets, MODE_POLICIES, TEST_SHEET_ID, LIVE_SHEET_ID, assertWriteTarget } from "../../../src/pipeline/safe-write/write-target.mjs";
import { GoogleSheetsCatalogSource } from "../../../src/pipeline/google-sheets.mjs";
import { GoogleSheetsWriter } from "../../../src/pipeline/sheets-writer.mjs";
import { catalogControlsAdapter } from "../../../src/pipeline/controls-adapter.mjs";
import { controlsState, verifyControlsSnapshot } from "../../../src/core/controls-plan.mjs";
import { validateContract, identityRow, SEO_DECISION, SALE_DECISION } from "../../../src/core/controls-common.mjs";
import { operationalUrl, parseSupplierText, validateFeed } from "../../../src/core/supplier-feed.mjs";
import { CONFIRMED_SNAPSHOT_KEY } from "../../../src/core/supplier-presence.mjs";
import { planPrices } from "../../../src/core/prices-only.mjs";
import { updatePrices, PRICE_READ_COLUMNS } from "../../../src/pipeline/prices-run.mjs";
import { openPlansGate, JOURNAL_SHEET } from "../../../src/pipeline/run-plan.mjs";
import { syncControls } from "../../../src/core/sheet-sync.mjs";
import { mtText } from "../../../src/core/text.mjs";
import { googleTokenSource } from "./google-auth.mjs";

const MAIN = "Основний каталог";
/** Колонки «Основного каталогу», які читає Catalog Controls (identityOf + команди власника). */
export const CC_MAIN_COLUMNS = Object.freeze(["Offer ID", ...Object.keys(identityRow({})), SEO_DECISION, SALE_DECISION]);
/** Інші аркуші CC (CC_BOOK_SHEETS без «Основного каталогу») — невеликі, читаються повністю. */
const CC_SMALL_SHEETS = Object.freeze(["Нові товари", "Відкладені товари", "Видалені товари", "Історія керування", "Стан керування"]);
const FEED_URL_RE = /^https:\/\/market-tools\.com\.ua\//i;
const MAX_FEED_CHARS = 45_000_000;
const fallback = (reason) => ({ fallback: "github", reason });

/** Читання таблиці для сервера: невеликі аркуші — повністю; «Основний каталог» і «Журнал» — лише вузько (повне — помилка). */
export function sheetsReaders(reader) {
  const readBook = async (names) => {
    const heavy = names.filter((n) => n === MAIN || n === JOURNAL_SHEET);
    if (heavy.length) throw new Error(`сервер Cloudflare не читає «${heavy.join("», «")}» повністю (пам'ять) — операцію виконає GitHub`);
    const { sheets } = await reader.load(names);
    return sheets;
  };
  const readColumns = (title, columns) => reader.loadColumns(title, columns);
  return { readBook, readColumns };
}

/**
 * env — секрети / змінні Worker (GOOGLE_SA_KEY, SUPPLIER_FEED_URL); store — сховище W2 (той самий DO, RemoteStore поверх w2-engine);
 * ccContractText — погоджений контракт CC (вхідний файл DO, SHA-256 звіряється); dry — лише план (без сесії й записів).
 * deps — підміна читача / записувача (тести). → { result, fallback?, reason?, metrics }
 */
export async function runPricesJob({ env, store, ccContractText, sha256Hex, ccSha = inputsManifest.inputs.CC_CONTRACT.sha256, fetchImpl = (...a) => fetch(...a), now = Date.now(), dry = false, deps = {} }) {
  const t0 = Date.now();
  const calls = { google: 0, feed: 0 };
  const counted = (url, init) => { if (String(url).includes("market-tools.com.ua")) calls.feed++; else calls.google++; return fetchImpl(url, init); };
  const metrics = () => ({ ms: Date.now() - t0, subrequests: calls.google + calls.feed, ...calls });
  assertWriteTarget(TEST_SHEET_ID);
  if (!FEED_URL_RE.test(String(env.SUPPLIER_FEED_URL || ""))) return { ...fallback("на сервері немає адреси фіду постачальника"), metrics: metrics() };
  if (!deps.reader && !env.GOOGLE_SA_KEY) return { ...fallback("на сервері немає ключа Google (GOOGLE_SA_KEY)"), metrics: metrics() };
  const config = productionConfig(structuredClone(defaultConfig));
  deps.configure?.(config); // лише тести (синтетичний фід менший за робочий мінімум)
  // Погоджений контракт CC — той самий файл, що й у GitHub (SHA-256 з config/ops-inputs.json).
  if (!ccContractText || (await sha256Hex(ccContractText)) !== ccSha) return { ...fallback("контракт Catalog Controls на сервері не збігається з погодженим"), metrics: metrics() };
  const contract = JSON.parse(ccContractText);
  if (validateContract(contract).length) return { ...fallback("контракт Catalog Controls недійсний"), metrics: metrics() };

  const getAccessToken = deps.reader ? null : googleTokenSource(env.GOOGLE_SA_KEY, { fetchImpl: counted });
  const reader = deps.reader || new GoogleSheetsCatalogSource({ spreadsheetId: TEST_SHEET_ID, getAccessToken, fetchImpl: counted, maxRequests: 45, maxRequestsPerMinute: 40, targetBytes: 4_000_000 });
  const { readBook, readColumns } = sheetsReaders(reader);
  const stamp = new Date(now).toISOString();

  // 1. Незавершені плани / команди CC — на GitHub (там повне читання для відновлення й перевірки).
  const gate = await openPlansGate({ store, session: null, readBook, stamp, recover: false });
  if (gate) return { ...fallback("незавершений попередній запис: " + mtText(gate.reason).slice(0, 200)), metrics: metrics() };
  const cp = (await store.getJsonVersioned(CC_CHECKPOINT_KEY))?.value;
  if (cp?.pending?.length) return { ...fallback("Catalog Controls має незавершені наміри — перевірку виконає GitHub"), metrics: metrics() };
  let ccBook = null;
  const loadCcBook = async () => {
    const small = await readBook([...CC_SMALL_SHEETS]);
    ccBook = { ...small, [MAIN]: await readColumns(MAIN, CC_MAIN_COLUMNS) };
    return ccBook;
  };
  const controls = catalogControlsAdapter({ loadBook: loadCcBook, store, contract, api: { controlsState, verifyControlsSnapshot }, integrity: null, requireActive: true });
  const ccState = await controls.state();
  const h = ccBook?.[MAIN]?.[0] || [];
  const commands = [SEO_DECISION, SALE_DECISION].map((c) => h.indexOf(c)).filter((i) => i >= 0);
  if (commands.length && ccBook[MAIN].slice(1).some((r) => commands.some((i) => mtText(r[i])))) return { ...fallback("у «Основному каталозі» є команди Catalog Controls — їх перевірку виконає GitHub"), metrics: metrics() };

  // 2. Операційний фід.
  let xml;
  try {
    const res = await counted(operationalUrl(env.SUPPLIER_FEED_URL, config.supplier), { redirect: "manual" });
    if (res.status !== 200) return { result: { state: "ABORTED", reason: "фід постачальника: HTTP " + res.status + " — нічого не записано" }, metrics: metrics() };
    xml = await res.text();
  } catch (e) { return { result: { state: "ABORTED", reason: "фід постачальника недоступний — нічого не записано" }, metrics: metrics() }; }
  if (xml.length > MAX_FEED_CHARS) return { result: { state: "ABORTED", reason: "фід постачальника завеликий — нічого не записано" }, metrics: metrics() };

  // 3. Лише план (перевірка без запису).
  if (dry) {
    const parsed = await parseSupplierText(xml, { maximumChars: config.supplier.maximumChars, identityFields: true });
    const confirmed = (await store.getJsonVersioned(CONFIRMED_SNAPSHOT_KEY))?.value || null;
    try { validateFeed(parsed, confirmed?.count ?? null, now, config.supplier); } catch (e) { return { result: { state: "ABORTED", reason: "фід не пройшов перевірку: " + mtText(e?.message || e) }, metrics: metrics() }; }
    const cc = syncControls(ccState);
    const values = await readColumns(MAIN, PRICE_READ_COLUMNS);
    const p = planPrices({ values, offers: parsed.offers, stamp, pricing: config.pricing, removed: cc?.removed || new Set(), anomaly: config.policy?.anomaly });
    return { result: { state: p.abort ? "ABORTED" : "PLANNED", reason: p.abort?.reason || "", stats: p.stats, feed: { offers: parsed.count }, cc: { blocked: cc?.blocked ?? null, removed: cc?.removed?.size ?? null } }, metrics: metrics() };
  }

  // 4. Запис через шлюз W2 (охоронець режиму prices; записувач знає ID живої таблиці й відмовляє в записі туди).
  const writer = deps.writer || new GoogleSheetsWriter({ spreadsheetId: TEST_SHEET_ID, liveSpreadsheetId: LIVE_SHEET_ID, getAccessToken, fetchImpl: counted, maxRequests: 12 });
  const headers = await reader.loadHeaders([MAIN, JOURNAL_SHEET]);
  const sheets = guardedSheets(writer, { spreadsheetId: TEST_SHEET_ID, policy: MODE_POLICIES.prices, headers: Object.fromEntries([MAIN, JOURNAL_SHEET].map((t) => [t, headers[t]?.[0] || []])) });
  const session = await new WriteGateway({ sheets, read: readBook, store, contract: ownershipFrom(ownershipJson) }).open({ writer: "sync" });
  try {
    if (session.state !== "READY") return { ...fallback("шлюз запису: " + session.state + " — потрібна звірка (GitHub)"), metrics: metrics() };
    // Стан CC для плану — уже прочитаний вище (кілька секунд тому); перед записом — свіжа звірка відбитка (verify).
    const ccOnce = { state: async () => ccState, verify: (fp) => controls.verify(fp) };
    const result = await updatePrices({ readBook, xml, stamp, now, config, controls: ccOnce, session, snapshotStore: store, readColumns });
    return { result, metrics: metrics() };
  } finally { await session.close?.().catch(() => {}); }
}
