import type { ForwardInfo } from "../../api";
import { urlOf } from "./model";

/** Opens the forwarded port in the default browser. */
export function openInBrowser(forward: Pick<ForwardInfo, "localPort">): void {
  window.open(urlOf(forward), "_blank", "noopener,noreferrer");
}
