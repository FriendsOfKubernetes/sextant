// "About Sextant": the dialog (`AboutHost`, mounted once by `AppShell`), opened by the tray menu and by a button in
// Settings through `openAbout()`.
export { AboutDialog, type AboutDialogProps } from "./AboutDialog";
export { AboutHost } from "./AboutHost";
export { closeAbout, openAbout, resetAbout, useAbout } from "./store";
export { versionInfoText } from "./versionInfo";
