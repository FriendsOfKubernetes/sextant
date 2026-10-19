// The merged logs of several pods (stern-like): every line prefixed with its pod and container in the pod's colour,
// pods followed as they appear and go, a pod/container choice, a text or regex filter, optional JSON parsing with a
// level filter, timestamps, previous containers and save.
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useCssLength } from "../../../app/accessibility";
import { api, toApiError, useWatch, type ClusterId, type WatchSpec } from "../../../api";
import { Button, Checkbox, ErrorState } from "../../../components";
import type { DockTabProps } from "../../../layout/dock/registry";
import { EMPTY_BUFFER, LOG_BUFFER_LIMIT, LOG_BUFFER_TEXT_LIMIT, type LogBuffer } from "../buffer";
import { POD_KIND } from "../openLogsTab";
import {
  LEVELS,
  MAX_STREAMS,
  parseJsonLine,
  passesLevel,
  sourcesOf,
  splitMatches,
  targetsOf,
  textFilter,
  type LogLevel,
  type LogSourceRef,
  type ParsedLine,
} from "./model";
import { visibleText } from "../ansi";
import { LogAnnouncer } from "../LogAnnouncer";
import { logText, type TextRange } from "../LogText";
import { LogViewControls, useFollowScroll } from "../view";
import { useLogView, type LogView } from "../viewSettings";
import type { MultiLogsPayload } from "./open";
import { MultiLogSession, type LogEntry, type LogSource, type MultiLogOptions, type RunState } from "./session";

/** A line's height at the default text size; the list measures `--log-line-height` (logs.css, in rem). */
const LINE_HEIGHT = 18;

/** The watch of the pods a merged tab reads: by selector in its namespace, or the namespaces of a fixed set. */
function watchSpecOf(payload: MultiLogsPayload, selector: string): WatchSpec | null {
  if (payload.selector) {
    return { kind: POD_KIND, namespaces: [payload.selector.namespace], labelSelector: selector, fieldSelector: null };
  }
  const namespaces = [...new Set((payload.pods ?? []).map((p) => p.namespace ?? ""))].sort();
  if (namespaces.length === 0) return null;
  return { kind: POD_KIND, namespaces, labelSelector: null, fieldSelector: null };
}

/** The session of the tab: a new one (empty text, every stream restarted) when the cluster or an option changes. */
function useSession(clusterId: ClusterId, options: MultiLogOptions, attempt: number) {
  const [session, setSession] = useState<MultiLogSession | null>(null);
  const [, setVersion] = useState(0);
  const key = JSON.stringify([clusterId, options, attempt]);
  useEffect(() => {
    const [cluster, opts] = JSON.parse(key) as [ClusterId, MultiLogOptions];
    const s = new MultiLogSession(cluster, opts, () => setVersion((v) => v + 1));
    setSession(s);
    return () => s.dispose();
  }, [key]);
  return session;
}

interface LineView {
  length: number;
  at(index: number): LogEntry | undefined;
  /** A key of the line that stays with it while older lines are discarded or the filter changes. */
  keyAt(index: number): number;
}

interface FilterCache {
  key: string;
  /** Absolute indices (`dropped` + index) of the lines that pass, from `head` on. */
  indices: number[];
  head: number;
  /** Absolute index up to which the buffer was scanned. */
  scanned: number;
}

/**
 * The lines of `buffer` that pass `predicate` (`null`: all of them). New lines are scanned once, not the whole
 * buffer on every batch: the buffer only grows at the end and drops at the start, until `generation` changes.
 */
function useFilteredLines(
  buffer: LogBuffer<LogEntry>,
  generation: number,
  predicate: ((e: LogEntry) => boolean) | null,
  predicateKey: string,
): LineView {
  const cache = useRef<FilterCache | null>(null);
  return useMemo(() => {
    const { lines, dropped } = buffer;
    if (!predicate) return { length: lines.length, at: (i: number) => lines.at(i), keyAt: (i: number) => dropped + i };
    const key = `${generation}\u0000${predicateKey}`;
    let c = cache.current;
    if (!c || c.key !== key) c = cache.current = { key, indices: [], head: 0, scanned: dropped };
    while (c.head < c.indices.length && c.indices[c.head]! < dropped) c.head++;
    if (c.head > 4096 && c.head * 2 > c.indices.length) {
      c.indices = c.indices.slice(c.head);
      c.head = 0;
    }
    const end = dropped + lines.length;
    for (let abs = Math.max(c.scanned, dropped); abs < end; abs++) {
      const entry = lines.at(abs - dropped);
      if (entry && predicate(entry)) c.indices.push(abs);
    }
    c.scanned = end;
    const { indices, head } = c;
    const length = indices.length - head;
    return {
      length,
      at: (i: number) => (i >= 0 && i < length ? lines.at(indices[head + i]! - dropped) : undefined),
      keyAt: (i: number) => indices[head + i] ?? -1 - i,
    };
    // `predicateKey` stands for `predicate`.
  }, [buffer, generation, predicateKey]);
}

type SourceStatus = RunState["status"] | "notStarted" | "gone" | "off";

export function MultiLogsTab({ tab, active }: DockTabProps) {
  const { t } = useTranslation();
  const payload = tab.payload as MultiLogsPayload;
  const { clusterId } = payload;

  const [selector, setSelector] = useState(payload.selector?.labelSelector ?? "");
  const [selectorDraft, setSelectorDraft] = useState(selector);
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [previous, setPrevious] = useState(false);
  const view = useLogView();
  const { wrap, colours } = view;
  const [json, setJson] = useState(false);
  const [minLevel, setMinLevel] = useState<LogLevel | null>(null);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [showSources, setShowSources] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saveError, setSaveError] = useState<unknown>(null);

  // ---- pods ----
  const spec = watchSpecOf(payload, selector);
  const watch = useWatch(spec ? clusterId : null, spec);
  const fixed = useMemo(
    () => (payload.pods ? new Set(payload.pods.map((p) => `${p.namespace ?? ""}/${p.name}`)) : null),
    [payload.pods],
  );
  const pods = useMemo(() => {
    const all = [...watch.items.values()];
    return fixed ? all.filter((p) => fixed.has(`${p.metadata?.namespace ?? ""}/${p.metadata?.name ?? ""}`)) : all;
  }, [watch.items, fixed]);

  // ---- streams ----
  const options = useMemo<MultiLogOptions>(() => ({ follow, previous, timestamps }), [follow, previous, timestamps]);
  const session = useSession(clusterId, options, attempt);
  const targets = useMemo(
    () => targetsOf(pods, previous).filter((target) => !excluded.has(target.key)),
    [pods, previous, excluded],
  );
  const targetsKey = targets.map((target) => target.runKey).join("\n");
  useEffect(() => {
    session?.sync(targets);
    // `targetsKey` stands for `targets`.
  }, [session, targetsKey]);

  const buffer = session?.buffer ?? (EMPTY_BUFFER as unknown as LogBuffer<LogEntry>);
  const sessionSources: readonly LogSource[] = session?.sources ?? [];
  const runStates = session?.runStates() ?? new Map<string, RunState>();
  const activeStreams = session?.activeCount() ?? 0;
  const waiting = session?.waitingCount() ?? 0;

  // Every source the tab lists: the containers of the current pods, then those of pods that went away.
  const current = sourcesOf(pods);
  const currentKeys = new Set(current.map((s) => s.key));
  const listed: LogSourceRef[] = [...current, ...sessionSources.filter((s) => !currentKeys.has(s.key))];
  const statusOf = (key: string): SourceStatus => {
    if (excluded.has(key)) return "off";
    const run = runStates.get(key);
    if (run) return run.status;
    return currentKeys.has(key) ? "notStarted" : "gone";
  };

  // ---- filters ----
  const filter = textFilter(query, regex);
  const parsed = useMemo(() => new WeakMap<LogEntry, ParsedLine | null>(), [session]);
  const parse = useCallback(
    (e: LogEntry): ParsedLine | null => {
      let p = parsed.get(e);
      if (p === undefined) {
        p = parseJsonLine(e.text, timestamps);
        parsed.set(e, p);
      }
      return p;
    },
    [parsed, timestamps],
  );
  const levelFilter = json ? minLevel : null;
  const filtering = excluded.size > 0 || levelFilter !== null || filter.pattern !== null;
  const predicate = filtering
    ? (e: LogEntry) => {
        const source = sessionSources[e.src];
        if (source && excluded.has(source.key)) return false;
        if (levelFilter !== null && !passesLevel(parse(e)?.level, levelFilter)) return false;
        return filter.pattern === null || filter.pattern.test(visibleText(e.text));
      }
    : null;
  const predicateKey = JSON.stringify([[...excluded].sort(), levelFilter, filter.pattern?.source ?? null]);
  const lines = useFilteredLines(buffer, session?.generation ?? 0, predicate, predicateKey);
  const { dropped } = buffer;

  // ---- the list ----
  const scrollRef = useRef<HTMLDivElement>(null);
  // Lines are `--log-line-height` high, measured again when the interface text size changes.
  const lineHeight = useCssLength("--log-line-height", LINE_HEIGHT);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => lineHeight,
    getItemKey: (index) => lines.keyAt(index),
    overscan: 20,
  });
  // Lines placed (or measured, wrapped) at the old size are placed again.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, lineHeight]);
  const count = lines.length;
  const { atBottom, onScroll } = useFollowScroll(virtualizer, scrollRef, {
    follow,
    active,
    count,
    wrap,
    colours,
    generation: session,
  });

  // ---- save ----
  const prefixOf = (e: LogEntry) => {
    const source = sessionSources[e.src];
    return source ? `${source.pod} ${source.container} ` : "";
  };
  const save = async () => {
    setSaveError(null);
    try {
      const path = await api.dialog.saveFile({
        title: t("logs:save.title"),
        defaultPath: `${tab.title.replace(/[^A-Za-z0-9._-]+/g, "-")}.log`,
        filters: [{ name: t("logs:save.filter"), extensions: ["log", "txt"] }],
      });
      if (!path) return;
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const e = lines.at(i);
        if (e) out.push(`${prefixOf(e)}${e.text}`);
      }
      await api.files.save(path, out.length > 0 ? `${out.join("\n")}\n` : "");
    } catch (err) {
      setSaveError(toApiError(err));
    }
  };

  const toggleSource = (key: string, on: boolean) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });

  // ---- status ----
  const statuses = [...runStates.values()].map((r) => r.status);
  let status: "connecting" | "streaming" | "ended" | "error";
  if (watch.status === "loading" || statuses.includes("connecting")) status = "connecting";
  else if (watch.status === "error") status = "error";
  else if (statuses.includes("streaming") || statuses.includes("waiting")) status = "streaming";
  else if (statuses.length > 0 && statuses.every((s) => s === "error")) status = "error";
  else status = pods.length === 0 ? "streaming" : "ended";
  const statusText =
    status === "connecting"
      ? t("logs:status.connecting")
      : status === "error"
        ? t("logs:status.failed")
        : status === "ended"
          ? t("logs:status.ended")
          : follow
            ? t("logs:status.live")
            : t("logs:status.notFollowing");
  const canReconnect = status === "ended" || status === "error";
  // The first failed stream's error (a forbidden namespace, an unknown container) says why lines are missing.
  const streamError = [...runStates.values()].find((r) => r.status === "error" && r.error)?.error;
  const levelLabel = (level: LogLevel) => t(`logs:multi.levels.${level}`);
  const look: Look = { colours, wrap, lineBreakLabel: t("logs:lineBreak") };

  return (
    <div className="logs">
      <div className="logs__toolbar" role="toolbar" aria-label={t("logs:toolbar.label")}>
        {payload.selector && (
          <label className="logs__field">
            <span>{t("logs:multi.selector")}</span>
            <input
              type="text"
              className="logs__selector"
              aria-label={t("logs:multi.selector")}
              title={t("logs:multi.selectorHint")}
              value={selectorDraft}
              onChange={(e) => setSelectorDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setSelector(selectorDraft.trim());
                }
              }}
            />
          </label>
        )}
        <Button
          aria-expanded={showSources}
          onClick={() => setShowSources((v) => !v)}
        >
          {t("logs:multi.sources", { shown: listed.length - excluded.size, total: listed.length })}
        </Button>
        <label className="logs__check">
          <Checkbox
            checked={follow}
            onChange={(e) => {
              atBottom.current = true;
              setFollow(e.target.checked);
            }}
          />
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
        <label className="logs__check">
          <Checkbox checked={json} onChange={(e) => setJson(e.target.checked)} />
          <span>{t("logs:multi.json")}</span>
        </label>
        {json && (
          <label className="logs__field">
            <span>{t("logs:multi.level")}</span>
            <select
              aria-label={t("logs:multi.level")}
              value={minLevel ?? ""}
              onChange={(e) => setMinLevel(e.target.value === "" ? null : (e.target.value as LogLevel))}
            >
              <option value="">{t("logs:multi.allLevels")}</option>
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t("logs:multi.levelAndAbove", { level: levelLabel(level) })}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="logs__spacer" />
        <input
          type="search"
          className="logs__search"
          aria-label={t("logs:multi.filter")}
          aria-invalid={filter.invalid || undefined}
          placeholder={t("logs:multi.filter")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="logs__check">
          <Checkbox checked={regex} onChange={(e) => setRegex(e.target.checked)} />
          <span>{t("logs:multi.regex")}</span>
        </label>
        <Button icon="download" onClick={() => void save()}>
          {t("logs:toolbar.save")}
        </Button>
      </div>

      {showSources && (
        <div className="logs__sources" role="group" aria-label={t("logs:multi.sourcesLabel")}>
          <p className="logs__sources-hint">{t("logs:multi.capHint", { count: MAX_STREAMS })}</p>
          {listed.length === 0 && <p className="logs__sources-hint">{t("logs:multi.noPods")}</p>}
          <ul>
            {listed.map((source) => {
              const st = statusOf(source.key);
              const colour = sessionSources.find((s) => s.key === source.key)?.colour;
              const name = `${source.pod} ${source.container}`;
              return (
                <li key={source.key}>
                  <label className="logs__check">
                    <Checkbox
                      checked={!excluded.has(source.key)}
                      aria-label={name}
                      onChange={(e) => toggleSource(source.key, e.target.checked)}
                    />
                    <span className={colour === undefined ? "logs__prefix" : `logs__prefix logs__src--${colour}`}>
                      {source.pod}
                    </span>
                    <span>{source.init ? t("logs:toolbar.initContainer", { name: source.container }) : source.container}</span>
                    <span className="logs__source-status" data-testid={`source-status-${source.key}`}>
                      {t(`logs:multi.sourceStatus.${st}`)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="logs__statusbar">
        <span role="status" className={`logs__status logs__status--${status}`}>
          {statusText}
        </span>
        <span data-testid="logs-count">{t("logs:lines", { count: lines.length })}</span>
        <LogAnnouncer total={dropped + buffer.lines.length} />
        <span data-testid="logs-streams">{t("logs:multi.streams", { count: activeStreams, pods: pods.length })}</span>
        {canReconnect && <Button onClick={() => setAttempt((n) => n + 1)}>{t("logs:toolbar.reconnect")}</Button>}
      </div>
      {waiting > 0 && (
        <div className="logs__dropped" data-testid="logs-cap">
          {t("logs:multi.capped", { count: waiting, max: MAX_STREAMS })}
        </div>
      )}
      {filter.invalid && <div className="logs__dropped">{t("logs:multi.badRegex")}</div>}
      {watch.status === "error" && watch.error && <ErrorState error={watch.error} />}
      {streamError && <ErrorState error={streamError} />}
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
        {lines.length === 0 && watch.status === "ready" && (
          <p className="logs__empty">{pods.length === 0 ? t("logs:multi.noPods") : t("logs:empty")}</p>
        )}
        <div className="logs__body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = lines.at(item.index);
            if (!entry) return null;
            const source = sessionSources[entry.src];
            const parsedLine = json ? parse(entry) : null;
            const style: CSSProperties = { transform: `translateY(${item.start}px)` };
            const lineClass = lineClassOf(parsedLine);
            return (
              <div key={item.key} ref={wrap ? virtualizer.measureElement : undefined} data-index={item.index} className={lineClass} style={style}>
                {source && <span className={`logs__prefix logs__src--${source.colour}`}>{prefixOf(entry)}</span>}
                {parsedLine ? renderJson(parsedLine, filter.pattern, levelLabel, look) : highlighted(entry.text, filter.pattern, look)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function lineClassOf(line: ParsedLine | null): string {
  return line?.level ? `logs__line logs__line--${line.level}` : "logs__line";
}

/** How text is drawn: the view settings and the name of the line-break symbol. */
type Look = Pick<LogView, "colours" | "wrap"> & { lineBreakLabel: string };

/** The parts of the visible text that `pattern` matches. */
function rangesOf(visible: string, pattern: RegExp): TextRange[] {
  const ranges: TextRange[] = [];
  let at = 0;
  for (const part of splitMatches(visible, pattern)) {
    if (part.match) ranges.push({ start: at, end: at + part.text.length });
    at += part.text.length;
  }
  return ranges;
}

function highlighted(text: string, pattern: RegExp | null, look: Look): ReactNode {
  return logText(text, { ...look, ranges: pattern ? (visible) => rangesOf(visible, pattern) : undefined });
}

function renderJson(line: ParsedLine, pattern: RegExp | null, levelLabel: (level: LogLevel) => string, look: Look): ReactNode {
  const timestamp = line.timestamp ? `${line.timestamp} ` : null;
  const level = line.level ? `${levelLabel(line.level)} ` : null;
  const fields = line.fields.length > 0 ? ` ${line.fields.join(" ")}` : null;
  return (
    <>
      {timestamp && <span className="logs__muted">{timestamp}</span>}
      {level && <span className="logs__level">{level}</span>}
      {line.message !== undefined && highlighted(line.message, pattern, look)}
      {fields && <span className="logs__muted">{highlighted(fields, pattern, look)}</span>}
    </>
  );
}
