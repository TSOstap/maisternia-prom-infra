/** Гібрид (рішення власника 16.11.2026, варіант Б): «Excel (розширений)» Хорошопу постачальника → компактний список у сховищі W2
 *  (Durable Object). Оновлює список лише GitHub (xlsx завеликий для Worker Free: ліміт пам'яті); «Ціни» на обох шляхах (Cloudflare і
 *  GitHub) читають готовий список зі сховища. Адреса — лише секрет (GitHub: MM_HOROSHOP_EXCEL_URL; Worker: HOROSHOP_EXCEL_URL),
 *  у звітах не друкується. Збій / неповний файл → список не змінюється, «Ціни» працюють за попереднім списком або Prom-фідом. */
import { compactFromExcel, EXCEL_COLUMN_LIST, HOROSHOP_DATA_KEY, HOROSHOP_META_KEY, HOROSHOP_MIN_ROWS } from "../core/horoshop.mjs";
import OVERRIDES from "../../config/horoshop-overrides.json" with { type: "json" };

export const HOROSHOP_OVERRIDES = Object.freeze({ ...(OVERRIDES.overrides || {}) });
const MAX_BYTES = 80_000_000;

/** GitHub: завантажити Excel, перетворити на компактний список і зберегти (дані + мітка). → { state, count, lastModified, reason } */
export async function refreshHoroshopExcel({ url, store, fetchImpl = (...a) => fetch(...a), now = Date.now(), readXlsx = null, minRows = HOROSHOP_MIN_ROWS }) {
  if (!url) return { state: "SKIPPED", reason: "не задано посилання на Excel Хорошопу" };
  let res, buf;
  try {
    res = await fetchImpl(url, { redirect: "manual" });
    if (res.status !== 200) return { state: "ERROR", reason: "Excel Хорошопу: HTTP " + res.status + " — список не змінено" };
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) { return { state: "ERROR", reason: "Excel Хорошопу недоступний (" + String(e?.message || e).slice(0, 100) + ") — список не змінено" }; }
  if (buf.length > MAX_BYTES) return { state: "ERROR", reason: "Excel Хорошопу завеликий — список не змінено" };
  let compact;
  try {
    const read = readXlsx || (await import("../core/xlsx-lite.mjs")).readXlsxColumns;
    compact = compactFromExcel(read(buf, EXCEL_COLUMN_LIST));
  } catch (e) { return { state: "ERROR", reason: "Excel Хорошопу не розібрано: " + String(e?.message || e).slice(0, 160) + " — список не змінено" }; }
  if (compact.count < minRows) return { state: "ERROR", reason: `Excel Хорошопу: лише ${compact.count} рядків (менше ${minRows}) — файл неповний, список не змінено` };
  const lastModified = res.headers.get("last-modified") || "";
  const at = new Date(now).toISOString();
  const data = { v: 1, at, lastModified, count: compact.count, rows: compact.rows };
  const d0 = await store.getJsonVersioned(HOROSHOP_DATA_KEY);
  await store.putJsonIfVersion(HOROSHOP_DATA_KEY, data, d0.version);
  const m0 = await store.getJsonVersioned(HOROSHOP_META_KEY);
  await store.putJsonIfVersion(HOROSHOP_META_KEY, { v: 1, at, lastModified, count: compact.count }, m0.version);
  return { state: "REFRESHED", count: compact.count, lastModified, at };
}

/** Обидва шляхи «Цін»: готовий список зі сховища. → { rows, count, at, lastModified, overrides } | null */
export async function loadHoroshopCompact(store) {
  try {
    const d = (await store?.getJsonVersioned?.(HOROSHOP_DATA_KEY))?.value;
    if (!d || !Array.isArray(d.rows) || d.rows.length < HOROSHOP_MIN_ROWS) return null;
    return { rows: d.rows, count: d.count ?? d.rows.length, at: d.at || "", lastModified: d.lastModified || "", overrides: HOROSHOP_OVERRIDES };
  } catch { return null; }
}

/** Мітка списку (без даних) — для щогодинної перевірки на сервері. */
export async function horoshopMeta(store) {
  try { return (await store?.getJsonVersioned?.(HOROSHOP_META_KEY))?.value || null; } catch { return null; }
}
