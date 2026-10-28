import { useDetailsDisclosure } from "../../../layout/details/disclosure";
// "Logs of previous pods (Loki)" in a workload's details: the pods its controller made that have lines in Loki in
// the chosen period (by the names the controller gives them), each opened in a logs tab of Loki's lines only.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ClusterId, type LokiNames, type LokiRange } from "../../../api";
import { useAppStore } from "../../../app/store";
import { Button, ErrorState } from "../../../components";
import type { DetailsSectionProps } from "../../../layout/details/registry";
import { Block } from "../../details";
import type { LogsPayload } from "../LogsTab";
import { POD_KIND } from "../openLogsTab";
import { useLokiStatus } from "./hooks";
import { lokiUnavailableKey } from "./LokiBar";
import { RANGE_PRESETS, type RangePreset } from "./model";
import { initialChoice, RangePicker, rangeOf, type RangeChoice } from "./RangePicker";

/** Workload kinds (by group) whose previous pods are listed: the backend knows how each names its pods. */
export const LOKI_WORKLOAD_KINDS: Readonly<Record<string, readonly string[]>> = {
  apps: ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"],
  batch: ["Job", "CronJob"],
};

const PRESETS: readonly RangePreset[] = RANGE_PRESETS;

/** Opens a logs tab with Loki's lines of `pod` over `range`; its containers are asked of Loki first. */
export async function openLokiLogsTab(clusterId: ClusterId, namespace: string, pod: string, range: LokiRange): Promise<void> {
  const containers = await api.loki.names(clusterId, { type: "podContainers", namespace, pod }, range);
  const payload: LogsPayload = {
    clusterId,
    pod: { kind: POD_KIND, namespace, name: pod },
    containers: containers.names.length > 0 ? containers.names.map((name) => ({ name, init: false })) : [{ name: "", init: false }],
    loki: { range },
  };
  useAppStore.getState().openDockTab({
    id: `logs:${clusterId}:${namespace}/${pod}:loki:${range.startMs}-${range.endMs}`,
    type: "logs",
    title: pod,
    payload,
  });
}

export function PreviousPodsSection({ clusterId, objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  const sectionOpen = useDetailsDisclosure("previousPods")?.open ?? true;
  const loki = useLokiStatus(clusterId, sectionOpen);
  const [choice, setChoice] = useState<RangeChoice>(() => initialChoice());
  const [found, setFound] = useState<{ names: LokiNames; range: LokiRange } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const namespace = objectRef.namespace;
  const title = t("loki:previous.title");
  if (!namespace) return null;
  if (!sectionOpen) return <Block id="previousPods" title={title}>{null}</Block>;
  if (loki.loading) return null;
  if (loki.error) {
    return (
      <Block id="previousPods" title={title}>
        <ErrorState error={loki.error} title={t("loki:statusFailed")} />
      </Block>
    );
  }
  const unavailable = lokiUnavailableKey(loki.status!);
  if (unavailable) {
    return (
      <Block id="previousPods" title={title}>
        <p className="loki-note">{t(unavailable)}</p>
      </Block>
    );
  }

  const find = async () => {
    const { range } = rangeOf(choice, Date.now());
    if (!range) return;
    setBusy(true);
    setError(null);
    try {
      const names = await api.loki.names(clusterId, { type: "workloadPods", namespace, kind: objectRef.kind.kind, name: objectRef.name }, range);
      setFound({ names, range });
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };
  const open = (pod: string, range: LokiRange) =>
    void openLokiLogsTab(clusterId, namespace, pod, range).catch((err: unknown) => setError(toApiError(err)));

  return (
    <Block id="previousPods" title={title}>
      <div className="loki-previous">
        <RangePicker choice={choice} onChange={setChoice} presets={PRESETS} />
        <Button icon="logs" disabled={busy || rangeOf(choice, Date.now()).problem !== null} onClick={() => void find()}>
          {t("loki:previous.find")}
        </Button>
      </div>
      <p className="loki-note">{t("loki:previous.hint")}</p>
      {busy && <p role="status">{t("loki:previous.searching")}</p>}
      {error && <ErrorState error={error} />}
      {found && !busy && (
        <>
          {found.names.names.length === 0 ? (
            <p className="loki-note" role="status">
              {t("loki:previous.none")}
            </p>
          ) : (
            <ul className="loki-previous__pods" aria-label={t("loki:previous.listLabel")}>
              {found.names.names.map((pod) => (
                <li key={pod}>
                  <Button size="compact" icon="logs" onClick={() => open(pod, found.range)}>
                    {pod}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {found.names.truncated && <p className="loki-note">{t("loki:previous.truncated", { count: found.names.names.length })}</p>}
        </>
      )}
    </Block>
  );
}
