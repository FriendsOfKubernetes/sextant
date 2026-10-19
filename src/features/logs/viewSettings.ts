// How the logs view shows lines (`AppSettings.logs`, written by the frontend): wrapped or one line per entry, ANSI
// colours on or off. Shared by every logs tab and remembered between runs.
import { useCallback, useState } from "react";
import { useSettings, type AppSettings } from "../../api";
import type { LogViewSettings } from "../../api/generated/LogViewSettings";

export const DEFAULT_LOG_VIEW: LogViewSettings = Object.freeze({ wrap: false, colours: true });

/** The view settings in `settings`, each field that is missing or not a boolean read as its default. */
export function logViewOf(settings: Pick<AppSettings, "logs"> | null | undefined): LogViewSettings {
  const raw = (settings?.logs ?? {}) as Partial<Record<keyof LogViewSettings, unknown>>;
  return {
    wrap: typeof raw.wrap === "boolean" ? raw.wrap : DEFAULT_LOG_VIEW.wrap,
    colours: typeof raw.colours === "boolean" ? raw.colours : DEFAULT_LOG_VIEW.colours,
  };
}

export interface LogView extends LogViewSettings {
  /** Changes one field at once in this tab and saves it for every logs tab. */
  set: (change: Partial<LogViewSettings>) => void;
}

/** The logs view settings, and changing them. A change shows at once, even when saving it fails. */
export function useLogView(): LogView {
  const { settings, update } = useSettings();
  const [local, setLocal] = useState<Partial<LogViewSettings>>({});
  const saved = logViewOf(settings);
  const set = useCallback(
    (change: Partial<LogViewSettings>) => {
      setLocal((prev) => ({ ...prev, ...change }));
      update((current) => ({ ...current, logs: { ...logViewOf(current), ...change } })).then(
        // Saved: the settings say it from now on (another tab's later change shows here too).
        () =>
          setLocal((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(change) as (keyof LogViewSettings)[]) {
              if (next[key] === change[key]) delete next[key]; // a newer change still waits for its save
            }
            return next;
          }),
        () => undefined,
      );
    },
    [update],
  );
  return { ...saved, ...local, set };
}
