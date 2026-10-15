// Draws the install dialog that `openInstall` asks for. Mounted once by `AppShell`, outside the cluster rail: the
// dialog outlives the cluster menu and the cluster settings that opened it, and the rail moving into the narrow
// layout's menu (or back) does not unmount it — unmounting would stop a running install.
import { InstallDialog } from "./InstallDialog";
import { closeInstall, useInstallDialog } from "./store";

export function InstallHost() {
  const target = useInstallDialog((s) => s.target);
  if (!target) return null;
  return (
    <InstallDialog
      key={`${target.clusterId}:${target.tool}`}
      clusterId={target.clusterId}
      tool={target.tool}
      onClose={closeInstall}
    />
  );
}
