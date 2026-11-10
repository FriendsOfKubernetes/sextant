// Sextant's details building blocks for an extension's frame (#355, ADR-0160): the same structure, classes and theme
// tokens as Sextant's own details panel (`src/features/details/details.css`), so a view moved out of the core looks
// like it did. Plain DOM: no framework. `addUiStyles()` puts the styles in once (`fields`, `block` and the rest call
// it themselves); the extension's own styles come later and win.
import type { ObjectRef } from "./generated/ObjectRef";
import { iconMarkup } from "./icons";

/** The tone of a status word, as Sextant's tables and details colour it. */
export type UiTone = "success" | "warning" | "danger" | "muted" | "neutral";

const STYLE_ID = "sextant-ui-styles";

const UI_STYLES = `
.sx-block { margin: 12px 0; min-width: 0; }
.sx-block .sx-block { margin: 8px 0; }
.sx-block__head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sx-block__actions { display: flex; gap: 6px; margin-left: auto; }
.sx-block__title { margin: 0; font-size: 0.8125rem; font-weight: 600; flex: 1; min-width: 0; }
.sx-block__toggle { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font: inherit; font-weight: 600; font-size: 0.8125rem; }
.sx-block__toggle::before { content: "▾"; display: inline-block; width: 1em; color: var(--color-text-muted); }
.sx-block__toggle[aria-expanded="false"]::before { content: "▸"; }
.sx-block__toggle:focus-visible { outline: 2px solid var(--color-focus, var(--color-accent)); outline-offset: 1px; border-radius: 2px; }
.sx-block__body[hidden] { display: none; }
.sx-fields { display: grid; grid-template-columns: minmax(110px, 30%) 1fr; gap: 4px 12px; margin: 0; }
.sx-fields__label { color: var(--color-text-muted); }
.sx-fields__value { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.sx-muted { color: var(--color-text-muted); }
.sx-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.sx-chip { background: var(--color-hover); border-radius: 3px; padding: 0 6px; font-size: 0.75rem; overflow-wrap: anywhere; }
.sx-links { display: inline-flex; flex-wrap: wrap; gap: 4px 12px; }
.sx-table-wrap { max-width: 100%; overflow-x: auto; }
.sx-table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
.sx-table th, .sx-table td { text-align: left; padding: 4px 8px 4px 0; height: auto; border-bottom: 1px solid var(--color-border); vertical-align: top; overflow-wrap: anywhere; }
.sx-table th { color: var(--color-text-muted); font-weight: 500; }
.sx-table--nowrap th, .sx-table--nowrap td { white-space: nowrap; overflow-wrap: normal; }
.sx-table--fixed > thead > tr > th, .sx-table--fixed > tbody > tr > td:not([colspan]) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; }
.sx-resize { position: relative; }
.sx-resize__handles { position: absolute; top: 0; left: 0; width: 100%; height: 0; z-index: 3; pointer-events: none; }
.sx-resize__handle { position: absolute; width: 8px; cursor: col-resize; touch-action: none; outline: none; pointer-events: auto; }
.sx-resize__handle::after { content: ""; position: absolute; top: 20%; bottom: 20%; left: 3px; width: 2px; border-radius: 1px; background: transparent; }
.sx-resize__handle:hover::after, .sx-resize__handle:active::after, .sx-resize__handle:focus-visible::after { background: var(--color-accent); }
.sx-resize__handle:focus-visible { outline: 2px solid var(--color-focus, var(--color-accent)); outline-offset: -2px; }
.sx-visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.sx-table tr:hover td { background: transparent; }
.sx-status--success { color: var(--color-success); }
.sx-status--warning { color: var(--color-warning); }
.sx-status--danger { color: var(--color-danger); }
.sx-status--muted { color: var(--color-text-muted); }
.sx-link { border: none; background: transparent; padding: 0; height: auto; color: var(--color-accent); cursor: pointer; text-align: left; overflow-wrap: anywhere; }
.sx-link:hover:not(:disabled) { background: transparent; text-decoration: underline; }
.sx-pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.75rem; }
.sx-empty { color: var(--color-text-muted); margin: 8px 0; }
.sx-error { color: var(--color-danger); margin: 8px 0; overflow-wrap: anywhere; }
.sx-field { display: inline-flex; flex-direction: column; gap: 4px; min-width: 0; }
.sx-field__label { color: var(--color-text-muted); font-size: 0.75rem; }
.sx-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--color-border); margin-bottom: 8px; overflow-x: auto; }
.sx-tab { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--color-text-muted); }
.sx-tab[aria-selected="true"] { color: var(--color-text); border-bottom-color: var(--color-accent); }
.sx-loading { color: var(--color-text-muted); margin: 8px 0; }
.sx-search { min-width: 12em; }
.sx-button--icon { display: inline-flex; align-items: center; gap: 6px; }
.sx-icon { display: inline-flex; flex: none; }
.sx-icon:empty { display: none; }
.sx-icon svg { width: var(--icon-size, 16px); height: var(--icon-size, 16px); }
.sx-checkbox { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.sx-checkbox__box { appearance: none; -webkit-appearance: none; flex: none; width: 14px; height: 14px; margin: 0; border: 1px solid var(--color-text-muted); border-radius: 3px; background-color: var(--color-main); background-position: center; background-repeat: no-repeat; background-size: 10px 10px; cursor: pointer; vertical-align: middle; }
.sx-checkbox__box:hover { border-color: var(--color-accent); }
.sx-checkbox__box:checked { border-color: var(--color-accent); background-color: var(--color-accent); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M1.5 5.2 4 7.6 8.5 2.6' fill='none' stroke='%23ffffff' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
:root[data-theme="dark"] .sx-checkbox__box:checked { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M1.5 5.2 4 7.6 8.5 2.6' fill='none' stroke='%2315181b' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
.sx-checkbox__box:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
.sx-checkbox__box:disabled { cursor: default; opacity: 0.5; }
`;

/** Puts the kit's styles into the document once (first in `<head>`, so the extension's own come later and win). */
export function addUiStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = UI_STYLES;
  doc.head.prepend(style);
}

/** What a builder takes as content: nodes, text, or nothing (`null`, `undefined`, `false` are left out). */
export type UiContent = Node | string | number | null | undefined | false | readonly UiContent[];

function append(parent: Node, content: UiContent): void {
  if (content === null || content === undefined || content === false) return;
  if (Array.isArray(content)) {
    for (const item of content as readonly UiContent[]) append(parent, item);
    return;
  }
  parent.appendChild(typeof content === "string" || typeof content === "number" ? document.createTextNode(String(content)) : (content as Node));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: UiContent): HTMLElementTagNameMap[K] {
  addUiStyles();
  const node = document.createElement(tag);
  node.className = className;
  append(node, content);
  return node;
}

/**
 * Whether a details frame's block is open by Sextant's memory (`context.blocks`, since Sextant 0.30): its own choice,
 * else the panel's "Expand all"/"Collapse all", else `defaultOpen`. Pair it with `block`'s `onToggle` calling
 * `sextant.ui.setBlockOpen(id, open)`.
 */
export function blockOpen(blocks: Readonly<Record<string, boolean>> | undefined, id: string, defaultOpen = true): boolean {
  return blocks?.[id] ?? blocks?.["*"] ?? defaultOpen;
}

let blockCounter = 0;

/**
 * A titled block, as a section of Sextant's details: with `collapsible`, a disclosure button (keyboard and screen
 * readers included) that shows and hides the body; `collapsed` starts it closed, and `onToggle` hears each change (to
 * remember it in `storage`, or to watch only while the block is open; since Sextant 0.30). `actions` go in its head,
 * after the title (a "Logs" button of the block's pods).
 */
export function block(
  title: string,
  content: UiContent,
  options: { collapsible?: boolean; collapsed?: boolean; onToggle?: (open: boolean) => void; actions?: readonly HTMLElement[] } = {},
): HTMLElement {
  const section = el("section", "sx-block");
  const head = el("div", "sx-block__head");
  const body = el("div", "sx-block__body", content);
  const heading = el("h3", "sx-block__title");
  if (options.collapsible) {
    const id = `sx-block-${++blockCounter}`;
    body.id = id;
    const toggle = el("button", "sx-block__toggle", title);
    toggle.type = "button";
    toggle.setAttribute("aria-controls", id);
    const set = (open: boolean) => {
      toggle.setAttribute("aria-expanded", String(open));
      body.hidden = !open;
    };
    set(!options.collapsed);
    toggle.addEventListener("click", () => {
      const open = body.hidden === true;
      set(open);
      options.onToggle?.(open);
    });
    heading.append(toggle);
  } else {
    heading.textContent = title;
  }
  head.append(heading);
  if (options.actions && options.actions.length > 0) head.append(el("div", "sx-block__actions", [...options.actions]));
  section.append(head, body);
  section.setAttribute("aria-label", title);
  return section;
}

/** A row of `fields`: a label and its value; a row whose value is nothing is left out. */
export type FieldRow = readonly [label: string, value: UiContent];

/** A list of labelled values, as the fields of Sextant's details. */
export function fields(rows: readonly FieldRow[]): HTMLElement {
  const list = el("dl", "sx-fields");
  for (const [label, value] of rows) {
    if (value === null || value === undefined || value === false || value === "") continue;
    list.append(el("dt", "sx-fields__label", label), el("dd", "sx-fields__value", value));
  }
  return list;
}

/** Narrowest column a user can make, in pixels (as Sextant's own tables). */
export const MIN_COLUMN_WIDTH = 48;
/** Widest column, in pixels. */
export const MAX_COLUMN_WIDTH = 1600;
const WIDTH_STEP = 16;
const WIDTH_STEP_LARGE = 64;
/** Half a handle's width: it sits on the column's right edge. */
const HANDLE_HALF = 4;

/** What a table whose columns resize needs of the client (`connect()`'s `Sextant`): its context and `ui.setColumnWidth`. */
export interface ColumnWidthKeeper {
  readonly context: {
    columnWidths?: Readonly<Record<string, Readonly<Record<string, number>>>>;
    texts?: { resizeColumn: string; resizeHint: string };
  };
  ui: { setColumnWidth(table: string, column: string, width: number | null): Promise<void> };
}

export interface TableOptions {
  /** The table's accessible name. */
  label?: string;
  /**
   * Since Sextant 0.30, with `sextant`: the user can resize the columns (drag a header's right edge, or its handle's
   * arrow keys), and Sextant keeps the widths under this id (letters, digits, `-`, `_`, `.`), as it keeps its own
   * tables'. A resized table keeps each cell on one line, cut with an ellipsis (the whole text in its tooltip).
   */
  id?: string;
  sextant?: ColumnWidthKeeper;
  /** Stable ids of the columns, one per header (not translated): what the widths are kept under; by position otherwise. */
  columns?: readonly string[];
  /** Cells on one line, never wrapped. */
  nowrap?: boolean;
}

/** Widths set in this frame that Sextant's context does not tell yet, by table id (`null`: back to its own). */
const pendingWidths = new Map<string, Map<string, number | null>>();

function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return MIN_COLUMN_WIDTH;
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, px)));
}

/** The table's widths: Sextant's, with what this frame set since (dropped once the context says the same). */
function widthsOf(id: string, keeper: ColumnWidthKeeper): Record<string, number> {
  const saved = keeper.context.columnWidths?.[id] ?? {};
  const out: Record<string, number> = {};
  for (const [column, width] of Object.entries(saved)) if (typeof width === "number" && Number.isFinite(width)) out[column] = clampWidth(width);
  const pending = pendingWidths.get(id);
  for (const [column, width] of pending ?? []) {
    if ((width === null && out[column] === undefined) || width === out[column]) pending!.delete(column);
    else if (width === null) delete out[column];
    else out[column] = width;
  }
  if (pending && pending.size === 0) pendingWidths.delete(id);
  return out;
}

let tableSeq = 0;

/**
 * A table with a header row; `rows` hold one cell per header. With `id` and `sextant` (since Sextant 0.30) its columns
 * resize and Sextant remembers their widths.
 */
export function table(headers: readonly string[], rows: readonly (readonly UiContent[])[], options: TableOptions = {}): HTMLElement {
  const wrap = el("div", "sx-table-wrap");
  const tableEl = el("table", options.nowrap ? "sx-table sx-table--nowrap" : "sx-table");
  if (options.label) tableEl.setAttribute("aria-label", options.label);
  const head = el("thead", "");
  const headRow = el("tr", "");
  const cells: HTMLTableCellElement[] = [];
  for (const header of headers) {
    const th = el("th", "", header);
    th.scope = "col";
    headRow.append(th);
    cells.push(th);
  }
  head.append(headRow);
  const body = el("tbody", "");
  for (const row of rows) {
    const tr = el("tr", "");
    for (const cell of row) tr.append(el("td", "", cell));
    body.append(tr);
  }
  tableEl.append(head, body);
  wrap.append(tableEl);
  const { id, sextant } = options;
  if (id !== undefined && sextant && /^[A-Za-z0-9._-]{1,80}$/.test(id) && cells.length > 0) {
    const keys = headers.map((_, i) => {
      const key = options.columns?.[i];
      return typeof key === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(key) ? key : String(i);
    });
    resizable(wrap, tableEl, cells, headers, keys, id, sextant);
  }
  return wrap;
}

/** The handles over a table's header, one per named column: drag, double-click, or the keys of Sextant's own tables. */
function resizable(
  wrap: HTMLElement,
  tableEl: HTMLTableElement,
  cells: readonly HTMLTableCellElement[],
  headers: readonly string[],
  keys: readonly string[],
  id: string,
  keeper: ColumnWidthKeeper,
): void {
  wrap.classList.add("sx-resize");
  const texts = keeper.context.texts;
  const colgroup = document.createElement("colgroup");
  const cols = keys.map(() => colgroup.appendChild(document.createElement("col")));
  tableEl.prepend(colgroup);
  const layer = el("div", "sx-resize__handles");
  const hint = el(
    "span",
    "sx-visually-hidden",
    texts?.resizeHint ?? "Left and Right arrows change the width (Shift: larger steps), Enter restores the default width, Control with Left or Right moves to another column.",
  );
  hint.id = `sx-resize-hint-${++tableSeq}`;
  layer.append(hint);
  wrap.prepend(layer);
  /** The widths the columns had in the table's own layout, for the columns the user did not resize. */
  let natural: number[] | null = null;
  const measured = () => cells.map((c) => Math.round(c.getBoundingClientRect().width) || MIN_COLUMN_WIDTH);
  const fixed = () => tableEl.classList.contains("sx-table--fixed");
  const widthAt = (i: number, widths: Record<string, number>) => widths[keys[i]!] ?? natural?.[i] ?? MIN_COLUMN_WIDTH;
  const fix = (widths: Record<string, number>) => {
    if (!fixed()) natural = measured();
    let total = 0;
    cols.forEach((col, i) => {
      const width = widthAt(i, widths);
      col.style.width = `${width}px`;
      total += width;
    });
    tableEl.classList.add("sx-table--fixed");
    tableEl.style.tableLayout = "fixed";
    tableEl.style.width = `${total}px`;
  };
  const unfix = () => {
    for (const col of cols) col.style.width = "";
    tableEl.classList.remove("sx-table--fixed");
    tableEl.style.tableLayout = "";
    tableEl.style.width = "";
    natural = null;
  };
  const layout = () => {
    const widths = widthsOf(id, keeper);
    if (keys.some((k) => widths[k] !== undefined)) fix(widths);
    else unfix();
  };
  const handles: HTMLElement[] = [];
  const place = () => {
    const box = tableEl.getBoundingClientRect();
    const headBox = tableEl.tHead?.getBoundingClientRect();
    const last = tableEl.offsetLeft + box.width - 2 * HANDLE_HALF;
    for (const handle of handles) {
      const cell = cells[Number(handle.dataset.index)]!;
      handle.style.left = `${Math.round(Math.min(tableEl.offsetLeft + cell.getBoundingClientRect().right - box.left - HANDLE_HALF, last))}px`;
      handle.style.top = `${headBox ? Math.round(tableEl.offsetTop + headBox.top - box.top) : 0}px`;
      handle.style.height = `${headBox ? Math.round(headBox.height) : 0}px`;
    }
  };
  const current = (i: number) => (fixed() ? widthAt(i, widthsOf(id, keeper)) : Math.round(cells[i]!.getBoundingClientRect().width) || MIN_COLUMN_WIDTH);
  const preview = (i: number, px: number) => {
    const widths = { ...widthsOf(id, keeper), [keys[i]!]: px };
    fix(widths);
    place();
  };
  const commit = (i: number, px: number | null) => {
    const key = keys[i]!;
    const pending = pendingWidths.get(id) ?? new Map<string, number | null>();
    pending.set(key, px);
    pendingWidths.set(id, pending);
    void keeper.ui.setColumnWidth(id, key, px).catch(() => undefined);
    layout();
    place();
    for (const handle of handles) handle.setAttribute("aria-valuenow", String(current(Number(handle.dataset.index))));
  };
  headers.forEach((name, i) => {
    if (name.trim() === "") return;
    const handle = el("div", "sx-resize__handle");
    handle.dataset.index = String(i);
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", (texts?.resizeColumn ?? "Resize column {{name}}").split("{{name}}").join(name));
    handle.setAttribute("aria-valuemin", String(MIN_COLUMN_WIDTH));
    handle.setAttribute("aria-valuemax", String(MAX_COLUMN_WIDTH));
    handle.setAttribute("aria-describedby", hint.id);
    handle.tabIndex = handles.length === 0 ? 0 : -1;
    let drag: { pointer: number; startX: number; start: number; latest: number | null; frame: number } | null = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      drag = { pointer: e.pointerId, startX: e.clientX, start: current(i), latest: null, frame: 0 };
    });
    handle.addEventListener("pointermove", (e) => {
      const d = drag;
      if (!d || d.pointer !== e.pointerId) return;
      d.latest = clampWidth(d.start + e.clientX - d.startX);
      if (d.frame !== 0) return;
      d.frame = requestAnimationFrame(() => {
        d.frame = 0;
        if (d.latest !== null) preview(i, d.latest);
      });
    });
    const end = (e: PointerEvent) => {
      const d = drag;
      if (!d || d.pointer !== e.pointerId) return;
      drag = null;
      if (d.frame !== 0) cancelAnimationFrame(d.frame);
      if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      if (d.latest !== null) commit(i, d.latest);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
    handle.addEventListener("click", (e) => e.stopPropagation());
    handle.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      commit(i, null);
    });
    handle.addEventListener("focus", () => {
      for (const other of handles) other.tabIndex = other === handle ? 0 : -1;
      handle.setAttribute("aria-valuenow", String(current(i)));
    });
    handle.addEventListener("keydown", (e) => {
      if (e.altKey) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        const at = handles.indexOf(handle) + (e.key === "ArrowLeft" ? -1 : 1);
        handles[Math.max(0, Math.min(handles.length - 1, at))]?.focus();
        return;
      }
      const step = e.shiftKey ? WIDTH_STEP_LARGE : WIDTH_STEP;
      const now = current(i);
      const target =
        e.key === "ArrowLeft" ? clampWidth(now - step)
        : e.key === "ArrowRight" ? clampWidth(now + step)
        : e.key === "Home" ? MIN_COLUMN_WIDTH
        : e.key === "End" ? MAX_COLUMN_WIDTH
        : e.key === "Enter" ? null
        : undefined;
      if (target === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      commit(i, target);
    });
    handles.push(handle);
    layer.append(handle);
  });
  // A cut cell shows its whole text as its tooltip.
  tableEl.addEventListener("mouseover", (e) => {
    const cell = (e.target as HTMLElement).closest?.("td, th");
    if (!(cell instanceof HTMLElement) || !tableEl.contains(cell) || !fixed()) return;
    const text = cell.textContent?.trim() ?? "";
    if (text && cell.scrollWidth > cell.clientWidth && !cell.hasAttribute("title")) {
      cell.setAttribute("title", text);
      cell.dataset.sxCut = "";
    } else if (cell.dataset.sxCut !== undefined && cell.scrollWidth <= cell.clientWidth) {
      cell.removeAttribute("title");
      delete cell.dataset.sxCut;
    }
  });
  // Laid out once the table is in the document and has its size; the handles follow every change of size after.
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    layout();
    place();
    for (const handle of handles) handle.setAttribute("aria-valuenow", String(current(Number(handle.dataset.index))));
  };
  if (typeof ResizeObserver === "undefined") {
    start();
    return;
  }
  const sizes = new ResizeObserver(() => {
    // Taken out of the document (a redraw): nothing to follow any more.
    if (!tableEl.isConnected) {
      if (started) sizes.disconnect();
      return;
    }
    if (!started) {
      if (tableEl.getBoundingClientRect().width === 0) return;
      start();
      return;
    }
    place();
  });
  sizes.observe(tableEl);
  for (const cell of cells) sizes.observe(cell);
}

/** A status word in its tone's colour; the word itself is shown, so colour is never the only sign. */
export function status(text: string, tone: UiTone = "neutral"): HTMLElement {
  return el("span", tone === "neutral" ? "sx-status" : `sx-status sx-status--${tone}`, text);
}

/** Small chips for a list of values (labels, flags); nothing for an empty list. */
export function chips(values: readonly (string | null | undefined)[]): HTMLElement | null {
  const shown = values.filter((v): v is string => typeof v === "string" && v !== "");
  if (shown.length === 0) return null;
  const list = el("span", "sx-chips");
  for (const value of shown) list.append(el("span", "sx-chip", value));
  return list;
}

/** Muted text. */
export function muted(text: string): HTMLElement {
  return el("span", "sx-muted", text);
}

/** Preformatted text (a message, a manifest). */
export function pre(text: string): HTMLElement {
  return el("pre", "sx-pre", text);
}

/** Links (or anything inline) side by side. */
export function inline(items: readonly UiContent[]): HTMLElement {
  return el("span", "sx-links", items);
}

/** What `objectLink` needs of the client: `sextant.ui.openDetails`. */
export interface DetailsOpener {
  ui: { openDetails(ref: ObjectRef): Promise<void> };
}

/** A link-styled button that opens an object's details in Sextant's panel. */
export function objectLink(sextant: DetailsOpener, ref: ObjectRef, text: string = ref.name): HTMLButtonElement {
  const button = el("button", "sx-link", text);
  button.type = "button";
  button.addEventListener("click", () => void sextant.ui.openDetails(ref).catch(() => undefined));
  return button;
}

/**
 * A button in Sextant's style: `primary` for the main action, `danger` for one that removes or stops something.
 * `icon` (since Sextant 0.30): one of Sextant's icons by name (`requestCheck`, `logs`, …), before the label as on
 * Sextant's own buttons; Sextant draws it, and a name it does not have shows no icon. The label stays the button's
 * text, so the icon is decoration (hidden from screen readers).
 */
export function button(
  label: string,
  onClick: () => void,
  options: { variant?: "default" | "primary" | "danger"; disabled?: boolean; title?: string; icon?: string } = {},
): HTMLButtonElement {
  const variant = options.variant && options.variant !== "default" ? options.variant : "";
  const node = el("button", options.icon ? `${variant} sx-button--icon`.trim() : variant, label);
  node.type = "button";
  node.disabled = options.disabled === true;
  if (options.title) node.title = options.title;
  node.addEventListener("click", onClick);
  if (options.icon) {
    const slot = el("span", "sx-icon");
    slot.setAttribute("aria-hidden", "true");
    node.prepend(slot);
    void iconMarkup(options.icon).then((svg) => {
      if (svg === null) slot.remove();
      else slot.innerHTML = svg;
    });
  }
  return node;
}

/**
 * A checkbox with its label, drawn as Sextant's own (`src/components/checkbox.css`: the theme's colors, the accent when
 * checked) instead of the browser's, which follows the toolkit's theme: "Only problems" on an extension's page.
 * `onChange` gets whether it is checked (since Sextant 0.30).
 */
export function checkbox(
  label: string,
  onChange: (checked: boolean) => void,
  options: { checked?: boolean; disabled?: boolean; title?: string } = {},
): HTMLLabelElement {
  const box = el("input", "sx-checkbox__box");
  box.type = "checkbox";
  box.checked = options.checked === true;
  box.disabled = options.disabled === true;
  box.addEventListener("change", () => onChange(box.checked));
  const node = el("label", "sx-checkbox", [box, label]);
  if (options.title) node.title = options.title;
  return node;
}

/** "Loading…" or any text, announced politely while something is read. */
export function loading(text: string): HTMLElement {
  const node = el("p", "sx-loading", text);
  node.setAttribute("role", "status");
  return node;
}

/** A search field, labelled for screen readers; `onInput` gets the text as typed. */
export function searchInput(label: string, onInput: (text: string) => void, options: { placeholder?: string; value?: string } = {}): HTMLInputElement {
  const input = el("input", "sx-search");
  input.type = "search";
  input.setAttribute("aria-label", label);
  input.placeholder = options.placeholder ?? label;
  input.value = options.value ?? "";
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

/** One tab of `tabs`: its id, label and what it shows (drawn when chosen). */
export interface UiTab {
  id: string;
  label: string;
  render: () => UiContent;
}

/**
 * Tabs as Sextant's details have them: a tablist with arrow keys, Home and End, and one panel showing the chosen tab
 * (`render` runs again each time a tab is chosen). `onChange` hears the choice.
 */
export function tabs(items: readonly UiTab[], options: { selected?: string; label?: string; onChange?: (id: string) => void } = {}): HTMLElement {
  const root = el("div", "sx-tabs-root");
  const list = el("div", "sx-tabs");
  list.setAttribute("role", "tablist");
  if (options.label) list.setAttribute("aria-label", options.label);
  const panel = el("div", "sx-tab-panel");
  panel.setAttribute("role", "tabpanel");
  const prefix = `sx-tab-${++blockCounter}`;
  const buttons = items.map((item, i) => {
    const tab = el("button", "sx-tab", item.label);
    tab.type = "button";
    tab.id = `${prefix}-${i}`;
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => choose(i));
    tab.addEventListener("keydown", (event) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = (next + items.length) % items.length;
      choose(target);
      buttons[target]!.focus();
    });
    return tab;
  });
  function choose(index: number): void {
    buttons.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", buttons[index]!.id);
    panel.replaceChildren();
    append(panel, items[index]!.render());
    options.onChange?.(items[index]!.id);
  }
  list.append(...buttons);
  root.append(list, panel);
  if (items.length > 0) choose(Math.max(0, items.findIndex((t) => t.id === options.selected)));
  return root;
}

/** What `namespaceSelect` needs of the client. */
export interface NamespaceSource {
  context: { clusterId: string | null; namespaces: string[] | null };
  resources: {
    list(params: { clusterId?: string; kind: { kind: string } }): Promise<{ items: { metadata?: { name?: string } }[] }>;
  };
}

/**
 * A labelled namespace choice like Sextant's: the cluster's namespaces when the extension may list them, else the
 * ones the window's filter names (and `value`); `labels.all` adds "every namespace" (`null`). `onChange` hears the
 * choice. The list is read once; a failure leaves the names it already knows.
 */
export function namespaceSelect(
  sextant: NamespaceSource,
  options: {
    value?: string | null;
    onChange: (namespace: string | null) => void;
    labels: { label: string; all?: string };
    clusterId?: string;
  },
): HTMLElement {
  const wrap = el("label", "sx-field");
  const caption = el("span", "sx-field__label", options.labels.label);
  const select = el("select", "sx-namespace");
  wrap.append(caption, select);
  const fill = (names: readonly string[]) => {
    const current = select.value || (options.value ?? "");
    select.replaceChildren();
    if (options.labels.all) select.append(new Option(options.labels.all, ""));
    const all = [...new Set([...names, ...(options.value ? [options.value] : [])])].sort((a, b) => a.localeCompare(b));
    for (const name of all) select.append(new Option(name, name));
    select.value = all.includes(current) || (current === "" && options.labels.all) ? current : (all[0] ?? "");
  };
  fill(sextant.context.namespaces ?? []);
  select.addEventListener("change", () => options.onChange(select.value === "" ? null : select.value));
  const clusterId = options.clusterId ?? sextant.context.clusterId ?? undefined;
  sextant.resources
    .list({ ...(clusterId ? { clusterId } : {}), kind: { kind: "Namespace" } })
    .then((answer) => fill(answer.items.map((n) => n.metadata?.name).filter((n): n is string => typeof n === "string")))
    .catch(() => undefined);
  return wrap;
}

/** A line saying there is nothing to show. */
export function empty(text: string): HTMLElement {
  return el("p", "sx-empty", text);
}

/** An error, read by screen readers as it appears: its message (a `SextantError`'s, or any `Error`'s). */
export function errorState(error: unknown, title?: string): HTMLElement {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const node = el("p", "sx-error", title ? `${title}: ${message}` : message);
  node.setAttribute("role", "alert");
  return node;
}
