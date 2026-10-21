// emberstack Reflector (#241): what its annotations on a Secret or ConfigMap say, read as Reflector reads them
// (`Mirroring/Core/Annotations.cs`, `MirroringPropertiesExtensions.cs`, ES.FX `NamespacedName.TryParse`):
//   source — `reflection-allowed` ("true", any case), `reflection-allowed-namespaces` (a comma-separated list of
//            regular expressions, each matching the whole namespace name; empty: every namespace),
//            `reflection-allowed-namespaces-selector` (a label selector on namespaces; a namespace matches when either
//            the list or the selector does), `reflection-auto-enabled`, `reflection-auto-namespaces` and
//            `reflection-auto-namespaces-selector` (the same for automatic mirrors, which also need the allowed ones);
//   mirror — `reflects` ("namespace/name" of the source, same kind), `auto-reflects` (written by Reflector on the
//            mirrors it created), `reflected-version` (the source's resourceVersion it last copied), `reflected-at`.
// Pure: no value of a Secret is ever read — only annotations, names and resourceVersions.
//
// Choices where Reflector's C# cannot be copied exactly (ADR-0110):
//   - patterns run as JavaScript regular expressions (.NET syntax JavaScript refuses — inline options, atomic groups —
//     is "cannot tell", never a match or a mismatch); like `Regex.Match` the first match must cover the whole name;
//   - a pattern longer than `MAX_PATTERN_LENGTH`, or with a repeated group that itself repeats (catastrophic
//     backtracking), is not run: "cannot tell";
//   - a label selector Reflector cannot parse matches no namespace (it fails closed), and so here; a namespace whose
//     labels are not known yet is "cannot tell" where Reflector would wait for its namespace cache.
import type { KindRef, KubeObject } from "../../api";

export const PREFIX = "reflector.v1.k8s.emberstack.com";
export const ANNOTATIONS = {
  allowed: `${PREFIX}/reflection-allowed`,
  allowedNamespaces: `${PREFIX}/reflection-allowed-namespaces`,
  allowedSelector: `${PREFIX}/reflection-allowed-namespaces-selector`,
  autoEnabled: `${PREFIX}/reflection-auto-enabled`,
  autoNamespaces: `${PREFIX}/reflection-auto-namespaces`,
  autoSelector: `${PREFIX}/reflection-auto-namespaces-selector`,
  reflects: `${PREFIX}/reflects`,
  autoReflects: `${PREFIX}/auto-reflects`,
  reflectedVersion: `${PREFIX}/reflected-version`,
  reflectedAt: `${PREFIX}/reflected-at`,
} as const;

export const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };
export const CONFIG_MAP: KindRef = { group: "", version: "v1", kind: "ConfigMap" };
export const NAMESPACE: KindRef = { group: "", version: "v1", kind: "Namespace" };
export type ReflectedKind = "Secret" | "ConfigMap";

/** A pattern longer than this is not run. */
export const MAX_PATTERN_LENGTH = 256;
/** At most this many patterns of one list are run. */
export const MAX_PATTERNS = 64;

/** `true`, `false`, or `undefined`: cannot tell. */
export type Tri = boolean | undefined;

export function reflectedKind(kind: Pick<KindRef, "group" | "kind">): ReflectedKind | undefined {
  if (kind.group !== "") return undefined;
  return kind.kind === "Secret" || kind.kind === "ConfigMap" ? kind.kind : undefined;
}

export function kindRefOf(kind: ReflectedKind): KindRef {
  return kind === "Secret" ? SECRET : CONFIG_MAP;
}

/** The annotations of an object (as a plain map). */
export function annotationsOf(obj: KubeObject): Readonly<Record<string, unknown>> {
  return (obj.metadata?.annotations ?? {}) as Record<string, unknown>;
}

function annotation(obj: KubeObject, key: string): string | undefined {
  const value = annotationsOf(obj)[key];
  return typeof value === "string" ? value : undefined;
}

/** .NET's `bool` conversion of an annotation: "true"/"false" in any case, trimmed; anything else is not set. */
function flag(obj: KubeObject, key: string): boolean {
  return annotation(obj, key)?.trim().toLowerCase() === "true";
}

/** ES.FX `NamespacedName.TryParse`: "namespace/name" or "name" (empty namespace); anything else is no reference. */
export function parseNamespacedName(value: string | undefined): { namespace: string; name: string } | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parts = value.split("/").map((p) => p.trim());
  if (parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0) return { namespace: parts[0]!, name: parts[1]! };
  if (parts.length === 1 && parts[0]!.length > 0) return { namespace: "", name: parts[0]! };
  return undefined;
}

export interface Reflection {
  allowed: boolean;
  allowedNamespaces: string;
  allowedSelector: string;
  autoEnabled: boolean;
  autoNamespaces: string;
  autoSelector: string;
  /** The source this object mirrors; `undefined`: not a mirror (or a `reflects` Reflector cannot parse). */
  reflects?: { namespace: string; name: string };
  /** `reflects` is set but is no "namespace/name": Reflector ignores the object. */
  reflectsInvalid: boolean;
  autoReflects: boolean;
  reflectedVersion: string;
  reflectedAt?: string;
}

/** The annotations as Reflector reads them (`GetMirroringProperties`). */
export function reflectionOf(obj: KubeObject): Reflection {
  const text = (key: string) => annotation(obj, key)?.trim() ?? "";
  const rawReflects = annotation(obj, ANNOTATIONS.reflects);
  const reflects = parseNamespacedName(rawReflects);
  const at = text(ANNOTATIONS.reflectedAt).replaceAll('"', "");
  return {
    allowed: flag(obj, ANNOTATIONS.allowed),
    allowedNamespaces: text(ANNOTATIONS.allowedNamespaces),
    allowedSelector: text(ANNOTATIONS.allowedSelector),
    autoEnabled: flag(obj, ANNOTATIONS.autoEnabled),
    autoNamespaces: text(ANNOTATIONS.autoNamespaces),
    autoSelector: text(ANNOTATIONS.autoSelector),
    ...(reflects ? { reflects } : {}),
    reflectsInvalid: rawReflects !== undefined && rawReflects.trim() !== "" && !reflects,
    autoReflects: flag(obj, ANNOTATIONS.autoReflects),
    reflectedVersion: text(ANNOTATIONS.reflectedVersion),
    ...(at ? { reflectedAt: at } : {}),
  };
}

/** Whether any Reflector annotation is on the object. */
export function hasReflectorAnnotations(obj: KubeObject): boolean {
  return Object.keys(annotationsOf(obj)).some((k) => k.startsWith(`${PREFIX}/`));
}

/** `metadata.resourceVersion`, when it is a string. */
export function resourceVersionOf(obj: KubeObject | undefined): string | undefined {
  const v = obj?.metadata?.resourceVersion;
  return typeof v === "string" ? v : undefined;
}
