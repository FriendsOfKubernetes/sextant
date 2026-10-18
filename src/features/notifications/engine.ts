// Turns problem transitions into desktop notifications (#135). Rules:
// - quiet start: the first look at a source (a cluster connected, a category turned on, the app started) only notes
//   the problems already there; only problems that start afterwards notify;
// - one notification per object and state (`Problem.notifyKey`): a state told is not told again while it lasts, nor
//   when it comes back within `COOLDOWN_MS` of when it was last seen, so a flapping condition notifies once;
// - grouping and rate limit: what starts within `GROUP_WINDOW_MS` is shown together — one by one up to
//   `GROUP_LIMIT`, else as one summary — and at most `MAX_PER_MINUTE` notifications go out per minute (the rest wait
//   for the next minute and are grouped the same way);
// - "Mute for 1 hour" and the settings are read when a notification is due: what is muted goes only to the history.
// Every notification due (shown, summarised or muted) is kept in a history of the last `HISTORY_LIMIT`.
import type { ClusterId, DesktopNotification, ObjectRef } from "../../api";
import { formatList, i18n } from "../../i18n";
import { isActive, type Problem, type ProblemCategory } from "../problems/model";
import type { SourceState } from "../problems/store";
import { suppressedBy, type NotificationPrefs } from "./prefs";

export const GROUP_WINDOW_MS = 3000;
/** More problems than this at once are shown as one summary. */
export const GROUP_LIMIT = 3;
export const MAX_PER_MINUTE = 6;
export const COOLDOWN_MS = 30 * 60_000;
export const HISTORY_LIMIT = 100;
/** Bounds of what the notifier remembers (states told within the cooldown, notifications waiting). */
const MAX_REMEMBERED = 5000;
const MAX_PENDING = 500;
const MESSAGE_LIMIT = 200;
const TITLE_LIMIT = 100;

/** Action type of the notifications (its button: "Mute for 1 hour"). */
export const ACTION_TYPE = "sextant-problem";
export const MUTE_ACTION = "mute-hour";

export type Delivery = "shown" | "summary" | "muted";

export interface HistoryEntry {
  id: number;
  /** When it was due (ms). */
  at: number;
  clusterId: ClusterId;
  category: ProblemCategory;
  reason: string;
  object: ObjectRef;
  message?: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  delivery: Delivery;
}

export interface EngineDeps {
  now: () => number;
  show: (notification: DesktopNotification) => void;
  /** Runs `fn` after `ms`; returns a function that cancels it. */
  schedule: (fn: () => void, ms: number) => () => void;
  clusterName: (clusterId: ClusterId) => string;
}

interface Candidate {
  clusterId: ClusterId;
  sourceKey: string;
  problem: Problem;
}

/** The text of a problem's message: the cluster's own, or the one Sextant writes. */
export function messageText(p: Pick<Problem, "message" | "messageKey" | "messageParams">): string {
  if (p.message) return p.message;
  return p.messageKey ? i18n.t(`problems:${p.messageKey}`, p.messageParams) : "";
}

/** At most `limit` characters (code points: a surrogate pair is never split), with an ellipsis when cut. */
export function clip(text: string, limit = MESSAGE_LIMIT): string {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
}

/**
 * Text from the cluster made inert for the notification service: Linux servers read a body as markup, so `<a href>`
 * in a condition message would become a link. `&`, `<` and `>` become look-alikes, which read the same on every
 * platform (an entity would show as `&amp;` on macOS and Windows).
 */
export function inert(text: string): string {
  return text.replace(/&/g, "\uff06").replace(/</g, "\u2039").replace(/>/g, "\u203a");
}

function objectText(o: ObjectRef): string {
  return o.namespace ? `${o.kind.kind} ${o.namespace}/${o.name}` : `${o.kind.kind} ${o.name}`;
}

export class NotificationEngine {
  private prefs: NotificationPrefs | null = null;
  /** Per source: the notify keys present at its first look (not told), minus those gone since. */
  private baselines = new Map<string, Set<string>>();
  /** Per source: the notify keys told (or muted) that have been present ever since. */
  private lasting = new Map<string, Set<string>>();
  /** Per source: the notify keys that count now, as of the last look (a due notification still has to be there). */
  private current = new Map<string, Set<string>>();
  private failure: string | null = null;
  /** `cluster|notifyKey` of the states told → when each was last seen. */
  private told = new Map<string, number>();
  private pending: Candidate[] = [];
  private sent: number[] = [];
  private cancel: (() => void) | undefined;
  private entries: HistoryEntry[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly deps: EngineDeps) {}

  setPrefs(prefs: NotificationPrefs | null): void {
    this.prefs = prefs;
  }

  /** Looks at a source's problems now; the first look of a source only notes what is there. */
  observe(source: Pick<SourceState, "key" | "clusterId" | "status" | "problems">, now = this.deps.now()): void {
    if (source.status === "loading" || source.status === "error") return;
    this.current.set(
      source.key,
      new Set(source.problems.filter((p) => p.notify && isActive(p, now)).map((p) => p.notifyKey)),
    );
    const baseline = this.baselines.get(source.key);
    if (!baseline) {
      this.baselines.set(
        source.key,
        new Set(source.problems.filter((p) => isActive(p, now)).map((p) => p.notifyKey)),
      );
      return;
    }
    const present = new Set(source.problems.map((p) => p.notifyKey));
    for (const key of baseline) if (!present.has(key)) baseline.delete(key);
    let lasting = this.lasting.get(source.key);
    if (!lasting) this.lasting.set(source.key, (lasting = new Set()));
    for (const key of lasting) if (!present.has(key)) lasting.delete(key);
    for (const p of source.problems) {
      if (!p.notify || baseline.has(p.notifyKey) || !isActive(p, now)) continue;
      const id = `${source.clusterId}|${p.notifyKey}`;
      // Told before and still there, or back within the cooldown: only noted as seen now.
      const last = this.told.get(id);
      const again = !lasting.has(p.notifyKey) && (last === undefined || now - last >= COOLDOWN_MS);
      lasting.add(p.notifyKey);
      this.told.delete(id);
      this.told.set(id, now);
      if (this.told.size > MAX_REMEMBERED) {
        const oldest = this.told.keys().next().value;
        if (oldest !== undefined) this.told.delete(oldest);
      }
      if (again) this.enqueue({ clusterId: source.clusterId, sourceKey: source.key, problem: p });
    }
  }

  /** The source is no longer watched: its next first look is quiet again. */
  forget(sourceKey: string): void {
    this.baselines.delete(sourceKey);
    this.lasting.delete(sourceKey);
    this.current.delete(sourceKey);
  }

  private enqueue(candidate: Candidate): void {
    this.pending.push(candidate);
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    if (!this.cancel) this.cancel = this.deps.schedule(() => this.flush(), GROUP_WINDOW_MS);
  }

  /** Shows (or mutes) what is due; called by the timer `enqueue` sets. */
  flush(): void {
    this.cancel?.();
    this.cancel = undefined;
    const now = this.deps.now();
    // What went away (or whose source is no longer watched) while it waited is not told.
    const due = this.pending.filter((c) => this.current.get(c.sourceKey)?.has(c.problem.notifyKey));
    this.pending = [];
    const deliver: Candidate[] = [];
    for (const c of due) {
      if (suppressedBy(this.prefs, c.clusterId, c.problem.category, now)) this.record(c, "muted", now);
      else deliver.push(c);
    }
    if (deliver.length === 0) return;
    this.sent = this.sent.filter((t) => now - t < 60_000);
    const budget = MAX_PER_MINUTE - this.sent.length;
    if (budget <= 0) {
      // Over the limit: they wait for the oldest of the last minute's notifications to age out.
      this.pending = deliver;
      const wait = Math.max(GROUP_WINDOW_MS, (this.sent[0] ?? now) + 60_000 - now);
      this.cancel = this.deps.schedule(() => this.flush(), wait);
      return;
    }
    if (deliver.length <= Math.min(GROUP_LIMIT, budget)) {
      for (const c of deliver) {
        this.showOne(c);
        this.sent.push(now);
        this.record(c, "shown", now);
      }
      return;
    }
    this.showSummary(deliver);
    this.sent.push(now);
    for (const c of deliver) this.record(c, "summary", now);
  }

  private showOne({ clusterId, problem }: Candidate): void {
    const message = messageText(problem);
    this.deps.show({
      id: this.nextId(),
      title: inert(
        clip(
          i18n.t("notifications:single.title", { cluster: this.deps.clusterName(clusterId), reason: problem.reason }),
          TITLE_LIMIT,
        ),
      ),
      body: inert(clip(message ? `${objectText(problem.object)}\n${message}` : objectText(problem.object))),
      actionTypeId: ACTION_TYPE,
      extra: { clusterId, object: problem.object },
    });
  }

  private showSummary(items: Candidate[]): void {
    // Clusters by how many problems they bring: a click opens the one with the most.
    const perCluster = new Map<ClusterId, number>();
    for (const c of items) perCluster.set(c.clusterId, (perCluster.get(c.clusterId) ?? 0) + 1);
    const clusters = [...perCluster.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const reasons = new Map<string, number>();
    for (const c of items) reasons.set(c.problem.reason, (reasons.get(c.problem.reason) ?? 0) + 1);
    const tally = [...reasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => i18n.t("notifications:summary.reason", { reason, count }));
    const only = clusters.length === 1 ? clusters[0] : undefined;
    const title = only
      ? i18n.t("notifications:summary.title", { count: items.length, cluster: this.deps.clusterName(only) })
      : i18n.t("notifications:summary.titleClusters", { count: items.length, clusters: clusters.length });
    this.deps.show({
      id: this.nextId(),
      title: inert(clip(title, TITLE_LIMIT)),
      body: inert(clip(formatList(tally))),
      actionTypeId: ACTION_TYPE,
      extra: { clusterId: clusters[0], object: null },
    });
  }

  private nextId(): number {
    // A 32-bit integer the platform keeps apart from other apps' notifications.
    return (Math.floor(Math.random() * 0x7fff0000) + this.seq) | 0;
  }

  private record({ clusterId, problem }: Candidate, delivery: Delivery, now: number): void {
    this.entries = [
      {
        id: ++this.seq,
        at: now,
        clusterId,
        category: problem.category,
        reason: problem.reason,
        object: problem.object,
        message: problem.message ? clip(problem.message) : undefined,
        messageKey: problem.messageKey,
        messageParams: problem.messageParams,
        delivery,
      },
      ...this.entries,
    ].slice(0, HISTORY_LIMIT);
    for (const fn of [...this.listeners]) fn();
  }

  /** Newest first. */
  history(): readonly HistoryEntry[] {
    return this.entries;
  }

  /** Something the user asked of a notification failed (saving "Mute for 1 hour"); shown with the history. */
  setFailure(text: string | null): void {
    this.failure = text;
    for (const fn of [...this.listeners]) fn();
  }

  lastFailure(): string | null {
    return this.failure;
  }

  clearHistory(): void {
    this.entries = [];
    for (const fn of [...this.listeners]) fn();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Forgets everything and cancels a pending flush (tests, a fresh start). */
  reset(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.prefs = null;
    this.baselines.clear();
    this.lasting.clear();
    this.current.clear();
    this.failure = null;
    this.told.clear();
    this.pending = [];
    this.sent = [];
    this.entries = [];
    this.seq = 0;
    for (const fn of [...this.listeners]) fn();
  }
}
