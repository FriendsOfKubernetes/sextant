// What each source of a report gave: where the alerts were read, or why a source gave none (off, not found, a
// VictoriaMetrics without vmalert, an error).
import { useTranslation } from "react-i18next";
import type { AlertSource, AlertsReport, ClusterId } from "../../api";
import { Button, ErrorState } from "../../components";
import { openClusterSettings } from "../clusters/clustersStore";
import { ALERTS_SETTINGS_ID } from "./ids";

type Which = "prometheus" | "alertmanager";
const PROMETHEUS: Which = "prometheus";
const ALERTMANAGER: Which = "alertmanager";

/** Whether a report has a source that answered. */
export const anySource = (report: AlertsReport): boolean =>
  report.prometheus.status === "ok" || report.alertmanager.status === "ok";

function Note({ which, source }: { which: Which; source: AlertSource }) {
  const { t } = useTranslation();
  const target = source.target ?? "";
  switch (source.status) {
    case "ok":
      return (
        <>
          <li className="al-source">{t(`alerts:source.${which}.ok`, { target })}</li>
          {source.error && (
            <li>
              <ErrorState className="al-error" title={t("alerts:source.silencesFailed")} error={source.error} />
            </li>
          )}
        </>
      );
    case "failed":
      return (
        <li>
          <ErrorState
            className="al-error"
            title={target ? t(`alerts:source.${which}.failedAt`, { target }) : t(`alerts:source.${which}.failed`)}
            error={source.error}
          />
        </li>
      );
    case "notAvailable":
      return <li className="al-source al-source--muted">{t("alerts:source.prometheus.vmalertMissing", { target })}</li>;
    default:
      return <li className="al-source al-source--muted">{t(`alerts:source.${which}.${source.status}`)}</li>;
  }
}

export function SourceNotes({ clusterId, report }: { clusterId: ClusterId; report: AlertsReport }) {
  const { t } = useTranslation();
  return (
    <div className="al-sources">
      <ul className="al-sources__list" aria-label={t("alerts:source.title")}>
        <Note which={PROMETHEUS} source={report.prometheus} />
        <Note which={ALERTMANAGER} source={report.alertmanager} />
      </ul>
      {!anySource(report) && (
        <Button size="compact" icon="settings" onClick={() => openClusterSettings(clusterId, ALERTS_SETTINGS_ID)}>
          {t("alerts:openSettings")}
        </Button>
      )}
    </div>
  );
}
