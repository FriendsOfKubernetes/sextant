// The "Agent activity" log: what AI agents asked for, newest first, filtered by cluster, kept current by the
// `mcp-audit` event while it is open.
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, events, toApiError, useSettings, type ApiError, type AuditDecision, type AuditEntry, type ClusterId } from "../../api";
import { Badge, Button, ConfirmDialog, Dialog, ErrorState, LoadingIndicator, type BadgeTone } from "../../components";
import { displayNameOf } from "../clusters/clusterSettings";
import { useClusters } from "../clusters/hooks";
import "./mcp.css";

/** The backend keeps this many entries. */
const MAX_ENTRIES = 2000;
const TONES: Record<AuditDecision, BadgeTone> = {
  allowed: "success",
  approved: "success",
  denied: "danger",
  declined: "warning",
  timedOut: "warning",
  notChecked: "neutral",
};

const keyOf = (e: AuditEntry) =>
  [e.at, e.client, e.clusterId, e.tool, e.target, e.decision, e.result, e.durationMs].join("\u0000");

/** `entry` first, unless the list has it already (it came both from the list and from the event). */
export function withEntry(list: AuditEntry[], entry: AuditEntry): AuditEntry[] {
  const key = keyOf(entry);
  if (list.some((e) => keyOf(e) === key)) return list;
  return [entry, ...list].slice(0, MAX_ENTRIES);
}

export function ActivityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const filterId = useId();
  const { clusters } = useClusters();
  const { settings } = useSettings();
  const [filter, setFilter] = useState<ClusterId | "">("");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    let loaded = false;
    const early: AuditEntry[] = [];
    setEntries(null);
    setError(null);
    const subscription = events.onMcpAudit((entry) => {
      if (!live || (filter !== "" && entry.clusterId !== filter)) return;
      if (loaded) setEntries((current) => withEntry(current ?? [], entry));
      else early.push(entry);
    });
    // Listen first, then read, so no call falls between the two; an entry in both is counted once.
    subscription
      .catch(() => undefined)
      .then(() => api.mcp.auditList(filter === "" ? null : filter))
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
      await api.mcp.auditClear();
      setEntries([]);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };

  const decisionLabel = (d: AuditDecision) => t(`mcp:activity.decisions.${d}`);
  const columns = ["time", "client", "cluster", "tool", "target", "decision", "result", "duration"] as const;

  return (
    <>
      <Dialog
        open={open}
        title={t("mcp:activity.title")}
        onClose={onClose}
        footer={
          <>
            <Button variant="danger" disabled={!entries || entries.length === 0} onClick={() => setClearing(true)}>
              {t("mcp:activity.clear")}
            </Button>
            <Button onClick={onClose}>{t("common:actions.close")}</Button>
          </>
        }
      >
        <div className="mcp-activity">
          <p className="settings__hint">{t("mcp:activity.hint")}</p>
          <div className="settings__row">
            <label className="settings__label mcp-activity__filter-label" htmlFor={filterId}>
              {t("mcp:activity.cluster")}
            </label>
            <select
              id={filterId}
              className="settings__input settings__select"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">{t("mcp:activity.allClusters")}</option>
              {clusters.map((cluster) => (
                <option key={cluster.id} value={cluster.id}>
                  {displayNameOf(cluster, settings)}
                </option>
              ))}
            </select>
          </div>
          {error && <ErrorState error={error} title={t("mcp:activity.failed")} />}
          {!error && entries === null && <LoadingIndicator text={t("mcp:activity.loading")} />}
          {!error && entries !== null && entries.length === 0 && <p className="mcp-activity__empty">{t("mcp:activity.empty")}</p>}
          {!error && entries !== null && entries.length > 0 && (
            <div className="mcp-activity__scroll">
              <table className="mcp-activity__table">
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column} scope="col">
                        {t(`mcp:activity.columns.${column}`)}
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
                      <td>{entry.client}</td>
                      <td>{entry.clusterName ?? t("mcp:activity.none")}</td>
                      <td>
                        <code>{entry.tool}</code>
                      </td>
                      <td className="mcp-activity__target">{entry.target || t("mcp:activity.none")}</td>
                      <td>
                        <Badge tone={TONES[entry.decision]}>{decisionLabel(entry.decision)}</Badge>
                      </td>
                      <td>
                        {entry.result === "ok" ? (
                          t("mcp:activity.ok")
                        ) : (
                          <code>{entry.result}</code>
                        )}
                      </td>
                      <td className="mcp-activity__duration">{t("mcp:activity.duration", { ms: entry.durationMs })}</td>
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
        title={t("mcp:activity.clearTitle")}
        confirmLabel={t("mcp:activity.clear")}
        danger
        onCancel={() => setClearing(false)}
        onConfirm={() => void clear()}
      >
        <p>{t("mcp:activity.clearBody")}</p>
      </ConfirmDialog>
    </>
  );
}
