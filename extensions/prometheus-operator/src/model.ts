// What the extension reads from monitoring.coreos.com objects — Sextant's former built-in Prometheus Operator view's
// model (ADR-0100), ported unchanged: the kinds it knows; for a ServiceMonitor or PodMonitor, the namespaces it looks
// in, its selector and endpoints; whether a Prometheus (or a PrometheusAgent) picks a monitor, a rule or a probe up by
// its selectors; a PrometheusRule's groups and rules; and the readiness of Prometheus and Alertmanager from their
// conditions. Pure functions. Label selectors are read as the API server applies them (`labelSelector`, `matches`:
// Sextant's resource-map selectors, ported), so a selector means the same here as in Sextant.
//
// `prometheusOperatorProblems` and `isServerProblem` are the built-in detector and "Only problems" filter: the manifest's
// rules and `problemWhen` replace them, and `model.test.ts` compares the two.
import type { KubeObject } from "@sextant/extension-sdk";

export const MONITORING_GROUP = "monitoring.coreos.com";

export interface KindOf {
  group: string;
  version: string;
  kind: string;
}

const k = (kind: string, version = "v1"): KindOf => ({ group: MONITORING_GROUP, version, kind });

export const SERVICE_MONITOR = k("ServiceMonitor");
export const POD_MONITOR = k("PodMonitor");
export const PROBE = k("Probe");
export const PROMETHEUS_RULE = k("PrometheusRule");
export const PROMETHEUS = k("Prometheus");
export const ALERTMANAGER = k("Alertmanager");
/** Not listed in the section; read only to tell whether a monitor is picked up. */
export const PROMETHEUS_AGENT = k("PrometheusAgent", "v1alpha1");

export const SERVICE: KindOf = { group: "", version: "v1", kind: "Service" };
export const POD: KindOf = { group: "", version: "v1", kind: "Pod" };
export const NAMESPACE: KindOf = { group: "", version: "v1", kind: "Namespace" };

/** The kinds of the section, in the built-in order (with their sidebar order). */
export const MONITORING_KINDS: readonly { kind: KindOf; order: number }[] = [
  { kind: SERVICE_MONITOR, order: 10 },
  { kind: POD_MONITOR, order: 11 },
  { kind: PROBE, order: 12 },
  { kind: PROMETHEUS_RULE, order: 20 },
  { kind: PROMETHEUS, order: 30 },
  { kind: ALERTMANAGER, order: 31 },
];

export const isKind = (a: { group: string; kind: string }, ...of: { group: string; kind: string }[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

// ---------- Reading fields ----------

export const get = (value: unknown, ...path: string[]): unknown => {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
};
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const labelsOf = (obj: KubeObject | undefined): Labels => record(obj?.metadata?.labels) as Labels;

/** The version of `apiVersion` (`monitoring.coreos.com/v1` → `v1`). */
export function versionOf(obj: KubeObject | null | undefined): string | undefined {
  const api = obj?.apiVersion;
  if (!api) return undefined;
  return api.includes("/") ? api.slice(api.indexOf("/") + 1) : api;
}

// ---------- Label selectors (Sextant's resource-map selectors) ----------

export type Labels = Readonly<Record<string, string>>;

export interface Requirement {
  key: string;
  operator: string;
  values: string[];
}

/** A compiled selector: `everything` matches all, `nothing` none, otherwise the terms. */
export type Selector = { type: "everything" } | { type: "nothing" } | { type: "terms"; matchLabels: [string, string][]; expressions: Requirement[] };

export const NOTHING: Selector = { type: "nothing" };
export const EVERYTHING: Selector = { type: "everything" };

/** A `LabelSelector` (`matchLabels`, `matchExpressions`); an empty one selects everything, a non-object nothing. */
export function labelSelector(value: unknown): Selector {
  if (value === null || value === undefined || typeof value !== "object") return NOTHING;
  const matchLabels = Object.entries(record(get(value, "matchLabels"))).map(([key, v]): [string, string] => [key, String(v)]);
  const expressions = arr(get(value, "matchExpressions")).map((e) => ({
    key: str(get(e, "key")) ?? "",
    operator: str(get(e, "operator")) ?? "",
    values: arr(get(e, "values")).map(String),
  }));
  if (matchLabels.length === 0 && expressions.length === 0) return EVERYTHING;
  return { type: "terms", matchLabels, expressions };
}

function requirementMatches(r: Requirement, labels: Labels): boolean {
  const has = Object.hasOwn(labels, r.key);
  switch (r.operator) {
    case "In":
      return has && r.values.includes(labels[r.key]!);
    case "NotIn":
      return !has || !r.values.includes(labels[r.key]!);
    case "Exists":
      return has;
    case "DoesNotExist":
      return !has;
    default:
      // An operator the API does not define never matches (fail closed).
      return false;
  }
}

/** Whether the selector selects an object with `labels`. */
export function matches(selector: Selector, labels: Labels): boolean {
  if (selector.type === "everything") return true;
  if (selector.type === "nothing") return false;
  for (const [key, value] of selector.matchLabels) if (labels[key] !== value) return false;
  return selector.expressions.every((r) => requirementMatches(r, labels));
}

/** A selector's terms as chips' texts, as Sextant's details write them: `key=value`, `key Operator (a, b)`. */
export function selectorTexts(selector: unknown): string[] {
  const labels = Object.entries(record(get(selector, "matchLabels"))).map(([key, v]) => `${key}=${String(v)}`);
  const expressions = arr(get(selector, "matchExpressions")).map((e) => {
    const values = arr(get(e, "values")).map(String).join(", ");
    return `${str(get(e, "key")) ?? ""} ${str(get(e, "operator")) ?? ""}${values ? ` (${values})` : ""}`;
  });
  return [...labels, ...expressions];
}

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

export function endpointsOf(monitor: KubeObject, kind: { group: string; kind: string }): Endpoint[] {
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

/** The text of an endpoint's port in the table's Ports column: its name, else its target, else its number. */
export const portText = (e: Endpoint): string => e.port ?? e.targetPort ?? (e.number === undefined ? "" : String(e.number));

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
export const SELECTOR_FIELDS: Record<string, [selector: string, namespaces: string]> = {
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
export function picksUp(prom: KubeObject, kind: { kind: string }, obj: KubeObject, namespaceLabels: (name: string) => Labels | undefined): boolean | undefined {
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
  /** Each Prometheus that picks it up. */
  by: KubeObject[];
  /** Some Prometheus could not be judged (a namespace's labels are not known). */
  unknown: boolean;
}

export function pickedUpBy(proms: readonly KubeObject[], kind: { kind: string }, obj: KubeObject, namespaceLabels: (name: string) => Labels | undefined): PickedUp {
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
export const SERVER_STATES: readonly ServerState[] = ["ready", "degraded", "failed", "pending"];

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

export type Tone = "success" | "warning" | "danger" | "muted" | "neutral";

export const SERVER_TONE: Record<ServerState, Tone> = {
  ready: "success",
  degraded: "warning",
  failed: "danger",
  pending: "warning",
};

/** Not available counts after this long: a rollout of the StatefulSet passes through it. */
export const SERVER_GRACE_MS = 5 * 60_000;

/** The built-in "Only problems" of Prometheus and Alertmanager. */
export function isServerProblem(obj: KubeObject): boolean {
  const s = serverReadiness(obj).state;
  return s === "failed" || s === "degraded";
}

/** A problem the built-in detector found. */
export interface Found {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs: number;
  notify: boolean;
}

/** The built-in problems of a Prometheus or Alertmanager: not available, degraded or not reconciled (after a grace). */
export function prometheusOperatorProblems(kind: { group: string; kind: string }, obj: KubeObject): Found[] {
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

// ---------- Monitors judged across objects (the built-in problems provider) ----------

/** What the built-in problems provider found of a monitor (its store's `MonitorFinding`). */
export interface MonitorFinding {
  uid: string;
  /** The namespaces it looks in (`null`: every namespace). */
  namespaces: string[] | null;
  /** How many Services (Pods) it selects; `undefined` when not judged. */
  selected?: number;
  /** The Prometheus objects that pick it up (`namespace/name`); `undefined` when not judged or there is none. */
  pickedBy?: string[];
}

/** Namespaces of targets the built-in provider listed at most, per kind; beyond them nothing was judged. */
export const MAX_TARGET_NAMESPACES = 40;

/**
 * The built-in provider's judgement of `monitors` of `kind` (`store.ts` `build`), kept as the reference the manifest's
 * rules (`selectsNone` with `selectedBy`, `selectedByNone`) are tested against: `targets` are the labels of the
 * Services (Pods) listed in each namespace a full list covers; `undefined` when they were not listed.
 */
export function judgeMonitors(
  kind: { kind: string },
  monitors: readonly KubeObject[],
  proms: readonly KubeObject[],
  targets: ReadonlyMap<string, readonly Labels[]> | undefined,
  namespaceLabels: (name: string) => Labels | undefined,
): MonitorFinding[] {
  return monitors.map((monitor) => {
    const picked = proms.length > 0 ? pickedUpBy(proms, kind, monitor, namespaceLabels) : undefined;
    const where = targetNamespaces(monitor, picked && !picked.unknown ? picked.by : undefined);
    let selected: number | undefined;
    if (where.type === "list" && targets && where.names.every((n) => targets.has(n))) {
      const selector = monitorSelector(monitor);
      selected = where.names.reduce((n, ns) => n + targets.get(ns)!.filter((labels) => matches(selector, labels)).length, 0);
    }
    return {
      uid: monitor.metadata?.uid ?? `${monitor.metadata?.namespace}/${monitor.metadata?.name}`,
      namespaces: where.type === "any" ? null : where.names,
      selected,
      pickedBy:
        picked && (picked.by.length > 0 || !picked.unknown) ? picked.by.map((p) => `${p.metadata?.namespace ?? ""}/${p.metadata?.name ?? ""}`) : undefined,
    };
  });
}
