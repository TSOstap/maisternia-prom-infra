/** S6 (CC R4 §6, ENG-10; CC R6 §2–3): адаптер композиції — стан Catalog Controls для runUpdate / синхронізації (ctx.controls).
 *
 *  Читає аркуші CC (loadBook) і контрольну точку з ТОГО САМОГО сховища W2 (store) і викликає API Catalog Controls:
 *    api.controlsState(book, { contract, checkpoint, integrity, publication })          → { held, tombstoned, blocked, reasons, fingerprint, … }
 *    api.verifyControlsSnapshot(book, { contract, checkpoint, integrity, publication }, fp) → { ok, reasons, fingerprint }
 *  CC R6 §3: integrity — M3 cardVerdict (owner-priority.mjs); publication — Map(Offer ID → { feed: "absent" | "present" | "unknown" })
 *  з АКТИВНИХ опублікованих версій усіх увімкнених фідів (activeXmls). Немає / не прочитано хоч одну — "unknown" (не доказ).
 *  API передається явно: код CC — у своєму модулі (src/core/controls-plan.mjs після злиття гілок), адаптер його не дублює.
 *  Будь-яка помилка читання → виняток → споживач трактує як blocked (fail-closed). */
import { mtText } from "../core/text.mjs";
import { offersById } from "../core/yml.mjs";
import { cardIntegrity } from "../core/owner-priority.mjs";
import { SHEET } from "../core/sheet-sync.mjs";
import { ARCHIVE_SHEET } from "../core/archive.mjs";

export const CC_CHECKPOINT_KEY = "state/catalog-controls/checkpoint.json";

/** Проєкція стану CC для Engineering (одна для update.mjs, синхронізації й renderProbe): removed = ключі tombstoned (усі стадії). */
export function controlsFromState(st) {
  if (!st || typeof st !== "object") return { blocked: true, reasons: ["стан Catalog Controls порожній"], held: new Set(), removed: new Set(), fingerprint: "" };
  return {
    held: st.held, removed: new Set(st.tombstoned instanceof Map ? st.tombstoned.keys() : []),
    blocked: st.blocked !== false, reasons: st.reasons || [], fingerprint: st.fingerprint, confirmed: st.confirmed, active: st.active === true,
    // CC R5: доручення переходів між аркушами й фільтр новинок — як є (Engineering їх не обчислює сам).
    moves: st.moves ?? null, gate: st.gate ?? null, tombstoned: st.tombstoned ?? null,
  };
}

const idsOf = (values) => {
  if (!Array.isArray(values) || !values.length) return [];
  const k = (values[0] || []).map(mtText).indexOf("Offer ID");
  return k < 0 ? [] : values.slice(1).map((r) => mtText(r?.[k])).filter(Boolean);
};
/** CC R6 §3.1: доказ про активні опубліковані версії. xmls — масив текстів (null / не рядок — версії немає або не прочитано). */
export function publicationFrom(xmls, ids) {
  const known = Array.isArray(xmls) && xmls.length > 0 && xmls.every((x) => typeof x === "string");
  const present = new Set(known ? xmls.flatMap((x) => [...offersById(x).keys()]) : []);
  return new Map([...new Set(ids)].map((id) => [id, { feed: !known ? "unknown" : present.has(id) ? "present" : "absent" }]));
}

export function catalogControlsAdapter({ loadBook, store, contract, api, checkpointKey = CC_CHECKPOINT_KEY, integrity = cardIntegrity, activeXmls = null, publication: publicationInput = null, requireActive = false }) {
  if (typeof loadBook !== "function" || !store || typeof api?.controlsState !== "function" || typeof api?.verifyControlsSnapshot !== "function") {
    throw new Error("catalogControlsAdapter: потрібні loadBook, store, api.controlsState, api.verifyControlsSnapshot");
  }
  const checkpoint = async () => {
    if (typeof store.getJsonVersioned === "function") return (await store.getJsonVersioned(checkpointKey)).value ?? null;
    return (await store.getJson(checkpointKey)) ?? null;
  };
  const read = async () => {
    const book = await loadBook();
    // publication — для ID обох аркушів (у каталозі — REGISTERED / MOVING, в архіві — ARCHIVED / DONE). Без activeXmls — null (CC: не доказ).
    let publication = null;
    if (publicationInput instanceof Map) publication = publicationInput;
    else if (typeof publicationInput === "function") publication = await publicationInput(book);
    else if (typeof activeXmls === "function") {
      let xmls;
      try { xmls = await activeXmls(); } catch { xmls = null; }
      publication = publicationFrom(xmls, [...idsOf(book[SHEET.main]), ...idsOf(book[ARCHIVE_SHEET])]);
    }
    return { book, ctx: { contract, checkpoint: await checkpoint(), integrity, publication } };
  };
  return {
    async state() {
      const { book, ctx } = await read();
      const p = controlsFromState(api.controlsState(book, ctx));
      // CC R7 G2: робочий шлях — лише активований CC (контрольна точка застосовується); стан «оцінки до активації» → blocked.
      if (requireActive && p.active !== true) return { ...p, blocked: true, reasons: [...p.reasons, "Catalog Controls не активовано (контракт activated:false) — робочий шлях fail-closed"] };
      return p;
    },
    async verify(fingerprint) {
      const { book, ctx } = await read();
      return api.verifyControlsSnapshot(book, ctx, fingerprint);
    },
  };
}
