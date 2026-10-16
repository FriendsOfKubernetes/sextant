// Details of Gateway API objects, one section (`gatewayApi`) for every kind of the section:
//   Gateway       — summary cards, a plain-language banner per broken listener, the listeners table, attached routes;
//   routes        — hostnames, a status row per parent, the rules as readable lines with backend readiness, broken
//                   rules outlined with the reason and, for RefNotPermitted, a ready-to-copy ReferenceGrant;
//   GatewayClass  — controller, Accepted with its reason, the Gateways using the class;
//   ReferenceGrant — who may refer to what, as a sentence and two tables;
//   BackendTLSPolicy — targets, validation and the status per Gateway.
// Conditions and YAML are the panel's own sections.
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KindRef, type KubeObject } from "../../api";
import { Button } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { findKind, ObjectLink, status, StatusText, useClusterKinds } from "../../resources";
import type { Tone } from "../../resources/status";
import { Block, chips, Fields, toYaml, type FieldRow } from "../details";
import { HEALTH_TONE, parentText, statusMark } from "./columns";
import { everywhere, servedKind, useBackendState, useGrants, useServedRoutes } from "./hooks";
import {
  apiVersionFor,
  attachedRouteCount,
  backendIssue,
  backendKey,
  backendsText,
  backendText,
  BACKEND_TLS_POLICY,
  conditionOf,
  conditionsOf,
  controllerName,
  explainReason,
  gatewayAddresses,
  gatewayClassHealth,
  gatewayClassName,
  gatewayHealth,
  gatewayOwnHealth,
  GATEWAY,
  GATEWAY_CLASS,
  GATEWAY_GROUP,
  grantFrom,
  grantTo,
  GRPC_ROUTE,
  HTTP_ROUTE,
  isKind,
  isRouteKind,
  listenersProgrammed,
  listenerStatuses,
  parentStatuses,
  policyAncestors,
  policyTargets,
  REFERENCE_GRANT,
  referenceGrantFor,
  routeAttachedTo,
  routeHostnames,
  routeRules,
  TCP_ROUTE,
  unpermittedCertificates,
  UDP_ROUTE,
  type BackendRef,
  type Condition,
  type Health,
  type ListenerStatus,
  type ObjRef,
  type Phrase,
  type RouteRule,
} from "./model";
import { gatewayPrefill, openRequestCheck } from "./checkState";

const { arr, get, str } = status;

/** Labels of the fields: `gateway:fields.*`. */
const FIELD_LABELS = "gateway:fields";
const NAMESPACE_KIND = "Namespace";

/** The API group as shown: "core" for the empty one. */
const groupText = (group: string) => group || "core";

/** A table row of a broken hop gets a red mark. */
export const rowClass = (health: Health) => (health === "problem" ? "gw-row--broken" : undefined);

/** All pods ready green, some or none red; unknown uncolored. */
function readyTone(state: { ready: number; total: number } | undefined): Tone | undefined {
  if (!state) return undefined;
  return state.total > 0 && state.ready === state.total ? "success" : "danger";
}

/** A backend problem as the ResolvedRefs condition a controller reports. */
const unresolved = (reason: string | undefined): Condition => ({ type: "ResolvedRefs", status: "False", reason });

/** A link that opens `ref`'s details, labelled `label` (default: its name). */
export function refLink(ref: ObjRef, label?: string): ReactNode {
  if (!ref.name) return null;
  return (
    <ObjectLink
      key={`${ref.kind}/${ref.namespace ?? ""}/${ref.name}`}
      target={{ apiVersion: apiVersionFor(ref), kind: ref.kind, name: ref.name }}
      namespace={ref.namespace}
    >
      {label ?? ref.name}
    </ObjectLink>
  );
}

export const gatewayRef = (name: string, namespace: string | null): ObjRef => ({
  group: GATEWAY_GROUP,
  kind: "Gateway",
  name,
  namespace,
});

/** "ns/name" when the namespace differs from `from`, else the name. */
export const nameFrom = (ref: ObjRef, from: string | null) =>
  ref.namespace && ref.namespace !== from ? `${ref.namespace}/${ref.name}` : ref.name;

/** "✓", "✗ NoMatchingListenerHostname", "? Pending" of one condition. */
export function conditionText(c: Condition | undefined): string {
  if (!c) return statusMark(undefined);
  return c.status === "True" ? statusMark("True") : [statusMark(c.status), c.reason].filter(Boolean).join(" ");
}

export function ConditionCell({ condition, bad = "False" }: { condition: Condition | undefined; bad?: string }) {
  const tone = !condition || condition.status === "Unknown" ? "warning" : condition.status === bad ? "danger" : "success";
  return <StatusText value={conditionText(condition)} tone={tone} />;
}

/** "OK", or what is wrong: "ResolvedRefs: RefNotPermitted". */
export function healthText(health: Health, problem: Condition | undefined, t: (key: string) => string): string {
  if (health === "ok") return t("gateway:health.ok");
  if (!problem) return t(`gateway:health.${health}`);
  return problem.reason ? `${problem.type}: ${problem.reason}` : problem.type;
}

/**
 * A problem in plain language: `title` (what failed), the explanation of the reason, the controller's message and
 * whatever `children` add (a ReferenceGrant to copy).
 */
export function ProblemBanner({
  title,
  condition,
  health = "problem",
  children,
}: {
  title: string;
  condition: Condition | undefined;
  health?: Health;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const key = explainReason(condition?.reason);
  return (
    <div className={`gw-problem gw-problem--${health}`} role="note">
      <div className="gw-problem__title">{title}</div>
      {key && <p className="gw-problem__text">{t(key)}</p>}
      {condition?.message && <p className="gw-problem__message">{condition.message}</p>}
      {children}
    </div>
  );
}

/** The `apiVersion` of ReferenceGrant the cluster serves (v1beta1 until discovery says otherwise). */
export function useGrantApiVersion(clusterId: ClusterId): string {
  const { kinds } = useClusterKinds(clusterId);
  const version = findKind(kinds, REFERENCE_GRANT)?.kindRef.version ?? REFERENCE_GRANT.version;
  return `${GATEWAY_GROUP}/${version}`;
}

/** The phrases as text: each translated, joined with `separator`. */
export function phrasesText(phrases: readonly Phrase[], t: (key: string, params?: Phrase["params"]) => string, separator: string) {
  return phrases.map((p) => t(p.key, p.params)).join(separator);
}

export const MATCH_SEPARATOR = " · ";
export const LIST_SEPARATOR = ", ";

const FEEDBACK_MS = 4000;

/** "Check a request…": opens the request check prefilled for the object. */
function CheckRequestButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button size="compact" icon="requestCheck" onClick={onClick}>
      {t("gateway:check.open")}
    </Button>
  );
}

/** "Copy ReferenceGrant YAML": puts the grant on the clipboard; says where it goes. */
export function CopyGrantButton({ grant, target }: { grant: KubeObject; target: string }) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<"copied" | "copyFailed" | null>(null);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [feedback]);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("the clipboard is not available");
      await navigator.clipboard.writeText(toYaml(grant));
      setFeedback("copied");
    } catch {
      setFeedback("copyFailed");
    }
  };
  return (
    <div className="gw-grant">
      <Button icon="copy" size="compact" onClick={() => void copy()}>
        {t("gateway:grant.copy")}
      </Button>
      <span className="dt-muted">{t("gateway:grant.for", { namespace: grant.metadata?.namespace, target })}</span>
      {feedback && (
        <span role="status" className={feedback === "copied" ? "gw-grant__ok" : "gw-grant__error"}>
          {t(`gateway:grant.${feedback}`)}
        </span>
      )}
    </div>
  );
}

export function LoadingLine({ text }: { text: string }) {
  return (
    <p className="dt-muted" role="status">
      {text}
    </p>
  );
}

export function SimpleTable({ headers, rows }: { headers: string[]; rows: { key: string; cells: ReactNode[]; className?: string }[] }) {
  return (
    <table className="dt-table">
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={row.className}>
            {row.cells.map((c, i) => (
              <td key={i}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- Gateway ----------

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gw-card">
      <div className="gw-card__label">{label}</div>
      <div className="gw-card__value">{children}</div>
    </div>
  );
}

function allowedText(l: ListenerStatus, t: (key: string, options?: Record<string, unknown>) => string): string {
  const from =
    l.allowedFrom === "All"
      ? t("gateway:listener.fromAll")
      : l.allowedFrom === "Selector"
        ? t("gateway:listener.fromSelector", { selector: l.allowedSelector.join(", ") })
        : t("gateway:listener.fromSame");
  return l.allowedKinds.length > 0 ? `${from}, ${t("gateway:listener.kinds", { kinds: l.allowedKinds.join(", ") })}` : from;
}

function GatewayDetails({ clusterId, gateway }: { clusterId: ClusterId; gateway: KubeObject }) {
  const { t } = useTranslation();
  const grantVersion = useGrantApiVersion(clusterId);
  const ns = gateway.metadata?.namespace ?? null;
  const className = gatewayClassName(gateway);
  const addresses = gatewayAddresses(gateway);
  const { programmed, total } = listenersProgrammed(gateway);
  const attached = attachedRouteCount(gateway);
  const lst = listenerStatuses(gateway);
  const own = gatewayOwnHealth(gateway);
  const none = t("gateway:cards.none");
  const certNamespaces = [
    ...new Set(lst.flatMap((l) => l.certificateRefs.flatMap((r) => (r.namespace && r.namespace !== ns ? [r.namespace] : [])))),
  ].sort();
  const grantsIn = useGrants(clusterId, certNamespaces);

  const banners = lst
    .filter((l) => l.health === "problem")
    .map((l) => {
      const c = l.problem;
      const crossNs = unpermittedCertificates(gateway, l, grantsIn);
      return (
        <ProblemBanner
          key={l.name}
          condition={c}
          title={t("gateway:listener.broken", { name: l.name, condition: c?.type, status: c?.status, reason: c?.reason })}
        >
          {c?.reason === "RefNotPermitted" &&
            ns &&
            crossNs.map((r) => (
              <CopyGrantButton
                key={`${r.namespace ?? ""}/${r.name}`}
                target={`${r.kind} ${r.namespace ?? ""}/${r.name}`}
                grant={referenceGrantFor(
                  { group: GATEWAY_GROUP, kind: GATEWAY.kind, namespace: ns },
                  { group: r.group, kind: r.kind, namespace: r.namespace ?? ns, name: r.name },
                  grantVersion,
                )}
              />
            ))}
        </ProblemBanner>
      );
    });

  const rows = lst.map((l) => ({
    key: l.name,
    className: rowClass(l.health),
    cells: [
      l.name,
      `${l.port ?? ""}/${l.protocol}`,
      l.hostname ?? t("gateway:listener.anyHostname"),
      l.certificateRefs.length > 0 ? (
        <span className="dt-links">
          {l.certificateRefs.map((r) => (r.group === "" && r.kind === "Secret" ? refLink(r, nameFrom(r, ns)) : `${r.kind} ${r.name}`))}
        </span>
      ) : (
        l.tlsMode
      ),
      allowedText(l, t),
      l.attachedRoutes,
      <StatusText key="s" value={healthText(l.health, l.problem, t)} tone={HEALTH_TONE[l.health]} />,
    ],
  }));

  return (
    <>
      <Block
        title={t("gateway:blocks.overview")}
        actions={<CheckRequestButton onClick={() => openRequestCheck(clusterId, { form: gatewayPrefill(gateway) })} />}
      >
        <div className="gw-cards">
          <Card label={t("gateway:cards.class")}>
            {className ? refLink({ group: GATEWAY_GROUP, kind: GATEWAY_CLASS.kind, name: className, namespace: null }) : none}
          </Card>
          <Card label={t("gateway:cards.addresses")}>{addresses.length > 0 ? addresses.join(", ") : none}</Card>
          <Card label={t("gateway:cards.listeners")}>
            <StatusText
              value={t("gateway:cards.listenersProgrammed", { programmed, total })}
              tone={programmed === total ? "success" : "danger"}
            />
          </Card>
          <Card label={t("gateway:cards.attachedRoutes")}>{attached ?? none}</Card>
        </div>
        {own.health !== "ok" && (
          <ProblemBanner
            health={own.health}
            condition={own.problem}
            title={t("gateway:gatewayProblem", {
              condition: own.problem?.type ?? "Accepted",
              status: own.problem?.status ?? "Unknown",
              reason: own.problem?.reason ?? "",
            })}
          />
        )}
        {banners}
      </Block>
      <Block title={t("gateway:blocks.listeners")}>
        <SimpleTable
          headers={[
            t("gateway:listener.name"),
            t("gateway:listener.port"),
            t("gateway:listener.hostname"),
            t("gateway:listener.tls"),
            t("gateway:listener.allowedRoutes"),
            t("gateway:listener.attached"),
            t("gateway:listener.status"),
          ]}
          rows={rows}
        />
      </Block>
      <AttachedRoutes clusterId={clusterId} gateway={gateway} />
    </>
  );
}

/** Routes of every served kind, in every namespace, that name `gateway` as a parent. */
function AttachedRoutes({ clusterId, gateway }: { clusterId: ClusterId; gateway: KubeObject }) {
  const { t } = useTranslation();
  const { routes, loading } = useServedRoutes(clusterId);

  const rows = routes.flatMap(({ kind, items }) =>
    items.flatMap((route) => {
      const parent = routeAttachedTo(route, gateway);
      if (!parent) return [];
      const ns = route.metadata?.namespace ?? null;
      const name = route.metadata?.name ?? "";
      return [
        {
          key: `${kind.kind}/${ns ?? ""}/${name}`,
          cells: [
            kind.kind,
            refLink({ group: GATEWAY_GROUP, kind: kind.kind, name, namespace: ns }),
            ns,
            parent.ref.sectionName ?? t("gateway:route.anyListener"),
            <StatusText key="s" value={parentText(parent)} tone={HEALTH_TONE[parent.health]} />,
          ],
        },
      ];
    }),
  ).sort((a, b) => a.key.localeCompare(b.key));

  return (
    <Block title={t("gateway:blocks.attachedRoutes")}>
      {rows.length > 0 && (
        <SimpleTable
          headers={[
            t("gateway:attached.kind"),
            t("gateway:attached.name"),
            t("gateway:attached.namespace"),
            t("gateway:attached.listener"),
            t("gateway:attached.status"),
          ]}
          rows={rows}
        />
      )}
      {loading ? (
        <LoadingLine text={t("gateway:attached.loading")} />
      ) : (
        rows.length === 0 && <p className="dt-muted">{t("gateway:attached.none")}</p>
      )}
    </Block>
  );
}

// ---------- Routes ----------

function ParentsBlock({ route }: { route: KubeObject }) {
  const { t } = useTranslation();
  const ns = route.metadata?.namespace ?? null;
  const parents = parentStatuses(route);
  const rows = parents.map((p, i) => ({
    key: `${i}:${p.ref.namespace ?? ""}/${p.ref.name}/${p.ref.sectionName ?? ""}`,
    className: rowClass(p.health),
    cells: [
      p.ref.kind === "Gateway" && p.ref.group === GATEWAY_GROUP ? refLink(p.ref, nameFrom(p.ref, ns)) : `${p.ref.kind} ${p.ref.name}`,
      [p.ref.sectionName ?? t("gateway:route.anyListener"), p.ref.port !== undefined ? `:${p.ref.port}` : ""].join(""),
      p.conditions.length > 0 ? <ConditionCell key="a" condition={p.accepted} /> : t("gateway:route.noStatus"),
      p.conditions.length > 0 ? <ConditionCell key="r" condition={p.resolvedRefs} /> : null,
    ],
  }));
  const problems = parents.filter((p) => p.health === "problem");
  return (
    <Block title={t("gateway:blocks.parents")}>
      <SimpleTable
        headers={[
          t("gateway:route.parent"),
          t("gateway:route.listener"),
          t("gateway:route.accepted"),
          t("gateway:route.resolvedRefs"),
        ]}
        rows={rows}
      />
      {problems.map((p, i) => (
        <ProblemBanner key={i} condition={p.problem} title={parentText(p)} />
      ))}
    </Block>
  );
}

function RulesBlock({
  clusterId,
  route,
  kind,
}: {
  clusterId: ClusterId;
  route: KubeObject;
  kind: KindRef;
}) {
  const { t } = useTranslation();
  const grantVersion = useGrantApiVersion(clusterId);
  const ns = route.metadata?.namespace ?? null;
  const rules = routeRules(route, kind);
  const parents = parentStatuses(route);
  const all = rules.flatMap((r) => [...r.backends, ...r.mirrors]);
  const namespaces = [
    ...new Set(all.flatMap((b) => (b.group === "" && b.kind === "Service" && b.namespace ? [b.namespace] : []))),
  ].sort();
  const crossNamespaces = [...new Set(all.flatMap((b) => (b.namespace && b.namespace !== ns ? [b.namespace] : [])))].sort();
  const { servicesIn, readiness } = useBackendState(clusterId, namespaces);
  const grantsIn = useGrants(clusterId, crossNamespaces);
  const matched = isKind(kind, HTTP_ROUTE, GRPC_ROUTE);
  const context = { routeNamespace: ns, routeKind: kind.kind, parents, servicesIn, grantsIn };

  return (
    <Block title={t("gateway:blocks.rules")}>
      {rules.map((rule) => (
        <RuleView
          key={rule.index}
          rule={rule}
          ns={ns}
          kind={kind}
          matched={matched}
          issueOf={(b) => backendIssue(b, context)}
          readiness={readiness}
          grantVersion={grantVersion}
        />
      ))}
    </Block>
  );
}

function RuleView({
  rule,
  ns,
  kind,
  matched,
  issueOf,
  readiness,
  grantVersion,
}: {
  rule: RouteRule;
  ns: string | null;
  kind: KindRef;
  matched: boolean;
  issueOf: (b: BackendRef) => string | undefined;
  readiness: (b: BackendRef) => { ready: number; total: number } | undefined;
  grantVersion: string;
}) {
  const { t } = useTranslation();
  const issues = rule.backends.map((b) => ({ backend: b, reason: issueOf(b) }));
  // A mirror in another namespace needs a grant too, and a missing one breaks the rule as well.
  const mirrorIssues = rule.mirrors.map((b) => ({ backend: b, reason: issueOf(b) }));
  const broken = [...issues, ...mirrorIssues].filter((i) => i.reason);
  const title = rule.name
    ? t("gateway:route.ruleNamed", { n: rule.index + 1, name: rule.name })
    : t("gateway:route.rule", { n: rule.index + 1 });
  const target = rule.backends.length > 0 ? ` → ${backendsText(rule, ns)}` : "";
  const matches =
    rule.matches.length > 0 ? rule.matches.map((m) => phrasesText(m, t, MATCH_SEPARATOR)) : [t("gateway:route.matchAll")];
  const lines = matched ? matches.map((m) => `${m}${target}`) : [backendsText(rule, ns)];
  const respondsItself = rule.filterTypes.includes("RequestRedirect");
  const problemText: Record<string, string> = {
    RefNotPermitted: t("gateway:route.notPermitted"),
    InvalidKind: t("gateway:route.invalidKind"),
    BackendNotFound: t("gateway:route.notFound"),
  };

  return (
    <div className={broken.length > 0 ? "gw-rule gw-rule--broken" : "gw-rule"} data-rule={rule.index}>
      <div className="gw-rule__title">{title}</div>
      {lines.map((line, i) => (
        <div key={i} className="gw-rule__line">
          {line}
        </div>
      ))}
      {rule.filters.length > 0 && (
        <div className="gw-rule__filters">
          <span className="dt-muted">{t("gateway:route.filters")}</span> {phrasesText(rule.filters, t, LIST_SEPARATOR)}
        </div>
      )}
      {rule.backends.length > 0 ? (
        <ul className="gw-rule__backends">
          {issues.map(({ backend, reason }) => {
            const state = reason ? undefined : readiness(backend);
            const readyText = state
              ? state.total > 0
                ? t("gateway:route.podsReady", { ready: state.ready, total: state.total })
                : t("gateway:route.noEndpoints")
              : undefined;
            const tone = readyTone(state);
            return (
              <li key={backendKey(backend)}>
                {backend.group === "" && backend.kind === "Service"
                  ? refLink(backend, backendText(backend, ns))
                  : backendText(backend, ns)}
                {rule.backends.length > 1 && <span className="dt-muted"> {`${backend.percent}%`}</span>}{" "}
                {reason ? (
                  <StatusText value={problemText[reason] ?? reason} tone="danger" />
                ) : (
                  readyText && <StatusText value={readyText} tone={tone} />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        !respondsItself && matched && <p className="dt-muted">{t("gateway:route.noBackends")}</p>
      )}
      {broken.map(({ backend, reason }) => (
        <ProblemBanner
          key={backendKey(backend)}
          title={t("gateway:route.brokenBackend", { backend: backendText(backend, ns), problem: reason })}
          condition={unresolved(reason)}
        >
          {reason === "RefNotPermitted" && ns && backend.namespace && (
            <CopyGrantButton
              target={`${backend.kind} ${backend.namespace}/${backend.name}`}
              grant={referenceGrantFor(
                { group: GATEWAY_GROUP, kind: kind.kind, namespace: ns },
                { group: backend.group, kind: backend.kind, namespace: backend.namespace, name: backend.name },
                grantVersion,
              )}
            />
          )}
        </ProblemBanner>
      ))}
    </div>
  );
}

function RouteDetails({ clusterId, route, kind }: { clusterId: ClusterId; route: KubeObject; kind: KindRef }) {
  const { t } = useTranslation();
  const hostnames = routeHostnames(route);
  const hasHostnames = !isKind(kind, TCP_ROUTE, UDP_ROUTE);
  const checkable = isKind(kind, HTTP_ROUTE, GRPC_ROUTE);
  const check = () =>
    openRequestCheck(clusterId, {
      route: {
        kind: kind.kind === GRPC_ROUTE.kind ? "GRPCRoute" : "HTTPRoute",
        namespace: route.metadata?.namespace ?? null,
        name: route.metadata?.name ?? "",
      },
      obj: route,
    });
  return (
    <>
      {hasHostnames && (
        <Block title={t("gateway:route.hostnames")} actions={checkable ? <CheckRequestButton onClick={check} /> : undefined}>
          {chips(hostnames) ?? <p className="dt-muted">{t("gateway:route.anyHostname")}</p>}
        </Block>
      )}
      <ParentsBlock route={route} />
      <RulesBlock clusterId={clusterId} route={route} kind={kind} />
    </>
  );
}

// ---------- GatewayClass ----------

function GatewayClassDetails({ clusterId, gatewayClass }: { clusterId: ClusterId; gatewayClass: KubeObject }) {
  const { t } = useTranslation();
  const { health, problem } = gatewayClassHealth(gatewayClass);
  const accepted = conditionOf(conditionsOf(get(gatewayClass, "status", "conditions")), "Accepted");
  const params = get(gatewayClass, "spec", "parametersRef");
  const paramsText = params
    ? [str(get(params, "kind")), [str(get(params, "namespace")), str(get(params, "name"))].filter(Boolean).join("/")]
        .filter(Boolean)
        .join(" ")
    : undefined;
  const rows: FieldRow[] = [
    ["controller", controllerName(gatewayClass)],
    ["description", str(get(gatewayClass, "spec", "description"))],
    ["accepted", accepted ? <ConditionCell condition={accepted} /> : t("gateway:route.noStatus")],
    ["parameters", paramsText],
    [
      "supportedFeatures",
      chips(arr(get(gatewayClass, "status", "supportedFeatures")).map((f) => (typeof f === "string" ? f : str(get(f, "name"))))),
    ],
  ];
  return (
    <>
      <Block title={t("gateway:blocks.fields")}>
        <Fields rows={rows} labelPrefix={FIELD_LABELS} />
        {health !== "ok" && (
          <ProblemBanner
            health={health}
            condition={problem}
            title={t("gateway:classProblem", { condition: problem?.type ?? "Accepted", status: problem?.status ?? "Unknown", reason: problem?.reason ?? "" })}
          />
        )}
      </Block>
      <ClassGateways clusterId={clusterId} gatewayClass={gatewayClass} />
    </>
  );
}

function ClassGateways({ clusterId, gatewayClass }: { clusterId: ClusterId; gatewayClass: KubeObject }) {
  const { t } = useTranslation();
  const kinds = useClusterKinds(clusterId);
  const served = servedKind(kinds, GATEWAY);
  const gateways = useWatch(clusterId, everywhere(served));
  const loading = served === undefined || (served !== null && gateways.status === "loading");
  const name = gatewayClass.metadata?.name;
  const rows = [...gateways.items.values()]
    .filter((gw) => gatewayClassName(gw) === name)
    .map((gw) => {
      const ns = gw.metadata?.namespace ?? null;
      const { health, problem } = gatewayHealth(gw);
      return {
        key: `${ns ?? ""}/${gw.metadata?.name ?? ""}`,
        cells: [
          refLink(gatewayRef(gw.metadata?.name ?? "", ns)),
          ns,
          gatewayAddresses(gw).join(", "),
          <StatusText key="s" value={healthText(health, problem, t)} tone={HEALTH_TONE[health]} />,
        ],
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  return (
    <Block title={t("gateway:blocks.gateways")}>
      {rows.length > 0 && (
        <SimpleTable
          headers={[
            t("gateway:attached.name"),
            t("gateway:attached.namespace"),
            t("gateway:columns.addresses"),
            t("gateway:attached.status"),
          ]}
          rows={rows}
        />
      )}
      {loading ? (
        <LoadingLine text={t("gateway:classGateways.loading")} />
      ) : (
        rows.length === 0 && <p className="dt-muted">{t("gateway:classGateways.none")}</p>
      )}
    </Block>
  );
}

// ---------- ReferenceGrant ----------

function ReferenceGrantDetails({ grant }: { grant: KubeObject }) {
  const { t } = useTranslation();
  const target = grant.metadata?.namespace ?? "";
  const from = grantFrom(grant);
  const to = grantTo(grant);
  const toText = to.map((x) => (x.name ? `${x.kind} ${x.name}` : `${x.kind} (${t("gateway:grantTable.anyName")})`)).join(", ");
  const sentences = from.map((f) =>
    t("gateway:grantTable.summary", { from: f.kind, namespace: f.namespace, to: toText, target }),
  );
  return (
    <Block title={t("gateway:blocks.grant")}>
      {sentences.map((s) => (
        <p key={s} className="gw-sentence">
          {s}
        </p>
      ))}
      <SimpleTable
        headers={[t("gateway:grantTable.from"), t("gateway:grantTable.kind"), t("gateway:grantTable.namespace")]}
        rows={from.map((f, i) => ({
          key: `${i}`,
          cells: [groupText(f.group), f.kind, refLink({ group: "", kind: NAMESPACE_KIND, name: f.namespace, namespace: null })],
        }))}
      />
      <SimpleTable
        headers={[t("gateway:grantTable.to"), t("gateway:grantTable.kind"), t("gateway:grantTable.name")]}
        rows={to.map((x, i) => ({
          key: `${i}`,
          cells: [
            groupText(x.group),
            x.kind,
            x.name ? refLink({ group: x.group, kind: x.kind, name: x.name, namespace: target }) : t("gateway:grantTable.anyName"),
          ],
        }))}
      />
    </Block>
  );
}

// ---------- BackendTLSPolicy ----------

function BackendTlsPolicyDetails({ policy }: { policy: KubeObject }) {
  const { t } = useTranslation();
  const ns = policy.metadata?.namespace ?? null;
  const validation = get(policy, "spec", "validation");
  const caRefs = arr(get(validation, "caCertificateRefs")).map((r) => ({
    group: str(get(r, "group")) ?? "",
    kind: str(get(r, "kind")) ?? "",
    name: str(get(r, "name")) ?? "",
    namespace: ns,
  }));
  const rows: FieldRow[] = [
    ["hostname", str(get(validation, "hostname"))],
    ["caCertificates", caRefs.length > 0 ? <span className="dt-links">{caRefs.map((r) => refLink(r, `${r.kind} ${r.name}`))}</span> : null],
    ["wellKnownCaCertificates", str(get(validation, "wellKnownCACertificates"))],
  ];
  const targets = policyTargets(policy);
  const ancestors = policyAncestors(policy);
  return (
    <>
      <Block title={t("gateway:blocks.fields")}>
        <Fields rows={rows} labelPrefix={FIELD_LABELS} />
      </Block>
      <Block title={t("gateway:blocks.targets")}>
        <span className="dt-links">
          {targets.map((target) =>
            refLink(target, `${target.kind} ${target.name}${target.sectionName ? ` (${target.sectionName})` : ""}`),
          )}
        </span>
      </Block>
      {ancestors.length > 0 && (
        <Block title={t("gateway:blocks.ancestors")}>
          <SimpleTable
            headers={[t("gateway:route.parent"), t("gateway:route.accepted"), t("gateway:attached.status")]}
            rows={ancestors.map((a, i) => ({
              key: `${i}`,
              className: rowClass(a.health),
              cells: [
                refLink(a.ref, nameFrom(a.ref, ns)),
                <ConditionCell key="a" condition={a.conditions.find((c) => c.type === "Accepted")} />,
                a.problem?.message ?? null,
              ],
            }))}
          />
          {ancestors
            .filter((a) => a.health === "problem")
            .map((a, i) => (
              <ProblemBanner key={i} condition={a.problem} title={`${a.ref.name}: ${conditionText(a.problem)}`} />
            ))}
        </Block>
      )}
    </>
  );
}

// ---------- The section ----------

/** The details section of every kind of the Gateway API section. */
export function GatewayApiSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, GATEWAY)) return <GatewayDetails clusterId={clusterId} gateway={obj} />;
  if (isRouteKind(kind)) return <RouteDetails clusterId={clusterId} route={obj} kind={kind} />;
  if (isKind(kind, GATEWAY_CLASS)) return <GatewayClassDetails clusterId={clusterId} gatewayClass={obj} />;
  if (isKind(kind, REFERENCE_GRANT)) return <ReferenceGrantDetails grant={obj} />;
  if (isKind(kind, BACKEND_TLS_POLICY)) return <BackendTlsPolicyDetails policy={obj} />;
  return null;
}
