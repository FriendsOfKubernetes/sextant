// Sextant's own extensions offered where a cluster runs their tool (ADR-0162): Flux, Argo CD and Argo Rollouts were
// views of Sextant until 0.30 and are now extensions in the catalog. When the active cluster serves a tool's kinds and
// its extension is not installed, the sidebar offers it ("Install", "Not now" for this run, "Don't offer again" kept in
// `extensionCatalog.declinedOffers`). Pure: which offers show.
import type { KindRef } from "../../api";

export interface ExtensionOffer {
  /** The extension's id in the catalog. */
  id: string;
  /** The tool's name (a product name, the same in every language). */
  tool: string;
  /** Whether a kind the cluster serves is the tool's. */
  matches: (kind: Pick<KindRef, "group" | "kind">) => boolean;
}

const fluxGroup = /^[a-z0-9-]+\.toolkit\.fluxcd\.io$/;

export const OFFERS: readonly ExtensionOffer[] = [
  { id: "sextant.flux", tool: "Flux", matches: (k) => fluxGroup.test(k.group) },
  // Argo CD, Argo Rollouts and Argo Workflows share `argoproj.io`: by kind too.
  { id: "sextant.argo-cd", tool: "Argo CD", matches: (k) => k.group === "argoproj.io" && k.kind === "Application" },
  { id: "sextant.argo-rollouts", tool: "Argo Rollouts", matches: (k) => k.group === "argoproj.io" && k.kind === "Rollout" },
  { id: "sextant.argo-workflows", tool: "Argo Workflows", matches: (k) => k.group === "argoproj.io" && k.kind === "Workflow" },
];

/** The offers for a cluster serving `kinds`: its tool is there, the extension is not installed, nor declined. */
export function offersFor(
  kinds: readonly Pick<KindRef, "group" | "kind">[],
  installed: ReadonlySet<string>,
  declined: readonly string[],
  notNow: ReadonlySet<string>,
): ExtensionOffer[] {
  return OFFERS.filter(
    (offer) => !installed.has(offer.id) && !declined.includes(offer.id) && !notNow.has(offer.id) && kinds.some(offer.matches),
  );
}

/** The offer of an extension by id. */
export const offerOf = (id: string): ExtensionOffer | undefined => OFFERS.find((o) => o.id === id);
