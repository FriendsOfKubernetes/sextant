import { describe, expect, it } from "vitest";
import type { KindRef, KubeObject } from "../../api";
import { HELM_CHART } from "../k3s/model";
import { judgedByRules } from "../problems/sources";
import { nodeHealth } from "./health";
import type { GraphNode } from "./relations";

const node = (kind: KindRef, obj: KubeObject) => ({ kind, obj }) as unknown as GraphNode;
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };

describe("map health", () => {
  it("never shows green for a kind whose problems a provider finds across objects", () => {
    // A HelmChart's outcome is its Job, a problem only the provider of features/k3s sees: no rule finding is not "fine".
    const chart: KubeObject = { metadata: { name: "traefik", namespace: "kube-system", uid: "h1" }, spec: { chart: "traefik" } };
    expect(judgedByRules(HELM_CHART)).toBe(false);
    expect(nodeHealth(node(HELM_CHART, chart), Date.now())).toBe("neutral");
    // Kinds the rules judge themselves are "ok" without a finding.
    const ready: KubeObject = {
      metadata: { name: "web", namespace: "demo", uid: "d1", generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, replicas: 1, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 },
    };
    expect(judgedByRules(DEPLOYMENT)).toBe(true);
    expect(nodeHealth(node(DEPLOYMENT, ready), Date.now())).toBe("ok");
  });
});
