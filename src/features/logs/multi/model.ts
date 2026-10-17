// The merged logs of several pods (stern-like): which containers to stream, the colour of a pod, JSON lines and
// their levels, and the text filter. Pure functions, no React.
import type { KubeObject } from "../../../api";
import { containersOf } from "../openLogsTab";

/** At most this many log streams run at once in one merged tab; the other containers wait for a free slot. */
export const MAX_STREAMS = 20;
/** Lines requested from each container before following (the merged view of 20 containers starts with 4000). */
export const MULTI_TAIL_LINES = 200;
/** Colours of the pod prefixes (`--logs-src-<n>` in logs.css, defined for the light and the dark theme). */
export const PALETTE_SIZE = 10;

/** One container of one pod: what the pod/container filter lists and what a line is prefixed with. */
export interface LogSourceRef {
  /** `namespace/pod/container`. */
  key: string;
  namespace: string;
  pod: string;
  container: string;
  init: boolean;
}

/** A container whose log can be streamed now. */
export interface LogTarget extends LogSourceRef {
  /** The source plus the container instance: a restarted container is a new run (a new stream). */
  runKey: string;
}

interface ContainerState {
  running?: unknown;
  terminated?: { containerID?: string };
  waiting?: unknown;
}

interface ContainerStatus {
  name?: string;
  containerID?: string;
  restartCount?: number;
  state?: ContainerState;
  lastState?: ContainerState;
}

function statusesOf(pod: KubeObject): Map<string, ContainerStatus> {
  const status = (pod as { status?: Record<string, unknown> }).status ?? {};
  const out = new Map<string, ContainerStatus>();
  for (const field of ["initContainerStatuses", "containerStatuses", "ephemeralContainerStatuses"]) {
    const list = status[field];
    if (!Array.isArray(list)) continue;
    for (const s of list as ContainerStatus[]) if (s.name) out.set(s.name, s);
  }
  return out;
}

/**
 * The container instance whose log is read: the current one once it has started (running or terminated), or with
 * `previous` the one before it; `null` when there is none yet (a pending pod, a container never restarted).
 */
function instanceOf(status: ContainerStatus | undefined, previous: boolean): string | null {
  if (!status) return null;
  const restarts = status.restartCount ?? 0;
  if (previous) {
    const last = status.lastState?.terminated;
    if (last) return last.containerID || `previous-${restarts}`;
    return null;
  }
  if (status.state?.running || status.state?.terminated) return status.containerID || `run-${restarts}`;
  return null;
}

export function sourceKeyOf(namespace: string, pod: string, container: string): string {
  return `${namespace}/${pod}/${container}`;
}

/** Every container of `pods`, by pod name and then in the pod's order (init, regular, ephemeral). */
export function sourcesOf(pods: readonly KubeObject[]): LogSourceRef[] {
  const sorted = [...pods].sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
  return sorted.flatMap((pod) => {
    const namespace = pod.metadata?.namespace ?? "";
    const name = pod.metadata?.name ?? "";
    return containersOf(pod).map((c) => ({
      key: sourceKeyOf(namespace, name, c.name),
      namespace,
      pod: name,
      container: c.name,
      init: c.init,
    }));
  });
}

/** The containers of `pods` whose logs can be read now, in `sourcesOf` order. */
export function targetsOf(pods: readonly KubeObject[], previous: boolean): LogTarget[] {
  const byPod = new Map(pods.map((p) => [`${p.metadata?.namespace ?? ""}/${p.metadata?.name ?? ""}`, statusesOf(p)]));
  const out: LogTarget[] = [];
  for (const source of sourcesOf(pods)) {
    const instance = instanceOf(byPod.get(`${source.namespace}/${source.pod}`)?.get(source.container), previous);
    if (instance !== null) out.push({ ...source, runKey: `${source.key}#${instance}` });
  }
  return out;
}

/** A stable colour (0 … `PALETTE_SIZE - 1`) for a pod name: FNV-1a of the name, so it never depends on order. */
export function colourOf(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % PALETTE_SIZE;
}

// ---------- JSON lines ----------

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LEVELS)[number];

export interface ParsedLine {
  /** The timestamp the backend put before the line (with "Timestamps" on). */
  timestamp?: string;
  level?: LogLevel;
  message?: string;
  /** The other fields, `key=value`. */
  fields: string[];
}

const LEVEL_KEYS = ["level", "lvl", "severity", "loglevel", "levelname", "log.level", "@l"];
const MESSAGE_KEYS = ["msg", "message", "@m", "@mt", "log"];

/** The level a JSON field names: words (`warning`, `ERR`, `critical`) or bunyan/pino numbers (30 = info). */
export function levelOf(value: unknown): LogLevel | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 10) return "trace";
    if (value <= 20) return "debug";
    if (value <= 30) return "info";
    if (value <= 40) return "warn";
    if (value <= 50) return "error";
    return "fatal";
  }
  if (typeof value !== "string") return undefined;
  const word = value.trim().toLowerCase();
  if (word.startsWith("trace")) return "trace";
  if (word.startsWith("debug") || word === "dbug" || word === "verbose") return "debug";
  if (word.startsWith("info") || word === "notice") return "info";
  if (word.startsWith("warn")) return "warn";
  if (word.startsWith("err")) return "error";
  if (["fatal", "critical", "crit", "panic", "dpanic", "alert", "emerg", "emergency"].includes(word)) return "fatal";
  return undefined;
}

function fieldText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * A JSON object line (after the timestamp, when `timestamps`): its level, message and other fields; `null` for
 * anything else.
 */
export function parseJsonLine(text: string, timestamps: boolean): ParsedLine | null {
  let body = text;
  let timestamp: string | undefined;
  if (timestamps) {
    const space = text.indexOf(" ");
    if (space > 0) {
      timestamp = text.slice(0, space);
      body = text.slice(space + 1);
    }
  }
  body = body.trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const levelKey = LEVEL_KEYS.find((k) => k in record && levelOf(record[k]) !== undefined);
  const messageKey = MESSAGE_KEYS.find((k) => typeof record[k] === "string");
  const fields = Object.entries(record)
    .filter(([k]) => k !== levelKey && k !== messageKey)
    .map(([k, v]) => `${k}=${fieldText(v)}`);
  return {
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(levelKey ? { level: levelOf(record[levelKey]) } : {}),
    ...(messageKey ? { message: record[messageKey] as string } : {}),
    fields,
  };
}

/** Whether a line of `level` passes the level filter `min` (`null` = all lines, also those without a level). */
export function passesLevel(level: LogLevel | undefined, min: LogLevel | null): boolean {
  if (min === null) return true;
  if (level === undefined) return false;
  return LEVELS.indexOf(level) >= LEVELS.indexOf(min);
}

// ---------- text filter ----------

export interface TextFilter {
  /** `null` when the filter is empty (every line passes). */
  pattern: RegExp | null;
  /** The regular expression does not compile; every line passes meanwhile. */
  invalid: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The filter for `query`: a case-insensitive substring, or with `regex` a case-insensitive regular expression. */
export function textFilter(query: string, regex: boolean): TextFilter {
  if (!query) return { pattern: null, invalid: false };
  try {
    return { pattern: new RegExp(regex ? query : escapeRegExp(query), "i"), invalid: false };
  } catch {
    return { pattern: null, invalid: true };
  }
}

export interface TextPart {
  text: string;
  match: boolean;
}

/** `text` cut into plain parts and the parts `pattern` matches (for highlighting). */
export function splitMatches(text: string, pattern: RegExp | null): TextPart[] {
  if (!pattern) return [{ text, match: false }];
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const parts: TextPart[] = [];
  let from = 0;
  for (const m of text.matchAll(global)) {
    const start = m.index;
    if (m[0].length === 0) continue;
    if (start > from) parts.push({ text: text.slice(from, start), match: false });
    parts.push({ text: m[0], match: true });
    from = start + m[0].length;
  }
  if (from < text.length || parts.length === 0) parts.push({ text: text.slice(from), match: false });
  return parts;
}
