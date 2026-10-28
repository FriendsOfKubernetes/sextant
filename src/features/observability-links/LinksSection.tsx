// The "Dashboards and traces" section of a workload's, pod's, node's or namespace's details (#266): shown only when
// the cluster's settings give the object a link.
import { Block } from "../details/ui";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { KindRef } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { LinkButtons, useObjectLinks } from "./LinkButtons";
import { objectValues, targetOf } from "./model";

export function linksApply(kind: KindRef): boolean {
  return targetOf(kind) !== null;
}

export function LinksSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const target = targetOf(objectRef.kind);
  const valuesAt = useCallback(
    (now: number) => (obj && target ? objectValues(objectRef.kind, obj, target, now) : {}),
    [obj, objectRef.kind, target],
  );
  const links = useObjectLinks(clusterId, target ?? "pod", valuesAt);
  if (!obj || !target || (!links.dashboard && !links.traces)) return null;
  return (
    <Block id="observability:details.title" title={t("observability:details.title")} label={t("observability:details.title")}>

      <LinkButtons clusterId={clusterId} target={target} valuesAt={valuesAt} />
    </Block>
  );
}
