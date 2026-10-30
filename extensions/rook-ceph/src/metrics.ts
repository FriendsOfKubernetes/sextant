// The "Metrics" tab of a CephCluster: charts of the Ceph mgr's metrics through the manifest's metric queries, with
// `namespace` = the cluster's namespace (the label Prometheus gives the targets of Rook's ServiceMonitor). Read again
// every minute while the tab is shown.
import { isSextantError, type MetricAnswer, type Sextant } from "@sextant/extension-sdk";
import { CAPACITY_IDS, lineChart, linesOf, OSD_IDS, pgLines, RANGES, type Line, type RangeChoice } from "./charts";
import { element, errorText, formatBytes, formatTime } from "./dom";
import { i18n, t } from "./i18n";

export const REFRESH_MS = 60_000;
const RANGE_KEY = "metricsRange";

export type QueryId = "health" | "capacity" | "osds" | "pgs";
const QUERIES: readonly QueryId[] = ["health", "capacity", "osds", "pgs"];

type Answers = Record<QueryId, MetricAnswer | { error: unknown }>;

function chartOf(id: QueryId, answer: MetricAnswer, range: RangeChoice, now: number): HTMLElement | null {
  const to = Math.floor(now / 1000);
  const from = to - range.minutes * 60;
  const timeLabel = (s: number) => formatTime(s * 1000);
  const count = (v: number) => i18n().formatNumber(v, { maximumFractionDigits: 0 });
  let lines: Line[];
  switch (id) {
    case "health":
      lines = answer.series.slice(0, 1).map((s) => ({ id: "health", name: t("chart.series.health"), points: s.points }));
      if (!lines.length) return null;
      return lineChart({
        title: t("chart.health"),
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
      lines = linesOf(answer, "__name__", CAPACITY_IDS, ["total", "used"]);
      if (!lines.length) return null;
      return lineChart({ title: t("chart.capacity"), lines, format: formatBytes, from, to, timeLabel });
    case "osds":
      lines = linesOf(answer, "state", OSD_IDS, ["inCluster", "in", "up"]);
      if (!lines.length) return null;
      return lineChart({ title: t("chart.osds"), lines, format: count, from, to, timeLabel });
    case "pgs":
      lines = pgLines(answer);
      if (!lines.length) return null;
      return lineChart({ title: t("chart.pgs"), lines, format: count, from, to, timeLabel });
  }
}

/** Why there is no chart: no source, a query the user did not agree to, or no Ceph series. */
export function whyNoCharts(answers: Answers, namespace: string): string | null {
  const errors = QUERIES.map((id) => answers[id]).filter((a): a is { error: unknown } => "error" in a);
  if (errors.some((e) => isSextantError(e.error, "notFound"))) {
    return t("metrics.noSource");
  }
  if (errors.length === QUERIES.length) return errorText(errors[0]!.error);
  const empty = QUERIES.every((id) => {
    const answer = answers[id];
    return "error" in answer || answer.series.length === 0;
  });
  if (empty) {
    return t("metrics.noSeries", { namespace });
  }
  return null;
}

export function startMetrics(sextant: Sextant, root: HTMLElement): () => void {
  const namespace = sextant.context.selection[0]?.namespace;
  if (!namespace) {
    root.replaceChildren(element("p", { className: "muted", textContent: t("common.noCluster") }));
    return () => undefined;
  }
  let range = RANGES[2]!;
  let reading = 0;
  let stopped = false;
  const charts = element("div", { className: "charts" }, element("p", { className: "muted", textContent: t("common.loading") }));
  const picker = element("div", { className: "range" });
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", t("chart.timeRange"));
  const drawPicker = () =>
    picker.replaceChildren(
      ...RANGES.map((choice) => {
        const button = element("button", { type: "button", textContent: t(`chart.range.${choice.id}`) });
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
        if ("error" in answer) return [element("p", { className: "error", textContent: t("metrics.queryFailed", { query: id, message: errorText(answer.error) }) })];
        const chart = chartOf(id, answer, range, now);
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
