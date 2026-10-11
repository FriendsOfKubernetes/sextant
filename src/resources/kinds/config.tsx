// Config: ConfigMaps, Secrets, ResourceQuotas, LimitRanges, HPA, PodDisruptionBudgets, PriorityClasses.
import { column, labelsColumn, standardColumns, StatusList } from "../columns";
import { registerResource } from "../registry";
import { arr, get, keyCount, num, str, trueConditions } from "../status";

const keysColumn = column("keys", (o) => keyCount(get(o, "data"), get(o, "binaryData")).join(", "), {
  width: "minmax(160px, 3fr)",
});

registerResource({
  kind: { group: "", version: "v1", kind: "ConfigMap" },
  sidebar: { section: "config", order: 10, labelKey: "resources:kinds.configmaps" },
  columns: standardColumns(true, keysColumn),
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: "", version: "v1", kind: "Secret" },
  sidebar: { section: "config", order: 20, labelKey: "resources:kinds.secrets" },
  columns: standardColumns(
    true,
    labelsColumn,
    column("keys", (o) => keyCount(get(o, "data")).join(", "), { width: "minmax(140px, 2fr)" }),
    column("type", (o) => str(get(o, "type")), { width: "minmax(140px, 1.5fr)" }),
  ),
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: "", version: "v1", kind: "ResourceQuota" },
  sidebar: { section: "config", order: 30, labelKey: "resources:kinds.resourcequotas" },
  columns: standardColumns(true),
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: "", version: "v1", kind: "LimitRange" },
  sidebar: { section: "config", order: 40, labelKey: "resources:kinds.limitranges" },
  columns: standardColumns(true),
  actions: ["edit", "delete"],
});

/** "cpu 45%/80%" style summary of an HPA's metrics (autoscaling/v2). */
function hpaMetrics(o: unknown): string {
  const current = arr(get(o, "status", "currentMetrics"));
  return arr(get(o, "spec", "metrics"))
    .map((m, i) => {
      const name = str(get(m, "resource", "name")) ?? str(get(m, "type")) ?? "";
      const target =
        num(get(m, "resource", "target", "averageUtilization")) ??
        str(get(m, "resource", "target", "averageValue")) ??
        str(get(m, "resource", "target", "value"));
      const now =
        num(get(current[i], "resource", "current", "averageUtilization")) ??
        str(get(current[i], "resource", "current", "averageValue"));
      const pct = typeof target === "number" ? "%" : "";
      return `${name} ${now ?? "?"}${now !== undefined ? pct : ""}/${target ?? "?"}${pct}`;
    })
    .join(", ");
}

registerResource({
  kind: { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" },
  sidebar: { section: "config", order: 50, labelKey: "resources:kinds.horizontalpodautoscalers" },
  columns: [
    ...standardColumns(
      true,
      column("metrics", hpaMetrics, { width: "minmax(140px, 2fr)" }),
      column("minPods", (o) => num(get(o, "spec", "minReplicas")) ?? 1, { width: "80px" }),
      column("maxPods", (o) => num(get(o, "spec", "maxReplicas")), { width: "80px" }),
      column("replicas", (o) => num(get(o, "status", "currentReplicas")), { width: "80px" }),
    ),
    column("status", (o) => trueConditions(o).join(" "), {
      width: "minmax(140px, 1.5fr)",
      render: (o) => <StatusList values={trueConditions(o)} />,
    }),
  ],
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: "policy", version: "v1", kind: "PodDisruptionBudget" },
  sidebar: { section: "config", order: 60, labelKey: "resources:kinds.poddisruptionbudgets" },
  columns: standardColumns(
    true,
    column("minAvailable", (o) => String(get(o, "spec", "minAvailable") ?? "N/A"), { width: "100px" }),
    column("maxUnavailable", (o) => String(get(o, "spec", "maxUnavailable") ?? "N/A"), { width: "110px" }),
    column("currentHealthy", (o) => num(get(o, "status", "currentHealthy")) ?? 0, { width: "110px" }),
    column("desiredHealthy", (o) => num(get(o, "status", "desiredHealthy")) ?? 0, { width: "110px" }),
  ),
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: "scheduling.k8s.io", version: "v1", kind: "PriorityClass" },
  sidebar: { section: "config", order: 70, labelKey: "resources:kinds.priorityclasses" },
  namespaced: false,
  columns: standardColumns(
    false,
    column("value", (o) => num(get(o, "value")), { width: "110px" }),
    column("globalDefault", (o) => String(get(o, "globalDefault") === true), { width: "110px" }),
  ),
  actions: ["edit", "delete"],
});
