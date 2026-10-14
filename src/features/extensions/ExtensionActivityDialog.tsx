// "Extension activity": what extensions asked for, newest first, for all extensions or one, kept current by the
// `ext-audit` event while it is open. The same shape as the agent activity log.
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, events, toApiError, type ApiError, type AuditDecision, type AuditEntry } from "../../api";
import { Badge, Button, ConfirmDialog, Dialog, ErrorState, LoadingIndicator, type BadgeTone } from "../../components";
import { useExtensions } from "../../extensions";
import { withEntry } from "../mcp/ActivityDialog";

const TONES: Record<AuditDecision, BadgeTone> = {
  allowed: "success",
  approved: "success",
  denied: "danger",
  declined: "warning",
  timedOut: "warning",
};
const COLUMNS = ["time", "extension", "cluster", "method", "target", "decision", "result", "duration"] as const;
const keyOf = (e: AuditEntry) => [e.at, e.client, e.clusterId, e.tool, e.target, e.decision, e.result, e.durationMs].join("\u0000");

export interface ExtensionActivityDialogProps {
  open: boolean;
  /** Extension to show first; "" (or none) is all of them. */
  extensionId?: string;
  onClose: () => void;
}

export function ExtensionActivityDialog({ open, extensionId = "", onClose }: ExtensionActivityDialogProps) {
  const { t } = useTranslation();
  const filterId = useId();
  const { extensions } = useExtensions();
  const [filter, setFilter] = useState(extensionId);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [clearing, setClearing] = useState(false);

  // Opening for another extension starts from its log.
  useEffect(() => {
    if (open) setFilter(extensionId);
  }, [open, extensionId]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    let loaded = false;
    const early: AuditEntry[] = [];
    setEntries(null);
    setError(null);
    const subscription = events.onExtAudit((entry) => {
      if (!live || (filter !== "" && entry.client !== filter)) return;
      if (loaded) setEntries((current) => withEntry(current ?? [], entry));
      else early.push(entry);
    });
    // Listen first, then read, so no call falls between the two; an entry in both is counted once.
    subscription
      .catch(() => undefined)
      .then(() => api.extensions.auditList(filter === "" ? null : filter))
      .then(
        (list) => {
          if (!live) return;
          loaded = true;
          setEntries(early.reduce(withEntry, list));
        },
        (err: unknown) => live && setError(toApiError(err)),
      );
    return () => {
      live = false;
      void subscription.then((off) => off(), () => undefined);
    };
  }, [open, filter]);

  const clear = async () => {
    setClearing(false);
    try {
      await api.extensions.auditClear();
      setEntries([]);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  return (
    <>
      <Dialog
        open={open}
        title={t("extensions:activity.title")}
        onClose={onClose}
        footer={
          <>
            <Button variant="danger" disabled={!entries || entries.length === 0} onClick={() => setClearing(true)}>
              {t("extensions:activity.clear")}
            </Button>
            <Button onClick={onClose}>{t("common:actions.close")}</Button>
          </>
        }
      >
        <div className="mcp-activity">
          <p className="settings__hint">{t("extensions:activity.hint")}</p>
          <div className="settings__row">
            <label className="settings__label mcp-activity__filter-label" htmlFor={filterId}>
              {t("extensions:activity.extension")}
            </label>
            <select
              id={filterId}
              className="settings__input settings__select"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">{t("extensions:activity.allExtensions")}</option>
              {extensions.map((extension) => (
                <option key={extension.id} value={extension.id}>
                  {extension.name}
                </option>
              ))}
            </select>
          </div>
          {error && <ErrorState error={error} title={t("extensions:activity.failed")} />}
          {!error && entries === null && <LoadingIndicator text={t("extensions:activity.loading")} />}
          {!error && entries !== null && entries.length === 0 && (
            <p className="mcp-activity__empty">{t("extensions:activity.empty")}</p>
          )}
          {!error && entries !== null && entries.length > 0 && (
            <div className="mcp-activity__scroll">
              <table className="mcp-activity__table">
                <thead>
                  <tr>
                    {COLUMNS.map((column) => (
                      <th key={column} scope="col">
                        {t(`extensions:activity.columns.${column}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={keyOf(entry)}>
                      <td className="mcp-activity__time">
                        <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString()}</time>
                      </td>
                      <td>{entry.principal}</td>
                      <td>{entry.clusterName ?? t("extensions:activity.none")}</td>
                      <td>
                        <code>{entry.tool}</code>
                      </td>
                      <td className="mcp-activity__target">{entry.target || t("extensions:activity.none")}</td>
                      <td>
                        <Badge tone={TONES[entry.decision]}>{t(`extensions:activity.decisions.${entry.decision}`)}</Badge>
                      </td>
                      <td>{entry.result === "ok" ? t("extensions:activity.ok") : <code>{entry.result}</code>}</td>
                      <td className="mcp-activity__duration">{t("extensions:activity.duration", { ms: entry.durationMs })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={clearing}
        title={t("extensions:activity.clearTitle")}
        confirmLabel={t("extensions:activity.clear")}
        danger
        onCancel={() => setClearing(false)}
        onConfirm={() => void clear()}
      >
        <p>{t("extensions:activity.clearBody")}</p>
      </ConfirmDialog>
    </>
  );
}
