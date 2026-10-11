// Secret values never show up unasked: the details panel hides every value of a Secret until "Show" is pressed
// for that key, and hides the copies that would reveal it anyway (the `last-applied-configuration` annotation,
// which `kubectl apply` fills with the whole manifest, and the YAML view).
import type { KubeObject } from "../../api";

export const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/** Whether an annotation of an object of `kind` is hidden because it may hold secret data. */
export function maskedAnnotation(kind: string, annotation: string): boolean {
  return kind === "Secret" && annotation === LAST_APPLIED;
}

/** Text of a base64 value (UTF-8; invalid bytes become U+FFFD); `null` when it is not base64. */
export function decodeBase64(value: string): string | null {
  try {
    const binary = atob(value.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
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
