// "Warn this many days before a certificate expires" (`notifications.certExpiryDays`): one setting for the problems
// screen and the notifications (cert-manager Certificates) and for the certificate views (TLS Secrets, the TLS
// certificates page). Shown in Settings → Notifications and on the TLS certificates page; saved on blur or Enter.
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../api";
import { clampExpiryDays, DEFAULT_CERT_EXPIRY_DAYS, MAX_CERT_EXPIRY_DAYS, MIN_CERT_EXPIRY_DAYS } from "../problems/model";

export function CertExpiryField({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { settings, update } = useSettings();
  const stored = settings?.notifications.certExpiryDays;
  const days = stored === undefined ? DEFAULT_CERT_EXPIRY_DAYS : clampExpiryDays(stored);
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n)) return;
    const next = clampExpiryDays(n);
    if (next !== days) {
      void update((s) => ({ ...s, notifications: { ...s.notifications, certExpiryDays: next } })).catch(() => undefined);
    }
  };
  return (
    <label className={className} htmlFor={id}>
      {t("notifications:settings.certExpiryDays")}
      <input
        id={id}
        type="number"
        min={MIN_CERT_EXPIRY_DAYS}
        max={MAX_CERT_EXPIRY_DAYS}
        step={1}
        disabled={!settings}
        value={draft ?? String(days)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </label>
  );
}
