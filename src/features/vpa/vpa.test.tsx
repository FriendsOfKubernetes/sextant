import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind, type WatchState } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { categoryOf, detect, OPT_IN_CATEGORIES, PROBLEM_CATEGORIES } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { judgedByRules, sourcesFor } from "../problems/sources";
import { resetSharedWatches } from "../resource-map/watches";
import { resetAutoscalingTaps } from "../autoscaling/hooks";
import fixtures from "./fixtures/objects.json";
import "./index";
import { containerChange, milliOf, proportionalLimit, templateChanges, unitsOf } from "./admission";
import { componentOf, groupComponents, missingMeaning } from "./components";
import { conflictsOf, hpaResources, valueOverlapsOf } from "./conflicts";
import { containerPoliciesOf, controls, isProblem, recommendationsOf, statusOf, targetOf, updateModeOf, VPA, VPA_CHECKPOINT } from "./model";
import { CONFLICT_GRACE_MS, hpasIn, MAX_HPA_NAMESPACES, namespacesToCheck, NO_PODS_GRACE_MS, toProblems, UNSUPPORTED_GRACE_MS } from "./provider";

const recreate = fixtures.recreate as KubeObject;
const hamster = fixtures.hamster as KubeObject;
const hpa = fixtures.hpa as KubeObject;
const off = fixtures.off as KubeObject;
const unsupported = fixtures.unsupported as KubeObject;
const noPods = fixtures.noPods as KubeObject;
const checkpoint = fixtures.checkpoint as KubeObject;
const recommender = fixtures.recommender as KubeObject;
const chartUpdater = fixtures.chartUpdater as KubeObject;

const MI = 2 ** 20;
/** `noPods` pointed at a Deployment in mode Recreate. */
const noPodsDeployment = (() => {
  const vpa = copy(noPods);
  (vpa.spec as Record<string, unknown>).targetRef = { apiVersion: "apps/v1", kind: "Deployment", name: "report" };
  (vpa.spec as Record<string, unknown>).updatePolicy = { updateMode: "Recreate" };
  return vpa;
})();
/** `noPodsDeployment` that still holds the recommendation it had before its pods went away. */
const noPodsRecommended = (() => {
  const vpa = copy(noPodsDeployment);
  const conditions = (vpa.status as { conditions: { type: string; status: string }[] }).conditions;
  conditions.find((c) => c.type === "RecommendationProvided")!.status = "True";
  (vpa.status as Record<string, unknown>).recommendation = copy((recreate.status as Record<string, unknown>).recommendation);
  return vpa;
})();
const ready = (items: KubeObject[]): WatchState => ({ status: "ready", items: new Map(items.map((o) => [o.metadata?.uid ?? "", o])) });

describe("the model", () => {
  it("reads the target and the mode, Recreate when unset", () => {
    expect(targetOf(recreate)).toEqual({ apiVersion: "apps/v1", kind: "Deployment", name: "hamster", group: "apps" });
    expect(updateModeOf(recreate)).toBe("Recreate");
    expect(updateModeOf(off)).toBe("Off");
    expect(updateModeOf(unsupported)).toBe("Auto");
  });

  it("reads the state from the conditions in the recommender's order", () => {
    expect(statusOf(recreate)).toMatchObject({ state: "ready", reason: "provided" });
    expect(statusOf(off)).toMatchObject({ state: "ready", reason: "lowConfidence" });
    // ConfigUnsupported also says NoPodsMatched: the configuration is told first.
    expect(statusOf(unsupported)).toMatchObject({ state: "failed", reason: "configUnsupported", message: expect.stringContaining("parent controller") });
    expect(statusOf(noPods)).toMatchObject({ state: "failed", reason: "noPodsMatched" });
    const none = copy(recreate);
    delete none.status;
    expect(statusOf(none)).toMatchObject({ state: "progressing", reason: "noStatus" });
    expect(isProblem(unsupported)).toBe(true);
    expect(isProblem(recreate)).toBe(false);
  });

  it("a kept recommendation outranks NoPodsMatched: ready, with a note, and no problem", () => {
    expect(statusOf(noPodsRecommended)).toMatchObject({ state: "ready", reason: "provided", noPodsNow: true });
    expect(statusOf(noPodsDeployment)).toMatchObject({ state: "failed", reason: "noPodsMatched" });
    expect(statusOf(noPodsDeployment).noPodsNow).toBeUndefined();
    expect(isProblem(noPodsRecommended)).toBe(false);
    expect(isProblem(noPodsDeployment)).toBe(true);
    // A CronJob's pods come and go; mode Off changes nothing.
    expect(isProblem(noPods)).toBe(false);
    expect(isProblem({ ...noPodsDeployment, spec: { ...(noPodsDeployment.spec as object), updatePolicy: { updateMode: "Off" } } })).toBe(false);
  });

  it("finds a container's policy by name, else the wildcard, with the API's defaults", () => {
    const policies = containerPoliciesOf(recreate);
    expect(controls(policies, "anything", "cpu")).toBe(true);
    const memoryOnly = containerPoliciesOf({ ...recreate, spec: { resourcePolicy: { containerPolicies: [{ containerName: "app", controlledResources: ["memory"] }, { containerName: "*", mode: "Off" }] } } });
    expect(controls(memoryOnly, "app", "cpu")).toBe(false);
    expect(controls(memoryOnly, "app", "memory")).toBe(true);
    expect(controls(memoryOnly, "sidecar", "memory")).toBe(false);
    expect(controls([], "app", "cpu")).toBe(true);
    expect(recommendationsOf(recreate)[0]?.target).toEqual({ cpu: "587m", memory: "262144k" });
  });
});

describe("what the admission controller would set", () => {
  it("rounds quantities as Kubernetes does", () => {
    expect(milliOf("587m")).toBe(587);
    expect(milliOf("1")).toBe(1000);
    expect(milliOf("0.1005")).toBe(101);
    expect(unitsOf("262144k")).toBe(262_144_000);
    expect(unitsOf("50Mi")).toBe(50 * MI);
  });

  it("scales a limit as getProportionalResourceLimit does", () => {
    // No limit stays no limit; no request or an equal one makes the limit the new request.
    expect(proportionalLimit("cpu", undefined, 100, 587)).toBeUndefined();
    expect(proportionalLimit("cpu", 200, undefined, 587)).toBe(587);
    expect(proportionalLimit("cpu", 200, 200, 587)).toBe(587);
    // 200m × 587m ÷ 100m; the remainder is dropped (noRounding).
    expect(proportionalLimit("cpu", 200, 100, 587)).toBe(1174);
    expect(proportionalLimit("cpu", 250, 300, 587)).toBe(489);
    // Bytes, beyond what a double multiplies exactly.
    expect(proportionalLimit("memory", 64 * 2 ** 30, 32 * 2 ** 30, 48 * 2 ** 30 + 1)).toBe(96 * 2 ** 30 + 2);
    expect(proportionalLimit("memory", 100 * MI, 50 * MI, 0)).toBeUndefined();
  });

  it("sets the target as the request and keeps the limit's ratio (RequestsAndLimits)", () => {
    const [c] = templateChanges(hamster, containerPoliciesOf(recreate), recommendationsOf(recreate));
    expect(c).toMatchObject({ container: "hamster", state: "scaled", controlledValues: "RequestsAndLimits" });
    expect(c!.resources).toEqual([
      expect.objectContaining({ resource: "cpu", request: 100, limit: 200, target: 587, newRequest: 587, newLimit: 1174 }),
      expect.objectContaining({ resource: "memory", request: 50 * MI, limit: 100 * MI, target: 262_144_000, newRequest: 262_144_000, newLimit: 524_288_000 }),
    ]);
  });

  it("keeps the target within minAllowed and maxAllowed, and at most the limit with RequestsOnly", () => {
    const low = copy(recreate);
    (low.status as { recommendation: { containerRecommendations: { target: Record<string, string> }[] } }).recommendation.containerRecommendations[0]!.target = { cpu: "20m", memory: "2Gi" };
    const [c] = templateChanges(hamster, containerPoliciesOf(low), recommendationsOf(low));
    expect(c!.resources[0]).toMatchObject({ newRequest: 100, capped: "minAllowed" });
    expect(c!.resources[1]).toMatchObject({ newRequest: 500 * MI, capped: "maxAllowed" });
    const [o] = templateChanges(hamster, containerPoliciesOf(off), recommendationsOf(off));
    expect(o!.resources[0]).toMatchObject({ resource: "cpu", newRequest: 200, capped: "limit" });
    expect(o!.resources[0]!.newLimit).toBeUndefined();
    expect(o!.resources[1]).toMatchObject({ resource: "memory", newRequest: 100 * MI, capped: "limit" });
  });

  it("leaves a container whose policy is Off, and one without a recommendation, as they are", () => {
    const container = { name: "sidecar", resources: { requests: { cpu: "10m" } } };
    expect(containerChange(container, [{ containerName: "sidecar", mode: "Off", minAllowed: {}, maxAllowed: {}, controlledResources: ["cpu"], controlledValues: "RequestsAndLimits" }], undefined).state).toBe("off");
    const none = containerChange(container, [], undefined);
    expect(none.state).toBe("noRecommendation");
    expect(none.resources.every((r) => r.newRequest === undefined)).toBe(true);
  });
});

describe("conflicts with an HPA", () => {
  it("reads the HPA's CPU and memory metrics; no metrics is the API's default CPU", () => {
    expect(hpaResources(hpa)).toEqual([{ resource: "cpu" }]);
    expect(hpaResources({ ...hpa, spec: { ...(hpa.spec as object), metrics: [] } })).toEqual([{ resource: "cpu" }]);
    const custom = { ...hpa, spec: { ...(hpa.spec as object), metrics: [{ type: "Pods", pods: { metric: { name: "rps" } } }] } };
    expect(hpaResources(custom)).toEqual([]);
  });

  it("only a Utilization target fights; an AverageValue target is a note, not a problem", () => {
    const averageValue = {
      ...hpa,
      spec: { ...(hpa.spec as object), metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "AverageValue", averageValue: "500m" } } }] },
    };
    expect(hpaResources(averageValue)).toEqual([{ resource: "cpu", byValue: true }]);
    expect(conflictsOf(recreate, [averageValue])).toEqual([]);
    expect(valueOverlapsOf(recreate, [averageValue])).toEqual([{ hpa: "hamster", resources: ["cpu"] }]);
    expect(valueOverlapsOf(recreate, [hpa])).toEqual([]);
    expect(toProblems([recreate], () => [averageValue], new Map(), Date.now())).toEqual([]);
    // A metric whose target has no type is read by the field it sets.
    const untyped = { ...hpa, spec: { ...(hpa.spec as object), metrics: [{ type: "Resource", resource: { name: "memory", target: { averageValue: "1Gi" } } }] } };
    expect(hpaResources(untyped)).toEqual([{ resource: "memory", byValue: true }]);
  });

  it("a VPA that changes running pods fights an HPA on the same resource of the same target", () => {
    expect(conflictsOf(recreate, [hpa])).toEqual([{ hpa: "hamster", resources: ["cpu"] }]);
    // Off and Initial change no running pod.
    expect(conflictsOf(off, [hpa])).toEqual([]);
    // Another target, another namespace.
    expect(conflictsOf(recreate, [{ ...hpa, spec: { ...(hpa.spec as object), scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "other" } } }])).toEqual([]);
    expect(conflictsOf(recreate, [{ ...hpa, metadata: { ...hpa.metadata, namespace: "other" } }])).toEqual([]);
  });

  it("a VPA on memory only next to an HPA on CPU is fine; unnamed containers are judged only with the template", () => {
    const memoryOnly = copy(recreate);
    (memoryOnly.spec as { resourcePolicy: unknown }).resourcePolicy = { containerPolicies: [{ containerName: "hamster", controlledResources: ["memory"] }] };
    expect(conflictsOf(memoryOnly, [hpa])).toEqual([]);
    expect(conflictsOf(memoryOnly, [hpa], ["hamster"])).toEqual([]);
    // A second container falls under the defaults (cpu and memory): known only from the template.
    expect(conflictsOf(memoryOnly, [hpa], ["hamster", "sidecar"])).toEqual([{ hpa: "hamster", resources: ["cpu"] }]);
    const perContainer = { ...hpa, spec: { ...(hpa.spec as object), metrics: [{ type: "ContainerResource", containerResource: { name: "memory", container: "hamster" } }] } };
    expect(conflictsOf(memoryOnly, [perContainer])).toEqual([{ hpa: "hamster", resources: ["memory"] }]);
  });
});

describe("the components", () => {
  it("are found by the manifests' names or the charts' labels", () => {
    expect(componentOf(recommender)).toBe("recommender");
    expect(componentOf(chartUpdater)).toBe("updater");
    const found = groupComponents([recommender, chartUpdater, recommender]);
    expect(found.recommender).toHaveLength(1);
    expect(found.updater[0]).toMatchObject({ namespace: "vpa", ready: 0, desired: 1 });
    expect(found["admission-controller"]).toEqual([]);
  });

  it("a missing one is explained for the mode", () => {
    expect(missingMeaning("updater", "Off")).toBeUndefined();
    expect(missingMeaning("updater", "Initial")).toBeUndefined();
    expect(missingMeaning("updater", "Recreate")).toBe("updater");
    expect(missingMeaning("admission-controller", "Initial")).toBe("admissionInitial");
    expect(missingMeaning("recommender", "Off")).toBe("recommender");
  });
});

describe("the problems", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");

  it("an unsupported configuration counts after its grace, with the recommender's message, and not also as no pods", () => {
    const problems = toProblems([unsupported], () => [], new Map(), now);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      category: "vpa",
      reason: "ConfigUnsupported",
      message: expect.stringContaining("topmost well-known or scalable controller"),
      activeAt: Date.parse("2026-10-03T08:00:00Z") + UNSUPPORTED_GRACE_MS,
      object: { kind: VPA, namespace: "shop", name: "rs-vpa" },
    });
  });

  it("no pods matched counts after a longer grace, and notifies only where the target is known to want pods", () => {
    const [p] = toProblems([noPodsDeployment], () => [], new Map(), now, VPA, () => 2);
    expect(p).toMatchObject({
      reason: "NoPodsMatched",
      messageKey: "messages.vpaNoPodsMatched",
      notify: true,
      activeAt: Date.parse("2026-10-03T09:00:00Z") + NO_PODS_GRACE_MS,
    });
    // The target's list is not held: listed, not notified.
    expect(toProblems([noPodsDeployment], () => [], new Map(), now)).toEqual([expect.objectContaining({ reason: "NoPodsMatched", notify: false })]);
    // Scaled to zero: no problem.
    expect(toProblems([noPodsDeployment], () => [], new Map(), now, VPA, () => 0)).toEqual([]);
  });

  it("no pods matched is no problem with a recommendation, in mode Off, or for a Job or CronJob", () => {
    expect(toProblems([noPodsRecommended], () => [], new Map(), now, VPA, () => 2)).toEqual([]);
    const offVpa = { ...noPodsDeployment, spec: { ...(noPodsDeployment.spec as object), updatePolicy: { updateMode: "Off" } } };
    expect(toProblems([offVpa], () => [], new Map(), now, VPA, () => 2)).toEqual([]);
    expect(toProblems([noPods], () => [], new Map(), now, VPA, () => 2)).toEqual([]);
    const job = { ...noPodsDeployment, spec: { ...(noPodsDeployment.spec as object), targetRef: { apiVersion: "batch/v1", kind: "Job", name: "once" } } };
    expect(toProblems([job], () => [], new Map(), now, VPA, () => 2)).toEqual([]);
  });

  it("a fight with an HPA counts after its grace from the first sighting; HPAs not read are not judged", () => {
    const [p] = toProblems([recreate], () => [hpa], new Map(), now);
    expect(p).toMatchObject({
      reason: "HpaConflict",
      messageKey: "messages.vpaHpaConflict",
      messageParams: { hpa: "hamster", mode: "Recreate" },
      messageLists: { resources: ["cpu"] },
      activeAt: now + CONFLICT_GRACE_MS,
    });
    expect(toProblems([recreate], () => undefined, new Map(), now)).toEqual([]);
    expect(toProblems([off], () => [hpa], new Map(), now)).toEqual([]);
  });

  it("lists HPAs only in the namespaces of VPAs that change running pods, and only lists read in full", () => {
    expect(namespacesToCheck([recreate, off, unsupported, noPods])).toEqual(["shop"]);
    expect(hpasIn(ready([hpa]), "shop")).toEqual([hpa]);
    expect(hpasIn({ ...ready([]), forbidden: ["shop"] }, "shop")).toBeUndefined();
    expect(hpasIn({ ...ready([]), total: 6000 }, "shop")).toBeUndefined();
    expect(hpasIn(undefined, "shop")).toBeUndefined();
    expect(MAX_HPA_NAMESPACES).toBe(40);
  });

  it("is a category of its own, on by default, judged by its provider only where VPAs are served", () => {
    expect(PROBLEM_CATEGORIES).toContain("vpa");
    expect(categoryOf(VPA)).toBe("vpa");
    expect(OPT_IN_CATEGORIES).not.toContain("vpa");
    expect(detect(VPA, unsupported)).toEqual([]);
    expect(judgedByRules(VPA)).toBe(false);
    expect(sourcesFor(["vpa"], [served(VPA)])).toEqual([expect.objectContaining({ external: true })]);
    expect(sourcesFor(["vpa"], [served(POD)])).toEqual([]);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const HPA: KindRef = { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" };

function served(kind: KindRef): ResourceKind {
  return { kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] };
}

let wb: WatchBackend;
let discovery: KindRef[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetAutoscalingTaps();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [POD, DEPLOYMENT, HPA, VPA, VPA_CHECKPOINT];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
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
  resetSharedWatches();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the Vertical Pod Autoscaler section", () => {
  it("is there where the cluster serves VPAs, and counts the problems", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Vertical Pod Autoscaler"));
    const vpaWatch = await watchOf(wb, "VerticalPodAutoscaler", (s) => s.namespaces === null);
    const start = wb.backend.calls.find((c) => c.cmd === "watch_start" && (c.args.spec as { kind: KindRef }).kind.kind === "VerticalPodAutoscaler")!;
    expect(start.args.options).toEqual({ progressive: false, maxObjects: 5000 });
    emitSnapshot(wb, vpaWatch, [unsupported, recreate]);
    // The HPAs of the namespace whose VPA changes running pods only.
    const hpas = await watchOf(wb, "HorizontalPodAutoscaler", (s) => s.namespaces?.join() === "shop");
    emitSnapshot(wb, hpas, []);
    await waitFor(() => expect(screen.getByTitle("1 object needs attention")).toHaveTextContent("1"));
  });

  it("is not there without the VPA CRDs, and nothing of it is watched", async () => {
    discovery = [POD, DEPLOYMENT, HPA];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Workloads"));
    expect(sections()).not.toContain("Vertical Pod Autoscaler");
    expect([...wb.specs.values()].some((s) => s.kind.kind === "VerticalPodAutoscaler" || s.kind.kind === "HorizontalPodAutoscaler")).toBe(false);
  });

  it("the tables show the target, mode, state and the first container's target; checkpoints their samples", () => {
    const def = getResourceDef(VPA);
    const col = (id: string) => def.columns.find((c) => c.id === id)!;
    expect(def.columns.map((c) => c.id)).toEqual(["name", "namespace", "target", "mode", "status", "cpu", "memory", "age"]);
    expect(col("target").value(recreate)).toBe("Deployment/hamster");
    expect(col("mode").value(recreate)).toBe("Recreate");
    expect(col("status").value(unsupported)).toBe("configUnsupported");
    expect(col("cpu").value(recreate)).toBeCloseTo(0.587);
    expect(def.problem?.(noPodsDeployment)).toBe(true);
    expect(def.problem?.(noPods)).toBe(false);
    const cp = getResourceDef(VPA_CHECKPOINT);
    expect(cp.columns.find((c) => c.id === "samples")!.value(checkpoint)).toBe(4521);
    expect(cp.columns.find((c) => c.id === "vpa")!.value(checkpoint)).toBe("hamster-vpa");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  const [group, version] = (obj.apiVersion ?? "").split("/");
  return version === undefined
    ? { kind: { group: "", version: group ?? "", kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" }
    : { kind: { group: group ?? "", version, kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  return container;
}

const sectionOf = (id: string) => document.querySelector<HTMLElement>(`[data-section='${id}']`)!;

async function answerComponents(found: KubeObject[]): Promise<void> {
  for (const name of ["vpa-recommender", "vpa-updater", "vpa-admission-controller"]) {
    const id = await watchOf(wb, "Deployment", (s) => s.fieldSelector === `metadata.name=${name}` && s.namespaces?.join() === "kube-system");
    emitSnapshot(wb, id, found.filter((d) => d.metadata?.name === name));
  }
  const charts = await watchOf(wb, "Deployment", (s) => s.labelSelector === "app.kubernetes.io/name in (vertical-pod-autoscaler,vpa)");
  emitSnapshot(wb, charts, found.filter((d) => d.metadata?.labels));
}

describe("details of a VPA", () => {
  it("explains the mode, compares the recommendation with the template, warns of the HPA and finds the components", async () => {
    const container = await openDetails(recreate);
    await waitFor(() => expect(sectionOf("vpa")).not.toBeNull());
    const view = within(sectionOf("vpa"));
    expect(view.getAllByText("Recommending")[0]).toHaveClass("rt-status--success");
    expect(view.getByText("Recreate (default)")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Open Deployment hamster" })).toBeInTheDocument();
    const target = await watchOf(wb, "Deployment", (s) => s.fieldSelector === "metadata.name=hamster");
    emitSnapshot(wb, target, [hamster]);
    emitSnapshot(wb, await watchOf(wb, "HorizontalPodAutoscaler", (s) => s.namespaces?.join() === "shop"), [hpa]);
    await waitFor(() => expect(view.getByText("100m / 200m")).toBeInTheDocument());
    // 587m and the limit scaled as the admission controller scales it: 200m × 587 ÷ 100.
    expect(view.getByText("587m / 1174m")).toBeInTheDocument();
    expect(view.getByText("250MiB / 500MiB")).toBeInTheDocument();
    await waitFor(() => expect(view.getByText(/HPA hamster scales this workload on cpu/)).toHaveClass("rt-status--danger"));

    await answerComponents([recommender, chartUpdater]);
    await waitFor(() => expect(view.getByRole("button", { name: "Open Deployment vpa-recommender" })).toBeInTheDocument());
    expect(view.getByText("0 of 1 ready")).toHaveClass("rt-status--danger");
    expect(view.getByText(/Without the admission controller pods are created with the template's values/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("an unsupported configuration says why; in mode Off nothing changes", async () => {
    await openDetails(unsupported);
    await waitFor(() => expect(sectionOf("vpa")).not.toBeNull());
    const view = within(sectionOf("vpa"));
    expect(view.getAllByText("Unsupported")[0]).toHaveClass("rt-status--danger");
    expect(view.getByText(/has a parent controller/)).toBeInTheDocument();
    expect(view.getByText(/point the VPA at the Deployment/)).toBeInTheDocument();
  });

  it("mode Off: the table says no pod changes, and a missing recommender is explained only without a recommendation", async () => {
    const container = await openDetails(off);
    await waitFor(() => expect(sectionOf("vpa")).not.toBeNull());
    const view = within(sectionOf("vpa"));
    emitSnapshot(wb, await watchOf(wb, "Deployment", (s) => s.fieldSelector === "metadata.name=hamster"), [hamster]);
    await waitFor(() => expect(view.getAllByText("No change (mode Off)")).toHaveLength(2));
    expect(view.getAllByText(/kept at the limit \(RequestsOnly\)/)).toHaveLength(2);
    await answerComponents([]);
    await waitFor(() => expect(view.getAllByText("Not found")).toHaveLength(3));
    expect(view.queryByText(/Recommendations come from the recommender/)).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("details of a VPA with a recommendation", () => {
  it("says no pods right now, and never that the recommender is missing", async () => {
    const container = await openDetails(noPodsRecommended);
    await waitFor(() => expect(sectionOf("vpa")).not.toBeNull());
    const view = within(sectionOf("vpa"));
    expect(view.getAllByText("Recommending")[0]).toHaveClass("rt-status--success");
    expect(view.getByText(/No pod matches this VPA right now/)).toBeInTheDocument();
    await answerComponents([]);
    await waitFor(() => expect(view.getAllByText("Not found")).toHaveLength(3));
    expect(view.queryByText(/Recommendations come from the recommender/)).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("an unsupported VPA that still holds a recommendation does not blame a missing recommender", async () => {
    const vpa = copy(unsupported);
    (vpa.status as Record<string, unknown>).recommendation = copy((recreate.status as Record<string, unknown>).recommendation);
    await openDetails(vpa);
    await waitFor(() => expect(sectionOf("vpa")).not.toBeNull());
    const view = within(sectionOf("vpa"));
    await answerComponents([]);
    await waitFor(() => expect(view.getAllByText("Not found")).toHaveLength(3));
    expect(view.queryByText(/Recommendations come from the recommender/)).toBeNull();
  });

  it("an HPA on an AverageValue is a note, not a danger line", async () => {
    await openDetails(recreate);
    await waitFor(() => expect(sectionOf("vpa")).not.toBeNull());
    const view = within(sectionOf("vpa"));
    emitSnapshot(wb, await watchOf(wb, "Deployment", (s) => s.fieldSelector === "metadata.name=hamster"), [hamster]);
    const averageValue = {
      ...hpa,
      spec: { ...(hpa.spec as object), metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "AverageValue", averageValue: "500m" } } }] },
    };
    emitSnapshot(wb, await watchOf(wb, "HorizontalPodAutoscaler", (s) => s.namespaces?.join() === "shop"), [averageValue]);
    await waitFor(() => expect(view.getByText(/HPA hamster scales this workload on the average cpu per pod/)).toHaveClass("vpa-note"));
    expect(view.queryByText(/the two fight/)).toBeNull();
  });
});

describe("a workload's VPA block", () => {
  it("lists the VPAs that target the workload next to right-sizing", async () => {
    const container = await openDetails(hamster);
    const vpas = await watchOf(wb, "VerticalPodAutoscaler", (s) => s.namespaces?.join() === "shop");
    emitSnapshot(wb, vpas, [recreate, off, unsupported]);
    await waitFor(() => expect(sectionOf("vpaWorkload")).not.toBeNull());
    const view = within(sectionOf("vpaWorkload"));
    await waitFor(() => expect(view.getByRole("button", { name: "Open VerticalPodAutoscaler hamster-vpa" })).toBeInTheDocument());
    expect(view.getByRole("button", { name: "Open VerticalPodAutoscaler api-vpa" })).toBeInTheDocument();
    // The VPA of a ReplicaSet is not this Deployment's.
    expect(view.queryByRole("button", { name: "Open VerticalPodAutoscaler rs-vpa" })).toBeNull();
    expect(view.getByText("2 VPAs target this workload: for its pods only the oldest one counts.")).toBeInTheDocument();
    expect(view.getByText("587m / 1174m")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("draws nothing where no VPA targets the workload", async () => {
    await openDetails(hamster);
    emitSnapshot(wb, await watchOf(wb, "VerticalPodAutoscaler", (s) => s.namespaces?.join() === "shop"), [unsupported]);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("[data-section='vpaWorkload']")?.textContent ?? "").toBe("");
  });
});
