import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type ClusterInfo, type KubeObject, type MockBackend } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { getClusterSettingsSections } from "../clusters/settingsRegistry";
import { getDetailsSections } from "../../layout/details/registry";
import { getPage } from "../../layout/pages";
import { axeViolations } from "../../test/axe";
import { useClustersStore } from "../clusters/clustersStore";
import { emitSnapshot, watchOf, type WatchBackend } from "../details/testing";
import { resetSharedWatches } from "../resource-map/watches";
import { AlertsPage } from "./AlertsPage";
import { AlertsDetailsSection } from "./DetailsSection";
import "./index";
import {
  alertsOf,
  alertTarget,
  choices,
  DEPLOYMENT,
  groupAlerts,
  indexAlerts,
  matches,
  NAMESPACE,
  NO_FILTER,
  NODE,
  POD,
  SERVICE,
} from "./model";
import { alertProblems } from "./provider";
import { AlertsSettingsSection, parseAlertmanagerAddress } from "./SettingsSection";
import { alertsStats, resetAlerts } from "./store";
import { alert, NODE_ALERT, PENDING_ALERT, report, SILENCED_ALERT, WATCHDOG } from "./testing";

let backend: MockBackend;
let wb: WatchBackend;

function start(answer: () => unknown = () => report()) {
  const specs = new Map();
  let n = 0;
  backend = mockBackend({
    alerts_list: answer,
    watch_start: (args) => {
      const id = `watch-${++n}`;
      specs.set(id, args.spec);
      return id;
    },
    watch_stop: () => undefined,
  });
  wb = { backend, specs };
}

const listCalls = () => backend.calls.filter((c) => c.cmd === "alerts_list").length;

beforeEach(() => {
  resetAppStore();
  resetSettingsCache();
  useClustersStore.setState({ settingsFor: null });
  useAppStore.getState().setActiveCluster("c1");
});

afterEach(() => {
  resetSharedWatches();
  resetAlerts();
  backend?.restore();
});

describe("registration", () => {
  it("adds the page, the details section of the named kinds and the settings section", () => {
    expect(getPage("alerts")).toMatchObject({ section: "cluster", order: 12, labelKey: "alerts:sidebar", icon: "alert" });
    const has = (group: string, kind: string) => getDetailsSections({ group, version: "v1", kind }).some((s) => s.id === "alerts");
    for (const [group, kind] of [["", "Pod"], ["apps", "Deployment"], ["batch", "Job"], ["", "Node"], ["", "Namespace"], ["", "PersistentVolumeClaim"]])
      expect(has(group!, kind!)).toBe(true);
    expect(has("", "ConfigMap")).toBe(false);
    expect(getClusterSettingsSections().some((s) => s.id === "alerts" && s.tab === "metrics")).toBe(true);
  });
});

describe("which object an alert names", () => {
  it("prefers the pod, skips kube-state-metrics' scrape Service and falls back to the namespace", () => {
    expect(alertTarget(alert())).toEqual({ kind: POD, namespace: "shop", name: "api-7d9c8b6f5d-x2x4q" });
    expect(alertTarget(PENDING_ALERT)).toEqual({ kind: DEPLOYMENT, namespace: "shop", name: "web" });
    expect(alertTarget(NODE_ALERT)).toEqual({ kind: NODE, namespace: null, name: "worker-2" });
    expect(alertTarget(SILENCED_ALERT)).toEqual({ kind: SERVICE, namespace: "shop", name: "metrics" });
    const hpa = alert({ labels: { horizontalpodautoscaler: "web", job: "kube-state-metrics", namespace: "shop", service: "kps-kube-state-metrics" } });
    expect(alertTarget(hpa)?.kind.kind).toBe("HorizontalPodAutoscaler");
    const ksmOnly = alert({ labels: { job: "kube-state-metrics", namespace: "shop", service: "kps-kube-state-metrics" } });
    expect(alertTarget(ksmOnly)).toEqual({ kind: NAMESPACE, namespace: null, name: "shop" });
    // A namespaced label without a namespace names nothing.
    expect(alertTarget(alert({ labels: { pod: "x" } }))).toBeNull();
    expect(alertTarget(WATCHDOG)).toBeNull();
  });

  it("finds a workload's alerts and those of its own pods, each once", () => {
    const index = indexAlerts([alert(), PENDING_ALERT]);
    const web = { kind: DEPLOYMENT, namespace: "shop", name: "web" };
    expect(alertsOf(index, web).map((a) => a.name)).toEqual(["KubeDeploymentReplicasMismatch"]);
    expect(alertsOf(index, web, ["api-7d9c8b6f5d-x2x4q"]).map((a) => a.name)).toEqual([
      "KubeDeploymentReplicasMismatch",
      "KubePodCrashLooping",
    ]);
    expect(alertsOf(index, { kind: POD, namespace: "shop", name: "api-7d9c8b6f5d-x2x4q" })).toHaveLength(1);
  });

  it("groups by severity, then name, and filters by severity, namespace, state and text", () => {
    const all = report().alerts;
    expect(groupAlerts(all).map((g) => [g.severity, g.count])).toEqual([
      ["critical", 1],
      ["warning", 3],
      ["none", 1],
    ]);
    expect(choices(all)).toEqual({ severities: ["critical", "warning", "none"], namespaces: ["shop"] });
    const only = (patch: Partial<typeof NO_FILTER>) => all.filter((a) => matches(a, { ...NO_FILTER, ...patch })).map((a) => a.name);
    expect(only({ state: "silenced" })).toEqual(["TargetDown"]);
    expect(only({ severity: "critical" })).toEqual(["KubeNodeNotReady"]);
    expect(only({ namespace: "shop", search: "replicas web" })).toEqual(["KubeDeploymentReplicasMismatch"]);
  });
});

describe("problems of the opt-in category", () => {
  it("are firing critical and warning alerts on their objects; only critical ones notify", () => {
    const firstSeen = new Map<string, number>();
    const problems = alertProblems(report().alerts, firstSeen, 1000);
    expect(problems.map((p) => [p.reason, p.object.kind.kind, p.object.name, p.notify])).toEqual([
      ["KubeNodeNotReady", "Node", "worker-2", true],
      ["KubePodCrashLooping", "Pod", "api-7d9c8b6f5d-x2x4q", false],
    ]);
    expect(problems[1]!.message).toBe("Pod is crash looping.");
    expect(problems[1]!.activeAt).toBe(Date.parse("2026-10-24T08:00:30.000Z"));
    // An alert that names only its namespace is a problem of the Namespace; gone ones are forgotten.
    const nsOnly = alert({ labels: { namespace: "shop" }, severity: "critical" });
    const next = alertProblems([nsOnly], firstSeen, 2000);
    expect(next.map((p) => p.object)).toEqual([{ kind: NAMESPACE, namespace: null, name: "shop" }]);
    expect(firstSeen.size).toBe(1);
  });
});

describe("Alerts page", () => {
  it("groups by severity and name with state, object, summary and links, and lists silences read-only", async () => {
    start();
    const { container } = render(<AlertsPage clusterId="c1" />);
    expect(await screen.findByText("Prometheus-compatible source: monitoring/prometheus-operated:9090")).toBeTruthy();
    expect(screen.getByText("Alertmanager: monitoring/alertmanager-operated:9093")).toBeTruthy();
    const critical = screen.getByRole("region", { name: "Critical" });
    expect(within(critical).getByText("KubeNodeNotReady")).toBeTruthy();
    expect(within(critical).getByRole("button", { name: /Node.*worker-2/ })).toBeTruthy();
    const warning = screen.getByRole("region", { name: "Warning" });
    expect(within(warning).getByText("Pod is crash looping.")).toBeTruthy();
    expect(within(warning).getAllByRole("button", { name: "Runbook" }).length).toBe(2);
    expect(within(warning).getByText("Silenced")).toBeTruthy();
    expect(screen.getByText("5 alerts shown")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);

    fireEvent.change(screen.getByLabelText("State"), { target: { value: "pending" } });
    expect(screen.getByText("1 alert shown")).toBeTruthy();
    expect(screen.getByText("KubeDeploymentReplicasMismatch")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Silences (1)" }));
    expect(await screen.findByText('namespace=~"shop|cart"')).toBeTruthy();
    expect(screen.getByText("1 expired silence is not shown.")).toBeTruthy();
    expect(screen.getByText(/create or expire them in Alertmanager/)).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says why there are no alerts when no source answers", async () => {
    start(() =>
      report({
        prometheus: { status: "notAvailable", target: "vm/vmsingle-vm:8428", kind: "victoriaMetricsSingle", error: null },
        alertmanager: { status: "notFound", target: null, error: null },
        alerts: [],
        totalAlerts: 0,
        silences: [],
        expiredSilences: 0,
      }),
    );
    const { container } = render(<AlertsPage clusterId="c1" />);
    expect(await screen.findByText(/gives alerts only through vmalert/)).toBeTruthy();
    expect(screen.getByText(/No Alertmanager was found/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alert sources…" })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("asks once per cluster however many views hold the alerts", async () => {
    start();
    render(
      <>
        <AlertsPage clusterId="c1" />
        <AlertsDetailsSection clusterId="c1" objectRef={{ kind: NODE, namespace: null, name: "worker-2" }} obj={null} />
      </>,
    );
    await screen.findAllByText("KubeNodeNotReady");
    expect(listCalls()).toBe(1);
    expect(alertsStats()).toEqual({ clusters: 1, polling: 1 });
  });
});

describe("Alerts details section", () => {
  it("lists a Node's alerts with their count", async () => {
    start();
    const { container } = render(
      <AlertsDetailsSection clusterId="c1" objectRef={{ kind: NODE, namespace: null, name: "worker-2" }} obj={null} />,
    );
    const section = await screen.findByRole("region", { name: "Alerts" });
    expect(await within(section).findByText("KubeNodeNotReady")).toBeTruthy();
    expect(within(section).getByText("1")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows a Deployment the alerts of its own pods, found through their owners", async () => {
    start();
    const web: KubeObject = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "api", namespace: "shop", uid: "d1" },
      spec: { selector: { matchLabels: { app: "api" } } },
    };
    render(<AlertsDetailsSection clusterId="c1" objectRef={{ kind: DEPLOYMENT, namespace: "shop", name: "api" }} obj={web} />);
    const id = await watchOf(wb, "Pod");
    emitSnapshot(wb, id, [
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "api-7d9c8b6f5d-x2x4q",
          namespace: "shop",
          labels: { app: "api", "pod-template-hash": "7d9c8b6f5d" },
          ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "api-7d9c8b6f5d", uid: "r1", controller: true }],
        },
      },
    ]);
    const section = await screen.findByRole("region", { name: "Alerts" });
    expect(await within(section).findByText("KubePodCrashLooping")).toBeTruthy();
    expect(within(section).getByRole("button", { name: /Pod.*api-7d9c8b6f5d-x2x4q/ })).toBeTruthy();
  });

  it("is hidden while no alert source answers, and opens no pod watch without pod alerts", async () => {
    start(() => report({ prometheus: { status: "off", target: null, error: null }, alertmanager: { status: "off", target: null, error: null }, alerts: [] }));
    const { container } = render(
      <AlertsDetailsSection clusterId="c1" objectRef={{ kind: DEPLOYMENT, namespace: "shop", name: "api" }} obj={null} />,
    );
    await waitFor(() => expect(listCalls()).toBe(1));
    await act(async () => undefined);
    expect(container.textContent).toBe("");
    expect(wb.specs.size).toBe(0);
  });
});

describe("Alerts settings", () => {
  it("reads an address only in the form the core accepts", () => {
    expect(parseAlertmanagerAddress("monitoring/am:9093", "/alertmanager")).toEqual({
      namespace: "monitoring",
      service: "am",
      port: 9093,
      pathPrefix: "/alertmanager",
    });
    expect(parseAlertmanagerAddress("monitoring/am:9093", "")).not.toBeNull();
    expect(parseAlertmanagerAddress("http://am:9093", "")).toBeNull();
    expect(parseAlertmanagerAddress("monitoring/am:0", "")).toBeNull();
    expect(parseAlertmanagerAddress("monitoring/am:9093", "/../x")).toBeNull();
    expect(parseAlertmanagerAddress("monitoring/am:9093", "/a?b=1")).toBeNull();
  });

  it("saves a Service address and asks again", async () => {
    start();
    const cluster: ClusterInfo = {
      id: "c1",
      context: "kind-sextant-test",
      clusterName: "kind-sextant-test",
      server: "https://127.0.0.1:6443",
      user: "admin",
      namespace: null,
      sourceId: "default",
    };
    const { container } = render(<AlertsSettingsSection clusterId="c1" cluster={cluster} />);
    expect(await screen.findByText("monitoring/alertmanager-operated:9093")).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByLabelText("Service address"));
    fireEvent.change(screen.getByLabelText("Service (namespace/name:port)"), { target: { value: "bad address" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toMatch(/namespace\/service:port/);
    fireEvent.change(screen.getByLabelText("Service (namespace/name:port)"), { target: { value: "obs/am:9093" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(backend.settings.clusters.c1?.alertmanager).toEqual({
        mode: "manual",
        target: { namespace: "obs", service: "am", port: 9093, pathPrefix: "" },
      }),
    );
    await waitFor(() => expect(listCalls()).toBe(2));
  });
});
