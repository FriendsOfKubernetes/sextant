// "Alerts" section of an object's details (#264): the alerts whose labels name this object (see model.ts), with their
// number in the heading; for a Deployment, StatefulSet, DaemonSet or Job also the alerts of its own pods, found through
// the pods' owners in the shared pod watch right-sizing and cost use (opened only when some alert of the namespace
// names a pod). Hidden while no alert source answers; polled once a minute while shown, shared with the page.
import { Block } from "../details/ui";
import { useDetailsDisclosure } from "../../layout/details/disclosure";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { KindRef, ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { Badge, Button } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { useWorkloadPods } from "../rightsizing/workloadPods";
import { ALERTS_PAGE_ID } from "./ids";
import { ALERT_KINDS, alertKeys, alertsOf, alertTarget, isActive, targetKey } from "./model";
import { anySource } from "./SourceNotes";
import { getAlerts, useAlerts } from "./store";
import { AlertRow } from "./ui";
import "./alerts.css";

const WITH_PODS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job"]);

export function alertsApplies(kind: KindRef): boolean {
  return ALERT_KINDS.some((k) => k.group === kind.group && k.kind === kind.kind);
}

export function AlertsDetailsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const setView = useAppStore((s) => s.setView);
  const open = useDetailsDisclosure("alerts:details.title")?.open ?? true;
  const live = useAlerts(open ? clusterId : null);
  const { report, index } = open ? live : (getAlerts(clusterId) ?? live);
  const namespace = objectRef.namespace ?? "";
  // A workload's own pods matter only when an alert of its namespace names a pod.
  const podAlerts = useMemo(() => {
    if (!namespace || !WITH_PODS.has(objectRef.kind.kind)) return false;
    for (const key of index.byPod.keys()) if (key.startsWith(`${namespace}/`)) return true;
    return false;
  }, [index, namespace, objectRef.kind.kind]);
  const { pods } = useWorkloadPods(clusterId, objectRef, obj, open && podAlerts);
  const podNames = useMemo(() => pods.map((p) => p.metadata?.name ?? "").filter(Boolean), [pods]);
  const alerts = useMemo(() => alertsOf(index, objectRef, podNames), [index, objectRef, podNames]);


  if (open && (!report || !anySource(report))) return null;
  const active = alerts.filter(isActive).length;
  return (
    <Block id="alerts:details.title" title={t("alerts:details.title")} label={t("alerts:details.title")} badge={report && (open || !WITH_PODS.has(objectRef.kind.kind)) ? <Badge tone={active > 0 ? "danger" : "neutral"}>{alerts.length}</Badge> : undefined}>
      <DetailsAlerts alerts={alerts} objectRef={objectRef} />
      <Button size="compact" onClick={() => setView(clusterId, ALERTS_PAGE_ID)}>
        {t("alerts:details.openPage")}
      </Button>
    </Block>
  );
}

function DetailsAlerts({ alerts, objectRef }: { alerts: ReturnType<typeof alertsOf>; objectRef: ObjectRef }) {
  const { t } = useTranslation();
  const keys = useMemo(() => alertKeys(alerts), [alerts]);
  if (alerts.length === 0) return <p className="al-note">{t("alerts:details.none")}</p>;
  return <ul className="al-list">{alerts.map((alert, i) => {
    const target = alertTarget(alert);
    return <AlertRow key={keys[i]} alert={alert} showName showObject={target !== null && targetKey(target) !== targetKey(objectRef)} />;
  })}</ul>;
}
