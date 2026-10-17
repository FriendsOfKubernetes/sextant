import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getPages } from "../../layout/pages";
import { getSectionBadge } from "../../layout/sectionBadges";
import "../../resources";
import { resetClusterKinds } from "../../resources/useKinds";
import { emitDelta, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore, selectNamespaces } from "../namespaces";
import { resetNotifier } from "../notifications/notifier";
import { filterProblems, groupProblems } from "./group";
import "./index";
import { NODE, POD, resolve } from "./model";
import { useProblemCount } from "./hooks";
import { ProblemsPage } from "./ProblemsPage";
import { LINGER_MS, resetProblemSources } from "./store";
import { resetProblemsUi } from "./ui";

const HOUR = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function crashing(name: string, namespace: string, finishedAt = ago(HOUR)): KubeObject {
  return {
    metadata: { name, namespace, uid: `uid-${name}`, creationTimestamp: ago(2 * HOUR) },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "app",
          restartCount: 9,
          state: { waiting: { reason: "CrashLoopBackOff", message: "back-off restarting failed container" } },
          lastState: { terminated: { reason: "Error", finishedAt } },
        },
      ],
    },
  };
}

function pending(name: string, namespace: string): KubeObject {
  return {
    metadata: { name, namespace, uid: `uid-${name}`, creationTimestamp: ago(HOUR) },
    status: {
      phase: "Pending",
      conditions: [
        { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes are available", lastTransitionTime: ago(HOUR) },
      ],
    },
  };
}

const notReady: KubeObject = {
  metadata: { name: "node-1", uid: "uid-node-1" },
  status: { conditions: [{ type: "Ready", status: "False", message: "kubelet stopped posting", lastTransitionTime: ago(HOUR) }] },
};

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetProblemSources();
  resetProblemsUi();
  resetNotifier();
  resetClusterKinds();
  resetNamespaceRestore();
  wb = watchBackend();
  // The cluster serves none of the tools' kinds.
  wb.backend.on("cluster_kinds", () => []);
});

afterEach(() => {
  vi.useRealTimers();
  resetProblemSources();
  wb.backend.restore();
});

async function showProblems(): Promise<void> {
  render(<ProblemsPage clusterId="c1" />);
  emitSnapshot(wb, await watchOf(wb, "Pod"), [crashing("web", "shop"), pending("worker", "batch")]);
  emitSnapshot(wb, await watchOf(wb, "Node"), [notReady]);
  for (const kind of ["Deployment", "StatefulSet", "DaemonSet", "Job", "PersistentVolumeClaim", "Event"]) {
    emitSnapshot(wb, await watchOf(wb, kind), []);
  }
}

describe("the problems screen", () => {
  it("is a page of the Cluster section after the overview, with a counter on the section", () => {
    const page = getPages("cluster").find((p) => p.id === "problems");
    expect(page?.labelKey).toBe("problems:sidebar");
    expect(getSectionBadge("cluster")?.tone).toBe("danger");
  });

  it("groups problems by category and namespace, with the reason, the message and links to the objects", async () => {
    await showProblems();
    const pods = await screen.findByRole("region", { name: "Pods" });
    expect(within(pods).getByRole("heading", { name: "batch" })).toBeInTheDocument();
    expect(within(pods).getByRole("heading", { name: "shop" })).toBeInTheDocument();
    expect(within(pods).getByText("CrashLoopBackOff")).toBeInTheDocument();
    expect(within(pods).getByText("Unschedulable")).toBeInTheDocument();
    expect(within(pods).getByText("0/1 nodes are available")).toBeInTheDocument();
    const nodes = screen.getByRole("region", { name: "Nodes" });
    expect(within(nodes).getByRole("heading", { name: "Cluster-wide" })).toBeInTheDocument();
    // Categories in their order: nodes before pods.
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(regions.indexOf("Nodes")).toBeLessThan(regions.indexOf("Pods"));
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("3 problems");

    fireEvent.click(within(pods).getByRole("button", { name: "Open Pod web" }));
    expect(useAppStore.getState().details).toEqual({ kind: POD, namespace: "shop", name: "web" });
  });

  it("follows the namespace filter; cluster-wide objects stay", async () => {
    await showProblems();
    await screen.findByRole("region", { name: "Pods" });
    await act(() => selectNamespaces("c1", ["shop"]));
    const pods = screen.getByRole("region", { name: "Pods" });
    expect(within(pods).queryByRole("heading", { name: "batch" })).toBeNull();
    expect(within(pods).getByRole("heading", { name: "shop" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Nodes" })).toBeInTheDocument();
  });

  it("\"Only new since…\" keeps what began after the mark", async () => {
    await showProblems();
    await screen.findByRole("region", { name: "Pods" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Only new since/ }));
    expect(screen.getByText("No new problems since the mark.")).toBeInTheDocument();

    emitDelta(wb, await watchOf(wb, "Pod"), [crashing("fresh", "shop", new Date(Date.now() + 1000).toISOString())]);
    const pods = await screen.findByRole("region", { name: "Pods" });
    expect(within(pods).getByRole("button", { name: "Open Pod fresh" })).toBeInTheDocument();
    expect(within(pods).queryByRole("button", { name: "Open Pod web" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Nodes" })).toBeNull();
  });

  it("drops a problem once the object recovers", async () => {
    await showProblems();
    await screen.findByRole("region", { name: "Nodes" });
    const ready = { ...notReady, status: { conditions: [{ type: "Ready", status: "True" }] } };
    emitDelta(wb, await watchOf(wb, "Node"), [ready]);
    expect(screen.queryByRole("region", { name: "Nodes" })).toBeNull();
  });
});

function Badge({ clusterId }: { clusterId: string }) {
  return <output aria-label="badge">{useProblemCount(clusterId)}</output>;
}

describe("the badge", () => {
  it("counts the problems that need attention, not a pending pod", async () => {
    render(<Badge clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "Pod"), [crashing("web", "shop"), pending("worker", "batch")]);
    emitSnapshot(wb, await watchOf(wb, "Node"), [notReady]);
    expect(screen.getByRole("status", { name: "badge" })).toHaveTextContent("2");
  });

  it("stops watching a cluster once it is no longer the open one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = render(<Badge clusterId="c1" />);
    await watchOf(wb, "Pod");
    const watchesOf = (cluster: string) =>
      wb.backend.calls.filter((c) => c.cmd === "watch_start" && c.args.clusterId === cluster).length;
    const opened = watchesOf("c1");
    expect(opened).toBeGreaterThanOrEqual(7);
    rerender(<Badge clusterId="c2" />);
    await act(() => vi.advanceTimersByTimeAsync(LINGER_MS + 100));
    await waitFor(() => expect(wb.backend.calls.filter((c) => c.cmd === "watch_stop")).toHaveLength(opened));
    expect(watchesOf("c2")).toBe(opened);
  });
});

describe("grouping and filters", () => {
  const now = Date.now();
  const all = [
    ...resolve(POD, crashing("b", "zeta"), now),
    ...resolve(POD, crashing("a", "alpha"), now),
    ...resolve(NODE, notReady, now),
  ];

  it("orders categories, puts cluster-wide first and sorts namespaces", () => {
    const groups = groupProblems(all);
    expect(groups.map((g) => [g.category, g.count])).toEqual([
      ["nodes", 1],
      ["pods", 2],
    ]);
    expect(groups[1]!.namespaces.map((n) => n.namespace)).toEqual(["alpha", "zeta"]);
    expect(groups[0]!.namespaces[0]!.namespace).toBeNull();
  });

  it("filters by namespace and by the mark", () => {
    expect(filterProblems(all, { namespaces: ["alpha"], newSince: null }).map((p) => p.object.name)).toEqual(["a", "node-1"]);
    expect(filterProblems(all, { namespaces: [], newSince: null })).toHaveLength(3);
    expect(filterProblems(all, { namespaces: null, newSince: now })).toEqual([]);
  });
});
