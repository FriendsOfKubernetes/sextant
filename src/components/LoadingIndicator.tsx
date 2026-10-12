// "Loading Nodes… 7 s": what is loading, the seconds since it began and, after `SLOW_AFTER_S`, that the cluster is
// slow to respond — so a long first load reads as waiting, not as a hang. Used by the tables, the pages that wait
// for the cluster (overview, Helm releases, events, the pod picker of logs) and by the cluster connection (rail and
// connection screen).
//
//   <LoadingIndicator text={t("resources:loading.kind", { kind: "Pods" })} since={startedAt} />
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "./loading.css";

/** After this many seconds the indicator says that the cluster is slow. */
export const SLOW_AFTER_S = 5;

/**
 * Whole seconds since `since` (a `Date.now()` value; default: when `active` last became true), updated every
 * second while `active`; 0 while not. A new `since` is a new wait: the count starts over from it.
 */
export function useElapsedSeconds(active = true, since?: number): number {
  const [now, setNow] = useState(() => Date.now());
  const [start, setStart] = useState<{ since: number | undefined; at: number } | null>(() =>
    active ? { since, at: since ?? Date.now() } : null,
  );
  if (active && (start === null || start.since !== since)) setStart({ since, at: since ?? Date.now() });
  if (!active && start !== null) setStart(null);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active || start === null || start.since !== since) return 0;
  return Math.max(0, Math.floor((now - start.at) / 1_000));
}

export interface LoadingIndicatorProps {
  /** Already translated, e.g. "Loading Nodes…". */
  text: string;
  /** Already translated; shown after `SLOW_AFTER_S`. Default: "The cluster is slow to respond". */
  slowText?: string;
  /** When the wait began (`Date.now()`); default: when the indicator appeared. */
  since?: number;
  className?: string;
}

export function LoadingIndicator({ text, slowText, since, className }: LoadingIndicatorProps) {
  const { t } = useTranslation();
  const seconds = useElapsedSeconds(true, since);
  return (
    <div className={`loading-indicator${className ? ` ${className}` : ""}`} role="status">
      <div className="loading-indicator__line">
        <span className="loading-indicator__spinner" aria-hidden="true" />
        <span className="loading-indicator__text">{text}</span>
        {seconds >= 1 && (
          <span className="loading-indicator__seconds">{t("resources:loading.seconds", { seconds })}</span>
        )}
      </div>
      {seconds >= SLOW_AFTER_S && (
        <div className="loading-indicator__slow">{slowText ?? t("resources:loading.slow")}</div>
      )}
    </div>
  );
}
