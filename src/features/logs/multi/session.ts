// The streams of a merged logs tab: one existing log stream (`api.logs.start` through `openStream`) per container
// instance, at most `MAX_STREAMS` at once, their lines merged into one bounded buffer in arrival order.
//
// `sync(targets)` is called whenever the watched pods (or the pod/container choice) change: a target that went away
// (a deleted pod, an unticked container) has its stream stopped — its lines stay —, a new one (a pod created by a
// rollout, a restarted container) waits for a slot and then starts. Lines are flushed into the buffer at most every
// `FLUSH_INTERVAL` ms, so twenty chatty streams cost one render per interval, not one per batch.
import {
  api,
  openStream,
  toApiError,
  type ApiError,
  type ClusterId,
  type KindRef,
  type LogUpdate,
} from "../../../api";
import { i18n } from "../../../i18n";
import { appendLines, EMPTY_BUFFER, LogLines, markCutLines, type LogBuffer } from "../buffer";
import { colourOf, MAX_STREAMS, MULTI_TAIL_LINES, type LogSourceRef, type LogTarget } from "./model";

export const FLUSH_INTERVAL = 100;

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };

/** A source as the tab knows it: numbered in the order it was first streamed, with its colour. */
export interface LogSource extends LogSourceRef {
  index: number;
  colour: number;
}

/** One line of the merged buffer: its source (index into `sources`), the run it came from, its text. */
export interface LogEntry {
  readonly src: number;
  readonly run: number;
  readonly text: string;
}

export type RunStatus = "waiting" | "connecting" | "streaming" | "ended" | "error";

interface Run {
  id: number;
  target: LogTarget;
  order: number;
  status: RunStatus;
  error?: ApiError;
  close?: () => void;
}

export interface MultiLogOptions {
  follow: boolean;
  previous: boolean;
  timestamps: boolean;
}

export interface RunState {
  status: RunStatus;
  error?: ApiError;
}

export class MultiLogSession {
  buffer: LogBuffer<LogEntry> = EMPTY_BUFFER as unknown as LogBuffer<LogEntry>;
  /** Bumped when the buffer was rebuilt (not just appended to): indices into older buffers mean nothing now. */
  generation = 0;
  readonly sources: LogSource[] = [];

  private readonly sourceByKey = new Map<string, LogSource>();
  private readonly runs = new Map<string, Run>();
  /** The id of the last run started for a run key: a run started again replaces that run's lines. */
  private readonly lastRun = new Map<string, number>();
  private runCounter = 0;
  private pending: LogEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly clusterId: ClusterId,
    private readonly options: MultiLogOptions,
    private readonly onChange: () => void,
  ) {}

  /** Streams exactly `targets` (in that order of priority for the free slots). */
  sync(targets: readonly LogTarget[]): void {
    if (this.disposed) return;
    const wanted = new Map(targets.map((t, order) => [t.runKey, { t, order }]));
    for (const [key, run] of this.runs) {
      if (!wanted.has(key)) {
        run.close?.();
        this.runs.delete(key);
      }
    }
    for (const [key, { t, order }] of wanted) {
      const run = this.runs.get(key);
      if (run) run.order = order;
      else this.runs.set(key, { id: ++this.runCounter, target: t, order, status: "waiting" });
    }
    this.fill();
    this.onChange();
  }

  /** The state of the stream of each source being streamed (or waiting), by source key. */
  runStates(): Map<string, RunState> {
    const out = new Map<string, RunState>();
    for (const run of this.runs.values()) out.set(run.target.key, { status: run.status, error: run.error });
    return out;
  }

  /** Streams running or starting now. */
  activeCount(): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.status === "connecting" || run.status === "streaming") n++;
    return n;
  }

  /** Containers waiting for a free slot (over `MAX_STREAMS`). */
  waitingCount(): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.status === "waiting") n++;
    return n;
  }

  /** Stops every stream; nothing happens after. */
  dispose(): void {
    this.disposed = true;
    for (const run of this.runs.values()) run.close?.();
    this.runs.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }

  private sourceOf(target: LogTarget): LogSource {
    let source = this.sourceByKey.get(target.key);
    if (!source) {
      const { key, namespace, pod, container, init } = target;
      source = { key, namespace, pod, container, init, index: this.sources.length, colour: colourOf(pod) };
      this.sources.push(source);
      this.sourceByKey.set(key, source);
    }
    return source;
  }

  private fill(): void {
    let free = MAX_STREAMS - this.activeCount();
    if (free <= 0) return;
    const waiting = [...this.runs.values()].filter((r) => r.status === "waiting").sort((a, b) => a.order - b.order);
    for (const run of waiting) {
      if (free <= 0) break;
      this.start(run);
      free--;
    }
  }

  private start(run: Run): void {
    const { target } = run;
    const src = this.sourceOf(target).index;
    const earlier = this.lastRun.get(target.runKey);
    if (earlier !== undefined) this.forget(earlier);
    this.lastRun.set(target.runKey, run.id);
    run.status = "connecting";
    const current = () => !this.disposed && this.runs.get(target.runKey) === run;
    const settle = (status: RunStatus, error?: ApiError) => {
      if (!current() || run.status === "ended" || run.status === "error") return;
      run.status = status;
      if (error) run.error = error;
      run.close?.();
      this.fill();
      this.onChange();
    };
    const pod = { kind: POD, namespace: target.namespace, name: target.pod };
    const { follow, previous, timestamps } = this.options;
    run.close = openStream<LogUpdate>({
      start: (id, channel) => {
        const opts = { container: target.container, follow, previous, timestamps, tailLines: MULTI_TAIL_LINES };
        return api.logs.start(this.clusterId, pod, opts, id, channel);
      },
      stop: api.logs.stop,
      onListening: () => {
        if (current() && run.status === "connecting") {
          run.status = "streaming";
          this.onChange();
        }
      },
      onEvent: (u) => {
        if (!current()) return;
        switch (u.type) {
          case "lines": {
            if (run.status === "connecting") run.status = "streaming";
            for (const text of markCutLines(u.lines, u.cut, i18n.t("logs:lineCut"))) this.pending.push({ src, run: run.id, text });
            this.schedule();
            break;
          }
          case "ended":
            settle("ended");
            break;
          case "error":
            settle("error", toApiError(u));
            break;
        }
      },
      onStartError: (err) => settle("error", toApiError(err)),
    });
  }

  /** Drops the lines of run `id` (it is about to stream the same container instance again from its tail). */
  private forget(id: number): void {
    this.pending = this.pending.filter((e) => e.run !== id);
    const kept = this.buffer.lines.toArray().filter((e) => e.run !== id);
    if (kept.length === this.buffer.lines.length) return;
    this.buffer = { lines: LogLines.of(kept), dropped: this.buffer.dropped };
    this.generation++;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_INTERVAL);
  }

  private flush(): void {
    if (this.disposed || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.buffer = appendLines(this.buffer, batch);
    this.onChange();
  }
}
