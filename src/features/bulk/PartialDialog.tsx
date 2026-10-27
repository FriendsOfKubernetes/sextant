// The explanation before an action that applies to only part of the selection (ADR-0126): how many it runs on, which
// selected objects it leaves out (the first MAX_LISTED, then a count) and, where the action says, why. Nothing runs
// before "Continue"; the action then opens its own confirmation for the objects it applies to.
import { useTranslation } from "react-i18next";
import type { KindRef } from "../../api";
import { Button, Dialog } from "../../components";
import { actionLabel } from "../actions/registry";
import { MAX_LISTED } from "../actions/deleteRun";
import { reasonOf, type BarAction } from "./selection";

export function PartialDialog({
  entry,
  kind,
  close,
  onContinue,
}: {
  entry: BarAction;
  kind: KindRef;
  close: () => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const action = actionLabel(entry.action, t);
  const part = entry.applying.length;
  const total = part + entry.left.length;
  const hidden = entry.left.length - MAX_LISTED;
  return (
    <Dialog
      open
      title={t("bulk:partial.title", { action })}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" onClick={onContinue}>
            {t("bulk:partial.continue", { count: part })}
          </Button>
        </>
      }
    >
      <p>{t("bulk:partial.text", { action, part, total })}</p>
      <ul className="sel-partial__list" aria-label={t("bulk:partial.left")}>
        {entry.left.slice(0, MAX_LISTED).map((obj) => {
          const name = obj.metadata?.namespace ? `${obj.metadata.namespace}/${obj.metadata.name ?? ""}` : (obj.metadata?.name ?? "");
          const reason = reasonOf(entry.action, obj, kind);
          return (
            <li key={obj.metadata?.uid ?? name}>
              <span className="sel-partial__name">{name}</span>
              {reason && <span className="sel-partial__reason">{reason}</span>}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && <p>{t("bulk:delete.more", { count: hidden })}</p>}
    </Dialog>
  );
}
