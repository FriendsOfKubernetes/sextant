// Sextant's look in a frame: the context's `tokens` (Sextant's CSS variables) set on `<html>`, its `theme` as
// `data-theme`, its `language` as `lang`, and — unless asked not to — a few base styles that use the variables, so a
// plain page already looks like Sextant. `connect()` applies the theme and follows its changes.
//
// The body's background is the colour of the place the frame fills (the context's `view`, set as `data-view`): the
// page area for a page, the panel for a details section, an action's dialog and the settings section, the dock for a
// dock tab. A transparent body does not work: the webview paints a frame's document on an opaque white canvas.
import type { HostContext } from "./protocol";

export const BASE_STYLE_ID = "sextant-base-styles";

export interface ThemeOptions {
  /** Where the variables go (default `document.documentElement`). */
  root?: HTMLElement;
  /** Add the base styles (body font and colours, buttons, inputs, tables, links). Default `true`. */
  baseStyles?: boolean;
}

/** The variables set on each root, so the ones Sextant stops sending are removed. */
const applied = new WeakMap<HTMLElement, Set<string>>();

const BASE_STYLES = `
body {
  margin: 0;
  padding: 12px 16px;
  background: var(--color-main, Canvas);
  color: var(--color-text, CanvasText);
  font-family: var(--font-family, system-ui, sans-serif);
  font-size: var(--control-font-size, 13px);
  line-height: 1.45;
}
html:is([data-view="details"], [data-view="action"], [data-view="settings"]) body { background: var(--color-panel, Canvas); }
html[data-view="dock"] body { background: var(--color-dock, Canvas); }
:where(h1, h2, h3) { font-weight: 600; margin: 0 0 8px; }
:where(h1) { font-size: 18px; }
:where(h2) { font-size: 15px; }
:where(h3) { font-size: 13px; }
:where(a) { color: var(--color-accent); }
:where(code, pre, kbd) { font-family: var(--font-mono, monospace); }
:where(.muted) { color: var(--color-text-muted); }
:where(button, input, select, textarea) {
  font: inherit;
  color: inherit;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  box-sizing: border-box;
}
:where(button, input, select) { height: var(--control-height, 32px); padding: 0 10px; }
:where(button) { cursor: pointer; }
:where(button:hover:not(:disabled)) { background: var(--color-hover); }
:where(button:disabled) { opacity: 0.6; cursor: default; }
:where(button.primary) { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-accent-text); }
:where(button.danger) { color: var(--color-danger); }
:where(table) { border-collapse: collapse; width: 100%; }
:where(th, td) { text-align: left; padding: 0 8px; height: var(--control-height-compact, 28px); border-bottom: 1px solid var(--color-border); }
:where(th) { color: var(--color-text-muted); font-weight: 500; }
:where(tr:hover td) { background: var(--color-hover); }
:where(.error) { color: var(--color-danger); }
`;

/** Applies `theme`, `language`, `tokens` (and `view`) of a context to `root`. Calling it again follows a change. */
export function applyTheme(
  context: Pick<HostContext, "theme" | "language" | "tokens"> & Partial<Pick<HostContext, "view">>,
  options: ThemeOptions = {},
): void {
  const root = options.root ?? document.documentElement;
  const before = applied.get(root) ?? new Set<string>();
  const now = new Set<string>();
  for (const [name, value] of Object.entries(context.tokens)) {
    if (!name.startsWith("--") || typeof value !== "string") continue;
    root.style.setProperty(name, value);
    now.add(name);
  }
  for (const name of before) if (!now.has(name)) root.style.removeProperty(name);
  applied.set(root, now);
  root.dataset.theme = context.theme;
  if (context.view) root.dataset.view = context.view;
  if (context.language) root.lang = context.language;
  if (options.baseStyles !== false) addBaseStyles(root.ownerDocument);
}

/** Adds the base styles to `doc` once. */
export function addBaseStyles(doc: Document = document): void {
  if (doc.getElementById(BASE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = BASE_STYLE_ID;
  style.textContent = BASE_STYLES;
  // First in <head>: the extension's own styles come later and win.
  doc.head.prepend(style);
}
