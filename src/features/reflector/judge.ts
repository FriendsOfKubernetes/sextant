// What Reflector does with a mirror and where a source may go, judged from annotations, names and resourceVersions
// only (#241): `CanBeReflectedToNamespace` / `CanBeAutoReflectedToNamespace` and the version check of
// `ResourceMirror.cs` (a mirror is current when its `reflected-version` is the source's resourceVersion). Pure.
import type { KubeObject } from "../../api";
import { reflectionOf, resourceVersionOf, type Reflection, type Tri } from "./model";
import { namespaceMatches } from "./patterns";

/** Labels of a namespace: `null` it does not exist, `undefined` not known. */
export type NamespaceLabels = (namespace: string) => Readonly<Record<string, string>> | null | undefined;

const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === true && b === true ? true : undefined);

/** Whether the source lets a mirror live in `namespace` (`reflection-allowed` and the allowed namespaces). */
export function canReflect(source: Reflection, namespace: string, labels: NamespaceLabels): Tri {
  if (!source.allowed) return false;
  return namespaceMatches(source.allowedNamespaces, source.allowedSelector, namespace, labels(namespace));
}

/** Whether Reflector creates (and keeps) an automatic mirror in `namespace`. */
export function canAutoReflect(source: Reflection, namespace: string, labels: NamespaceLabels): Tri {
  if (!source.allowed || !source.autoEnabled) return false;
  return and(canReflect(source, namespace, labels), namespaceMatches(source.autoNamespaces, source.autoSelector, namespace, labels(namespace)));
}

export type MirrorState = "inSync" | "stale" | "sourceMissing" | "notAllowed" | "unknown";

export const MIRROR_TONE: Record<MirrorState, "success" | "warning" | "danger" | "muted"> = {
  inSync: "success",
  stale: "warning",
  sourceMissing: "danger",
  notAllowed: "danger",
  unknown: "muted",
};

export interface MirrorJudgement {
  state: MirrorState;
  reflection: Reflection;
  /** `namespace/name` of the source. */
  source: { namespace: string; name: string };
  /** The source object (metadata), when found. */
  sourceObj?: KubeObject;
  /** Whether the source permits this namespace (for an automatic mirror: as an automatic one). */
  permitted: Tri;
  /** `reflected-version` equals the source's resourceVersion; `undefined` without the source. */
  versionMatches?: boolean;
}

/**
 * The state of a mirror. `source`: the source object, `null` where its list is read in full and it is not there,
 * `undefined` where it cannot be read. "Not allowed" before "stale": Reflector will not bring such a mirror up to date.
 */
export function judgeMirror(mirror: KubeObject, source: KubeObject | null | undefined, labels: NamespaceLabels): MirrorJudgement | undefined {
  const reflection = reflectionOf(mirror);
  const ref = reflection.reflects;
  if (!ref) return undefined;
  const base = { reflection, source: ref };
  // A reference without a namespace names nothing Reflector can find.
  if (ref.namespace === "" || source === null) return { ...base, state: "sourceMissing", permitted: undefined };
  if (source === undefined) return { ...base, state: "unknown", permitted: undefined };
  const props = reflectionOf(source);
  const namespace = mirror.metadata?.namespace ?? "";
  const permitted = reflection.autoReflects ? canAutoReflect(props, namespace, labels) : canReflect(props, namespace, labels);
  const versionMatches = reflection.reflectedVersion !== "" && reflection.reflectedVersion === resourceVersionOf(source);
  const state: MirrorState = permitted === false ? "notAllowed" : versionMatches ? "inSync" : "stale";
  return { ...base, state, sourceObj: source, permitted, versionMatches };
}
