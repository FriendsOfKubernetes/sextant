// "Views and workspaces": rename, reorder and delete saved views; create, edit, use and delete workspaces; export
// and import them (with the clusters by reference and their shareable settings).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, updateSettings, useSettings, type ApiError, type AppSettings, type ClusterInfo } from "../../api";
import { Button, Checkbox, ConfirmDialog, Dialog, ErrorState, Icon, Tabs } from "../../components";
import { formatList } from "../../i18n/format";
import { findResourceDef } from "../../resources";
import { displayNameOf } from "../clusters/clusterSettings";
import { useClusters } from "../clusters/hooks";
import {
  activeWorkspace,
  cleanName,
  deleteView,
  deleteWorkspace,
  moveView,
  newId,
  renameView,
  switchWorkspace,
  withWorkspace,
  type SavedView,
  type Workspace,
} from "./model";
import {
  applyImport,
  buildExport,
  countChanges,
  exportText,
  ImportError,
  parseImport,
  planImport,
  type ApplyOptions,
  type ImportPlan,
  type PlannedCluster,
  type PlannedEntry,
  type SharedField,
} from "./transfer";
import { closeManager, save, useViewsUi, type ManagerTab } from "./ui";
import "./views.css";

/** Drawn in the rail footer; shows the manager while it is open. */
export function ViewsHost() {
  const tab = useViewsUi((s) => s.manager);
  if (!tab) return null;
  return <Manager tab={tab} />;
}

function Manager({ tab }: { tab: ManagerTab }) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const { clusters } = useClusters();
  const tabs = [
    { id: "views" as const, label: t("views:manager.tabs.views") },
    { id: "workspaces" as const, label: t("views:manager.tabs.workspaces") },
    { id: "transfer" as const, label: t("views:manager.tabs.transfer") },
  ];
  return (
    <Dialog open title={t("views:manager.title")} onClose={closeManager}>
      <div className="views-manager">
        <Tabs label={t("views:manager.title")} tabs={tabs} selected={tab} onSelect={(id) => useViewsUi.setState({ manager: id })}>
          {settings && tab === "views" && <ViewsTab settings={settings} clusters={clusters} />}
          {settings && tab === "workspaces" && <WorkspacesTab settings={settings} clusters={clusters} />}
          {settings && tab === "transfer" && <TransferTab settings={settings} />}
        </Tabs>
      </div>
    </Dialog>
  );
}

function kindLabel(t: ReturnType<typeof useTranslation>["t"], view: Pick<SavedView, "group" | "kind">): string {
  const def = findResourceDef(view);
  return def?.sidebar ? t(def.sidebar.labelKey) : view.kind;
}

function ViewsTab({ settings, clusters }: { settings: AppSettings; clusters: ClusterInfo[] }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<SavedView | null>(null);
  if (settings.views.length === 0) return <p className="views-manager__empty">{t("views:manager.noViews")}</p>;
  const clusterName = (id: string | null) => {
    if (id === null) return t("views:sidebar.allClusters");
    const cluster = clusters.find((c) => c.id === id);
    return cluster ? displayNameOf(cluster, settings) : t("views:manager.missingCluster");
  };
  return (
    <>
      <ul className="views-manager__list">
        {settings.views.map((view, index) => (
          <li key={view.id} className="views-manager__row">
            {editing?.id === view.id ? (
              <form
                className="views-manager__rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (cleanName(editing.name)) save((s) => renameView(s, view.id, editing.name));
                  setEditing(null);
                }}
              >
                <input
                  autoFocus
                  aria-label={t("views:manager.renameField", { name: view.name })}
                  value={editing.name}
                  maxLength={120}
                  onChange={(e) => setEditing({ id: view.id, name: e.target.value })}
                />
                <Button type="submit" size="compact" variant="primary">
                  {t("views:manager.save")}
                </Button>
                <Button size="compact" onClick={() => setEditing(null)}>
                  {t("views:manager.cancel")}
                </Button>
              </form>
            ) : (
              <span className="views-manager__name">
                <Icon name="savedView" size={14} />
                <span>{view.name}</span>
                <small>{t("views:manager.kindIn", { kind: kindLabel(t, view), cluster: clusterName(view.cluster) })}</small>
              </span>
            )}
            <span className="views-manager__tools">
              <Button
                iconOnly
                icon="edit"
                size="compact"
                label={t("views:manager.rename", { name: view.name })}
                onClick={() => setEditing({ id: view.id, name: view.name })}
              />
              <Button
                iconOnly
                icon="chevronUp"
                size="compact"
                label={t("views:manager.moveUp", { name: view.name })}
                disabled={index === 0}
                onClick={() => save((s) => moveView(s, view.id, -1))}
              />
              <Button
                iconOnly
                icon="chevronDown"
                size="compact"
                label={t("views:manager.moveDown", { name: view.name })}
                disabled={index === settings.views.length - 1}
                onClick={() => save((s) => moveView(s, view.id, 1))}
              />
              <Button
                iconOnly
                icon="delete"
                size="compact"
                label={t("views:manager.delete", { name: view.name })}
                onClick={() => setDeleting(view)}
              />
            </span>
          </li>
        ))}
      </ul>
      {deleting && (
        <ConfirmDialog
          open
          title={t("views:manager.delete", { name: deleting.name })}
          confirmLabel={t("views:manager.delete_button")}
          danger
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(null);
            save((s) => deleteView(s, id));
          }}
          onCancel={() => setDeleting(null)}
        >
          <p>{t("views:manager.deleteConfirm", { name: deleting.name })}</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function WorkspacesTab({ settings, clusters }: { settings: AppSettings; clusters: ClusterInfo[] }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const current = activeWorkspace(settings);

  if (editing) {
    const toggle = (id: string) =>
      setEditing({
        ...editing,
        clusters: editing.clusters.includes(id) ? editing.clusters.filter((c) => c !== id) : [...editing.clusters, id],
      });
    const name = cleanName(editing.name);
    return (
      <form
        className="views-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name) return;
          const workspace = { ...editing, name };
          save((s) => withWorkspace(s, workspace));
          setEditing(null);
        }}
      >
        <label className="views-form__field">
          <span>{t("views:manager.workspaceName")}</span>
          <input
            autoFocus
            value={editing.name}
            maxLength={120}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
        </label>
        <fieldset className="views-form__field views-form__clusters">
          <legend>{t("views:manager.workspaceClusters")}</legend>
          {clusters.map((cluster) => (
            <label key={cluster.id} className="views-form__choice">
              <Checkbox checked={editing.clusters.includes(cluster.id)} onChange={() => toggle(cluster.id)} />
              {displayNameOf(cluster, settings)}
            </label>
          ))}
        </fieldset>
        <div className="views-form__buttons">
          <Button onClick={() => setEditing(null)}>{t("views:manager.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!name}>
            {t("views:manager.saveWorkspace")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <>
      <p className="views-manager__empty">{t("views:workspace.hint")}</p>
      {settings.workspaces.length === 0 && <p className="views-manager__empty">{t("views:manager.noWorkspaces")}</p>}
      <ul className="views-manager__list">
        {settings.workspaces.map((w) => (
          <li key={w.id} className="views-manager__row">
            <span className="views-manager__name">
              <Icon name="workspace" size={14} />
              <span>{w.name}</span>
              <small>{t("views:manager.workspaceClusterCount", { number: w.clusters.length })}</small>
            </span>
            <span className="views-manager__tools">
              <Button
                size="compact"
                disabled={current?.id === w.id}
                onClick={() => save((s) => switchWorkspace(s, w.id))}
              >
                {current?.id === w.id ? t("views:manager.inUse") : t("views:manager.use")}
              </Button>
              <Button
                iconOnly
                icon="edit"
                size="compact"
                label={t("views:manager.editWorkspace", { name: w.name })}
                onClick={() => setEditing({ ...w, clusters: [...w.clusters] })}
              />
              <Button
                iconOnly
                icon="delete"
                size="compact"
                label={t("views:manager.deleteWorkspace", { name: w.name })}
                onClick={() => setDeleting(w)}
              />
            </span>
          </li>
        ))}
      </ul>
      <Button icon="add" onClick={() => setEditing({ id: newId("w"), name: "", clusters: [] })}>
        {t("views:manager.newWorkspace")}
      </Button>
      {deleting && (
        <ConfirmDialog
          open
          title={t("views:manager.deleteWorkspace", { name: deleting.name })}
          confirmLabel={t("views:manager.delete_button")}
          danger
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(null);
            save((s) => deleteWorkspace(s, id));
          }}
          onCancel={() => setDeleting(null)}
        >
          <p>{t("views:manager.deleteWorkspaceConfirm", { name: deleting.name })}</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function TransferTab({ settings }: { settings: AppSettings }) {
  const { t } = useTranslation();
  const { clusters, sources } = useClusters();
  const [includeAccess, setIncludeAccess] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [done, setDone] = useState(false);

  const doExport = async () => {
    setError(null);
    setExported(null);
    try {
      const path = await api.dialog.saveFile({
        title: t("views:transfer.exportDialog"),
        defaultPath: "sextant-views.json",
        filters: [{ name: t("views:transfer.filter"), extensions: ["json"] }],
      });
      if (!path) return;
      const file = buildExport(settings, clusters, sources, { includeAgentAccess: includeAccess });
      await api.files.save(path, exportText(file));
      setExported(path);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  const doImport = async () => {
    setError(null);
    setProblems(null);
    setPlan(null);
    setDone(false);
    try {
      // The backend shows the open dialog and reads only the file picked there.
      const text = await api.files.openViewsImport(t("views:transfer.importDialog"), t("views:transfer.filter"));
      if (text === null) return;
      setPlan(planImport(parseImport(text), settings, clusters, sources));
    } catch (err) {
      if (err instanceof ImportError) setProblems(err.problems);
      else setError(toApiError(err));
    }
  };

  return (
    <div className="views-transfer">
      <section>
        <h3>{t("views:transfer.exportTitle")}</h3>
        <p className="views-manager__empty">{t("views:transfer.exportHint")}</p>
        <label className="views-form__choice">
          <Checkbox checked={includeAccess} onChange={(e) => setIncludeAccess(e.target.checked)} />
          {t("views:transfer.includeAgentAccess")}
        </label>
        <Button icon="download" onClick={() => void doExport()}>
          {t("views:transfer.export")}
        </Button>
        {exported && <p role="status">{t("views:transfer.exported", { path: exported })}</p>}
      </section>
      <section>
        <h3>{t("views:transfer.importTitle")}</h3>
        <p className="views-manager__empty">{t("views:transfer.importHint")}</p>
        <Button icon="upload" onClick={() => void doImport()}>
          {t("views:transfer.import")}
        </Button>
        {done && <p role="status">{t("views:transfer.done")}</p>}
      </section>
      {error && <ErrorState error={error} />}
      {problems && (
        <div role="alert" className="views-transfer__problems">
          <p>{t("views:transfer.invalid")}</p>
          <ul>
            {problems.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan && (
        <ImportPreview
          plan={plan}
          onCancel={() => setPlan(null)}
          onApply={(options) => {
            const applied = plan;
            setPlan(null);
            void updateSettings((current) => applyImport(current, applied, options)).then(
              () => setDone(true),
              (err: unknown) => setError(toApiError(err)),
            );
          }}
        />
      )}
    </div>
  );
}

const SECTION_VIEWS = "views";
const SECTION_PINS = "pins";
const SECTION_WORKSPACES = "workspaces";

/** How a cluster of the file shows in the preview. */
function clusterStatus(c: PlannedCluster): "missing" | "changed" | "added" | "kept" {
  if (!c.localId) return "missing";
  if (c.changed.length > 0) return "changed";
  return c.added.length > 0 ? "added" : "kept";
}

/** What an import would do, per section; applies only on "Import". */
export function ImportPreview({
  plan,
  onApply,
  onCancel,
}: {
  plan: ImportPlan;
  onApply: (options: ApplyOptions) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [overwrite, setOverwrite] = useState(false);
  const [agentAccess, setAgentAccess] = useState(false);
  const options = { overwrite, agentAccess };
  const count = countChanges(plan, options);
  const fields = (list: SharedField[]) => formatList(list.map((f) => t(`views:transfer.fields.${f}`)));
  const section = <T,>(id: "views" | "pins" | "workspaces", entries: PlannedEntry<T>[]) =>
    entries.length > 0 && (
      <section aria-label={t(`views:transfer.sections.${id}`)}>
        <h4>{t(`views:transfer.sections.${id}`)}</h4>
        <ul className="views-preview__list">
          {entries.map((e, i) => (
            <li key={i} className={`views-preview__row views-preview__row--${e.status}`}>
              <span className="views-preview__status">{t(`views:transfer.status.${e.status}`)}</span>
              <span>{e.label}</span>
              {e.status === "skipped" && <small>{t("views:transfer.skippedHint")}</small>}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <div className="views-preview" aria-label={t("views:transfer.preview")} role="region">
      <h3>{t("views:transfer.preview")}</h3>
      {plan.clusters.length > 0 && (
        <section aria-label={t("views:transfer.sections.clusters")}>
          <h4>{t("views:transfer.sections.clusters")}</h4>
          <ul className="views-preview__list">
            {plan.clusters.map((c) => {
              const status = clusterStatus(c);
              return (
                <li key={c.exportedId} className={`views-preview__row views-preview__row--${status}`}>
                  <span className="views-preview__status">{t(`views:transfer.status.${status}`)}</span>
                  <span title={c.sourcePath}>{c.context}</span>
                  {c.match && <small>{t(c.match === "exact" ? "views:transfer.matchExact" : "views:transfer.matchName")}</small>}
                  {c.agentAccessSkipped && <small>{t("views:transfer.agentAccessSkipped")}</small>}
                  {c.localId && c.added.length > 0 && <small>{t("views:transfer.clusterFields", { fields: fields(c.added) })}</small>}
                  {c.localId && c.changed.length > 0 && (
                    <small>{t("views:transfer.clusterChanges", { fields: fields(c.changed) })}</small>
                  )}
                  {c.localId && c.added.length === 0 && c.changed.length === 0 && <small>{t("views:transfer.clusterSame")}</small>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {section(SECTION_VIEWS, plan.views)}
      {section(SECTION_PINS, plan.pins)}
      {section(SECTION_WORKSPACES, plan.workspaces)}
      <label className="views-form__choice">
        <Checkbox checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
        {t("views:transfer.overwrite")}
      </label>
      {plan.hasAgentAccess && (
        <>
          <label className="views-form__choice">
            <Checkbox checked={agentAccess} onChange={(e) => setAgentAccess(e.target.checked)} />
            {t("views:transfer.applyAgentAccess")}
          </label>
          <p className="views-manager__empty">{t("views:transfer.agentAccessWarning")}</p>
        </>
      )}
      <p role="status">{count > 0 ? t("views:transfer.changes", { number: count }) : t("views:transfer.nothing")}</p>
      <div className="views-form__buttons">
        <Button onClick={onCancel}>{t("views:transfer.cancel")}</Button>
        <Button variant="primary" disabled={count === 0} onClick={() => onApply(options)}>
          {t("views:transfer.apply")}
        </Button>
      </div>
    </div>
  );
}
