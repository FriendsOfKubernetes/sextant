// Settings → Clusters → "Terminal tools" (ADR-0132): what Sextant installed into its own folder, with Install, Check
// for updates and Remove. Nothing is asked of a source before a click; kubectl is installed from a cluster's terminal,
// for that cluster's version, so here it can only be removed.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type AppSettings, type InstalledTool, type Tool, type ToolsView } from "../../api";
import { Button, Checkbox, ErrorState } from "../../components";
import { refreshHelmStatus } from "../helm/hooks";
import { formatBytes } from "../metrics/format";
import { onToolsChanged, toolsChanged } from "./toolsChanged";

/** The tools installed from here; kubectl comes from a cluster's terminal. */
const PLAIN_TOOLS: Tool[] = ["helm", "k9s", "kubectx"];

type Save = (change: (current: AppSettings) => AppSettings) => Promise<boolean>;

type Check = { kind: "checking" } | { kind: "upToDate" } | { kind: "newer"; version: string };

export function ToolsPanel({ settings, save }: { settings: AppSettings | null; save: Save }) {
  const { t } = useTranslation();
  const [view, setView] = useState<ToolsView | null>(null);
  const [busy, setBusy] = useState<Tool | null>(null);
  const [checks, setChecks] = useState<Partial<Record<Tool, Check>>>({});
  const [error, setError] = useState<ApiError | null>(null);

  const reload = useCallback(() => {
    api.tools.list().then(setView, (err) => setError(toApiError(err)));
  }, []);
  useEffect(() => {
    reload();
    return onToolsChanged(reload);
  }, [reload]);

  const run = async (tool: Tool, work: () => Promise<unknown>) => {
    setBusy(tool);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
      toolsChanged();
      if (tool === "helm") refreshHelmStatus();
    }
  };
  const install = (tool: Tool) =>
    run(tool, async () => {
      await api.tools.install(tool);
      setChecks((c) => ({ ...c, [tool]: undefined }));
    });
  const check = (tool: Tool, current: string) =>
    run(tool, async () => {
      setChecks((c) => ({ ...c, [tool]: { kind: "checking" } }));
      const latest = await api.tools.latest(tool).catch((err: unknown) => {
        setChecks((c) => ({ ...c, [tool]: undefined }));
        throw err;
      });
      setChecks((c) => ({ ...c, [tool]: latest === current ? { kind: "upToDate" } : { kind: "newer", version: latest } }));
    });
  const remove = (item: InstalledTool) => run(item.tool, () => api.tools.remove(item.tool, item.version));

  const offer = settings?.terminalTools.offerKubectl ?? true;
  const versionsOf = (tool: Tool) => view?.installed.filter((i) => i.tool === tool) ?? [];
  const removeButton = (item: InstalledTool) => (
    <Button
      key={item.version}
      disabled={busy !== null}
      aria-label={t("tools:settings.removeNamed", { name: t(`tools:names.${item.tool}`), version: item.version })}
      onClick={() => void remove(item)}
    >
      {t("tools:settings.remove")}
    </Button>
  );
  const kubectls = versionsOf("kubectl");
  const versionText = (item: InstalledTool) =>
    t("tools:settings.installed", { version: item.version, size: formatBytes(item.bytes) });

  return (
    <>
      <label className="settings__choice">
        <Checkbox
          checked={offer}
          disabled={!settings}
          onChange={(e) => {
            const offerKubectl = e.target.checked;
            void save((s) => ({ ...s, terminalTools: { ...s.terminalTools, offerKubectl } }));
          }}
        />
        {t("tools:settings.offerKubectl")}
      </label>
      {view && !view.supported && <p className="settings__hint">{t("tools:settings.unsupported")}</p>}
      {view?.supported && (
        <ul className="settings__sources" aria-label={t("tools:settings.title")}>
          <li className="settings__source">
            <span className="settings__tool-name">{t("tools:names.kubectl")}</span>
            <span className="settings__source-path">
              {kubectls.length === 0 ? t("tools:settings.notInstalled") : kubectls.map(versionText).join(", ")}
            </span>
            {kubectls.map(removeButton)}
            <span className="settings__hint settings__tool-hint">{t("tools:settings.kubectlHint")}</span>
          </li>
          {PLAIN_TOOLS.map((tool) => {
            const versions = versionsOf(tool);
            const newest = versions[0]; // the backend lists the newest first
            const name = t(`tools:names.${tool}`);
            const state = checks[tool];
            return (
              <li key={tool} className="settings__source">
                <span className="settings__tool-name">{name}</span>
                <span className="settings__source-path">
                  {busy === tool
                    ? t("tools:settings.working")
                    : versions.length === 0
                      ? t("tools:settings.notInstalled")
                      : versions.map(versionText).join(", ")}
                </span>
                {!newest && (
                  <Button
                    disabled={busy !== null}
                    aria-label={t("tools:settings.installNamed", { name })}
                    onClick={() => void install(tool)}
                  >
                    {t("tools:settings.install")}
                  </Button>
                )}
                {newest && state?.kind !== "newer" && state?.kind !== "upToDate" && (
                  <Button
                    disabled={busy !== null}
                    aria-label={t("tools:settings.checkNamed", { name })}
                    onClick={() => void check(tool, newest.version)}
                  >
                    {t("tools:settings.check")}
                  </Button>
                )}
                {newest && state?.kind === "upToDate" && <span role="status">{t("tools:settings.upToDate")}</span>}
                {newest && state?.kind === "newer" && (
                  <Button
                    variant="primary"
                    disabled={busy !== null}
                    aria-label={t("tools:settings.updateNamed", { name, version: state.version })}
                    onClick={() => void install(tool)}
                  >
                    {t("tools:settings.updateTo", { version: state.version })}
                  </Button>
                )}
                {versions.map(removeButton)}
              </li>
            );
          })}
        </ul>
      )}
      {error && <ErrorState title={t("tools:settings.failed")} error={error} />}
      {view && <p className="settings__status">{t("tools:settings.folder", { dir: view.dir })}</p>}
    </>
  );
}

/** "Install Helm" of the Helm section, shown while no helm is found: the latest Helm into Sextant's own folder. */
export function InstallHelm() {
  const { t } = useTranslation();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await api.tools.install("helm");
      refreshHelmStatus();
      toolsChanged();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setInstalling(false);
    }
  };
  return (
    <div className="settings__field">
      <p className="settings__hint">{t("tools:helm.installHint")}</p>
      <div className="settings__row">
        <Button variant="primary" disabled={installing} onClick={() => void install()}>
          {installing ? t("tools:helm.installing") : t("tools:helm.install")}
        </Button>
      </div>
      {error && <ErrorState title={t("tools:settings.failed")} error={error} />}
    </div>
  );
}
