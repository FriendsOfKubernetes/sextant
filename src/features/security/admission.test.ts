// What is judged on its own, and what a live Pod adds at admission (a webhook injecting `istio-init`).
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { judgeObjects } from "./admission";
import { evaluateObject, signature } from "./pss";

const owner = (kind: string, name: string) => [{ apiVersion: "v1", kind, name, uid: `${kind}-${name}`, controller: true }];

/** A container that meets Restricted. */
const app = {
  name: "app",
  image: "nginx:1.27",
  securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } },
};
const istioInit = {
  name: "istio-init",
  image: "istio/proxyv2:1.24",
  securityContext: { ...app.securityContext, capabilities: { drop: ["ALL"], add: ["NET_ADMIN", "NET_RAW"] } },
};

const deployment: KubeObject = { metadata: { name: "web", namespace: "shop" }, spec: { template: { spec: { containers: [app] } } } };
const rs: KubeObject = {
  metadata: { name: "web-7d9c6b8f5d", namespace: "shop", ownerReferences: owner("Deployment", "web") },
  spec: { template: { spec: { containers: [app] } } },
};
const injected: KubeObject = {
  metadata: { name: "web-7d9c6b8f5d-abcde", namespace: "shop", ownerReferences: owner("ReplicaSet", "web-7d9c6b8f5d") },
  spec: { initContainers: [istioInit], containers: [app] },
};
const plain = (name: string): KubeObject => ({ ...injected, metadata: { ...injected.metadata, name }, spec: { containers: [app] } });

const judge = (lists: { kind: string; items: KubeObject[] }[]) => judgeObjects(lists, (kind, obj) => evaluateObject(kind, obj));

describe("judging with the live Pods", () => {
  it("reports what admission added to a Deployment's Pods on the Deployment, without a fix", () => {
    const judged = judge([
      { kind: "Deployment", items: [deployment] },
      { kind: "ReplicaSet", items: [rs] },
      { kind: "Pod", items: [plain("web-7d9c6b8f5d-aaaaa"), injected] },
    ]);
    expect(judged.map((j) => `${j.kind}/${j.obj.metadata?.name}`)).toEqual(["Deployment/web"]);
    const added = judged[0]!.findings.filter((f) => f.admittedIn);
    expect(added.map((f) => [f.check, f.level, f.container, f.admittedIn])).toEqual([
      ["capabilities", "baseline", "istio-init", "web-7d9c6b8f5d-abcde"],
    ]);
  });

  it("does not repeat what the template already has, wherever the injected container moved it", () => {
    const privileged = { ...app, securityContext: { ...app.securityContext, privileged: true } };
    const template: KubeObject = { ...deployment, spec: { template: { spec: { containers: [privileged] } } } };
    const pod: KubeObject = { ...injected, spec: { containers: [{ name: "istio-proxy", image: "istio/proxyv2:1.24", securityContext: app.securityContext }, privileged] } };
    const judged = judge([
      { kind: "Deployment", items: [template] },
      { kind: "ReplicaSet", items: [rs] },
      { kind: "Pod", items: [pod] },
    ]);
    expect(judged[0]!.findings.filter((f) => f.admittedIn)).toEqual([]);
    const [fromTemplate] = evaluateObject("Deployment", template);
    const [fromPod] = evaluateObject("Pod", pod).filter((f) => f.check === "privileged");
    expect(fromTemplate!.path).not.toBe(fromPod!.path);
    expect(signature(fromTemplate!)).toBe(signature(fromPod!));
  });

  it("judges itself a Pod or ReplicaSet whose controller is not a judged kind, and a bare ReplicaSet", () => {
    const rolloutRs: KubeObject = { ...rs, metadata: { name: "canary-5f6d7c8b9a", namespace: "shop", ownerReferences: owner("Rollout", "canary") } };
    const rolloutPod: KubeObject = { ...plain("canary-5f6d7c8b9a-x"), metadata: { name: "canary-5f6d7c8b9a-x", namespace: "shop", ownerReferences: owner("ReplicaSet", "canary-5f6d7c8b9a") } };
    const staticPod: KubeObject = { ...plain("etcd-node1"), metadata: { name: "etcd-node1", namespace: "shop", ownerReferences: owner("Node", "node1") } };
    const bareRs: KubeObject = { ...rs, metadata: { name: "solo", namespace: "shop" } };
    const judged = judge([
      { kind: "ReplicaSet", items: [rolloutRs, bareRs] },
      { kind: "Pod", items: [rolloutPod, staticPod] },
    ]);
    expect(judged.map((j) => `${j.kind}/${j.obj.metadata?.name}`).sort()).toEqual([
      "Pod/etcd-node1",
      "ReplicaSet/canary-5f6d7c8b9a",
      "ReplicaSet/solo",
    ]);
  });
});
