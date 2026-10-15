// "Install Flux…" / "Install Argo CD…" in the context menu of a cluster: only for a connected cluster, and only for
// a tool that is not installed or only partly installed (`useGitopsTools`).
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { openInstall } from "./store";
import { GITOPS_TOOLS, useGitopsTools } from "./tools";

export function InstallMenuItems({ clusterId, run }: { clusterId: ClusterId; run: (action: () => unknown) => () => void }) {
  const { t } = useTranslation();
  const { tools } = useGitopsTools(clusterId);
  if (!tools) return null;
  return (
    <>
      {GITOPS_TOOLS.filter((tool) => tools[tool] !== "installed").map((tool) => (
        <li key={tool} role="none">
          <button type="button" role="menuitem" onClick={run(() => openInstall(clusterId, tool))}>
            {t(`gitops:menu.${tool}`)}
          </button>
        </li>
      ))}
    </>
  );
}
