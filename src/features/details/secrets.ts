// Secret values never show up unasked. The backend sends a Secret without its values (keys with empty values, no
// `last-applied-configuration`, the `VALUES_HIDDEN` annotation set); "Show" reads one value with `secret_value`, and
// "Edit" loads the whole object with `resource_get_full`. Text that still carries the marker is never saved back:
// it would replace every value with an empty string.
//
// Secret material other kinds hold inline (`src/resources/inline-secrets.json`) arrives whole: the YAML view and the
// editor show and save the object as it is (ADR-0120, ADR-0121, ADR-0123). The metadata list masks the two annotations
// of that table it shows as plain text, a k3s/RKE2 node's arguments and environment, by the rules of the k3s view
// (`src/features/k3s/mask.ts`): a secret flag's or variable's value is `<hidden>`, every other value is cleaned of URI
// credentials, and text that does not read is hidden whole.
import type { KubeObject } from "../../api";
import { cleanText } from "../../resources/uri";
import { HIDDEN, looksSecret } from "../kuberay/mask";
import { K3S_OMITTED, nodeArgs } from "../k3s/mask";

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

/** The k3s/RKE2 node annotations of the arguments and the environment a node was started with. */
const NODE_ARGS = new Set(["k3s.io/node-args", "rke2.io/node-args"]);
const NODE_ENV = new Set(["k3s.io/node-env", "rke2.io/node-env"]);
/** A node-env annotation longer than this is not read (as `MAX_ARGS_TEXT` for the arguments). */
const MAX_ENV_TEXT = 64 * 1024;

/** A node's `K3S_*` environment (a JSON object of strings) with secret-looking variables hidden; `null` unreadable. */
function maskedNodeEnv(text: string): string | null {
  if (text.length > MAX_ENV_TEXT) return null;
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch {
    return null;
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== "string") return null;
    const secret = value === K3S_OMITTED || looksSecret(name) || name.toUpperCase().endsWith("DATASTORE_ENDPOINT");
    out[name] = secret ? HIDDEN : (cleanText(value) ?? "");
  }
  return JSON.stringify(out);
}

/**
 * How the metadata list shows the annotation `key` of an object of `kind`: `value` as it is, masked (a k3s/RKE2
 * node's arguments and environment), or `null` when it is hidden whole.
 */
export function shownAnnotation(kind: string, key: string, value: string): string | null {
  if (maskedAnnotation(kind, key)) return null;
  if (kind !== "Node") return value;
  if (NODE_ARGS.has(key)) {
    const args = nodeArgs(value);
    if (!args) return null;
    const words = args.flatMap((a) => {
      const flag = a.flag === undefined ? [] : [a.flag];
      if (a.hidden) return [...flag, HIDDEN];
      return a.value === undefined ? flag : [...flag, a.value];
    });
    return JSON.stringify(words);
  }
  if (NODE_ENV.has(key)) return maskedNodeEnv(value);
  return value;
}
