// Details of Traefik objects (#232), one section for every kind of the section. Traefik writes no status, so each view
// opens with what can be judged — whether the objects its references name exist (store.ts) — and says why one breaks
// the object or cannot be judged. Then per kind:
//   IngressRoute(TCP/UDP) — entry points, ingress class, parents, TLS (Secret with its certificate through the
//                           core's TLS reader, options, store, resolver, domains) and the routes: match, priority,
//                           middlewares and services, each a link;
//   TraefikService        — its strategy and the services it sends to (weights, mirror percentages, fallback);
//   Middleware            — its type and, for a chain, the middlewares in order;
//   TLSOption / TLSStore / ServersTransport — their main settings and the Secrets they read.
// Read-only.
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { inline, type TypeRef } from "../details/ui";
import { TlsCertificateView } from "../cert-manager/TlsSection";
import {
  apiVersionOf,
  isRouteKind,
  isTraefik,
  middlewareRefs,
  middlewareType,
  routeSpec,
  traefikKind,
  traefikServiceRefs,
  traefikServiceType,
  MIDDLEWARE,
  SERVERS_TRANSPORT,
  SERVERS_TRANSPORT_TCP,
  TLS_OPTION,
  TLS_STORE,
  TRAEFIK_SERVICE,
  type Ref,
  type Route,
} from "./model";
import { breaks, HEALTH_TONE, type Health, type RefCheck, type RefState } from "./resolve";
import { useTraefik } from "./store";

const { get, str } = status;
const LABELS = "traefik:fields";
const ROUTES_TABLE = "traefikRoutes";
const ROUTES_WRAP: ColumnWrap[] = ["nowrap", undefined, "nowrap", undefined, undefined];
const REFS_TABLE = "traefikReferences";
const REFS_WRAP: ColumnWrap[] = ["nowrap", undefined, undefined, undefined];

const STATE_TONE: Record<RefState, "success" | "danger" | "muted" | "warning"> = {
  found: "success",
  missing: "danger",
  badKind: "danger",
  crossNamespace: "warning",
  otherProvider: "muted",
  unknown: "muted",
};

/** The details link of what a reference names, in the group of the object it is in. */
function refType(ref: Ref, group: string): TypeRef {
  if (ref.kind === "Service") return KINDS.service;
  if (ref.kind === "Secret") return KINDS.secret;
  return { apiVersion: apiVersionOf({ group, version: "v1alpha1" }), kind: ref.kind };
}

/** A reference as a link (another provider's object as its name only). */
function refLink(ref: Ref, group: string): React.ReactNode {
  if (ref.provider) return `${ref.name}@${ref.provider}`;
  return link(refType(ref, group), ref.name, ref.namespace, ref.crossNamespace ? `${ref.namespace}/${ref.name}` : ref.name);
}

function HealthText({ health }: { health: Health }) {
  const { t } = useTranslation();
  return <StatusText value={t(`traefik:health.${health}`)} tone={HEALTH_TONE[health]} />;
}

/** What can be judged without a status, in plain words. */
function Judged({ health, checks, issues }: { health: Health; checks: RefCheck[]; issues: { type: string; route: number; value?: string }[] }) {
  const { t } = useTranslation();
  const broken = checks.filter(breaks);
  const cross = checks.some((c) => c.state === "crossNamespace");
  const other = checks.some((c) => c.state === "otherProvider");
  const unknown = checks.some((c) => c.state === "unknown");
  return (
    <>
      <p className="cm-muted">{t("traefik:explain.noStatus")}</p>
      {health === "failed" && broken.length > 0 && <p className="cm-explain cm-explain--danger">{t("traefik:explain.broken", { count: broken.length })}</p>}
      {issues.map((i) => (
        <p key={`${i.type}-${i.route}`} className="cm-explain cm-explain--danger">
          {t(`traefik:explain.${i.type}`, { route: i.route + 1, kind: i.value ?? "" })}
        </p>
      ))}
      {cross && <p className="cm-explain">{t("traefik:explain.crossNamespace")}</p>}
      {other && <p className="cm-explain">{t("traefik:explain.otherProvider")}</p>}
      {unknown && <p className="cm-explain">{t("traefik:explain.unknown")}</p>}
    </>
  );
}

function stateText(t: (key: string, options?: Record<string, unknown>) => string, check: RefCheck): string {
  return t(`traefik:refState.${check.state}`, { kind: check.ref.badKind ?? "" });
}

/** Every reference of the object with what it finds. */
function ReferencesTable({ checks, group }: { checks: RefCheck[]; group: string }) {
  const { t } = useTranslation();
  const rows = checks.map((c) => [
    c.ref.kind,
    refLink(c.ref, group),
    t(`traefik:place.${c.ref.place}`, { route: (c.ref.route ?? 0) + 1 }),
    <StatusText key="s" value={stateText(t, c)} tone={STATE_TONE[c.state]} />,
  ]);
  const headers = [t("traefik:refs.kind"), t("traefik:refs.name"), t("traefik:refs.where"), t("traefik:refs.state")];
  const body = table(REFS_TABLE, headers, rows, REFS_WRAP);
  return body ? <Block title={t("traefik:refs.title")}>{body}</Block> : null;
}

const portText = (ref: Ref) => (ref.port === undefined ? "" : `:${ref.port}`);

function serviceCell(ref: Ref, group: string, t: (key: string, options?: Record<string, unknown>) => string): React.ReactNode {
  const extra = ref.weight === undefined ? "" : t(ref.place === "mirror" ? "traefik:values.percent" : "traefik:values.weight", { value: ref.weight });
  return (
    <span key={`${ref.kind}/${ref.namespace}/${ref.name}/${ref.place}`}>
      {refLink(ref, group)}
      {portText(ref)}
      {extra ? ` ${extra}` : ""}
    </span>
  );
}

function RoutesTable({ routes, group }: { routes: Route[]; group: string }) {
  const { t } = useTranslation();
  const rows = routes.map((r) => [
    String(r.index + 1),
    r.match ? <code key="m">{r.match}</code> : "",
    r.priority === undefined ? "" : String(r.priority),
    inline(r.middlewares.map((m) => refLink(m, group))),
    inline(r.services.map((s) => serviceCell(s, group, t))),
  ]);
  const headers = [t("traefik:routes.number"), t("traefik:routes.match"), t("traefik:routes.priority"), t("traefik:routes.middlewares"), t("traefik:routes.services")];
  const body = table(ROUTES_TABLE, headers, rows, ROUTES_WRAP);
  return body ? <Block title={t("traefik:routes.title")}>{body}</Block> : null;
}

function RouteView({ clusterId, kind, obj }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const spec = routeSpec(kind, obj);
  const tls = spec.tls;
  const ns = obj.metadata?.namespace ?? "";
  const rows: FieldRow[] = [
    ["entryPoints", spec.entryPoints.length > 0 ? chips(spec.entryPoints) : t("traefik:values.allEntryPoints")],
    ["ingressClassName", spec.ingressClassName],
    ["parents", inline(spec.parents.map((p) => refLink(p, kind.group)))],
    ["tlsSecret", tls?.secretName ? link(KINDS.secret, tls.secretName, ns) : undefined],
    ["tlsOptions", tls?.options ? refLink(tls.options, kind.group) : undefined],
    ["tlsStore", tls?.store ? refLink(tls.store, kind.group) : undefined],
    ["certResolver", tls?.certResolver],
    ["domains", tls && tls.domains.length > 0 ? chips(tls.domains) : undefined],
    ["passthrough", tls?.passthrough ? t("traefik:values.yes") : undefined],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      {spec.ingressClassName && <p className="cm-muted">{t("traefik:explain.ingressClass", { name: spec.ingressClassName })}</p>}
      <RoutesTable routes={spec.routes} group={kind.group} />
      {tls?.secretName && (
        <Block title={t("traefik:fields.certificate")}>
          <TlsCertificateView clusterId={clusterId} obj={{ metadata: { namespace: ns, name: tls.secretName } } as KubeObject} />
        </Block>
      )}
      {tls?.certResolver && !tls.secretName && <p className="cm-muted">{t("traefik:explain.certResolver", { name: tls.certResolver })}</p>}
    </>
  );
}

function TraefikServiceView({ kind, obj }: { kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const type = traefikServiceType(obj);
  const children = traefikServiceRefs(obj).filter((r) => r.kind === "Service" || r.kind === "TraefikService");
  const byPlace = (place: Ref["place"]) => inline(children.filter((r) => r.place === place).map((r) => serviceCell(r, kind.group, t)));
  const rows: FieldRow[] = [
    ["strategy", type ? t(`traefik:strategy.${type}`) : undefined],
    ["services", byPlace("service")],
    ["mirrors", byPlace("mirror")],
    ["fallback", byPlace("fallback")],
  ];
  return <Fields rows={rows} labelPrefix={LABELS} />;
}

function MiddlewareView({ kind, obj }: { kind: KindRef; obj: KubeObject }) {
  const chain = isTraefik(kind, MIDDLEWARE) ? middlewareRefs(obj).filter((r) => r.place === "chain") : [];
  const rows: FieldRow[] = [
    ["type", middlewareType(obj)],
    ["chain", inline(chain.map((r) => refLink(r, kind.group)))],
  ];
  return <Fields rows={rows} labelPrefix={LABELS} />;
}

function SettingsView({ kind, obj }: { kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const spec = get(obj, "spec");
  const tls = isTraefik(kind, SERVERS_TRANSPORT_TCP) ? get(spec, "tls") : spec;
  const insecure = get(tls, "insecureSkipVerify") === true;
  const rows: FieldRow[] = isTraefik(kind, TLS_OPTION)
    ? [
        ["minVersion", str(get(spec, "minVersion"))],
        ["maxVersion", str(get(spec, "maxVersion"))],
        ["clientAuth", str(get(spec, "clientAuth", "clientAuthType"))],
        ["sniStrict", get(spec, "sniStrict") === true ? t("traefik:values.yes") : undefined],
      ]
    : isTraefik(kind, TLS_STORE)
      ? [["defaultCertificate", str(get(spec, "defaultCertificate", "secretName"))]]
      : [
          ["serverName", str(get(tls, "serverName"))],
          ["insecureSkipVerify", insecure ? <StatusText key="i" value={t("traefik:values.insecure")} tone="warning" /> : undefined],
        ];
  return <Fields rows={rows} labelPrefix={LABELS} />;
}

const stateRow = (health: Health): FieldRow[] => [["state", <HealthText key="h" health={health} />]];

export function TraefikSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const state = useTraefik(clusterId);
  const def = traefikKind(objectRef.kind);
  if (!obj || !def) return null;
  const kind = objectRef.kind;
  const finding = obj.metadata?.uid ? state.byUid.get(obj.metadata.uid) : undefined;
  const health: Health = finding?.judgement.health ?? "loading";
  const view = isRouteKind(kind) ? (
    <RouteView clusterId={clusterId} kind={kind} obj={obj} />
  ) : isTraefik(kind, TRAEFIK_SERVICE) ? (
    <TraefikServiceView kind={kind} obj={obj} />
  ) : isTraefik(kind, TLS_OPTION) || isTraefik(kind, TLS_STORE) || isTraefik(kind, SERVERS_TRANSPORT) || isTraefik(kind, SERVERS_TRANSPORT_TCP) ? (
    <SettingsView kind={kind} obj={obj} />
  ) : (
    <MiddlewareView kind={kind} obj={obj} />
  );
  return (
    <Block title={t("details:sections.fields", { kind: kind.kind })}>
      <Fields rows={stateRow(health)} labelPrefix={LABELS} />
      {finding && <Judged health={health} checks={finding.judgement.checks} issues={finding.judgement.issues} />}
      {view}
      {finding && <ReferencesTable checks={finding.judgement.checks} group={kind.group} />}
    </Block>
  );
}
