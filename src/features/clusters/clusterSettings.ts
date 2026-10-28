// Per-cluster settings (`AppSettings.clusters[clusterId]`) owned by this feature: display name, color, icon, last
// view.
import { updateSettings, type AppSettings, type ClusterId, type ClusterInfo, type ClusterSettings } from "../../api";

/** Same defaults as `ClusterSettings::default()` in Rust. */
export function defaultClusterSettings(): ClusterSettings {
  return {
    displayName: null,
    color: null,
    namespaces: null,
    lastView: null,
    prometheus: { mode: "auto" },
    usageSource: "auto",
    icon: null,
    agentAccess: { preset: "off", rules: [] },
    argocdNamespace: null,
    previewChanges: null,
    alertmanager: null,
    observabilityLinks: null,
    knownNamespaces: null,
    tableFilters: {},
  };
}

export function clusterSettingsOf(settings: AppSettings | null, id: ClusterId): ClusterSettings {
  return { ...defaultClusterSettings(), ...settings?.clusters[id] };
}

/** Merges `patch` into the cluster's settings and saves them. */
export function updateClusterSettings(id: ClusterId, patch: Partial<ClusterSettings>): Promise<AppSettings> {
  return updateSettings((current) => ({
    ...current,
    clusters: { ...current.clusters, [id]: { ...clusterSettingsOf(current, id), ...patch } },
  }));
}

/** The name shown in the rail: the user's display name, else the context name. */
export function displayNameOf(cluster: ClusterInfo, settings: AppSettings | null): string {
  const name = settings?.clusters[cluster.id]?.displayName?.trim();
  return name || cluster.context;
}

/** Label colors offered in the cluster settings. */
export const CLUSTER_COLORS = ["#3d90ce", "#48a868", "#d6a01e", "#e0703a", "#ce3933", "#a05ad0", "#2aa3a3", "#7a8590"];

/** Color of the rail icon: the chosen one, else a stable color derived from the id. */
export function colorOf(cluster: ClusterInfo, settings: AppSettings | null): string {
  const chosen = settings?.clusters[cluster.id]?.color;
  if (chosen) return chosen;
  let hash = 0;
  for (const ch of cluster.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return CLUSTER_COLORS[hash % CLUSTER_COLORS.length] ?? CLUSTER_COLORS[0]!;
}

/** Light and dark letters for the rail icon. Black, not a softer dark: with it every offered color reaches 4.5:1. */
export const INITIALS_LIGHT = "#ffffff";
export const INITIALS_DARK = "#000000";

function relativeLuminance(hex: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const digits = m[1]!.length === 3 ? [...m[1]!].map((d) => d + d).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio of two `#rgb`/`#rrggbb` colors, or `null` when either is not one. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The letters' color on a label color: light or dark, whichever contrasts more (light when it cannot tell). */
export function initialsColorOn(background: string): string {
  const light = contrastRatio(INITIALS_LIGHT, background);
  const dark = contrastRatio(INITIALS_DARK, background);
  if (light === null || dark === null) return INITIALS_LIGHT;
  return dark > light ? INITIALS_DARK : INITIALS_LIGHT;
}

/** Up to two letters for the rail icon: "kind-sextant-test" → "KS", "prod" → "PR". */
export function initialsOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? name).slice(0, 2).toUpperCase();
}

/** A cluster's own rail icon as stored in the settings. */
export type ClusterIcon = NonNullable<ClusterSettings["icon"]>;

/** What the rail draws for a cluster: a picture or one or two characters on the label color. */
export type ShownIcon = { kind: "image"; src: string } | { kind: "text"; text: string };

/** The only pictures drawn: PNG data URLs made by `readIconImage` (never a link or another format). */
const PNG_DATA_URL = "data:image/png;base64,";

/** Text of an icon: trimmed, at most two characters as the user sees them (an emoji counts as one). */
export function normalizeIconText(input: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let text = "";
  let count = 0;
  for (const { segment } of segmenter.segment(input.trim())) {
    if (count === 2) break;
    text += segment;
    count++;
  }
  return text.trim();
}

/** The icon the rail shows: the chosen picture or text, else the initials of the shown name. */
export function iconOf(cluster: ClusterInfo, settings: AppSettings | null): ShownIcon {
  const icon = settings?.clusters[cluster.id]?.icon;
  if (icon?.type === "image" && icon.dataUrl.startsWith(PNG_DATA_URL)) return { kind: "image", src: icon.dataUrl };
  const text = icon?.type === "text" ? normalizeIconText(icon.text) : "";
  return { kind: "text", text: text || initialsOf(displayNameOf(cluster, settings)) };
}
