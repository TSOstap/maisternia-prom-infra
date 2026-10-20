/** Синтетичний каталог і фід постачальника. Жодних реальних товарів/цін: тільки форма даних.
 *  Розміри полів підібрані так, щоб один offer у YML займав ≈ 9,7 КБ (як 49 МБ / 5029 у чинному фіді). */
import { YML_HEADERS, GROUP_HEADERS, rowSeal, SEAL_COLUMN } from "../core/seal.mjs";
import { mtPrices, DEFAULT_PRICING } from "../core/pricing.mjs";
import { approvalManifest } from "../core/seal.mjs";
import { formatYmlDate } from "../core/time.mjs";
import { xmlEscape } from "../core/yml.mjs";

export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UA = "дриль шуруповерт акумулятор потужність обороти патрон крутний момент корпус редуктор щітки двигун швидкість робота металу деревини бетону свердління кріплення комплект кейс зарядний пристрій режим регулювання захист перевантаження вага габарити гарантія виробник модель серія".split(" ");
const RU = "дрель шуруповерт аккумулятор мощность обороты патрон крутящий момент корпус редуктор щетки двигатель скорость работа металла древесины бетона сверление крепление комплект кейс зарядное устройство режим регулировка защита перегрузки вес габариты гарантия производитель модель серия".split(" ");
const BRANDS = ["ALPHA", "BETA", "GAMMA", "DELTA", "OMEGA", "SIGMA", "KAPPA", "ZETA"];

function words(rand, dict, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(dict[Math.floor(rand() * dict.length)]);
  return out.join(" ");
}
function html(rand, dict, chars) {
  const parts = [];
  let size = 0;
  while (size < chars) {
    const p = "<p>" + words(rand, dict, 18 + Math.floor(rand() * 14)) + ".</p>";
    parts.push(p);
    size += p.length;
  }
  return parts.join("");
}

/** Групи: 2 рівні, детерміновані ID. */
function makeGroups(count) {
  const values = [GROUP_HEADERS.slice()];
  const roots = Math.max(1, Math.round(count / 10));
  for (let i = 0; i < count; i++) {
    const id = String(800000 + i);
    const parent = i < roots ? "" : String(800000 + (i % roots));
    values.push([id, "Група " + i, "Группа " + i, parent]);
  }
  return values;
}

/**
 * @param o { products, queue, deferred, newOffers, seed, now (ms), groups, missingFromSupplier, identityConflicts }
 * @returns { sheets, groups, offers, supplierXml(), manifestMain, stamp }
 */
export function generateSynthetic(o) {
  const rand = prng(o.seed ?? 1);
  const groupCount = o.groups ?? 120;
  const groups = makeGroups(groupCount);
  const previousStamp = new Date(o.now - 4 * 3600000).toISOString();
  const total = o.products + (o.queue || 0) + (o.deferred || 0);
  const sheets = { "Основний каталог": [YML_HEADERS.slice()], "Нові товари": [YML_HEADERS.slice()], "Відкладені товари": [YML_HEADERS.slice()] };
  const offers = [];
  const missing = new Set(o.missingFromSupplier || []);
  const conflicts = new Set(o.identityConflicts || []);

  for (let n = 0; n < total; n++) {
    const id = String(1500000000 + n * 7);
    const brand = BRANDS[n % BRANDS.length];
    const sku = brand.slice(0, 2) + "-" + (1000 + n);
    const supplierUa = `${words(rand, UA, 3)} ${brand} ${sku}`;
    const supplierRu = `${words(rand, RU, 3)} ${brand} ${sku}`;
    const price = Math.round((150 + rand() * 20000) * 100) / 100;
    const available = rand() < 0.45;
    const groupId = groups[1 + (n % groupCount)][0];
    const sheet = n < o.products ? "Основний каталог" : n < o.products + (o.queue || 0) ? "Нові товари" : "Відкладені товари";
    const p = mtPrices(price, available, DEFAULT_PRICING);
    const photos = Array.from({ length: 4 + (n % 5) }, (_, i) => `https://images.prom.ua/${3700000000 + n * 10 + i}_tovar-${n}.jpg`);
    const params = Array.from({ length: 10 + (n % 9) }, (_, i) => ({ name: "Параметр " + i, value: String(Math.round(rand() * 1000)), unit: i % 3 ? "мм" : "" }));
    const row = {
      "Offer ID": id, "ID постачальника": id, "Артикул постачальника": sku,
      "Назва UA": `${brand} ${sku} — ${words(rand, UA, 6)}`, "Назва RU": `${brand} ${sku} — ${words(rand, RU, 6)}`,
      "Ціна постачальника": price, "Ціна": p.base, "Ціна кінцева": p.final, "Знижка": p.discount, "Наявність": p.availability,
      "Кількість постачальника": "", "Стан синхронізації": "ЗІСТАВЛЕНО", "Оновлено": previousStamp, "Валюта": "UAH",
      "Опис UA": html(rand, UA, 1650), "Опис RU": html(rand, RU, 1650),
      "Фото JSON": JSON.stringify(photos), "Характеристики JSON": JSON.stringify(params),
      "Група ID": groupId, "Група UA": "Група", "Група RU": "Группа", "Категорія Prom ID": String(500 + (n % 50)),
      "Категорія Prom URL": n % 4 ? `https://prom.ua/Kategoriya-${n % 50}` : "",
      "GTIN": "", "Виробник": brand, "Країна": n % 3 ? "" : "Україна",
      "Запити UA": words(rand, UA, 40).slice(0, 380), "Запити RU": words(rand, RU, 40).slice(0, 380),
      "Назва постачальника UA": supplierUa, "Назва постачальника RU": supplierRu,
      "URL постачальника": `https://market-tools.com.ua/p${id}-tovar.html`, "Модель": sku,
      "Джерело контенту": "SYNTHETIC", "SHA256 контенту": "", "Унікальний ID Prom": "", "Код товару Prom": n % 2 ? "MT-" + id : "",
      "Існує у Prom": "", "Статус імпорту": "ДОЗВОЛЕНО", "Поля Prom JSON": "{}", [SEAL_COLUMN]: "",
    };
    row[SEAL_COLUMN] = rowSeal(row);
    sheets[sheet].push(YML_HEADERS.map((k) => row[k]));
    if (sheet !== "Відкладені товари" && !missing.has(id)) {
      // Постачальник трохи змінює ціни/наявність між запусками.
      const nextPrice = rand() < 0.1 ? Math.round(price * (0.95 + rand() * 0.1) * 100) / 100 : price;
      const nameRu = conflicts.has(id) ? supplierRu + " NEW" : supplierRu;
      offers.push({ id, available: rand() < 0.1 ? !available : available, price: nextPrice, sku, nameUa: supplierUa, nameRu, url: row["URL постачальника"] });
    }
  }
  for (let k = 0; k < (o.newOffers || 0); k++) {
    const id = String(2900000000 + k * 13);
    offers.push({ id, available: true, price: 999 + k, sku: "NEW-" + k, nameUa: "Новий товар " + k, nameRu: "Новый товар " + k, url: `https://market-tools.com.ua/p${id}-new.html` });
  }

  const supplierXml = () => {
    const head = `<?xml version="1.0" encoding="UTF-8"?>\n<yml_catalog date="${formatYmlDate(o.now - 15 * 60000, "Europe/Kyiv")}"><shop><name>Supplier</name><currencies><currency id="UAH" rate="1"/></currencies><categories><category id="1">Інструменти</category></categories><offers>`;
    const body = offers.map((x) => `<offer id="${x.id}" available="${x.available}"><url>${xmlEscape(x.url)}</url><price>${x.price}</price><currencyId>UAH</currencyId><categoryId>1</categoryId><name>${xmlEscape(x.nameRu)}</name><name_ua>${xmlEscape(x.nameUa)}</name_ua><vendorCode>${xmlEscape(x.sku)}</vendorCode><quantity_in_stock></quantity_in_stock></offer>`);
    return head + "\n" + body.join("\n") + "\n</offers></shop></yml_catalog>\n";
  };

  const mainRows = sheets["Основний каталог"].slice(1).map((r) => Object.fromEntries(YML_HEADERS.map((k, i) => [k, r[i]])));
  const groupRows = groups.slice(1).map((g) => Object.fromEntries(GROUP_HEADERS.map((k, i) => [k, g[i]])));
  const manifestMain = { ...approvalManifest(mainRows, groupRows), ids: mainRows.map((r) => r["Offer ID"]).sort(), approvedBy: "SYNTHETIC" };
  return { sheets, groups, offers, supplierXml, manifestMain };
}
