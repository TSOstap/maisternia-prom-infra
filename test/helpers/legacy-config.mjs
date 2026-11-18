/** Конфігурація СТАРОГО режиму (глобальний паспорт / печатки) — лише для регресійних тестів прийнятої механіки синхронізації, intake і YML.
 *
 *  Рішення власника 29–30.10: пріоритет власника — типова й обов'язкова поведінка (owner-priority.mjs `enabled`: увімкнено, якщо явно
 *  не вимкнено). Робочі точки запуску (src/cli.mjs, tools/sheet-sync.mjs) старий режим відхиляють (production.mjs `productionConfig`).
 *  Ці тести перевіряють спільну механіку (ціни, черга, прив'язки, журнал, D1/D1b, FZ, OV тощо), записану до рішення, тому явно
 *  вмикають старий режим. Нові вимоги (ручні правки не блокують каталог, CC обов'язковий) — у тестах режиму пріоритету власника. */
import base from "../../config/default.json" with { type: "json" };

const legacy = structuredClone(base);
legacy.ownerPriority = { enabled: false };
// Рішення власника 18.11 (№ 87): робочий конфіг — ціни без копійок (pricing.whole). Регресія прийнятої механіки й паритет із LIVE
// (Apps Script, ціни з копійками) — на старій формулі; цілі ціни й перехідний стан фіду — test/whole-prices.test.mjs.
legacy.pricing = { ...legacy.pricing, whole: false };
export default legacy;
