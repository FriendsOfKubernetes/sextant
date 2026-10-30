// Charts of the Ceph mgr's metrics, read through the manifest's metric queries (`health`, `capacity`, `osds`, `pgs`;
// the metric names of Ceph's mgr/prometheus module, src/pybind/mgr/prometheus/module.py). Drawn as plain SVG.
import type { MetricAnswer } from "@sextant/extension-sdk";
import { element } from "./dom";

export interface RangeChoice {
  id: string;
  label: string;
  minutes: number;
  step: string;
}

/** The ranges offered; each stays under the queries' `range.maxHours` (168) and Sextant's 1500 points. */
export const RANGES: readonly RangeChoice[] = [
  { id: "1h", label: "1 hour", minutes: 60, step: "1m" },
  { id: "6h", label: "6 hours", minutes: 360, step: "5m" },
  { id: "24h", label: "24 hours", minutes: 1440, step: "15m" },
  { id: "7d", label: "7 days", minutes: 10080, step: "1h" },
];

export type Point = [number, number | null];

export interface Line {
  name: string;
  points: Point[];
}

/** The answer's series, named by the label `by` (or `fallback` for a series without it), in `order`. */
export function linesOf(answer: MetricAnswer, by: string, names: Record<string, string>, order: readonly string[]): Line[] {
  const lines: Line[] = [];
  for (const series of answer.series) {
    const key = series.labels[by] ?? "";
    const name = names[key];
    if (name === undefined) continue;
    lines.push({ name, points: series.points });
  }
  return lines.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

export const CAPACITY_NAMES: Record<string, string> = {
  ceph_cluster_total_bytes: "Total",
  ceph_cluster_total_used_raw_bytes: "Used",
};
export const OSD_NAMES: Record<string, string> = { total: "In the cluster", in: "In", up: "Up" };
export const PG_NAMES: Record<string, string> = {
  ceph_pg_total: "Total",
  ceph_pg_active: "Active",
  ceph_pg_clean: "Clean",
  ceph_pg_degraded: "Degraded",
  ceph_pg_undersized: "Undersized",
  ceph_pg_down: "Down",
  ceph_pg_stale: "Stale",
  ceph_pg_peering: "Peering",
  ceph_pg_incomplete: "Incomplete",
  ceph_pg_inconsistent: "Inconsistent",
  ceph_pg_recovering: "Recovering",
  ceph_pg_backfilling: "Backfilling",
  ceph_pg_remapped: "Remapped",
};
/** Total, active and clean are always drawn; the other states only when some point is above zero. */
const PG_ALWAYS = new Set(["Total", "Active", "Clean"]);

export function pgLines(answer: MetricAnswer): Line[] {
  return linesOf(answer, "__name__", PG_NAMES, Object.values(PG_NAMES)).filter(
    (line) => PG_ALWAYS.has(line.name) || line.points.some(([, v]) => v !== null && v > 0),
  );
}

export function lastValue(line: Line): number | null {
  for (let i = line.points.length - 1; i >= 0; i--) {
    const value = line.points[i]![1];
    if (value !== null) return value;
  }
  return null;
}

export interface ChartOptions {
  title: string;
  lines: Line[];
  format: (value: number) => string;
  /** Fixed bounds of the value axis (otherwise from 0 to the largest value). */
  min?: number;
  max?: number;
  /** Labels of the value axis' bounds, instead of formatted values. */
  minLabel?: string;
  maxLabel?: string;
  /** The time span drawn (unix seconds), so lines with gaps keep their place. */
  from: number;
  to: number;
  timeLabel: (seconds: number) => string;
}

const WIDTH = 600;
const HEIGHT = 140;
const PAD = { left: 64, right: 8, top: 8, bottom: 20 };
const SVG = "http://www.w3.org/2000/svg";

function svgNode(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * A line chart in a `<figure>`: the SVG is one image whose label gives every line's last value, and the legend
 * repeats them as text, so nothing is said by colour alone.
 */
export function lineChart(options: ChartOptions): HTMLElement {
  const values = options.lines.flatMap((l) => l.points.map(([, v]) => v)).filter((v): v is number => v !== null);
  const min = options.min ?? 0;
  const max = Math.max(options.max ?? Math.max(...values, 0), min + Number.EPSILON);
  const spanX = Math.max(options.to - options.from, 1);
  const x = (t: number) => PAD.left + ((t - options.from) / spanX) * (WIDTH - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * (HEIGHT - PAD.top - PAD.bottom);

  const latest = options.lines.map((line) => {
    const value = lastValue(line);
    return `${line.name} ${value === null ? "no data" : options.format(value)}`;
  });
  const svg = svgNode("svg", {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    role: "img",
    "aria-label": `${options.title}: ${latest.join(", ")}`,
    preserveAspectRatio: "none",
    class: "chart",
  });
  const axis = (value: number, text: string) => {
    svg.append(svgNode("line", { x1: PAD.left, x2: WIDTH - PAD.right, y1: y(value), y2: y(value), class: "grid" }));
    const label = svgNode("text", { x: PAD.left - 6, y: y(value) + 4, "text-anchor": "end", class: "axis" });
    label.textContent = text;
    svg.append(label);
  };
  axis(max, options.maxLabel ?? options.format(max));
  axis(min, options.minLabel ?? options.format(min));
  for (const [t, anchor] of [
    [options.from, "start"],
    [options.to, "end"],
  ] as const) {
    const label = svgNode("text", { x: x(t), y: HEIGHT - 4, "text-anchor": anchor, class: "axis" });
    label.textContent = options.timeLabel(t);
    svg.append(label);
  }
  options.lines.forEach((line, index) => {
    // A gap (a missing or non-finite point) breaks the line.
    let d = "";
    let pen = false;
    for (const [t, v] of line.points) {
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    if (d) svg.append(svgNode("path", { d, class: `line s${index % 6}`, "vector-effect": "non-scaling-stroke" }));
  });

  const legend = element(
    "ul",
    { className: "legend" },
    ...options.lines.map((_line, index) => {
      const swatch = element("span", { className: `swatch s${index % 6}` });
      swatch.setAttribute("aria-hidden", "true");
      return element("li", {}, swatch, latest[index]!);
    }),
  );
  return element("figure", { className: "chart-figure" }, element("figcaption", { textContent: options.title }), svg, legend);
}
