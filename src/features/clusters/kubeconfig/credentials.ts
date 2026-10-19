// When each cluster's credentials expire, as the kubeconfig tells (#150): read by the backend without running
// anything (`kubeconfig_credentials`), again whenever the cluster list is read and once an hour. Shown as a badge on
// the cluster in the rail and fed to the opt-in "Credentials" notifications.
import { create } from "zustand";
import { api, type AppSettings, type ClusterId, type CredentialExpiry } from "../../../api";

export const DEFAULT_CREDENTIAL_EXPIRY_DAYS = 14;
export const MIN_CREDENTIAL_EXPIRY_DAYS = 1;
export const MAX_CREDENTIAL_EXPIRY_DAYS = 365;
const DAY_MS = 24 * 3600_000;
/** How often the expiry is read again while the app runs. */
export const CREDENTIALS_REFRESH_MS = 3600_000;

interface CredentialsState {
  byCluster: Record<ClusterId, CredentialExpiry>;
}

export const useCredentialsStore = create<CredentialsState>()(() => ({ byCluster: {} }));

let seq = 0;

/** Reads the expiry of every cluster again; a failure keeps what was known. */
export async function refreshCredentials(): Promise<void> {
  const mine = ++seq;
  try {
    const list = await api.kubeconfig.credentials();
    if (mine !== seq) return;
    useCredentialsStore.setState({ byCluster: Object.fromEntries(list.map((c) => [c.clusterId, c])) });
  } catch {
    // Not known now: the badges stay as they were.
  }
}

export function resetCredentials(): void {
  seq++;
  useCredentialsStore.setState({ byCluster: {} }, true);
}

/** The setting within its bounds; anything unreadable is the default. */
export function clampCredentialDays(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return DEFAULT_CREDENTIAL_EXPIRY_DAYS;
  return Math.min(MAX_CREDENTIAL_EXPIRY_DAYS, Math.max(MIN_CREDENTIAL_EXPIRY_DAYS, Math.round(n)));
}

export function credentialDaysOf(settings: AppSettings | null): number {
  return clampCredentialDays(settings?.kubeconfig?.credentialExpiryDays);
}

export type ExpiryState = "expired" | "expiring" | "valid" | "unknown";

/** Whether the credentials have expired, expire within `days`, are valid longer, or nobody can tell. */
export function expiryState(item: CredentialExpiry | undefined, days: number, now: number): ExpiryState {
  const at = item?.expiresAt ? Date.parse(item.expiresAt) : NaN;
  if (Number.isNaN(at)) return "unknown";
  if (at <= now) return "expired";
  return at - now <= days * DAY_MS ? "expiring" : "valid";
}

/** The time (ms) from which the credentials count as expiring; `null` when the expiry is unknown. */
export function warnFrom(item: CredentialExpiry, days: number): number | null {
  const at = item.expiresAt ? Date.parse(item.expiresAt) : NaN;
  return Number.isNaN(at) ? null : at - days * DAY_MS;
}
