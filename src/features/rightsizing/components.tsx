// Pieces shared by the right-sizing page and the details section: the rows table, the source note, the copy button.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { HistoryWindow } from "../../api";
import { useAppStore } from "../../app/store";
import { Badge, Button, ErrorState, type BadgeTone } from "../../components";
import { dotSeparator } from "../../i18n";
import { formatBytes, formatCpu } from "../metrics/format";
import { OOM_RECENT_MS, rowWaste, workloadObjectRef, type RightsizingRow } from "./group";
import { MAX_HISTORY_CONTAINERS, type RightsizingSource } from "./hooks";
import {
  FLAG_SEVERITY,
  MIN_HISTORY_SECS,
  NEAR_LIMIT_SHARE,
  OVER_PROVISIONED_FACTOR,
  type Flag,
  type FlagSeverity,
} from "./recommend";
import { resourcesYaml } from "./yaml";
import { ResizableTable } from "../../components/Table";

type T = (key: string, options?: Record<string, unknown>) => string;

const CPU = "cpu";
const MEMORY = "memory";

const TONES: Record<FlagSeverity, BadgeTone> = { risk: "danger", waste: "warning", missing: "info", info: "neutral" };

export function isRiskRow(row: RightsizingRow): boolean {
  return row.assessment.flags.some((f) => FLAG_SEVERITY[f] === "risk");
}

/** Rows worth a look: any finding but the informational ones. */
export function hasFindings(row: RightsizingRow): boolean {
  return row.assessment.flags.some((f) => FLAG_SEVERITY[f] !== "info");
}

/** "3 hours", "2 days" (whole units, rounded down, at least a minute). */
export function durationText(t: T, seconds: number): string {
  if (seconds < 3600) return t("rightsizing:duration.minutes", { count: Math.max(1, Math.floor(seconds / 60)) });
  if (seconds < 48 * 3600) return t("rightsizing:duration.hours", { count: Math.floor(seconds / 3600) });
  return t("rightsizing:duration.days", { count: Math.floor(seconds / 86_400) });
}

function percentText(language: string, ratio: number): string {
  return new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 }).format(ratio);
}

/** Where the usage comes from and how much of it there is. */
export function SourceNote({ source, window }: { source: RightsizingSource; window: HistoryWindow }) {
  const { t } = useTranslation();
  let text: string;
  if (source.mode === undefined || source.loading) text = t("rightsizing:source.loading");
  else if (source.mode === "history" && source.data.kind === "history")
    text = t(`rightsizing:source.history.${window}`);
  else if (source.mode === "snapshot")
    text = source.error
      ? t("rightsizing:source.snapshotAfterError")
      : t("rightsizing:source.snapshot", { source: t("rightsizing:source.metricsServer") });
  else text = t("rightsizing:source.none");
  return (
    <>
      <p className="rs-note" role="status">
        {text}
      </p>
      {source.error && source.mode !== "snapshot" && (
        <ErrorState className="rs-error" title={t("rightsizing:source.historyFailed")} error={source.error} />
      )}
      {source.data.kind === "history" && !source.data.history.coverageKnown && (
        <p className="rs-note rs-note--warning">{t("rightsizing:source.coverageUnknown")}</p>
      )}
      {source.truncated && (
        <p className="rs-note rs-note--warning">{t("rightsizing:source.truncated", { count: MAX_HISTORY_CONTAINERS })}</p>
      )}
    </>
  );
}

function CopyButton({ row }: { row: RightsizingRow }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const rec = row.assessment.recommendation;
  const copy = async () => {
    if (!rec) return;
    try {
      await navigator.clipboard.writeText(resourcesYaml(rec));
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  const label = t("rightsizing:copy");
  return (
    <span className="rs-copy">
      <Button
        size="compact"
        icon="copy"
        iconOnly
        label={label}
        disabled={!rec}
        onClick={() => void copy()}
      />
      {state !== "idle" && (
        <span className="rs-copy__state" role="status">
          {state === "copied" ? t("rightsizing:copied") : t("rightsizing:copyFailed")}
        </span>
      )}
    </span>
  );
}

function FlagBadges({ row }: { row: RightsizingRow }) {
  const { t, i18n } = useTranslation();
  const hints = {
    percent: percentText(i18n.language, row.usage?.kind === "history" ? (row.usage.throttledRatio ?? 0) : 0),
    share: percentText(i18n.language, NEAR_LIMIT_SHARE),
  };
  // The number a hint's noun agrees with ("2 times", "7 days"): the plural forms of the hint follow it.
  const counts: Partial<Record<Flag, number>> = {
    cpuOverProvisioned: OVER_PROVISIONED_FACTOR,
    memoryOverProvisioned: OVER_PROVISIONED_FACTOR,
    oomKilled: Math.round(OOM_RECENT_MS / 86_400_000),
  };
  return (
    <span className="rs-flags">
      {row.assessment.flags.map((flag: Flag) => (
        <span key={flag} title={t(`rightsizing:flagHints.${flag}`, counts[flag] === undefined ? hints : { ...hints, count: counts[flag] })} data-flag={flag}>
          <Badge tone={TONES[FLAG_SEVERITY[flag]]}>{t(`rightsizing:flags.${flag}`)}</Badge>
        </span>
      ))}
    </span>
  );
}

function ConfidenceNote({ row, window }: { row: RightsizingRow; window: HistoryWindow }) {
  const { t } = useTranslation();
  const { confidence } = row.assessment;
  const usage = row.usage;
  if (confidence === "history") return null;
  let text: string;
  if (confidence === "partialHistory" && usage?.kind === "history" && usage.coverageSecs !== undefined)
    text = t("rightsizing:confidence.partialHistory", { duration: durationText(t, usage.coverageSecs) });
  else if (confidence === "unknownHistory") text = t("rightsizing:confidence.unknownHistory");
  else if (confidence === "insufficientHistory" && usage?.kind === "history" && usage.coverageSecs !== undefined)
    text = t(`rightsizing:confidence.insufficientHistory.${window}`, {
      duration: durationText(t, usage.coverageSecs),
      minimum: durationText(t, MIN_HISTORY_SECS),
    });
  else if (confidence === "snapshot") text = t("rightsizing:confidence.snapshot");
  else text = t("rightsizing:confidence.noData");
  return <div className="rs-confidence">{text}</div>;
}

function Amounts({
  request,
  limit,
  used,
  recommended,
  recommendedLimit,
  format,
}: {
  request?: number;
  limit?: number;
  used: string[];
  recommended?: number;
  recommendedLimit?: number;
  format: (v: number) => string;
}) {
  const { t } = useTranslation();
  const notSet = t("rightsizing:amounts.notSet");
  const separator = dotSeparator();
  const spec = [
    t("rightsizing:amounts.request", { value: request === undefined ? notSet : format(request) }),
    t("rightsizing:amounts.limit", { value: limit === undefined ? notSet : format(limit) }),
  ].join(separator);
  const advice =
    recommended === undefined
      ? undefined
      : [
          t("rightsizing:amounts.recommended", { value: format(recommended) }),
          ...(recommendedLimit === undefined
            ? []
            : [t("rightsizing:amounts.recommendedLimit", { value: format(recommendedLimit) })]),
        ].join(separator);
  return (
    <div className="rs-amounts">
      <div>{spec}</div>
      {used.length > 0 && <div className="rs-amounts__used">{used.join(separator)}</div>}
      {advice && <div className="rs-amounts__recommended">{advice}</div>}
    </div>
  );
}

function usedTexts(t: T, row: RightsizingRow, resource: "cpu" | "memory"): string[] {
  const u = row.usage;
  const format = resource === "cpu" ? formatCpu : formatBytes;
  if (!u) return [];
  if (u.kind === "snapshot") {
    const now = resource === "cpu" ? u.cpuNow : u.memoryNow;
    return now === undefined ? [] : [t("rightsizing:amounts.now", { value: format(now) })];
  }
  const out: string[] = [];
  if (resource === "cpu") {
    if (u.cpuP95 !== undefined) out.push(t("rightsizing:amounts.p95", { value: format(u.cpuP95) }));
  } else if (u.memoryMax !== undefined) out.push(t("rightsizing:amounts.peak", { value: format(u.memoryMax) }));
  return out;
}

/** The rows as a table; `showWorkload` false leaves out the workload column (details of one workload). */
export function RowsTable({
  rows,
  window,
  showWorkload,
}: {
  rows: RightsizingRow[];
  window: HistoryWindow;
  showWorkload: boolean;
}) {
  const { t } = useTranslation();
  const openDetails = useAppStore((s) => s.openDetails);
  // Column keys (not translated): the saved widths follow the column when "Workload" comes and goes.
  const head: { key: string; label: ReactNode }[] = [
    ...(showWorkload ? [{ key: "workload", label: t("rightsizing:columns.workload") }] : []),
    { key: "container", label: t("rightsizing:columns.container") },
    { key: "replicas", label: t("rightsizing:columns.replicas") },
    { key: "cpu", label: t("rightsizing:columns.cpu") },
    { key: "memory", label: t("rightsizing:columns.memory") },
    { key: "findings", label: t("rightsizing:columns.findings") },
    { key: "actions", label: t("rightsizing:columns.actions") },
  ];
  return (
    <div className="rs-table-wrap">
      <ResizableTable tableId="rightsizing" className="rs-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h.key} scope="col" data-col={h.key}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rec = row.assessment.recommendation;
            const w = row.workload;
            const waste = rowWaste(row);
            const cpuUsed = usedTexts(t, row, CPU);
            const memoryUsed = usedTexts(t, row, MEMORY);
            return (
              <tr key={`${w.kind}/${w.name}/${row.container}`} data-waste-cpu={waste.cpu} data-waste-memory={waste.memory}>
                {showWorkload && (
                  <td>
                    <button
                      type="button"
                      className="rt-link"
                      aria-label={t("resources:table.openObject", { kind: w.kind, name: w.name })}
                      onClick={() => openDetails(workloadObjectRef(w))}
                    >
                      {t("rightsizing:workload", { kind: w.kind, name: w.name })}
                    </button>
                  </td>
                )}
                <td>
                  {row.container}
                  <ConfidenceNote row={row} window={window} />
                </td>
                <td>{row.replicas}</td>
                <td>
                  <Amounts
                    request={row.amounts.cpu.request}
                    limit={row.amounts.cpu.limit}
                    used={cpuUsed}
                    recommended={rec?.cpuRequest}
                    recommendedLimit={rec?.cpuLimit}
                    format={formatCpu}
                  />
                </td>
                <td>
                  <Amounts
                    request={row.amounts.memory.request}
                    limit={row.amounts.memory.limit}
                    used={memoryUsed}
                    recommended={rec?.memoryRequest}
                    recommendedLimit={rec?.memoryLimit}
                    format={formatBytes}
                  />
                </td>
                <td>
                  <FlagBadges row={row} />
                </td>
                <td>
                  <CopyButton row={row} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </ResizableTable>
    </div>
  );
}
