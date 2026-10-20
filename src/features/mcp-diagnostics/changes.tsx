// `get_recent_changes`: what the change recorder already holds (ADR-0079), newest first, with "soon after" problems
// from the problem sources the window already holds. Nothing is watched for it — not for recording, not for problems.
import type { ClusterId, ReadRule } from "../../api";
import { sourcesOf } from "../problems/store";
import { correlate, signalsOf } from "../timeline/correlate";
import { friendlyManager, SEXTANT_MANAGER, type Who } from "../timeline/model";
import { getTimeline, type ChangeEntry } from "../timeline/recorder";
import { iso } from "./english";
import { canRead, objectName } from "./scope";
import { useAnswer, type WorkerProps } from "./worker";

interface Args {
  namespace: string | null;
  kind: string | null;
  group: string | null;
  name: string | null;
  limit: number;
}

const managerName = (manager: string) => (manager === SEXTANT_MANAGER ? "Sextant" : (friendlyManager(manager) ?? manager));

function whoOut(who: Who | null | undefined): { who: string[]; whoIsAGuess: boolean } {
  if (!who) return { who: [], whoIsAGuess: false };
  return { who: [...new Set(who.managers.map((m) => managerName(m.manager)))], whoIsAGuess: !who.exact };
}

const matches = (e: ChangeEntry, args: Args) =>
  (!args.namespace || e.namespace === args.namespace) &&
  (!args.kind || e.kind.kind.toLowerCase() === args.kind.toLowerCase()) &&
  (args.group === null || e.kind.group === args.group) &&
  (!args.name || e.name === args.name);

/** The recorded changes the agent may see, newest first, at most `args.limit` (and whether more matched). */
export function recentChanges(clusterId: ClusterId, reads: readonly ReadRule[], args: Args) {
  const signals = signalsOf(sourcesOf(clusterId)).filter((s) => canRead(reads, s.object.kind, s.object.namespace ?? null));
  const entries = getTimeline(clusterId);
  const changes = [];
  let truncated = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!matches(e, args) || !canRead(reads, e.kind, e.namespace)) continue;
    if (changes.length >= args.limit) {
      truncated = true;
      break;
    }
    const soonAfter = correlate({ at: e.at, kind: e.kind, namespace: e.namespace, name: e.name }, signals).map((c) => ({
      type: c.signal.type,
      reason: c.signal.reason,
      object: objectName(c.signal.object.kind, c.signal.object.namespace, c.signal.object.name),
      afterSeconds: Math.round(c.delayMs / 1000),
      via: c.via,
    }));
    changes.push({
      at: iso(e.at),
      late: e.late,
      action: e.action,
      object: objectName(e.kind, e.namespace, e.name),
      changes: e.changes.map((c) => ({ path: c.path, op: c.op, before: c.before, after: c.after, long: c.long === true })),
      more: e.more,
      summaryOnly: e.summaryOnly === true,
      ...whoOut(e.who),
      soonAfter,
    });
  }
  return { changes, truncated };
}

export function ChangesWorker(props: WorkerProps) {
  const { request } = props;
  useAnswer(props, true, () => recentChanges(request.clusterId, request.reads, request.args as unknown as Args));
  return null;
}
