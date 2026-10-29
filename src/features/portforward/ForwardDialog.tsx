// The dialog that starts a forward: which port, which local port (own or a free one picked by the backend).
// A taken local port is reported with the offer to take a free one instead.
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, type ApiError, type ClusterId, type ForwardInfo, type ForwardTarget } from "../../api";
import { useAppStore } from "../../app/store";
import { Button, Dialog, ErrorState, Radio } from "../../components";
import { parseLocalPort, targetName, sameTarget, PORT_FORWARD_PAGE } from "./model";
import { ForwardButtons, useForwardControls } from "./ForwardButtons";
import { restartForward, startForward } from "./hooks";
import "./portforward.css";

export interface ForwardDialogProps {
  clusterId: ClusterId;
  target: ForwardTarget;
  /** Ports the object offers; the first one is preselected. */
  ports: number[];
  initialPort?: number;
  initialLocalPort?: number;
  initialError?: ApiError;
  close: () => void;
}

function useForwardForm({ clusterId, target, ports, initialPort, initialLocalPort, initialError }: ForwardDialogProps) {
  const [remotePort, setRemotePort] = useState(initialPort ?? ports[0] ?? 0);
  const [custom, setCustom] = useState(initialLocalPort !== undefined);
  const [localText, setLocalText] = useState(initialLocalPort?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(initialError ?? null);
  const [taken, setTaken] = useState<number | null>(null);
  const [started, setStarted] = useState<ForwardInfo | null>(null);
  const retry = async (forward: ForwardInfo) => {
    setBusy(true);
    setError(null);
    try { setStarted(await restartForward(forward)); }
    catch (err) {
      setStarted(null);
      setCustom(true);
      setLocalText(String(forward.localPort));
      setRemotePort(forward.remotePort);
      setError(toApiError(err));
    } finally { setBusy(false); }
  };

  const localPort = custom ? parseLocalPort(localText) : null;
  const valid = remotePort > 0 && (!custom || localPort !== null);

  const start = async (local: number | null) => {
    setBusy(true);
    setError(null);
    setTaken(null);
    try {
      setStarted(await startForward(clusterId, target, remotePort, local));
    } catch (err) {
      const apiError = toApiError(err);
      if (apiError.code === "portInUse" && local !== null) setTaken(local);
      else setError(apiError);
    } finally {
      setBusy(false);
    }
  };

  return { remotePort, setRemotePort, custom, setCustom, localText, setLocalText, busy, error, taken, started,
    localPort, valid, start, retry, again: () => { setStarted(null); setError(null); } };
}

export function ForwardDialog(props: ForwardDialogProps) {
  const { clusterId, target, ports, close } = props;
  const { t } = useTranslation();
  const remoteId = useId();
  const { remotePort, setRemotePort, custom, setCustom, localText, setLocalText, busy, error, taken, started,
    localPort, valid, start, retry, again } = useForwardForm(props);
  const controls = useForwardControls();
  const { forwards, pending, error: listError, requestStop, actionError, confirmation } = controls;
  const existing = forwards.filter(f => f.cluster === clusterId && sameTarget(f.target, target) && f.remotePort === remotePort);
  const openManager = () => {
    useAppStore.getState().setView(clusterId, PORT_FORWARD_PAGE);
    useAppStore.getState().closeDetails();
    close();
  };

  const title = t("portforward:dialog.title", { target: targetName(target) });

  if (started) return <ForwardResult started={started} title={title} controls={controls} busy={busy} close={close}
    onManager={openManager} onRetry={retry} onAnother={again} />;

  return (
    <>
    <Dialog
      open
      title={title}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={openManager}>{t("portforward:actions.all")}</Button>
          <Button
            variant="primary"
            disabled={busy || !valid}
            onClick={() => void start(localPort)}
          >
            {busy ? t("portforward:dialog.starting") : t("portforward:dialog.start")}
          </Button>
        </>
      }
    >
      <div className="pf-dialog">
        <div className="pf-dialog__field">
          <label htmlFor={remoteId}>{t("portforward:dialog.remotePort")}</label>
          <select id={remoteId} value={remotePort} onChange={(e) => setRemotePort(Number(e.target.value))}>
            {ports.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        {existing.length > 0 && <div className="pf-dialog__existing">
          <p>{t("portforward:dialog.existing")}</p>
          {existing.map(f => <div key={f.id}>
            <span className="pf-route">{t("portforward:ports", { local: f.localPort, remote: f.remotePort })}</span>
            <ForwardButtons forward={f} pending={pending.has(f.id) || busy} onStop={() => requestStop(f)} onRetry={() => void retry(f)} />
          </div>)}
        </div>}
        <LocalPortChoice custom={custom} localText={localText} onMode={setCustom} onText={setLocalText} />
        {taken !== null && (
          <div className="pf-dialog__taken" role="alert">
            <span>{t("portforward:dialog.inUse", { port: taken })}</span>
            <Button disabled={busy} onClick={() => void start(null)}>
              {t("portforward:dialog.useFree")}
            </Button>
          </div>
        )}
        {error && <ErrorState error={error} />}{actionError && <ErrorState error={actionError} />}
        {listError && <ErrorState error={listError} />}
      </div>
    </Dialog>
    {confirmation}
    </>
  );
}

function ForwardResult({ started, title, controls, busy, close, onManager, onRetry, onAnother }: {
  started: ForwardInfo; title: string; controls: ReturnType<typeof useForwardControls>; busy: boolean;
  close: () => void; onManager: () => void; onRetry: (forward: ForwardInfo) => Promise<void>; onAnother: () => void;
}) {
  const { t } = useTranslation();
    const live = controls.forwards.find(f => f.id === started.id);
    return (
      <>
      <Dialog
        open
        title={title}
        onClose={close}
        footer={
          <>
            <Button onClick={close}>
              {t("portforward:dialog.close")}
            </Button>
            <Button onClick={onManager}>{t("portforward:actions.all")}</Button>
            {live ? <ForwardButtons forward={live} pending={controls.pending.has(live.id) || busy} onStop={() => controls.requestStop(live)} onRetry={() => void onRetry(live)} /> :
              <Button onClick={onAnother}>{t("portforward:dialog.startAnother")}</Button>}
          </>
        }
      >
        <p className={live?.status.state === "active" ? "pf-dialog__result" : "pf-muted"}>
          {live ? t("portforward:dialog.started", { local: live.localPort, remote: live.remotePort }) : t("portforward:dialog.stopped")}
        </p>
        {live?.status.state === "error" && <ErrorState error={live.status} />}{controls.actionError && <ErrorState error={controls.actionError} />}
      </Dialog>
      {controls.confirmation}
      </>
    );
}

function LocalPortChoice({ custom, localText, onMode, onText }: {
  custom: boolean; localText: string; onMode: (custom: boolean) => void; onText: (text: string) => void;
}) {
  const { t } = useTranslation();
  const localId = useId();
  const localPort = parseLocalPort(localText);
  return <>        <div className="pf-dialog__choice" role="radiogroup" aria-label={t("portforward:dialog.localPortChoice")}>
          <label>
            <Radio name={localId} checked={!custom} onChange={() => onMode(false)} />
            {t("portforward:dialog.auto")}
          </label>
          <label>
            <Radio name={localId} checked={custom} onChange={() => onMode(true)} />
            {t("portforward:dialog.custom")}
          </label>
        </div>
        {custom && (
          <div className="pf-dialog__field">
            <label htmlFor={`${localId}-port`}>{t("portforward:dialog.localPort")}</label>
            <input
              id={`${localId}-port`}
              type="number"
              min={1}
              max={65535}
              step={1}
              value={localText}
              autoFocus
              onChange={(e) => onText(e.target.value)}
            />
            {localText !== "" && localPort === null && (
              <span className="pf-dialog__hint">{t("portforward:dialog.invalidPort")}</span>
            )}
          </div>
        )}
</>;
}
