// The model and the manifest's declarative parts. The manifest's problem rules (which also make the kind's "Only
// problems") and the columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and
// columns.tsx, loaded at run time so the type check stays inside the extension) and compared with the model they
// replace — the reading of Sextant's former built-in view (ADR-0111), ported unchanged, its problem provider
// included — on its fixtures and variants of them. Where the rules cannot say what the provider said, a test pins the
// difference the README lists.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import fixtures from "../fixtures/objects.json";
import en from "./locales/en.json";
import { containerChange, milliOf, proportionalLimit, templateChanges, unitsOf } from "./admission";
import { componentOf, groupComponents, missingMeaning } from "./components";
import { conflictsOf, hpaResources, valueOverlapsOf } from "./conflicts";
import { formatAmount, parseQuantity } from "./format";
import {
  containerPoliciesOf,
  controls,
  isBatchTarget,
  isProblem,
  recommendationsOf,
  STATE_TONE,
  statusOf,
  targetOf,
  UPDATING_MODES,
  updateModeOf,
} from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const obj = (key: keyof typeof fixtures): KubeObject => copy(fixtures[key]) as unknown as KubeObject;
const recreate = () => obj("recreate");
const hamster = () => obj("hamster");
const hpa = () => obj("hpa");
const off = () => obj("off");
const unsupported = () => obj("unsupported");
const noPods = () => obj("noPods");
const checkpoint = () => obj("checkpoint");
const recommender = () => obj("recommender");
const chartUpdater = () => obj("chartUpdater");
const spec = (o: KubeObject) => o.spec as Record<string, unknown>;
const st = (o: KubeObject) => o.status as Record<string, unknown>;
type Cond = { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string };
const conditions = (o: KubeObject) => (st(o).conditions ?? []) as Cond[];
const at = (iso: string) => Date.parse(iso);
const MI = 2 ** 20;

/** `noPods` pointed at a Deployment in mode Recreate. */
const noPodsDeployment = () => {
  const vpa = noPods();
  spec(vpa).targetRef = { apiVersion: "apps/v1", kind: "Deployment", name: "report" };
  spec(vpa).updatePolicy = { updateMode: "Recreate" };
  return vpa;
};
/** `noPodsDeployment` that still holds the recommendation it had before its pods went away. */
const noPodsRecommended = () => {
  const vpa = noPodsDeployment();
  conditions(vpa).find((c) => c.type === "RecommendationProvided")!.status = "True";
  st(vpa).recommendation = copy(st(recreate()).recommendation);
  return vpa;
};

// ---------- The built-in model ----------

describe("the model", () => {
  it("reads the target and the mode, Recreate when unset", () => {
    expect(targetOf(recreate())).toEqual({ apiVersion: "apps/v1", kind: "Deployment", name: "hamster", group: "apps" });
    expect(updateModeOf(recreate())).toBe("Recreate");
    expect(updateModeOf(off())).toBe("Off");
    expect(updateModeOf(unsupported())).toBe("Auto");
  });

  it("reads the state from the conditions in the recommender's order", () => {
    expect(statusOf(recreate())).toMatchObject({ state: "ready", reason: "provided" });
    expect(statusOf(off())).toMatchObject({ state: "ready", reason: "lowConfidence" });
    expect(statusOf(unsupported())).toMatchObject({ state: "failed", reason: "configUnsupported", message: expect.stringContaining("parent controller") });
    expect(statusOf(noPods())).toMatchObject({ state: "failed", reason: "noPodsMatched" });
    const none = recreate();
    delete none.status;
    expect(statusOf(none)).toMatchObject({ state: "progressing", reason: "noStatus" });
    expect(isProblem(unsupported())).toBe(true);
    expect(isProblem(recreate())).toBe(false);
  });

  it("a kept recommendation outranks NoPodsMatched: ready, with a note, and no problem", () => {
    expect(statusOf(noPodsRecommended())).toMatchObject({ state: "ready", reason: "provided", noPodsNow: true });
    expect(statusOf(noPodsDeployment())).toMatchObject({ state: "failed", reason: "noPodsMatched" });
    expect(isProblem(noPodsRecommended())).toBe(false);
    expect(isProblem(noPodsDeployment())).toBe(true);
    expect(isProblem(noPods())).toBe(false);
  });

  it("finds a container's policy by name, else the wildcard, with the API's defaults", () => {
    const policies = containerPoliciesOf(recreate());
    expect(controls(policies, "anything", "cpu")).toBe(true);
    const memoryOnly = containerPoliciesOf({ ...recreate(), spec: { resourcePolicy: { containerPolicies: [{ containerName: "app", controlledResources: ["memory"] }, { containerName: "*", mode: "Off" }] } } });
    expect(controls(memoryOnly, "app", "cpu")).toBe(false);
    expect(controls(memoryOnly, "app", "memory")).toBe(true);
    expect(controls(memoryOnly, "sidecar", "memory")).toBe(false);
    expect(controls([], "app", "cpu")).toBe(true);
    expect(recommendationsOf(recreate())[0]?.target).toEqual({ cpu: "587m", memory: "262144k" });
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
    expect(proportionalLimit("cpu", undefined, 100, 587)).toBeUndefined();
    expect(proportionalLimit("cpu", 200, undefined, 587)).toBe(587);
    expect(proportionalLimit("cpu", 200, 200, 587)).toBe(587);
    expect(proportionalLimit("cpu", 200, 100, 587)).toBe(1174);
    expect(proportionalLimit("cpu", 250, 300, 587)).toBe(489);
    // Bytes, beyond what a double multiplies exactly.
    expect(proportionalLimit("memory", 64 * 2 ** 30, 32 * 2 ** 30, 48 * 2 ** 30 + 1)).toBe(96 * 2 ** 30 + 2);
    expect(proportionalLimit("memory", 100 * MI, 50 * MI, 0)).toBeUndefined();
  });

  it("sets the target as the request and keeps the limit's ratio (RequestsAndLimits)", () => {
    const [c] = templateChanges(hamster(), containerPoliciesOf(recreate()), recommendationsOf(recreate()));
    expect(c).toMatchObject({ container: "hamster", state: "scaled", controlledValues: "RequestsAndLimits" });
    expect(c!.resources).toEqual([
      expect.objectContaining({ resource: "cpu", request: 100, limit: 200, target: 587, newRequest: 587, newLimit: 1174 }),
      expect.objectContaining({ resource: "memory", request: 50 * MI, limit: 100 * MI, target: 262_144_000, newRequest: 262_144_000, newLimit: 524_288_000 }),
    ]);
  });

  it("keeps the target within minAllowed and maxAllowed, and at most the limit with RequestsOnly", () => {
    const low = recreate();
    (st(low).recommendation as { containerRecommendations: { target: Record<string, string> }[] }).containerRecommendations[0]!.target = { cpu: "20m", memory: "2Gi" };
    const [c] = templateChanges(hamster(), containerPoliciesOf(low), recommendationsOf(low));
    expect(c!.resources[0]).toMatchObject({ newRequest: 100, capped: "minAllowed" });
    expect(c!.resources[1]).toMatchObject({ newRequest: 500 * MI, capped: "maxAllowed" });
    const [o] = templateChanges(hamster(), containerPoliciesOf(off()), recommendationsOf(off()));
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

  it("writes amounts as Sextant's autoscaling views write them", () => {
    expect(formatAmount("cpu", 0.587)).toBe("587m");
    expect(formatAmount("cpu", 2)).toBe("2");
    expect(formatAmount("memory", 262_144_000)).toBe("250MiB");
    expect(formatAmount("memory", 1.5 * 2 ** 30)).toBe("1.50GiB");
    expect(parseQuantity("262144k")).toBe(262_144_000);
  });
});

describe("conflicts with an HPA", () => {
  it("reads the HPA's CPU and memory metrics; no metrics is the API's default CPU", () => {
    expect(hpaResources(hpa())).toEqual([{ resource: "cpu" }]);
    expect(hpaResources({ ...hpa(), spec: { ...spec(hpa()), metrics: [] } })).toEqual([{ resource: "cpu" }]);
    expect(hpaResources({ ...hpa(), spec: { ...spec(hpa()), metrics: [{ type: "Pods", pods: { metric: { name: "rps" } } }] } })).toEqual([]);
  });

  it("only a Utilization target fights; an AverageValue target is a note", () => {
    const averageValue = { ...hpa(), spec: { ...spec(hpa()), metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "AverageValue", averageValue: "500m" } } }] } };
    expect(conflictsOf(recreate(), [averageValue])).toEqual([]);
    expect(valueOverlapsOf(recreate(), [averageValue])).toEqual([{ hpa: "hamster", resources: ["cpu"] }]);
    expect(valueOverlapsOf(recreate(), [hpa()])).toEqual([]);
  });

  it("a VPA that changes running pods fights an HPA on the same resource of the same target", () => {
    expect(conflictsOf(recreate(), [hpa()])).toEqual([{ hpa: "hamster", resources: ["cpu"] }]);
    expect(conflictsOf(off(), [hpa()])).toEqual([]);
    const memoryOnly = recreate();
    spec(memoryOnly).resourcePolicy = { containerPolicies: [{ containerName: "hamster", controlledResources: ["memory"] }] };
    expect(conflictsOf(memoryOnly, [hpa()])).toEqual([]);
    expect(conflictsOf(memoryOnly, [hpa()], ["hamster", "sidecar"])).toEqual([{ hpa: "hamster", resources: ["cpu"] }]);
  });
});

describe("the components", () => {
  it("are found by the manifests' names or the charts' labels", () => {
    expect(componentOf(recommender())).toBe("recommender");
    expect(componentOf(chartUpdater())).toBe("updater");
    const found = groupComponents([recommender(), chartUpdater(), recommender()]);
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

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Lookup {
  group: string;
  kind: string;
  name: string;
  /** `relatedBy`: the paths of the other object and the judged object's texts there. */
  by?: [string, string][];
  fact?: string;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  activeFrom?: number;
  notify: boolean;
  lookups?: Lookup[];
}
interface Engine {
  valueAt(obj: unknown, path: string): unknown;
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
  filter?: { type?: string; value(obj: KubeObject, ctx: { now: number }): unknown };
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
let formatDateTime: (value: number) => string;
let formatList: (items: readonly string[]) => string;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  const { startI18n } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n(language: string): Promise<unknown> };
  await startI18n("en");
  ({ formatDateTime, formatList } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/format.ts"))) as {
    formatDateTime(value: number): string;
    formatList(items: readonly string[]): string;
  });
});

type Rule = (typeof manifest.contributes.problems)[number];
const RULES = manifest.contributes.problems as Rule[];
const SHORT_GRACE_MS = 2 * 60_000;
const NO_PODS_GRACE_MS = 10 * 60_000;

/** The `relatedBy` condition of a rule (at most one, at the top of its `all`). */
function relatedByOf(rule: Rule): { when: unknown } | undefined {
  const of = (rule.when as { type: string; of?: { type: string; when?: unknown }[] }).of ?? [];
  return of.find((c) => c.type === "relatedBy") as { when: unknown } | undefined;
}

/**
 * What the manifest's rules find for `vpa`, judged as the window judges them (`judgeAcross`): a `relatedBy` lookup
 * holds when an HPA of `hpas` (read in full; `undefined`: not read) in the VPA's namespace holds the VPA's texts at the
 * lookup's paths and its own condition holds there. `start` is when it counts, the first sighting being `seen`.
 */
function windowProblems(vpa: KubeObject, hpas: KubeObject[] | undefined, seen: number) {
  return RULES.flatMap((rule) =>
    engine.detectRule(rule, vpa).flatMap((d) => {
      // The HPAs found, each once, for `{{found}}` (`foundNames`): all of the VPA's namespace, so plain names.
      const names: string[] = [];
      for (const lookup of d.lookups ?? []) {
        const found = (hpas ?? []).filter(
          (h) =>
            h.metadata.namespace === vpa.metadata.namespace &&
            (lookup.by ?? []).every(([path, value]) => {
              const v = engine.valueAt(h, path);
              return (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && String(v) === value;
            }) &&
            engine.evaluate(relatedByOf(rule)!.when, h).holds,
        );
        if (found.length === 0) return [];
        names.push(...found.map((h) => h.metadata.name!));
      }
      const message = d.message?.split("{{found}}").join(formatList([...new Set(names)]));
      const since = d.since ? at(d.since) : seen;
      return [{ reason: d.reason, group: d.group, message, notify: d.notify ?? true, start: d.activeFrom ?? (d.graceMs ? since + d.graceMs : Math.min(since, seen)) }];
    }),
  );
}

/** The built-in provider's problems (`toProblems`), ported, with the English texts of its message keys. */
function builtInProblems(vpa: KubeObject, hpas: KubeObject[] | undefined, seen: number, targetReplicas?: number) {
  const out: { reason: string; group: string; message?: string; notify: boolean; start: number }[] = [];
  if (vpa.metadata.deletionTimestamp) return out;
  const start = (since: string | undefined, grace: number) => (since ? at(since) : seen) + grace;
  const s = statusOf(vpa);
  const mode = updateModeOf(vpa);
  if (s.reason === "configUnsupported") out.push({ reason: "ConfigUnsupported", group: "config-unsupported", message: s.message ?? "", notify: true, start: start(s.since, SHORT_GRACE_MS) });
  if (s.reason === "noPodsMatched" && mode !== "Off" && !isBatchTarget(targetOf(vpa)) && targetReplicas !== 0) {
    out.push({ reason: "NoPodsMatched", group: "no-pods-matched", message: "No pod matches it, so the recommender gives no recommendation.", notify: targetReplicas !== undefined, start: start(s.since, NO_PODS_GRACE_MS) });
  }
  const namespaceHpas = UPDATING_MODES.has(mode) ? hpas?.filter((h) => h.metadata.namespace === vpa.metadata.namespace) : undefined;
  for (const c of namespaceHpas ? conflictsOf(vpa, namespaceHpas) : []) {
    out.push({
      reason: "HpaConflict",
      group: "hpa-conflict",
      // The built-in message (`messages.vpaHpaConflict`), the rules naming the HPA they found with `{{found}}`.
      message: `HPA ${c.hpa} scales the same workload on ${c.resources.join(", ")}, which this VPA changes in mode ${mode}: the two fight.`,
      notify: true,
      start: start(undefined, SHORT_GRACE_MS),
    });
  }
  return out;
}

const SEEN = at("2026-10-21T12:00:00Z");
const sorted = <T extends { reason: string }>(list: T[]) => [...list].sort((a, b) => a.reason.localeCompare(b.reason));

// ---------- Variants of the fixtures ----------

const withMode = (vpa: KubeObject, updateMode: unknown) => {
  spec(vpa).updatePolicy = { updateMode };
  return vpa;
};
const withPolicies = (vpa: KubeObject, containerPolicies: unknown[] | undefined) => {
  if (containerPolicies === undefined) delete spec(vpa).resourcePolicy;
  else spec(vpa).resourcePolicy = { containerPolicies };
  return vpa;
};
const withTarget = (vpa: KubeObject, targetRef: unknown) => {
  spec(vpa).targetRef = targetRef;
  return vpa;
};
const withConditions = (vpa: KubeObject, list: Cond[]) => {
  vpa.status = { ...st(vpa), conditions: list };
  return vpa;
};
const T0 = "2026-10-21T11:00:00Z";

function vpaVariants(): [string, KubeObject][] {
  const deleting = unsupported();
  deleting.metadata.deletionTimestamp = "2026-10-21T11:00:00Z";
  const unsupportedNoTime = unsupported();
  delete conditions(unsupportedNoTime)[0]!.lastTransitionTime;
  const none = recreate();
  delete none.status;
  const olderRecommender = recreate();
  st(olderRecommender).conditions = [];
  const noPodsOldRecommender = noPodsDeployment();
  st(noPodsOldRecommender).conditions = conditions(noPodsOldRecommender).filter((c) => c.type !== "RecommendationProvided");
  st(noPodsOldRecommender).recommendation = copy(st(recreate()).recommendation);
  const notProvided = withConditions(recreate(), [{ type: "RecommendationProvided", status: "False", reason: "NotYet", message: "not yet", lastTransitionTime: T0 }]);
  delete st(notProvided).recommendation;
  const fetching = withConditions(recreate(), [
    { type: "RecommendationProvided", status: "True", lastTransitionTime: T0 },
    { type: "FetchingHistory", status: "True", lastTransitionTime: T0 },
  ]);
  const deprecated = withConditions(recreate(), [
    { type: "RecommendationProvided", status: "True", lastTransitionTime: T0 },
    { type: "ConfigDeprecated", status: "True", lastTransitionTime: T0 },
  ]);
  const noPodsNoTime = noPodsDeployment();
  for (const c of conditions(noPodsNoTime)) delete c.lastTransitionTime;
  return [
    ["recreate", recreate()],
    ["off", off()],
    ["unsupported", unsupported()],
    ["unsupported, no time", unsupportedNoTime],
    ["unsupported, deleting", deleting],
    ["no pods, CronJob", noPods()],
    ["no pods, Job", withTarget(noPodsDeployment(), { apiVersion: "batch/v1", kind: "Job", name: "once" })],
    ["no pods, a Job of another group", withTarget(noPodsDeployment(), { apiVersion: "example.com/v1", kind: "Job", name: "once" })],
    ["no pods, Deployment", noPodsDeployment()],
    ["no pods, no time", noPodsNoTime],
    ["no pods, mode Off", withMode(noPodsDeployment(), "Off")],
    ["no pods, mode empty", withMode(noPodsDeployment(), "")],
    ["no pods, kept recommendation", noPodsRecommended()],
    ["no pods, an older recommender's recommendation", noPodsOldRecommender],
    ["no status", none],
    ["older recommender", olderRecommender],
    ["not provided", notProvided],
    ["fetching history", fetching],
    ["deprecated", deprecated],
  ];
}

/** VPAs of the hamster Deployment with every mode and container policy shape the conflicts tell apart. */
function conflictVpas(): [string, KubeObject][] {
  const policies: [string, unknown[] | undefined][] = [
    ["wildcard both", [{ containerName: "*", controlledResources: ["cpu", "memory"] }]],
    ["no policies", undefined],
    ["empty policies", []],
    ["memory only", [{ containerName: "hamster", controlledResources: ["memory"] }]],
    ["cpu only", [{ containerName: "*", controlledResources: ["cpu"] }]],
    ["unset resources", [{ containerName: "hamster" }]],
    ["Off", [{ containerName: "*", mode: "Off" }]],
    ["Off and memory", [{ containerName: "*", mode: "Off" }, { containerName: "hamster", controlledResources: ["memory"] }]],
    ["Auto mode, cpu", [{ containerName: "hamster", mode: "Auto", controlledResources: ["cpu"] }]],
  ];
  const modes: unknown[] = [undefined, "", "Recreate", "Auto", "InPlaceOrRecreate", "InPlace", "Initial", "Off"];
  const out: [string, KubeObject][] = [];
  for (const [label, list] of policies) {
    for (const mode of modes) {
      const vpa = withPolicies(recreate(), list);
      if (mode !== undefined) withMode(vpa, mode);
      out.push([`${label}, mode ${String(mode)}`, vpa]);
    }
  }
  // Each kind an HPA scales, and a target of another group or without an apiVersion.
  for (const kind of ["StatefulSet", "ReplicaSet"]) out.push([`a ${kind}`, withTarget(recreate(), { apiVersion: "apps/v1", kind, name: "hamster" })]);
  out.push(["a Deployment of extensions", withTarget(recreate(), { apiVersion: "extensions/v1beta1", kind: "Deployment", name: "hamster" })]);
  out.push(["a Deployment without apiVersion", withTarget(recreate(), { kind: "Deployment", name: "hamster" })]);
  out.push(["a Rollout", withTarget(recreate(), { apiVersion: "argoproj.io/v1alpha1", kind: "Rollout", name: "hamster" })]);
  // A per-container metric is judged where the VPA's policies make it certain for every container: none at all.
  out.push(["no policies, a Rollout", withPolicies(withTarget(recreate(), { apiVersion: "argoproj.io/v1alpha1", kind: "Rollout", name: "hamster" }), undefined)]);
  const deleting = recreate();
  deleting.metadata.deletionTimestamp = T0;
  out.push(["deleting", deleting]);
  return out;
}

const metric = (name: string, target: Record<string, unknown> = { type: "Utilization", averageUtilization: 60 }) => ({ type: "Resource", resource: { name, target } });
const hpaWith = (metrics: unknown[] | undefined, patch: (h: KubeObject) => void = () => undefined) => {
  const h = hpa();
  if (metrics === undefined) delete spec(h).metrics;
  else spec(h).metrics = metrics;
  patch(h);
  return h;
};

/** HPAs of the hamster Deployment, whatever they are called, and some that are not its. */
function hpaSets(): [string, KubeObject[] | undefined][] {
  return [
    ["none read", undefined],
    ["none", []],
    ["cpu", [hpa()]],
    ["memory", [hpaWith([metric("memory")])]],
    ["cpu and memory", [hpaWith([metric("memory"), metric("cpu")])]],
    ["no metrics", [hpaWith(undefined)]],
    ["empty metrics", [hpaWith([])]],
    ["cpu AverageValue", [hpaWith([metric("cpu", { type: "AverageValue", averageValue: "500m" })])]],
    ["memory Value and cpu", [hpaWith([metric("memory", { type: "Value", value: "1Gi" }), metric("cpu")])]],
    ["a Pods metric", [hpaWith([{ type: "Pods", pods: { metric: { name: "rps" }, target: { type: "AverageValue", averageValue: "10" } } }])]],
    ["another target", [hpaWith([metric("cpu")], (h) => (spec(h).scaleTargetRef = { apiVersion: "apps/v1", kind: "Deployment", name: "other" }))]],
    ["another namespace", [hpaWith([metric("cpu")], (h) => (h.metadata.namespace = "other"))]],
    ["a StatefulSet's", [hpaWith([metric("cpu")], (h) => (spec(h).scaleTargetRef = { apiVersion: "apps/v1", kind: "StatefulSet", name: "hamster" }))]],
    ["a ReplicaSet's", [hpaWith([metric("cpu"), metric("memory")], (h) => (spec(h).scaleTargetRef = { apiVersion: "apps/v1", kind: "ReplicaSet", name: "hamster" }))]],
    ["of extensions", [hpaWith([metric("cpu")], (h) => (spec(h).scaleTargetRef = { apiVersion: "extensions/v1beta1", kind: "Deployment", name: "hamster" }))]],
    ["deleting", [hpaWith([metric("cpu")], (h) => (h.metadata.deletionTimestamp = T0))]],
    ["named otherwise", [hpaWith([metric("cpu")], (h) => (h.metadata.name = "hamster-hpa"))]],
    ["named otherwise, both", [hpaWith([metric("cpu"), metric("memory")], (h) => (h.metadata.name = "web-autoscaler"))]],
    ["per container cpu", [hpaWith([{ type: "ContainerResource", containerResource: { name: "cpu", container: "hamster", target: { type: "Utilization", averageUtilization: 60 } } }])]],
    ["per container memory and cpu", [hpaWith([{ type: "ContainerResource", containerResource: { name: "memory", container: "hamster", target: { type: "Utilization", averageUtilization: 60 } } }, metric("cpu")])]],
    ["per container AverageValue", [hpaWith([{ type: "ContainerResource", containerResource: { name: "cpu", container: "hamster", target: { type: "AverageValue", averageValue: "1" } } }])]],
    ["a Rollout's", [hpaWith([metric("cpu")], (h) => (spec(h).scaleTargetRef = { apiVersion: "argoproj.io/v1alpha1", kind: "Rollout", name: "hamster" }))]],
  ];
}

describe("the problem rules, against the built-in provider", () => {
  it("find what the provider found, counted from the same time, for every VPA state", () => {
    for (const [label, vpa] of vpaVariants()) {
      for (const [hpaLabel, hpas] of [["none read", undefined], ["cpu", [hpa()]]] as const) {
        expect(sorted(windowProblems(vpa, hpas as KubeObject[] | undefined, SEEN)), `${label} / ${hpaLabel}`).toEqual(sorted(builtInProblems(vpa, hpas as KubeObject[] | undefined, SEEN)));
      }
    }
  });

  it("find the fights with an HPA as the provider did, with the same resources", () => {
    let fights = 0;
    for (const [label, vpa] of conflictVpas()) {
      for (const [hpaLabel, hpas] of hpaSets()) {
        // A per-container metric of a VPA with policies: below.
        const policies = (spec(vpa).resourcePolicy as { containerPolicies?: unknown[] } | undefined)?.containerPolicies ?? [];
        if (hpaLabel.startsWith("per container") && hpaLabel !== "per container AverageValue" && policies.length > 0) continue;
        const expected = builtInProblems(vpa, hpas, SEEN);
        fights += expected.filter((p) => p.reason === "HpaConflict").length;
        expect(sorted(windowProblems(vpa, hpas, SEEN)), `${label} / ${hpaLabel}`).toEqual(sorted(expected));
      }
    }
    expect(fights).toBeGreaterThan(40);
  });

  it("make the kind's Only problems as the built-in filter did", () => {
    const problemWhen = manifest.contributes.kinds[0]!.problemWhen;
    for (const [label, vpa] of [...vpaVariants(), ...conflictVpas()]) {
      expect(engine.evaluate(problemWhen, vpa).holds, label).toBe(isProblem(vpa));
    }
  });

  it("the section counts every rule's problems, in the extension's main category, on by default", () => {
    expect(manifest.contributes.sectionBadges).toEqual([expect.objectContaining({ section: "vpa", rules: [] })]);
    expect(RULES.every((r) => (r as { category?: string }).category === undefined)).toBe(true);
    expect((manifest.contributes as { problemCategories?: unknown }).problemCategories).toBeUndefined();
  });

  it("differ where the README says: a target scaled to zero is listed, and no-pods never notifies", () => {
    const vpa = noPodsDeployment();
    // The provider read the target's replicas from a list another view held: none for zero, a notification when known.
    expect(builtInProblems(vpa, [], SEEN, 0)).toEqual([]);
    expect(builtInProblems(vpa, [], SEEN, 2)).toEqual([expect.objectContaining({ reason: "NoPodsMatched", notify: true })]);
    expect(windowProblems(vpa, [], SEEN)).toEqual([expect.objectContaining({ reason: "NoPodsMatched", notify: false })]);
  });

  it("differ where the README says: a per-container metric of a VPA with policies, a target's version, no apiVersion", () => {
    const perContainer = hpaWith([{ type: "ContainerResource", containerResource: { name: "cpu", container: "hamster", target: { type: "Utilization", averageUtilization: 60 } } }]);
    // The wildcard policy covers the container: the built-in problem knew it; the rules read no container name.
    expect(builtInProblems(recreate(), [perContainer], SEEN)).toHaveLength(1);
    expect(windowProblems(recreate(), [perContainer], SEEN)).toEqual([]);
    // The built-in compared the group, the rules the whole apiVersion.
    const older = hpaWith([metric("cpu")], (h) => (spec(h).scaleTargetRef = { apiVersion: "apps/v1beta2", kind: "Deployment", name: "hamster" }));
    expect(builtInProblems(recreate(), [older], SEEN)).toHaveLength(1);
    expect(windowProblems(recreate(), [older], SEEN)).toEqual([]);
    // Neither names an apiVersion: the same (core) group to the built-in view, no text to compare for the rules.
    const bare = withTarget(recreate(), { kind: "Deployment", name: "hamster" });
    const bareHpa = hpaWith([metric("cpu")], (h) => (spec(h).scaleTargetRef = { kind: "Deployment", name: "hamster" }));
    expect(builtInProblems(bare, [bareHpa], SEEN)).toHaveLength(1);
    expect(windowProblems(bare, [bareHpa], SEEN)).toEqual([]);
    // Two HPAs on one target: one problem per HPA built in; the rules find the outcome once, naming both.
    const second = hpaWith([metric("cpu")], (h) => (h.metadata.name = "second"));
    expect(builtInProblems(recreate(), [hpa(), second], SEEN)).toHaveLength(2);
    const both = windowProblems(recreate(), [hpa(), second], SEEN);
    expect(both).toHaveLength(1);
    expect(both[0]!.message).toBe(`HPA ${formatList([hpa().metadata.name!, "second"])} scales the same workload on cpu, which this VPA changes in mode Recreate: the two fight.`);
  });

  it("notify once per VPA and reason, and say the reasons the built-in problems said", () => {
    expect([...new Set(RULES.map((r) => r.reason))].sort()).toEqual(["ConfigUnsupported", "HpaConflict", "NoPodsMatched"]);
    for (const rule of RULES) expect(rule.group).toBe({ ConfigUnsupported: "config-unsupported", NoPodsMatched: "no-pods-matched", HpaConflict: "hpa-conflict" }[rule.reason!]);
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.vpa:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = at("2026-10-21T12:00:00Z");
const cell = (id: string, o: KubeObject) => windowColumn(id).searchText(o, { now: NOW, t: T }) ?? undefined;
function drawn(id: string, o: KubeObject): { title?: string; tone?: string } {
  let node = windowColumn(id).render(o, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title, tone: node?.props?.tone };
}

describe("the columns, against the built-in ones", () => {
  it("are placed as the built-in ones, with the CRDs' own columns left out, in their widths", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    const order = (kind: string) => manifest.contributes.columns.filter((c) => c.kind.kind === kind).map((c) => [c.afterColumn, c.id]);
    expect(order("VerticalPodAutoscaler")).toEqual([
      ["namespace", "vpa-target"],
      ["vpa-target", "vpa-mode"],
      ["vpa-mode", "vpa-status"],
      ["vpa-status", "vpa-cpu"],
      ["vpa-cpu", "vpa-memory"],
    ]);
    expect(order("VerticalPodAutoscalerCheckpoint")).toEqual([
      ["namespace", "cp-vpa"],
      ["cp-vpa", "cp-container"],
      ["cp-container", "cp-samples"],
      ["cp-samples", "cp-last-update"],
    ]);
    expect(Object.fromEntries(manifest.contributes.columns.map((c) => [c.id, windowColumn(c.id).width]))).toEqual({
      "vpa-target": "minmax(140px, 1fr)",
      "vpa-mode": "140px",
      "vpa-status": "160px",
      "vpa-cpu": "80px",
      "vpa-memory": "90px",
      "cp-vpa": "minmax(120px, 1fr)",
      "cp-container": "minmax(100px, 1fr)",
      "cp-samples": "90px",
      "cp-last-update": "170px",
    });
  });

  it("Status: the state in its tone, the deciding condition's message on hover, sorted and filtered by the state", () => {
    for (const [label, o] of [...vpaVariants(), ...conflictVpas()]) {
      const s = statusOf(o);
      expect(cell("vpa-status", o), label).toBe(en[`reason.${s.reason}` as keyof typeof en]);
      expect(drawn("vpa-status", o), label).toEqual({ title: s.message, tone: STATE_TONE[s.state] });
      expect(windowColumn("vpa-status").value(o), label).toBe(s.reason);
      expect(windowColumn("vpa-status").filter!.value(o, { now: NOW }), label).toBe(s.reason);
    }
  });

  it("Target and Mode as the built-in ones: Kind/name, and Recreate when unset", () => {
    expect(cell("vpa-target", recreate())).toBe("Deployment/hamster");
    expect(windowColumn("vpa-target").value(recreate())).toBe("Deployment/hamster");
    expect(cell("vpa-target", withTarget(recreate(), { name: "x" }))).toBeFalsy();
    expect(windowColumn("vpa-target").value(withTarget(recreate(), { kind: "Deployment" }))).toBeUndefined();
    for (const [label, o] of [...vpaVariants(), ...conflictVpas()]) {
      expect(cell("vpa-mode", o), label).toBe(updateModeOf(o));
      expect(windowColumn("vpa-mode").value(o), label).toBe(updateModeOf(o));
    }
  });

  it("CPU and Memory: the first container's target in Sextant's units, sorted and filtered by the amount", () => {
    for (const [label, o] of [...vpaVariants(), ...conflictVpas()]) {
      const first = recommendationsOf(o)[0]?.target;
      for (const resource of ["cpu", "memory"] as const) {
        const id = `vpa-${resource}`;
        const amount = parseQuantity(first?.[resource]);
        // The built-in cell (`AmountCell`) and its sort value (`firstTarget`).
        expect(cell(id, o) || undefined, `${label} ${resource}`).toBe(amount === undefined ? undefined : formatAmount(resource, amount));
        expect(windowColumn(id).value(o), `${label} ${resource}`).toBe(amount);
      }
    }
    expect(cell("vpa-cpu", recreate())).toBe("587m");
    expect(cell("vpa-memory", recreate())).toBe("250MiB");
    expect(windowColumn("vpa-cpu").value(recreate())).toBeCloseTo(0.587);
    expect(cell("vpa-cpu", noPods())).toBeFalsy();
  });

  it("Checkpoints: the VPA, the container, the samples and when they were last saved", () => {
    expect(cell("cp-vpa", checkpoint())).toBe("hamster-vpa");
    expect(cell("cp-container", checkpoint())).toBe("hamster");
    expect(windowColumn("cp-samples").value(checkpoint())).toBe(4521);
    // A date and time in the UI language, as the built-in column's `formatDateTime`, sorted by the time.
    expect(cell("cp-last-update", checkpoint())).toBe(formatDateTime(at("2026-10-20T12:00:00Z")));
    expect(windowColumn("cp-last-update").value(checkpoint())).toBe(at("2026-10-20T12:00:00Z"));
  });
});
