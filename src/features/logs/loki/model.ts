// Lines read from Loki (#265, ADR-0118): time ranges, timestamps, merging the pages of a read and dropping what the
// live view already shows. Pure functions; the read itself is in hooks.ts.
import type { KubeObject, LokiDirection, LokiEntry, LokiRange } from "../../../api";

/** Choices of the period before the end of the read. */
export const RANGE_PRESETS = ["1h", "6h", "24h", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

const HOUR_MS = 3_600_000;
/** The longest period one read covers (the backend refuses more). */
export const MAX_RANGE_MS = 24 * HOUR_MS;
/** The most lines one read returns (the backend's cap). */
export const MAX_LOKI_LINES = 5000;

/** Characters of text kept from Loki per tab, besides the live buffer's own limit. */
export const LOKI_TEXT_LIMIT = 16 * 1024 * 1024;

const PRESET_MS: Record<Exclude<RangePreset, "custom">, number> = { "1h": HOUR_MS, "6h": 6 * HOUR_MS, "24h": MAX_RANGE_MS };

/** The range of a preset ending at `endMs`. */
export function presetRange(preset: Exclude<RangePreset, "custom">, endMs: number): LokiRange {
  return { startMs: endMs - PRESET_MS[preset], endMs };
}

/** Why a custom range cannot be read, or `null` when it can. */
export function rangeProblem(range: LokiRange | null, nowMs: number): "invalid" | "tooLong" | "future" | null {
  if (!range || !Number.isFinite(range.startMs) || !Number.isFinite(range.endMs) || range.endMs <= range.startMs) {
    return "invalid";
  }
  if (range.endMs - range.startMs > MAX_RANGE_MS) return "tooLong";
  if (range.endMs > nowMs + 5 * 60_000) return "future";
  return null;
}

/** `datetime-local` input text (local time, minutes) of a time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The time of `datetime-local` input text; `NaN` when it does not read. */
export function fromLocalInput(text: string): number {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(text) ? new Date(text).getTime() : Number.NaN;
}

// ---- timestamps: nanoseconds as decimal text (too large for a number), compared as text of equal length ----

/** `ts` padded so that two timestamps compare as text. */
export function nsKey(ts: string): string {
  return ts.padStart(20, "0");
}

/** The time as the kubelet writes it before a line with "Timestamps" on (RFC 3339, nine fraction digits, UTC). */
export function isoOfNs(ts: string): string {
  const digits = ts.padStart(10, "0");
  const seconds = Number(digits.slice(0, -9));
  const fraction = digits.slice(-9);
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`);
}

const LIVE_TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z /;

/** The timestamp (as nanoseconds) and the text of a live line read with "Timestamps" on; `null` without one. */
export function splitLiveLine(line: string): { ts: string; text: string } | null {
  const match = LIVE_TIMESTAMP.exec(line);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}Z`) / 1000;
  if (!Number.isFinite(seconds)) return null;
  return { ts: `${seconds}${(match[2] ?? "").padEnd(9, "0")}`, text: line.slice(match[0].length) };
}

/** The milliseconds of a nanosecond timestamp. */
export function msOfNs(ts: string): number {
  return Number(ts.padStart(10, "0").slice(0, -6));
}

// ---- merging ----

/** `entries` with a new page: a backward read's pages are older than what came before, a forward read's newer. */
export function withPage(entries: readonly LokiEntry[], page: readonly LokiEntry[], direction: LokiDirection): LokiEntry[] {
  return direction === "backward" ? [...page, ...entries] : [...entries, ...page];
}

/** At most `limit` characters of text, the newest lines kept (a backward read) or the oldest (forward). */
export function capText(entries: LokiEntry[], direction: LokiDirection, limit = LOKI_TEXT_LIMIT): { entries: LokiEntry[]; dropped: number } {
  let size = 0;
  const keep: LokiEntry[] = [];
  const ordered = direction === "backward" ? [...entries].reverse() : entries;
  for (const entry of ordered) {
    size += entry.line.length;
    if (size > limit && keep.length > 0) break;
    keep.push(entry);
  }
  if (direction === "backward") keep.reverse();
  return { entries: keep, dropped: entries.length - keep.length };
}

/** The lines the live view shows that a Loki line may repeat: `<ns> <text>` of live lines read with timestamps. */
export function liveKeys(lines: Iterable<string>): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    const split = splitLiveLine(line);
    if (split) keys.add(`${nsKey(split.ts)} ${split.text}`);
  }
  return keys;
}

/** `entries` without the ones the live view already shows (same timestamp and text). Only whole lines are compared:
 * a line Loki holds cut in pieces is kept. */
export function withoutLive(entries: readonly LokiEntry[], keys: ReadonlySet<string>): readonly LokiEntry[] {
  if (keys.size === 0) return entries;
  return entries.filter((e) => e.cut || !keys.has(`${nsKey(e.ts)} ${e.line}`));
}

// ---- where a read ends ----

interface ContainerStatus {
  name?: string;
  restartCount?: number;
  state?: { running?: { startedAt?: string }; terminated?: { startedAt?: string } };
  lastState?: { terminated?: { startedAt?: string } };
}

function statusOf(pod: KubeObject, container: string): ContainerStatus | undefined {
  const status = (pod as { status?: Record<string, unknown> }).status ?? {};
  const all = ["initContainerStatuses", "containerStatuses", "ephemeralContainerStatuses"].flatMap((key) =>
    Array.isArray(status[key]) ? (status[key] as ContainerStatus[]) : [],
  );
  return all.find((s) => s.name === container);
}

/**
 * When the run of `container` the live view shows began (the previous run with "Previous container" on): lines from
 * Loki end there, so they never overlap what the live view shows. `null` when the pod does not say.
 */
export function shownRunStart(pod: KubeObject, container: string, previous: boolean): number | null {
  const status = statusOf(pod, container);
  const started = previous
    ? status?.lastState?.terminated?.startedAt
    : (status?.state?.running?.startedAt ?? status?.state?.terminated?.startedAt);
  const ms = started ? Date.parse(started) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** How many times `container` restarted (0 when the pod does not say). */
export function restartsOf(pod: KubeObject, container: string): number {
  return statusOf(pod, container)?.restartCount ?? 0;
}
