// Plain-language lines of mesh objects (#155): each a whole sentence under `` with its values, so the views
// translate them and never glue words together. Pure.
import { formatList } from "../i18n";
import type { AuthzPolicy, AuthzRule, OperationField, SourceField } from "./authz";
import { OPERATION_FIELDS, SOURCE_FIELDS } from "./authz";
import { ROOT_NAMESPACE, stringMatchText, type Destination, type HttpMatch, type HttpRoute, type StringMatch } from "./istio";

export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
}

const p = (key: string, params?: Record<string, string | number>): Phrase => ({ key, params });

function stringPhrase(field: string, m: StringMatch, extra: Record<string, string> = {}): Phrase {
  return p(`match.${field}.${m.type}`, { value: m.value, ...extra });
}

/** The conditions of one `match` block, one sentence each. */
export function matchPhrases(m: HttpMatch): Phrase[] {
  const out: Phrase[] = [];
  if (m.uri) out.push(stringPhrase(m.ignoreUriCase ? "uriIgnoreCase" : "uri", m.uri));
  if (m.method) out.push(stringPhrase("method", m.method));
  if (m.scheme) out.push(stringPhrase("scheme", m.scheme));
  if (m.authority) out.push(stringPhrase("authority", m.authority));
  for (const [name, v] of m.headers) out.push(v === "present" ? p("match.headerPresent", { name }) : stringPhrase("header", v, { name }));
  for (const [name, v] of m.withoutHeaders)
    out.push(v === "present" ? p("match.headerAbsent", { name }) : p("match.headerNot", { name, value: stringMatchText(v) }));
  for (const [name, v] of m.queryParams) out.push(v === "present" ? p("match.queryPresent", { name }) : stringPhrase("query", v, { name }));
  if (m.port !== undefined) out.push(p("match.port", { port: m.port }));
  if (m.sourceLabels) out.push(p("match.sourceLabels", { labels: formatList(Object.entries(m.sourceLabels).map(([k, v]) => `${k}=${v}`)) }));
  if (m.sourceNamespace) out.push(p("match.sourceNamespace", { namespace: m.sourceNamespace }));
  if (m.gateways) out.push(p("match.gateways", { gateways: formatList(m.gateways) }));
  return out;
}

/** `host:port`, `host:port (subset v2)`. */
export function destinationText(d: Destination): string {
  return d.port !== undefined ? `${d.host}:${d.port}` : d.host;
}

/** What a route does besides sending: timeouts, retries, faults, mirroring, rewrites. */
export function routeExtras(r: HttpRoute): Phrase[] {
  const out: Phrase[] = [];
  if (r.timeout) out.push(p("route.timeout", { timeout: r.timeout }));
  if (r.retries) {
    if (r.retries.attempts === 0) out.push(p("route.noRetries"));
    else
      out.push(
        p(r.retries.perTryTimeout ? "route.retriesPerTry" : "route.retries", {
          count: r.retries.attempts ?? 2,
          perTry: r.retries.perTryTimeout ?? "",
          on: r.retries.retryOn ?? "",
        }),
      );
    if (r.retries.retryOn) out.push(p("route.retryOn", { on: r.retries.retryOn }));
  }
  if (r.fault?.delay) out.push(p("route.faultDelay", { delay: r.fault.delay, percent: r.fault.delayPercent ?? 100 }));
  if (r.fault?.abortStatus !== undefined) out.push(p("route.faultAbort", { status: r.fault.abortStatus, percent: r.fault.abortPercent ?? 100 }));
  if (r.mirror) out.push(p("route.mirror", { host: destinationText(r.mirror), percent: r.mirrorPercent ?? 100 }));
  const uri = r.rewrite?.uri;
  if (typeof uri === "string") out.push(p("route.rewriteUri", { uri }));
  const authority = r.rewrite?.authority;
  if (typeof authority === "string") out.push(p("route.rewriteAuthority", { authority }));
  return out;
}

/** What a route sends to, when it does not send to destinations. */
export function routeAction(r: HttpRoute): Phrase | undefined {
  if (r.delegate) return p("route.delegate", { name: `${r.delegate.namespace}/${r.delegate.name}` });
  if (r.directResponse) return p("route.directResponse", { status: r.directResponse.status ?? "" });
  if (r.redirect) {
    const target = [r.redirect.authority, r.redirect.uri].filter((v) => typeof v === "string").join("");
    return p(target ? "route.redirectTo" : "route.redirect", { target });
  }
  return undefined;
}

/** One line per field of a rule: `{ field, values }` (labels under `authz.fields`). */
export interface RuleLine {
  part: "from" | "to" | "when";
  /** Index of the `from`/`to` entry (entries are alternatives). */
  entry: number;
  field: SourceField | OperationField | "condition";
  key?: string;
  values: string[];
  notValues?: string[];
}

export function ruleLines(rule: AuthzRule): RuleLine[] {
  const out: RuleLine[] = [];
  rule.from.forEach((source, entry) => {
    for (const field of SOURCE_FIELDS) if (source[field]) out.push({ part: "from", entry, field, values: source[field]! });
  });
  rule.to.forEach((op, entry) => {
    for (const field of OPERATION_FIELDS) if (op[field]) out.push({ part: "to", entry, field, values: op[field]! });
  });
  rule.when.forEach((c, entry) => out.push({ part: "when", entry, field: "condition", key: c.key, values: c.values, notValues: c.notValues }));
  return out;
}

/** The sentences of a policy as a whole: where it applies, what its action does, what empty rules mean. */
export function policyPhrases(policy: AuthzPolicy, rootNamespace = ROOT_NAMESPACE): Phrase[] {
  const scope = policy.targetRef ? "targetRef" : policy.selector ? "workloads" : policy.namespace === rootNamespace ? "mesh" : "namespace";
  const out = [p(`authz.scope.${scope}`, { namespace: policy.namespace }), p(`authz.action.${policy.action}`, { provider: policy.provider ?? "" })];
  if (policy.dryRun) out.push(p("authz.dryRun"));
  if (policy.rules.length === 0) out.push(p(policy.action === "ALLOW" ? "authz.special.allowNothing" : "authz.special.noRules"));
  else if (policy.rules.some((r) => r.from.length === 0 && r.to.length === 0 && r.when.length === 0)) out.push(p("authz.special.everything"));
  return out;
}
