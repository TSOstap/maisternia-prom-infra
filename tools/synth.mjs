/** Генерація синтетичного набору на диск.
 *  node tools/synth.mjs --products=5029 --queue=92 --deferred=10 --new=25 --out=.data/synth-5k [--seed=1] [--now=ISO]
 *  Пише: <out>/catalog (знімок аркушів), <out>/supplier.xml, <out>/approved-main.json */
import fsp from "node:fs/promises";
import path from "node:path";
import { generateSynthetic } from "../src/synth/generator.mjs";
import { writeCatalogSnapshot } from "../src/pipeline/sources.mjs";

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const out = path.resolve(arg("out", ".data/synth"));
const now = arg("now") ? Date.parse(arg("now")) : Date.now();
const opts = {
  products: Number(arg("products", 5029)), queue: Number(arg("queue", 0)), deferred: Number(arg("deferred", 0)),
  newOffers: Number(arg("new", 0)), seed: Number(arg("seed", 1)), groups: Number(arg("groups", 300)), now,
};
const started = Date.now();
const s = generateSynthetic(opts);
await fsp.mkdir(out, { recursive: true });
await writeCatalogSnapshot(path.join(out, "catalog"), { sheets: s.sheets, groups: s.groups });
await fsp.writeFile(path.join(out, "supplier.xml"), s.supplierXml());
await fsp.writeFile(path.join(out, "approved-main.json"), JSON.stringify(s.manifestMain));
console.log(JSON.stringify({ out, ...opts, supplierOffers: s.offers.length, ms: Date.now() - started }));
