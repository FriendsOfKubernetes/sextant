import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend, type ObjectRef, type ResourceKind } from "../api";
import { CONCURRENCY, MAX_READS, objectRefOf, refKey, useRefObjects, type NamedRef } from "./refObjects";
import { resetClusterKinds } from "./useKinds";

const served = (group: string, version: string, kind: string): ResourceKind => ({
  kindRef: { group, version, kind },
  plural: `${kind.toLowerCase()}s`,
  namespaced: true,
  verbs: ["get", "list", "watch"],
  printerColumns: [],
});

let backend: MockBackend;
let reads: ObjectRef[];
let running: number;
let peak: number;

beforeEach(() => {
  resetClusterKinds();
  reads = [];
  running = 0;
  peak = 0;
  backend = mockBackend({
    cluster_kinds: () => [served("", "v1", "Service"), served("cluster.x-k8s.io", "v1beta1", "Machine")],
    resource_get: async (args) => {
      const ref = args.ref as ObjectRef;
      reads.push(ref);
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (ref.name === "gone") throw { code: "notFound", message: "not found" };
      return { metadata: { name: ref.name, namespace: ref.namespace } };
    },
  });
});

afterEach(() => {
  backend.restore();
  resetClusterKinds();
});

const service = (name: string): NamedRef => ({ group: "", version: "v1", kind: "Service", name, namespace: "kube-system" });

describe("objects read by name", () => {
  it("keys and refs: the served version first, else the one named, else v1beta2", () => {
    const machine: NamedRef = { group: "cluster.x-k8s.io", kind: "Machine", name: "m1", namespace: "default" };
    expect(refKey(machine)).toBe("cluster.x-k8s.io/Machine/default/m1");
    expect(refKey(service("traefik"))).toBe("/Service/kube-system/traefik");
    expect(objectRefOf(machine, { group: "cluster.x-k8s.io", version: "v1beta1", kind: "Machine" }).kind.version).toBe("v1beta1");
    expect(objectRefOf(machine, undefined).kind.version).toBe("v1beta2");
    expect(objectRefOf(service("traefik"), undefined)).toEqual({ kind: { group: "", version: "v1", kind: "Service" }, namespace: "kube-system", name: "traefik" });
  });

  it("reads each object once, at most CONCURRENCY at a time and MAX_READS in all, and tells errors and kinds not served", async () => {
    const refs = [
      ...Array.from({ length: MAX_READS + 5 }, (_, i) => service(`svc-${i}`)),
      { group: "example.com", kind: "Widget", name: "w", namespace: "default" },
      service("gone"),
    ];
    const hook = renderHook(() => useRefObjects("c1", refs, "s1"));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(reads).toHaveLength(MAX_READS);
    expect(peak).toBeLessThanOrEqual(CONCURRENCY);
    expect(hook.result.current.byKey.get("/Service/kube-system/svc-0")).toEqual({ obj: { metadata: { name: "svc-0", namespace: "kube-system" } } });
    // Beyond the cap nothing is read.
    expect(hook.result.current.byKey.has("/Service/kube-system/gone")).toBe(false);
    expect(hook.result.current.byKey.has("example.com/Widget/default/w")).toBe(false);
  });

  it("does not ask for a kind the cluster does not serve, keeps an error, and reads again when the stamp changes", async () => {
    const refs: NamedRef[] = [service("traefik"), service("gone"), { group: "example.com", kind: "Widget", name: "w", namespace: "default" }];
    let stamp = "s1";
    const hook = renderHook(() => useRefObjects("c1", refs, stamp));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(reads.map((r) => r.name).sort()).toEqual(["gone", "traefik"]);
    expect(hook.result.current.byKey.get("example.com/Widget/default/w")).toEqual({ notServed: true });
    expect(hook.result.current.byKey.get("/Service/kube-system/gone")).toEqual({ error: expect.objectContaining({ code: "notFound" }) });
    stamp = "s2";
    hook.rerender();
    // The previous reading stays while the new one comes.
    expect(hook.result.current.byKey.get("/Service/kube-system/traefik")).toBeDefined();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(reads).toHaveLength(4);
  });
});
