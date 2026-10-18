// Change timeline (#145): what went wrong soon after a change, on the changed object or on what depends on it — "pods
// started failing 2 min after this change". Pure functions; the signals come from the problem sources the window
// already watches (`features/problems`: problems and Warning events), the relations from the resource map's graph
// (`features/resource-map/relations.ts`) when the namespace is watched, else from owner names.
import type { KindRef, ObjectRef } from "../../api";
import { startedAt, type Problem } from "../problems/model";
import type { SourceState } from "../problems/store";
import { keyOf, type Graph } from "../resource-map/relations";

/** Something that went wrong, at a time. */
export interface Signal {
  /** A problem of the problems screen, or a Warning event. */
  type: "problem" | "warning";
  reason: string;
  object: ObjectRef;
  /** When it began (ms). */
  at: number;
}

/** How a signal's object relates to the changed one. */
export type Via = "same" | "dependent";

export interface Correlation {
  signal: Signal;
  /** From the change to the signal (ms); may be a little below zero (two clocks). */
  delayMs: number;
  via: Via;
}

/** A signal counts when it began at most this long after the change… */
export const CORRELATION_WINDOW_MS = 30 * 60_000;
/** …and at least this long before it (the cluster's clock and this machine's differ a little). */
export const CLOCK_SLACK_MS = 60_000;
/** Correlations listed per change at most. */
export const MAX_CORRELATIONS = 5;
/** Hops followed from a changed object to what depends on it. */
const MAX_HOPS = 3;
/** Objects reached from a changed object at most. */
const MAX_REACHED = 500;

/** The signals of the problem sources: their problems, a Warning event's as a warning. */
export function signalsOf(sources: readonly SourceState[]): Signal[] {
  const out: Signal[] = [];
  for (const source of sources) {
    for (const p of source.problems) out.push(signalOf(p));
  }
  return out;
}

function signalOf(p: Problem): Signal {
  return {
    type: p.category === "events" ? "warning" : "problem",
    reason: p.reason,
    object: p.object,
    at: startedAt(p),
  };
}

export interface Subject {
  at: number;
  kind: Pick<KindRef, "group" | "kind">;
  namespace: string | null;
  name: string;
}

const refKey = (r: { kind: Pick<KindRef, "group" | "kind">; namespace: string | null; name: string }) =>
  keyOf({ group: r.kind.group, kind: r.kind.kind, namespace: r.namespace, name: r.name });

/**
 * The keys (`keyOf`) of what depends on `subject` in `graph`: what names or owns it, hop by hop (a ConfigMap → the
 * pods that mount it; a Deployment → its ReplicaSets → their pods), and what an autoscaler, a Service or a policy
 * picks (an HPA → its target → …).
 */
export function dependents(graph: Graph | null, subject: Omit<Subject, "at">): Set<string> {
  const start = refKey(subject);
  const reached = new Set<string>();
  if (!graph || !graph.nodes.has(start)) return reached;
  let frontier = [start];
  for (let hop = 0; hop < MAX_HOPS && frontier.length > 0 && reached.size < MAX_REACHED; hop++) {
    const next: string[] = [];
    for (const key of frontier) {
      const edges = [
        ...(graph.in.get(key) ?? []).map((e) => e.from),
        ...(hop === 0
          ? (graph.out.get(key) ?? []).filter((e) => e.relation === "scales" || e.relation === "selects").map((e) => e.to)
          : []),
      ];
      for (const other of edges) {
        if (other === start || reached.has(other)) continue;
        reached.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return reached;
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "ReplicaSet"]);

/** Without a graph: a pod or Job named after a workload in its namespace is taken as one of its own. */
function namedAfter(subject: Omit<Subject, "at">, object: ObjectRef): boolean {
  if (!WORKLOADS.has(subject.kind.kind) || subject.kind.group !== (subject.kind.kind === "Job" || subject.kind.kind === "CronJob" ? "batch" : "apps")) {
    return false;
  }
  if (object.namespace !== subject.namespace) return false;
  return ["Pod", "Job", "ReplicaSet"].includes(object.kind.kind) && object.name.startsWith(`${subject.name}-`);
}

/**
 * The signals that began soon after the change (within `CORRELATION_WINDOW_MS`, allowing `CLOCK_SLACK_MS` before it)
 * on the changed object or on what depends on it; the earliest first, at most `MAX_CORRELATIONS`.
 */
export function correlate(
  subject: Subject,
  signals: readonly Signal[],
  related: ReadonlySet<string> = new Set(),
): Correlation[] {
  const self = refKey(subject);
  const out: Correlation[] = [];
  for (const signal of signals) {
    const delayMs = signal.at - subject.at;
    if (delayMs < -CLOCK_SLACK_MS || delayMs > CORRELATION_WINDOW_MS) continue;
    const key = refKey(signal.object);
    const via: Via | null =
      key === self ? "same" : related.has(key) || namedAfter(subject, signal.object) ? "dependent" : null;
    if (via) out.push({ signal, delayMs, via });
  }
  out.sort((a, b) => a.delayMs - b.delayMs);
  // One line per object and reason: a crash loop is one story, not one per restart.
  const seen = new Set<string>();
  return out
    .filter((c) => {
      const id = `${refKey(c.signal.object)}|${c.signal.reason}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, MAX_CORRELATIONS);
}
