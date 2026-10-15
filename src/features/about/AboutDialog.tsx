// "About Sextant": icon, version and how this copy was installed, licence, links, the check for updates (the one of
// Settings → Updates) and "Copy version info" for a bug report.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import tauriConfig from "../../../src-tauri/tauri.conf.json";
import { api, type AboutInfo } from "../../api";
import logoUrl from "../../assets/sextant.svg";
import { Button, Dialog } from "../../components";
import { checkForUpdates, useAppInfo, useUpdates } from "../updates/store";
import { ReleasePageButton, UpdateDetails, UpdateError } from "../updates/UpdateDetails";
import { ABOUT_LINKS } from "./links";
import { buildKey, versionInfoText } from "./versionInfo";
import "./about.css";

const { license } = tauriConfig.bundle;
/** `bundle.copyright` names the licence too (for the installers); the licence has its own line here. */
const copyright = tauriConfig.bundle.copyright.replace(`, ${license}`, "").trim();

/** How long "Copied" stays next to the button. */
const FEEDBACK_MS = 3000;

export interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const { t } = useTranslation();

  // Escape closes this dialog only, also when it was opened on top of the Settings dialog (a capture listener on the
  // window runs before the ones of the dialogs below).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  return (
    <Dialog open={open} title={t("about:title")} onClose={onClose}>
      <AboutBody />
    </Dialog>
  );
}

function AboutBody() {
  const { t } = useTranslation();
  const app = useAppInfo();
  const update = useUpdates();
  const configured = api.updates.configured();
  const busy = update.phase === "checking" || update.phase === "installing" || update.phase === "restarting";
  const [machine, setMachine] = useState<{ info: AboutInfo | null } | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    api.about.info().then(
      (info) => live && setMachine({ info }),
      () => live && setMachine({ info: null }),
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  const copy = async () => {
    if (!app || !machine) return;
    try {
      if (!navigator.clipboard) throw new Error("the clipboard is not available");
      await navigator.clipboard.writeText(versionInfoText(app, machine.info, (key) => t(key)));
      setFeedback({ kind: "ok", text: t("about:copied") });
    } catch {
      setFeedback({ kind: "error", text: t("about:copyFailed") });
    }
  };

  return (
    <div className="about">
      <div className="about__head">
        <img className="about__logo" src={logoUrl} alt="" width={64} height={64} />
        <div className="about__identity">
          <p className="about__name">{t("about:name")}</p>
          <p className="about__version">{app ? t("about:version", { version: app.version }) : t("about:versionUnknown")}</p>
          {app && <p className="about__build">{t(buildKey(app))}</p>}
        </div>
      </div>

      <p className="about__text">{t("about:tagline")}</p>
      <p className="about__text">{t("about:license", { license })}</p>
      <p className="about__text about__text--muted">{copyright}</p>

      <div className="about__links" role="group" aria-label={t("about:links")}>
        {ABOUT_LINKS.map((link) => (
          <Button key={link.id} onClick={() => void api.shell.openUrl(link.url).catch(() => undefined)}>
            {t(`about:link.${link.id}`)}
          </Button>
        ))}
      </div>

      <div className="about__updates">
        {!configured && (
          <>
            <p className="about__text about__text--muted">{t("updates:notConfigured")}</p>
            <ReleasePageButton />
          </>
        )}
        <div className="updates__row">
          <Button disabled={!configured || busy} onClick={() => void checkForUpdates()}>
            {t("updates:check")}
          </Button>
          {update.phase === "checking" && (
            <span className="updates__status" role="status">
              {t("updates:checking")}
            </span>
          )}
          {update.phase === "upToDate" && (
            <span className="updates__status" role="status">
              {t("updates:upToDate")}
            </span>
          )}
        </div>
        {update.failure?.during === "check" && <UpdateError failure={update.failure} />}
        {update.update && <UpdateDetails update={update.update} info={app} state={update} />}
      </div>

      <div className="updates__row">
        <Button disabled={!app || !machine} onClick={() => void copy()}>
          {t("about:copy")}
        </Button>
        {feedback && (
          <span className="updates__status" role={feedback.kind === "error" ? "alert" : "status"}>
            {feedback.text}
          </span>
        )}
      </div>
    </div>
  );
}
