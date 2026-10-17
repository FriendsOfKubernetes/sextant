import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errorKey, openStream, toApiError, type ClusterId, type ObjectRef } from "../../api";
import type { TransferEvent } from "../../api/generated/TransferEvent";
import { Button, ConfirmDialog, Dialog } from "../../components";
import { formatBytes } from "../metrics/format";

export interface FilesDialogProps {
  clusterId: ClusterId;
  pod: ObjectRef;
  container: string;
  close: () => void;
}

type Direction = "download" | "upload";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "confirm"; source: string; target: string }
  | { kind: "running"; direction: Direction; transferred: number; total: number | null }
  | { kind: "done"; direction: Direction; bytes: number; where: string }
  | { kind: "failed"; message: string }
  | { kind: "cancelled"; direction: Direction };

/** The last part of a local path (either separator). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Copies files to and from a container (`kubectl cp`, through `tar` in the container): a file or folder is downloaded
 * to a path chosen in the save dialog (a folder as `.tar.gz`), a local file is uploaded to a path in the container
 * after a confirmation. Shows the size and the progress; "Cancel" (or closing the dialog) stops the transfer.
 */
export function FilesDialog({ clusterId, pod, container, close }: FilesDialogProps) {
  const { t } = useTranslation();
  const [remote, setRemote] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const stopRef = useRef<(() => void) | null>(null);
  const remoteId = useId();
  const targetId = useId();
  // Closing the dialog cancels a transfer still running.
  useEffect(() => () => stopRef.current?.(), []);

  const failed = (err: unknown, direction?: Direction) => {
    const error = toApiError(err);
    const parts = [t(errorKey(error.code)), error.message];
    if (direction === "upload") parts.push(t("terminal:files.partialUpload"));
    setPhase({ kind: "failed", message: parts.filter(Boolean).join(" — ") });
  };

  const run = (direction: Direction, where: string, start: (id: string) => Promise<unknown>) => {
    setPhase({ kind: "running", direction, transferred: 0, total: null });
    const stop = openStream<TransferEvent>({
      start,
      listen: api.files.onTransfer,
      stop: api.files.transferStop,
      onEvent: (event) => {
        if (event.type === "progress") {
          setPhase({ kind: "running", direction, transferred: event.transferred, total: event.total });
          return;
        }
        stopRef.current = null;
        stop();
        if (event.type === "done") setPhase({ kind: "done", direction, bytes: event.bytes, where });
        else failed(event.error, direction);
      },
      onStartError: (err) => {
        stopRef.current = null;
        failed(err, direction);
      },
    });
    stopRef.current = stop;
  };

  const cancel = () => {
    stopRef.current?.();
    stopRef.current = null;
    setPhase({ kind: "cancelled", direction: phase.kind === "running" ? phase.direction : "download" });
  };

  const download = async () => {
    const path = remote.trim();
    if (!path) return;
    setPhase({ kind: "checking" });
    let entry;
    try {
      entry = await api.files.stat(clusterId, pod, container, path);
    } catch (err) {
      failed(err);
      return;
    }
    if (entry.kind === "symlink") {
      setPhase({ kind: "failed", message: t("terminal:files.symlink", { path, target: entry.linkTarget ?? "" }) });
      return;
    }
    if (entry.kind === "other") {
      setPhase({ kind: "failed", message: t("terminal:files.notAFile", { path }) });
      return;
    }
    const folder = entry.kind === "directory";
    const destination = await api.dialog.saveFile({
      title: t("terminal:files.saveTitle", { path }),
      defaultPath: folder ? `${entry.name}.tar.gz` : entry.name,
      filters: folder ? [{ name: t("terminal:files.archive"), extensions: ["gz"] }] : undefined,
    });
    if (!destination) {
      setPhase({ kind: "idle" });
      return;
    }
    const kind = entry.kind;
    run("download", destination, (id) =>
      api.files.downloadStart(clusterId, pod, container, path, kind, destination, id),
    );
  };

  const chooseFile = async () => {
    const picked = await api.dialog.openFile({ title: t("terminal:files.chooseTitle") });
    if (!picked) return;
    setSource(picked);
    setTarget(`/tmp/${baseName(picked)}`);
  };

  const upload = () => {
    const path = target.trim();
    if (!source || !path) return;
    setPhase({ kind: "confirm", source, target: path });
  };

  const busy = phase.kind === "running" || phase.kind === "checking";
  return (
    <Dialog
      open
      title={t("terminal:files.title", { pod: pod.name, container })}
      onClose={close}
      footer={
        busy ? (
          <Button variant="danger" onClick={cancel}>
            {t("terminal:files.cancel")}
          </Button>
        ) : (
          <Button onClick={close}>{t("common:actions.close")}</Button>
        )
      }
    >
      <div className="terminal-form">
        <div className="terminal-form__field">
          <label htmlFor={remoteId}>{t("terminal:files.downloadPath")}</label>
          <div className="terminal-form__row">
            <input
              id={remoteId}
              type="text"
              value={remote}
              spellCheck={false}
              autoFocus
              placeholder={t("terminal:files.downloadPlaceholder")}
              onChange={(e) => setRemote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void download();
              }}
            />
            <Button icon="download" disabled={busy || remote.trim() === ""} onClick={() => void download()}>
              {t("terminal:files.download")}
            </Button>
          </div>
          <span className="terminal-form__hint">{t("terminal:files.downloadHint")}</span>
        </div>

        <div className="terminal-form__field">
          <span className="terminal-form__label">{t("terminal:files.upload")}</span>
          <div className="terminal-form__row">
            <Button disabled={busy} onClick={() => void chooseFile()}>
              {t("terminal:files.choose")}
            </Button>
            <span className="terminal-form__mono terminal-form__grow">{source ?? t("terminal:files.noFile")}</span>
          </div>
          {source && (
            <>
              <label htmlFor={targetId}>{t("terminal:files.uploadPath")}</label>
              <div className="terminal-form__row">
                <input
                  id={targetId}
                  type="text"
                  value={target}
                  spellCheck={false}
                  onChange={(e) => setTarget(e.target.value)}
                />
                <Button variant="primary" disabled={busy || target.trim() === ""} onClick={upload}>
                  {t("terminal:files.uploadButton")}
                </Button>
              </div>
            </>
          )}
        </div>

        <TransferStatus phase={phase} />
      </div>
      {phase.kind === "confirm" && (
        <ConfirmDialog
          open
          title={t("terminal:files.confirmTitle")}
          confirmLabel={t("terminal:files.uploadButton")}
          onCancel={() => setPhase({ kind: "idle" })}
          onConfirm={() => {
            const { source: from, target: to } = phase;
            run("upload", to, (id) => api.files.uploadStart(clusterId, pod, container, from, to, id));
          }}
        >
          <p>{t("terminal:files.confirm", { file: baseName(phase.source), path: phase.target, container, pod: pod.name })}</p>
        </ConfirmDialog>
      )}
    </Dialog>
  );
}

function TransferStatus({ phase }: { phase: Phase }) {
  const { t } = useTranslation();
  switch (phase.kind) {
    case "checking":
      return (
        <p className="terminal-form__status" role="status">
          {t("terminal:files.checking")}
        </p>
      );
    case "running": {
      const done = formatBytes(phase.transferred);
      const percent =
        phase.total && phase.total > 0 ? Math.min(100, Math.round((phase.transferred / phase.total) * 100)) : null;
      const text =
        phase.total === null
          ? t("terminal:files.progressUnknown", { done })
          : t("terminal:files.progress", { done, total: formatBytes(phase.total), percent: percent ?? 0 });
      return (
        <div className="terminal-form__status" role="status">
          <span>{phase.direction === "download" ? t("terminal:files.downloading") : t("terminal:files.uploading")}</span>
          <div
            className="terminal-progress"
            role="progressbar"
            aria-label={t("terminal:files.progressLabel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <div className="terminal-progress__bar" style={{ width: `${percent ?? 0}%` }} />
          </div>
          <span>{text}</span>
        </div>
      );
    }
    case "done":
      return (
        <p className="terminal-form__status terminal-form__status--ok" role="status">
          {phase.direction === "download"
            ? t("terminal:files.downloaded", { size: formatBytes(phase.bytes), path: phase.where })
            : t("terminal:files.uploaded", { size: formatBytes(phase.bytes), path: phase.where })}
        </p>
      );
    case "failed":
      return (
        <p className="terminal-form__status terminal-form__status--error" role="alert">
          {phase.message}
        </p>
      );
    case "cancelled":
      return (
        <p className="terminal-form__status" role="status">
          {phase.direction === "upload" ? t("terminal:files.cancelledUpload") : t("terminal:files.cancelled")}
        </p>
      );
    default:
      return null;
  }
}
