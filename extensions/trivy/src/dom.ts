// Small DOM helpers the views share: the built-in view's badges, notes and tables (in the classes of its stylesheet,
// copied into `style.css`), and the blocks opened and closed in Sextant's own memory of details sections
// (`BlockMemory`). Fields, blocks and links are the SDK's UI kit (`ui`, ADR-0160).
import { isSextantError, ui, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { t } from "./i18n";

type Child = Node | string | null | undefined | false;

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** The tone of a badge, as Sextant's `Badge`. */
export type BadgeTone = "info" | "success" | "warning" | "danger" | "neutral";

/** A badge as Sextant's `Badge`: a word on a fill of its tone. */
export const badge = (text: string, tone: BadgeTone): HTMLElement => element("span", { className: `badge badge--${tone}`, textContent: text });

/** A muted note of the built-in view (`sec-note`): kept line breaks, wrapped anywhere. */
export const note = (text: string, warning = false): HTMLElement => element("p", { className: warning ? "sec-note sec-note--warning" : "sec-note", textContent: text });

/** Muted text inside a line. */
export const muted = (text: string): HTMLElement => element("span", { className: "sec-muted", textContent: text });

/** Code (an image reference). */
export const code = (text: string): HTMLElement => element("code", { className: "sec-code", textContent: text });

/** A cell of `table`: its content, and its hover. */
export interface Cell {
  content: UiContent;
  title?: string;
}

const isCell = (cell: Cell | UiContent): cell is Cell => cell !== null && typeof cell === "object" && !Array.isArray(cell) && !(cell instanceof Node) && "content" in cell;

/**
 * A table of the built-in view (`sec-table` in `sec-table-wrap`): its columns resize and Sextant keeps their widths
 * under `id`, by position, as it kept the built-in `security.<id>` table's.
 */
export function table(sextant: Sextant, id: string, headers: readonly string[], rows: readonly (readonly (Cell | UiContent)[])[]): HTMLElement {
  const node = ui.table(
    headers,
    rows.map((row) => row.map((cell) => (isCell(cell) ? cell.content : cell))),
    { id, sextant },
  );
  node.classList.add("sec-table-wrap");
  node.querySelector("table")?.classList.add("sec-table");
  const trs = node.querySelectorAll("tbody tr");
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const td = trs[r]?.children[c];
      if (isCell(cell) && cell.title && td instanceof HTMLElement) td.title = cell.title;
    }),
  );
  return node;
}

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

/**
 * Which blocks are open: Sextant's own memory of details sections (`context.blocks`, written by `ui.setBlockOpen`),
 * kept per kind as Settings → Appearance says, with the panel's "Expand all" and "Collapse all". A toggle counts at
 * once, until Sextant tells it back.
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

  /** Whether `id` would be drawn open, without counting it as drawn (to watch only what an open block shows). */
  peek(id: string): boolean {
    return this.now(id);
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
