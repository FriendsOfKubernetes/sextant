import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components";

export interface NodeShellConfirmProps {
  node: string;
  /** Opens the shell (a new privileged pod). */
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Says what a shell on a node does to the cluster before anything is created (story 25). Asked before every new pod:
 * the "Shell" action and "Reconnect" in a node shell tab.
 */
export function NodeShellConfirm({ node, onConfirm, onCancel }: NodeShellConfirmProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open
      title={t("terminal:node.confirmTitle", { node })}
      confirmLabel={t("terminal:node.open")}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p>{t("terminal:node.confirm", { node })}</p>
    </ConfirmDialog>
  );
}
