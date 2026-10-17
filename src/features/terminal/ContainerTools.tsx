import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject, ObjectRef } from "../../api";
import { Button } from "../../components";
import { DebugDialog } from "./DebugDialog";
import { FilesDialog } from "./FilesDialog";
import { shellContainers } from "./tabs";

export interface ContainerToolsProps {
  clusterId: ClusterId;
  pod: ObjectRef;
  obj: KubeObject;
  container: string;
  /** The container's status (`status.containerStatuses[]`), if any. */
  status: unknown;
}

function isRunning(status: unknown): boolean {
  const state = (status as { state?: { running?: unknown } } | undefined)?.state;
  return state?.running !== undefined && state.running !== null;
}

/**
 * "Debug" and "Files" for one regular container of a pod in its details: a debug container targeting it (any pod: a
 * crashed one is debugged as a copy) and copying files to and from it (only while it runs).
 */
export function ContainerTools({ clusterId, pod, obj, container, status }: ContainerToolsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<"debug" | "files" | null>(null);
  const close = () => setOpen(null);
  return (
    <span className="terminal-tools">
      <Button size="compact" icon="shell" onClick={() => setOpen("debug")}>
        {t("terminal:debug.action")}
      </Button>
      {isRunning(status) && (
        <Button size="compact" icon="download" onClick={() => setOpen("files")}>
          {t("terminal:files.action")}
        </Button>
      )}
      {open === "debug" && (
        <DebugDialog
          clusterId={clusterId}
          pod={pod}
          containers={shellContainers(obj)}
          target={container}
          close={close}
        />
      )}
      {open === "files" && <FilesDialog clusterId={clusterId} pod={pod} container={container} close={close} />}
    </span>
  );
}
