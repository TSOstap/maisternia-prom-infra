/** Перевірка механізму стабільного зіставлення на реальних даних. Лише читання; нічого не видаляє і не змінює.
 *
 *  node tools/analysis/identity.mjs --fresh=<xlsx робочої книги> --supplier=<xlsx каталогу постачальника у форматі Prom>
 *        [--prom=<xlsx експорту нашого магазину з Prom>] [--out=.data/analysis]
 *
 *  Звіт: <out>/identity.json (ID і агрегати, без описів). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readXlsx } from "../lib/xlsx-read.mjs";
import { objectsFromValues } from "../../src/core/yml.mjs";
import { YML_HEADERS } from "../../src/core/seal.mjs";
import { mtKey, mtSku, mtText } from "../../src/core/text.mjs";
import { brandKey, cardKeys, looseSku, resolveUnknownOffers, validGtin } from "../../src/core/identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const out = path.resolve(arg("out", path.join(root, ".data", "analysis")));
const sheetObjects = (file, name) => {
  const s = readXlsx(file, { only: [name] }).sheets.find((x) => x.name === name);
  const h = s.values[0];
  return s.values.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
};
const tally = (arr) => arr.reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {});

// ---------- каталог ----------
const book = Object.fromEntries(readXlsx(arg("fresh"), { only: ["Основний каталог", "Нові товари", "Відкладені товари"] }).sheets.filter((s) => s.values).map((s) => [s.name, s.values]));
const rows = [];
for (const [sheet, values] of Object.entries(book)) for (const r of objectsFromValues(values, YML_HEADERS)) rows.push({ sheet, r });
const cards = rows.map(({ sheet, r }) => ({ ...cardKeys(r), sheet }));
const report = { catalogCards: cards.length, bySheet: tally(cards.map((c) => c.sheet)) };

// A. Унікальність ключів у каталозі
const groupsBy = (fn) => {
  const m = new Map();
  for (const c of cards) { const k = fn(c); if (k) m.set(k, [...(m.get(k) || []), c.offerId]); }
  const dups = [...m.entries()].filter(([, v]) => v.length > 1);
  return { keyed: [...m.values()].reduce((a, v) => a + v.length, 0), duplicateGroups: dups.length, cardsInDuplicateGroups: dups.reduce((a, [, v]) => a + v.length, 0), sample: dups.slice(0, 8).map(([k, v]) => ({ key: k, ids: v })) };
};
report.keyUniqueness = {
  supplierId: groupsBy((c) => c.supplierId),
  sku: groupsBy((c) => c.sku),
  skuLoose: groupsBy((c) => c.skuLoose),
  brandSku: groupsBy((c) => c.brand && c.sku && c.brand + "|" + c.sku),
  brandModel: groupsBy((c) => c.brand && c.model && c.brand + "|" + c.model),
  gtin: groupsBy((c) => c.gtin),
  skuPlusNames: groupsBy((c) => c.sku && c.sku + "|" + mtKey(c.nameUa) + "|" + mtKey(c.nameRu)),
  slug: groupsBy((c) => c.slug),
};
report.coverage = {
  sku: cards.filter((c) => c.sku).length, brand: cards.filter((c) => c.brand).length, model: cards.filter((c) => c.model).length,
  gtinValid: cards.filter((c) => c.gtin).length, gtinRaw: rows.filter(({ r }) => mtText(r["GTIN"]).trim()).length,
  refNameUa: cards.filter((c) => c.nameUa).length, refNameRu: cards.filter((c) => c.nameRu).length, slug: cards.filter((c) => c.slug).length,
};

// A2. Можливі дублі всередині каталогу (нічого не видаляється — лише список на перевірку)
{
  const byKey = (fn) => {
    const m = new Map();
    for (const c of cards) { const k = fn(c); if (k) m.set(k, [...(m.get(k) || []), c]); }
    return [...m.values()].filter((v) => v.length > 1);
  };
  const sameNames = byKey((c) => c.brand + "|" + mtKey(c.nameUa));
  const sameSkuLoose = byKey((c) => c.brand + "|" + c.skuLoose);
  const describe = (g) => g.map((c) => ({ offerId: c.offerId, sheet: c.sheet, sku: c.sku }));
  report.potentialDuplicates = {
    note: "Кандидати на ручну перевірку; різні артикули з однаковою назвою можуть бути різними модифікаціями.",
    sameBrandAndRefNameUa: { groups: sameNames.length, cards: sameNames.reduce((a, g) => a + g.length, 0), crossSheet: sameNames.filter((g) => new Set(g.map((c) => c.sheet)).size > 1).length, list: sameNames.map(describe) },
    sameBrandAndLooseSku: { groups: sameSkuLoose.length, cards: sameSkuLoose.reduce((a, g) => a + g.length, 0), list: sameSkuLoose.map(describe) },
  };
}

// D. Найгірший випадок: постачальник перевипустив УСІ товари з новими ID (усі картки — сироти)
{
  const offers = rows.map(({ r }, i) => ({ id: String(9000000000 + i), sku: r["Артикул постачальника"], vendor: r["Виробник"], nameUa: r["Назва постачальника UA"], nameRu: r["Назва постачальника RU"], url: mtText(r["URL постачальника"]).replace(/\/p\d+-/, `/p${9000000000 + i}-`), model: r["Модель"], gtin: r["GTIN"] }));
  const orphanIds = new Set(cards.map((c) => c.offerId));
  const res = resolveUnknownOffers({ offers, cards, orphanIds });
  const correct = res.filter((d, i) => d.decision === "RELINK" && d.target === cards[i].offerId).length;
  const wrong = res.filter((d, i) => d.decision === "RELINK" && d.target !== cards[i].offerId).length;
  report.simulationAllReissued = {
    offers: offers.length, relinkCorrect: correct, relinkWrong: wrong, manual: res.filter((d) => d.decision === "MANUAL_REVIEW").length, newCards: res.filter((d) => d.decision === "NEW").length,
    manualReasons: tally(res.filter((d) => d.decision === "MANUAL_REVIEW").map((d) => d.reason)),
    manualSample: res.filter((d) => d.decision === "MANUAL_REVIEW").slice(0, 6).map((d, i) => ({ candidates: d.candidates.map((c) => [c.offerId, c.level, c.evidence.join("+"), c.conflicts.join("+")]) })),
  };
}

// B/C/E. Знімок постачальника (інша дата) проти поточного каталогу
if (arg("supplier")) {
  const sup = sheetObjects(arg("supplier"), "Export Products Sheet").map((r) => ({
    id: mtText(r["Унікальний_ідентифікатор"]), sku: r["Код_товару"], vendor: r["Виробник"], nameRu: r["Назва_позиції"], nameUa: r["Назва_позиції_укр"],
    gtin: r["Код_маркування_(GTIN)"], model: r["Номер_пристрою_(MPN)"], url: "",
  })).filter((o) => /^\d+$/.test(o.id));
  const supById = new Map(sup.map((o) => [o.id, o]));
  const catBySupplier = new Map(cards.map((c) => [c.supplierId, c]));
  const both = cards.filter((c) => supById.has(c.supplierId));
  const nameEq = both.filter((c) => { const o = supById.get(c.supplierId); return mtKey(o.nameUa) === mtKey(c.nameUa) && mtKey(o.nameRu) === mtKey(c.nameRu); }).length;
  const skuEq = both.filter((c) => mtSku(supById.get(c.supplierId).sku) === c.sku).length;
  const notInSnapshot = cards.filter((c) => !supById.has(c.supplierId));
  const snapshotNotInCatalog = sup.filter((o) => !catBySupplier.has(o.id));
  // Справжні зміни ID: картка, чий поточний ID відсутній у старому знімку, а там є інший ID з тим самим артикулом+брендом.
  const oldBySku = new Map();
  for (const o of snapshotNotInCatalog) { const k = brandKey(o.vendor) + "|" + mtSku(o.sku); if (mtSku(o.sku)) oldBySku.set(k, [...(oldBySku.get(k) || []), o]); }
  const idChanges = [];
  for (const c of notInSnapshot) {
    const hits = oldBySku.get(c.brand + "|" + c.sku) || [];
    if (hits.length) idChanges.push({ offerId: c.offerId, currentSupplierId: c.supplierId, oldIds: hits.map((h) => h.id), namesEqual: hits.some((h) => mtKey(h.nameUa) === mtKey(c.nameUa)) });
  }
  // Як механізм поведеться, якщо старі ID «повернуться» як невідомі offers проти карток-сиріт (поточні ID відсутні в старому знімку).
  const orphanIds = new Set(notInSnapshot.map((c) => c.offerId));
  const res = resolveUnknownOffers({ offers: snapshotNotInCatalog, cards, orphanIds });
  report.supplierSnapshot = {
    file: path.basename(arg("supplier")), offers: sup.length,
    catalogCardsFoundById: both.length, namesEqualForSameId: nameEq, skuEqualForSameId: skuEq,
    catalogCardsNotInSnapshot: notInSnapshot.length, snapshotOffersNotInCatalog: snapshotNotInCatalog.length,
    evidenceOfIdChange: { count: idChanges.length, namesEqual: idChanges.filter((x) => x.namesEqual).length, sample: idChanges.slice(0, 10) },
    resolverOnUnknownSnapshotOffers: {
      decisions: tally(res.map((d) => d.decision)),
      reasons: tally(res.filter((d) => d.decision === "MANUAL_REVIEW").map((d) => d.reason)),
      relinks: res.filter((d) => d.decision === "RELINK").slice(0, 15).map((d) => ({ oldOfferId: d.offerId, card: d.target, evidence: d.candidates[0].evidence })),
      possibleDuplicatesOfLiveCards: res.filter((d) => d.candidates.some((c) => !c.orphan && (c.level === "STRONG" || c.level === "MEDIUM"))).length,
    },
  };
}

// F. Експорт нашого магазину з Prom
if (arg("prom")) {
  const prom = sheetObjects(arg("prom"), "Export Products Sheet");
  const ours = new Map(cards.map((c) => [c.offerId, c]));
  const matched = prom.filter((p) => ours.has(mtText(p["Ідентифікатор_товару"])));
  const extra = prom.filter((p) => !ours.has(mtText(p["Ідентифікатор_товару"])));
  const extIds = prom.map((p) => mtText(p["Ідентифікатор_товару"])).filter(Boolean);
  const extDup = extIds.filter((id, i) => extIds.indexOf(id) !== i);
  // Можливі дублі: «чужі» позиції Prom з тим самим брендом+артикулом/кодом, що й наша картка.
  const bySku = new Map();
  for (const c of cards) if (c.sku) bySku.set(c.brand + "|" + c.skuLoose, [...(bySku.get(c.brand + "|" + c.skuLoose) || []), c.offerId]);
  const dupCandidates = extra.filter((p) => bySku.has(brandKey(p["Виробник"]) + "|" + looseSku(p["Код_товару"])));
  report.promExport = {
    file: path.basename(arg("prom")), rows: prom.length,
    ourCardsFound: matched.length, ourCardsMissingInProm: [...ours.keys()].filter((id) => !prom.some((p) => mtText(p["Ідентифікатор_товару"]) === id)).length,
    bySheetFound: tally(matched.map((p) => ours.get(mtText(p["Ідентифікатор_товару"])).sheet)),
    externalIdDuplicates: [...new Set(extDup)].length,
    extraRows: extra.length, extraAvailability: tally(extra.map((p) => mtText(p["Наявність"]))),
    extraNotesSample: tally(extra.map((p) => mtText(p["Особисті_нотатки"]).split(".")[0].slice(0, 40))),
    extraDuplicateCandidates: dupCandidates.length,
    extraDuplicateSample: dupCandidates.slice(0, 10).map((p) => ({ promId: mtText(p["Унікальний_ідентифікатор"]), code: mtText(p["Код_товару"]), ourIds: bySku.get(brandKey(p["Виробник"]) + "|" + looseSku(p["Код_товару"])) })),
  };
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "identity.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, (k, v) => (k === "sample" || k === "manualSample" || k === "extraDuplicateSample" ? (Array.isArray(v) ? v.slice(0, 4) : v) : v), 1).slice(0, 9000));
