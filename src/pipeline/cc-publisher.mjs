/** CC R6 §6 п. 3: publisher «cc-publisher-v2» для перевірки готовності Catalog Controls (checkReadiness).
 *
 *  renderProbe({ rows, groups, manifest, meta, config, ccState }) → текст YML — ТОЙ САМИЙ шлях, що й робочий запуск (update.mjs):
 *    ccState → controlsFromState (та сама проєкція, що в адаптері CC) → buildYml з feedBuildOptions (ті самі параметри, режим
 *    пріоритету власника) → candidateGuard (та сама перевірка кандидата перед публікацією).
 *  Очікування CC: знятий → available="false"; без зняття → "true"; видалений → жодного <offer>, сусідній — "true"; blocked → виняток.
 *  Нічого не пише (пам'ять). config — робочий config (ціни, політики, ліміт фіду); probe-config CC — це config.yml. */
import { buildYml, memorySink } from "../core/yml.mjs";
import { controlsFromState } from "./controls-adapter.mjs";
import { feedBuildOptions, candidateGuard } from "./update.mjs";

export const CC_PUBLISHER_CONTRACT = "cc-publisher-v2";
const PROBE_FEED = Object.freeze({ name: "cc-readiness-probe", maximumBytes: 5_000_000 });

export function ccPublisher({ config = {} } = {}) {
  return Object.freeze({
    contract: CC_PUBLISHER_CONTRACT,
    async renderProbe({ rows, groups, manifest, meta, config: ymlConfig, ccState }) {
      const controls = controlsFromState(ccState);
      const sink = memorySink();
      await buildYml({
        rows, groups, manifest, sink, meta,
        ...feedBuildOptions({ config: { ...config, yml: ymlConfig }, feed: PROBE_FEED, controls, lastGood: new Map(), ownerPriority: true }),
      });
      const xml = sink.text();
      candidateGuard(controls)(xml);
      return xml;
    },
  });
}

/** Повний набір готовності для CC: { publisher, committer, store } — committer / store з того самого шлюзу запису (W2, Р7). */
export function engineeringReadiness(gateway, { config = {} } = {}) {
  return { ...gateway.ccReadiness(), publisher: ccPublisher({ config }) };
}
