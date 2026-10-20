// What the Kyverno section reads from Kyverno policies and policy reports (#213): the kinds it knows, a policy's
// readiness and mode (Enforce or Audit, per rule since Kyverno 1.13), its rules, and the results of the reports —
// per object (Kyverno writes one report per resource, named by the resource's uid, `scope` naming it) and per policy
// (reports carry the label `cpol.kyverno.io/<policy>` or `pol.kyverno.io/<policy>`). Pure functions, no React.
import type { KindRef, KubeObject, ObjectRef } from "../../api";
import { kindFromApiVersion, status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, num, str } = status;

export const KYVERNO_GROUP = "kyverno.io";
export const REPORT_GROUP = "wgpolicyk8s.io";
export const EPHEMERAL_GROUP = "reports.kyverno.io";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const CLUSTER_POLICY = k(KYVERNO_GROUP, "v1", "ClusterPolicy");
export const POLICY = k(KYVERNO_GROUP, "v1", "Policy");
export const POLICY_REPORT = k(REPORT_GROUP, "v1alpha2", "PolicyReport");
export const CLUSTER_POLICY_REPORT = k(REPORT_GROUP, "v1alpha2", "ClusterPolicyReport");
export const EPHEMERAL_REPORT = k(EPHEMERAL_GROUP, "v1", "EphemeralReport");
export const CLUSTER_EPHEMERAL_REPORT = k(EPHEMERAL_GROUP, "v1", "ClusterEphemeralReport");

export interface KyvernoKind {
  kind: KindRef;
  order: number;
  /** Key under `kyverno:sidebar`. */
  label: string;
  namespaced: boolean;
}

export const KYVERNO_KINDS: readonly KyvernoKind[] = [
  { kind: CLUSTER_POLICY, order: 10, label: "clusterPolicies", namespaced: false },
  { kind: POLICY, order: 11, label: "policies", namespaced: true },
  { kind: POLICY_REPORT, order: 20, label: "policyReports", namespaced: true },
  { kind: CLUSTER_POLICY_REPORT, order: 21, label: "clusterPolicyReports", namespaced: false },
  { kind: EPHEMERAL_REPORT, order: 30, label: "ephemeralReports", namespaced: true },
  { kind: CLUSTER_EPHEMERAL_REPORT, order: 31, label: "clusterEphemeralReports", namespaced: false },
];

export const sameKind = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) =>
  a.group === b.group && a.kind === b.kind;

export function kyvernoKind(kind: Pick<KindRef, "group" | "kind">): KyvernoKind | undefined {
  return KYVERNO_KINDS.find((d) => sameKind(d.kind, kind));
}

export const isPolicyKind = (kind: Pick<KindRef, "group" | "kind">) => sameKind(kind, CLUSTER_POLICY) || sameKind(kind, POLICY);
export const isReportKind = (kind: Pick<KindRef, "group" | "kind">) => kind.group === REPORT_GROUP || kind.group === EPHEMERAL_GROUP;
const isEphemeral = (kind: Pick<KindRef, "group" | "kind">) => kind.group === EPHEMERAL_GROUP;

export const apiVersionOf = (kind: KindRef) => `${kind.group}/${kind.version}`;

// ---------- Policies ----------

export type Mode = "Enforce" | "Audit";

/** `Enforce`/`enforce` → Enforce, `Audit`/`audit` → Audit; anything else is not a mode. */
export function normalizeMode(value: unknown): Mode | undefined {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  return text === "enforce" ? "Enforce" : text === "audit" ? "Audit" : undefined;
}

export type RuleType = "validate" | "mutate" | "generate" | "verifyImages";
const RULE_TYPES: readonly RuleType[] = ["validate", "mutate", "generate", "verifyImages"];

export interface PolicyRule {
  name: string;
  type?: RuleType;
  /** Validation and image verification rules only: the rule's own action, else the policy's, else Audit. */
  mode?: Mode;
  kinds: string[];
}

function matchedKinds(rule: unknown): string[] {
  const match = get(rule, "match");
  const blocks = [get(match, "resources"), ...arr(get(match, "any")).map((b) => get(b, "resources")), ...arr(get(match, "all")).map((b) => get(b, "resources"))];
  return [...new Set(blocks.flatMap((b) => arr(get(b, "kinds")).map(str)).filter((v): v is string => Boolean(v)))];
}

export function policyRules(policy: KubeObject): PolicyRule[] {
  const policyMode = normalizeMode(get(policy, "spec", "validationFailureAction")) ?? "Audit";
  return arr(get(policy, "spec", "rules")).map((rule) => {
    const type = RULE_TYPES.find((t) => get(rule, t) !== undefined);
    const own = type === "validate" || type === "verifyImages" ? normalizeMode(get(rule, type, "failureAction")) : undefined;
    // `verifyImages` is a list; each entry may set its own action.
    const images = type === "verifyImages" ? arr(get(rule, "verifyImages")).map((v) => normalizeMode(get(v, "failureAction"))).find(Boolean) : undefined;
    return {
      name: str(get(rule, "name")) ?? "",
      type,
      mode: type === "validate" || type === "verifyImages" ? (own ?? images ?? policyMode) : undefined,
      kinds: matchedKinds(rule),
    };
  });
}

/** Enforce, Audit, or Mixed when the rules differ; `undefined` for a policy that validates nothing. */
export function policyMode(policy: KubeObject): Mode | "Mixed" | undefined {
  const modes = new Set(policyRules(policy).flatMap((r) => (r.mode ? [r.mode] : [])));
  if (modes.size === 0) return undefined;
  return modes.size > 1 ? "Mixed" : [...modes][0];
}

/** Ready from the `Ready` condition (Kyverno 1.9+), else the older `status.ready`. */
export function policyReady(policy: KubeObject): "True" | "False" | "Unknown" | undefined {
  const ready = arr(get(policy, "status", "conditions")).find((c) => get(c, "type") === "Ready");
  const value = str(get(ready, "status"));
  if (value === "True" || value === "False" || value === "Unknown") return value;
  const legacy = get(policy, "status", "ready");
  return legacy === true ? "True" : legacy === false ? "False" : undefined;
}

export function policyMessage(policy: KubeObject): string | undefined {
  const ready = arr(get(policy, "status", "conditions")).find((c) => get(c, "type") === "Ready");
  return str(get(ready, "message"));
}

export const readyTone = (value: string | undefined): Tone =>
  value === "True" ? "success" : value === "False" ? "danger" : value === "Unknown" ? "warning" : "muted";

export const modeTone = (mode: string | undefined): Tone => (mode === "Enforce" ? "warning" : "neutral");

export const backgroundScan = (policy: KubeObject) => get(policy, "spec", "background") !== false;

export const isPolicyProblem = (policy: KubeObject) => policyReady(policy) === "False";

/** The name results give a policy: `name` for a ClusterPolicy, `namespace/name` for a Policy. */
export function resultPolicyName(policy: KubeObject, kind: Pick<KindRef, "group" | "kind">): string {
  const name = policy.metadata?.name ?? "";
  return sameKind(kind, POLICY) ? `${policy.metadata?.namespace ?? ""}/${name}` : name;
}

/** The label Kyverno puts on the reports that hold results of a policy; `undefined` when it cannot be a label. */
export function policyReportLabel(policy: KubeObject, kind: Pick<KindRef, "group" | "kind">): string | undefined {
  const name = policy.metadata?.name ?? "";
  if (!name || name.length > 63) return undefined;
  return `${sameKind(kind, POLICY) ? "pol" : "cpol"}.kyverno.io/${name}`;
}

// ---------- Reports ----------

export type ResultValue = "pass" | "fail" | "warn" | "error" | "skip";
export const RESULT_VALUES: readonly ResultValue[] = ["fail", "error", "warn", "pass", "skip"];

export const RESULT_TONE: Record<ResultValue, Tone> = { pass: "success", fail: "danger", warn: "warning", error: "danger", skip: "muted" };

export interface PolicyResult {
  policy: string;
  rule?: string;
  result: ResultValue;
  message?: string;
  severity?: string;
  category?: string;
  /** RFC 3339, from the result's `timestamp.seconds`. */
  time?: string;
}

/** What a report is about: `scope` (wgpolicyk8s.io) or `spec.owner` (reports.kyverno.io). */
export function reportScope(kind: Pick<KindRef, "group" | "kind">, report: KubeObject): ObjectRef | undefined {
  const scope = isEphemeral(kind) ? get(report, "spec", "owner") : get(report, "scope");
  const apiVersion = str(get(scope, "apiVersion"));
  const scopeKind = str(get(scope, "kind"));
  const name = str(get(scope, "name"));
  if (!apiVersion || !scopeKind || !name) return undefined;
  const namespace = str(get(scope, "namespace")) ?? (isEphemeral(kind) ? report.metadata?.namespace : undefined) ?? null;
  return { kind: kindFromApiVersion(apiVersion, scopeKind), namespace, name };
}

export function reportResults(kind: Pick<KindRef, "group" | "kind">, report: KubeObject): PolicyResult[] {
  const list = isEphemeral(kind) ? get(report, "spec", "results") : get(report, "results");
  return arr(list).flatMap((r) => {
    const result = str(get(r, "result")) as ResultValue | undefined;
    const policy = str(get(r, "policy"));
    if (!policy || !result || !RESULT_VALUES.includes(result)) return [];
    const seconds = num(get(r, "timestamp", "seconds"));
    return [
      {
        policy,
        rule: str(get(r, "rule")),
        result,
        message: str(get(r, "message")),
        severity: str(get(r, "severity")),
        category: str(get(r, "category")),
        time: seconds === undefined ? undefined : new Date(seconds * 1000).toISOString(),
      },
    ];
  });
}

export type Summary = Record<ResultValue, number>;

/** The report's `summary`, else counted from its results. */
export function reportSummary(kind: Pick<KindRef, "group" | "kind">, report: KubeObject): Summary {
  const summary = isEphemeral(kind) ? get(report, "spec", "summary") : get(report, "summary");
  if (summary && typeof summary === "object") {
    const out = {} as Summary;
    for (const v of RESULT_VALUES) out[v] = num(get(summary, v)) ?? 0;
    return out;
  }
  return countResults(reportResults(kind, report));
}

export function countResults(results: readonly PolicyResult[]): Summary {
  const out: Summary = { pass: 0, fail: 0, warn: 0, error: 0, skip: 0 };
  for (const r of results) out[r.result]++;
  return out;
}

export const isReportProblem = (kind: Pick<KindRef, "group" | "kind">) => (report: KubeObject) => reportSummary(kind, report).fail > 0;

/** Failures first, then errors, warnings, passes and skips; by policy and rule within each. */
export function sortResults(results: readonly PolicyResult[]): PolicyResult[] {
  const rank = (r: PolicyResult) => RESULT_VALUES.indexOf(r.result);
  return [...results].sort((a, b) => rank(a) - rank(b) || a.policy.localeCompare(b.policy) || (a.rule ?? "").localeCompare(b.rule ?? ""));
}

/** A result's policy as a link target: a ClusterPolicy by name, a Policy as `namespace/name`. */
export function policyTarget(result: PolicyResult): { kind: KindRef; namespace: string | null; name: string } {
  const slash = result.policy.indexOf("/");
  return slash > 0
    ? { kind: POLICY, namespace: result.policy.slice(0, slash), name: result.policy.slice(slash + 1) }
    : { kind: CLUSTER_POLICY, namespace: null, name: result.policy };
}
