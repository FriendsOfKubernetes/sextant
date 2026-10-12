// Port forwarding: the details section of pods and services, the "Port forward…" action and the
// Network → Port Forwarding page.
import "./register";

export { ForwardDialog, type ForwardDialogProps } from "./ForwardDialog";
export { usePortForwards, type PortForwards } from "./hooks";
export { isForwardable, parseLocalPort, portsOf, targetOf, urlOf, type UrlScheme } from "./model";
export { openInBrowser } from "./openInBrowser";
export { PortForwardPage } from "./PortForwardPage";
