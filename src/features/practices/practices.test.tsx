import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { messageText } from "../notifications/engine";
import "../problems";
import { ProblemsPage } from "../problems/ProblemsPage";
import { resetProblemSources } from "../problems/store";
import { resetProblemsUi } from "../problems/ui";
import { resetSharedWatches } from "../resource-map/watches";
import "./index";
import { PracticesPage } from "./PracticesPage";

let wb: WatchBackend;
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetProblemsUi();
  resetSettingsCache();
  resetNamespaceRestore();
  resetSharedWatches();
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => []);
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
  resetSharedWatches();
});

// ---------- Fixtures ----------

const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };

function deployment(name: string, replicas: number, container: Record<string, unknown>, namespace = "shop"): KubeObject {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, uid: `d-${name}` },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: "app", ...container }] } },
    },
  };
}

const probes = { readinessProbe: { tcpSocket: { port: 8080 } }, livenessProbe: { tcpSocket: { port: 8080 } } };
const resources = { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "256Mi" } };
/** One replica, :latest, no probes, no requests. */
const web = deployment("web", 1, { image: "nginx:latest", ports: [{ containerPort: 8080 }] });
/** Follows every check (with its PDB). */
const api = deployment("api", 3, { image: "api:2.1.0", ports: [{ containerPort: 8080 }], resources, ...probes });
const apiPdb: KubeObject = {
  apiVersion: "policy/v1",
  kind: "PodDisruptionBudget",
  metadata: { name: "api", namespace: "shop", uid: "pdb-api" },
  spec: { maxUnavailable: 1, selector: { matchLabels: { app: "api" } } },
};
const node = (name: string): KubeObject => ({ apiVersion: "v1", kind: "Node", metadata: { name, uid: `n-${name}` }, spec: {} });

const inShop = (kind: string) => watchOf(wb, kind, (s) => JSON.stringify(s.namespaces) === JSON.stringify(["shop"]) && s.labelSelector === null);

async function renderPage(): Promise<void> {
  useAppStore.getState().setNamespaces("c1", ["shop"]);
  render(<PracticesPage clusterId="c1" />);
  emitSnapshot(wb, await inShop("Deployment"), [web, api]);
  for (const kind of ["StatefulSet", "DaemonSet", "CronJob", "Job", "HorizontalPodAutoscaler", "LimitRange", "Pod"]) {
    emitSnapshot(wb, await inShop(kind), []);
  }
  emitSnapshot(wb, await inShop("PodDisruptionBudget"), [apiPdb]);
  emitSnapshot(wb, await watchOf(wb, "Node", (s) => s.namespaces === null), [node("n1"), node("n2")]);
}

describe("the Best practices page", () => {
  it("asks for namespaces with All namespaces, and watches no workloads", async () => {
    render(<PracticesPage clusterId="c1" />);
    await waitFor(() => expect(screen.getByText("Choose namespaces")).toBeInTheDocument());
    expect([...wb.specs.values()].filter((s) => s.kind.kind === "Deployment")).toEqual([]);
  });

  it("lists the workloads with findings, worst first, with why and a fix to copy", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderPage();
    const ns = within(await screen.findByRole("region", { name: "shop" }));
    await waitFor(() => expect(ns.getAllByRole("button", { name: /^Open Deployment/ }).map((b) => b.textContent)).toEqual(["Deployment: web"]));
    expect(ns.getAllByText("4 medium-severity findings").length).toBeGreaterThan(0);

    fireEvent.click(ns.getByRole("button", { name: "Show the findings of web" }));
    const image = document.querySelector<HTMLElement>("[data-check='mutableImage']")!;
    expect(within(image).getByText("spec.template.spec.containers[0].image")).toBeInTheDocument();
    expect(within(image).getByText("Image without a pinned version")).toBeInTheDocument();
    expect(within(image).getByText(/can change under the same name/)).toBeInTheDocument();
    fireEvent.click(within(image).getByRole("button", { name: "Copy the fix" }));
    await waitFor(() => expect(within(image).getByText("Copied")).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith("spec:\n  template:\n    spec:\n      containers:\n        - name: app\n          image: \"nginx:<version>\"\n");
    expect(document.querySelector("[data-check='singleReplica']")).not.toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("filters by area and severity", async () => {
    await renderPage();
    const ns = within(await screen.findByRole("region", { name: "shop" }));
    await waitFor(() => expect(ns.getAllByRole("button", { name: /^Open Deployment/ })).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "high" } });
    expect(ns.queryAllByRole("button", { name: /^Open Deployment/ })).toHaveLength(0);
    expect(ns.getByText("No findings match the filters in this namespace.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "any" } });
    fireEvent.change(screen.getByLabelText("Area"), { target: { value: "efficiency" } });
    fireEvent.click(ns.getByRole("button", { name: "Show the findings of web" }));
    expect(document.querySelector("[data-check='noRequests']")).not.toBeNull();
    expect(document.querySelector("[data-check='mutableImage']")).toBeNull();
  });

  it("saves the turned-off checks and the excluded namespaces, and follows them", async () => {
    await renderPage();
    const ns = within(await screen.findByRole("region", { name: "shop" }));
    await waitFor(() => expect(ns.getAllByRole("button", { name: /^Open Deployment/ })).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Settings…" }));
    const dialog = within(await screen.findByRole("dialog"));
    for (const title of ["Image without a pinned version", "Single replica", "No readiness probe", "No liveness probe", "No resource requests", "No memory limit"]) {
      fireEvent.click(dialog.getByRole("checkbox", { name: title }));
    }
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stored.practices.disabledChecks).toHaveLength(6));
    await waitFor(() => expect(ns.getByText("No findings in this namespace.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Settings…" }));
    const again = within(await screen.findByRole("dialog"));
    fireEvent.change(again.getByRole("textbox", { name: /Namespaces never checked/ }), { target: { value: "kube-system\nshop" } });
    fireEvent.click(again.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stored.practices.excludedNamespaces).toEqual(["kube-system", "shop"]));
    await waitFor(() => expect(screen.getByText("Not checked, excluded in the settings: shop")).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "shop" })).toBeNull();
    expect(screen.queryByText("Checking workloads…")).toBeNull();
  });
});

// ---------- Details ----------

describe("the Best practices section of a workload", () => {
  it("shows the findings against its namespace's budgets and where its replicas run", async () => {
    const pods = ["a", "b"].map((s): KubeObject => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `api-7d9c6b8f5d-${s}`,
        namespace: "shop",
        uid: `p-${s}`,
        labels: { app: "api", "pod-template-hash": "7d9c6b8f5d" },
        ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "api-7d9c6b8f5d", uid: "rs", controller: true }],
      },
      spec: { nodeName: "n1", containers: [{ name: "app" }] },
      status: { phase: "Running" },
    }));
    const blocking: KubeObject = { ...apiPdb, spec: { minAvailable: 3, selector: { matchLabels: { app: "api" } } } };
    const ref: ObjectRef = { kind: DEPLOYMENT, namespace: "shop", name: "api" };
    useAppStore.getState().openDetails(ref);
    render(<DetailsPanel clusterId="c1" objectRef={ref} />);
    emitSnapshot(wb, await watchOf(wb, "Deployment", (s) => s.fieldSelector === "metadata.name=api"), [api]);
    emitSnapshot(wb, await inShop("HorizontalPodAutoscaler"), []);
    emitSnapshot(wb, await inShop("LimitRange"), []);
    emitSnapshot(wb, await inShop("PodDisruptionBudget"), [blocking]);
    emitSnapshot(wb, await watchOf(wb, "Pod", (s) => s.labelSelector === "app=api"), pods);
    emitSnapshot(wb, await watchOf(wb, "Node", (s) => s.namespaces === null), [node("n1"), node("n2")]);
    const section = () => document.querySelector<HTMLElement>("[data-section='practices']")!;
    await waitFor(() => expect(section().querySelector("[data-check='pdbBlocksDisruption']")).not.toBeNull());
    const pdb = within(section().querySelector<HTMLElement>("[data-check='pdbBlocksDisruption']")!);
    expect(pdb.getByText("In PodDisruptionBudget api")).toBeInTheDocument();
    expect(pdb.getByText("spec.minAvailable")).toBeInTheDocument();
    expect(pdb.getByText(/PodDisruptionBudget api lets no pod be evicted \(expected pods: 3\)/)).toBeInTheDocument();
    const node1 = within(section().querySelector<HTMLElement>("[data-check='sameNode']")!);
    expect(node1.getByText(/The running replicas \(2\) are all on node n1/)).toBeInTheDocument();
  });
});

// ---------- Problems ----------

describe("the problems screen", () => {
  it("lists best-practice findings as an opt-in category from the shared watches", async () => {
    render(<ProblemsPage clusterId="c1" />);
    const checkbox = await screen.findByRole("checkbox", { name: "Best-practice findings" });
    expect(checkbox).not.toBeChecked();
    // Off: nothing of its own is watched.
    expect([...wb.specs.values()].some((s) => s.kind.kind === "PodDisruptionBudget")).toBe(false);

    fireEvent.click(checkbox);
    await waitFor(() => expect(stored.notifications.enabledCategories).toEqual(["practices"]));
    const cluster = (kind: string) => watchOf(wb, kind, (s) => s.namespaces === null);
    emitSnapshot(wb, await cluster("Deployment"), [web, api, deployment("dns", 1, { image: "coredns:latest" }, "kube-system")]);
    for (const kind of ["StatefulSet", "DaemonSet", "Job", "CronJob", "HorizontalPodAutoscaler", "LimitRange", "Pod"]) {
      emitSnapshot(wb, await cluster(kind), []);
    }
    emitSnapshot(wb, await cluster("PodDisruptionBudget"), [apiPdb]);
    emitSnapshot(wb, await cluster("Node"), [node("n1")]);
    const group = within(await screen.findByRole("region", { name: "Best practices" }));
    expect(group.getByText("MutableImageTag")).toBeInTheDocument();
    expect(group.getByText("SingleReplica")).toBeInTheDocument();
    expect(group.getByText("Image without a pinned version")).toBeInTheDocument();
    // kube-system is excluded by default.
    expect(group.queryByText("dns")).toBeNull();
    expect(group.queryByText("api")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Best-practice findings" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Best practices" })).toBeNull());
  });

  it("writes a problem's message in the current language from the check", () => {
    expect(messageText({ messageKey: "messages.practice", messageParams: { check: "noPdb" } })).toBe("No PodDisruptionBudget");
  });
});

