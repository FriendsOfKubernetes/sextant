// The dock tab with a pod's logs: toolbar (container, follow, timestamps, previous, wrap, search, save) and a
// virtualized list of the buffered lines.
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ClusterId, type LogOptions, type ObjectRef } from "../../api";
import { Button, Checkbox, ErrorState, Icon } from "../../components";
import type { DockTabProps } from "../../layout/dock/registry";
import { LOG_BUFFER_LIMIT } from "./buffer";
import { findMatches, MAX_MATCHES, splitLine } from "./search";
import { useLogStream } from "./useLogStream";

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
/** How close to the end (px) still counts as "at the end" for following. */
const BOTTOM_SLACK = 24;

export function LogsTab({ tab, active }: DockTabProps) {
  const { t } = useTranslation();
  const { clusterId, pod, containers, container: preferred } = tab.payload as LogsPayload;
  const [container, setContainer] = useState(
    () => preferred ?? containers.find((c) => !c.init)?.name ?? containers[0]?.name ?? "",
  );
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [previous, setPrevious] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [saveError, setSaveError] = useState<unknown>(null);

  const options: LogOptions = { container, follow, previous, timestamps, tailLines: INITIAL_TAIL_LINES };
  const stream = useLogStream(clusterId, pod, options);
  const { lines, dropped } = stream.buffer;

  // ---- search ----
  const matches = useMemo(() => findMatches(lines, query), [lines, query]);
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
  const atBottom = useRef(true);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
  });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
  }, []);

  // Following: stay at the end while new lines arrive, unless the reader scrolled up.
  const count = lines.length;
  useEffect(() => {
    if (count === 0) atBottom.current = true; // a fresh stream starts at the end
    if (follow && active && atBottom.current && count > 0 && !currentMatch) virtualizer.scrollToIndex(count - 1, { align: "end" });
  }, [follow, active, count, currentMatch, virtualizer]);

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
      await api.files.save(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    } catch (err) {
      setSaveError(toApiError(err));
    }
  };

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
        <label className="logs__check">
          <Checkbox checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          <span>{t("logs:toolbar.wrap")}</span>
        </label>
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
          {t("logs:dropped", { count: dropped, limit: LOG_BUFFER_LIMIT })}
        </div>
      )}

      <div
        ref={scrollRef}
        className={wrap ? "logs__scroll logs__scroll--wrap" : "logs__scroll"}
        role="log"
        aria-label={t("logs:view")}
        onScroll={onScroll}
      >
        {lines.length === 0 && stream.status === "streaming" && <p className="logs__empty">{t("logs:empty")}</p>}
        <div className="logs__body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const text = lines[item.index] ?? "";
            const style: CSSProperties = { transform: `translateY(${item.start}px)` };
            return (
              <div key={item.key} ref={wrap ? virtualizer.measureElement : undefined} data-index={item.index} className="logs__line" style={style}>
                {renderLine(text, item.index, query, firstMatchOfLine, currentMatch?.line === item.index ? current : -1)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** A line with its matches in `<mark>`; the current match (`current` = its index among all matches) is stronger. */
function renderLine(text: string, line: number, query: string, firstMatchOfLine: Map<number, number>, current: number) {
  const first = firstMatchOfLine.get(line);
  if (first === undefined) return text === "" ? " " : text;
  let ordinal = 0;
  return splitLine(text, query).map((part, i) => {
    if (!part.match) return part.text;
    const isCurrent = first + ordinal === current;
    ordinal++;
    return (
      <mark key={i} className={isCurrent ? "logs__mark logs__mark--current" : "logs__mark"}>
        {part.text}
      </mark>
    );
  });
}
