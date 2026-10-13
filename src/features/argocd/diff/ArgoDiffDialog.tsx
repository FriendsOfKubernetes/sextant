// The "Diff" of an Application: asks the backend for the desired and live states of its resources. The backend
// signs in to Argo CD by itself (saved login, then the standard secrets); when it answers `unauthorized` the sign-in
// window takes the place of the diff and the diff is read again after signing in.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errorKey, toApiError, type ApiError, type ArgoStatus, type ClusterId, type ManagedResource, type ObjectRef } from "../../../api";
import { Button, Dialog, LoadingIndicator } from "../../../components";
import { ambiguousInstallationText, isAmbiguousInstallation } from "../server";
import { DiffView } from "./DiffView";
import { LoginForm } from "./LoginForm";

type Phase =
  | { type: "loading" }
  | { type: "login"; status: ArgoStatus | null; reason: ApiError | null }
  | { type: "diff"; items: ManagedResource[]; status: ArgoStatus | null }
  | { type: "error"; error: ApiError };

export interface ArgoDiffDialogProps {
  clusterId: ClusterId;
  app: ObjectRef;
  close: () => void;
}

export function ArgoDiffDialog({ clusterId, app, close }: ArgoDiffDialogProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ type: "loading" });
  // Answers of an older request (or after the dialog closed) are dropped.
  const request = useRef(0);

  const status = useCallback(() => api.argocd.status(clusterId).catch(() => null), [clusterId]);

  const load = useCallback(async () => {
    const id = ++request.current;
    setPhase({ type: "loading" });
    try {
      const items = await api.argocd.diff(clusterId, app);
      const current = await status();
      if (id === request.current) setPhase({ type: "diff", items, status: current });
    } catch (err) {
      const error = toApiError(err);
      if (error.code !== "unauthorized") {
        if (id === request.current) setPhase({ type: "error", error });
        return;
      }
      const current = await status();
      if (id === request.current) setPhase({ type: "login", status: current, reason: error });
    }
  }, [clusterId, app, status]);

  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);

  const signOut = async (forget: boolean) => {
    const id = ++request.current;
    try {
      const after = await api.argocd.logout(clusterId, forget);
      if (id === request.current) setPhase({ type: "login", status: after, reason: null });
    } catch (err) {
      if (id === request.current) setPhase({ type: "error", error: toApiError(err) });
    }
  };

  const title = t("argocd:diff.title", { name: app.name });
  return (
    <Dialog open title={title} onClose={close}>
      <div className="argo-diff-dialog">
        {phase.type === "loading" && <LoadingIndicator text={t("argocd:diff.loading")} />}
        {phase.type === "login" && (
          <LoginForm clusterId={clusterId} status={phase.status} reason={phase.reason} onSignedIn={() => void load()} />
        )}
        {phase.type === "error" && <DiffError error={phase.error} onRetry={() => void load()} />}
        {phase.type === "diff" && (
          <>
            <SessionBar status={phase.status} onReload={() => void load()} onSignOut={signOut} />
            <DiffView items={phase.items} />
          </>
        )}
      </div>
    </Dialog>
  );
}

function SessionBar({
  status,
  onReload,
  onSignOut,
}: {
  status: ArgoStatus | null;
  onReload: () => void;
  onSignOut: (forget: boolean) => void;
}) {
  const { t } = useTranslation();
  const who = status?.user ? t("argocd:diff.signedInAs", { user: status.user }) : t("argocd:diff.signedIn");
  const how = status?.source ? t(`argocd:diff.source.${status.source}`) : "";
  return (
    <div className="argo-diff__session">
      <span>{how ? `${who} · ${how}` : who}</span>
      <span className="argo-diff__session-actions">
        <Button onClick={onReload}>
          {t("argocd:diff.reload")}
        </Button>
        <Button onClick={() => onSignOut(false)}>
          {t("argocd:diff.signOut")}
        </Button>
        {status?.source === "saved" && (
          <Button onClick={() => onSignOut(true)}>
            {t("argocd:diff.forget")}
          </Button>
        )}
      </span>
    </div>
  );
}

function DiffError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const { t } = useTranslation();
  const key =
    error.code === "unreachable" || error.code === "timeout"
      ? "argocd:login.errors.unreachable"
      : error.code === "forbidden"
        ? "argocd:diff.errors.forbidden"
        : error.code === "notFound"
          ? "argocd:diff.errors.notFound"
          : errorKey(error.code);
  const text = isAmbiguousInstallation(error) ? ambiguousInstallationText(error) : t(key);
  return (
    <div className="argo-diff__error" role="alert">
      <p>{text}</p>
      {error.message && <p className="argo-login__detail">{error.message}</p>}
      <Button onClick={onRetry}>
        {t("argocd:diff.retry")}
      </Button>
    </div>
  );
}
