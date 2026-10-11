import { useEffect } from "react";
import { useSettings } from "../api";
import { setLanguage } from "../i18n";
import { AppShell } from "../layout";
import { useApplyTheme } from "./theme";
import { useLayoutPersistence } from "./useLayoutPersistence";

export function App() {
  const { settings } = useSettings();
  useApplyTheme(settings?.theme ?? "system");
  useLayoutPersistence(settings);
  const language = settings?.language;
  useEffect(() => {
    if (language) setLanguage(language);
  }, [language]);
  return <AppShell />;
}
