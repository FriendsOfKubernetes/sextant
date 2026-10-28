import { useDetailsDisclosure } from "../../layout/details/disclosure";
// The details of an HTTPProxy (#233): its state in plain words and Contour's own errors and warnings, the virtual
// host (host, addresses, TLS — a Secret of another namespace with the TLSCertificateDelegation that allows it — and
// the policies attached to the host, an authorization ExtensionService linked), the routes with their match
// conditions, services with their share of requests or the percent mirrored, and the policies attached to each
// route, the includes with the state of each included proxy, a TCP proxy's services, and the delegation tree.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { formatNumber } from "../../i18n/format";
import { StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { explain } from "./explain";
import { useDelegations, useProxyIndex } from "./hooks";
import {
  apiVersionOf,
  authorizationRef,
  delegationFor,
  description,
  EXTENSION_SERVICE,
  fqdnOf,
  HEALTH_TONE,
  healthOf,
  hostPoliciesOf,
  HTTP_PROXY,
  includesOf,
  ingressClassOf,
  proxyAddresses,
  proxyKey,
  proxyState,
  routesOf,
  shares,
  TLS_DELEGATION,
  tcpServicesOf,
  tlsOf,
  validCondition,
  type ProxyService,
  type SecretRef,
} from "./model";
import { DelegationTree } from "./tree";

const LABELS = "contour:fields";
const type = (kind: typeof HTTP_PROXY) => ({ apiVersion: apiVersionOf(kind), kind: kind.kind });
const ISSUES_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined];
const ROUTES_WRAP: ColumnWrap[] = ["nowrap", undefined, undefined, undefined, undefined];
const INCLUDES_WRAP: ColumnWrap[] = ["nowrap", undefined, "nowrap"];

function ProxyStatus({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  return <StatusText value={t(`contour:state.${proxyState(obj)}`)} tone={HEALTH_TONE[healthOf(HTTP_PROXY, obj)]} />;
}

function Explanation({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const phrase = explain(obj);
  const state = proxyState(obj);
  const cls = state === "invalid" || state === "orphaned" ? "cm-explain cm-explain--danger" : "cm-explain";
  const said = description(obj);
  const firstMessage = validCondition(obj)?.errors[0]?.message;
  return (
    <>
      <p className={cls}>{t(`contour:explain.${phrase.key}`, phrase.params ?? {})}</p>
      {said && said !== firstMessage && state !== "valid" && <p className="cm-message">{said}</p>}
    </>
  );
}

/** Contour's errors and warnings of the Valid condition, one row each. */
export function Issues({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const valid = validCondition(obj);
  if (!valid) return null;
  const rows = [
    ...valid.errors.map((e) => [t("contour:issues.error"), e.type, e.reason ?? "", e.message ?? ""]),
    ...valid.warnings.map((w) => [t("contour:issues.warning"), w.type, w.reason ?? "", w.message ?? ""]),
  ];
  const headers = [t("contour:issues.kind"), t("contour:issues.type"), t("contour:issues.reason"), t("contour:issues.message")];
  const body = table("contourIssues", headers, rows, ISSUES_WRAP);
  return body ? <Block id="contour:issues.title" title={t("contour:issues.title")}>{body}</Block> : null;
}

/** The TLSCertificateDelegation that lets this proxy use a Secret of another namespace, or why there is none. */
function DelegationField({ clusterId, secret, target }: { clusterId: ClusterId; secret: SecretRef; target: string }) {
  const { t } = useTranslation();
  const { items, state, served } = useDelegations(clusterId, secret.namespace);
  if (served === false) return <>{t("contour:fields.delegationNotServed")}</>;
  if (state?.status !== "ready") return <>{state?.status === "error" ? t("contour:fields.delegationUnknown") : t("contour:fields.delegationLoading")}</>;
  const found = delegationFor(items, secret, target);
  if (!found) return <span className="cm-message">{t("contour:fields.delegationMissing", { namespace: secret.namespace, target })}</span>;
  return <>{link(type(TLS_DELEGATION), found.metadata?.name, secret.namespace)}</>;
}

function hostRows(clusterId: ClusterId, obj: KubeObject, t: (k: string, o?: Record<string, unknown>) => string): FieldRow[] {
  const own = obj.metadata?.namespace ?? "";
  const tls = tlsOf(obj);
  const auth = authorizationRef(obj);
  const versions = [tls?.minimumProtocolVersion, tls?.maximumProtocolVersion].filter(Boolean).join(" – ");
  return [
    ["status", <ProxyStatus key="s" obj={obj} />],
    ["fqdn", fqdnOf(obj)],
    ["ingressClass", ingressClassOf(obj)],
    ["addresses", chips(proxyAddresses(obj))],
    ["tlsSecret", tls?.secret ? link(KINDS.secret, tls.secret.name, tls.secret.namespace, tls.secret.delegated ? `${tls.secret.namespace}/${tls.secret.name}` : undefined) : null],
    ["tlsDelegation", tls?.secret?.delegated ? <DelegationField key="d" clusterId={clusterId} secret={tls.secret} target={own} /> : null],
    ["tlsPassthrough", tls?.passthrough ? t("contour:yes") : null],
    ["tlsVersions", versions],
    ["fallbackCertificate", tls?.fallbackCertificate ? t("contour:yes") : null],
    ["clientValidation", tls?.clientValidation ? t("contour:yes") : null],
    ["hostPolicies", chips(hostPoliciesOf(obj))],
    ["authorization", auth ? link(type(EXTENSION_SERVICE), auth.name, auth.namespace) : null],
  ];
}

/** One service of a route: a link to the Service, its port, and its share (or the percent mirrored). */
function serviceCell(services: readonly ProxyService[], namespace: string, t: (k: string, o?: Record<string, unknown>) => string): ReactNode {
  const share = shares(services);
  return (
    <span className="ct-services">
      {services.map((s, i) => (
        <span key={`${s.name}:${i}`} className="ct-service">
          {link(KINDS.service, s.name, namespace, s.port === undefined ? s.name : `${s.name}:${s.port}`)}
          <span className="cm-chain__extra">
            {s.mirror
              ? t("contour:routes.mirror", { percent: formatNumber(share[i] ?? 0) })
              : t("contour:routes.share", { percent: formatNumber(share[i] ?? 0) })}
          </span>
        </span>
      ))}
    </span>
  );
}

function Routes({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const namespace = obj.metadata?.namespace ?? "";
  const rows = routesOf(obj).map((r) => [
    String(r.index + 1),
    r.conditions.length > 0 ? chips(r.conditions) : t("contour:routes.everything"),
    r.services.length > 0 ? serviceCell(r.services, namespace, t) : "",
    chips(r.policies),
    r.redirect
      ? t("contour:routes.redirect")
      : r.directResponse !== undefined
        ? t("contour:routes.directResponse", { code: r.directResponse })
        : r.services.every((s) => s.mirror)
          ? t("contour:routes.noService")
          : r.websockets
            ? t("contour:routes.websockets")
            : "",
  ]);
  const headers = [t("contour:routes.number"), t("contour:routes.conditions"), t("contour:routes.services"), t("contour:routes.policies"), t("contour:routes.action")];
  const body = table("contourRoutes", headers, rows, ROUTES_WRAP);
  return body ? <Block id="contour:routes.title" title={t("contour:routes.title")}>{body}</Block> : null;
}

function Includes({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const includes = includesOf(obj);
  const open = useDetailsDisclosure("contour:includes.title")?.open ?? true;
  const { index } = useProxyIndex(clusterId, open && includes.length > 0);
  const rows = includes.map((inc) => {
    const row = index.get(proxyKey(inc.namespace, inc.name));
    const state = row ? t(`contour:state.${row.state}`) : index.size > 0 ? t("contour:tree.missing") : "";
    return [
      link(type(HTTP_PROXY), inc.name, inc.namespace, `${inc.namespace}/${inc.name}`),
      inc.tcp ? t("contour:tree.tcp") : inc.conditions.length > 0 ? chips(inc.conditions) : t("contour:routes.everything"),
      state,
    ];
  });
  const headers = [t("contour:includes.proxy"), t("contour:includes.conditions"), t("contour:includes.state")];
  const body = table("contourIncludes", headers, rows, INCLUDES_WRAP);
  return body ? <Block id="contour:includes.title" title={t("contour:includes.title")}>{body}</Block> : null;
}

function TcpServices({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const services = tcpServicesOf(obj);
  if (services.length === 0) return null;
  return <Block id="contour:tcp.title" title={t("contour:tcp.title")}>{serviceCell(services, obj.metadata?.namespace ?? "", t)}</Block>;
}

export function ProxyView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  return (
    <>
      <Explanation obj={obj} />
      <Fields rows={hostRows(clusterId, obj, t)} labelPrefix={LABELS} />
      <Issues obj={obj} />
      <Routes obj={obj} />
      <TcpServices obj={obj} />
      <Includes clusterId={clusterId} obj={obj} />
      <DelegationTree clusterId={clusterId} obj={obj} />
    </>
  );
}
