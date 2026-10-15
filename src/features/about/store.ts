// Whether the About dialog is open. Opened by the tray menu (`open-about`, through `AboutHost`) and by the button in
// Settings, which is why this is a small module store and not the state of one component.
import { create } from "zustand";

interface AboutState {
  open: boolean;
}

export const useAbout = create<AboutState>(() => ({ open: false }));

export function openAbout(): void {
  useAbout.setState({ open: true });
}

export function closeAbout(): void {
  useAbout.setState({ open: false });
}

/** Closes the dialog (tests). */
export function resetAbout(): void {
  closeAbout();
}
