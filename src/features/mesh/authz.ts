// "Who may call this workload?" from Istio AuthorizationPolicies (#155). Pure; three-valued: a condition Sextant
// cannot evaluate (a JWT claim, a header not given, an IP not given) is "unknown", never a guess.
//
// Which policies apply: those of the workload's namespace whose selector matches its labels (no selector → every
// workload of the namespace), and those of the root namespace likewise for every namespace. Policies with
// `targetRef(s)` attach to Gateways and waypoints, not to the workload's own proxy: they are listed as not evaluated.
//
// The order Istio evaluates them in:
//   1. CUSTOM — a match hands the request to the external authorizer (it may deny);
//   2. DENY   — any match denies;
//   3. ALLOW  — with no ALLOW policy the request is allowed; otherwise it must match one;
//   AUDIT only logs.
// Empty rules: a policy without `rules` matches nothing (an ALLOW one then allows nothing: every request is denied);
// a rule `{}` matches every request. Within a rule `from`, `to` and `when` must all match; any entry of `from` (or
// `to`) may; every field of an entry must; a list field matches when the value matches one item and no `not…` item.
// Values: exact, `prefix*`, `*suffix` or `*` (any non-empty value).
//
// The answer is never "allowed" while a DENY or CUSTOM policy might match (unknown), and never "allowed" while a
// DENY or CUSTOM policy attached by targetRef is not evaluated. The caller's principal is
// `cluster.local/ns/<namespace>/sa/<service account>` (the default trust domain) and assumes the caller is in the
// mesh with mTLS (without it the call has no principal and no namespace).
// A policy annotated `istio.io/dry-run: "true"` is evaluated and shown but never decides. A policy whose action
// Istio does not accept (it rejects it) makes the answer "unknown". The caller's own IP feeds `ipBlocks` and
// `source.ip`; `remoteIpBlocks` and `remote.ip` (the client behind a proxy, X-Forwarded-For) need a remote IP of
// their own, otherwise they are not evaluated. A header condition needs the header: a missing one matches no value.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { CLUSTER_DOMAIN, refOf, ROOT_NAMESPACE, type Ref } from "./istio";
import { AUTHORIZATION_POLICY } from "./kinds";
import type { Tri } from "./routing";

const { arr, get, record, str } = status;

/** `INVALID`: an action Istio does not accept (it rejects the policy), so what it does cannot be told. */
export type AuthzAction = "ALLOW" | "DENY" | "AUDIT" | "CUSTOM" | "INVALID";

const ACTIONS = ["ALLOW", "DENY", "AUDIT", "CUSTOM"];

/** The annotation that makes a policy log its decision without enforcing it. */
export const DRY_RUN_ANNOTATION = "istio.io/dry-run";

export const SOURCE_FIELDS = [
  "principals",
  "notPrincipals",
  "requestPrincipals",
  "notRequestPrincipals",
  "namespaces",
  "notNamespaces",
  "ipBlocks",
  "notIpBlocks",
  "remoteIpBlocks",
  "notRemoteIpBlocks",
] as const;
export const OPERATION_FIELDS = ["hosts", "notHosts", "ports", "notPorts", "methods", "notMethods", "paths", "notPaths"] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];
export type OperationField = (typeof OPERATION_FIELDS)[number];

export type FieldValues<F extends string> = Partial<Record<F, string[]>>;

export interface AuthzCondition {
  key: string;
  values: string[];
  notValues: string[];
}

export interface AuthzRule {
  from: FieldValues<SourceField>[];
  to: FieldValues<OperationField>[];
  when: AuthzCondition[];
}

export interface AuthzPolicy {
  obj: KubeObject;
  ref: Ref;
  namespace: string;
  action: AuthzAction;
  /** `istio.io/dry-run: "true"`: evaluated and logged, never enforced. */
  dryRun: boolean;
  provider?: string;
  /** `matchLabels`; `undefined` without a selector. */
  selector?: Record<string, string>;
  targetRef: boolean;
  rules: AuthzRule[];
}

const strings = (value: unknown): string[] => arr(value).map(String);

function fields<F extends string>(value: unknown, names: readonly F[]): FieldValues<F> {
  const out: FieldValues<F> = {};
  for (const name of names) {
    const list = strings(get(value, name));
    if (list.length > 0) out[name] = list;
  }
  return out;
}

export function parseAuthorizationPolicy(obj: KubeObject): AuthzPolicy {
  const action = str(get(obj, "spec", "action")) ?? "ALLOW";
  const labels = record(get(obj, "spec", "selector", "matchLabels"));
  return {
    obj,
    ref: refOf(AUTHORIZATION_POLICY, obj),
    namespace: obj.metadata?.namespace ?? "",
    action: (ACTIONS.includes(action) ? action : "INVALID") as AuthzAction,
    dryRun: String(record(obj.metadata?.annotations)[DRY_RUN_ANNOTATION] ?? "").toLowerCase() === "true",
    provider: str(get(obj, "spec", "provider", "name")),
    selector: Object.keys(labels).length > 0 ? Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, String(v)])) : undefined,
    targetRef: get(obj, "spec", "targetRef") !== undefined || arr(get(obj, "spec", "targetRefs")).length > 0,
    rules: arr(get(obj, "spec", "rules")).map((r) => ({
      from: arr(get(r, "from")).map((f) => fields(get(f, "source"), SOURCE_FIELDS)),
      to: arr(get(r, "to")).map((t) => fields(get(t, "operation"), OPERATION_FIELDS)),
      when: arr(get(r, "when")).map((c) => ({ key: str(get(c, "key")) ?? "", values: strings(get(c, "values")), notValues: strings(get(c, "notValues")) })),
    })),
  };
}

/** Whether `policy` applies to a workload of `namespace` with `labels` (`targetRef` policies never do here). */
export function policyApplies(policy: AuthzPolicy, namespace: string, labels: Record<string, string>, root = ROOT_NAMESPACE): boolean {
  if (policy.targetRef) return false;
  if (policy.namespace !== namespace && policy.namespace !== root) return false;
  return !policy.selector || Object.entries(policy.selector).every(([k, v]) => labels[k] === v);
}

export interface Caller {
  namespace?: string;
  serviceAccount?: string;
  /** The caller's own address (`source.ip`, `ipBlocks`). */
  ip?: string;
  /** The original client behind a proxy (X-Forwarded-For; `remote.ip`, `remoteIpBlocks`): unknown unless given. */
  remoteIp?: string;
  method?: string;
  path?: string;
  port?: number;
  host?: string;
  headers?: Record<string, string>;
}

export function callerPrincipal(caller: Caller): string | undefined {
  return caller.namespace && caller.serviceAccount ? `${CLUSTER_DOMAIN}/ns/${caller.namespace}/sa/${caller.serviceAccount}` : undefined;
}

/** Istio's value match: exact, `prefix*`, `*suffix`, `*` (non-empty). */
export function valueMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return value !== "";
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return value.endsWith(pattern.slice(1));
  return pattern === value;
}

function ipv4(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return undefined;
    n = n * 256 + Number(p);
  }
  return n;
}

/** Whether `ip` is in `block` (an address or CIDR); `undefined` for what is not IPv4. */
export function inBlock(block: string, ip: string): boolean | undefined {
  const [base, bits] = block.split("/");
  const a = ipv4(ip);
  const b = ipv4(base ?? "");
  if (a === undefined || b === undefined) return undefined;
  const size = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(size) || size < 0 || size > 32) return undefined;
  const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

const and = (list: Tri[]): Tri => (list.includes("no") ? "no" : list.includes("unknown") ? "unknown" : "yes");
const or = (list: Tri[]): Tri => (list.includes("yes") ? "yes" : list.includes("unknown") ? "unknown" : "no");

/** A list field: `positive` → the value must match an item; else it must match none. */
function listTri(items: string[], value: string | undefined, positive: boolean, test: (p: string, v: string) => boolean | undefined): Tri {
  if (value === undefined) return "unknown";
  const results = items.map((p) => test(p, value));
  const hit = results.includes(true);
  const unsure = results.includes(undefined);
  if (positive) return hit ? "yes" : unsure ? "unknown" : "no";
  return hit ? "no" : unsure ? "unknown" : "yes";
}

/** A principal pattern against a caller whose service account is not known but whose namespace is. */
function principalByNamespace(pattern: string, namespace: string | undefined): boolean | undefined {
  if (!namespace) return undefined;
  const m = /^[^/]+\/ns\/([^/*]+)\/sa\//.exec(pattern);
  return m && m[1] !== namespace ? false : undefined;
}

interface Evaluation {
  result: Tri;
  unknown: Set<string>;
}

function sourceTri(source: FieldValues<SourceField>, caller: Caller, unknown: Set<string>): Tri {
  const principal = callerPrincipal(caller);
  const results: Tri[] = [];
  for (const [field, items] of Object.entries(source) as [SourceField, string[]][]) {
    let r: Tri;
    const positive = !field.startsWith("not");
    switch (field) {
      case "principals":
      case "notPrincipals":
        r = principal
          ? listTri(items, principal, positive, valueMatches)
          : (() => {
              // Without the service account, a principal of another namespace still cannot match.
              const verdicts = items.map((p) => principalByNamespace(p, caller.namespace));
              if (verdicts.every((v) => v === false)) return positive ? "no" : "yes";
              return "unknown";
            })();
        break;
      case "namespaces":
      case "notNamespaces":
        r = listTri(items, caller.namespace, positive, valueMatches);
        break;
      case "ipBlocks":
      case "notIpBlocks":
        r = listTri(items, caller.ip, positive, inBlock);
        break;
      case "remoteIpBlocks":
      case "notRemoteIpBlocks":
        r = listTri(items, caller.remoteIp, positive, inBlock);
        break;
      default:
        // Request principals come from a JWT: not evaluated.
        r = "unknown";
    }
    if (r === "unknown") unknown.add(field);
    results.push(r);
  }
  return and(results);
}

function operationTri(op: FieldValues<OperationField>, caller: Caller, unknown: Set<string>): Tri {
  const results: Tri[] = [];
  for (const [field, items] of Object.entries(op) as [OperationField, string[]][]) {
    const positive = !field.startsWith("not");
    let r: Tri;
    if (field === "hosts" || field === "notHosts") r = listTri(items, caller.host?.toLowerCase(), positive, (p, v) => valueMatches(p.toLowerCase(), v));
    else if (field === "ports" || field === "notPorts") r = listTri(items, caller.port?.toString(), positive, (p, v) => p === v);
    else if (field === "methods" || field === "notMethods") r = listTri(items, caller.method?.toUpperCase(), positive, valueMatches);
    // Path templates (`{*}`, `{**}`) are not evaluated.
    else r = listTri(items, caller.path, positive, (p, v) => (p.includes("{") ? undefined : valueMatches(p, v)));
    if (r === "unknown") unknown.add(field);
    results.push(r);
  }
  return and(results);
}

function conditionTri(c: AuthzCondition, caller: Caller, unknown: Set<string>): Tri {
  const header = /^request\.headers\[(.+)\]$/.exec(c.key);
  let value: string | undefined;
  let test: (p: string, v: string) => boolean | undefined = valueMatches;
  let known = true;
  if (c.key === "source.namespace") value = caller.namespace;
  else if (c.key === "source.principal") value = callerPrincipal(caller);
  else if (c.key === "source.ip" || c.key === "remote.ip") {
    value = c.key === "source.ip" ? caller.ip : caller.remoteIp;
    test = inBlock;
  } else if (c.key === "destination.port") value = caller.port?.toString();
  else if (header && caller.headers) {
    // A header condition needs the header: a missing one matches no value (not even ""), and so every notValues.
    const present = caller.headers[header[1]!.toLowerCase()];
    if (present === undefined) return c.values.length > 0 ? "no" : "yes";
    value = present;
  } else known = false;
  if (!known || value === undefined) {
    unknown.add(c.key);
    return "unknown";
  }
  const parts: Tri[] = [];
  if (c.values.length > 0) parts.push(listTri(c.values, value, true, test));
  if (c.notValues.length > 0) parts.push(listTri(c.notValues, value, false, test));
  const r = and(parts);
  if (r === "unknown") unknown.add(c.key);
  return r;
}

/** Whether a rule matches the caller's request. */
export function ruleTri(rule: AuthzRule, caller: Caller): Evaluation {
  const unknown = new Set<string>();
  const from = rule.from.length === 0 ? "yes" : or(rule.from.map((s) => sourceTri(s, caller, unknown)));
  const to = rule.to.length === 0 ? "yes" : or(rule.to.map((o) => operationTri(o, caller, unknown)));
  const when = and(rule.when.map((c) => conditionTri(c, caller, unknown)));
  return { result: and([from, to, when]), unknown };
}

export interface PolicyVerdict {
  ref: Ref;
  action: AuthzAction;
  /** Logged only, not enforced (`istio.io/dry-run`). */
  dryRun: boolean;
  /** Whether a rule of the policy matches (a policy without rules matches nothing). */
  match: Tri;
  /** The first rule that matched. */
  rule?: number;
  /** What could not be evaluated (field names and condition keys). */
  unknown: string[];
}

export type AuthzDecision = "allowed" | "denied" | "unknown" | "external";

export type DecisionReason =
  | "noPolicies"
  | "allowMatched"
  | "noAllowMatched"
  | "denyMatched"
  | "denyMayMatch"
  | "allowMayMatch"
  | "customMatched"
  | "customMayMatch"
  | "invalidPolicy"
  | "targetRefNotEvaluated";

export interface AuthzResult {
  decision: AuthzDecision;
  reason: DecisionReason;
  /** The policy that decided, if one did. */
  by?: PolicyVerdict;
  verdicts: PolicyVerdict[];
  /** Policies attached by targetRef in the namespaces that matter: not evaluated. */
  notEvaluated: Ref[];
}

export function policyVerdict(policy: AuthzPolicy, caller: Caller): PolicyVerdict {
  const unknown = new Set<string>();
  let match: Tri = "no";
  let rule: number | undefined;
  for (const [i, r] of policy.rules.entries()) {
    const e = ruleTri(r, caller);
    for (const u of e.unknown) unknown.add(u);
    if (e.result === "yes") {
      match = "yes";
      rule = i;
      break;
    }
    if (e.result === "unknown") match = "unknown";
  }
  return { ref: policy.ref, action: policy.action, dryRun: policy.dryRun, match, rule, unknown: [...unknown] };
}

/** Whether `caller` may call a workload of `namespace` with `labels`. */
export function whoMayCall(
  namespace: string,
  labels: Record<string, string>,
  policies: readonly AuthzPolicy[],
  caller: Caller,
  root = ROOT_NAMESPACE,
): AuthzResult {
  const applying = policies.filter((p) => policyApplies(p, namespace, labels, root));
  const notEvaluated = policies.filter((p) => p.targetRef && (p.namespace === namespace || p.namespace === root));
  const verdicts = applying.map((p) => policyVerdict(p, caller));
  // A dry-run policy is shown with its verdict but decides nothing.
  const of = (action: AuthzAction) => verdicts.filter((v) => v.action === action && !v.dryRun);
  const custom = of("CUSTOM");
  const deny = of("DENY");
  const allow = of("ALLOW");
  const base = { verdicts, notEvaluated: notEvaluated.map((p) => p.ref) };
  const denyHit = deny.find((v) => v.match === "yes");
  if (denyHit) return { ...base, decision: "denied", reason: "denyMatched", by: denyHit };
  const unsureDeny = deny.find((v) => v.match === "unknown");
  if (unsureDeny) return { ...base, decision: "unknown", reason: "denyMayMatch", by: unsureDeny };
  // Istio rejects a policy whose action it does not know: what it would do cannot be told.
  const invalid = of("INVALID")[0];
  if (invalid) return { ...base, decision: "unknown", reason: "invalidPolicy", by: invalid };
  let allowed: { decision: AuthzDecision; reason: DecisionReason; by?: PolicyVerdict };
  if (allow.length === 0) allowed = { decision: "allowed", reason: "noPolicies" };
  else {
    const hit = allow.find((v) => v.match === "yes");
    const unsure = allow.find((v) => v.match === "unknown");
    allowed = hit
      ? { decision: "allowed", reason: "allowMatched", by: hit }
      : unsure
        ? { decision: "unknown", reason: "allowMayMatch", by: unsure }
        : { decision: "denied", reason: "noAllowMatched" };
  }
  if (allowed.decision === "denied") return { ...base, ...allowed };
  const customHit = custom.find((v) => v.match === "yes");
  if (customHit) return { ...base, decision: "external", reason: "customMatched", by: customHit };
  const unsureCustom = custom.find((v) => v.match === "unknown");
  if (unsureCustom) return { ...base, decision: "unknown", reason: "customMayMatch", by: unsureCustom };
  const blocking = notEvaluated.some((p) => !p.dryRun && (p.action === "DENY" || p.action === "CUSTOM" || p.action === "INVALID"));
  if (allowed.decision === "allowed" && blocking) return { ...base, decision: "unknown", reason: "targetRefNotEvaluated" };
  return { ...base, ...allowed };
}
