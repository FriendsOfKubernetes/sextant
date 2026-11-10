// Small DOM helpers the views share; the blocks, fields, tables, status words and links are the SDK's UI kit (`ui`,
// ADR-0160), the blocks opened and closed in Sextant's own memory of details sections (`BlockMemory`). The notes keep
// the built-in view's look (cert-manager's classes): a remark with an amber bar on its left (red with `danger`), or muted.
import { isSextantError, ui, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { t } from "./i18n";

/** A note as the built-in view's: an amber bar on its left (`warning`), a red one (`danger`), or muted text. */
export const note = (text: string, tone: "warning" | "danger" | "muted"): HTMLElement =>
  Object.assign(document.createElement("p"), { className: `traefik-note traefik-note--${tone}`, textContent: text });

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
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

  /** Whether `id` is open, without counting it as drawn (what to watch). */
  peek(id: string): boolean {
    return this.now(id);
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

/** Where a view asks whether its blocks are open: Sextant's memory, or every block open (tests). */
export interface Blocks {
  isOpen(id: string): boolean;
  setOpen(id: string, open: boolean): void;
}

export const ALL_OPEN: Blocks = { isOpen: () => true, setOpen: () => undefined };

/**
 * A titled block as the built-in view's: open unless Sextant remembers it closed, and closable with its title. Its
 * content is drawn only while it is open, as the built-in block's was (the section draws again on each toggle).
 */
export function block(blocks: Blocks, id: string, title: string, content: () => UiContent): HTMLElement {
  const open = blocks.isOpen(id);
  const node = ui.block(title, open ? content() : null, { collapsible: true, collapsed: !open, onToggle: (now) => blocks.setOpen(id, now) });
  node.dataset.block = id;
  return node;
}

/** `root` drawn again with `nodes`, the focus kept on the toggle of the block that had it. */
export function redraw(root: HTMLElement, nodes: readonly Node[]): void {
  const focused =
    document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>("[data-block]")?.dataset.block : undefined;
  root.replaceChildren(...nodes);
  if (focused !== undefined) root.querySelector<HTMLElement>(`[data-block="${focused}"] .sx-block__toggle`)?.focus();
}
