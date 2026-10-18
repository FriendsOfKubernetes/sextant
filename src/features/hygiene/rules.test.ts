import { describe, expect, it } from "vitest";
import type { KindRef, KubeObject } from "../../api";
import { CERTIFICATE, CLUSTER_ISSUER } from "../cert-manager/model";
import { GIT_REPOSITORY, HELM_RELEASE } from "../flux/model";
import { GATEWAY, REFERENCE_GRANT } from "../gateway-api/model";
import {
  CONFIG_MAP,
  CRON_JOB,
  DEPLOYMENT,
  ENDPOINT_SLICE,
  INGRESS,
  JOB,
  NAMESPACE,
  POD,
  PV,
  PVC,
  REPLICA_SET,
  SECRET,
  SERVICE,
  SERVICE_ACCOUNT,
  STATEFUL_SET,
} from "../resource-map/kinds";
import { CLEANUP_CLUSTER_KINDS, CLEANUP_NAMESPACE_KINDS, ENDPOINTS, VOLUME_SNAPSHOT } from "./kinds";
import { managerOf } from "./managed";
import { findCleanup, SYSTEM_NAMESPACES, type CleanupAges, type CleanupInput, type ClusterState, type KindList, type NamespaceSample } from "./rules";
import { scanReferences } from "./scan";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const OLD = "2026-01-01T00:00:00Z";
const RECENT = "2026-10-19T00:00:00Z";
const AGES: CleanupAges = { configs: 7, services: 7, pods: 7, jobs: 7, claims: 30, volumes: 30, namespaces: 30 };

let uid = 0;
type Obj = KubeObject & { metadata: NonNullable<KubeObject["metadata"]> };

function o(name: string, extra: Record<string, unknown> = {}, ns: string | null = "app"): Obj {
  const { metadata, ...rest } = extra as { metadata?: Record<string, unknown> };
  return {
    metadata: {
      name,
      ...(ns ? { namespace: ns } : {}),
      uid: `uid-${name}-${++uid}`,
      resourceVersion: "1",
      creationTimestamp: OLD,
      ...metadata,
    },
    ...rest,
  };
}

const BUILT_IN_GROUPS = new Set(["", "apps", "batch", "networking.k8s.io", "discovery.k8s.io", "policy", "autoscaling"]);

type Entry = [KindRef, Obj];

/**
 * Every list of namespace `app` ready (custom kinds not served unless the case lists one of them), the cluster-wide
 * lists ready; `override` changes one list's state.
 */
interface InputOptions {
  override?: (l: KindList) => KindList;
  namespaces?: string[];
  excluded?: string[];
  /** Default: both rules on (the tests of the other rules are not affected by them). */
  rules?: CleanupInput["rules"];
  /** Default: every group answers and nothing cluster-scoped names a ConfigMap or Secret of the case. */
  cluster?: ClusterState | null;
  /** Default: every namespace sampled, holding nothing. */
  samples?: Record<string, NamespaceSample | undefined>;
}

/** A cluster check that looked for every ConfigMap and Secret of the case and found none named. */
function clusterReady(entries: Entry[], referenced: string[] = [], unavailableGroups: string[] = []): ClusterState {
  const scanned = entries
    .filter(([k]) => k.kind === "ConfigMap" || k.kind === "Secret")
    .map(([k, obj]) => `${k.kind}/${obj.metadata.namespace}/${obj.metadata.name}`);
  return { state: "ready", unavailableGroups, referenced: new Set(referenced), scanned: new Set(scanned), unread: [] };
}

function input(entries: Entry[], options: InputOptions = {}): CleanupInput {
  const namespaces = options.namespaces ?? ["app"];
  const sameKind = (a: KindRef, b: KindRef) => a.group === b.group && a.kind === b.kind;
  const lists: KindList[] = [];
  const served = (kind: KindRef) => BUILT_IN_GROUPS.has(kind.group) || entries.some(([k]) => sameKind(k, kind));
  for (const ns of namespaces) {
    for (const kind of CLEANUP_NAMESPACE_KINDS) {
      lists.push({
        kind,
        namespace: ns,
        state: served(kind) ? "ready" : "notServed",
        items: entries.filter(([k, obj]) => sameKind(k, kind) && obj.metadata.namespace === ns).map(([, obj]) => obj),
      });
    }
  }
  for (const kind of CLEANUP_CLUSTER_KINDS) {
    lists.push({
      kind,
      namespace: null,
      state: served(kind) ? "ready" : "notServed",
      items: entries.filter(([k]) => sameKind(k, kind)).map(([, obj]) => obj),
    });
  }
  if (!entries.some(([k]) => sameKind(k, NAMESPACE))) {
    lists.find((l) => sameKind(l.kind, NAMESPACE))!.items = namespaces.map((ns) => o(ns, { status: { phase: "Active" } }, null));
  }
  return {
    lists: options.override ? lists.map(options.override) : lists,
    namespaces,
    excluded: new Set([...SYSTEM_NAMESPACES, ...(options.excluded ?? [])]),
    ages: AGES,
    rules: options.rules ?? { configMaps: true, secrets: true },
    cluster: options.cluster === null ? undefined : (options.cluster ?? clusterReady(entries)),
    samples: new Map(
      namespaces.flatMap((ns): [string, NamespaceSample][] => {
        const sample: NamespaceSample | undefined = options.samples && ns in options.samples ? options.samples[ns] : { state: "ready", kinds: [] };
        return sample ? [[ns, sample]] : [];
      }),
    ),
    now: NOW,
  };
}

/** `Kind/name` of the candidates (sorted), the namespaces left out. */
function names(result: ReturnType<typeof findCleanup>, which: "candidates" | "managed" = "candidates", kinds?: string[]): string[] {
  return result[which]
    .filter((c) => !kinds || kinds.includes(c.kind.kind))
    .map((c) => `${c.kind.kind}/${c.name}`)
    .sort();
}

const cm = (name: string, extra: Record<string, unknown> = {}): Entry => [CONFIG_MAP, o(name, extra)];
const secret = (name: string, type = "Opaque", extra: Record<string, unknown> = {}): Entry => [SECRET, o(name, { type, ...extra })];
const podSpec = (spec: Record<string, unknown>) => ({ containers: [{ name: "c", image: "x" }], ...spec });
const template = (spec: Record<string, unknown>, labels: Record<string, string> = { app: "web" }) => ({
  template: { metadata: { labels }, spec: podSpec(spec) },
});

describe("ConfigMaps", () => {
  const cases: { name: string; entries: Entry[]; expected: string[] }[] = [
    { name: "an old ConfigMap nothing names is a candidate", entries: [cm("orphan")], expected: ["ConfigMap/orphan"] },
    { name: "a recent one is not", entries: [cm("fresh", { metadata: { creationTimestamp: RECENT } })], expected: [] },
    {
      name: "a Deployment's volume keeps it",
      entries: [cm("conf"), [DEPLOYMENT, o("web", { spec: template({ volumes: [{ name: "v", configMap: { name: "conf" } }] }) })]],
      expected: [],
    },
    {
      name: "a Pod's projected source keeps it",
      entries: [cm("conf"), [POD, o("p", { spec: podSpec({ volumes: [{ name: "v", projected: { sources: [{ configMap: { name: "conf" } }] } }] }) })]],
      expected: [],
    },
    {
      name: "a CronJob's envFrom keeps it",
      entries: [
        cm("conf"),
        [CRON_JOB, o("nightly", { spec: { jobTemplate: { spec: template({ containers: [{ name: "c", envFrom: [{ configMapRef: { name: "conf" } }] }] }) } } })],
      ],
      expected: [],
    },
    {
      name: "an optional env reference keeps it too",
      entries: [
        cm("conf"),
        [POD, o("p", { spec: podSpec({ containers: [{ name: "c", env: [{ name: "X", valueFrom: { configMapKeyRef: { name: "conf", key: "k", optional: true } } }] }] }) })],
      ],
      expected: [],
    },
    {
      name: "an old ReplicaSet of a Deployment keeps what a rollback would mount",
      entries: [
        cm("conf-v1"),
        [
          REPLICA_SET,
          o("web-1", {
            metadata: { ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "d", controller: true }] },
            spec: { replicas: 0, ...template({ volumes: [{ name: "v", configMap: { name: "conf-v1" } }] }) },
          }),
        ],
      ],
      expected: [],
    },
    {
      name: "a HelmRelease's valuesFrom keeps it",
      entries: [cm("values"), [HELM_RELEASE, o("rel", { spec: { valuesFrom: [{ kind: "ConfigMap", name: "values" }] } })]],
      expected: [],
    },
    { name: "kube-root-ca.crt never is", entries: [cm("kube-root-ca.crt")], expected: [] },
    {
      name: "a leader-election ConfigMap never is",
      entries: [cm("lock", { metadata: { creationTimestamp: OLD, annotations: { "control-plane.alpha.kubernetes.io/leader": "{}" } } })],
      expected: [],
    },
    {
      name: "an owned ConfigMap never is",
      entries: [cm("owned", { metadata: { creationTimestamp: OLD, ownerReferences: [{ apiVersion: "v1", kind: "Foo", name: "x", uid: "x" }] } })],
      expected: [],
    },
  ];
  it.each(cases)("$name", ({ entries, expected }) => {
    expect(names(findCleanup(input(entries)), "candidates", ["ConfigMap"])).toEqual(expected);
  });
});

describe("Secrets", () => {
  const cases: { name: string; entries: Entry[]; expected: string[] }[] = [
    { name: "an unused Opaque Secret is a candidate", entries: [secret("old")], expected: ["Secret/old"] },
    { name: "a service account token never is", entries: [secret("t", "kubernetes.io/service-account-token")], expected: [] },
    { name: "a Helm release Secret never is", entries: [secret("sh.helm.release.v1.web.v3", "helm.sh/release.v1")], expected: [] },
    { name: "a bootstrap token never is", entries: [secret("bootstrap-token-abc", "bootstrap.kubernetes.io/token")], expected: [] },
    {
      name: "an Argo CD repository Secret never is",
      entries: [secret("repo", "Opaque", { metadata: { creationTimestamp: OLD, labels: { "argocd.argoproj.io/secret-type": "repository" } } })],
      expected: [],
    },
    { name: "image pull secrets of a pod keep it", entries: [secret("pull"), [POD, o("p", { spec: podSpec({ imagePullSecrets: [{ name: "pull" }] }) })]], expected: [] },
    { name: "a ServiceAccount's imagePullSecrets keep it", entries: [secret("pull"), [SERVICE_ACCOUNT, o("sa", { imagePullSecrets: [{ name: "pull" }] })]], expected: [] },
    { name: "a ServiceAccount's secrets keep it", entries: [secret("tok"), [SERVICE_ACCOUNT, o("sa", { secrets: [{ name: "tok" }] })]], expected: [] },
    { name: "Ingress TLS keeps it", entries: [secret("tls", "kubernetes.io/tls"), [INGRESS, o("ing", { spec: { tls: [{ secretName: "tls" }] } })]], expected: [] },
    {
      name: "an ingress-nginx auth annotation keeps it",
      entries: [secret("basic"), [INGRESS, o("ing", { metadata: { annotations: { "nginx.ingress.kubernetes.io/auth-secret": "basic" } } })]],
      expected: [],
    },
    {
      name: "a Gateway listener's certificateRefs keep it",
      entries: [secret("gw-tls", "kubernetes.io/tls"), [GATEWAY, o("gw", { spec: { listeners: [{ name: "https", port: 443, protocol: "HTTPS", tls: { certificateRefs: [{ name: "gw-tls" }] } }] } })]],
      expected: [],
    },
    {
      name: "a ReferenceGrant for Gateways of another namespace keeps it",
      entries: [
        secret("shared", "kubernetes.io/tls"),
        [REFERENCE_GRANT, o("allow", { spec: { from: [{ group: "gateway.networking.k8s.io", kind: "Gateway", namespace: "infra" }], to: [{ group: "", kind: "Secret" }] } })],
      ],
      expected: [],
    },
    { name: "a cert-manager Certificate's secretName keeps it", entries: [secret("site-tls", "kubernetes.io/tls"), [CERTIFICATE, o("site", { spec: { secretName: "site-tls" } })]], expected: [] },
    { name: "a Flux source's secretRef keeps it", entries: [secret("git-auth"), [GIT_REPOSITORY, o("repo", { spec: { secretRef: { name: "git-auth" } } })]], expected: [] },
    {
      name: "a ClusterIssuer's key keeps a Secret of that name in any namespace",
      entries: [secret("acme-key"), [CLUSTER_ISSUER, o("le", { spec: { acme: { privateKeySecretRef: { name: "acme-key" } } } }, null)]],
      expected: [],
    },
  ];
  it.each(cases)("$name", ({ entries, expected }) => {
    expect(names(findCleanup(input(entries)), "candidates", ["Secret"])).toEqual(expected);
  });
});

describe("when a list is not known in full", () => {
  it("nothing that list could name is a candidate, and the gap is reported", () => {
    const result = findCleanup(
      input([cm("orphan"), secret("old")], { override: (l) => (l.kind.kind === "Pod" ? { ...l, state: "unknown" } : l) }),
    );
    expect(names(result, "candidates", ["ConfigMap", "Secret", "Service"])).toEqual([]);
    expect(result.unchecked).toContainEqual({ rule: "configMap", namespace: "app", kinds: ["Pod"] });
  });

  it("a namespace a list may not read counts as unknown", () => {
    const result = findCleanup(input([cm("orphan")], { override: (l) => (l.kind.kind === "Deployment" ? { ...l, forbidden: ["app"] } : l) }));
    expect(names(result)).not.toContain("ConfigMap/orphan");
  });

  it("a served custom kind that is still loading blocks the Secrets", () => {
    const result = findCleanup(
      input([secret("old"), [CERTIFICATE, o("c", { spec: { secretName: "other" } })]], {
        override: (l) => (l.kind.kind === "Certificate" ? { ...l, state: "unknown" } : l),
      }),
    );
    expect(names(result, "candidates", ["Secret"])).toEqual([]);
  });
});

describe("PersistentVolumeClaims and PersistentVolumes", () => {
  const claim = (name: string, extra: Record<string, unknown> = {}): Entry => [PVC, o(name, extra)];
  const cases: { name: string; entries: Entry[]; expected: string[] }[] = [
    { name: "an old claim nothing mounts is a candidate", entries: [claim("data")], expected: ["PersistentVolumeClaim/data"] },
    { name: "a recent one is not", entries: [claim("data", { metadata: { creationTimestamp: RECENT } })], expected: [] },
    { name: "a Pod mounting it keeps it", entries: [claim("data"), [POD, o("p", { spec: podSpec({ volumes: [{ name: "v", persistentVolumeClaim: { claimName: "data" } }] }) })]], expected: [] },
    { name: "a Deployment template keeps it", entries: [claim("data"), [DEPLOYMENT, o("web", { spec: { replicas: 0, ...template({ volumes: [{ name: "v", persistentVolumeClaim: { claimName: "data" } }] }) } })]], expected: [] },
    { name: "a VolumeSnapshot of it keeps it", entries: [claim("data"), [VOLUME_SNAPSHOT, o("snap", { spec: { source: { persistentVolumeClaimName: "data" } } })]], expected: [] },
    {
      name: "a StatefulSet's claim template keeps the claims of its replicas",
      entries: [claim("data-db-3"), [STATEFUL_SET, o("db", { spec: { replicas: 1, volumeClaimTemplates: [{ metadata: { name: "data" } }], ...template({}) } })]],
      expected: [],
    },
    { name: "another claim's data source keeps it", entries: [claim("data"), claim("copy", { spec: { dataSource: { kind: "PersistentVolumeClaim", name: "data" } }, metadata: { creationTimestamp: RECENT } })], expected: [] },
  ];
  it.each(cases)("$name", ({ entries, expected }) => {
    expect(names(findCleanup(input(entries)), "candidates", ["PersistentVolumeClaim"])).toEqual(expected);
  });

  it("Released volumes and unclaimed Available ones are candidates after the days", () => {
    const pv = (name: string, phase: string, claimRef?: Record<string, string>, since = OLD): Entry => [
      PV,
      o(name, { spec: claimRef ? { claimRef } : {}, status: { phase, lastPhaseTransitionTime: since } }, null),
    ];
    const result = findCleanup(
      input([
        pv("released", "Released", { namespace: "app", name: "gone" }),
        pv("released-recently", "Released", { namespace: "app", name: "gone" }, RECENT),
        pv("free", "Available"),
        pv("prebound", "Available", { namespace: "app", name: "future" }),
        pv("bound", "Bound", { namespace: "app", name: "data" }),
        pv("system", "Released", { namespace: "kube-system", name: "x" }),
      ]),
    );
    expect(names(result, "candidates", ["PersistentVolume"])).toEqual(["PersistentVolume/free", "PersistentVolume/released"]);
    expect(result.candidates.find((c) => c.name === "released")?.reason).toEqual({ id: "volumeReleased", values: { claim: "app/gone" } });
  });
});

describe("Services", () => {
  const svc = (name: string, spec: Record<string, unknown>): Entry => [SERVICE, o(name, { spec })];
  const cases: { name: string; entries: Entry[]; expected: string[] }[] = [
    { name: "a selector matching nothing is a candidate", entries: [svc("web", { selector: { app: "web" } })], expected: ["Service/web"] },
    { name: "a matching Pod keeps it", entries: [svc("web", { selector: { app: "web" } }), [POD, o("p", { metadata: { creationTimestamp: OLD, labels: { app: "web" } }, spec: podSpec({}) })]], expected: [] },
    { name: "a Deployment scaled to zero whose template matches keeps it", entries: [svc("web", { selector: { app: "web" } }), [DEPLOYMENT, o("web", { spec: { replicas: 0, ...template({}) } })]], expected: [] },
    {
      name: "an EndpointSlice with endpoints keeps it",
      entries: [svc("web", { selector: { app: "web" } }), [ENDPOINT_SLICE, o("web-abc", { metadata: { creationTimestamp: OLD, labels: { "kubernetes.io/service-name": "web" } }, endpoints: [{ addresses: ["10.0.0.1"] }] })]],
      expected: [],
    },
    { name: "ExternalName never is", entries: [svc("ext", { type: "ExternalName", externalName: "example.com" })], expected: [] },
    { name: "a headless Service without a selector never is", entries: [svc("peers", { clusterIP: "None" })], expected: [] },
    { name: "manual Endpoints keep a Service without a selector", entries: [svc("db", {}), [ENDPOINTS, o("db")]], expected: [] },
    { name: "a Service without a selector and without endpoints is a candidate", entries: [svc("db", {})], expected: ["Service/db"] },
  ];
  it.each(cases)("$name", ({ entries, expected }) => {
    expect(names(findCleanup(input(entries)), "candidates", ["Service"])).toEqual(expected);
  });

  it("says which Ingress still routes to a candidate", () => {
    const result = findCleanup(
      input([svc("web", { selector: { app: "web" } }), [INGRESS, o("ing", { spec: { defaultBackend: { service: { name: "web", port: { number: 80 } } } } })]]),
    );
    const candidate = result.candidates.find((c) => c.name === "web");
    expect(candidate?.reason.id).toBe("serviceNoEndpoints");
    expect(candidate?.impact.map((l) => [l.id, l.count])).toEqual([["routes", 1]]);
  });
});

describe("ReplicaSets, Pods and Jobs", () => {
  it("only ReplicaSets beyond the Deployment's revision history limit", () => {
    const deployment = o("web", { spec: { revisionHistoryLimit: 1, ...template({}) } });
    const rs = (revision: number, replicas: number): Entry => [
      REPLICA_SET,
      o(`web-${revision}`, {
        metadata: {
          creationTimestamp: OLD,
          annotations: { "deployment.kubernetes.io/revision": String(revision) },
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: deployment.metadata.uid, controller: true }],
        },
        spec: { replicas },
        status: { replicas },
      }),
    ];
    const result = findCleanup(input([[DEPLOYMENT, deployment], rs(1, 0), rs(2, 0), rs(3, 0), rs(4, 2), rs(5, 0)]));
    // 5 is the current revision (even at 0); 4 still runs; of the old 3, 2, 1 the limit keeps 3.
    expect(names(result, "candidates", ["ReplicaSet"])).toEqual(["ReplicaSet/web-1", "ReplicaSet/web-2"]);
    expect(result.candidates.find((c) => c.name === "web-1")?.reason).toEqual({
      id: "replicaSetHistory",
      values: { revision: 1, deployment: "web", limit: 1 },
    });
  });

  const finishedPod = (name: string, phase: string, extra: Record<string, unknown> = {}, finishedAt = OLD): Entry => [
    POD,
    o(name, { ...extra, spec: podSpec({}), status: { phase, containerStatuses: [{ name: "c", state: { terminated: { finishedAt } } }] } }),
  ];
  const owned = (kind: string, apiVersion: string) => ({
    metadata: { creationTimestamp: OLD, ownerReferences: [{ apiVersion, kind, name: "x", uid: "x", controller: true }] },
  });
  const podCases: { name: string; entries: Entry[]; expected: string[] }[] = [
    { name: "a bare Pod that succeeded long ago is a candidate", entries: [finishedPod("once", "Succeeded")], expected: ["Pod/once"] },
    { name: "an evicted Pod of a ReplicaSet is a candidate", entries: [finishedPod("evicted", "Failed", owned("ReplicaSet", "apps/v1"))], expected: ["Pod/evicted"] },
    { name: "a Job's Pod goes with its Job", entries: [finishedPod("job-pod", "Succeeded", owned("Job", "batch/v1"))], expected: [] },
    { name: "a Pod of an unknown controller is left to it", entries: [finishedPod("wf", "Succeeded", owned("Workflow", "argoproj.io/v1alpha1"))], expected: [] },
    { name: "a Pod that finished recently is not", entries: [finishedPod("recent", "Failed", {}, RECENT)], expected: [] },
    { name: "a running Pod is not", entries: [[POD, o("run", { spec: podSpec({}), status: { phase: "Running" } })]], expected: [] },
  ];
  it.each(podCases)("$name", ({ entries, expected }) => {
    expect(names(findCleanup(input(entries)), "candidates", ["Pod"])).toEqual(expected);
  });

  const job = (name: string, conditionType: string | null, extra: Record<string, unknown> = {}): Entry => [
    JOB,
    o(name, {
      ...extra,
      spec: { ...((extra.spec as object) ?? {}), ...template({}) },
      status: conditionType ? { completionTime: OLD, conditions: [{ type: conditionType, status: "True", lastTransitionTime: OLD }] } : {},
    }),
  ];
  const jobCases: { name: string; entries: Entry[]; expected: string[] }[] = [
    { name: "a finished Job of its own is a candidate", entries: [job("migrate", "Complete")], expected: ["Job/migrate"] },
    { name: "a failed one too", entries: [job("broken", "Failed")], expected: ["Job/broken"] },
    { name: "a CronJob's Job is left to its history limit", entries: [job("nightly-1", "Complete", owned("CronJob", "batch/v1"))], expected: [] },
    { name: "a Job with ttlSecondsAfterFinished cleans itself up", entries: [job("ttl", "Complete", { spec: { ttlSecondsAfterFinished: 100 } })], expected: [] },
    { name: "a running Job is not", entries: [job("running", null)], expected: [] },
  ];
  it.each(jobCases)("$name", ({ entries, expected }) => {
    expect(names(findCleanup(input(entries)), "candidates", ["Job"])).toEqual(expected);
  });
});

describe("namespaces, exclusions and managers", () => {
  it("a namespace holding only what Kubernetes creates is a candidate; one with anything else is not", () => {
    const defaults: Entry[] = [
      cm("kube-root-ca.crt"),
      [SERVICE_ACCOUNT, o("default")],
    ];
    expect(names(findCleanup(input(defaults)), "candidates", ["Namespace"])).toEqual(["Namespace/app"]);
    expect(names(findCleanup(input([...defaults, cm("conf", { metadata: { creationTimestamp: RECENT } })])), "candidates", ["Namespace"])).toEqual([]);
  });

  it("default and kube-* namespaces are never candidates", () => {
    const empty = findCleanup(input([], { namespaces: ["default", "kube-extra"] }));
    expect(names(empty, "candidates", ["Namespace"])).toEqual([]);
  });

  it("a system or user-excluded namespace is not checked at all", () => {
    const entries: Entry[] = [[CONFIG_MAP, o("orphan", {}, "kube-system")], [CONFIG_MAP, o("orphan2", {}, "tools")]];
    const result = findCleanup(input(entries, { namespaces: ["kube-system", "tools"], excluded: ["tools"] }));
    expect(result.candidates).toEqual([]);
  });

  it("an object being deleted is not a candidate", () => {
    const result = findCleanup(input([cm("going", { metadata: { creationTimestamp: OLD, deletionTimestamp: RECENT } })]));
    expect(names(result, "candidates", ["ConfigMap"])).toEqual([]);
  });

  it("an unused object a tool manages is shown as managed, with its manager", () => {
    const result = findCleanup(
      input([
        cm("helm-cm", { metadata: { creationTimestamp: OLD, labels: { "app.kubernetes.io/managed-by": "Helm" }, annotations: { "meta.helm.sh/release-name": "web", "meta.helm.sh/release-namespace": "app" } } }),
        cm("flux-cm", { metadata: { creationTimestamp: OLD, labels: { "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" } } }),
        cm("argo-cm", { metadata: { creationTimestamp: OLD, annotations: { "argocd.argoproj.io/tracking-id": "shop:/ConfigMap:app/argo-cm" } } }),
      ]),
    );
    expect(names(result, "candidates", ["ConfigMap"])).toEqual([]);
    expect(result.managed.map((c) => [c.name, c.managedBy])).toEqual([
      ["argo-cm", { tool: "argocd", name: "shop" }],
      ["flux-cm", { tool: "flux", name: "flux-system/apps" }],
      ["helm-cm", { tool: "helm", name: "app/web" }],
    ]);
  });

  it("every candidate carries the uid and resourceVersion it was judged at", () => {
    const [candidate] = findCleanup(input([cm("orphan")])).candidates.filter((c) => c.name === "orphan");
    expect(candidate).toMatchObject({ uid: expect.stringMatching(/^uid-orphan-/), resourceVersion: "1", namespace: "app", key: "/ConfigMap/app/orphan" });
  });
});

describe("managerOf and scanReferences", () => {
  it.each([
    [{ labels: { "helm.toolkit.fluxcd.io/name": "web", "helm.toolkit.fluxcd.io/namespace": "apps" } }, { tool: "flux", name: "apps/web" }],
    [{ labels: { "argocd.argoproj.io/instance": "shop" } }, { tool: "argocd", name: "shop" }],
    [{ annotations: { "helm.sh/hook": "pre-install" }, labels: { "app.kubernetes.io/instance": "web" } }, { tool: "helm", name: "web" }],
    [{ labels: { "app.kubernetes.io/managed-by": "my-operator" } }, { tool: "other", name: "my-operator" }],
    [{ labels: { app: "web" } }, undefined],
  ])("%j → %j", (metadata, expected) => {
    expect(managerOf({ metadata: { name: "x", ...metadata } })).toEqual(expected);
  });

  it("finds Secrets, ConfigMaps and ServiceAccounts by field shape", () => {
    const refs = scanReferences({
      metadata: { name: "k", namespace: "flux" },
      spec: {
        decryption: { secretRef: { name: "sops" } },
        kubeConfig: { secretRef: { name: "kc", key: "value" } },
        serviceAccountName: "deployer",
        valuesFrom: [{ kind: "ConfigMap", name: "vals" }, { kind: "Secret", name: "svals" }],
        sourceRef: { kind: "GitRepository", name: "repo" },
        certSecretRef: { name: "ca", namespace: "certs" },
      },
    });
    expect(refs.map((r) => `${r.kind}:${r.namespace}/${r.name}`).sort()).toEqual([
      "ConfigMap:flux/vals",
      "Secret:certs/ca",
      "Secret:flux/kc",
      "Secret:flux/sops",
      "Secret:flux/svals",
      "ServiceAccount:flux/deployer",
    ]);
  });
});

describe("what Sextant cannot see (review of #147)", () => {
  const sample = (kinds: { kind: KindRef; names?: string[]; error?: boolean; sa?: string }[]): NamespaceSample => ({
    state: "ready",
    kinds: kinds.map((k) => ({
      kind: k.kind,
      objects: (k.names ?? []).map((name) => ({ name, serviceAccount: k.sa ?? null })),
      more: false,
      error: k.error ? { code: "forbidden", message: "no" } : null,
    })),
  });
  const APPLICATION: KindRef = { group: "argoproj.io", version: "v1alpha1", kind: "Application" };
  const ROLE: KindRef = { group: "rbac.authorization.k8s.io", version: "v1", kind: "Role" };
  const TRIGGER_AUTH: KindRef = { group: "keda.sh", version: "v1alpha1", kind: "TriggerAuthentication" };
  const STORAGE_CLASS: KindRef = { group: "storage.k8s.io", version: "v1", kind: "StorageClass" };
  const claim = (name: string, extra: Record<string, unknown> = {}): Entry => [PVC, o(name, extra)];

  it("ConfigMaps and Secrets are not offered while their rules are off", () => {
    const result = findCleanup(input([cm("orphan"), secret("old")], { rules: { configMaps: false, secrets: false } }));
    expect(names(result, "candidates", ["ConfigMap", "Secret"])).toEqual([]);
  });

  it("a KEDA TriggerAuthentication's secretTargetRef and configMapTargetRef keep them", () => {
    const result = findCleanup(
      input([
        secret("keda-creds"),
        cm("keda-conf"),
        [TRIGGER_AUTH, o("auth", { spec: { secretTargetRef: [{ parameter: "p", name: "keda-creds", key: "k" }], configMapTargetRef: [{ parameter: "q", name: "keda-conf", key: "c" }] } })],
      ]),
    );
    expect(names(result, "candidates", ["ConfigMap", "Secret"])).toEqual([]);
  });

  it("a StorageClass naming an SMB Secret keeps it; a templated name keeps every Secret of the claims' namespace", () => {
    const smb = [STORAGE_CLASS, o("smb", { provisioner: "smb.csi.k8s.io", parameters: { "csi.storage.k8s.io/node-stage-secret-name": "smbcreds", "csi.storage.k8s.io/node-stage-secret-namespace": "app" } }, null)] as Entry;
    expect(names(findCleanup(input([secret("smbcreds"), secret("other"), smb])), "candidates", ["Secret"])).toEqual(["Secret/other"]);

    const templatedClass = [STORAGE_CLASS, o("per-claim", { parameters: { "csi.storage.k8s.io/node-publish-secret-name": "${pvc.name}", "csi.storage.k8s.io/node-publish-secret-namespace": "${pvc.namespace}" } }, null)] as Entry;
    const user = claim("data", { spec: { storageClassName: "per-claim" }, metadata: { creationTimestamp: RECENT } });
    expect(names(findCleanup(input([secret("other"), templatedClass, user])), "candidates", ["Secret"])).toEqual([]);
  });

  it("a PersistentVolume's CSI secret reference and a Pod's cephfs secret keep them", () => {
    const pv = [PV, o("pv-1", { spec: { csi: { driver: "x", nodeStageSecretRef: { name: "csi-creds", namespace: "app" } } }, status: { phase: "Bound" } }, null)] as Entry;
    const pod = [POD, o("p", { spec: podSpec({ volumes: [{ name: "c", cephfs: { monitors: ["m"], secretRef: { name: "ceph-key" } } }] }) })] as Entry;
    expect(names(findCleanup(input([secret("csi-creds"), secret("ceph-key"), pv, pod])), "candidates", ["Secret"])).toEqual([]);
  });

  it("a controller argument naming ns/name, or the name with its own namespace variable, keeps it", () => {
    const controller = [POD, o("ctl", { spec: podSpec({ containers: [{ name: "c", args: ["--default-ssl-certificate=app/wildcard", "--configmap=$(POD_NAMESPACE)/ctl-conf"] }] }) })] as Entry;
    const result = findCleanup(input([secret("wildcard", "kubernetes.io/tls"), cm("ctl-conf"), controller]));
    expect(names(result, "candidates", ["ConfigMap", "Secret"])).toEqual([]);
  });

  it("a namespace holding Argo CD Applications offers no ConfigMap, Secret or claim and is not empty", () => {
    const result = findCleanup(
      input([cm("orphan"), secret("old"), claim("data")], { samples: { app: sample([{ kind: APPLICATION, names: ["shop"] }]) } }),
    );
    expect(names(result, "candidates", ["ConfigMap", "Secret", "PersistentVolumeClaim", "Namespace"])).toEqual([]);
    expect(result.blocked).toEqual([{ namespace: "app", kinds: ["Application"] }]);
  });

  it("a namespace whose sample failed or has not come offers nothing of those kinds", () => {
    for (const s of [{ state: "failed" } as NamespaceSample, undefined]) {
      const result = findCleanup(input([cm("orphan"), claim("data")], { samples: { app: s } }));
      expect(names(result, "candidates", ["ConfigMap", "PersistentVolumeClaim", "Namespace"])).toEqual([]);
    }
  });

  it("an empty namespace is offered only when every sampled kind holds nothing but the defaults", () => {
    const defaults = sample([
      { kind: CONFIG_MAP, names: ["kube-root-ca.crt"] },
      { kind: SERVICE_ACCOUNT, names: ["default"] },
      { kind: SECRET, names: ["default-token-abc"], sa: "default" },
    ]);
    const entries: Entry[] = [cm("kube-root-ca.crt"), [SERVICE_ACCOUNT, o("default")]];
    expect(names(findCleanup(input(entries, { samples: { app: defaults } })), "candidates", ["Namespace"])).toEqual(["Namespace/app"]);
    const withRole = sample([{ kind: ROLE, names: ["reader"] }]);
    expect(names(findCleanup(input(entries, { samples: { app: withRole } })), "candidates", ["Namespace"])).toEqual([]);
    const unreadable = sample([{ kind: ROLE, error: true }]);
    expect(names(findCleanup(input(entries, { samples: { app: unreadable } })), "candidates", ["Namespace"])).toEqual([]);
  });

  it("a Released volume with reclaim policy Retain is kept on purpose; a claim says what happens to its data", () => {
    const pv = (name: string, policy: string, phase = "Released"): Entry => [
      PV,
      o(name, { spec: { persistentVolumeReclaimPolicy: policy, claimRef: { namespace: "app", name: "gone" } }, status: { phase, lastPhaseTransitionTime: OLD } }, null),
    ];
    const result = findCleanup(input([pv("kept", "Retain"), pv("dropped", "Delete"), pv("bound", "Delete", "Bound"), claim("data", { spec: { volumeName: "bound" } })]));
    expect(names(result, "candidates", ["PersistentVolume"])).toEqual(["PersistentVolume/dropped"]);
    expect(result.kept.map((c) => [c.name, c.keptBecause])).toEqual([["kept", "retain"]]);
    expect(result.candidates.find((c) => c.name === "dropped")?.sinceKind).toBe("phaseChanged");
    expect(result.candidates.find((c) => c.name === "data")?.notes).toEqual([{ id: "reclaimDelete", values: { volume: "bound", policy: "Delete" } }]);
  });
});

describe("second review of #147", () => {
  const ROLLOUT: KindRef = { group: "argoproj.io", version: "v1alpha1", kind: "Rollout" };
  const withRollout: NamespaceSample = {
    state: "ready",
    kinds: [{ kind: ROLLOUT, objects: [{ name: "web", serviceAccount: null }], more: false, error: null }],
  };
  const svc = (name: string): Entry => [SERVICE, o(name, { spec: { selector: { app: name } } })];

  it("a Service is not offered while an unknown custom kind (an Argo Rollout at 0) lives in its namespace", () => {
    expect(names(findCleanup(input([svc("web")])), "candidates", ["Service"])).toEqual(["Service/web"]);
    const result = findCleanup(input([svc("web")], { samples: { app: withRollout } }));
    expect(names(result, "candidates", ["Service"])).toEqual([]);
    expect(result.blocked).toEqual([{ namespace: "app", kinds: ["Rollout"] }]);
  });

  it("an API group that does not answer offers no namespace, ConfigMap, Secret, claim or Service anywhere", () => {
    const entries: Entry[] = [cm("orphan"), secret("old"), [PVC, o("data")], svc("web")];
    const result = findCleanup(input(entries, { cluster: clusterReady(entries, [], ["metrics.example.com/v1beta1"]) }));
    expect(names(result, "candidates", ["ConfigMap", "Secret", "PersistentVolumeClaim", "Service", "Namespace"])).toEqual([]);
    expect(result.unavailableGroups).toEqual(["metrics.example.com/v1beta1"]);
  });

  it("a Secret a cluster-scoped object names, one not looked for, or any while a kind is unread, is not offered", () => {
    const entries: Entry[] = [secret("aws-creds"), secret("free"), secret("new")];
    const looked = clusterReady([secret("aws-creds"), secret("free")], ["Secret/app/aws-creds"]);
    expect(names(findCleanup(input(entries, { cluster: looked })), "candidates", ["Secret"])).toEqual(["Secret/free"]);
    const unread: ClusterState = { ...(looked as Exclude<ClusterState, undefined | { state: "failed" }>), unread: ["ProviderConfig"] };
    const result = findCleanup(input(entries, { cluster: unread }));
    expect(names(result, "candidates", ["Secret"])).toEqual([]);
    expect(result.clusterUnread).toEqual(["ProviderConfig"]);
    expect(names(findCleanup(input(entries, { cluster: null })), "candidates", ["Secret", "Namespace"])).toEqual([]);
  });

  it("a Gateway's infrastructure parametersRef keeps its ConfigMap", () => {
    const gateway = [
      GATEWAY,
      o("gw", { spec: { gatewayClassName: "c", listeners: [], infrastructure: { parametersRef: { group: "", kind: "ConfigMap", name: "gw-params" } } } }),
    ] as Entry;
    expect(names(findCleanup(input([cm("gw-params"), gateway])), "candidates", ["ConfigMap"])).toEqual([]);
  });
});
