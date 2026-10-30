// The window of consent (spec story 8): who the extension is, what it adds, what it may do. Nothing is installed
// until the user presses Install. Also the window for "Review permissions" of an extension that was paused.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type PendingInstall } from "../../api";
import { Badge, Button, Dialog, ErrorState } from "../../components";
import { pushNotice, refreshExtensions } from "../../extensions";
import { BackendConsent } from "./BackendDialogs";
import { ExtensionIcon } from "./ExtensionIcon";
import { ProblemsConsent } from "./ProblemsConsent";
import { installErrorTitle, sourceText } from "./install";
import { ContributionsView, PermissionsView, readsSecretValues } from "./PermissionsView";

export interface ConsentDialogProps {
  pending: PendingInstall;
  /** The window was opened from "Review permissions" (the extension is installed and paused). */
  review?: boolean;
  /** Cancel (the pending install is dropped first), or done after a successful install. */
  onClose: () => void;
}

export function ConsentDialog({ pending, review = false, onClose }: ConsentDialogProps) {
  const { t } = useTranslation();
  const { manifest, source } = pending;
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const update = pending.replaces !== null && !review;
  const secrets = readsSecretValues(manifest.permissions);

  // `notFound` (and only it) says the pending install is gone: expired, used, or the package changed since its check.
  // Any other failure leaves it waiting, so Install can be pressed again.
  const gone = error?.code === "notFound";

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      const info = await api.extensions.install(pending.token);
      void refreshExtensions();
      pushNotice(info.name, t(update ? "extensions:install.updated" : "extensions:install.installed", { version: info.version }));
      onClose();
    } catch (err) {
      setError(toApiError(err));
      setInstalling(false);
    }
  };

  // Declining drops the checked package at once (its copy can be tens of MB) instead of letting it wait out its time.
  const cancel = () => {
    api.extensions.installCancel(pending.token).catch(() => undefined);
    onClose();
  };

  const title = review
    ? t("extensions:consent.titleReview", { name: manifest.name })
    : t(update ? "extensions:consent.titleUpdate" : "extensions:consent.titleInstall", { name: manifest.name });

  return (
    <Dialog
      open
      title={title}
      onClose={cancel}
      footer={
        <>
          <Button onClick={cancel}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" disabled={installing || gone} onClick={() => void install()}>
            {update ? t("extensions:consent.update") : t("extensions:consent.install")}
          </Button>
        </>
      }
    >
      <div className="ext-consent">
        <div className="ext-consent__head">
          <ExtensionIcon name={manifest.icon} size={28} />
          <div className="ext-consent__name">
            <strong>{manifest.name}</strong>
            {source.type === "folder" && <Badge tone="info">{t("extensions:list.development")}</Badge>}
          </div>
        </div>
        {manifest.description && <p className="ext-consent__description">{manifest.description}</p>}
        <dl className="ext-consent__facts">
          <dt>{t("extensions:consent.author")}</dt>
          <dd>{manifest.author}</dd>
          <dt>{t("extensions:consent.version")}</dt>
          <dd>{manifest.version}</dd>
          <dt>{t("extensions:consent.source")}</dt>
          <dd className="ext-consent__source">{sourceText(source, t)}</dd>
          {source.type === "catalog" && (
            <>
              <dt>{t("extensions:catalog.publisherKey")}</dt>
              <dd className="ext-consent__source">
                <Badge tone="success">{t("extensions:consent.verified", { keyId: source.keyId })}</Badge>
              </dd>
            </>
          )}
        </dl>
        {pending.listedInCatalog && (
          <div className="ext-consent__warning" role="alert">
            <strong>{t("extensions:consent.namesake", pending.listedInCatalog)}</strong>
          </div>
        )}
        {source.type === "folder" && <p className="settings__hint">{t("extensions:consent.devHint")}</p>}
        {review && <p className="ext-consent__review">{t("extensions:consent.reviewHint")}</p>}
        {update && pending.replaces && (
          <div className="ext-consent__update">
            <p>{t("extensions:consent.replaces", { version: pending.replaces })}</p>
            <p>
              <Badge tone={pending.newPermissions ? "warning" : "success"}>
                {pending.newPermissions ? t("extensions:consent.newPermissions") : t("extensions:consent.samePermissions")}
              </Badge>{" "}
              <span className="settings__hint">
                {pending.newPermissions
                  ? t("extensions:consent.newPermissionsHint")
                  : t("extensions:consent.samePermissionsHint")}
              </span>
            </p>
          </div>
        )}
        <h3 className="ext-consent__heading">{t("extensions:consent.adds")}</h3>
        <ContributionsView contributes={manifest.contributes} />
        <h3 className="ext-consent__heading">{t("extensions:consent.permissions")}</h3>
        {secrets && (
          <div className="ext-consent__warning" role="alert">
            <strong>{t("extensions:consent.secretWarning")}</strong>
            <p>{t("extensions:consent.secretWarningHint")}</p>
          </div>
        )}
        <PermissionsView permissions={manifest.permissions} />
        {manifest.backend && <BackendConsent backend={manifest.backend} />}
        {manifest.contributes.problems.length > 0 && <ProblemsConsent rules={manifest.contributes.problems} />}
        {error && <ErrorState error={error} title={installErrorTitle(error, t)} className="settings__error" />}
      </div>
    </Dialog>
  );
}
