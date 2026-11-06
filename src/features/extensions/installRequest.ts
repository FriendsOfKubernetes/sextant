// "Install this extension from the catalog" asked from elsewhere in the window (an offer in the sidebar, the end of a
// Flux or Argo CD install; ADR-0162): opens Settings → Extensions, where the panel takes the request once and runs the
// catalog's own install (the package checked, then the consent window). Nothing is installed without that window.
import { create } from "zustand";
import { openSettings } from "../settings/store";

interface InstallRequestState {
  /** The extension to install from the catalog, until the panel takes it. */
  id: string | null;
}

export const useInstallRequest = create<InstallRequestState>(() => ({ id: null }));

/** Opens Settings → Extensions and starts the catalog install of `id` there. */
export function requestCatalogInstall(id: string): void {
  useInstallRequest.setState({ id });
  openSettings({ tab: "extensions" });
}

/** The request, taken once (the panel calls it when it shows). */
export function takeInstallRequest(): string | null {
  const { id } = useInstallRequest.getState();
  if (id !== null) useInstallRequest.setState({ id: null });
  return id;
}
