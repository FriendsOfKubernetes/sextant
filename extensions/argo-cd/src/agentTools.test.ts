import { describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import type { KubeObject } from "@sextant/extension-sdk";
import { ARGO_TOOL_IDS, doneText, readArgs, toolPatch } from "./agentTools";

const ARGS = { cluster: "kind", namespace: "argocd", name: "guestbook" };
const APP = {
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Application",
  metadata: { name: "guestbook", namespace: "argocd" },
  spec: { syncPolicy: { syncOptions: ["CreateNamespace=true"], retry: { limit: 2 } } },
} as unknown as KubeObject;

describe("the agents' tools", () => {
  it("are the manifest's, with a backend", () => {
    expect(manifest.contributes.agentTools.map((t) => t.id)).toEqual([...ARGO_TOOL_IDS]);
    expect(manifest.backend).toEqual({ module: "backend.wasm" });
  });

  it("send what gitops_action sent", () => {
    const sync = toolPatch("sync", readArgs("sync", { ...ARGS, revision: "v2", prune: true }), APP);
    expect(sync).toMatchObject({
      clusterId: "kind",
      ref: { kind: { group: "argoproj.io", kind: "Application" }, namespace: "argocd", name: "guestbook" },
      patchType: "merge",
    });
    expect(sync.patch).toEqual({
      operation: {
        initiatedBy: { username: "sextant" },
        sync: { prune: true, dryRun: false, revision: "v2", syncOptions: ["CreateNamespace=true"] },
        retry: { limit: 2 },
      },
    });
    expect(toolPatch("refresh", readArgs("refresh", ARGS), null).patch).toEqual({
      metadata: { annotations: { "argocd.argoproj.io/refresh": "normal" } },
    });
    expect(toolPatch("hard-refresh", readArgs("hard-refresh", ARGS), null).patch).toEqual({
      metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } },
    });
    expect(doneText("hard-refresh", readArgs("hard-refresh", ARGS))).toBe("requested hard refresh of Application argocd/guestbook");
  });

  it("read the arguments strictly", () => {
    expect(readArgs("sync", ARGS)).toEqual({ ...ARGS, revision: null, prune: false });
    expect(() => readArgs("refresh", { ...ARGS, prune: true })).toThrow(/unknown arguments: prune/);
    expect(() => readArgs("sync", { ...ARGS, prune: "yes" })).toThrow(/prune is a boolean/);
    expect(() => readArgs("sync", { ...ARGS, name: "" })).toThrow(/name/);
    expect(() => readArgs("sync", null)).toThrow(/object/);
  });
});
