// The text "Copy version info" puts on the clipboard for a bug report: what a maintainer needs to reproduce a problem
// and nothing that names a person or a folder.
import type { AboutInfo, AppInfo } from "../../api";

/** Translation keys (namespace `about`) of how this copy was installed; development builds win over the bundle kind. */
export function buildKey(app: AppInfo): string {
  if (app.devBuild) return "about:build.dev";
  return app.bundleKind ? `about:build.${app.bundleKind}` : "about:build.none";
}

/**
 * ```
 * Sextant 0.6.1 (AppImage)
 * OS: Linux Ubuntu 24.04.1 LTS x86_64
 * WebView: 2.44.1
 * Tauri: 2.12.3
 * ```
 * `machine` is `null` when the backend could not tell: the version line is still worth copying.
 * `t` is the translation function of the app.
 */
export function versionInfoText(
  app: AppInfo,
  machine: AboutInfo | null,
  t: (key: string) => string,
): string {
  const lines = [`Sextant ${app.version} (${t(buildKey(app))})`];
  if (!machine) {
    lines.push(`OS: ${t("about:unknown")}`);
    return lines.join("\n");
  }
  lines.push(`OS: ${[machine.os, machine.osVersion, machine.arch].filter(Boolean).join(" ")}`);
  lines.push(`WebView: ${machine.webviewVersion ?? t("about:unknown")}`);
  lines.push(`Tauri: ${machine.tauriVersion}`);
  return lines.join("\n");
}
