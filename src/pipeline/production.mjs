/** Робоча композиція (CC R6 §6 п. 2, рішення власника 29.10: пріоритет власника — обов'язкова поведінка нової системи).
 *
 *  productionConfig — єдиний вхід робочих точок запуску (src/cli.mjs, tools/sheet-sync.mjs): режим пріоритету власника й обов'язковий
 *  Catalog Controls увімкнено завжди; явне вимкнення (ownerPriority.enabled === false) — відмова. Старий режим глобального паспорта
 *  лишається лише всередині бібліотеки для регресійних тестів прийнятої поведінки — робочі точки запуску його не досягають.
 *  Захист ідентичності (Offer ID / ID постачальника, FZ, дублікати) діє в обох режимах.
 *
 *  loadCatalogControls — адаптер CC з модуля CC (src/core/controls-plan.mjs, після злиття гілок). Модуля немає → null:
 *  споживачі трактують як blocked (YML не публікується, синхронізація / intake нічого не пишуть, відкат заборонено).
 *  CC R7 G1: у CC передається САМ об'єкт контракту (loadControlsContract().contract); problems → стан blocked (не «оцінка»).
 *  CC R7 G2: у робочому шляху CC має бути активований (state.active === true), інакше blocked — журнал без контрольної точки
 *  не вважається довіреним.
 *  runCatalogControls (CC R7 G3) — корінь запуску CC: readiness (committer / store шлюзу W2 + publisher cc-publisher-v2), integrity
 *  (M3), publication (активні версії фідів), той самий контракт; apply — лише якщо CC активовано й готовність підтверджено.
 *  w2Coordinator — W2: координатор записів. ENG-29 (переїзд на сервер, рішення власника 02.11): MM_W2_MODE=do — спільне сховище W2
 *  у Cloudflare Durable Object (MM_W2_URL + MM_W2_KEY), дозволено й у GitHub Actions. Однохостовий режим (MM_W2_MODE=single-host +
 *  постійний MM_SAFE_WRITE_DIR) — лише локально й лише поки сховище не перенесено в DO (позначка MOVED-TO-DO.json у каталозі → відмова:
 *  два координатори одночасно = дві черги записувачів). Інакше — відмова. */
import fs from "node:fs";
import path from "node:path";
import { catalogControlsAdapter, publicationFrom } from "./controls-adapter.mjs";
import { readServedVersions } from "../publish/publisher.mjs";
import { cardIntegrity } from "../core/owner-priority.mjs";
import { engineeringReadiness } from "./cc-publisher.mjs";
import { mtText } from "../core/text.mjs";
import { runArchiveMoves, markPublished } from "./archive-run.mjs";
import { supportsFencing } from "../publish/feed-fence.mjs";
import { declareRecovery } from "./recovery.mjs";

export function productionConfig(config) {
  if (config?.ownerPriority?.enabled === false) throw new Error("Старий режим глобального паспорта вимкнено рішенням власника 29.10: пріоритет власника (ownerPriority) обов'язковий");
  // ENG-17 (Hermes I07): перемикання маніфестів у робочому шляху — лише під орендою координатора W2 (w2.required).
  // ENG-28b (рішення власника 01.11): у робочих точках характеристики основного каталогу лише зберігаються («preserve»); перебудова за
  // схемою / з описів — окремий майбутній етап C, у робочому шляху недоступна (не перевизначається конфігом).
  return { ...config, ownerPriority: { ...(config?.ownerPriority || {}), enabled: true }, controls: { ...(config?.controls || {}), required: true }, w2: { ...(config?.w2 || {}), required: true },
    characteristics: { ...(config?.characteristics || {}), main: "preserve" } };
}

/** Аркуші, з яких CC будує стан (контрольна точка — у сховищі W2). */
export const CC_BOOK_SHEETS = Object.freeze(["Основний каталог", "Нові товари", "Відкладені товари", "Видалені товари", "Історія керування", "Стан керування"]);

/** Версії, які ФАКТИЧНО обслуговуються, всіх увімкнених фідів (publication CC R6 §3.1). ENG-17 (Hermes ENG15-P3 / I18): лише з повністю
 *  перевіреним вмістом (метадані + потік: кількість, idsSha, sha256); немає / пошкоджено / знято з обслуговування / не прочитано →
 *  null для цього фіду (publicationFrom → unknown, не DONE; markPublished — не «ЗАВЕРШЕНО»). */
export function activeXmlsOf(store, config) {
  return async () => (await Promise.all((config.feeds || []).filter((f) => f.enabled !== false).map(async (f) => (await readServedVersions(store, f.name).catch(() => null)) ?? [null]))).flat();
}

/** Модулі CC (після злиття гілок) або null. */
export async function loadCatalogControlsModules(importer = (p) => import(p)) {
  try {
    const plan = await importer(new URL("../core/controls-plan.mjs", import.meta.url).href);
    const common = await importer(new URL("../core/controls-common.mjs", import.meta.url).href);
    const run = await importer(new URL("./controls-run.mjs", import.meta.url).href).catch(() => null);
    if (typeof plan?.controlsState !== "function" || typeof plan?.verifyControlsSnapshot !== "function" || typeof common?.loadControlsContract !== "function") return null;
    return { plan, common, run };
  } catch { return null; }
}
/** G1: контракт — сам об'єкт; problems → null + причини. contractFile — лише для тестової копії / тестів (окремий активований контракт). */
export function resolveContract(common, { contract = undefined, contractFile = undefined } = {}) {
  const ct = contract !== undefined ? { contract, problems: typeof common.validateContract === "function" ? common.validateContract(contract) : [] } : common.loadControlsContract(contractFile);
  if (!ct?.contract || ct.problems?.length) return { contract: null, reasons: ["контракт Catalog Controls недійсний: " + ((ct?.problems || []).join("; ") || "не прочитано")] };
  return { contract: ct.contract, reasons: [] };
}
const blockedAdapter = (reasons) => ({
  state: async () => ({ blocked: true, reasons, held: new Set(), removed: new Set(), fingerprint: "" }),
  verify: async () => ({ ok: false, reasons }),
});

export async function loadCatalogControls({ loadBook, store, config, feedStore = null, importer = (p) => import(p), contract = undefined, contractFile = undefined }) {
  const mods = await loadCatalogControlsModules(importer);
  if (!mods) return null;
  const ct = resolveContract(mods.common, { contract, contractFile });
  if (!ct.contract) return blockedAdapter(ct.reasons); // A2: недійсний контракт → blocked, а не стан «оцінки»
  return catalogControlsAdapter({
    loadBook, store, contract: ct.contract,
    api: { controlsState: mods.plan.controlsState, verifyControlsSnapshot: mods.plan.verifyControlsSnapshot },
    activeXmls: feedStore ? activeXmlsOf(feedStore, config) : null,
    requireActive: true, // G2
  });
}

/** W2: координатор записів. Між машинами — спільне сховище в Durable Object (MM_W2_MODE=do); інакше — лише однохостовий режим за
 *  явного налаштування. */
export function w2Coordinator(env = process.env, { exists = (p) => fs.existsSync(p) } = {}) {
  if (env.MM_W2_MODE === "do") {
    if (!/^https:\/\//.test(env.MM_W2_URL || "")) throw new Error("W2: режим do без адреси сховища (MM_W2_URL, https://) — запис без оренди й журналу заборонено");
    if (String(env.MM_W2_KEY || "").length < 20) throw new Error("W2: режим do без ключа сховища (MM_W2_KEY) — запис без оренди й журналу заборонено");
    return { kind: "durable-object", url: env.MM_W2_URL, key: env.MM_W2_KEY };
  }
  if (env.GITHUB_ACTIONS === "true") throw new Error("W2: у GitHub Actions — лише спільне сховище Durable Object (MM_W2_MODE=do); однохостовий запис із GitHub Actions заборонено");
  if (env.MM_W2_MODE !== "single-host") throw new Error("W2: координатора записів між машинами немає — запис дозволено лише в явному однохостовому режимі (MM_W2_MODE=single-host)");
  if (!env.MM_SAFE_WRITE_DIR) throw new Error("W2: однохостовий режим без постійного сховища (MM_SAFE_WRITE_DIR) — запис без оренди й журналу заборонено");
  if (exists(path.join(env.MM_SAFE_WRITE_DIR, "MOVED-TO-DO.json"))) throw new Error("W2: сховище перенесено в Durable Object (MOVED-TO-DO.json) — однохостовий запис заборонено, лише MM_W2_MODE=do");
  return { kind: "single-host-file", dir: env.MM_SAFE_WRITE_DIR };
}

/**
 * Перенесення між «Основним каталогом» і «Видаленими товарами» — ЛИШЕ за дорученнями CC (moves), через шлюз запису W2
 * (оренда, журнал, fencing), з перевіркою відбитка CC перед видаленням; потім завершення видалень за АКТИВНИМИ версіями фідів
 * (markPublished: «ЗАВЕРШЕНО» — лише коли жодна активна версія не містить offer). CC недоступний / blocked → нічого не пишемо.
 */
export async function runArchiveStep({ readBook, gateway, controls, stamp, feedStore = null, config = {} }) {
  if (!controls || typeof controls.state !== "function" || typeof controls.verify !== "function") return { state: "BLOCKED_CC", reason: "Catalog Controls не підключено" };
  if (!gateway) return { state: "BLOCKED", reason: "перенесення без шлюзу запису (W2) заборонено" };
  let st;
  try { st = await controls.state(); } catch (e) { return { state: "BLOCKED_CC", reason: "стан Catalog Controls не прочитано: " + (e?.message || e) }; }
  if (!st || st.blocked !== false) return { state: "BLOCKED_CC", reason: (st?.reasons || []).join("; ") || "стан Catalog Controls недостовірний" };
  const cc = { ...st, verify: (fp) => controls.verify(fp), refresh: () => controls.state() };
  const session = await gateway.open({ writer: "sync" });
  try {
    const moves = await runArchiveMoves({ session, read: readBook, controls: cc, stamp });
    let published = null;
    if (feedStore && moves.state === "OK") published = await markPublished({ session, read: readBook, activeXmls: await activeXmlsOf(feedStore, config)().catch(() => null), controls: cc, stamp });
    return { state: moves.state === "OK" ? "ARCHIVED" : moves.state, moves, published };
  } finally { await session.close?.().catch(() => {}); }
}

/**
 * ENG-18 (Hermes ENG16-N1 / G3): конфіг для Catalog Controls. Ключі в config.controls, якими володіє Engineering (ENGINEERING_CONTROLS_KEYS:
 * required — допуск fail-closed у робочих точках), до CC НЕ передаються: CC приймає в config.controls лише погоджені ліміти й строго
 * відхиляє невідомі параметри. Будь-який інший ключ іде до CC як є — його строгу перевірку не вимкнено (невідомий / некоректний → ABORTED).
 */
export const ENGINEERING_CONTROLS_KEYS = Object.freeze(["required"]);
export function ccConfigOf(config) {
  const controls = Object.fromEntries(Object.entries(config?.controls || {}).filter(([k]) => !ENGINEERING_CONTROLS_KEYS.includes(k)));
  return { ...(config || {}), controls };
}

const offerIdsOf = (values) => {
  if (!Array.isArray(values) || !values.length) return [];
  const k = (values[0] || []).map(mtText).indexOf("Offer ID");
  return k < 0 ? [] : values.slice(1).map((r) => mtText(r?.[k])).filter(Boolean);
};
/**
 * G3: запуск Catalog Controls (команди власника: зняти / повернути / видалити / SEO). mode — "shadow" (типово) або "apply".
 * sheets / readBook — тестова копія; gateway — WriteGateway над сховищем W2 (оренда, fencing, cc-committer / cc-store);
 * feedStore — сховище фідів (publication). Повертає результат runControls CC або BLOCKED.
 */
export async function runCatalogControls({ sheets, readBook, gateway, config, stamp, mode = "shadow", feedStore = null, parsed = null, catalog = null, importer = (p) => import(p), contract = undefined, contractFile = undefined, protection = undefined }) {
  const mods = await loadCatalogControlsModules(importer);
  if (!mods?.run || typeof mods.run.runControls !== "function") return { state: "BLOCKED", reason: "модуль Catalog Controls відсутній (до злиття гілок)" };
  const ct = resolveContract(mods.common, { contract, contractFile });
  if (!ct.contract) return { state: "BLOCKED", reason: ct.reasons.join("; ") };
  if ((mode === "apply" || mode === "recover") && !gateway) return { state: "BLOCKED", reason: mode + " без шлюзу запису (W2) заборонено" };
  // ENG-20 (рішення власника 30.10, протокол A): у робочому режимі (w2.required) стан CC фіксується лише після того, як обслуговування
  // фідів безпечне щодо НОВОГО стану. Без сховища фідів з умовним записом (fencing, B) — обмеження не фіксуються взагалі.
  // Неактивований контракт (G2) — рішення за CC (NOT_ACTIVATED, нічого не пишеться); активований без сховища фідів — BLOCKED.
  // ENG-24: recover (cc-recovery-v1, C5) — так само лише в протоколі A.
  const protocolA = (mode === "apply" || mode === "recover") && config?.w2?.required === true;
  if (mode === "recover" && !protocolA) return { state: "BLOCKED", reason: "recover Catalog Controls — лише через протокол A (робочий конфіг w2.required)" };
  // ENG-23 (рішення власника Q4): apply активованого CC — лише через протокол A (cc-serving-v2); інший шлях точки не пише (E3 / E4).
  if (mode === "apply" && !protocolA && ct.contract.activated === true) return { state: "BLOCKED", reason: "apply Catalog Controls — лише через протокол A (робочий конфіг w2.required, cc-serving-v2); інших шляхів запису контрольної точки немає" };
  if (protocolA && ct.contract.activated === true && (!feedStore || !supportsFencing(feedStore))) return { state: "BLOCKED", reason: "протокол A: без сховища фідів з умовним записом (fencing) стан Catalog Controls не фіксується — спершу безпечне обслуговування" };
  // publication — для ID каталогу й архіву (стадія DONE); активні версії не прочитано → "unknown" (не доказ).
  let publication = null;
  if (feedStore) {
    const book = await readBook(["Основний каталог", "Видалені товари"]);
    publication = publicationFrom(await activeXmlsOf(feedStore, config)().catch(() => null), [...offerIdsOf(book["Основний каталог"]), ...offerIdsOf(book["Видалені товари"])]);
  }
  // Захист для видалення (FZ, перелік захищених MM_FREEZE_IDS, OV MM_OWNER_VALUES): робочий шлях — loadProtection CC; недійсний →
  // CC відмовляє лише командам видалення (fail-closed). protection — лише явна підміна (тести).
  const prot = protection !== undefined ? protection : typeof mods.run.loadProtection === "function" ? mods.run.loadProtection(catalog ? { catalog } : {}) : null;
  const readiness = gateway ? (protocolA ? gateway.ccProtocolA({ feedStore, config, loadBook: () => readBook(CC_BOOK_SHEETS), contract: ct.contract, mods, activeXmlsOf, base: engineeringReadiness(gateway, { config }) }) : engineeringReadiness(gateway, { config })) : null;
  const result = await mods.run.runControls({
    sheets, readBook, stamp, config: ccConfigOf(config), contract: ct.contract, protection: prot, parsed, mode,
    // ENG-21: у протоколі A CC отримує сховище ЛИШЕ через обгортку readiness (сире сховище W2 не передається — запис точки повз A неможливий).
    store: protocolA ? null : gateway?.store ?? null, readiness,
    integrity: cardIntegrity, publication,
  });
  // ENG-24 (R7.3 Q2, погодження Engineering): детектор журналу CC («Історія керування» має рядки без прив'язки до точки) — тригер
  // системного declareRecovery: стан відновлення в дзеркалі → CC (status), публікація й відкат (E7) заблоковані; обслуговування —
  // одразу перевірене щодо найсуворішого стану або знято (оренда протоколу A → status → secureDuringRecovery).
  if (protocolA && result?.state === "RECOVERY_PENDING" && result.detector === "journal" && feedStore) {
    try {
      const rec = await declareRecovery({ feedStore, type: "JOURNAL", reason: result.reason || "детектор журналу CC", declaredBy: "cc-journal-detector", now: gateway.now });
      // ENG-25 (e4): у звіті — ФАКТИЧНИЙ режим обслуговування (status протоколу A: STRICT / WITHDRAWN / NOT_SECURED), не «видано оренду».
      let secured = "NOT_ATTEMPTED";
      try {
        const l = await readiness.committer.acquire("catalog-controls");
        try { secured = (await readiness.serving.status({ lease: l }))?.serving || "NOT_SECURED"; } finally { await l.release().catch(() => {}); }
      } catch (e) { secured = "LEASE_UNAVAILABLE: " + String(e?.message || e).slice(0, 160); }
      return { ...result, declared: { state: rec?.state, type: rec?.type, id: rec?.id, serving: secured } };
    } catch (e) { return { ...result, declared: { error: String(e?.message || e).slice(0, 300) } }; }
  }
  return result;
}

/**
 * ENG-20 — протокол A («спершу обслуговування»; рішення власника 30.10). ENG-23: реалізація — src/pipeline/cc-serving.mjs
 * (cc-serving-v2: межа епох, fencing фідів, виявлення відновлення, квитки beforeCommit, head W2 і дзеркало реєстру), збирається через
 * WriteGateway.ccProtocolA (лише шлюз має стіл квитків сховища W2).
 */
