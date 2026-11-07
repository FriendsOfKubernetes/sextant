// Whether the "What's new" window was opened by hand (About → "What's new"); the start-up decision is the host's.
import { create } from "zustand";

interface WhatsNewState {
  open: boolean;
}

export const useWhatsNew = create<WhatsNewState>()(() => ({ open: false }));

export const openWhatsNew = (): void => useWhatsNew.setState({ open: true });
export const closeWhatsNew = (): void => useWhatsNew.setState({ open: false });
