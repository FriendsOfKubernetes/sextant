// Settings -> Appearance: the interface font and the monospace font (ADR-0093). Each is the built-in one (the bundled
// Fira Sans / Fira Mono, the default), the system's stack (the look before the bundled fonts) or a font family
// installed on this computer, picked from a searchable list the backend reads (`system_fonts`; a web view cannot list
// fonts). The window applies the choice itself (`useApplyFonts` in App).
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type AppSettings, type FontChoice, type SystemFont } from "../../api";
import { parseFontChoice, sanitizeFamily, type FontRole } from "../../app/fonts";
import { Checkbox, Radio } from "../../components";

type Save = (change: (current: AppSettings) => AppSettings) => Promise<boolean>;
type Kind = FontChoice["kind"];

const KINDS: Kind[] = ["builtin", "system", "custom"];
/** Rows of the font list. */
const LIST_ROWS = 8;
/**
 * Rows drawn in their own font around the visible ones: a machine may have thousands of families, and a preview of
 * each would make the web view load every one of them when the list opens.
 */
export const PREVIEW_MARGIN = 11;

// The installed fonts are read once per window (the backend caches them too).
let installed: Promise<SystemFont[]> | null = null;
function installedFonts(): Promise<SystemFont[]> {
  installed ??= api.fonts.system().catch((err: unknown) => {
    installed = null;
    throw err;
  });
  return installed;
}

/** Forgets the window's copy of the installed fonts (tests). */
export function resetInstalledFonts(): void {
  installed = null;
}

export function FontSettings({ settings, save }: { settings: AppSettings | null; save: Save }) {
  return (
    <>
      <FontField role="ui" settings={settings} save={save} />
      <FontField role="mono" settings={settings} save={save} />
    </>
  );
}

function FontField({ role, settings, save }: { role: FontRole; settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  const labelId = useId();
  const stored = parseFontChoice(role === "ui" ? settings?.appearance?.uiFont : settings?.appearance?.monoFont);
  // "Other installed font…" can be open before a family is picked; nothing is saved until one is.
  const [picking, setPicking] = useState(false);
  const kind: Kind = picking ? "custom" : stored.kind;
  const label = t(role === "ui" ? "settings:fonts.ui" : "settings:fonts.mono");

  const choose = (choice: FontChoice) => {
    setPicking(false);
    void save((s) => {
      const appearance = s.appearance ?? { uiFont: { kind: "builtin" }, monoFont: { kind: "builtin" } };
      return { ...s, appearance: role === "ui" ? { ...appearance, uiFont: choice } : { ...appearance, monoFont: choice } };
    });
  };

  return (
    <div className="settings__field">
      <span className="settings__label" id={labelId}>
        {label}
      </span>
      <div className="settings__choices" role="radiogroup" aria-labelledby={labelId}>
        {KINDS.map((value) => (
          <label key={value} className="settings__choice">
            <Radio
              name={`settings-font-${role}`}
              value={value}
              checked={kind === value}
              disabled={!settings}
              onChange={() => {
                if (value === "custom") setPicking(true);
                else choose({ kind: value });
              }}
            />
            {t(`settings:fonts.kinds.${value === "builtin" ? `builtin_${role}` : value}`)}
          </label>
        ))}
      </div>
      {role === "mono" && <p className="settings__hint">{t("settings:fonts.monoHint")}</p>}
      {kind === "custom" && (
        <FontPicker
          role={role}
          label={label}
          current={stored.kind === "custom" ? (stored.family ?? null) : null}
          onPick={(family) => choose({ kind: "custom", family })}
        />
      )}
    </div>
  );
}

function FontPicker({
  role,
  label,
  current,
  onPick,
}: {
  role: FontRole;
  label: string;
  current: string | null;
  onPick: (family: string) => void;
}) {
  const { t } = useTranslation();
  const [fonts, setFonts] = useState<SystemFont[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(role === "ui");
  // The first row in view; only the rows around it (and the chosen one) are previewed in their own fonts.
  const [firstVisible, setFirstVisible] = useState(0);

  useEffect(() => {
    let live = true;
    installedFonts().then(
      (list) => live && setFonts(list),
      (err: unknown) => {
        if (!live) return;
        console.warn("listing the installed fonts failed", toApiError(err).message);
        setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (fonts ?? []).filter(
      (f) => (showAll || f.monospace) && (!needle || f.family.toLowerCase().includes(needle)),
    );
  }, [fonts, query, showAll]);
  const chosen = current === null ? undefined : fonts?.find((f) => f.family === current);
  const missing = fonts !== null && current !== null && !chosen;
  // A proportional font breaks the terminal's column grid: allowed, but said.
  const proportionalWarning = role === "mono" && (showAll || chosen?.monospace === false);
  useEffect(() => setFirstVisible(0), [query, showAll]);

  return (
    <div className="settings__font-picker">
      {current && (
        <p className="settings__hint">
          {missing
            ? t("settings:fonts.notInstalled", { family: current })
            : t("settings:fonts.current", { family: current })}
        </p>
      )}
      {failed ? (
        <p className="settings__hint" role="alert">
          {t("settings:fonts.failed")}
        </p>
      ) : fonts === null ? (
        <p className="settings__hint">{t("settings:fonts.loading")}</p>
      ) : (
        <>
          <input
            type="search"
            className="settings__input"
            value={query}
            placeholder={t("settings:fonts.search")}
            aria-label={t("settings:fonts.searchLabel", { font: label })}
            onChange={(e) => setQuery(e.target.value)}
          />
          {role === "mono" && (
            <label className="settings__choice">
              <Checkbox checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              {t("settings:fonts.showAll")}
            </label>
          )}
          {proportionalWarning && <p className="settings__hint">{t("settings:fonts.proportionalHint")}</p>}
          {shown.length === 0 ? (
            <p className="settings__hint">{t("settings:fonts.none")}</p>
          ) : (
            <select
              className="settings__input settings__font-list"
              size={Math.min(LIST_ROWS, Math.max(2, shown.length))}
              aria-label={t("settings:fonts.list", { font: label })}
              value={current ?? ""}
              onChange={(e) => {
                // The backend offers only names that need no cleaning, so the saved name matches the list.
                const family = sanitizeFamily(e.target.value);
                if (family) onPick(family);
              }}
              onScroll={(e) => setFirstVisible(firstRowInView(e.currentTarget))}
            >
              {shown.map((f, i) => (
                <option
                  key={f.family}
                  value={f.family}
                  style={
                    f.family === current || Math.abs(i - firstVisible - LIST_ROWS / 2) <= PREVIEW_MARGIN
                      ? previewStyle(f.family, role)
                      : undefined
                  }
                >
                  {f.family}
                </option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
  );
}

/** The index of the first option scrolled into view in a list box (rows are the same height). */
function firstRowInView(list: HTMLSelectElement): number {
  const rows = list.options.length;
  if (rows === 0 || list.scrollHeight <= 0) return 0;
  return Math.max(0, Math.floor(list.scrollTop / (list.scrollHeight / rows)));
}

/** The name drawn in its own font (the role's generic family if it cannot be drawn). */
function previewStyle(family: string, role: FontRole) {
  const clean = sanitizeFamily(family);
  if (!clean) return undefined;
  return { fontFamily: `"${clean}", ${role === "ui" ? "sans-serif" : "monospace"}` };
}
