import { useTranslation } from "react-i18next";

export type AgeUnit = "seconds" | "minutes" | "hours" | "days" | "years";

/** Largest whole unit of an age in milliseconds, like kubectl/Lens ("45s", "3m", "5h", "12d", "2y"). */
export function ageParts(ms: number): { unit: AgeUnit; count: number } {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return { unit: "seconds", count: s };
  const m = Math.floor(s / 60);
  if (m < 60) return { unit: "minutes", count: m };
  const h = Math.floor(m / 60);
  if (h < 24) return { unit: "hours", count: h };
  const d = Math.floor(h / 24);
  if (d < 365) return { unit: "days", count: d };
  return { unit: "years", count: Math.floor(d / 365) };
}

/** Age of an RFC 3339 timestamp (e.g. `metadata.creationTimestamp`). */
export function Age({ timestamp, now = Date.now() }: { timestamp: string | null | undefined; now?: number }) {
  const { t } = useTranslation();
  if (!timestamp) return null;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return null;
  const { unit, count } = ageParts(now - time);
  return (
    <time dateTime={timestamp} title={timestamp}>
      {t(`common:age.${unit}`, { count })}
    </time>
  );
}
