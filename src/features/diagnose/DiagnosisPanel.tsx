// The live diagnosis of one object: the "Diagnosis" tab of a Service, Ingress, HTTPRoute or GRPCRoute, and the dialog
// the "Diagnose" action opens. Watches only while it is shown (`useDiagnosisData`).
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject, ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { Button, Dialog, LoadingIndicator } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { DiagnosisView } from "./DiagnosisView";
import { diagnose } from "./engine";
import { useDiagnosisData } from "./hooks";

export interface DiagnosisPanelProps {
  clusterId: ClusterId;
  kind: KindRef;
  namespace: string;
  name: string;
  /** The object as the caller has it; the live list takes over once it comes. */
  obj: KubeObject | null;
  /** Called before an object's details open (a dialog closes). */
  onNavigate?: () => void;
}

export function DiagnosisPanel({ clusterId, kind, namespace, name, obj, onNavigate }: DiagnosisPanelProps) {
  const { t } = useTranslation();
  const openDetails = useAppStore((s) => s.openDetails);
  const data = useDiagnosisData(clusterId, kind, namespace, name, obj);
  const chain = useMemo(
    () => (data.obj && !data.loading ? diagnose(kind, data.obj, data.view) : null),
    [kind, data.obj, data.view, data.loading],
  );
  const onOpen = (ref: ObjectRef) => {
    onNavigate?.();
    openDetails(ref);
  };
  if (data.loading && !chain) return <LoadingIndicator text={t("diagnose:loading")} />;
  if (!chain) return <p className="dg-gone">{t("diagnose:gone", { kind: kind.kind, name })}</p>;
  return <DiagnosisView chain={chain} onOpen={onOpen} />;
}

/** The "Diagnosis" tab of the details panel. */
export function DiagnosisTab({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { kind, namespace, name } = objectRef;
  if (namespace === null) return null;
  return <DiagnosisPanel key={JSON.stringify(objectRef)} clusterId={clusterId} kind={kind} namespace={namespace} name={name} obj={obj} />;
}

export interface DiagnoseDialogProps extends Omit<DiagnosisPanelProps, "onNavigate"> {
  close: () => void;
}

/** What the "Diagnose" action opens. */
export function DiagnoseDialog({ close, ...panel }: DiagnoseDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      title={t("diagnose:dialogTitle", { kind: panel.kind.kind, name: panel.name })}
      onClose={close}
      footer={
        <Button variant="primary" onClick={close}>
          {t("common:actions.close")}
        </Button>
      }
    >
      <div className="dg-dialog">
        <DiagnosisPanel {...panel} onNavigate={close} />
      </div>
    </Dialog>
  );
}
