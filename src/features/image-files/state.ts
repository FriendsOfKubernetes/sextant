// State of the "Image files" page per cluster (a module store, not saved): the typed reference and what to open. A
// pod's container header opens the page on the container's image (`openImageFiles`); nothing is fetched without the
// user's click.
import { create } from "zustand";
import type { ClusterId, ImageSource } from "../../api";
import { useAppStore } from "../../app/store";

/** `view` of the page in the app store (`registerPage`). */
export const IMAGE_FILES_PAGE = "imageFiles";

export interface ImageFilesState {
  /** What the reference field holds. */
  reference: string;
  /** A pod's container offered by its details panel, not opened yet or open. */
  pod: Extract<ImageSource, { type: "pod" }> | null;
  /** What is open (or opening) now; a new value opens it. */
  open: { source: ImageSource; key: number } | null;
}

const EMPTY: ImageFilesState = Object.freeze({ reference: "", pod: null, open: null }) as ImageFilesState;

interface Store {
  clusters: Record<ClusterId, ImageFilesState>;
  patch(clusterId: ClusterId, patch: Partial<ImageFilesState>): void;
}

let nextKey = 1;

export const useImageFilesStore = create<Store>()((set) => ({
  clusters: {},
  patch: (clusterId, patch) =>
    set((s) => ({ clusters: { ...s.clusters, [clusterId]: { ...(s.clusters[clusterId] ?? EMPTY), ...patch } } })),
}));

export function useImageFilesState(clusterId: ClusterId): ImageFilesState {
  return useImageFilesStore((s) => s.clusters[clusterId] ?? EMPTY);
}

/** Opens `source` on the page of `clusterId` (again, when it is the same). */
export function openSource(clusterId: ClusterId, source: ImageSource): void {
  useImageFilesStore.getState().patch(clusterId, { open: { source, key: nextKey++ } });
}

export function closeSource(clusterId: ClusterId): void {
  useImageFilesStore.getState().patch(clusterId, { open: null });
}

/** Shows the page opening a pod's container's image (and closes the details panel): the user's click on "Browse image
 * files" is what fetches it. */
export function openImageFiles(clusterId: ClusterId, namespace: string, pod: string, container: string): void {
  const source = { type: "pod" as const, clusterId, namespace, pod, container };
  useImageFilesStore.getState().patch(clusterId, { pod: source, open: { source, key: nextKey++ } });
  const app = useAppStore.getState();
  app.closeDetails();
  app.setView(clusterId, IMAGE_FILES_PAGE);
}

/** Forgets every cluster's state (tests). */
export function resetImageFiles(): void {
  useImageFilesStore.setState({ clusters: {} });
}
