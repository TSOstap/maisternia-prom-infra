/** Один цикл оновлення (те, що зараз робить mtUpdate + mtAfterUpdate_), у shadow-режимі:
 *  результат пишеться лише в окреме сховище нової системи, робоча таблиця не змінюється.
 *
 *  1. Фід постачальника: потоковий розбір і перевірка повноти/свіжості.
 *  2. Знімок каталогу: аркуші синхронізації, дублікати ID між аркушами — зупинка.
 *  3. План F:M для всіх рядків; ЄДИНИЙ запис state/operational.json (комміт синхронізації).
 *  4. Кожен фід окремо: формування → незалежна перевірка → публікація. Збій фіду не скасовує синхронізацію
 *     і не зачіпає інші фіди; Prom продовжує отримувати попередню перевірену версію.
 *  5. Нові товари постачальника — лише звіт.
 *  6. Звіт запуску та лічильники використання (контроль безплатних квот). */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitize, mtText } from "../core/text.mjs";
import { parseSupplierFeed, validateFeed } from "../core/supplier-feed.mjs";
import { LIVE_COLUMNS, MATCH, changeEntries, planRows, readSheet } from "../core/sync-plan.mjs";
import { buildYml, objectsFromValues, offersById, patchFeedUnavailable, patchFeedRemove, availableForbidden, controlsInput, controlsViolations } from "../core/yml.mjs";
import { GROUP_HEADERS, YML_HEADERS, idsSha } from "../core/seal.mjs";
import crypto from "node:crypto";
import { detectNewProducts, duplicateReport } from "../core/catalog-guards.mjs";
import { publishFeed, readActiveXml, rollbackFeed, withdrawFeed, servedChain, servedNames, invalidateFallback, readVerifiedXml, manifestKey } from "../publish/publisher.mjs";
import { fenceFeeds, supportsFencing, compensationStore, OPERATIONAL_KEY } from "../publish/feed-fence.mjs";
import { readRecovery, recoveryActive } from "./recovery.mjs";

/** ENG-24 (E7, cc-recovery-v1 крок 2): стан відновлення Catalog Controls (дзеркало реєстру у сховищі фідів). Помилка читання — як
 *  активне відновлення (fail-closed). → { active, recovery } */
async function recoveryOf(store) {
  if (typeof store?.getJsonEtag !== "function" && typeof store?.fenceBase?.getJsonEtag !== "function") return { active: false, recovery: null };
  try { const { recovery } = await readRecovery(store); return { active: recoveryActive(recovery), recovery }; }
  catch (e) { return { active: true, recovery: { state: "RECOVERY_PENDING", type: "UNKNOWN", reason: "стан відновлення не прочитано: " + sanitize(e) } }; }
}
const recoveryReason = (r) => `відновлення Catalog Controls (${r?.state || "RECOVERY_PENDING"}${r?.type ? ", " + r.type : ""}${r?.id ? ", id " + r.id : ""}) — публікації й відкати заборонено до завершення погодженої власником процедури`;
import { ARCHIVE_SHEET, archiveIds } from "../core/archive.mjs";
import { applyAvailabilityPolicy, planView, resolveIdentity } from "../core/d1.mjs";
import { enabled as ownerPriorityEnabled } from "../core/owner-priority.mjs";

const SYNC_KEY = "state/sync.json";
const SEEN_KEY = "state/supplier-seen.json";
const LINKS_KEY = "state/links.json";
const OWN_STOCK_KEY = "state/own-stock.json";

function fileSink(file) {
  const out = fs.createWriteStream(file, { encoding: "utf8" });
  return {
    write(text) { return out.write(text) ? undefined : new Promise((r) => out.once("drain", r)); },
    close() { return new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve()))); },
    destroy() { out.destroy(); },
  };
}

function timer() {
  const start = Date.now();
  let last = start;
  const ms = {};
  return { lap(stage) { const now = Date.now(); ms[stage] = now - last; last = now; }, ms, total: () => Date.now() - start };
}

/** Поточні операційні значення: зі стану нової системи (shadow), інакше — зі знімка таблиці. */
function overlayOperational(rows, operational) {
  if (!operational?.rows) return rows;
  return rows.map((r) => {
    const saved = operational.rows[mtText(r["Offer ID"])];
    if (!saved) return r;
    const copy = { ...r };
    LIVE_COLUMNS.forEach((k, i) => { copy[k] = saved[i]; });
    return copy;
  });
}

/** S6 / S7 (ENG-10, CC R4 §6): стан Catalog Controls для цього запуску.
 *  ctx.controls — адаптер композиції: { state(): { held, removed, blocked, reasons, fingerprint },
 *  verify(fingerprint): { ok, reasons } } (у композиції — controlsState / verifyControlsSnapshot CC з того самого сховища W2).
 *  Немає адаптера, а config.controls.required — blocked (fail-closed). Помилка читання стану — blocked. */
async function controlsFor(ctx, config) {
  // CC R5: у режимі пріоритету власника CC обов'язковий (рішення CC авторитетне); без адаптера — blocked, не псевдостан з архіву.
  const required = config.controls?.required || ownerPriorityEnabled(config);
  if (!ctx.controls) return required ? { blocked: true, reasons: ["Catalog Controls не підключено (обов'язковий у режимі пріоритету власника)"], held: [], removed: [] } : null;
  if (typeof ctx.controls.verify !== "function") return { blocked: true, reasons: ["адаптер Catalog Controls без verify — перевірка перед публікацією неможлива"], held: [], removed: [] };
  try {
    const s = await ctx.controls.state();
    return s && typeof s === "object" ? s : { blocked: true, reasons: ["стан Catalog Controls порожній"], held: [], removed: [] };
  } catch (e) { return { blocked: true, reasons: ["стан Catalog Controls не прочитано: " + sanitize(e)], held: [], removed: [] }; }
}
const setOf = (v) => new Set(v instanceof Map ? v.keys() : [...(v || [])].map(String));

/** ENG-17 (Hermes ENG15-P2 / I07): перемикання маніфестів і відкат — під орендою координатора W2 на ТОМУ САМОМУ ресурсі, що й запуск CC
 *  та синхронізація (committer зводить області до одного ресурсу): CC не може зафіксувати видалення між перевіркою й перемиканням.
 *  Сховище фідів не підтримує fenced PUT, тож межа = оренда + assertCurrent перед і після перемикання; втрата оренди після
 *  перемикання → захисна перевірка обслуговуваної версії на свіжий стан CC (і зняття з обслуговування, якщо безпечність не доведено). */
export const PUBLISH_SCOPE = "publisher";
const leaseOk = async (lease) => { if (lease) await lease.assertCurrent(); };
/** Активна версія з ПЕРЕВІРЕНИМ вмістом (метадані + повний потік) або null. */
async function readVerifiedActive(store, feed) {
  const m = await store.getJson(manifestKey(feed)).catch(() => null);
  if (!m?.active) return null;
  const xml = await readVerifiedXml(store, m.active);
  return xml === null ? null : { entry: m.active, xml };
}
const withdrawSafe = (store, feed, reason) => withdrawFeed(store, feed, reason).catch((e) => ({ withdrawn: false, error: sanitize(e) }));

/**
 * ENG-17 (Hermes ENG15-P1, I15–I17): безпечність версії, яку ФАКТИЧНО віддає Worker (servedChain: той самий алгоритм, обидва кодування),
 * на поточний стан CC. Запасна (previous) з порушенням або неперевіреним вмістом → більше не запасна. Обслуговувана версія з
 * порушенням або неперевіреним вмістом → зняти з обслуговування (Worker 503). activeSafety: VERIFIED | NOT_SERVED | UNSAFE.
 */
export async function secureServed({ store, feed, controls, reason = "" }) {
  const guard = candidateGuard(controls);
  const problem = (l) => { if (!l) return null; if (l.xml === null) return "вміст версії не проходить перевірку цілісності"; try { guard(l.xml); return null; } catch (e) { return sanitize(e); } };
  const out = {};
  let ch = await servedChain(store, feed);
  if (ch.manifest?.previousFallbackSafe === true) {
    const p = problem(ch.links.previous);
    if (p) { await invalidateFallback(store, feed, p); out.fallbackInvalidated = p; ch = await servedChain(store, feed); }
  }
  const names = servedNames(ch); // ENG-22 (F01): разом з версіями, чий HEAD невідомий (можуть обслуговуватися)
  out.served = names;
  if (!names.length) return { ...out, activeSafety: "NOT_SERVED" };
  const bad = names.map((n) => problem(ch.links[n])).filter(Boolean);
  if (!bad.length) return { ...out, activeSafety: "VERIFIED" };
  out.violation = bad[0];
  out.withdraw = await withdrawSafe(store, feed, (reason || "обслуговувана версія суперечить стану Catalog Controls: ") + bad[0]);
  return { ...out, activeSafety: "UNSAFE" };
}

/** CC R6 §6.4 (правило 8): перевірка будь-якого YML-кандидата на стан CC — видалений → жодного offer, знятий → не available="true".
 *  Той самий критерій, що CC feedViolations для видалених (паритет підтверджено пробою CC R6). Виняток → не публікувати. */
export function candidateGuard(controls) {
  const cc = controlsInput(controls);
  return (xml) => {
    if (!cc || cc.blocked) throw new Error("кандидат YML: стан Catalog Controls blocked або невідомий — публікацію заборонено");
    if (typeof xml !== "string") throw new Error("кандидат YML: текст не прочитано — перевірку не виконано");
    const bad = controlsViolations(xml, cc);
    if (bad.length) throw new Error(`кандидат YML суперечить стану Catalog Controls (${bad.length}: ${bad.slice(0, 5).map((x) => x.id + " — " + x.why).join(", ")})`);
  };
}
/** Параметри формування фіду — ОДНІ для робочого запуску (runUpdate) і перевірки готовності CC (renderProbe, cc-publisher.mjs). */
export function feedBuildOptions({ config, feed, controls, lastGood, ownerPriority }) {
  return { pricing: config.pricing, maximumBytes: feed.maximumBytes, missingPolicy: config.policy?.missing || "block", conflictPolicy: config.policy?.conflict || "block",
    config: config.yml, controls, lastGood, isolateRows: ownerPriority, ownerPriority };
}

/** CC R6 §6 п. 1 (правило 8): ручний відкат — лише зі свіжим достовірним станом CC. controls — адаптер { state(), verify(fp) }.
 *  Без адаптера / blocked / порушення в цільовій версії / зміна стану до перемикання → відмова, маніфест не змінюється.
 *  ENG-17 (Hermes ENG15-P2): увесь цикл «стан CC → перевірка цілі → verify → перемикання» — під орендою координатора W2 (coordinator:
 *  { acquire(scope) → { assertCurrent, release } }, той самий ресурс, що й запуск CC). Без координатора / зайнято — відмова. */
export async function guardedRollback({ store, feed, toKey, controls, coordinator = null }) {
  if (!controls || typeof controls.state !== "function" || typeof controls.verify !== "function") throw new Error("Відкат заборонено: Catalog Controls не підключено (правило 8)");
  if (!coordinator || typeof coordinator.acquire !== "function") throw new Error("Відкат заборонено: без координатора W2 (спільна оренда з Catalog Controls) видалення може статися між перевіркою й перемиканням");
  // ENG-24 (E7): під час відновлення CC — жодних відкатів.
  { const rv = await recoveryOf(store); if (rv.active) throw Object.assign(new Error("Відкат заборонено: " + recoveryReason(rv.recovery)), { code: "RECOVERY_PENDING" }); }
  let lease;
  try { lease = await coordinator.acquire(PUBLISH_SCOPE); } catch (e) { throw new Error("Відкат заборонено: оренду W2 не отримано (інший записувач — CC / синхронізація): " + sanitize(e)); }
  const raw = store;
  try {
    // ENG-20 (B): епоха fencing — маніфест пишеться лише умовно з ETag після власного підвищення епохи.
    // ENG-22 (Hermes ENG-21 F07): fencing ОБОВ'ЯЗКОВИЙ — сховище без атомарного умовного запису (оголошення + функціональна проба)
    // → відмова (BLOCK), а не перемикання безумовним PUT.
    try { store = await fenceFeeds({ store: raw, feeds: [feed], lease, scope: PUBLISH_SCOPE }); }
    catch (e) { throw new Error("Відкат заборонено: fencing маніфесту не виконано" + (e?.code === "NO_CAS" ? " — сховище фідів без атомарного умовного запису (CAS), BLOCK" : "") + ": " + sanitize(e)); }
    const st = await controls.state();
    if (!st || st.blocked !== false) throw new Error("Відкат заборонено: стан Catalog Controls недостовірний: " + (st?.reasons || []).join("; "));
    const guard = candidateGuard(st);
    const res = await rollbackFeed(store, feed, {
      toKey,
      violations: (xml) => { try { guard(xml); return []; } catch (e) { return [{ id: "*", why: e.message }]; } },
      verify: async () => {
        await leaseOk(lease);
        const v = await controls.verify(st.fingerprint);
        if (!v?.ok) throw new Error("Відкат заборонено: стан Catalog Controls змінився: " + (v?.reasons || []).join("; "));
        await leaseOk(lease);
      },
    });
    try { await leaseOk(lease); } catch (e) {
      // Оренду втрачено вже після перемикання — інший записувач міг діяти: обслуговувана версія перевіряється на свіжий стан CC.
      // ENG-20 (B): якщо новий власник уже підвищив епоху, наші записи відхиляються сховищем (STALE_FENCE) — безпеку забезпечує він (A).
      const fresh = await controls.state().catch(() => null), comp = compensationStore(store);
      if (!fresh || fresh.blocked !== false) await withdrawSafe(comp, feed, "відкат: оренду W2 втрачено, стан Catalog Controls невідомий");
      else await secureServed({ store: comp, feed, controls: fresh, reason: "відкат: оренду W2 втрачено — " }).catch(() => {});
      throw new Error("Відкат: оренду W2 втрачено під час перемикання — виконано захисну перевірку обслуговуваної версії: " + sanitize(e));
    }
    return res;
  } finally { await lease.release().catch(() => {}); }
}

/** Аварійний патч S7: новий фід не сформовано, а активна версія суперечить стану CC — публікуємо активну версію, де видалені
 *  offer прибрано повністю, а зняті — примусово недоступні (решта — байт-у-байт). Захист від старого фіду. */
async function publishHoldPatch({ store, feed, controls, ctx, config, tmpDir, now, lease = null }) {
  const removed = setOf(controls.removed), held = new Set([...setOf(controls.held)].filter((id) => !removed.has(id)));
  // ENG-17: патч лише з ПЕРЕВІРЕНОГО вмісту активної версії (пошкоджений вміст не «латається» в нову валідну версію).
  const active = await readVerifiedActive(store, feed.name);
  if (!active || (!held.size && !removed.size)) return { needed: false };
  const ids0 = new Set(offersById(active.xml).keys());
  const toRemove = [...removed].filter((id) => ids0.has(id)), toHold = availableForbidden(active.xml, held);
  if (!toRemove.length && !toHold.length) return { needed: false };
  const r1 = patchFeedRemove(active.xml, new Set(toRemove));
  const { xml, patched: patchedHeld } = patchFeedUnavailable(r1.xml, new Set(toHold));
  const patched = [...r1.removed, ...patchedHeld];
  const bad = patched;
  const ids = [...offersById(xml).keys()];
  const file = path.join(tmpDir, `feed-${feed.name}-holdpatch-${process.pid}-${Date.now()}.xml`);
  await fsp.writeFile(file, xml, "utf8");
  try {
    const built = {
      generatedAt: new Date(now).toISOString(), sha256: crypto.createHash("sha256").update(xml, "utf8").digest("hex"), bytes: Buffer.byteLength(xml, "utf8"),
      count: ids.length, idsSha: idsSha(ids), contentSha: active.entry.contentSha, sourceSuccess: active.entry.sourceSuccess, ccFingerprint: String(controls.fingerprint || ""),
      sourceDigest: crypto.createHash("sha256").update("hold-patch:" + active.entry.sourceDigest + ":" + String(controls.fingerprint || "") + ":" + bad.sort().join(",")).digest("hex"),
    };
    const published = await publishFeed(store, feed.name, file, built, {
      retain: config.publish.retainVersions, readback: config.publish.readback, gzip: Boolean(feed.gzip),
      checkCandidate: candidateGuard(controls),
      assertSourceUnchanged: async () => {
        await leaseOk(lease);
        if (ctx.controls?.verify) { const v = await ctx.controls.verify(built.ccFingerprint); if (!v?.ok) throw new Error("стан Catalog Controls змінився до перемикання: " + (v?.reasons || []).join("; ")); }
        await leaseOk(lease);
      },
    });
    return { needed: true, published: !published.reused, patched, removed: r1.removed, held: patchedHeld };
  } finally { await fsp.unlink(file).catch(() => {}); }
}

/** Hermes E7 / правило 8: захист активних версій, коли новий фід не сформовано (ранній вихід runUpdate).
 *  Стан CC достовірний → аварійний патч (видалені — без offer, зняті — недоступні); активна версія перевіряється candidateGuard.
 *  Патч неможливий, а версія небезпечна → зняти з обслуговування (withdrawFeed → Worker 503). Стан CC недостовірний →
 *  BLOCKED_CC, безпечність активної версії НЕ підтверджено (не успіх). Без CC (явний старий режим) — нічого. */
async function protectActiveFeeds({ store, ctx, config, tmpDir, now, stamp, controls: given = undefined }) {
  const controls = given !== undefined ? given : await controlsFor(ctx, config);
  if (!controls) return [];
  const feeds = config.feeds.filter((f) => f.enabled !== false);
  const { lease, problem, store: fstore } = await acquirePublishLease(ctx, config);
  if (problem) return feeds.map((f) => ({ feed: f.name, state: "BLOCKED_W2", activeSafety: "UNVERIFIED", reason: problem }));
  store = fstore;
  const out = [];
  const rv = await recoveryOf(store);
  try {
    for (const feed of feeds) {
      // ENG-24 (E7): під час відновлення — без аварійного патча (це публікація); лише перевірка й зняття небезпечного (зменшення).
      if (rv.active) { out.push({ feed: feed.name, state: "RECOVERY_PENDING", reason: recoveryReason(rv.recovery), ...(controls.blocked ? { activeSafety: "UNVERIFIED", withdraw: await withdrawSafe(store, feed.name, recoveryReason(rv.recovery)) } : await secureServed({ store, feed: feed.name, controls, reason: recoveryReason(rv.recovery) + ": " })) }); continue; }
      const r = { feed: feed.name, state: "STALE_ACTIVE" };
      // ENG-17 (Hermes ENG15-P1a / I17): стан CC недостовірний — безпечність версії неможливо довести → не обслуговувати (503).
      if (controls.blocked) { Object.assign(r, { state: "BLOCKED_CC", activeSafety: "UNVERIFIED", reasons: controls.reasons || [], withdraw: await withdrawSafe(store, feed.name, "стан Catalog Controls недостовірний — безпечність версії неможливо довести: " + (controls.reasons || []).join("; ")) }); out.push(r); continue; }
      Object.assign(r, await secureFeed({ store, feed, controls, ctx, config, tmpDir, now, stamp, lease }));
      if (r.activeSafety === "UNSAFE") r.state = "WITHDRAWN";
      out.push(r);
    }
  } finally { await lease?.release().catch(() => {}); }
  return out;
}
/** Оренда W2 для перемикань маніфестів. Немає координатора в робочому режимі (config.w2.required) / зайнято — problem.
 *  ENG-20 (B): fence — одразу після оренди підвищити епоху fencing у маніфестах усіх увімкнених фідів; store — сховище, що пише
 *  маніфести лише умовно (ETag після власного fencing). Робочий режим без умовного запису у сховищі фідів → problem (fail-closed). */
async function acquirePublishLease(ctx, config, { fence = true } = {}) {
  if (!ctx.coordinator) return config.w2?.required ? { lease: null, problem: "немає координатора W2 — перемикання маніфестів заборонене", store: ctx.store } : { lease: null, problem: null, store: ctx.store };
  let lease;
  try { lease = await ctx.coordinator.acquire(PUBLISH_SCOPE); }
  catch (e) { return { lease: null, problem: "оренду W2 не отримано (інший записувач — CC / синхронізація): " + sanitize(e), store: ctx.store }; }
  if (!fence || (!config.w2?.required && !supportsFencing(ctx.store))) return { lease, problem: null, store: ctx.store };
  try { return { lease, problem: null, store: await fenceFeeds({ store: ctx.store, feeds: config.feeds.filter((f) => f.enabled !== false).map((f) => f.name), lease, scope: PUBLISH_SCOPE }) }; }
  catch (e) { await lease.release().catch(() => {}); return { lease: null, problem: "fencing маніфестів не виконано: " + sanitize(e), store: ctx.store }; }
}
/** ENG-18 (Hermes ENG17-P4 late delete): комміт синхронізації — під тією ж орендою W2, що й запуск CC; під орендою стан CC, на якому
 *  побудовано план (controls0), перевіряється verify. Змінився (напр. нове видалення між першим читанням і коммітом) / оренда
 *  зайнята → операційний стан НЕ записується (повтор наступним запуском зі свіжим станом). Без адаптера CC (явний старий режим) — як було.
 *  ENG-22 (Hermes ENG-21 F03): спільний захист від гонки «перевірка стану CC → запис»: оренда з fencing (епоха операційного стану
 *  підвищується при кожному отриманні оренди, зокрема запуском CC — протокол A), а сам запис — лише умовний з ETag після власного
 *  fencing. CC, що перехопив оренду після verify і зафіксував обмеження, змінив ETag → запізнілий запис відхиляється сховищем атомарно
 *  (STALE_FENCE → W2_STALE), ціна видаленого товару не оновлюється. */
async function commitOperational({ store, ctx, config, controls0, operational }) {
  if (!controls0 || !ctx.controls) { await store.putJson(OPERATIONAL_KEY, operational); return; }
  const { lease, problem, store: fstore } = await acquirePublishLease(ctx, config);
  if (problem) throw Object.assign(new Error("комміт синхронізації: " + problem), { code: "W2_BUSY" });
  try {
    const v = await Promise.resolve(ctx.controls.verify(controls0.fingerprint)).catch((e) => ({ ok: false, reasons: [sanitize(e)] }));
    if (!v?.ok) throw Object.assign(new Error("стан Catalog Controls змінився під час синхронізації — операційний стан не записано: " + (v?.reasons || []).join("; ")), { code: "CC_CHANGED" });
    await leaseOk(lease);
    try { await fstore.putJson(OPERATIONAL_KEY, operational); }
    catch (e) {
      if (e?.code === "STALE_FENCE") throw Object.assign(new Error("комміт синхронізації: оренду W2 перехоплено (епоху операційного стану підвищено) — операційний стан не записано: " + sanitize(e)), { code: "W2_STALE" });
      throw e;
    }
  } finally { await lease?.release().catch(() => {}); }
}
/** ENG-20 (A): що Worker ФАКТИЧНО може віддати (active / previous за прапорцями, обидва кодування) — безпечно щодо стану controls?
 *  Обслуговувана версія з порушенням або неперевіреним вмістом, запасна previousFallbackSafe:true з порушенням → небезпечно. */
export async function servedSafety(store, feed, controls) {
  const guard = candidateGuard(controls);
  const check = (l) => { if (!l) return null; if (l.xml === null) return "вміст версії не перевірено"; try { guard(l.xml); return null; } catch (e) { return sanitize(e); } };
  const ch = await servedChain(store, feed);
  const served = servedNames(ch); // ENG-22 (F01): невідомий HEAD → може обслуговуватися
  const problems = served.map((n) => check(ch.links[n])).filter(Boolean).map((p) => "обслуговується: " + p);
  if (ch.manifest?.previousFallbackSafe === true && !ch.manifest?.withdrawn) { const p = check(ch.links.previous); if (p) problems.push("запасна: " + p); }
  return { safe: problems.length === 0, served, problems };
}
/** ENG-20 (A): зробити обслуговування всіх увімкнених фідів безпечним щодо стану controls (напр. стану CC для нової контрольної
 *  точки) — під орендою lease, через сховище store (з fencing). Аварійний патч → інакше зняття з обслуговування (secureFeed).
 *  ok — лише якщо ПІСЛЯ дій кожен фід безпечний (servedSafety). adapter — { state, verify } для перевірки під час патча. */
export async function secureServingAgainst({ store, controls, adapter, config, lease = null, now = Date.now(), tmpDir = os.tmpdir() }) {
  const stamp = new Date(now).toISOString(), out = [];
  let ok = true;
  for (const feed of config.feeds.filter((f) => f.enabled !== false)) {
    const pre = await servedSafety(store, feed.name, controls);
    if (pre.safe) { out.push({ feed: feed.name, action: "NONE", served: pre.served }); continue; }
    let r;
    try { r = await secureFeed({ store, feed, controls, ctx: { controls: adapter, config }, config, tmpDir, now, stamp, lease }); }
    catch (e) { r = { error: sanitize(e) }; }
    const post = await servedSafety(store, feed.name, controls).catch((e) => ({ safe: false, problems: [sanitize(e)] }));
    if (!post.safe) ok = false;
    out.push({ feed: feed.name, action: r.holdPatch?.published ? "PATCHED" : r.withdraw?.withdrawn ? "WITHDRAWN" : r.error ? "FAILED" : "CHECKED", before: pre.problems, after: post.problems, served: post.served, ...(r.error ? { error: r.error } : {}), ...(r.holdPatch?.error ? { holdPatchError: r.holdPatch.error } : {}) });
  }
  return { ok, feeds: out };
}
/** Новий фід не сформовано: аварійний патч активної версії → перевірка candidateGuard → небезпечна й невиправна — зняти з обслуговування. */
async function secureFeed({ store, feed, controls, ctx, config, tmpDir, now, stamp, lease = null }) {
  const r = {};
  let cc = controls;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { r.holdPatch = await publishHoldPatch({ store, feed, controls: cc, ctx, config, tmpDir, now, lease }); break; }
    catch (e) {
      r.holdPatch = { needed: true, error: sanitize(e), attempts: attempt };
      // Стан CC змінився під час патча — одна повторна спроба зі свіжим станом (blocked → без повтору).
      const fresh = attempt === 1 ? await controlsFor(ctx, config) : null;
      if (!fresh || fresh.blocked) break;
      cc = fresh;
    }
  }
  controls = cc;
  // ENG-17 (Hermes ENG15-P1b): перевіряється версія, яку ФАКТИЧНО віддає Worker (active або запасна previous), а не лише active.
  Object.assign(r, await secureServed({ store, feed: feed.name, controls, reason: "обслуговувана версія суперечить стану Catalog Controls, патч неможливий" + (r.holdPatch?.error ? " (" + r.holdPatch.error + ")" : "") + ": " }));
  if (r.activeSafety === "UNSAFE") await store.putJson(`state/feed-${feed.name}-error.json`, { at: stamp, error: "WITHDRAWN: " + (r.violation || "") }).catch(() => {});
  return r;
}

/**
 * @param ctx { store, catalog, supplier, config, now?: () => ms, tmpDir?, manifests?: { feed: manifest }, controls? }
 */
export async function runUpdate(ctx) {
  const { store, catalog, supplier, config } = ctx;
  const now = ctx.now ? ctx.now() : Date.now();
  const stamp = new Date(now).toISOString();
  const t = timer();
  const report = { kind: "RUN_REPORT_V1", startedAt: stamp, mode: "SHADOW", sync: null, feeds: [], newProducts: null, warnings: [] };
  const syncState = (await store.getJson(SYNC_KEY)) || {};
  // ENG-17 (Hermes ENG15-P4 / I13): стан CC — ДО операційної синхронізації: видалений (будь-яка стадія) не оновлюється в жодному шляху.
  const ownerPriority = ownerPriorityEnabled(config);
  const controls0 = await controlsFor(ctx, config);

  // ---------- синхронізація цін і наявності ----------
  let rowsBySheet;
  let operational;
  let archive = null; // «Видалені товари»: ID архіву — заборона продажу незалежно від стану CC
  try {
    // Робочий режим: без достовірного стану CC видалені неможливо відрізнити — операційний стан не оновлюється (fail-closed).
    if (ownerPriority && controls0?.blocked) throw Object.assign(new Error("стан Catalog Controls недостовірний: " + (controls0.reasons || []).join("; ")), { code: "CC_BLOCKED" });
    const parsed = await parseSupplierFeed(supplier.chunks(), { maximumChars: config.supplier.maximumChars, identityFields: true });
    validateFeed(parsed, syncState.lastFeedCount, now, config.supplier);
    t.lap("постачальник");

    const snapshot = await catalog.load([...config.catalog.knownSheets, ...(config.catalog.knownIdSheets || [])]);
    const previous = await store.getJson(OPERATIONAL_KEY);
    if (snapshot.sheets[ARCHIVE_SHEET]?.length) archive = archiveIds(snapshot.sheets[ARCHIVE_SHEET]);
    // Видалені для синхронізації: tombstone CC (будь-яка стадія) + рядки архіву (лише захисний напрям).
    const removedSync = new Set([...setOf(controls0?.removed), ...(archive?.all || [])]);
    t.lap("каталог");

    const allIds = new Set();
    rowsBySheet = {};
    const plans = {};
    const sheetRows = {};
    for (const name of config.catalog.syncSheets) {
      const values = snapshot.sheets[name];
      if (!values) throw new Error("Немає аркуша " + name);
      const view = readSheet(values, name);
      if (name === config.catalog.requiredNonEmptySheet && !view.rows.length) throw new Error("Основний каталог порожній");
      for (const r of view.rows) {
        if (allIds.has(r["Offer ID"])) throw new Error("ID є в обох аркушах");
        allIds.add(r["Offer ID"]);
      }
      sheetRows[name] = overlayOperational(view.rows, previous);
    }
    const otherRows = config.catalog.knownSheets.filter((n) => !config.catalog.syncSheets.includes(n) && snapshot.sheets[n]?.length)
      .flatMap((n) => readSheet(snapshot.sheets[n], n).rows);
    // Аркуші лише з колонкою Offer ID («Заморожені ID»): зафіксований набір каталогу, у т.ч. свідомо виключені.
    const frozenIds = new Set();
    for (const n of config.catalog.knownIdSheets || []) {
      const v = snapshot.sheets[n];
      if (!v?.length) continue;
      const col = v[0].map(mtText).indexOf("Offer ID");
      if (col < 0) continue;
      for (const r of v.slice(1)) if (r[col] !== "" && r[col] != null) frozenIds.add(mtText(r[col]));
    }

    // D1 п. 4–7: стабільна картка при зміні ID постачальника (до плану, щоб перев'язані картки оновились у цьому ж запуску).
    const syncAll = Object.values(sheetRows).flat();
    const identity = resolveIdentity({
      // Видалений не перев'язується до іншої позиції постачальника (E6): у резолюції ідентичності — лише як «відомий» рядок.
      syncRows: syncAll.filter((r) => !removedSync.has(mtText(r["Offer ID"]))), knownRows: [...syncAll, ...otherRows], offers: parsed.offers,
      links: await store.getJson(LINKS_KEY), autoRelink: config.identity?.autoRelink !== false, now, frozenIds,
    });
    const views = {};
    for (const name of config.catalog.syncSheets) {
      views[name] = sheetRows[name].map((r) => planView(r, identity.effective));
      plans[name] = planRows(views[name], parsed.offers, stamp, config.pricing);
    }
    // D1 (зникнення) і D1b (конфлікти): ізоляція окремої картки, власний залишок, журнал, захист від масових збоїв.
    const availability = applyAvailabilityPolicy({
      sheets: config.catalog.syncSheets.map((name) => ({ rows: views[name], plan: plans[name] })), offers: parsed.offers,
      previous: { missing: previous?.missing, conflicts: previous?.conflicts, verifiedAt: previous?.verifiedAt },
      ownStock: await store.getJson(OWN_STOCK_KEY), now, policy: config.policy, pricing: config.pricing,
    });
    if (availability.anomaly) {
      const a = availability.anomaly;
      throw new Error(`Аномально багато проблемних товарів за один запуск (нових зникнень ${a.newlyMissing}, нових конфліктів ${a.newlyConflicted}; поріг ${a.limit}): вважаємо фід постачальника несправним, стан і фіди не змінено`);
    }
    // E6 (Hermes ENG15-P4): видалений до перенесення в архів — операційні значення (ціна, наявність, кількість) НЕ оновлюються.
    let removedFrozen = 0;
    for (const name of config.catalog.syncSheets) plans[name] = plans[name].map((p) => (removedSync.has(String(p.id)) ? (removedFrozen++, { ...p, next: p.before.slice() }) : p));
    for (const name of config.catalog.syncSheets) {
      rowsBySheet[name] = sheetRows[name].map((r, i) => {
        const copy = { ...r };
        LIVE_COLUMNS.forEach((k, j) => { copy[k] = plans[name][i].next[j]; });
        return copy;
      });
    }
    t.lap("зіставлення");

    const opRows = {};
    for (const name of config.catalog.syncSheets) for (const p of plans[name]) opRows[p.id] = p.next;
    if (identity.relinked.length || !(await store.head(LINKS_KEY))) await store.putJson(LINKS_KEY, identity.links);
    operational = { kind: "OPERATIONAL_STATE_V1", syncState: "OK", lastSuccess: stamp, feedDate: parsed.date, feedCount: parsed.count, rows: opRows, missing: availability.missing, conflicts: availability.conflicts, verifiedAt: availability.verifiedAt };
    await commitOperational({ store, ctx, config, controls0, operational }); // комміт синхронізації — один запис
    t.lap("запис стану");

    await store.putJson("reports/identity/latest.json", { generatedAt: stamp, relinked: identity.relinked, manualReview: identity.manual, frozen: identity.frozen });
    await store.putJson("reports/missing/latest.json", {
      generatedAt: stamp, missing: Object.keys(availability.missing).length, newlyMissing: availability.newlyMissing,
      returned: availability.returned, proposals: availability.proposals, note: "Лише пропозиції. Автоматичного приховування/видалення немає.",
    });
    report.identity = { relinked: identity.relinked.length, manualReview: identity.manual.length, frozenInFeed: identity.frozen.inFeed, frozenIgnored: identity.frozen.ignored, frozenFlagged: identity.frozen.flagged };
    // D1b п. 6: журнал конфліктів — окремий файл подій на запуск (лише якщо є події), плюс поточний реєстр.
    if (availability.events.length) await store.putJson(`journal/conflicts/${stamp.slice(0, 7)}/${stamp.replace(/[:.]/g, "-")}.json`, availability.events);
    await store.putJson("reports/conflicts/latest.json", {
      generatedAt: stamp, open: Object.keys(availability.conflicts).length, events: availability.events.length,
      byReason: Object.values(availability.conflicts).reduce((a, c) => ((a[c.reason] = (a[c.reason] || 0) + 1), a), {}),
      conflicts: availability.conflicts, note: "Ізольовано лише ці картки. Контент і остання перевірена ціна збережені; перевірте й виправте джерело.",
    });
    report.availability = { missing: Object.keys(availability.missing).length, newlyMissing: availability.newlyMissing.length, returned: availability.returned.length, proposals: availability.proposals.length };
    report.conflicts = { open: Object.keys(availability.conflicts).length, opened: availability.events.filter((e) => e.event === "OPENED").length, resolved: availability.events.filter((e) => e.event === "RESOLVED").length };

    const changes = config.catalog.syncSheets.flatMap((name) => changeEntries(stamp, name, plans[name]));
    if (changes.length) await store.putJson(`runs/${stamp.slice(0, 7)}/${stamp.replace(/[:.]/g, "-")}-changes.json`, changes);

    report.sync = {
      state: "OK", feedDate: parsed.date, offers: parsed.count, changes: changes.length, removedFrozen,
      sheets: config.catalog.syncSheets.map((name) => ({
        name, rows: plans[name].length,
        matched: plans[name].filter((x) => x.match === MATCH.OK).length,
        held: plans[name].filter((x) => x.match !== MATCH.OK).length,
        byStatus: plans[name].reduce((acc, x) => ((acc[x.match] = (acc[x.match] || 0) + 1), acc), {}),
      })),
    };
    const dups = duplicateReport(rowsBySheet);
    if (dups.supplierIdDuplicates.length) report.warnings.push({ code: "SUPPLIER_ID_DUPLICATES", count: dups.supplierIdDuplicates.length, sample: dups.supplierIdDuplicates.slice(0, 5) });

    // ---------- нові товари (лише звіт) ----------
    const knownIds = new Set();
    for (const values of Object.values(snapshot.sheets)) {
      if (!values.length) continue;
      const h = values[0].map(mtText);
      const i = h.indexOf("ID постачальника");
      const j = h.indexOf("Offer ID");
      for (const row of values.slice(1)) { if (i >= 0 && row[i] !== "" && row[i] != null) knownIds.add(mtText(row[i])); if (j >= 0 && row[j]) knownIds.add(mtText(row[j])); }
    }
    // Перев'язані та неоднозначні offers — не «нові товари» (щоб не створити другу картку).
    for (const r of identity.relinked) knownIds.add(r.to);
    for (const m of identity.manual) knownIds.add(m.offerId);
    const seen = (await store.getJson(SEEN_KEY)) || {};
    const detected = detectNewProducts({ offers: parsed.offers, knownIds, seen: seen.items || {}, now });
    await store.putJson(SEEN_KEY, { kind: "SUPPLIER_SEEN_V1", updatedAt: stamp, items: detected.seen });
    await store.putJson("reports/new-products/latest.json", { generatedAt: stamp, total: detected.candidates.length, newSinceLastRun: detected.newSinceLastRun, disappeared: detected.disappearedCandidates, candidates: detected.candidates });
    report.newProducts = { total: detected.candidates.length, newSinceLastRun: detected.newSinceLastRun.length };
    t.lap("нові товари");

    await store.putJson(SYNC_KEY, { ...syncState, state: "OK", lastSuccess: stamp, lastAttempt: stamp, lastError: "", lastFeedCount: parsed.count });
    ctx.groups = snapshot.groups;
  } catch (error) {
    const message = sanitize(error);
    await store.putJson(SYNC_KEY, { ...syncState, state: "ERROR", lastAttempt: stamp, lastError: message }).catch(() => {});
    report.sync = { state: error?.code === "CC_BLOCKED" ? "BLOCKED_CC" : "ERROR", error: message };
    // Hermes E7: ранній збій не обходить захист — активні версії фідів перевіряються на поточний стан CC і, за потреби, виправляються.
    report.feeds = await protectActiveFeeds({ store, ctx, config, tmpDir: ctx.tmpDir || os.tmpdir(), now, stamp, controls: error?.code === "CC_BLOCKED" ? controls0 : undefined });
    report.timingsMs = t.ms;
    report.finishedAt = new Date().toISOString();
    report.usage = await recordUsage(store, report, t.total());
    await store.putJson("state/last-run.json", report).catch(() => {});
    return report;
  }

  // ---------- фіди (кожен ізольовано) ----------
  const groups = objectsFromValues(ctx.groups, GROUP_HEADERS);
  const tmpDir = ctx.tmpDir || os.tmpdir();
  // Видалені (архів) — у removed додатково до CC (лише захисний напрям: виключити з фіду).
  const union = (a, b) => new Set([...setOf(a), ...setOf(b)]);
  // Рішення CC авторитетне: blocked → BLOCKED_CC (архів його не обходить). Архів лише ДОДАЄ виключення (захисний напрям), ніколи не дозволяє.
  const controls = archive?.all.size && controls0 && !controls0.blocked
    ? { ...controls0, removed: union(controls0.removed, archive.all) }
    : controls0;
  report.controls = controls ? { blocked: controls.blocked === true, reasons: controls.reasons || [], held: setOf(controls.held).size, removed: setOf(controls.removed).size, fingerprint: controls.fingerprint || null } : null;
  const { lease, problem: leaseProblem, store: pstore = store } = controls ? await acquirePublishLease(ctx, config) : { lease: null, problem: null, store };
  const rv = leaseProblem ? { active: false } : await recoveryOf(pstore);
  try {
  for (const feed of config.feeds.filter((f) => f.enabled !== false)) {
    const result = { feed: feed.name };
    const file = path.join(tmpDir, `feed-${feed.name}-${process.pid}-${Date.now()}.xml`);
    // ENG-17 (I07): без оренди W2 — жодного перемикання й жодного запису маніфесту (не успіх).
    if (leaseProblem) { Object.assign(result, { state: "BLOCKED_W2", activeSafety: "UNVERIFIED", reason: leaseProblem }); report.feeds.push(result); continue; }
    // ENG-24 (E7): відновлення CC — нового фіду не публікуємо; обслуговувана версія — перевірка щодо стану CC або зняття (зменшення).
    if (rv.active) {
      Object.assign(result, { state: "RECOVERY_PENDING", reason: recoveryReason(rv.recovery) }, controls && !controls.blocked
        ? await secureServed({ store: pstore, feed: feed.name, controls, reason: recoveryReason(rv.recovery) + ": " }).catch((e) => ({ activeSafety: "UNVERIFIED", secureError: sanitize(e) }))
        : { activeSafety: "UNVERIFIED", withdraw: await withdrawSafe(pstore, feed.name, recoveryReason(rv.recovery)) });
      report.feeds.push(result);
      continue;
    }
    // CC R4 §6.2: стан CC недостовірний — нового фіду не формуємо й чинний НЕ перевикористовуємо як успіх.
    // ENG-17 (Hermes ENG15-P1a / I17): безпечність обслуговуваної версії неможливо довести → зняти з обслуговування (Worker 503).
    if (controls?.blocked) {
      Object.assign(result, { state: "BLOCKED_CC", reasons: controls.reasons || [], activeSafety: "UNVERIFIED", withdraw: await withdrawSafe(pstore, feed.name, "стан Catalog Controls недостовірний — безпечність версії неможливо довести: " + (controls.reasons || []).join("; ")) });
      await store.putJson(`state/feed-${feed.name}-error.json`, { at: stamp, error: "BLOCKED_CC: " + (controls.reasons || []).join("; ") }).catch(() => {});
      report.feeds.push(result);
      continue;
    }
    let lastGood = null;
    try {
      const manifest = ctx.manifests?.[feed.name] || (await store.getJson(feed.manifest));
      if (!manifest) throw new Error("Немає погодженого паспорта набору для фіду " + feed.name);
      let rows = feed.sheets.flatMap((name) => rowsBySheet[name] || []);
      // Фід лише з погоджених ID (напр. NEW92 з черги, де можуть бути й непогоджені кандидати).
      if (feed.filterByManifest) {
        if (!Array.isArray(manifest.ids)) throw new Error("Паспорт фіду " + feed.name + " не містить списку ids");
        const allowed = new Set(manifest.ids);
        rows = rows.filter((r) => allowed.has(mtText(r["Offer ID"])));
      }
      for (const k of YML_HEADERS) if (rows.length && !(k in rows[0])) throw new Error("Немає унікальної колонки " + k);
      if (controls || ownerPriority) { const a = await readVerifiedActive(store, feed.name); lastGood = a ? offersById(a.xml) : new Map(); }
      const sink = fileSink(file);
      let built;
      try {
        built = await buildYml({
          rows, groups, manifest, sink,
          meta: { syncState: operational.syncState, lastSuccess: operational.lastSuccess, now },
          ...feedBuildOptions({ config, feed, controls, lastGood, ownerPriority }),
        });
      } finally { await sink.close(); }
      if (built.rowIssues?.length) await store.putJson(`reports/rows/${feed.name}-latest.json`, { generatedAt: stamp, issues: built.rowIssues, note: "Ізольовано лише ці товари (останній опублікований стан, недоступні); решта фіду опублікована." });
      t.lap("формування " + feed.name);
      const published = await publishFeed(pstore, feed.name, file, built, {
        retain: config.publish.retainVersions, readback: config.publish.readback, gzip: Boolean(feed.gzip),
        ...(controls ? { checkCandidate: candidateGuard(controls) } : {}),
        assertSourceUnchanged: async () => {
          await leaseOk(lease);
          const current = await store.getJson(OPERATIONAL_KEY);
          if (!current || current.lastSuccess !== operational.lastSuccess) throw new Error("Джерело змінилося під час формування YML");
          // CC R4 §6.4: у момент перемикання — свіжий стан CC; інший відбиток / blocked → не перемикати.
          if (controls && ctx.controls?.verify) {
            const v = await ctx.controls.verify(built.ccFingerprint);
            if (!v?.ok) throw new Error("Стан Catalog Controls змінився між проєкцією й публікацією: " + (v?.reasons || []).join("; "));
          }
          await leaseOk(lease);
        },
      });
      t.lap("публікація " + feed.name);
      // ENG-17 (I07): оренду втрачено вже після перемикання — інший записувач міг діяти: захисна перевірка обслуговуваної версії.
      try { await leaseOk(lease); } catch (e) {
        const fresh = await controlsFor(ctx, config);
        result.leaseLost = sanitize(e);
        const comp = compensationStore(pstore);
        if (fresh && !fresh.blocked) Object.assign(result, await secureServed({ store: comp, feed: feed.name, controls: fresh, reason: "оренду W2 втрачено після перемикання — " }).catch((x) => ({ activeSafety: "UNVERIFIED", secureError: sanitize(x) })));
        else Object.assign(result, { activeSafety: "UNVERIFIED", withdraw: await withdrawSafe(comp, feed.name, "оренду W2 втрачено, стан Catalog Controls невідомий") });
        throw Object.assign(new Error("оренду W2 втрачено під час перемикання: " + sanitize(e)), { leaseLost: true });
      }
      Object.assign(result, { state: published.reused ? "REUSED" : "PUBLISHED", count: built.count, bytes: built.bytes, sha256: built.sha256, storedBytes: published.active.storedBytes, removedVersions: published.removed?.length || 0, unavailableMissing: built.unavailableMissing, isolatedConflicts: built.isolatedConflicts, ownStock: built.ownStock, excludedNeverPriced: built.excludedNeverPriced, held: built.held, removedExcluded: built.removedExcluded?.length || 0, rowIssues: built.rowIssues?.length || 0, ccFingerprint: built.ccFingerprint, audit: built.audit });
    } catch (error) {
      Object.assign(result, { state: error?.leaseLost ? "LEASE_LOST" : "ERROR", error: sanitize(error) });
      await store.putJson(`state/feed-${feed.name}-error.json`, { at: stamp, error: result.error }).catch(() => {});
      // S7: новий фід не вдався — не залишати знятий / видалений товар доступним у старій активній версії.
      if (error?.leaseLost) { /* захисну перевірку вже виконано вище (без оренди нових записів не робимо) */ }
      else if (controls && !controls.blocked) {
        Object.assign(result, await secureFeed({ store: pstore, feed, controls, ctx, config, tmpDir, now, stamp, lease }));
        if (result.activeSafety === "UNSAFE") result.state = "WITHDRAWN";
      } else if (controls?.blocked) result.activeSafety = "UNVERIFIED";
    } finally {
      await fsp.unlink(file).catch(() => {});
    }
    report.feeds.push(result);
  }
  } finally { await lease?.release().catch(() => {}); }
  report.timingsMs = t.ms;
  report.finishedAt = new Date().toISOString();
  report.usage = await recordUsage(store, report, t.total());
  await store.putJson("state/last-run.json", report);
  await store.putJson(`runs/${stamp.slice(0, 7)}/${stamp.replace(/[:.]/g, "-")}-report.json`, report);
  return report;
}

/** Накопичення використання за місяць: операції R2, байти, тривалість — основа контролю квот. */
async function recordUsage(store, report, durationMs) {
  const month = report.startedAt.slice(0, 7);
  const key = `usage/${month}.json`;
  const usage = (await store.getJson(key)) || { month, runs: 0, durationMs: 0, classA: 0, classB: 0, bytesUploaded: 0 };
  const ops = store.ops || {};
  usage.runs += 1;
  usage.durationMs += durationMs;
  // Лічильник сховища накопичувальний за процес; фіксуємо приріст від попереднього запису.
  const delta = (k) => (ops[k] || 0) - (store.__lastUsage?.[k] || 0);
  usage.classA += delta("classA") + 2; // +2: цей запис usage та last-run
  usage.classB += delta("classB");
  usage.bytesUploaded += delta("bytesUploaded");
  store.__lastUsage = { ...ops };
  await store.putJson(key, usage).catch(() => {});
  return usage;
}
