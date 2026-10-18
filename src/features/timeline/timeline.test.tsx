import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, KubeObject, PartialHistory, ResourceKind, WatchSpec, WatchUpdate } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getDetailsSections } from "../../layout/details/registry";
import { getPages } from "../../layout/pages";
import { resetClusterKinds } from "../../resources";
import { resetClustersStore } from "../clusters/clustersStore";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore, selectNamespaces } from "../namespaces";
import { resetProblemSources } from "../problems/store";
import { NAMESPACE_KINDS } from "../resource-map/kinds";
import { resetSharedWatches, setWatchLinger } from "../resource-map/watches";
import { ChangesSection } from "./ChangesTab";
import "./index";
import { observe, resetRecorder, startRecorder } from "./recorder";
import { TIMELINE_PAGE_ID, TimelinePage } from "./TimelinePage";

const snap = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never[] });
const delta = (upserted: KubeObject[], deleted: string[] = []): WatchUpdate => ({ type: "delta", upserted: upserted as never[], deleted });


const NOW = Date.parse("2026-03-02T10:00:00Z");
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const served = (kind: KindRef): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced: true,
  verbs: ["list", "watch"],
  printerColumns: [],
});
const spec = (kind: KindRef): WatchSpec => ({ kind, namespaces: null, labelSelector: null, fieldSelector: null });

function deployment(rv: number, image: string, ns = "shop"): KubeObject {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: ns, uid: `d-${ns}`, resourceVersion: String(rv) },
    spec: { template: { spec: { containers: [{ name: "web", image }] } } },
  };
}

/** A pod of the Deployment crash-looping since two minutes after the change. */
const crashing: KubeObject = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "web-5d4f8b7c9-abcde", namespace: "shop", uid: "p1", creationTimestamp: "2026-03-02T10:00:30Z" },
  status: {
    phase: "Running",
    containerStatuses: [
      {
        name: "web",
        state: { waiting: { reason: "CrashLoopBackOff" } },
        lastState: { terminated: { reason: "Error", finishedAt: "2026-03-02T10:02:00Z" } },
      },
    ],
  },
};

const HISTORY: PartialHistory = {
  entries: [
    {
      source: "helmRevision",
      object: { kind: { group: "helm.sh", version: "v3", kind: "Release" }, namespace: "shop", name: "shop" },
      uid: null,
      time: "2026-02-28T10:00:00Z",
      manager: null,
      operation: null,
      subresource: null,
      owner: null,
      revision: 3,
      status: "deployed",
      changeCause: null,
    },
    {
      source: "fieldManager",
      object: { kind: { group: "", version: "v1", kind: "ConfigMap" }, namespace: "shop", name: "settings" },
      uid: "cm1",
      time: "2026-02-27T10:00:00Z",
      manager: "kubectl-client-side-apply",
      operation: "Update",
      subresource: null,
      owner: null,
      revision: null,
      status: null,
      changeCause: null,
    },
  ],
  truncated: false,
  reports: [],
};

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetNamespaceRestore();
  resetSharedWatches();
  resetProblemSources();
  setWatchLinger(0);
  resetRecorder(() => NOW);
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => NAMESPACE_KINDS.filter((k) => k.group !== "gateway.networking.k8s.io").map(served));
  wb.backend.on("timeline_managers", () => []);
  wb.backend.on("timeline_history", () => HISTORY);
  startRecorder();
  // Recorded before the page opens: a change of the image in two namespaces.
  for (const ns of ["shop", "blog"]) {
    observe("c1", spec(DEPLOYMENT), snap([deployment(1, "web:1", ns)]));
    observe("c1", spec(DEPLOYMENT), delta([deployment(2, "web:2", ns)], []));
  }
});

afterEach(() => {
  resetSharedWatches();
  resetProblemSources();
  setWatchLinger(null);
  resetClustersStore();
  resetRecorder();
  wb.backend.restore();
  resetClusterKinds();
});

describe("the Timeline page", () => {
  it("is a page of the Cluster section after the problems, and every object has a Changes tab", () => {
    expect(getPages("cluster").find((p) => p.id === TIMELINE_PAGE_ID)).toMatchObject({
      order: 15,
      labelKey: "timeline:sidebar",
      icon: "changeTimeline",
    });
    expect(getDetailsSections(DEPLOYMENT).some((s) => s.id === "timelineChanges" && s.placement === "tab")).toBe(true);
    expect(getDetailsSections({ group: "", version: "v1", kind: "Event" }).some((s) => s.id === "timelineChanges")).toBe(false);
  });

  it("lists recorded changes of all namespaces and opens no watch or history of its own", async () => {
    render(<TimelinePage clusterId="c1" />);
    const list = await screen.findByRole("list", { name: "Change timeline" });
    expect(within(list).getAllByText("spec.template.spec.containers[web].image: web:1 → web:2")).toHaveLength(2);
    expect(within(list).getByRole("button", { name: "Deployment shop/web" })).toBeInTheDocument();
    expect(screen.getByText(/Choose namespaces in the filter/)).toBeInTheDocument();
    expect(wb.backend.calls.some((c) => c.cmd === "timeline_history")).toBe(false);
    expect([...wb.specs.values()].some((s) => s.kind.kind === "ConfigMap" || s.kind.kind === "Secret")).toBe(false);
    fireEvent.click(within(list).getAllByRole("button", { name: "Deployment shop/web" })[0]!);
    expect(useAppStore.getState().details).toEqual({ kind: DEPLOYMENT, namespace: "shop", name: "web" });
  });

  it("with a namespace: the partial history, its watches, and the problems that followed a change", async () => {
    await act(() => selectNamespaces("c1", ["shop"]));
    render(<TimelinePage clusterId="c1" />);
    expect(await screen.findByText("Helm release shop, revision 3 (deployed)")).toBeInTheDocument();
    expect(screen.getByText("By kubectl apply")).toBeInTheDocument();
    expect(screen.getAllByText("Partial")).toHaveLength(2);
    const asked = wb.backend.calls.find((c) => c.cmd === "timeline_history")!.args;
    expect(asked).toMatchObject({ clusterId: "c1", namespaces: ["shop"], helm: true });
    expect((asked.kinds as KindRef[]).some((k) => k.kind === "Deployment")).toBe(true);
    // The other namespace's change is filtered out.
    expect(screen.getAllByText("spec.template.spec.containers[web].image: web:1 → web:2")).toHaveLength(1);
    // ConfigMaps and Secrets of the namespace are watched while the page is open.
    await watchOf(wb, "ConfigMap", (s) => JSON.stringify(s.namespaces) === '["shop"]');
    await watchOf(wb, "Secret", (s) => JSON.stringify(s.namespaces) === '["shop"]');

    // The pod problem source (shared with the problems screen) reports a crash loop two minutes later.
    const pods = await watchOf(wb, "Pod", (s) => s.namespaces === null);
    emitSnapshot(wb, pods, [crashing]);
    expect(await screen.findByText("CrashLoopBackOff on Pod web-5d4f8b7c9-abcde 2 min after this change")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Only changes before problems" }));
    await waitFor(() => expect(screen.queryByText("Helm release shop, revision 3 (deployed)")).toBeNull());
    expect(screen.getByText("spec.template.spec.containers[web].image: web:1 → web:2")).toBeInTheDocument();
  });

  it("keeps the timeline between restarts only when asked", async () => {
    wb.backend.on("timeline_save", () => undefined);
    render(<TimelinePage clusterId="c1" />);
    const keep = await screen.findByRole("checkbox", { name: "Keep between restarts" });
    expect(keep).not.toBeChecked();
    fireEvent.click(keep);
    await waitFor(() => expect(wb.backend.settings.timeline.persist).toBe(true));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "timeline_save" && typeof c.args.text === "string")).toBe(true));
  });
});

describe("the Changes tab", () => {
  it("shows the object's recorded changes and what the cluster keeps", async () => {
    wb.backend.on("timeline_object_history", () => ({
      entries: [
        {
          source: "fieldManager",
          object: { kind: DEPLOYMENT, namespace: "shop", name: "web" },
          uid: "d-shop",
          time: "2026-02-01T00:00:00Z",
          manager: "helm",
          operation: "Update",
          subresource: null,
          owner: null,
          revision: null,
          status: null,
          changeCause: null,
        },
        {
          source: "revision",
          object: { kind: { group: "apps", version: "v1", kind: "ReplicaSet" }, namespace: "shop", name: "web-5d4f8b7c9" },
          uid: null,
          time: "2026-02-01T00:00:01Z",
          manager: null,
          operation: null,
          subresource: null,
          owner: { kind: DEPLOYMENT, namespace: "shop", name: "web" },
          revision: 4,
          status: null,
          changeCause: "bump",
        },
      ],
      truncated: false,
      reports: [],
    }));
    render(<ChangesSection clusterId="c1" objectRef={{ kind: DEPLOYMENT, namespace: "shop", name: "web" }} obj={null} />);
    expect(await screen.findByText("Last change by this field manager")).toBeInTheDocument();
    expect(screen.getByText("By Helm")).toBeInTheDocument();
    expect(screen.getByText("Revision 4: bump")).toBeInTheDocument();
    // Only this object's recorded change, not the other namespace's.
    expect(screen.getAllByText("spec.template.spec.containers[web].image: web:1 → web:2")).toHaveLength(1);
    expect(wb.backend.calls.find((c) => c.cmd === "timeline_object_history")!.args).toMatchObject({
      clusterId: "c1",
      object: { kind: DEPLOYMENT, namespace: "shop", name: "web" },
    });
  });
});
