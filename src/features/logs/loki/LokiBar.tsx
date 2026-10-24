// "Load older lines from Loki" in a pod's logs tab: the period, the read's progress, and why nothing can be read
// when the cluster has no Loki (shown when the pod is gone, where it matters).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ClusterId, type LokiRange, type LokiStatus, type ObjectRef } from "../../../api";
import { Button, ErrorState } from "../../../components";
import type { UseLokiRead } from "./hooks";
import { useLokiStatus } from "./hooks";
import { MAX_LOKI_LINES, shownRunStart } from "./model";
import { initialChoice, RangePicker, rangeOf, type RangeChoice } from "./RangePicker";

export interface LokiBarProps {
  clusterId: ClusterId;
  pod: ObjectRef;
  container: string;
  /** "Previous container" is on: lines end where the previous run began. */
  previous: boolean;
  /** The pod is gone (its live log failed with "not found") or the tab shows only Loki's lines. */
  gone: boolean;
  read: UseLokiRead;
}

/** When the run the live view shows began, from the pod; `null` (read up to now) when the pod is gone or does not
 * say. */
async function runStart(clusterId: ClusterId, pod: ObjectRef, container: string, previous: boolean): Promise<number | null> {
  try {
    return shownRunStart(await api.resources.get(clusterId, pod), container, previous);
  } catch (err) {
    if (toApiError(err).code === "notFound") return null;
    throw err;
  }
}

/** Why nothing can be read from Loki, as one sentence; `null` when it can be read. */
export function lokiUnavailableKey(status: LokiStatus): string | null {
  if (status.off) return "loki:none.off";
  if (!status.source) return status.manual ? "loki:none.manualNoAnswer" : "loki:none.notFound";
  if (!status.scheme) return "loki:none.noLabels";
  return null;
}

/** Why the Service named in the settings did not answer as Loki (no permission, a wrong port), as the core cleaned it. */
export function LokiProbeError({ error }: { error: Pick<ApiError, "message"> }) {
  const { t } = useTranslation();
  return <span className="loki-note__detail">{t("loki:none.probeError", { message: error.message })}</span>;
}

export function LokiBar({ clusterId, pod, container, previous, gone, read }: LokiBarProps) {
  const { t } = useTranslation();
  const loki = useLokiStatus(clusterId);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<RangeChoice>(() => initialChoice());
  const [startError, setStartError] = useState<unknown>(null);

  if (loki.loading) return null;
  // Not an alert: the live log's own error (a gone pod) is the one that matters here.
  if (loki.error) return gone ? <p className="loki-note">{t("loki:statusFailedNote", { message: loki.error.message })}</p> : null;
  const status = loki.status!;
  const unavailable = lokiUnavailableKey(status);
  if (unavailable) {
    return gone ? (
      <p className="loki-note" data-testid="loki-unavailable">
        {t(unavailable)}
        {status.probeError && <LokiProbeError error={status.probeError} />}
      </p>
    ) : null;
  }

  const load = async () => {
    setStartError(null);
    try {
      const now = Date.now();
      const end = choice.preset === "custom" || gone ? now : ((await runStart(clusterId, pod, container, previous)) ?? now);
      const { range } = rangeOf(choice, end, now);
      if (!range) return;
      startRead(range);
    } catch (err) {
      setStartError(err);
    }
  };
  const startRead = (range: LokiRange) =>
    read.load(clusterId, {
      namespace: pod.namespace ?? "",
      pod: pod.name,
      container: status.containerLabel && container ? container : null,
      range,
      direction: "backward",
      limit: MAX_LOKI_LINES,
    });

  if (!open && !gone && read.status === "idle") {
    return (
      <div className="loki-bar loki-bar--closed">
        <Button size="compact" icon="logs" onClick={() => setOpen(true)}>
          {t("loki:openBar")}
        </Button>
      </div>
    );
  }
  const loading = read.status === "loading";
  const invalid = rangeOf(choice, Date.now()).problem !== null;
  return (
    <div className="loki-bar" role="group" aria-label={t("loki:bar")}>
      <RangePicker choice={choice} onChange={setChoice} />
      <Button icon="logs" disabled={loading || invalid} onClick={() => void load()}>
        {t("loki:load")}
      </Button>
      {loading && (
        <>
          <span role="status">{t("loki:loading", { count: read.entries.length })}</span>
          <Button onClick={read.cancel}>{t("loki:cancel")}</Button>
        </>
      )}
      {read.status === "done" && (
        <>
          <span role="status" data-testid="loki-count">
            {t("loki:loaded", { count: read.entries.length })}
          </span>
          {read.truncated && <span className="loki-bar__note">{t("loki:truncated", { count: MAX_LOKI_LINES })}</span>}
          <Button onClick={read.clear}>{t("loki:clear")}</Button>
        </>
      )}
      {!status.containerLabel && <span className="loki-bar__note">{t("loki:noContainerLabel")}</span>}
      {read.status === "error" && read.error && <ErrorState error={read.error} title={t("loki:readFailed")} />}
      {startError !== null && <ErrorState error={startError} title={t("loki:readFailed")} />}
    </div>
  );
}
