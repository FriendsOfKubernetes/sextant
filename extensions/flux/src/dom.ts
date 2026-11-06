// Small DOM helpers the views share.
import { isSextantError, type Sextant } from "@sextant/extension-sdk";
import { refInput, type FluxRef, type Tone } from "./flux";
import { t } from "./i18n";

type Child = Node | string | null | undefined | false;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** A status word with its tone's colour (the word itself is there too, so colour is never the only sign). */
export function badge(text: string, tone: Tone): HTMLElement {
  return element("span", { className: `status ${tone}`, textContent: text });
}

/** A link-styled button that opens an object's details in Sextant. */
export function objectLink(sextant: Sextant, ref: FluxRef, text = ref.name): HTMLButtonElement {
  const button = element("button", { className: "link", type: "button", textContent: text });
  button.addEventListener("click", () => void sextant.ui.openDetails(refInput(ref)).catch(() => undefined));
  return button;
}

/** What a failed call says to the user. */
export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

export function errorBox(err: unknown): HTMLElement {
  return element("p", { className: "error", textContent: errorText(err) });
}

export const muted = (text: string): HTMLElement => element("p", { className: "muted", textContent: text });
