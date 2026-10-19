// A mark on a cluster in the rail when its credentials have expired or expire within the warning days
// (`kubeconfig.credentialExpiryDays`); its tooltip says when. Nothing is shown when the expiry is unknown (an exec
// plugin, an opaque token) or far away.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, type ClusterId, type CredentialExpiry } from "../../../api";
import { formatDateTime } from "../../../i18n";
import { useNow } from "../../problems/hooks";
import { CREDENTIALS_REFRESH_MS, credentialDaysOf, expiryState, refreshCredentials, useCredentialsStore } from "./credentials";

/** What the kubeconfig tells about a user's credentials, in one sentence; `null` when it tells nothing. */
export function credentialText(
  t: (key: string, values?: Record<string, unknown>) => string,
  item: CredentialExpiry | undefined,
  days: number,
  now: number,
): string | null {
  if (!item) return null;
  if (item.problem) return t("kubeconfig:expiry.unreadable");
  const state = expiryState(item, days, now);
  if (state !== "unknown" && item.expiresAt) {
    const date = formatDateTime(item.expiresAt);
    return t(`kubeconfig:expiry.${state}`, { date });
  }
  if (item.kind === "oidcToken" && item.refreshable) return t("kubeconfig:expiry.oidcRefresh");
  if (item.kind === "exec" && item.command) return t("kubeconfig:expiry.exec", { command: item.command });
  if (item.kind === "authProvider" && item.command) return t("kubeconfig:expiry.provider", { command: item.command });
  return null;
}

/** Reads the credentials whenever the cluster list was read again (`clusters` changes) and every hour. */
export function useCredentialRefresh(clusters: unknown): void {
  useEffect(() => {
    void refreshCredentials();
  }, [clusters]);
  useEffect(() => {
    const timer = setInterval(() => void refreshCredentials(), CREDENTIALS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
}

export function ExpiryBadge({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const item = useCredentialsStore((s) => s.byCluster[clusterId]);
  const now = useNow(60_000);
  const state = expiryState(item, credentialDaysOf(settings), now);
  if (state !== "expired" && state !== "expiring") return null;
  const text = credentialText(t, item, credentialDaysOf(settings), now) ?? "";
  return (
    <span
      className="cluster-icon__credentials"
      data-state={state}
      role="img"
      aria-label={t(state === "expired" ? "kubeconfig:expiry.badgeExpired" : "kubeconfig:expiry.badge")}
      title={text}
    />
  );
}
