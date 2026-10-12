// "Logs" on a Deployment, StatefulSet, DaemonSet or Job: choose which of its pods to read.
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KubeObject } from "../../api";
import { Dialog, EmptyState, ErrorState, LoadingIndicator } from "../../components";
import { openLogsTab, POD_KIND } from "./openLogsTab";
import { labelSelectorOf } from "./selector";

export interface PodPickerProps {
  clusterId: ClusterId;
  workload: KubeObject;
  close: () => void;
}

export function PodPicker({ clusterId, workload, close }: PodPickerProps) {
  const { t } = useTranslation();
  const name = workload.metadata?.name ?? "";
  const namespace = workload.metadata?.namespace;
  const selector = labelSelectorOf(workload);
  const watch = useWatch(
    selector && namespace ? clusterId : null,
    selector && namespace
      ? { kind: POD_KIND, namespaces: [namespace], labelSelector: selector, fieldSelector: null }
      : null,
  );
  const pods = [...watch.items.values()].sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));

  let body;
  if (!selector) body = <EmptyState title={t("logs:picker.noSelector")} />;
  else if (watch.status === "error") body = <ErrorState error={watch.error} />;
  else if (watch.status === "loading") body = <LoadingIndicator text={t("logs:picker.loading")} />;
  else if (pods.length === 0) body = <EmptyState title={t("logs:picker.none")} />;
  else {
    body = (
      <ul className="logs-picker">
        {pods.map((pod) => (
          <li key={pod.metadata?.uid ?? pod.metadata?.name}>
            <button
              type="button"
              className="logs-picker__pod"
              onClick={() => {
                openLogsTab(clusterId, pod);
                close();
              }}
            >
              <span>{pod.metadata?.name}</span>
              <span className="logs-picker__phase">{(pod.status as { phase?: string } | undefined)?.phase}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <Dialog open title={t("logs:picker.title", { name })} onClose={close}>
      {body}
    </Dialog>
  );
}
