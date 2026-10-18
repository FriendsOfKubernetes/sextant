import { describe, expect, it } from "vitest";
import type { KindRef, KubeObject } from "../../api";
import { APPLICATION } from "../argocd/model";
import { KUSTOMIZATION } from "../flux/model";
import { HTTP_ROUTE } from "../gateway-api/model";
import {
  CERT_EXPIRY_WARNING_MS,
  CERTIFICATE,
  DAEMONSET,
  DEPLOYMENT,
  detect,
  EVENT,
  isActive,
  JOB,
  LONG_GRACE_MS,
  NODE,
  POD,
  PVC,
  RECENT_RESTART_MS,
  resolve,
  ROLLOUT_STALL_MS,
  SHORT_GRACE_MS,
  STATEFULSET,
} from "./model";

const T0 = "2026-10-18T10:00:00Z";
const SELECTED = "volume.kubernetes.io/selected-node";
const T0_MS = Date.parse(T0);

const meta = (name = "x", namespace: string | null = "demo") => ({
  name,
  uid: `uid-${name}`,
  ...(namespace ? { namespace } : {}),
  creationTimestamp: T0,
});

const pod = (status: Record<string, unknown>, extra: Partial<KubeObject> = {}): KubeObject => ({
  metadata: meta("web"),
  status,
  ...extra,
});

const container = (state: Record<string, unknown>, lastState: Record<string, unknown> = {}, restartCount = 0) => ({
  name: "app",
  ready: false,
  restartCount,
  state,
  lastState,
});

const cond = (type: string, status: string, extra: Record<string, unknown> = {}) => ({
  type,
  status,
  lastTransitionTime: T0,
  ...extra,
});

interface Case {
  name: string;
  kind: KindRef;
  obj: KubeObject;
  /** The reasons found, in order; [] for none. */
  reasons: string[];
  notify?: boolean[];
  group?: string;
}

const CASES: Case[] = [
  // ---- pods ----
  {
    name: "a running ready pod is fine",
    kind: POD,
    obj: pod({ phase: "Running", conditions: [cond("Ready", "True")], containerStatuses: [container({ running: {} })] }),
    reasons: [],
  },
  {
    name: "CrashLoopBackOff",
    kind: POD,
    obj: pod({
      phase: "Running",
      containerStatuses: [
        container({ waiting: { reason: "CrashLoopBackOff", message: "back-off 5m" } }, { terminated: { reason: "Error", finishedAt: T0 } }, 7),
      ],
    }),
    reasons: ["CrashLoopBackOff"],
    notify: [true],
    group: "crash",
  },
  {
    name: "a crash loop of OOM kills is OOMKilled",
    kind: POD,
    obj: pod({
      phase: "Running",
      containerStatuses: [container({ waiting: { reason: "CrashLoopBackOff" } }, { terminated: { reason: "OOMKilled", finishedAt: T0 } }, 3)],
    }),
    reasons: ["OOMKilled"],
    notify: [true],
  },
  {
    name: "ErrImagePull and ImagePullBackOff are one state",
    kind: POD,
    obj: pod({ phase: "Pending", containerStatuses: [container({ waiting: { reason: "ErrImagePull" } })] }),
    reasons: ["ImagePullBackOff"],
    notify: [true],
  },
  {
    name: "ImagePullBackOff",
    kind: POD,
    obj: pod({ phase: "Pending", containerStatuses: [container({ waiting: { reason: "ImagePullBackOff" } })] }),
    reasons: ["ImagePullBackOff"],
    notify: [true],
  },
  {
    name: "an init container that cannot pull counts too",
    kind: POD,
    obj: pod({ phase: "Pending", initContainerStatuses: [container({ waiting: { reason: "ImagePullBackOff" } })] }),
    reasons: ["ImagePullBackOff"],
  },
  {
    name: "a restart that just happened shows, without a notification",
    kind: POD,
    obj: pod({
      phase: "Running",
      conditions: [cond("Ready", "True")],
      containerStatuses: [container({ running: {} }, { terminated: { reason: "Error", finishedAt: T0 } }, 1)],
    }),
    reasons: ["Restarting"],
    notify: [false],
    group: "crash",
  },
  {
    name: "a restart after an OOM kill notifies",
    kind: POD,
    obj: pod({
      phase: "Running",
      containerStatuses: [container({ running: {} }, { terminated: { reason: "OOMKilled", finishedAt: T0 } }, 1)],
    }),
    reasons: ["OOMKilled"],
    notify: [true],
  },
  {
    name: "a pending pod the scheduler cannot place (FailedScheduling)",
    kind: POD,
    obj: pod({
      phase: "Pending",
      conditions: [cond("PodScheduled", "False", { reason: "Unschedulable", message: "0/3 nodes are available" })],
    }),
    reasons: ["Unschedulable"],
    notify: [false],
  },
  { name: "a pending pod", kind: POD, obj: pod({ phase: "Pending" }), reasons: ["Pending"], notify: [false] },
  {
    name: "a running pod that is not ready",
    kind: POD,
    obj: pod({ phase: "Running", conditions: [cond("Ready", "False")], containerStatuses: [container({ running: {} })] }),
    reasons: ["NotReady"],
    notify: [false],
  },
  {
    name: "a sidecar that restarted once does not hide another container crash-looping",
    kind: POD,
    obj: pod({
      phase: "Running",
      containerStatuses: [
        { ...container({ running: {} }, { terminated: { reason: "Error", finishedAt: T0 } }, 1), name: "sidecar" },
        container({ waiting: { reason: "ImagePullBackOff" } }),
      ],
    }),
    reasons: ["ImagePullBackOff"],
    notify: [true],
  },
  { name: "an evicted pod", kind: POD, obj: pod({ phase: "Failed", reason: "Evicted" }), reasons: ["Evicted"] },
  { name: "a finished pod is fine", kind: POD, obj: pod({ phase: "Succeeded" }), reasons: [] },
  {
    name: "a terminating pod is left alone",
    kind: POD,
    obj: { metadata: { ...meta("web"), deletionTimestamp: T0 }, status: { phase: "Running", containerStatuses: [container({ waiting: { reason: "CrashLoopBackOff" } })] } },
    reasons: [],
  },
  // ---- nodes ----
  {
    name: "a ready node is fine",
    kind: NODE,
    obj: { metadata: meta("n1", null), status: { conditions: [cond("Ready", "True"), cond("MemoryPressure", "False")] } },
    reasons: [],
  },
  {
    name: "a node NotReady",
    kind: NODE,
    obj: { metadata: meta("n1", null), status: { conditions: [cond("Ready", "Unknown")] } },
    reasons: ["NotReady"],
    notify: [true],
  },
  {
    name: "a node under pressure",
    kind: NODE,
    obj: {
      metadata: meta("n1", null),
      status: { conditions: [cond("Ready", "True"), cond("DiskPressure", "True"), cond("PIDPressure", "True")] },
    },
    reasons: ["DiskPressure", "PIDPressure"],
    notify: [true, true],
  },
  // ---- workloads ----
  {
    name: "a Deployment with all replicas ready",
    kind: DEPLOYMENT,
    obj: { metadata: meta("api"), spec: { replicas: 3 }, status: { readyReplicas: 3 } },
    reasons: [],
  },
  {
    name: "a Deployment with unavailable replicas",
    kind: DEPLOYMENT,
    obj: {
      metadata: meta("api"),
      spec: { replicas: 3 },
      status: { readyReplicas: 1, conditions: [cond("Progressing", "True", { reason: "NewReplicaSetAvailable" })] },
    },
    reasons: ["UnavailableReplicas"],
    notify: [true],
    group: "unavailable",
  },
  {
    name: "a Deployment in the middle of a rollout is not a problem",
    kind: DEPLOYMENT,
    obj: {
      metadata: meta("api"),
      spec: { replicas: 3 },
      status: { readyReplicas: 1, conditions: [cond("Progressing", "True", { reason: "ReplicaSetUpdated" })] },
    },
    reasons: [],
  },
  {
    name: "a Deployment past its progress deadline",
    kind: DEPLOYMENT,
    obj: {
      metadata: meta("api"),
      spec: { replicas: 3 },
      status: { readyReplicas: 1, conditions: [cond("Progressing", "False", { reason: "ProgressDeadlineExceeded" })] },
    },
    reasons: ["ProgressDeadlineExceeded"],
  },
  {
    name: "a Deployment scaled to zero is fine",
    kind: DEPLOYMENT,
    obj: { metadata: meta("api"), spec: { replicas: 0 }, status: {} },
    reasons: [],
  },
  {
    name: "a StatefulSet short of replicas",
    kind: STATEFULSET,
    obj: { metadata: meta("db"), spec: { replicas: 2 }, status: { readyReplicas: 1, currentRevision: "a", updateRevision: "a" } },
    reasons: ["UnavailableReplicas"],
  },
  {
    name: "a DaemonSet short of ready pods",
    kind: DAEMONSET,
    obj: { metadata: meta("agent"), status: { desiredNumberScheduled: 3, numberReady: 2, updatedNumberScheduled: 3 } },
    reasons: ["UnavailableReplicas"],
  },
  {
    name: "a StatefulSet rollout with pods not ready counts once it stalls",
    kind: STATEFULSET,
    obj: {
      metadata: meta("db"),
      spec: { replicas: 3 },
      status: { readyReplicas: 2, updatedReplicas: 1, currentRevision: "a", updateRevision: "b" },
    },
    reasons: ["RolloutNotProgressing"],
    notify: [true],
  },
  {
    name: "a DaemonSet rollout with pods not ready counts once it stalls",
    kind: DAEMONSET,
    obj: { metadata: meta("agent"), status: { desiredNumberScheduled: 3, numberReady: 2, updatedNumberScheduled: 1 } },
    reasons: ["RolloutNotProgressing"],
  },
  // ---- Jobs, claims ----
  {
    name: "a failed Job",
    kind: JOB,
    obj: { metadata: meta("migrate"), status: { conditions: [cond("Failed", "True", { reason: "BackoffLimitExceeded" })] } },
    reasons: ["BackoffLimitExceeded"],
    notify: [true],
  },
  {
    name: "a complete Job is fine",
    kind: JOB,
    obj: { metadata: meta("migrate"), status: { conditions: [cond("Complete", "True")] } },
    reasons: [],
  },
  {
    name: "a pending claim a scheduled pod waits for",
    kind: PVC,
    obj: { metadata: { ...meta("data"), annotations: { [SELECTED]: "node-1" } }, status: { phase: "Pending" } },
    reasons: ["Pending"],
    notify: [false],
  },
  {
    name: "a pending claim of a WaitForFirstConsumer class nobody uses yet is normal",
    kind: PVC,
    obj: { metadata: meta("data"), status: { phase: "Pending" } },
    reasons: [],
  },
  { name: "a lost claim", kind: PVC, obj: { metadata: meta("data"), status: { phase: "Lost" } }, reasons: ["Lost"], notify: [true] },
  { name: "a bound claim is fine", kind: PVC, obj: { metadata: meta("data"), status: { phase: "Bound" } }, reasons: [] },
  // ---- events ----
  {
    name: "a Warning event, about its involved object, never notifies",
    kind: EVENT,
    obj: {
      metadata: meta("web.1"),
      type: "Warning",
      reason: "FailedMount",
      message: "MountVolume.SetUp failed",
      lastTimestamp: T0,
      involvedObject: { kind: "Pod", apiVersion: "v1", name: "web", namespace: "demo" },
    },
    reasons: ["FailedMount"],
    notify: [false],
  },
  { name: "a Normal event is not a problem", kind: EVENT, obj: { metadata: meta("e"), type: "Normal", reason: "Pulled" }, reasons: [] },
  // ---- tools ----
  {
    name: "a Flux Kustomization not ready",
    kind: KUSTOMIZATION,
    obj: { metadata: meta("apps"), status: { conditions: [cond("Ready", "False", { reason: "BuildFailed", message: "kustomize build failed" })] } },
    reasons: ["BuildFailed"],
    notify: [true],
  },
  {
    name: "a suspended Flux object is left alone",
    kind: KUSTOMIZATION,
    obj: { metadata: meta("apps"), spec: { suspend: true }, status: { conditions: [cond("Ready", "False")] } },
    reasons: [],
  },
  {
    name: "a Flux object waiting for a dependency is not a problem",
    kind: KUSTOMIZATION,
    obj: { metadata: meta("apps"), status: { conditions: [cond("Ready", "False", { reason: "DependencyNotReady" })] } },
    reasons: [],
  },
  {
    name: "a Flux object reconciling (Unknown) is not a problem",
    kind: KUSTOMIZATION,
    obj: { metadata: meta("apps"), status: { conditions: [cond("Ready", "Unknown")] } },
    reasons: [],
  },
  {
    name: "an Argo CD Application degraded whose last sync failed",
    kind: APPLICATION,
    obj: {
      metadata: meta("shop"),
      status: { health: { status: "Degraded" }, operationState: { phase: "Failed", message: "one or more objects failed" } },
    },
    reasons: ["Degraded", "SyncFailed"],
  },
  {
    name: "a healthy Argo CD Application",
    kind: APPLICATION,
    obj: { metadata: meta("shop"), status: { health: { status: "Healthy" }, sync: { status: "Synced" } } },
    reasons: [],
  },
  {
    name: "an HTTPRoute a Gateway refused",
    kind: HTTP_ROUTE,
    obj: {
      metadata: meta("web"),
      status: {
        parents: [
          {
            parentRef: { name: "gw" },
            controllerName: "example.com/gw",
            conditions: [cond("Accepted", "False", { reason: "NotAllowedByListeners" }), cond("ResolvedRefs", "True")],
          },
        ],
      },
    },
    reasons: ["NotAllowedByListeners"],
    notify: [true],
  },
  {
    name: "a new certificate being issued is not a problem",
    kind: CERTIFICATE,
    obj: { metadata: meta("tls"), status: { conditions: [cond("Ready", "False", { reason: "DoesNotExist" })] } },
    reasons: [],
  },
  {
    name: "a certificate cert-manager could not issue",
    kind: CERTIFICATE,
    obj: { metadata: meta("tls"), status: { conditions: [cond("Ready", "False", { reason: "Failed" })] } },
    reasons: ["Failed"],
  },
  {
    name: "a first issuance that keeps failing (still DoesNotExist, Issuing=False/Failed)",
    kind: CERTIFICATE,
    obj: {
      metadata: meta("tls"),
      status: {
        conditions: [
          cond("Ready", "False", { reason: "DoesNotExist" }),
          cond("Issuing", "False", { reason: "Failed", message: "order is in \"invalid\" state" }),
        ],
      },
    },
    reasons: ["IssuanceFailed"],
    notify: [true],
  },
  {
    name: "a valid certificate whose renewal failed",
    kind: CERTIFICATE,
    obj: {
      metadata: meta("tls"),
      status: { conditions: [cond("Ready", "True", { reason: "Ready" }), cond("Issuing", "False", { reason: "Failed" })] },
    },
    reasons: ["IssuanceFailed"],
  },
];

describe("detection rules", () => {
  it.each(CASES)("$name", ({ kind, obj, reasons, notify, group }) => {
    const found = detect(kind, obj);
    expect(found.map((d) => d.reason)).toEqual(reasons);
    if (notify) expect(found.map((d) => d.notify)).toEqual(notify);
    if (group) expect(found[0]?.group).toBe(group);
  });

  it("a Warning event is about its involved object", () => {
    const [problem] = resolve(EVENT, CASES.find((c) => c.kind === EVENT)!.obj, T0_MS);
    expect(problem!.object).toEqual({ kind: { group: "", version: "v1", kind: "Pod" }, namespace: "demo", name: "web" });
    expect(problem!.category).toBe("events");
  });
});

describe("when a problem counts", () => {
  it("a restart counts for a while after it happened, then not", () => {
    const obj = CASES.find((c) => c.name.startsWith("a restart that just happened"))!.obj;
    const [p] = resolve(POD, obj, T0_MS);
    expect(isActive(p!, T0_MS + 1000)).toBe(true);
    expect(isActive(p!, T0_MS + RECENT_RESTART_MS + 1)).toBe(false);
  });

  it("a slow state counts after its grace, measured from what the object says", () => {
    const pending = resolve(POD, pod({ phase: "Pending" }), T0_MS + 1000)[0]!;
    expect(isActive(pending, T0_MS + LONG_GRACE_MS - 1)).toBe(false);
    expect(isActive(pending, T0_MS + LONG_GRACE_MS)).toBe(true);
    const claim = resolve(PVC, { metadata: { ...meta("data"), annotations: { [SELECTED]: "n" } }, status: { phase: "Pending" } }, T0_MS)[0]!;
    expect(isActive(claim, T0_MS + SHORT_GRACE_MS)).toBe(true);
  });

  it("without a time on the object, the grace runs from when Sextant first saw it, kept across updates", () => {
    const obj: KubeObject = { metadata: meta("db"), spec: { replicas: 2 }, status: { readyReplicas: 1 } };
    const first = resolve(STATEFULSET, obj, T0_MS);
    const later = resolve(STATEFULSET, obj, T0_MS + 60_000, first);
    expect(later[0]!.firstSeen).toBe(T0_MS);
    expect(later[0]!.activeAt).toBe(T0_MS + LONG_GRACE_MS);
  });

  it("a Flux failure counts only after a short grace", () => {
    const flux = resolve(KUSTOMIZATION, CASES.find((c) => c.name === "a Flux Kustomization not ready")!.obj, T0_MS)[0]!;
    expect(isActive(flux, T0_MS + 1000)).toBe(false);
    expect(isActive(flux, T0_MS + SHORT_GRACE_MS)).toBe(true);
  });

  it("a stalled rollout waits from its last progress", () => {
    const sts = (updated: number): KubeObject => ({
      metadata: meta("db"),
      spec: { replicas: 3 },
      status: { readyReplicas: 2, updatedReplicas: updated, currentRevision: "a", updateRevision: "b" },
    });
    const first = resolve(STATEFULSET, sts(1), T0_MS);
    const same = resolve(STATEFULSET, sts(1), T0_MS + 5 * 60_000, first);
    expect(same[0]!.activeAt).toBe(T0_MS + ROLLOUT_STALL_MS);
    const progressed = resolve(STATEFULSET, sts(2), T0_MS + 8 * 60_000, same);
    expect(progressed[0]!.activeAt).toBe(T0_MS + 8 * 60_000 + ROLLOUT_STALL_MS);
  });

  it("a certificate is expiring two weeks before notAfter and expired after it", () => {
    const notAfter = T0_MS + 30 * 24 * 3600_000;
    const cert: KubeObject = {
      metadata: meta("tls"),
      status: { conditions: [cond("Ready", "True")], notAfter: new Date(notAfter).toISOString() },
    };
    const found = resolve(CERTIFICATE, cert, T0_MS);
    const at = (t: number) => found.filter((p) => isActive(p, t)).map((p) => p.reason);
    expect(at(T0_MS)).toEqual([]);
    expect(at(notAfter - CERT_EXPIRY_WARNING_MS + 1)).toEqual(["Expiring"]);
    expect(at(notAfter + 1)).toEqual(["Expired"]);
  });

  it("Jobs of one CronJob and pods of one workload share their notify key", () => {
    const failedJob = (name: string, owner: Record<string, unknown>): KubeObject => ({
      metadata: { ...meta(name), ownerReferences: [{ ...owner, controller: true }] },
      status: { conditions: [cond("Failed", "True", { reason: "BackoffLimitExceeded" })] },
    });
    const cron = { apiVersion: "batch/v1", kind: "CronJob", name: "backup" };
    const a = resolve(JOB, failedJob("backup-29000001", cron), T0_MS)[0]!;
    const b = resolve(JOB, failedJob("backup-29000002", cron), T0_MS)[0]!;
    expect(a.key).not.toBe(b.key);
    expect(a.notifyKey).toBe(b.notifyKey);

    const crashingPod = (name: string, owner: Record<string, unknown>): KubeObject => ({
      ...CASES[1]!.obj,
      metadata: { ...meta(name), ownerReferences: [{ ...owner, controller: true }] },
    });
    const rs = { apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-7d9f8b6c5d" };
    const p1 = resolve(POD, crashingPod("web-7d9f8b6c5d-abcde", rs), T0_MS)[0]!;
    const p2 = resolve(POD, crashingPod("web-7d9f8b6c5d-fghij", rs), T0_MS)[0]!;
    expect(p1.notifyKey).toBe(p2.notifyKey);
    expect(p1.notifyKey).toBe("owner:demo/Deployment/web|crash");
    // A lone pod is its own identity.
    expect(resolve(POD, CASES[1]!.obj, T0_MS)[0]!.notifyKey).toBe("uid-web|crash");
  });

  it("keys tell problems apart; notify keys follow the state, not the reason", () => {
    const crash = resolve(POD, CASES[1]!.obj, T0_MS)[0]!;
    const restart = resolve(POD, CASES.find((c) => c.name.startsWith("a restart that just"))!.obj, T0_MS)[0]!;
    expect(crash.key).not.toBe(restart.key);
    expect(crash.notifyKey).toBe(restart.notifyKey);
  });
});
