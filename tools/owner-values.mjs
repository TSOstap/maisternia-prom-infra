#!/usr/bin/env node
/** Рішення власника щодо характеристик (лише локальні файли; мережі немає).
 *   node tools/owner-values.mjs index <файл рішень>  — оновити перелік schemas/prom/owner-values-index.json (назви без значень)
 *   node tools/owner-values.mjs check <файл рішень>  — перевірити файл і його відповідність переліку в репозиторії
 *  Значення рішень лишаються у файлі поза репозиторієм; у перелік потрапляють лише Offer ID, модель і назви характеристик —
 *  щоб без файлу генератор утримував ці характеристики, а не повертав дані постачальника. */
import fs from "node:fs";
import path from "node:path";
import { SCHEMAS_DIR, loadOwnerValues, loadPromCatalog, ownerIndexOf, ownerRequiredProblem } from "../src/pipeline/prom-schemas.mjs";

const [cmd, file] = process.argv.slice(2);
const INDEX = path.join(SCHEMAS_DIR, "owner-values-index.json");
if (!["index", "check"].includes(cmd) || !file) {
  console.error("Використання: node tools/owner-values.mjs index|check <файл рішень власника>");
  process.exitCode = 2;
} else {
  const ov = loadOwnerValues(file);
  if (cmd === "index") {
    if (ov.problems.length) { console.error(JSON.stringify(ov.problems, null, 2)); process.exitCode = 1; }
    else {
      const products = ownerIndexOf(ov);
      // OV (R1): обов'язкова прив'язка до прийнятого файлу — ревізія й відбиток усього вмісту products (значення теж).
      // F1: некоректна прив'язка (rev < 1 / не ціле, 0 товарів / записів, без дати) не записується — довірений перелік лишається як був.
      const required = { rev: ov.rev, date: ov.date, fingerprint: ov.fingerprint, products: ov.productCount, items: ov.rawItems };
      const bad = ownerRequiredProblem(required) || (!Object.keys(products).length ? "0 товарів із рішеннями" : "");
      if (bad) { console.error(`обов'язкову прив'язку (required) не створено: ${bad} (rev ${ov.rev}, товарів ${ov.productCount}, записів ${ov.rawItems}) — перелік не змінено`); process.exitCode = 1; }
      else {
        const index = { required, _note: "Перелік товарів і характеристик із підтвердженими рішеннями власника — БЕЗ значень (значення — у файлі поза репозиторієм, змінна MM_OWNER_VALUES). Якщо файл рішень відсутній, пошкоджений або не містить запису з переліку, генератор не передає значення постачальника для цих характеристик і не прибирає наявних — утримує й позначає ПОТРЕБУЄ ПЕРЕВІРКИ. Формат v2: required обов'язковий (OV, R1/F1) — файл рішень обов'язковий: не задано / відсутній / пошкоджений / інша ревізія / інший відбиток вмісту, а також перелік без required — прохід НЕ ВИКОНАНО (тип OV). Оновлюється разом із файлом: node tools/owner-values.mjs index <файл>.", v: 2, date: ov.date, products };
        fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + "\n");
        console.log(JSON.stringify({ written: path.relative(process.cwd(), INDEX), products: ov.map.size, items: ov.items, required }));
      }
    }
  } else {
    const c = loadPromCatalog(undefined, { ownerValuesFile: file });
    const problems = c.problems.filter((p) => /рішення власника|рішень власника/.test(p));
    console.log(JSON.stringify({ file: path.basename(file), date: ov.date, products: ov.map.size, items: ov.items, indexProducts: c.ownerIndex.size, indexItems: [...c.ownerIndex.values()].reduce((n, p) => n + p.items.length, 0), problems }, null, 2));
    process.exitCode = problems.length ? 1 : 0;
  }
}
