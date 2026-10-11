export { AppShell } from "./AppShell";
export {
  getDetailsSections,
  registerDetailsSection,
  setDetailsObjectSource,
  unregisterDetailsSection,
  useDetailsObject,
  type DetailsObject,
  type DetailsObjectSource,
  type DetailsSectionDef,
  type DetailsSectionProps,
} from "./details/registry";
export {
  getDockActions,
  getDockTabComponent,
  registerDockAction,
  registerDockTab,
  unregisterDockAction,
  unregisterDockTab,
  type DockActionContext,
  type DockActionDef,
  type DockTabProps,
} from "./dock/registry";
export { getPage, getPages, registerPage, unregisterPage, type PageDef, type PageProps } from "./pages";
export { getSlot, registerSlot, unregisterSlot, type SlotName } from "./slots";
