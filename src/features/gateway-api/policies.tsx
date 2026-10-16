// The "Policies" page of the Gateway API section: policies attached to Gateway API objects (or Services) through
// `spec.targetRefs` (policy attachment, GEP-713) — BackendTLSPolicy and the implementations' own (Envoy Gateway's
// BackendTrafficPolicy, SecurityPolicy, …; Kuadrant's AuthPolicy, RateLimitPolicy, …).
//
// Which kinds: every kind discovery serves outside Kubernetes' own API groups whose name ends in "Policy" (the
// naming GEP-713 asks of policy kinds), and of their objects only those that have `spec.targetRefs` (or the older
// single `spec.targetRef`). The name narrows what is watched without downloading CRD schemas; the field keeps out
// unrelated *Policy kinds (Kyverno's, Calico's, …). The sidebar shows the page only while the section has served
// kinds; the page checks for the Gateway API itself too.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KubeObject, type ResourceKind, type WatchSpec } from "../../api";
import { EmptyState, ErrorState, LoadingIndicator } from "../../components";
import { registerPage, type PageProps } from "../../layout/pages";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { customResourceKinds, kindKey, ObjectLink, StatusText, useClusterKinds } from "../../resources";
import { HEALTH_TONE, policyStatusText } from "./columns";
import { apiVersionFor, GATEWAY_GROUP, policyHealth, policyTargets } from "./model";

export const POLICIES_PAGE = "gatewayApiPolicies";

/** Kinds that may hold attached policies: served custom kinds named *Policy that can be listed and watched. */
export function policyKinds(kinds: ResourceKind[] | null): ResourceKind[] {
  return customResourceKinds(kinds)
    .filter((k) => k.kindRef.kind.endsWith("Policy"))
    .sort((a, b) => a.kindRef.kind.localeCompare(b.kindRef.kind) || a.kindRef.group.localeCompare(b.kindRef.group));
}

/** An object of such a kind is an attached policy when it names its targets. */
export function isAttachedPolicy(obj: KubeObject): boolean {
  return policyTargets(obj).some((t) => t.kind && t.name);
}

interface Loaded {
  done: boolean;
  rows: number;
}

function PolicyRows({
  clusterId,
  kind,
  namespaces,
  onLoaded,
}: {
  clusterId: ClusterId;
  kind: ResourceKind;
  namespaces: string[] | null;
  onLoaded: (key: string, loaded: Loaded) => void;
}) {
  const spec: WatchSpec = {
    kind: kind.kindRef,
    namespaces: kind.namespaced && namespaces && namespaces.length > 0 ? namespaces : null,
    labelSelector: null,
    fieldSelector: null,
  };
  const watch = useWatch(clusterId, spec);
  const policies = [...watch.items.values()]
    .filter(isAttachedPolicy)
    .sort((a, b) =>
      `${a.metadata?.namespace ?? ""}/${a.metadata?.name ?? ""}`.localeCompare(
        `${b.metadata?.namespace ?? ""}/${b.metadata?.name ?? ""}`,
      ),
    );
  const key = kindKey(kind.kindRef);
  // A kind the user may not list, or that fails, just has no rows.
  const done = watch.status !== "loading";
  useEffect(() => onLoaded(key, { done, rows: policies.length }), [key, done, policies.length, onLoaded]);
  const apiVersion = kind.kindRef.group ? `${kind.kindRef.group}/${kind.kindRef.version}` : kind.kindRef.version;
  return (
    <>
      {policies.map((policy) => {
        const ns = policy.metadata?.namespace ?? null;
        const name = policy.metadata?.name ?? "";
        const health = policyHealth(policy).health;
        return (
          <tr key={`${ns ?? ""}/${name}`}>
            <td>{kind.kindRef.kind}</td>
            <td>
              <ObjectLink target={{ apiVersion, kind: kind.kindRef.kind, name }} namespace={ns}>
                {name}
              </ObjectLink>
            </td>
            <td>{ns}</td>
            <td>
              <span className="dt-links">
                {policyTargets(policy).map((t) => (
                  <ObjectLink
                    key={`${t.group}/${t.kind}/${t.name}/${t.sectionName ?? ""}`}
                    target={{ apiVersion: apiVersionFor(t), kind: t.kind, name: t.name }}
                    namespace={t.namespace}
                  >
                    {targetText(t)}
                  </ObjectLink>
                ))}
              </span>
            </td>
            <td>
              <StatusText value={policyStatusText(policy)} tone={HEALTH_TONE[health]} />
            </td>
          </tr>
        );
      })}
    </>
  );
}

const targetText = (t: { kind: string; name: string; sectionName?: string }) =>
  `${t.kind} ${t.name}${t.sectionName ? ` (${t.sectionName})` : ""}`;

export function PoliciesPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const { kinds, error } = useClusterKinds(clusterId);
  const namespaces = useSelectedNamespaces(clusterId);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Loaded>>(() => new Map());
  const onLoaded = useCallback(
    (key: string, value: Loaded) =>
      setLoaded((prev) => {
        const old = prev.get(key);
        return old && old.done === value.done && old.rows === value.rows ? prev : new Map(prev).set(key, value);
      }),
    [],
  );
  const title = t("gateway:sidebar.policies");

  let body;
  if (!kinds) {
    body = error ? <ErrorState error={error} /> : <LoadingIndicator text={t("gateway:policies.loading")} />;
  } else if (!kinds.some((k) => k.kindRef.group === GATEWAY_GROUP)) {
    body = <EmptyState title={t("gateway:policies.notServed")} />;
  } else if (namespaces !== undefined) {
    const candidates = policyKinds(kinds);
    const states = candidates.map((k) => loaded.get(kindKey(k.kindRef)));
    const loading = states.some((s) => !s?.done);
    const rows = states.reduce((sum, s) => sum + (s?.rows ?? 0), 0);
    body = (
      <>
        <table className="dt-table gw-policies" aria-label={title}>
          <thead>
            <tr>
              <th>{t("gateway:policies.kind")}</th>
              <th>{t("gateway:policies.name")}</th>
              <th>{t("gateway:policies.namespace")}</th>
              <th>{t("gateway:policies.targets")}</th>
              <th>{t("gateway:policies.status")}</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((k) => (
              <PolicyRows
                key={kindKey(k.kindRef)}
                clusterId={clusterId}
                kind={k}
                namespaces={namespaces}
                onLoaded={onLoaded}
              />
            ))}
          </tbody>
        </table>
        {loading ? (
          <LoadingIndicator text={t("gateway:policies.loading")} />
        ) : (
          rows === 0 && <p className="dt-muted">{t("gateway:policies.none")}</p>
        )}
      </>
    );
  }

  return (
    <div className="gw-page">
      <header className="gw-page__header">
        <h2 className="gw-page__title">{title}</h2>
        <NamespaceFilter clusterId={clusterId} />
      </header>
      <div className="gw-page__body">{body}</div>
    </div>
  );
}

registerPage({
  id: POLICIES_PAGE,
  section: "gatewayApi",
  order: 60,
  labelKey: "gateway:sidebar.policies",
  icon: "gatewayPolicies",
  Component: PoliciesPage,
});
