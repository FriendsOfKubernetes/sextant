// The pods of a workload (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job) or a Service are the pods its
// `spec.selector` matches.

interface SelectorRequirement {
  key: string;
  operator: string;
  values?: string[];
}

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: SelectorRequirement[];
}

/** A label selector string (`app=web,env in (a,b)`) for the pods of `workload`; `null` if it selects nothing. */
export function labelSelectorOf(workload: unknown): string | null {
  const selector = (workload as { spec?: { selector?: LabelSelector } } | null)?.spec?.selector;
  if (!selector) return null;
  const parts: string[] = Object.entries(selector.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`);
  for (const { key, operator, values = [] } of selector.matchExpressions ?? []) {
    if (operator === "In") parts.push(`${key} in (${values.join(",")})`);
    else if (operator === "NotIn") parts.push(`${key} notin (${values.join(",")})`);
    else if (operator === "Exists") parts.push(key);
    else if (operator === "DoesNotExist") parts.push(`!${key}`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}

/** Whether `kind` selects pods with a label selector: the workloads above, a ReplicaSet, or a Service. */
export function selectsPods(kind: { group: string; kind: string }): boolean {
  if (kind.group === "" && kind.kind === "Service") return true;
  return (POD_OWNERS[kind.group]?.includes(kind.kind) ?? false);
}

/** `apps` Deployment, StatefulSet, DaemonSet, ReplicaSet and `batch` Job: the workloads whose pods logs can follow. */
export const POD_OWNERS: Readonly<Record<string, readonly string[]>> = {
  apps: ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"],
  batch: ["Job"],
};

/**
 * The label selector string for the pods of `obj` of `kind`: a Service's `spec.selector` is a plain map, every
 * other kind has a `LabelSelector`. `null` when it selects nothing.
 */
export function podSelectorOf(obj: unknown, kind: { group: string; kind: string }): string | null {
  if (kind.group === "" && kind.kind === "Service") {
    const selector = (obj as { spec?: { selector?: Record<string, string> } } | null)?.spec?.selector;
    const parts = Object.entries(selector ?? {}).map(([key, value]) => `${key}=${value}`);
    return parts.length > 0 ? parts.join(",") : null;
  }
  return labelSelectorOf(obj);
}
