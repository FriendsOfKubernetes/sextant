import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import deploymentJson from "./fixtures/deployment.json";
import jobJson from "./fixtures/job.json";
import jobPodJson from "./fixtures/job-pod.json";
import podJson from "./fixtures/pod.json";
import replicaSetJson from "./fixtures/replicaset.json";
import serviceJson from "./fixtures/service.json";
import { hasHealthCheck, healthWatchKinds, resourceHealth } from "./health";
import type { ManagedResource } from "./model";

const copy = <T>(v: T): T => structuredClone(v);
const k = (group: string, kind: string) => ({ group, kind });
const DEPLOYMENT = k("apps", "Deployment");
const STATEFUL_SET = k("apps", "StatefulSet");
const DAEMON_SET = k("apps", "DaemonSet");
const REPLICA_SET = k("apps", "ReplicaSet");
const POD = k("", "Pod");
const JOB = k("batch", "Job");
const PVC = k("", "PersistentVolumeClaim");
const SERVICE = k("", "Service");
const INGRESS = k("networking.k8s.io", "Ingress");

const obj = (fields: Record<string, unknown>): KubeObject =>
  ({
    metadata: { name: "x", namespace: "ns", generation: 1 },
    ...fields,
  }) as KubeObject;
const statusOf = (h: ReturnType<typeof resourceHealth>) => h?.status;

describe("resourceHealth", () => {
  it("is Missing for an absent object of a checked kind and nothing for a kind without a check", () => {
    expect(resourceHealth(DEPLOYMENT, undefined)).toEqual({
      status: "Missing",
    });
    expect(resourceHealth(k("", "ConfigMap"), undefined)).toBeUndefined();
    expect(resourceHealth(k("", "ConfigMap"), obj({}))).toBeUndefined();
    expect(hasHealthCheck(INGRESS)).toBe(true);
    expect(hasHealthCheck(k("extensions", "Ingress"))).toBe(false);
  });

  it("is Progressing for any object being deleted", () => {
    const d = copy(deploymentJson) as KubeObject;
    d.metadata!.deletionTimestamp = "2026-10-12T16:52:31Z";
    expect(resourceHealth(DEPLOYMENT, d)).toEqual({
      status: "Progressing",
      message: "Pending deletion",
    });
  });

  it("Deployment: Healthy when rolled out, Suspended when paused, Progressing while rolling, Degraded past its deadline", () => {
    const d = deploymentJson as KubeObject;
    expect(statusOf(resourceHealth(DEPLOYMENT, d))).toBe("Healthy");
    const paused = copy(d) as { spec: Record<string, unknown> } & KubeObject;
    paused.spec.paused = true;
    expect(statusOf(resourceHealth(DEPLOYMENT, paused))).toBe("Suspended");
    const unobserved = copy(d);
    unobserved.metadata!.generation = 2;
    expect(statusOf(resourceHealth(DEPLOYMENT, unobserved))).toBe("Progressing");
    const scaling = copy(d) as { spec: Record<string, unknown> } & KubeObject;
    scaling.spec.replicas = 3;
    expect(resourceHealth(DEPLOYMENT, scaling)?.message).toMatch(/1 out of 3 new replicas/);
    const old = copy(d) as { status: Record<string, unknown> } & KubeObject;
    old.status.replicas = 2;
    expect(resourceHealth(DEPLOYMENT, old)?.message).toMatch(/old replicas are pending termination/);
    const unavailable = copy(d) as {
      status: Record<string, unknown>;
    } & KubeObject;
    unavailable.status.availableReplicas = 0;
    expect(statusOf(resourceHealth(DEPLOYMENT, unavailable))).toBe("Progressing");
    const stuck = copy(d) as {
      status: { conditions: Record<string, unknown>[] };
    } & KubeObject;
    stuck.status.conditions[1]!.reason = "ProgressDeadlineExceeded";
    expect(resourceHealth(DEPLOYMENT, stuck)).toEqual({
      status: "Degraded",
      message: 'Deployment "guestbook-ui" exceeded its progress deadline',
    });
  });

  it("StatefulSet: Progressing until observed, ready and updated; partitions and OnDelete count as Argo CD counts them", () => {
    const base = {
      spec: { replicas: 2, updateStrategy: { type: "RollingUpdate" } },
      status: {
        observedGeneration: 1,
        readyReplicas: 2,
        updatedReplicas: 2,
        currentRevision: "a",
        updateRevision: "a",
      },
    };
    expect(statusOf(resourceHealth(STATEFUL_SET, obj(base)))).toBe("Healthy");
    expect(
      statusOf(resourceHealth(STATEFUL_SET, obj({ ...base, status: { ...base.status, observedGeneration: 0 } }))),
    ).toBe("Progressing");
    expect(resourceHealth(STATEFUL_SET, obj({ ...base, status: { ...base.status, readyReplicas: 1 } }))?.message).toBe(
      "Waiting for 1 pods to be ready...",
    );
    expect(
      statusOf(resourceHealth(STATEFUL_SET, obj({ ...base, status: { ...base.status, updateRevision: "b" } }))),
    ).toBe("Progressing");
    const partitioned = {
      ...base,
      spec: {
        replicas: 2,
        updateStrategy: {
          type: "RollingUpdate",
          rollingUpdate: { partition: 1 },
        },
      },
    };
    expect(
      statusOf(
        resourceHealth(
          STATEFUL_SET,
          obj({
            ...partitioned,
            status: { ...base.status, updatedReplicas: 0 },
          }),
        ),
      ),
    ).toBe("Progressing");
    expect(
      statusOf(
        resourceHealth(
          STATEFUL_SET,
          obj({
            ...partitioned,
            status: { ...base.status, updatedReplicas: 1, updateRevision: "b" },
          }),
        ),
      ),
    ).toBe("Healthy");
    const onDelete = {
      spec: { replicas: 2, updateStrategy: { type: "OnDelete" } },
      status: { ...base.status, updateRevision: "b" },
    };
    expect(statusOf(resourceHealth(STATEFUL_SET, obj(onDelete)))).toBe("Healthy");
  });

  it("DaemonSet: Healthy when every scheduled pod is updated and available", () => {
    const status = {
      observedGeneration: 1,
      desiredNumberScheduled: 3,
      updatedNumberScheduled: 3,
      numberAvailable: 3,
    };
    expect(statusOf(resourceHealth(DAEMON_SET, obj({ status })))).toBe("Healthy");
    expect(statusOf(resourceHealth(DAEMON_SET, obj({ status: { ...status, updatedNumberScheduled: 2 } })))).toBe(
      "Progressing",
    );
    expect(statusOf(resourceHealth(DAEMON_SET, obj({ status: { ...status, numberAvailable: 2 } })))).toBe(
      "Progressing",
    );
    expect(statusOf(resourceHealth(DAEMON_SET, obj({ status: { ...status, observedGeneration: 0 } })))).toBe(
      "Progressing",
    );
    const onDelete = {
      spec: { updateStrategy: { type: "OnDelete" } },
      status: { ...status, numberAvailable: 0 },
    };
    expect(statusOf(resourceHealth(DAEMON_SET, obj(onDelete)))).toBe("Healthy");
  });

  it("ReplicaSet: Healthy when its replicas are available, Degraded on ReplicaFailure", () => {
    const rs = replicaSetJson as KubeObject;
    expect(statusOf(resourceHealth(REPLICA_SET, rs))).toBe("Healthy");
    const short = copy(rs) as { status: Record<string, unknown> } & KubeObject;
    short.status.availableReplicas = 0;
    expect(statusOf(resourceHealth(REPLICA_SET, short))).toBe("Progressing");
    const failing = copy(rs) as {
      status: Record<string, unknown>;
    } & KubeObject;
    failing.status.conditions = [
      {
        type: "ReplicaFailure",
        status: "True",
        message: 'pods "x" is forbidden: quota',
      },
    ];
    expect(resourceHealth(REPLICA_SET, failing)).toEqual({
      status: "Degraded",
      message: 'pods "x" is forbidden: quota',
    });
  });

  it("Pod: Healthy when ready or succeeded, Degraded on a back-off or failure, Progressing otherwise", () => {
    expect(statusOf(resourceHealth(POD, podJson as KubeObject))).toBe("Healthy");
    expect(statusOf(resourceHealth(POD, jobPodJson as KubeObject))).toBe("Healthy"); // Succeeded
    const pending = { spec: {}, status: { phase: "Pending" } };
    expect(statusOf(resourceHealth(POD, obj(pending)))).toBe("Progressing");
    const backOff = {
      spec: { restartPolicy: "Always" },
      status: {
        phase: "Pending",
        containerStatuses: [
          {
            name: "app",
            state: {
              waiting: {
                reason: "ImagePullBackOff",
                message: "Back-off pulling image",
              },
            },
          },
        ],
      },
    };
    expect(resourceHealth(POD, obj(backOff))).toEqual({
      status: "Degraded",
      message: "Back-off pulling image",
    });
    // A hook pod (Never) waiting for its image is not failed yet.
    expect(statusOf(resourceHealth(POD, obj({ ...backOff, spec: { restartPolicy: "Never" } })))).toBe("Progressing");
    const failed = {
      spec: { restartPolicy: "Never" },
      status: {
        phase: "Failed",
        containerStatuses: [{ name: "app", state: { terminated: { exitCode: 2 } } }],
      },
    };
    expect(resourceHealth(POD, obj(failed))).toEqual({
      status: "Degraded",
      message: 'container "app" failed with exit code 2',
    });
    const restarted = {
      spec: {},
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "False" }],
        containerStatuses: [
          {
            name: "app",
            lastState: { terminated: { exitCode: 1 } },
            state: { running: {} },
          },
        ],
      },
    };
    expect(statusOf(resourceHealth(POD, obj(restarted)))).toBe("Degraded");
    const starting = {
      spec: {},
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "False" }],
      },
    };
    expect(statusOf(resourceHealth(POD, obj(starting)))).toBe("Progressing");
    expect(statusOf(resourceHealth(POD, obj({ ...starting, spec: { restartPolicy: "OnFailure" } })))).toBe(
      "Progressing",
    );
    expect(statusOf(resourceHealth(POD, obj({ spec: {}, status: { phase: "Unknown" } })))).toBe("Unknown");
  });

  it("Job: Healthy when complete, Degraded when failed, Suspended when suspended, Progressing while running", () => {
    expect(statusOf(resourceHealth(JOB, jobJson as KubeObject))).toBe("Healthy");
    expect(statusOf(resourceHealth(JOB, obj({ status: { active: 1 } })))).toBe("Progressing");
    const failed = {
      status: {
        conditions: [{ type: "Failed", status: "True", message: "BackoffLimitExceeded" }],
      },
    };
    expect(resourceHealth(JOB, obj(failed))).toEqual({
      status: "Degraded",
      message: "BackoffLimitExceeded",
    });
    const suspended = {
      status: {
        conditions: [{ type: "Suspended", status: "True", message: "Job suspended" }],
      },
    };
    expect(resourceHealth(JOB, obj(suspended))).toEqual({
      status: "Suspended",
      message: "Job suspended",
    });
  });

  it("PersistentVolumeClaim: by its phase", () => {
    const pvc = (phase?: string) => obj({ status: phase ? { phase } : {} });
    expect(statusOf(resourceHealth(PVC, pvc("Bound")))).toBe("Healthy");
    expect(statusOf(resourceHealth(PVC, pvc("Pending")))).toBe("Progressing");
    expect(statusOf(resourceHealth(PVC, pvc("Lost")))).toBe("Degraded");
    expect(statusOf(resourceHealth(PVC, pvc()))).toBe("Unknown");
  });

  it("Service: Healthy, except a LoadBalancer without an ingress address yet", () => {
    expect(statusOf(resourceHealth(SERVICE, serviceJson as KubeObject))).toBe("Healthy");
    const lb = { spec: { type: "LoadBalancer" }, status: { loadBalancer: {} } };
    expect(statusOf(resourceHealth(SERVICE, obj(lb)))).toBe("Progressing");
    const ready = {
      ...lb,
      status: { loadBalancer: { ingress: [{ ip: "10.0.0.1" }] } },
    };
    expect(statusOf(resourceHealth(SERVICE, obj(ready)))).toBe("Healthy");
  });

  it("Ingress: Healthy once it has a load balancer address", () => {
    expect(statusOf(resourceHealth(INGRESS, obj({ status: { loadBalancer: {} } })))).toBe("Progressing");
    expect(
      statusOf(resourceHealth(INGRESS, obj({ status: { loadBalancer: { ingress: [{ hostname: "lb" }] } } }))),
    ).toBe("Healthy");
  });
});

describe("healthWatchKinds", () => {
  const managed = (kind: string, group: string, namespace: string | null, health?: string): ManagedResource => ({
    group,
    version: "v1",
    kind,
    namespace,
    name: "x",
    sync: "Synced",
    health,
  });

  it("lists the checked kinds of the resources without health, by namespace", () => {
    expect(
      healthWatchKinds([
        managed("Service", "", "b"),
        managed("Deployment", "apps", "b"),
        managed("Deployment", "apps", "a"),
        managed("Deployment", "apps", "c", "Healthy"), // Argo CD 2.x gave its health
        managed("ConfigMap", "", "a"), // no check
        managed("Namespace", "", null),
      ]),
    ).toEqual([
      {
        kind: { group: "apps", version: "v1", kind: "Deployment" },
        namespaces: ["a", "b"],
      },
      {
        kind: { group: "", version: "v1", kind: "Service" },
        namespaces: ["b"],
      },
    ]);
  });
});
