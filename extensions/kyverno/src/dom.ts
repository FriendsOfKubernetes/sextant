// Small DOM helpers the views share; the blocks, fields, tables, status words and links are the SDK's UI kit (`ui`,
// ADR-0160), the blocks opened and closed in Sextant's own memory of details sections (`BlockMemory`). The paragraphs
// keep the built-in view's look: an explanation with a bar on its left (red when a policy is not ready or an object
// fails rules), the controller's message, and muted remarks.
import { isSextantError, ui, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { t } from "./i18n";

const paragraph = (className: string, text: string): HTMLElement => Object.assign(document.createElement("p"), { className, textContent: text });

/** What a state means: an amber bar on its left, red with `danger`. */
export const explain = (text: string, danger = false): HTMLElement => paragraph(danger ? "ky-explain ky-explain--danger" : "ky-explain", text);

/** Kyverno's own message. */
export const message = (text: string): HTMLElement => paragraph("ky-message", text);

/** A muted remark. */
export const remark = (text: string): HTMLElement => paragraph("ky-muted", text);

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

/** The error codes Sextant names in their own words (`error.code.<code>`); `other` is "Something went wrong.". */
export const ERROR_CODES = ["unreachable", "unauthorized", "forbidden", "notFound", "conflict", "invalid", "authPlugin", "helmMissing", "portInUse", "kubeconfig", "timeout"] as const;

/**
 * An error as the built-in view's error state showed it: what its code means, then "Details: <message>". A refusal of
 * Sextant's own (`denied`) says so with its message.
 */
export function codedError(err: unknown): HTMLElement {
  if (isSextantError(err, "denied")) return ui.errorState(t("error.denied", { message: err.message }));
  const code = isSextantError(err) ? err.code : "other";
  const known = (ERROR_CODES as readonly string[]).includes(code);
  const message = err instanceof Error ? err.message : err === undefined || err === null ? "" : String(err);
  const node = document.createElement("div");
  node.className = "ky-error";
  node.setAttribute("role", "alert");
  node.dataset.code = code;
  node.append(paragraph("sx-error", known ? t(`error.code.${code}`) : t("error.unknown")));
  if (message) node.append(remark(t("error.details", { message })));
  return node;
}

/**
 * Which blocks are open: Sextant's own memory of details sections (`context.blocks`, written by `ui.setBlockOpen`),
 * kept per kind as Settings → Appearance says, with the panel's "Expand all" and "Collapse all" — where the built-in
 * section's blocks were kept. A toggle counts at once, until Sextant tells it back.
 */
export class BlockMemory {
  private readonly toggled = new Map<string, boolean>();
  /** How each block was last drawn. */
  private readonly shown = new Map<string, boolean>();
  private every: boolean | undefined;

  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {
    this.every = sextant.context.blocks?.["*"];
  }

  private now(id: string): boolean {
    return this.toggled.get(id) ?? ui.blockOpen(this.sextant.context.blocks, id, true);
  }

  /** Whether `id` is open, as it is drawn now. */
  isOpen(id: string): boolean {
    const open = this.now(id);
    this.shown.set(id, open);
    return open;
  }

  setOpen(id: string, open: boolean): void {
    this.toggled.set(id, open);
    void this.sextant.ui.setBlockOpen(id, open).catch(() => undefined);
    this.changed();
  }

  /** After a context change: "Expand all"/"Collapse all" overrides the toggles; whether a drawn block now differs. */
  follow(): boolean {
    const blocks = this.sextant.context.blocks ?? {};
    if (blocks["*"] !== this.every) {
      this.every = blocks["*"];
      this.toggled.clear();
    }
    for (const [id, open] of this.toggled) if (blocks[id] === open) this.toggled.delete(id);
    return [...this.shown].some(([id, open]) => this.now(id) !== open);
  }

  /** Another object: its blocks as Sextant remembers them. */
  reset(): void {
    this.toggled.clear();
    this.shown.clear();
  }
}

/**
 * A titled block as the built-in view's: open unless Sextant remembers it closed, and closable with its title. Its
 * content is drawn only while it is open, as the built-in block's was (the section draws again on each toggle).
 */
export function block(memory: BlockMemory, id: string, title: string, content: () => UiContent): HTMLElement {
  const open = memory.isOpen(id);
  const node = ui.block(title, open ? content() : null, { collapsible: true, collapsed: !open, onToggle: (now) => memory.setOpen(id, now) });
  node.dataset.block = id;
  return node;
}

/** `root` drawn again with `nodes`, the focus kept on the toggle of the block that had it. */
export function redraw(root: HTMLElement, nodes: readonly Node[]): void {
  const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>("[data-block]")?.dataset.block : undefined;
  root.replaceChildren(...nodes);
  if (focused !== undefined) root.querySelector<HTMLElement>(`[data-block="${focused}"] .sx-block__toggle`)?.focus();
}
