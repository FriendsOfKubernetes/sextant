// The pods of a workload (Deployment, StatefulSet, DaemonSet, Job) are the pods its `spec.selector` matches.

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
