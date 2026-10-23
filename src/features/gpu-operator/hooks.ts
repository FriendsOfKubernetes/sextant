// What the GPU Operator views read beyond the object shown, through the shared watch registry (`useWatch`), closed
// when the view closes: the DaemonSets of one operand namespace (at most `MAX_NAMESPACE_DAEMONSETS`), and the nodes
// labelled `nvidia.com/gpu.present=true` for the "GPU nodes" page (at most `MAX_GPU_NODES`).
import type { ClusterId, KubeObject } from "../../api";
import { useWatch } from "../../api";
import { isCapped } from "../../api/watchState";
import { DAEMONSET, LABEL_PRESENT, NODE } from "./model";

export const MAX_NAMESPACE_DAEMONSETS = 1000;
export const MAX_GPU_NODES = 500;
export const GPU_NODE_SELECTOR = `${LABEL_PRESENT}=true`;

export interface Listed {
  items: KubeObject[];
  loading: boolean;
  unavailable: boolean;
  truncated: boolean;
}

export function useOperandDaemonSets(clusterId: ClusterId, namespace: string | undefined): Listed {
  const spec = namespace ? { kind: DAEMONSET, namespaces: [namespace], labelSelector: null, fieldSelector: null } : null;
  const state = useWatch(clusterId, spec, { progressive: false, maxObjects: MAX_NAMESPACE_DAEMONSETS });
  return {
    items: [...state.items.values()],
    loading: spec !== null && state.status === "loading",
    unavailable: spec === null || Boolean(state.error) || (state.forbidden ?? []).length > 0,
    truncated: spec !== null && isCapped(state),
  };
}

export function useGpuNodes(clusterId: ClusterId): Listed {
  const spec = { kind: NODE, namespaces: null, labelSelector: GPU_NODE_SELECTOR, fieldSelector: null };
  const state = useWatch(clusterId, spec, { progressive: false, maxObjects: MAX_GPU_NODES });
  return {
    items: [...state.items.values()],
    loading: state.status === "loading",
    unavailable: Boolean(state.error),
    truncated: isCapped(state),
  };
}
