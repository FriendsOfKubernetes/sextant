// The Settings page: appearance (theme, language), the YAML editor colour scheme, the `helm` binary (found in PATH or chosen), the kubeconfig
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
import { Button, ConfirmDialog, ErrorState, Radio } from "../../components";
import { availableLanguages } from "../../i18n";
import type { PageProps } from "../../layout/pages";
import { AddFileButton, PasteButton, SourceError } from "../clusters/AddClusterDialog";
import { removeKubeconfigSource } from "../clusters/clustersStore";
import { useClusters } from "../clusters/hooks";
import { EDITOR_THEME_IDS, parseEditorTheme } from "../editor/editorTheme";
import { refreshHelmStatus, useHelmStatus } from "../helm/hooks";
// The panels themselves, not the features' index files: those register UI of their own (features/mcp: the agent
// activity button in the rail footer), loaded with every feature (`src/app/features.ts`).
import { ExtensionsPanel } from "../extensions/ExtensionsPanel";
import { McpPanel } from "../mcp/McpPanel";
import { UpdatesPanel } from "../updates";
import { languageName } from "./languages";
import "./settings.css";

const THEMES: Theme[] = ["system", "light", "dark"];
const DEFAULT_NODE_SHELL_IMAGE = defaultAppSettings().nodeShellImage;
const REMOVABLE: ReadonlySet<KubeconfigSource["kind"]> = new Set(["addedFile", "pasted", "cloud"]);
/** What removing a source does, by its kind. */
const REMOVE_CONFIRM: Partial<Record<KubeconfigSource["kind"], string>> = {
  pasted: "clusters:sources.confirmPasted",
  cloud: "clusters:sources.confirmCloud",
};

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

/** The sections, also shown in a dialog when no cluster is open. */
export function SettingsContent() {
  const { settings, update } = useSettings();
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

  return (
    <div className="settings">
      {error && <SaveError error={error} />}
      <AppearanceSection settings={settings} save={save} />
      <EditorSection settings={settings} save={save} />
      <HelmSection settings={settings} save={save} />
      <KubeconfigSection />
      <TerminalSection settings={settings} save={save} />
      <McpSection settings={settings} save={save} />
      <ExtensionsSection />
      <UpdatesSection save={save} />
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
  const language = settings?.language ?? "en";
  const languages = availableLanguages.includes(language) ? availableLanguages : [...availableLanguages, language];

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
          {languages.map((code) => (
            <option key={code} value={code}>
              {languageName(code)}
            </option>
          ))}
        </select>
        <p className="settings__hint">{t("settings:appearance.languageHint")}</p>
      </div>
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
            <span className="settings__source-kind">{t(`clusters:sources.kind.${source.kind}`)}</span>
            {REMOVABLE.has(source.kind) && (
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
      <ConfirmDialog
        open={removing !== null}
        title={t("clusters:sources.confirmTitle")}
        confirmLabel={t("clusters:sources.remove")}
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      >
        <p>{t((removing && REMOVE_CONFIRM[removing.kind]) ?? "clusters:sources.confirmFile")}</p>
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

function SaveError({ error }: { error: ApiError }) {
  const { t } = useTranslation();
  return <ErrorState error={error} title={t("settings:saveFailed")} className="settings__error" />;
}
