import { api, type ForwardInfo } from "../../api";
import { urlOf } from "./model";

/** Opens the forwarded port in the system's default browser. */
export function openInBrowser(forward: Pick<ForwardInfo, "localPort">): void {
  api.shell.openUrl(urlOf(forward)).catch((err: unknown) => console.error("cannot open the browser", err));
}
