// The sign-in window of Argo CD: a local user and password, or an API token; "Remember" saves it in the OS
// credential store (by the backend). The password lives in this form's state only until it is sent.
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ArgoStatus, type ClusterId } from "../../../api";
import { Button, Checkbox } from "../../../components";
import { loginErrorDetail, loginErrorKey, type LoginMode } from "./model";

export interface LoginFormProps {
  clusterId: ClusterId;
  /** `null` when the status could not be read. */
  status: ArgoStatus | null;
  /** Why the window is shown: the diff answered `unauthorized` (or `null` after signing out). */
  reason: ApiError | null;
  onSignedIn: (status: ArgoStatus) => void;
}

export function LoginForm({ clusterId, status, reason, onSignedIn }: LoginFormProps) {
  const { t } = useTranslation();
  const ids = { user: useId(), password: useId(), token: useId(), remember: useId() };
  const [mode, setMode] = useState<LoginMode>(status && !status.localUsers ? "token" : "password");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const ready = mode === "token" ? token.trim() !== "" : username.trim() !== "" && password !== "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const login =
      mode === "token" ? { token: token.trim(), remember } : { username: username.trim(), password, remember };
    try {
      const signed = await api.argocd.login(clusterId, login);
      setPassword("");
      setToken("");
      onSignedIn(signed);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const notes: string[] = [];
  if (reason && status?.expired) notes.push(t("argocd:login.expired"));
  if (status && !status.localUsers) notes.push(t("argocd:login.noLocalUsers"));
  if (status?.sso) notes.push(t("argocd:login.sso"));
  const intro = t("argocd:login.intro", { namespace: status?.namespace ?? "argocd" });
  const modes: { id: LoginMode; label: string }[] = [
    { id: "password", label: t("argocd:login.mode.password") },
    { id: "token", label: t("argocd:login.mode.token") },
  ];

  return (
    <form className="argo-login" onSubmit={submit} aria-label={t("argocd:login.title")}>
      <h3>{t("argocd:login.title")}</h3>
      <p>{intro}</p>
      {notes.map((note) => (
        <p key={note} className="argo-login__note" role="note">
          {note}
        </p>
      ))}
      <div className="argo-login__modes" role="group" aria-label={t("argocd:login.mode.label")}>
        {modes.map((m) => (
          <Button
            key={m.id}
            aria-pressed={mode === m.id}
            onClick={() => {
              setMode(m.id);
              setError(null);
            }}
          >
            {m.label}
          </Button>
        ))}
      </div>
      <div className="argo-login__fields">
        {mode === "password" ? (
          <>
            <label htmlFor={ids.user}>{t("argocd:login.username")}</label>
            <input
              id={ids.user}
              value={username}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
            <label htmlFor={ids.password}>{t("argocd:login.password")}</label>
            <input
              id={ids.password}
              type="password"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        ) : (
          <>
            <label htmlFor={ids.token}>{t("argocd:login.token")}</label>
            <input
              id={ids.token}
              type="password"
              value={token}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
            />
          </>
        )}
      </div>
      <div className="argo-login__remember">
        <Checkbox id={ids.remember} checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <label htmlFor={ids.remember}>{t("argocd:login.remember")}</label>
      </div>
      <p className="argo-login__hint">{t("argocd:login.hint")}</p>
      {error && (
        <div className="argo-login__error" role="alert">
          <p>{t(loginErrorKey(error, status, mode))}</p>
          {loginErrorDetail(error) && <p className="argo-login__detail">{loginErrorDetail(error)}</p>}
        </div>
      )}
      <div className="argo-login__actions">
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {t(busy ? "argocd:login.signingIn" : "argocd:login.submit")}
        </Button>
      </div>
    </form>
  );
}
