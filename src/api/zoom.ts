// Window zoom (#158): Ctrl+= / Ctrl+- / Ctrl+0 (`zoomHotkeysEnabled` in tauri.conf.json). On Linux and macOS Tauri's
// hotkey script counts from 100 % on every page load while the web view keeps its zoom, so after a reload Ctrl+=
// would jump; the page sets the web view back to 100 % once when it loads (permission
// `core:webview:allow-set-webview-zoom`).
import { call } from "./transport";

/** The main window's web view (it carries the window's label). */
const MAIN_WEBVIEW = "main";

let reset = false;

/** Once per page load; a failure (no such permission, a test transport) is ignored. */
export function resetZoomOnLoad(): void {
  if (reset) return;
  reset = true;
  call("plugin:webview|set_webview_zoom", { label: MAIN_WEBVIEW, value: 1 }).catch(() => undefined);
}
