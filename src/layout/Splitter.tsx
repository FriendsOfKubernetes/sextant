import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export interface SplitterProps {
  orientation: "vertical" | "horizontal";
  /** Already translated accessible name. */
  label: string;
  /** Current size of the panel the splitter resizes. */
  value: number;
  min: number;
  max: number;
  /**
   * Called with the new size. `direction` tells how pointer movement maps to size:
   * +1 — size grows when the pointer moves right/down (a sidebar), −1 — when it moves left/up (a dock).
   */
  onResize: (size: number) => void;
  direction: 1 | -1;
}

const KEY_STEP = 16;

/** Drag handle between two zones; also adjustable with arrow keys. */
export function Splitter({ orientation, label, value, min, max, onResize, direction }: SplitterProps) {
  const drag = useRef<{ start: number; size: number } | null>(null);
  const axis = (e: { clientX: number; clientY: number }) => (orientation === "vertical" ? e.clientX : e.clientY);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag.current = { start: axis(e), size: value };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.body.classList.add(orientation === "vertical" ? "resizing-x" : "resizing-y");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(drag.current.size + direction * (axis(e) - drag.current.start));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.body.classList.remove("resizing-x", "resizing-y");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = orientation === "vertical" ? "ArrowRight" : direction === 1 ? "ArrowDown" : "ArrowUp";
    const shrink = orientation === "vertical" ? "ArrowLeft" : direction === 1 ? "ArrowUp" : "ArrowDown";
    if (e.key === grow) onResize(value + KEY_STEP);
    else if (e.key === shrink) onResize(value - KEY_STEP);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`splitter splitter--${orientation}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
