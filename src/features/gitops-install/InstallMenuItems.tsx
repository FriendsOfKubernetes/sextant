// "Install Flux…" / "Install Argo CD…" in the context menu of a cluster: only for a connected cluster, and only for
// a tool its discovery does not serve.
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { openInstall } from "./store";
import { GITOPS_TOOLS, useGitopsTools } from "./tools";

export function InstallMenuItems({ clusterId, run }: { clusterId: ClusterId; run: (action: () => unknown) => () => void }) {
  const { t } = useTranslation();
  const { installed } = useGitopsTools(clusterId);
  if (!installed) return null;
  return (
    <>
      {GITOPS_TOOLS.filter((tool) => !installed[tool]).map((tool) => (
        <li key={tool} role="none">
          <button type="button" role="menuitem" onClick={run(() => openInstall(clusterId, tool))}>
            {t(`gitops:menu.${tool}`)}
          </button>
        </li>
      ))}
    </>
  );
}
