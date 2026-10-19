// Clusters feature: fills the cluster rail and the welcome area, adds the "General" cluster settings section.
import { registerSlot } from "../../layout";
import { ClusterList } from "./ClusterList";
import { GeneralSection } from "./GeneralSection";
import { registerClusterSettingsSection } from "./settingsRegistry";
import { Welcome } from "./Welcome";
import { CredentialsNotifier } from "./kubeconfig/CredentialsNotifier";

registerSlot("clusterRail", ClusterList);
registerSlot("welcome", Welcome);
registerClusterSettingsSection({ id: "general", order: 0, Component: GeneralSection });
// Opt-in notifications about expiring kubeconfig credentials (#150); draws nothing.
registerSlot("railFooter", CredentialsNotifier, 1001);

export { useClusters, useClusterState, type UseClusters } from "./hooks";
export {
  getClusterSettingsSections,
  registerClusterSettingsSection,
  unregisterClusterSettingsSection,
  type ClusterSettingsSectionDef,
  type ClusterSettingsSectionProps,
} from "./settingsRegistry";
