// An extension's backend in Settings → Extensions (ADR-0131): what the consent screen says about it, the form where
// the user enters its credentials (kept in the keyring by the backend; a value never comes back to the window), and
// its log.
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type BackendLogLine, type BackendManifest, type CredentialStatus } from "../../api";
import { Badge, Button, Dialog, ErrorState, LoadingIndicator } from "../../components";
import { formatTime } from "../../i18n";

/** The consent screen's block about a backend: that it runs code, where it may connect, what it asks for. */
export function BackendConsent({ backend }: { backend: BackendManifest }) {
  const { t } = useTranslation();
  const hosts = backend.network.hosts;
  return (
    <>
      <h3 className="ext-consent__heading">{t("extensions:backend.heading")}</h3>
      <div className="ext-consent__warning" role="note">
        <strong>{t("extensions:backend.runsCode")}</strong>
        <p>{t("extensions:backend.runsCodeHint")}</p>
      </div>
      {hosts.length > 0 ? (
        <>
          <p>{t("extensions:backend.hosts")}</p>
          <ul className="ext-backend__list">
            {hosts.map((host) => (
              <li key={host}>
                <code>{host}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>{t("extensions:backend.noNetwork")}</p>
      )}
      {backend.credentials.length > 0 && (
        <>
          <p>{t("extensions:backend.credentials")}</p>
          <ul className="ext-backend__list">
            {backend.credentials.map((c) => (
              <li key={c.id}>{c.label}</li>
            ))}
          </ul>
          <p className="settings__hint">{t("extensions:backend.credentialsHint")}</p>
        </>
      )}
    </>
  );
}

function CredentialRow({ extensionId, status, onChanged }: { extensionId: string; status: CredentialStatus; onChanged: () => void }) {
  const { t } = useTranslation();
  const inputId = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const save = async (next: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.extensions.setCredential(extensionId, status.id, next);
      setValue("");
      onChanged();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="ext-credential" aria-label={status.label}>
      <div className="ext-row__title">
        <label className="settings__label" htmlFor={inputId}>
          {status.label}
        </label>
        <Badge tone={status.set ? "success" : "neutral"}>{status.set ? t("extensions:backend.set") : t("extensions:backend.notSet")}</Badge>
      </div>
      <form
        className="ext-credential__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value !== "") void save(value);
        }}
      >
        <input
          id={inputId}
          className="settings__input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={t("extensions:backend.value")}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={busy || value === ""}>
          {t("extensions:backend.save")}
        </Button>
        {status.set && (
          <Button disabled={busy} onClick={() => void save(null)}>
            {t("extensions:backend.clear")}
          </Button>
        )}
      </form>
      {error && <ErrorState error={error} title={t("extensions:list.actionFailed")} className="settings__error" />}
    </li>
  );
}

/** The credentials of one extension's backend: which are entered, a field to enter or replace each, Remove. */
export function CredentialsDialog({ extensionId, name, onClose }: { extensionId: string; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [list, setList] = useState<CredentialStatus[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(() => {
    api.extensions.credentials(extensionId).then(setList, (err: unknown) => setError(toApiError(err)));
  }, [extensionId]);
  useEffect(load, [load]);
  return (
    <Dialog
      open
      title={t("extensions:backend.credentialsTitle", { name })}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t("extensions:permissionsDialog.close")}</Button>}
    >
      <p className="settings__hint">{t("extensions:backend.credentialsIntro")}</p>
      {error && <ErrorState error={error} title={t("extensions:list.actionFailed")} onRetry={load} />}
      {!error && list === null && <LoadingIndicator text={t("extensions:backend.loading")} />}
      {list && (
        <ul className="ext-list">
          {list.map((status) => (
            <CredentialRow key={status.id} extensionId={extensionId} status={status} onChanged={load} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

const LEVEL_TONES = { debug: "neutral", info: "info", warn: "warning", error: "danger" } as const;

/** The backend's log: its `host.log` lines, stdout and stderr, and its failures, oldest first. */
export function BackendLogDialog({ extensionId, name, onClose }: { extensionId: string; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<BackendLogLine[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(() => {
    setError(null);
    api.extensions.backendLog(extensionId).then(setLines, (err: unknown) => setError(toApiError(err)));
  }, [extensionId]);
  useEffect(load, [load]);
  return (
    <Dialog
      open
      title={t("extensions:backend.logTitle", { name })}
      onClose={onClose}
      footer={
        <>
          <Button icon="refresh" onClick={load}>
            {t("extensions:catalog.refresh")}
          </Button>
          <Button onClick={onClose}>{t("extensions:permissionsDialog.close")}</Button>
        </>
      }
    >
      {error && <ErrorState error={error} title={t("extensions:list.actionFailed")} onRetry={load} />}
      {!error && lines === null && <LoadingIndicator text={t("extensions:backend.loading")} />}
      {lines && lines.length === 0 && <p className="settings__hint">{t("extensions:backend.logEmpty")}</p>}
      {lines && lines.length > 0 && (
        <ol className="ext-backend__log">
          {lines.map((line, i) => (
            <li key={i}>
              <span className="ext-backend__time">{formatTime(line.at)}</span>
              <Badge tone={LEVEL_TONES[line.level]}>{t(`extensions:backend.levels.${line.level}`)}</Badge>
              <span className="ext-backend__message">{line.message}</span>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
