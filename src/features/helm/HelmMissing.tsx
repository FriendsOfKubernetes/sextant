// Hint shown when the `helm` command is not found: what does not work and where to get Helm.
import { useTranslation } from "react-i18next";

export const HELM_INSTALL_URL = "https://helm.sh/docs/intro/install/";

export function HelmMissing() {
  const { t } = useTranslation();
  return (
    <div className="helm-missing" role="note" data-testid="helm-missing">
      <strong>{t("helm:missing.title")}</strong>
      <span>{t("helm:missing.text")}</span>
      <a href={HELM_INSTALL_URL} target="_blank" rel="noreferrer">
        {HELM_INSTALL_URL}
      </a>
    </div>
  );
}
