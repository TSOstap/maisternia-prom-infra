/** Стан A — до активації FZ (FZ-HERMES-08 п. 2). Після локальної заміни кореневого контракту захисту на rev 5 з requiresFrozenAttrs
 *  старі тести, що брали типовий контракт репозиторію, явно задають прийнятий rev 4 (байтова копія schemas/prom/freeze-contract.json
 *  із 1961ef9; без Offer ID) і стан без переліку захищених / без FZ — як у їхньому ізольованому прогоні; OV (R1) — прийнятий перелік рішень без required. Assertions не змінюються. */
import { fileURLToPath } from "node:url";

export const STATE_A_CONTRACT = fileURLToPath(new URL("../fixtures/freeze-contract-rev4.json", import.meta.url));
/** OV (R1): прийнятий перелік рішень власника з 1961ef9 / 21999bd — БЕЗ обов'язкової прив'язки required (байтова копія, формат v1, без значень);
 *  F1: формат v1 приймається лише явно (ownerIndexLegacy: true) — для історичних фікстур стану до OV; без нього — блокер OV;
 *  у стані A файл рішень не підключається (ownerValuesFile ""), як в ізольованому прогоні, — локальний MM_OWNER_VALUES іншої ревізії
 *  не звіряється зі старим переліком. Реальні рішення власника перевіряють окремі локальні тести з явним файлом. */
export const OWNER_INDEX_A = fileURLToPath(new URL("../fixtures/owner-values-index-legacy.json", import.meta.url));
export const STATE_A = Object.freeze({ freezeContractFile: STATE_A_CONTRACT, freezeFile: "", frozenAttrsFile: "", ownerValuesIndexFile: OWNER_INDEX_A, ownerIndexLegacy: true, ownerValuesFile: "" });
