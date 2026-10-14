// "Install from URL…": asks for a link to a file in a GitHub release, checks its shape before any request, then the
// backend downloads and checks the package (consent follows).
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiError } from "../../api";
import { Button, Dialog, ErrorState, LoadingIndicator } from "../../components";
import { installErrorTitle, isReleaseUrl } from "./install";

export function InstallUrlDialog({
  busy,
  error,
  onCheck,
  onClose,
}: {
  /** The package is being downloaded. */
  busy: boolean;
  /** Why the last download or check failed. */
  error: ApiError | null;
  onCheck: (url: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);
  const valid = isReleaseUrl(url);
  const invalid = touched && url.trim() !== "" && !valid;
  const submit = () => {
    setTouched(true);
    if (valid && !busy) onCheck(url.trim());
  };
  return (
    <Dialog
      open
      title={t("extensions:url.title")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {t("extensions:url.check")}
          </Button>
        </>
      }
    >
      <form
        className="settings__field"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="settings__label" htmlFor={inputId}>
          {t("extensions:url.label")}
        </label>
        <input
          id={inputId}
          className="settings__input settings__path ext-url__input"
          type="url"
          spellCheck={false}
          autoFocus
          value={url}
          placeholder={t("extensions:url.placeholder")}
          aria-invalid={invalid || undefined}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => setTouched(true)}
        />
        {invalid ? (
          <p className="settings__hint" data-invalid role="alert">
            {t("extensions:url.invalid")}
          </p>
        ) : (
          <p className="settings__hint">{t("extensions:url.hint")}</p>
        )}
      </form>
      {busy && <LoadingIndicator text={t("extensions:install.checking")} />}
      {!busy && error && <ErrorState error={error} title={installErrorTitle(error, t)} className="settings__error" />}
    </Dialog>
  );
}
