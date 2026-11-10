// "Distribution" (the manifest's page `distribution` in the section `k3s`), as the built-in page drew it: what the
// nodes tell of k3s or RKE2 (the distribution, the versions, servers and agents, embedded etcd), each node's role and
// version, the bundled components with a readable state (their Addon or HelmChart, the HelmChart's install Job, their
// workloads in kube-system), and the Services ServiceLB serves with their DaemonSets and load-balancer addresses.
// Watched while the page shows, each list capped by the core as the built-in page's: the nodes (≤ `MAX_NODES`),
// kube-system's Deployments and DaemonSets (≤ `MAX_KUBE_SYSTEM`) and Addons (≤ `MAX_ADDONS`), every HelmChart
// (≤ `MAX_CHARTS`) and the Jobs labelled `helmcharts.helm.cattle.io/chart` (selected on the API server, ≤ `MAX_JOBS`);
// the Services ServiceLB names are read by name (≤ `MAX_LISTED`, `resources.getMany`), again when a DaemonSet's
// counts move. A kind the cluster does not serve gives an empty list. Read-only.
import { trackObjects, ui, type KubeObject, type Sextant, type UiContent, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { element, link, remark } from "./dom";
import { t } from "./i18n";
import {
  ADDON,
  clusterDistributionOf,
  COMPONENT_TONE,
  componentsOf,
  CHART_LABEL,
  DAEMONSET,
  DEPLOYMENT,
  HELM_CHART,
  JOB,
  KUBE_SYSTEM,
  loadBalancerAddresses,
  MAX_CHARTS,
  MAX_JOBS,
  NODE,
  nodeDistributionOf,
  SERVICE,
  serviceLbOf,
  shownComponent,
  type ComponentRow,
  type Distribution,
  type ServiceLb,
  type WorkloadState,
} from "./model";

export const MAX_NODES = 1000;
export const MAX_KUBE_SYSTEM = 1000;
export const MAX_ADDONS = 500;
/** ServiceLB rows listed (and Services read). */
export const MAX_LISTED = 50;

/** A list as the page reads it (the built-in `Listed`). */
export interface Listed {
  items: KubeObject[];
  loading: boolean;
  unavailable: boolean;
  truncated: boolean;
}

const LOADING: Listed = { items: [], loading: true, unavailable: false, truncated: false };

/** What the page shows. */
export interface PageInputs {
  nodes: Listed;
  addons: Listed;
  charts: Listed;
  jobs: Listed;
  deployments: Listed;
  daemonSets: Listed;
  /** The Services ServiceLB names, read by name: each `{obj}` or `{error}`; `loading` while a reading is under way. */
  services: { byKey: Map<string, { obj: KubeObject } | { error: string }>; loading: boolean };
}

const fieldsOf = (rows: readonly (readonly [string, UiContent])[]): HTMLElement => ui.fields(rows.map(([key, value]) => [t(`fields.${key}`), value] as const));
const tableOf = (headers: string[], rows: UiContent[][], label: string): HTMLElement | null => (rows.length > 0 ? ui.table(headers, rows, { label }) : null);

function workloads(sextant: Sextant, list: WorkloadState[]): HTMLElement | null {
  if (list.length === 0) return null;
  return element(
    "span",
    { className: "k3s-workloads" },
    ...list.map((w) =>
      element(
        "span",
        { className: "k3s-workload" },
        link(sextant, w.kind === "DaemonSet" ? DAEMONSET : DEPLOYMENT, w.name, w.namespace),
        " ",
        ui.status(t("components.available", { available: w.available, desired: w.desired }), w.ready ? "success" : "warning"),
      ),
    ),
  );
}

function stateText(row: ComponentRow): string {
  if (row.state === "notFound" && row.def.serviceLb) return t("components.state.notFoundServiceLb", { flag: row.def.disable ?? "" });
  if (row.state === "notFound" && row.def.disable) return t("components.state.notFoundDisabled", { flag: row.def.disable });
  return t(`components.state.${row.state}`);
}

function componentsTable(sextant: Sextant, rows: ComponentRow[]): HTMLElement | null {
  const body: UiContent[][] = rows.map((row) => [
    t(`component.${row.def.id}`),
    ui.status(stateText(row), COMPONENT_TONE[row.state]),
    element(
      "span",
      { className: "k3s-workloads" },
      row.addon ? link(sextant, ADDON, row.addon.metadata.name, row.addon.metadata.namespace ?? null) : null,
      row.chart ? link(sextant, HELM_CHART, row.chart.metadata.name, row.chart.metadata.namespace ?? null) : null,
    ),
    workloads(sextant, row.workloads),
  ]);
  return tableOf(["component", "status", "from", "workloads"].map((h) => t(`components.${h}`)), body, t("components.title"));
}

/** The key a Service read by name is kept under. */
export const serviceKey = (namespace: string, name: string): string => `${namespace}/${name}`;

/** The ServiceLB rows the page lists, in the built-in order. */
export function serviceLbRows(daemonSets: readonly KubeObject[]): ServiceLb[] {
  return daemonSets
    .map(serviceLbOf)
    .filter((r): r is ServiceLb => r !== undefined)
    .sort((a, b) => a.serviceNamespace.localeCompare(b.serviceNamespace) || a.service.localeCompare(b.service));
}

/** What changes of the listed rows make the page read their Services again (the built-in `stamp`). */
export const serviceStamp = (rows: readonly ServiceLb[]): string =>
  rows
    .slice(0, MAX_LISTED)
    .map((r) => `${r.serviceNamespace}/${r.service}|${r.name}:${r.ready}/${r.desired}`)
    .join(",");

function serviceLbTable(sextant: Sextant, rows: ServiceLb[], services: PageInputs["services"]): Node[] {
  const listed = rows.slice(0, MAX_LISTED);
  const body: UiContent[][] = listed.map((r) => {
    const fetched = services.byKey.get(serviceKey(r.serviceNamespace, r.service));
    const svc = fetched && "obj" in fetched ? fetched.obj : undefined;
    const addresses = svc ? loadBalancerAddresses(svc) : [];
    return [
      link(sextant, SERVICE, r.service, r.serviceNamespace, `${r.serviceNamespace}/${r.service}`),
      link(sextant, DAEMONSET, r.name, r.namespace),
      ui.status(t("serviceLb.ready", { ready: r.ready, desired: r.desired }), r.ready >= r.desired ? "success" : "warning"),
      addresses.length > 0 ? ui.chips(addresses) : svc ? t("serviceLb.noAddress") : services.loading ? t("loading") : t("serviceLb.serviceUnreadable"),
    ];
  });
  const table = tableOf(["service", "daemonSet", "pods", "addresses"].map((h) => t(`serviceLb.${h}`)), body, t("serviceLb.title"));
  return [table, rows.length > MAX_LISTED && remark(t("serviceLb.truncated", { limit: String(MAX_LISTED) }))].filter((n): n is HTMLElement => Boolean(n));
}

function part(id: string, title: string, ...children: (Node | null | false | undefined)[]): HTMLElement {
  const heading = element("h3", { id, className: "k3s-page__heading", textContent: title });
  const section = element("section", { className: "k3s-page__part" }, heading, ...children.flat());
  section.setAttribute("aria-labelledby", id);
  return section;
}

export function pageView(sextant: Sextant, input: PageInputs): HTMLElement {
  const { nodes, addons, charts, jobs, deployments, daemonSets } = input;
  const cluster = clusterDistributionOf(nodes.items);
  const inferred: Distribution =
    cluster.distribution === "k3s" || cluster.distribution === "rke2"
      ? cluster.distribution
      : charts.items.some((c) => (c.metadata.name ?? "").startsWith("rke2-"))
        ? "rke2"
        : "k3s";
  const summary = fieldsOf([
    ["distribution", cluster.distribution ? t(`distribution.${cluster.distribution}`) : t("page.notRecognised")],
    ["versions", ui.chips(cluster.versions)],
    ["recognised", t("page.recognised", { recognised: cluster.recognised, total: cluster.total })],
    ["servers", cluster.recognised > 0 ? t("page.serversAgents", { servers: cluster.servers, agents: cluster.agents }) : null],
    ["datastore", cluster.recognised > 0 ? t(cluster.embeddedEtcd ? "page.embeddedEtcd" : "page.otherDatastore") : null],
  ]);
  const nodeRows: UiContent[][] = nodes.items
    .map(nodeDistributionOf)
    .filter((d) => d.distribution)
    .sort((a, b) => Number(b.server) - Number(a.server) || a.name.localeCompare(b.name))
    .map((d) => [
      link(sextant, NODE, d.name, null),
      t(`distribution.${d.distribution!}`),
      d.version ?? "",
      t(d.server ? "node.server" : "node.agent"),
      ui.chips(d.roles.map((r) => t(`role.${r}`))) ?? "",
    ]);
  const components = componentsOf(inferred, {
    addons: addons.items,
    charts: charts.items,
    jobs: jobs.items,
    deployments: deployments.items,
    daemonSets: daemonSets.items,
  }).filter(shownComponent);
  const lbRows = serviceLbRows(daemonSets.items);
  const loading = nodes.loading || deployments.loading || daemonSets.loading || charts.loading || addons.loading;
  return element(
    "div",
    { className: "k3s-page" },
    element("h2", { className: "k3s-page__title", textContent: t("page.title") }),
    remark(t("page.hint")),
    loading && ui.loading(t("loading")),
    part(
      "k3s-summary",
      t("page.summary"),
      summary,
      nodes.truncated && remark(t("page.nodesTruncated", { limit: String(MAX_NODES) })),
      nodes.unavailable && !nodes.loading && remark(t("page.nodesUnavailable")),
      tableOf(["node", "distribution", "version", "role", "roles"].map((h) => t(`page.columns.${h}`)), nodeRows, t("page.summary")),
    ),
    part(
      "k3s-components",
      t("components.title"),
      remark(t(`components.hint.${inferred}`)),
      (deployments.unavailable || daemonSets.unavailable) && !loading && remark(t("components.unavailable")),
      (deployments.truncated || daemonSets.truncated || charts.truncated || jobs.truncated) && remark(t("components.truncated")),
      componentsTable(sextant, components),
    ),
    part(
      "k3s-servicelb",
      t("serviceLb.title"),
      remark(t("serviceLb.hint")),
      lbRows.length === 0 && !daemonSets.loading && remark(t("serviceLb.none")),
      ...(lbRows.length > 0 ? serviceLbTable(sextant, lbRows, input.services) : []),
    ),
  );
}

/** The lists the page watches, by name. */
export const PAGE_WATCHES: Record<Exclude<keyof PageInputs, "services">, Omit<WatchParams, "clusterId">> = {
  nodes: { kind: NODE, maxObjects: MAX_NODES },
  addons: { kind: ADDON, namespaces: [KUBE_SYSTEM], maxObjects: MAX_ADDONS },
  charts: { kind: HELM_CHART, maxObjects: MAX_CHARTS },
  jobs: { kind: JOB, labelSelector: CHART_LABEL, maxObjects: MAX_JOBS },
  deployments: { kind: DEPLOYMENT, namespaces: [KUBE_SYSTEM], maxObjects: MAX_KUBE_SYSTEM },
  daemonSets: { kind: DAEMONSET, namespaces: [KUBE_SYSTEM], maxObjects: MAX_KUBE_SYSTEM },
};

/** Starts the page: the lists of the context's cluster, watched while it shows, and the ServiceLB Services read. */
export function startPage(sextant: Sextant, root: HTMLElement): () => void {
  const input: PageInputs = {
    nodes: LOADING,
    addons: LOADING,
    charts: LOADING,
    jobs: LOADING,
    deployments: LOADING,
    daemonSets: LOADING,
    services: { byKey: new Map(), loading: false },
  };
  let stopped = false;
  let scheduled = false;
  let stamp = "";
  let reading = 0;

  const readServices = (rows: ServiceLb[]) => {
    const listed = rows.slice(0, MAX_LISTED);
    const attempt = ++reading;
    if (listed.length === 0) {
      input.services = { byKey: new Map(), loading: false };
      return;
    }
    // Until the new reading lands, the previous one stays (no flicker when a DaemonSet changes).
    input.services = { ...input.services, loading: true };
    const refs = listed.map((r) => ({ kind: SERVICE, namespace: r.serviceNamespace, name: r.service }));
    sextant.resources
      .getMany({ refs })
      .then(
        (result) => {
          const byKey = new Map<string, { obj: KubeObject } | { error: string }>();
          result.items.forEach((item, i) => {
            const r = listed[i]!;
            byKey.set(serviceKey(r.serviceNamespace, r.service), "object" in item ? { obj: item.object } : { error: item.error.code });
          });
          return byKey;
        },
        (err: unknown) => new Map(listed.map((r) => [serviceKey(r.serviceNamespace, r.service), { error: err instanceof Error ? err.message : String(err) }] as const)),
      )
      .then((byKey) => {
        if (attempt !== reading || stopped) return;
        input.services = { byKey, loading: false };
        schedule();
      });
  };

  const render = () => {
    if (stopped) return;
    const rows = serviceLbRows(input.daemonSets.items);
    const next = serviceStamp(rows);
    if (next !== stamp && !input.daemonSets.loading) {
      stamp = next;
      readServices(rows);
    }
    root.replaceChildren(pageView(sextant, input));
  };
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };

  const watches: Watch[] = Object.entries(PAGE_WATCHES).map(([name, spec]) => {
    const key = name as keyof typeof PAGE_WATCHES;
    const set = (change: Partial<Listed>) => {
      input[key] = { ...input[key], ...change };
      schedule();
    };
    const watch = sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => set({ items, loading: false, unavailable: false }),
        (other) => {
          if (other.type === "error" || other.type === "forbidden") set({ loading: false, unavailable: true });
        },
      ),
      onError: () => set({ loading: false, unavailable: true }),
      onCapped: (total) => set({ truncated: total > (spec.maxObjects ?? Infinity) }),
    });
    watch.started.catch(() => undefined);
    return watch;
  });
  render();
  return () => {
    stopped = true;
    for (const watch of watches) void watch.unwatch().catch(() => undefined);
  };
}
