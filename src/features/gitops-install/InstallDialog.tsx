// The install dialog of Flux or Argo CD: choose a version (GitHub's stable releases, or the bundled one) → download
// and check the official manifest → preview (source, SHA-256, objects, cluster-wide changes, rights, what exists) →
// "Install" → objects applied one by one → waiting for the controllers (up to 5 minutes) → the result. Closing it
// while the install runs asks whether to stop; a stop ends the install after the object being applied.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  openStream,
  toApiError,
  type ApiError,
  type ClusterId,
  type GitopsTool,
  type GitopsVersions,
  type InstallEvent,
  type InstallPreview,
  type WorkloadState,
} from "../../api";
import { Badge, Button, ConfirmDialog, Dialog, ErrorState, LoadingIndicator } from "../../components";
import { refreshClusterKinds } from "../../resources";
import { initialRun, reduceRun, type RunState } from "./run";
import "./gitopsInstall.css";
import { formatList } from "../../i18n";

export interface InstallDialogProps {
  clusterId: ClusterId;
  tool: GitopsTool;
  onClose: () => void;
}

/** The running install's stream: its id once the backend answered the start; a Stop pressed before that waits. */
interface OwnStream {
  close: () => void;
  id: string | null;
  stopWanted: boolean;
}

type Step =
  | { step: "choose" }
  | { step: "preparing"; since: number }
  | { step: "preview"; preview: InstallPreview }
  | { step: "running"; preview: InstallPreview };

/** The sections of a newly installed tool appear without reconnecting: discovery is read again. */
function refreshKinds(clusterId: ClusterId): void {
  api.clusters.refreshKinds(clusterId).then(
    () => refreshClusterKinds(clusterId, { keep: true }),
    () => undefined,
  );
}

export function InstallDialog({ clusterId, tool, onClose }: InstallDialogProps) {
  const { t } = useTranslation();
  const toolName = t(`gitops:tool.${tool}`);
  const [versions, setVersions] = useState<GitopsVersions | null>(null);
  const [version, setVersion] = useState("");
  const [step, setStep] = useState<Step>({ step: "choose" });
  const [error, setError] = useState<ApiError | null>(null);
  const [run, dispatch] = useReducer(reduceRun, initialRun);
  const [askStop, setAskStop] = useState(false);
  const stream = useRef<OwnStream | null>(null);

  useEffect(() => {
    let live = true;
    api.gitopsInstall.versions(tool).then(
      (found) => {
        if (!live) return;
        setVersions(found);
        setVersion(found.latest);
      },
      (err: unknown) => live && setError(toApiError(err)),
    );
    return () => {
      live = false;
    };
  }, [tool]);

  // Closing the dialog (or the window's page) ends the stream, which stops an install still running.
  useEffect(
    () => () => {
      stream.current?.close();
      stream.current = null;
    },
    [],
  );

  const prepare = async () => {
    setError(null);
    setStep({ step: "preparing", since: Date.now() });
    try {
      const preview = await api.gitopsInstall.prepare(clusterId, tool, version);
      setStep({ step: "preview", preview });
    } catch (err) {
      setError(toApiError(err));
      setStep({ step: "choose" });
    }
  };

  const start = (preview: InstallPreview) => {
    setError(null);
    dispatch({ type: "start", total: preview.summary.objects.length });
    setStep({ step: "running", preview });
    const own: OwnStream = { close: () => undefined, id: null, stopWanted: false };
    stream.current = own;
    own.close = openStream<InstallEvent>({
      start: (id, channel) => api.gitopsInstall.start(clusterId, preview.token, id, channel),
      stop: api.gitopsInstall.stop,
      onListening: (id) => {
        own.id = id;
        if (own.stopWanted) void api.gitopsInstall.stop(id).catch(() => undefined);
      },
      onEvent: (event) => {
        dispatch({ type: "event", event });
        if (event.type !== "applied" && event.type !== "failed" && event.type !== "waiting") {
          refreshKinds(clusterId);
          own.close();
          if (stream.current === own) stream.current = null;
        }
      },
      onStartError: (err) => dispatch({ type: "startFailed", error: toApiError(err) }),
    });
  };

  const stop = () => {
    const own = stream.current;
    dispatch({ type: "stopping" });
    if (!own) return;
    // Before the start answered the backend has no install under this id yet: the stop is sent once it answers.
    if (own.id) void api.gitopsInstall.stop(own.id).catch(() => undefined);
    else own.stopWanted = true;
  };

  const running = step.step === "running" && run.outcome === null;
  const close = useCallback(() => {
    if (running) setAskStop(true);
    else onClose();
  }, [running, onClose]);

  const title = t("gitops:dialog.title", { tool: toolName });
  let body;
  let footer;
  if (step.step === "choose") {
    body = (
      <Choose
        tool={tool}
        versions={versions}
        version={version}
        onVersion={setVersion}
        error={error}
      />
    );
    footer = (
      <>
        <Button onClick={onClose}>{t("common:actions.cancel")}</Button>
        <Button variant="primary" disabled={!version} onClick={() => void prepare()}>
          {t("gitops:versions.next")}
        </Button>
      </>
    );
  } else if (step.step === "preparing") {
    body = <LoadingIndicator text={t("gitops:preparing")} since={step.since} />;
    footer = <Button onClick={onClose}>{t("common:actions.cancel")}</Button>;
  } else if (step.step === "preview") {
    body = <Preview preview={step.preview} toolName={toolName} />;
    footer = (
      <>
        <Button onClick={() => setStep({ step: "choose" })}>{t("gitops:back")}</Button>
        <Button variant="danger" onClick={() => start(step.preview)}>
          {t("gitops:install")}
        </Button>
      </>
    );
  } else {
    body = <Progress clusterId={clusterId} preview={step.preview} run={run} toolName={toolName} />;
    footer = running ? (
      <Button variant="danger" disabled={run.stopping} onClick={stop}>
        {t("gitops:stop")}
      </Button>
    ) : (
      <Button variant="primary" onClick={onClose}>
        {t("common:actions.close")}
      </Button>
    );
  }

  return (
    <>
      <Dialog open title={title} onClose={close} footer={footer}>
        <div className="gitops-install">{body}</div>
      </Dialog>
      <ConfirmDialog
        open={askStop}
        title={t("gitops:confirmStop.title")}
        confirmLabel={t("gitops:confirmStop.confirm")}
        danger
        onCancel={() => setAskStop(false)}
        onConfirm={() => {
          setAskStop(false);
          stream.current?.close();
          stream.current = null;
          onClose();
        }}
      >
        <p>{t("gitops:confirmStop.text")}</p>
      </ConfirmDialog>
    </>
  );
}

function Choose({
  tool,
  versions,
  version,
  onVersion,
  error,
}: {
  tool: GitopsTool;
  versions: GitopsVersions | null;
  version: string;
  onVersion: (version: string) => void;
  error: ApiError | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="gitops-install__text">{t(`gitops:dialog.${tool}`)}</p>
      {!versions && !error && <LoadingIndicator text={t("gitops:versions.loading")} />}
      {versions && (
        <label className="gitops-install__field">
          <span>{t("gitops:versions.label")}</span>
          <select value={version} onChange={(e) => onVersion(e.target.value)}>
            {versions.versions.map((v) => (
              <option key={v} value={v}>
                {v === versions.latest ? t(versions.error ? "gitops:versions.bundled" : "gitops:versions.latest", { version: v }) : v}
              </option>
            ))}
          </select>
        </label>
      )}
      {versions?.error && (
        <p className="gitops-install__warning" role="status">
          {t("gitops:versions.error", { version: versions.latest })}{" "}
          <span className="gitops-install__muted">{versions.error}</span>
        </p>
      )}
      {error && <ErrorState error={error} className="gitops-install__error" />}
    </>
  );
}

function Preview({ preview, toolName }: { preview: InstallPreview; toolName: string }) {
  const { t } = useTranslation();
  const { summary, access, existing, overlap } = preview;
  const warnings: string[] = [t("gitops:preview.warning")];
  if (!access.canCreateCrds) warnings.push(t("gitops:preview.noCrdAccess"));
  if (!access.canCreateClusterRoleBindings) warnings.push(t("gitops:preview.noBindingAccess"));
  if (existing.present) warnings.push(t("gitops:preview.present", { tool: toolName }));
  else if (existing.partial) warnings.push(t("gitops:preview.partial", { tool: toolName }));
  if (overlap.leftOutControllers.length > 0) {
    warnings.push(
      t("gitops:preview.leftOut", {
        namespace: preview.namespace,
        names: formatList(overlap.leftOutControllers),
        interpolation: { escapeValue: false },
      }),
    );
  }
  return (
    <>
      <dl className="gitops-install__facts">
        <dt>{t("gitops:preview.version")}</dt>
        <dd>{preview.version}</dd>
        <dt>{t("gitops:preview.source")}</dt>
        <dd className="gitops-install__mono">{preview.sourceUrl}</dd>
        <dt>{t("gitops:preview.sha256")}</dt>
        <dd>
          <span className="gitops-install__mono">{preview.sha256}</span>{" "}
          <Badge tone={preview.checksumVerified ? "success" : "neutral"}>
            {t(preview.checksumVerified ? "gitops:preview.verified" : "gitops:preview.unverified")}
          </Badge>
        </dd>
        <dt>{t("gitops:preview.namespace")}</dt>
        <dd>{preview.namespace}</dd>
      </dl>
      {warnings.map((text) => (
        <p key={text} className="gitops-install__warning" role="alert">
          {text}
        </p>
      ))}
      {overlap.clusterObjects.length > 0 && (
        <div className="gitops-install__warning" role="alert">
          {t("gitops:preview.overwritten")}
          <ul className="gitops-install__names">
            {overlap.clusterObjects.map((o) => (
              <li key={`${o.kind}/${o.name}`}>{`${o.kind} ${o.name}`}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="gitops-install__counts">
        {summary.kinds.map((k) => `${k.kind} ${k.count}`).join(" · ")}
      </p>
      <details className="gitops-install__objects">
        <summary>{t("gitops:preview.objects", { count: summary.objects.length })}</summary>
        <ul>
          {summary.objects.map((o) => (
            <li key={`${o.kind}/${o.namespace ?? ""}/${o.name}`}>
              <span>{`${o.kind} ${o.namespace ? `${o.namespace}/` : ""}${o.name}`}</span>
              {o.clusterScoped && <Badge tone="warning">{t("gitops:preview.clusterScoped")}</Badge>}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function Workloads({ workloads }: { workloads: WorkloadState[] }) {
  const { t } = useTranslation();
  return (
    <ul className="gitops-install__workloads">
      {workloads.map((w) => (
        <li key={`${w.kind}/${w.name}`}>
          <Badge tone={w.ready ? "success" : "warning"}>
            {t(w.ready ? "gitops:progress.ready" : "gitops:progress.notReady")}
          </Badge>
          <span>{`${w.kind} ${w.name}`}</span>
          {w.reason && <span className="gitops-install__muted">{w.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

function Progress({
  clusterId,
  preview,
  run,
  toolName,
}: {
  clusterId: ClusterId;
  preview: InstallPreview;
  run: RunState;
  toolName: string;
}) {
  const { t } = useTranslation();
  const [uiError, setUiError] = useState<unknown>(null);
  const total = preview.summary.objects.length;
  const applied = new Set(run.applied.map((o) => `${o.kind}/${o.name}`));
  const notApplied = preview.summary.objects.filter((o) => !applied.has(`${o.kind}/${o.name}`));
  const outcome = run.outcome;
  return (
    <>
      {outcome === null && !run.workloads && (
        <p className="gitops-install__text" role="status">
          {run.stopping
            ? t("gitops:progress.stopping")
            : t("gitops:progress.applying", { done: run.applied.length, total })}
        </p>
      )}
      {outcome === null && run.workloads && (
        <p className="gitops-install__text" role="status">
          {run.stopping ? t("gitops:progress.stopping") : t("gitops:progress.waiting")}
        </p>
      )}
      {outcome === "done" && (
        <p className="gitops-install__success" role="status">
          {t("gitops:result.done", { tool: toolName, version: preview.version })}
        </p>
      )}
      {outcome === "timedOut" && (
        <p className="gitops-install__warning" role="alert">
          {t("gitops:result.timedOut")}
        </p>
      )}
      {outcome === "stopped" && (
        <p className="gitops-install__warning" role="status">
          {(run.stoppedAfter ?? run.applied.length) >= total
            ? t("gitops:result.stoppedWaiting", { count: total })
            : t("gitops:result.stopped", { count: run.stoppedAfter ?? run.applied.length })}
        </p>
      )}
      {outcome === "error" && (
        <>
          <p className="gitops-install__warning" role="alert">
            {t("gitops:result.failed")}
          </p>
          {run.error && <ErrorState error={run.error} className="gitops-install__error" />}
        </>
      )}
      {run.workloads && <Workloads workloads={run.workloads} />}
      {(outcome === "done" || outcome === "timedOut") && preview.tool === "argoCd" && (
        <div className="gitops-install__argo">
          <p className="gitops-install__text">{t("gitops:argo.login")}</p>
          <Button
            icon="external"
            onClick={() => {
              setUiError(null);
              // Loaded on use: the window shell mounts this dialog, and the Argo CD feature registers its kinds and
              // actions when its modules load.
              import("../argocd/server")
                .then(({ openArgoUi }) => openArgoUi(clusterId, "/applications"))
                .catch((err: unknown) => setUiError(err));
            }}
          >
            {t("gitops:argo.openUi")}
          </Button>
          {uiError !== null && <ErrorState error={uiError} className="gitops-install__error" />}
        </div>
      )}
      <details className="gitops-install__objects" open={outcome === "error" || outcome === "stopped"}>
        <summary>{t("gitops:result.applied", { count: run.applied.length })}</summary>
        <ul>
          {run.applied.map((o) => (
            <li key={`${o.kind}/${o.name}`}>{`${o.kind} ${o.name}`}</li>
          ))}
        </ul>
      </details>
      {outcome !== null && outcome !== "done" && outcome !== "timedOut" && notApplied.length > 0 && (
        <details className="gitops-install__objects" open>
          <summary>{t("gitops:result.notApplied", { count: notApplied.length })}</summary>
          <ul>
            {notApplied.map((o) => (
              <li key={`${o.kind}/${o.name}`}>{`${o.kind} ${o.name}`}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
