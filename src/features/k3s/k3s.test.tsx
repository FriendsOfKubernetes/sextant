import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { getPage } from "../../layout/pages";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { categoryOf, detect, OPT_IN_CATEGORIES, PROBLEM_CATEGORIES } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { judgedByRules, sourcesFor } from "../problems/sources";
import { resetSharedWatches } from "../resource-map/watches";
import fixtures from "./fixtures/objects.json";
import "./index";
import { HIDDEN, maskedSet, maskedValuesContent, nodeArgs, secretFlag } from "./mask";
import {
  ADDON,
  addonOwnerOf,
  chartInfoOf,
  chartStateOf,
  clusterDistributionOf,
  componentOfDeployment,
  componentsOf,
  ETCD_SNAPSHOT,
  HELM_CHART,
  HELM_CHART_CONFIG,
  jobOfChart,
  loadBalancerAddresses,
  nodeDistributionOf,
  serviceLbOf,
  shownComponent,
  snapshotOf,
  snapshotStateOf,
} from "./model";
import { FAILED_FOR_MS, JOBS_SELECTOR, RETRY_GRACE_MS, toProblems, UNAVAILABLE_GRACE_MS, type Seen } from "./provider";
import { DISTRIBUTION_PAGE_ID } from "./register";

const f = fixtures as unknown as Record<string, KubeObject>;
const jobs = () => [f.jobTraefik!, f.jobFailed!, f.jobRetrying!];
const node = (over: { version?: string; providerID?: string; labels?: Record<string, string>; annotations?: Record<string, string> }): KubeObject => ({
  apiVersion: "v1",
  kind: "Node",
  metadata: { name: "n", labels: over.labels ?? {}, annotations: over.annotations ?? {} },
  spec: over.providerID ? { providerID: over.providerID } : {},
  status: { nodeInfo: { kubeletVersion: over.version ?? "v1.33.4" } },
});
const ann = (obj: KubeObject, key: string): string => (obj.metadata?.annotations as Record<string, string>)[key]!;
const specOf = (obj: KubeObject): Record<string, unknown> => obj.spec as Record<string, unknown>;
const SECRETS = ["plain-old-secret", "abc123", "hunter2", "k3s-pass", "s3cr3t-value", "dbpass", "inline-pass", "repo-pass"];

describe("recognition", () => {
  it.each([
    ["the kubelet's +k3s suffix", node({ version: "v1.31.2+k3s2" }), "k3s", ["kubeletVersion"]],
    ["the kubelet's +rke2r suffix", node({ version: "v1.31.2+rke2r1" }), "rke2", ["kubeletVersion"]],
    ["the k3s.io annotations", node({ annotations: { "k3s.io/hostname": "a" } }), "k3s", ["annotations"]],
    ["the rke2 provider ID", node({ providerID: "rke2://n" }), "rke2", ["providerId"]],
    ["the instance-type label", node({ labels: { "node.kubernetes.io/instance-type": "k3s" } }), "k3s", ["instanceType"]],
    ["the kubelet before annotations of the other", node({ version: "v1.31.2+rke2r1", annotations: { "k3s.io/node-args": "[]" } }), "rke2", ["kubeletVersion"]],
    ["nothing on a kubeadm node", f.nodePlain!, undefined, []],
    ["not a look-alike suffix", node({ version: "v1.31.2+k3sx" }), undefined, []],
  ])("%s", (_, obj, distribution, signals) => {
    const d = nodeDistributionOf(obj);
    expect(d.distribution).toBe(distribution);
    expect(d.signals).toEqual(signals);
  });

  it("reads a node's version, roles, addresses and etcd member", () => {
    expect(nodeDistributionOf(f.nodeK3sServer!)).toMatchObject({
      distribution: "k3s",
      version: "v1.33.4+k3s1",
      signals: ["kubeletVersion", "annotations", "providerId", "instanceType"],
      roles: ["controlPlane", "etcd"],
      server: true,
      hostname: "k3s-server-1",
      internalIp: "10.0.0.11",
      etcdMember: "k3s-server-1-6d1f4a2b",
    });
    expect(nodeDistributionOf(f.nodeK3sAgent!)).toMatchObject({ server: false, roles: [], externalIp: "203.0.113.21" });
    expect(nodeDistributionOf(f.nodeRke2!)).toMatchObject({ distribution: "rke2", roles: ["controlPlane", "etcd", "master"], etcdMember: "rke2-server-1-2c4e6a8b" });
  });

  it("sums up the cluster", () => {
    expect(clusterDistributionOf([f.nodeK3sServer!, f.nodeK3sAgent!, f.nodePlain!])).toEqual({
      distribution: "k3s",
      versions: ["v1.33.4+k3s1"],
      recognised: 2,
      total: 3,
      servers: 1,
      agents: 1,
      embeddedEtcd: true,
    });
    expect(clusterDistributionOf([f.nodeK3sServer!, f.nodeRke2!]).distribution).toBe("mixed");
    expect(clusterDistributionOf([f.nodePlain!]).distribution).toBeUndefined();
  });
});

describe("node arguments", () => {
  it("hides every secret value, k3s's own mask included, and keeps the rest", () => {
    const args = nodeArgs(ann(f.nodeK3sServer!, "k3s.io/node-args"))!;
    expect(args).toEqual([
      { value: "server", hidden: false },
      { flag: "--cluster-init", hidden: false },
      { flag: "--disable", value: "traefik", hidden: false },
      { flag: "--token", hidden: true },
      { flag: "--etcd-s3-secret-key", hidden: true },
      { flag: "--kube-apiserver-arg", hidden: true },
      { flag: "--tls-san", value: "k3s.example.com", hidden: false },
      { flag: "--write-kubeconfig-mode", value: "0644", hidden: false },
    ]);
    const all = JSON.stringify([
      args,
      nodeArgs(ann(f.nodeK3sAgent!, "k3s.io/node-args")),
      nodeArgs(ann(f.nodeRke2!, "rke2.io/node-args")),
    ]);
    for (const secret of SECRETS) expect(all).not.toContain(secret);
    expect(nodeArgs(ann(f.nodeRke2!, "rke2.io/node-args"))).toContainEqual({ flag: "--datastore-endpoint", hidden: true });
    expect(nodeArgs("not json")).toBeNull();
    expect(nodeArgs("[1, 2]")).toBeNull();
    expect(nodeArgs(undefined)).toBeUndefined();
  });

  it.each([
    ["--token", undefined, true],
    ["-t", undefined, true],
    ["--agent-token", undefined, true],
    ["--datastore-endpoint", undefined, true],
    ["--etcd-s3-access-key", undefined, true],
    ["--etcd-s3-session-token", undefined, true],
    ["--vpn-auth", undefined, true],
    ["--kubelet-arg", "max-pods=110", false],
    ["--kube-apiserver-arg", "oidc-client-secret=x", true],
    ["--disable", "traefik", false],
    ["--node-taint", "a=b:NoSchedule", false],
  ])("%s %s → secret %s", (flag, value, secret) => {
    expect(secretFlag(flag, value)).toBe(secret);
  });
});

describe("values", () => {
  it("hides secret-looking keys and cleans addresses; unreadable text is not shown", () => {
    const masked = maskedValuesContent(specOf(f.chartFailed!).valuesContent as string)!;
    expect(masked).toContain("replicaCount: 2");
    expect(masked).toContain(`apiToken: ${HIDDEN}`);
    expect(masked).toContain(`password: ${HIDDEN}`);
    for (const secret of SECRETS) expect(masked).not.toContain(secret);
    expect(maskedValuesContent("a: [unclosed")).toBeUndefined();
    expect(maskedValuesContent("- a\n- b\n")).toBeUndefined();
    expect(maskedValuesContent("  \n")).toBe("");
    expect(maskedSet(specOf(f.chartFailed!).set)).toEqual([`auth.password=${HIDDEN}`, "ingress.enabled=true"]);
  });
});

describe("HelmCharts", () => {
  it("reads what a chart installs and where, with credentials out of the repository address", () => {
    const info = chartInfoOf(f.chartFailed!);
    expect(info).toMatchObject({ chart: "my-app", version: "1.2.3", targetNamespace: "apps", backOffLimit: 5, jobName: "helm-install-my-app", createNamespace: true });
    expect(info.repo).not.toContain("repo-pass");
    expect(info.repo).not.toContain("token");
    expect(chartInfoOf(f.chartTraefik!)).toMatchObject({ targetNamespace: "kube-system", backOffLimit: 1000, failurePolicy: "retry" });
    const deleting = copy(f.chartTraefik!);
    (deleting.metadata as Record<string, unknown>).deletionTimestamp = "2026-10-01T12:00:00Z";
    delete (deleting.status as Record<string, unknown>).jobName;
    expect(chartInfoOf(deleting).jobName).toBe("helm-delete-traefik");
    expect(addonOwnerOf(f.chartTraefik!)).toEqual({ name: "traefik", namespace: "kube-system" });
    expect(addonOwnerOf(f.chartFailed!)).toBeUndefined();
  });

  it("tells the state from helm-controller's conditions and the Job", () => {
    expect(chartStateOf(f.chartTraefik!, f.jobTraefik!)).toBe("deployed");
    expect(chartStateOf(f.chartTraefik!)).toBe("applied");
    expect(chartStateOf(f.chartFailed!)).toBe("failed");
    expect(chartStateOf(f.chartRetrying!, f.jobRetrying!)).toBe("retrying");
    const bare = copy(f.chartFailed!);
    delete (bare as Record<string, unknown>).status;
    expect(chartStateOf(bare)).toBe("unknown");
    expect(chartStateOf(bare, f.jobFailed!)).toBe("failed");
    expect(jobOfChart(f.chartFailed!, jobs())?.metadata?.name).toBe("helm-install-my-app");
  });
});

describe("bundled components", () => {
  const inputs = {
    addons: [f.addonCoredns!, f.addonTraefik!],
    charts: [f.chartTraefik!, f.chartRetrying!],
    jobs: jobs(),
    deployments: [f.deployCoredns!, f.deployTraefik!, f.deployLocalPath!, f.deployOther!, f.deployRke2Coredns!],
    daemonSets: [f.dsSvclb!, f.dsOther!],
  };

  it("k3s: each component by its manifest's Deployment or its chart's Helm release", () => {
    const rows = Object.fromEntries(componentsOf("k3s", inputs).map((r) => [r.def.id, r]));
    expect(rows.coredns).toMatchObject({ state: "ready" });
    expect(rows.traefik).toMatchObject({ state: "notReady", chartState: "deployed" });
    expect(rows.traefik!.workloads.map((w) => w.name)).toEqual(["traefik"]);
    expect(rows.localPath).toMatchObject({ state: "ready" });
    expect(rows.metricsServer).toMatchObject({ state: "notFound" });
    expect(rows.serviceLb!.workloads.map((w) => w.name)).toEqual(["svclb-traefik-5d3e1c2a"]);
    expect(componentsOf("k3s", inputs).every(shownComponent)).toBe(true);
  });

  it("RKE2: only the charts present are listed", () => {
    const shown = componentsOf("rke2", inputs).filter(shownComponent);
    expect(shown.map((r) => [r.def.id, r.state])).toEqual([
      ["rke2Coredns", "ready"],
      ["rke2IngressNginx", "installing"],
    ]);
  });

  it("knows the component Deployments the problems judge, and only those", () => {
    expect(componentOfDeployment(f.deployTraefik!)?.id).toBe("traefik");
    expect(componentOfDeployment(f.deployRke2Coredns!)?.id).toBe("rke2Coredns");
    expect(componentOfDeployment(f.deployOther!)).toBeUndefined();
  });

  it("ServiceLB: the Service of each DaemonSet and its load-balancer addresses", () => {
    expect(serviceLbOf(f.dsSvclb!)).toMatchObject({ service: "traefik", serviceNamespace: "kube-system", program: "k3s", desired: 2, ready: 2 });
    expect(serviceLbOf(f.dsOther!)).toBeUndefined();
    expect(loadBalancerAddresses(f.svcTraefik!)).toEqual(["10.0.0.11", "10.0.0.21"]);
  });
});

describe("etcd snapshots", () => {
  it("reads the node, the storage and the state, without credentials", () => {
    expect(snapshotOf(f.snapshotLocal!)).toMatchObject({ node: "k3s-server-1", storage: "local", size: "12582944", readyToUse: true });
    expect(snapshotStateOf(snapshotOf(f.snapshotLocal!))).toBe("ready");
    const s3 = snapshotOf(f.snapshotS3Failed!);
    expect(s3).toMatchObject({ storage: "s3", bucket: "k3s-backups" });
    expect(snapshotStateOf(s3)).toBe("failed");
  });
});

describe("problems", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const input = (over: Partial<Parameters<typeof toProblems>[0]> = {}) => ({
    charts: [f.chartTraefik!, f.chartFailed!, f.chartRetrying!],
    jobs: jobs(),
    deployments: [f.deployCoredns!, f.deployTraefik!, f.deployOther!, f.deployRke2Coredns!],
    ...over,
  });

  it("a failed install for a day, an install that keeps failing, an unavailable component; never the values", () => {
    const problems = toProblems(input(), new Map(), now);
    expect(problems.map((p) => `${p.object.kind.kind}/${p.object.name}:${p.reason}`).sort()).toEqual([
      "Deployment/traefik:ComponentUnavailable",
      "HelmChart/my-app:HelmChartFailed",
      "HelmChart/rke2-ingress-nginx:HelmChartRetrying",
    ]);
    const failed = problems.find((p) => p.reason === "HelmChartFailed")!;
    const failedAt = Date.parse("2026-10-01T10:00:00Z");
    expect(failed).toMatchObject({ category: "k3s", activeAt: failedAt, until: failedAt + FAILED_FOR_MS });
    expect(failed.message).toContain("retries");
    expect(problems.find((p) => p.reason === "HelmChartRetrying")).toMatchObject({ activeAt: now + RETRY_GRACE_MS, messageParams: { failed: 4 } });
    expect(problems.find((p) => p.reason === "ComponentUnavailable")!.activeAt).toBe(Date.parse("2026-10-01T09:00:00Z") + UNAVAILABLE_GRACE_MS);
    for (const secret of SECRETS) expect(JSON.stringify(problems)).not.toContain(secret);
  });

  it("without the Jobs a chart's own Failed condition still counts; unread Deployments are not judged", () => {
    const seen: Seen = new Map();
    const problems = toProblems(input({ jobs: undefined, deployments: undefined }), seen, now);
    expect(problems.map((p) => p.reason)).toEqual(["HelmChartFailed"]);
    expect(problems[0]!.until).toBeUndefined();
    expect(toProblems(input({ charts: [f.chartTraefik!], deployments: [f.deployCoredns!] }), seen, now)).toEqual([]);
    expect(seen.size).toBe(0);
  });

  it("is a category of its own, on by default, judged by its provider only where HelmCharts are served", () => {
    expect(PROBLEM_CATEGORIES).toContain("k3s");
    expect(OPT_IN_CATEGORIES).not.toContain("k3s");
    expect(categoryOf(HELM_CHART)).toBe("k3s");
    expect(categoryOf(ADDON)).toBe("k3s");
    expect(detect(HELM_CHART, f.chartFailed!)).toEqual([]);
    expect(judgedByRules(HELM_CHART)).toBe(false);
    expect(sourcesFor(["k3s"], [served(HELM_CHART)])).toEqual([expect.objectContaining({ external: true })]);
    expect(sourcesFor(["k3s"], [served(NODE, false)])).toEqual([]);
  });
});

// ---------- In the app ----------

const NODE: KindRef = { group: "", version: "v1", kind: "Node" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const DAEMONSET: KindRef = { group: "apps", version: "v1", kind: "DaemonSet" };
const JOB: KindRef = { group: "batch", version: "v1", kind: "Job" };
const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };

function served(kind: KindRef, namespaced = true): ResourceKind {
  return { kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced, verbs: ["list", "watch"], printerColumns: [] };
}

let wb: WatchBackend;
let discovery: ResourceKind[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [
    served(NODE, false),
    served(DEPLOYMENT),
    served(DAEMONSET),
    served(JOB),
    served(SERVICE),
    served(HELM_CHART),
    served(HELM_CHART_CONFIG),
    served(ADDON),
    served(ETCD_SNAPSHOT, false),
  ];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery);
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
  wb.backend.on("resource_get", (args) => {
    const ref = args.ref as ObjectRef;
    if (ref.kind.kind === "Service" && ref.name === "traefik") return copy(f.svcTraefik!);
    throw { kind: "notFound", message: "not found" };
  });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the sections", () => {
  it("are there where the cluster serves the kinds; the problems watch the charts, their Jobs and kube-system only", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("helm-controller"));
    expect(sections()).toContain("k3s / RKE2");
    emitSnapshot(wb, await watchOf(wb, "HelmChart"), [f.chartFailed!]);
    emitSnapshot(wb, await watchOf(wb, "Job", (s) => s.labelSelector === JOBS_SELECTOR), [f.jobFailed!]);
    emitSnapshot(wb, await watchOf(wb, "Deployment", (s) => s.namespaces?.join() === "kube-system"), [f.deployTraefik!]);
    const starts = wb.backend.calls.filter((c) => c.cmd === "watch_start").map((c) => c.args.spec as { kind: KindRef; namespaces: string[] | null; labelSelector: string | null });
    expect(starts.filter((s) => s.kind.kind === "Job").every((s) => s.labelSelector === JOBS_SELECTOR)).toBe(true);
  });

  it("are not there without the CRDs, and nothing of them is watched", async () => {
    discovery = [served(NODE, false), served(DEPLOYMENT), served(DAEMONSET)];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Workloads"));
    expect(sections()).not.toContain("helm-controller");
    expect(sections()).not.toContain("k3s / RKE2");
    expect([...wb.specs.values()].some((s) => s.kind.group === "helm.cattle.io" || s.labelSelector === JOBS_SELECTOR)).toBe(false);
  });

  it("the tables show a chart's state, what it installs and its Addon", () => {
    const charts = getResourceDef(HELM_CHART);
    expect(charts.columns.map((c) => c.id)).toEqual(["name", "namespace", "state", "chart", "version", "targetNamespace", "addon", "age"]);
    expect(charts.columns.find((c) => c.id === "addon")!.value(f.chartTraefik!)).toBe("traefik");
    expect(charts.problem?.(f.chartFailed!)).toBe(true);
    expect(getResourceDef(ETCD_SNAPSHOT).columns.find((c) => c.id === "size")!.value(f.snapshotLocal!)).toBe("12.0MiB");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  const [group, version] = (obj.apiVersion ?? "").split("/");
  return version === undefined
    ? { kind: { group: "", version: group ?? "", kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" }
    : { kind: { group: group ?? "", version, kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  return container;
}

const sectionOf = (id: string) => document.querySelector<HTMLElement>(`[data-section='${id}']`)!;

describe("details", () => {
  it("a failed HelmChart: helm-controller's message, its Job with logs, values masked", async () => {
    const container = await openDetails(f.chartFailed!);
    await waitFor(() => expect(sectionOf("k3s")).not.toBeNull());
    emitSnapshot(wb, await watchOf(wb, "Job", (s) => s.labelSelector === "helmcharts.helm.cattle.io/chart=my-app"), [f.jobFailed!]);
    const view = within(sectionOf("k3s"));
    expect(view.getByText(/reached configured number of retries/)).toBeInTheDocument();
    await waitFor(() => expect(view.getByRole("button", { name: "Open Job helm-install-my-app" })).toBeInTheDocument());
    expect(view.getByRole("button", { name: "Logs" })).toBeInTheDocument();
    expect(view.getByText("Show valuesContent")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Open Secret my-app-values" })).toBeInTheDocument();
    for (const secret of SECRETS) expect(sectionOf("k3s").textContent).not.toContain(secret);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a HelmChartConfig: the HelmChart it overrides", async () => {
    const container = await openDetails(f.chartConfigTraefik!);
    await waitFor(() => expect(sectionOf("k3s")).not.toBeNull());
    emitSnapshot(wb, await watchOf(wb, "HelmChart", (s) => s.fieldSelector === "metadata.name=traefik"), [f.chartTraefik!]);
    await waitFor(() => expect(within(sectionOf("k3s")).getByRole("button", { name: "Open HelmChart traefik" })).toBeInTheDocument());
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a k3s node: role, version and its arguments with secret values hidden", async () => {
    const container = await openDetails(f.nodeK3sServer!);
    await waitFor(() => expect(sectionOf("k3sNode")).not.toBeNull());
    const view = within(sectionOf("k3sNode"));
    expect(view.getByText("v1.33.4+k3s1")).toBeInTheDocument();
    expect(view.getByText("--token")).toBeInTheDocument();
    expect(view.getAllByText("hidden").length).toBe(3);
    for (const secret of SECRETS) expect(sectionOf("k3sNode").textContent).not.toContain(secret);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("an etcd snapshot that failed to upload", async () => {
    const container = await openDetails(f.snapshotS3Failed!);
    await waitFor(() => expect(sectionOf("k3s")).not.toBeNull());
    expect(within(sectionOf("k3s")).getByText(/failed to upload snapshot/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("the Distribution page", () => {
  it("shows the distribution, the components and the Services ServiceLB serves", async () => {
    const Page = getPage(DISTRIBUTION_PAGE_ID)!.Component;
    const { container } = render(<Page clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "Node", (s) => s.labelSelector === null), [f.nodeK3sServer!, f.nodeK3sAgent!]);
    emitSnapshot(wb, await watchOf(wb, "Deployment", (s) => s.namespaces?.join() === "kube-system"), [f.deployCoredns!, f.deployTraefik!, f.deployLocalPath!]);
    emitSnapshot(wb, await watchOf(wb, "DaemonSet", (s) => s.namespaces?.join() === "kube-system"), [f.dsSvclb!, f.dsOther!]);
    emitSnapshot(wb, await watchOf(wb, "Addon"), [f.addonCoredns!, f.addonTraefik!]);
    emitSnapshot(wb, await watchOf(wb, "HelmChart", (s) => s.fieldSelector === null), [f.chartTraefik!]);
    emitSnapshot(wb, await watchOf(wb, "Job", (s) => s.labelSelector === JOBS_SELECTOR), [f.jobTraefik!]);
    await waitFor(() => expect(screen.getByText("Servers: 1, agents: 1")).toBeInTheDocument());
    expect(screen.getByText("Embedded etcd")).toBeInTheDocument();
    expect(screen.getByText("CoreDNS")).toBeInTheDocument();
    expect(screen.getByText("Not found (disabled with --disable metrics-server?)")).toBeInTheDocument();
    expect(screen.getByText("0 of 1 available")).toHaveClass("rt-status--warning");
    await waitFor(() => expect(screen.getByText("10.0.0.21")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open Service traefik" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
