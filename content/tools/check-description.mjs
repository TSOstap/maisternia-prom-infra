#!/usr/bin/env node
/**
 * Локальна перевірка чернетки опису за шаблоном T-1.0. Лише читає файли, нічого не записує.
 *
 *   node check-description.mjs <ua.html> <ru.html> [<джерело власника.txt> <рядок від> <рядок до>]
 *
 * Перевірки: дозволені теги / класи / стилі, баланс тегів, структура T-1.0, паритет UA ↔ RU (теги, кількість
 * пунктів, числа, дюйми, латинські коди), мова, розмір у байтах, SHA-256; за наявності джерела — UA = тексту власника.
 * Рішення власника 29.10.2026: заголовки блоків — жирні 16 px, жирність явна (<strong style="font-weight:bold">, бо
 * жирність лише від <strong> зникає там, де CSS його скидає); вступ у синьому блоці — без кольорових фрагментів;
 * «Технічні характеристики» — список <li><strong>Параметр:</strong> значення</li>, без таблиць.
 * З --offer і --exceptions — перевірка винятків власника: неправильні за рішенням власника значення в UA / RU = FAIL.
 * Код виходу 1, якщо є хоч один FAIL.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ALLOWED_TAGS = new Set(["div", "span", "strong", "p", "ul", "li"]);
const ALLOWED_CLASS = new Set(["ck-alert", "ck-alert__title", "ck-alert ck-alert_theme_blue"]);
// font-size:16px — на <span> заголовка; font-weight:bold — лише на <strong> заголовка (явна жирність, рішення власника 29.10)
const ALLOWED_STYLE = new Set(["font-size:16px", "font-weight:bold"]);
const ENTITIES = { quot: '"', mdash: "—", ndash: "–", middot: "·", nbsp: " ", amp: "&", lt: "<", gt: ">", laquo: "«", raquo: "»" };
const PREFIX = '<div class="ck-alert"><span class="ck-alert__title"></span>\n<div class="ck-alert ck-alert_theme_blue"><strong>';
const SUFFIX = "</ul>\n</div>\n\n<p>&nbsp;</p>";
const HEADING = /<p><span style="font-size:16px">([\s\S]*?)<\/span><\/p>/g;
const TECH_HEADINGS = new Set(["Технічні характеристики", "Технические характеристики"]);

const results = [];
const report = (level, name, detail = "") => results.push({ level, name, detail });

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const decode = (s, unknown) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  if (ENTITIES[e] !== undefined) return ENTITIES[e];
  unknown?.add(m);
  return m;
});
const textOf = (html, unknown) => decode(html.replace(/<[^>]*>/g, " "), unknown).replace(/ /g, " ").replace(/\s+/g, " ").trim();
const multiset = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
const diffSets = (a, b) => {
  const ma = multiset(a), mb = multiset(b), out = [];
  for (const k of new Set([...ma.keys(), ...mb.keys()])) if ((ma.get(k) || 0) !== (mb.get(k) || 0)) out.push(`${k}: UA ${ma.get(k) || 0} / RU ${mb.get(k) || 0}`);
  return out;
};

function tags(html, lang) {
  const list = [];
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    const [, close, rawName, rawAttrs] = m;
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) report("FAIL", `${lang}: недозволений тег`, `<${close}${rawName}>`);
    const attrs = {};
    const rest = rawAttrs.replace(/([a-zA-Z-:]+)\s*=\s*"([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; return ""; }).trim();
    if (rest && rest !== "/") report("FAIL", `${lang}: невалідні атрибути`, `<${rawName}${rawAttrs}>`);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class" && !ALLOWED_CLASS.has(v)) report("FAIL", `${lang}: недозволений class`, v);
      else if (k === "style" && !ALLOWED_STYLE.has(v)) report("FAIL", `${lang}: недозволений style`, v);
      else if (k !== "class" && k !== "style") report("FAIL", `${lang}: недозволений атрибут`, k);
    }
    if (close) {
      if (stack.pop() !== name) report("FAIL", `${lang}: незбалансовані теги`, `зайвий </${name}>`);
    } else stack.push(name);
    list.push(`${close}${name}${attrs.class ? "." + attrs.class : ""}${attrs.style ? "{" + attrs.style + "}" : ""}`);
  }
  if (stack.length) report("FAIL", `${lang}: незакриті теги`, stack.join(", "));
  return list;
}

function checkOne(html, lang) {
  if (/<script|<iframe|\son[a-z]+\s*=|\]\]>/i.test(html)) report("FAIL", `${lang}: заборонений вміст`, "script / iframe / on* / ]]>");
  if (!html.startsWith(PREFIX)) report("FAIL", `${lang}: початок не відповідає T-1.0 (сірий блок → синій блок без кольорів → <strong>назва</strong>)`);
  if (!html.trimEnd().endsWith(SUFFIX)) report("FAIL", `${lang}: кінець не відповідає T-1.0 (…</ul></div> + <p>&nbsp;</p>)`);
  if (/&nbsp;<\/li>/.test(html)) report("FAIL", `${lang}: хвостовий &nbsp; у пункті списку (Ш9)`);
  // Заголовки блоків — жирні 16 px з явним font-weight (Ш4); блок «Технічні характеристики» — лише «Параметр: значення» (Ш11)
  const headings = [...html.matchAll(HEADING)];
  const boldStyles = (html.match(/font-weight:bold/g) || []).length;
  if (boldStyles !== headings.length) report("FAIL", `${lang}: font-weight:bold дозволений лише в заголовках блоків (Ш4)`, `заголовків ${headings.length}, font-weight:bold ${boldStyles}`);
  for (const m of headings) {
    const title = /^<strong style="font-weight:bold">([^<]+)<\/strong>$/.exec(m[1]);
    if (!title) { report("FAIL", `${lang}: заголовок блоку без явної жирності <strong style="font-weight:bold"> (Ш4)`, m[1].slice(0, 80)); continue; }
    if (!TECH_HEADINGS.has(title[1].trim())) continue;
    const list = /^\s*<ul>([\s\S]*?)<\/ul>/.exec(html.slice(m.index + m[0].length));
    const items = list ? [...list[1].matchAll(/<li>[\s\S]*?<\/li>/g)].map((x) => x[0]) : [];
    if (!items.length) report("FAIL", `${lang}: після «${title[1]}» немає списку (Ш11)`);
    const bad = items.filter((li) => !/^<li><strong>[^<]+:<\/strong> [^<\s][^<]*<\/li>$/.test(li));
    if (bad.length) report("FAIL", `${lang}: пункт технічних характеристик не у форматі «<strong>Параметр:</strong> значення» (Ш11)`, bad[0].slice(0, 80));
  }
  const unknown = new Set();
  const text = textOf(html, unknown);
  if (unknown.size) report("FAIL", `${lang}: невідомі HTML-сутності`, [...unknown].join(" "));
  const bodyText = html.replace(/<[^>]*>/g, "");
  const raw = [...new Set(bodyText.match(/["'—–·]/g) || [])];
  if (raw.length) report("WARN", `${lang}: символи без сутностей (Ш7)`, raw.join(" "));
  return { text, tags: tags(html, lang), bytes: Buffer.byteLength(html, "utf8"), sha: sha(html) };
}

const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => { const [k, ...v] = a.slice(2).split("="); return [k, v.join("=")]; }));
const [uaPath, ruPath, ownerPath, from, to] = argv.filter((a) => !a.startsWith("--"));
if (!uaPath || !ruPath) {
  console.error("Використання: node check-description.mjs <ua.html> <ru.html> [<джерело.txt> <рядок від> <рядок до>] [--offer=<Offer ID> --exceptions=<винятки-власника.json>]");
  process.exit(2);
}
const ua = readFileSync(uaPath, "utf8");
const ru = readFileSync(ruPath, "utf8");
const U = checkOne(ua, "UA");
const R = checkOne(ru, "RU");

// Паритет структури
if (U.tags.join("|") !== R.tags.join("|")) {
  const i = U.tags.findIndex((t, k) => t !== R.tags[k]);
  report("FAIL", "UA ↔ RU: різна послідовність тегів", `позиція ${i}: UA ${U.tags[i]} / RU ${R.tags[i]}`);
} else report("PASS", "UA ↔ RU: однакова послідовність тегів", `${U.tags.length} тегів`);
const li = (t) => t.filter((x) => x === "li").length;
report(li(U.tags) === li(R.tags) ? "PASS" : "FAIL", "UA ↔ RU: кількість пунктів списків", `UA ${li(U.tags)} / RU ${li(R.tags)}`);

// Числа, дюйми, латинські коди
const nums = (t) => t.match(/\d+(?:[.,]\d+)?/g) || [];
const inches = (h) => h.match(/\d+(?:\/\d+)?&quot;/g) || [];
const latin = (t) => t.match(/[A-Za-z0-9]*[A-Za-z][A-Za-z0-9-]*/g) || [];
for (const [name, a, b] of [["числа", nums(U.text), nums(R.text)], ["дюйми", inches(ua), inches(ru)], ["латинські коди / бренди", latin(U.text), latin(R.text)]]) {
  const d = diffSets(a, b);
  report(d.length ? "FAIL" : "PASS", `UA ↔ RU: ${name}`, d.length ? d.join("; ") : `${a.length} збігів`);
}

// Мова
const uaBad = U.text.match(/[ыэъёЫЭЪЁ]/g);
const ruBad = R.text.match(/[іїєґІЇЄҐ]/g);
report(uaBad ? "FAIL" : "PASS", "UA: без російських літер", uaBad ? [...new Set(uaBad)].join(" ") : "");
report(ruBad ? "FAIL" : "PASS", "RU: без українських літер", ruBad ? [...new Set(ruBad)].join(" ") : "");

// Відповідність тексту власника
if (ownerPath) {
  const lines = readFileSync(ownerPath, "utf8").split(/\r?\n/).slice(Number(from) - 1, Number(to));
  const ownerHtml = lines.filter((l) => !/Технічні дані: \(якщо потрібно залишити/.test(l)).join("\n");
  const o = textOf(ownerHtml), u = U.text;
  if (o === u) report("PASS", "UA = текст власника (слово в слово)", `${u.split(" ").length} слів`);
  else {
    const ow = o.split(" "), uw = u.split(" ");
    const i = ow.findIndex((w, k) => w !== uw[k]);
    report("FAIL", "UA ≠ текст власника", `перша різниця, слово ${i}: власник «${ow.slice(i, i + 6).join(" ")}» / чернетка «${uw.slice(i, i + 6).join(" ")}»`);
  }
}

// Винятки власника (правило 29.10): значення, які власник назвав неправильними, не можуть бути в описі — інакше FAIL,
// опис не затверджується до рішення власника. Файл винятків — поза Git (реальні дані товарів).
if (flags.offer || flags.exceptions) {
  if (!flags.offer || !flags.exceptions) report("FAIL", "винятки власника: потрібні обидва параметри --offer і --exceptions");
  else {
    const list = JSON.parse(readFileSync(flags.exceptions, "utf8")).exceptions || [];
    const ex = list.filter((e) => String(e.offerId) === String(flags.offer));
    if (!ex.length) report("PASS", "винятки власника", `для ${flags.offer} у файлі винятків записів немає`);
    for (const e of ex) {
      report("INFO", `виняток власника ${e.offerId}`, `${e.status}: ${e.ownerStatement}`);
      for (const w of e.wrong || []) {
        if (!w.pattern) continue;
        const re = new RegExp(w.pattern, "iu");
        for (const [lang, t] of [["UA", U.text], ["RU", R.text]]) {
          const m = re.exec(t);
          if (m) report("FAIL", `${lang}: суперечність із винятком власника (${w.subject})`, `у тексті «${t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)}»; власник: ${e.ownerStatement}`);
        }
      }
    }
  }
}

console.log(`UA: ${U.bytes} байт, SHA-256 ${U.sha}`);
console.log(`RU: ${R.bytes} байт, SHA-256 ${R.sha}`);
console.log(`Разом: ${U.bytes + R.bytes} байт`);
for (const r of results) console.log(`[${r.level}] ${r.name}${r.detail ? " — " + r.detail : ""}`);
const fails = results.filter((r) => r.level === "FAIL").length;
console.log(fails ? `ПІДСУМОК: FAIL (${fails})` : "ПІДСУМОК: PASS");
process.exit(fails ? 1 : 0);
