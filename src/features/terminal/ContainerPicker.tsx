import { useTranslation } from "react-i18next";
import type { ClusterId, ObjectRef } from "../../api";
import { Button, Dialog } from "../../components";
import { openExecTab } from "./tabs";

export interface ContainerPickerProps {
  clusterId: ClusterId;
  pod: ObjectRef;
  containers: string[];
  /** Listed first and focused. */
  preferred?: string;
  close: () => void;
}

/** Asks which container of a multi-container pod to open a shell in. */
export function ContainerPicker({ clusterId, pod, containers, preferred, close }: ContainerPickerProps) {
  const { t } = useTranslation();
  const ordered = preferred ? [preferred, ...containers.filter((c) => c !== preferred)] : containers;
  const pick = (container: string) => {
    openExecTab(clusterId, pod, container, containers.length);
    close();
  };
  return (
    <Dialog open title={t("terminal:shell.pickContainer", { pod: pod.name })} onClose={close}>
      <p className="terminal-picker__hint">{t("terminal:shell.pickContainerHint")}</p>
      <ul className="terminal-picker">
        {ordered.map((name, i) => (
          <li key={name}>
            <Button
              variant={i === 0 ? "primary" : "default"}
              autoFocus={i === 0}
              onClick={() => pick(name)}
            >
              {name}
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
