// In-app updates and the application's own version: types and the `api.updates` group. The work is done by the
// Tauri updater and process plugins behind the transport (`transport.ts`), which `mockBackend` swaps in tests.
import { toApiError } from "./errors";
import { currentTransport } from "./transport";

/**
 * How this copy of Sextant was installed: Tauri's bundle type, or `scoop` — the portable zip that Scoop installs
 * (ADR-0104), which Tauri reports as no bundle; `null` for a build that is not a release package.
 */
export type BundleKind = "appimage" | "deb" | "rpm" | "app" | "msi" | "nsis" | "scoop";

export interface AppInfo {
  /** Version of the running application, e.g. `0.2.0`. */
  version: string;
  bundleKind: BundleKind | null;
  /** A Vite dev build (`tauri dev`): it never checks for updates at start, whatever the bundle kind says. */
  devBuild: boolean;
}

/** The kinds Tauri itself reports (`scoop` is never one of them). */
const BUNDLE_KINDS: readonly string[] = ["appimage", "deb", "rpm", "app", "msi", "nsis"] satisfies BundleKind[];
const APP_RESOURCES = /\.app\/Contents\/Resources\/?$/;
/**
 * Scoop's layout: `<scoop>\apps\sextant\<version>\sextant.exe`, run through the `current` junction (also a global
 * install under `C:\ProgramData\scoop`). On Windows the resource directory is the executable's directory.
 */
const SCOOP_APP_DIR = /\\apps\\sextant\\[^\\]+\\?$/i;

/**
 * The bundle kind of the running copy, from what Tauri reports (`getBundleType()`) and its resource directory.
 * Tauri reports `app` on macOS for every binary it did not patch at bundling, so `tauri dev` and a bare
 * `--no-bundle` build would pass for an installed app: `app` counts only when the resources resolve inside
 * `<name>.app/Contents/Resources`, i.e. the executable runs from `<name>.app/Contents/MacOS/`. The resource
 * directory is the directory of the executable for a Cargo output directory and on Windows, and unresolvable for a
 * binary copied elsewhere (`null` here). An executable Tauri reports as no bundle that runs from Scoop's app
 * directory is the Scoop copy (`scoop`): Scoop updates it, never the in-app updater.
 */
export function installedBundleKind(reported: unknown, resourceDir: string | null): BundleKind | null {
  if (typeof reported !== "string" || !BUNDLE_KINDS.includes(reported)) {
    return SCOOP_APP_DIR.test(resourceDir ?? "") ? "scoop" : null;
  }
  if (reported === "app" && !APP_RESOURCES.test(resourceDir ?? "")) return null;
  return reported as BundleKind;
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
