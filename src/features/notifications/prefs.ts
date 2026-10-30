// The notification settings (`AppSettings.notifications`, written here by the frontend) as the notifier reads them:
// the global switch, the categories turned off, the muted clusters and "Mute for 1 hour".
import type { AppSettings, ClusterId } from "../../api";
import { isOptIn, NOTIFY_CATEGORIES, type ProblemCategory } from "../problems/model";

/** "Mute for 1 hour". */
export const MUTE_MS = 3600_000;

export interface NotificationPrefs {
  enabled: boolean;
  disabledCategories: ReadonlySet<string>;
  /** Opt-in categories turned on (`OPT_IN_CATEGORIES`: off until then). */
  enabledCategories: ReadonlySet<string>;
  mutedClusters: ReadonlySet<string>;
  /** Nothing is shown before this time (ms); `null`: not muted. */
  mutedUntil: number | null;
}

/** The settings as the notifier reads them; `null` while they have not loaded (nothing is watched then). */
export function prefsOf(settings: AppSettings | null): NotificationPrefs | null {
  if (!settings) return null;
  const n = settings.notifications;
  const until = n.mutedUntil ? Date.parse(n.mutedUntil) : NaN;
  return {
    enabled: n.enabled,
    disabledCategories: new Set(n.disabledCategories),
    enabledCategories: new Set(n.enabledCategories ?? []),
    mutedClusters: new Set(n.mutedClusters),
    mutedUntil: Number.isNaN(until) ? null : until,
  };
}

/** The categories that notify: every notifying category (Sextant's and `extensions`') the user did not turn off. */
export function enabledCategories(prefs: NotificationPrefs, extensions: readonly ProblemCategory[] = []): ProblemCategory[] {
  return [...NOTIFY_CATEGORIES, ...extensions].filter((c) => categoryOn(prefs, c));
}

/** Whether a category notifies: an opt-in one once turned on, any other until turned off. */
export function categoryOn(prefs: Pick<NotificationPrefs, "disabledCategories" | "enabledCategories">, category: ProblemCategory): boolean {
  return isOptIn(category) ? prefs.enabledCategories.has(category) : !prefs.disabledCategories.has(category);
}

export function mutedNow(prefs: NotificationPrefs, now: number): boolean {
  return prefs.mutedUntil !== null && now < prefs.mutedUntil;
}

/** Why a notification about a problem of `category` in the cluster is not shown now, if it is not. */
export function suppressedBy(
  prefs: NotificationPrefs | null,
  clusterId: ClusterId,
  category: ProblemCategory,
  now: number,
): "off" | "category" | "cluster" | "muted" | null {
  if (!prefs || !prefs.enabled) return "off";
  if (!categoryOn(prefs, category)) return "category";
  if (prefs.mutedClusters.has(clusterId)) return "cluster";
  if (mutedNow(prefs, now)) return "muted";
  return null;
}

type Change = (current: AppSettings) => AppSettings;

const patch =
  (fn: (n: AppSettings["notifications"]) => Partial<AppSettings["notifications"]>): Change =>
  (s) => ({ ...s, notifications: { ...s.notifications, ...fn(s.notifications) } });

export const setEnabled = (enabled: boolean): Change => patch(() => ({ enabled }));

export const setCategory = (category: ProblemCategory, on: boolean): Change =>
  isOptIn(category)
    ? patch((n) => {
        const others = (n.enabledCategories ?? []).filter((c) => c !== category);
        return { enabledCategories: on ? [...others, category] : others };
      })
    : patch((n) => ({
        disabledCategories: on
          ? n.disabledCategories.filter((c) => c !== category)
          : [...n.disabledCategories.filter((c) => c !== category), category],
      }));

export const setClusterMuted = (clusterId: ClusterId, muted: boolean): Change =>
  patch((n) => ({
    mutedClusters: muted
      ? [...n.mutedClusters.filter((c) => c !== clusterId), clusterId]
      : n.mutedClusters.filter((c) => c !== clusterId),
  }));

/** "Mute for 1 hour" from `now`. */
export const muteForHour = (now: number): Change => patch(() => ({ mutedUntil: new Date(now + MUTE_MS).toISOString() }));

export const unmute = (): Change => patch(() => ({ mutedUntil: null }));
