// One installed extension in Settings → Extensions: what it is, its state, and what you can do with it.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ExtensionInfo, type ExtensionState } from "../../api";
import { Badge, Button, ConfirmDialog, Dialog, ErrorState, type BadgeTone } from "../../components";
import { ExtensionSettingsFrame, refreshExtensions } from "../../extensions";
import { ExtensionActivityDialog } from "./ExtensionActivityDialog";
import { ExtensionIcon } from "./ExtensionIcon";
import { reinstallText, sourceText } from "./install";
import { PermissionsView } from "./PermissionsView";
import { ReviewDialog } from "./ReviewDialog";

const STATE_TONES: Record<ExtensionState, BadgeTone> = {
  active: "success",
  disabled: "neutral",
  needsConsent: "warning",
  failed: "danger",
};

type Dialogs = "permissions" | "activity" | "remove" | "review" | null;

export function ExtensionRow({ info }: { info: ExtensionInfo }) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const close = () => setDialog(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
      void refreshExtensions();
    }
  };
  // Accessible names of the row's buttons: one whole text per action, with the extension's name where the language
  // puts it.
  const named = { name: info.name };
  const hasSettings = info.state === "active" && info.manifest?.contributes.settings !== undefined;
  const requested = info.manifest?.permissions;
  // Only a folder can be read again for review; a package is reviewed by installing it again from its source.
  const reinstall = reinstallText(info.source, t);

  return (
    <li className="ext-row" data-state={info.state} aria-label={info.name}>
      <div className="ext-row__main">
        <ExtensionIcon name={info.manifest?.icon} />
        <div className="ext-row__info">
          <div className="ext-row__title">
            <strong>{info.name}</strong>
            <span className="ext-row__version">{t("extensions:list.version", { version: info.version })}</span>
            {info.dev && <Badge tone="info">{t("extensions:list.development")}</Badge>}
            <Badge tone={STATE_TONES[info.state]}>{t(`extensions:state.${info.state}`)}</Badge>
          </div>
          <div className="ext-row__meta">{sourceText(info.source, t)}</div>
          {info.manifest?.description && <div className="ext-row__description">{info.manifest.description}</div>}
        </div>
      </div>
      {info.state === "failed" && info.error && (
        <p className="ext-row__alert" data-tone="danger" role="alert">
          {t("extensions:list.failedHint", { error: info.error })}
        </p>
      )}
      {info.needsConsent && (
        <div className="ext-row__alert" data-tone="warning" role="alert">
          <span>{t("extensions:list.pausedHint")}</span>
          {reinstall !== null && <span>{reinstall}</span>}
          {reinstall === null && (
            <Button variant="primary" size="compact" onClick={() => setDialog("review")}>
              {t("extensions:list.reviewPermissions")}
            </Button>
          )}
        </div>
      )}
      <div className="ext-row__actions">
        <Button
          size="compact"
          disabled={busy}
          aria-label={info.enabled ? t("extensions:list.named.disable", named) : t("extensions:list.named.enable", named)}
          onClick={() => void run(() => api.extensions.setEnabled(info.id, !info.enabled))}
        >
          {info.enabled ? t("extensions:list.disable") : t("extensions:list.enable")}
        </Button>
        <Button size="compact" aria-label={t("extensions:list.named.permissions", named)} onClick={() => setDialog("permissions")}>
          {t("extensions:list.permissions")}
        </Button>
        <Button
          size="compact"
          disabled={busy}
          aria-label={t("extensions:list.named.reload", named)}
          onClick={() => void run(() => api.extensions.reload(info.id))}
        >
          {t("extensions:list.reload")}
        </Button>
        <Button size="compact" aria-label={t("extensions:list.named.activity", named)} onClick={() => setDialog("activity")}>
          {t("extensions:list.activity")}
        </Button>
        <Button size="compact" variant="danger" aria-label={t("extensions:list.named.remove", named)} onClick={() => setDialog("remove")}>
          {t("extensions:list.remove")}
        </Button>
      </div>
      {error && <ErrorState error={error} title={t("extensions:list.actionFailed")} className="settings__error" />}
      {hasSettings && (
        <section className="ext-row__settings" aria-label={t("extensions:settingsFrame", { name: info.name })}>
          <ExtensionSettingsFrame extensionId={info.id} />
        </section>
      )}

      <Dialog
        open={dialog === "permissions"}
        title={t("extensions:permissionsDialog.title", { name: info.name })}
        onClose={close}
        footer={<Button onClick={close}>{t("extensions:permissionsDialog.close")}</Button>}
      >
        <h3 className="ext-consent__heading">{t("extensions:permissionsDialog.granted")}</h3>
        <PermissionsView permissions={info.granted} />
        {info.needsConsent && requested && (
          <>
            <h3 className="ext-consent__heading">{t("extensions:permissionsDialog.requested")}</h3>
            <PermissionsView permissions={requested} />
          </>
        )}
      </Dialog>
      <ExtensionActivityDialog open={dialog === "activity"} extensionId={info.id} onClose={close} />
      <ConfirmDialog
        open={dialog === "remove"}
        title={t("extensions:remove.title", { name: info.name })}
        confirmLabel={t("extensions:list.remove")}
        danger
        onCancel={close}
        onConfirm={() => {
          close();
          void run(() => api.extensions.remove(info.id));
        }}
      >
        <p>{t("extensions:remove.body")}</p>
      </ConfirmDialog>
      {dialog === "review" && reinstall === null && <ReviewDialog info={info} onClose={close} />}
    </li>
  );
}
