// Mounted once by the shell (AppShell): listens for the palette's shortcut on the whole window and shows the palette
// while it is open. The listener runs in the capture phase, so a terminal or an editor that would take Ctrl+Shift+K
// never sees it.
import { useEffect } from "react";
import { Palette } from "./Palette";
import { isPaletteShortcut } from "./shortcut";
import { closePalette, togglePalette, usePalette } from "./store";

export function PaletteHost() {
  const open = usePalette((s) => s.open);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inside = e.target instanceof Element && e.target.closest(".palette") !== null;
      if (!isPaletteShortcut(e, inside)) return;
      e.preventDefault();
      e.stopPropagation();
      togglePalette();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return open ? <Palette onClose={closePalette} /> : null;
}
