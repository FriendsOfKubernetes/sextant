// One release: its user values, manifest, notes and revision history, with the actions that go through `helm`
// (edit values and upgrade, roll back to a revision, uninstall). Without `helm` the actions are disabled.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId, type HelmRelease } from "../../api";
import { Age, Badge, ErrorState } from "../../components";
import { YamlViewer } from "../details";
import { RollbackDialog, UninstallDialog, UpgradeDialog } from "./dialogs";
import { useLoad } from "./hooks";
import { StatusBadge } from "./StatusBadge";

type Tab = "values" | "manifest" | "notes" | "history";
const TABS: Tab[] = ["values", "manifest", "notes", "history"];

type OpenDialog = { type: "upgrade" } | { type: "uninstall" } | { type: "rollback"; revision: number } | null;

export function ReleaseDetails({
  clusterId,
  release,
  helmAvailable,
  onClose,
  onChanged,
}: {
  clusterId: ClusterId;
  release: HelmRelease;
  helmAvailable: boolean;
  onClose: () => void;
  /** After an upgrade, rollback or uninstall. */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("values");
  const [dialog, setDialog] = useState<OpenDialog>(null);
  // Values and manifest are hidden until "Show". What was shown belongs to one revision of one release: another
  // release or a new revision hides them again.
  const revisionId = `${clusterId}|${release.namespace}|${release.name}|${release.revision}`;
  const [revealed, setRevealed] = useState<{ id: string; tabs: ReadonlySet<Tab> }>({ id: revisionId, tabs: new Set() });
  const isShown = (id: Tab) => revealed.id === revisionId && revealed.tabs.has(id);
  const valuesShown = isShown("values");
  const manifestShown = isShown("manifest");
  // Notes are plain text and always visible; values and manifest are drawn (and waited for) only after "Show".
  const contentWanted = tab === "notes" || isShown(tab);
  const toggleShown = (id: Tab) =>
    setRevealed((prev) => {
      const tabs = new Set(prev.id === revisionId ? prev.tabs : []);
      if (!tabs.delete(id)) tabs.add(id);
      return { id: revisionId, tabs };
    });
  // A new revision (from the list's watch) reloads the details.
  const key = `${clusterId}|${release.namespace}|${release.name}|${release.revision}|${release.status}`;
  const detail = useLoad(key, () => api.helm.releaseDetail(clusterId, release.namespace, release.name, null));
  const history = useLoad(key, () => api.helm.releaseHistory(clusterId, release.namespace, release.name));
  const disabledHint = helmAvailable ? undefined : t("helm:missing.short");
  const rollbackTo = (revision: number) => setDialog({ type: "rollback", revision });
  const changed = () => {
    onChanged();
    detail.reload();
    history.reload();
  };

  return (
    <section className="helm-details" aria-label={t("helm:details.title", { name: release.name })}>
      <header className="helm-details__header">
        <div>
          <h3>{t("helm:details.title", { name: release.name })}</h3>
          <div className="helm-muted">
            {t("helm:details.chart", {
              chart: release.chart,
              version: release.chartVersion,
              appVersion: release.appVersion,
              revision: release.revision,
            })}
          </div>
          {release.unreadableRevision !== null && (
            <div className="helm-warning">
              {release.unreadable
                ? t("helm:details.nothingReadable", { revision: release.unreadableRevision })
                : t("helm:details.unreadableLatest", { revision: release.unreadableRevision, shown: release.revision })}
            </div>
          )}
        </div>
        <button type="button" className="icon-btn" aria-label={t("helm:details.close")} onClick={onClose}>
          ×
        </button>
      </header>

      <div className="helm-details__actions">
        <button
          type="button"
          className="btn"
          disabled={!helmAvailable || !detail.data}
          title={disabledHint}
          onClick={() => setDialog({ type: "upgrade" })}
        >
          {t("helm:actions.editValues")}
        </button>
        <button
          type="button"
          className="btn btn--danger"
          disabled={!helmAvailable}
          title={disabledHint}
          onClick={() => setDialog({ type: "uninstall" })}
        >
          {t("helm:actions.uninstall")}
        </button>
      </div>

      <div className="helm-tabs" role="tablist" aria-label={t("helm:details.tabsLabel")}>
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "helm-tab helm-tab--active" : "helm-tab"}
            onClick={() => setTab(id)}
          >
            {t(`helm:details.tabs.${id}`)}
          </button>
        ))}
      </div>

      <div className="helm-details__body" role="tabpanel">
        {tab !== "history" && detail.error && <ErrorState error={detail.error} onRetry={detail.reload} />}
        {(tab === "values" || tab === "manifest") && (
          <ShowToggle tab={tab} shown={isShown(tab)} onToggle={() => toggleShown(tab)} />
        )}
        {tab !== "history" && contentWanted && !detail.data && !detail.error && (
          <div className="helm-muted" role="status">
            {t("helm:details.loading")}
          </div>
        )}
        {tab === "values" &&
          valuesShown &&
          detail.data &&
          (detail.data.valuesYaml.trim() === "" ? (
            <p className="helm-muted">{t("helm:details.noValues")}</p>
          ) : (
            <YamlViewer text={detail.data.valuesYaml} label={t("helm:details.valuesLabel", { name: release.name })} />
          ))}
        {tab === "manifest" && manifestShown && detail.data && (
          <YamlViewer text={detail.data.manifest} label={t("helm:details.manifestLabel", { name: release.name })} />
        )}
        {tab === "notes" &&
          detail.data &&
          (detail.data.notes.trim() === "" ? (
            <p className="helm-muted">{t("helm:details.noNotes")}</p>
          ) : (
            <pre className="helm-notes">{detail.data.notes}</pre>
          ))}
        {tab === "history" && (
          <HistoryTable
            history={history.data}
            error={history.error}
            current={release.revision}
            helmAvailable={helmAvailable}
            onRollback={rollbackTo}
          />
        )}
      </div>

      {dialog?.type === "upgrade" && detail.data && (
        <UpgradeDialog
          clusterId={clusterId}
          release={release}
          values={detail.data.valuesYaml}
          close={() => setDialog(null)}
          onDone={changed}
        />
      )}
      {dialog?.type === "rollback" && (
        <RollbackDialog
          clusterId={clusterId}
          release={release}
          revision={dialog.revision}
          close={() => setDialog(null)}
          onDone={changed}
        />
      )}
      {dialog?.type === "uninstall" && (
        <UninstallDialog
          clusterId={clusterId}
          release={release}
          close={() => setDialog(null)}
          onDone={() => {
            onChanged();
            onClose();
          }}
        />
      )}
    </section>
  );
}

/** The hint and the "Show"/"Hide" button of the values and manifest tabs (the same pattern as a Secret's values). */
function ShowToggle({ tab, shown, onToggle }: { tab: "values" | "manifest"; shown: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="helm-reveal">
      {!shown && <span className="helm-muted">{t(`helm:details.hidden.${tab}`)}</span>}
      <button
        type="button"
        className="btn"
        aria-label={t(shown ? `helm:details.hide.${tab}` : `helm:details.show.${tab}`)}
        aria-pressed={shown}
        onClick={onToggle}
      >
        {t(shown ? "helm:details.hideButton" : "helm:details.showButton")}
      </button>
    </div>
  );
}

function HistoryTable({
  history,
  error,
  current,
  helmAvailable,
  onRollback,
}: {
  history: HelmRelease[] | null;
  error: unknown;
  current: number;
  helmAvailable: boolean;
  onRollback: (revision: number) => void;
}) {
  const { t } = useTranslation();
  if (error) return <ErrorState error={error} />;
  if (!history) {
    return (
      <div className="helm-muted" role="status">
        {t("helm:details.loading")}
      </div>
    );
  }
  const newestFirst = [...history].sort((a, b) => b.revision - a.revision);
  return (
    <table className="helm-table" aria-label={t("helm:details.tabs.history")}>
      <thead>
        <tr>
          <th>{t("helm:columns.revision")}</th>
          <th>{t("helm:columns.status")}</th>
          <th>{t("helm:columns.chart")}</th>
          <th>{t("helm:columns.appVersion")}</th>
          <th>{t("helm:columns.updated")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {newestFirst.map((h) => (
          <tr key={h.revision} data-revision={h.revision}>
            <td>
              {h.revision}
              {h.revision === current && !h.unreadable && (
                <span className="helm-muted">{` (${t("helm:details.current")})`}</span>
              )}
            </td>
            {h.unreadable ? (
              <>
                <td>
                  <Badge tone="danger">{t("helm:details.unreadable")}</Badge>
                </td>
                <td colSpan={4} className="helm-muted">
                  {t("helm:details.unreadableText")}
                </td>
              </>
            ) : (
              <ReadableRevision h={h} current={current} helmAvailable={helmAvailable} onRollback={onRollback} />
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The cells of a readable history row after its revision number. */
function ReadableRevision({
  h,
  current,
  helmAvailable,
  onRollback,
}: {
  h: HelmRelease;
  current: number;
  helmAvailable: boolean;
  onRollback: (revision: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <td>
        <StatusBadge status={h.status} />
      </td>
      <td>{`${h.chart}-${h.chartVersion}`}</td>
      <td>{h.appVersion}</td>
      <td>
        <Age timestamp={h.updated} />
      </td>
      <td>
        {h.revision !== current && (
          <button
            type="button"
            className="btn btn--small"
            disabled={!helmAvailable}
            title={helmAvailable ? undefined : t("helm:missing.short")}
            aria-label={t("helm:actions.rollbackTo", { revision: h.revision })}
            onClick={() => onRollback(h.revision)}
          >
            {t("helm:actions.rollback")}
          </button>
        )}
      </td>
    </>
  );
}
