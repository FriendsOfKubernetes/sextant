// jsdom lays nothing out: this gives popups and their anchors a size and a place, so tests can check that a popup is
// kept inside the window (#176). A popup is found by `isPopup`; its rectangle sits where its inline `left`/`top` put
// it, with the given size. Every other element gets the rectangle `anchorOf` returns (or an empty one at 0,0).
import { vi } from "vitest";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopupLayout {
  window: { width: number; height: number };
  isPopup: (el: HTMLElement) => boolean;
  popupSize: (el: HTMLElement) => { width: number; height: number };
  anchorOf?: (el: HTMLElement) => Box | null;
}

function rect({ left, top, width, height }: Box): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

/** Installs the layout (spies are restored by `vi.restoreAllMocks`). */
export function layOutPopups(layout: PopupLayout): void {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(layout.window.width);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(layout.window.height);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (layout.isPopup(this)) {
      const size = layout.popupSize(this);
      const maxHeight = parseFloat(this.style.maxHeight);
      const maxWidth = parseFloat(this.style.maxWidth);
      return rect({
        left: parseFloat(this.style.left) || 0,
        top: parseFloat(this.style.top) || 0,
        width: Number.isNaN(maxWidth) ? size.width : Math.min(size.width, maxWidth),
        height: Number.isNaN(maxHeight) ? size.height : Math.min(size.height, maxHeight),
      });
    }
    return rect(layout.anchorOf?.(this) ?? { left: 0, top: 0, width: 0, height: 0 });
  });
}

/** Where the popup ended up, and whether all of it is inside the window with `margin` to spare. */
export function placed(el: HTMLElement, margin = 8): { box: DOMRect; inside: boolean } {
  const box = el.getBoundingClientRect();
  const inside =
    box.left >= margin &&
    box.top >= margin &&
    box.right <= window.innerWidth - margin &&
    box.bottom <= window.innerHeight - margin;
  return { box, inside };
}
