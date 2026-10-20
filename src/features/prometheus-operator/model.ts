// What the Prometheus Operator section reads from monitoring.coreos.com objects: the kinds it knows; for a
// ServiceMonitor or PodMonitor, the namespaces it looks in, its selector and endpoints; whether a Prometheus (or a
// PrometheusAgent) picks a monitor, a rule or a probe up by its selectors; a PrometheusRule's groups and rules; and the
// readiness of Prometheus and Alertmanager from their conditions. Pure functions, no React. Selectors are the resource
// map's (src/features/resource-map/selectors.ts), so a label selector means the same here as everywhere else.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import type { Detected } from "../problems/model";
import { labelSelector, matches, NOTHING, type Labels, type Selector } from "../resource-map/selectors";

const { arr, get, labelsOf, num, str } = status;

export const MONITORING_GROUP = "monitoring.coreos.com";
const k = (kind: string, version = "v1"): KindRef => ({
  group: MONITORING_GROUP,
  version,
  kind,
});

export const SERVICE_MONITOR = k("ServiceMonitor");
export const POD_MONITOR = k("PodMonitor");
export const PROBE = k("Probe");
export const PROMETHEUS_RULE = k("PrometheusRule");
export const PROMETHEUS = k("Prometheus");
export const ALERTMANAGER = k("Alertmanager");
/** Not listed in the section; read only to tell whether a monitor is picked up. */
export const PROMETHEUS_AGENT = k("PrometheusAgent", "v1alpha1");

export interface MonitoringKind {
  kind: KindRef;
  order: number;
  /** Key under `prometheusoperator:sidebar`. */
  label: string;
}

export const MONITORING_KINDS: MonitoringKind[] = [
  { kind: SERVICE_MONITOR, order: 10, label: "serviceMonitors" },
  { kind: POD_MONITOR, order: 11, label: "podMonitors" },
  { kind: PROBE, order: 12, label: "probes" },
  { kind: PROMETHEUS_RULE, order: 20, label: "prometheusRules" },
  { kind: PROMETHEUS, order: 30, label: "prometheuses" },
  { kind: ALERTMANAGER, order: 31, label: "alertmanagers" },
];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

export const monitoringKind = (kind: Pick<KindRef, "group" | "kind">): MonitoringKind | undefined =>
  MONITORING_KINDS.find((d) => isKind(kind, d.kind));

// ---------- Monitors ----------

/** Where a monitor looks: every namespace (`any: true`), the names it lists, else its own namespace. */
export type TargetNamespaces = { type: "any" } | { type: "list"; names: string[] };

/**
 * A Prometheus (or PrometheusAgent) with `spec.ignoreNamespaceSelectors: true` ignores the `spec.namespaceSelector` of
 * every ServiceMonitor, PodMonitor and Probe it picks up: they find targets in their own namespace only
 * (`getNamespacesFromNamespaceSelector`, pkg/prometheus/promcfg.go). Which monitors it picks up is not affected.
 */
export const ignoresNamespaceSelectors = (prom: KubeObject): boolean => get(prom, "spec", "ignoreNamespaceSelectors") === true;

/**
 * Where a monitor looks for targets. `pickedBy`, when known, are the Prometheus objects that pick it up: if every one
 * ignores namespace selectors, its own namespace only; if some do, its own namespace too.
 */
export function targetNamespaces(monitor: KubeObject, pickedBy?: readonly KubeObject[]): TargetNamespaces {
  const own = monitor.metadata?.namespace ?? "";
  const ignoring = pickedBy?.filter(ignoresNamespaceSelectors).length ?? 0;
  if (pickedBy && ignoring > 0 && ignoring === pickedBy.length) return { type: "list", names: [own] };
  const fromSpec = specNamespaces(monitor);
  if (ignoring === 0 || fromSpec.type === "any") return fromSpec;
  return { type: "list", names: [...new Set([...fromSpec.names, own])].sort() };
}

function specNamespaces(monitor: KubeObject): TargetNamespaces {
  if (get(monitor, "spec", "namespaceSelector", "any") === true) return { type: "any" };
  const names = arr(get(monitor, "spec", "namespaceSelector", "matchNames"))
    .map(String)
    .filter(Boolean);
  if (names.length > 0) return { type: "list", names: [...new Set(names)].sort() };
  return { type: "list", names: [monitor.metadata?.namespace ?? ""] };
}

/** A monitor's selector of Services (ServiceMonitor) or Pods (PodMonitor): an empty one selects all of them. */
export const monitorSelector = (monitor: KubeObject): Selector => labelSelector(get(monitor, "spec", "selector") ?? {});

/** The selector as the API server's `labelSelector` text; `null` when it can select nothing. */
export function selectorText(selector: Selector): string | null {
  if (selector.type === "nothing") return null;
  if (selector.type === "everything") return "";
  const parts = selector.matchLabels.map(([key, value]) => `${key}=${value}`);
  for (const r of selector.expressions) {
    if (r.operator === "In") parts.push(`${r.key} in (${r.values.join(",")})`);
    else if (r.operator === "NotIn") parts.push(`${r.key} notin (${r.values.join(",")})`);
    else if (r.operator === "Exists") parts.push(r.key);
    else if (r.operator === "DoesNotExist") parts.push(`!${r.key}`);
    else return null;
  }
  return parts.join(",");
}

export interface Endpoint {
  /** The named port: a Service port's name (ServiceMonitor) or a container port's name (PodMonitor). */
  port?: string;
  /** A port given by number or by its target (PodMonitor `portNumber`, the deprecated `targetPort`). */
  number?: number;
  targetPort?: string;
  path?: string;
  interval?: string;
}

export function endpointsOf(monitor: KubeObject, kind: Pick<KindRef, "group" | "kind">): Endpoint[] {
  const list = isKind(kind, POD_MONITOR) ? get(monitor, "spec", "podMetricsEndpoints") : get(monitor, "spec", "endpoints");
  return arr(list).map((e) => {
    const target = get(e, "targetPort");
    return {
      port: str(get(e, "port")),
      number: num(get(e, "portNumber")),
      targetPort: target === undefined || target === null ? undefined : String(target),
      path: str(get(e, "path")),
      interval: str(get(e, "interval")),
    };
  });
}

/** Port names of a Service (`spec.ports[].name`). */
export const servicePortNames = (svc: KubeObject): string[] =>
  arr(get(svc, "spec", "ports"))
    .map((p) => str(get(p, "name")))
    .filter((n): n is string => !!n);

/** Container port names of a Pod (`spec.containers[].ports[].name`, init containers included). */
export const podPortNames = (pod: KubeObject): string[] =>
  [...arr(get(pod, "spec", "containers")), ...arr(get(pod, "spec", "initContainers"))].flatMap((c) =>
    arr(get(c, "ports"))
      .map((p) => str(get(p, "name")))
      .filter((n): n is string => !!n),
  );

// ---------- Picked up by Prometheus ----------

/** The Prometheus fields that select each kind and its namespaces. */
const SELECTOR_FIELDS: Record<string, [selector: string, namespaces: string]> = {
  ServiceMonitor: ["serviceMonitorSelector", "serviceMonitorNamespaceSelector"],
  PodMonitor: ["podMonitorSelector", "podMonitorNamespaceSelector"],
  Probe: ["probeSelector", "probeNamespaceSelector"],
  PrometheusRule: ["ruleSelector", "ruleNamespaceSelector"],
};

/** A null selector of a Prometheus selects nothing; an empty one everything (the operator's API). */
function promSelector(value: unknown): Selector {
  return value === undefined || value === null ? NOTHING : labelSelector(value);
}

/**
 * Whether a Prometheus or PrometheusAgent picks `obj` (of `kind`) up: its selector for that kind matches the object's
 * labels and its namespace selector the object's namespace (null: the Prometheus's own namespace only; empty: every
 * namespace). `undefined` when that needs a namespace's labels that are not known.
 */
export function picksUp(
  prom: KubeObject,
  kind: Pick<KindRef, "kind">,
  obj: KubeObject,
  namespaceLabels: (name: string) => Labels | undefined,
): boolean | undefined {
  const fields = SELECTOR_FIELDS[kind.kind];
  if (!fields) return false;
  const spec = get(prom, "spec");
  if (!matches(promSelector(get(spec, fields[0])), labelsOf(obj))) return false;
  const nsValue = get(spec, fields[1]);
  const namespace = obj.metadata?.namespace ?? "";
  if (nsValue === undefined || nsValue === null) return namespace === prom.metadata?.namespace;
  const nsSelector = labelSelector(nsValue);
  if (nsSelector.type === "everything") return true;
  const labels = namespaceLabels(namespace);
  return labels === undefined ? undefined : matches(nsSelector, labels);
}

/** Whether any Prometheus selects namespaces by labels (only then are the Namespaces' labels needed). */
export function needsNamespaceLabels(proms: readonly KubeObject[]): boolean {
  return proms.some((p) =>
    Object.values(SELECTOR_FIELDS).some(([, nsField]) => {
      const value = get(p, "spec", nsField);
      return value !== undefined && value !== null && labelSelector(value).type === "terms";
    }),
  );
}

export interface PickedUp {
  /** `namespace/name` of each Prometheus that picks it up. */
  by: KubeObject[];
  /** Some Prometheus could not be judged (a namespace's labels are not known). */
  unknown: boolean;
}

export function pickedUpBy(
  proms: readonly KubeObject[],
  kind: Pick<KindRef, "kind">,
  obj: KubeObject,
  namespaceLabels: (name: string) => Labels | undefined,
): PickedUp {
  const by: KubeObject[] = [];
  let unknown = false;
  for (const p of proms) {
    const r = picksUp(p, kind, obj, namespaceLabels);
    if (r === undefined) unknown = true;
    else if (r) by.push(p);
  }
  return { by, unknown };
}

// ---------- PrometheusRule ----------

export interface RuleGroup {
  name: string;
  interval?: string;
  alerts: number;
  records: number;
}

export function ruleGroupsOf(rule: KubeObject): RuleGroup[] {
  return arr(get(rule, "spec", "groups")).map((g) => {
    const rules = arr(get(g, "rules"));
    return {
      name: str(get(g, "name")) ?? "",
      interval: str(get(g, "interval")),
      alerts: rules.filter((r) => str(get(r, "alert"))).length,
      records: rules.filter((r) => str(get(r, "record"))).length,
    };
  });
}

export const ruleCount = (rule: KubeObject): number => ruleGroupsOf(rule).reduce((n, g) => n + g.alerts + g.records, 0);

// ---------- Prometheus and Alertmanager ----------

export type ServerState = "ready" | "degraded" | "failed" | "pending";

export interface ServerReadiness {
  state: ServerState;
  reason?: string;
  message?: string;
  since?: string;
  available?: number;
  desired: number;
}

const condition = (obj: KubeObject, type: string) => arr(get(obj, "status", "conditions")).find((c) => get(c, "type") === type);

/**
 * Readiness of a Prometheus or Alertmanager from the operator's conditions: `Available` True (ready), Degraded (some
 * replicas down), False (none); `Reconciled` False is a failure to apply the spec. Without conditions: pending.
 */
export function serverReadiness(obj: KubeObject): ServerReadiness {
  const available = condition(obj, "Available");
  const reconciled = condition(obj, "Reconciled");
  const base = {
    available: num(get(obj, "status", "availableReplicas")),
    desired: (num(get(obj, "spec", "replicas")) ?? 1) * (num(get(obj, "spec", "shards")) ?? 1),
  };
  const read = (c: unknown, state: ServerState): ServerReadiness => ({
    ...base,
    state,
    reason: str(get(c, "reason")),
    message: str(get(c, "message")),
    since: str(get(c, "lastTransitionTime")),
  });
  const a = str(get(available, "status"));
  if (a === "False") return read(available, "failed");
  if (str(get(reconciled, "status")) === "False") return read(reconciled, "failed");
  if (a === "Degraded") return read(available, "degraded");
  if (a === "True") return read(available, "ready");
  return { ...base, state: "pending" };
}

export const SERVER_TONE: Record<ServerState, Tone> = {
  ready: "success",
  degraded: "warning",
  failed: "danger",
  pending: "warning",
};

/** Not available counts after this long: a rollout of the StatefulSet passes through it. */
export const SERVER_GRACE_MS = 5 * 60_000;

export function isServerProblem(obj: KubeObject): boolean {
  const s = serverReadiness(obj).state;
  return s === "failed" || s === "degraded";
}

/** The problems of a Prometheus or Alertmanager: not available, degraded or not reconciled (after a grace). */
export function prometheusOperatorProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Detected[] {
  if (!isKind(kind, PROMETHEUS, ALERTMANAGER) || obj.metadata?.deletionTimestamp) return [];
  const r = serverReadiness(obj);
  if (r.state !== "failed" && r.state !== "degraded") return [];
  return [
    {
      reason: r.reason || (r.state === "degraded" ? "Degraded" : "NotAvailable"),
      group: "notReady",
      message: r.message,
      since: r.since,
      graceMs: SERVER_GRACE_MS,
      notify: true,
    },
  ];
}
