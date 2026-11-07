// The "What's new" window (ADR-0166): each version's notes, then the extensions of Sextant's own that left the core in
// it, each with "Install" (the catalog's own install in Settings → Extensions: the package checked, then the consent
// window) or "Installed".
import { useTranslation } from "react-i18next";
import { useSettings } from "../../api";
import { Button, Dialog } from "../../components";
import { useExtensions } from "../../extensions";
import { offerOf } from "../extension-offers/offers";
import { requestCatalogInstall } from "../extensions/installRequest";
import { versionKey, type ReleaseNotes } from "./notes";
import "./whatsnew.css";

export function WhatsNewDialog({ notes, onClose }: { notes: readonly ReleaseNotes[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { extensions } = useExtensions();
  const { settings } = useSettings();
  const installed = new Set(extensions.map((e) => e.id));
  const catalogOff = settings?.extensionCatalog.enabled === false;
  const newest = notes[0];
  if (!newest) return null;
  return (
    <Dialog
      open
      title={t("whatsnew:title", { version: newest.version })}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("whatsnew:close")}
        </Button>
      }
    >
      <div className="whatsnew">
        {notes.map((note) => (
          <section key={note.version} className="whatsnew__version" aria-label={t("whatsnew:version", { version: note.version })}>
            {notes.length > 1 && <h3 className="whatsnew__version-title">{t("whatsnew:version", { version: note.version })}</h3>}
            <ul className="whatsnew__items">
              {note.items.map((item) => (
                <li key={item}>
                  <strong>{t(`whatsnew:${versionKey(note.version)}.${item}.title`)}</strong>
                  <p>{t(`whatsnew:${versionKey(note.version)}.${item}.text`)}</p>
                </li>
              ))}
            </ul>
            {note.extensions.length > 0 && (
              <>
                <h3 className="whatsnew__offers-title">{t("whatsnew:extensions.title")}</h3>
                <p className="settings__hint">{t("whatsnew:extensions.hint")}</p>
                {catalogOff && <p className="settings__hint">{t("whatsnew:extensions.catalogOff")}</p>}
                <ul className="whatsnew__offers" aria-label={t("whatsnew:extensions.title")}>
                  {note.extensions.map((id) => {
                    const offer = offerOf(id);
                    const tool = offer?.tool ?? id;
                    return (
                      <li key={id} className="whatsnew__offer">
                        <span className="whatsnew__offer-text">
                          <strong>{tool}</strong>
                          <span>{t(`whatsnew:extensions.about.${id.replace("sextant.", "")}`)}</span>
                        </span>
                        {installed.has(id) ? (
                          <span className="whatsnew__installed">{t("whatsnew:extensions.installed")}</span>
                        ) : (
                          <Button
                            icon="download"
                            aria-label={t("whatsnew:extensions.installLabel", { tool })}
                            onClick={() => {
                              onClose();
                              requestCatalogInstall(id);
                            }}
                          >
                            {t("whatsnew:extensions.install")}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
