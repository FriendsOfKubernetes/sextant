import { api, type ForwardInfo } from "../../api";
import { urlOf, type UrlScheme } from "./model";

/** Opens the forwarded port in the system's default browser (`https` for a server with its own TLS). */
export function openInBrowser(forward: Pick<ForwardInfo, "localPort">, scheme: UrlScheme = "http"): void {
  api.shell.openUrl(urlOf(forward, scheme)).catch((err: unknown) => console.error("cannot open the browser", err));
}
