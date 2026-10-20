// The Rollout actions Promote, Promote fully, Abort and Retry (ADR-0097). Each opens a confirmation that reads the
// Rollout again and lists exactly the patches it will send (./patches.ts, as `kubectl argo rollouts` builds them from
// the Rollout as it is now); on confirm the Rollout is read once more, and if the patches would differ from the ones
// shown, nothing is sent and the dialog shows the new ones to confirm. Each patch is sent once (ADR-0055), through
// `resource_patch_status` (the status subresource) and `resource_patch` (the spec), within their CHANGE_TIMEOUT.
// Agents and extensions get nothing new: these are window actions.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, toApiError, type ApiError as ApiErrorType, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import { ErrorState } from "../../components";
import { ConfirmAction } from "../actions";
import { registerAction } from "../actions/registry";
import { currentHash, fullyPromoted, isAborted, isKind, pauseConditions, ROLLOUT, rolloutPhase, specPaused, stableHash } from "./model";
import { changesSomething, planFor, sendPlan, type PatchPlan, type RolloutAction } from "./patches";

const json = (value: unknown) => JSON.stringify(value);

/** The patches as the dialog lists them. */
function PlanView({ plan }: { plan: PatchPlan }) {
  const { t } = useTranslation();
  if (!changesSomething(plan)) return <p>{t("argorollouts:dialog.nothing")}</p>;
  const fallback = plan.status && plan.unified ? plan.unified : undefined;
  return (
    <div className="ar-plan">
      {plan.status && (
        <>
          <p>{t("argorollouts:dialog.statusPatch")}</p>
          <pre className="dt-pre">{json(plan.status)}</pre>
        </>
      )}
      {plan.spec && (
        <>
          <p>{t("argorollouts:dialog.specPatch")}</p>
          <pre className="dt-pre">{json(plan.spec)}</pre>
        </>
      )}
      {fallback && (
        <>
          <p className="ar-muted">{t("argorollouts:dialog.fallbackPatch")}</p>
          <pre className="dt-pre">{json(fallback)}</pre>
        </>
      )}
    </div>
  );
}

export function RolloutActionDialog({
  clusterId,
  objectRef,
  action,
  close,
}: {
  clusterId: ClusterId;
  objectRef: ObjectRef;
  action: RolloutAction;
  close: () => void;
}) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<PatchPlan | null>(null);
  const [loadError, setLoadError] = useState<ApiErrorType | null>(null);
  const key = JSON.stringify([clusterId, objectRef, action]);
  useEffect(() => {
    let live = true;
    api.resources.get(clusterId, objectRef).then(
      (ro) => live && setPlan(planFor(action, ro)),
      (err: unknown) => live && setLoadError(toApiError(err)),
    );
    return () => {
      live = false;
    };
    // `key` holds the cluster, the object and the action by value.
  }, [key]);

  const confirm = async () => {
    if (!plan) return;
    const fresh = planFor(action, await api.resources.get(clusterId, objectRef));
    if (json(fresh) !== json(plan)) {
      setPlan(fresh);
      throw new ApiError("conflict", t("argorollouts:dialog.changed"));
    }
    await sendPlan(clusterId, objectRef, fresh);
  };

  const names = { name: objectRef.name };
  return (
    <ConfirmAction
      title={t(`argorollouts:dialog.${action}Title`, names)}
      confirmLabel={t(`argorollouts:actions.${action}`)}
      danger={action === "abort"}
      close={close}
      canConfirm={plan !== null && changesSomething(plan)}
      onConfirm={confirm}
    >
      <p>{t(`argorollouts:dialog.${action}Text`)}</p>
      {loadError ? <ErrorState error={loadError} /> : plan ? <PlanView plan={plan} /> : <p>{t("argorollouts:dialog.loading")}</p>}
    </ConfirmAction>
  );
}

const isRollout = (kind: Parameters<typeof isKind>[0]) => isKind(kind, ROLLOUT);

/** An update is under way: the new template is not the stable one yet. */
const updating = (ro: KubeObject) => Boolean(currentHash(ro)) && currentHash(ro) !== stableHash(ro);

/** Offered when the plugin's promote would move the Rollout on: paused, or a canary between its steps. */
export function canPromote(ro: KubeObject): boolean {
  if (isAborted(ro)) return false;
  return specPaused(ro) || pauseConditions(ro).length > 0 || rolloutPhase(ro).phase === "Paused" || updating(ro);
}

const ACTIONS: { id: "rolloutPromote" | "rolloutPromoteFull" | "rolloutAbort" | "rolloutRetry"; action: RolloutAction; applies: (ro: KubeObject) => boolean; danger?: boolean }[] = [
  { id: "rolloutPromote", action: "promote", applies: canPromote },
  { id: "rolloutPromoteFull", action: "promoteFull", applies: (ro) => !isAborted(ro) && (!fullyPromoted(ro) || specPaused(ro)) },
  { id: "rolloutAbort", action: "abort", applies: (ro) => !isAborted(ro) && updating(ro), danger: true },
  { id: "rolloutRetry", action: "retry", applies: isAborted },
];

const ICONS = {
  promote: "rolloutPromote",
  promoteFull: "rolloutPromoteFull",
  abort: "rolloutAbort",
  retry: "rolloutRetry",
} as const;

for (const { id, action, applies, danger } of ACTIONS) {
  registerAction(id, {
    labelKey: `argorollouts:actions.${action}`,
    icon: ICONS[action],
    danger,
    appliesTo: (obj, kind) => isRollout(kind) && applies(obj),
    run: ({ clusterId, refs, openDialog }) => {
      const ref = refs[0];
      if (!ref) return;
      openDialog((close) => <RolloutActionDialog clusterId={clusterId} objectRef={ref} action={action} close={close} />);
    },
  });
}
