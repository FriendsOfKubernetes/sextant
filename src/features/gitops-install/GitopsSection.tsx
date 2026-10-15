// "GitOps" in the cluster settings: whether Flux and Argo CD are installed, and "Install …" for a missing one (the
// sections of an installed tool appear in the sidebar by themselves).
import { useTranslation } from "react-i18next";
import { Badge, Button } from "../../components";
import type { ClusterSettingsSectionProps } from "../clusters/settingsRegistry";
import { openInstall } from "./store";
import { GITOPS_TOOLS, useGitopsTools } from "./tools";
import "./gitopsInstall.css";

export function GitopsSection({ clusterId }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const { connected, installed } = useGitopsTools(clusterId);
  return (
    <div className="gitops-section">
      <p className="gitops-section__hint">{t("gitops:section.hint")}</p>
      {!connected && <p className="gitops-section__hint">{t("gitops:section.notConnected")}</p>}
      {connected && !installed && <p className="gitops-section__hint">{t("gitops:section.loading")}</p>}
      {installed && (
        <ul className="gitops-section__tools">
          {GITOPS_TOOLS.map((tool) => (
            <li key={tool} className="gitops-section__tool">
              <span className="gitops-section__name">{t(`gitops:tool.${tool}`)}</span>
              {installed[tool] ? (
                <Badge tone="success">{t("gitops:section.installed")}</Badge>
              ) : (
                <>
                  <Badge>{t("gitops:section.missing")}</Badge>
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
