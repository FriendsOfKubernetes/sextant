// A certificate's end, with the days left, coloured by the expiry warning setting.
import { useTranslation } from "react-i18next";
import { StatusText } from "../../resources";
import { formatDateTime } from "../../i18n";
import { useNow } from "../problems/hooks";
import { useExpiryDays } from "./hooks";
import { EXPIRY_TONE, expiryOf } from "./model";

/** Expiry of a certificate, colored by the warning setting. */
export function ExpiryText({ notAfter, notBefore }: { notAfter: string | undefined; notBefore?: string }) {
  const { t } = useTranslation();
  const days = useExpiryDays();
  const now = useNow(60_000);
  const expiry = expiryOf(notAfter, now, days, notBefore);
  if (!notAfter || !expiry) return null;
  const text =
    expiry.state === "expired"
      ? t("tls:expiry.expiredOn", { date: formatDateTime(notAfter) })
      : expiry.state === "notYetValid"
        ? t("tls:expiry.notYetValid", { date: formatDateTime(notBefore ?? notAfter) })
        : t("tls:expiry.until", { date: formatDateTime(notAfter), count: expiry.daysLeft });
  return <StatusText value={text} tone={EXPIRY_TONE[expiry.state]} />;
}
