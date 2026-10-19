// The Settings page, in tabs: General (appearance, window, notifications, editor), Clusters (kubeconfig sources, helm, terminal),
// AI agents (MCP server), Extensions, Updates & About. The sections: appearance (theme, language, fonts), the main window (keep in the tray), the YAML editor colour scheme, the `helm` binary (found in PATH or chosen), the kubeconfig
// sources, the node shell image, the MCP server, extensions, and the app version with its updates (features/updates). Everything is saved right away through `updateSettings`; the window applies theme and language itself.
import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  defaultAppSettings,
  toApiError,
  useSettings,
  type ApiError,
  type AppSettings,
  type KubeconfigSource,
  type Theme,
} from "../../api";
import { Button, Checkbox, ConfirmDialog, ErrorState, Radio, Tabs } from "../../components";
import { availableLanguages, resolveLanguage, SYSTEM_LANGUAGE } from "../../i18n";
import type { PageProps } from "../../layout/pages";
import { AddFileButton, PasteButton, SourceError } from "../clusters/AddClusterDialog";
import { removeKubeconfigSource } from "../clusters/clustersStore";
import { useClusters } from "../clusters/hooks";
import { isRemovableSource, removeConfirmKey, sourceKindLabelKey } from "../clusters/sources";
import { KubeconfigTools, SourceWritable } from "../clusters/kubeconfig/SourceSettings";
import { EDITOR_THEME_IDS, parseEditorTheme } from "../editor/editorTheme";
import { refreshHelmStatus, useHelmStatus } from "../helm/hooks";
// The panels themselves, not the features' index files: those register UI of their own (features/mcp: the agent
// activity button in the rail footer), loaded with every feature (`src/app/features.ts`).
import { ExtensionsPanel } from "../extensions/ExtensionsPanel";
import { openAbout } from "../about/store";
import { McpPanel } from "../mcp/McpPanel";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { UpdatesPanel } from "../updates";
import { FontSettings } from "./FontSettings";
import { languageName } from "./languages";
import { SETTINGS_TABS, useSettingsUi } from "./store";
import "./settings.css";

const THEMES: Theme[] = ["system", "light", "dark"];
const DEFAULT_NODE_SHELL_IMAGE = defaultAppSettings().nodeShellImage;

/** The sidebar page (`registerPage`). */
export function SettingsPage(_props: PageProps) {
  const { t } = useTranslation();
  return (
    <div className="settings-page">
      <h1 className="settings-page__title">{t("settings:page.title")}</h1>
      <SettingsContent />
    </div>
  );
}

/** The sections in tabs (the open one is remembered for the session, store.ts); also shown in a dialog when no cluster
 * is open. */
export function SettingsContent() {
  const { t } = useTranslation();
  const { settings, update } = useSettings();
  const tab = useSettingsUi((s) => s.tab);
  const selectTab = useSettingsUi((s) => s.selectTab);
  const prefix = useId();
  // A link to a tab at the end of the list (a narrow window scrolls the list): bring the selected tab into view.
  useEffect(() => {
    document.getElementById(`${prefix}-tab-${tab}`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [prefix, tab]);
  const [error, setError] = useState<ApiError | null>(null);

  const save = (change: (current: AppSettings) => AppSettings): Promise<boolean> =>
    update(change).then(
      () => {
        setError(null);
        return true;
      },
      (err: unknown) => {
        setError(toApiError(err));
        return false;
      },
    );

  const tabs = SETTINGS_TABS.map((id) => ({ id, label: t(`settings:tabs.${id}`) }));
  return (
    <div className="settings">
      {error && <SaveError error={error} />}
      <Tabs
        label={t("settings:tabs.label")}
        tabs={tabs}
        selected={tab}
        onSelect={selectTab}
        idPrefix={prefix}
        className="settings__tabs"
      >
        {tab === "general" && (
          <>
            <AppearanceSection settings={settings} save={save} />
            <WindowSection settings={settings} save={save} />
            <NotificationsSection settings={settings} save={save} />
            <EditorSection settings={settings} save={save} />
          </>
        )}
        {tab === "clusters" && (
          <>
            <KubeconfigSection />
            <HelmSection settings={settings} save={save} />
            <TerminalSection settings={settings} save={save} />
          </>
        )}
        {tab === "agents" && <McpSection settings={settings} save={save} />}
        {/* Extension-contributed settings sections are drawn inside the panel (`ExtensionSettingsFrame`). */}
        {tab === "extensions" && <ExtensionsSection />}
        {tab === "about" && (
          <>
            <UpdatesSection save={save} />
            <AboutSection />
          </>
        )}
      </Tabs>
    </div>
  );
}

type Save = (change: (current: AppSettings) => AppSettings) => Promise<boolean>;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings__section" aria-labelledby={id}>
      <h2 id={id} className="settings__heading">
        {title}
      </h2>
      {hint && <p className="settings__hint">{hint}</p>}
      {children}
    </section>
  );
}

function AppearanceSection({ settings, save }: { settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  const languageId = useId();
  const theme = settings?.theme ?? "system";
  // "system" (a new install) follows the OS; a stored code is an explicit choice. Empty reads as "system".
  const language = settings?.language || SYSTEM_LANGUAGE;
  const known = language === SYSTEM_LANGUAGE || availableLanguages.includes(language);
  const languages = known ? availableLanguages : [...availableLanguages, language];

  return (
    <Section title={t("settings:appearance.title")}>
      <div className="settings__field">
        <span className="settings__label">{t("settings:appearance.theme")}</span>
        <div className="settings__choices" role="radiogroup" aria-label={t("settings:appearance.theme")}>
          {THEMES.map((value) => (
            <label key={value} className="settings__choice">
              <Radio
                name="settings-theme"
                value={value}
                checked={theme === value}
                disabled={!settings}
                onChange={() => void save((s) => ({ ...s, theme: value }))}
              />
              {t(`settings:appearance.themes.${value}`)}
            </label>
          ))}
        </div>
        <p className="settings__hint">{t("settings:appearance.systemHint")}</p>
      </div>
      <div className="settings__field">
        <label className="settings__label" htmlFor={languageId}>
          {t("settings:appearance.language")}
        </label>
        <select
          id={languageId}
          className="settings__input settings__select"
          value={language}
          disabled={!settings}
          onChange={(e) => {
            const next = e.target.value;
            void save((s) => ({ ...s, language: next }));
          }}
        >
          <option value={SYSTEM_LANGUAGE}>
            {t("settings:appearance.languageSystem", { language: languageName(resolveLanguage(SYSTEM_LANGUAGE)) })}
          </option>
          {languages.map((code) => (
            <option key={code} value={code}>
              {languageName(code)}
            </option>
          ))}
        </select>
        <p className="settings__hint">{t("settings:appearance.languageHint")}</p>
      </div>
      <FontSettings settings={settings} save={save} />
    </Section>
  );
}

/** "Keep in the tray" on close; offered only when the backend created a tray icon (`tray_status`). */
function WindowSection({ settings, save }: { settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  // `null` while asking; a failed check counts as no tray, so the window is never hidden with no way back.
  const [trayAvailable, setTrayAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api.settings.trayStatus().then(
      (status) => live && setTrayAvailable(status.available),
      () => live && setTrayAvailable(false),
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <Section title={t("settings:window.title")}>
      <label className="settings__choice">
        <Checkbox
          checked={settings?.closeToTray ?? false}
          disabled={!settings || trayAvailable !== true}
          onChange={(e) => {
            const closeToTray = e.target.checked;
            void save((s) => ({ ...s, closeToTray }));
          }}
        />
        {t("settings:window.closeToTray")}
      </label>
      <p className="settings__hint">
        {trayAvailable === false ? t("settings:window.noTray") : t("settings:window.closeToTrayHint")}
      </p>
    </Section>
  );
}

/** Desktop notifications about new problems in connected clusters (features/notifications). */
function NotificationsSection({ settings, save }: { settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  return (
    <Section title={t("notifications:settings.title")}>
      <NotificationsPanel settings={settings} save={save} />
    </Section>
  );
}

function EditorSection({ settings, save }: { settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  const schemeId = useId();
  return (
    <Section title={t("settings:editor.title")} hint={t("settings:editor.hint")}>
      <div className="settings__field">
        <label className="settings__label" htmlFor={schemeId}>
          {t("settings:editor.scheme")}
        </label>
        <select
          id={schemeId}
          className="settings__input settings__select"
          value={parseEditorTheme(settings?.editorTheme)}
          disabled={!settings}
          onChange={(e) => {
            const editorTheme = e.target.value;
            void save((s) => ({ ...s, editorTheme }));
          }}
        >
          {EDITOR_THEME_IDS.map((id) => (
            <option key={id} value={id}>
              {t(`settings:editor.schemes.${id}`)}
            </option>
          ))}
        </select>
      </div>
    </Section>
  );
}

function HelmSection({ settings, save }: { settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  const pathId = useId();
  const status = useHelmStatus();
  const savedPath = settings?.helmPath ?? null;
  const [manual, setManual] = useState(savedPath !== null);
  const [path, setPath] = useState(savedPath ?? "");

  // The saved settings arrived or changed elsewhere: show them.
  useEffect(() => {
    setManual(savedPath !== null);
    if (savedPath !== null) setPath(savedPath);
  }, [savedPath]);

  const choose = async (helmPath: string | null) => {
    if (await save((s) => ({ ...s, helmPath }))) refreshHelmStatus();
  };

  const browse = async () => {
    const picked = await api.dialog.openFile({ title: t("settings:helm.browseTitle") });
    if (picked) setPath(picked);
  };

  let statusText: string;
  if (!status) statusText = t("settings:helm.checking");
  else if (status.available && status.path) {
    statusText = status.version
      ? t("settings:helm.found", { version: status.version, path: status.path })
      : t("settings:helm.foundNoVersion", { path: status.path });
  } else if (status.path) statusText = t("settings:helm.notRunnable", { path: status.path });
  else statusText = t("settings:helm.notFound");

  return (
    <Section title={t("settings:helm.title")} hint={t("settings:helm.hint")}>
      <div className="settings__choices settings__choices--column" role="radiogroup" aria-label={t("settings:helm.title")}>
        <label className="settings__choice">
          <Radio
            name="settings-helm"
            checked={!manual}
            disabled={!settings}
            onChange={() => {
              setManual(false);
              void choose(null);
            }}
          />
          {t("settings:helm.auto")}
        </label>
        <label className="settings__choice">
          <Radio
            name="settings-helm"
            checked={manual}
            disabled={!settings}
            onChange={() => {
              setManual(true);
              if (!path && status?.path) setPath(status.path);
            }}
          />
          {t("settings:helm.manual")}
        </label>
      </div>
      {manual && (
        <form
          className="settings__row"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void choose(path.trim());
          }}
        >
          <label className="settings-visually-hidden" htmlFor={pathId}>
            {t("settings:helm.path")}
          </label>
          <input
            id={pathId}
            className="settings__input settings__path"
            type="text"
            spellCheck={false}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button onClick={() => void browse()}>
            {t("settings:helm.browse")}
          </Button>
          <Button type="submit" variant="primary" disabled={!path.trim()}>
            {t("settings:helm.apply")}
          </Button>
        </form>
      )}
      <p className="settings__status" role="status" data-available={status?.available ?? undefined}>
        {statusText}
      </p>
    </Section>
  );
}

function KubeconfigSection() {
  const { t } = useTranslation();
  const { sources } = useClusters();
  const [removing, setRemoving] = useState<KubeconfigSource | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const remove = async (source: KubeconfigSource) => {
    setRemoving(null);
    try {
      await removeKubeconfigSource(source.id);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  return (
    <Section title={t("settings:kubeconfig.title")} hint={t("settings:kubeconfig.hint")}>
      <ul className="settings__sources" aria-label={t("clusters:sources.title")}>
        {sources.map((source) => (
          <li key={source.id} className="settings__source">
            <span className="settings__source-path">{source.path}</span>
            <span className="settings__source-kind">{t(sourceKindLabelKey(source.kind))}</span>
            <SourceWritable source={source} />
            {isRemovableSource(source.kind) && (
              <Button
                aria-label={t("clusters:sources.removeNamed", { path: source.path })}
                onClick={() => setRemoving(source)}
              >
                {t("clusters:sources.remove")}
              </Button>
            )}
            {source.error && <SourceError error={source.error} />}
          </li>
        ))}
      </ul>
      {error && <SourceError error={error} />}
      <div className="settings__row">
        <AddFileButton />
        <PasteButton />
      </div>
      <KubeconfigTools />
      <ConfirmDialog
        open={removing !== null}
        title={t("clusters:sources.confirmTitle")}
        confirmLabel={t("clusters:sources.remove")}
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      >
        <p>{t(removeConfirmKey(removing?.kind))}</p>
        <p className="settings__source-path">{removing?.path}</p>
      </ConfirmDialog>
    </Section>
  );
}

/** The image of the privileged pod behind a shell on a node; saved on Enter or when the field loses focus. */
function TerminalSection({ settings, save }: { settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  const imageId = useId();
  const saved = settings?.nodeShellImage ?? "";
  const [image, setImage] = useState(saved);
  useEffect(() => setImage(saved), [saved]);
  const apply = () => {
    const nodeShellImage = image.trim() || DEFAULT_NODE_SHELL_IMAGE;
    setImage(nodeShellImage);
    if (nodeShellImage !== saved) void save((s) => ({ ...s, nodeShellImage }));
  };
  return (
    <Section title={t("settings:terminal.title")}>
      <form
        className="settings__field"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <label className="settings__label" htmlFor={imageId}>
          {t("settings:terminal.nodeShellImage")}
        </label>
        <input
          id={imageId}
          className="settings__input settings__path"
          type="text"
          spellCheck={false}
          value={image}
          disabled={!settings}
          placeholder={DEFAULT_NODE_SHELL_IMAGE}
          onChange={(e) => setImage(e.target.value)}
          onBlur={apply}
        />
        <p className="settings__hint">{t("settings:terminal.nodeShellImageHint")}</p>
      </form>
    </Section>
  );
}

function McpSection({ settings, save }: { settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  return (
    <Section title={t("mcp:title")} hint={t("mcp:hint")}>
      <McpPanel settings={settings} save={save} />
    </Section>
  );
}

function ExtensionsSection() {
  const { t } = useTranslation();
  return (
    <Section title={t("extensions:title")} hint={t("extensions:hint")}>
      <ExtensionsPanel />
    </Section>
  );
}

function UpdatesSection({ save }: { save: Save }) {
  const { t } = useTranslation();
  return (
    <Section title={t("updates:title")}>
      <UpdatesPanel save={save} />
    </Section>
  );
}

function AboutSection() {
  const { t } = useTranslation();
  return (
    <Section title={t("about:section")}>
      <div>
        <Button onClick={openAbout}>{t("about:open")}</Button>
      </div>
    </Section>
  );
}

function SaveError({ error }: { error: ApiError }) {
  const { t } = useTranslation();
  return <ErrorState error={error} title={t("settings:saveFailed")} className="settings__error" />;
}
