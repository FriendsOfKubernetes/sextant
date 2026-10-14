// Extensions in Settings: the section (`ExtensionsPanel`, mounted by features/settings), the window of consent for
// installing and for reviewing permissions, the activity log, and the notice that an extension is paused
// (`ConsentNotice`, mounted once by `AppShell`, like the confirmation dialog).
export { ConsentDialog, type ConsentDialogProps } from "./ConsentDialog";
export { ConsentNotice } from "./ConsentNotice";
export { ExtensionActivityDialog } from "./ExtensionActivityDialog";
export { ExtensionsPanel } from "./ExtensionsPanel";
export { isReleaseUrl } from "./install";
export { PermissionsView } from "./PermissionsView";
