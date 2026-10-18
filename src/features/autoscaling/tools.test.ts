import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { caNodeMarks, notTriggeredReasons, parseCaStatus, triggeredGroups } from "./clusterAutoscaler";
import {
  causeOf,
  disruptionOf,
  durationMs,
  isDisruptionEvent,
  launchProblem,
  limitRows,
  nodeClaimOf,
  nominationsOf,
  reachedLimits,
} from "./karpenter";
import { authSources, kedaState, managedHpaName, scaleTargetOf, stateWord, triggersOf } from "./keda";
import type { EventRow } from "./model";

const cond = (type: string, status: string, reason?: string) => ({ type, status, ...(reason ? { reason } : {}) });

// ---------- KEDA ----------

function scaledObject(extra: { annotations?: Record<string, string>; conditions?: unknown[]; spec?: Record<string, unknown>; status?: Record<string, unknown> } = {}): KubeObject {
  return {
    apiVersion: "keda.sh/v1alpha1",
    kind: "ScaledObject",
    metadata: { name: "orders", namespace: "shop", ...(extra.annotations ? { annotations: extra.annotations } : {}) },
    spec: {
      scaleTargetRef: { name: "orders-worker" },
      minReplicaCount: 1,
      maxReplicaCount: 20,
      triggers: [
        { type: "rabbitmq", metadata: { queueName: "orders", mode: "QueueLength", value: "20" }, authenticationRef: { name: "rabbit" } },
        { type: "cron", name: "office", metadata: { timezone: "Europe/Berlin", start: "0 8 * * *", end: "0 18 * * *", desiredReplicas: "3" } },
      ],
      ...extra.spec,
    },
    status: { conditions: extra.conditions ?? [], ...extra.status },
  };
}

describe("KEDA", () => {
  it("target, managed HPA and triggers with their health", () => {
    const so = scaledObject({ status: { health: { "s0-rabbitmq-orders": { numberOfFailures: 4, status: "Failure" } } } });
    expect(scaleTargetOf(so)).toEqual({ apiVersion: "apps/v1", kind: "Deployment", name: "orders-worker" });
    expect(managedHpaName(so)).toBe("keda-hpa-orders");
    expect(managedHpaName(scaledObject({ status: { hpaName: "custom" } }))).toBe("custom");
    const triggers = triggersOf(so);
    expect(triggers[0]).toMatchObject({ type: "rabbitmq", auth: { kind: "TriggerAuthentication", name: "rabbit" }, failures: 4, health: "Failure" });
    expect(triggers[0]?.metadata).toEqual(["queueName=orders", "mode=QueueLength", "value=20"]);
    expect(triggers[1]).toMatchObject({ type: "cron", name: "office" });
    expect(triggers[1]?.failures).toBeUndefined();
  });

  it.each([
    ["active", [cond("Ready", "True"), cond("Active", "True")], {}, ["keda.active"], "Active"],
    ["inactive, kept at min", [cond("Ready", "True"), cond("Active", "False")], {}, ["keda.inactive"], "Inactive"],
    ["inactive, scaled to idle", [cond("Ready", "True"), cond("Active", "False")], { spec: { idleReplicaCount: 0 } }, ["keda.inactiveIdle"], "Inactive"],
    ["not ready", [cond("Ready", "False", "ScaledObjectCheckFailed"), cond("Active", "False")], {}, ["keda.notReady", "keda.inactive"], "ScaledObjectCheckFailed"],
    ["paused by annotation", [cond("Ready", "True"), cond("Active", "False")], { annotations: { "autoscaling.keda.sh/paused": "true" } }, ["keda.paused"], "Paused"],
    ["paused at replicas", [cond("Ready", "True")], { annotations: { "autoscaling.keda.sh/paused-replicas": "2" } }, ["keda.pausedAt"], "Paused"],
    ["fallback", [cond("Ready", "True"), cond("Active", "True"), cond("Fallback", "True")], { spec: { fallback: { failureThreshold: 3, replicas: 6 } } }, ["keda.fallback", "keda.active"], "Fallback"],
  ])("%s", (_name, conditions, extra, keys, word) => {
    const so = scaledObject({ conditions, ...(extra as object) });
    expect(kedaState(so).phrases.map((p) => p.key)).toEqual(keys);
    expect(stateWord(so)).toBe(word);
  });

  it("a failing trigger is named", () => {
    const so = scaledObject({ conditions: [cond("Ready", "True"), cond("Active", "False")], status: { health: { "s1-cron": { numberOfFailures: 2, status: "Failure" } } } });
    expect(kedaState(so).phrases[0]).toEqual({ key: "keda.triggerFailing", params: { trigger: "office", count: 2 }, tone: "danger" });
  });

  it("a ScaledJob's state", () => {
    const job: KubeObject = { spec: { maxReplicaCount: 5, triggers: [] }, status: { conditions: [cond("Ready", "True"), cond("Active", "True")] } };
    expect(kedaState(job, true).phrases).toEqual([{ key: "keda.jobActive", params: { max: 5 }, tone: "success" }]);
  });

  it("a TriggerAuthentication's sources, never values", () => {
    const auth: KubeObject = {
      spec: {
        secretTargetRef: [{ parameter: "host", name: "rabbit", key: "url" }],
        env: [{ parameter: "region", name: "AWS_REGION" }],
        podIdentity: { provider: "aws" },
        hashiCorpVault: { address: "https://vault", credentials: [{ parameter: "token", path: "secret/rabbit" }] },
      },
    };
    expect(authSources(auth)).toEqual({
      sources: [
        { parameter: "host", from: "Secret", name: "rabbit", key: "url" },
        { parameter: "region", from: "env", name: "AWS_REGION" },
        { parameter: "token", from: "hashiCorpVault", name: "secret/rabbit" },
      ],
      podIdentity: "aws",
    });
  });
});

// ---------- Karpenter ----------

describe("Karpenter", () => {
  const pool: KubeObject = {
    metadata: { name: "default" },
    spec: {
      limits: { cpu: "100", memory: "400Gi" },
      disruption: { consolidationPolicy: "WhenEmptyOrUnderutilized", consolidateAfter: "1m", budgets: [{ nodes: "10%" }] },
      template: { spec: { expireAfter: "720h", nodeClassRef: { group: "karpenter.k8s.aws", kind: "EC2NodeClass", name: "default" } } },
    },
    status: { resources: { cpu: "100", memory: "350Gi", nodes: "12" } },
  };

  it("limits against what the NodePool launched", () => {
    expect(limitRows(pool)).toEqual([
      { resource: "cpu", limit: "100", used: "100", reached: true },
      { resource: "memory", limit: "400GiB", used: "350GiB", reached: false },
    ]);
    expect(reachedLimits(pool)).toEqual(["cpu"]);
  });

  it.each([
    ["720h", 720 * 3_600_000],
    ["1h30m", 5_400_000],
    ["45s", 45_000],
    ["Never", undefined],
    ["soon", undefined],
  ])("duration %s", (text, ms) => {
    expect(durationMs(text)).toBe(ms);
  });

  it("launch problems in order: launched, registered, initialized", () => {
    const claim = (...conditions: unknown[]): KubeObject => ({ status: { conditions } });
    expect(launchProblem(claim())?.key).toBe("karpenter.launching");
    expect(launchProblem(claim(cond("Launched", "False", "InsufficientCapacityError")))).toEqual({
      key: "karpenter.notLaunched",
      params: { reason: "InsufficientCapacityError" },
      tone: "danger",
    });
    expect(launchProblem(claim(cond("Launched", "True"), cond("Registered", "Unknown", "AwaitingReconciliation")))?.key).toBe("karpenter.notRegistered");
    expect(launchProblem(claim(cond("Launched", "True"), cond("Registered", "True"), cond("Initialized", "True")))).toBeUndefined();
  });

  it("disruption: drift, consolidation, the taint, do-not-disrupt and expiry", () => {
    const node: KubeObject = {
      metadata: { name: "ip-10-0-1-1", annotations: { "karpenter.sh/do-not-disrupt": "true" } },
      spec: { providerID: "aws:///eu-west-1a/i-1", taints: [{ key: "karpenter.sh/disrupted", effect: "NoSchedule" }] },
    };
    const claim: KubeObject = {
      metadata: { name: "default-abcde", creationTimestamp: "2026-10-01T00:00:00Z", labels: { "karpenter.sh/nodepool": "default" } },
      status: { providerID: "aws:///eu-west-1a/i-1", conditions: [cond("Drifted", "True", "NodeClassDrift"), cond("Consolidatable", "True")] },
    };
    expect(nodeClaimOf(node, [claim])).toBe(claim);
    expect(disruptionOf(node, claim, pool)).toEqual([
      { key: "karpenter.disrupting", tone: "warning" },
      { key: "karpenter.drifted", params: { reason: "NodeClassDrift" }, tone: "warning" },
      { key: "karpenter.consolidatable", params: { policy: "WhenEmptyOrUnderutilized" }, tone: "neutral" },
      { key: "karpenter.doNotDisrupt", params: { annotation: "karpenter.sh/do-not-disrupt" }, tone: "neutral" },
      { key: "karpenter.expiresAt", params: { time: "2026-10-31T00:00:00.000Z" }, tone: "neutral" },
    ]);
  });

  const event = (reason: string, message: string, source = "karpenter"): EventRow => ({
    uid: reason,
    reason,
    message,
    type: "Normal",
    source,
    count: 1,
    involvedKind: "Pod",
    involvedName: "web-1",
  });

  it("events: disruption causes and nominations", () => {
    expect(causeOf("Disrupting NodeClaim: Drifted/Replace")).toBe("drift");
    expect(causeOf("Disrupting Node: Underutilized/Delete")).toBe("consolidation");
    expect(causeOf("Disrupting Node: Empty/Delete")).toBe("emptiness");
    expect(causeOf("Disrupting Node: Expired/Replace")).toBe("expiration");
    expect(isDisruptionEvent(event("DisruptionTerminating", "Disrupting Node: Empty/Delete"))).toBe(true);
    expect(isDisruptionEvent(event("Unconsolidatable", "SpotToSpotConsolidation is disabled"))).toBe(true);
    expect(isDisruptionEvent(event("Nominated", "Pod should schedule on: nodeclaim/default-x"))).toBe(false);
    expect(nominationsOf([event("Nominated", "Pod should schedule on: nodeclaim/default-x7k2p, node/ip-10-0-1-1")])).toEqual({
      claims: ["default-x7k2p"],
      nodes: ["ip-10-0-1-1"],
    });
  });
});

// ---------- Cluster Autoscaler ----------

describe("Cluster Autoscaler", () => {
  it("reads the YAML status (1.30+)", () => {
    const status = `time: 2026-10-19 10:00:00.123 +0000 UTC
autoscalerStatus: Running
clusterWide:
  health:
    status: Healthy
    nodeCounts:
      registered: {total: 5, ready: 4, notStarted: 0}
  scaleUp:
    status: InProgress
  scaleDown:
    status: NoCandidates
nodeGroups:
- name: eks-general
  health:
    status: Healthy
    nodeCounts:
      registered: {total: 3, ready: 3}
    cloudProviderTarget: 4
    minSize: 1
    maxSize: 10
  scaleUp:
    status: InProgress
  scaleDown:
    status: NoCandidates
`;
    expect(parseCaStatus({ data: { status } })).toEqual({
      time: "2026-10-19 10:00:00.123 +0000 UTC",
      autoscalerStatus: "Running",
      health: "Healthy",
      scaleUp: "InProgress",
      scaleDown: "NoCandidates",
      ready: 4,
      registered: 5,
      groups: [{ name: "eks-general", health: "Healthy", scaleUp: "InProgress", scaleDown: "NoCandidates", ready: 3, registered: 3, target: 4, min: 1, max: 10 }],
    });
  });

  it("reads the older text status", () => {
    const status = `Cluster-autoscaler status at 2024-01-01 10:00:00.0 +0000 UTC:
Cluster-wide:
  Health:      Healthy (ready=3 unready=0 (resourceUnready=0) notStarted=0 longNotStarted=0 registered=3 longUnregistered=0)
               LastProbeTime:      2024-01-01 10:00:00
  ScaleUp:     NoActivity (ready=3 registered=3)
  ScaleDown:   CandidatesPresent (candidates=1)

NodeGroups:
  Name:        ng-1
  Health:      Healthy (ready=3 unready=0 notStarted=0 longNotStarted=0 registered=3 longUnregistered=0 cloudProviderTarget=3 (minSize=1, maxSize=5))
  ScaleUp:     NoActivity (ready=3 cloudProviderTarget=3)
  ScaleDown:   CandidatesPresent (candidates=1)
`;
    expect(parseCaStatus({ data: { status } })).toEqual({
      time: "2024-01-01 10:00:00.0 +0000 UTC",
      health: "Healthy",
      scaleUp: "NoActivity",
      scaleDown: "CandidatesPresent",
      ready: 3,
      registered: 3,
      groups: [{ name: "ng-1", health: "Healthy", scaleUp: "NoActivity", scaleDown: "CandidatesPresent", ready: 3, registered: 3, target: 3, min: 1, max: 5 }],
    });
  });

  it("events and node marks", () => {
    expect(triggeredGroups("pod triggered scale-up: [{eks-general 3->4 (max: 10)} {eks-gpu 0->1 (max: 2)}]")).toEqual([
      { group: "eks-general", from: 3, to: 4, max: 10 },
      { group: "eks-gpu", from: 0, to: 1, max: 2 },
    ]);
    expect(notTriggeredReasons("pod didn't trigger scale-up: 1 max node group size reached, 2 node(s) had untolerated taint {dedicated: gpu}").map((r) => r.code)).toEqual([
      "maxGroupSize",
      "taint",
    ]);
    expect(
      caNodeMarks({
        metadata: { annotations: { "cluster-autoscaler.kubernetes.io/scale-down-disabled": "true" } },
        spec: { taints: [{ key: "DeletionCandidateOfClusterAutoscaler", value: "1700000000", effect: "PreferNoSchedule" }] },
      }).map((p) => p.key),
    ).toEqual(["ca.candidate", "ca.scaleDownDisabled"]);
    expect(caNodeMarks({ spec: { taints: [{ key: "ToBeDeletedByClusterAutoscaler", effect: "NoSchedule" }] } }).map((p) => p.key)).toEqual(["ca.toBeDeleted"]);
  });
});
