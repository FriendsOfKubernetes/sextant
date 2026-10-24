// "Alerts" section of an object's details (#264): the alerts whose labels name this object (see model.ts), with their
// number in the heading; for a Deployment, StatefulSet, DaemonSet or Job also the alerts of its own pods, found through
// the pods' owners in the shared pod watch right-sizing and cost use (opened only when some alert of the namespace
// names a pod). Hidden while no alert source answers; polled once a minute while shown, shared with the page.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { KindRef } from "../../api";
import { useAppStore } from "../../app/store";
import { Badge, Button } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { useWorkloadPods } from "../rightsizing/workloadPods";
import { ALERTS_PAGE_ID } from "./ids";
import { ALERT_KINDS, alertKeys, alertsOf, alertTarget, isActive, targetKey } from "./model";
import { anySource } from "./SourceNotes";
import { useAlerts } from "./store";
import { AlertRow } from "./ui";
import "./alerts.css";

const WITH_PODS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job"]);

export function alertsApplies(kind: KindRef): boolean {
  return ALERT_KINDS.some((k) => k.group === kind.group && k.kind === kind.kind);
}

export function AlertsDetailsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const setView = useAppStore((s) => s.setView);
  const { report, index } = useAlerts(clusterId);
  const namespace = objectRef.namespace ?? "";
  // A workload's own pods matter only when an alert of its namespace names a pod.
  const podAlerts = useMemo(() => {
    if (!namespace || !WITH_PODS.has(objectRef.kind.kind)) return false;
    for (const key of index.byPod.keys()) if (key.startsWith(`${namespace}/`)) return true;
    return false;
  }, [index, namespace, objectRef.kind.kind]);
  const { pods } = useWorkloadPods(clusterId, objectRef, obj, podAlerts);
  const podNames = useMemo(() => pods.map((p) => p.metadata?.name ?? "").filter(Boolean), [pods]);
  const alerts = useMemo(() => alertsOf(index, objectRef, podNames), [index, objectRef, podNames]);
  const keys = useMemo(() => alertKeys(alerts), [alerts]);

  if (!report || !anySource(report)) return null;
  const active = alerts.filter(isActive).length;
  return (
    <section className="al-section" aria-label={t("alerts:details.title")}>
      <h3 className="al-section__title">
        {t("alerts:details.title")}
        <Badge tone={active > 0 ? "danger" : "neutral"}>{alerts.length}</Badge>
      </h3>
      {alerts.length === 0 ? (
        <p className="al-note">{t("alerts:details.none")}</p>
      ) : (
        <ul className="al-list">
          {alerts.map((alert, i) => (
            <AlertRow
              key={keys[i]}
              alert={alert}
              showName
              // A pod's alert on its workload names the pod.
              showObject={(() => {
                const target = alertTarget(alert);
                return target !== null && targetKey(target) !== targetKey(objectRef);
              })()}
            />
          ))}
        </ul>
      )}
      <Button size="compact" onClick={() => setView(clusterId, ALERTS_PAGE_ID)}>
        {t("alerts:details.openPage")}
      </Button>
    </section>
  );
}
