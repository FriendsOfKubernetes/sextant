// Network → Port Forwarding: the active forwards of the cluster with their status; each can be opened in the
// browser or stopped. The list follows the `portforwards` event, so a forward whose pod died turns to "Error".
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ForwardInfo } from "../../api";
import { Button, Badge, EmptyState, ErrorState } from "../../components";
import type { PageProps } from "../../layout/pages";
import { usePortForwards } from "./hooks";
import { targetName } from "./model";
import { openInBrowser } from "./openInBrowser";
import "./portforward.css";

export function PortForwardPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const { forwards, loaded, error } = usePortForwards();
  const [stopError, setStopError] = useState<ApiError | null>(null);
  const shown = forwards.filter((f) => f.cluster === clusterId);

  const stop = async (id: string) => {
    setStopError(null);
    try {
      await api.portForward.stop(id);
    } catch (err) {
      setStopError(toApiError(err));
    }
  };

  let body;
  if (!loaded && !error) body = <div className="pf-muted" role="status">{t("portforward:loading")}</div>;
  else if (shown.length === 0 && !error)
    body = <EmptyState title={t("portforward:empty")} text={t("portforward:emptyText")} />;
  else
    body = (
      <table className="pf-table" aria-label={t("portforward:title")}>
        <thead>
          <tr>
            <th>{t("portforward:columns.target")}</th>
            <th>{t("portforward:columns.ports")}</th>
            <th>{t("portforward:columns.status")}</th>
            <th>
              <span className="visually-hidden">{t("resources:table.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((f) => (
            <ForwardRow key={f.id} forward={f} onStop={() => void stop(f.id)} />
          ))}
        </tbody>
      </table>
    );

  return (
    <div className="pf-page">
      <header className="pf-page__header">
        <h2>{t("portforward:title")}</h2>
      </header>
      {error && <ErrorState error={error} />}
      {stopError && <ErrorState error={stopError} />}
      {body}
    </div>
  );
}

function ForwardRow({ forward, onStop }: { forward: ForwardInfo; onStop: () => void }) {
  const { t } = useTranslation();
  const failed = forward.status.state === "error";
  return (
    <tr data-forward={forward.id}>
      <td>{t(`portforward:target.${forward.target.type}`, { name: targetName(forward.target) })}</td>
      <td>{t("portforward:ports", { local: forward.localPort, remote: forward.remotePort })}</td>
      <td>
        <Badge tone={failed ? "danger" : "success"}>{t(`portforward:status.${forward.status.state}`)}</Badge>
        {forward.status.state === "error" && <span className="pf-table__message">{forward.status.message}</span>}
      </td>
      <td className="pf-table__actions">
        <Button size="compact" onClick={() => openInBrowser(forward)}>
          {t("portforward:actions.open")}
        </Button>
        <Button size="compact" onClick={onStop}>
          {t("portforward:actions.stop")}
        </Button>
      </td>
    </tr>
  );
}
