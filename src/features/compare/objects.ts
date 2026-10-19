// What an object offers to compare against: its Helm release (Helm's ownership annotations) and its last-applied
// configuration.
import type { KindRef, KubeObject } from "../../api";

const RELEASE_NAME = "meta.helm.sh/release-name";
const RELEASE_NAMESPACE = "meta.helm.sh/release-namespace";
export const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/** The value of annotation `key` of `obj`, `undefined` when it has none (or it is not text). */
export function annotationOf(obj: KubeObject, key: string): string | undefined {
  const annotations = obj.metadata?.annotations;
  if (typeof annotations !== "object" || annotations === null) return undefined;
  const value = (annotations as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** The Helm release an object belongs to, or `null`. */
export function helmReleaseOf(obj: KubeObject): { name: string; namespace: string } | null {
  const name = annotationOf(obj, RELEASE_NAME);
  const namespace = annotationOf(obj, RELEASE_NAMESPACE);
  return name && namespace ? { name, namespace } : null;
}

export function isSecretKind(kind: Pick<KindRef, "group" | "kind">): boolean {
  return kind.group === "" && kind.kind === "Secret";
}

/** Whether an object may have a last-applied configuration (a Secret's is hidden from the frontend: maybe). */
export function mayHaveLastApplied(obj: KubeObject, kind: Pick<KindRef, "group" | "kind">): boolean {
  return isSecretKind(kind) || Boolean(annotationOf(obj, LAST_APPLIED));
}
