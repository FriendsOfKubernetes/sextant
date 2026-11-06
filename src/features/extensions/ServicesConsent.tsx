// The consent screen's block about services inside a cluster (ADR-0158): each Service the extension may send requests
// to, by name and port, and what that takes. Agreeing grants exactly these; an update that adds or changes one asks
// again.
import { useTranslation } from "react-i18next";
import type { ServiceContribution } from "../../api";
import { formatList } from "../../i18n/format";

export function ServicesConsent({ services }: { services: readonly ServiceContribution[] }) {
  const { t } = useTranslation();
  return (
    <>
      <h3 className="ext-consent__heading">{t("extensions:services.heading")}</h3>
      <p>{t("extensions:services.list")}</p>
      <ul className="ext-backend__list">
        {services.map((service) => (
          <li key={service.id}>
            {service.title}
            <br />
            <code>{`${service.scheme}://${service.name ?? service.labelSelector ?? ""}:${String(service.port)}`}</code>
            {(service.secrets ?? []).length > 0 && (
              <>
                <br />
                <span className="settings__hint">
                  {t("extensions:services.secrets", { keys: formatList((service.secrets ?? []).map((s) => `${s.name}/${s.key}`)) })}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="settings__hint">{t("extensions:services.scope")}</p>
    </>
  );
}
