export { AppShell } from "./AppShell";
export {
  getDetailsSections,
  registerDetailsSection,
  setDetailsObjectSource,
  unregisterDetailsSection,
  useDetailsObject,
  useDetailsSectionsVersion,
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
  useDockVersion,
  type DockActionContext,
  type DockActionDef,
  type DockTabProps,
} from "./dock/registry";
export {
  getPage,
  getPages,
  registerPage,
  unregisterPage,
  usePagesVersion,
  type PageDef,
  type PageProps,
} from "./pages";
export { getSectionBadge, registerSectionBadge, useSectionBadgesVersion, type SectionBadgeDef } from "./sectionBadges";
export { getSlot, registerSlot, unregisterSlot, useSlotsVersion, type SlotName } from "./slots";
