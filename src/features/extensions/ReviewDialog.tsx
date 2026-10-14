// "Review permissions" of an extension paused after a change of its folder: reads the manifest as it is now
// (`inspectFolder`) and shows the same window of consent. Used by the list and by the notice.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toApiError, type ApiError, type ExtensionInfo, type PendingInstall } from "../../api";
import { Button, Dialog, ErrorState, LoadingIndicator } from "../../components";
import { ConsentDialog } from "./ConsentDialog";
import { installErrorTitle } from "./install";

export function ReviewDialog({ info, onClose }: { info: ExtensionInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingInstall | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // Keyed by the folder, not by `info`: the list is read again on every change and must not restart the check.
  const folder = info.source.type === "folder" ? info.source.path : null;
  const unreadable = info.error ?? info.name;
  useEffect(() => {
    let live = true;
    const read = folder !== null ? api.extensions.inspectFolder(folder) : Promise.reject(new Error(unreadable));
    read.then(
      (next) => live && setPending(next),
      (err: unknown) => live && setError(toApiError(err)),
    );
    return () => {
      live = false;
    };
  }, [folder, unreadable]);

  if (pending) return <ConsentDialog pending={pending} review onClose={onClose} />;
  return (
    <Dialog
      open
      title={t("extensions:consent.titleReview", { name: info.name })}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t("common:actions.close")}</Button>}
    >
      {error ? (
        <ErrorState error={error} title={installErrorTitle(error, t)} />
      ) : (
        <LoadingIndicator text={t("extensions:install.checking")} />
      )}
    </Dialog>
  );
}
