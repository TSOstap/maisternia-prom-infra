/** Стан A — до активації FZ (FZ-HERMES-08 п. 2). Після локальної заміни кореневого контракту захисту на rev 5 з requiresFrozenAttrs
 *  старі тести, що брали типовий контракт репозиторію, явно задають прийнятий rev 4 (байтова копія schemas/prom/freeze-contract.json
 *  із 1961ef9; без Offer ID) і стан без переліку захищених / без FZ — як у їхньому ізольованому прогоні. Assertions не змінюються. */
import { fileURLToPath } from "node:url";

export const STATE_A_CONTRACT = fileURLToPath(new URL("../fixtures/freeze-contract-rev4.json", import.meta.url));
export const STATE_A = Object.freeze({ freezeContractFile: STATE_A_CONTRACT, freezeFile: "", frozenAttrsFile: "" });
