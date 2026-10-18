import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type MockBackend, type ScanApi, type UpgradeScan } from "../../api";
import { resetAppStore } from "../../app/store";
import { getPages } from "../../layout/pages";
import { resetNamespaceRestore } from "../namespaces";
import "./index";
import { resetUpgradeState, UPGRADE_PAGE } from "./state";
import { DEPRECATIONS } from "./table";
import { UpgradePage } from "./UpgradePage";

const scan: UpgradeScan = {
  version: { gitVersion: "v1.24.6", major: "1", minor: "24", platform: "linux/amd64" },
  served: [{ group: "policy", version: "v1beta1", kind: "PodDisruptionBudget" }],
  usages: [
    {
      api: { group: "batch", version: "v1beta1", kind: "CronJob" },
      namespace: "shop",
      name: "nightly",
      origin: { type: "helm", release: "shop", namespace: "shop", revision: 3 },
    },
    {
      api: { group: "autoscaling", version: "v2beta2", kind: "HorizontalPodAutoscaler" },
      namespace: "web",
      name: "api",
      origin: { type: "argoCd", application: "web", namespace: "argocd" },
    },
  ],
  usagesTruncated: false,
  nodes: [
    { name: "cp", kubeletVersion: "v1.24.6", kubeProxyVersion: "", controlPlane: true },
    { name: "old", kubeletVersion: "v1.22.1", kubeProxyVersion: "", controlPlane: false },
  ],
  components: [],
  sources: [
    { source: "live", outcome: "done", error: null, scanned: 10, truncated: false, skipped: [] },
    {
      source: "helm",
      outcome: "done",
      error: { code: "forbidden", message: "secrets is forbidden" },
      scanned: 2,
      truncated: false,
      skipped: [{ group: "kube-system", version: "", kind: "locked" }],
    },
    { source: "argoCd", outcome: "done", error: null, scanned: 1, truncated: false, skipped: [] },
    { source: "flux", outcome: "notInstalled", error: null, scanned: 0, truncated: false, skipped: [] },
  ],
};

let backend: MockBackend;
let asked: ScanApi[][];

beforeEach(() => {
  resetAppStore();
  resetUpgradeState();
  resetNamespaceRestore();
  asked = [];
  backend = mockBackend({
    upgrade_scan: (args) => {
      asked.push((args as { apis: ScanApi[] }).apis);
      return scan;
    },
  });
});

afterEach(() => {
  backend.restore();
});

describe("the Upgrade readiness page", () => {
  it("is a page of the Cluster section", () => {
    expect(getPages("cluster").find((p) => p.id === UPGRADE_PAGE)).toMatchObject({
      labelKey: "upgrade:sidebar",
      icon: "upgradeReadiness",
    });
  });

  it("scans once with the whole table and shows what breaks at the next minor version", async () => {
    render(<UpgradePage clusterId="c1" />);
    const table = await screen.findByRole("table");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(DEPRECATIONS.length);

    expect(screen.getByText("Cluster version: v1.24.6")).toBeInTheDocument();
    expect(screen.getByText(/not clients that call deprecated APIs.*apiserver_requested_deprecated_apis/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Target version" })).toHaveValue("25");
    const counts = screen.getAllByRole("status").find((s) => s.textContent?.includes("removed"))!;
    expect(counts).toHaveTextContent("1 removed");
    expect(counts).toHaveTextContent("1 deprecated");
    expect(counts).toHaveTextContent("1 deprecated API version served");
    expect(counts).toHaveTextContent("1 version skew problem");

    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Removed");
    expect(rows[1]).toHaveTextContent("CronJob");
    expect(rows[1]).toHaveTextContent("batch/v1");
    expect(rows[1]).toHaveTextContent("Helm release shop/shop (revision 3)");
    expect(rows[2]).toHaveTextContent("Deprecated");
    expect(rows[2]).toHaveTextContent("Argo CD application argocd/web");
    expect(screen.getByText(/policy\/v1beta1/)).toBeInTheDocument();
    expect(screen.getByText(/1 node must be upgraded before the control plane reaches 1.25 \(its kubelet is 1.22\): old/)).toBeInTheDocument();
    expect(screen.getByText(/Some Helm releases could not be read: kube-system\/locked/)).toBeInTheDocument();
    // Flux is not installed: no filter for it.
    expect(screen.queryByRole("checkbox", { name: "Flux" })).toBeNull();
  });

  it("re-evaluates for another target and filters by source without scanning again", async () => {
    render(<UpgradePage clusterId="c1" />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByRole("combobox", { name: "Target version" }), { target: { value: "26" } });
    expect(screen.getByText("2 removed")).toBeInTheDocument();
    expect(screen.getByText(/through each of these versions: 1.25, 1.26/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Helm" }));
    expect(within(screen.getByRole("table")).queryByText("CronJob")).toBeNull();
    expect(screen.getByText("1 finding is hidden by the filters.")).toBeInTheDocument();
    expect(asked).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    await waitFor(() => expect(asked).toHaveLength(2));
  });

  it("copies the report as Markdown", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<UpgradePage clusterId="c1" />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
    await screen.findByText("Copied");
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain("# Upgrade readiness: v1.24.6 → 1.25");
    expect(text).toContain("| Removed | CronJob | shop | nightly | batch/v1beta1 |");
  });

  it("shows why a scan failed", async () => {
    backend.on("upgrade_scan", () => {
      throw { code: "notFound", message: "cluster not connected" };
    });
    render(<UpgradePage clusterId="c1" />);
    expect(await screen.findByText("Could not scan the cluster")).toBeInTheDocument();
  });
});
