// Change timeline (#145): the rows the page and the "Changes" tab list — recorded changes and the partial history the
// cluster still keeps, in one list, newest first, filtered. Pure.
import type { HistoryEntry, KindRef } from "../../api";
import { CLOCK_SLACK_MS, correlate, CORRELATION_WINDOW_MS, type Correlation, type Signal } from "./correlate";
import type { ChangeEntry } from "./recorder";

export type TimelineItem =
  | { type: "recorded"; key: string; at: number; entry: ChangeEntry; correlations: Correlation[] }
  | { type: "partial"; key: string; at: number; entry: HistoryEntry; correlations: Correlation[] };

export interface TimelineFilters {
  /** `null`: every namespace. Cluster-scoped objects are shown with any choice. */
  namespaces: readonly string[] | null;
  /** `group/kind`, or `null` for every kind. */
  kind: string | null;
  /** A field manager's name, or `null` for anyone. */
  manager: string | null;
  /** Only changes followed by a problem or a Warning event. */
  onlyBeforeProblems: boolean;
  /** List the partial history too. */
  partial: boolean;
}

export const ALL: TimelineFilters = { namespaces: null, kind: null, manager: null, onlyBeforeProblems: false, partial: true };

export const kindId = (kind: Pick<KindRef, "group" | "kind">) => `${kind.group}/${kind.kind}`;

/** The object an item is about (a revision's workload, when it has one). */
export function subjectOf(item: TimelineItem): { kind: KindRef; namespace: string | null; name: string } {
  if (item.type === "recorded") return { kind: item.entry.kind, namespace: item.entry.namespace, name: item.entry.name };
  const e = item.entry;
  const target = e.source === "revision" && e.owner ? e.owner : e.object;
  return { kind: target.kind, namespace: target.namespace, name: target.name };
}

/** The field managers an item names. */
export function managersOf(item: TimelineItem): string[] {
  if (item.type === "partial") return item.entry.manager ? [item.entry.manager] : [];
  return item.entry.who?.managers.map((m) => m.manager) ?? [];
}

function partialTime(entry: HistoryEntry): number {
  const t = Date.parse(entry.time);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The partial history without what the recording already tells: a manager's last change at (about) the time of a
 * recorded change of the same object is that change.
 */
function notRecorded(entry: HistoryEntry, recorded: readonly ChangeEntry[]): boolean {
  if (entry.source !== "fieldManager") return true;
  const at = partialTime(entry);
  return !recorded.some(
    (r) =>
      r.name === entry.object.name &&
      r.namespace === entry.object.namespace &&
      r.kind.kind === entry.object.kind.kind &&
      Math.abs(r.at - at) < 120_000 &&
      (r.who?.managers.some((m) => m.manager === entry.manager) ?? false),
  );
}

/** The rows of `recorded` and `partial` that pass `filters`, newest first, each with what went wrong soon after it. */
export function buildItems(
  recorded: readonly ChangeEntry[],
  partial: readonly HistoryEntry[],
  filters: TimelineFilters,
  signals: readonly Signal[],
  relatedTo: (subject: { kind: KindRef; namespace: string | null; name: string }) => ReadonlySet<string> = () => new Set(),
): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const entry of recorded) {
    items.push({ type: "recorded", key: `r${entry.id}`, at: entry.at, entry, correlations: [] });
  }
  if (filters.partial) {
    partial.forEach((entry, i) => {
      if (notRecorded(entry, recorded)) items.push({ type: "partial", key: `p${i}`, at: partialTime(entry), entry, correlations: [] });
    });
  }
  const namespaces = filters.namespaces ? new Set(filters.namespaces) : null;
  const sorted = [...signals].sort((a, b) => a.at - b.at);
  /** The signals that began near `at`: only these can be about a change at `at`. */
  const near = (at: number): Signal[] => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.at < at - CLOCK_SLACK_MS) lo = mid + 1;
      else hi = mid;
    }
    const out: Signal[] = [];
    for (let i = lo; i < sorted.length && sorted[i]!.at <= at + CORRELATION_WINDOW_MS; i++) out.push(sorted[i]!);
    return out;
  };
  const related = new Map<string, ReadonlySet<string>>();
  const relatedOf = (subject: { kind: KindRef; namespace: string | null; name: string }) => {
    const id = `${kindId(subject.kind)}|${subject.namespace ?? ""}|${subject.name}`;
    let found = related.get(id);
    if (!found) related.set(id, (found = relatedTo(subject)));
    return found;
  };
  const out: TimelineItem[] = [];
  for (const item of items) {
    const subject = subjectOf(item);
    if (namespaces && subject.namespace !== null && !namespaces.has(subject.namespace)) continue;
    if (filters.kind && kindId(subject.kind) !== filters.kind) continue;
    if (filters.manager && !managersOf(item).includes(filters.manager)) continue;
    const candidates = near(item.at);
    const correlations = candidates.length > 0 ? correlate({ ...subject, at: item.at }, candidates, relatedOf(subject)) : [];
    if (filters.onlyBeforeProblems && correlations.length === 0) continue;
    out.push({ ...item, correlations });
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

/** The kinds and managers the rows name, for the filters' choices. */
export function choicesOf(recorded: readonly ChangeEntry[], partial: readonly HistoryEntry[]): { kinds: string[]; managers: string[] } {
  const kinds = new Set<string>();
  const managers = new Set<string>();
  for (const e of recorded) {
    kinds.add(kindId(e.kind));
    for (const m of e.who?.managers ?? []) managers.add(m.manager);
  }
  for (const e of partial) {
    kinds.add(kindId(e.source === "revision" && e.owner ? e.owner.kind : e.object.kind));
    if (e.manager) managers.add(e.manager);
  }
  return { kinds: [...kinds].sort(), managers: [...managers].sort() };
}
