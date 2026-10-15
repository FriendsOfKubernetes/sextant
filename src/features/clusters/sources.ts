// What the UI may do with a kubeconfig source, by its kind: which kinds have "Remove" and what the confirmation says
// removing does to the file. Used by the Add cluster dialog and the Settings page. Keyed by every `SourceKind`, so a
// new kind does not compile until it is decided here.
import type { SourceKind } from "../../api";

type SourcePolicy = { removable: false } | { removable: true; confirmKey: string };

const POLICY: Record<SourceKind, SourcePolicy> = {
  default: { removable: false },
  env: { removable: false },
  // An added file stays on disk; Sextant only forgets it.
  addedFile: { removable: true, confirmKey: "clusters:sources.confirmFile" },
  // Sextant's own copies are deleted.
  pasted: { removable: true, confirmKey: "clusters:sources.confirmPasted" },
  cloud: { removable: true, confirmKey: "clusters:sources.confirmCloud" },
};

/** Whether a source of this kind can be removed from the app (`default` and `KUBECONFIG` cannot). */
export function isRemovableSource(kind: SourceKind): boolean {
  return POLICY[kind].removable;
}

/** The translation key of the remove confirmation for a source of this kind; the added-file text when nothing is
 *  being removed or the kind is not removable. */
export function removeConfirmKey(kind: SourceKind | undefined): string {
  const policy = kind === undefined ? undefined : POLICY[kind];
  return policy?.removable ? policy.confirmKey : "clusters:sources.confirmFile";
}
