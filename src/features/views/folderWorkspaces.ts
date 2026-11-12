// Workspaces made from kubeconfig folders (#329, ADR-0148): one for the files directly in a folder, named after the
// folder (#328: several folders added one by one, none with subfolders), and one per subfolder, each holding the
// clusters of its files, computed from the cluster list each time and never stored, so they always match the folder.
// They are read-only: the folder decides what they hold; the manager copies one into a workspace of the user's own to
// edit. The user's own workspaces stand beside them; one with the same name is never changed. A folder whose
// workspaces are turned off makes none.
import { useMemo } from "react";
import type { ClusterInfo, KubeconfigSource } from "../../api";
import type { Workspace } from "../../api/generated/Workspace";
import { useClustersStore } from "../clusters/clustersStore";

/** A workspace of a subfolder: `folder` is the folder's path, for the manager. */
export interface FolderWorkspace extends Workspace {
  folder: string;
}

/** The id prefix of a folder's workspace (a valid workspace id, so it can be the active one). */
const PREFIX = "folder-";

/** FNV-1a, 32 bits, as hex. */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const isFolderWorkspaceId = (id: string): boolean => id.startsWith(PREFIX);

/** The last part of a folder's path: the name of the workspace of its own files. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Per folder whose workspaces are on: a workspace of the files directly in it (named after the folder; only when there
 * are such files), then one per subfolder by name; folders in the order of the sources.
 */
export function folderWorkspaces(clusters: readonly ClusterInfo[], sources: readonly KubeconfigSource[]): FolderWorkspace[] {
  const out: FolderWorkspace[] = [];
  for (const folder of sources) {
    if (folder.kind !== "folder" || folder.workspaces === false) continue;
    const own: string[] = [];
    const bySubfolder = new Map<string, string[]>();
    for (const cluster of clusters) {
      const place = cluster.folder;
      if (place?.sourceId !== folder.id) continue;
      if (!place.subfolder) own.push(cluster.id);
      else bySubfolder.set(place.subfolder, [...(bySubfolder.get(place.subfolder) ?? []), cluster.id]);
    }
    // The folder's own files: the id hashes "/", which no subfolder name is.
    if (own.length > 0) out.push({ id: `${PREFIX}${folder.id}-${fnv("/")}`, name: folderName(folder.path), clusters: own, folder: folder.path });
    for (const [subfolder, ids] of [...bySubfolder].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({ id: `${PREFIX}${folder.id}-${fnv(subfolder)}`, name: subfolder, clusters: ids, folder: folder.path });
    }
  }
  return out;
}

/** The folder workspaces of the clusters as they are now. */
export function useFolderWorkspaces(): FolderWorkspace[] {
  const clusters = useClustersStore((s) => s.clusters);
  const sources = useClustersStore((s) => s.sources);
  return useMemo(() => folderWorkspaces(clusters, sources), [clusters, sources]);
}

/** The folder workspaces as the store has them now (outside React). */
export function currentFolderWorkspaces(): FolderWorkspace[] {
  const { clusters, sources } = useClustersStore.getState();
  return folderWorkspaces(clusters, sources);
}
