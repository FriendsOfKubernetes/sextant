// The settings of the best-practice checks (`AppSettings.practices`, written by the frontend): the checks turned off
// and the namespaces never checked. Read tolerantly: anything unreadable is the default, an unknown check id is
// ignored (and kept when saving, for another version that knows it).
import { useMemo } from "react";
import { defaultAppSettings, useSettings, type AppSettings } from "../../api";
import { CHECKS, type CheckId, type PracticeFinding } from "./model";

export interface PracticesConfig {
  disabled: ReadonlySet<CheckId>;
  excluded: ReadonlySet<string>;
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : undefined;

/** The settings as the checks read them; the defaults for a file without them (or before the settings load). */
export function practicesConfigOf(settings: Pick<AppSettings, "practices"> | null | undefined): PracticesConfig {
  const raw = (settings?.practices ?? null) as unknown;
  const defaults = defaultAppSettings().practices;
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const disabled = strings(record.disabledChecks) ?? defaults.disabledChecks;
  const excluded = strings(record.excludedNamespaces) ?? defaults.excludedNamespaces;
  return {
    disabled: new Set(CHECKS.filter((c) => disabled.includes(c))),
    excluded: new Set(excluded),
  };
}

/** The findings of the checks that are on. */
export function enabledFindings(findings: readonly PracticeFinding[], config: PracticesConfig): PracticeFinding[] {
  return config.disabled.size === 0 ? [...findings] : findings.filter((f) => !config.disabled.has(f.check));
}

/** The settings now; `loaded` is `false` until they are read (nothing is judged before: exclusions are unknown). */
export function usePracticesConfig(): { config: PracticesConfig; loaded: boolean } {
  const { settings, error } = useSettings();
  const practices = settings?.practices;
  // The same object while the saved value is the same.
  const config = useMemo(() => practicesConfigOf(practices ? { practices } : null), [practices]);
  return { config, loaded: !!settings || !!error };
}

/** Namespace names from free text (spaces, commas, lines), each once. */
export function parseNamespaceList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0))];
}

/**
 * The change that saves `disabled` and `excluded`; check ids this version does not know are kept as they were.
 */
export function savePractices(disabled: readonly CheckId[], excluded: readonly string[]): (s: AppSettings) => AppSettings {
  return (s) => {
    const before = strings((s.practices as unknown as Record<string, unknown> | undefined)?.disabledChecks) ?? [];
    const unknown = before.filter((id) => !(CHECKS as readonly string[]).includes(id));
    return { ...s, practices: { disabledChecks: [...new Set([...unknown, ...disabled])], excludedNamespaces: [...excluded] } };
  };
}
