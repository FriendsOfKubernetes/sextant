// "Allocated resources" of a node (#280) as `kubectl describe node` sums them, with Sextant's pod amounts (ADR-0037).
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { allocatedResources, isTerminated, namespacesOf, nodePodsSpec } from "./model";

const node: KubeObject = {
  metadata: { name: "n1" },
  status: { allocatable: { cpu: "4", memory: "8Gi", pods: "110" } },
};

type Res = { requests?: Record<string, string>; limits?: Record<string, string> };
function pod(name: string, containers: Res[], phase = "Running", namespace = "shop"): KubeObject {
  return {
    metadata: { name, namespace },
    spec: { nodeName: "n1", containers: containers.map((resources, i) => ({ name: `c${i}`, resources })) },
    status: { phase },
  };
}

const GI = 1024 ** 3;
const MI = 1024 ** 2;

describe("allocated resources", () => {
  it("sums the requests and whole limits of the non-terminated pods against allocatable", () => {
    const pods = [
      pod("a", [{ requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "1", memory: "2Gi" } }]),
      pod("b", [
        { requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
        { requests: { cpu: "250m" }, limits: { cpu: "500m", memory: "512Mi" } },
      ]),
      // Done: holds nothing on the node.
      pod("done", [{ requests: { cpu: "3", memory: "6Gi" } }], "Succeeded"),
      pod("failed", [{ requests: { cpu: "3" } }], "Failed"),
    ];
    const a = allocatedResources(node, pods, { cpuMillicores: 1200, memoryBytes: 3 * GI });
    expect(a.cpu).toEqual({ allocatable: 4000, requests: 1000, limits: 2000, podsWithoutLimit: 0, usage: 1200 });
    expect(a.memory).toEqual({ allocatable: 8 * GI, requests: GI + 256 * MI, limits: 3 * GI, podsWithoutLimit: 0, usage: 3 * GI });
    expect(a.pods).toEqual({ count: 2, allocatable: 110 });
  });

  it("leaves out of the limit sum a pod whose limit is not on every container, and counts it", () => {
    const pods = [
      pod("whole", [{ limits: { cpu: "1", memory: "1Gi" } }]),
      // CPU limit on one of two containers: no CPU limit for the pod (ADR-0037); memory on both.
      pod("partial", [{ limits: { cpu: "2", memory: "1Gi" } }, { limits: { memory: "1Gi" } }]),
      pod("none", [{}]),
    ];
    const a = allocatedResources(node, pods);
    expect(a.cpu.limits).toBe(1000);
    expect(a.cpu.podsWithoutLimit).toBe(2);
    expect(a.memory.limits).toBe(3 * GI);
    expect(a.memory.podsWithoutLimit).toBe(1);
    expect(a.cpu.requests).toBe(0);
    expect(a.cpu.usage).toBeUndefined();
  });

  it("without the node object knows no allocatable", () => {
    const a = allocatedResources(null, [pod("a", [{ requests: { cpu: "100m" } }])]);
    expect(a.cpu.allocatable).toBeUndefined();
    expect(a.pods).toEqual({ count: 1, allocatable: undefined });
  });

  it("knows a terminated pod by its phase", () => {
    expect(isTerminated(pod("x", [], "Succeeded"))).toBe(true);
    expect(isTerminated(pod("x", [], "Pending"))).toBe(false);
  });
});

describe("the node's pods", () => {
  it("are watched across namespaces by spec.nodeName", () => {
    expect(nodePodsSpec("n1")).toEqual({
      kind: { group: "", version: "v1", kind: "Pod" },
      namespaces: null,
      labelSelector: null,
      fieldSelector: "spec.nodeName=n1",
    });
  });

  it("have their usage asked for their namespaces, sorted", () => {
    const pods = [pod("a", [], "Running", "b-ns"), pod("b", [], "Running", "a-ns"), pod("c", [], "Running", "a-ns")];
    expect(namespacesOf(pods)).toEqual(["a-ns", "b-ns"]);
  });
});
