// Lazy object counts in the sidebar (#157): asked only for the entries shown, "999+" above that.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type KindRef, type MockBackend, type ResourceKind } from "../../api";
import { resetAppStore } from "../../app/store";
import "../../resources";
import { resetClusterKinds } from "../../resources";
import { COUNT_REQUESTS_PER_MINUTE, refreshCount, resetObjectCounts } from "../../resources/counts";
import { resetNamespaceRestore } from "../../features/namespaces";
import { MEASURE, report } from "../../test/scale";
import { Sidebar } from "./Sidebar";

const served = (group: string, kind: string, namespaced = true): ResourceKind => ({
  kindRef: { group, version: "v1", kind },
  plural: `${kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

let backend: MockBackend;
const counts: Record<string, { count: number; exact: boolean }> = {
  Pod: { count: 42, exact: true },
  Deployment: { count: 5000, exact: true },
  StatefulSet: { count: 600, exact: false },
};

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetObjectCounts();
  resetNamespaceRestore();
  backend = mockBackend({
    cluster_kinds: () => [
      served("", "Pod"),
      served("apps", "Deployment"),
      served("apps", "StatefulSet"),
      served("", "Node", false),
      ...Array.from({ length: 40 }, (_, i) => served("demo.sextant.dev", `Widget${i}`)),
    ],
    watch_start: () => undefined,
    watch_stop: () => undefined,
    resource_count: (args) => {
      const kind = (args.kind as KindRef).kind;
      return counts[kind] ?? { count: 1, exact: true };
    },
  });
});
afterEach(() => backend.restore());

const counted = () => backend.calls.filter((c) => c.cmd === "resource_count").map((c) => (c.args.kind as KindRef).kind);

describe("sidebar counts", () => {
  it("are asked only for entries of open sections and read 999+ above that", async () => {
    render(<Sidebar clusterId="c1" />);
    // Nodes is a single link, always shown; the Workloads section is closed.
    await waitFor(() => expect(counted()).toContain("Node"));
    expect(counted()).not.toContain("Pod");

    fireEvent.click(screen.getByRole("button", { name: "Workloads" }));
    await waitFor(() => expect(counted()).toEqual(expect.arrayContaining(["Pod", "Deployment", "StatefulSet"])));
    expect(await screen.findByTitle("42 objects")).toHaveTextContent("42");
    expect(screen.getAllByTitle("More than 999 objects").map((e) => e.textContent)).toEqual(["999+", "999+"]);
    // The entries keep their names.
    expect(screen.getByRole("button", { name: "Pods" })).toBeInTheDocument();
    // Custom resources are not counted while their group is open, only the one shown.
    fireEvent.click(screen.getByRole("button", { name: "Custom Resources" }));
    fireEvent.click(screen.getByRole("button", { name: "demo.sextant.dev" }));
    expect(screen.getByRole("button", { name: "Widget7" })).toBeInTheDocument();
    expect(counted().some((k) => k.startsWith("Widget"))).toBe(false);
    // One request per kind: a second look within a minute uses the cache.
    const asked = counted().length;
    fireEvent.click(screen.getByRole("button", { name: "Workloads" }));
    fireEvent.click(screen.getByRole("button", { name: "Workloads" }));
    expect(counted()).toHaveLength(asked);
  });
});

describe("the count budget", () => {
  it("asks at most COUNT_REQUESTS_PER_MINUTE counts a minute per cluster, but never holds back a table's check", () => {
    for (let i = 0; i < 30; i++) refreshCount("c1", { group: "demo.sextant.dev", version: "v1", kind: `Widget${i}` }, null);
    expect(counted()).toHaveLength(COUNT_REQUESTS_PER_MINUTE);
    refreshCount("c1", { group: "", version: "v1", kind: "Pod" }, ["a", "b"]);
    expect(counted()).toHaveLength(COUNT_REQUESTS_PER_MINUTE);
    refreshCount("c1", { group: "", version: "v1", kind: "Pod" }, null, true);
    expect(counted()).toHaveLength(COUNT_REQUESTS_PER_MINUTE + 1);
    // Another cluster has its own budget.
    refreshCount("c2", { group: "", version: "v1", kind: "Pod" }, null);
    expect(counted()).toHaveLength(COUNT_REQUESTS_PER_MINUTE + 2);
  });
});

describe.skipIf(!MEASURE)("scale measurements", () => {
  it("first paint of the sidebar with hundreds of custom kinds", async () => {
    for (const n of [150, 500]) {
      backend.restore();
      resetClusterKinds();
      const crds = Array.from({ length: n }, (_, i) => served(`g${i % 30}.load.sextant.dev`, `Load${i}`));
      backend = mockBackend({
        cluster_kinds: () => [served("", "Pod"), ...crds],
        watch_start: () => undefined,
        watch_stop: () => undefined,
      });
      const start = performance.now();
      const view = render(<Sidebar clusterId="c1" />);
      await screen.findByRole("button", { name: "Custom Resources" });
      const painted = performance.now() - start;
      const open = performance.now();
      fireEvent.click(screen.getByRole("button", { name: "Custom Resources" }));
      for (const group of screen.getAllByRole("button", { name: /load\.sextant\.dev$/ })) fireEvent.click(group);
      const expanded = performance.now() - open;
      report(`sidebar with ${n} custom kinds: first paint ${painted.toFixed(0)} ms, all groups expanded ${expanded.toFixed(0)} ms`);
      view.unmount();
    }
  }, 60_000);
});
