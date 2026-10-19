// One time series drawn with uPlot. uPlot is loaded on first use (it needs a real browser: canvas, matchMedia);
// without one the figure still shows its title and the latest value.
import { useEffect, useRef } from "react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface ChartProps {
  /** Already translated. */
  title: string;
  points: [number, number][];
  format: (value: number) => string;
  /** Line color: a theme token (`--color-chart-cpu`, read when drawn) or `#rrggbb` (canvas does not resolve CSS variables). */
  color: string;
  height?: number;
}

function canDraw(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

/** A theme token's current value (axes follow the light/dark theme). */
function token(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function Chart({ title, points, format, color, height = 120 }: ChartProps) {
  const holder = useRef<HTMLDivElement>(null);
  const last = points.length > 0 ? points[points.length - 1]![1] : undefined;

  useEffect(() => {
    const el = holder.current;
    if (!el || !canDraw()) return;
    let plot: uPlot | null = null;
    let observer: ResizeObserver | null = null;
    let cancelled = false;
    void import("uplot").then(({ default: UPlot }) => {
      if (cancelled) return;
      const width = () => Math.max(el.clientWidth, 200);
      const muted = token("--color-text-muted", "#59636e");
      const grid = token("--color-border", "#d6d9de");
      // A theme token (`--color-chart-cpu`) or a colour; a token is read for the current theme.
      const line = color.startsWith("--") ? token(color, "#3d90ce") : color;
      const options: uPlot.Options = {
        width: width(),
        height,
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: true }, y: { range: (_u, min, max) => [Math.min(0, min), max > 0 ? max * 1.1 : 1] } },
        axes: [
          { stroke: muted, grid: { stroke: grid, width: 1 } },
          {
            stroke: muted,
            grid: { stroke: grid, width: 1 },
            size: 64,
            values: (_u, splits) => splits.map((v) => format(v)),
          },
        ],
        series: [{}, { label: title, stroke: line, width: 1.5, fill: `${line}26` }],
      };
      const data: uPlot.AlignedData = [points.map((p) => p[0]), points.map((p) => p[1])];
      plot = new UPlot(options, data, el);
      if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver(() => plot?.setSize({ width: width(), height }));
        observer.observe(el);
      }
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      plot?.destroy();
    };
  }, [points, format, color, height, title]);

  return (
    <figure className="mx-chart" aria-label={title}>
      <figcaption className="mx-chart__head">
        <span className="mx-chart__title">{title}</span>
        {last !== undefined && <span className="mx-chart__value">{format(last)}</span>}
      </figcaption>
      <div className="mx-chart__plot" ref={holder} style={{ minHeight: height }} />
    </figure>
  );
}
