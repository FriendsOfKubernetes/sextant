// The tools the extension gives AI agents (ADR-0159, #402): Reconcile, Suspend and Resume of a Flux object, as the
// MCP tool `gitops_action` did before Flux left the core. Pure: the arguments read strictly and the patch built here;
// `backend/main.ts` sends it through `host`, where Sextant decides the call for the extension and the agent both.
import type { JsonValue, PatchParams } from "@sextant/extension-sdk";
import { FLUX_KINDS, reconcilePatch } from "./flux";

export type FluxToolId = "reconcile" | "suspend" | "resume";
export const FLUX_TOOL_IDS: readonly FluxToolId[] = ["reconcile", "suspend", "resume"];

/** What an agent sends: the object, by the cluster id `list_clusters` gives. */
export interface FluxToolArgs {
  cluster: string;
  kind: string;
  namespace: string;
  name: string;
}

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** The arguments checked as the manifest's `inputSchema` says (Sextant checks no schema of an extension's tool). */
export function readArgs(params: JsonValue): FluxToolArgs {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("the arguments are an object");
  const known = new Set(["cluster", "kind", "namespace", "name"]);
  const unknown = Object.keys(params).filter((k) => !known.has(k));
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(", ")}`);
  const text = (key: string): string => {
    const value = (params as Record<string, JsonValue>)[key];
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is a non-empty string`);
    return value.trim();
  };
  const args = { cluster: text("cluster"), kind: text("kind"), namespace: text("namespace"), name: text("name") };
  if (!FLUX_KINDS.some((k) => k.kind === args.kind)) {
    throw new Error(`kind is one of Flux's kinds: ${FLUX_KINDS.map((k) => k.kind).join(", ")}`);
  }
  if (!NAME.test(args.namespace)) throw new Error("namespace is a Kubernetes name");
  if (!NAME.test(args.name)) throw new Error("name is a Kubernetes name");
  return args;
}

/** The merge patch of `tool` on `args`'s object, as the extension's own actions send it. */
export function toolPatch(tool: FluxToolId, args: FluxToolArgs, now: Date): PatchParams & { clusterId: string } {
  const kind = FLUX_KINDS.find((k) => k.kind === args.kind)!;
  const patch =
    tool === "reconcile" ? reconcilePatch(now) : { spec: { suspend: tool === "suspend" } };
  return {
    clusterId: args.cluster,
    ref: { kind: { group: kind.group, kind: kind.kind }, namespace: args.namespace, name: args.name },
    patch: patch as JsonValue,
    patchType: "merge",
  };
}

/** What the agent is told when the patch was sent. */
export const doneText = (tool: FluxToolId, args: FluxToolArgs): string =>
  `requested ${tool} of ${args.kind} ${args.namespace}/${args.name}`;
