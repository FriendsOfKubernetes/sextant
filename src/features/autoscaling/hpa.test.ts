import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { analyzeHpa, metricCauses, proposal, requestChecks, rescaleOf, stepLimit, type DirectionBehavior } from "./hpa";

interface HpaInput {
  min?: number;
  max?: number;
  current?: number;
  desired?: number;
  metrics?: unknown[];
  currentMetrics?: unknown[];
  conditions?: { type: string; status: string; reason?: string; message?: string }[];
  behavior?: unknown;
}

function hpa(i: HpaInput): KubeObject {
  return {
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
    metadata: { name: "web", namespace: "shop", uid: "h1" },
    spec: {
      scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "web" },
      ...(i.min !== undefined ? { minReplicas: i.min } : {}),
      maxReplicas: i.max ?? 10,
      metrics: i.metrics ?? [],
      ...(i.behavior ? { behavior: i.behavior } : {}),
    },
    status: {
      currentReplicas: i.current ?? 2,
      desiredReplicas: i.desired ?? i.current ?? 2,
      currentMetrics: i.currentMetrics ?? [],
      conditions: i.conditions ?? [],
    },
  };
}

const cpu = (target: number) => ({ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: target } } });
const cpuNow = (value: number) => ({ type: "Resource", resource: { name: "cpu", current: { averageUtilization: value, averageValue: "120m" } } });
const ok = (type: string, reason: string, status = "True", message?: string) => ({ type, status, reason, ...(message ? { message } : {}) });
const healthy = [ok("AbleToScale", "ReadyForNewScale"), ok("ScalingActive", "ValidMetricFound"), ok("ScalingLimited", "DesiredWithinRange", "False")];

describe("one metric's proposal (the controller's formula)", () => {
  it.each([
    // ratio, current replicas, expected replicas, within tolerance
    [1.0, 3, 3, true],
    [1.09, 3, 3, true],
    [1.1, 3, 4, false], // 55/50: 1.1 − 1 is a hair above 0.1 in floating point, as in the controller
    [0.9, 3, 3, true],
    [1.8, 2, 4, false], // ceil(3.6)
    [0.5, 4, 2, false],
    [0.34, 3, 2, false], // ceil(1.02)
    [2.0, 5, 10, false],
  ])("ratio %s with %s replicas → %s", (ratio, current, replicas, within) => {
    expect(proposal(ratio, current, 0.1, 0.1)).toEqual({ replicas, within });
  });

  it("no value, or no replicas, proposes nothing", () => {
    expect(proposal(undefined, 3, 0.1, 0.1)).toEqual({});
    expect(proposal(1.5, 0, 0.1, 0.1)).toEqual({});
  });

  it("separate tolerances up and down", () => {
    expect(proposal(1.04, 10, 0.05, 0.2).within).toBe(true);
    expect(proposal(1.06, 10, 0.05, 0.2)).toEqual({ replicas: 11, within: false });
    expect(proposal(0.85, 10, 0.05, 0.2).within).toBe(true);
  });
});

describe("analyzeHpa", () => {
  const cases: { name: string; input: HpaInput; verdict: string; params?: Record<string, unknown>; estimate?: unknown }[] = [
    {
      name: "CPU above target: scaling up",
      input: { current: 2, desired: 4, metrics: [cpu(50)], currentMetrics: [cpuNow(90)], conditions: healthy },
      verdict: "verdict.scaling",
      params: { count: 4, from: 2 },
      estimate: { wanted: 4, replicas: 4, heldByMissing: false },
    },
    {
      name: "within tolerance: steady",
      input: { current: 3, metrics: [cpu(50)], currentMetrics: [cpuNow(54)], conditions: healthy },
      verdict: "verdict.steady",
      params: { count: 3 },
      estimate: { wanted: 3, replicas: 3, heldByMissing: false },
    },
    {
      name: "at maxReplicas",
      input: {
        current: 5,
        max: 5,
        metrics: [cpu(50)],
        currentMetrics: [cpuNow(100)],
        conditions: [ok("AbleToScale", "ReadyForNewScale"), ok("ScalingActive", "ValidMetricFound"), ok("ScalingLimited", "TooManyReplicas")],
      },
      verdict: "verdict.atMax",
      params: { count: 5, wanted: 10 },
      estimate: { wanted: 10, replicas: 5, limitedBy: "max", heldByMissing: false },
    },
    {
      name: "at minReplicas",
      input: {
        current: 2,
        min: 2,
        metrics: [cpu(50)],
        currentMetrics: [cpuNow(10)],
        conditions: [ok("AbleToScale", "ReadyForNewScale"), ok("ScalingActive", "ValidMetricFound"), ok("ScalingLimited", "TooFewReplicas")],
      },
      verdict: "verdict.atMin",
      params: { count: 2, wanted: 1 },
    },
    {
      name: "scale-down stabilization holds the count",
      input: {
        current: 6,
        metrics: [cpu(50)],
        currentMetrics: [cpuNow(20)],
        conditions: [ok("AbleToScale", "ScaleDownStabilized"), ok("ScalingActive", "ValidMetricFound"), ok("ScalingLimited", "DesiredWithinRange", "False")],
      },
      verdict: "verdict.stabilizedDown",
      params: { count: 6 },
    },
    {
      name: "metrics cannot be read",
      input: {
        current: 2,
        metrics: [cpu(50)],
        conditions: [ok("AbleToScale", "SucceededGetScale"), ok("ScalingActive", "FailedGetResourceMetric", "False", "the HPA was unable to compute the replica count")],
      },
      verdict: "verdict.noMetrics",
    },
    {
      name: "scaled to zero",
      input: { current: 0, metrics: [cpu(50)], conditions: [ok("ScalingActive", "ScalingDisabled", "False")] },
      verdict: "verdict.disabled",
    },
    {
      name: "target missing",
      input: { current: 2, metrics: [cpu(50)], conditions: [ok("AbleToScale", "FailedGetScale", "False")] },
      verdict: "verdict.cannotScale",
    },
    {
      name: "backoff after a change",
      input: { current: 3, metrics: [cpu(50)], conditions: [ok("AbleToScale", "BackoffBoth", "False")] },
      verdict: "verdict.backoff",
      params: { count: 3 },
    },
    {
      name: "a scale-up policy limits the step",
      input: { current: 2, desired: 6, metrics: [cpu(50)], currentMetrics: [cpuNow(500)], conditions: [ok("ScalingLimited", "ScaleUpLimit")] },
      verdict: "verdict.upLimit",
      params: { count: 6 },
      // Default scale-up policies from 2: max(100 % → 4, 4 Pods → 6) = 6.
      estimate: { wanted: 20, replicas: 6, limitedBy: "upPolicy", heldByMissing: false },
    },
    {
      name: "no status yet",
      input: { current: 0, desired: 0, metrics: [cpu(50)] },
      verdict: "verdict.noStatus",
    },
    {
      name: "one metric missing and the other would scale down: held",
      input: {
        current: 4,
        metrics: [cpu(50), { type: "Pods", pods: { metric: { name: "rps" }, target: { type: "AverageValue", averageValue: "10" } } }],
        currentMetrics: [cpuNow(10)],
        conditions: healthy,
      },
      verdict: "verdict.heldByMissing",
      params: { count: 4 },
      estimate: { wanted: 4, replicas: 4, heldByMissing: true },
    },
  ];

  it.each(cases)("$name", ({ input, verdict, params, estimate }) => {
    const a = analyzeHpa(hpa(input));
    expect(a.verdict.key).toBe(verdict);
    if (params) expect(a.verdict.params).toEqual(params);
    if (estimate) expect(a.estimate).toEqual(estimate);
  });

  it("the largest proposal of several metrics wins", () => {
    const a = analyzeHpa(
      hpa({
        current: 4,
        metrics: [
          cpu(50),
          { type: "Resource", resource: { name: "memory", target: { type: "AverageValue", averageValue: "1Gi" } } },
          { type: "External", external: { metric: { name: "queue", selector: { matchLabels: { q: "orders" } } }, target: { type: "AverageValue", averageValue: "30" } } },
          { type: "Object", object: { metric: { name: "rps" }, describedObject: { kind: "Ingress", name: "main" }, target: { type: "Value", value: "100" } } },
          { type: "ContainerResource", containerResource: { name: "cpu", container: "app", target: { type: "Utilization", averageUtilization: 60 } } },
        ],
        currentMetrics: [
          cpuNow(25),
          { type: "Resource", resource: { name: "memory", current: { averageValue: "512Mi" } } },
          { type: "External", external: { metric: { name: "queue" }, current: { averageValue: "90" } } },
          { type: "Object", object: { metric: { name: "rps" }, describedObject: { kind: "Ingress", name: "main" }, current: { value: "150" } } },
          { type: "ContainerResource", containerResource: { name: "cpu", container: "app", current: { averageUtilization: 60 } } },
        ],
        conditions: healthy,
      }),
    );
    expect(a.metrics.map((m) => [m.source, m.name, m.currentText, m.targetText, m.proposes])).toEqual([
      ["Resource", "cpu", "25%", "50%", 2],
      ["Resource", "memory", "512MiB", "1.00GiB", 2],
      ["External", "queue", "90", "30", 12],
      ["Object", "rps", "150", "100", 6],
      ["ContainerResource", "cpu", "60%", "60%", 4],
    ]);
    expect(a.metrics[2]?.selector).toBe("q=orders");
    expect(a.metrics[3]?.object).toBe("Ingress/main");
    expect(a.metrics[4]?.container).toBe("app");
    // 12 is above maxReplicas 10, and one default scale-up step from 4 reaches 8 (100 % or 4 Pods).
    expect(a.estimate).toEqual({ wanted: 12, replicas: 8, limitedBy: "upPolicy", heldByMissing: false });
  });

  it.each([
    // current below minReplicas: straight to the minimum, whatever the metrics ask (reconcileAutoscaler).
    ["below min", { current: 1, min: 3, currentMetrics: [cpuNow(10)] }, { wanted: 1, replicas: 3, limitedBy: "min", heldByMissing: false }],
    // current above maxReplicas: straight to the maximum.
    ["above max", { current: 12, max: 10, currentMetrics: [cpuNow(100)] }, { wanted: 24, replicas: 10, limitedBy: "max", heldByMissing: false }],
    // Scale-down step: 50 % per period from 5 allows int32(2.5) = 2.
    [
      "down step",
      { current: 5, min: 1, currentMetrics: [cpuNow(5)], behavior: { scaleDown: { policies: [{ type: "Percent", value: 50, periodSeconds: 60 }] } } },
      { wanted: 1, replicas: 2, limitedBy: "downPolicy", heldByMissing: false },
    ],
    // The bound is tighter than the step: minReplicas wins.
    ["down to min", { current: 5, min: 4, currentMetrics: [cpuNow(5)] }, { wanted: 1, replicas: 4, limitedBy: "min", heldByMissing: false }],
  ])("the estimate's direction and limits: %s", (_name, input, expected) => {
    expect(analyzeHpa(hpa({ metrics: [cpu(50)], conditions: healthy, ...(input as HpaInput) })).estimate).toEqual(expected);
  });

  it("behavior: the API defaults when unset, the object's own otherwise", () => {
    const plain = analyzeHpa(hpa({}));
    expect(plain.up).toMatchObject({ windowSeconds: 0, windowIsDefault: true, selectPolicy: "Max", tolerance: 0.1 });
    expect(plain.down).toMatchObject({ windowSeconds: 300, windowIsDefault: true, policies: [{ type: "Percent", value: 100, periodSeconds: 15 }] });
    const tuned = analyzeHpa(
      hpa({
        behavior: {
          scaleUp: { stabilizationWindowSeconds: 60, selectPolicy: "Min", policies: [{ type: "Pods", value: 2, periodSeconds: 60 }], tolerance: "0.05" },
          scaleDown: { selectPolicy: "Disabled" },
        },
      }),
    );
    expect(tuned.up).toMatchObject({ windowSeconds: 60, windowIsDefault: false, selectPolicy: "Min", tolerance: 0.05 });
    expect(tuned.down.selectPolicy).toBe("Disabled");
  });

  it("conditions get plain reasons and tones", () => {
    const a = analyzeHpa(
      hpa({ conditions: [ok("AbleToScale", "ScaleDownStabilized"), ok("ScalingActive", "FailedGetResourceMetric", "False"), ok("ScalingLimited", "TooManyReplicas")] }),
    );
    expect(a.conditions.map((c) => [c.type, c.explanation?.key, c.tone])).toEqual([
      ["AbleToScale", "hpaReason.ScaleDownStabilized", "warning"],
      ["ScalingActive", "hpaReason.FailedGetResourceMetric", "danger"],
      ["ScalingLimited", "hpaReason.TooManyReplicas", "warning"],
    ]);
  });
});

describe("causes read from the controller's messages", () => {
  it.each([
    [
      "failed to get cpu utilization: missing request for cpu in container istio-proxy of Pod web-6d4-x",
      [{ key: "cause.missingRequest", params: { resource: "cpu", container: "istio-proxy", pod: "web-6d4-x" }, tone: "danger" }],
    ],
    [
      "unable to get metrics for resource cpu: unable to fetch metrics from resource metrics API: the server could not find the requested resource (get pods.metrics.k8s.io)",
      [{ key: "cause.noMetricsServer", tone: "danger" }],
    ],
    [
      "unable to get external metric shop/s0-rabbitmq/&LabelSelector{}: unable to fetch metrics from external metrics API: the server is currently unable to handle the request (get external.metrics.k8s.io)",
      [{ key: "cause.noExternalMetrics", tone: "danger" }],
    ],
    [
      "unable to get metric http_requests: unable to fetch metrics from custom metrics API: the server could not find the metric http_requests for pods",
      [{ key: "cause.metricNotFound", tone: "danger" }],
    ],
    ["did not receive metrics for targeted pods (pods might be unready)", [{ key: "cause.noPodMetrics", tone: "warning" }]],
    ["recommended size matches current size", []],
  ])("%s", (message, causes) => {
    expect(metricCauses(message)).toEqual(causes);
  });

  it("an HPA lists each cause once", () => {
    const message = "missing request for cpu in container app of Pod web-1";
    const a = analyzeHpa(hpa({ conditions: [ok("ScalingActive", "FailedGetResourceMetric", "False", message), ok("AbleToScale", "SucceededGetScale")] }));
    expect(a.causes).toHaveLength(1);
  });
});

describe("step limits of the policies", () => {
  const b = (policies: DirectionBehavior["policies"], selectPolicy = "Max"): DirectionBehavior => ({
    windowSeconds: 0,
    windowIsDefault: true,
    selectPolicy,
    policies,
    tolerance: 0.1,
  });
  const defaults = b([
    { type: "Percent", value: 100, periodSeconds: 15 },
    { type: "Pods", value: 4, periodSeconds: 15 },
  ]);
  it.each([
    [defaults, 2, true, 6],
    [defaults, 10, true, 20],
    [b(defaults.policies, "Min"), 10, true, 14],
    [b([{ type: "Percent", value: 50, periodSeconds: 60 }]), 10, false, 5],
    // Scale-down Percent truncates: int32(5 * (1 - 50/100)) = int32(2.5) = 2 (calculateScaleDownLimitWithBehaviors).
    [b([{ type: "Percent", value: 50, periodSeconds: 60 }]), 5, false, 2],
    // Scale-up Percent rounds up: int32(math.Ceil(5 * (1 + 50/100))) = 8.
    [b([{ type: "Percent", value: 50, periodSeconds: 60 }]), 5, true, 8],
    [b([{ type: "Pods", value: 1, periodSeconds: 60 }]), 10, false, 9],
    [b([], "Disabled"), 7, true, 7],
  ])("%#", (behavior, current, up, limit) => {
    expect(stepLimit(behavior, current, up)).toBe(limit);
  });
});

describe("the target's requests", () => {
  const template = (containers: unknown[]) => ({ spec: { containers } });
  it.each([
    ["every container requests cpu", [cpu(50)], [{ name: "app", resources: { requests: { cpu: "100m" } } }], [{ resource: "cpu", without: [] }]],
    [
      "a sidecar without a request",
      [cpu(50)],
      [{ name: "app", resources: { requests: { cpu: "100m" } } }, { name: "proxy" }],
      [{ resource: "cpu", without: ["proxy"] }],
    ],
    ["a limit stands for the request", [cpu(50)], [{ name: "app", resources: { limits: { cpu: "1" } } }], [{ resource: "cpu", without: [] }]],
    [
      "a container metric checks only its container",
      [{ type: "ContainerResource", containerResource: { name: "memory", container: "app", target: { type: "Utilization", averageUtilization: 70 } } }],
      [{ name: "app" }, { name: "proxy", resources: { requests: { memory: "64Mi" } } }],
      [{ resource: "memory", without: ["app"], container: "app" }],
    ],
    [
      "value targets need no requests",
      [{ type: "Resource", resource: { name: "cpu", target: { type: "AverageValue", averageValue: "500m" } } }],
      [{ name: "app" }],
      [],
    ],
  ])("%s", (_name, metrics, containers, checks) => {
    expect(requestChecks(hpa({ metrics }), template(containers))).toEqual(checks);
  });
});

it("reads a SuccessfulRescale message", () => {
  expect(rescaleOf("New size: 5; reason: cpu resource utilization (percentage of request) above target")).toEqual({
    size: 5,
    reason: "cpu resource utilization (percentage of request) above target",
  });
  expect(rescaleOf("something else")).toBeUndefined();
});
