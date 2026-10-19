// Which words of a table's search the API server can filter by (#157): label terms (`app=web`, `tier!=db`, `app=`
// = has the label) become the watch's label selector, terms of a field the API server supports for the kind
// (`status.phase=Running` on pods) its field selector. Everything else stays a text search in the window. A term
// that is not a valid selector (`app=a b`, a value over 63 characters) stays in the window too, so a typo never
// turns into an error of the watch.

/** Fields every kind can be selected by. */
const COMMON_FIELDS = ["metadata.name", "metadata.namespace"];

/** Fields the API server selects by, per kind (`group/Kind`), besides `COMMON_FIELDS`. */
const KIND_FIELDS: Record<string, readonly string[]> = {
  "/Pod": [
    "spec.nodeName",
    "spec.restartPolicy",
    "spec.schedulerName",
    "spec.serviceAccountName",
    "spec.hostNetwork",
    "status.phase",
    "status.podIP",
    "status.nominatedNodeName",
  ],
  "/Event": [
    "involvedObject.kind",
    "involvedObject.namespace",
    "involvedObject.name",
    "involvedObject.uid",
    "involvedObject.apiVersion",
    "involvedObject.fieldPath",
    "reason",
    "reportingComponent",
    "source",
    "type",
  ],
  "/Secret": ["type"],
  "/Namespace": ["status.phase"],
  "/Node": ["spec.unschedulable"],
  "/ReplicationController": ["status.replicas"],
  "apps/ReplicaSet": ["status.replicas"],
  "batch/Job": ["status.successful"],
  "certificates.k8s.io/CertificateSigningRequest": ["spec.signerName"],
};

/**
 * Fields whose value the API server does not read from the object's own JSON path, or reads as something when unset
 * (as its field label conversions do): what the window compares when it checks a field term itself.
 */
const FIELD_VALUES: Record<string, Record<string, { path?: string; unset?: string }>> = {
  "/Pod": { "spec.hostNetwork": { unset: "false" } },
  "/Event": { source: { path: "source.component" }, reportingComponent: { path: "reportingController" } },
  "/Node": { "spec.unschedulable": { unset: "false" } },
  "/ReplicationController": { "status.replicas": { unset: "0" } },
  "apps/ReplicaSet": { "status.replicas": { unset: "0" } },
  "batch/Job": { "status.successful": { path: "status.succeeded", unset: "0" } },
};

/** The value of the selectable field `key` of `obj` as the API server compares it (`status.phase` → "Running"). */
export function fieldValueOf(obj: unknown, kind: string, key: string): string {
  const how = FIELD_VALUES[kind]?.[key];
  let value: unknown = obj;
  for (const part of (how?.path ?? key).split(".")) {
    if (value === null || typeof value !== "object") {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value === undefined || value === null ? (how?.unset ?? "") : String(value);
}

/** Whether the API server can select objects of `kind` (`group/Kind`) by the field `key`. */
export function isFieldKey(kind: string, key: string): boolean {
  return COMMON_FIELDS.includes(key) || (KIND_FIELDS[kind]?.includes(key) ?? false);
}

const NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const PREFIX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** A label key: `name` or `prefix/name`, the prefix a DNS subdomain of at most 253 characters. */
function isLabelKey(key: string): boolean {
  const slash = key.indexOf("/");
  if (slash < 0) return NAME.test(key);
  const prefix = key.slice(0, slash);
  return prefix.length <= 253 && PREFIX.test(prefix) && NAME.test(key.slice(slash + 1));
}

/** A label value: empty, or a name of at most 63 characters. */
function isLabelValue(value: string): boolean {
  return value === "" || NAME.test(value);
}

/** A field selector value the API server takes literally (no selector syntax inside). */
function isFieldValue(value: string): boolean {
  return value !== "" && value.length <= 253 && !/[,=!\\\s]/.test(value);
}

/** A selector term: `key`, the operator and the value (`app=web` → `app`, `=`, `web`). */
export function selectorTerm(term: string): { key: string; op: "=" | "==" | "!="; value: string } | null {
  const match = /^([^=!]+)(!=|==|=)(.*)$/.exec(term);
  if (!match) return null;
  return { key: match[1] ?? "", op: match[2] as "=" | "==" | "!=", value: match[3] ?? "" };
}

export interface ServerSelectors {
  labelSelector: string | null;
  fieldSelector: string | null;
}

/**
 * The label and field selectors the API server can apply for the search `terms` (split as the search splits them)
 * on `kind` (`group/Kind`); `null` when no term qualifies.
 */
export function serverSelectors(terms: readonly string[], kind: string): ServerSelectors {
  const labels: string[] = [];
  const fields: string[] = [];
  for (const term of terms) {
    const selector = selectorTerm(term);
    if (!selector) continue;
    const { key, value } = selector;
    const op = selector.op === "==" ? "=" : selector.op;
    if (isFieldKey(kind, key)) {
      if (isFieldValue(value)) fields.push(`${key}${op}${value}`);
      continue;
    }
    if (!isLabelKey(key) || !isLabelValue(value)) continue;
    if (value === "") {
      // `app=` is "has the label"; `app!=` stays in the window.
      if (op === "=") labels.push(key);
      continue;
    }
    labels.push(`${key}${op}${value}`);
  }
  const unique = (list: string[]) => (list.length > 0 ? [...new Set(list)].sort().join(",") : null);
  return { labelSelector: unique(labels), fieldSelector: unique(fields) };
}

/** Selectors joined: both must hold (`a=b` and `c=d` → `a=b,c=d`); `null` when neither is set. */
export function joinSelectors(...selectors: (string | null | undefined)[]): string | null {
  const parts = selectors.map((s) => s?.trim()).filter((s): s is string => Boolean(s));
  return parts.length > 0 ? parts.join(",") : null;
}
