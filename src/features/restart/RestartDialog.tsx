// The confirmation, progress and result of "Restart" (#255, ADR-0112). The confirmation names every step (the first
// MAX_LISTED, then a count) and shows the patches as they will be sent; nothing reaches the cluster before "Restart".
// While it runs, Escape and the backdrop do nothing and "Stop" starts nothing more; the end lists what was restarted,
// what failed and why, and what was not started. One object restarted without trouble closes the dialog at once.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { Button, Dialog, ErrorState } from "../../components";
import { formatList } from "../../i18n/format";
import { rfc3339Seconds } from "../argo-rollouts/patches";
import { isArgoRollout, isRolloutKind, MAX_LISTED, objectLabel, type RestartStep } from "./model";
import { runRestart, type Progress, type RunControl, type StepOutcome } from "./run";

const TEMPLATE_PATCH = (at: string) => ({
  spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": at } } } },
});

/** The sentence that says what happens to the object of `step`. */
function stepText(step: RestartStep, t: (key: string, options?: Record<string, unknown>) => string): string {
  const name = objectLabel(step.target);
  switch (step.type) {
    case "rollout":
      return t("restart:step.rollout", { name });
    case "argoRollout":
      return t("restart:step.argoRollout", { name });
    case "owner":
      return t("restart:step.owner", { name, replicaSets: formatList(step.replicaSets.map((rs) => rs.ref.name)) });
    case "pods":
      return t("restart:step.pods", { name });
    case "pod":
      return t("restart:step.pod", { name, controller: objectLabel({ ...step.target, kind: step.controller.kind, name: step.controller.name }) });
  }
}

function titleOf(steps: readonly RestartStep[], t: (key: string, options?: Record<string, unknown>) => string): string {
  const [only] = steps;
  if (steps.length !== 1 || !only) return t("restart:titleMany", { count: steps.length });
  if (only.type === "pods") return t("restart:titlePods", { name: only.target.name });
  return t("restart:title", { kind: only.target.kind.kind, name: only.target.name });
}

/** Which patches the steps send: the template annotation (rollout restart) and the Rollout's `restartAt`. */
function patchKinds(steps: readonly RestartStep[]): { template: boolean; argo: boolean } {
  let template = false;
  let argo = false;
  for (const step of steps) {
    if (step.type !== "rollout" && step.type !== "argoRollout" && step.type !== "owner") continue;
    if (isArgoRollout(step.target.kind)) argo = true;
    else if (isRolloutKind(step.target.kind)) template = true;
  }
  return { template, argo };
}

export interface RestartDialogProps {
  clusterId: ClusterId;
  steps: RestartStep[];
  close: () => void;
  /** Tests: the clock and the replacement timeout of the run. */
  control?: Pick<RunControl, "now" | "replacementTimeoutMs">;
}

export function RestartDialog({ clusterId, steps, close, control }: RestartDialogProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"confirm" | "running" | "result">("confirm");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const [outcomes, setOutcomes] = useState<StepOutcome[]>([]);
  const [stopFlag] = useState(() => ({ stopped: false }));
  const [openedAt] = useState(() => rfc3339Seconds(control?.now?.() ?? new Date()));

  const start = async () => {
    setPhase("running");
    const result = await runRestart(clusterId, steps, {
      ...control,
      stopped: () => stopFlag.stopped,
      onProgress: setProgress,
    });
    if (steps.length === 1 && result[0]?.status === "done" && result[0].podsTotal === undefined) {
      close();
      return;
    }
    setOutcomes(result);
    setPhase("result");
  };
  const stop = () => {
    stopFlag.stopped = true;
    setStopRequested(true);
  };

  const title = titleOf(steps, t);
  if (phase === "result") return <ResultView title={title} steps={steps} outcomes={outcomes} close={close} />;

  if (phase === "running") {
    const step = progress ? steps[progress.index] : undefined;
    const name = step ? objectLabel(step.target) : "";
    const text =
      progress?.podsTotal !== undefined
        ? t("restart:progressPods", { name, done: progress.podsDone ?? 0, count: progress.podsTotal })
        : t("restart:progress", { name, current: (progress?.index ?? 0) + 1, total: steps.length });
    return (
      <Dialog
        open
        title={title}
        onClose={() => {}}
        footer={
          <Button disabled={stopRequested} onClick={stop}>
            {stopRequested ? t("restart:stopping") : t("restart:stop")}
          </Button>
        }
      >
        <p role="status">{text}</p>
      </Dialog>
    );
  }

  const { template, argo } = patchKinds(steps);
  const hidden = steps.length - MAX_LISTED;
  return (
    <Dialog
      open
      title={title}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" disabled={steps.length === 0} onClick={() => void start()}>
            {t("restart:confirm")}
          </Button>
        </>
      }
    >
      {steps.length > 1 && <p>{t("restart:intro", { count: steps.length })}</p>}
      <ul className="restart-dialog__steps">
        {steps.slice(0, MAX_LISTED).map((step) => (
          <li key={objectLabel(step.target)}>{stepText(step, t)}</li>
        ))}
      </ul>
      {hidden > 0 && <p>{t("restart:more", { count: hidden })}</p>}
      {template && <Patch label={t("restart:templatePatch")}>{JSON.stringify(TEMPLATE_PATCH(openedAt))}</Patch>}
      {argo && <Patch label={t("restart:argoPatch")}>{JSON.stringify({ spec: { restartAt: openedAt } })}</Patch>}
    </Dialog>
  );
}

function Patch({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <p className="action-dialog__hint">{label}</p>
      <pre className="dt-pre restart-dialog__patch">{children}</pre>
    </>
  );
}

function ResultView({
  title,
  steps,
  outcomes,
  close,
}: {
  title: string;
  steps: RestartStep[];
  outcomes: StepOutcome[];
  close: () => void;
}) {
  const { t } = useTranslation();
  const done = outcomes.filter((o) => o.status === "done").length;
  const stopped = outcomes.some((o) => o.status === "stopped" || o.status === "skipped");
  return (
    <Dialog
      open
      title={title}
      onClose={close}
      footer={
        <Button variant="primary" onClick={close}>
          {t("actions:dialog.close")}
        </Button>
      }
    >
      <p>{t(stopped ? "restart:summaryStopped" : "restart:summary", { done, total: steps.length })}</p>
      <ul className="restart-dialog__results">
        {steps.map((step, i) => {
          const outcome = outcomes[i];
          const name = objectLabel(step.target);
          if (!outcome) return null;
          const pods =
            "podsTotal" in outcome && outcome.podsTotal !== undefined
              ? t("restart:result.pods", { done: outcome.podsDone ?? 0, count: outcome.podsTotal })
              : null;
          if (outcome.status === "failed") {
            return (
              <li key={name}>
                <ErrorState error={outcome.error} title={t("restart:result.failed", { name })} />
                {pods && <p className="action-dialog__hint">{pods}</p>}
              </li>
            );
          }
          return (
            <li key={name}>
              {t(`restart:result.${outcome.status}`, { name })}
              {pods && <span className="action-dialog__hint restart-dialog__pods">{pods}</span>}
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
