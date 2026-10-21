// The watches the details of a SealedSecret open while they are shown, all through the resource map's shared watches
// (released when the details close):
//   - the target Secret by its name, metadata only (its data never reaches the window);
//   - the controller: the Deployment `sealed-secrets-controller` in kube-system (kubeseal's default) and any
//     Deployment labelled `app.kubernetes.io/name=sealed-secrets` (the Helm chart), each listed by the API server's
//     own selector;
//   - the controller's sealing keys: the Secrets labelled `sealedsecrets.bitnami.com/sealed-secrets-key` in the
//     controllers' namespaces, metadata only. Their certificates and private keys are never read (ADR-0109).
import { useMemo } from "react";
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { useSharedWatches } from "../resource-map/watches";
import { CONTROLLER_LABEL, CONTROLLER_NAME, CONTROLLER_NAMESPACE, DEPLOYMENT, KEY_LABEL, SECRET } from "./model";

/** At most this many controllers' namespaces are looked at for sealing keys. */
export const MAX_KEY_NAMESPACES = 5;

export interface Found<T> {
  /** `undefined` while loading; `null` when there is nothing (or it cannot be read: `error`). */
  value: T | null | undefined;
  /** The list could not be read (no permission, an error). */
  error: boolean;
}

const failed = (s: WatchState | undefined) => s?.status === "error" || (s?.forbidden ?? []).length > 0;

/** The target Secret's metadata (`null`: there is no Secret of that name). */
export function useTargetSecret(clusterId: ClusterId, namespace: string | undefined, name: string | undefined): Found<KubeObject> {
  const specs = useMemo(
    (): WatchSpec[] =>
      namespace && name
        ? [{ kind: SECRET, namespaces: [namespace], labelSelector: null, fieldSelector: `metadata.name=${name}`, metadataOnly: true }]
        : [],
    [namespace, name],
  );
  const [state] = useSharedWatches(clusterId, specs);
  if (!state) return { value: undefined, error: false };
  if (failed(state)) return { value: null, error: true };
  if (state.status === "loading") return { value: undefined, error: false };
  return { value: [...state.items.values()][0] ?? null, error: false };
}

const CONTROLLER_SPECS: WatchSpec[] = [
  { kind: DEPLOYMENT, namespaces: [CONTROLLER_NAMESPACE], labelSelector: null, fieldSelector: `metadata.name=${CONTROLLER_NAME}` },
  { kind: DEPLOYMENT, namespaces: null, labelSelector: CONTROLLER_LABEL, fieldSelector: null },
];

export interface Controllers {
  /** The Deployments found by name or label, by namespace and name; `undefined` while loading. */
  deployments: KubeObject[] | undefined;
  /** One of the lists could not be read: "none found" is not known. */
  error: boolean;
}

/** The controllers found in the cluster. */
export function useControllers(clusterId: ClusterId): Controllers {
  const states = useSharedWatches(clusterId, CONTROLLER_SPECS);
  return useMemo(() => {
    const error = states.some(failed);
    const readable = states.filter((s) => !failed(s));
    if (readable.some((s) => s.status === "loading")) return { deployments: undefined, error };
    const byUid = new Map<string, KubeObject>();
    for (const s of readable) for (const d of s.items.values()) byUid.set(d.metadata?.uid ?? `${d.metadata?.namespace}/${d.metadata?.name}`, d);
    const deployments = [...byUid.values()].sort((a, b) =>
      `${a.metadata?.namespace}/${a.metadata?.name}`.localeCompare(`${b.metadata?.namespace}/${b.metadata?.name}`),
    );
    return { deployments, error };
  }, [states]);
}

/** The sealing key Secrets (metadata only) in `namespaces`, newest first. */
export function useSealingKeys(clusterId: ClusterId, namespaces: readonly string[]): Found<KubeObject[]> {
  const key = namespaces.slice(0, MAX_KEY_NAMESPACES).join(",");
  const specs = useMemo(
    (): WatchSpec[] =>
      key ? [{ kind: SECRET, namespaces: key.split(","), labelSelector: KEY_LABEL, fieldSelector: null, metadataOnly: true }] : [],
    [key],
  );
  const [state] = useSharedWatches(clusterId, specs);
  if (!state) return { value: null, error: false };
  if (state.status === "error") return { value: null, error: true };
  if (state.status === "loading") return { value: undefined, error: false };
  const created = (o: KubeObject) => (typeof o.metadata?.creationTimestamp === "string" ? o.metadata.creationTimestamp : "");
  return { value: [...state.items.values()].sort((a, b) => created(b).localeCompare(created(a))), error: failed(state) };
}
