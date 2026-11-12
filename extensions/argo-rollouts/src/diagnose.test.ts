/* eslint-disable @typescript-eslint/no-explicit-any -- the fixtures and the tool's JSON answer are read and edited in place */
// #341: the canary checks (safety.ts), where traffic goes (traffic.ts), the judges over the fields Sextant sends
// (judges.ts), the agent tool's diagnosis (diagnose.ts, agentTools.ts) and the Deployment section's reading (workload.ts).
import type { JsonValue, KubeObject } from "@sextant/extension-sdk";
import { describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import canaryJson from "../fixtures/rollout-canary-paused.json";
import replicaSetsJson from "../fixtures/replicasets.json";
import { answer, readArgs } from "./agentTools";
import { DEPLOYMENT, DESTINATION_RULE, EVENT, VIRTUAL_SERVICE, diagnose, templateRefs, type Reader } from "./diagnose";
import { JUDGE_IDS, TRAFFIC_FACTS, judge, rebuild, type JudgedObject } from "./judges";
import { ANALYSIS_RUN, ANALYSIS_TEMPLATE, REPLICA_SET, ROLLOUT, SERVICE } from "./model";
import { rolloutFindings, templateFindings, type SafetyCode } from "./safety";
import { trafficFindings, virtualServiceKey, type Found, type TrafficLookups } from "./traffic";
import { replicasMeaning, rolloutsOf } from "./workload";

const copy = <T>(value: T): T => structuredClone(value);
const canary = canaryJson as unknown as KubeObject;
const replicaSets = replicaSetsJson as unknown as KubeObject[];
const NS = "shop";
const NEW = "7d8c6f9b5";
const STABLE = "6c9f8b5d4";

/** The paused canary fixture routed by Istio through `vs` and `dr`, with the canary at `weight`. */
function istioRollout(weight = 20): KubeObject {
  const ro = copy(canary) as unknown as { spec: Record<string, any>; status: Record<string, any> };
  ro.spec.strategy.canary.canaryService = "shop-canary";
  ro.spec.strategy.canary.stableService = "shop-stable";
  ro.spec.strategy.canary.trafficRouting = {
    istio: {
      virtualService: { name: "shop-vs", routes: ["primary"] },
      destinationRule: { name: "shop-dr", canarySubsetName: "canary", stableSubsetName: "stable" },
    },
  };
  ro.status.canary = { weights: { canary: { weight, podTemplateHash: NEW }, stable: { weight: 100 - weight, podTemplateHash: STABLE } } };
  return ro as unknown as KubeObject;
}

const vs = (routes: unknown[] = [{ name: "primary", route: [{ destination: { host: "shop", subset: "stable" }, weight: 80 }, { destination: { host: "shop", subset: "canary" }, weight: 20 }] }]): KubeObject =>
  ({ apiVersion: "networking.istio.io/v1", kind: "VirtualService", metadata: { name: "shop-vs", namespace: NS, uid: "vs-1" }, spec: { http: routes } }) as unknown as KubeObject;

const dr = (canaryHash: string | undefined, stableHash: string | undefined, subsets = ["canary", "stable"]): KubeObject =>
  ({
    apiVersion: "networking.istio.io/v1",
    kind: "DestinationRule",
    metadata: { name: "shop-dr", namespace: NS, uid: "dr-1" },
    spec: {
      subsets: subsets.map((name) => {
        const hash = name === "canary" ? canaryHash : stableHash;
        return { name, labels: hash ? { app: "shop", "rollouts-pod-template-hash": hash } : { app: "shop" } };
      }),
    },
  }) as unknown as KubeObject;

const service = (name: string, hash: string): KubeObject =>
  ({ apiVersion: "v1", kind: "Service", metadata: { name, namespace: NS, uid: `svc-${name}` }, spec: { selector: { app: "shop", "rollouts-pod-template-hash": hash } } }) as unknown as KubeObject;

function lookups(objects: { vs?: Found; dr?: Found; canarySvc?: Found; stableSvc?: Found; available?: Record<string, number> }): TrafficLookups {
  return {
    virtualService: () => objects.vs,
    destinationRule: () => objects.dr,
    service: (_, name) => (name === "shop-canary" ? objects.canarySvc : objects.stableSvc),
    available: objects.available ? (hash) => objects.available![hash] ?? 0 : undefined,
  };
}

const codes = (list: { code: string }[]) => list.map((f) => f.code);

describe("where a canary's traffic goes", () => {
  it("reads a VirtualService reference as the controller does", () => {
    expect(virtualServiceKey("shop-vs", NS)).toEqual({ name: "shop-vs", namespace: NS });
    expect(virtualServiceKey("shop-vs.mesh", NS)).toEqual({ name: "shop-vs", namespace: "mesh" });
    // Only `.cluster.local` is cut, then the last part is the namespace: exactly what the controller reads.
    expect(virtualServiceKey("shop-vs.mesh.cluster.local", NS)).toEqual({ name: "shop-vs", namespace: "mesh" });
  });

  it("is fine while the subsets point at the new and the stable pods", () => {
    const found = trafficFindings(istioRollout(), lookups({ vs: vs(), dr: dr(NEW, STABLE), available: { [NEW]: 1, [STABLE]: 5 } }));
    expect(found).toEqual([]);
  });

  it("calls subsets on one hash a problem only while the canary has weight during an update", () => {
    const during = trafficFindings(istioRollout(20), lookups({ vs: vs(), dr: dr(STABLE, STABLE) }));
    expect(during).toEqual([{ code: "same-hash", level: "problem", values: { via: "subsets", hash: STABLE, weight: "20" } }]);
    // No weight yet: the controller switches the subset before it sets a weight, nothing is wrong.
    expect(codes(trafficFindings(istioRollout(0), lookups({ vs: vs(), dr: dr(STABLE, STABLE) })))).toEqual([]);
    // Fully promoted: both on the stable hash is normal.
    const done = istioRollout(0) as unknown as { status: Record<string, any> };
    done.status.currentPodHash = STABLE;
    const promoted = trafficFindings(done as unknown as KubeObject, lookups({ vs: vs(), dr: dr(STABLE, STABLE) }));
    expect(promoted).toEqual([{ code: "promoted-same-hash", level: "normal", values: { via: "subsets", hash: STABLE } }]);
  });

  it("checks the Services' selectors the same way", () => {
    const ro = istioRollout(30) as unknown as { spec: Record<string, any> };
    delete ro.spec.strategy.canary.trafficRouting.istio.destinationRule;
    const routes = [{ name: "primary", route: [{ destination: { host: "shop-stable" }, weight: 70 }, { destination: { host: "shop-canary.shop.svc.cluster.local" }, weight: 30 }] }];
    const same = trafficFindings(ro as unknown as KubeObject, lookups({ vs: vs(routes), canarySvc: service("shop-canary", STABLE), stableSvc: service("shop-stable", STABLE) }));
    expect(codes(same)).toEqual(["same-hash"]);
    expect(same[0]?.values.via).toBe("services");
    const fine = trafficFindings(ro as unknown as KubeObject, lookups({ vs: vs(routes), canarySvc: service("shop-canary", NEW), stableSvc: service("shop-stable", STABLE) }));
    expect(fine).toEqual([]);
  });

  it("names what the controller stops on: a missing route, object or subset, a route without both destinations", () => {
    expect(codes(trafficFindings(istioRollout(), lookups({ vs: null, dr: dr(NEW, STABLE) })))).toEqual(["virtual-service-missing"]);
    expect(codes(trafficFindings(istioRollout(), lookups({ vs: vs([{ name: "other", route: [] }]), dr: dr(NEW, STABLE) })))).toEqual(["route-missing"]);
    const onlyStable = vs([{ name: "primary", route: [{ destination: { host: "shop", subset: "stable" }, weight: 100 }] }]);
    expect(codes(trafficFindings(istioRollout(), lookups({ vs: onlyStable, dr: dr(NEW, STABLE) })))).toEqual(["route-without-canary"]);
    expect(codes(trafficFindings(istioRollout(), lookups({ vs: vs(), dr: null })))).toEqual(["destination-rule-missing"]);
    expect(codes(trafficFindings(istioRollout(), lookups({ vs: vs(), dr: dr(NEW, STABLE, ["stable"]) })))).toEqual(["subset-missing"]);
    // Several routes and none named: the controller cannot choose.
    const ro = istioRollout() as unknown as { spec: Record<string, any> };
    ro.spec.strategy.canary.trafficRouting.istio.virtualService.routes = [];
    const two = vs([{ name: "a", route: [] }, { name: "b", route: [] }]);
    expect(codes(trafficFindings(ro as unknown as KubeObject, lookups({ vs: two, dr: dr(NEW, STABLE) })))).toEqual(["route-not-chosen"]);
  });

  it("says nothing of what it cannot read", () => {
    expect(trafficFindings(istioRollout(), lookups({ vs: undefined, dr: undefined }))).toEqual([]);
  });

  it("tells a subset that carries traffic to a hash without available pods, and a canary subset not yet switched", () => {
    const found = trafficFindings(istioRollout(), lookups({ vs: vs(), dr: dr(NEW, STABLE), available: { [STABLE]: 5 } }));
    expect(found).toEqual([{ code: "no-pods", level: "problem", values: { via: "subsets", role: "canary", hash: NEW } }]);
    const stale = trafficFindings(istioRollout(), lookups({ vs: vs(), dr: dr("0000000000", STABLE) }));
    expect(codes(stale)).toEqual(["canary-not-new"]);
    expect(stale[0]?.level).toBe("warning");
  });
});

describe("how safe a canary is set up", () => {
  const metric = (m: Record<string, unknown>) => templateFindings({ metrics: [{ name: "m", provider: { prometheus: { query: "x" } }, ...m }] });
  const code = (list: { code: SafetyCode }[]) => list.map((f) => f.code);

  it("reads metrics as the controller evaluates them", () => {
    expect(code(metric({}))).toEqual(["metric-always-passes"]);
    expect(code(metric({ failureCondition: "result[0] > 0.05" }))).toEqual(["metric-nan-passes"]);
    expect(code(metric({ failureCondition: "isNaN(result[0]) || result[0] > 0.05" }))).toEqual([]);
    expect(code(metric({ successCondition: "result[0] < 0.05" }))).toEqual([]);
    expect(code(metric({ successCondition: "len(result) == 0 || result[0] < 0.05" }))).toEqual(["metric-no-data-passes"]);
    expect(code(metric({ successCondition: "default(result[0], 0) < 0.05" }))).toEqual(["metric-no-data-passes"]);
    expect(code(metric({ successCondition: "isNaN(result[0]) || result[0] < 0.05" }))).toEqual(["metric-nan-passes"]);
    // A job decides by itself.
    expect(templateFindings({ metrics: [{ name: "smoke", provider: { job: {} } }] })).toEqual([]);
  });

  it("finds a metric that cannot fail or runs dry", () => {
    expect(code(metric({ successCondition: "result[0] < 1", failureLimit: 3, count: 3 }))).toEqual(["metric-cannot-fail"]);
    expect(code(metric({ successCondition: "result[0] < 1", failureLimit: -1 }))).toEqual(["metric-cannot-fail"]);
    expect(code(metric({ successCondition: "result[0] < 1", failureLimit: 2, count: 5 }))).toEqual([]);
    // With a consecutiveSuccessLimit the metric can still fail.
    expect(code(metric({ successCondition: "result[0] < 1", failureLimit: -1, consecutiveSuccessLimit: 3 }))).toEqual([]);
    const dry = templateFindings({ dryRun: [{ metricName: ".*" }], metrics: [{ name: "m", provider: { prometheus: {} } }] });
    expect(code(dry)).toEqual(["metric-dry-run"]);
  });

  it("finds a Rollout promoted on time alone, or shifting weights without a check", () => {
    const steps = (s: unknown[], extra: Record<string, unknown> = {}) => rolloutFindings({ replicas: 5, strategy: { canary: { steps: s, ...extra } } });
    expect(code(steps([{ setWeight: 20 }, { pause: { duration: "1m" } }, { setWeight: 50 }]))).toEqual(["promoted-on-time"]);
    expect(code(steps([{ setWeight: 20 }, { pause: {} }, { setWeight: 50 }, { setWeight: 80 }]))).toEqual(["weights-without-check"]);
    expect(code(steps([{ setWeight: 20 }, { analysis: { templates: [] } }, { setWeight: 50 }]))).toEqual([]);
    expect(code(steps([{ setWeight: 100 }, { pause: {} }]))).toEqual(["first-step-full"]);
    // Background analysis guards every step.
    expect(code(steps([{ setWeight: 20 }, { setWeight: 50 }], { analysis: { templates: [{ templateName: "t" }] } }))).toEqual([]);
    expect(code(steps([{ setWeight: 20 }, { pause: {} }], { maxUnavailable: "100%" }))).toEqual(["all-pods-unavailable"]);
    expect(code(rolloutFindings({ strategy: { blueGreen: { activeService: "a" } } }))).toEqual(["promoted-on-time"]);
    expect(code(rolloutFindings({ strategy: { blueGreen: { activeService: "a", autoPromotionEnabled: false } } }))).toEqual([]);
  });
});

/** An object as Sextant sends it to a judge: the declared paths of its kind only. */
function judged(obj: KubeObject, paths: string[]): JudgedObject {
  const values: Record<string, unknown> = {};
  for (const p of paths) {
    let at: unknown = obj;
    for (const step of p.split(".").filter(Boolean)) at = at && typeof at === "object" ? (at as Record<string, unknown>)[step] : undefined;
    if (at !== undefined) values[p] = at;
  }
  const m = obj.metadata!;
  return { apiVersion: obj.apiVersion!, kind: obj.kind!, metadata: { name: m.name!, namespace: m.namespace, uid: m.uid! }, values };
}

const judgeOf = (id: string) => manifest.contributes.problemJudges.find((j) => j.id === id)!;
const pathsOf = (id: string, kind: string) => judgeOf(id).reads.find((r) => r.kind.kind === kind)!.paths;

describe("the problem judges", () => {
  it("are the manifest's, with its facts, and each fact has a rule", () => {
    expect(manifest.contributes.problemJudges.map((j) => j.id)).toEqual([...JUDGE_IDS]);
    expect(judgeOf("traffic").facts.map((f) => f.id)).toEqual([...TRAFFIC_FACTS]);
    for (const j of manifest.contributes.problemJudges) {
      for (const f of j.facts) {
        const used = manifest.contributes.problems.some((r) => JSON.stringify(r.when).includes(`"judge":"${j.id}","fact":"${f.id}"`));
        expect(used, `${j.id}/${f.id}`).toBe(true);
      }
    }
  });

  it("rebuild an object from its declared paths", () => {
    const ro = rebuild(judged(istioRollout(), pathsOf("traffic", "Rollout")));
    expect((ro as unknown as { spec: { strategy: unknown } }).spec.strategy).toEqual((istioRollout() as unknown as { spec: { strategy: unknown } }).spec.strategy);
  });

  it("tell the traffic facts from the fields Sextant sends, and nothing where a list was not read", () => {
    const objects = [
      judged(istioRollout(20), pathsOf("traffic", "Rollout")),
      judged(vs(), pathsOf("traffic", "VirtualService")),
      judged(dr(STABLE, STABLE), pathsOf("traffic", "DestinationRule")),
    ];
    const facts = judge("traffic", objects, () => true);
    expect(facts).toEqual([
      { uid: canary.metadata!.uid, fact: "same-hash", values: { via: "subsets", hash: STABLE, weight: "20" }, needs: [{ kind: DESTINATION_RULE, namespace: NS }] },
    ]);
    // The DestinationRule's namespace was not read: cannot tell that it is missing.
    const withoutRule = judge("traffic", objects.slice(0, 2), (kind) => kind.kind !== "DestinationRule");
    expect(withoutRule).toEqual([]);
    // Read and not there: missing.
    expect(judge("traffic", objects.slice(0, 2), () => true).map((f) => f.fact)).toEqual(["destination-rule-missing"]);
  });

  it("tell the safety facts of templates and Rollouts", () => {
    const template = { apiVersion: "argoproj.io/v1alpha1", kind: "AnalysisTemplate", metadata: { name: "t", namespace: NS, uid: "t-1" }, spec: { metrics: [{ name: "errors", failureCondition: "result[0] > 1", provider: { prometheus: {} } }] } } as unknown as KubeObject;
    const facts = judge("safety", [judged(template, pathsOf("safety", "AnalysisTemplate")), judged(canary, pathsOf("safety", "Rollout"))], () => true);
    // The fixture's canary pauses for a person after its first step: guarded, so only the template's metric is told.
    expect(facts).toEqual([{ uid: "t-1", fact: "metric-nan-passes", values: { metric: "errors" } }]);
  });
});

/** A reader over fixed objects; `refuse` names kinds whose reads throw `forbidden`. */
function reader(objects: KubeObject[], refuse: string[] = []): Reader {
  const kindOf = (o: KubeObject) => ({ group: (o.apiVersion ?? "").includes("/") ? o.apiVersion!.split("/")[0]! : "", kind: o.kind ?? "" });
  const fail = (kind: string) => {
    if (refuse.includes(kind)) throw Object.assign(new Error("forbidden"), { code: "forbidden" });
  };
  return {
    get(kind, namespace, name) {
      fail(kind.kind);
      return objects.find((o) => kindOf(o).kind === kind.kind && kindOf(o).group === kind.group && o.metadata?.name === name && (namespace === undefined || o.metadata?.namespace === namespace)) ?? null;
    },
    list(kind, namespace) {
      fail(kind.kind);
      return { items: objects.filter((o) => kindOf(o).kind === kind.kind && kindOf(o).group === kind.group && o.metadata?.namespace === namespace), truncated: false };
    },
  };
}

describe("the agent tool", () => {
  it("reads its arguments strictly", () => {
    expect(readArgs({ cluster: "c", namespace: NS, name: "rollout-canary" } as JsonValue)).toMatchObject({ name: "rollout-canary" });
    expect(() => readArgs({ cluster: "c", namespace: NS } as JsonValue)).toThrow(/exactly one/);
    expect(() => readArgs({ cluster: "c", namespace: NS, name: "a", deployment: "b" } as JsonValue)).toThrow(/exactly one/);
    expect(() => readArgs({ cluster: "c", namespace: NS, name: "a", extra: 1 } as JsonValue)).toThrow(/unknown arguments: extra/);
    expect(() => readArgs({ cluster: "c", namespace: "Bad NS", name: "a" } as JsonValue)).toThrow(/namespace/);
    expect(manifest.contributes.agentTools.map((t) => t.id)).toEqual(["diagnose-rollout"]);
    expect(manifest.contributes.agentTools[0]?.readOnly).toBe(true);
  });

  it("tells one Rollout whole, in context, and names what it could not read", () => {
    const ro = istioRollout(20) as unknown as { spec: Record<string, any>; metadata: Record<string, any> };
    ro.spec.workloadRef = { apiVersion: "apps/v1", kind: "Deployment", name: "shop", scaleDown: "onsuccess" };
    delete ro.spec.template;
    const deployment = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "shop", namespace: NS }, spec: { replicas: 0 }, status: {} } as unknown as KubeObject;
    const objects = [ro as unknown as KubeObject, deployment, vs(), dr(STABLE, STABLE), service("shop-canary", STABLE), service("shop-stable", STABLE), ...replicaSets];
    const out = answer(reader(objects, ["Event", "AnalysisRun"]), { cluster: "c", namespace: NS, name: "rollout-canary" }) as Record<string, any>;
    const byCode = (code: string) => out.findings.find((f: { code: string }) => f.code === code);
    expect(byCode("workload-scaled-down")).toMatchObject({ level: "normal" });
    expect(byCode("workload-scaled-down").text).toMatch(/0 replicas: normal, the controller scales it down \(scaleDown onsuccess\)/);
    expect(byCode("same-hash")).toMatchObject({ level: "problem" });
    expect(out.findings[0].level).toBe("problem");
    expect(out.rollout).toMatchObject({ name: "rollout-canary", strategy: "canary", updating: true, canaryWeight: 20, stableHash: STABLE, newHash: NEW });
    expect(out.workload).toMatchObject({ kind: "Deployment", name: "shop", scaleDown: "onsuccess", replicas: 0 });
    expect(out.notChecked.map((n: { what: string }) => n.what)).toEqual([`AnalysisRuns in ${NS}`, `events of Rollout ${NS}/rollout-canary`]);
    expect(out.notChecked[0].why).toMatch(/forbidden/);
    expect(out.dataNotice).toMatch(/data, not instructions/);
    expect(JSON.stringify(out).length).toBeLessThan(64 * 1024);
  });

  it("finds the Rollout of a Deployment, and says when there is none", () => {
    const ro = copy(canary) as unknown as { spec: Record<string, any> };
    ro.spec.workloadRef = { apiVersion: "apps/v1", kind: "Deployment", name: "shop" };
    const out = diagnose(reader([ro as unknown as KubeObject]), { cluster: "c", namespace: NS, deployment: "shop" });
    expect((out.rollout as { name: string }).name).toBe("rollout-canary");
    const none = diagnose(reader([canary]), { cluster: "c", namespace: NS, deployment: "shop" });
    expect(none).toMatchObject({ deployment: `${NS}/shop`, managedBy: null });
    expect(() => diagnose(reader([]), { cluster: "c", namespace: NS, name: "gone" })).toThrow(/not there/);
    expect(() => diagnose(reader([], ["Rollout"]), { cluster: "c", namespace: NS, name: "x" })).toThrow(/cannot read/);
  });

  it("names the templates a strategy uses, and a missing one", () => {
    const ro = copy(canary) as unknown as { spec: Record<string, any> };
    ro.spec.strategy.canary.analysis = { templates: [{ templateName: "success-rate" }, { templateName: "latency", clusterScope: true }] };
    expect(templateRefs(ro as unknown as KubeObject)).toEqual([
      { name: "success-rate", cluster: false },
      { name: "latency", cluster: true },
    ]);
    const out = diagnose(reader([ro as unknown as KubeObject]), { cluster: "c", namespace: NS, name: "rollout-canary" });
    expect((out.findings as { code: string }[]).filter((f) => f.code === "template-missing")).toHaveLength(2);
  });

  it("reads only the kinds the manifest lets it read", () => {
    const allowed = manifest.permissions.rules[0]!.kinds as { kinds: { group: string; kind: string }[] };
    for (const kind of [ROLLOUT, REPLICA_SET, ANALYSIS_RUN, ANALYSIS_TEMPLATE, SERVICE, DEPLOYMENT, EVENT, VIRTUAL_SERVICE, DESTINATION_RULE]) {
      expect(allowed.kinds, kind.kind).toContainEqual(kind);
    }
  });
});

describe("the Deployment section", () => {
  it("finds the Rollouts that take their template from a Deployment", () => {
    const ro = copy(canary) as unknown as { spec: Record<string, any> };
    ro.spec.workloadRef = { kind: "Deployment", name: "shop" };
    expect(rolloutsOf([ro as unknown as KubeObject, canary], "shop")).toHaveLength(1);
    expect(rolloutsOf([ro as unknown as KubeObject], "other")).toHaveLength(0);
  });

  it("reads the replica count by scaleDown, which the controller applies to the first revision only", () => {
    expect(replicasMeaning("onsuccess", 0, 3)).toBe("scaledDown");
    expect(replicasMeaning("never", 0, 1)).toBe("scaledByHand");
    expect(replicasMeaning("never", 3, 1)).toBe("runsBeside");
    expect(replicasMeaning("progressively", 3, 1)).toBe("willScaleDown");
    expect(replicasMeaning("onsuccess", 2, undefined)).toBe("willScaleDown");
    expect(replicasMeaning("onsuccess", 2, 3)).toBe("stays");
    expect(replicasMeaning("never", undefined, 1)).toBeUndefined();
  });

  it("is a hidden section on Deployments", () => {
    const section = manifest.contributes.detailsSections.find((s) => s.id === "managed-by-rollout")!;
    expect(section).toMatchObject({ kinds: [{ group: "apps", kind: "Deployment" }], placement: "section", startHidden: true });
  });
});
