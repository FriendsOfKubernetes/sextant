import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, KubeObject, ObjectRef, ResourceKind, WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { i18n } from "../../i18n";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { resetClusterKinds } from "../../resources";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import "./index";
import { CONFIG_MAP, NAMESPACE_KINDS, NODE, POD, SERVICE } from "./kinds";
import { impactText } from "./RelatedTab";
import * as data from "./testData";
import { openWatchCount, resetSharedWatches, setWatchLinger } from "./watches";

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

// The cluster serves the built-in kinds, not the Gateway API.
const DISCOVERY = [
  ...NAMESPACE_KINDS.filter((k) => k.group !== "gateway.networking.k8s.io"),
  CONFIG_MAP,
  { group: "", version: "v1", kind: "Secret" },
].map((k) => served(k));

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetSharedWatches();
  setWatchLinger(0);
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [...DISCOVERY, served(NODE, false)]);
});

afterEach(() => {
  resetSharedWatches();
  setWatchLinger(null);
  wb.backend.restore();
  resetClusterKinds();
});

const inShop = (spec: WatchSpec) =>
  JSON.stringify(spec.namespaces) === JSON.stringify(["shop"]) && spec.fieldSelector === null && spec.labelSelector === null;

/** Answers every namespace list of "shop" with the fixture's objects (an empty list for the rest). */
async function listShop(objects: { kind: KindRef; items: KubeObject[] }[] = data.SHOP) {
  for (const kind of NAMESPACE_KINDS.filter((k) => k.group !== "gateway.networking.k8s.io")) {
    const id = await watchOf(wb, kind.kind, inShop);
    emitSnapshot(wb, id, objects.find((o) => o.kind.kind === kind.kind && o.kind.group === kind.group)?.items ?? []);
  }
}

async function openRelated(ref: ObjectRef, obj: KubeObject) {
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  fireEvent.click(screen.getByRole("tab", { name: "Related" }));
}

const configMap: KubeObject = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "web-config", namespace: "shop", uid: "cm-1" } };
const cmRef: ObjectRef = { kind: CONFIG_MAP, namespace: "shop", name: "web-config" };

describe("the Related tab", () => {
  it("says what breaks and lists what uses a ConfigMap", async () => {
    await openRelated(cmRef, configMap);
    await listShop();
    const impact = await screen.findByRole("list", { name: "If it is deleted" });
    await waitFor(() =>
      expect([...impact.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
        "2 pods mount it: restarted or new ones will fail to start.",
        "2 pods read environment variables from it: restarted or new ones will fail to start.",
        "1 workload names it in its pod template: its new pods will fail to start.",
      ]),
    );
    const mounted = screen.getByRole("region", { name: "Mounted by" });
    expect(within(mounted).getAllByRole("button", { name: /^Open / }).map((b) => b.textContent)).toEqual([
      "web",
      "web-7d9f8c6b5-a1",
      "web-7d9f8c6b5-b2",
    ]);
    expect(within(mounted).getByText("pod template")).toBeInTheDocument();
  });

  it("opens a related object's details and follows the relations hop by hop", async () => {
    await openRelated(cmRef, configMap);
    await listShop();
    const mounted = await screen.findByRole("region", { name: "Mounted by" });
    // The pods come with their own list: wait for them rather than for the region alone.
    fireEvent.click(await within(mounted).findByRole("button", { name: "Show the relations of Pod web-7d9f8c6b5-a1" }));
    const owner = await screen.findByRole("region", { name: "Owned by" });
    expect(await within(owner).findByRole("button", { name: "Open ReplicaSet web-7d9f8c6b5" })).toBeInTheDocument();
    // The ConfigMap it came from is not listed again under the pod.
    const nested = owner.parentElement!;
    expect(within(nested).queryByRole("button", { name: "Open ConfigMap web-config" })).toBeNull();

    fireEvent.click(within(mounted).getByRole("button", { name: "Open Pod web-7d9f8c6b5-b2" }));
    expect(useAppStore.getState().details).toEqual({ kind: POD, namespace: "shop", name: "web-7d9f8c6b5-b2" });
  });

  it("on a Service: routes to it, pods it selects, and what stops", async () => {
    await openRelated({ kind: SERVICE, namespace: "shop", name: "web" }, data.service);
    await listShop();
    await waitFor(() => expect(screen.getByText("2 pods stop getting traffic through it.")).toBeInTheDocument());
    expect(screen.getByText("1 route sends traffic to it: that traffic will fail.")).toBeInTheDocument();
    const selects = screen.getByRole("region", { name: "Selects" });
    expect(within(selects).getAllByRole("button", { name: /^Open Pod/ })).toHaveLength(2);
  });

  it("a cluster-scoped Node watches only its own pods", async () => {
    const node: KubeObject = { apiVersion: "v1", kind: "Node", metadata: { name: "node-1", uid: "n1" } };
    await openRelated({ kind: NODE, namespace: null, name: "node-1" }, node);
    const id = await watchOf(wb, "Pod", (s) => s.fieldSelector === "spec.nodeName=node-1");
    expect(wb.specs.get(id)?.namespaces).toBeNull();
    emitSnapshot(wb, id, [data.pods[0]!, data.jobPod]);
    expect(await screen.findByText("2 pods run on this node and will be removed.")).toBeInTheDocument();
    // No namespace lists for a Node.
    expect([...wb.specs.values()].some((s) => s.namespaces !== null)).toBe(false);
  });

  it("watches only served kinds of the namespace and lets go when the details close", async () => {
    await openRelated(cmRef, configMap);
    await listShop();
    const kinds = [...wb.specs.values()].filter(inShop).map((s) => s.kind.kind);
    expect(kinds).not.toContain("HTTPRoute");
    expect(kinds).toContain("Pod");
    expect(openWatchCount()).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    await waitFor(() => expect(openWatchCount()).toBe(0));
  });
});

describe("impact sentences", () => {
  it("join kinds with the language's list separator", () => {
    const text = impactText({ id: "cascade", count: 3, keys: [], kinds: ["Pod", "ReplicaSet", "Secret"] }, i18n.t);
    expect(text).toBe("Deleting it also deletes 3 objects it owns (Pod, ReplicaSet, Secret).");
  });
});

