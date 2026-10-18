// The security category of the problems screen and the notifications (#143): what counts, which watch carries it, and
// that it stays off for notifications until turned on.
import { afterEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type KindRef, type KubeObject } from "../../api";
import { emitSnapshot, watchBackend, watchOf } from "../details/testing";
import { nodeHealth } from "../resource-map/health";
import type { GraphNode } from "../resource-map/relations";
import { acquireSource, getSource, resetProblemSources } from "../problems/store";
import { messageText } from "../notifications/engine";
import { categoryOn, enabledCategories, prefsOf, setCategory, suppressedBy } from "../notifications/prefs";
import {
  categoryOf,
  CRONJOB,
  DEPLOYMENT,
  JOB,
  DAEMONSET,
  NOTIFY_CATEGORIES,
  OPT_IN_CATEGORIES,
  POD,
  REPLICASET,
  resolve,
  securityProblems,
} from "../problems/model";
import { CATEGORY_SOURCES, sourceKey, sourcesFor } from "../problems/sources";

const privilegedSpec = { containers: [{ name: "app", image: "nginx:1.27", securityContext: { privileged: true } }], hostNetwork: true };

const deployment: KubeObject = { metadata: { name: "agent", namespace: "infra", uid: "d1" }, spec: { template: { spec: privilegedSpec } } };
const barePod: KubeObject = { metadata: { name: "debug", namespace: "infra", uid: "p1" }, spec: privilegedSpec, status: { phase: "Running" } };
const ownedPod: KubeObject = {
  metadata: { name: "agent-x", namespace: "infra", uid: "p2", ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "agent-1a2b3c4d5e", uid: "r", controller: true }] },
  spec: privilegedSpec,
  status: { phase: "Running" },
};

describe("security problems", () => {
  it("a workload that violates Baseline is one problem naming the fields", () => {
    expect(securityProblems(DEPLOYMENT, deployment)).toEqual([
      {
        reason: "PodSecurityBaseline",
        group: "security",
        messageKey: "messages.securityBaseline",
        messageParams: { count: 2 },
        messageLists: { fields: ["hostNetwork", "privileged"] },
        notify: true,
      },
    ]);
    // The field list is joined when the text is shown, in the language of that moment.
    expect(messageText(securityProblems(DEPLOYMENT, deployment)[0]!)).toContain("hostNetwork, privileged");
  });

  it("Restricted findings and hints are not problems; owned pods and Jobs are judged through their owner", () => {
    const restrictedOnly: KubeObject = { metadata: { name: "web" }, spec: { template: { spec: { containers: [{ name: "app", image: "nginx" }] } } } };
    expect(securityProblems(DEPLOYMENT, restrictedOnly)).toEqual([]);
    expect(securityProblems(POD, ownedPod)).toEqual([]);
    const cronJobRun: KubeObject = { ...deployment, metadata: { name: "b-1", ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "b", uid: "c", controller: true }] } };
    expect(securityProblems(JOB, cronJobRun)).toEqual([]);
  });

  it("judges a Pod, ReplicaSet or Job itself only when no judged controller holds its template", () => {
    const owned = (obj: KubeObject, kind: string): KubeObject => ({
      ...obj,
      metadata: { ...obj.metadata, ownerReferences: [{ apiVersion: "v1", kind, name: "x", uid: "o", controller: true }] },
    });
    const rs: KubeObject = { metadata: { name: "rs", uid: "r1" }, spec: { template: { spec: privilegedSpec } } };
    expect(securityProblems(REPLICASET, rs)).toHaveLength(1);
    expect(securityProblems(REPLICASET, owned(rs, "Deployment"))).toEqual([]);
    // An Argo Rollout's ReplicaSet, a static Pod (owned by its Node) and a Pod of an unknown controller are judged.
    expect(securityProblems(REPLICASET, owned(rs, "Rollout"))).toHaveLength(1);
    expect(securityProblems(POD, owned(barePod, "Node"))).toHaveLength(1);
    expect(securityProblems(POD, owned(barePod, "PipelineRun"))).toHaveLength(1);
    expect(securityProblems(POD, owned(barePod, "DaemonSet"))).toEqual([]);
  });

  it("are found only by security sources: a kind's own rules, the map's colours and CronJobs stay as they were", () => {
    expect(resolve(POD, barePod, 0)).toEqual([]);
    expect(resolve(POD, barePod, 0, [], "security").map((p) => [p.category, p.reason])).toEqual([["security", "PodSecurityBaseline"]]);
    expect(categoryOf(CRONJOB)).toBeUndefined();
    const node = (kind: KindRef, obj: KubeObject) => ({ kind, obj }) as unknown as GraphNode;
    const kubeProxy: KubeObject = {
      metadata: { name: "kube-proxy", uid: "ds1" },
      spec: { template: { spec: { hostNetwork: true, containers: [{ name: "p", image: "k:1", securityContext: { privileged: true } }], volumes: [{ name: "m", hostPath: { path: "/lib/modules" } }] } } },
      status: { desiredNumberScheduled: 2, numberReady: 2 },
    };
    expect(nodeHealth(node(DAEMONSET, kubeProxy), Date.now())).toBe("ok");
    expect(nodeHealth(node(CRONJOB, { metadata: { name: "c" }, spec: { jobTemplate: { spec: { template: { spec: privilegedSpec } } } } }), Date.now())).toBe(
      "neutral",
    );
  });

  it("have sources of their own, never shared with the pods and workloads sources", () => {
    const keys = (category: keyof typeof CATEGORY_SOURCES) => CATEGORY_SOURCES[category].map((d) => sourceKey("c1", d));
    const shared = [...keys("pods"), ...keys("workloads"), ...keys("jobs")];
    const security = keys("security");
    expect(security.filter((k) => shared.includes(k))).toEqual([]);
    expect(security).toHaveLength(7);
    const all = sourcesFor(["pods", "workloads", "jobs", "security"], []).map((d) => sourceKey("c1", d));
    expect(all).toHaveLength(new Set(all).size);
  });
});

describe("the problem store", () => {
  afterEach(() => resetProblemSources());

  it("keeps security problems only in a security source, so they never take a pods source's place", async () => {
    const wb = watchBackend();
    try {
      const [podsDef] = CATEGORY_SOURCES.pods;
      const securityDef = CATEGORY_SOURCES.security.find((d) => d.kind.kind === "Pod")!;
      const releasePods = acquireSource("c1", podsDef!);
      const podsWatch = await watchOf(wb, "Pod");
      emitSnapshot(wb, podsWatch, [barePod]);
      expect(getSource(sourceKey("c1", podsDef!))?.problems).toEqual([]);
      // Turned on: a watch of its own, with the problem.
      const releaseSecurity = acquireSource("c1", securityDef);
      const securityWatch = await watchOf(wb, "Pod", () => wb.specs.size === 2);
      expect(securityWatch).not.toBe(podsWatch);
      emitSnapshot(wb, securityWatch, [barePod]);
      expect(getSource(sourceKey("c1", securityDef))?.problems.map((p) => p.reason)).toEqual(["PodSecurityBaseline"]);
      expect(getSource(sourceKey("c1", podsDef!))?.problems).toEqual([]);
      releasePods();
      releaseSecurity();
    } finally {
      wb.backend.restore();
    }
  });
});

describe("notifications of the security category", () => {
  it("are off until turned on, and turned on by their own toggle", () => {
    expect(OPT_IN_CATEGORIES).toEqual(["security"]);
    expect(NOTIFY_CATEGORIES).toContain("security");
    let settings = defaultAppSettings();
    let prefs = prefsOf(settings)!;
    expect(categoryOn(prefs, "security")).toBe(false);
    expect(categoryOn(prefs, "pods")).toBe(true);
    expect(enabledCategories(prefs)).not.toContain("security");
    expect(suppressedBy(prefs, "c1", "security", 0)).toBe("category");

    settings = setCategory("security", true)(settings);
    expect(settings.notifications.enabledCategories).toEqual(["security"]);
    expect(settings.notifications.disabledCategories).toEqual([]);
    prefs = prefsOf(settings)!;
    expect(enabledCategories(prefs)).toContain("security");
    expect(suppressedBy(prefs, "c1", "security", 0)).toBeNull();

    settings = setCategory("security", false)(settings);
    expect(settings.notifications.enabledCategories).toEqual([]);
    // The other categories keep their "on unless turned off" rule.
    expect(setCategory("pods", false)(settings).notifications.disabledCategories).toEqual(["pods"]);
  });
});
