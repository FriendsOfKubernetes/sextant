// Installing Flux or Argo CD from the window (#81): "Install Flux…" / "Install Argo CD…" in the cluster menu (drawn
// by the clusters feature from `InstallMenuItems`) and the "GitOps" section of the cluster settings open one dialog:
// version → preview → confirm → progress → readiness → result, drawn by `InstallHost` (mounted once by `AppShell`).
// Only the user's click starts an install.
import { registerClusterSettingsSection } from "../clusters/settingsRegistry";
import { GitopsSection } from "./GitopsSection";

registerClusterSettingsSection({
  id: "gitops",
  order: 40,
  titleKey: "gitops:section.title",
  Component: GitopsSection,
});

export { InstallDialog, type InstallDialogProps } from "./InstallDialog";
export { InstallHost } from "./InstallHost";
export { InstallMenuItems } from "./InstallMenuItems";
export { closeInstall, openInstall, useInstallDialog } from "./store";
export { GITOPS_TOOLS, TOOL_KINDS, useGitopsTools } from "./tools";
