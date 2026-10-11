// The dialog that starts a forward: which port, which local port (own or a free one picked by the backend).
// A taken local port is reported with the offer to take a free one instead.
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ClusterId, type ForwardInfo, type ForwardTarget } from "../../api";
import { Dialog, ErrorState } from "../../components";
import { parseLocalPort, targetName } from "./model";
import { openInBrowser } from "./openInBrowser";

export interface ForwardDialogProps {
  clusterId: ClusterId;
  target: ForwardTarget;
  /** Ports the object offers; the first one is preselected. */
  ports: number[];
  initialPort?: number;
  close: () => void;
}

export function ForwardDialog({ clusterId, target, ports, initialPort, close }: ForwardDialogProps) {
  const { t } = useTranslation();
  const ids = { remote: useId(), local: useId() };
  const [remotePort, setRemotePort] = useState(initialPort ?? ports[0] ?? 0);
  const [custom, setCustom] = useState(false);
  const [localText, setLocalText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [taken, setTaken] = useState<number | null>(null);
  const [started, setStarted] = useState<ForwardInfo | null>(null);

  const localPort = custom ? parseLocalPort(localText) : null;
  const valid = remotePort > 0 && (!custom || localPort !== null);

  const start = async (local: number | null) => {
    setBusy(true);
    setError(null);
    setTaken(null);
    try {
      setStarted(await api.portForward.start(clusterId, target, remotePort, local));
    } catch (err) {
      const apiError = toApiError(err);
      if (apiError.code === "portInUse" && local !== null) setTaken(local);
      else setError(apiError);
    } finally {
      setBusy(false);
    }
  };

  const title = t("portforward:dialog.title", { target: targetName(target) });

  if (started) {
    return (
      <Dialog
        open
        title={title}
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              {t("portforward:dialog.close")}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => openInBrowser(started)}>
              {t("portforward:actions.open")}
            </button>
          </>
        }
      >
        <p className="pf-dialog__result">
          {t("portforward:dialog.started", { local: started.localPort, remote: started.remotePort })}
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={title}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {t("common:actions.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !valid}
            onClick={() => void start(localPort)}
          >
            {busy ? t("portforward:dialog.starting") : t("portforward:dialog.start")}
          </button>
        </>
      }
    >
      <div className="pf-dialog">
        <div className="pf-dialog__field">
          <label htmlFor={ids.remote}>{t("portforward:dialog.remotePort")}</label>
          <select id={ids.remote} value={remotePort} onChange={(e) => setRemotePort(Number(e.target.value))}>
            {ports.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="pf-dialog__choice" role="radiogroup" aria-label={t("portforward:dialog.localPortChoice")}>
          <label>
            <input type="radio" name={ids.local} checked={!custom} onChange={() => setCustom(false)} />
            {t("portforward:dialog.auto")}
          </label>
          <label>
            <input type="radio" name={ids.local} checked={custom} onChange={() => setCustom(true)} />
            {t("portforward:dialog.custom")}
          </label>
        </div>
        {custom && (
          <div className="pf-dialog__field">
            <label htmlFor={`${ids.local}-port`}>{t("portforward:dialog.localPort")}</label>
            <input
              id={`${ids.local}-port`}
              type="number"
              min={1}
              max={65535}
              step={1}
              value={localText}
              autoFocus
              onChange={(e) => setLocalText(e.target.value)}
            />
            {localText !== "" && localPort === null && (
              <span className="pf-dialog__hint">{t("portforward:dialog.invalidPort")}</span>
            )}
          </div>
        )}
        {taken !== null && (
          <div className="pf-dialog__taken" role="alert">
            <span>{t("portforward:dialog.inUse", { port: taken })}</span>
            <button type="button" className="btn btn--small" disabled={busy} onClick={() => void start(null)}>
              {t("portforward:dialog.useFree")}
            </button>
          </div>
        )}
        {error && <ErrorState error={error} />}
      </div>
    </Dialog>
  );
}
