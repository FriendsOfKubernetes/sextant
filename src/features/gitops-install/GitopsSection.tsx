// "GitOps" in the cluster settings: whether Flux and Argo CD are installed, partly installed or missing, and
// "Install …" for any that is not fully installed (the sections of an installed tool appear in the sidebar by
// themselves).
import { useTranslation } from "react-i18next";
import { Badge, Button } from "../../components";
import type { ClusterSettingsSectionProps } from "../clusters/settingsRegistry";
import { openInstall } from "./store";
import { GITOPS_TOOLS, useGitopsTools } from "./tools";
import "./gitopsInstall.css";

export function GitopsSection({ clusterId }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const { connected, tools } = useGitopsTools(clusterId);
  return (
    <div className="gitops-section">
      <p className="gitops-section__hint">{t("gitops:section.hint")}</p>
      {!connected && <p className="gitops-section__hint">{t("gitops:section.notConnected")}</p>}
      {connected && !tools && <p className="gitops-section__hint">{t("gitops:section.loading")}</p>}
      {tools && (
        <ul className="gitops-section__tools">
          {GITOPS_TOOLS.map((tool) => (
            <li key={tool} className="gitops-section__tool">
              <span className="gitops-section__name">{t(`gitops:tool.${tool}`)}</span>
              {tools[tool] === "installed" ? (
                <Badge tone="success">{t("gitops:section.installed")}</Badge>
              ) : (
                <>
                  {tools[tool] === "partial" ? (
                    <Badge tone="warning">{t("gitops:section.partial")}</Badge>
                  ) : (
                    <Badge>{t("gitops:section.missing")}</Badge>
                  )}
                  <Button onClick={() => openInstall(clusterId, tool)}>
                    {t("gitops:section.install", { tool: t(`gitops:tool.${tool}`) })}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
