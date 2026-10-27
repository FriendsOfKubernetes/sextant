// "Distribution" (section "k3s / RKE2", #270): what the nodes tell of k3s or RKE2 (the distribution, the versions,
// servers and agents, embedded etcd), each node's role and version, the bundled components with a readable state
// (their Addon or HelmChart, the HelmChart's install Job, their workloads in kube-system), and the Services ServiceLB
// serves with their DaemonSets and load-balancer addresses. Lists of the nodes (≤ `MAX_NODES`), kube-system's
// Deployments, DaemonSets and Addons, the HelmCharts and their Jobs; the Services ServiceLB names are read by name
// (≤ `MAX_LISTED`). Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { LoadingIndicator } from "../../components";
import type { PageProps } from "../../layout/pages";
import { StatusText } from "../../resources";
import { useRefObjects } from "../cluster-api/hooks";
import { chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { Muted } from "./details";
import { MAX_NODES, useAddons, useChartJobs, useHelmCharts, useKubeSystemDaemonSets, useKubeSystemDeployments, useNodes } from "./hooks";
import {
  clusterDistributionOf,
  COMPONENT_TONE,
  componentsOf,
  loadBalancerAddresses,
  nodeDistributionOf,
  serviceLbOf,
  shownComponent,
  type ComponentRow,
  type Distribution,
  type ServiceLb,
  type WorkloadState,
} from "./model";

/** ServiceLB rows listed (and Services read). */
export const MAX_LISTED = 50;

const NODE_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", undefined];
const COMPONENT_WRAP: ColumnWrap[] = ["nowrap", "nowrap", undefined, undefined];
const LB_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined];
const LABELS = "k3s:fields";
const NODES_TABLE = "k3sNodes";
const COMPONENTS_TABLE = "k3sComponents";
const LB_TABLE = "k3sServiceLb";
const ADDON_TYPE = { apiVersion: "k3s.cattle.io/v1", kind: "Addon" };
const CHART_TYPE = { apiVersion: "helm.cattle.io/v1", kind: "HelmChart" };
const DEPLOYMENT_TYPE = { apiVersion: "apps/v1", kind: "Deployment" };
const DAEMONSET_TYPE = { apiVersion: "apps/v1", kind: "DaemonSet" };

function Workloads({ workloads }: { workloads: WorkloadState[] }) {
  const { t } = useTranslation();
  if (workloads.length === 0) return null;
  return (
    <span className="k3s-workloads">
      {workloads.map((w) => (
        <span key={`${w.kind}/${w.name}`} className="k3s-workload">
          {link(w.kind === "DaemonSet" ? DAEMONSET_TYPE : DEPLOYMENT_TYPE, w.name, w.namespace)}{" "}
          <StatusText value={t("k3s:components.available", { available: w.available, desired: w.desired })} tone={w.ready ? "success" : "warning"} />
        </span>
      ))}
    </span>
  );
}

function stateText(row: ComponentRow, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (row.state === "notFound" && row.def.serviceLb) return t("k3s:components.state.notFoundServiceLb", { flag: row.def.disable ?? "" });
  if (row.state === "notFound" && row.def.disable) return t("k3s:components.state.notFoundDisabled", { flag: row.def.disable });
  return t(`k3s:components.state.${row.state}`);
}

function ComponentsTable({ rows }: { rows: ComponentRow[] }) {
  const { t } = useTranslation();
  const body: ReactNode[][] = rows.map((row) => [
    t(`k3s:component.${row.def.id}`),
    <StatusText key="s" value={stateText(row, t)} tone={COMPONENT_TONE[row.state]} />,
    <span key="from" className="k3s-workloads">
      {row.addon ? link(ADDON_TYPE, row.addon.metadata?.name, row.addon.metadata?.namespace ?? null) : null}
      {row.chart ? link(CHART_TYPE, row.chart.metadata?.name, row.chart.metadata?.namespace ?? null) : null}
    </span>,
    <Workloads key="w" workloads={row.workloads} />,
  ]);
  const view = table(
    COMPONENTS_TABLE,
    [t("k3s:components.component"), t("k3s:components.status"), t("k3s:components.from"), t("k3s:components.workloads")],
    body,
    COMPONENT_WRAP,
  );
  return <>{view}</>;
}

function ServiceLbTable({ clusterId, rows }: { clusterId: PageProps["clusterId"]; rows: ServiceLb[] }) {
  const { t } = useTranslation();
  const listed = rows.slice(0, MAX_LISTED);
  const refs = listed.map((r) => ({ group: "", version: "v1", kind: "Service", name: r.service, namespace: r.serviceNamespace }));
  const stamp = listed.map((r) => `${r.name}:${r.ready}/${r.desired}`).join(",");
  const services = useRefObjects(clusterId, refs, stamp);
  const body: ReactNode[][] = listed.map((r) => {
    const fetched = services.byKey.get(`/Service/${r.serviceNamespace}/${r.service}`);
    const svc: KubeObject | undefined = fetched && "obj" in fetched ? fetched.obj : undefined;
    const addresses = svc ? loadBalancerAddresses(svc) : [];
    return [
      link(KINDS.service, r.service, r.serviceNamespace, `${r.serviceNamespace}/${r.service}`),
      link(DAEMONSET_TYPE, r.name, r.namespace),
      <StatusText key="r" value={t("k3s:serviceLb.ready", { ready: r.ready, desired: r.desired })} tone={r.ready >= r.desired ? "success" : "warning"} />,
      addresses.length > 0 ? chips(addresses) : svc ? t("k3s:serviceLb.noAddress") : services.loading ? t("k3s:loading") : t("k3s:serviceLb.serviceUnreadable"),
    ];
  });
  const view = table(LB_TABLE, [t("k3s:serviceLb.service"), t("k3s:serviceLb.daemonSet"), t("k3s:serviceLb.pods"), t("k3s:serviceLb.addresses")], body, LB_WRAP);
  return (
    <>
      {view}
      {rows.length > MAX_LISTED && <Muted text={t("k3s:serviceLb.truncated", { limit: MAX_LISTED })} />}
    </>
  );
}

export function DistributionPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const nodes = useNodes(clusterId);
  const addons = useAddons(clusterId);
  const charts = useHelmCharts(clusterId);
  const jobs = useChartJobs(clusterId);
  const deployments = useKubeSystemDeployments(clusterId);
  const daemonSets = useKubeSystemDaemonSets(clusterId);
  const cluster = clusterDistributionOf(nodes.items);
  const inferred: Distribution =
    cluster.distribution === "k3s" || cluster.distribution === "rke2"
      ? cluster.distribution
      : charts.items.some((c) => (c.metadata?.name ?? "").startsWith("rke2-"))
        ? "rke2"
        : "k3s";
  const summary: FieldRow[] = [
    ["distribution", cluster.distribution ? t(`k3s:distribution.${cluster.distribution}`) : t("k3s:page.notRecognised")],
    ["versions", chips(cluster.versions)],
    ["recognised", t("k3s:page.recognised", { recognised: cluster.recognised, total: cluster.total })],
    ["servers", cluster.recognised > 0 ? t("k3s:page.serversAgents", { servers: cluster.servers, agents: cluster.agents }) : null],
    ["datastore", cluster.recognised > 0 ? t(cluster.embeddedEtcd ? "k3s:page.embeddedEtcd" : "k3s:page.otherDatastore") : null],
  ];
  const nodeRows: ReactNode[][] = nodes.items
    .map(nodeDistributionOf)
    .filter((d) => d.distribution)
    .sort((a, b) => Number(b.server) - Number(a.server) || a.name.localeCompare(b.name))
    .map((d) => [
      link(KINDS.node, d.name),
      t(`k3s:distribution.${d.distribution!}`),
      d.version ?? "",
      t(d.server ? "k3s:node.server" : "k3s:node.agent"),
      chips(d.roles.map((r) => t(`k3s:role.${r}`))) ?? "",
    ]);
  const components = componentsOf(inferred, {
    addons: addons.items,
    charts: charts.items,
    jobs: jobs.items,
    deployments: deployments.items,
    daemonSets: daemonSets.items,
  }).filter(shownComponent);
  const lbRows = daemonSets.items
    .map(serviceLbOf)
    .filter((r): r is ServiceLb => r !== undefined)
    .sort((a, b) => a.serviceNamespace.localeCompare(b.serviceNamespace) || a.service.localeCompare(b.service));
  const nodeTable = table(
    NODES_TABLE,
    [t("k3s:page.columns.node"), t("k3s:page.columns.distribution"), t("k3s:page.columns.version"), t("k3s:page.columns.role"), t("k3s:page.columns.roles")],
    nodeRows,
    NODE_WRAP,
  );
  const loading = nodes.loading || deployments.loading || daemonSets.loading || charts.loading || addons.loading;
  return (
    <div className="k3s-page">
      <h2 className="k3s-page__title">{t("k3s:page.title")}</h2>
      <p className="k3s-muted">{t("k3s:page.hint")}</p>
      {loading && <LoadingIndicator text={t("k3s:loading")} />}
      <section className="k3s-page__part" aria-labelledby="k3s-summary">
        <h3 id="k3s-summary" className="k3s-page__heading">
          {t("k3s:page.summary")}
        </h3>
        <Fields rows={summary} labelPrefix={LABELS} />
        {nodes.truncated && <Muted text={t("k3s:page.nodesTruncated", { limit: MAX_NODES })} />}
        {nodes.unavailable && !nodes.loading && <Muted text={t("k3s:page.nodesUnavailable")} />}
        {nodeTable}
      </section>
      <section className="k3s-page__part" aria-labelledby="k3s-components">
        <h3 id="k3s-components" className="k3s-page__heading">
          {t("k3s:components.title")}
        </h3>
        <Muted text={t(`k3s:components.hint.${inferred}`)} />
        {(deployments.unavailable || daemonSets.unavailable) && !loading && <Muted text={t("k3s:components.unavailable")} />}
        {(deployments.truncated || daemonSets.truncated || charts.truncated || jobs.truncated) && <Muted text={t("k3s:components.truncated")} />}
        <ComponentsTable rows={components} />
      </section>
      <section className="k3s-page__part" aria-labelledby="k3s-servicelb">
        <h3 id="k3s-servicelb" className="k3s-page__heading">
          {t("k3s:serviceLb.title")}
        </h3>
        <Muted text={t("k3s:serviceLb.hint")} />
        {lbRows.length === 0 && !daemonSets.loading && <Muted text={t("k3s:serviceLb.none")} />}
        {lbRows.length > 0 && <ServiceLbTable clusterId={clusterId} rows={lbRows} />}
      </section>
    </div>
  );
}
