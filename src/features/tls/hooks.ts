// The expiry warning setting of the TLS views.
import { useSettings } from "../../api";
import { clampExpiryDays, DEFAULT_CERT_EXPIRY_DAYS } from "./model";

/** Days before expiry a certificate shows as expiring (`notifications.certExpiryDays`). */
export function useExpiryDays(): number {
  const { settings } = useSettings();
  const value = settings?.notifications.certExpiryDays;
  return value === undefined ? DEFAULT_CERT_EXPIRY_DAYS : clampExpiryDays(value);
}
