#!/usr/bin/env node
/** Схеми категорій Prom (лише локальні файли; мережі немає).
 *   node tools/prom-schemas.mjs import <файл.xml|txt> [...]  — додати / оновити схеми у schemas/prom і MANIFEST.json
 *   node tools/prom-schemas.mjs check                         — перевірити SHA і структуру всіх схем із MANIFEST */
import { importSchemaFiles, loadPromCatalog, readManifest } from "../src/pipeline/prom-schemas.mjs";

const [cmd, ...files] = process.argv.slice(2);
if (cmd === "import" && files.length) {
  const report = importSchemaFiles(files);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.some((r) => ["ПОМИЛКИ", "НЕМАЄ КАТЕГОРІЙ", "КОНФЛІКТ"].includes(r.status)) ? 1 : 0;
} else if (cmd === "check") {
  const c = loadPromCatalog();
  console.log(JSON.stringify({ inManifest: (readManifest().categories || []).length, loaded: c.schemas.size, mappings: c.mappings.size, unitConversions: (c.units.conversions || []).length, problems: c.problems }, null, 2));
  process.exitCode = c.problems.length ? 1 : 0;
} else {
  console.error("Використання: node tools/prom-schemas.mjs import <файл...> | check");
  process.exitCode = 2;
}
