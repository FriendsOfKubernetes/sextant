// "Logs" on a workload (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job) or a Service: all of its pods in one
// merged tab, or one pod.
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KindRef, type KubeObject } from "../../api";
import { Button, Dialog, EmptyState, ErrorState, LoadingIndicator } from "../../components";
import { openSelectorLogsTab } from "./multi/open";
import { openLogsTab, POD_KIND } from "./openLogsTab";
import { podSelectorOf } from "./selector";

export interface PodPickerProps {
  clusterId: ClusterId;
  kind: KindRef;
  workload: KubeObject;
  close: () => void;
}

/** The title of a merged tab for the pods of `obj`: `deployment/web`. */
export function selectorTabTitle(kind: KindRef, obj: KubeObject): string {
  return `${kind.kind.toLowerCase()}/${obj.metadata?.name ?? ""}`;
}

export function PodPicker({ clusterId, kind, workload, close }: PodPickerProps) {
  const { t } = useTranslation();
  const name = workload.metadata?.name ?? "";
  const namespace = workload.metadata?.namespace;
  const selector = podSelectorOf(workload, kind);
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
  const all =
    selector && namespace ? (
      <div className="logs-picker__all">
        <Button
          icon="logs"
          variant="primary"
          onClick={() => {
            openSelectorLogsTab(clusterId, namespace, selector, selectorTabTitle(kind, workload));
            close();
          }}
        >
          {t("logs:picker.all")}
        </Button>
        <span className="logs-picker__hint">{t("logs:picker.allHint")}</span>
      </div>
    ) : null;
  return (
    <Dialog open title={t("logs:picker.title", { name })} onClose={close}>
      {all}
      {body}
    </Dialog>
  );
}
