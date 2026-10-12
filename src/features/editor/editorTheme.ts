// Colour scheme of every CodeMirror instance (resource editor, YAML viewers, Helm values). One place decides the
// scheme: the `editorTheme` setting, where "auto" follows the app theme. Instances hold the scheme in a Compartment, so
// a change reaches the open editors without recreating them.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { color, oneDarkHighlightStyle, oneDarkTheme } from "@codemirror/theme-one-dark";
import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { nord } from "@uiw/codemirror-theme-nord";
import { solarizedDark, solarizedLight } from "@uiw/codemirror-theme-solarized";
import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { useSettings } from "../../api";

export type EditorSchemeId = "oneDark" | "githubDark" | "githubLight" | "dracula" | "nord" | "solarizedDark" | "solarizedLight";
export type EditorThemeId = "auto" | EditorSchemeId;

/** Settings → Editor lists the schemes in this order. */
export const EDITOR_THEME_IDS: readonly EditorThemeId[] = [
  "auto",
  "oneDark",
  "githubDark",
  "githubLight",
  "dracula",
  "nord",
  "solarizedDark",
  "solarizedLight",
];

// One Dark's coral (names, YAML keys) is 4.4:1 on its background; a little lighter reaches 4.5:1 (checked in the tests).
const READABLE_CORAL = "#e5787f";
const oneDark: Extension = [
  oneDarkTheme,
  syntaxHighlighting(
    HighlightStyle.define(oneDarkHighlightStyle.specs.map((spec) => (spec.color === color.coral ? { ...spec, color: READABLE_CORAL } : spec))),
  ),
];

const SCHEMES: Record<EditorSchemeId, Extension> = {
  oneDark,
  githubDark,
  githubLight,
  dracula,
  nord,
  solarizedDark,
  solarizedLight,
};

/** The saved value as a scheme id; anything unknown (a value from another version) is "auto". */
export function parseEditorTheme(value: string | null | undefined): EditorThemeId {
  return EDITOR_THEME_IDS.find((id) => id === value) ?? "auto";
}

/** "auto" is One Dark in the dark app theme and GitHub Light in the light one. */
export function resolveEditorTheme(id: EditorThemeId, appTheme: "light" | "dark"): EditorSchemeId {
  if (id !== "auto") return id;
  return appTheme === "dark" ? "oneDark" : "githubLight";
}

export function schemeExtension(id: EditorSchemeId): Extension {
  return SCHEMES[id];
}

// The app theme as shown: `useApplyTheme` writes it to <html data-theme> (it also resolves "system").
function subscribeAppTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

const appThemeSnapshot = (): "light" | "dark" => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/** The scheme the editors use now. */
export function useEditorScheme(): EditorSchemeId {
  const { settings } = useSettings();
  const appTheme = useSyncExternalStore(subscribeAppTheme, appThemeSnapshot, () => "light" as const);
  return resolveEditorTheme(parseEditorTheme(settings?.editorTheme), appTheme);
}

/**
 * Colour scheme for one CodeMirror instance. `initial()` goes into the extensions of a new view; when the scheme
 * changes later, the live view in `view` is reconfigured. The host element gets `data-editor-theme={scheme}`.
 */
export function useEditorTheme(view: RefObject<EditorView | null>): { scheme: EditorSchemeId; initial: () => Extension } {
  const scheme = useEditorScheme();
  const compartment = useRef(new Compartment()).current;
  const latest = useRef(scheme);
  latest.current = scheme;

  useEffect(() => {
    view.current?.dispatch({ effects: compartment.reconfigure(schemeExtension(scheme)) });
  }, [view, compartment, scheme]);

  const initial = useCallback(() => compartment.of(schemeExtension(latest.current)), [compartment]);
  return { scheme, initial };
}
