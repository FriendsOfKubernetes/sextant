// Details section of pods and services: one "Forward" button per port, and the forwards already running for
// this object with a way to open them.
import { Block } from "../details/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { Button } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { ForwardDialog } from "./ForwardDialog";
import { usePortForwards } from "./hooks";
import { portsOf, sameTarget, targetOf } from "./model";
import { openInBrowser } from "./openInBrowser";
import "./portforward.css";

export function PortForwardSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const ports = obj ? portsOf(obj as KubeObject, objectRef.kind) : [];
  if (ports.length === 0) return null;
  return <Block id="portforward:section.title" title={t("portforward:section.title")}><PortList clusterId={clusterId} objectRef={objectRef} ports={ports} /></Block>;
}

function PortList({ clusterId, objectRef, ports }: Pick<DetailsSectionProps, "clusterId" | "objectRef"> & { ports: number[] }) {
  const { t } = useTranslation();
  const [dialogPort, setDialogPort] = useState<number | null>(null);
  const { forwards } = usePortForwards();
  const target = targetOf(objectRef);
  const mine = forwards.filter((f) => f.cluster === clusterId && sameTarget(f.target, target));

  return (
    <div className="pf-section">

      <ul className="pf-section__ports">
        {ports.map((port) => (
          <li key={port}>
            <span className="pf-section__port">{port}</span>
            <Button
              aria-label={t("portforward:section.forwardPort", { port })}
              onClick={() => setDialogPort(port)}
            >
              {t("portforward:section.forward")}
            </Button>
          </li>
        ))}
      </ul>
      {mine.length > 0 && (
        <ul className="pf-section__active">
          {mine.map((f) => (
            <li key={f.id} className={f.status.state === "error" ? "pf-section__error" : undefined}>
              <span>{t("portforward:section.active", { local: f.localPort, remote: f.remotePort })}</span>
              <Button onClick={() => openInBrowser(f)}>
                {t("portforward:actions.open")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {dialogPort !== null && (
        <ForwardDialog
          clusterId={clusterId}
          target={target}
          ports={ports}
          initialPort={dialogPort}
          close={() => setDialogPort(null)}
        />
      )}
    </div>
  );
}
