// Counters on sidebar section headers (the Gateway API section's problems). A feature registers, for a section, a hook
// that returns the number to show for a cluster; the sidebar draws it as a badge next to the header while it is above
// zero. The hook runs inside a component of its own, one per registration, so registering or removing one never
// changes the hooks of the sidebar.
//
//   registerSectionBadge("gatewayApi", (clusterId) => useGatewayProblems(clusterId).count, {
//     tone: "danger", labelKey: "gateway:problems.count" });   // labelKey: the badge's tooltip, with {{count}}
import type { ClusterId } from "../api";
import type { BadgeTone } from "../components";
import { createRegistryVersion } from "./registryVersion";

export interface SectionBadgeDef {
  /** Unique per registration (the sidebar's key: a new registration is a new component). */
  id: number;
  section: string;
  /** A hook: the count for the cluster; the badge shows while it is above 0. */
  useCount: (clusterId: ClusterId) => number;
  tone?: BadgeTone;
  /** i18n key of the tooltip and accessible label, given `count`. */
  labelKey?: string;
}

const badges = new Map<string, SectionBadgeDef>();
const version = createRegistryVersion();
let seq = 0;

/** Sets the badge of `section` (replacing one registered before); returns a function that removes it. */
export function registerSectionBadge(
  section: string,
  useCount: SectionBadgeDef["useCount"],
  options: Pick<SectionBadgeDef, "tone" | "labelKey"> = {},
): () => void {
  const def: SectionBadgeDef = { id: ++seq, section, useCount, ...options };
  badges.set(section, def);
  version.bump();
  return () => {
    if (badges.get(section) === def) {
      badges.delete(section);
      version.bump();
    }
  };
}

export function getSectionBadge(section: string): SectionBadgeDef | undefined {
  return badges.get(section);
}

/** Re-renders the caller when badges are registered or removed. */
export function useSectionBadgesVersion(): number {
  return version.use();
}
