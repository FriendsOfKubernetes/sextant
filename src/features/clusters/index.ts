// Clusters feature: fills the cluster rail and the welcome area, adds the "General" and "Connection" cluster settings sections.
import { registerSlot } from "../../layout";
import { ClusterList } from "./ClusterList";
import { ConnectionSection } from "./ConnectionSection";
import { GeneralSection } from "./GeneralSection";
import { registerClusterSettingsSection } from "./settingsRegistry";
import { Welcome } from "./Welcome";
import { CredentialsNotifier } from "./kubeconfig/CredentialsNotifier";
import { KubeconfigViewSection } from "./kubeconfig/ViewKubeconfig";

registerSlot("clusterRail", ClusterList);
registerSlot("welcome", Welcome);
registerClusterSettingsSection({ id: "general", order: 0, tab: "general", Component: GeneralSection });
registerClusterSettingsSection({
  id: "connection",
  order: 0,
  tab: "connection",
  titleKey: "clustersettings:sections.connection",
  Component: ConnectionSection,
});
// "View kubeconfig" (#228) in the same tab.
registerClusterSettingsSection({
  id: "kubeconfigView",
  order: 10,
  tab: "connection",
  titleKey: "kubeconfigview:settings.title",
  Component: KubeconfigViewSection,
});
// Opt-in notifications about expiring kubeconfig credentials (#150); draws nothing.
registerSlot("railFooter", CredentialsNotifier, 1001);

export { useClusters, useClusterState, type UseClusters } from "./hooks";
export {
  getClusterSettingsSections,
  getClusterSettingsTabs,
  MORE_TAB,
  registerClusterSettingsSection,
  registerClusterSettingsTab,
  tabOfSection,
  unregisterClusterSettingsSection,
  unregisterClusterSettingsTab,
  type ClusterSettingsSectionDef,
  type ClusterSettingsSectionProps,
  type ClusterSettingsTabDef,
} from "./settingsRegistry";
