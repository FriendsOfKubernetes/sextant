// The virtual clusters Sextant forwards for (`api.vcluster.links`), kept current by the `vcluster-links` event: when a
// forward ends (stopped, its host disconnected) the backend removes the entry, and the cluster list is read again.
import { create } from "zustand";
import { api, events, type ClusterId, type VclusterLink } from "../../api";
import { refreshClusters } from "../clusters/clustersStore";

interface LinksState {
  /** `null` until first read. */
  links: VclusterLink[] | null;
}

export const useLinksStore = create<LinksState>(() => ({ links: null }));

export function setLinks(links: VclusterLink[]): void {
  useLinksStore.setState({ links });
}

/** Reads the list from the backend (an error leaves it empty: nothing is forwarded that the window knows of). */
export async function loadLinks(): Promise<void> {
  try {
    setLinks(await api.vcluster.links());
  } catch {
    setLinks([]);
  }
}

/** Follows the backend's list; returns the unsubscribe. */
export function followLinks(): () => void {
  let stop: (() => void) | undefined;
  let gone = false;
  void loadLinks();
  void events
    .onVclusterLinks((links) => {
      setLinks(links);
      void refreshClusters();
    })
    .then((unsubscribe) => {
      if (gone) unsubscribe();
      else stop = unsubscribe;
    })
    .catch(() => undefined);
  return () => {
    gone = true;
    stop?.();
  };
}

/** The link of the vcluster `namespace`/`name` of a host cluster, if Sextant forwards for it. */
export function useLinkOf(hostClusterId: ClusterId, namespace: string, name: string): VclusterLink | undefined {
  return useLinksStore((s) =>
    s.links?.find((l) => l.hostClusterId === hostClusterId && l.namespace === namespace && l.name === name),
  );
}

/** Connects (on the user's confirmed click): the backend forwards and writes the entry; the list is read again. */
export async function connectVcluster(hostClusterId: ClusterId, namespace: string, name: string): Promise<VclusterLink> {
  const link = await api.vcluster.connect(hostClusterId, namespace, name);
  const others = (useLinksStore.getState().links ?? []).filter((l) => l.clusterId !== link.clusterId);
  setLinks([...others, link]);
  await refreshClusters();
  return link;
}

/** Stops the forward, which disconnects the virtual cluster and removes its entry. */
export async function disconnectVcluster(clusterId: ClusterId): Promise<void> {
  await api.vcluster.disconnect(clusterId);
  setLinks((useLinksStore.getState().links ?? []).filter((l) => l.clusterId !== clusterId));
  await refreshClusters();
}
