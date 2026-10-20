// "Set image…" on a Pod a controller owns: its controller would replace the Pod (or ignore the change and roll the
// old image back with the next replacement), so the dialog offers the owner instead — through a ReplicaSet to its
// Deployment and through a Job to its CronJob, with one read of the middle object. A static Pod's mirror only says
// where its image is set.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId } from "../../api";
import { useAppStore } from "../../app/store";
import { Button, Dialog, LoadingIndicator } from "../../components";
import { kindFromApiVersion } from "../../resources/refs";
import type { OwnerRef } from "../../resources/status";
import { LOOK_THROUGH, podController } from "./model";

export interface OwnedPodDialogProps {
  clusterId: ClusterId;
  /** The Pod's name, for the title. */
  name: string;
  namespace: string | null;
  /** The Pod's controller; `null` for a static Pod's mirror. */
  owner: OwnerRef | null;
  close: () => void;
}

export function OwnedPodDialog({ clusterId, name, namespace, owner, close }: OwnedPodDialogProps) {
  const { t } = useTranslation();
  const openDetails = useAppStore((s) => s.openDetails);
  const looksThrough = owner !== null && LOOK_THROUGH.includes(owner.kind);
  const [target, setTarget] = useState<OwnerRef | null>(looksThrough ? null : owner);

  useEffect(() => {
    if (!owner || !looksThrough) return;
    let current = true;
    const ref = { kind: kindFromApiVersion(owner.apiVersion, owner.kind), namespace, name: owner.name };
    api.resources
      .get(clusterId, ref)
      .then((middle) => current && setTarget(podController(middle) ?? owner))
      .catch(() => current && setTarget(owner));
    return () => {
      current = false;
    };
  }, [clusterId, namespace, owner, looksThrough]);

  const open = () => {
    if (!target) return;
    openDetails({ kind: kindFromApiVersion(target.apiVersion, target.kind), namespace, name: target.name });
    close();
  };

  const footer = (
    <>
      <Button onClick={close}>{t("actions:dialog.close")}</Button>
      {owner && (
        <Button variant="primary" disabled={!target} onClick={open}>
          {target ? t("setimage:owned.open", { kind: target.kind, name: target.name }) : t("setimage:owned.looking")}
        </Button>
      )}
    </>
  );

  return (
    <Dialog open title={t("setimage:title", { name })} onClose={close} footer={footer}>
      <div className="set-image">
        {owner === null ? (
          <p>{t("setimage:mirror")}</p>
        ) : target === null ? (
          <LoadingIndicator text={t("setimage:owned.looking")} />
        ) : (
          <p>{t("setimage:owned.intro", { kind: target.kind, name: target.name })}</p>
        )}
      </div>
    </Dialog>
  );
}
