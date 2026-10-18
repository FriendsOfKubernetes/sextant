import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { resetClusterKinds } from "../../resources";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import "../problems";
import { ProblemsPage } from "../problems/ProblemsPage";
import { resetProblemSources } from "../problems/store";
import { resetProblemsUi } from "../problems/ui";
import auditJson from "./fixtures/configauditreport.json";
import vulnJson from "./fixtures/vulnerabilityreport.json";
import "./index";
import { SecurityPage } from "./SecurityPage";
import { CLUSTER_COMPLIANCE_REPORT, CONFIG_AUDIT_REPORT, VULNERABILITY_REPORT } from "./trivy";

const vuln = vulnJson as KubeObject;
const audit = auditJson as KubeObject;

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

const BUILT_IN: KindRef[] = [
  { group: "", version: "v1", kind: "Pod" },
  { group: "", version: "v1", kind: "Namespace" },
  { group: "apps", version: "v1", kind: "Deployment" },
  { group: "apps", version: "v1", kind: "ReplicaSet" },
];

let wb: WatchBackend;
let discovery: KindRef[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetProblemsUi();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [...BUILT_IN, VULNERABILITY_REPORT, CONFIG_AUDIT_REPORT, CLUSTER_COMPLIANCE_REPORT];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map((k) => served(k, k.kind !== "ClusterComplianceReport" && k.kind !== "Namespace")));
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
});

// ---------- Fixtures ----------

const container = (securityContext: Record<string, unknown> = {}) => ({
  name: "nginx",
  image: "nginx:1.25.3",
  resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { memory: "64Mi" } },
  securityContext: { readOnlyRootFilesystem: true, ...securityContext },
});

function deployment(name: string, spec: Record<string, unknown>): KubeObject {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: "shop", uid: `d-${name}` },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { app: name } }, spec: { automountServiceAccountToken: false, ...spec } },
    },
  };
}

/** Meets Baseline, not Restricted (no securityContext). */
const web = deployment("web", { containers: [container()] });
/** Violates Baseline: host network. */
const agent = deployment("agent", { hostNetwork: true, containers: [container()] });

const webRs: KubeObject = {
  apiVersion: "apps/v1",
  kind: "ReplicaSet",
  metadata: {
    name: "web-7d9c6b8f5d",
    namespace: "shop",
    uid: "rs-1",
    creationTimestamp: "2026-10-10T00:00:00Z",
    labels: { app: "web" },
    ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "d-web", controller: true }],
  },
  spec: { replicas: 2, template: web.spec && (web.spec as Record<string, unknown>).template },
};

const shop: KubeObject = {
  apiVersion: "v1",
  kind: "Namespace",
  metadata: { name: "shop", uid: "ns-shop", labels: { "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/warn": "baseline" } },
};

const inShop = (kind: string) => watchOf(wb, kind, (s) => JSON.stringify(s.namespaces) === JSON.stringify(["shop"]) && s.labelSelector === null);

// ---------- Sidebar ----------

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the sidebar", () => {
  it("lists the Trivy report kinds the cluster serves, and the Security page under Cluster", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Trivy"));
    fireEvent.click(screen.getByRole("button", { name: /Trivy/ }));
    const trivy = within(screen.getByRole("button", { name: /Trivy/ }).closest("li")!);
    for (const label of ["Vulnerability Reports", "Config Audit Reports", "Cluster Compliance Reports"]) {
      expect(trivy.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(trivy.queryByRole("button", { name: "Exposed Secret Reports" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cluster" }));
    expect(screen.getByRole("button", { name: "Security" })).toBeInTheDocument();
  });

  it("has no Trivy section without Trivy Operator", async () => {
    discovery = [...BUILT_IN];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Workloads"));
    expect(sections()).not.toContain("Trivy");
  });
});

// ---------- The page ----------

async function renderPage(): Promise<void> {
  useAppStore.getState().setNamespaces("c1", ["shop"]);
  render(<SecurityPage clusterId="c1" />);
  emitSnapshot(wb, await inShop("Deployment"), [web, agent]);
  emitSnapshot(wb, await inShop("ReplicaSet"), [webRs]);
  for (const kind of ["StatefulSet", "DaemonSet", "CronJob", "Job", "Pod"]) emitSnapshot(wb, await inShop(kind), []);
  emitSnapshot(wb, await watchOf(wb, "Namespace", (s) => s.fieldSelector === null), [shop]);
  emitSnapshot(wb, await inShop("VulnerabilityReport"), [vuln]);
  emitSnapshot(wb, await inShop("ConfigAuditReport"), [audit]);
}

describe("the Security page", () => {
  it("asks for namespaces with All namespaces, and watches nothing", async () => {
    render(<SecurityPage clusterId="c1" />);
    await waitFor(() => expect(screen.getByText("Choose namespaces")).toBeInTheDocument());
    expect(wb.specs.size).toBeLessThanOrEqual(1);
    expect([...wb.specs.values()].every((s) => s.kind.kind === "Namespace")).toBe(true);
  });

  it("compares the namespace's labels with its workloads, lists findings with fixes and the image scans", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderPage();
    const ns = within(await screen.findByRole("region", { name: "shop" }));
    await waitFor(() =>
      expect(ns.getByText("pod-security.kubernetes.io/enforce=restricted: 2 workloads would be rejected.")).toBeInTheDocument(),
    );
    expect(ns.getByText("pod-security.kubernetes.io/warn=baseline: 1 workload would get a warning.")).toBeInTheDocument();
    // Worst first: the Deployment with the host network.
    const rows = ns.getAllByRole("button", { name: /^Open Deployment/ }).map((b) => b.textContent);
    expect(rows).toEqual(["Deployment: agent", "Deployment: web"]);
    expect(ns.getByText("Violates Baseline")).toBeInTheDocument();
    expect(ns.getByText("Meets Baseline")).toBeInTheDocument();
    // web's image scan: through its ReplicaSet.
    expect(ns.getByText("Critical: 1")).toBeInTheDocument();
    expect(ns.getByText("1 critical or high audit finding")).toBeInTheDocument();

    fireEvent.click(ns.getByRole("button", { name: "Show the findings of agent" }));
    const finding = document.querySelector<HTMLElement>("[data-check='hostNamespaces']")!;
    expect(within(finding).getByText("spec.template.spec.hostNetwork")).toBeInTheDocument();
    expect(within(finding).getByText("Host namespace")).toBeInTheDocument();
    fireEvent.click(within(finding).getByRole("button", { name: "Copy the fix" }));
    await waitFor(() => expect(within(finding).getByText("Copied")).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith("spec:\n  template:\n    spec:\n      hostNetwork: false\n");
  });

  it("says the labels are unknown when the Namespaces cannot be listed", async () => {
    useAppStore.getState().setNamespaces("c1", ["shop"]);
    render(<SecurityPage clusterId="c1" />);
    emitSnapshot(wb, await inShop("Deployment"), [web]);
    const nsWatch = await watchOf(wb, "Namespace", (s) => s.fieldSelector === null);
    act(() => wb.backend.emit(`watch:${nsWatch}`, { type: "error", code: "forbidden", message: "namespaces is forbidden" }));
    const ns = within(await screen.findByRole("region", { name: "shop" }));
    await waitFor(() => expect(ns.getByText("Pod Security labels unknown: the Namespace could not be read.")).toBeInTheDocument());
    expect(ns.queryByText(/No Pod Security labels/)).toBeNull();
  });

  it("filters by level and by vulnerability severity", async () => {
    await renderPage();
    const ns = within(await screen.findByRole("region", { name: "shop" }));
    await waitFor(() => expect(ns.getAllByRole("button", { name: /^Open Deployment/ })).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "baseline" } });
    expect(ns.getAllByRole("button", { name: /^Open Deployment/ }).map((b) => b.textContent)).toEqual(["Deployment: agent"]);
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Image vulnerabilities"), { target: { value: "CRITICAL" } });
    expect(ns.getAllByRole("button", { name: /^Open Deployment/ }).map((b) => b.textContent)).toEqual(["Deployment: web"]);
  });
});

// ---------- Details ----------

async function openDetails(obj: KubeObject, kind: KindRef): Promise<void> {
  const ref: ObjectRef = { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section='${id}']`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

describe("the Security section of a workload", () => {
  it("shows its posture against the namespace's labels, its findings and its image scans", async () => {
    await openDetails(web, { group: "apps", version: "v1", kind: "Deployment" });
    await waitFor(() => expect(within(section("security")).getByText("Meets the Baseline standard, but not Restricted.")).toBeInTheDocument());
    const sec = within(section("security"));
    // Until the Namespace is read, its labels are unknown (not "none").
    expect(sec.getByText("Pod Security labels unknown: the Namespace could not be read.")).toBeInTheDocument();
    emitSnapshot(wb, await watchOf(wb, "Namespace", (s) => s.fieldSelector === "metadata.name=shop"), [shop]);
    await waitFor(() => expect(sec.getByText("pod-security.kubernetes.io/enforce=restricted: 1 workload would be rejected.")).toBeInTheDocument());
    expect(sec.getByText("Privilege escalation not disabled")).toBeInTheDocument();

    // Its ReplicaSets by its selector, then the reports of the live one by label.
    const rsWatch = await watchOf(wb, "ReplicaSet", (s) => s.labelSelector === "app=web");
    emitSnapshot(wb, rsWatch, [webRs]);
    // Its live Pods: a sidecar injected at admission adds what the template does not have.
    const injected: KubeObject = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "web-7d9c6b8f5d-abcde", namespace: "shop", uid: "pod-1", ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-7d9c6b8f5d", uid: "rs-1", controller: true }] },
      spec: { initContainers: [{ name: "istio-init", image: "istio/proxyv2:1.24", securityContext: { capabilities: { add: ["NET_ADMIN", "NET_RAW"] } } }], containers: [container()] },
    };
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.labelSelector === "app=web"), [injected]);
    await waitFor(() => expect(section("security").querySelector("[data-check='capabilities']")).not.toBeNull());
    const added = section("security").querySelector<HTMLElement>("[data-check='capabilities']")!;
    expect(within(added).getByText(/^Added at admission: seen in Pod web-7d9c6b8f5d-abcde/)).toBeInTheDocument();
    expect(within(added).queryByRole("button", { name: "Copy the fix" })).toBeNull();
    expect(sec.getByText("Violates Baseline")).toBeInTheDocument();
    const selector = "trivy-operator.resource.kind=ReplicaSet,trivy-operator.resource.name=web-7d9c6b8f5d";
    emitSnapshot(wb, await watchOf(wb, "VulnerabilityReport", (s) => s.labelSelector === selector), [vuln]);
    emitSnapshot(wb, await watchOf(wb, "ConfigAuditReport", (s) => s.labelSelector === selector), [audit]);
    await waitFor(() => expect(sec.getByText("CVE-2024-45491")).toBeInTheDocument());
    expect(within(section("security").querySelector<HTMLElement>(".sec-trivy")!).getByText("Container nginx")).toBeInTheDocument();
    expect(sec.getByText("4 vulnerabilities have a fixed version.")).toBeInTheDocument();
    expect(sec.getByText("KSV014")).toBeInTheDocument();
    expect(sec.getByRole("button", { name: "Open VulnerabilityReport replicaset-web-7d9c6b8f5d-nginx" })).toBeInTheDocument();
  });
});

describe("the details of a Trivy report", () => {
  it("links the scanned object and lists the most severe rows with their fixed versions", async () => {
    await openDetails(vuln, VULNERABILITY_REPORT);
    const report = within(section("trivyReport"));
    await waitFor(() => expect(report.getByRole("button", { name: "Open ReplicaSet web-7d9c6b8f5d" })).toBeInTheDocument());
    const ids = [...section("trivyReport").querySelectorAll(".sec-table tbody tr")].map((tr) => tr.children[1]?.textContent);
    expect(ids).toEqual(["CVE-2024-45491", "CVE-2024-45492", "CVE-2023-52425", "CVE-2024-2511", "CVE-2024-5535"]);
    expect(report.getAllByText("2.5.0-1+deb12u1")).toHaveLength(2);
    expect(report.getAllByText("No fix")).toHaveLength(1);
  });
});

// ---------- Problems ----------

describe("the problems screen", () => {
  it("lists Baseline violations as the Security category while the saved setting is on, and the counter agrees", async () => {
    render(
      <>
        <Sidebar clusterId="c1" />
        <ProblemsPage clusterId="c1" />
      </>,
    );
    const privilegedPod: KubeObject = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "debug", namespace: "shop", uid: "p-1", creationTimestamp: "2026-10-10T00:00:00Z" },
      spec: { hostPID: true, containers: [container({ privileged: true })] },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
    };
    const podWatches = () =>
      [...wb.specs.entries()]
        .filter(([id, spec]) => spec.kind.kind === "Pod" && spec.namespaces === null && wb.backend.listenerCount(`watch:${id}`) > 0)
        .map(([id]) => id);
    await waitFor(() => expect(podWatches()).toHaveLength(1));
    emitSnapshot(wb, podWatches()[0]!, [privilegedPod]);
    const checkbox = await screen.findByRole("checkbox", { name: "Security findings" });
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByRole("region", { name: "Security" })).toBeNull();
    expect(screen.queryByTitle(/needs? attention/)).toBeNull();

    // On: saved (the notifications follow the same setting), and a watch of its own judges the pods.
    fireEvent.click(checkbox);
    await waitFor(() => expect(stored.notifications.enabledCategories).toEqual(["security"]));
    await waitFor(() => expect(podWatches()).toHaveLength(2));
    emitSnapshot(wb, podWatches()[1]!, [privilegedPod]);
    const group = within(await screen.findByRole("region", { name: "Security" }));
    expect(group.getByText("PodSecurityBaseline")).toBeInTheDocument();
    expect(group.getByText("2 Baseline Pod Security violations: hostPID, privileged")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTitle("1 problem needs attention")).toHaveTextContent("1"));

    fireEvent.click(screen.getByRole("checkbox", { name: "Security findings" }));
    await waitFor(() => expect(stored.notifications.enabledCategories).toEqual([]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Security" })).toBeNull());
    await waitFor(() => expect(screen.queryByTitle(/needs? attention/)).toBeNull());
  });
});
