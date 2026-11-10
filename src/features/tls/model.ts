// When a certificate expires, as the TLS views tell it (ADR-0069): the TLS certificates page and the "Certificate"
// section of TLS Secrets. "Expiring" means within `notifications.certExpiryDays` (Settings → Notifications), the
// setting the problem rules use too (`src/features/problems/model.ts`; extensions' `expiring` conditions).
import type { Tone } from "../../resources/status";

export const DAY_MS = 24 * 3600_000;
// The expiry warning setting's bounds and default are the problems rules' (one source for both).
export { clampExpiryDays, DEFAULT_CERT_EXPIRY_DAYS, MAX_CERT_EXPIRY_DAYS, MIN_CERT_EXPIRY_DAYS } from "../problems/model";

export type ExpiryState = "expired" | "expiring" | "valid" | "notYetValid";

export interface Expiry {
  state: ExpiryState;
  /** Whole days until `notAfter` (rounded down; negative once expired). */
  daysLeft: number;
}

/** How a certificate valid `notBefore`..`notAfter` stands at `now`, warning `warnDays` ahead. */
export function expiryOf(notAfter: string | undefined, now: number, warnDays: number, notBefore?: string): Expiry | undefined {
  const end = notAfter ? Date.parse(notAfter) : NaN;
  if (Number.isNaN(end)) return undefined;
  const left = end - now;
  const daysLeft = Math.floor(left / DAY_MS);
  if (left <= 0) return { state: "expired", daysLeft };
  const start = notBefore ? Date.parse(notBefore) : NaN;
  if (!Number.isNaN(start) && now < start) return { state: "notYetValid", daysLeft };
  if (left <= warnDays * DAY_MS) return { state: "expiring", daysLeft };
  return { state: "valid", daysLeft };
}

export const EXPIRY_TONE: Record<ExpiryState, Tone> = {
  expired: "danger",
  expiring: "warning",
  notYetValid: "warning",
  valid: "success",
};
