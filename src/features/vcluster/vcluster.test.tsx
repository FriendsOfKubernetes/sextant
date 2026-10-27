import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type ClusterInfo, type KubeObject, type ObjectRef, type VclusterLink } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { getPage } from "../../layout/pages";
import { resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import { useClustersStore } from "../clusters/clustersStore";
import { sourceKindLabelKey, isRemovableSource, removeConfirmKey } from "../clusters/sources";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resetSharedWatches } from "../resource-map/watches";
import fixtures from "./fixtures/objects.json";
import "./index";
import { followLinks, useLinksStore } from "./links";
import {
  CONTROL_PLANE_SELECTOR,
  contextName,
  instanceOf,
  instancesOf,
  podsOf,
  podSummary,
  releaseOf,
  stateOf,
  syncedOf,
} from "./model";
import { VCLUSTER_PAGE_ID } from "./VclusterPage";

const f = fixtures as unknown as Record<string, KubeObject>;

describe("the model", () => {
  it("finds control planes by app=vcluster and release, never etcd or a synced copy", () => {
    expect(releaseOf(f.devStatefulSet)).toBe("dev");
    expect(releaseOf(f.qaDeploymentPaused)).toBe("qa");
    expect(releaseOf(f.devEtcd)).toBeUndefined();
    const synced = copy(f.devStatefulSet!);
    synced.metadata!.labels = { ...(synced.metadata!.labels as Record<string, string>), "vcluster.loft.sh/managed-by": "other" };
    expect(releaseOf(synced)).toBeUndefined();
    expect(instancesOf([f.qaDeploymentPaused!, f.devEtcd!, f.devStatefulSet!]).map((i) => `${i.namespace}/${i.name}`)).toEqual([
      "team-a/dev",
      "team-b/qa",
    ]);
  });

  it("reads the version from the syncer's image and the state as the CLI does", () => {
    const dev = instanceOf(f.devStatefulSet!)!;
    expect(dev).toMatchObject({ kind: "StatefulSet", version: "0.29.0", replicas: 1, readyReplicas: 1, paused: false });
    expect(stateOf(dev)).toBe("ready");
    expect(stateOf(instanceOf(f.qaDeploymentPaused!)!)).toBe("paused");
    expect(stateOf({ ...dev, replicas: 0 })).toBe("scaledDown");
    expect(stateOf({ ...dev, replicas: 3, readyReplicas: 1 })).toBe("degraded");
    expect(stateOf({ ...dev, readyReplicas: 0 })).toBe("notReady");
    const sleeping = copy(f.devStatefulSet!);
    sleeping.metadata!.labels = { ...(sleeping.metadata!.labels as Record<string, string>), "loft.sh/sleep-mode": "true" };
    expect(stateOf(instanceOf(sleeping)!)).toBe("paused");
  });

  it("counts only the control-plane pods, not synced pods with the same labels", () => {
    const dev = instanceOf(f.devStatefulSet!)!;
    const pods = podsOf(dev, [f.syncedPod!, f.devPod!]);
    expect(pods.map((p) => p.metadata?.name)).toEqual(["dev-0"]);
    expect(podSummary(pods)).toEqual({ total: 1, ready: 1, phases: {} });
  });

  it("tells what a synced object stands for in the virtual cluster", () => {
    expect(syncedOf(f.syncedPod!, "dev")).toEqual({
      kind: "Pod",
      hostName: "nginx-x-default-x-dev",
      virtualName: "nginx",
      virtualNamespace: "default",
    });
    expect(syncedOf(f.syncedPod!, "other")).toBeUndefined();
    expect(syncedOf(f.devPod!, "dev")).toBeUndefined();
  });

  it("names the context as vcluster connect does", () => {
    expect(contextName("dev", "team-a", "kind-host")).toBe("vcluster_dev_team-a_kind-host");
  });

  it("the vcluster source is Sextant's own and removable", () => {
    expect(sourceKindLabelKey("vcluster")).toBe("vcluster:source.kind");
    expect(isRemovableSource("vcluster")).toBe(true);
    expect(removeConfirmKey("vcluster")).toBe("vcluster:source.confirmRemove");
  });
});

const HOST: ClusterInfo = {
  id: "c1",
  context: "kind-host",
  clusterName: "kind-host",
  server: "https://127.0.0.1:6443",
  user: "admin",
  namespace: null,
  sourceId: "src",
};
const LINK: VclusterLink = {
  clusterId: "v1",
  context: "vcluster_dev_team-a_kind-host",
  hostClusterId: "c1",
  namespace: "team-a",
  name: "dev",
  localPort: 40123,
  forwardId: "pf-7",
};
const VIRTUAL: ClusterInfo = { ...HOST, id: "v1", context: LINK.context, server: "https://127.0.0.1:40123", sourceId: "src-vc" };

let wb: WatchBackend;
let stored: AppSettings;
let listed: ClusterInfo[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  useLinksStore.setState({ links: [] });
  stored = defaultAppSettings();
  listed = [HOST];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => []);
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
  wb.backend.on("clusters_list", () => listed);
  wb.backend.on("kubeconfig_sources", () => []);
  wb.backend.on("vcluster_links", () => []);
  useClustersStore.setState({ clusters: [HOST] });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetSharedWatches();
  resetSettingsCache();
});

async function showPage(): Promise<HTMLElement> {
  const Page = getPage(VCLUSTER_PAGE_ID)!.Component;
  const { container } = render(<Page clusterId="c1" />);
  const control = (s: { labelSelector: string | null }) => s.labelSelector === CONTROL_PLANE_SELECTOR;
  emitSnapshot(wb, await watchOf(wb, "StatefulSet", control), [f.devStatefulSet!, f.devEtcd!]);
  emitSnapshot(wb, await watchOf(wb, "Deployment", control), [f.qaDeploymentPaused!]);
  emitSnapshot(wb, await watchOf(wb, "Pod", control), [f.devPod!, f.syncedPod!]);
  emitSnapshot(wb, await watchOf(wb, "Service", control), [f.devService!]);
  emitSnapshot(wb, await watchOf(wb, "Secret"), [f.devSecret!]);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 virtual clusters"));
  return container;
}

describe("the Virtual clusters page", () => {
  it("is in the Cluster section", () => {
    expect(getPage(VCLUSTER_PAGE_ID)).toMatchObject({ section: "cluster", labelKey: "vcluster:sidebar" });
  });

  it("lists the instances with state, pods, Service and Secret; watches by the label selector, Secrets metadata only", async () => {
    const container = await showPage();
    const rows = screen.getAllByRole("row");
    const dev = within(rows.find((r) => r.textContent?.includes("team-a"))!);
    expect(dev.getByText("Ready")).toHaveClass("rt-status--success");
    expect(dev.getByText("1/1 ready")).toBeInTheDocument();
    expect(dev.getAllByText("Found")).toHaveLength(2);
    expect(dev.getByText("0.29.0")).toBeInTheDocument();
    const qa = within(rows.find((r) => r.textContent?.includes("team-b"))!);
    expect(qa.getByText("Paused")).toBeInTheDocument();
    expect(qa.getAllByText("Missing")).toHaveLength(2);

    const specs = [...wb.specs.values()];
    const secrets = specs.filter((s) => s.kind.kind === "Secret");
    expect(secrets.every((s) => s.metadataOnly === true)).toBe(true);
    expect(secrets.at(-1)!.namespaces).toEqual(["team-a", "team-b"]);
    expect(specs.filter((s) => s.kind.kind === "StatefulSet").every((s) => s.labelSelector === CONTROL_PLANE_SELECTOR)).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("connects only after the confirmation, then offers Open and Disconnect", async () => {
    wb.backend.on("vcluster_connect", () => {
      listed = [HOST, VIRTUAL];
      return LINK;
    });
    wb.backend.on("vcluster_disconnect", () => {
      listed = [HOST];
      return null;
    });
    const container = await showPage();
    fireEvent.click(screen.getByRole("button", { name: "Connect dev" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/reads the Secret vc-dev in team-a/)).toBeInTheDocument();
    expect(within(dialog).getByText(/vcluster_dev_team-a_kind-host/)).toBeInTheDocument();
    expect(wb.backend.calls.some((c) => c.cmd === "vcluster_connect")).toBe(false);
    expect(await axeViolations(container.ownerDocument)).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText("Forwarded on port 40123")).toBeInTheDocument());
    expect(wb.backend.calls.find((c) => c.cmd === "vcluster_connect")!.args).toEqual({
      hostClusterId: "c1",
      namespace: "team-a",
      name: "dev",
    });
    const open = await screen.findByRole("button", { name: `Open ${LINK.context}` });
    await waitFor(() => expect(open).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Disconnect dev" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect dev" })).toBeInTheDocument());
    expect(wb.backend.calls.find((c) => c.cmd === "vcluster_disconnect")!.args).toEqual({ clusterId: "v1" });
  });

  it("shows the backend's error when connecting fails", async () => {
    wb.backend.on("vcluster_connect", () => {
      throw { code: "forbidden", message: "you may not read the Secret team-a/vc-dev, which holds the vcluster's kubeconfig" };
    });
    await showPage();
    fireEvent.click(screen.getByRole("button", { name: "Connect dev" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("you may not read the Secret team-a/vc-dev");
  });
});

describe("following the backend's links", () => {
  it("takes the list from the event and reads the cluster list again", async () => {
    wb.backend.on("vcluster_links", () => [LINK]);
    const stop = followLinks();
    await waitFor(() => expect(useLinksStore.getState().links).toEqual([LINK]));
    const before = wb.backend.calls.filter((c) => c.cmd === "clusters_list").length;
    act(() => wb.backend.emit("vcluster-links", []));
    expect(useLinksStore.getState().links).toEqual([]);
    await waitFor(() => expect(wb.backend.calls.filter((c) => c.cmd === "clusters_list").length).toBeGreaterThan(before));
    stop();
  });
});

function refTo(obj: KubeObject): ObjectRef {
  return { kind: { group: "apps", version: "v1", kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

describe("the details of a control plane", () => {
  it("shows the instance, its Service and Secret by name, and the synced objects with their virtual names", async () => {
    const ref = refTo(f.devStatefulSet!);
    useAppStore.getState().openDetails(ref);
    const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
    emitSnapshot(wb, await watchOf(wb, "StatefulSet", (s) => s.fieldSelector === "metadata.name=dev"), [f.devStatefulSet!]);
    await waitFor(() => expect(document.querySelector("[data-section='vcluster']")).not.toBeNull());
    const view = within(document.querySelector<HTMLElement>("[data-section='vcluster']")!);
    emitSnapshot(wb, await watchOf(wb, "Service", (s) => s.fieldSelector === "metadata.name=dev"), [f.devService!]);
    const secretWatch = await watchOf(wb, "Secret", (s) => s.fieldSelector === "metadata.name=vc-dev");
    expect(wb.specs.get(secretWatch)!.metadataOnly).toBe(true);
    emitSnapshot(wb, secretWatch, []);
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.labelSelector === "app=vcluster,release=dev"), [f.devPod!]);
    const synced = await watchOf(wb, "Pod", (s) => s.labelSelector === "vcluster.loft.sh/managed-by=dev");
    expect(wb.specs.get(synced)).toMatchObject({ namespaces: ["team-a"], metadataOnly: true });
    emitSnapshot(wb, synced, [f.syncedPod!]);

    await waitFor(() => expect(view.getByText("Pod (1)")).toBeInTheDocument());
    expect(view.getByText("nginx")).toBeInTheDocument();
    await waitFor(() => expect(view.getByText("Missing")).toBeInTheDocument());
    expect(view.getByText("Found")).toBeInTheDocument();
    expect(view.getByText("1/1 ready")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Connect dev" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("is not there on an ordinary StatefulSet", async () => {
    const plain = copy(f.devEtcd!);
    const ref = refTo(plain);
    useAppStore.getState().openDetails(ref);
    render(<DetailsPanel clusterId="c1" objectRef={ref} />);
    emitSnapshot(wb, await watchOf(wb, "StatefulSet", (s) => s.fieldSelector === "metadata.name=dev-etcd"), [plain]);
    await waitFor(() => expect(screen.getAllByText("dev-etcd").length).toBeGreaterThan(0));
    expect(document.querySelector("[data-section='vcluster']")?.textContent ?? "").toBe("");
  });
});
