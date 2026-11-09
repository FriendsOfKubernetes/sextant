// The tools the extension gives AI agents (ADR-0159, #402): Sync, Refresh and Hard refresh of an Argo CD Application,
// as the MCP tool `gitops_action` did before Argo CD left the core. Pure: the arguments read strictly and the patches
// built here; `backend/main.ts` reads and patches through `host`, where Sextant decides each call for the extension
// and the agent both.
import type { JsonValue, KubeObject, PatchParams, RefInput } from "@sextant/extension-sdk";
import { APPLICATION, refreshPatch, syncPatch } from "./argo";

export type ArgoToolId = "sync" | "refresh" | "hard-refresh";
export const ARGO_TOOL_IDS: readonly ArgoToolId[] = ["sync", "refresh", "hard-refresh"];

export interface ArgoToolArgs {
  cluster: string;
  namespace: string;
  name: string;
  /** `sync`: the revision to sync to; each source's own `targetRevision` when left out. */
  revision: string | null;
  /** `sync`: also delete resources no longer in Git. */
  prune: boolean;
}

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** The arguments of `tool` checked as the manifest's `inputSchema` says (Sextant checks no schema of an extension's tool). */
export function readArgs(tool: ArgoToolId, params: JsonValue): ArgoToolArgs {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("the arguments are an object");
  const given = params as Record<string, JsonValue>;
  const known = new Set(["cluster", "namespace", "name", ...(tool === "sync" ? ["revision", "prune"] : [])]);
  const unknown = Object.keys(given).filter((k) => !known.has(k));
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(", ")}`);
  const text = (key: string): string => {
    const value = given[key];
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is a non-empty string`);
    return value.trim();
  };
  const args: ArgoToolArgs = { cluster: text("cluster"), namespace: text("namespace"), name: text("name"), revision: null, prune: false };
  if (!NAME.test(args.namespace)) throw new Error("namespace is a Kubernetes name");
  if (!NAME.test(args.name)) throw new Error("name is a Kubernetes name");
  if (given.revision !== undefined && given.revision !== null) {
    if (typeof given.revision !== "string" || given.revision.length > 1024) throw new Error("revision is a string of at most 1024 characters");
    args.revision = given.revision.trim() || null;
  }
  if (given.prune !== undefined) {
    if (typeof given.prune !== "boolean") throw new Error("prune is a boolean");
    args.prune = given.prune;
  }
  return args;
}

/** The Application `args` names. */
export const appRef = (args: ArgoToolArgs): RefInput => ({ kind: APPLICATION, namespace: args.namespace, name: args.name });

/** The merge patch of `tool`: a sync carries the Application's own sync options and retry policy (`app`). */
export function toolPatch(tool: ArgoToolId, args: ArgoToolArgs, app: KubeObject | null): PatchParams & { clusterId: string } {
  const patch =
    tool === "sync"
      ? syncPatch(app ?? ({} as KubeObject), { revision: args.revision, prune: args.prune, dryRun: false })
      : refreshPatch(tool === "hard-refresh" ? "hard" : "normal");
  return { clusterId: args.cluster, ref: appRef(args), patch: patch as JsonValue, patchType: "merge" };
}

/** What the agent is told when the patch was sent. */
export const doneText = (tool: ArgoToolId, args: ArgoToolArgs): string =>
  `requested ${tool === "hard-refresh" ? "hard refresh" : tool} of Application ${args.namespace}/${args.name}`;
