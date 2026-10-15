// The About dialog of the window, mounted once by the window shell (`AppShell`): it opens when the tray menu asks
// (`open-about`, the backend has already brought the window back) and when Settings calls `openAbout()`.
import { useEffect } from "react";
import { events } from "../../api";
import { AboutDialog } from "./AboutDialog";
import { closeAbout, openAbout, useAbout } from "./store";

export function AboutHost() {
  const open = useAbout((s) => s.open);

  useEffect(() => {
    let live = true;
    const unsubscribe = events.onOpenAbout(() => {
      if (live) openAbout();
    });
    return () => {
      live = false;
      void unsubscribe.then((off) => off(), () => undefined);
    };
  }, []);

  return <AboutDialog open={open} onClose={closeAbout} />;
}
