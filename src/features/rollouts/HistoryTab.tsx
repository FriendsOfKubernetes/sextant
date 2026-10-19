// The "History" tab of a Deployment, StatefulSet or DaemonSet: where the rollout stands, the revisions (time,
// change-cause, images, the current one marked), two of them compared side by side, and "Roll back to revision N".
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import { Age, Badge, Button, Checkbox, ErrorState, LoadingIndicator, type BadgeTone } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import {
  revisionsOf,
  revisionsWatchSpec,
  rolloutStatus,
  templateYaml,
  workloadKind,
  type RevisionInfo,
  type RolloutState,
  type WorkloadKind,
} from "./model";
import { RollbackDialog } from "./RollbackDialog";
import { TemplateDiff } from "./TemplateDiff";
import { ResizableTable } from "../../components/Table";

const STATE_TONE: Record<RolloutState, BadgeTone> = {
  complete: "success",
  progressing: "info",
  paused: "warning",
  failed: "danger",
};

export function HistoryTab({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const kind = workloadKind(objectRef.kind);
  if (!obj || !kind) return null;
  return <History clusterId={clusterId} objectRef={objectRef} workload={obj} kind={kind} />;
}

function RolloutStatusBlock({ workload, kind }: { workload: KubeObject; kind: WorkloadKind }) {
  const { t } = useTranslation();
  const s = rolloutStatus(workload, kind);
  return (
    <section className="rollouts-status" aria-label={t("rollouts:status.title")}>
      <div className="rollouts-status__line">
        <Badge tone={STATE_TONE[s.state]}>{t(`rollouts:status.state.${s.state}`)}</Badge>
        <span>
          {t("rollouts:status.replicas", {
            updated: s.updated,
            desired: s.desired,
            ready: s.ready,
            available: s.available,
          })}
        </span>
      </div>
      {s.pendingObservation && <p className="rollouts-note">{t("rollouts:status.pendingObservation")}</p>}
      {s.state === "failed" && (
        <p className="rollouts-note rollouts-note--danger">
          {t("rollouts:status.stuck", { reason: s.reason, message: s.message ?? "" })}
        </p>
      )}
      {s.state === "paused" && <p className="rollouts-note rollouts-note--warning">{t("rollouts:status.pausedHint")}</p>}
    </section>
  );
}

function History({
  clusterId,
  objectRef,
  workload,
  kind,
}: {
  clusterId: ClusterId;
  objectRef: ObjectRef;
  workload: KubeObject;
  kind: WorkloadKind;
}) {
  const { t } = useTranslation();
  // Compared by value: status updates of the workload keep the watch.
  const spec = revisionsWatchSpec(workload, kind);
  const { items, status, error } = useWatch(spec ? clusterId : null, spec);
  const revisions = useMemo(() => revisionsOf(workload, kind, items.values()), [workload, kind, items]);
  const [selected, setSelected] = useState<number[]>([]);
  const [rollbackTo, setRollbackTo] = useState<number | null>(null);

  // Selections of revisions that are gone (pruned by revisionHistoryLimit) drop out.
  const compared = selected.filter((n) => revisions.some((r) => r.revision === n));
  const toggle = (revision: number, on: boolean) =>
    setSelected((current) => {
      const kept = current.filter((n) => n !== revision && revisions.some((r) => r.revision === n));
      // A third selection replaces the older of the two.
      return on ? [...kept.slice(-1), revision] : kept;
    });

  const pair = compared.length === 2 ? pairOf(revisions, compared) : null;

  return (
    <div className="rollouts">
      <RolloutStatusBlock workload={workload} kind={kind} />
      <h3 className="rollouts__heading">{t("rollouts:history.title")}</h3>
      {spec && status === "loading" ? (
        <LoadingIndicator text={t("rollouts:history.loading")} />
      ) : status === "error" ? (
        <ErrorState error={error} />
      ) : revisions.length === 0 ? (
        <p>{t("rollouts:history.empty")}</p>
      ) : (
        <>
          <ResizableTable tableId="rollouts.history" className="rollouts__table">
            <thead>
              <tr>
                <th scope="col" className="rollouts__select">
                  <span className="rollouts__sr">{t("rollouts:history.columns.compare")}</span>
                </th>
                <th scope="col">{t("rollouts:history.columns.revision")}</th>
                <th scope="col">{t("rollouts:history.columns.created")}</th>
                <th scope="col">{t("rollouts:history.columns.changeCause")}</th>
                <th scope="col">{t("rollouts:history.columns.images")}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {[...revisions].reverse().map((r) => (
                <tr key={r.revision} className={r.current ? "rollouts__row--current" : undefined}>
                  <td className="rollouts__select">
                    <Checkbox
                      checked={compared.includes(r.revision)}
                      onChange={(e) => toggle(r.revision, e.target.checked)}
                      aria-label={t("rollouts:history.select", { revision: r.revision })}
                    />
                  </td>
                  <td>
                    <span className="rollouts__revision">{r.revision}</span>
                    {r.current && <Badge tone="success">{t("rollouts:history.current")}</Badge>}
                  </td>
                  <td>
                    <Age timestamp={r.created} />
                  </td>
                  <td className="rollouts__cause">{r.changeCause}</td>
                  <td className="rollouts__images">
                    {r.images.map((image) => (
                      <code key={image}>{image}</code>
                    ))}
                  </td>
                  <td className="rollouts__actions">
                    {!r.current && (
                      <Button
                        size="compact"
                        icon="rollback"
                        iconOnly
                        label={t("rollouts:history.rollBack", { revision: r.revision })}
                        onClick={() => setRollbackTo(r.revision)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </ResizableTable>
          {pair ? (
            <TemplateDiff
              left={templateYaml(pair[0].template)}
              right={templateYaml(pair[1].template)}
              leftTitle={t("rollouts:history.revisionTitle", { revision: pair[0].revision })}
              rightTitle={t("rollouts:history.revisionTitle", { revision: pair[1].revision })}
            />
          ) : (
            revisions.length > 1 && (
              <p className="rollouts-note">
                {compared.length === 1 ? t("rollouts:history.pickOneMore") : t("rollouts:history.pickTwo")}
              </p>
            )
          )}
        </>
      )}
      {rollbackTo !== null && (
        <RollbackDialog
          clusterId={clusterId}
          objectRef={objectRef}
          workload={workload}
          kind={kind}
          revisions={revisions}
          initial={rollbackTo}
          close={() => setRollbackTo(null)}
        />
      )}
    </div>
  );
}

/** The two compared revisions, older first. */
function pairOf(revisions: RevisionInfo[], numbers: number[]): [RevisionInfo, RevisionInfo] | null {
  const [a, b] = [...numbers].sort((x, y) => x - y).map((n) => revisions.find((r) => r.revision === n));
  return a && b ? [a, b] : null;
}
