// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove them.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/objects.json";
import { startDetails } from "./details";
import { setLanguage } from "./i18n";

const obj = (key: keyof typeof fixtures): KubeObject => structuredClone(fixtures[key]) as unknown as KubeObject;
const spec = (o: KubeObject) => o.spec as Record<string, unknown>;
const st = (o: KubeObject) => o.status as Record<string, unknown>;

const refOf = (o: KubeObject) => {
  const api = o.apiVersion ?? "";
  const [group, version] = api.includes("/") ? api.split("/") : ["", api];
  return { kind: { group: group!, version: version!, kind: o.kind ?? "" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name };
};
const served = (group: string, version: string, kind: string) => ({ kindRef: { group, version, kind }, plural: `${kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const KINDS = [
  served("autoscaling.k8s.io", "v1", "VerticalPodAutoscaler"),
  served("autoscaling.k8s.io", "v1", "VerticalPodAutoscalerCheckpoint"),
  served("autoscaling", "v2", "HorizontalPodAutoscaler"),
  served("apps", "v1", "Deployment"),
  served("apps", "v1", "ReplicaSet"),
  served("batch", "v1", "CronJob"),
];

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
let remembered: Record<string, boolean> = {};
let hidden = false;

interface Options {
  contribution?: "vpa" | "workload";
  language?: string;
  blocks?: Record<string, boolean>;
  kinds?: unknown[];
}

async function open(o: KubeObject, options: Options = {}): Promise<void> {
  const { contribution = "vpa", language = "en", blocks = {}, kinds = KINDS } = options;
  remembered = { ...blocks };
  hidden = contribution === "workload";
  host = await startTestHost({
    context: { view: "details", contribution, selection: [refOf(o)], resourceVersion: "1", language, blocks: remembered },
    handlers: {
      "resources.get": () => structuredClone(o),
      kinds: () => kinds,
      "ui.setBlockOpen": ({ id, open: isOpen }: { id: string; open: boolean }) => {
        remembered = { ...remembered, [id]: isOpen };
        host.setContext({ blocks: remembered });
      },
      "ui.setHidden": ({ hidden: hide }: { hidden: boolean }) => void (hidden = hide),
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, contribution);
  if (contribution === "vpa") await expect.poll(() => root.querySelector(".sx-fields")).not.toBeNull();
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

type Params = { kind: { group: string; kind: string; version?: string }; namespaces?: string[]; labelSelector?: string; fieldSelector?: string };
const params = (w: TestWatch) => w.params as Params;
const live = () => host.watches.filter((w) => !w.stopped);
const watchOf = (kind: string, test: (p: Params) => boolean = () => true) => live().find((w) => params(w).kind.kind === kind && test(params(w)));
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const statusWord = (word: string) => [...root.querySelectorAll(".sx-status")].find((s) => s.textContent === word);
const statusMatching = (re: RegExp) => [...root.querySelectorAll(".sx-status")].find((s) => re.test(s.textContent ?? ""));
const cellsWith = (value: string) => [...root.querySelectorAll("td")].filter((c) => c.textContent === value);
const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`[data-block="${id}"] .sx-block__toggle`);

async function answerComponents(found: KubeObject[]): Promise<void> {
  for (const name of ["vpa-recommender", "vpa-updater", "vpa-admission-controller"]) {
    await expect.poll(() => watchOf("Deployment", (p) => p.fieldSelector === `metadata.name=${name}`)).toBeDefined();
    const w = watchOf("Deployment", (p) => p.fieldSelector === `metadata.name=${name}`)!;
    expect(params(w).namespaces).toEqual(["kube-system"]);
    w.emit(snapshot(found.filter((d) => d.metadata.name === name)));
  }
  const charts = watchOf("Deployment", (p) => p.labelSelector === "app.kubernetes.io/name in (vertical-pod-autoscaler,vpa)")!;
  expect(params(charts).namespaces).toBeUndefined();
  charts.emit(snapshot(found.filter((d) => d.metadata.labels)));
}

async function answerTarget(target: KubeObject): Promise<void> {
  await expect.poll(() => watchOf(target.kind!, (p) => p.fieldSelector === `metadata.name=${target.metadata.name}`)).toBeDefined();
  const w = watchOf(target.kind!, (p) => p.fieldSelector === `metadata.name=${target.metadata.name}`)!;
  expect(params(w)).toMatchObject({ kind: { group: "apps", kind: "Deployment" }, namespaces: ["shop"] });
  w.emit(snapshot([target]));
}

async function answerHpas(hpas: KubeObject[]): Promise<void> {
  await expect.poll(() => watchOf("HorizontalPodAutoscaler")).toBeDefined();
  const w = watchOf("HorizontalPodAutoscaler")!;
  expect(params(w)).toMatchObject({ kind: { group: "autoscaling", kind: "HorizontalPodAutoscaler" }, namespaces: ["shop"] });
  w.emit(snapshot(hpas));
}

/** `noPods` pointed at a Deployment in mode Recreate, still holding the recommendation it had before its pods went. */
const noPodsRecommended = () => {
  const vpa = obj("noPods");
  spec(vpa).targetRef = { apiVersion: "apps/v1", kind: "Deployment", name: "report" };
  spec(vpa).updatePolicy = { updateMode: "Recreate" };
  (st(vpa).conditions as { type: string; status: string }[]).find((c) => c.type === "RecommendationProvided")!.status = "True";
  st(vpa).recommendation = structuredClone(st(obj("recreate")).recommendation);
  return vpa;
};

describe("details of a VPA", () => {
  it("explains the mode, compares the recommendation with the template, warns of the HPA and finds the components", async () => {
    await open(obj("recreate"));
    expect(statusWord("Recommending")?.classList.contains("sx-status--success")).toBe(true);
    expect(text()).toContain("Recreate (default)");
    expect(byLabel("Open Deployment hamster")).toHaveLength(1);
    expect(byLabel("Open Deployment hamster")[0]!.textContent).toBe("Deployment/hamster");
    // No heading of its own: the fields come first.
    expect(root.firstElementChild?.classList.contains("sx-fields")).toBe(true);
    await answerTarget(obj("hamster"));
    await answerHpas([obj("hpa")]);
    await expect.poll(() => cellsWith("100m / 200m")).toHaveLength(1);
    expect(cellsWith("50.0MiB / 100MiB")).toHaveLength(1);
    // 587m and the limit scaled as the admission controller scales it: 200m × 587 ÷ 100.
    expect(cellsWith("587m / 1174m")).toHaveLength(1);
    expect(cellsWith("250MiB / 500MiB")).toHaveLength(1);
    expect(statusMatching(/HPA hamster scales this workload on cpu/)?.classList.contains("sx-status--danger")).toBe(true);
    expect(text()).toContain("When the VPA raises a request");

    await answerComponents([obj("recommender"), obj("chartUpdater")]);
    await expect.poll(() => byLabel("Open Deployment vpa-recommender")).toHaveLength(1);
    expect(statusWord("0 of 1 ready")?.classList.contains("sx-status--danger")).toBe(true);
    expect(statusWord("1 of 1 ready")?.classList.contains("sx-status--success")).toBe(true);
    expect(text()).toContain("Without the admission controller pods are created with the template's values");
    expect(text()).toContain("Looked for as the Deployments vpa-recommender");
    // Columns kept on one line, as the built-in tables' `nowrap`.
    expect(cellsWith("587m / 1174m")[0]!.classList.contains("sx-col--nowrap")).toBe(true);
  });

  it("an unsupported configuration says why", async () => {
    await open(obj("unsupported"));
    expect(statusWord("Unsupported")?.classList.contains("sx-status--danger")).toBe(true);
    expect(root.querySelector(".vpa-message")?.textContent).toContain("has a parent controller");
    expect(text()).toContain("point the VPA at the Deployment");
    expect(text()).toContain("Auto");
  });

  it("mode Off: the table says no pod changes, and a missing recommender is explained only without a recommendation", async () => {
    await open(obj("off"));
    await answerTarget(obj("hamster"));
    await expect.poll(() => cellsWith("No change (mode Off)")).toHaveLength(2);
    expect([...root.querySelectorAll("td")].filter((c) => /kept at the limit \(RequestsOnly\)/.test(c.textContent ?? ""))).toHaveLength(2);
    expect(text()).toContain("With RequestsOnly the request is never set above");
    await answerComponents([]);
    await expect.poll(() => [...root.querySelectorAll(".sx-status")].filter((s) => s.textContent === "Not found")).toHaveLength(3);
    expect(text()).not.toContain("Recommendations come from the recommender");
  });

  it("a kept recommendation: no pods right now, and never that the recommender is missing", async () => {
    await open(noPodsRecommended());
    expect(statusWord("Recommending")?.classList.contains("sx-status--success")).toBe(true);
    expect(text()).toContain("No pod matches this VPA right now");
    await answerComponents([]);
    await expect.poll(() => [...root.querySelectorAll(".sx-status")].filter((s) => s.textContent === "Not found")).toHaveLength(3);
    expect(text()).not.toContain("Recommendations come from the recommender");
  });

  it("a missing recommender is explained where no recommendation came", async () => {
    await open(obj("noPods"));
    await answerComponents([]);
    await expect.poll(() => text()).toContain("Recommendations come from the recommender");
    // Initial: no updater note, and the admission controller's Initial note.
    expect(text()).not.toContain("Without the updater");
    expect(text()).toContain("Without the admission controller, Initial does nothing");
  });

  it("an HPA on an AverageValue is a note, not a danger line", async () => {
    await open(obj("recreate"));
    await answerTarget(obj("hamster"));
    const averageValue = obj("hpa");
    spec(averageValue).metrics = [{ type: "Resource", resource: { name: "cpu", target: { type: "AverageValue", averageValue: "500m" } } }];
    await answerHpas([averageValue]);
    await expect.poll(() => root.querySelector(".vpa-note:not(:empty)") && text()).toContain("HPA hamster scales this workload on the average cpu per pod");
    expect(text()).not.toContain("the two fight");
  });

  it("the target not read, or not served, is said so", async () => {
    await open(obj("recreate"));
    expect(text()).toContain("The target has not been read");
    stop();
    root.remove();
    host.close();
    await open(obj("recreate"), { kinds: KINDS.filter((k) => k.kindRef.kind !== "Deployment") });
    await expect.poll(() => text()).toContain("The cluster does not serve the target's kind Deployment.");
    expect(watchOf("Deployment", (p) => p.fieldSelector === "metadata.name=hamster")).toBeUndefined();
  });

  it("watches the components only while their block is open, and remembers it in Sextant's memory", async () => {
    await open(obj("recreate"), { blocks: { components: false } });
    expect(toggle("components")?.getAttribute("aria-expanded")).toBe("false");
    expect(watchOf("Deployment", (p) => p.labelSelector !== undefined)).toBeUndefined();
    toggle("components")!.click();
    await expect.poll(() => remembered.components).toBe(true);
    await expect.poll(() => watchOf("Deployment", (p) => p.labelSelector !== undefined)).toBeDefined();
    // "Collapse all" in Sextant's panel.
    host.setContext({ blocks: { "*": false } });
    await expect.poll(() => toggle("recommendation")?.getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => watchOf("Deployment", (p) => p.labelSelector !== undefined)).toBeUndefined();
  });

  it("speaks the UI language", async () => {
    await open(obj("recreate"), { language: "ru" });
    expect(statusWord("Рекомендует")).toBeDefined();
  });
});

describe("a workload's VPA block", () => {
  it("lists the VPAs that target the workload", async () => {
    await open(obj("hamster"), { contribution: "workload" });
    expect(hidden).toBe(true);
    await expect.poll(() => watchOf("VerticalPodAutoscaler")).toBeDefined();
    expect(params(watchOf("VerticalPodAutoscaler")!)).toMatchObject({ kind: { group: "autoscaling.k8s.io", kind: "VerticalPodAutoscaler" }, namespaces: ["shop"] });
    // The namespace's HPAs only once a VPA targets the workload.
    expect(watchOf("HorizontalPodAutoscaler")).toBeUndefined();
    watchOf("VerticalPodAutoscaler")!.emit(snapshot([obj("recreate"), obj("off"), obj("unsupported")]));
    await expect.poll(() => byLabel("Open VerticalPodAutoscaler hamster-vpa")).toHaveLength(1);
    expect(hidden).toBe(false);
    expect(byLabel("Open VerticalPodAutoscaler api-vpa")).toHaveLength(1);
    // The VPA of a ReplicaSet is not this Deployment's.
    expect(byLabel("Open VerticalPodAutoscaler rs-vpa")).toHaveLength(0);
    expect(text()).toContain("2 VPAs target this workload: for its pods only the oldest one counts.");
    expect(cellsWith("587m / 1174m")).toHaveLength(1);
    // Sorted by name: api-vpa first.
    const names = byLabel("Open VerticalPodAutoscaler api-vpa")[0]!.compareDocumentPosition(byLabel("Open VerticalPodAutoscaler hamster-vpa")[0]!);
    expect(names & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await answerHpas([obj("hpa")]);
    await expect.poll(() => statusMatching(/HPA hamster scales this workload on cpu/)).toBeDefined();
    expect(root.querySelector("[data-block='workload'] .sx-block__toggle")?.textContent).toBe("Vertical Pod Autoscaler");
  });

  it("draws nothing where no VPA targets the workload", async () => {
    await open(obj("hamster"), { contribution: "workload" });
    await expect.poll(() => watchOf("VerticalPodAutoscaler")).toBeDefined();
    watchOf("VerticalPodAutoscaler")!.emit(snapshot([obj("unsupported")]));
    await new Promise((r) => setTimeout(r, 20));
    expect(hidden).toBe(true);
    expect(text()).toBe("");
    expect(watchOf("HorizontalPodAutoscaler")).toBeUndefined();
  });

  it("draws nothing and watches nothing where the cluster serves no VPAs", async () => {
    await open(obj("hamster"), { contribution: "workload", kinds: KINDS.filter((k) => k.kindRef.group !== "autoscaling.k8s.io") });
    await new Promise((r) => setTimeout(r, 20));
    expect(hidden).toBe(true);
    expect(live()).toHaveLength(0);
  });

  it("closed, the block stays as a closed block and watches nothing, as the built-in one did", async () => {
    await open(obj("hamster"), { contribution: "workload", blocks: { workload: false } });
    await expect.poll(() => hidden).toBe(false);
    expect(toggle("workload")?.getAttribute("aria-expanded")).toBe("false");
    expect(live()).toHaveLength(0);
    toggle("workload")!.click();
    await expect.poll(() => watchOf("VerticalPodAutoscaler")).toBeDefined();
    // Open and no VPA known yet: nothing drawn.
    expect(hidden).toBe(true);
  });
});
