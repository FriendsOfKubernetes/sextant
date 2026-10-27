// Resource kinds: the registry (columns, sidebar entries, actions per kind) and the built-in descriptions.
// Importing this module registers every built-in kind.
import "./kinds/cluster";
import "./kinds/workloads";
import "./kinds/config";
import "./kinds/network";
import "./kinds/storage";
import "./kinds/access";
import "./kinds/custom";

export {
  ageColumn,
  column,
  labelsColumn,
  Labels,
  nameColumn,
  namespaceColumn,
  ObjectLink,
  standardColumns,
  StatusList,
  statusListColumn,
  StatusText,
} from "./columns";
export { CRD_KIND, crdVersion } from "./kinds/custom";
export { evalJsonPath } from "./jsonpath";
export { printerColumns } from "./generic";
export {
  extendColumns,
  findResourceDef,
  getResourceDef,
  getResourceDefs,
  kindFromApiVersion,
  kindKey,
  parseViewId,
  refOf,
  registerResource,
  SIDEBAR_SECTIONS,
  unregisterResource,
  useRegistryVersion,
  useResourceDef,
  viewIdOf,
  type ActionId,
  type CellContext,
  type SearchTextContext,
  type ColumnDef,
  type ResourceDef,
  type SidebarEntry,
  type SidebarSection,
} from "./registry";
export * as status from "./status";
export {
  customResourceKinds,
  findKind,
  loadClusterKinds,
  refreshClusterKinds,
  resetClusterKinds,
  useClusterKinds,
  type ClusterKinds,
} from "./useKinds";
export { crdPrinterColumns, forgetCrdPrinterColumns, useCrdPrinterColumns } from "./crdColumns";
