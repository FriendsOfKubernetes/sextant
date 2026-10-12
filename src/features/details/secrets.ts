// Secret values never show up unasked. The backend sends a Secret without its values (keys with empty values, no
// `last-applied-configuration`, the `VALUES_HIDDEN` annotation set); "Show" reads one value with `secret_value`, and
// "Edit" loads the whole object with `resource_get_full`. Text that still carries the marker is never saved back:
// it would replace every value with an empty string.
import type { KubeObject } from "../../api";

export const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";
/** Set by the backend on a Secret sent without its values. */
export const VALUES_HIDDEN = "sextant.dev/values-hidden";

/** Whether an annotation of an object of `kind` is hidden because it may hold secret data. */
export function maskedAnnotation(kind: string, annotation: string): boolean {
  return kind === "Secret" && annotation === LAST_APPLIED;
}

/** Whether the annotation list shows `annotation`: the marker of hidden values is Sextant's own, not the object's. */
export function listedAnnotation(kind: string, annotation: string): boolean {
  return !(kind === "Secret" && annotation === VALUES_HIDDEN);
}

/** Whether YAML text came from a Secret sent without its values (saving it would wipe them). */
export function hasHiddenValues(text: string): boolean {
  return text.includes(VALUES_HIDDEN);
}

export const HIDDEN_VALUE = "<hidden>";

/** A copy of a Secret with every value of `data`/`stringData` and the last-applied annotation replaced. */
export function maskSecret(obj: KubeObject): KubeObject {
  if (obj.kind !== "Secret") return obj;
  const copy = structuredClone(obj) as KubeObject & { data?: unknown; stringData?: unknown };
  for (const field of ["data", "stringData"] as const) {
    const values = copy[field];
    if (values && typeof values === "object" && !Array.isArray(values)) {
      copy[field] = Object.fromEntries(Object.keys(values).map((k) => [k, HIDDEN_VALUE]));
    }
  }
  const annotations = copy.metadata?.annotations as Record<string, unknown> | undefined;
  if (annotations && LAST_APPLIED in annotations) annotations[LAST_APPLIED] = HIDDEN_VALUE;
  return copy;
}
