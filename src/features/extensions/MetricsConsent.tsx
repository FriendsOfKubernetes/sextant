// The consent screen's block about metric queries (ADR-0138): the queries the extension may run, word for word, and
// that Prometheus may answer with data of namespaces the extension may not otherwise read. Agreeing grants exactly
// these queries; an update that adds or changes one asks again.
import { useTranslation } from "react-i18next";
import type { MetricQuery } from "../../api";

export function MetricsConsent({ queries }: { queries: readonly MetricQuery[] }) {
  const { t } = useTranslation();
  return (
    <>
      <h3 className="ext-consent__heading">{t("extensions:metrics.heading")}</h3>
      <p>{t("extensions:metrics.queries")}</p>
      <ul className="ext-backend__list">
        {queries.map((query) => (
          <li key={query.id}>
            {query.title}
            <br />
            <code>{query.query}</code>
          </li>
        ))}
      </ul>
      <p className="settings__hint">{t("extensions:metrics.scope")}</p>
    </>
  );
}
