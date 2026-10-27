// "Virtual clusters" (Cluster section, #269): the vcluster instances of the namespaces in the filter (or of every
// namespace), found by the API server's own selector `app=vcluster` on StatefulSets and Deployments — each with its
// state (paused, scaled down, ready replicas), its control-plane pods, whether its Service `<name>` and its
// kubeconfig Secret `vc-<name>` exist (metadata only), and "Connect" (a click, a confirmation; ADR-0122).
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { LoadingIndicator } from "../../components";
import { formatList } from "../../i18n";
import type { PageProps } from "../../layout/pages";
import { StatusText } from "../../resources";
import { link, table, type ColumnWrap } from "../details";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { ConnectControls } from "./connect";
import { MAX_INSTANCES, MAX_NAMESPACES, useAround, useInstances, type Around, type Listed } from "./hooks";
import { hasNamed, namespacesOf, podsOf, podSummary, secretName, STATE_TONE, stateOf, type Instance } from "./model";

export const VCLUSTER_PAGE_ID = "virtualClusters";

const PAGE_TABLE = "vclusterPage";
const WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", "nowrap", undefined, "nowrap", "nowrap", undefined];

/** Whether an object of the instance's namespace is known to exist (`undefined`: cannot be told). */
export function presence(list: Listed, instance: Instance, name: string, watched: readonly string[]): boolean | undefined {
  if (!watched.includes(instance.namespace) || list.loading || list.unavailable) return undefined;
  if (hasNamed(list.items, instance.namespace, name)) return true;
  return list.truncated ? undefined : false;
}

export function Presence({ value }: { value: boolean | undefined }) {
  const { t } = useTranslation();
  if (value === undefined) return <span className="vc-muted">{t("vcluster:presence.unknown")}</span>;
  return value ? (
    <StatusText value={t("vcluster:presence.found")} tone="success" />
  ) : (
    <StatusText value={t("vcluster:presence.missing")} tone="warning" />
  );
}

export function PodsCell({ instance, around }: { instance: Instance; around: Around }) {
  const { t } = useTranslation();
  if (around.pods.loading) return <span className="vc-muted">{t("vcluster:loading")}</span>;
  if (around.pods.unavailable) return <span className="vc-muted">{t("vcluster:presence.unknown")}</span>;
  const summary = podSummary(podsOf(instance, around.pods.items));
  const phases = Object.entries(summary.phases).map(([phase, count]) => t("vcluster:pods.phase", { phase, number: count }));
  return (
    <span>
      {t("vcluster:pods.ready", { ready: summary.ready, total: summary.total })}
      {phases.length > 0 && <span className="vc-muted"> {formatList(phases)}</span>}
    </span>
  );
}

export function StateCell({ instance }: { instance: Instance }) {
  const { t } = useTranslation();
  const state = stateOf(instance);
  return (
    <StatusText
      value={t(`vcluster:state.${state}`, { ready: instance.readyReplicas, replicas: instance.replicas })}
      tone={STATE_TONE[state]}
    />
  );
}

function InstancesTable({ clusterId, instances }: { clusterId: ClusterId; instances: Instance[] }) {
  const { t } = useTranslation();
  const around = useAround(clusterId, instances);
  const watched = namespacesOf(instances, MAX_NAMESPACES);
  const rows: ReactNode[][] = instances.map((i) => [
    link({ apiVersion: "apps/v1", kind: i.kind }, i.workloadName, i.namespace, i.name),
    i.namespace,
    i.kind,
    i.version ?? "",
    <StateCell key="s" instance={i} />,
    <PodsCell key="p" instance={i} around={around} />,
    <Presence key="svc" value={presence(around.services, i, i.name, watched)} />,
    <Presence key="sec" value={presence(around.secrets, i, secretName(i.name), watched)} />,
    <ConnectControls key="c" clusterId={clusterId} namespace={i.namespace} name={i.name} />,
  ]);
  return (
    <>
      {namespacesOf(instances, Infinity).length > MAX_NAMESPACES && (
        <p className="vc-muted">{t("vcluster:page.namespacesCapped", { max: MAX_NAMESPACES })}</p>
      )}
      {table(
        PAGE_TABLE,
        [
          t("vcluster:columns.name"),
          t("vcluster:columns.namespace"),
          t("vcluster:columns.kind"),
          t("vcluster:columns.version"),
          t("vcluster:columns.state"),
          t("vcluster:columns.pods"),
          t("vcluster:columns.service"),
          t("vcluster:columns.secret"),
          t("vcluster:columns.connection"),
        ],
        rows,
        WRAP,
      )}
    </>
  );
}

export function VclusterPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const selected = useSelectedNamespaces(clusterId);
  // While the filter is restored nothing is watched; "All namespaces" watches cluster-wide by the label selector.
  const found = useInstances(clusterId, selected === undefined ? undefined : selected && selected.length > 0 ? selected : null);
  return (
    <div className="vc-page">
      <h2 className="vc-page__title">{t("vcluster:page.title")}</h2>
      <p className="vc-muted">{t("vcluster:page.hint")}</p>
      <div className="vc-toolbar">
        <NamespaceFilter clusterId={clusterId} />
      </div>
      {found.loading && <LoadingIndicator text={t("vcluster:loading")} />}
      {!found.loading && (
        <p className="vc-muted" role="status">
          {t("vcluster:page.total", { count: found.instances.length })}
        </p>
      )}
      {found.truncated && <p className="vc-muted">{t("vcluster:page.truncated", { max: MAX_INSTANCES })}</p>}
      {found.unavailable && <p className="vc-muted">{t("vcluster:page.unavailable")}</p>}
      {found.instances.length > 0 && <InstancesTable clusterId={clusterId} instances={found.instances} />}
      <p className="vc-muted">{t("vcluster:page.lifetime")}</p>
    </div>
  );
}
