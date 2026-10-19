// The handles that resize a table's columns, one on the right edge of each column header.
//
// Mouse: drag a handle (the pointer is captured; the table follows once per frame without a React render of its
// rows), double-click it for the default width.
// Keyboard (a focusable separator per the ARIA window splitter): the handles of a table are one tab stop (a roving
// tabindex, the last one used); ← → narrow or widen the focused column (Shift: larger steps), Home / End the narrowest
// / widest, Enter the default width, Ctrl+← → (⌘ on macOS) move to the previous / next column's handle. Focusing a
// handle announces "Resize column <name>", its width and the keys (`aria-describedby`).
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { clampWidth, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, widthKeyTarget } from "./columnWidths";

export interface ResizeHandleProps {
  /** The column's (translated) name, for "Resize column <name>". */
  name: string;
  /** The user's width of the column, if any. */
  width: number | undefined;
  /** The column's current rendered width, in pixels. Default: the width of the element the handle is in. */
  measure?: () => number;
  /** Shows a width while it is dragged (called at most once per animation frame); not saved. */
  onPreview: (px: number) => void;
  /** The width chosen (clamped px), or `null` = the default width. */
  onCommit: (px: number | null) => void;
  /** 0 for the handle in the tab order, -1 for the others of its table. */
  tabIndex?: number;
  /** Ctrl/⌘ + ← → : move to the previous (-1) or next (1) handle. */
  onStep?: (delta: -1 | 1) => void;
  onFocused?: () => void;
  /** Id of the text that explains the keys. */
  describedBy?: string;
  className?: string;
  style?: CSSProperties;
}

export function ResizeHandle({
  name,
  width,
  measure: measureProp,
  onPreview,
  onCommit,
  tabIndex = 0,
  onStep,
  onFocused,
  describedBy,
  className,
  style,
}: ResizeHandleProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const measure = () =>
    measureProp ? measureProp() : Math.round(ref.current?.parentElement?.getBoundingClientRect().width ?? MIN_COLUMN_WIDTH);
  // Only the handle re-renders for its value: never the table's rows.
  const [now, setNow] = useState(() => width ?? MIN_COLUMN_WIDTH);
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useLayoutEffect(() => {
    setNow(width ?? clampWidth(measureRef.current()));
  }, [width]);
  const drag = useRef<{ pointer: number; startX: number; start: number; latest: number | null; frame: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { pointer: e.pointerId, startX: e.clientX, start: measure(), latest: null, frame: 0 };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    d.latest = clampWidth(d.start + e.clientX - d.startX);
    if (d.frame !== 0) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      if (d.latest !== null) onPreview(d.latest);
    });
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (d.frame !== 0) cancelAnimationFrame(d.frame);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.latest === null) return;
    onPreview(d.latest);
    onCommit(d.latest);
    setNow(d.latest);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey) return;
    if (e.ctrlKey || e.metaKey) {
      if (onStep && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        e.stopPropagation();
        onStep(e.key === "ArrowLeft" ? -1 : 1);
      }
      return;
    }
    const target = widthKeyTarget(e.key, e.shiftKey, width ?? measure());
    if (target === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (target === "reset") {
      onCommit(null);
      return;
    }
    onPreview(target);
    onCommit(target);
    setNow(target);
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("resources:table.resizeColumn", { name })}
      aria-valuenow={now}
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      aria-describedby={describedBy}
      tabIndex={tabIndex}
      className={`col-resize${className ? ` ${className}` : ""}`}
      style={style}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onCommit(null);
      }}
      onFocus={() => {
        setNow(width ?? clampWidth(measure()));
        onFocused?.();
      }}
    />
  );
}

export interface ResizeColumn {
  /** Column id (what the width is saved under). */
  key: string;
  /** The column's (translated) name. */
  name: string;
  /** The user's width, if any. */
  width: number | undefined;
  measure?: () => number;
  /** Position of the handle (when the handles are laid out by the caller). */
  style?: CSSProperties;
}

export interface ResizeHandlesProps {
  columns: readonly ResizeColumn[];
  className: string;
  /** With it each handle sits in a `<div>` of this class (a grid cell); otherwise the handles are placed by `style`. */
  slotClassName?: string;
  handleClassName?: string;
  /** Content before the first handle (e.g. the empty cell of a checkbox column). */
  leading?: ReactNode;
  onPreview: (key: string, px: number) => void;
  onCommit: (key: string, px: number | null) => void;
}

/** The handles of one table: one tab stop, Ctrl/⌘ + ← → between them, a hidden text that explains the keys. */
export function ResizeHandles({
  columns,
  className,
  slotClassName,
  handleClassName,
  leading,
  onPreview,
  onCommit,
}: ResizeHandlesProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [active, setActive] = useState<string | null>(null);
  const current = columns.some((c) => c.key === active) ? active : (columns[0]?.key ?? null);
  const step = (index: number, delta: -1 | 1) => {
    const next = Math.max(0, Math.min(columns.length - 1, index + delta));
    ref.current?.querySelectorAll<HTMLElement>("[role='separator']")[next]?.focus();
  };
  return (
    <div ref={ref} className={className}>
      {leading}
      {columns.map((c, i) => {
        const handle = (
          <ResizeHandle
            key={c.key}
            name={c.name}
            width={c.width}
            measure={c.measure}
            onPreview={(px) => onPreview(c.key, px)}
            onCommit={(px) => onCommit(c.key, px)}
            tabIndex={c.key === current ? 0 : -1}
            onStep={(delta) => step(i, delta)}
            onFocused={() => setActive(c.key)}
            describedBy={hintId}
            className={handleClassName}
            style={c.style}
          />
        );
        return slotClassName ? (
          <div key={c.key} className={slotClassName}>
            {handle}
          </div>
        ) : (
          handle
        );
      })}
      <span id={hintId} className="visually-hidden">
        {t("resources:table.resizeHint")}
      </span>
    </div>
  );
}
