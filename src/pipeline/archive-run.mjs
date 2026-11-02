/** Виконання переходів «Основний каталог» ⇄ «Видалені товари» через шлюз запису (оренда, журнал, за ключем; без другого
 *  механізму запису). Рішення — стан Catalog Controls (removed = tombstone, restore = дозволені повернення); blocked → нічого.
 *  Порядок кожного переходу: дописати в цільовий аркуш за ключем → перевірити → видалити з вихідного за ключем зі знімком.
 *  Повтор після збою продовжує з наступного кроку (planArchive бачить проміжний стан). */
import { SHEET } from "../core/sheet-sync.mjs";
import { mtText } from "../core/text.mjs";
import { ARCHIVE_SHEET, archiveHeader, planArchive, publishedCompletions, REMOVAL } from "../core/archive.mjs";
import { offersById } from "../core/yml.mjs";
import { OP } from "./safe-write/keyed-update.mjs";

const valuesOf = (header, objs) => objs.map((o) => header.map((h) => o[h] ?? ""));
const snapshot = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, mtText(v)]));

/**
 * @param {object} o
 * @param {object} o.session   сесія шлюзу (writer "sync")
 * @param {(names: string[]) => Promise<object>} o.read
 * @param {object} o.controls  стан CC: { removed: Set, restore?: Set, blocked, reasons }
 * @param {string} o.stamp
 */
export async function runArchiveMoves({ session, read, controls, stamp, opOf = () => "" }) {
  if (!controls || controls.blocked) return { state: "BLOCKED", reason: "стан Catalog Controls недостовірний або відсутній — перенесень немає", reasons: controls?.reasons || [] };
  // CC R5: переходи — за дорученням CC (moves.toArchive / moves.toCatalog); без moves — removed / restore (двійники, сумісність).
  const removed = new Set([...(controls.moves?.toArchive ?? controls.removed ?? [])].map(String)), restore = new Set([...(controls.moves?.toCatalog ?? controls.restore ?? [])].map(String));
  let book = await read([SHEET.main, ARCHIVE_SHEET]);
  const mainHeader = (book[SHEET.main]?.[0] || []).map(mtText);
  const aHeader = archiveHeader(mainHeader);
  if (!book[ARCHIVE_SHEET]) { await session.sheets.ensureSheet(ARCHIVE_SHEET, aHeader); book = await read([SHEET.main, ARCHIVE_SHEET]); }
  const plan = planArchive({ mainValues: book[SHEET.main], archiveValues: book[ARCHIVE_SHEET], removed, restore, at: stamp, opOf });
  const report = { state: "OK", archived: [], restored: [], pendingPublication: [], conflicts: plan.conflicts, needsDecision: [], steps: [] };
  const step = (name, r) => { report.steps.push({ name, outcome: r.outcome }); if (r.outcome === OP.NEEDS_DECISION || r.outcome === OP.UNKNOWN) report.needsDecision.push({ name, outcome: r.outcome, lost: r.lost || [] }); return r; };
  // Видалення: 1) архів, 2) каталог.
  if (plan.archive.length) {
    const r = step("archive:append", await session.appendMissingByKey({ title: ARCHIVE_SHEET, rows: valuesOf(aHeader, plan.archive.map((x) => x.row)), generation: "archive:" + stamp }));
    if (![OP.VERIFIED, OP.NOTHING].includes(r.outcome)) { report.state = "INCOMPLETE"; return report; }
  }
  // CC R5 крок 1: перед видаленням з джерела — рішення CC досі те саме. ENG-16: відбиток CC R7 враховує вміст архіву, тож наше власне
  // дописування копії його змінює; тому, якщо є свіжий стан (refresh), перевіряється ДОРУЧЕННЯ: не blocked, і кожен ID, який видаляємо
  // з каталогу, досі в moves.toArchive (з архіву — у moves.toCatalog). Без refresh — як раніше, відбиток (verify).
  const recheck = async () => {
    if (typeof controls.refresh === "function") {
      const fresh = await controls.refresh();
      if (!fresh || fresh.blocked !== false) throw Object.assign(new Error("стан Catalog Controls недостовірний: " + (fresh?.reasons || []).join("; ")), { code: "CC_CHANGED" });
      const toA = new Set([...(fresh.moves?.toArchive ?? [])].map(String)), toC = new Set([...(fresh.moves?.toCatalog ?? [])].map(String));
      const gone = [...plan.deleteFromMain.filter((x) => !toA.has(x.key)), ...plan.deleteFromArchive.filter((x) => !toC.has(x.key))].map((x) => x.key);
      if (gone.length) throw Object.assign(new Error("доручення Catalog Controls змінилось для: " + gone.slice(0, 5).join(", ")), { code: "CC_CHANGED" });
      return;
    }
    if (typeof controls.verify === "function") { const v = await controls.verify(controls.fingerprint); if (!v?.ok) throw Object.assign(new Error("стан Catalog Controls змінився: " + (v?.reasons || []).join("; ")), { code: "CC_CHANGED" }); }
  };
  if (plan.deleteFromMain.length || plan.deleteFromArchive.length) {
    try { await recheck(); } catch (e) { report.state = "BLOCKED"; report.reason = e.message; return report; }
  }
  if (plan.deleteFromMain.length) {
    const r = step("main:delete", await session.deleteByKeys({ title: SHEET.main, rows: plan.deleteFromMain.map((x) => ({ key: x.key, expect: snapshot(x.row) })), generation: "archive-main:" + stamp }));
    for (const it of r.items || []) if (it.status === "VERIFIED" || it.status === "ALREADY") report.archived.push(it.key); else report.conflicts.push({ id: it.key, reason: "не видалено з каталогу: " + it.status });
    if (r.outcome !== OP.VERIFIED && r.outcome !== OP.NOTHING) report.state = "INCOMPLETE";
  }
  // Відновлення: 1) каталог, 2) архів.
  if (plan.restore.length) {
    const r = step("main:append", await session.appendMissingByKey({ title: SHEET.main, rows: valuesOf(mainHeader, plan.restore.map((x) => x.row)), generation: "restore:" + stamp }));
    if (![OP.VERIFIED, OP.NOTHING].includes(r.outcome)) { report.state = "INCOMPLETE"; return report; }
  }
  if (plan.deleteFromArchive.length) {
    const r = step("archive:delete", await session.deleteByKeys({ title: ARCHIVE_SHEET, rows: plan.deleteFromArchive.map((x) => ({ key: x.key, expect: snapshot(x.row) })), generation: "restore-archive:" + stamp }));
    for (const it of r.items || []) if (it.status === "VERIFIED" || it.status === "ALREADY") report.restored.push(it.key);
    if (r.outcome !== OP.VERIFIED && r.outcome !== OP.NOTHING) report.state = "INCOMPLETE";
  }
  const after = await read([ARCHIVE_SHEET]);
  // До публікації YML без товару операція не «завершена» (markPublished).
  report.pendingPublication = planArchive({ mainValues: [mainHeader], archiveValues: after[ARCHIVE_SHEET], removed }).done.filter((d) => !d.status.startsWith(REMOVAL.DONE)).map((d) => d.id);
  if (report.needsDecision.length) report.state = "NEEDS_DECISION";
  // Hermes F3: розбіжні копії (каталог / архів) — жодна не видаляється; стан явно вимагає рішення людини (решта переходів виконано).
  if (report.conflicts.length && report.state === "OK") report.state = "NEEDS_DECISION";
  return report;
}

/** Завершення видалення за ОПУБЛІКОВАНИМ фідом (без Prom): activeXml — текст активної версії (publisher.readActiveXml).
 *  «ЗАВЕРШЕНО» — для архівних товарів, яких немає в жодному <offer> активної версії. Немає опублікованої версії → нічого. */
export async function markPublished({ session, read, activeXml, activeXmls = null, controls, stamp }) {
  // CC R5: рішення CC авторитетне — лише коли стан достовірний і лише для ID, які CC вважає видаленими; перевіряються активні
  // версії ВСІХ увімкнених фідів. Архів сам по собі нічого не «завершує».
  if (!controls || controls.blocked) return { outcome: OP.NOTHING, done: [], reason: "стан Catalog Controls недостовірний або відсутній" };
  const xmls = activeXmls || (typeof activeXml === "string" ? [activeXml] : []);
  if (!xmls.length || xmls.some((x) => typeof x !== "string")) return { outcome: OP.NOTHING, done: [], reason: "немає опублікованої версії фіду" };
  const removed = new Set([...(controls.removed || [])].map(String));
  const published = new Set(xmls.flatMap((x) => [...offersById(x).keys()]));
  const book = await read([ARCHIVE_SHEET]);
  const changes = publishedCompletions(book[ARCHIVE_SHEET], published, stamp).filter((ch) => removed.has(ch.key));
  if (!changes.length) return { outcome: OP.NOTHING, done: [] };
  const r = await session.updateByKey({ title: ARCHIVE_SHEET, changes, generation: "published:" + stamp });
  return { outcome: r.outcome, done: (r.items || []).filter((x) => x.status === "VERIFIED").map((x) => x.key) };
}