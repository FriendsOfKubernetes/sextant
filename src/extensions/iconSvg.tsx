// `ui.icon` (ADR-0167 amendment): one of Sextant's icons (`src/components/icons.tsx`) as SVG markup for an extension's
// frame, so the SDK's `ui.button(…, {icon})` draws the icon Sextant's own button has. Only names of the set; any
// other name is no icon. The markup is the host's own (rendered here once per name), never the frame's.
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Icon, isIconName } from "../components/icons";

/** Longest icon name asked for. */
export const MAX_ICON_NAME_CHARS = 64;

const cache = new Map<string, string>();

/** The SVG of the icon `name` of Sextant's set, `null` for any other name. */
export function iconSvg(name: string): string | null {
  if (name.length > MAX_ICON_NAME_CHARS || !isIconName(name)) return null;
  const known = cache.get(name);
  if (known !== undefined) return known;
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() => root.render(<Icon name={name} />));
  const svg = host.innerHTML;
  root.unmount();
  if (!svg.startsWith("<svg")) return null;
  cache.set(name, svg);
  return svg;
}
