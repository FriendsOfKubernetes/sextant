// The opt-in "Credentials" notifications (#150): while notifications are on and the category is turned on
// (`notifications.enabledCategories`, off by default), each cluster that is not muted becomes one source of the
// notifier with up to two problems from its kubeconfig — "expiring" from the warning days before the expiry, and
// "expired" from the expiry. The notifier's rules apply (a quiet first look, one notification per state, mute).
// Nothing is connected or watched for it: the expiry comes from `kubeconfig_credentials`. Draws nothing.
import { useEffect, useMemo, useRef } from "react";
import { useSettings, type ClusterInfo, type CredentialExpiry, type ObjectRef } from "../../../api";
import { formatDateTime, i18n } from "../../../i18n";
import { LOCAL_GROUP, notifier } from "../../notifications/notifier";
import { categoryOn, prefsOf } from "../../notifications/prefs";
import { useNow } from "../../problems/hooks";
import type { Problem } from "../../problems/model";
import { useClustersStore } from "../clustersStore";
import { credentialDaysOf, useCredentialsStore, warnFrom } from "./credentials";

export const CREDENTIALS_CATEGORY = "credentials";

/** The pseudo-object a credentials notification is about: the kubeconfig context (never opened as an object). */
export function contextObject(cluster: Pick<ClusterInfo, "context">): ObjectRef {
  return { kind: { group: LOCAL_GROUP, version: "v1", kind: "Kubeconfig" }, namespace: null, name: cluster.context };
}

/** The notifier's problems of one cluster's credentials; none when the expiry is unknown. */
export function credentialProblems(cluster: ClusterInfo, item: CredentialExpiry | undefined, days: number, now: number): Problem[] {
  if (!item?.expiresAt) return [];
  const expiresAt = Date.parse(item.expiresAt);
  const from = warnFrom(item, days);
  if (Number.isNaN(expiresAt) || from === null) return [];
  const date = formatDateTime(expiresAt);
  const base = {
    category: "credentials" as const,
    uid: cluster.id,
    object: contextObject(cluster),
    notify: true,
    firstSeen: now,
    expiresAt,
  };
  return [
    {
      ...base,
      key: `${cluster.id}|CredentialsExpiring`,
      notifyKey: `${cluster.id}|CredentialsExpiring`,
      reason: "CredentialsExpiring",
      message: i18n.t("kubeconfig:expiry.notifyExpiring", { context: cluster.context, date }),
      activeFrom: from,
      activeAt: from,
      until: expiresAt,
    },
    {
      ...base,
      key: `${cluster.id}|CredentialsExpired`,
      notifyKey: `${cluster.id}|CredentialsExpired`,
      reason: "CredentialsExpired",
      message: i18n.t("kubeconfig:expiry.notifyExpired", { context: cluster.context, date }),
      activeFrom: expiresAt,
      activeAt: expiresAt,
    },
  ];
}

export function CredentialsNotifier() {
  const { settings } = useSettings();
  const clusters = useClustersStore((s) => s.clusters);
  const byCluster = useCredentialsStore((s) => s.byCluster);
  const now = useNow(60_000);
  const prefs = useMemo(() => prefsOf(settings), [settings]);
  const on = !!prefs && prefs.enabled && categoryOn(prefs, CREDENTIALS_CATEGORY);
  const days = credentialDaysOf(settings);
  const looked = useRef(new Set<string>());

  useEffect(() => {
    const keys = new Set<string>();
    if (on) {
      for (const cluster of clusters) {
        if (prefs.mutedClusters.has(cluster.id)) continue;
        const key = `${cluster.id}|credentials`;
        keys.add(key);
        notifier.observe({
          key,
          clusterId: cluster.id,
          status: "ready",
          problems: credentialProblems(cluster, byCluster[cluster.id], days, now),
        } as Parameters<typeof notifier.observe>[0]);
      }
    }
    for (const key of looked.current) if (!keys.has(key)) notifier.forget(key);
    looked.current = keys;
  }, [on, prefs, clusters, byCluster, days, now]);

  useEffect(() => {
    const seen = looked;
    return () => {
      for (const key of seen.current) notifier.forget(key);
      seen.current = new Set();
    };
  }, []);
  return null;
}
