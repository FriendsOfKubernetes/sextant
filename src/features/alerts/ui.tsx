// Pieces of the alert views shared by the Alerts page and the details section: the state, the severity, the object an
// alert names, its annotation links and one alert's row. Texts from the cluster are shown as plain text only (the core
// has clipped them and cleaned every URI in them); a link opens only an `http(s)` URL the core cleaned, in the system
// browser.
import { useTranslation } from "react-i18next";
import { api, type Alert, type AlertLink, type AlertState, type ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { Age, Badge, Button, type BadgeTone } from "../../components";
import { alertTarget, shownLabels } from "./model";

const STATE_TONE: Record<AlertState, BadgeTone> = {
  firing: "danger",
  pending: "warning",
  silenced: "neutral",
  inhibited: "neutral",
};

export function StateBadge({ state }: { state: AlertState }) {
  const { t } = useTranslation();
  return <Badge tone={STATE_TONE[state]}>{t(`alerts:state.${state}`)}</Badge>;
}

const KNOWN_SEVERITIES = new Set(["critical", "error", "high", "warning", "medium", "info", "low", "none"]);

/** A severity as shown: the usual names translated, any other as the cluster says it. */
export function useSeverityText(): (severity: string) => string {
  const { t } = useTranslation();
  return (severity) => {
    if (severity === "") return t("alerts:severity.unset");
    return KNOWN_SEVERITIES.has(severity) ? t(`alerts:severity.${severity}`) : severity;
  };
}

export const severityTone = (severity: string | null): BadgeTone =>
  severity === "critical" || severity === "error" || severity === "high"
    ? "danger"
    : severity === "warning" || severity === "medium"
      ? "warning"
      : "info";

export function ObjectButton({ object }: { object: ObjectRef }) {
  const { t } = useTranslation();
  const openDetails = useAppStore((s) => s.openDetails);
  const text = object.namespace ? `${object.kind.kind}: ${object.namespace}/${object.name}` : `${object.kind.kind}: ${object.name}`;
  return (
    <button
      type="button"
      className="rt-link al-object"
      aria-label={t("resources:table.openObject", { kind: object.kind.kind, name: object.name })}
      onClick={() => openDetails(object)}
    >
      {text}
    </button>
  );
}

function linkLabel(link: AlertLink, t: (key: string) => string): string {
  const key = link.key.toLowerCase();
  if (key.startsWith("runbook")) return t("alerts:link.runbook");
  if (key.startsWith("dashboard") || key.startsWith("grafana")) return t("alerts:link.dashboard");
  return link.key;
}

export function Links({ links }: { links: readonly AlertLink[] }) {
  const { t } = useTranslation();
  if (links.length === 0) return null;
  return (
    <span className="al-links">
      {links.map((link) => (
        <Button
          key={`${link.key}|${link.url}`}
          size="compact"
          icon="external"
          title={link.cleaned ? t("alerts:link.cleaned", { url: link.url }) : link.url}
          onClick={() => void api.shell.openUrl(link.url).catch(() => undefined)}
        >
          {linkLabel(link, t)}
        </Button>
      ))}
    </span>
  );
}

/** One alert: state, object, age, summary and description, labels and links. */
export function AlertRow({ alert, showObject = true, showName = false }: { alert: Alert; showObject?: boolean; showName?: boolean }) {
  const { t } = useTranslation();
  const severityText = useSeverityText();
  const object = showObject ? alertTarget(alert) : null;
  const labels = shownLabels(alert);
  return (
    <li className="al-row" data-state={alert.state}>
      <div className="al-row__head">
        <StateBadge state={alert.state} />
        {showName && <span className="al-row__name">{alert.name}</span>}
        {showName && alert.severity && <Badge tone={severityTone(alert.severity)}>{severityText(alert.severity)}</Badge>}
        {object && <ObjectButton object={object} />}
        {alert.activeAt && (
          <span className="al-row__age" title={t("alerts:activeSince")}>
            <Age timestamp={alert.activeAt} />
          </span>
        )}
        <Links links={alert.links} />
      </div>
      {alert.summary && <p className="al-row__summary">{alert.summary}</p>}
      {alert.description && <p className="al-row__description">{alert.description}</p>}
      {labels.length > 0 && (
        <ul className="al-labels" aria-label={t("alerts:labels")}>
          {labels.map(([k, v]) => (
            <li key={k} className="al-label">{`${k}=${v}`}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
