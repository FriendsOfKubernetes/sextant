import { useEffect } from "react";
import { resetStreams, useSettings } from "../api";
import { setLanguage } from "../i18n";
import { AppShell } from "../layout";
import { useApplyAccessibility } from "./accessibility";
import { useApplyFonts } from "./fonts";
import { useApplyTheme } from "./theme";
import { useLayoutPersistence } from "./useLayoutPersistence";

export function App() {
  // A reloaded page cannot see the streams of the previous one: the backend closes them before the first new stream
  // starts (streams wait for it). Once per page load; rendering again does not repeat it.
  void resetStreams();
  const { settings } = useSettings();
  useApplyTheme(settings?.theme ?? "system");
  useApplyFonts(settings?.appearance);
  useApplyAccessibility(settings?.appearance);
  useLayoutPersistence(settings);
  const language = settings?.language;
  useEffect(() => {
    if (language) setLanguage(language);
  }, [language]);
  return <AppShell />;
}
