// The dock tab with a pod's logs: toolbar (container, follow, timestamps, previous, wrap, search, save) and a
// virtualized list of the buffered lines. A `MultiLogsPayload` gets the merged logs of several pods (multi/).
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useCssLength } from "../../app/accessibility";
import { api, toApiError, type ClusterId, type LogOptions, type LokiRange, type ObjectRef } from "../../api";
import { Button, Checkbox, ErrorState, Icon } from "../../components";
import type { DockTabProps } from "../../layout/dock/registry";
import { LOG_BUFFER_LIMIT, LOG_BUFFER_TEXT_LIMIT } from "./buffer";
import { LogAnnouncer } from "./LogAnnouncer";
import { useLokiRead } from "./loki/hooks";
import { LokiBar } from "./loki/LokiBar";
import { useLokiLines } from "./loki/lines";
import { MAX_LOKI_LINES } from "./loki/model";
import { MultiLogsTab } from "./multi/MultiLogsTab";
import { isMultiLogsPayload } from "./multi/open";
import { logText, type TextRange } from "./LogText";
import { findMatches, MatchIndex, MAX_MATCHES, matchRanges } from "./search";
import { useLogStream } from "./useLogStream";
import { LogViewControls, useFollowScroll } from "./view";
import { useLogView } from "./viewSettings";

export interface LogContainer {
  name: string;
  init: boolean;
}

/** `DockTab.payload` of a logs tab. */
export interface LogsPayload {
  clusterId: ClusterId;
  pod: ObjectRef;
  containers: LogContainer[];
  /** Container shown first; the first regular one when absent. */
  container?: string;
  /** Only lines from Loki over this period (a pod that is gone, opened from a workload's details): no live stream. */
  loki?: { range: LokiRange };
}

/** Lines requested from the pod before following. */
const INITIAL_TAIL_LINES = 1000;
/** A line's height at the default text size; the list measures `--log-line-height` (logs.css, in rem). */
const LINE_HEIGHT = 18;

/** The "logs" dock tab: one pod's logs, or the merged logs of several pods (`MultiLogsPayload`). */
export function LogsTab(props: DockTabProps) {
  return isMultiLogsPayload(props.tab.payload) ? <MultiLogsTab {...props} /> : <PodLogsTab {...props} />;
}

function PodLogsTab({ tab, active }: DockTabProps) {
  const { t } = useTranslation();
  const { clusterId, pod, containers, container: preferred, loki: lokiOnly } = tab.payload as LogsPayload;
  const [container, setContainer] = useState(
    () => preferred ?? containers.find((c) => !c.init)?.name ?? containers[0]?.name ?? "",
  );
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [previous, setPrevious] = useState(false);
  const view = useLogView();
  const { wrap, colours } = view;
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [saveError, setSaveError] = useState<unknown>(null);

  const options: LogOptions = { container, follow, previous, timestamps, tailLines: INITIAL_TAIL_LINES };
  const stream = useLogStream(clusterId, pod, options, !lokiOnly);
  const { lines, dropped } = stream.buffer;

  // ---- lines from Loki (#265): older than the live ones, shown before them ----
  const read = useLokiRead();
  const { load: loadLoki, clear: clearLoki } = read;
  const lokiStart = lokiOnly?.range.startMs;
  const lokiEnd = lokiOnly?.range.endMs;
  useEffect(() => {
    // Lines of another container or run are not the ones shown: a tab of a gone pod reads again, another one forgets.
    if (lokiStart === undefined || lokiEnd === undefined) {
      clearLoki();
      return;
    }
    loadLoki(clusterId, {
      namespace: pod.namespace ?? "",
      pod: pod.name,
      container: container || null,
      range: { startMs: lokiStart, endMs: lokiEnd },
      direction: "backward",
      limit: MAX_LOKI_LINES,
    });
  }, [clusterId, pod.namespace, pod.name, container, previous, lokiStart, lokiEnd, loadLoki, clearLoki]);
  const lokiLines = useLokiLines(read.entries, lines, timestamps, t("logs:lineCut"));
  const lokiCount = lokiLines.length;
  const total = lokiCount + lines.length;
  const textAt = (i: number) => (i < lokiCount ? lokiLines[i] : lines.at(i - lokiCount));
  const gone = !!lokiOnly || (stream.status === "error" && stream.error?.code === "notFound");

  // ---- search ----
  // Each line is read once as it arrives, not on every batch (MatchIndex); Loki's few thousand lines at once.
  const [index] = useState(() => new MatchIndex());
  const liveMatches = useMemo(
    () => index.update(lines, dropped, query, stream.generation),
    [index, lines, dropped, query, stream.generation],
  );
  const lokiMatches = useMemo(() => (query ? findMatches(lokiLines, query) : []), [lokiLines, query]);
  const matches = useMemo(
    () =>
      lokiMatches.length === 0
        ? liveMatches
        : [...lokiMatches, ...liveMatches.map((m) => ({ ...m, line: m.line + lokiCount }))].slice(0, MAX_MATCHES),
    [lokiMatches, liveMatches, lokiCount],
  );
  const current = matches.length === 0 ? -1 : Math.min(cursor, matches.length - 1);
  const currentMatch = current >= 0 ? matches[current] : undefined;
  const firstMatchOfLine = useMemo(() => {
    const first = new Map<number, number>();
    matches.forEach((m, i) => {
      if (!first.has(m.line)) first.set(m.line, i);
    });
    return first;
  }, [matches]);
  const step = (delta: number) => {
    if (matches.length > 0) setCursor((current + delta + matches.length) % matches.length);
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  // ---- the list ----
  const scrollRef = useRef<HTMLDivElement>(null);
  // Lines are `--log-line-height` high, measured again when the interface text size changes.
  const lineHeight = useCssLength("--log-line-height", LINE_HEIGHT);
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => lineHeight,
    // Keys follow the line, not its place: when the oldest lines are discarded, a measured (wrapped) height stays
    // with its line.
    getItemKey: (index) => (index < lokiCount ? `loki:${read.generation}:${index}` : dropped + index - lokiCount),
    overscan: 20,
  });
  // Lines placed (or measured, wrapped) at the old size are placed again.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, lineHeight]);
  const count = total;
  const { atBottom, onScroll } = useFollowScroll(virtualizer, scrollRef, {
    follow: follow && !currentMatch,
    active,
    count,
    wrap,
    colours,
  });

  // Jump to the current match when the query or the chosen match changes (not on every new line).
  const matchLine = currentMatch?.line;
  useEffect(() => {
    if (matchLine !== undefined) {
      atBottom.current = false;
      virtualizer.scrollToIndex(matchLine, { align: "center" });
    }
  }, [matchLine, current, virtualizer]);

  // ---- save ----
  const save = async () => {
    setSaveError(null);
    try {
      const path = await api.dialog.saveFile({
        title: t("logs:save.title"),
        defaultPath: `${pod.name}-${container}.log`,
        filters: [{ name: t("logs:save.filter"), extensions: ["log", "txt"] }],
      });
      if (!path) return;
      const all = [...lokiLines, ...lines.toArray()];
      await api.files.save(path, all.length > 0 ? `${all.join("\n")}\n` : "");
    } catch (err) {
      setSaveError(toApiError(err));
    }
  };

  const lineBreakLabel = t("logs:lineBreak");
  const statusText = lokiOnly
    ? read.status === "loading"
      ? t("loki:status.loading")
      : read.status === "error"
        ? t("loki:status.failed")
        : t("loki:status.onlyLoki")
    : stream.status === "connecting"
      ? t("logs:status.connecting")
      : stream.status === "ended"
        ? t("logs:status.ended")
        : stream.status === "error"
          ? t("logs:status.failed")
          : follow
            ? t("logs:status.live")
            : t("logs:status.notFollowing");
  const canReconnect = !lokiOnly && (stream.status === "ended" || stream.status === "error");

  const matchCount =
    matches.length === 0
      ? t("logs:search.none")
      : t(matches.length >= MAX_MATCHES ? "logs:search.countCapped" : "logs:search.count", {
          current: current + 1,
          total: matches.length,
        });

  return (
    <div className="logs">
      <div className="logs__toolbar" role="toolbar" aria-label={t("logs:toolbar.label")}>
        <label className="logs__field">
          <span>{t("logs:toolbar.container")}</span>
          <select aria-label={t("logs:toolbar.container")} value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <option key={c.name} value={c.name}>
                {c.init ? t("logs:toolbar.initContainer", { name: c.name }) : c.name}
              </option>
            ))}
          </select>
        </label>
        {!lokiOnly && (
          <label className="logs__check">
            <Checkbox checked={follow} onChange={(e) => {
                atBottom.current = true;
                setFollow(e.target.checked);
              }} />
            <span>{t("logs:toolbar.follow")}</span>
          </label>
        )}
        <label className="logs__check">
          <Checkbox checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
          <span>{t("logs:toolbar.timestamps")}</span>
        </label>
        {!lokiOnly && (
          <label className="logs__check">
            <Checkbox checked={previous} onChange={(e) => setPrevious(e.target.checked)} />
            <span>{t("logs:toolbar.previous")}</span>
          </label>
        )}
        <LogViewControls view={view} />
        <span className="logs__spacer" />
        <input
          type="search"
          className="logs__search"
          aria-label={t("logs:search.label")}
          placeholder={t("logs:search.placeholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onSearchKey}
        />
        {query && (
          <span className="logs__match-count" data-testid="logs-match-count">
            {matchCount}
          </span>
        )}
        <button type="button" className="icon-btn" aria-label={t("logs:search.previous")} disabled={matches.length === 0} onClick={() => step(-1)}>
          <Icon name="chevronUp" />
        </button>
        <button type="button" className="icon-btn" aria-label={t("logs:search.next")} disabled={matches.length === 0} onClick={() => step(1)}>
          <Icon name="chevronDown" />
        </button>
        <Button icon="download" onClick={() => void save()}>
          {t("logs:toolbar.save")}
        </Button>
      </div>

      <div className="logs__statusbar">
        <span role="status" className={`logs__status logs__status--${stream.status}`}>
          {statusText}
        </span>
        <span data-testid="logs-count">{t("logs:lines", { count: lines.length })}</span>
        {lokiCount > 0 && <span data-testid="logs-loki-count">{t("loki:linesFromLoki", { count: lokiCount })}</span>}
        <LogAnnouncer total={dropped + total} />
        {canReconnect && (
          <Button onClick={stream.reconnect}>
            {t("logs:toolbar.reconnect")}
          </Button>
        )}
      </div>
      <LokiBar clusterId={clusterId} pod={pod} container={container} previous={previous} gone={gone} read={read} />
      {stream.status === "error" && stream.error && <ErrorState error={stream.error} />}
      {saveError !== null && <ErrorState error={saveError} title={t("logs:save.failed")} />}
      {dropped > 0 && (
        <div className="logs__dropped" data-testid="logs-dropped">
          {t("logs:dropped", { count: dropped, limit: LOG_BUFFER_LIMIT, size: LOG_BUFFER_TEXT_LIMIT / (1024 * 1024) })}
        </div>
      )}

      <div
        ref={scrollRef}
        className={wrap ? "logs__scroll logs__scroll--wrap" : "logs__scroll"}
        role="log"
        aria-live="off"
        aria-label={t("logs:view")}
        onScroll={onScroll}
      >
        {total === 0 && stream.status === "streaming" && <p className="logs__empty">{t("logs:empty")}</p>}
        {total === 0 && lokiOnly && read.status === "done" && <p className="logs__empty">{t("loki:noLines")}</p>}
        <div className="logs__body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const text = textAt(item.index) ?? "";
            const style: CSSProperties = { transform: `translateY(${item.start}px)` };
            const fromLoki = item.index < lokiCount;
            return (
              <div
                key={item.key}
                ref={wrap ? virtualizer.measureElement : undefined}
                data-index={item.index}
                className={fromLoki ? "logs__line logs__line--loki" : "logs__line"}
                style={style}
              >
                {fromLoki && (
                  <span className="logs__loki-mark" title={t("loki:markTitle")}>
                    {t("loki:mark")}
                  </span>
                )}
                {logText(text, {
                  colours,
                  wrap,
                  lineBreakLabel,
                  ranges: rangesOf(item.index, query, firstMatchOfLine, currentMatch?.line === item.index ? current : -1),
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The matches of `query` in a line (`current` = the index of the current match among all matches). */
function rangesOf(line: number, query: string, firstMatchOfLine: Map<number, number>, current: number) {
  const first = firstMatchOfLine.get(line);
  if (first === undefined) return undefined;
  return (visible: string): TextRange[] =>
    matchRanges(visible, query).map((r, i) => (first + i === current ? { ...r, current: true } : r));
}
