// A plain `<table>` whose columns the user can resize: a drop-in for `<table>` with a stable `tableId` under which the
// widths are saved (`useColumnWidths`).
//
//   <ResizableTable tableId="helm.releases" className="helm-table" aria-label={…}><thead>…</thead><tbody>…</tbody></ResizableTable>
//
// The columns are the cells of the last header row (`thead`); a column is named by its `data-col` attribute, or by
// its position when it has none — give `data-col` (a key that is not translated) to every column of a table whose
// columns come and go. A header cell without text (a checkbox column) gets no handle. The handles sit in a layer
// above the header (inside a header cell they would become part of its name); while nothing is resized the table
// keeps its own (auto) layout, after a resize it switches to `table-layout: fixed` with a `<colgroup>`: the resized
// columns get the user's widths, the others the widths they had. A drag moves the `<col>` directly, once per frame,
// without a React render. The handles are placed from the table's own offsets (a wrapper that scrolls sideways does
// not move them) and placed again only when a header cell changes size or the header changes, never per render.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type TableHTMLAttributes,
} from "react";
import { MIN_COLUMN_WIDTH, showCutText, useColumnWidths } from "./columnWidths";
import { ResizeHandles } from "./ResizeHandle";
import "./table.css";

export interface ResizableTableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Stable id the widths are saved under (`helm.releases`); `null` = not saved. */
  tableId: string | null;
  /** Extra class of the wrapper the table and its handles sit in (e.g. a container that scrolls sideways). */
  wrapperClassName?: string;
  children?: ReactNode;
}

/** Half the width of a handle: it is centred on the column's right edge. */
const HANDLE_HALF = 4;

interface HeadColumn {
  key: string;
  /** The header's text; empty = no handle. */
  name: string;
  /** Left of the handle, from the left of the wrapper's content (kept inside the table). */
  left: number;
}

interface HeadLayout {
  cols: HeadColumn[];
  top: number;
  height: number;
  /** The header cells stick to the top of a scrolling container: so do the handles. */
  sticky: boolean;
}

/** Cells of the last header row. */
function headerCells(table: HTMLTableElement): HTMLTableCellElement[] {
  const rows = table.tHead?.rows;
  const row = rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
  return row ? [...row.cells] : [];
}

function keyOf(cell: HTMLTableCellElement, index: number): string {
  return cell.dataset.col || String(index);
}

function cellWidth(cell: HTMLElement | undefined): number {
  return cell ? Math.round(cell.getBoundingClientRect().width) : MIN_COLUMN_WIDTH;
}

function colsOf(table: HTMLTableElement): HTMLElement[] {
  return [...(table.querySelector(":scope > colgroup")?.children ?? [])] as HTMLElement[];
}

/** Where the handles go: from the table's offsets in the wrapper, so a scrolled wrapper does not shift them. */
function headLayoutOf(table: HTMLTableElement): HeadLayout {
  const cells = headerCells(table);
  // Spanning header cells do not say where one column ends: no handles then.
  const usable = cells.length > 0 && cells.every((c) => c.colSpan <= 1);
  const box = table.getBoundingClientRect();
  const head = table.tHead?.getBoundingClientRect();
  const lastLeft = table.offsetLeft + box.width - 2 * HANDLE_HALF;
  return {
    cols: usable
      ? cells.map((cell, i) => ({
          key: keyOf(cell, i),
          name: (cell.getAttribute("aria-label") ?? cell.textContent ?? "").trim(),
          left: Math.round(
            Math.min(table.offsetLeft + cell.getBoundingClientRect().right - box.left - HANDLE_HALF, lastLeft),
          ),
        }))
      : [],
    top: head ? Math.round(table.offsetTop + head.top - box.top) : 0,
    height: head ? Math.round(head.height) : 0,
    sticky: usable && getComputedStyle(cells[0]!).position === "sticky",
  };
}

const FIXED_CLASS = "tbl-resize__table--fixed";

export function ResizableTable({ tableId, wrapperClassName, className, style, children, ...rest }: ResizableTableProps) {
  const { widths, setWidth } = useColumnWidths(tableId);
  const tableRef = useRef<HTMLTableElement>(null);
  const [head, setHead] = useState<HeadLayout | null>(null);
  // The widths the columns had before the table became fixed, for the columns the user did not resize.
  const [base, setBase] = useState<{ keys: string; widths: Record<string, number> } | null>(null);
  const dragBase = useRef<{ keys: string; widths: Record<string, number> } | null>(null);

  const keys = head ? head.cols.map((c) => c.key) : [];
  const keysJson = JSON.stringify(keys);
  const customized = keys.some((k) => widths[k] !== undefined);
  const fixed = customized && base !== null && base.keys === keysJson;
  const widthOf = (key: string): number | undefined => widths[key] ?? (fixed ? base?.widths[key] : undefined);

  const measureHead = useCallback(() => {
    const table = tableRef.current;
    if (!table) return;
    const next = headLayoutOf(table);
    setHead((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);

  // On mount and when the widths change; later changes of the layout come from the observers below.
  useLayoutEffect(measureHead, [measureHead, fixed, widths, base]);

  // A table with saved widths is first laid out by the browser once (before paint), to learn the widths of the
  // columns the user did not resize.
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!customized || fixed || !table || keysJson === "[]") return;
    const cells = headerCells(table);
    setBase({ keys: keysJson, widths: Object.fromEntries(cells.map((c, i) => [keyOf(c, i), cellWidth(c)])) });
  }, [customized, fixed, keysJson]);

  // A header cell that changes size (content, a wider window) or a header that changes (columns, names) moves the
  // handles; the rows do not (a new row that widens a column widens its header cell too).
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const observers: { disconnect: () => void }[] = [];
    if (typeof ResizeObserver !== "undefined") {
      const sizes = new ResizeObserver(() => measureHead());
      sizes.observe(table);
      for (const cell of headerCells(table)) sizes.observe(cell);
      observers.push(sizes);
    }
    if (typeof MutationObserver !== "undefined" && table.tHead) {
      const header = new MutationObserver(() => measureHead());
      header.observe(table.tHead, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-col", "aria-label", "colspan"] });
      observers.push(header);
    }
    return () => observers.forEach((o) => o.disconnect());
  }, [measureHead, keysJson]);

  const preview = (key: string, px: number) => {
    const table = tableRef.current;
    if (!table) return;
    const cells = headerCells(table);
    const cols = colsOf(table);
    if (!table.classList.contains(FIXED_CLASS)) {
      // The first move of a drag in an auto table: every column keeps the width it has, then the table is fixed.
      const natural = Object.fromEntries(cells.map((c, i) => [keyOf(c, i), cellWidth(c)]));
      cols.forEach((col, i) => {
        col.style.width = `${natural[keys[i] ?? ""] ?? MIN_COLUMN_WIDTH}px`;
      });
      dragBase.current = { keys: keysJson, widths: natural };
      table.classList.add(FIXED_CLASS);
      table.style.tableLayout = "fixed";
    }
    const col = cols[keys.indexOf(key)];
    if (col) col.style.width = `${px}px`;
    const total = cols.reduce((sum, c) => sum + (parseFloat(c.style.width) || MIN_COLUMN_WIDTH), 0);
    table.style.width = `${total}px`;
  };

  const commit = (key: string, px: number | null) => {
    if (px !== null && !fixed && dragBase.current?.keys === keysJson) setBase(dragBase.current);
    dragBase.current = null;
    setWidth(key, px);
  };

  const handles = head
    ? head.cols
        .map((c, i) => ({ ...c, index: i }))
        .filter((c) => c.name !== "")
        .map((c) => ({
          key: c.key,
          name: c.name,
          width: widths[c.key],
          measure: () => cellWidth(tableRef.current ? headerCells(tableRef.current)[c.index] : undefined),
          style: { left: c.left, top: head.sticky ? 0 : head.top, height: head.height },
        }))
    : [];
  const total = fixed ? keys.reduce((sum, k) => sum + (widthOf(k) ?? MIN_COLUMN_WIDTH), 0) : undefined;
  const classes = ["tbl-resize__table", className, fixed ? FIXED_CLASS : undefined].filter(Boolean).join(" ");
  return (
    <div className={`tbl-resize${wrapperClassName ? ` ${wrapperClassName}` : ""}`} onMouseOver={showCutText}>
      {head && handles.length > 0 && (
        <ResizeHandles
          className={`tbl-resize__handles${head.sticky ? " tbl-resize__handles--sticky" : ""}`}
          handleClassName="tbl-resize__handle"
          columns={handles}
          onPreview={preview}
          onCommit={commit}
        />
      )}
      <table
        ref={tableRef}
        className={classes}
        style={fixed ? { ...style, tableLayout: "fixed", width: total } : style}
        {...rest}
      >
        {keys.length > 0 && (
          <colgroup>
            {keys.map((k) => {
              const width = customized ? widthOf(k) : undefined;
              return <col key={k} style={width !== undefined ? { width } : undefined} />;
            })}
          </colgroup>
        )}
        {children}
      </table>
    </div>
  );
}
