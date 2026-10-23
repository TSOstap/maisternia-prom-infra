/** «Сторож новинок» (погоджено власником 22.10.2026): спільне ядро Cloudflare Worker і GitHub intake. Чисті функції, без мережі.
 *
 *  Правила:
 *   - новий ID у фіді постачальника — спершу КАНДИДАТ (не черга): запам'ятовуємо перше виявлення й останню суттєву зміну;
 *   - суттєві поля: назви UA/RU, артикул, URL, фото, характеристики (+ опис — лише там, де він є, тобто в повному XML);
 *   - будь-яка суттєва зміна → 10-хвилинний період стабільності починається заново;
 *   - лише після ≥10 хв стабільності й повних даних кандидат «ГОТОВИЙ» і передається в GitHub intake;
 *   - intake повторно звіряє відбиток із повним XML (дані могли змінитися після передачі) — інакше відмова;
 *   - нічого не потрапляє в основний каталог / YML без затвердження власника.
 *
 *  Відбиток — по частинах: коротка SHA-256 (8 hex) кожного поля → видно, ЩО саме змінилось:
 *   «w1.<профіль>.<назва UA>.<назва RU>.<артикул>.<URL>.<фото>.<характеристики>» — для стеження (Worker; без опису);
 *   «s1.<назва UA>.<назва RU>.<артикул>.<URL>.<фото>.<характеристики>.<опис>» — у таблиці («SHA даних постачальника»).
 *  Дата yml_catalog НЕ використовується як ознака змін (у Prom це час генерації фіду, змінюється щоразу). */
import { mtDecode, mtKey, mtSku, mtText, sha256 } from "./text.mjs";
import { offerFields } from "./supplier-feed.mjs";
import { photoKey } from "./dup-check.mjs";

export const INTAKE_RULES = Object.freeze({
  stableMinutes: 10,          // період стабільності
  goneDropHours: 24,          // кандидат, що зник із фіду, забуваємо через добу
  ackTimeoutMinutes: 60,      // GitHub не підтвердив передачу — повтор
  refusedHoldMinutes: 30,     // intake відмовив — пауза перед повтором (не витрачати хвилини GitHub)
  maxDispatchPerDay: 12,      // ліміт запусків GitHub intake на добу (UTC)
  minDispatchGapMinutes: 15,  // не частіше одного запуску на 15 хв
  maxIdsPerDispatch: 40,
  historyLimit: 10,
  heartbeatMinutes: 60,       // стан пишемо в KV лише при змінах або раз на годину
  requireParams: true,
  minOffers: 4157,            // захист від неповного фіду (як validateFeed)
  dropRatio: 0.8,
  backoffMinutes: 30,         // постачальник обмежує частоту (429/503) — пауза
});

export const PART_LABEL = Object.freeze({ nameUa: "назва UA", nameRu: "назва RU", sku: "артикул", url: "URL", photos: "фото", params: "характеристики", description: "опис" });
const WATCH_KEYS = ["nameUa", "nameRu", "sku", "url", "photos", "params"];
const SHEET_KEYS = [...WATCH_KEYS, "description"];
/** Профілі фіду для Worker: medium — без описів і ключових слів (фото й характеристики є); operational — лише назви/артикул/ціни. */
export const FEED_PROFILES = Object.freeze({
  medium: { exclude_fields: "description,keywords", html_description: "0", extra_fields: "0" },
  operational: { exclude_fields: "description,picture,param,keywords", html_description: "0", extra_fields: "0" },
});
const PROFILE_KEYS = { medium: WATCH_KEYS, operational: ["nameUa", "nameRu", "sku", "url"] };

const DAY = (t) => new Date(t).toISOString().slice(0, 10);
const MIN = 60_000;

// ---------- сирі дані offer ----------
const stripCdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
const tagRaw = (body, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(body); return m ? stripCdata(m[1]).trim() : ""; };
export function picturesFrom(body) {
  return [...body.matchAll(/<picture>([\s\S]*?)<\/picture>/g)].map((x) => mtDecode(stripCdata(x[1]).trim())).filter((u) => /^https?:\/\//.test(u));
}
export function paramsFrom(body) {
  return [...body.matchAll(/<param\b([^>]*)>([\s\S]*?)<\/param>/g)].map((p) => ({
    name: mtDecode(/\bname\s*=\s*"([^"]*)"/.exec(p[1])?.[1] || "").trim(), value: mtDecode(stripCdata(p[2])).trim(), unit: mtDecode(/\bunit\s*=\s*"([^"]*)"/.exec(p[1])?.[1] || "").trim(),
  })).filter((p) => p.name);
}
/** Один offer → сирі дані (ті самі розбори, що в mtParse і в extractFullOffers). Опис — лише якщо він є у XML. */
export function offerRaw(attrs, body) {
  const o = offerFields(attrs, body);
  return {
    ...o, pictures: picturesFrom(body), params: paramsFrom(body),
    descriptionUa: tagRaw(body, "description_ua"), descriptionRu: tagRaw(body, "description"),
    hasDescription: /<description(_ua)?[\s>]/.test(body),
  };
}
/** Сирі дані з рядка черги + (необов'язково) повного offer (фото, характеристики, опис). */
export function rawFromOffer(offer, full) {
  return {
    id: offer.id, nameUa: offer.nameUa, nameRu: offer.nameRu, sku: offer.sku, url: offer.url,
    price: offer.price, currency: offer.currency, available: offer.available,
    pictures: full?.pictures || [], params: full?.params || [],
    descriptionUa: full?.descriptionUa || "", descriptionRu: full?.descriptionRu || "", hasDescription: Boolean(full),
  };
}

const jsonList = (v) => { try { const a = JSON.parse(mtText(v) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
/** Сирі дані постачальника, збережені в рядку черги (опису постачальника там немає — лише SEO-опис). */
export function rawFromQueueRow(row) {
  return {
    id: mtText(row["ID постачальника"]), nameUa: row["Назва постачальника UA"], nameRu: row["Назва постачальника RU"], sku: row["Артикул постачальника"], url: row["URL постачальника"],
    // Сирі характеристики — окрема колонка (з 23.10.2026); у старих рядках — «Характеристики JSON», яку тоді писала система.
    pictures: jsonList(row["Фото JSON"]).filter((u) => typeof u === "string"),
    params: jsonList(mtText(row["Характеристики постачальника JSON"]).trim() ? row["Характеристики постачальника JSON"] : row["Характеристики JSON"]).filter((p) => p && typeof p === "object"),
    descriptionUa: "", descriptionRu: "", hasDescription: false,
  };
}

// ---------- відбиток ----------
const canonText = (s) => mtKey(mtText(s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " "));
export function rawParts(raw) {
  return {
    nameUa: mtKey(raw.nameUa), nameRu: mtKey(raw.nameRu), sku: mtSku(raw.sku), url: mtText(raw.url).trim(),
    // Порядок фото й характеристик — не суттєва зміна; набір — суттєва.
    photos: [...new Set((raw.pictures || []).slice(0, 10).map(photoKey))].sort().join("|"),
    params: (raw.params || []).slice(0, 100).map((p) => `${mtKey(p.name)}=${mtKey(p.value)}|${mtKey(p.unit)}`).sort().join("\n"),
    description: canonText(raw.descriptionUa) + "\n" + canonText(raw.descriptionRu),
  };
}
const h8 = (s) => sha256(s).slice(0, 8);
export function watchFingerprint(raw, profile = "medium") {
  const parts = rawParts(raw);
  return `w1.${profile}.` + PROFILE_KEYS[profile].map((k) => h8(parts[k])).join(".");
}
/** Відбиток для таблиці. Опис невідомий (немає повного XML) — береться з попереднього відбитка (опис не «змінюється» сам). */
export function sheetFingerprint(raw, previous = "") {
  const parts = rawParts(raw);
  const prev = parseFingerprint(previous);
  return "s1." + SHEET_KEYS.map((k) => (k === "description" && !raw.hasDescription ? prev?.description || h8(parts[k]) : h8(parts[k]))).join(".");
}
export function parseFingerprint(fp) {
  const m = /^(w1|s1)\.(.+)$/.exec(mtText(fp));
  if (!m) return null;
  let rest = m[2].split(".");
  let keys = SHEET_KEYS;
  if (m[1] === "w1") { keys = PROFILE_KEYS[rest[0]]; rest = rest.slice(1); if (!keys) return null; }
  if (rest.length !== keys.length) return null;
  return Object.fromEntries(keys.map((k, i) => [k, rest[i]]));
}
/** Які суттєві поля відрізняються (людські назви). Невідомий формат — «усі дані». */
export function changedParts(a, b) {
  const x = parseFingerprint(a), y = parseFingerprint(b);
  if (!x || !y) return a === b ? [] : ["дані постачальника"];
  return Object.keys(PART_LABEL).filter((k) => k in x && k in y && x[k] !== y[k]).map((k) => PART_LABEL[k]);
}

// ---------- повнота ----------
export function completeness(raw, { requireParams = true, profile = "medium" } = {}) {
  const miss = [];
  if (!mtText(raw.nameUa).trim()) miss.push("назва UA");
  if (!mtText(raw.nameRu).trim()) miss.push("назва RU");
  if (!mtText(raw.sku).trim()) miss.push("артикул");
  if (!(Number.isFinite(raw.price) && raw.price > 0)) miss.push("ціна");
  if (raw.currency !== "UAH") miss.push("валюта UAH");
  if (typeof raw.available !== "boolean") miss.push("наявність");
  if (profile === "medium") {
    if (!(raw.pictures || []).length) miss.push("фото");
    if (requireParams && !(raw.params || []).length) miss.push("характеристики");
  }
  return miss;
}

// ---------- сканування фіду (Worker): лише ID усіх offer + сирі дані потрібних ----------
export function scanFeed(xml, want) {
  const head = xml.slice(0, 4000);
  const date = /<yml_catalog\b[^>]*\bdate\s*=\s*"([^"]*)"/.exec(head)?.[1] || "";
  const ids = new Set();
  const offers = new Map();
  let dup = 0, i = 0;
  // Швидкий шлях (CPU Worker Free — 10 мс): вбудований indexOf, без regex; кінець offer шукаємо лише для потрібних ID.
  // Prom завжди пише «<offer id="…"»; якщо формат зміниться — повільніший запасний шлях (регулярний вираз).
  const fast = xml.indexOf('<offer id="') >= 0;
  for (;;) {
    i = xml.indexOf(fast ? '<offer id="' : "<offer ", i);
    if (i < 0) break;
    const gt = xml.indexOf(">", i);
    if (gt < 0) throw new Error("обірваний запис offer — фід неповний");
    let id;
    if (xml.startsWith('id="', i + 7)) { const q = xml.indexOf('"', i + 11); id = q > 0 && q < gt ? xml.slice(i + 11, q) : ""; }
    else id = /\bid\s*=\s*"([^"]*)"/.exec(xml.slice(i + 6, gt))?.[1] || ""; // інший порядок атрибутів
    if (!/^\d+$/.test(id)) throw new Error("невалідний ID offer");
    if (ids.has(id)) dup++;
    ids.add(id);
    const start = i;
    i = gt + 1;
    if (want(id)) {
      const end = xml.indexOf("</offer>", gt);
      if (end < 0) throw new Error("обірваний запис offer — фід неповний");
      offers.set(id, offerRaw(xml.slice(start + 6, gt), xml.slice(gt + 1, end)));
      i = end + 8;
    }
  }
  if (!xml.slice(-512).includes("</yml_catalog>")) throw new Error("немає кінця документа — фід неповний"); // лише кінець — не весь рядок
  if (dup) throw new Error("повторені ID offer у фіді");
  return { date, ids, offers };
}

// ---------- стан Worker ----------
export function emptyState() {
  return { v: 1, known: null, queue: {}, candidates: {}, dispatch: { day: "", count: 0, lastAt: 0 }, backoffUntil: 0, lastRun: null, savedAt: 0 };
}
/** Які ID Worker має розібрати повністю: невідомі (кандидати) і позиції черги. */
export function wantedIds(state) {
  const known = new Set(state.known?.ids || []);
  return (id) => !known.has(id) || Object.prototype.hasOwnProperty.call(state.queue, id);
}
const pushHistory = (rec, at, what, rules) => { rec.history = [...(rec.history || []), { at, what }].slice(-rules.historyLimit); };

/**
 * Один крок спостереження. state — з KV (не змінюється, повертається новий); scan — scanFeed(); now — мс.
 * Повертає { state, dispatch: null | { profile, ready: [...], refresh: [...] }, report, persist }.
 */
export function planWatch({ state: input, scan, now, rules = INTAKE_RULES, profile = "medium" }) {
  // База відомих ID (тисячі) planWatch не змінює — її не копіюємо й не серіалізуємо для порівняння (CPU Worker).
  const src = input || emptyState();
  const state = structuredClone({ ...src, known: null });
  state.known = src.known;
  const report = { at: new Date(now).toISOString(), feedDate: scan.date, offers: scan.ids.size, candidates: 0, ready: 0, waiting: 0, incomplete: 0, gone: 0, queueChanged: 0, blocked: "" };
  const before = JSON.stringify({ ...src, known: src.known?.at ?? null, lastRun: null, savedAt: 0 });
  const done = (dispatch = null) => {
    state.lastRun = report;
    const changed = JSON.stringify({ ...state, known: state.known?.at ?? null, lastRun: null, savedAt: 0 }) !== before;
    const persist = changed || !input?.savedAt || now - input.savedAt >= rules.heartbeatMinutes * MIN;
    if (persist) state.savedAt = now;
    return { state, dispatch, report, persist };
  };
  if (!state.known) { report.blocked = "НЕМАЄ БАЗИ ВІДОМИХ ID (чекаємо перший звіт GitHub)"; return done(); }
  // Неповний фід — нічого не вирішуємо (інакше всі кандидати «зникли б», а відомі виглядали б новими).
  const prev = Number(state.lastRun?.offers || state.known.ids.length || 0);
  const minimum = Math.max(rules.minOffers, Math.round(prev * rules.dropRatio));
  if (scan.ids.size < minimum) { report.blocked = `НЕПОВНИЙ ФІД: ${scan.ids.size} < ${minimum}`; return done(); }

  const known = new Set(state.known.ids);
  const stable = (t) => now - t >= rules.stableMinutes * MIN;
  // 1. Кандидати (невідомі ID).
  for (const [id, raw] of scan.offers) {
    if (known.has(id) || state.queue[id]) continue;
    const fp = watchFingerprint(raw, profile);
    const missing = completeness(raw, { requireParams: rules.requireParams, profile });
    let rec = state.candidates[id];
    if (!rec) {
      rec = state.candidates[id] = { firstSeen: now, lastChange: now, fp, missing, status: "СПОСТЕРЕЖЕННЯ", history: [] };
      pushHistory(rec, now, "ПОЯВА", rules);
    } else {
      if (rec.goneAt) { delete rec.goneAt; rec.lastChange = now; pushHistory(rec, now, "ПОВЕРНУВСЯ У ФІД", rules); }
      if (rec.fp !== fp) {
        pushHistory(rec, now, "ЗМІНА: " + changedParts(rec.fp, fp).join(", "), rules);
        rec.fp = fp; rec.lastChange = now; delete rec.fullFp;
        if (rec.status === "ПЕРЕДАНО") { delete rec.dispatchedAt; delete rec.dispatchedFp; }
      }
      rec.missing = missing;
    }
    if (rec.status === "ПЕРЕДАНО" && rec.dispatchedFp === fp && now - rec.dispatchedAt < rules.ackTimeoutMinutes * MIN) continue;
    if (rec.holdUntil && rec.holdUntil > now && rec.fp === rec.heldFp) { rec.status = "ВІДКЛАДЕНО"; continue; }
    delete rec.holdUntil; delete rec.heldFp;
    rec.status = !stable(rec.lastChange) ? "СПОСТЕРЕЖЕННЯ" : missing.length ? "НЕПОВНИЙ" : "ГОТОВИЙ";
  }
  // 2. Кандидати, яких більше немає у фіді.
  for (const [id, rec] of Object.entries(state.candidates)) {
    if (known.has(id)) { delete state.candidates[id]; continue; }
    if (scan.ids.has(id)) continue;
    if (!rec.goneAt) { rec.goneAt = now; rec.status = "ЗНИК"; pushHistory(rec, now, "ЗНИК ІЗ ФІДУ", rules); }
    else if (now - rec.goneAt >= rules.goneDropHours * 60 * MIN) delete state.candidates[id];
  }
  // 3. Позиції черги: зміна сирих даних → оновлення в черзі після 10 хв стабільності.
  const refresh = [];
  for (const [id, q] of Object.entries(state.queue)) {
    const raw = scan.offers.get(id);
    if (!raw) continue;
    const fp = watchFingerprint(raw, profile);
    if (fp === q.fp) { delete q.pendingFp; delete q.pendingSince; delete q.dispatchedAt; continue; }
    if (q.pendingFp !== fp) { q.pendingFp = fp; q.pendingSince = now; delete q.dispatchedAt; }
    report.queueChanged++;
    if (stable(q.pendingSince) && !(q.dispatchedAt && now - q.dispatchedAt < rules.ackTimeoutMinutes * MIN)) refresh.push({ id, fp, lastChange: q.pendingSince });
  }
  const cands = Object.entries(state.candidates);
  report.candidates = cands.length;
  report.waiting = cands.filter(([, r]) => r.status === "СПОСТЕРЕЖЕННЯ").length;
  report.incomplete = cands.filter(([, r]) => r.status === "НЕПОВНИЙ").length;
  report.gone = cands.filter(([, r]) => r.status === "ЗНИК").length;
  const ready = cands.filter(([, r]) => r.status === "ГОТОВИЙ").slice(0, rules.maxIdsPerDispatch)
    .map(([id, r]) => ({ id, fp: r.fp, firstSeen: new Date(r.firstSeen).toISOString(), lastChange: new Date(r.lastChange).toISOString(), ...(r.fullFp ? { fullFp: r.fullFp } : {}) }));
  report.ready = ready.length;
  if (!ready.length && !refresh.length) return done();
  // 4. Ліміти запусків GitHub (безкоштовні хвилини).
  if (state.dispatch.day !== DAY(now)) state.dispatch = { day: DAY(now), count: 0, lastAt: state.dispatch.lastAt || 0 };
  if (state.dispatch.count >= rules.maxDispatchPerDay) { report.blocked = `ЛІМІТ ЗАПУСКІВ: ${state.dispatch.count}/${rules.maxDispatchPerDay} за добу`; return done(); }
  if (state.dispatch.lastAt && now - state.dispatch.lastAt < rules.minDispatchGapMinutes * MIN) { report.blocked = "ПАУЗА МІЖ ЗАПУСКАМИ"; return done(); }
  return done({ profile, ready, refresh: refresh.slice(0, rules.maxIdsPerDispatch) });
}

/** Запуск GitHub прийнято — позначаємо передані (повтор лише після ackTimeout або зміни даних). */
export function markDispatched(state, dispatch, now) {
  const s = structuredClone(state);
  for (const r of dispatch.ready) { const c = s.candidates[r.id]; if (c) { c.status = "ПЕРЕДАНО"; c.dispatchedAt = now; c.dispatchedFp = r.fp; } }
  for (const r of dispatch.refresh) { const q = s.queue[r.id]; if (q) q.dispatchedAt = now; }
  s.dispatch = { day: DAY(now), count: (s.dispatch.day === DAY(now) ? s.dispatch.count : 0) + 1, lastAt: now };
  s.savedAt = now;
  return s;
}

/**
 * Звіт GitHub (після intake або синхронізації): база відомих ID, відбитки черги, результати передачі.
 * ack = { known: [ids], queue: { id: watchFp }, results: { id: { status: "ДОДАНО"|"ВЖЕ Є"|"ВІДМОВА", reason?, fullFp? } } }
 */
export function applyAck(state, ack, now, rules = INTAKE_RULES) {
  const s = structuredClone(state || emptyState());
  if (!Array.isArray(ack?.known) || !ack.known.length) throw new Error("звіт без бази відомих ID");
  s.known = { at: now, ids: [...new Set(ack.known.map(String))] };
  const queue = {};
  for (const [id, fp] of Object.entries(ack.queue || {})) {
    const old = s.queue[id];
    queue[id] = { fp };
    // Нова зміна, яку таблиця ще не отримала, — не губимо.
    if (old?.pendingFp && old.pendingFp !== fp) { queue[id].pendingFp = old.pendingFp; queue[id].pendingSince = old.pendingSince; }
  }
  s.queue = queue;
  for (const [id, r] of Object.entries(ack.results || {})) {
    const c = s.candidates[id];
    if (!c) continue;
    if (r.status === "ДОДАНО" || r.status === "ВЖЕ Є") { delete s.candidates[id]; continue; }
    c.status = "ВІДКЛАДЕНО"; c.note = mtText(r.reason).slice(0, 200); c.holdUntil = now + rules.refusedHoldMinutes * MIN; c.heldFp = c.fp;
    if (r.fullFp) { c.fullFp = r.fullFp; c.holdUntil = now + rules.stableMinutes * MIN; } // двофазна перевірка повних даних
    delete c.dispatchedAt; delete c.dispatchedFp;
    pushHistory(c, now, "ВІДМОВА INTAKE: " + c.note, rules);
  }
  const known = new Set(s.known.ids);
  for (const id of Object.keys(s.candidates)) if (known.has(id)) delete s.candidates[id];
  s.savedAt = now;
  return s;
}

/** Перевірка GitHub intake: кандидат справді стабільний і повний за ПОВНИМ XML (без довіри до Worker на слово). */
export function verifyReady(entry, raw, now, { rules = INTAKE_RULES, profile = "medium" } = {}) {
  if (!raw) return { ok: false, reason: "позиції немає у фіді постачальника" };
  const last = Date.parse(entry.lastChange);
  if (!Number.isFinite(last) || now - last < rules.stableMinutes * MIN) return { ok: false, reason: `стабільність не підтверджена (потрібно ≥${rules.stableMinutes} хв без змін)` };
  const fp = watchFingerprint(raw, profile);
  if (fp !== entry.fp) return { ok: false, reason: "дані змінилися після перевірки стабільності: " + changedParts(entry.fp, fp).join(", ") };
  const missing = completeness(raw, { requireParams: rules.requireParams, profile: "medium" });
  if (missing.length) return { ok: false, reason: "неповні дані: бракує " + missing.join(", ") };
  // Фолбек-профіль без фото/характеристик: повні дані теж мають бути стабільні (друга фаза через ≥10 хв).
  if (profile !== "medium") {
    const full = watchFingerprint(raw, "medium");
    if (entry.fullFp !== full) return { ok: false, reason: "контроль стабільності фото й характеристик (друга перевірка через 10 хв)", fullFp: full };
  }
  return { ok: true };
}

/** Обмежений набір кандидатів (контрольований тест): перші n за часом першого виявлення, потім за ID; 0 — усі. */
export function limitReady(ready, n) {
  const list = (Array.isArray(ready) ? ready : []).filter((e) => /^\d+$/.test(String(e?.id || "")));
  const sorted = list.slice().sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen)) || String(a.id).localeCompare(String(b.id)));
  const k = Number(n);
  return Number.isInteger(k) && k > 0 ? sorted.slice(0, k) : sorted;
}

/** Адреса фіду для Worker: та сама база (TOOLS_FEED_URL), інший набір полів. */
export function watchFeedUrl(base, profile = "medium") {
  let url = mtText(base);
  for (const [k, v] of Object.entries(FEED_PROFILES[profile])) {
    const re = new RegExp("([?&])" + k + "=[^&]*");
    url = re.test(url) ? url.replace(re, "$1" + k + "=" + encodeURIComponent(v)) : url + (url.includes("?") ? "&" : "?") + k + "=" + encodeURIComponent(v);
  }
  return url;
}

/** Короткий стан для перегляду (без адрес і ключів). */
export function publicStatus(state) {
  const s = state || emptyState();
  return {
    knownIds: s.known?.ids.length || 0, knownAt: s.known?.at ? new Date(s.known.at).toISOString() : "",
    queueWatched: Object.keys(s.queue).length, dispatch: s.dispatch, backoffUntil: s.backoffUntil ? new Date(s.backoffUntil).toISOString() : "",
    lastRun: s.lastRun,
    candidates: Object.entries(s.candidates).map(([id, r]) => ({
      id, status: r.status, firstSeen: new Date(r.firstSeen).toISOString(), lastChange: new Date(r.lastChange).toISOString(),
      missing: r.missing, note: r.note || "", history: r.history,
    })),
  };
}

