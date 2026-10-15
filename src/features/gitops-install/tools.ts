// Whether Flux and Argo CD are in a connected cluster. The cluster is asked (`gitops_install_status`: the tool's
// CRDs and, in its namespace, the controllers of the standard set), so an install that stopped or failed after the
// CRDs counts as partly installed and is offered again although discovery already serves its kinds. Until the
// answer comes, or when the cluster cannot be asked, discovery decides (the same kinds that show the sidebar
// sections): Flux by `Kustomization`, Argo CD by `Application`. Nothing is known for a cluster that is not connected
// or whose kinds have not come yet. The cluster is asked again when its kinds change (a CRD came or went) and when an
// install dialog closes.
import { useEffect, useState } from "react";
import { api, type ClusterId, type GitopsStatus, type GitopsTool, type KindRef } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { useClusterState } from "../clusters/hooks";
import { useInstallDialog } from "./store";

export const GITOPS_TOOLS: GitopsTool[] = ["flux", "argoCd"];

/** The kind whose presence in discovery means the tool is installed while the cluster has not answered. */
export const TOOL_KINDS: Record<GitopsTool, Pick<KindRef, "group" | "kind">> = {
  flux: { group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" },
  argoCd: { group: "argoproj.io", kind: "Application" },
};

/** `partial`: some of the tool is there (its namespace, some CRDs, or not every controller); an install is offered. */
export type ToolState = "installed" | "partial" | "missing";

export interface GitopsTools {
  connected: boolean;
  /** Per tool; `null` while the cluster is not connected or its kinds are unknown. */
  tools: Record<GitopsTool, ToolState> | null;
}

function fromStatus(status: GitopsStatus): Record<GitopsTool, ToolState> {
  const of = (s: GitopsStatus["flux"]): ToolState => (s.present ? "installed" : s.partial ? "partial" : "missing");
  return { flux: of(status.flux), argoCd: of(status.argoCd) };
}

export function useGitopsTools(clusterId: ClusterId): GitopsTools {
  const connected = useClusterState(clusterId).state === "connected";
  const { kinds } = useClusterKinds(connected ? clusterId : null);
  const dialogOpen = useInstallDialog((s) => s.target !== null);
  const [status, setStatus] = useState<{ clusterId: ClusterId; tools: Record<GitopsTool, ToolState> } | null>(null);

  useEffect(() => {
    if (!connected || !kinds || dialogOpen) return;
    let live = true;
    api.gitopsInstall.status(clusterId).then(
      (found) => live && setStatus({ clusterId, tools: fromStatus(found) }),
      () => live && setStatus(null),
    );
    return () => {
      live = false;
    };
  }, [clusterId, connected, kinds, dialogOpen]);

  if (!connected || !kinds) return { connected, tools: null };
  if (status?.clusterId === clusterId) return { connected, tools: status.tools };
  return {
    connected,
    tools: {
      flux: findKind(kinds, TOOL_KINDS.flux) ? "installed" : "missing",
      argoCd: findKind(kinds, TOOL_KINDS.argoCd) ? "installed" : "missing",
    },
  };
}
