// The Alertmanager's active and pending silences (#264), read-only: matchers, state, when they start and end, who
// created them and why. Sextant neither creates nor expires silences.
import { useTranslation } from "react-i18next";
import type { AlertsReport, SilenceMatcher } from "../../api";
import { Badge } from "../../components";
import { formatDateTime } from "../../i18n";

/** A matcher as Alertmanager writes it: `name="value"`, `!=`, `=~`, `!~`. */
export function matcherText(m: SilenceMatcher): string {
  const op = m.isEqual ? (m.isRegex ? "=~" : "=") : m.isRegex ? "!~" : "!=";
  return `${m.name}${op}${JSON.stringify(m.value)}`;
}

const time = (value: string | null) => {
  if (!value) return "—";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : formatDateTime(ms);
};

export function SilencesView({ report }: { report: AlertsReport }) {
  const { t } = useTranslation();
  if (report.alertmanager.status !== "ok") return <p className="al-note">{t("alerts:silences.noAlertmanager")}</p>;
  return (
    <div className="al-silences">
      <p className="al-note">{t("alerts:silences.readOnly")}</p>
      {report.expiredSilences > 0 && <p className="al-note">{t("alerts:silences.expired", { count: report.expiredSilences })}</p>}
      {report.silences.length === 0 ? (
        <p className="al-note">{t("alerts:silences.none")}</p>
      ) : (
        <ul className="al-list" aria-label={t("alerts:tabs.silences", { count: report.silences.length })}>
          {report.silences.map((s) => (
            <li key={s.id} className="al-row">
              <div className="al-row__head">
                <Badge tone={s.state === "active" ? "info" : "neutral"}>{t(`alerts:silences.state.${s.state}`)}</Badge>
                <span className="al-row__time">{t("alerts:silences.period", { start: time(s.startsAt), end: time(s.endsAt) })}</span>
                {s.createdBy && <span className="al-row__by">{t("alerts:silences.createdBy", { name: s.createdBy })}</span>}
              </div>
              <ul className="al-labels" aria-label={t("alerts:silences.matchers")}>
                {s.matchers.map((m, i) => (
                  <li key={i} className="al-label">
                    {matcherText(m)}
                  </li>
                ))}
              </ul>
              {s.comment && <p className="al-row__description">{s.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
