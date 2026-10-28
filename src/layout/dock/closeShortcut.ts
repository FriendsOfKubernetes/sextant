// Closing the dock tab in front from the keyboard. On macOS Cmd+W is the app menu's "Close Tab"
// (src-tauri/src/app_menu.rs), which sends `close-tab`: the active tab closes, or, with no tab shown, the window (as
// a tabbed macOS app does). Linux and Windows have no menu bar: Ctrl+W (on macOS too) is caught in the window and
// closes the active tab only, never the window; in a terminal Ctrl+W stays the shell's "delete the word before the
// cursor".
// While a modal (a dialog, a popup) is open neither does anything: the tab behind it is not the one in front.
import { useAppStore } from "../../app/store";
import { isTopModal } from "../../components";

/** What the menu's Cmd+W closes: the tab shown in front, the window, or nothing while a modal is open. */
export type CloseTarget = { type: "tab"; id: string } | { type: "window" } | { type: "none" };

export function closeTarget(): CloseTarget {
  if (!isTopModal(null)) return { type: "none" };
  const { dock } = useAppStore.getState();
  return dock.open && dock.activeTabId ? { type: "tab", id: dock.activeTabId } : { type: "window" };
}

/** Ctrl+W outside a terminal. By `code` too: on a non-Latin layout `key` is another letter. */
export function isCloseTabKey(
  e: Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "repeat" | "target">,
): boolean {
  if (e.type !== "keydown" || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.repeat) return false;
  const w = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === "w" : e.code === "KeyW";
  return w && !(e.target instanceof Element && e.target.closest(".xterm"));
}
