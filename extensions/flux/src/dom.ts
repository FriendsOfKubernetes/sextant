// What the views share on top of the SDK's UI kit (`ui`, Sextant's own details look): an element builder for the
// action windows' text, a link to an object's details, what a failed call says, and hiding a section.
import { isSextantError, ui, type Sextant } from "@sextant/extension-sdk";
import { refInput, type FluxRef } from "./flux";
import { t } from "./i18n";

type Child = Node | string | null | undefined | false;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/**
 * The kit's link that opens an object's details in Sextant. It asks with the reference's own version, or none (Sextant
 * then takes the kind's), never a guessed one.
 */
export function objectLink(sextant: Sextant, ref: FluxRef, text = ref.name): HTMLButtonElement {
  const opener = { ui: { openDetails: () => sextant.ui.openDetails(refInput(ref)) } };
  return ui.objectLink(opener, { kind: { group: ref.group, version: ref.version ?? "", kind: ref.kind }, namespace: ref.namespace, name: ref.name }, text);
}

/** What a failed call says to the user. */
export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

export const errorBox = (err: unknown): HTMLElement => ui.errorState(errorText(err));

/**
 * Hides the details section (its title too) while it has nothing to show, as the built-in view drew none (ADR-0161);
 * says so only when it changes.
 */
export function sectionHider(sextant: Sextant): (hidden: boolean) => void {
  let shown: boolean | undefined;
  return (hidden) => {
    if (hidden === shown) return;
    shown = hidden;
    void sextant.ui.setHidden(hidden).catch(() => undefined);
  };
}
