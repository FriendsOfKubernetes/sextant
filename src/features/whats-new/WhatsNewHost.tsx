// Decides at start whether "What's new" opens (ADR-0166): the settings say which notes the user has seen
// (`whatsNew.seenVersion`; the migration writes 0.29.0 for a file of an earlier Sextant). Notes newer than that open
// the window once; closing it remembers the newest. A fresh install has seen nothing to miss: the newest is remembered
// at once and nothing opens. About → "What's new" opens the latest notes again.
import { useEffect, useRef, useState } from "react";
import { useSettings } from "../../api";
import { useAppInfo } from "../updates/store";
import { NOTES, notesSince, seenAfter, type ReleaseNotes } from "./notes";
import { closeWhatsNew, useWhatsNew } from "./store";
import { WhatsNewDialog } from "./WhatsNewDialog";

export function WhatsNewHost() {
  const { settings, update } = useSettings();
  const app = useAppInfo();
  const manual = useWhatsNew((s) => s.open);
  const [due, setDue] = useState<ReleaseNotes[] | null>(null);
  const decided = useRef(false);
  const appVersion = app?.version ?? null;

  useEffect(() => {
    if (!settings || app === null || decided.current) return;
    decided.current = true;
    const seen = settings.whatsNew.seenVersion;
    if (seen === undefined) {
      void update((s) => ({ ...s, whatsNew: { seenVersion: seenAfter(appVersion) } }));
      return;
    }
    const notes = notesSince(seen);
    if (notes.length > 0) setDue(notes);
  }, [settings, app, appVersion, update]);

  const shown = due ?? (manual ? NOTES.slice(0, 1) : null);
  if (!shown) return null;
  const close = () => {
    if (due) void update((s) => ({ ...s, whatsNew: { seenVersion: seenAfter(appVersion) } }));
    setDue(null);
    closeWhatsNew();
  };
  return <WhatsNewDialog notes={shown} onClose={close} />;
}
