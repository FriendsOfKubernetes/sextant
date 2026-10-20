import { describe, expect, it } from "vitest";
import type { KindRef, KubeObject } from "../../api";
import { ALERTMANAGER, PROMETHEUS, SERVICE_MONITOR } from "../prometheus-operator/model";
import { judgedByRules } from "../problems/sources";
import { nodeHealth } from "./health";
import type { GraphNode } from "./relations";

const node = (kind: KindRef, obj: KubeObject) => ({ kind, obj }) as unknown as GraphNode;
const ready: KubeObject = {
  metadata: { name: "main", namespace: "monitoring", uid: "p1" },
  spec: { replicas: 1 },
  status: { conditions: [{ type: "Available", status: "True" }, { type: "Reconciled", status: "True" }] },
};

describe("map health", () => {
  it("never shows green for a kind whose problems a provider finds across objects", () => {
    // A ServiceMonitor that selects nothing is a problem only the provider sees: no rule finding is not "fine".
    const monitor: KubeObject = { metadata: { name: "orphan", namespace: "default", uid: "m1" }, spec: { selector: { matchLabels: { app: "gone" } } } };
    expect(judgedByRules(SERVICE_MONITOR)).toBe(false);
    expect(nodeHealth(node(SERVICE_MONITOR, monitor), Date.now())).toBe("neutral");
    // Prometheus and Alertmanager are watched and judged by the rules themselves.
    expect(judgedByRules(PROMETHEUS)).toBe(true);
    expect(judgedByRules(ALERTMANAGER)).toBe(true);
    expect(nodeHealth(node(PROMETHEUS, ready), Date.now())).toBe("ok");
    // Kinds of categories without a provider are as before.
    expect(judgedByRules({ group: "apps", kind: "Deployment" })).toBe(true);
  });
});
