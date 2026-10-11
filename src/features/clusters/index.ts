// Clusters feature: fills the cluster rail and the welcome area, adds the "General" cluster settings section.
import { registerSlot } from "../../layout";
import { ClusterList } from "./ClusterList";
import { GeneralSection } from "./GeneralSection";
import { registerClusterSettingsSection } from "./settingsRegistry";
import { Welcome } from "./Welcome";

registerSlot("clusterRail", ClusterList);
registerSlot("welcome", Welcome);
registerClusterSettingsSection({ id: "general", order: 0, Component: GeneralSection });

export { useClusters, useClusterState, type UseClusters } from "./hooks";
export {
  getClusterSettingsSections,
  registerClusterSettingsSection,
  unregisterClusterSettingsSection,
  type ClusterSettingsSectionDef,
  type ClusterSettingsSectionProps,
} from "./settingsRegistry";
