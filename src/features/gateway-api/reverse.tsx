// Reverse links of the Gateway API, as details sections of the objects traffic reaches:
//   Service    — "Exposed by": the external addresses, routes and Gateway listeners (and Ingresses) that reach it;
//   TLS Secret — "Used by listeners": the Gateway listeners whose certificates name it;
//   targets    — "Policies attached": the policies (`spec.targetRefs`) that name the object.
// Each section shows only when there is something. Nothing is watched for a kind the cluster does not serve: routes
// and Gateways only when the Gateway API is served, Ingresses only when Ingress is; lists are bounded to the
// namespaces that can matter wherever references are namespace-local (Ingress backends, policy targets), and every
// watch ends when the details close.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KindRef, type KubeObject, type ResourceKind } from "../../api";
import { dotSeparator } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { kindKey, ObjectLink, StatusText, useClusterKinds } from "../../resources";
import type { Tone } from "../../resources/status";
import { Block } from "../details";
import { HEALTH_TONE, policyStatusText } from "./columns";
import { breakable, healthText, nameFrom, phraseText, refLink, rowClass, SimpleTable } from "./details";
import {
  ingressExposures,
  listenersUsingSecret,
  policiesTargeting,
  routesReaching,
  serviceExposures,
  type Exposure,
  type ExposureState,
  type ExposureTarget,
} from "./exposure";
import { everywhere, inNamespaces, INGRESS, servedKind, useGrants, useServedRoutes } from "./hooks";
import { explainReason, GATEWAY, GATEWAY_GROUP, parentStatuses, policyHealth, ROUTE_KINDS, type Health, type ObjRef } from "./model";
import { isAttachedPolicy, policyKinds } from "./policies";

// ---------- Service: Exposed by ----------

const STATE_TONE: Record<ExposureState, Tone | undefined> = {
  serving: "success",
  mirror: "success",
  redirect: undefined,
  notAttached: "danger",
  notPermitted: "danger",
  pending: "warning",
};

function ExposureStatus({ exposure }: { exposure: Pick<Exposure, "state" | "reason"> }) {
  const { t } = useTranslation();
  const label = t(`gateway:exposedBy.state.${exposure.state}`);
  const value = exposure.reason && exposure.state !== "serving" ? `${label}: ${exposure.reason}` : label;
  const explained = explainReason(exposure.reason);
  return (
    <span title={explained ? t(explained) : undefined}>
      <StatusText value={value} tone={STATE_TONE[exposure.state]} />
    </span>
  );
}

/**
 * The ways in, one per line: the address, then what else the request needs there and the Service's share of the
 * rule's traffic — `https://shop.example.com/api · header x-env=prod · 90%`.
 */
function Addresses({ targets }: { targets: readonly ExposureTarget[] }) {
  const { t } = useTranslation();
  if (targets.length === 0) return <span className="dt-muted">{t("gateway:exposedBy.noAddress")}</span>;
  return (
    <span className="gw-addresses">
      {targets.map((target, i) => {
        const extra = [
          ...target.conditions.map((c) => phraseText(c, t)),
          ...(target.percent !== undefined ? [t("gateway:exposedBy.share", { percent: target.percent })] : []),
        ];
        return (
          <span key={`${i}:${target.url}`} className="gw-address">
            <span className="gw-address__url">{breakable(target.url)}</span>
            {extra.map((part, j) => (
              <span key={j} className="gw-address__extra">{`${dotSeparator()}${part}`}</span>
            ))}
          </span>
        );
      })}
    </span>
  );
}

/** "public-gw / http", or the parent's kind and name when it is not a Gateway. */
function parentCell(exposure: Exposure, from: string | null) {
  const p = exposure.parent.ref;
  const isGateway = p.group === GATEWAY_GROUP && p.kind === "Gateway";
  return (
    <span className="dt-links">
      {isGateway ? refLink(p, nameFrom(p, from)) : `${p.kind} ${p.name}`}
      {exposure.listener && <span className="dt-muted">{` / ${exposure.listener}`}</span>}
    </span>
  );
}

function ExposedBy({ clusterId, service }: { clusterId: ClusterId; service: KubeObject }) {
  const { t } = useTranslation();
  const kinds = useClusterKinds(clusterId);
  const ns = service.metadata?.namespace ?? "";
  const svc = { namespace: ns, name: service.metadata?.name ?? "" };
  const { routes } = useServedRoutes(clusterId);
  const reaching = routesReaching(routes, svc);
  // Only the Gateways the reaching routes name, only the grants of the Service's namespace when a route is elsewhere.
  const gatewayNamespaces = reaching.flatMap(({ route }) =>
    parentStatuses(route).flatMap((p) => (p.ref.kind === "Gateway" && p.ref.group === GATEWAY_GROUP && p.ref.namespace ? [p.ref.namespace] : [])),
  );
  const gateways = useWatch(clusterId, inNamespaces(servedKind(kinds, GATEWAY), gatewayNamespaces));
  const grantsIn = useGrants(clusterId, reaching.some(({ route }) => route.metadata?.namespace !== ns) ? [ns] : []);
  const ingresses = useWatch(clusterId, inNamespaces(servedKind(kinds, INGRESS), ns ? [ns] : []));

  const gatewayList = [...gateways.items.values()];
  const exposures = serviceExposures(service, {
    routes,
    gatewayOf: (ref: ObjRef) =>
      gatewayList.find((g) => g.metadata?.name === ref.name && (g.metadata?.namespace ?? null) === ref.namespace),
    grantsIn,
  });
  const viaIngress = ingressExposures(service, ingresses.items.values());
  if (exposures.length === 0 && viaIngress.length === 0) return null;

  const rows = [
    ...exposures.map((e) => ({
      key: e.key,
      className: rowClass(e.health),
      cells: [
        <Addresses key="a" targets={e.targets} />,
        <span key="r" className="dt-links">
          <span className="dt-muted">{e.routeKind}</span> {refLink(e.route, nameFrom(e.route, ns))}
        </span>,
        parentCell(e, ns),
        <ExposureStatus key="s" exposure={e} />,
      ],
    })),
    ...viaIngress.map((e) => ({
      key: `ingress:${e.key}`,
      cells: [
        <Addresses key="a" targets={[{ url: e.address, conditions: [] }]} />,
        <span key="r" className="dt-links">
          <span className="dt-muted">{e.ingress.kind}</span> {refLink(e.ingress)}
        </span>,
        e.ingressClass
          ? refLink({ group: "networking.k8s.io", kind: "IngressClass", name: e.ingressClass, namespace: null })
          : null,
        <StatusText
          key="s"
          value={t(e.health === "ok" ? "gateway:exposedBy.state.serving" : "gateway:exposedBy.noLoadBalancer")}
          tone={HEALTH_TONE[e.health]}
        />,
      ],
    })),
  ];
  return (
    <Block title={t("gateway:exposedBy.title")}>
      <SimpleTable
        tableId="gateway.exposedBy"
        headers={[
          t("gateway:exposedBy.address"),
          t("gateway:exposedBy.route"),
          t("gateway:exposedBy.gateway"),
          t("gateway:exposedBy.status"),
        ]}
        rows={rows}
      />
    </Block>
  );
}

export function ExposedBySection({ clusterId, obj }: DetailsSectionProps) {
  return obj ? <ExposedBy clusterId={clusterId} service={obj} /> : null;
}

// ---------- TLS Secret: Used by listeners ----------

const TLS_SECRET_TYPE = "kubernetes.io/tls";
const PROBLEM: Health = "problem";

function UsedByListeners({ clusterId, secret }: { clusterId: ClusterId; secret: KubeObject }) {
  const { t } = useTranslation();
  const kinds = useClusterKinds(clusterId);
  const ns = secret.metadata?.namespace ?? "";
  const gateways = useWatch(clusterId, everywhere(servedKind(kinds, GATEWAY)));
  const fromElsewhere = [...gateways.items.values()].some((g) => g.metadata?.namespace !== ns);
  const grantsIn = useGrants(clusterId, fromElsewhere ? [ns] : []);
  const uses = listenersUsingSecret(secret, gateways.items.values(), grantsIn);
  if (uses.length === 0) return null;
  return (
    <Block title={t("gateway:secretUse.title")}>
      <SimpleTable
        tableId="gateway.secretUse"
        headers={[t("gateway:secretUse.gateway"), t("gateway:secretUse.listener"), t("gateway:secretUse.status")]}
        rows={uses.map(({ key, gateway, listener, notPermitted }) => ({
          key,
          className: rowClass(notPermitted ? PROBLEM : listener.health),
          cells: [
            refLink(gateway, nameFrom(gateway, ns)),
            `${listener.name} (${listener.port ?? ""}/${listener.protocol}${listener.hostname ? ` ${listener.hostname}` : ""})`,
            notPermitted ? (
              <StatusText key="s" value={t("gateway:secretUse.notPermitted")} tone="danger" />
            ) : (
              <StatusText key="s" value={healthText(listener.health, listener.problem, t)} tone={HEALTH_TONE[listener.health]} />
            ),
          ],
        }))}
      />
    </Block>
  );
}

export function UsedByListenersSection({ clusterId, obj }: DetailsSectionProps) {
  // Only a TLS Secret can serve a listener: nothing is watched for the others.
  if (!obj || obj.type !== TLS_SECRET_TYPE) return null;
  return <UsedByListeners clusterId={clusterId} secret={obj} />;
}

// ---------- Policies attached ----------

/** Kinds policies attach to (GEP-713 targets): Gateways, routes, listener sets, Services and their imports. */
const POLICY_TARGETS: Pick<KindRef, "group" | "kind">[] = [
  GATEWAY,
  ...ROUTE_KINDS,
  { group: GATEWAY_GROUP, kind: "ListenerSet" },
  { group: "gateway.networking.x-k8s.io", kind: "XListenerSet" },
  { group: "", kind: "Service" },
  { group: "multicluster.x-k8s.io", kind: "ServiceImport" },
];

export function isPolicyTarget(kind: Pick<KindRef, "group" | "kind">): boolean {
  return POLICY_TARGETS.some((k) => k.group === kind.group && k.kind === kind.kind);
}

interface Found {
  kind: ResourceKind;
  policies: { policy: KubeObject; sectionNames: string[] }[];
}

/** Same kind and the same policy objects naming the same sections: nothing to re-render. */
function samePolicies(a: Found, b: Found): boolean {
  return (
    a.kind === b.kind &&
    a.policies.length === b.policies.length &&
    a.policies.every((p, i) => p.policy === b.policies[i]?.policy && p.sectionNames.join() === b.policies[i]?.sectionNames.join())
  );
}

/** Watches one policy kind in the object's namespace (targetRefs are local) and reports the policies naming it. */
function PolicyKindWatch({
  clusterId,
  kind,
  target,
  targetKind,
  onFound,
}: {
  clusterId: ClusterId;
  kind: ResourceKind;
  target: KubeObject;
  targetKind: KindRef;
  onFound: (key: string, found: Found | null) => void;
}) {
  const ns = target.metadata?.namespace ?? "";
  const watch = useWatch(clusterId, inNamespaces(kind.kindRef, [ns]));
  const policies = useMemo(
    () => policiesTargeting(target, targetKind, [...watch.items.values()].filter(isAttachedPolicy)),
    [watch.items, target, targetKind],
  );
  const key = kindKey(kind.kindRef);
  useEffect(() => {
    onFound(key, policies.length > 0 ? { kind, policies } : null);
  }, [key, kind, policies, onFound]);
  useEffect(() => () => onFound(key, null), [key, onFound]);
  return null;
}

function PoliciesAttached({ clusterId, obj, kind }: { clusterId: ClusterId; obj: KubeObject; kind: KindRef }) {
  const { t } = useTranslation();
  const { kinds } = useClusterKinds(clusterId);
  const [found, setFound] = useState<ReadonlyMap<string, Found>>(() => new Map());
  const onFound = useCallback(
    (key: string, value: Found | null) =>
      setFound((prev) => {
        if (!value) {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        }
        const old = prev.get(key);
        return old && samePolicies(old, value) ? prev : new Map(prev).set(key, value);
      }),
    [],
  );
  // Policy attachment is a Gateway API mechanism: without it served, no policy kind is watched.
  const candidates = kinds?.some((k) => k.kindRef.group === GATEWAY_GROUP)
    ? policyKinds(kinds).filter((k) => k.namespaced)
    : [];
  const rows = [...found.values()]
    .sort((a, b) => a.kind.kindRef.kind.localeCompare(b.kind.kindRef.kind))
    .flatMap(({ kind: policyKind, policies }) =>
      policies.map(({ policy, sectionNames }) => {
        const name = policy.metadata?.name ?? "";
        const apiVersion = policyKind.kindRef.group ? `${policyKind.kindRef.group}/${policyKind.kindRef.version}` : policyKind.kindRef.version;
        const health = policyHealth(policy).health;
        const statusText = policyStatusText(policy);
        return {
          key: `${kindKey(policyKind.kindRef)}/${name}`,
          className: rowClass(health),
          cells: [
            policyKind.kindRef.kind,
            <ObjectLink key="n" target={{ apiVersion, kind: policyKind.kindRef.kind, name }} namespace={policy.metadata?.namespace ?? null}>
              {name}
            </ObjectLink>,
            sectionNames.join(", ") || t("gateway:attachedPolicies.whole"),
            <StatusText key="s" value={statusText || t("gateway:attachedPolicies.noStatus")} tone={statusText ? HEALTH_TONE[health] : undefined} />,
          ],
        };
      }),
    );
  return (
    <>
      {candidates.map((k) => (
        <PolicyKindWatch
          key={kindKey(k.kindRef)}
          clusterId={clusterId}
          kind={k}
          target={obj}
          targetKind={kind}
          onFound={onFound}
        />
      ))}
      {rows.length > 0 && (
        <Block title={t("gateway:attachedPolicies.title")}>
          <SimpleTable
            tableId="gateway.attachedPolicies"
            headers={[
              t("gateway:attachedPolicies.kind"),
              t("gateway:attachedPolicies.name"),
              t("gateway:attachedPolicies.section"),
              t("gateway:attachedPolicies.status"),
            ]}
            rows={rows}
          />
        </Block>
      )}
    </>
  );
}

export function PoliciesAttachedSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  // Policies are namespaced and target objects of their own namespace.
  if (!obj || !objectRef.namespace) return null;
  return <PoliciesAttached clusterId={clusterId} obj={obj} kind={objectRef.kind} />;
}
