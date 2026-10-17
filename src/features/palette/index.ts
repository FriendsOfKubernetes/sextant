// Command palette and global search (Ctrl+K / Cmd+K): find any object of the active cluster by name and open it or
// run one of its actions, go to a section, a page, a Settings tab or another cluster. The shell mounts
// `PaletteHost` once (src/layout/AppShell.tsx); everything the palette offers comes from the existing registries.
export { PaletteHost } from "./PaletteHost";
export { closePalette, openPalette, resetPalette, togglePalette } from "./store";
