// Label selectors as the API server applies them, and what an empty or missing selector means for each kind that
// selects pods (the semantics differ, and getting them wrong draws edges that do not exist):
//
//   Service              `spec.selector` (a plain map)        missing or empty → selects nothing (manual endpoints)
//   NetworkPolicy        `spec.podSelector` (LabelSelector)   empty → every pod of the namespace (missing reads as empty)
//   PodDisruptionBudget  `spec.selector` (LabelSelector)      policy/v1: empty → every pod of the namespace;
//                                                             missing (null) → nothing; policy/v1beta1: empty → nothing
//
// A requirement with an operator the API does not define never matches (fail closed).
import type { KubeObject } from "../../api";
import { status } from "../../resources";

const { arr, get, labelsOf, record, str } = status;

export type Labels = Readonly<Record<string, string>>;

/** A compiled selector: `everything` matches all, `nothing` none, otherwise the terms. */
export type Selector =
  | { type: "everything" }
  | { type: "nothing" }
  | { type: "terms"; matchLabels: [string, string][]; expressions: Requirement[] };

export interface Requirement {
  key: string;
  operator: string;
  values: string[];
}

export const NOTHING: Selector = { type: "nothing" };
export const EVERYTHING: Selector = { type: "everything" };

/** A `LabelSelector` (`matchLabels`, `matchExpressions`); an empty one selects everything. */
export function labelSelector(value: unknown): Selector {
  if (value === null || value === undefined || typeof value !== "object") return NOTHING;
  const matchLabels = Object.entries(record(get(value, "matchLabels"))).map(([k, v]): [string, string] => [k, String(v)]);
  const expressions = arr(get(value, "matchExpressions")).map((e) => ({
    key: str(get(e, "key")) ?? "",
    operator: str(get(e, "operator")) ?? "",
    values: arr(get(e, "values")).map(String),
  }));
  if (matchLabels.length === 0 && expressions.length === 0) return EVERYTHING;
  return { type: "terms", matchLabels, expressions };
}

/** A Service-style selector (a plain map): an empty or missing map selects nothing. */
export function mapSelector(value: unknown): Selector {
  const matchLabels = Object.entries(record(value)).map(([k, v]): [string, string] => [k, String(v)]);
  return matchLabels.length === 0 ? NOTHING : { type: "terms", matchLabels, expressions: [] };
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

/**
 * The pod selector of an object of `kind`, with that kind's rules for an empty or missing selector; `null` for a
 * kind that does not select pods by labels.
 */
export function podSelectorOf(kind: { group: string; kind: string; version?: string }, obj: KubeObject): Selector | null {
  if (kind.group === "" && kind.kind === "Service") {
    // ExternalName Services have no endpoints, whatever the selector says.
    if (str(get(obj, "spec", "type")) === "ExternalName") return NOTHING;
    return mapSelector(get(obj, "spec", "selector"));
  }
  if (kind.group === "networking.k8s.io" && kind.kind === "NetworkPolicy") {
    const value = get(obj, "spec", "podSelector");
    return value === undefined || value === null ? EVERYTHING : labelSelector(value);
  }
  if (kind.group === "policy" && kind.kind === "PodDisruptionBudget") {
    const value = get(obj, "spec", "selector");
    if (value === undefined || value === null) return NOTHING;
    const selector = labelSelector(value);
    // policy/v1beta1 read an empty selector as "no pods"; policy/v1 as "every pod of the namespace".
    const version = kind.version ?? apiVersionOf(obj);
    return selector.type === "everything" && version === "v1beta1" ? NOTHING : selector;
  }
  return null;
}

function apiVersionOf(obj: KubeObject): string {
  const apiVersion = obj.apiVersion ?? "";
  return apiVersion.includes("/") ? apiVersion.slice(apiVersion.indexOf("/") + 1) : apiVersion;
}

/** Pods of some namespaces, indexed by `key=value` so a selector with `matchLabels` looks only at candidates. */
export interface PodIndex {
  byNamespace: Map<string, KubeObject[]>;
  /** `<namespace>\u0000<key>=<value>` → pods. */
  byLabel: Map<string, KubeObject[]>;
}

export function indexPods(pods: Iterable<KubeObject>): PodIndex {
  const byNamespace = new Map<string, KubeObject[]>();
  const byLabel = new Map<string, KubeObject[]>();
  const push = (map: Map<string, KubeObject[]>, key: string, pod: KubeObject) => {
    const list = map.get(key);
    if (list) list.push(pod);
    else map.set(key, [pod]);
  };
  for (const pod of pods) {
    const ns = pod.metadata?.namespace ?? "";
    push(byNamespace, ns, pod);
    for (const [key, value] of Object.entries(labelsOf(pod))) push(byLabel, `${ns}\u0000${key}=${value}`, pod);
  }
  return { byNamespace, byLabel };
}

/** The pods of `namespace` the selector selects. */
export function selectPods(index: PodIndex, namespace: string, selector: Selector): KubeObject[] {
  if (selector.type === "nothing") return [];
  const all = index.byNamespace.get(namespace) ?? [];
  if (selector.type === "everything") return all;
  // The rarest `matchLabels` pair narrows the candidates; expressions alone scan the namespace.
  let candidates = all;
  for (const [key, value] of selector.matchLabels) {
    const list = index.byLabel.get(`${namespace}\u0000${key}=${value}`) ?? [];
    if (list.length < candidates.length) candidates = list;
    if (candidates.length === 0) return [];
  }
  return candidates.filter((pod) => matches(selector, labelsOf(pod)));
}
