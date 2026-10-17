// "Roll back to revision N": the revision to go to, the change it makes (current template ↔ the revision's) and a
// confirmation; the patch goes through `resource_patch`. Opened from the History tab (with its revisions) and by the
// "Roll back…" action (which watches the revisions itself).
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, useWatch, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import { LoadingIndicator } from "../../components";
import { ConfirmAction } from "../actions";
import {
  liveTemplate,
  matchesLive,
  revisionsOf,
  revisionsWatchSpec,
  rollbackBlocker,
  rollbackPatch,
  templateYaml,
  type RevisionInfo,
  type WorkloadKind,
} from "./model";
import { TemplateDiff } from "./TemplateDiff";

export interface RollbackDialogProps {
  clusterId: ClusterId;
  objectRef: ObjectRef;
  workload: KubeObject;
  kind: WorkloadKind;
  /** The revisions when the caller has them; otherwise the dialog watches them. */
  revisions?: RevisionInfo[];
  /** The revision to offer first; by default the one before the newest, as `kubectl rollout undo`. */
  initial?: number | null;
  close: () => void;
}

/** kubectl's default target: the second newest revision. */
export function previousRevision(revisions: RevisionInfo[]): number | null {
  return revisions.at(-2)?.revision ?? null;
}

export function RollbackDialog({
  clusterId,
  objectRef,
  workload,
  kind,
  revisions: given,
  initial,
  close,
}: RollbackDialogProps) {
  const { t } = useTranslation();
  const selectId = useId();
  const spec = given ? null : revisionsWatchSpec(workload, kind);
  const watched = useWatch(spec ? clusterId : null, spec);
  const revisions = useMemo(
    () => given ?? revisionsOf(workload, kind, watched.items.values()),
    [given, workload, kind, watched.items],
  );
  const loading = !given && spec !== null && watched.status === "loading";
  const [chosen, setChosen] = useState<number | null>(initial ?? null);
  const revisionNumber = chosen ?? previousRevision(revisions);
  const target = revisions.find((r) => r.revision === revisionNumber) ?? null;
  const blocker = rollbackBlocker(workload, kind);
  const same = target !== null && matchesLive(workload, target);

  const rollBack = async () => {
    if (!target) return;
    await api.resources.patch(clusterId, objectRef, rollbackPatch(workload, kind, target), "json");
  };

  return (
    <ConfirmAction
      title={t("rollouts:rollback.title", { name: objectRef.name })}
      confirmLabel={t("rollouts:rollback.confirm", { revision: target?.revision ?? "" })}
      danger
      close={close}
      canConfirm={target !== null && !same && blocker === null}
      onConfirm={rollBack}
    >
      <div className="rollouts-confirm">
        {loading ? (
          <LoadingIndicator text={t("rollouts:rollback.loading")} />
        ) : revisions.length < 2 || target === null ? (
          <p>{t("rollouts:rollback.none")}</p>
        ) : (
          <>
            <div className="action-dialog__field">
              <label htmlFor={selectId}>{t("rollouts:rollback.revision")}</label>
              <select
                id={selectId}
                value={target.revision}
                onChange={(e) => setChosen(Number(e.target.value))}
              >
                {[...revisions].reverse().map((r) => (
                  <option key={r.revision} value={r.revision}>
                    {r.changeCause
                      ? t("rollouts:rollback.revisionOptionCause", { revision: r.revision, cause: r.changeCause })
                      : t("rollouts:rollback.revisionOption", { revision: r.revision })}
                  </option>
                ))}
              </select>
            </div>
            <p>{t("rollouts:rollback.intro", { revision: target.revision })}</p>
            {blocker === "paused" && <p className="rollouts-note rollouts-note--warning">{t("rollouts:rollback.paused")}</p>}
            {same && <p className="rollouts-note">{t("rollouts:rollback.same", { revision: target.revision })}</p>}
            <TemplateDiff
              left={templateYaml(liveTemplate(workload))}
              right={templateYaml(target.template)}
              leftTitle={t("rollouts:rollback.current")}
              rightTitle={t("rollouts:rollback.target", { revision: target.revision })}
            />
          </>
        )}
      </div>
    </ConfirmAction>
  );
}
