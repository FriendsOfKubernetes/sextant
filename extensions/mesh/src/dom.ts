// Small DOM helpers the views share; the blocks, fields, tables, status words and links are the SDK's UI kit (`ui`,
// ADR-0160), the blocks opened and closed in Sextant's own memory of details sections (`BlockMemory`), where the
// built-in mesh views' blocks were kept. The lines keep the built-in look (`mesh.css`, `gateway.css` of Sextant).
import { isSextantError, ui, type KindRef, type Sextant, type UiContent } from "@sextant/extension-sdk";
import type { Ref } from "./engine/istio";
import { meshKind } from "./engine/kinds";
import type { Phrase } from "./engine/phrases";
import { t } from "./i18n";

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}

/** An element with a class and its content. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...content: UiContent[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  const add = (c: UiContent) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else node.append(typeof c === "string" || typeof c === "number" ? String(c) : (c as Node));
  };
  content.forEach(add);
  return node;
}

/** One line of plain words (`mesh-line`), amber with `warning`. */
export const line = (text: string, warning = false): HTMLElement => el("p", warning ? "mesh-line mesh-line--warning" : "mesh-line", text);

/** A muted remark (`dt-muted`). */
export const muted = (text: string): HTMLElement => el("p", "sx-muted mesh-muted", text);

/** One line per phrase. */
export const phraseLines = (phrases: readonly Phrase[]): HTMLElement[] => phrases.map((ph) => line(t(ph.key, ph.params)));

/** Lucide's "triangle-alert", Sextant's `warning` icon. */
export function warningIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "mesh-icon" }))
    svg.setAttribute(k, v);
  for (const d of ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** `group/version` of a mesh kind for a link (the registered version; Sextant resolves the served one). */
function kindOf(kind: Pick<KindRef, "group" | "kind">): KindRef {
  if (kind.group === "") return { group: "", version: "v1", kind: kind.kind };
  return { group: kind.group, version: meshKind(kind)?.kind.version ?? "v1", kind: kind.kind };
}

/** A link opening the details of `ref`, labelled `label` (default `namespace/name`, or the name in `from`). */
export function meshLink(sextant: Sextant, ref: Ref, label?: string, from?: string): HTMLElement | null {
  if (!ref.name) return null;
  const text = label ?? (ref.namespace && ref.namespace !== from ? `${ref.namespace}/${ref.name}` : ref.name);
  return ui.objectLink(sextant, { kind: kindOf(ref.kind), namespace: ref.namespace || null, name: ref.name }, text);
}

/** Several links in a wrapping row (`dt-links`). */
export const links = (items: readonly (HTMLElement | null)[]): HTMLElement => ui.inline(items.filter((i): i is HTMLElement => i !== null));

/** `ui.fields` labelled from `fields.<key>`; rows with an empty value left out, nothing when all are, as `Fields`. */
export function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== false && value !== "");
  return shown.length > 0 ? ui.fields(shown.map(([key, value]) => [t(`fields.${key}`), value] as const)) : null;
}

/** `key=value` chips of a string map (labels, selectors), as Sextant's `mapChips`. */
export function mapChips(value: unknown): HTMLElement | null {
  const map = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return ui.chips(Object.entries(map).map(([k, v]) => `${k}=${String(v)}`));
}

/** A table as the built-in `SimpleTable` (a row with `broken` marked red on its left). */
export function table(headers: readonly string[], rows: readonly { cells: readonly UiContent[]; broken?: boolean }[]): HTMLElement {
  const node = ui.table(
    headers,
    rows.map((r) => r.cells),
  );
  const trs = node.querySelectorAll("tbody tr");
  rows.forEach((r, i) => {
    if (r.broken) trs[i]?.classList.add("gw-row--broken");
  });
  return node;
}

/**
 * Which blocks are open: Sextant's own memory of details sections (`context.blocks`, written by `ui.setBlockOpen`),
 * with the panel's "Expand all" and "Collapse all" — where the built-in blocks were kept. A toggle counts at once,
 * until Sextant tells it back.
 */
export class BlockMemory {
  private readonly toggled = new Map<string, boolean>();
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

/** Where a view asks whether its blocks are open. */
export interface Blocks {
  isOpen(id: string): boolean;
  peek(id: string): boolean;
  setOpen(id: string, open: boolean): void;
}

/**
 * A titled block as the built-in `Block`: open unless Sextant remembers it closed, closable with its title, buttons in
 * its head. Its content is drawn only while it is open, as the built-in block's was.
 */
export function block(blocks: Blocks, id: string, title: string, content: () => UiContent, actions?: readonly HTMLElement[]): HTMLElement {
  const open = blocks.isOpen(id);
  const node = ui.block(title, open ? content() : null, {
    collapsible: true,
    collapsed: !open,
    onToggle: (now) => blocks.setOpen(id, now),
    ...(actions && actions.length > 0 ? { actions } : {}),
  });
  node.dataset.block = id;
  return node;
}

/** `root` drawn again with `nodes`, the focus kept on the toggle of the block (or the field) that had it. */
export function redraw(root: HTMLElement, nodes: readonly Node[]): void {
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : undefined;
  const focusedBlock = active?.closest<HTMLElement>("[data-block]")?.dataset.block;
  const focusedField = active?.dataset.field;
  const selection = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : undefined;
  root.replaceChildren(...nodes);
  if (focusedField !== undefined) {
    const field = root.querySelector<HTMLElement>(`[data-field="${focusedField}"]`);
    field?.focus();
    if (field instanceof HTMLInputElement && selection) field.setSelectionRange(selection[0] ?? null, selection[1] ?? null);
  } else if (focusedBlock !== undefined) root.querySelector<HTMLElement>(`[data-block="${focusedBlock}"] .sx-block__toggle`)?.focus();
}

/** Calls `run` once in the next microtask, however often it is asked. */
export function batched(run: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      run();
    });
  };
}
