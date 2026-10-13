// What a found update looks like in Settings and in the dialog at start: version, release notes, and either
// "Install and restart" or, for a copy that cannot replace itself (.deb, .rpm, a bare binary), how to update by hand.
import { useTranslation } from "react-i18next";
import { api, RELEASES_URL, type AppInfo, type AvailableUpdate } from "../../api";
import { Button, ErrorState } from "../../components";
import { canInstall, installUpdate, type UpdateFailure, type UpdatesState } from "./store";

export function UpdateDetails({ update, info, state }: { update: AvailableUpdate; info: AppInfo | null; state: UpdatesState }) {
  const { t } = useTranslation();
  const kind = info?.bundleKind ?? null;
  const busy = state.phase === "installing" || state.phase === "restarting";
  const notes = update.notes?.trim();

  let progressText: string | null = null;
  if (state.phase === "restarting") progressText = t("updates:restarting");
  else if (state.phase === "installing") {
    const { downloaded, total } = state.progress ?? { downloaded: 0, total: null };
    progressText =
      total && total > 0
        ? t("updates:installingProgress", { percent: Math.min(100, Math.floor((downloaded / total) * 100)) })
        : t("updates:installing");
  }

  return (
    <div className="updates__details">
      <p className="updates__available">
        {t("updates:available", { version: update.version, current: update.currentVersion })}
      </p>
      {notes && (
        <pre className="updates__notes" aria-label={t("updates:notesLabel")}>
          {notes}
        </pre>
      )}
      {canInstall(kind) ? (
        <div className="updates__row">
          <Button variant="primary" disabled={busy} onClick={() => void installUpdate()}>
            {t("updates:install")}
          </Button>
          {progressText && (
            <span className="updates__status" role="status">
              {progressText}
            </span>
          )}
        </div>
      ) : (
        <>
          <p className="updates__hint">
            {t(kind === "deb" ? "updates:manual.deb" : kind === "rpm" ? "updates:manual.rpm" : "updates:manual.other", {
              version: update.version,
            })}
          </p>
          <ReleasePageButton />
        </>
      )}
      {state.failure?.during === "install" && <UpdateError failure={state.failure} />}
    </div>
  );
}

export function ReleasePageButton() {
  const { t } = useTranslation();
  return (
    <div className="updates__row">
      <Button onClick={() => void api.shell.openUrl(RELEASES_URL).catch(() => undefined)}>
        {t("updates:openReleasePage")}
      </Button>
    </div>
  );
}

const ERROR_KEYS: Record<UpdateFailure["during"], Record<UpdateFailure["kind"], string>> = {
  check: {
    network: "updates:error.network",
    noRelease: "updates:error.noRelease",
    signature: "updates:error.signature",
    other: "updates:error.otherCheck",
  },
  install: {
    network: "updates:error.networkInstall",
    noRelease: "updates:error.otherInstall",
    signature: "updates:error.signature",
    other: "updates:error.otherInstall",
  },
};

export function UpdateError({ failure }: { failure: UpdateFailure }) {
  const { t } = useTranslation();
  return <ErrorState error={failure.error} title={t(ERROR_KEYS[failure.during][failure.kind])} className="updates__error" />;
}
