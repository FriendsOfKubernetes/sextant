// The "Metrics" tab of a CephCluster: charts of the Ceph mgr's metrics through the manifest's metric queries, with
// `namespace` = the cluster's namespace (the label Prometheus gives the targets of Rook's ServiceMonitor). Read again
// every minute while the tab is shown.
import { isSextantError, type MetricAnswer, type Sextant } from "@sextant/extension-sdk";
import { CAPACITY_NAMES, lineChart, linesOf, OSD_NAMES, pgLines, RANGES, type Line, type RangeChoice } from "./charts";
import { element, errorText, formatBytes, formatTime } from "./dom";

export const REFRESH_MS = 60_000;
const RANGE_KEY = "metricsRange";

export type QueryId = "health" | "capacity" | "osds" | "pgs";
const QUERIES: readonly QueryId[] = ["health", "capacity", "osds", "pgs"];

type Answers = Record<QueryId, MetricAnswer | { error: unknown }>;

function chartOf(id: QueryId, answer: MetricAnswer, range: RangeChoice, now: number, language: string): HTMLElement | null {
  const to = Math.floor(now / 1000);
  const from = to - range.minutes * 60;
  const timeLabel = (s: number) => formatTime(s * 1000, language);
  const count = (v: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(v);
  let lines: Line[];
  switch (id) {
    case "health":
      lines = answer.series.slice(0, 1).map((s) => ({ name: "Health", points: s.points }));
      if (!lines.length) return null;
      return lineChart({
        title: "Ceph health",
        lines,
        format: (v) => (v >= 2 ? "HEALTH_ERR" : v >= 1 ? "HEALTH_WARN" : "HEALTH_OK"),
        min: 0,
        max: 2,
        minLabel: "OK",
        maxLabel: "ERR",
        from,
        to,
        timeLabel,
      });
    case "capacity":
      lines = linesOf(answer, "__name__", CAPACITY_NAMES, ["Total", "Used"]);
      if (!lines.length) return null;
      return lineChart({ title: "Raw capacity", lines, format: (v) => formatBytes(v, language), from, to, timeLabel });
    case "osds":
      lines = linesOf(answer, "state", OSD_NAMES, ["In the cluster", "In", "Up"]);
      if (!lines.length) return null;
      return lineChart({ title: "OSDs", lines, format: count, from, to, timeLabel });
    case "pgs":
      lines = pgLines(answer);
      if (!lines.length) return null;
      return lineChart({ title: "Placement groups", lines, format: count, from, to, timeLabel });
  }
}

/** Why there is no chart: no source, a query the user did not agree to, or no Ceph series. */
export function whyNoCharts(answers: Answers, namespace: string): string | null {
  const errors = QUERIES.map((id) => answers[id]).filter((a): a is { error: unknown } => "error" in a);
  if (errors.some((e) => isSextantError(e.error, "notFound"))) {
    return "This cluster has no Prometheus-compatible source for Sextant (none was found, or it is turned off in the cluster's settings, Metrics tab).";
  }
  if (errors.length === QUERIES.length) return errorText(errors[0]!.error);
  const empty = QUERIES.every((id) => {
    const answer = answers[id];
    return "error" in answer || answer.series.length === 0;
  });
  if (empty) {
    return `The Prometheus-compatible source has no Ceph metrics with namespace="${namespace}". Rook's CephCluster sets them up with spec.monitoring.enabled and the Prometheus Operator's ServiceMonitor for the mgr.`;
  }
  return null;
}

export function startMetrics(sextant: Sextant, root: HTMLElement): () => void {
  const namespace = sextant.context.selection[0]?.namespace;
  if (!namespace) {
    root.replaceChildren(element("p", { className: "muted", textContent: "No CephCluster." }));
    return () => undefined;
  }
  let range = RANGES[2]!;
  let reading = 0;
  let stopped = false;
  const charts = element("div", { className: "charts" }, element("p", { className: "muted", textContent: "Loading…" }));
  const picker = element("div", { className: "range" });
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Time range");
  const drawPicker = () =>
    picker.replaceChildren(
      ...RANGES.map((choice) => {
        const button = element("button", { type: "button", textContent: choice.label });
        button.setAttribute("aria-pressed", String(choice.id === range.id));
        button.addEventListener("click", () => {
          range = choice;
          void sextant.storage.set(RANGE_KEY, choice.id).catch(() => undefined);
          drawPicker();
          void read();
        });
        return button;
      }),
    );

  const read = async () => {
    const attempt = ++reading;
    const answers = Object.fromEntries(
      await Promise.all(
        QUERIES.map(async (id) => {
          try {
            const answer = await sextant.metrics.query({
              id,
              params: { namespace },
              range: { minutes: range.minutes, step: range.step },
            });
            return [id, answer] as const;
          } catch (error) {
            return [id, { error }] as const;
          }
        }),
      ),
    ) as Answers;
    if (stopped || attempt !== reading) return;
    const why = whyNoCharts(answers, namespace);
    if (why) {
      charts.replaceChildren(element("p", { className: "muted", textContent: why }));
      return;
    }
    const now = Date.now();
    charts.replaceChildren(
      ...QUERIES.flatMap((id) => {
        const answer = answers[id];
        if ("error" in answer) return [element("p", { className: "error", textContent: `${id}: ${errorText(answer.error)}` })];
        const chart = chartOf(id, answer, range, now, sextant.context.language);
        return chart ? [chart] : [];
      }),
    );
  };

  root.replaceChildren(picker, charts);
  void sextant.storage
    .get(RANGE_KEY)
    .catch(() => null)
    .then((stored) => {
      range = RANGES.find((r) => r.id === stored) ?? range;
      drawPicker();
      void read();
    });
  const timer = setInterval(() => void read(), REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
