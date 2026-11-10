import { describe, expect, it } from "vitest";
import type { KindRef, KubeObject } from "../../api";
import { judgedByRules } from "../problems/sources";
import { nodeHealth } from "./health";
import type { GraphNode } from "./relations";

const node = (kind: KindRef, obj: KubeObject) => ({ kind, obj }) as unknown as GraphNode;
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const HELM_CHART: KindRef = { group: "helm.cattle.io", version: "v1", kind: "HelmChart" };

describe("map health", () => {
  it("never shows green for a kind Sextant's own rules do not judge", () => {
    // A HelmChart's outcome is its Job, judged by Sextant's own extension `extensions/k3s` (ADR-0162 amendment), not by
    // the built-in rules: no rule finding is not "fine".
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
