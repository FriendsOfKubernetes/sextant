// Charts of the Ceph mgr's metrics, read through the manifest's metric queries (`health`, `capacity`, `osds`, `pgs`;
// the metric names of Ceph's mgr/prometheus module, src/pybind/mgr/prometheus/module.py). Drawn as plain SVG.
import type { MetricAnswer } from "@sextant/extension-sdk";
import { element } from "./dom";
import { i18n, t } from "./i18n";

export interface RangeChoice {
  id: string;
  minutes: number;
  step: string;
}

/** The ranges offered (labelled `chart.range.<id>`); each stays under the queries' `range.maxHours` (168) and
 * Sextant's 1500 points. */
export const RANGES: readonly RangeChoice[] = [
  { id: "1h", minutes: 60, step: "1m" },
  { id: "6h", minutes: 360, step: "5m" },
  { id: "24h", minutes: 1440, step: "15m" },
  { id: "7d", minutes: 10080, step: "1h" },
];

export type Point = [number, number | null];

export interface Line {
  /** What the series is: `total`, `used`, `up`, `degraded`, … */
  id: string;
  /** Its name in the UI language (`chart.series.<id>`). */
  name: string;
  points: Point[];
}

/** The answer's series as lines: the label `by` names each (`ids` maps its value to a line id), in `order` of ids. */
export function linesOf(answer: MetricAnswer, by: string, ids: Record<string, string>, order: readonly string[]): Line[] {
  const lines: Line[] = [];
  for (const series of answer.series) {
    const id = ids[series.labels[by] ?? ""];
    if (id === undefined) continue;
    lines.push({ id, name: t(`chart.series.${id}`), points: series.points });
  }
  return lines.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export const CAPACITY_IDS: Record<string, string> = {
  ceph_cluster_total_bytes: "total",
  ceph_cluster_total_used_raw_bytes: "used",
};
export const OSD_IDS: Record<string, string> = { total: "inCluster", in: "in", up: "up" };
export const PG_IDS: Record<string, string> = Object.fromEntries(
  [
    "total",
    "active",
    "clean",
    "degraded",
    "undersized",
    "down",
    "stale",
    "peering",
    "incomplete",
    "inconsistent",
    "recovering",
    "backfilling",
    "remapped",
  ].map((state) => [`ceph_pg_${state}`, state]),
);
/** Total, active and clean are always drawn; the other states only when some point is above zero. */
const PG_ALWAYS = new Set(["total", "active", "clean"]);

export function pgLines(answer: MetricAnswer): Line[] {
  return linesOf(answer, "__name__", PG_IDS, Object.values(PG_IDS)).filter(
    (line) => PG_ALWAYS.has(line.id) || line.points.some(([, v]) => v !== null && v > 0),
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
    return t("chart.latest", { name: line.name, value: value === null ? t("chart.noData") : options.format(value) });
  });
  const svg = svgNode("svg", {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    role: "img",
    "aria-label": t("chart.label", { title: options.title, values: i18n().formatList(latest) }),
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
