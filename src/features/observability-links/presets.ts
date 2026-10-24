// Ready templates for common dashboards and trace searches (#266). The kube-prometheus-stack dashboards come from the
// Kubernetes mixin (github.com/kubernetes-monitoring/kubernetes-mixin), whose `config.libsonnet` sets every
// dashboard's uid to `std.md5(<file name>)` — the same in every installation — and whose dashboards take the variables
// `namespace`, `pod`, `type` (the lowercase workload kind of the `workload_type` label), `workload` and `node`.
// Grafana Explore presets name a data source by uid (`loki`, `tempo`); an installation that gave its data source
// another uid edits the template.
import type { Target } from "./template";

export interface Preset {
  id: string;
  target: Target;
  template: string;
}

/** Dashboard uids of the Kubernetes mixin: `md5("k8s-resources-<name>.json")`. */
export const MIXIN_UIDS = {
  pod: "6581e46e4e5c7ba40a07646395ef7b23",
  workload: "a164a7f0339f99e89cea5cb47e9be617",
  node: "200ac8fdbfbb74b39aff88118e4d1c2c",
  namespace: "85a562078cdf77779eaa1add43ccec1e",
} as const;

const RANGE = "from={from}&to={to}";

const PLACEHOLDER_ENCODED = /%7B([a-z]+)%7D/g;

/**
 * A Grafana Explore path of one query: the `panes` parameter is JSON, URL-encoded as a whole, with the placeholders
 * left as `{variable}` (a literal brace of the query stays encoded, so it is never read as a placeholder).
 */
export function explorePath(datasource: { type: string; uid: string }, query: Record<string, string>): string {
  const panes = {
    a: {
      datasource: datasource.uid,
      queries: [{ refId: "A", datasource, ...query }],
      range: { from: "{from}", to: "{to}" },
    },
  };
  const encoded = encodeURIComponent(JSON.stringify(panes)).replace(PLACEHOLDER_ENCODED, "{$1}");
  return `/explore?schemaVersion=1&orgId=1&panes=${encoded}`;
}

export const PRESETS: readonly Preset[] = [
  {
    id: "mixinWorkload",
    target: "workload",
    template: `/d/${MIXIN_UIDS.workload}?var-namespace={namespace}&var-type={kind}&var-workload={name}&${RANGE}`,
  },
  { id: "mixinPod", target: "pod", template: `/d/${MIXIN_UIDS.pod}?var-namespace={namespace}&var-pod={pod}&${RANGE}` },
  {
    id: "lokiPod",
    target: "pod",
    template: explorePath(
      { type: "loki", uid: "loki" },
      { expr: '{namespace="{namespace}", pod="{pod}"}', queryType: "range" },
    ),
  },
  { id: "mixinNode", target: "node", template: `/d/${MIXIN_UIDS.node}?var-node={node}&${RANGE}` },
  { id: "mixinNamespace", target: "namespace", template: `/d/${MIXIN_UIDS.namespace}?var-namespace={namespace}&${RANGE}` },
  {
    id: "mixinEdge",
    target: "edge",
    template: `/d/${MIXIN_UIDS.workload}?var-namespace={namespace}&var-type=%24__all&var-workload={destination}&${RANGE}`,
  },
  {
    id: "tempo",
    target: "traces",
    template: explorePath(
      { type: "tempo", uid: "tempo" },
      { query: '{resource.service.name="{service}"}', queryType: "traceql" },
    ),
  },
  // Jaeger's UI takes microseconds: three zeros after the milliseconds.
  { id: "jaeger", target: "traces", template: "/search?service={service}&start={from}000&end={to}000&lookback=custom&limit=20" },
];

export function presetsFor(target: Target): Preset[] {
  return PRESETS.filter((p) => p.target === target);
}
