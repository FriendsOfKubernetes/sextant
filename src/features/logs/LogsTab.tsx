// The dock tab with a pod's logs: toolbar (container, follow, timestamps, previous, wrap, search, save) and a
// virtualized list of the buffered lines. A `MultiLogsPayload` gets the merged logs of several pods (multi/).
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ClusterId, type LogOptions, type ObjectRef } from "../../api";
import { Button, Checkbox, ErrorState, Icon } from "../../components";
import type { DockTabProps } from "../../layout/dock/registry";
import { LOG_BUFFER_LIMIT, LOG_BUFFER_TEXT_LIMIT } from "./buffer";
import { LogAnnouncer } from "./LogAnnouncer";
import { MultiLogsTab } from "./multi/MultiLogsTab";
import { isMultiLogsPayload } from "./multi/open";
import { logText, type TextRange } from "./LogText";
import { MatchIndex, MAX_MATCHES, matchRanges } from "./search";
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
}

/** Lines requested from the pod before following. */
const INITIAL_TAIL_LINES = 1000;
const LINE_HEIGHT = 18;

/** The "logs" dock tab: one pod's logs, or the merged logs of several pods (`MultiLogsPayload`). */
export function LogsTab(props: DockTabProps) {
  return isMultiLogsPayload(props.tab.payload) ? <MultiLogsTab {...props} /> : <PodLogsTab {...props} />;
}

function PodLogsTab({ tab, active }: DockTabProps) {
  const { t } = useTranslation();
  const { clusterId, pod, containers, container: preferred } = tab.payload as LogsPayload;
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
  const stream = useLogStream(clusterId, pod, options);
  const { lines, dropped } = stream.buffer;

  // ---- search ----
  // Each line is read once as it arrives, not on every batch (MatchIndex).
  const [index] = useState(() => new MatchIndex());
  const matches = useMemo(
    () => index.update(lines, dropped, query, stream.generation),
    [index, lines, dropped, query, stream.generation],
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
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    // Keys follow the line, not its place: when the oldest lines are discarded, a measured (wrapped) height stays
    // with its line.
    getItemKey: (index) => dropped + index,
    overscan: 20,
  });
  const count = lines.length;
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
      await api.files.save(path, lines.length > 0 ? `${lines.toArray().join("\n")}\n` : "");
    } catch (err) {
      setSaveError(toApiError(err));
    }
  };

  const lineBreakLabel = t("logs:lineBreak");
  const statusText =
    stream.status === "connecting"
      ? t("logs:status.connecting")
      : stream.status === "ended"
        ? t("logs:status.ended")
        : stream.status === "error"
          ? t("logs:status.failed")
          : follow
            ? t("logs:status.live")
            : t("logs:status.notFollowing");
  const canReconnect = stream.status === "ended" || stream.status === "error";

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
        <label className="logs__check">
          <Checkbox checked={follow} onChange={(e) => {
              atBottom.current = true;
              setFollow(e.target.checked);
            }} />
          <span>{t("logs:toolbar.follow")}</span>
        </label>
        <label className="logs__check">
          <Checkbox checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
          <span>{t("logs:toolbar.timestamps")}</span>
        </label>
        <label className="logs__check">
          <Checkbox checked={previous} onChange={(e) => setPrevious(e.target.checked)} />
          <span>{t("logs:toolbar.previous")}</span>
        </label>
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
        <LogAnnouncer total={dropped + lines.length} />
        {canReconnect && (
          <Button onClick={stream.reconnect}>
            {t("logs:toolbar.reconnect")}
          </Button>
        )}
      </div>
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
        {lines.length === 0 && stream.status === "streaming" && <p className="logs__empty">{t("logs:empty")}</p>}
        <div className="logs__body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const text = lines.at(item.index) ?? "";
            const style: CSSProperties = { transform: `translateY(${item.start}px)` };
            return (
              <div key={item.key} ref={wrap ? virtualizer.measureElement : undefined} data-index={item.index} className="logs__line" style={style}>
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
