// Settings → Extensions: the installed extensions with their controls, the three ways to install one (a file, a
// link to a GitHub release, an unpacked folder), and the catalog (ADR-0130) in its own tab. Every way ends in the
// window of consent; nothing runs before it. The catalog is read only while its tab is open or a catalog extension is
// installed, and never while "Use the extension catalog" is off.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, useSettings, type ApiError, type PendingInstall } from "../../api";
import { Button, Checkbox, ErrorState, LoadingIndicator, Tabs } from "../../components";
import { useExtensions } from "../../extensions";
import { statusesOf, useCatalog } from "./catalog";
import { CatalogTab } from "./CatalogTab";
import { ConsentDialog } from "./ConsentDialog";
import { ExtensionActivityDialog } from "./ExtensionActivityDialog";
import { ExtensionRow } from "./ExtensionRow";
import { InstallUrlDialog } from "./InstallUrlDialog";
import { installErrorTitle } from "./install";
import "./extensions.css";

const PACKAGE_EXTENSIONS = ["sextant-ext", "zip"];

type Tab = "installed" | "catalog";
const TABS: readonly Tab[] = ["installed", "catalog"];

export function ExtensionsPanel() {
  const { t } = useTranslation();
  const { extensions, loaded, error: listError, refresh } = useExtensions();
  const [checking, setChecking] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState<PendingInstall | null>(null);
  const [activity, setActivity] = useState(false);
  const [tab, setTab] = useState<Tab>("installed");
  const { settings, update } = useSettings();
  const catalogOn = settings?.extensionCatalog.enabled ?? false;
  const hasCatalogInstalls = extensions.some((e) => e.source.type === "catalog");
  const catalog = useCatalog(catalogOn && (tab === "catalog" || hasCatalogInstalls));
  const statuses = useMemo(() => statusesOf(catalog.view), [catalog.view]);

  /** Runs a check of a package; its result is the consent window, its failure a readable error. */
  const inspect = async (read: () => Promise<PendingInstall | null>, fromUrl = false) => {
    setChecking(true);
    setError(null);
    try {
      const next = await read();
      if (next) {
        setPending(next);
        if (fromUrl) setUrlOpen(false);
      }
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setChecking(false);
    }
  };

  const fromFile = () =>
    inspect(async () => {
      const path = await api.dialog.openFile({
        title: t("extensions:install.fileTitle"),
        filters: [{ name: t("extensions:install.fileFilter"), extensions: PACKAGE_EXTENSIONS }],
      });
      return path ? api.extensions.inspectFile(path) : null;
    });
  const fromFolder = () =>
    inspect(async () => {
      const path = await api.dialog.openFile({ title: t("extensions:install.folderTitle"), directory: true });
      return path ? api.extensions.inspectFolder(path) : null;
    });
  const fromUrl = (url: string) => inspect(() => api.extensions.inspectUrl(url), true);
  const fromCatalog = (id: string) => inspect(() => api.extensions.inspectCatalog(id));
  const shownTab: Tab = catalogOn ? tab : "installed";

  const installedList = (
    <>
      {listError && <ErrorState error={listError} title={t("extensions:list.failed")} onRetry={() => void refresh()} />}
      {!listError && !loaded && <LoadingIndicator text={t("extensions:list.loading")} />}
      {!listError && loaded && extensions.length === 0 && <p className="settings__hint">{t("extensions:list.empty")}</p>}
      {extensions.length > 0 && (
        <ul className="ext-list" aria-label={t("extensions:title")}>
          {extensions.map((info) => (
            <ExtensionRow
              key={info.id}
              info={info}
              catalogStatus={catalogOn ? statuses.get(info.id) : undefined}
              busyInstall={checking}
              onUpdate={(id) => void fromCatalog(id)}
            />
          ))}
        </ul>
      )}
    </>
  );

  return (
    <div className="ext-panel">
      <div className="settings__row">
        <Button icon="add" disabled={checking} onClick={() => void fromFile()}>
          {t("extensions:install.file")}
        </Button>
        <Button
          icon="download"
          disabled={checking}
          onClick={() => {
            setError(null);
            setUrlOpen(true);
          }}
        >
          {t("extensions:install.url")}
        </Button>
        <Button icon="add" disabled={checking} onClick={() => void fromFolder()}>
          {t("extensions:install.folder")}
        </Button>
        <Button onClick={() => setActivity(true)}>{t("extensions:activity.title")}</Button>
      </div>
      {checking && !urlOpen && <LoadingIndicator text={t("extensions:install.checking")} />}
      {error && !urlOpen && (
        <ErrorState
          error={error}
          title={installErrorTitle(error, t)}
          className="settings__error"
          actions={<Button onClick={() => setError(null)}>{t("extensions:notice.dismiss")}</Button>}
        />
      )}
      <label className="settings__choice">
        <Checkbox
          checked={catalogOn}
          disabled={!settings}
          onChange={(e) => {
            const enabled = e.target.checked;
            void update((s) => ({ ...s, extensionCatalog: { ...s.extensionCatalog, enabled } }));
          }}
        />
        {t("extensions:catalog.use")}
      </label>
      <p className="settings__hint">{t("extensions:catalog.useHint")}</p>
      {catalogOn ? (
        <Tabs
          className="ext-tabs"
          label={t("extensions:title")}
          tabs={TABS.map((id) => ({ id, label: t(`extensions:tabs.${id}`) }))}
          selected={shownTab}
          onSelect={setTab}
        >
          {shownTab === "catalog" ? (
            <CatalogTab catalog={catalog} installed={extensions} busy={checking} onInstall={(id) => void fromCatalog(id)} />
          ) : (
            installedList
          )}
        </Tabs>
      ) : (
        installedList
      )}
      {urlOpen && (
        <InstallUrlDialog busy={checking} error={error} onCheck={(url) => void fromUrl(url)} onClose={() => setUrlOpen(false)} />
      )}
      {pending && (
        <ConsentDialog
          key={pending.token}
          pending={pending}
          onClose={() => {
            setPending(null);
            // The installed list changed: the statuses against the catalog are read again (from its cached copy).
            if (catalogOn && pending.source.type === "catalog") void catalog.load(false);
          }}
        />
      )}
      <ExtensionActivityDialog open={activity} onClose={() => setActivity(false)} />
    </div>
  );
}
