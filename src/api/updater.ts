// In-app updates and the application's own version: types and the `api.updates` group. The work is done by the
// Tauri updater and process plugins behind the transport (`transport.ts`), which `mockBackend` swaps in tests.
import { toApiError } from "./errors";
import { currentTransport } from "./transport";

/** How this copy of Sextant was installed (Tauri's bundle type); `null` for a build that is not a release package. */
export type BundleKind = "appimage" | "deb" | "rpm" | "app" | "msi" | "nsis";

export interface AppInfo {
  /** Version of the running application, e.g. `0.2.0`. */
  version: string;
  bundleKind: BundleKind | null;
}

/** A newer release announced by `latest.json` of the latest GitHub release. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** RFC 3339 publication date, if the release names one. */
  date: string | null;
  /** Release notes (Markdown as written on GitHub), if any. */
  notes: string | null;
}

export interface DownloadProgress {
  downloaded: number;
  /** Size of the download, when the server tells it. */
  total: number | null;
}

export interface AvailableUpdate extends UpdateInfo {
  /** Downloads the update, checks its signature against the built-in public key and installs it. */
  install(onProgress?: (progress: DownloadProgress) => void): Promise<void>;
}

/** Where a release can be downloaded by hand. */
export const RELEASES_URL = "https://github.com/FriendsOfKubernetes/sextant/releases/latest";

/**
 * Whether a Tauri configuration lets the updater run: `plugins.updater` with a public key and an endpoint (the same
 * rule as `updater_configured` in `src-tauri/src/lib.rs`, which leaves the plugin out otherwise).
 */
export function updaterConfiguredIn(config: unknown): boolean {
  const updater = (config as { plugins?: { updater?: { pubkey?: unknown; endpoints?: unknown } } } | null)?.plugins
    ?.updater;
  const pubkey = typeof updater?.pubkey === "string" ? updater.pubkey.trim() : "";
  const endpoints = Array.isArray(updater?.endpoints) ? updater.endpoints : [];
  return pubkey !== "" && endpoints.some((e) => typeof e === "string" && e.trim() !== "");
}

async function rethrow<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toApiError(err);
  }
}

export const updates = {
  /** `false` when this build has no update signing key: checking is turned off. */
  configured: (): boolean => currentTransport().updaterConfigured(),
  appInfo: (): Promise<AppInfo> => rethrow(() => currentTransport().appInfo()),
  /** The newer release, or `null` when this version is the latest. Rejects with `ApiError`. */
  check: (): Promise<AvailableUpdate | null> =>
    rethrow(async () => {
      const update = await currentTransport().checkUpdate();
      if (!update) return null;
      return { ...update, install: (onProgress) => rethrow(() => update.install(onProgress)) };
    }),
  /** Restarts the application (after an update was installed). */
  relaunch: (): Promise<void> => rethrow(() => currentTransport().relaunch()),
};
