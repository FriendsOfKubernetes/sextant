// Namespace filter: the header control and the per-cluster choice, saved in `ClusterSettings.namespaces`; the known
// namespaces (`ClusterSettings.knownNamespaces`) and the access check of users who may not list Namespaces (#285),
// with the "Accessible namespaces" section of the cluster settings.
import { registerClusterSettingsSection } from "../clusters/settingsRegistry";
import { AccessibleNamespacesSection } from "./AccessibleNamespacesSection";

registerClusterSettingsSection({
  id: "accessibleNamespaces",
  order: 20,
  tab: "connection",
  titleKey: "namespaces:settings.title",
  Component: AccessibleNamespacesSection,
});

export { NamespaceFilter } from "./NamespaceFilter";
export { resetNamespaceRestore, selectNamespaces, useSelectedNamespaces } from "./namespaces";
export { refreshAccess, restrictedScope, subscribeScope, useAccess, useRestrictedScope } from "./accessStore";
export { KindAccessMark, NoAccessTable, useNoAccess } from "./NoAccess";
