// Whether Flux and Argo CD are in a connected cluster, from its discovery (the same kinds that show their sidebar
// sections): Flux by `Kustomization`, Argo CD by `Application`. Nothing is known for a cluster that is not connected
// or whose kinds have not come yet.
import type { ClusterId, GitopsTool, KindRef } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { useClusterState } from "../clusters/hooks";

export const GITOPS_TOOLS: GitopsTool[] = ["flux", "argoCd"];

/** The kind whose presence in discovery means the tool is installed. */
export const TOOL_KINDS: Record<GitopsTool, Pick<KindRef, "group" | "kind">> = {
  flux: { group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" },
  argoCd: { group: "argoproj.io", kind: "Application" },
};

export interface GitopsTools {
  connected: boolean;
  /** Per tool: installed or not; `null` while the cluster is not connected or its kinds are unknown. */
  installed: Record<GitopsTool, boolean> | null;
}

export function useGitopsTools(clusterId: ClusterId): GitopsTools {
  const connected = useClusterState(clusterId).state === "connected";
  const { kinds } = useClusterKinds(connected ? clusterId : null);
  if (!connected || !kinds) return { connected, installed: null };
  return {
    connected,
    installed: {
      flux: findKind(kinds, TOOL_KINDS.flux) !== undefined,
      argoCd: findKind(kinds, TOOL_KINDS.argoCd) !== undefined,
    },
  };
}
