// Column widths the user dragged, shared by every table: the resource table and the plain `<table>`s
// (`ResizableTable`). Widths are saved per table id and column id in `AppSettings.columnWidths` (frontend-written,
// read leniently by `crates/sextant-core/src/settings/columns.rs`), a short while after a resize ends.
//
//   const widths = useColumnWidths("helm.releases");
//   widths.widths.name   // px, only for columns the user resized
//   widths.setWidth("name", 240); widths.setWidth("name", null) /* back to the default */; widths.reset();
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { getSettingsSnapshot, subscribeSettings, updateSettings, type TableColumnWidths } from "../../api";

/** Narrowest column, in pixels (Rust `MIN_COLUMN_WIDTH`). */
export const MIN_COLUMN_WIDTH = 48;
/** Widest column, in pixels (Rust `MAX_COLUMN_WIDTH`). */
export const MAX_COLUMN_WIDTH = 1600;
/** One arrow key press on a resize handle; with Shift, {@link WIDTH_STEP_LARGE}. */
export const WIDTH_STEP = 16;
export const WIDTH_STEP_LARGE = 64;
/** Pause after the last change before the widths are written to the settings. */
export const SAVE_WIDTHS_DELAY_MS = 500;
/** Tables with saved widths, at most (Rust `MAX_TABLES`): past it the least recently changed are dropped. */
export const MAX_TABLES = 300;
/** Saved widths per table, at most (Rust `MAX_COLUMNS`). */
export const MAX_COLUMNS = 64;

/** Column id → width in pixels, only for the columns the user resized. */
export type ColumnWidthMap = Readonly<Record<string, number>>;

const EMPTY: ColumnWidthMap = Object.freeze({});

/** A width in the allowed range, in whole pixels. */
export function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return MIN_COLUMN_WIDTH;
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, px)));
}

/**
 * What a key does on a resize handle (the APG window splitter): ← → narrow or widen by {@link WIDTH_STEP} (with
 * Shift {@link WIDTH_STEP_LARGE}), Home the narrowest, End the widest, Enter back to the default width; `null` for any
 * other key. (Ctrl/⌘ + ← → move to the next handle instead: `ResizeHandles`.)
 */
export function widthKeyTarget(key: string, shiftKey: boolean, current: number): number | "reset" | null {
  const step = shiftKey ? WIDTH_STEP_LARGE : WIDTH_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampWidth(current - step);
    case "ArrowRight":
      return clampWidth(current + step);
    case "Home":
      return MIN_COLUMN_WIDTH;
    case "End":
      return MAX_COLUMN_WIDTH;
    case "Enter":
      return "reset";
    default:
      return null;
  }
}

/** The saved widths of a table as stored (`{columns, used}`), without what does not read (a hand-edited file). */
export function cleanWidths(entry: unknown): ColumnWidthMap {
  const columns = entry && typeof entry === "object" ? (entry as { columns?: unknown }).columns : undefined;
  if (!columns || typeof columns !== "object" || Array.isArray(columns)) return EMPTY;
  const out: Record<string, number> = {};
  for (const [column, width] of Object.entries(columns as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_COLUMNS) break;
    if (column && typeof width === "number" && Number.isFinite(width)) out[column] = clampWidth(width);
  }
  return Object.keys(out).length > 0 ? out : EMPTY;
}

/** What one table changed since its last save: `clear` drops the stored widths first, `set` then applies (`null` removes). */
export interface WidthChanges {
  clear: boolean;
  set: Record<string, number | null>;
}

/**
 * All tables' widths after `changes` of `tableId` at `now`: the table's stored columns are merged with the changes
 * (another mounted table of the same id keeps the columns it saved), and past {@link MAX_TABLES} the least recently
 * changed tables are dropped — never the one just changed.
 */
export function applyWidthChanges(
  all: Readonly<Record<string, TableColumnWidths>>,
  tableId: string,
  changes: WidthChanges,
  now: number,
): Record<string, TableColumnWidths> {
  const out = { ...all };
  const columns: Record<string, number> = changes.clear ? {} : { ...(all[tableId]?.columns ?? {}) };
  for (const [column, width] of Object.entries(changes.set)) {
    if (width === null) delete columns[column];
    else columns[column] = clampWidth(width);
  }
  const kept = Object.entries(columns).slice(0, MAX_COLUMNS);
  if (kept.length === 0) {
    delete out[tableId];
    return out;
  }
  out[tableId] = { columns: Object.fromEntries(kept), used: now };
  const ids = Object.keys(out);
  if (ids.length > MAX_TABLES) {
    const oldest = ids
      .filter((id) => id !== tableId)
      .sort((a, b) => (out[a]!.used ?? 0) - (out[b]!.used ?? 0) || (a < b ? 1 : -1));
    for (const id of oldest.slice(0, ids.length - MAX_TABLES)) delete out[id];
  }
  return out;
}

/** The saved widths of one table; the same object while they do not change (other settings changes do not count). */
function useSavedWidths(tableId: string | null): ColumnWidthMap {
  const cache = useRef<{ json: string; value: ColumnWidthMap }>({ json: "{}", value: EMPTY });
  const read = () => {
    const entry = tableId === null ? undefined : getSettingsSnapshot()?.columnWidths?.[tableId];
    const json = entry ? JSON.stringify(entry.columns ?? {}) : "{}";
    if (cache.current.json !== json) cache.current = { json, value: cleanWidths(entry) };
    return cache.current.value;
  };
  return useSyncExternalStore(subscribeSettings, read, read);
}

export interface ColumnWidths {
  /** Width of each column the user resized, in pixels. */
  widths: ColumnWidthMap;
  /** Sets one column (clamped), or `null` = back to its default width. Saved after {@link SAVE_WIDTHS_DELAY_MS}. */
  setWidth: (column: string, px: number | null) => void;
  /** Every column back to its default width. */
  reset: () => void;
  /** Some column has a width of the user's. */
  customized: boolean;
}

/**
 * The widths of the table `tableId` (`null` = kept for this mount only, never saved). A change shows at once and is
 * written to the settings once the user paused (only the columns this table changed, merged into what is stored); a
 * pending write is flushed when the table goes away.
 */
export function useColumnWidths(tableId: string | null): ColumnWidths {
  const saved = useSavedWidths(tableId);
  // The user's latest widths until they are saved (and read back); `null` = the saved ones.
  const [own, setOwn] = useState<{ tableId: string | null; widths: ColumnWidthMap } | null>(null);
  const widths = own && own.tableId === tableId ? own.widths : saved;
  const pending = useRef<{ tableId: string; changes: WidthChanges } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const version = useRef(0);

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    const written = version.current;
    updateSettings((current) => ({
      ...current,
      columnWidths: applyWidthChanges(current.columnWidths ?? {}, next.tableId, next.changes, Date.now()),
    })).then(
      // Saved and read back: the settings say the same now, unless the user changed something meanwhile.
      () => {
        if (version.current === written) setOwn(null);
      },
      // Not saved: the widths stay for this mount.
      () => undefined,
    );
  }, []);

  useEffect(() => flush, [flush, tableId]);

  const latest = useRef(widths);
  latest.current = widths;
  const change = useCallback(
    (next: ColumnWidthMap, record: (changes: WidthChanges) => void) => {
      version.current += 1;
      setOwn({ tableId, widths: next });
      if (tableId === null) return;
      const current = pending.current?.tableId === tableId ? pending.current : { tableId, changes: { clear: false, set: {} } };
      record(current.changes);
      pending.current = current;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_WIDTHS_DELAY_MS);
    },
    [tableId, flush],
  );

  const setWidth = useCallback(
    (column: string, px: number | null) => {
      const current = latest.current;
      if (px === null) {
        if (!(column in current)) return;
        const rest = { ...current };
        delete rest[column];
        change(rest, (c) => {
          c.set[column] = null;
        });
        return;
      }
      const width = clampWidth(px);
      if (current[column] === width) return;
      change({ ...current, [column]: width }, (c) => {
        c.set[column] = width;
      });
    },
    [change],
  );
  const reset = useCallback(() => {
    if (Object.keys(latest.current).length === 0) return;
    change(EMPTY, (c) => {
      c.clear = true;
      c.set = {};
    });
  }, [change]);

  return { widths, setWidth, reset, customized: Object.keys(widths).length > 0 };
}

const CELL_SELECTOR = "td, th, [role='cell'], [role='columnheader'], [role='gridcell']";
/** Marks a tooltip this module wrote (its value is the text), so it is updated or removed, never a cell's own one. */
const CUT_TITLE = "data-cut-title";

/**
 * `onMouseOver` of a table: a cell whose text is cut by its column shows the whole text as its tooltip. Worked out
 * again at every hover, so a cell whose text changed or that now fits loses a stale tooltip; a tooltip the cell has
 * of its own is left alone.
 */
export function showCutText(e: MouseEvent<HTMLElement>): void {
  const cell = (e.target as HTMLElement).closest<HTMLElement>(CELL_SELECTOR);
  if (!cell || !e.currentTarget.contains(cell)) return;
  const title = cell.getAttribute("title");
  const ours = title !== null && cell.getAttribute(CUT_TITLE) === title;
  if (title !== null && !ours) return;
  const text = cell.textContent?.trim() ?? "";
  if (text && cell.scrollWidth > cell.clientWidth) {
    cell.setAttribute("title", text);
    cell.setAttribute(CUT_TITLE, text);
  } else if (ours) {
    cell.removeAttribute("title");
    cell.removeAttribute(CUT_TITLE);
  }
}
