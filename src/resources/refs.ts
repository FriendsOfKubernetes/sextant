// Identifiers of kinds and objects shared by the registry, the sidebar, the main view and the tables.
import type { KindRef, KubeObject, ObjectRef } from "../api";

/** `group/Kind` — the registry key; the version does not matter for the description. */
export function kindKey(kind: Pick<KindRef, "group" | "kind">): string {
  return `${kind.group}/${kind.kind}`;
}

/** The store `view` value of a kind's table: `kind:apps/Deployment`, `kind:/Pod`. */
export function viewIdOf(kind: Pick<KindRef, "group" | "kind">): string {
  return `kind:${kindKey(kind)}`;
}

/** Inverse of `viewIdOf`; `null` for page views. */
export function parseViewId(view: string | null): { group: string; kind: string } | null {
  if (!view?.startsWith("kind:")) return null;
  const rest = view.slice("kind:".length);
  const slash = rest.lastIndexOf("/");
  if (slash < 0) return null;
  return { group: rest.slice(0, slash), kind: rest.slice(slash + 1) };
}

/** `ObjectRef` of an object of `kind` (for `openDetails`, actions, API calls). */
export function refOf(obj: KubeObject, kind: KindRef): ObjectRef {
  return { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

/** `KindRef` from an `apiVersion` ("apps/v1", "v1") and a kind. */
export function kindFromApiVersion(apiVersion: string, kind: string): KindRef {
  const slash = apiVersion.indexOf("/");
  return slash < 0
    ? { group: "", version: apiVersion, kind }
    : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1), kind };
}
