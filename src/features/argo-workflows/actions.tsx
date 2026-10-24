// The Workflow actions Suspend, Resume, Stop and Terminate (ADR-0097, amended for #238). Each opens a confirmation
// that reads the Workflow again and lists the exact merge patch (./patches.ts, as util.go builds it); on confirm the
// Workflow is read once more and, if the patch would differ from the one shown, nothing is sent and the dialog shows
// the new one to confirm. The patch goes once (ADR-0055) through `resource_patch` within its CHANGE_TIMEOUT; a
// versioned one is refused by the API server (a conflict) when the Workflow changed after the last read. Retry is not
// offered. Agents and extensions get nothing new: these are window actions.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, toApiError, type ApiError as ApiErrorType, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import { ErrorState } from "../../components";
import { status } from "../../resources";
import { ConfirmAction } from "../actions";
import { registerAction, type ActionPlacement } from "../actions/registry";
import { isKind, WORKFLOW } from "./model";
import {
  activeSuspendNodes,
  isCompleted,
  isFinished,
  isSuspended,
  nowStamp,
  patchToSend,
  planFor,
  shutdownOf,
  type WorkflowAction,
  type WorkflowPlan,
} from "./patches";

const json = (value: unknown) => JSON.stringify(value);
const resourceVersion = (wf: KubeObject) => status.str(wf.metadata?.resourceVersion);
const D = "argoworkflows:dialog";

interface Shown {
  plan: WorkflowPlan;
  /** The patch as it would be sent now (with the resourceVersion read and the time of reading). */
  patch: Record<string, unknown> | undefined;
}

const show = (action: WorkflowAction, wf: KubeObject): Shown => {
  const plan = planFor(action, wf);
  return { plan, patch: patchToSend(plan, resourceVersion(wf), nowStamp()) };
};

function PlanView({ shown, action, objectRef }: { shown: Shown; action: WorkflowAction; objectRef: ObjectRef }) {
  const { t } = useTranslation();
  const { plan, patch } = shown;
  if (plan.refusal) {
    const names = { name: objectRef.name, namespace: objectRef.namespace ?? "", ...plan.refusal };
    return <p role="alert">{t(`${D}.refusal.${plan.refusal.reason}`, names)}</p>;
  }
  if (!patch) return <p>{t(`${D}.nothing.${action}`)}</p>;
  return (
    <div className="aw-plan">
      <p>{t(`${D}.patch`)}</p>
      <pre className="dt-pre">{json(patch)}</pre>
      {plan.versioned && <p className="aw-muted">{t(`${D}.versioned`)}</p>}
      {plan.stamped.length > 0 && <p className="aw-muted">{t(`${D}.stamped`)}</p>}
    </div>
  );
}

export function WorkflowActionDialog({
  clusterId,
  objectRef,
  action,
  close,
}: {
  clusterId: ClusterId;
  objectRef: ObjectRef;
  action: WorkflowAction;
  close: () => void;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<Shown | null>(null);
  const [loadError, setLoadError] = useState<ApiErrorType | null>(null);
  const key = JSON.stringify([clusterId, objectRef, action]);
  useEffect(() => {
    let live = true;
    api.resources.get(clusterId, objectRef).then(
      (wf) => live && setShown(show(action, wf)),
      (err: unknown) => live && setLoadError(toApiError(err)),
    );
    return () => {
      live = false;
    };
    // `key` holds the cluster, the object and the action by value.
  }, [key]);

  const confirm = async () => {
    if (!shown) return;
    const wf = await api.resources.get(clusterId, objectRef);
    const fresh = planFor(action, wf);
    if (json(fresh) !== json(shown.plan)) {
      setShown(show(action, wf));
      throw new ApiError("conflict", t(`${D}.changed`));
    }
    const patch = patchToSend(fresh, resourceVersion(wf), nowStamp());
    if (patch) await api.resources.patch(clusterId, objectRef, patch, "merge");
  };

  const ready = shown !== null && !shown.plan.refusal && shown.patch !== undefined;
  return (
    <ConfirmAction
      title={t(`${D}.${action}Title`, { name: objectRef.name })}
      confirmLabel={t(`argoworkflows:actions.${action}`)}
      danger={action === "stop" || action === "terminate"}
      close={close}
      canConfirm={ready}
      onConfirm={confirm}
    >
      <p>{t(`${D}.${action}Text`)}</p>
      {loadError ? (
        <ErrorState error={loadError} />
      ) : shown ? (
        <PlanView shown={shown} action={action} objectRef={objectRef} />
      ) : (
        <p>{t(`${D}.loading`)}</p>
      )}
    </ConfirmAction>
  );
}

/** Offered as util.go would act: suspend a running one, resume a suspended one, stop or terminate an unfinished one. */
export const WORKFLOW_ACTIONS: {
  id: "workflowSuspend" | "workflowResume" | "workflowStop" | "workflowTerminate";
  action: WorkflowAction;
  applies: (wf: KubeObject) => boolean;
  icon: "suspend" | "resume" | "terminate" | "rolloutAbort";
  danger?: boolean;
  /** Suspend/Resume and Stop are buttons of the details panel; Terminate is in "Actions" (#275). */
  placement: ActionPlacement;
}[] = [
  { id: "workflowSuspend", action: "suspend", icon: "suspend", applies: (wf) => !isCompleted(wf) && !isFinished(wf) && !isSuspended(wf), placement: "primary" },
  { id: "workflowResume", action: "resume", icon: "resume", applies: (wf) => isSuspended(wf) || activeSuspendNodes(wf).length > 0, placement: "primary" },
  { id: "workflowStop", action: "stop", icon: "terminate", danger: true, applies: (wf) => !isFinished(wf) && shutdownOf(wf) !== "Stop", placement: "primary" },
  {
    id: "workflowTerminate",
    action: "terminate",
    icon: "rolloutAbort",
    danger: true,
    applies: (wf) => !isFinished(wf) && shutdownOf(wf) !== "Terminate",
    placement: "more",
  },
];

for (const { id, action, applies, icon, danger, placement } of WORKFLOW_ACTIONS) {
  registerAction(id, {
    labelKey: `argoworkflows:actions.${action}`,
    icon,
    danger,
    placement,
    appliesTo: (obj, kind) => isKind(kind, WORKFLOW) && applies(obj),
    run: ({ clusterId, refs, openDialog }) => {
      const ref = refs[0];
      if (!ref) return;
      openDialog((close) => <WorkflowActionDialog clusterId={clusterId} objectRef={ref} action={action} close={close} />);
    },
  });
}
