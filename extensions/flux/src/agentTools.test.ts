import { describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import { doneText, FLUX_TOOL_IDS, readArgs, toolPatch } from "./agentTools";
import { FLUX_KINDS } from "./flux";

const ARGS = { cluster: "kind", kind: "Kustomization", namespace: "flux-system", name: "podinfo" };

describe("the agents' tools", () => {
  it("are the manifest's, each with the arguments the backend reads", () => {
    const tools = manifest.contributes.agentTools;
    expect(tools.map((t) => t.id)).toEqual([...FLUX_TOOL_IDS]);
    for (const tool of tools) {
      expect(tool.inputSchema.required).toEqual(["cluster", "kind", "namespace", "name"]);
      expect(tool.inputSchema.properties.kind.enum).toEqual(FLUX_KINDS.map((k) => k.kind));
    }
    expect(manifest.backend).toEqual({ module: "backend.wasm" });
  });

  it("send what gitops_action sent", () => {
    const now = new Date("2026-11-09T10:00:00Z");
    expect(toolPatch("reconcile", ARGS, now)).toEqual({
      clusterId: "kind",
      ref: { kind: { group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" }, namespace: "flux-system", name: "podinfo" },
      patch: { metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": "2026-11-09T10:00:00.000Z" } } },
      patchType: "merge",
    });
    expect(toolPatch("suspend", ARGS, now).patch).toEqual({ spec: { suspend: true } });
    expect(toolPatch("resume", { ...ARGS, kind: "HelmRelease" }, now)).toMatchObject({
      ref: { kind: { group: "helm.toolkit.fluxcd.io", kind: "HelmRelease" } },
      patch: { spec: { suspend: false } },
    });
    expect(doneText("suspend", ARGS)).toBe("requested suspend of Kustomization flux-system/podinfo");
  });

  it("read the arguments strictly", () => {
    expect(readArgs({ ...ARGS, name: " podinfo " })).toEqual(ARGS);
    expect(() => readArgs({ ...ARGS, kind: "Application" })).toThrow(/Flux's kinds/);
    expect(() => readArgs({ ...ARGS, extra: 1 })).toThrow(/unknown arguments: extra/);
    expect(() => readArgs({ ...ARGS, namespace: "" })).toThrow(/namespace/);
    expect(() => readArgs({ ...ARGS, name: "Bad_Name" })).toThrow(/name is a Kubernetes name/);
    expect(() => readArgs([])).toThrow(/object/);
  });
});
