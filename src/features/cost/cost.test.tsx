import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CostQuery, CostReport, KubeObject, MetricsStatus, UsageHistory } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getDetailsSections } from "../../layout/details/registry";
import { getPage } from "../../layout/pages";
import { useClustersStore } from "../clusters/clustersStore";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetMetricsCache } from "../metrics/hooks";
import { resetNamespaceRestore } from "../namespaces";
import { resetSharedWatches } from "../resource-map/watches";
import { COST_PAGE_ID, CostPage } from "./CostPage";
import { RightsizingDetailsSection } from "../rightsizing/DetailsSection";
import { CostDetailsSection } from "./DetailsSection";
import "./index";
import { GIB } from "./model";
import { costRow } from "./testing";

const SOURCE = { product: "opencost", namespace: "opencost", service: "opencost", port: 9003 } as const;
const MI = 2 ** 20;
const WEEK = 7 * 24 * 3600;
const NOW_S = Math.floor(Date.now() / 1000);

function report(patch: Partial<CostReport> = {}): CostReport {
  return {
    source: SOURCE,
    window: "week",
    currency: null,
    rows: [
      costRow({ name: "shop", namespace: "shop", cpuCost: 6, ramCost: 3, pvCost: 1, networkCost: 0.5, totalCost: 10.5, totalEfficiency: 0.42 }),
      costRow({ name: "tools", namespace: "tools", cpuCost: 1, ramCost: 1, totalCost: 2 }),
    ],
    idle: costRow({ name: "__idle__", namespace: null, cpuCost: 3, ramCost: 1, totalCost: 4 }),
    totalRows: 2,
    truncated: false,
    ...patch,
  };
}

let wb: WatchBackend;
const queries = () => wb.backend.calls.filter((c) => c.cmd === "cost_allocation").map((c) => c.args.query as CostQuery);

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  resetMetricsCache();
  useClustersStore.setState({ settingsFor: null });
  useAppStore.getState().setActiveCluster("c1");
  useAppStore.getState().setNamespaces("c1", ["tools", "shop"]);
  wb = watchBackend();
});

afterEach(() => {
  resetSharedWatches();
  wb.backend.restore();
  resetMetricsCache();
});

describe("registration", () => {
  it("adds the page to the Cluster section and a details section for workloads", () => {
    expect(getPage(COST_PAGE_ID)).toMatchObject({ section: "cluster", order: 50, labelKey: "cost:sidebar", icon: "cost" });
    const has = (group: string, kind: string) => getDetailsSections({ group, version: "v1", kind }).some((s) => s.id === "cost");
    expect(has("apps", "Deployment")).toBe(true);
    expect(has("apps", "StatefulSet")).toBe(true);
    expect(has("apps", "DaemonSet")).toBe(true);
    expect(has("", "Pod")).toBe(false);
    expect(has("", "Node")).toBe(false);
  });
});

describe("Cost page", () => {
  it("says where to get OpenCost when neither it nor Kubecost is installed", async () => {
    wb.backend.on("cost_allocation", () => report({ source: null, rows: [], idle: null, totalRows: 0 }));
    render(<CostPage clusterId="c1" />);
    expect(await screen.findByText("OpenCost or Kubecost was not found")).toBeTruthy();
    expect(screen.getByText(/https:\/\/www\.opencost\.io/)).toBeTruthy();
    expect(screen.getByText(/does not install it/)).toBeTruthy();
  });

  it("shows totals split by resource, the idle cost and the groups of the selected namespaces", async () => {
    wb.backend.on("cost_allocation", () => report());
    render(<CostPage clusterId="c1" />);
    await screen.findByText("From OpenCost, Service opencost/opencost.", { exact: false });
    expect(queries()[0]).toEqual({ window: "week", aggregate: { type: "namespace" }, namespaces: ["shop", "tools"] });
    expect(screen.getByText(/the API does not name it/)).toBeTruthy();

    const totals = screen.getByRole("region", { name: "Totals" });
    const value = (label: string) => within(totals).getByText(label).nextElementSibling!.textContent;
    expect(value("Total")).toBe("16.50");
    expect(value("Allocated")).toBe("12.50");
    expect(value("Idle")).toBe("4.00");
    expect(value("CPU")).toBe("7.00");
    expect(value("Storage")).toBe("1.00");
    expect(screen.getByRole("img", { name: "Split of the allocated cost" })).toBeTruthy();

    const shop = screen.getByRole("button", { name: "Open shop" }).closest("tr")!;
    expect(within(shop).getByText("10.50")).toBeTruthy();
    expect(within(shop).getByText("42%")).toBeTruthy();
    const idle = screen.getByText("Idle (unused capacity)").closest("tr")!;
    expect(within(idle).getByText("4.00")).toBeTruthy();
    // No GPU cost: no GPU column.
    expect(screen.queryByRole("columnheader", { name: "GPU" })).toBeNull();
  });

  it("asks again for another period and grouping, and a label key only once it is valid", async () => {
    wb.backend.on("cost_allocation", () => report({ currency: "EUR" }));
    render(<CostPage clusterId="c1" />);
    await screen.findByText("Amounts in EUR.", { exact: false });
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "month" } });
    await waitFor(() => expect(queries().at(-1)).toMatchObject({ window: "month", aggregate: { type: "namespace" } }));
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "workload" } });
    await waitFor(() => expect(queries().at(-1)).toMatchObject({ window: "month", aggregate: { type: "workload" } }));

    const before = queries().length;
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "label" } });
    expect(await screen.findByText(/Enter a label key/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Label key"), { target: { value: "a b" } });
    expect(screen.getByText("This is not a label key.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Show" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Label key"), { target: { value: "app.kubernetes.io/name" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() =>
      expect(queries().at(-1)).toMatchObject({ aggregate: { type: "label", key: "app.kubernetes.io/name" } }),
    );
    expect(queries().length).toBe(before + 1);
  });

  it("shows an error with Retry", async () => {
    let fail = true;
    wb.backend.on("cost_allocation", () => {
      if (fail) throw { code: "forbidden", message: "no permission to reach the cost service" };
      return report();
    });
    render(<CostPage clusterId="c1" />);
    expect(await screen.findByText("Costs could not be read")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Open shop" })).toBeTruthy();
  });
});

function status(): MetricsStatus {
  return {
    metricsServer: true,
    prometheus: { type: "service", namespace: "monitoring", service: "prometheus-operated", port: 9090, pathPrefix: "" },
    mode: { mode: "auto" },
    usageSource: "auto",
    effectiveUsageSource: "metricsServer",
  };
}

function webPod(name: string): KubeObject {
  return {
    metadata: {
      namespace: "shop",
      name,
      uid: name,
      creationTimestamp: "2026-10-01T00:00:00Z",
      labels: { "pod-template-hash": "7d9f8c6b5", app: "web" },
      ownerReferences: [{ kind: "ReplicaSet", name: "web-7d9f8c6b5", controller: true }],
    },
    spec: { containers: [{ name: "app", resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { memory: "1Gi" } } }] },
    status: { phase: "Running" },
  };
}

const PODS = [webPod("web-7d9f8c6b5-aaaaa"), webPod("web-7d9f8c6b5-bbbbb")];

const HISTORY: UsageHistory = {
  windowSecs: WEEK,
  evaluatedAt: NOW_S,
  truncated: false,
  coverageKnown: true,
  liveKnown: true,
  containers: PODS.map((p) => ({
    namespace: "shop",
    pod: p.metadata!.name!,
    container: "app",
    cpuP95Millicores: 100,
    memoryMaxBytes: 100 * MI,
    throttledRatio: null,
    firstSeen: NOW_S - WEEK,
    lastSeen: NOW_S,
  })),
};

const DEPLOYMENT: KubeObject = {
  metadata: { namespace: "shop", name: "web", uid: "d1" },
  spec: { selector: { matchLabels: { app: "web" } } },
};
const WEB_REF = { kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "shop", name: "web" };

const WEB = costRow({
  name: "shop/deployment:web",
  namespace: "shop",
  controllerKind: "deployment",
  controller: "web",
  cpuCost: 4.8,
  cpuCoreHours: 160,
  ramCost: 1.6,
  ramByteHours: 320 * GIB,
  totalCost: 7,
  minutes: 7 * 1440,
});

describe("Cost section of a workload's details", () => {
  it("shows the week's cost, a monthly estimate and the savings of the right-sizing recommendation", async () => {
    wb.backend.on("cost_allocation", () => report({ currency: "USD", rows: [WEB] }));
    wb.backend.on("metrics_status", () => status());
    wb.backend.on("metrics_usage_history", () => HISTORY);
    wb.backend.on("metrics_pods", () => []);
    render(<CostDetailsSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);

    const section = await screen.findByRole("region", { name: "Cost" });
    expect(queries()[0]).toEqual({ window: "week", aggregate: { type: "workload" }, namespaces: ["shop"] });
    const fact = (label: string) => within(section).getByText(label).nextElementSibling!.textContent;
    expect(fact("Cost over the last 7 days")).toBe("$7.00");
    // 7 over 7 days → 30 over 30 days.
    expect(fact("Monthly estimate")).toBe("$30.00");
    expect(within(section).getByText(/\$0\.03 per CPU core-hour, \$0\.01 per GiB-hour/)).toBeTruthy();

    const id = await watchOf(wb, "Pod");
    expect(wb.specs.get(id)).toMatchObject({ namespaces: ["shop"], labelSelector: "app=web" });
    emitSnapshot(wb, id, PODS);
    // 2 × (1000m − 120m) CPU and 2 × (1024Mi − 128Mi) memory over 30 days:
    // 1.76 × 0.03 × 720 + 1.75 × 0.005 × 720 = 38.016 + 6.3.
    await waitFor(() => expect(fact("Estimated savings with the right-sizing recommendation")).toBe("$44.32 per month"));
    expect(within(section).getByText(/requests above the recommendation/)).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Open right-sizing" }));
    expect(useAppStore.getState().clusterViews.c1?.view).toBe("rightsizing");
  });

  it("is not shown without OpenCost or Kubecost, and says when the workload has no costs", async () => {
    wb.backend.on("cost_allocation", () => report({ source: null, rows: [], idle: null }));
    const { container, unmount } = render(<CostDetailsSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    await waitFor(() => expect(queries()).toHaveLength(1));
    expect(container.textContent).toBe("");
    unmount();
    resetMetricsCache();

    wb.backend.on("cost_allocation", () => report({ rows: [] }));
    render(<CostDetailsSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />);
    expect(await screen.findByText("OpenCost or Kubecost has no costs for this workload in the last 7 days.")).toBeTruthy();
    // No savings without a cost row: no pods are watched.
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Pod")).toBe(false);
  });
});

describe("Cost and right-sizing sections together", () => {
  it("share one pod watch and one history poller", async () => {
    wb.backend.on("cost_allocation", () => report({ rows: [WEB] }));
    wb.backend.on("metrics_status", () => status());
    wb.backend.on("metrics_usage_history", () => HISTORY);
    wb.backend.on("metrics_pods", () => []);
    render(
      <>
        <RightsizingDetailsSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />
        <CostDetailsSection clusterId="c1" objectRef={WEB_REF} obj={DEPLOYMENT} />
      </>,
    );
    const id = await watchOf(wb, "Pod");
    emitSnapshot(wb, id, PODS);
    const section = await screen.findByRole("region", { name: "Cost" });
    await waitFor(() => expect(within(section).getByText("44.32 per month")).toBeTruthy());
    expect([...wb.specs.values()].filter((s) => s.kind.kind === "Pod")).toHaveLength(1);
    expect(wb.backend.calls.filter((c) => c.cmd === "metrics_usage_history")).toHaveLength(1);
  });

  it("watches by matchExpressions when the selector has no matchLabels", async () => {
    wb.backend.on("cost_allocation", () => report({ rows: [WEB] }));
    wb.backend.on("metrics_status", () => status());
    wb.backend.on("metrics_usage_history", () => HISTORY);
    const obj: KubeObject = {
      metadata: { namespace: "shop", name: "web", uid: "d1" },
      spec: { selector: { matchExpressions: [{ key: "app", operator: "In", values: ["web"] }] } },
    };
    render(<RightsizingDetailsSection clusterId="c1" objectRef={WEB_REF} obj={obj} />);
    const id = await watchOf(wb, "Pod");
    expect(wb.specs.get(id)).toMatchObject({ namespaces: ["shop"], labelSelector: "app in (web)" });
  });
});
