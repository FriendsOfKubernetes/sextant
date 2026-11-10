// Small DOM and formatting helpers the view shares; the blocks, fields, tables, status words and links are the SDK's
// UI kit (`ui`, ADR-0160), the blocks opened and closed in Sextant's own memory of details sections (`BlockMemory`).
// The paragraphs keep the built-in view's look: the controller's error with a red bar on its left, notes that explain
// it with an amber bar, and muted remarks.
import { isSextantError, ui, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";

const paragraph = (className: string, text: string): HTMLElement => Object.assign(document.createElement("p"), { className, textContent: text });

/** The controller's error: a red bar on its left. */
export const message = (text: string): HTMLElement => paragraph("ss-message", text);

/** A note that explains a state: an amber bar on its left. */
export const note = (text: string): HTMLElement => paragraph("ss-note", text);

/** A muted remark. */
export const remark = (text: string): HTMLElement => paragraph("ss-muted", text);

/** A muted word inside a field. */
export const mutedWord = (text: string): HTMLElement => Object.assign(document.createElement("span"), { className: "ss-muted", textContent: text });

/** The date and time in the UI language's default style, as Sextant's `formatDateTime` (`toLocaleString`). */
export const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

/** An RFC 3339 time as a date and time; nothing for no time. */
export function dateTime(time: string | undefined): HTMLElement | null {
  if (!time) return null;
  const node = document.createElement("time");
  node.dateTime = time;
  const ms = Date.parse(time);
  node.textContent = Number.isNaN(ms) ? time : i18n().formatDateTime(ms, DATE_TIME);
  return node;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** Bytes as Sextant's `formatBytes` writes them: "96B", "1.50KiB", the language's decimal sign, no grouping. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)}${BYTE_UNITS[0]}`;
  const digits = Math.abs(value) < 10 ? 2 : Math.abs(value) < 100 ? 1 : 0;
  return `${i18n().formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })}${BYTE_UNITS[unit]}`;
}

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
