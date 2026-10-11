// Renders the dialogs that actions open (`ctx.openDialog`) and the errors of failed actions.
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, ErrorState } from "../../components";
import { useActionDialogs } from "../../features/actions/registry";

export function ActionDialogHost() {
  const { t } = useTranslation();
  const { dialogs, failures } = useActionDialogs();
  return (
    <>
      {dialogs.map((d) => (
        <Fragment key={d.id}>{d.render(d.close)}</Fragment>
      ))}
      {failures.map((f) => (
        <Dialog key={f.id} open title={t("resources:actions.failed", { action: t(f.labelKey) })} onClose={f.close}>
          <ErrorState error={f.error} />
        </Dialog>
      ))}
    </>
  );
}
