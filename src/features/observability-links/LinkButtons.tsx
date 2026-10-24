// "Open in Grafana" and "Find traces" (#266): the links of an object or a traffic edge, built at the click (so the
// time window ends then) and opened in the system browser. Sextant itself requests nothing. Shows nothing when the
// cluster has no link for the target.
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, useSettings, type ClusterId, type TrafficPeer } from "../../api";
import { Button } from "../../components";
import { buildLinks, edgeValues, linksOf, type ObjectLinks } from "./model";
import type { DashboardTarget, Values } from "./template";

export interface LinkButtonsProps {
  clusterId: ClusterId;
  target: DashboardTarget;
  /** The values at a time (`now`, in milliseconds). */
  valuesAt: (now: number) => Values;
}

/** The links a target would get now; both null when there is nothing to show. */
export function useObjectLinks(clusterId: ClusterId, target: DashboardTarget, valuesAt: (now: number) => Values): ObjectLinks {
  const { settings } = useSettings();
  return buildLinks(linksOf(settings, clusterId), target, valuesAt(Date.now()));
}

export function LinkButtons({ clusterId, target, valuesAt }: LinkButtonsProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [error, setError] = useState<string | null>(null);
  const links = linksOf(settings, clusterId);
  const shown = buildLinks(links, target, valuesAt(Date.now()));
  if (!shown.dashboard && !shown.traces) return null;
  const open = (which: keyof ObjectLinks) => {
    setError(null);
    const url = buildLinks(links, target, valuesAt(Date.now()))[which];
    if (!url) return;
    api.shell.openUrl(url).catch((err: unknown) => setError(toApiError(err).message));
  };
  return (
    <div className="observability-links">
      {shown.dashboard && (
        <Button size="compact" icon="external" onClick={() => open("dashboard")}>
          {t("observability:openGrafana")}
        </Button>
      )}
      {shown.traces && (
        <Button size="compact" icon="external" onClick={() => open("traces")}>
          {t("observability:findTraces")}
        </Button>
      )}
      {error && (
        <p className="observability-links__error" role="alert">
          {t("observability:openFailed", { error })}
        </p>
      )}
    </div>
  );
}

/** The links of a traffic edge (the traffic graph's panel): by both ends' names, the destination as the service. */
export function EdgeLinks({ clusterId, from, to }: { clusterId: ClusterId; from: TrafficPeer; to: TrafficPeer }) {
  const valuesAt = useCallback((now: number) => edgeValues(from, to, now), [from, to]);
  return <LinkButtons clusterId={clusterId} target="edge" valuesAt={valuesAt} />;
}
