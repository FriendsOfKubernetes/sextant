// Where the UI kit gets Sextant's icons (`ui.button(…, {icon})`, since Sextant 0.30): the connected client asks the
// window (`ui.icon`), once per name; without a connection, or for a name Sextant does not have, no icon.

/** Asks Sextant for an icon's SVG markup; `null` when it has none of that name. */
export type IconSource = (name: string) => Promise<string | null>;

let source: IconSource | null = null;
const cache = new Map<string, Promise<string | null>>();

/** The connected client's way to ask (`connect`); `null` when it disconnects. */
export function setIconSource(next: IconSource | null): void {
  source = next;
  cache.clear();
}

/** The SVG of Sextant's icon `name`, asked once; `null` when there is none (or no connection, or it failed). */
export function iconMarkup(name: string): Promise<string | null> {
  if (!source) return Promise.resolve(null);
  let known = cache.get(name);
  if (!known) {
    known = source(name).catch(() => null);
    cache.set(name, known);
  }
  return known;
}
