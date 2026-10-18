import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { GATEWAY, HTTP_ROUTE } from "../gateway-api/model";
import { deletionImpact, descendants } from "./impact";
import { DEPLOYMENT, ENDPOINT_SLICE, HPA, INGRESS, NETWORK_POLICY, PDB, POD, PV, PVC, SERVICE, SERVICE_ACCOUNT } from "./kinds";
import { buildGraph, keyOf, neighbours, references, type Graph, type Relation } from "./relations";
import * as data from "./testData";

const key = (group: string, kind: string, namespace: string | null, name: string) => keyOf({ group, kind, namespace, name });
const shop = (group: string, kind: string, name: string) => key(group, kind, "shop", name);

/** `relation → kind/name` of what `obj` names. */
function named(kind: Parameters<typeof references>[0], obj: KubeObject): string[] {
  return references(kind, obj)
    .map((r) => `${r.relation}${r.optional ? "?" : ""}${r.template ? "(t)" : ""}${r.reverse ? "<" : ""} ${r.to.kind}/${r.to.namespace ?? "-"}/${r.to.name}`)
    .sort();
}

describe("references", () => {
  const cases: [string, Parameters<typeof references>[0], KubeObject, string[]][] = [
    [
      "a pod: owner, volumes (optional flagged), projected, env, pull secret, service account, node",
      POD,
      data.pods[0]!,
      [
        "env Secret/shop/web-env",
        "env ConfigMap/shop/web-config",
        "node Node/-/node-1",
        "owner ReplicaSet/shop/web-7d9f8c6b5",
        "pullSecret Secret/shop/regcred",
        "serviceAccount ServiceAccount/shop/web",
        "volume ConfigMap/shop/web-config",
        "volume Secret/shop/web-certs",
        "volume? ConfigMap/shop/flags",
      ].sort(),
    ],
    [
      "a top-level Deployment: its template's references",
      DEPLOYMENT,
      data.deployment,
      [
        "env(t) ConfigMap/shop/web-config",
        "env(t) Secret/shop/web-env",
        "pullSecret(t) Secret/shop/regcred",
        "serviceAccount(t) ServiceAccount/shop/web",
        "volume(t) ConfigMap/shop/web-config",
        "volume(t) Secret/shop/web-certs",
        "volume?(t) ConfigMap/shop/flags",
      ].sort(),
    ],
    ["a controlled ReplicaSet: only its owner (the template is its owner's)", { group: "apps", kind: "ReplicaSet" }, data.replicaSet, ["owner Deployment/shop/web"]],
    ["a CronJob: its job template's pod template", { group: "batch", kind: "CronJob" }, data.cronJob, ["env(t) ConfigMap/shop/report-config"]],
    [
      "an Ingress: backends, TLS Secrets, class",
      INGRESS,
      data.ingress,
      ["class IngressClass/-/nginx", "routesTo Service/shop/web", "tls Secret/shop/shop-tls"],
    ],
    [
      "an HTTPRoute: backends and parents through the Gateway API model",
      HTTP_ROUTE,
      data.httpRoute,
      ["parent Gateway/infra/public-gw", "routesTo Service/shop/gone", "routesTo Service/shop/web"],
    ],
    ["an HPA: its scale target", HPA, data.hpa, ["scales Deployment/shop/web"]],
    [
      "an EndpointSlice owned by its Service: the owner edge and the pods, no duplicate label edge",
      ENDPOINT_SLICE,
      data.endpointSlice,
      ["endpoint Pod/shop/web-7d9f8c6b5-a1", "endpoint Pod/shop/web-7d9f8c6b5-b2", "owner Service/shop/web"],
    ],
    [
      "an EndpointSlice without an owner: the service-name label",
      ENDPOINT_SLICE,
      { metadata: { name: "s", namespace: "shop", labels: { "kubernetes.io/service-name": "web" } } },
      ["endpointsFor Service/shop/web"],
    ],
    ["a PVC: its volume and class", PVC, data.claim, ["boundTo PersistentVolume/-/pv-1", "storageClass StorageClass/-/standard"]],
    ["a PV: its claim (reversed) and class", PV, data.volume, ["boundTo< PersistentVolumeClaim/shop/data-db-0", "storageClass StorageClass/-/standard"]],
    [
      "a PVC with the beta class annotation",
      PVC,
      { metadata: { name: "old", namespace: "shop", annotations: { "volume.beta.kubernetes.io/storage-class": "slow" } } },
      ["storageClass StorageClass/-/slow"],
    ],
    [
      "a ServiceAccount: its image pull secrets",
      SERVICE_ACCOUNT,
      { metadata: { name: "web", namespace: "shop" }, imagePullSecrets: [{ name: "regcred" }] },
      ["pullSecret Secret/shop/regcred"],
    ],
    [
      "a Gateway: its class and listener certificates",
      GATEWAY,
      {
        metadata: { name: "public-gw", namespace: "infra" },
        spec: {
          gatewayClassName: "eg",
          listeners: [{ name: "https", port: 443, protocol: "HTTPS", tls: { certificateRefs: [{ name: "wild", namespace: "certs" }] } }],
        },
      },
      ["class GatewayClass/-/eg", "tls Secret/certs/wild"],
    ],
    ["a Service names nothing itself", SERVICE, data.service, []],
  ];
  it.each(cases)("%s", (_name, kind, obj, expected) => {
    expect(named(kind, obj)).toEqual(expected);
  });
});

describe("the graph", () => {
  const graph = buildGraph(data.SHOP_WITH_PV);
  const edges = (g: Graph, from: string, relation: Relation) =>
    (g.out.get(from) ?? []).filter((e) => e.relation === relation).map((e) => e.to).sort();

  it("a Service selects its pods; one without a selector selects none", () => {
    expect(edges(graph, shop("", "Service", "web"), "selects")).toEqual(
      data.pods.map((p) => shop("", "Pod", p.metadata!.name!)).sort(),
    );
    expect(edges(graph, shop("", "Service", "legacy"), "selects")).toEqual([]);
  });

  it("a deny-all NetworkPolicy selects every pod of the namespace; a PDB its labelled pods", () => {
    expect(edges(graph, shop(NETWORK_POLICY.group, "NetworkPolicy", "deny-all"), "selects")).toHaveLength(4);
    expect(edges(graph, shop(PDB.group, "PodDisruptionBudget", "web"), "selects")).toHaveLength(2);
  });

  it("the PV's claimRef and the claim's volumeName are one edge", () => {
    const pvKey = key("", "PersistentVolume", null, "pv-1");
    const incoming = graph.in.get(pvKey) ?? [];
    expect(incoming.map((e) => `${e.relation} ${e.from}`)).toEqual([`boundTo ${shop("", "PersistentVolumeClaim", "data-db-0")}`]);
  });

  it("names not watched are placeholders; with complete lists a missing one is marked", () => {
    expect(graph.nodes.get(shop("", "ConfigMap", "web-config"))?.obj).toBeUndefined();
    expect(graph.nodes.get(shop("", "Service", "gone"))?.missing).toBeUndefined();
    const complete = buildGraph(data.SHOP, { complete: (ref) => ref.kind === "Service" && ref.namespace === "shop" });
    expect(complete.nodes.get(shop("", "Service", "gone"))?.missing).toBe(true);
    expect(complete.nodes.get(shop("", "Service", "web"))?.missing).toBeUndefined();
    expect(complete.nodes.get(shop("", "ConfigMap", "web-config"))?.missing).toBeUndefined();
  });

  it("a required reference wins over an optional one, a pod's over a template's", () => {
    const pod = shop("", "Pod", "web-7d9f8c6b5-a1");
    const g = buildGraph([
      {
        kind: POD,
        items: [
          {
            metadata: { name: "web-7d9f8c6b5-a1", namespace: "shop" },
            spec: {
              volumes: [
                { name: "a", configMap: { name: "c", optional: true } },
                { name: "b", configMap: { name: "c" } },
              ],
            },
          },
        ],
      },
    ]);
    expect(g.out.get(pod)?.find((e) => e.relation === "volume")?.optional).toBeUndefined();
  });

  it("neighbours: one hop both ways, grouped, outgoing first", () => {
    const groups = neighbours(graph, shop("", "Service", "web")).map(
      (g) => `${g.relation}/${g.direction}: ${g.items.map((i) => i.node.ref.name).join(",")}`,
    );
    expect(groups).toEqual([
      "owner/in: web-x7k2p",
      "routesTo/in: web,shop", // HTTPRoute before Ingress
      "selects/out: web-7d9f8c6b5-a1,web-7d9f8c6b5-b2",
    ]);
  });

  it("the opened object wins over a list that holds it too", () => {
    const fresh = { ...data.service, spec: { selector: { app: "none" } } };
    const g = buildGraph([{ kind: SERVICE, items: [fresh] }, ...data.SHOP]);
    expect(g.nodes.get(shop("", "Service", "web"))?.obj).toBe(fresh);
    expect(edges(g, shop("", "Service", "web"), "selects")).toEqual([]);
  });
});

describe("what breaks if it is deleted", () => {
  const graph = buildGraph(data.SHOP_WITH_PV);
  const lines = (k: string) => deletionImpact(graph, k).map((l) => `${l.id}:${l.count}`);

  const cases: [string, string, string[]][] = [
    ["a ConfigMap mounted and read by pods and a template", shop("", "ConfigMap", "web-config"), ["mountedBy:2", "envFrom:2", "templates:1"]],
    ["an optional ConfigMap: nothing", shop("", "ConfigMap", "flags"), []],
    ["a Secret for env, TLS and pulls", shop("", "Secret", "web-env"), ["envFrom:2", "templates:1"]],
    ["a pull secret", shop("", "Secret", "regcred"), ["templates:1", "pullSecret:2"]],
    ["an Ingress TLS Secret", shop("", "Secret", "shop-tls"), ["tls:1"]],
    ["a Deployment: cascade through its ReplicaSet to the pods, and its HPA", shop("apps", "Deployment", "web"), ["cascade:3", "scaledBy:1"]],
    ["a pod: its ReplicaSet creates it again", shop("", "Pod", "web-7d9f8c6b5-a1"), ["recreated:1"]],
    ["a Service: routes lose it, slices go with it, pods stop getting traffic", shop("", "Service", "web"), ["cascade:1", "routes:2", "trafficStops:2"]],
    ["a PDB", shop("policy", "PodDisruptionBudget", "web"), ["budgetLost:2"]],
    ["a NetworkPolicy", shop("networking.k8s.io", "NetworkPolicy", "deny-all"), ["policyLost:4"]],
    ["a claim in use", shop("", "PersistentVolumeClaim", "data-db-0"), ["claimInUse:1"]],
    ["a bound volume", key("", "PersistentVolume", null, "pv-1"), ["boundClaims:1"]],
    ["a storage class", key("storage.k8s.io", "StorageClass", null, "standard"), ["storageClass:2"]],
    ["a node", key("", "Node", null, "node-1"), ["node:3"]],
    ["a CronJob: its Job and the Job's pod", shop("batch", "CronJob", "report"), ["cascade:2"]],
    ["a Gateway with a route attached", key("gateway.networking.k8s.io", "Gateway", "infra", "public-gw"), ["parent:1"]],
  ];
  it.each(cases)("%s", (_name, k, expected) => {
    expect(lines(k)).toEqual(expected);
  });

  it("the cascade names the kinds; the recreating owner is named", () => {
    const cascade = deletionImpact(graph, shop("apps", "Deployment", "web")).find((l) => l.id === "cascade");
    expect(cascade?.kinds).toEqual(["Pod", "ReplicaSet"]);
    const recreated = deletionImpact(graph, shop("", "Pod", "db-0")).find((l) => l.id === "recreated");
    expect(recreated?.owner).toEqual({ kind: "StatefulSet", name: "db" });
    expect(descendants(graph, shop("apps", "Deployment", "web"))).toHaveLength(3);
  });
});

describe("garbage collection and recreation", () => {
  const ownerRef = (kind: string, apiVersion: string, name: string, uid: string, controller = true) => ({ apiVersion, kind, name, uid, controller });
  const rs = (name: string, uid: string, replicas: number): KubeObject => ({
    metadata: { name, namespace: "shop", uid, ownerReferences: [ownerRef("Deployment", "apps/v1", "web", "uid-web")] },
    spec: { replicas },
  });
  const pod = (name: string, owners: object[]): KubeObject => ({ metadata: { name, namespace: "shop", uid: `uid-${name}`, ownerReferences: owners } });
  const deployment: KubeObject = { metadata: { name: "web", namespace: "shop", uid: "uid-web" } };
  const lines = (g: Graph, k: string) => deletionImpact(g, k).map((l) => `${l.id}:${l.count}`);

  it("counts only dependents that name the object by uid and have no other owner left", () => {
    const keeper: KubeObject = { metadata: { name: "keeper", namespace: "shop", uid: "uid-keeper" } };
    const g = buildGraph([
      { kind: DEPLOYMENT, items: [deployment] },
      { kind: { group: "apps", version: "v1", kind: "ReplicaSet" }, items: [rs("web-1", "uid-rs-1", 2), keeper] },
      {
        kind: POD,
        items: [
          pod("only-mine", [ownerRef("Deployment", "apps/v1", "web", "uid-web")]),
          // Also owned by an object that stays: the collector keeps it.
          pod("shared", [ownerRef("Deployment", "apps/v1", "web", "uid-web"), ownerRef("ReplicaSet", "apps/v1", "keeper", "uid-keeper", false)]),
          // Names an older Deployment "web" (another uid): not this one's dependent.
          pod("stale", [ownerRef("Deployment", "apps/v1", "web", "uid-old-web")]),
        ],
      },
    ]);
    const cascade = deletionImpact(g, shop("apps", "Deployment", "web")).find((l) => l.id === "cascade");
    expect(cascade?.keys.sort()).toEqual([shop("", "Pod", "only-mine"), shop("apps", "ReplicaSet", "web-1")].sort());
  });

  it("a dependent of two owners goes when both go in the same cascade", () => {
    const g = buildGraph([
      { kind: DEPLOYMENT, items: [deployment] },
      { kind: { group: "apps", version: "v1", kind: "ReplicaSet" }, items: [rs("web-1", "uid-rs-1", 1)] },
      {
        kind: POD,
        items: [pod("both", [ownerRef("Deployment", "apps/v1", "web", "uid-web"), ownerRef("ReplicaSet", "apps/v1", "web-1", "uid-rs-1")])],
      },
    ]);
    expect(lines(g, shop("apps", "Deployment", "web"))).toEqual(["cascade:2"]);
    // The ReplicaSet alone: the Deployment still owns the pod.
    expect(lines(g, shop("apps", "ReplicaSet", "web-1"))).toEqual(["recreated:1"]);
  });

  it("a Deployment recreates only its current ReplicaSet; a CronJob never recreates a Job; a finished Job not its pods", () => {
    const g = buildGraph([
      { kind: DEPLOYMENT, items: [deployment] },
      { kind: { group: "apps", version: "v1", kind: "ReplicaSet" }, items: [rs("web-new", "uid-new", 3), rs("web-old", "uid-old", 0)] },
    ]);
    expect(lines(g, shop("apps", "ReplicaSet", "web-new"))).toEqual(["recreated:1"]);
    expect(lines(g, shop("apps", "ReplicaSet", "web-old"))).toEqual([]);

    const shopGraph = buildGraph(data.SHOP);
    expect(lines(shopGraph, shop("batch", "Job", "report-29000000"))).toEqual(["cascade:1"]);
    expect(lines(shopGraph, shop("", "Pod", "report-29000000-q8x"))).toEqual([]);
    const running = { ...data.job, status: { active: 1 } };
    const runningGraph = buildGraph([{ kind: { group: "batch", version: "v1", kind: "Job" }, items: [running] }, { kind: POD, items: [data.jobPod] }]);
    expect(lines(runningGraph, shop("", "Pod", "report-29000000-q8x"))).toEqual(["recreated:1"]);
  });
});

